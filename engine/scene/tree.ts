import type { FocusStack } from '../focus/types.ts';
import type { SceneLayout, SceneNode, TreeInput } from './types.ts';

/**
 * Cone tree — the hierarchy view.
 *
 * The focus stack flattens everything into three levels of buckets, which throws the
 * real shape away: `src/main/services/sandbox/PluginWorker.ts` and `src/main/services/ai.ts`
 * land in the same bucket with no memory that one is nested deeper. This reads the actual
 * path tree at arbitrary depth instead, with files as leaves.
 *
 * Layout is the classic cone tree: each node's children sit on a disc beneath it, sized so
 * sibling subtrees cannot overlap. Deterministic, like the graph layout — the same repo
 * lays out the same way every session, which is the whole basis for spatial memory.
 */

const TAU = Math.PI * 2;
const DEPTH_GAP = 40;
const LEAF_SPREAD = 5.5;
const MIN_RADIUS = 14;

/** Above this many children, a ring becomes a wall and the disc packing takes over. */
const RING_LIMIT = 12;
/** Fraction of a disc that evenly-spread circles occupy. Empirical, and deliberately shy. */
const PACKING = 0.55;
/** Golden angle: successive children land in the gaps left by the previous ones. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** World radius the finished tree is shrunk to fit, chosen against the camera's range. */
const TARGET_RADIUS = 520;
/** Distance at which only the top level shows. The camera clamps a little beyond it. */
const BAND_FAR = 900;

interface Build {
  id: string;
  name: string;
  isFile: boolean;
  children: Build[];
  files: string[];
  /** Radius this subtree needs, computed bottom-up. */
  spread: number;
  depth: number;
}

function buildTree(files: string[], rootLabel: string): Build {
  const root: Build = {
    id: '(root)', name: rootLabel, isFile: false, children: [], files: [], spread: 0, depth: 0,
  };
  const dirs = new Map<string, Build>([['', root]]);

  for (const file of [...files].sort()) {
    const parts = file.split('/');
    let prefix = '';
    let parent = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const next = prefix ? `${prefix}/${parts[i]}` : parts[i];
      let node = dirs.get(next);
      if (!node) {
        node = {
          id: next, name: parts[i], isFile: false, children: [],
          files: [], spread: 0, depth: i + 1,
        };
        dirs.set(next, node);
        parent.children.push(node);
      }
      prefix = next;
      parent = node;
    }

    parent.children.push({
      id: file, name: parts[parts.length - 1], isFile: true, children: [],
      files: [file], spread: LEAF_SPREAD, depth: parts.length,
    });
  }

  /**
   * Bottom-up sizing: a parent's disc must hold every child's disc without overlap.
   *
   * Children used to go on a single ring, which makes the radius grow *linearly* with how
   * many there are — the circumference has to fit them all. On a monorepo that is fatal: six
   * top-level packages ended up 10,000 units from the centre and the deepest nodes 38,000
   * out, while the camera is clamped to a few hundred. You could never get far enough away
   * to see it, so the whole tree read as a dot with rays going off past the far plane.
   *
   * Packing them into the disc's *area* instead makes the radius grow with the square root of
   * the count, which is the difference between 620 siblings needing 25x the room and 5x.
   *
   * A single ring is still better to look at when it fits, so small fan-outs keep it. The
   * switch is on count alone, so it stays deterministic.
   */
  const measure = (node: Build): void => {
    node.files = node.isFile ? node.files : [];
    if (!node.children.length) {
      node.spread = LEAF_SPREAD;
      return;
    }

    let widest = 0;
    let areaSum = 0;
    let circumference = 0;
    for (const child of node.children) {
      measure(child);
      widest = Math.max(widest, child.spread);
      areaSum += child.spread * child.spread;
      circumference += child.spread * 2.15;
      node.files.push(...child.files);
    }

    /**
     * Ring or disc, whichever is actually smaller here.
     *
     * Neither wins everywhere, which is why this measures instead of choosing. A ring's
     * radius grows with the *sum* of its children, so hundreds of siblings become a wall —
     * `api`, with 179 children, needs 6125 on a ring and 3201 in a disc. But a disc is sized
     * by its largest occupant, so one dominant subtree ruins it: `launchpad` has 33 children
     * of which one is 30797 wide, and the disc wants 49275 against the ring's 11054.
     *
     * Taking the smaller is never worse than the ring alone, which is what shipped.
     */
    const ringRadius = Math.max(MIN_RADIUS, circumference / TAU);
    const discRadius = Math.max(MIN_RADIUS, Math.sqrt(areaSum / PACKING));
    const ring = node.children.length <= RING_LIMIT || ringRadius <= discRadius;
    const radius = ring ? ringRadius : discRadius;

    node.spread = radius + widest;
    (node as any).radius = radius;
    (node as any).ring = ring;
  };
  measure(root);

  return root;
}

