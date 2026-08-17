import type { FunctionRecord, Graph } from '../graph/types.ts';

/**
 * D6 — parallel implementations.
 *
 * Two files that are the same thing written twice, where nothing inside either one is a copy
 * of anything inside the other.
 *
 * This detector exists because calibration proved D1–D4 structurally cannot reach the
 * fixture's headline duplication, and that no threshold change gets there. `ChatRepository`
 * and `ChannelRepository` are two hand-written stores over analogous tables: D1 cannot fire
 * because both classes expose two fields (`db`, `logger`) — a repository's shape lives in SQL
 * strings, not in its types. D4 cannot fire because the bodies genuinely diverged. D2 and D3
 * do link them, but only through `delete` ×17 and `(string) => void` ×24, which the pattern
 * guard correctly discards as conventions.
 *
 * Every one of those refusals is right at the symbol level. The signal is at the *file*
 * level: no single shared method name means anything, but the particular *set* the two files
 * share is far larger and far more specific than any other pair in the codebase.
 *
 * So each shared name is weighted by how rare it is. `delete`, in seventeen files, is worth
 * almost nothing; `getParticipants`, in two, is worth a great deal. That is the difference
 * between "both are repositories" — true, uninteresting — and "these two are the same
 * repository written twice", which is the finding. It is inverse document frequency, the
 * oldest trick there is, applied to method names instead of words.
 *
 * **Two scores, and a pair qualifies on either.** A weighted Jaccard finds two files that are
 * near-identical in surface. It does *not* find the fixture's case, because `ChatRepository`
 * grew seventeen methods `ChannelRepository` never had — search, tags, branch counts — which
 * drags the union up and the ratio down to 0.26. Yet the two share seven names that occur in
 * two to four files apiece out of a hundred and twenty-four. That is not a coincidence any
 * amount of divergence explains away, so the mass of shared *rare* names is scored separately
 * and qualifies on its own.
 *
 * That second score is expressed in units of *the rarest name a codebase can have* rather
 * than in raw IDF, because raw IDF does not survive a change of scale: a name in two files is
 * worth ln(124/2) in the fixture and ln(14/2) in a small repo, so an absolute floor tuned on
 * one would silently never fire on the other. Divided through, the score reads directly —
 * "worth four maximally-rare shared names" — and means the same thing in any repo.
 *
 * Calibrated on the fixture: the two known pairs score 6.7 and 5.0 at pre-collapse, the next
 * pair scores 2.7, and at HEAD — where both duplications have been done away with — nothing
 * exceeds 2.7. Two labelled pairs is thin evidence for a threshold and the floor is set to
 * say so; see `RARE_MASS_FLOOR`.
 *
 * Deterministic, no model, no dependency.
 */

export interface ParallelPair {
  detector: 'D6';
  a: string;
  b: string;
  /** IDF-weighted Jaccard. Finds near-identical surfaces; blind to one side having grown. */
  score: number;
  /**
   * Shared rare names, measured in units of the rarest name this codebase can have — so 4.0
   * means "as much evidence as four names that each appear in only two files". Scale-free,
   * and unlike the overlap score it survives one side of the pair having grown.
   */
  rareMass: number;
  /** Which of the two scores qualified this pair, so the reason is never inferred. */
  by: 'overlap' | 'rare-names' | 'both';
  /** The names both files define, rarest first — this is the evidence. */
  shared: string[];
  /** Shared names rare enough to count toward `rareMass`. */
  rare: string[];
  onlyA: string[];
  onlyB: string[];
}

export interface ParallelOptions {
  /** Files defining fewer names than this are too small to compare. */
  minNames?: number;
  /** Shared names required before a pair is considered at all. */
  minShared?: number;
  /** Report pairs at or above this weighted Jaccard. */
  minScore?: number;
  /** Report pairs whose shared rare names carry at least this much IDF mass. */
  minRareMass?: number;
  /** Rare shared names required before rare mass can qualify a pair on its own. */
  minRareNames?: number;
}

/**
 * Where the rare-mass floor sits, and how much to trust it.
 *
 * Read it as a count: 3.5 means a pair must share the evidence-equivalent of three and a half
 * names that each occur in only two files.
 *
 * Calibrated on two labelled pairs, which is thin. At pre-collapse they score 6.7 and 5.0 and
 * the next pair scores 2.7; at HEAD, where both duplications are gone, nothing exceeds 2.7.
 * So 3.5 sits in a wide empty gap at both points — but with two examples that is a line drawn
 * between two clusters, not an estimate of anything. More labelled pairs would move it, and
 * the sweep in engine/tools/calibrate.ts is where they go.
 */
export const RARE_MASS_FLOOR = 3.5;

/** Names that repeat for conventional reasons and carry no signal even before weighting. */
const IGNORED = new Set([
  'constructor', 'render', 'toString', 'toJSON', 'valueOf', 'default',
]);

