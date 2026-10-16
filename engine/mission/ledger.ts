import type { DaylightContext } from './context.ts';
import {
  EXPORT_SCHEMA_VERSION, isEntityId,
  type Attempt, type AttemptOrigin, type Candidate, type Decision, type DecisionOperation,
  type Ledger, type LedgerDecisionCount, type LedgerRevision, type LedgerRow, type LedgerWorkItem, type Mission,
} from './types.ts';

/**
 * The project ledger: what was spent, by whom, on what, and what came of it.
 *
 * Figures come from attempt rows only — `attempts.cost_usd`, `cost_source` and the token
 * columns that capture promotes from `attempt_usage` — never from a sum over events. A null
 * is counted as unknown and never summed as zero; a scraped figure is spend, shown apart from
 * known dollars; nothing is estimated and there is no price table. An ingested attempt is
 * recorded work done outside Daylight's controls and is labelled so wherever it is shown.
 *
 * The ledger carries no timestamp, so an export → import → ledger round trip is byte-equal.
 */

type Ctx = Pick<DaylightContext, 'store'>;

export type LedgerGroup = 'runner' | 'model' | 'origin' | 'mission' | 'work-item' | 'actor';
export const LEDGER_GROUPS: readonly LedgerGroup[] = ['runner', 'model', 'origin', 'mission', 'work-item', 'actor'];

export interface LedgerOptions {
  projectId: string;
  group: LedgerGroup;
  /** Epoch ms: attempts started, decisions made and missions created at or after it. */
  since?: number;
  /** Only attempts of this origin, and only decisions about their missions. */
  origin?: AttemptOrigin;
}

/** The words every view uses for an ingested attempt (R12.1). */
export const OUTSIDE_CONTROLS = "outside Daylight's controls";

/** Sums of dollars, rounded so that the same rows always print the same bytes. */
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

const REJECTED = new Set<Candidate['verdict']>(['rejected-by-gates', 'policy-violation', 'no-diff', 'stale-base', 'gates-invalid']);

function askedModel(runnerId: string): string | null {
  const m = /^agent:[^:]+:(.+)$/.exec(runnerId);
  return m && m[1] !== 'default' ? m[1] : null;
}

/** The model as the provider reported it; otherwise what was asked for, labelled as asked. */
function modelKey(a: Attempt): string {
  if (a.model) return a.model;
  const asked = askedModel(a.runnerId);
  return asked ? `${asked} (asked; not reported)` : 'unknown';
}

const operationOf = (d: Decision): DecisionOperation | null =>
  typeof d.scope.operation === 'string' ? (d.scope.operation as DecisionOperation) : null;

type TokenField = 'input' | 'output' | 'cacheRead' | 'cacheWrite';
const TOKEN_FIELDS: readonly TokenField[] = ['input', 'output', 'cacheRead', 'cacheWrite'];

/**
 * Per row and token field, how many attempts reported nothing for that field. A `LedgerRow`
 * sums known counts and carries one `unknownCount` for attempts with no usage at all; an
 * attempt that reported some fields and not others (codex has no cache-write figure) is a gap
 * the row alone cannot show, so renderers take this beside it and print a floor or `unknown`.
 */
export type TokenGaps = Record<string, Record<TokenField, number>>;

export function ledger(ctx: Ctx, o: LedgerOptions): Ledger {
  return ledgerWithGaps(ctx, o).ledger;
}

