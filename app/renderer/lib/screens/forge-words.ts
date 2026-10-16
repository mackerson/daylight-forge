import type {
  Attempt, CandidateVerdict, Decision, Experiment, ForgeCandidate, GateEvaluation, GuardedResult,
  LedgerRow, Mission, Need, PolicyRule, WorkItem, WorkItemStatus, Application,
} from '../types.ts';
import type { Word } from './mission-words.ts';

/**
 * The words the Forge screens use for what the engine records, and the little reshaping the
 * screens need. Pure, so it is tested without a window (forge-words.test.mjs).
 *
 * Three rules run through all of it. A missing figure is the word `unknown`, never `0`: a
 * provider that said nothing has not said zero. An open question stays on screen as open,
 * never hidden because the answer is not in yet (R9). And nothing here decides anything —
 * `needs` are the engine's, rendered; whether an act is allowed is the engine's guard, shown.
 */

export const UNKNOWN = 'unknown';

export const shortDigest = (d: string | null | undefined): string =>
  d ? d.replace(/^sha256:/, '').slice(0, 8) : UNKNOWN;

export const shortRef = (id: string | null | undefined): string => (id ? `${id.slice(0, 2)}${id.slice(2, 10)}` : UNKNOWN);

// ---- money and tokens ------------------------------------------------------------------

