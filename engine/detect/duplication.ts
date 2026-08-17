import type { FunctionRecord, Graph, ShapeRecord } from '../graph/types.ts';

/**
 * D1–D4. All four are deterministic and cheap — no LLM finds anything here.
 * Agents only adjudicate the families these produce. See DESIGN.md, "Duplication families".
 */

export interface D1Pair {
  detector: 'D1';
  a: string;
  b: string;
  /** Jaccard over `name:type` pairs — the strict reading. */
  score: number;
  /** Jaccard over field names alone — catches "same shape, drifted types". */
  nameScore: number;
  shared: string[];
  onlyA: string[];
  onlyB: string[];
}

/** What every group-shaped detector result carries. */
export interface DetectorGroup {
  detector: 'D2' | 'D3';
  /** The thing the members share: a name for D2, a signature for D3. */
  key: string;
  members: string[];
}

export interface D2Group extends DetectorGroup {
  detector: 'D2';
  exportedCount: number;
}

export interface D3Group extends DetectorGroup {
  detector: 'D3';
}

/**
 * D4 — two function *bodies* that do the same work.
 *
 * D2 and D3 look at the outside of a function: its name and its signature. Neither sees
 * the case that actually motivates a dedup — a body copied to a second file and lightly
 * renamed, which by construction has a different name and often a different signature.
 * D4 is the detector that reads the inside.
 */
export interface D4Pair {
  detector: 'D4';
  a: string;
  b: string;
  /** Estimated Jaccard over the bodies' token shingles, from the MinHash signatures. */
  score: number;
  /** Token count of the smaller body — how much code the finding is actually about. */
  tokens: number;
  /** True when the two also share a name, i.e. D2 already saw them. */
  sameName: boolean;
}

/**
 * A D2/D3 group too large to be copy-paste. `getById` across 19 repositories is
 * the repository pattern, not duplication — it's evidence of a shared *role*, which
 * makes it input to clustering (L2) rather than a dedup finding. Kept, not discarded.
 */
export type Pattern = DetectorGroup;

export interface Family {
  id: string;
  members: string[];
  detectors: Array<'D1' | 'D2' | 'D3' | 'D4'>;
  /** Highest D1 score in the family, when D1 contributed. */
  topScore?: number;
  evidence: string[];
}

export interface DuplicationReport {
  d1: D1Pair[];
  d2: D2Group[];
  d3: D3Group[];
  d4: D4Pair[];
  patterns: Pattern[];
  families: Family[];
}

export interface DuplicationOptions {
  /** Structures with fewer fields than this are too generic to be signal. */
  minFields?: number;
  /** Report D1 pairs at or above this name-set Jaccard. */
  minNameScore?: number;
  /** Candidate pairs must share at least this many field names. */
  minSharedFields?: number;
  /**
   * Floor on the typed Jaccard. Shapes that share field *names* but no field *types*
   * are coincidence, not duplication — `DuplicationReport` and `Link` both have d1/d2/d3
   * and mean nothing alike. Calibrated on the enclave fixture: none of its 75 pairs score
   * 0.00 typed and the weakest genuine finding is 0.33, so this costs no recall there.
   */
  minTypedScore?: number;
  /** D2/D3 groups larger than this are conventions; they become patterns, not families. */
  maxGroupSize?: number;
  /** Report D4 pairs at or above this estimated body Jaccard. */
  minBodyScore?: number;
  /** Bodies smaller than this are too short for similarity to mean anything. */
  minBodyTokens?: number;
}

