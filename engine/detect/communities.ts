import type { Graph } from '../graph/types.ts';

/**
 * Communities — groups the *graph* thinks belong together, independent of the directory
 * tree.
 *
 * This is the other half of the collapse-candidate finding the taxonomy specified: D1–D3
 * find things that are textually the same, and this finds things that are *connected* like
 * one thing while being filed as several. Where a community spans directories, either the
 * filing is wrong or the coupling is.
 *
 * Label propagation rather than Louvain: it is a dozen lines, near-linear, and needs no
 * modularity-resolution parameter to argue about. It is stochastic in the general case, so
 * ties break on a stable hash of the node id instead of at random — an unstable answer here
 * would move the map on every run for no reason, which the design forbids.
 */

export interface Community {
  id: string;
  members: string[];
  /** Directories the members are filed under. */
  dirs: string[];
  /** Edges inside the community versus edges leaving it. */
  internal: number;
  external: number;
  /** internal / (internal + external): how much of one thing this really is. */
  cohesion: number;
}

const fileOf = (id: string) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);
const dirOf = (f: string) => f.slice(0, f.lastIndexOf('/')) || '(root)';

/** Deterministic tie-break, so the same graph always yields the same communities. */
function rank(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  return h >>> 0;
}

export function detectCommunities(graph: Graph, rounds = 12): Community[] {
  const files = graph.nodes.filter((n) => n.kind === 'file').map((n) => n.id);
  const neighbours = new Map<string, Set<string>>();
  for (const f of files) neighbours.set(f, new Set());

  for (const e of graph.edges) {
    if (e.external || e.kind === 'contains') continue;
    const a = fileOf(e.from);
    const b = fileOf(e.to);
    if (a === b || !neighbours.has(a) || !neighbours.has(b)) continue;
    // Undirected: for "what belongs together", direction is not the question.
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  }

  const label = new Map<string, string>(files.map((f) => [f, f]));
  // Fixed order, not shuffled, for the same reason ties break on a hash.
  const order = [...files].sort((a, b) => rank(a) - rank(b));

  for (let round = 0; round < rounds; round++) {
    let moved = 0;
    for (const f of order) {
      const counts = new Map<string, number>();
      for (const n of neighbours.get(f) ?? []) {
        const l = label.get(n)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      if (!counts.size) continue;

      let best = label.get(f)!;
      let bestCount = -1;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && rank(l) < rank(best))) {
          best = l;
          bestCount = c;
        }
      }
      if (best !== label.get(f)) {
        label.set(f, best);
        moved++;
      }
    }
    if (!moved) break;
  }

  const grouped = new Map<string, string[]>();
  for (const [f, l] of label) {
    const list = grouped.get(l);
    if (list) list.push(f);
    else grouped.set(l, [f]);
  }

  const communities: Community[] = [];
  for (const [id, members] of grouped) {
    if (members.length < 2) continue;
    const inside = new Set(members);
    let internal = 0;
    let external = 0;
    for (const m of members) {
      for (const n of neighbours.get(m) ?? []) (inside.has(n) ? internal++ : external++);
    }
    internal /= 2; // counted from both ends
    communities.push({
      id,
      members: [...members].sort(),
      dirs: [...new Set(members.map((m) => dirOf(m)))].sort(),
      internal,
      external,
      cohesion: internal + external === 0 ? 0 : internal / (internal + external),
    });
  }

  return communities.sort((a, b) => b.members.length - a.members.length);
}

/**
 * Communities worth acting on: cohesive, but spread across directories.
 *
 * A cohesive community inside one directory is simply a well-organised module and says
 * nothing. The finding is a group that behaves as one thing while being filed as several.
 */
export function collapseCandidates(communities: Community[], minCohesion = 0.5): Community[] {
  return communities.filter(
    (c) => c.dirs.length > 1 && c.members.length >= 3 && c.cohesion >= minCohesion,
  );
}
