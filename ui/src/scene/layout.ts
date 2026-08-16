/**
 * Festooned-tree layout.
 *
 * The spine is the hierarchy: L3 at the base, L2 above it, files at the leaves.
 * Everything that is NOT a spine edge is a festoon — a cross-edge that ignores the
 * hierarchy, drawn as a curve that dips toward the axis so bundles read as ropes
 * rather than noise.
 *
 * The layout is DETERMINISTIC. Flying around only builds spatial memory if the same
 * repo lays out the same way every session, so there is no force relaxation and no
 * randomness here — position is a pure function of the focus stack.
 */

const TAU = Math.PI * 2;

/** Stable hash → the angular seed for a subtree, so ordering never jitters. */
function hashAngle(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 100000) / 100000;
}

export const LEVEL_Y: Record<number, number> = { 3: 0, 2: 34, 1: 68 };
const LEVEL_RADIUS: Record<number, number> = { 3: 86, 2: 150, 1: 215 };

export function layout(stack: any, rootLabel = 'repo'): any {
  const byLevel = new Map<number, any>(stack.levels.map((l: any) => [l.level, l]));
  const nodes = new Map<string, any>();
  const spine: any[] = [];

  // ---- L3: the base ring, ordered by size so the layout reads consistently ----
  const l3 = byLevel.get(3);
  const l3Sorted = [...l3.nodes].sort((a: any, b: any) => b.fileCount - a.fileCount || a.id.localeCompare(b.id));
  const angleOfL3 = new Map<string, number>();

  l3Sorted.forEach((node: any, i: number) => {
    const angle = (i / l3Sorted.length) * TAU;
    angleOfL3.set(node.id, angle);
    const r = LEVEL_RADIUS[3];
    nodes.set(key(3, node.id), {
      key: key(3, node.id), level: 3, id: node.id, label: node.label,
      purpose: node.purpose, fileCount: node.fileCount, symbolCount: node.symbolCount,
      origin: node.origin, members: node.members,
      x: Math.cos(angle) * r, y: LEVEL_Y[3], z: Math.sin(angle) * r,
    });
  });

  // ---- L2 and L1: fan out near the parent's angle -----------------------------
  for (const level of [2, 1]) {
    const lvl = byLevel.get(level);
    if (!lvl) continue;

    // Which L3 bucket does each node belong under? Match by shared file membership.
    const parentOf = new Map();
    for (const node of lvl.nodes as any[]) {
      let best: any = null;
      let bestOverlap = 0;
      for (const l3n of l3.nodes as any[]) {
        const set = new Set(l3n.members);
        let overlap = 0;
        for (const m of node.members as string[]) if (set.has(m)) overlap++;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = l3n.id;
        }
      }
      parentOf.set(node.id, best);
    }

    const grouped = new Map<string, any[]>();
    for (const node of lvl.nodes as any[]) {
      const p = parentOf.get(node.id) ?? '(none)';
      if (!grouped.has(p)) grouped.set(p, []);
      grouped.get(p)!.push(node);
    }

    for (const [parent, kids] of grouped) {
      const baseAngle = angleOfL3.get(parent) ?? hashAngle(parent) * TAU;
      // Spread siblings in a wedge around the parent's bearing.
      const spread = Math.min(TAU / Math.max(l3Sorted.length, 1), 0.9);
      kids.sort((a: any, b: any) => a.id.localeCompare(b.id));
      kids.forEach((node: any, i: number) => {
        const t = kids.length === 1 ? 0 : i / (kids.length - 1) - 0.5;
        const angle = baseAngle + t * spread;
        const r = LEVEL_RADIUS[level] + (i % 3) * 6;
        nodes.set(key(level, node.id), {
          key: key(level, node.id), level, id: node.id, label: node.label,
          purpose: node.purpose, fileCount: node.fileCount, symbolCount: node.symbolCount,
          origin: node.origin, members: node.members,
          x: Math.cos(angle) * r, y: LEVEL_Y[level], z: Math.sin(angle) * r,
        });
        if (parent !== '(none)' && nodes.has(key(3, parent)) && level === 2) {
          spine.push({ from: key(3, parent), to: key(level, node.id) });
        }
      });
    }
  }

  // L1 hangs off its L2 parent where we can determine one, else off L3.
  const l1 = byLevel.get(1);
  const l2 = byLevel.get(2);
  if (l1 && l2) {
    for (const node of l1.nodes as any[]) {
      let best: any = null;
      let bestOverlap = 0;
      for (const l2n of l2.nodes as any[]) {
        const set = new Set(l2n.members);
        let overlap = 0;
        for (const m of node.members as string[]) if (set.has(m)) overlap++;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = l2n.id;
        }
      }
      if (best && nodes.has(key(2, best)) && nodes.has(key(1, node.id))) {
        spine.push({ from: key(2, best), to: key(1, node.id) });
      }
    }
  }

  // ---- root: a real node, not a decorative anchor -----------------------------
  // The trunk used to converge on a hardcoded point with no referent. Everything on
  // screen has to expand back to files, so the root is now an actual node: the repo.
  const allMembers = new Set<string>();
  for (const n of l3.nodes as any[]) for (const m of n.members as string[]) allMembers.add(m);

  const rootKey = key(3, '(root)');
  nodes.set(rootKey, {
    key: rootKey, level: 3, id: '(root)', label: rootLabel,
    purpose: undefined, fileCount: allMembers.size, symbolCount: 0,
    origin: 'path', members: [...allMembers].sort(), isRoot: true,
    x: 0, y: LEVEL_Y[3] - 34, z: 0,
  });
  for (const n of l3Sorted) spine.push({ from: rootKey, to: key(3, n.id) });

  // ---- festoons: every cross-edge at each level --------------------------------
  const festoons: any[] = [];
  for (const lvl of stack.levels as any[]) {
    for (const e of lvl.edges as any[]) {
      const from = nodes.get(key(lvl.level, e.from));
      const to = nodes.get(key(lvl.level, e.to));
      if (!from || !to) continue;
      festoons.push({
        level: lvl.level,
        from: from.key,
        to: to.key,
        weight: e.weight,
        kinds: e.kinds,
      });
    }
  }

  return { nodes, spine, festoons };
}

export const key = (level: number, id: string) => `${level}:${id}`;