/**
 * Where an expanded file's symbols sit.
 *
 * Deliberately *outside* the spread calculation: a file keeps `LEAF_SPREAD` whether it is
 * open or shut, so opening one does not resize its parent's disc and shuffle every sibling
 * subtree. The whole argument for a deterministic layout is spatial memory — you learn where
 * things are — and a tree that rearranges itself when you ask a question about one file
 * throws that away to buy tidier packing. Symbols may crowd a neighbour when several files
 * are open at once; that is the cheaper failure by a wide margin.
 */
const SYMBOL_RADIUS = LEAF_SPREAD * 1.7;
const SYMBOL_GAP = DEPTH_GAP * 0.55;

export function layoutTree(
  data: TreeInput,
  rootLabel: string,
  expanded: ReadonlySet<string> = new Set(),
): SceneLayout {
  const stack = data.stack as FocusStack;
  const files = new Set<string>();
  for (const l of stack.levels) for (const n of l.nodes) for (const m of n.members) files.add(m);

  const root = buildTree([...files], rootLabel);

  // Purpose and defended-ness live on focus-stack nodes; carry them onto whichever
  // directory holds exactly that node's members, so intent survives into this view.
  const purposeByDir = new Map<string, string>();
  for (const l of stack.levels) {
    for (const n of l.nodes) {
      if (!n.purpose) continue;
      for (const m of n.members) {
        const dir = m.slice(0, m.lastIndexOf('/'));
        if (dir && !purposeByDir.has(dir)) purposeByDir.set(dir, n.purpose);
      }
    }
  }

  const nodes = new Map<string, SceneNode>();
  const spine: Array<{ from: string; to: string }> = [];
  const parentOf = new Map<string, string>();
  let maxDepth = 0;

  const place = (node: Build, x: number, z: number, parentKey?: string) => {
    const nodeKey = `t:${node.id}`;
    maxDepth = Math.max(maxDepth, node.depth);

    nodes.set(nodeKey, {
      key: nodeKey,
      level: node.depth,
      id: node.id,
      label: node.name,
      purpose: node.isFile ? undefined : purposeByDir.get(node.id),
      members: node.isFile ? [node.id] : node.files,
      fileCount: node.isFile ? 1 : node.files.length,
      symbolCount: 0,
      origin: 'path',
      isRoot: node.depth === 0,
      isFile: node.isFile,
      x, y: -node.depth * DEPTH_GAP, z,
    });
    if (parentKey) {
      spine.push({ from: parentKey, to: nodeKey });
      parentOf.set(nodeKey, parentKey);
    }

    if (node.isFile && expanded.has(node.id)) {
      const symbols = data.symbols?.[node.id] ?? [];
      symbols.forEach((sym, i) => {
        const a = (i / Math.max(1, symbols.length)) * TAU;
        const symKey = `t:${sym.id}`;
        nodes.set(symKey, {
          key: symKey,
          level: node.depth + 1,
          id: sym.id,
          label: sym.name,
          members: [node.id],
          fileCount: 0,
          symbolCount: 1,
          origin: 'symbol',
          isFile: false,
          isSymbol: true,
          symbolKind: sym.kind,
          x: x + Math.cos(a) * SYMBOL_RADIUS,
          y: -node.depth * DEPTH_GAP - SYMBOL_GAP,
          z: z + Math.sin(a) * SYMBOL_RADIUS,
        });
        spine.push({ from: nodeKey, to: symKey });
        parentOf.set(symKey, nodeKey);
      });
      maxDepth = Math.max(maxDepth, node.depth + 1);
    }

    if (!node.children.length) return;
    const radius = (node as any).radius ?? MIN_RADIUS;

    if ((node as any).ring) {
      // Few enough to go round the edge: angular share proportional to each subtree's width,
      // so a heavy branch gets the room it needs.
      const total = node.children.reduce((sum, c) => sum + c.spread, 0) || 1;
      let angle = 0;
      for (const child of node.children) {
        const share = (child.spread / total) * TAU;
        const a = angle + share / 2;
        place(child, x + Math.cos(a) * radius, z + Math.sin(a) * radius, nodeKey);
        angle += share;
      }
      return;
    }

    /**
     * Too many for a ring, so they fill the disc.
     *
     * `sqrt((k + 0.5) / n)` spaces them evenly by *area* rather than by radius — without it
     * everything crowds the rim — and the golden angle drops each one into the gap left by
     * its predecessors, which is why sunflower seeds pack the way they do. Index order, so
     * the same tree lays out identically every time.
     */
    const n = node.children.length;
    node.children.forEach((child, k) => {
      const r = radius * Math.sqrt((k + 0.5) / n);
      const a = k * GOLDEN_ANGLE;
      place(child, x + Math.cos(a) * r, z + Math.sin(a) * r, nodeKey);
    });
  };
  place(root, 0, 0);

  /**
   * Hierarchical edge bundling.
   *
   * A dependency is routed UP from its source to the lowest common ancestor of the two
   * files, then back down — so edges travel along the tree rather than cutting across it.
   * Edges that share a route visually merge into a rope, which is what makes "this limb's
   * dependencies all leave the subtree" legible instead of a haze under the leaves.
   */
  const ancestry = (nodeKey: string): string[] => {
    const chain = [nodeKey];
    let cur = nodeKey;
    while (parentOf.has(cur)) {
      cur = parentOf.get(cur)!;
      chain.push(cur);
    }
    return chain;
  };

  const festoons = [];
  for (const e of data.fileEdges ?? []) {
    const from = nodes.get(`t:${e.from}`);
    const to = nodes.get(`t:${e.to}`);
    if (!from || !to) continue;

    const up = ancestry(from.key);
    const downSet = new Set(ancestry(to.key));
    const lcaIndex = up.findIndex((k) => downSet.has(k));
    const lca = up[lcaIndex < 0 ? up.length - 1 : lcaIndex];

    const down = ancestry(to.key);
    const via = [
      ...up.slice(0, lcaIndex < 0 ? up.length : lcaIndex + 1),
      ...down.slice(0, down.indexOf(lca)).reverse(),
    ];

    festoons.push({
      level: 0, from: from.key, to: to.key,
      weight: e.weight, kinds: ['imports'], via,
    });
  }

  /**
   * Bring the layout within reach of the camera.
   *
   * A containment layout has no bounded size — each level must hold everything beneath it, so
   * extent grows with the repo. On a 10k-file monorepo the deepest nodes landed 28,000 units
   * out while the camera is clamped to a few hundred, so there was no distance from which the
   * tree was visible: you sat inside the first ring looking at a dot with lines going off past
   * the far plane. Scaling only ever shrinks — a repo that already fits is left exactly as it
   * was, since its layout is not the one that was broken.
   *
   * Depth is deliberately *not* scaled with it. Shrinking a 10k-file tree by thirty times
   * would flatten 13 levels into 17 units and turn a tree into a disc; keeping the vertical
   * gap fixed is what makes it still read as a hierarchy at any size.
   */
  let scale = 1;
  {
    let maxRadial = 0;
    for (const n of nodes.values()) maxRadial = Math.max(maxRadial, Math.hypot(n.x, n.z));
    if (maxRadial > TARGET_RADIUS) {
      scale = TARGET_RADIUS / maxRadial;
      for (const n of nodes.values()) {
        n.x *= scale;
        n.z *= scale;
      }
    }
  }

  /**
   * Camera distance maps to tree depth, the same way it maps to focus altitude in the graph
   * view: pull back and the deep leaves collapse into their directories.
   *
   * The thresholds have to be spread over the depth this repo actually has. They were
   * `420 - depth * 90`, which reaches zero at level 5 — so on a 13-level tree every level
   * below the fifth shared a threshold, `find` always matched the fifth, and levels 6 to 13
   * were unreachable at any distance. Nine tenths of the tree was in the scene and could not
   * be looked at.
   */
  /**
   * A base node radius that suits how crowded this tree actually is.
   *
   * Node size was computed purely from file count, in absolute units, which was fine while
   * every layout was about the same size. Once the layout shrinks to fit, positions move
   * thirty times closer together and unchanged sizes turn the tree into overlapping blobs —
   * the one enormous sphere swallowing its neighbours. Deriving it from mean spacing
   * (extent over root-n) makes a node a fraction of the gap to the next one, at any scale.
   */
  let unit: number | undefined;
  if (scale < 1) {
    // Only where the layout had to be shrunk. A tree that already fitted was never the
    // problem, and its sizing is what people have been looking at — leave it alone.
    let extent = 0;
    for (const n of nodes.values()) extent = Math.max(extent, Math.hypot(n.x, n.z));
    // Mean spacing between nodes spread over the disc, with the node taking a share of it.
    const spacing = Math.sqrt((Math.PI * extent * extent) / Math.max(nodes.size, 1));
    unit = Math.max(0.5, Math.min(6, spacing * 0.22));
  }

  const bands = [];
  for (let d = 1; d <= maxDepth; d++) {
    const t = maxDepth > 1 ? (maxDepth - d) / (maxDepth - 1) : 0;
    bands.push({ level: d, minDistance: Math.round(BAND_FAR * t ** 1.5) });
  }
  if (bands.length) bands[bands.length - 1].minDistance = 0;

  return { nodes, spine, festoons, bands, mode: 'tree', maxDepth, scale, unit };
}