export function ledgerWithGaps(ctx: Ctx, o: LedgerOptions): { ledger: Ledger; gaps: TokenGaps } {
  const since = o.since ?? 0;
  const missions = new Map(ctx.store.missions(o.projectId).map((m) => [m.id, m]));
  const attempts = ctx.store.projectAttempts(o.projectId, { since })
    .filter((a) => o.origin === undefined || a.origin === o.origin);
  const inScope = (m: Mission) => o.origin === undefined
    || attempts.some((a) => a.missionId === m.id)
    || (o.origin === 'daylight' && m.kind !== 'work');
  const scoped = [...missions.values()].filter(inScope);

  const decisions = scoped.flatMap((m) => ctx.store.decisions(m.id)).filter((d) => d.at >= since);
  const candidates = scoped.flatMap((m) => ctx.store.candidates(m.id));
  const applications = scoped.flatMap((m) => ctx.store.applications(m.id)).filter((p) => p.at >= since);
  const appliedIds = new Set(scoped.flatMap((m) => ctx.store.applications(m.id)).map((p) => p.candidateId));
  const overridden = new Set(decisions.filter((d) => operationOf(d) === 'override-candidate')
    .map((d) => String(d.scope.candidateId)));
  const candidatesOf = new Map<string, Candidate[]>();
  for (const c of candidates) candidatesOf.set(c.attemptId, [...(candidatesOf.get(c.attemptId) ?? []), c]);

  const keyOf = (a: Attempt): string => {
    switch (o.group) {
      case 'runner': case 'actor': return a.runnerId;
      case 'model': return modelKey(a);
      case 'origin': return a.origin;
      case 'mission': return a.missionId;
      case 'work-item': return missions.get(a.missionId)?.workItemId ?? 'none';
    }
  };
  const byKey = new Map<string, Attempt[]>();
  for (const a of attempts) byKey.set(keyOf(a), [...(byKey.get(keyOf(a)) ?? []), a]);

  // Which row a decision is counted in. A person's decisions go on their own row when grouping
  // by actor; otherwise on the rows of the work they were about.
  const decisionKeys = (d: Decision): string[] => {
    if (o.group === 'actor') return [d.actor];
    if (o.group === 'mission') return [d.missionId];
    if (o.group === 'work-item') return [missions.get(d.missionId)?.workItemId ?? 'none'];
    const c = typeof d.scope.candidateId === 'string' ? candidates.find((x) => x.id === d.scope.candidateId) : undefined;
    const a = c ? attempts.find((x) => x.id === c.attemptId) : undefined;
    return a ? [keyOf(a)] : [];
  };
  const decisionCount = new Map<string, number>();
  for (const d of decisions) for (const k of decisionKeys(d)) decisionCount.set(k, (decisionCount.get(k) ?? 0) + 1);

  const keys = [...new Set([...byKey.keys(), ...decisionCount.keys()])].sort();
  const gaps: TokenGaps = {};
  const rows: LedgerRow[] = keys.map((key) => {
    const as = byKey.get(key) ?? [];
    const cs = as.flatMap((a) => candidatesOf.get(a.id) ?? []);
    // Known counts only; the nulls are counted in `gaps`, never added in as zeros.
    const sum = (f: TokenField) => as.reduce((n, a) => n + (a.tokens[f] ?? 0), 0);
    gaps[key] = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, as.filter((a) => a.tokens[f] === null).length])) as Record<TokenField, number>;
    return {
      key,
      attempts: as.length,
      usdKnown: round(as.filter((a) => a.costSource === 'provider').reduce((n, a) => n + (a.costUsd ?? 0), 0)),
      usdUnknownCount: as.filter((a) => a.costUsd === null).length,
      usdScanned: round(as.filter((a) => a.costSource === 'stdout-scan').reduce((n, a) => n + (a.costUsd ?? 0), 0)),
      tokens: {
        input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'),
        unknownCount: as.filter((a) => a.usageSource === 'none').length,
      },
      candidates: {
        accepted: cs.filter((c) => c.verdict === 'accepted-by-gates').length,
        rejected: cs.filter((c) => REJECTED.has(c.verdict)).length,
        applied: cs.filter((c) => appliedIds.has(c.id)).length,
        overridden: cs.filter((c) => overridden.has(c.id)).length,
      },
      decisions: decisionCount.get(key) ?? 0,
      gateSetDigests: [...new Set(as.map((a) => a.gateSetDigest).filter((g): g is string => !!g))].sort(),
    };
  });

  const counts = new Map<string, LedgerDecisionCount>();
  for (const d of decisions) {
    const operation = operationOf(d);
    const k = JSON.stringify([d.actor, d.kind, operation]);
    const c = counts.get(k) ?? { actor: d.actor, kind: d.kind, operation, count: 0 };
    c.count++;
    counts.set(k, c);
  }
  const decisionRows = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);

  const workItems: LedgerWorkItem[] = ctx.store.workItems(o.projectId)
    .filter((w) => o.origin !== 'ingested' && w.createdAt >= since)
    .map((w) => ({ id: w.id, missionId: w.missionId, title: w.title, status: w.status }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const revisions = new Map<string, LedgerRevision>();
  for (const m of scoped) {
    if (m.createdAt < since && !attempts.some((a) => a.missionId === m.id)) continue;
    const r = revisions.get(m.baseRevision) ?? { revision: m.baseRevision, missions: 0, attempts: 0 };
    r.missions++;
    r.attempts += attempts.filter((a) => a.missionId === m.id).length;
    revisions.set(m.baseRevision, r);
  }

  const built: Ledger = {
    kind: 'daylight-ledger',
    schemaVersion: EXPORT_SCHEMA_VERSION,
    projectId: o.projectId,
    rows,
    decisions: decisionRows,
    workItems,
    applications: applications.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)),
    revisions: [...revisions.values()].sort((a, b) => (a.revision < b.revision ? -1 : 1)),
  };
  return { ledger: built, gaps };
}