export function usd(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? UNKNOWN : `$${n.toFixed(2)}`;
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * A ledger total, as a floor. Unknown spend is counted, not summed as zero; scanned spend is a
 * pattern read out of output and is shown beside the floor, never inside it.
 */
export function ledgerUsd(r: Pick<LedgerRow, 'attempts' | 'usdKnown' | 'usdUnknownCount' | 'usdScanned'>): string {
  if (r.attempts > 0 && r.usdUnknownCount >= r.attempts) {
    return r.usdScanned > 0 ? `${UNKNOWN} (${r.usdUnknownCount} unknown, ${usd(r.usdScanned)} scanned)` : UNKNOWN;
  }
  if (r.usdUnknownCount === 0 && r.usdScanned === 0) return usd(r.usdKnown);
  const extra = [`${r.usdUnknownCount} unknown`];
  if (r.usdScanned > 0) extra.push(`${usd(r.usdScanned)} scanned`);
  return `≥ ${usd(r.usdKnown)} (${extra.join(', ')})`;
}

/** A token column of a ledger row: the known sum, a floor when some are unknown, or unknown. */
export function ledgerTokens(known: number, unknownCount: number, attempts: number): string {
  if (attempts > 0 && unknownCount >= attempts) return UNKNOWN;
  return unknownCount > 0 ? `≥ ${tokens(known)}` : tokens(known);
}

/**
 * Where a row's dollars came from (R10.2): the provider, a stdout scan, or nobody. A row mixes
 * attempts, so this names the mix rather than one source.
 */
export function costSourceOf(r: Pick<LedgerRow, 'attempts' | 'usdUnknownCount' | 'usdScanned'>): string {
  const provider = Math.max(0, r.attempts - r.usdUnknownCount);
  const parts: string[] = [];
  if (provider) parts.push(`provider ×${provider}`);
  if (r.usdScanned > 0) parts.push('stdout-scan');
  if (r.usdUnknownCount) parts.push(`none ×${r.usdUnknownCount}`);
  return parts.join(' · ') || 'none';
}

/** One attempt's cost with its source. A scanned figure is labelled as a guess. */
export function attemptCost(a: Pick<Attempt, 'costUsd' | 'costSource'>): string {
  if (a.costUsd === null || a.costUsd === undefined) return `cost ${UNKNOWN}`;
  if (a.costSource === 'stdout-scan') return `≈${usd(a.costUsd)} · stdout-scan, not known`;
  return `${usd(a.costUsd)} · ${a.costSource}`;
}

/** Ledger keys that are ingested work: recorded, not run by Daylight (R12.1). */
export const isIngestedKey = (key: string): boolean => /^ingest:/.test(key);

export const OUTSIDE = "outside Daylight's controls";

// ---- attempts and their sandboxes --------------------------------------------------------

export interface Badge extends Word { title?: string }

/**
 * What an attempt was allowed to do, as badges. Write is a mode, not a fault (R7): `write on`
 * names the authorize decision and who made it. Null sandbox is ingested work (R12.1).
 */
export function sandboxBadges(a: Pick<Attempt, 'sandbox' | 'origin'>, decisions: readonly Decision[] = []): Badge[] {
  if (a.origin === 'ingested' || a.sandbox === null) {
    return [{ name: OUTSIDE, tone: 'warn', title: 'recovered from a transcript; Daylight granted it nothing and cannot say what it had' }];
  }
  const s = a.sandbox;
  const out: Badge[] = [];
  out.push(s.profile === 'none'
    ? { name: 'unsandboxed — H5 open', tone: 'bad', title: 'a P0 reviewer runs with no sandbox; Sec H5 is open (R9.1)' }
    : { name: `profile ${s.profile}`, tone: 'accent' });
  if (s.write) {
    const d = decisions.find((x) => x.id === s.authorizeDecisionId);
    out.push({
      name: `write on — ${shortRef(s.authorizeDecisionId)} ${d ? d.actor : 'decision not in view'}`,
      tone: 'warn',
      title: 'granted by this mission\'s authorize decision',
    });
  } else {
    out.push({ name: 'write off', tone: 'dim' });
  }
  out.push(s.exec ? { name: 'exec on', tone: 'warn' } : { name: 'exec off', tone: 'dim' });
  out.push({ name: `network ${s.network}`, tone: s.network === 'none' ? 'dim' : 'warn' });
  return out;
}

/** The questions still open that change what these screens mean. Always shown (R9). */
export const OPEN_ITEMS: readonly { id: string; text: string }[] = [
  { id: 'R9.2', text: 'exec policy undecided (R9.2): whether an author may run commands is the owner\'s open question' },
  { id: 'H5', text: 'reviewer unsandboxed — H5 open (R9.1): review attempts run with profile none' },
  { id: 'Q5', text: 'claude unavailable for implement — Q5 pending: no live author run is authorised' },
];

/** Who can author an implement attempt in this build. Shown, never hidden, when unavailable. */
export interface Runner { tool: string; available: boolean; why: string }
export const IMPLEMENT_RUNNERS: readonly Runner[] = [
  { tool: 'claude', available: false, why: 'unavailable for implement — Q5 pending' },
  { tool: 'codex', available: false, why: 'unavailable for implement — Q5 pending' },
  { tool: 'mock', available: true, why: 'mock author — tests and fixtures only, spends nothing' },
];

/** The mission's budget as a badge: a ceiling, or the word for not having one. */
export const budgetWord = (m: Pick<Mission, 'budget'>): string =>
  m.budget.maxUsd !== undefined ? `maxUsd ${usd(m.budget.maxUsd)}` : 'maxUsd not set';

// ---- decisions -------------------------------------------------------------------------

const opOf = (d: Decision): string | null => {
  const op = (d.scope as { operation?: unknown }).operation;
  return typeof op === 'string' ? op : null;
};

/** The latest decision of one operation, optionally about one candidate or work item. */
export function latestDecision(decisions: readonly Decision[], operation: string, subjectKey?: string, subjectId?: string): Decision | null {
  let best: Decision | null = null;
  for (const d of decisions) {
    if (opOf(d) !== operation) continue;
    if (subjectKey && (d.scope as Record<string, unknown>)[subjectKey] !== subjectId) continue;
    if (!best || d.at > best.at) best = d;
  }
  return best;
}

// ---- gates -------------------------------------------------------------------------------

export interface GateRow {
  id: string;
  role: 'gate';
  hypothesis: string;
  harnessDigest: string;
  /** The gate at base: `falsified` is what a usable gate shows before the change. */
  baseline: Experiment['conclusion'] | 'not run';
  /** Passes at base already, so it cannot tell a change from no change. */
  vacuous: boolean;
  /** Named in the lock's `vacuousOverrides`: a person accepted it as vacuous, on the record. */
  acceptedAtLock: boolean;
}

export type GateLock =
  | { state: 'unlocked' }
  | { state: 'locked'; decisionId: string; actor: string; digest: string }
  | { state: 'stale'; decisionId: string; actor: string; digest: string; why: string };

export interface GateSetView {
  gates: GateRow[];
  /** Holdouts are counted. Their content never reaches a screen. */
  holdoutCount: number;
  lock: GateLock;
}

/**
 * The gate set as the screen shows it. Holdouts are reduced to a count here, before any
 * component sees them, so no render can leak a hypothesis, command or digest of one.
 */
export function gateSetView(
  experiments: readonly Experiment[], decisions: readonly Decision[], evaluations: readonly GateEvaluation[] = [],
): GateSetView {
  const baseOf = (id: string) => {
    const rows = evaluations.filter((e) => e.experimentId === id && e.target === 'base');
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return rows[0]?.conclusion;
  };
  const d = latestDecision(decisions, 'lock-gates');
  const overrides = new Set(((d?.scope as { vacuousOverrides?: string[] } | undefined)?.vacuousOverrides) ?? []);
  const gates: GateRow[] = experiments
    .filter((x) => x.role === 'gate')
    .map((x) => {
      const base = baseOf(x.id);
      return {
        id: x.id, role: 'gate', hypothesis: x.hypothesis, harnessDigest: x.harnessDigest,
        baseline: base ?? 'not run', vacuous: base === 'supported', acceptedAtLock: overrides.has(x.id),
      };
    });
  const holdouts = experiments.filter((x) => x.role === 'holdout');
  let lock: GateLock = { state: 'unlocked' };
  if (d) {
    const scope = d.scope as { gateSetDigest?: string; harnessDigests?: Record<string, string>; experimentIds?: string[] };
    const digest = scope.gateSetDigest ?? '';
    const locked = new Set(scope.experimentIds ?? []);
    const current = [...gates.map((g) => ({ id: g.id, h: g.harnessDigest })), ...holdouts.map((x) => ({ id: x.id, h: x.harnessDigest }))];
    const changed = current.filter((c) => locked.has(c.id) && scope.harnessDigests?.[c.id] !== c.h).length;
    const added = current.filter((c) => !locked.has(c.id)).length;
    lock = changed || added
      ? {
        state: 'stale', decisionId: d.id, actor: d.actor, digest,
        why: [changed ? `${changed} harness${changed === 1 ? '' : 'es'} changed since the lock` : '', added ? `${added} gate${added === 1 ? '' : 's'} added since the lock` : '']
          .filter(Boolean).join(', '),
      }
      : { state: 'locked', decisionId: d.id, actor: d.actor, digest };
  }
  return { gates, holdoutCount: holdouts.length, lock };
}

// ---- candidates ----------------------------------------------------------------------------

export function verdictWord(v: CandidateVerdict): Word {
  switch (v) {
    case 'accepted-by-gates': return { name: 'accepted by gates', tone: 'ok' };
    case 'rejected-by-gates': return { name: 'rejected by gates', tone: 'bad' };
    case 'policy-violation': return { name: 'policy violation', tone: 'bad' };
    case 'gates-invalid': return { name: 'gates invalid', tone: 'bad' };
    case 'gates-inconclusive': return { name: 'gates inconclusive', tone: 'warn' };
    case 'no-diff': return { name: 'no diff', tone: 'warn' };
    case 'stale-base': return { name: 'stale base', tone: 'warn' };
    default: return { name: 'pending', tone: 'dim' };
  }
}

export interface Allowed { enabled: boolean; why: string }

/** Approve is for `accepted-by-gates` only; anything else is an override, and says so. */
export function approveAllowed(c: Pick<ForgeCandidate, 'verdict'>): Allowed {
  if (c.verdict === 'accepted-by-gates') return { enabled: true, why: 'the gates accepted this candidate' };
  return {
    enabled: false,
    why: `approve needs accepted-by-gates; this candidate is ${verdictWord(c.verdict).name}. Override records a reason instead.`,
  };
}

/** Apply needs an approve or override of this candidate, and nothing applied yet. */
export function applyAllowed(c: Pick<ForgeCandidate, 'id'>, decisions: readonly Decision[], applications: readonly Application[]): Allowed {
  const done = applications.find((a) => a.candidateId === c.id);
  if (done) return { enabled: false, why: `already applied as ${done.commit.slice(0, 12)} on ${done.ref}` };
  const ok = latestDecision(decisions, 'approve-candidate', 'candidateId', c.id) ?? latestDecision(decisions, 'override-candidate', 'candidateId', c.id);
  if (!ok) return { enabled: false, why: 'apply needs an approve or an override of this candidate first' };
  return { enabled: true, why: `${opOf(ok) === 'override-candidate' ? 'overridden' : 'approved'} by ${ok.actor}` };
}

export interface FileFlag { path: string; change: string; insertions: number | null; deletions: number | null; rules: PolicyRule[] }

/** The files list with each path's policy rules, and the rules about the diff as a whole. */
export function flaggedFiles(c: Pick<ForgeCandidate, 'files' | 'policyViolations' | 'secretHits'>): { files: FileFlag[]; whole: PolicyRule[] } {
  const byPath = new Map<string, PolicyRule[]>();
  const whole: PolicyRule[] = [];
  for (const v of c.policyViolations) {
    if (v.path === null) whole.push(v.rule);
    else byPath.set(v.path, [...(byPath.get(v.path) ?? []), v.rule]);
  }
  if (c.secretHits > 0 && !whole.includes('secret-in-diff') && ![...byPath.values()].some((r) => r.includes('secret-in-diff'))) {
    whole.push('secret-in-diff');
  }
  const files: FileFlag[] = c.files.map((f) => ({
    path: f.path, change: f.change, insertions: f.insertions, deletions: f.deletions, rules: byPath.get(f.path) ?? [],
  }));
  for (const [p, rules] of byPath) {
    if (!c.files.some((f) => f.path === p)) files.push({ path: p, change: 'outside the files list', insertions: null, deletions: null, rules });
  }
  return { files, whole };
}

export const RULE_WORDS: Record<PolicyRule, string> = {
  'protected-path': 'protected path',
  'gate-path': 'touches the gates',
  'spec-path': 'touches the spec',
  'outside-scope': 'outside the mission scope',
  'path-escape': 'path escapes the tree',
  symlink: 'symlink',
  gitlink: 'gitlink (submodule)',
  'exec-mode': 'made executable',
  'empty-diff': 'empty diff',
  'too-many-files': 'too many files',
  'too-large': 'diff too large',
  'secret-in-diff': 'secret in diff (redacted)',
};

export interface DiffLine { n: number; text: string; kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx' }

/** Diff text as numbered lines, bounded. Text only: the screen never interprets it as markup. */
export function diffLines(text: string, max = 4000): { lines: DiffLine[]; cut: number } {
  const all = text.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const lines = all.slice(0, max).map((t, i): DiffLine => ({
    n: i + 1,
    text: t.length > 2000 ? `${t.slice(0, 2000)}…` : t,
    kind: /^(diff --git|index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename )/.test(t) ? 'meta'
      : t.startsWith('@@') ? 'hunk' : t.startsWith('+') ? 'add' : t.startsWith('-') ? 'del' : 'ctx',
  }));
  return { lines, cut: Math.max(0, all.length - max) };
}

// ---- work items --------------------------------------------------------------------------

export interface AnchorGroup { anchor: string; items: WorkItem[]; ambiguous: boolean }
export interface StatusGroup { status: WorkItemStatus; anchors: AnchorGroup[] }

const STATUS_ORDER: WorkItemStatus[] = ['proposed', 'approved', 'rejected', 'superseded'];

/**
 * The queue by status, then by anchor. Two proposals for one anchor are a spec ambiguity and
 * sit side by side; the engine raises the `spec-ambiguity` need, this only groups.
 */
export function workItemQueue(items: readonly WorkItem[], needs: readonly Need[] = []): StatusGroup[] {
  const ambiguousRefs = new Set(needs.filter((n) => n.kind === 'spec-ambiguity').map((n) => n.ref));
  return STATUS_ORDER.map((status) => {
    const by = new Map<string, WorkItem[]>();
    for (const w of items) {
      if (w.status !== status) continue;
      by.set(w.anchor, [...(by.get(w.anchor) ?? []), w]);
    }
    const anchors = [...by.entries()].map(([anchor, list]) => ({
      anchor,
      items: list.sort((a, b) => a.createdAt - b.createdAt),
      ambiguous: status === 'proposed' && (list.length > 1 || list.some((w) => ambiguousRefs.has(w.id) || ambiguousRefs.has(w.anchor))),
    }));
    anchors.sort((a, b) => Number(b.ambiguous) - Number(a.ambiguous) || a.anchor.localeCompare(b.anchor));
    return { status, anchors };
  }).filter((g) => g.anchors.length > 0);
}

// ---- needs --------------------------------------------------------------------------------

export type ForgeScreen = 'missions' | 'work-items' | 'ledger' | 'ingest';
export type ImplementTab = 'attempts' | 'gates' | 'candidate';

export interface NeedTarget { screen: ForgeScreen; missionId?: string; tab?: ImplementTab; candidateId?: string }

/**
 * Where a need is answered. The ref names what it is about by its id prefix; a need whose ref
 * the screen does not recognise opens the mission list rather than guessing.
 */
export function needTarget(n: Need, missionOfCandidate: (id: string) => string | undefined = () => undefined): NeedTarget {
  const mission = /^m_[0-9a-f]{32}$/.test(n.ref) ? n.ref : undefined;
  switch (n.kind) {
    case 'spec-ambiguity': return { screen: 'work-items' };
    case 'gate-lock':
    case 'gate-vacuous':
      return mission ? { screen: 'missions', missionId: mission, tab: 'gates' } : { screen: 'missions' };
    case 'candidate-decision':
    case 'apply': {
      if (/^c_[0-9a-f]{32}$/.test(n.ref)) {
        const m = missionOfCandidate(n.ref);
        return m ? { screen: 'missions', missionId: m, tab: 'candidate', candidateId: n.ref } : { screen: 'missions' };
      }
      return mission ? { screen: 'missions', missionId: mission, tab: 'candidate' } : { screen: 'missions' };
    }
    default:
      return mission ? { screen: 'missions', missionId: mission } : { screen: 'missions' };
  }
}

/** One list from the work-item listing and the per-mission needs, each need once. */
export function mergeNeeds(...lists: ReadonlyArray<readonly Need[] | undefined>): Need[] {
  const seen = new Set<string>();
  const out: Need[] = [];
  for (const list of lists) {
    for (const n of list ?? []) {
      const k = `${n.kind}\u0000${n.ref}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(n);
    }
  }
  return out;
}

export const needsStrip = (running: number, needs: number): string => `${running} running · ${needs} need you`;

export const NEED_WORDS: Record<Need['kind'], string> = {
  blocked: 'blocked',
  dispute: 'dispute',
  'spec-ambiguity': 'spec ambiguity',
  'gate-lock': 'lock gates',
  'gate-vacuous': 'vacuous gate',
  'candidate-decision': 'decide candidate',
  apply: 'apply',
};

// ---- guarded acts -------------------------------------------------------------------------

/** How a guarded act ended, as one line. Refusal text is the engine's, verbatim. */
export function guardWord(r: GuardedResult | null): Word & { detail?: string } {
  if (!r) return { name: '', tone: 'dim' };
  if (r.refused) return { name: 'refused — nothing recorded', tone: 'bad', detail: r.refused };
  if (r.canceled) return { name: `cancelled at the dialog${r.digest8 ? ` (${r.digest8})` : ''} — nothing recorded`, tone: 'dim' };
  if (r.error) return { name: 'the act failed', tone: 'bad', detail: r.error };
  if (r.ok) return { name: `done · confirmed ${r.digest8 ?? ''}`.trim(), tone: 'ok' };
  return { name: 'no answer', tone: 'warn' };
}

/** Editable starting points, so a rationale is a pick and a tweak rather than a paragraph. */
export const RATIONALE_PRESETS: Record<string, readonly string[]> = {
  approve: ['gates and holdouts pass; diff read and matches the work item', 'small, scoped change; gates pass'],
  reject: ['diff does not do what the work item asks', 'touches more than it should', 'gates pass for the wrong reason'],
  override: ['gate is wrong, not the change', 'flaky gate; passed on manual rerun', 'accepted risk, recorded here'],
  'approve-work-item': ['clear, testable, matches the spec', 'the better of the sibling proposals'],
  'reject-work-item': ['ambiguous; the sibling proposal is clearer', 'out of scope for the spec', 'duplicate'],
  lock: ['these gates define done for this item', 'reviewed the gate tests; they fail at base for the right reason'],
  authorize: ['implement this work item in its detached workspace', 'write only; gates execute'],
};
