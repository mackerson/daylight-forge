import type { Graph } from '../graph/types.ts';

/**
 * Stable identity across renames and moves.
 *
 * `path#Name` is the node id, and it is fine as an id — the graph is rebuilt from scratch on
 * every run, so nothing in it needs to survive. **Claims** need to survive, and they are keyed
 * by subject. Rename `ChatRepository.ts`, and every claim anyone ever confirmed about it is
 * orphaned: still in the store, attached to a path that no longer exists, invisible to the
 * map. The tool recommends exactly the refactors that do this. It was quietly punishing you
 * for taking its advice.
 *
 * The fix is deliberately *not* a content-addressed node id. Content changes constantly, so
 * a content id breaks on every edit — trading a rare failure for a continuous one — and it
 * would rewrite identity through the entire codebase to fix a problem that only exists at
 * the claim layer. Instead the graph keeps path identity, and this matches the nodes of one
 * run against the nodes of the last, the way git detects a rename: by looking at what moved
 * and asking whether anything that arrived looks enough like it.
 *
 * Two signals, because either alone is wrong:
 *
 *  - **Structure.** A file's fingerprint is the elementwise minimum of its functions' body
 *    signatures, which is exactly the MinHash of their union — so the file-level signature
 *    falls out of the per-function ones D4 already computes, for free. This survives renaming
 *    the file *and* its symbols, since identifiers were erased before hashing.
 *  - **Names.** Jaccard over the symbol names the file declares. This survives a rewrite that
 *    kept the interface, which is the case structure alone misses.
 *
 * A match needs both to agree. One signal alone reliably produces the failure that matters
 * most here: silently moving somebody's confirmed knowledge onto the wrong file.
 */

export interface Fingerprint {
  file: string;
  /** MinHash over the union of the file's function bodies. Empty for files with no code. */
  sig: number[];
  /** Declared symbol names, sorted. */
  names: string[];
  contentHash?: string;
}

export interface Rename {
  from: string;
  to: string;
  /** Structural similarity, 0–1. */
  structure: number;
  /** Name-set similarity, 0–1. */
  names: number;
  confidence: number;
}

export interface RenameReport {
  renames: Rename[];
  /** Files that vanished with nothing resembling them. Their claims are genuinely stranded. */
  disappeared: string[];
  /** Files that appeared and matched nothing. New code, most likely. */
  appeared: string[];
  /**
   * Gone files that resemble *several* arrivals, or arrivals that resemble several departures.
   * Deliberately not resolved: a split or a merge is a real event with no single right answer,
   * and guessing one would attach knowledge to a file nobody claimed it about.
   */
  ambiguous: Array<{ from: string; candidates: Rename[] }>;
}

export interface RenameOptions {
  /** Structural agreement required. */
  minStructure?: number;
  /** Name-set agreement required. */
  minNames?: number;
  /** A second candidate this close to the best one makes the match ambiguous rather than won. */
  ambiguityMargin?: number;
}

export function fingerprints(graph: Graph): Fingerprint[] {
  const byFile = new Map<string, Fingerprint>();

  for (const node of graph.nodes) {
    if (node.kind !== 'file') continue;
    byFile.set(node.id, {
      file: node.id,
      sig: [],
      names: [],
      ...(node.contentHash ? { contentHash: node.contentHash } : {}),
    });
  }

  for (const node of graph.nodes) {
    if (node.kind === 'file') continue;
    byFile.get(node.file)?.names.push(node.name);
  }

  // Elementwise min over the file's function signatures *is* the MinHash of their union —
  // which is why a file-level fingerprint costs nothing beyond what D4 already computed.
  for (const fn of graph.functions) {
    const fp = byFile.get(fn.file);
    if (!fp || !fn.body?.length) continue;
    if (!fp.sig.length) fp.sig = [...fn.body];
    else for (let i = 0; i < fp.sig.length && i < fn.body.length; i++) {
      if (fn.body[i] < fp.sig[i]) fp.sig[i] = fn.body[i];
    }
  }

  for (const fp of byFile.values()) fp.names.sort();
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function sigSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

function nameSimilarity(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  const A = new Set(a);
  let shared = 0;
  for (const n of new Set(b)) if (A.has(n)) shared++;
  const union = A.size + new Set(b).size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * What moved between two runs.
 *
 * Only files present in one side and absent from the other are considered. A file that kept
 * its path did not move, whatever happened inside it — and comparing it against everything
 * else would invent renames out of ordinary similarity between siblings.
 */
export function detectRenames(
  before: Fingerprint[],
  after: Fingerprint[],
  opts: RenameOptions = {},
): RenameReport {
  const minStructure = opts.minStructure ?? 0.6;
  const minNames = opts.minNames ?? 0.5;
  const margin = opts.ambiguityMargin ?? 0.1;

  const afterPaths = new Set(after.map((f) => f.file));
  const beforePaths = new Set(before.map((f) => f.file));
  const gone = before.filter((f) => !afterPaths.has(f.file));
  const arrived = after.filter((f) => !beforePaths.has(f.file));

  const scored = new Map<string, Rename[]>();
  for (const from of gone) {
    const candidates: Rename[] = [];
    for (const to of arrived) {
      const structure = sigSimilarity(from.sig, to.sig);
      const names = nameSimilarity(from.names, to.names);
      if (structure < minStructure || names < minNames) continue;
      candidates.push({
        from: from.file,
        to: to.file,
        structure,
        names,
        // Both signals must be strong, so the weaker one dominates: an average would let a
        // perfect structural match carry a file whose entire interface changed.
        confidence: Math.min(structure, names),
      });
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    if (candidates.length) scored.set(from.file, candidates);
  }

  const renames: Rename[] = [];
  const ambiguous: RenameReport['ambiguous'] = [];
  const claimed = new Map<string, Rename>();

  // Best-first, so a strong match wins its target over a weaker one competing for it.
  const ordered = [...scored.entries()].sort(
    (a, b) => b[1][0].confidence - a[1][0].confidence,
  );

  for (const [from, candidates] of ordered) {
    const free = candidates.filter((c) => !claimed.has(c.to));
    if (!free.length) {
      ambiguous.push({ from, candidates });
      continue;
    }
    const best = free[0];
    const runnerUp = free[1];
    // Two plausible destinations is a split, which is a real event with no single answer.
    if (runnerUp && best.confidence - runnerUp.confidence < margin) {
      ambiguous.push({ from, candidates: free });
      continue;
    }
    claimed.set(best.to, best);
    renames.push(best);
  }

  const matchedFrom = new Set(renames.map((r) => r.from));
  const ambiguousFrom = new Set(ambiguous.map((a) => a.from));

  return {
    renames: renames.sort((a, b) => a.from.localeCompare(b.from)),
    disappeared: gone
      .map((f) => f.file)
      .filter((f) => !matchedFrom.has(f) && !ambiguousFrom.has(f))
      .sort(),
    appeared: arrived
      .map((f) => f.file)
      .filter((f) => !claimed.has(f))
      .sort(),
    ambiguous: ambiguous.sort((a, b) => a.from.localeCompare(b.from)),
  };
}