/** Gaps summed over rows, for a total line. */
export function totalGaps(gaps: TokenGaps, keys: readonly string[]): Record<TokenField, number> {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const k of keys) for (const f of TOKEN_FIELDS) out[f] += gaps[k]?.[f] ?? 0;
  return out;
}

// ---- mission spend ------------------------------------------------------------

/**
 * What a mission has spent, over every attempt it has ever had — not one run's — because the
 * budget is the mission's (Ledger H3). `spentUsd` is what counts against a ceiling: known
 * dollars plus scanned ones, since a scraped figure is still money that went somewhere.
 * `knownUsd` is the provider's own figures only.
 */
export interface MissionSpend {
  spentUsd: number;
  knownUsd: number;
  /** Finished attempts with no figure at all. */
  unknownCount: number;
  /** Attempts whose figure was read from output by pattern. */
  scannedCount: number;
  /** Attempts not finished yet: their spend is not in yet either. */
  runningCount: number;
  /** True only when every attempt is finished with a provider figure. */
  costKnown: boolean;
}

export function missionSpend(ctx: Ctx, missionId: string): MissionSpend {
  if (!ctx.store.mission(missionId)) throw new Error(`unknown mission ${missionId}`);
  const attempts = ctx.store.tasks(missionId).flatMap((t) => ctx.store.attempts(t.id));
  const live = (a: Attempt) => a.state === 'starting' || a.state === 'running';
  const finished = attempts.filter((a) => !live(a));
  const unknownCount = finished.filter((a) => a.costUsd === null).length;
  const scannedCount = attempts.filter((a) => a.costSource === 'stdout-scan').length;
  const runningCount = attempts.length - finished.length;
  return {
    spentUsd: round(attempts.reduce((n, a) => n + (a.costUsd ?? 0), 0)),
    knownUsd: round(attempts.filter((a) => a.costSource === 'provider').reduce((n, a) => n + (a.costUsd ?? 0), 0)),
    unknownCount,
    scannedCount,
    runningCount,
    costKnown: unknownCount === 0 && scannedCount === 0 && runningCount === 0,
  };
}

/**
 * Why a mission under `ceilingUsd` may not launch more work, or null when it may. Spent at or
 * past the ceiling stops it; so does any unknown figure, because a ceiling only holds while
 * spend is known. A scanned figure counts toward spend and does not by itself stop it.
 */
export function spendRefusal(spend: MissionSpend, ceilingUsd: number | undefined): string | null {
  if (!ceilingUsd) return null;
  if (spend.spentUsd >= ceilingUsd) {
    return `budget exhausted: spent $${spend.spentUsd.toFixed(2)} of $${ceilingUsd.toFixed(2)}`;
  }
  if (spend.unknownCount || spend.runningCount) {
    const n = spend.unknownCount + spend.runningCount;
    return `cost unknown for ${n} attempt(s), so the $${ceilingUsd.toFixed(2)} ceiling cannot be enforced`;
  }
  return null;
}

// ---- git trailers ---------------------------------------------------------------

/**
 * The only Daylight trailers this module supplies for a commit: which mission and attempt it
 * came from. Dollars and tokens stay in the ledger and never enter git history (RULINGS R4
 * Q3a). Ids are checked by shape, so nothing but an id can reach a trailer line.
 */
export function trailersFor(missionId: string, attemptId: string): string[] {
  if (!isEntityId('mission', missionId)) throw new Error(`not a mission id: ${JSON.stringify(missionId)}`);
  if (!isEntityId('attempt', attemptId)) throw new Error(`not an attempt id: ${JSON.stringify(attemptId)}`);
  return [`Daylight-Mission: ${missionId}`, `Daylight-Attempt: ${attemptId}`];
}

// ---- rendering --------------------------------------------------------------------

