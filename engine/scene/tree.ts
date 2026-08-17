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

  // Bottom-up: a parent's disc must be wide enough that no child's disc overlaps another.
  const measure = (node: Build): void => {
    node.files = node.isFile ? node.files : [];
    if (!node.children.length) {
      node.spread = LEAF_SPREAD;
      return;
    }
    let circumference = 0;
    let widest = 0;
    for (const child of node.children) {
      measure(child);
      circumference += child.spread * 2.15;
      widest = Math.max(widest, child.spread);
      node.files.push(...child.files);
    }
    const radius = Math.max(MIN_RADIUS, circumference / TAU);
    node.spread = radius + widest;
    (node as any).radius = radius;
  };
  measure(root);

  return root;
}

export function layoutTree(data: TreeInput, rootLabel: string): SceneLayout {
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

    if (!node.children.length) return;
    const radius = (node as any).radius ?? MIN_RADIUS;
    const total = node.children.reduce((sum, c) => sum + c.spread, 0) || 1;

    // Angular share proportional to each subtree's width, so a heavy branch gets room.
    let angle = 0;
    for (const child of node.children) {
      const share = (child.spread / total) * TAU;
      const a = angle + share / 2;
      place(child, x + Math.cos(a) * radius, z + Math.sin(a) * radius, nodeKey);
      angle += share;
    }
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

  // Camera distance maps to tree depth here, the same way it maps to focus altitude in
  // the graph view: pull back and the deep leaves collapse into their directories.
  const bands = [];
  for (let d = 1; d <= maxDepth; d++) {
    bands.push({ level: d, minDistance: Math.max(0, 420 - d * 90) });
  }
  if (bands.length) bands[bands.length - 1].minDistance = 0;

  return { nodes, spine, festoons, bands, mode: 'tree', maxDepth };
}