const stop = (s: string) => s.replace(/^['"`]|['"`]$/g, '');

// ---- D1: structure shape ----------------------------------------------------

function fieldKeys(shape: ShapeRecord) {
  const names = new Set(shape.fields.map((f) => stop(f.name)));
  const typed = new Set(shape.fields.map((f) => `${stop(f.name)}:${f.type}`));
  return { names, typed };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function detectD1(shapes: ShapeRecord[], opts: DuplicationOptions = {}): D1Pair[] {
  const minFields = opts.minFields ?? 3;
  const minNameScore = opts.minNameScore ?? 0.6;
  const minShared = opts.minSharedFields ?? 2;
  const minTyped = opts.minTypedScore ?? 0.1;

  const eligible = shapes.filter((s) => s.fields.length >= minFields);
  const keyed = eligible.map((s) => ({ shape: s, ...fieldKeys(s) }));

  // Candidate generation by inverted index on field name — avoids the N² matrix.
  const byField = new Map<string, number[]>();
  keyed.forEach((entry, i) => {
    for (const name of entry.names) {
      const bucket = byField.get(name);
      if (bucket) bucket.push(i);
      else byField.set(name, [i]);
    }
  });

  const candidateCounts = new Map<string, number>();
  for (const bucket of byField.values()) {
    // A field name shared by half the codebase (`id`, `name`) generates no signal.
    if (bucket.length > 200) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const key = `${bucket[i]}|${bucket[j]}`;
        candidateCounts.set(key, (candidateCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs: D1Pair[] = [];
  for (const [key, sharedCount] of candidateCounts) {
    if (sharedCount < minShared) continue;
    const [i, j] = key.split('|').map(Number);
    const A = keyed[i];
    const B = keyed[j];
    if (A.shape.nodeId === B.shape.nodeId) continue;

    const nameScore = jaccard(A.names, B.names);
    if (nameScore < minNameScore) continue;

    const typedScore = jaccard(A.typed, B.typed);
    if (typedScore < minTyped) continue;

    const shared: string[] = [];
    const onlyA: string[] = [];
    const onlyB: string[] = [];
    for (const n of A.names) (B.names.has(n) ? shared : onlyA).push(n);
    for (const n of B.names) if (!A.names.has(n)) onlyB.push(n);

    pairs.push({
      detector: 'D1',
      a: A.shape.nodeId,
      b: B.shape.nodeId,
      score: typedScore,
      nameScore,
      shared: shared.sort(),
      onlyA: onlyA.sort(),
      onlyB: onlyB.sort(),
    });
  }

  return pairs.sort((x, y) => y.nameScore - x.nameScore || y.score - x.score);
}

// ---- D2: duplicate function names -------------------------------------------

/** Names that repeat for conventional reasons, not because anyone copy-pasted. */
const D2_IGNORED = new Set([
  'constructor', 'render', 'toString', 'toJSON', 'valueOf', 'default',
  'handler', 'main', 'run', 'init', 'setup', 'teardown', 'dispose', 'destroy',
]);

export function detectD2(functions: FunctionRecord[]): D2Group[] {
  const byName = new Map<string, FunctionRecord[]>();
  for (const fn of functions) {
    const name = stop(fn.name);
    if (name.length < 3 || D2_IGNORED.has(name)) continue;
    const list = byName.get(name);
    if (list) list.push(fn);
    else byName.set(name, [fn]);
  }

  const groups: D2Group[] = [];
  for (const [name, fns] of byName) {
    const distinctFiles = new Set(fns.map((f) => f.file));
    // Same name twice in one file is an overload or a nested helper, not a family.
    if (fns.length < 2 || distinctFiles.size < 2) continue;
    groups.push({
      detector: 'D2',
      key: name,
      members: fns.map((f) => f.nodeId),
      exportedCount: fns.filter((f) => f.exported).length,
    });
  }

  return groups.sort((a, b) => b.members.length - a.members.length);
}

// ---- D3: duplicate signatures -----------------------------------------------

export function detectD3(functions: FunctionRecord[]): D3Group[] {
  const byKey = new Map<string, FunctionRecord[]>();

  for (const fn of functions) {
    const paramTypes = fn.params.map((p) => p.type);
    // Without type inference an un-annotated function is `(any) => any`. That's
    // absence of information, not evidence of duplication — drop it.
    const informative =
      paramTypes.some((t) => t !== 'any') || (fn.returnType !== 'any' && fn.returnType !== 'void');
    if (!informative || paramTypes.length === 0) continue;

    const key = `(${paramTypes.join(', ')}) => ${fn.returnType}`;
    const list = byKey.get(key);
    if (list) list.push(fn);
    else byKey.set(key, [fn]);
  }

  const groups: D3Group[] = [];
  for (const [key, fns] of byKey) {
    const distinctNames = new Set(fns.map((f) => stop(f.name)));
    // Same signature AND same name is already D2's finding; D3 earns its keep
    // on differently-named functions that do structurally identical work.
    if (fns.length < 2 || distinctNames.size < 2) continue;
    groups.push({ detector: 'D3', key, members: fns.map((f) => f.nodeId) });
  }

  return groups.sort((a, b) => b.members.length - a.members.length);
}

// ---- D4: duplicate bodies ----------------------------------------------------

/**
 * Candidates come from LSH banding rather than an N² sweep: two signatures that agree on
 * a whole band of positions are very likely similar overall, and everything else is never
 * compared. With 12 hashes in 4 bands this finds pairs above ~0.7 similarity reliably while
 * comparing a small fraction of the matrix.
 */
export function detectD4(functions: FunctionRecord[], opts: DuplicationOptions = {}): D4Pair[] {
  const minScore = opts.minBodyScore ?? 0.85;
  const minTokens = opts.minBodyTokens ?? 40;
  const BANDS = 4;

  const eligible = functions.filter(
    (f) => f.body && f.body.length && (f.bodyTokens ?? 0) >= minTokens,
  );
  const width = eligible[0]?.body?.length ?? 0;
  if (!width) return [];
  const rows = Math.max(1, Math.floor(width / BANDS));

  const buckets = new Map<string, number[]>();
  eligible.forEach((fn, i) => {
    const sig = fn.body!;
    for (let b = 0; b < BANDS; b++) {
      const key = `${b}:${sig.slice(b * rows, (b + 1) * rows).join(',')}`;
      const list = buckets.get(key);
      if (list) list.push(i);
      else buckets.set(key, [i]);
    }
  });

  const seen = new Set<string>();
  const pairs: D4Pair[] = [];
  for (const bucket of buckets.values()) {
    // A band shared by hundreds of functions is boilerplate shape, not a copy.
    if (bucket.length < 2 || bucket.length > 60) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const A = eligible[bucket[i]];
        const B = eligible[bucket[j]];
        if (A.nodeId === B.nodeId) continue;
        // A body compared against itself in the same file is an overload, not a copy.
        if (A.file === B.file && stop(A.name) === stop(B.name)) continue;
        const key = pairKey(A.nodeId, B.nodeId);
        if (seen.has(key)) continue;
        seen.add(key);

        let same = 0;
        for (let k = 0; k < width; k++) if (A.body![k] === B.body![k]) same++;
        const score = same / width;
        if (score < minScore) continue;

        pairs.push({
          detector: 'D4',
          a: A.nodeId,
          b: B.nodeId,
          score,
          tokens: Math.min(A.bodyTokens ?? 0, B.bodyTokens ?? 0),
          sameName: stop(A.name) === stop(B.name),
        });
      }
    }
  }

  return pairs.sort((x, y) => y.score - x.score || y.tokens - x.tokens);
}

// ---- families ---------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root === x) {
      this.parent.set(x, x);
      return x;
    }
    root = this.find(root);
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const SEP = ' ';
const pairKey = (a: string, b: string) => (a < b ? a + SEP + b : b + SEP + a);

interface Link {
  d1?: number;
  d2?: string;
  d3?: string;
  d4?: number;
}

/**
 * Cluster detector links into families so we adjudicate once per family rather
 * than once per pair — the difference between N² and N agent calls.
 *
 * The qualification rule matters more than the clustering. Unioning on *any*
 * detector link takes transitive closure through common signatures — one run on the
 * enclave fixture welded 107 unrelated symbols into a single "family" via chains of
 * `(string) => Promise<void>`. So a link only qualifies when the evidence is specific:
 *
 *   - D1 alone qualifies. Shape similarity over >=3 named fields is specific.
 *   - D4 alone qualifies. A body match is the most specific evidence any of these produce —
 *     it is the only detector that has read the code rather than its label.
 *   - D2 + D3 together qualify. Two independent weak detectors agreeing on the same
 *     pair is corroboration.
 *   - D2 or D3 alone does not. Those still surface as their own groups; they just
 *     don't get to merge clusters on their own authority.
 *
 * Precision over recall: a noisy map is ignored, and an over-merged family is worse
 * than no family at all because it hides the real one inside it.
 */
export function buildFamilies(
  d1: D1Pair[],
  d2: D2Group[],
  d3: D3Group[],
  d4: D4Pair[] = [],
  opts: DuplicationOptions = {},
): Family[] {
  const maxGroup = opts.maxGroupSize ?? 6;
  const links = new Map<string, Link>();

  const link = (a: string, b: string, mut: (l: Link) => void) => {
    if (a === b) return;
    const key = pairKey(a, b);
    const existing = links.get(key) ?? {};
    mut(existing);
    links.set(key, existing);
  };

  for (const p of d1) link(p.a, p.b, (l) => (l.d1 = Math.max(l.d1 ?? 0, p.nameScore)));
  for (const p of d4) link(p.a, p.b, (l) => (l.d4 = Math.max(l.d4 ?? 0, p.score)));

  for (const g of d2) {
    if (g.members.length > maxGroup) continue;
    for (let i = 0; i < g.members.length; i++) {
      for (let j = i + 1; j < g.members.length; j++) {
        link(g.members[i], g.members[j], (l) => (l.d2 = g.key));
      }
    }
  }
  for (const g of d3) {
    if (g.members.length > maxGroup) continue;
    for (let i = 0; i < g.members.length; i++) {
      for (let j = i + 1; j < g.members.length; j++) {
        link(g.members[i], g.members[j], (l) => (l.d3 = g.key));
      }
    }
  }

  const uf = new UnionFind();
  const detectors = new Map<string, Set<'D1' | 'D2' | 'D3' | 'D4'>>();
  const evidence = new Map<string, Set<string>>();

  const note = (id: string, det: 'D1' | 'D2' | 'D3' | 'D4', why: string) => {
    const d = detectors.get(id) ?? new Set<'D1' | 'D2' | 'D3' | 'D4'>();
    d.add(det);
    detectors.set(id, d);
    const e = evidence.get(id) ?? new Set<string>();
    e.add(why);
    evidence.set(id, e);
  };

  for (const [key, l] of links) {
    const qualifies =
      l.d1 !== undefined || l.d4 !== undefined || (l.d2 !== undefined && l.d3 !== undefined);
    if (!qualifies) continue;

    const [a, b] = key.split(SEP);
    uf.union(a, b);
    for (const id of [a, b]) {
      if (l.d1 !== undefined) note(id, 'D1', `D1 shape ${l.d1.toFixed(2)} name-set Jaccard`);
      if (l.d2 !== undefined) note(id, 'D2', `D2 name ${l.d2}`);
      if (l.d3 !== undefined) note(id, 'D3', `D3 signature ${l.d3}`);
      if (l.d4 !== undefined) note(id, 'D4', `D4 body ${l.d4.toFixed(2)} token-shingle Jaccard`);
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const id of detectors.keys()) {
    const root = uf.find(id);
    const list = byRoot.get(root);
    if (list) list.push(id);
    else byRoot.set(root, [id]);
  }

  const families: Family[] = [];
  for (const [root, members] of byRoot) {
    if (members.length < 2) continue;
    const dets = new Set<'D1' | 'D2' | 'D3' | 'D4'>();
    const ev = new Set<string>();
    let top = 0;
    for (const m of members) {
      for (const d of detectors.get(m) ?? []) dets.add(d);
      for (const e of evidence.get(m) ?? []) ev.add(e);
    }
    for (const [key, l] of links) {
      if (l.d1 === undefined) continue;
      const [a] = key.split(SEP);
      if (uf.find(a) === root) top = Math.max(top, l.d1);
    }
    families.push({
      id: root,
      members: members.sort(),
      detectors: [...dets].sort(),
      topScore: top || undefined,
      evidence: [...ev].sort(),
    });
  }

  // Multi-detector families first: agreement across independent detectors is the
  // strongest signal we have without asking an agent anything.
  return families.sort(
    (a, b) =>
      b.detectors.length - a.detectors.length ||
      (b.topScore ?? 0) - (a.topScore ?? 0) ||
      b.members.length - a.members.length,
  );
}

export function detectDuplication(graph: Graph, opts: DuplicationOptions = {}): DuplicationReport {
  const maxGroup = opts.maxGroupSize ?? 6;

  const d1 = detectD1(graph.shapes, opts);
  const d4 = detectD4(graph.functions, opts);
  const allD2 = detectD2(graph.functions);
  const allD3 = detectD3(graph.functions);

  const d2 = allD2.filter((g) => g.members.length <= maxGroup);
  const d3 = allD3.filter((g) => g.members.length <= maxGroup);

  const patterns: Pattern[] = [...allD2, ...allD3]
    .filter((g) => g.members.length > maxGroup)
    .sort((a, b) => b.members.length - a.members.length);

  return { d1, d2, d3, d4, patterns, families: buildFamilies(d1, d2, d3, d4, opts) };
}
