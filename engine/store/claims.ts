import { DatabaseSync } from 'node:sqlite';

/**
 * The claim store. Every interesting assertion about the graph lives here with its
 * provenance, and nothing is ever overwritten — disagreement is preserved, not resolved.
 *
 * Uses node:sqlite so there is no native dependency to rebuild.
 */

export type {
  SourceKind, Source, Evidence, ClaimInput, Claim, ClaimStatus, Belief,
} from './types.ts';
import type { Claim, ClaimInput, ClaimStatus, Belief, Evidence, Source } from './types.ts';

/**
 * Predicate polarity.
 *
 * Discovered by running two models on the same questions: the naive "values differ →
 * CONTRADICTED" rule gets this exactly backwards. Two prose descriptions of the same
 * module always differ textually, producing loud false contradictions; meanwhile a real
 * disagreement expressed as `duplicates` vs `not_duplicates` never gets compared at all,
 * because the predicate names differ. So:
 *
 *  - NARRATIVE predicates (purpose, description) never contradict. Independent
 *    descriptions accumulate as corroboration and are kept side by side for a human or
 *    agent to merge. Comparing them by string equality is meaningless.
 *  - VERDICT predicates are normalised onto a single predicate with a boolean value, so
 *    `not_duplicates` is recognised as the negation of `duplicates` rather than a
 *    different topic.
 */
const NARRATIVE_PREDICATES = new Set(['purpose', 'description', 'summary', 'notes', 'role']);

/** `predicate` → `[canonicalPredicate, valueWhenAsserted]`. */
const POLARITY: Record<string, [string, boolean]> = {
  duplicates: ['duplication_verdict', true],
  not_duplicates: ['duplication_verdict', false],
  is_dead: ['liveness_verdict', true],
  partially_dead: ['liveness_verdict', true],
  not_dead: ['liveness_verdict', false],
  is_live: ['liveness_verdict', false],
  has_bug: ['bug_verdict', true],
  no_bug: ['bug_verdict', false],
  cluster_verdict: ['cluster_verdict', true],
  elision_verdict: ['elision_verdict', true],
  // The canonical names must map to themselves. Without this an agent using
  // `duplication_verdict` directly — rather than `duplicates` — skipped the boolean
  // requirement and could submit an arbitrary object, which produced a false
  // CONTRADICTED between two claims that agreed but spelled a JSON key differently
  // (`sameConcept` vs `same_concept`). Seen on this repo.
  duplication_verdict: ['duplication_verdict', true],
  liveness_verdict: ['liveness_verdict', true],
  bug_verdict: ['bug_verdict', true],
  cycle_verdict: ['cycle_verdict', true],
  limb_verdict: ['limb_verdict', true],
  god_verdict: ['god_verdict', true],
  divergence_verdict: ['divergence_verdict', true],
};

export function isNarrative(predicate: string): boolean {
  return NARRATIVE_PREDICATES.has(predicate);
}

/** Maps a raw predicate/value onto its canonical comparable form. */
export function canonicalise(
  predicate: string,
  value: unknown,
): { predicate: string; compare: unknown } {
  const polar = POLARITY[predicate];
  if (polar) {
    const [canonical, asserts] = polar;
    // The predicate carries a polarity, but an explicit boolean value can invert it:
    // `is_dead: false` means alive, not dead. A non-boolean value (agents usually send
    // a prose rationale) leaves the predicate's own polarity standing.
    const compare = typeof value === 'boolean' ? (asserts ? value : !value) : asserts;
    return { predicate: canonical, compare };
  }
  return { predicate, compare: value };
}

export class EvidenceRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceRequired';
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  value         TEXT NOT NULL,
  source_kind   TEXT NOT NULL,
  source_tool   TEXT,
  source_model  TEXT,
  source_session TEXT,
  confidence    REAL NOT NULL,
  evidence      TEXT NOT NULL,
  observed_hash TEXT,
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_subject ON claims(subject, predicate);