const stop = (s: string) => s.replace(/^['"`]|['"`]$/g, '');

/**
 * Pair key separator.
 *
 * Named rather than inlined because it was inlined, twice, and the two spellings silently
 * disagreed — one a space and one a NUL — so the inheritance guard below matched nothing and
 * a class and its own subclass were reported as parallel implementations. A separator that
 * cannot occur in a path is the right choice; using it in only one of the two places is not.
 */
const SEP = '\u0000';
const pairKey = (a: string, b: string) => (a < b ? a + SEP + b : b + SEP + a);

/** Method names per file. Nested helpers count once; a file is a bag of names. */
function namesByFile(functions: FunctionRecord[]): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const fn of functions) {
    const name = stop(fn.name);
    if (name.length < 3 || IGNORED.has(name)) continue;
    const set = byFile.get(fn.file);
    if (set) set.add(name);
    else byFile.set(fn.file, new Set([name]));
  }
  return byFile;
}

export function detectParallel(graph: Graph, opts: ParallelOptions = {}): ParallelPair[] {
  const minNames = opts.minNames ?? 4;
  const minShared = opts.minShared ?? 3;
  const minScore = opts.minScore ?? 0.35;
  const minRareMass = opts.minRareMass ?? RARE_MASS_FLOOR;
  const minRareNames = opts.minRareNames ?? 3;

  const byFile = new Map(
    [...namesByFile(graph.functions)].filter(([, names]) => names.size >= minNames),
  );
  const files = [...byFile.keys()].sort();
  if (files.length < 2) return [];

  // Document frequency over the files we are actually comparing.
  const df = new Map<string, number>();
  for (const names of byFile.values()) {
    for (const n of names) df.set(n, (df.get(n) ?? 0) + 1);
  }
  const total = files.length;
  /**
   * Smoothed IDF. A name in every file scores 0 rather than a small positive number, so
   * "both are repositories" contributes literally nothing instead of accumulating across
   * a dozen conventional names into a score that looks like a finding.
   */
  const idf = (name: string) => Math.log(total / (df.get(name) ?? 1));
  // "Rare" scales with the codebase: a name in 5% of files is rare in a big repo and
  // unremarkable in a small one. Floored at 2 so a tiny repo still has a rare band.
  const rareCutoff = Math.max(2, Math.round(total * 0.05));
  const isRare = (name: string) => (df.get(name) ?? 0) <= rareCutoff;
  // The most a single shared name can be worth here. Dividing by it makes the rare-mass
  // score a count of maximally-rare names, which means the same thing in a repo of any size.
  const unit = Math.log(total / 2) || 1;

  // Candidates by inverted index, so files sharing no name are never compared. Names in
  // most of the codebase generate no candidates — they are also the ones worth nothing.
  const postings = new Map<string, string[]>();
  for (const [file, names] of byFile) {
    for (const n of names) {
      if ((df.get(n) ?? 0) > Math.max(20, total * 0.25)) continue;
      const list = postings.get(n);
      if (list) list.push(file);
      else postings.set(n, [file]);
    }
  }

  /**
   * File pairs linked by inheritance.
   *
   * A subclass sharing its base class's method names is not two implementations of one
   * thing — it is one implementation, overridden, which is the mechanism working. Without
   * this, `BaseExecutor` and `PythonExecutor` score above the floor on the fixture purely for
   * being a class and its subclass, which is the most confidently wrong finding this detector
   * could produce.
   */
  const related = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== 'extends' && e.kind !== 'implements') continue;
    const fileOf = (id: string) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);
    const [x, y] = [fileOf(e.from), fileOf(e.to)];
    if (x !== y) related.add(pairKey(x, y));
  }

  const candidates = new Map<string, number>();
  for (const list of postings.values()) {
    if (list.length > 200) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = pairKey(list[i], list[j]);
        candidates.set(key, (candidates.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs: ParallelPair[] = [];
  for (const [key, count] of candidates) {
    if (count < minShared) continue;
    if (related.has(key)) continue;
    const [a, b] = key.split(SEP);
    const A = byFile.get(a)!;
    const B = byFile.get(b)!;

    const shared: string[] = [];
    const onlyA: string[] = [];
    const onlyB: string[] = [];
    for (const n of A) (B.has(n) ? shared : onlyA).push(n);
    for (const n of B) if (!A.has(n)) onlyB.push(n);
    if (shared.length < minShared) continue;

    let inter = 0;
    for (const n of shared) inter += idf(n);
    let union = inter;
    for (const n of onlyA) union += idf(n);
    for (const n of onlyB) union += idf(n);
    if (union <= 0) continue;

    const score = inter / union;
    const rare = shared.filter(isRare);
    const rareMass = rare.reduce((sum, n) => sum + idf(n), 0) / unit;

    const byOverlap = score >= minScore;
    const byRare = rare.length >= minRareNames && rareMass >= minRareMass;
    if (!byOverlap && !byRare) continue;

    // Rarest first: the top of this list is why the pair scored, and it is what a human
    // should read before deciding anything.
    const rarest = (xs: string[]) => [...xs].sort((x, y) => idf(y) - idf(x) || x.localeCompare(y));

    pairs.push({
      detector: 'D6',
      a,
      b,
      score,
      rareMass,
      by: byOverlap && byRare ? 'both' : byOverlap ? 'overlap' : 'rare-names',
      shared: rarest(shared),
      rare: rarest(rare),
      onlyA: onlyA.sort(),
      onlyB: onlyB.sort(),
    });
  }

  // By rare mass, because that is the score that survives one side having grown — and a
  // parallel implementation that grew is the one most worth knowing about.
  return pairs.sort(
    (x, y) => y.rareMass - x.rareMass || y.score - x.score || x.a.localeCompare(y.a),
  );
}