const money = (n: number): string => `$${n.toFixed(2)}`;
const count = (n: number): string => n.toLocaleString('en-US');

/**
 * A row's dollars as words a reader cannot misread. `unknown` when nobody reported a figure
 * (never `$0.00`); a floor, `≥`, when some did not; scanned spend shown beside, never inside,
 * the known figure.
 */
export function dollarsOf(r: LedgerRow): string {
  if (r.attempts === 0) return '—';
  if (r.usdUnknownCount === r.attempts) return 'unknown';
  const unknown = r.usdUnknownCount ? `${r.usdUnknownCount} unknown` : '';
  if (r.usdKnown === 0 && r.usdScanned > 0) {
    return `${money(r.usdScanned)} scanned, not known${unknown ? ` (${unknown})` : ''}`;
  }
  const notes = [unknown, r.usdScanned > 0 ? `${money(r.usdScanned)} scanned, not known` : ''].filter(Boolean);
  return notes.length ? `≥ ${money(r.usdKnown)} (${notes.join(', ')})` : money(r.usdKnown);
}

/**
 * One cell per token field: `unknown` when no attempt reported it, a floor when some did not.
 * Without `gap` (a ledger read back from JSON) the row's no-usage count stands for every field.
 */
export function tokenCells(r: LedgerRow, gap?: Record<TokenField, number>): string[] {
  if (r.attempts === 0) return ['—', '—', '—', '—'];
  return TOKEN_FIELDS.map((f) => {
    const missing = gap?.[f] ?? r.tokens.unknownCount;
    if (missing >= r.attempts) return 'unknown';
    return `${missing ? '≥ ' : ''}${count(r.tokens[f])}`;
  });
}

/** The one-line total over rows, `≥ $X (N unknown, M scanned)` when it is a floor. */
export function totalOf(rows: readonly LedgerRow[]): LedgerRow {
  const z: LedgerRow = {
    key: 'total', attempts: 0, usdKnown: 0, usdUnknownCount: 0, usdScanned: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownCount: 0 },
    candidates: { accepted: 0, rejected: 0, applied: 0, overridden: 0 }, decisions: 0, gateSetDigests: [],
  };
  for (const r of rows) {
    z.attempts += r.attempts;
    z.usdKnown = round(z.usdKnown + r.usdKnown);
    z.usdUnknownCount += r.usdUnknownCount;
    z.usdScanned = round(z.usdScanned + r.usdScanned);
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'unknownCount'] as const) z.tokens[f] += r.tokens[f];
    for (const f of ['accepted', 'rejected', 'applied', 'overridden'] as const) z.candidates[f] += r.candidates[f];
    z.decisions += r.decisions;
    z.gateSetDigests = [...new Set([...z.gateSetDigests, ...r.gateSetDigests])].sort();
  }
  return z;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The rows of one ledger as a markdown table, with a total line beneath. */
export function renderLedger(l: Ledger, opts: { heading?: string; keyLabel?: string; gaps?: TokenGaps } = {}): string {
  const out: string[] = [];
  if (opts.heading) out.push(`## ${opts.heading}`, '');
  const rows = l.rows.filter((r) => r.attempts > 0);
  if (!rows.length) {
    out.push('No attempts.', '');
    return out.join('\n');
  }
  out.push(`| ${opts.keyLabel ?? 'key'} | attempts | dollars | tokens in | out | cache read | cache write | tokens unknown | candidates (accepted/rejected/applied/overridden) |`);
  out.push('|---|---:|---|---:|---:|---:|---:|---:|---|');
  const line = (r: LedgerRow, label: string, gap: Record<TokenField, number> | undefined) => {
    const c = r.candidates;
    out.push(`| ${label} | ${r.attempts} | ${dollarsOf(r)} | ${tokenCells(r, gap).join(' | ')} | ${r.tokens.unknownCount} | ${c.accepted}/${c.rejected}/${c.applied}/${c.overridden} |`);
  };
  for (const r of rows) line(r, r.key === 'ingested' ? `ingested — ${OUTSIDE_CONTROLS}` : `\`${cell(r.key)}\``, opts.gaps?.[r.key]);
  if (rows.length > 1) {
    line(totalOf(rows), '**total**', opts.gaps ? totalGaps(opts.gaps, rows.map((r) => r.key)) : undefined);
  }
  out.push('');
  return out.join('\n');
}