CREATE TABLE IF NOT EXISTS clusters (
  id        TEXT PRIMARY KEY,
  level     INTEGER NOT NULL,
  name      TEXT NOT NULL,
  purpose   TEXT NOT NULL,
  members   TEXT NOT NULL,
  source    TEXT NOT NULL,
  evidence  TEXT NOT NULL,
  at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS elisions (
  id       TEXT PRIMARY KEY,
  level    INTEGER NOT NULL,
  members  TEXT NOT NULL,
  into_node TEXT,
  reason   TEXT NOT NULL,
  source   TEXT NOT NULL,
  at       INTEGER NOT NULL,
  revoked  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS leases (
  subject   TEXT NOT NULL,
  session   TEXT NOT NULL,
  until     INTEGER NOT NULL,
  PRIMARY KEY (subject)
);

CREATE TABLE IF NOT EXISTS defences (
  id       TEXT PRIMARY KEY,
  node     TEXT NOT NULL,
  reason   TEXT NOT NULL,
  source   TEXT NOT NULL,
  at       INTEGER NOT NULL
);
`;

/** Deterministic id so re-proposing the same thing updates rather than duplicates. */
export function stableId(prefix: string, parts: string[]): string {
  const joined = [...parts].sort().join('|');
  let h = 0;
  for (let i = 0; i < joined.length; i++) h = (Math.imul(31, h) + joined.charCodeAt(i)) | 0;
  return `${prefix}_${(h >>> 0).toString(36)}`;
}

export class ClaimStore {
  private db: DatabaseSync;
  /** Injected so the store stays deterministic under test and under workflow replay. */
  private now: () => number;

  constructor(dbPath: string, now: () => number = () => Date.now()) {
    this.db = new DatabaseSync(dbPath);
    /**
     * Concurrency, which this store is for.
     *
     * The whole design is a swarm — leases exist precisely so several agents can work at
     * once — and two agents launched together crashed on `database is locked` before either
     * had asked a question. SQLite's default is one writer and no waiting, which is the
     * wrong default for the one access pattern this file was built to serve.
     *
     * WAL lets readers run while a writer holds the lock, and a busy timeout makes a
     * competing writer wait its turn instead of failing instantly. Neither weakens any
     * guarantee: writes are still serialised, they just queue rather than crash.
     */
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 10000');
    this.db.exec(SCHEMA);
    this.now = now;
  }

  close(): void {
    this.db.close();
  }

  /**
   * The evidence boundary. An agent assertion without a citable span or an explicit
   * reasoning note is rejected here — this is the single guard against a confabulated
   * map, and it is enforced at ingest rather than at review time.
   */
  submit(input: ClaimInput): Claim {
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new EvidenceRequired(
        `claim ${input.predicate} on ${input.subject} has no evidence; ` +
          'cite a file (and line where possible) or an explicit reasoning note',
      );
    }
    for (const e of input.evidence) {
      if (!e.file && !e.note) {
        throw new EvidenceRequired('each evidence item needs a file or a note');
      }
    }
    if (!(input.confidence >= 0 && input.confidence <= 1)) {
      throw new EvidenceRequired(`confidence must be within 0..1, got ${input.confidence}`);
    }

    // Verdict predicates must carry a boolean. Agents otherwise send a predicate whose
    // name says one thing and a prose value that says the opposite ("duplicates" with
    // value "false — these are NOT duplicates"), which no polarity rule can resolve and
    // which shows up as a phantom disagreement. Force the ambiguity into a boundary error.
    /**
     * `"true"` is a boolean that went through a JSON boundary. Prose is not.
     *
     * The rule that a verdict must carry a boolean is right, and it stays: an agent sending
     * `duplicates` with the value "false — these are NOT duplicates" is the failure it exists
     * to stop. But a bare `"true"` carries no reasoning to lose, so rejecting it was not
     * enforcing the rule — it was refusing an answer over its serialisation.
     *
     * It cost more than it sounds. Watched live, an agent assigned a `god_verdict` question
     * answered it fifteen times, was rejected fifteen times, and burned its whole budget
     * without landing a single claim. No verdict claim could be submitted at all, which means
     * the contradiction queue — the screen this design calls its highest-value surface — has
     * been unreachable for verdicts since the rule landed. That is why no cross-model
     * disagreement had ever been seen: not because models agree, but because neither could
     * record an answer.
     */
    const bare = typeof input.value === 'string' ? input.value.trim().toLowerCase() : null;
    if (POLARITY[input.predicate] && (bare === 'true' || bare === 'false')) {
      input = { ...input, value: bare === 'true' };
    }

    if (POLARITY[input.predicate] && typeof input.value !== 'boolean') {
      throw new EvidenceRequired(
        `predicate '${input.predicate}' is a verdict and needs a boolean value ` +
          `(got ${typeof input.value}). Put the reasoning in evidence[].note, not in value.`,
      );
    }

    /**
     * Dismissal is not free.
     *
     * Evidence enforcement makes a *false* claim expensive but does nothing about a
     * *dismissive* one: an agent could clear the frontier cheaply by ruling things out, and
     * nothing cost it anything. desloppify solves the analogous problem by widening its score
     * gap on `wontfix`; this is our version.
     *
     * Asserting a thing means finding one place it is true. Ruling it out means checking the
     * places it could have been true — strictly more work — so a negative verdict must cite
     * strictly more, and at least one citation must point at a line rather than waving at a
     * file. Humans are exempt: arbitration is the point at which someone takes responsibility.
     */
    const polar = POLARITY[input.predicate];
    if (polar && input.value === false && input.source.kind !== 'human') {
      const cited = input.evidence.filter((e) => e.file && typeof e.line === 'number');
      if (input.evidence.length < 2 || cited.length < 1) {
        throw new EvidenceRequired(
          `ruling out '${input.predicate}' on ${input.subject} needs at least two pieces of ` +
            'evidence including one with a line number — show where it would have been true. ' +
            `Got ${input.evidence.length} item(s), ${cited.length} with a line.`,
        );
      }
    }

    const at = input.at ?? this.now();
    this.db
      .prepare(
        `INSERT INTO claims
         (subject, predicate, value, source_kind, source_tool, source_model, source_session,
          confidence, evidence, observed_hash, at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.subject,
        input.predicate,
        JSON.stringify(input.value ?? null),
        input.source.kind,
        input.source.tool ?? null,
        input.source.model ?? null,
        input.source.sessionId ?? null,
        input.confidence,
        JSON.stringify(input.evidence),
        input.observedHash ?? null,
        at,
      );

    const id = Number(
      (this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
    );
    return { ...input, id, at };
  }

  /** Every claim on a subject whose canonical predicate matches, across polar aliases. */
  claimsForCanonical(subject: string, canonical: string): Claim[] {
    return this.claimsFor(subject).filter(
      (c) => canonicalise(c.predicate, c.value).predicate === canonical,
    );
  }

  claimsFor(subject: string, predicate?: string): Claim[] {
    const rows = predicate
      ? this.db.prepare('SELECT * FROM claims WHERE subject=? AND predicate=? ORDER BY at').all(subject, predicate)
      : this.db.prepare('SELECT * FROM claims WHERE subject=? ORDER BY at').all(subject);
    return (rows as any[]).map(rowToClaim);
  }

  allSubjects(): Array<{ subject: string; predicate: string }> {
    return this.db
      .prepare('SELECT DISTINCT subject, predicate FROM claims')
      .all() as Array<{ subject: string; predicate: string }>;
  }

  /**
   * Derives the current belief for one subject+predicate.
   *
   * Agreement raises confidence but does not erase the individual claims; disagreement
   * becomes CONTRADICTED and stays that way until a human resolves it. Nothing here
   * auto-resolves a conflict — that is the whole point.
   */
  belief(subject: string, predicate: string, currentHash?: string, admit?: (c: Claim) => boolean): Belief {
    // Gather across polar aliases so `duplicates` and `not_duplicates` are compared
    // rather than filed as unrelated topics. `admit` narrows the claims a belief is derived
    // from — one mission's reviewers, say — without changing how it is derived.
    const canonical = canonicalise(predicate, undefined).predicate;
    const gathered =
      canonical === predicate ? this.claimsFor(subject, predicate) : this.claimsForCanonical(subject, canonical);
    const claims = admit ? gathered.filter(admit) : gathered;
    if (!claims.length) {
      return { subject, predicate, status: 'UNKNOWN', confidence: 0, claims: [] };
    }

    const human = claims.filter((c) => c.source.kind === 'human');
    if (human.length) {
      const latest = human[human.length - 1];
      return {
        subject, predicate, status: 'CONFIRMED', value: latest.value,
        confidence: 1, claims,
      };
    }

    if (currentHash && claims.every((c) => c.observedHash && c.observedHash !== currentHash)) {
      return {
        subject, predicate, status: 'STALE',
        value: claims[claims.length - 1].value,
        confidence: 0, claims,
      };
    }

    // Group by canonical comparable value; distinct independent sources are what counts.
    // Narrative predicates all collapse into one group: prose never contradicts prose.
    const narrative = isNarrative(canonical);
    const byValue = new Map<string, Claim[]>();
    for (const c of claims) {
      const key = narrative
        ? 'narrative'
        : JSON.stringify(canonicalise(c.predicate, c.value).compare ?? null);
      const list = byValue.get(key);
      if (list) list.push(c);
      else byValue.set(key, [c]);
    }

    const independent = (list: Claim[]) =>
      new Set(list.map((c) => `${c.source.kind}:${c.source.tool ?? ''}:${c.source.model ?? ''}`)).size;

    const groups = [...byValue.entries()]
      .map(([key, list]) => ({ key, list, sources: independent(list) }))
      .sort((a, b) => b.sources - a.sources || b.list.length - a.list.length);

    const top = groups[0];
    const contested = groups.length > 1 && groups.some((g) => g !== top && g.sources >= 1);

    if (contested) {
      return { subject, predicate, status: 'CONTRADICTED', confidence: 0, claims };
    }

    const best = Math.max(...top.list.map((c) => c.confidence));
    const status: ClaimStatus = top.sources >= 2 ? 'CORROBORATED' : 'INFERRED';
    const confidence = top.sources >= 2 ? Math.min(1, best + 0.15 * (top.sources - 1)) : best;

    return { subject, predicate, status, value: top.list[0].value, confidence, claims };
  }

  /** Everything currently in dispute — the highest-value screen in the product. */
  contradictions(): Belief[] {
    const seen = new Set<string>();
    const out: Belief[] = [];
    for (const { subject, predicate } of this.allSubjects()) {
      const canonical = canonicalise(predicate, undefined).predicate;
      const key = `${subject}\u0000${canonical}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const b = this.belief(subject, predicate);
      if (b.status === 'CONTRADICTED') out.push(b);
    }
    return out;
  }

  // ---- focus operations (P3) -------------------------------------------------

  putCluster(c: {
    id?: string; level: number; name: string; purpose: string;
    members: string[]; source: Source; evidence: Evidence[];
  }): string {
    const id = c.id ?? stableId('cl', c.members);
    this.db
      .prepare(
        `INSERT INTO clusters (id, level, name, purpose, members, source, evidence, at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, purpose=excluded.purpose, members=excluded.members,
           source=excluded.source, evidence=excluded.evidence, at=excluded.at`,
      )
      .run(id, c.level, c.name, c.purpose, JSON.stringify(c.members),
           JSON.stringify(c.source), JSON.stringify(c.evidence), this.now());
    return id;
  }

  /**
   * Rows from a level-scoped table, optionally filtered.
   *
   * Extracted because D4 found `clusters()` and `elisions()` to be the same 116 tokens at
   * 0.92 — the same optional-level filter and the same JSON-column parse, written twice. The
   * per-row mapping stays with each caller, since that part genuinely differs.
   */
  private atLevel(table: 'clusters' | 'elisions', where: string, level?: number): unknown[] {
    const clause = [where, level === undefined ? '' : 'level=?'].filter(Boolean).join(' AND ');
    const sql = `SELECT * FROM ${table}${clause ? ` WHERE ${clause}` : ''}`;
    return level === undefined
      ? this.db.prepare(sql).all()
      : this.db.prepare(sql).all(level);
  }

  clusters(level?: number) {
    return (this.atLevel('clusters', '', level) as any[]).map((r) => ({
      id: r.id as string,
      level: r.level as number,
      name: r.name as string,
      purpose: r.purpose as string,
      members: JSON.parse(r.members as string) as string[],
      source: JSON.parse(r.source as string) as Source,
      evidence: JSON.parse(r.evidence as string) as Evidence[],
      at: r.at as number,
    }));
  }

  putElision(e: {
    id?: string; level: number; members: string[]; into?: string;
    reason: string; source: Source;
  }): string {
    const id = e.id ?? stableId('el', e.members);
    this.db
      .prepare(
        `INSERT INTO elisions (id, level, members, into_node, reason, source, at, revoked)
         VALUES (?,?,?,?,?,?,?,0)
         ON CONFLICT(id) DO UPDATE SET
           members=excluded.members, into_node=excluded.into_node, reason=excluded.reason,
           source=excluded.source, at=excluded.at, revoked=0`,
      )
      .run(id, e.level, JSON.stringify(e.members), e.into ?? null, e.reason,
           JSON.stringify(e.source), this.now());
    return id;
  }

  /** Elisions are reversible by construction — a focused map you can't expand is a lie. */
  revokeElision(id: string): void {
    this.db.prepare('UPDATE elisions SET revoked=1 WHERE id=?').run(id);
  }

  elisions(level?: number) {
    return (this.atLevel('elisions', 'revoked=0', level) as any[]).map((r) => ({
      id: r.id as string,
      level: r.level as number,
      members: JSON.parse(r.members as string) as string[],
      into: (r.into_node ?? undefined) as string | undefined,
      reason: r.reason as string,
      source: JSON.parse(r.source as string) as Source,
      at: r.at as number,
    }));
  }

  putDefence(d: { node: string; reason: string; source: Source }): string {
    const id = stableId('df', [d.node, d.reason]);
    this.db
      .prepare(
        `INSERT INTO defences (id, node, reason, source, at) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET reason=excluded.reason, at=excluded.at`,
      )
      .run(id, d.node, d.reason, JSON.stringify(d.source), this.now());
    return id;
  }

  defences(): Array<{ id: string; node: string; reason: string; source: Source }> {
    return (this.db.prepare('SELECT * FROM defences').all() as any[]).map((r) => ({
      id: r.id as string,
      node: r.node as string,
      reason: r.reason as string,
      source: JSON.parse(r.source as string) as Source,
    }));
  }

  /**
   * Frontier leasing.
   *
   * `get_open_questions` used to be stateless, so every agent that asked got the identical
   * top-ranked list and concurrent runs duplicated each other by construction. A lease
   * records who is working where — the same trick the manual audit used when it
   * "partitioned the stale set four ways so the areas did not overlap", except recorded in
   * the shared environment rather than in someone's head.
   *
   * Leases expire rather than being released: an agent that dies mid-run must not hold work
   * hostage, and the cost of occasionally handing the same item out twice is far lower than
   * the cost of a frontier item nobody can ever be assigned.
   */
  lease(subjects: string[], session: string, ms = 15 * 60_000): void {
    const until = this.now() + ms;
    const stmt = this.db.prepare(
      `INSERT INTO leases (subject, session, until) VALUES (?,?,?)
       ON CONFLICT(subject) DO UPDATE SET session=excluded.session, until=excluded.until`,
    );
    for (const s of subjects) stmt.run(s, session, until);
  }

  /** Subjects currently leased to someone other than `session`. */
  leasedElsewhere(session: string): Set<string> {
    const rows = this.db
      .prepare('SELECT subject FROM leases WHERE session != ? AND until > ?')
      .all(session, this.now()) as Array<{ subject: string }>;
    return new Set(rows.map((r) => r.subject));
  }

  releaseLeases(session: string): void {
    this.db.prepare('DELETE FROM leases WHERE session = ?').run(session);
  }

  activeLeases(): Array<{ subject: string; session: string; until: number }> {
    return this.db
      .prepare('SELECT * FROM leases WHERE until > ? ORDER BY until')
      .all(this.now()) as Array<{ subject: string; session: string; until: number }>;
  }

  /**
   * Verdict claims that predate the boolean rule.
   *
   * These were collected when a verdict could carry prose, and `submit` now rejects them —
   * so importing a colleague's older store drops them silently into `rejected` and the
   * knowledge is simply gone. Coercing them is not an option: `duplicates` with the value
   * "false — these are NOT duplicates" is exactly the case the boolean rule exists to stop,
   * and guessing which way it points would fabricate a verdict nobody gave.
   *
   * So they are surfaced as *questions*. The subject goes back to the frontier and gets
   * asked again, with the original claim's evidence attached so the second answer is cheaper
   * than the first.
   */
  legacyVerdicts(): Array<{
    subject: string;
    predicate: string;
    value: unknown;
    evidence: Evidence[];
    source: Source;
  }> {
    const out: Array<{
      subject: string; predicate: string; value: unknown; evidence: Evidence[]; source: Source;
    }> = [];
    for (const { subject, predicate } of this.allSubjects()) {
      if (!POLARITY[predicate]) continue;
      for (const c of this.claimsFor(subject, predicate)) {
        if (typeof c.value === 'boolean') continue;
        out.push({
          subject, predicate, value: c.value, evidence: c.evidence, source: c.source,
        });
      }
    }
    return out.sort(
      (a, b) => a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate),
    );
  }

  /**
   * Follow a file that moved.
   *
   * Claims are keyed by subject, and a subject is a path. When the path changes, every claim
   * about it is orphaned — still stored, attached to something that no longer exists, and
   * invisible on the map. Since this tool spends its time recommending exactly the refactors
   * that move files, it was quietly punishing you for taking its advice.
   *
   * Rewrites in place rather than re-asserting: the claim, its evidence, its confidence and
   * above all *who said it and when* are unchanged, because none of that stopped being true.
   * A move is not new knowledge, so it must not look like new knowledge — re-asserting would
   * make a two-month-old human confirmation appear to have been made by the migration.
   *
   * Evidence file paths move with the subject, or the arbitration screen would try to show
   * spans from a file that is gone.
   */
  migrateSubject(from: string, to: string): number {
    if (from === to) return 0;
    const prefixed = (subject: string) =>
      subject === from || subject.startsWith(`${from}#`)
        ? to + subject.slice(from.length)
        : null;

    const rows = this.db
      .prepare('SELECT id, subject, evidence FROM claims')
      .all() as Array<{ id: number; subject: string; evidence: string }>;

    const update = this.db.prepare('UPDATE claims SET subject = ?, evidence = ? WHERE id = ?');
    let moved = 0;
    for (const row of rows) {
      const next = prefixed(row.subject);
      if (!next) continue;
      let evidence: Evidence[];
      try {
        evidence = JSON.parse(row.evidence) as Evidence[];
      } catch {
        evidence = [];
      }
      const rewritten = evidence.map((e) =>
        e.file === from ? { ...e, file: to } : e,
      );
      update.run(next, JSON.stringify(rewritten), row.id);
      moved++;
    }

    // Clusters, elisions and defences name files too; a stale member is a phantom node.
    const remap = (list: string[]) => list.map((m) => prefixed(m) ?? m);
    for (const c of this.clusters()) {
      const members = remap(c.members);
      if (members.join() !== c.members.join()) {
        this.db.prepare('UPDATE clusters SET members = ? WHERE id = ?')
          .run(JSON.stringify(members), c.id);
      }
    }
    for (const e of this.elisions()) {
      const members = remap(e.members);
      if (members.join() !== e.members.join()) {
        this.db.prepare('UPDATE elisions SET members = ? WHERE id = ?')
          .run(JSON.stringify(members), e.id);
      }
    }
    for (const d of this.defences()) {
      const node = prefixed(d.node);
      if (node) this.db.prepare('UPDATE defences SET node = ? WHERE id = ?').run(node, d.id);
    }

    return moved;
  }

  stats() {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as any).n);
    return {
      claims: one('SELECT COUNT(*) AS n FROM claims'),
      subjects: one('SELECT COUNT(DISTINCT subject) AS n FROM claims'),
      clusters: one('SELECT COUNT(*) AS n FROM clusters'),
      elisions: one('SELECT COUNT(*) AS n FROM elisions WHERE revoked=0'),
      defences: one('SELECT COUNT(*) AS n FROM defences'),
      leases: Number(
        (this.db.prepare('SELECT COUNT(*) AS n FROM leases WHERE until > ?').get(this.now()) as any).n,
      ),
    };
  }
}

function rowToClaim(r: any): Claim {
  return {
    id: r.id,
    subject: r.subject,
    predicate: r.predicate,
    value: JSON.parse(r.value),
    source: {
      kind: r.source_kind,
      tool: r.source_tool ?? undefined,
      model: r.source_model ?? undefined,
      sessionId: r.source_session ?? undefined,
    },
    confidence: r.confidence,
    evidence: JSON.parse(r.evidence),
    observedHash: r.observed_hash ?? undefined,
    at: r.at,
  };
}
