import { STATUS_BUCKET_OF, STATUS_BUCKETS } from '../../../../engine/mission/types.ts';
import { campaignSpendWords, spendWords } from '../../../../engine/forge/spend-words.ts';
import type {
  CampaignEnvelope, CampaignHaltReason, CampaignSpend, DiffStat, FindingSeverity, FocusItem, FocusKind, FocusRule,
  ForgeAssumptionRow, ForgeCampaignShow, ForgeryClass, Mission, Need, RefineOverlay, ReportBlocked, RunClaim,
  SpendLine, StatusBucket, TicketStatus, WaveReport, CampaignAuthorizeForm,
} from '../types.ts';
import type { Word } from './mission-words.ts';
import type { CampaignTab } from './forge-words.ts';

/**
 * The words and the little layout the campaign screens use. Pure, so it is tested without a
 * window (campaign-words.test.mjs).
 *
 * Nothing here ranks, derives a status or adds up spend: the engine does all three and these
 * functions only say what it reported. Two rules carry over from the Forge words: a missing
 * figure is never `$0.00`, and an open question stays on screen until a person answers it.
 */

export { STATUS_BUCKETS, STATUS_BUCKET_OF };

export type { CampaignTab };
export const CAMPAIGN_TABS: ReadonlyArray<{ value: CampaignTab; label: string }> = [
  { value: 'overview', label: 'overview' },
  { value: 'report', label: 'wave report' },
  { value: 'assumptions', label: 'assumptions' },
  { value: 'refine', label: 'refine' },
];

/** `regressed` is keyed in STATUS_BUCKET_OF ahead of `TicketStatus` gaining it (P2-R44, P2-R47). */
export type TicketStatusWord = TicketStatus | 'regressed';
export const TICKET_STATUSES: readonly TicketStatusWord[] = Object.keys(STATUS_BUCKET_OF) as TicketStatusWord[];

const money = (n: number): string => `$${n.toFixed(2)}`;
export const UNKNOWN = 'unknown';

// ---- states ------------------------------------------------------------------------------

export function ticketTone(s: TicketStatusWord): Word {
  switch (s) {
    case 'landed': return { name: 'landed', tone: 'ok' };
    case 'running': return { name: 'running', tone: 'accent' };
    case 'integrating': return { name: 'integrating', tone: 'accent' };
    case 'blocked': return { name: 'blocked', tone: 'bad' };
    case 'regressed': return { name: 'regressed', tone: 'bad' };
    case 'waiting-owner': return { name: 'waiting on owner', tone: 'warn' };
    case 'waiting-dependency': return { name: 'waiting on dependency', tone: 'warn' };
    case 'ready': return { name: 'ready', tone: 'dim' };
    case 'waiting': return { name: 'waiting', tone: 'dim' };
    case 'superseded': return { name: 'superseded', tone: 'dim' };
    case 'stale': return { name: 'stale', tone: 'warn' };
    default: return { name: String(s), tone: 'warn' };
  }
}

/** Node fill for the DAG, one per status: the word is always beside it, never only the colour. */
export const TICKET_FILL: Record<TicketStatusWord, string> = {
  landed: '#3fb37f', running: '#6ea8fe', integrating: '#8a5cf6', blocked: '#e5534b', regressed: '#c93c37',
  'waiting-owner': '#e0a33a', 'waiting-dependency': '#d29922', ready: '#8b949e', waiting: '#57606a', superseded: '#3b4048',
  stale: '#bf8700',
};

export const BUCKET_WORDS: Record<StatusBucket, string> = {
  done: 'done', 'in-progress': 'in progress', blocked: 'blocked', requests: 'requests', queued: 'queued', superseded: 'superseded',
};
export function bucketWord(b: StatusBucket): Word {
  const tone = b === 'done' ? 'ok' : b === 'in-progress' ? 'accent' : b === 'blocked' ? 'bad' : b === 'requests' ? 'warn' : 'dim';
  return { name: BUCKET_WORDS[b], tone };
}

/** The run claim as words: a live pid is a run; a dead one is a claim left behind, said as such. */
export function runWord(run: RunClaim | null): Word | null {
  if (!run) return null;
  if (run.alive) return { name: `running · pid ${run.pid}`, tone: 'accent' };
  return { name: run.pid > 0 ? `claim left by pid ${run.pid}, not running` : 'claim file unreadable, not running', tone: 'warn' };
}

export const HALT_WORDS: Record<CampaignHaltReason, string> = {
  operator: 'halted by a person',
  'spend-unknown': 'halted: a finished attempt reported no cost',
  'spend-cap': 'halted: the spend cap is reached',
  'spend-breach': 'halted: spend went past the cap',
  'integration-moved': 'halted: the integration ref moved outside the director',
  invariant: 'halted: an invariant went red on the integration tip',
  'authorization-expired': 'halted: the authorization expired',
};
export const haltWord = (r: CampaignHaltReason | null): Word | null =>
  r ? { name: HALT_WORDS[r] ?? `halted: ${r}`, tone: 'bad' } : null;

export function severityWord(s: FindingSeverity): Word {
  return { name: s, tone: s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'dim' };
}

// ---- spend --------------------------------------------------------------------------------

/**
 * One spend line, and the whole campaign's spend, as words: the engine's own functions
 * (engine/forge/spend-words.ts, P2-R60), so the screen says what STATUS.md and the markdown
 * report say and the two cannot drift. That module has no runtime import, so the bundle gains
 * no engine runtime by importing it.
 */
export { campaignSpendWords, spendWords };

export interface SpendBar {
  /**
   * Fractions of the cap, each clamped to [0, 1]; a bar never draws a figure it was not given.
   * `charged`: unfinished attempts charged at their reservation (P2-R44), a labelled segment of
   * its own; `reserved`: what running attempts hold, outlined.
   */
  known: number; scanned: number; charged: number; reserved: number;
  /** No right edge: some finished attempt has no figure, so the total is a floor (P2-R11). */
  open: boolean;
  unknown: number;
  reservationCount: number | null;
  /** Dollars charged at reservation, when the line carries them. */
  chargedUsd: number | null;
  words: string;
  cap: string;
}

const frac = (n: number, cap: number) => (cap > 0 && Number.isFinite(n) ? Math.max(0, Math.min(1, n / cap)) : 0);

/** A spend line drawn against a cap: known solid, scanned hatched beside, the reservation charge its own segment. */
export function spendBar(l: SpendLine, capUsd: number): SpendBar {
  const known = frac(l.knownUsd, capUsd);
  const scanned = Math.min(1 - known, frac(l.scannedUsd, capUsd));
  const charged = Math.min(1 - known - scanned, frac(l.reservationUsd, capUsd));
  return {
    known, scanned, charged, reserved: 0, open: l.unknownCount > 0, unknown: l.unknownCount,
    reservationCount: l.reservationCount, chargedUsd: l.reservationUsd, words: spendWords(l), cap: capUsd > 0 ? `of ${money(capUsd)}` : 'no cap',
  };
}

/** The campaign bar: known solid, reservation charges their own segment, running reservations outlined, open while any figure is unknown. */
export function campaignSpendBar(s: CampaignSpend): SpendBar {
  const known = frac(s.knownUsd, s.capUsd);
  const charged = Math.min(1 - known, frac(s.reservationUsd, s.capUsd));
  return {
    known, scanned: 0, charged, reserved: Math.min(1 - known - charged, frac(s.reservedUsd, s.capUsd)), open: s.unknownCount > 0,
    unknown: s.unknownCount, reservationCount: s.reservationCount, chargedUsd: s.reservationUsd,
    words: campaignSpendWords(s), cap: s.capUsd > 0 ? `of ${money(s.capUsd)}` : 'no cap',
  };
}

// ---- the DAG ------------------------------------------------------------------------------

export interface DagTicket { id: string; lane: string; dependsOn: readonly string[] }

/**
 * Layers by longest `dependsOn` path: a ticket sits one layer right of its deepest dependency.
 * Dependencies outside the set are ignored; a cycle (which a validated plan cannot hold) puts
 * what is left in one last layer rather than looping. Stable: each layer is sorted by lane, id.
 */
export function dagLayers(tickets: readonly DagTicket[]): string[][] {
  const by = new Map(tickets.map((t) => [t.id, t]));
  const layer = new Map<string, number>();
  let changed = true;
  for (let pass = 0; changed && pass <= tickets.length; pass++) {
    changed = false;
    for (const t of tickets) {
      if (layer.has(t.id)) continue;
      const deps = t.dependsOn.filter((d) => by.has(d) && d !== t.id);
      if (!deps.every((d) => layer.has(d))) continue;
      layer.set(t.id, deps.length ? Math.max(...deps.map((d) => layer.get(d)!)) + 1 : 0);
      changed = true;
    }
  }
  const last = layer.size ? Math.max(...layer.values()) + 1 : 0;
  for (const t of tickets) if (!layer.has(t.id)) layer.set(t.id, last);
  const out: string[][] = [];
  for (const [id, n] of layer) (out[n] ??= []).push(id);
  const cmp = (a: string, b: string) => {
    const la = by.get(a)!.lane;
    const lb = by.get(b)!.lane;
    return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  };
  return out.filter(Boolean).map((l) => l.sort(cmp));
}

export interface DagNode { id: string; lane: string; layer: number; x: number; y: number }
export interface DagLayout { nodes: DagNode[]; edges: Array<{ from: string; to: string }>; lanes: Array<{ lane: string; y: number; h: number }>; width: number; height: number }

/** Columns are layers, rows are lanes (sorted, FIX last as the engine sorts); tickets of one lane and layer stack. */
export function dagLayout(tickets: readonly DagTicket[], o = { col: 150, row: 34, pad: 16, laneGap: 14, label: 64 }): DagLayout {
  const layers = dagLayers(tickets);
  const layerOf = new Map<string, number>();
  layers.forEach((l, i) => l.forEach((id) => layerOf.set(id, i)));
  const laneIds = [...new Set(tickets.map((t) => t.lane))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const depth = new Map<string, number>();
  for (const lane of laneIds) {
    let most = 1;
    layers.forEach((l) => { most = Math.max(most, l.filter((id) => tickets.find((t) => t.id === id)!.lane === lane).length); });
    depth.set(lane, most);
  }
  const lanes: DagLayout['lanes'] = [];
  let y = o.pad;
  for (const lane of laneIds) {
    const h = depth.get(lane)! * o.row;
    lanes.push({ lane, y, h });
    y += h + o.laneGap;
  }
  const nodes: DagNode[] = [];
  layers.forEach((l, li) => {
    const seen = new Map<string, number>();
    for (const id of l) {
      const t = tickets.find((x) => x.id === id)!;
      const k = seen.get(t.lane) ?? 0;
      seen.set(t.lane, k + 1);
      const band = lanes.find((b) => b.lane === t.lane)!;
      nodes.push({ id, lane: t.lane, layer: li, x: o.pad + o.label + li * o.col, y: band.y + k * o.row + o.row / 2 });
    }
  });
  const ids = new Set(tickets.map((t) => t.id));
  const edges = tickets.flatMap((t) => t.dependsOn.filter((d) => ids.has(d) && d !== t.id).map((d) => ({ from: d, to: t.id })));
  return { nodes, edges, lanes, width: o.pad * 2 + o.label + Math.max(1, layers.length) * o.col, height: Math.max(y, o.pad * 2 + o.row) };
}

// ---- the report ---------------------------------------------------------------------------

export function scopeWord(s: WaveReport['scope']): string {
  return s.kind === 'wave' ? `wave ${s.seq}` : s.kind === 'open' ? 'open: since the last closed wave' : 'whole campaign';
}

export const diffWords = (d: DiffStat): string =>
  `${d.files} file${d.files === 1 ? '' : 's'} · +${d.insertions} −${d.deletions}${d.binary ? ` · ${d.binary} binary` : ''}`;

export const BLOCKED_ACTS: Record<ReportBlocked['act'], { name: string; hint: string }> = {
  retry: { name: 'retry', hint: 'closed at preflight or inconclusive: a person releases it to run again' },
  'resolve-dependency': { name: 'add the dependency', hint: 'the author asked for a dependency; a person decides it on the mission' },
  'owner-decision': { name: 'decide the assumption', hint: 'it waits on an open owner decision' },
  'approve-work-item': { name: 'approve the ticket', hint: 'a generated ticket a person admits' },
  authorize: { name: 'authorize', hint: 'outside the campaign authorization: authorize again to include it' },
  read: { name: 'read why', hint: 'nothing to press: the reason says what is wrong' },
};
export const blockedActWord = (a: ReportBlocked['act']): Word & { hint: string } =>
  ({ name: BLOCKED_ACTS[a]?.name ?? a, tone: a === 'read' ? 'dim' : 'warn', hint: BLOCKED_ACTS[a]?.hint ?? '' });

export const FORGERY_WORDS: Record<ForgeryClass | 'unclassified', string> = {
  'stdout-fd-write': 'writes to stdout by file descriptor',
  'test-summary-literal': 'a test-runner summary as a string literal',
  'process-exit': 'exits the process from library code',
  unclassified: 'unclassified',
};

// ---- refine -------------------------------------------------------------------------------

export const FOCUS_KIND_WORDS: Record<FocusKind, string> = {
  assumption: 'assumption waiting on you',
  finding: 'High finding not fixed',
  'forgery-shape': 'landed after a forgery-shaped candidate (heuristic)',
  'blocked-ticket': 'blocked ticket',
  'untested-diff': 'landed with no real gate',
  introduced: 'introduced on the integration ref',
};

/** The tier an item is in: its kind's rule, as the report echoes the rules. A lookup, not a ranking. */
export function tierOf(item: Pick<FocusItem, 'kind'>, rules: readonly FocusRule[]): number | null {
  const r = rules.find((x) => x.kind === item.kind);
  return r ? r.tier : null;
}
export function focusTierWord(item: Pick<FocusItem, 'kind'>, rules: readonly FocusRule[]): string {
  const t = tierOf(item, rules);
  return `${t === null ? 'tier ?' : `tier ${t}`} · ${FOCUS_KIND_WORDS[item.kind] ?? item.kind}`;
}

export const OVERLAYS: readonly RefineOverlay[] = ['assumption', 'finding', 'forgery', 'blocked', 'untested', 'introduced'];
export const OVERLAY_WORDS: Record<RefineOverlay, string> = {
  assumption: 'held by an assumption',
  finding: 'High finding',
  forgery: 'forgery-shaped (heuristic)',
  blocked: 'blocked tickets',
  untested: 'untested diff',
  introduced: 'introduced',
};
export const overlayWord = (o: RefineOverlay): string => OVERLAY_WORDS[o] ?? o;

export const READ_ONLY_REASON = 'read-only: this is the integration tip, not the checkout; symbols and node moves are off, and reveal and snippet are not available because the checkout is not at the integration tip';

// ---- assumptions --------------------------------------------------------------------------

/** What waits on a person: open blocking, then open, then pending; most held tickets first, then id. */
export function assumptionQueue(rows: readonly ForgeAssumptionRow[]): ForgeAssumptionRow[] {
  const rank = (a: ForgeAssumptionRow) => (a.status === 'open' ? (a.blocking ? 0 : 1) : 2);
  return rows
    .filter((a) => a.status === 'open' || a.status === 'pending')
    .sort((a, b) => rank(a) - rank(b) || b.heldTickets.length - a.heldTickets.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The acts an assumption allows in its state: confirm a pending default, decide an open one, overturn either. */
export function assumptionActs(a: Pick<ForgeAssumptionRow, 'status'>): Array<'confirm' | 'decide' | 'overturn'> {
  if (a.status === 'pending') return ['confirm', 'overturn'];
  if (a.status === 'open') return ['decide', 'overturn'];
  return [];
}

// ---- needs --------------------------------------------------------------------------------

/**
 * Which campaign a need belongs to. Needs arrive keyed by mission (`mission list`), so a need
 * listed under a campaign mission is that campaign's.
 */
export function campaignOfNeedFrom(missions: readonly Pick<Mission, 'id' | 'kind'>[], needs: Record<string, readonly Need[]> | undefined): (n: Need) => string | undefined {
  const campaigns = new Set(missions.filter((m) => m.kind === 'campaign').map((m) => m.id));
  const by = new Map<string, string>();
  for (const [mid, list] of Object.entries(needs ?? {})) {
    if (!campaigns.has(mid)) continue;
    for (const n of list) by.set(`${n.kind}\u0000${n.ref}`, mid);
  }
  return (n) => by.get(`${n.kind}\u0000${n.ref}`);
}

// ---- the envelope and the authorize form ----------------------------------------------------

export const dateWord = (ms: number | null | undefined): string =>
  ms === null || ms === undefined || !Number.isFinite(ms) ? UNKNOWN : new Date(ms).toISOString().replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, ' UTC');

/** Every field of the envelope in force, in order; the identity is labelled asserted and is never a form field (D2). */
export function envelopeRows(e: CampaignEnvelope): Array<{ k: string; v: string }> {
  return [
    { k: 'plan', v: e.planDigest },
    { k: 'gate set', v: e.gateSetDigest },
    { k: 'policy', v: e.policyDigest ?? 'none at the plan commit' },
    { k: 'tickets', v: e.ticketIds.join(', ') || 'none' },
    { k: 'roster', v: e.roster.join(', ') },
    { k: 'review roster', v: e.reviewRoster.length ? e.reviewRoster.join(', ') : 'none: wave review off' },
    { k: 'cap', v: `${money(e.maxUsdTotal)} total · ${money(e.maxUsdPerMission)} a ticket mission` },
    { k: 'turns · timeout', v: `${e.maxTurns} turns · ${e.timeoutSeconds}s` },
    { k: 'attempts · concurrency · wave', v: `${e.maxAttemptsPerTicket} a ticket · ${e.concurrency} at once · waves of ${e.waveSize}` },
    { k: 'exec', v: e.execute ? 'on: the nested run tool, no network' : 'off' },
    { k: 'auto-apply', v: e.autoApply },
    { k: 'fix lane', v: e.fixLane.enabled ? `${e.fixLane.maxTicketsPerWave} a wave · ${money(e.fixLane.maxUsdPerTicket)} a ticket` : 'off' },
    { k: 'identity (asserted)', v: `${e.identity.name} <${e.identity.email}>` },
    { k: 'not after', v: dateWord(e.notAfter) },
  ];
}

export type AuthorizeFields = Omit<CampaignAuthorizeForm, 'id' | 'rationale'>;

/** The form prefilled from the envelope in force, else from the documented defaults. No identity field. */
export function authorizeDefaults(e: CampaignEnvelope | null, now = Date.now()): AuthorizeFields {
  if (!e) {
    return {
      roster: ['mock'], reviewRoster: ['mock', 'mock'], maxUsdTotal: 40, maxUsdPerMission: 2, maxTurns: 60, timeoutSeconds: 600,
      maxAttempts: 3, concurrency: 6, execute: false, autoApply: 'integration-ref', fixLane: { tickets: 5, usd: 1.5 }, notAfterHours: 72,
    };
  }
  const left = Math.round((e.notAfter - now) / 3_600_000);
  return {
    roster: [...e.roster], reviewRoster: [...e.reviewRoster], maxUsdTotal: e.maxUsdTotal, maxUsdPerMission: e.maxUsdPerMission,
    maxTurns: e.maxTurns, timeoutSeconds: e.timeoutSeconds, maxAttempts: e.maxAttemptsPerTicket, concurrency: e.concurrency,
    waveSize: e.waveSize, execute: e.execute, autoApply: e.autoApply,
    fixLane: e.fixLane.enabled ? { tickets: e.fixLane.maxTicketsPerWave, usd: e.fixLane.maxUsdPerTicket } : 'off',
    tickets: [...e.ticketIds], notAfterHours: Math.min(720, Math.max(1, Number.isFinite(left) && left > 0 ? left : 72)),
  };
}

const TOOL = /^[a-z][a-z0-9-]{0,31}(?::[A-Za-z0-9._-]{1,64})?$/;
const inRange = (n: number, lo: number, hi: number) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

/** Why the form cannot be sent yet, in words; main and the engine check it all again. */
export function authorizeProblems(f: AuthorizeFields): string[] {
  const p: string[] = [];
  if (!f.roster.length || !f.roster.every((t) => TOOL.test(t))) p.push('the roster names one or more authors as tool or tool:model');
  if (!f.reviewRoster.every((t) => TOOL.test(t))) p.push('each reviewer is tool or tool:model');
  if (!inRange(f.maxUsdTotal, 0, 10_000)) p.push('the cap is $0 to $10000');
  if (!inRange(f.maxUsdPerMission, 0, f.maxUsdTotal)) p.push('a ticket mission cannot have more than the cap');
  if (!Number.isInteger(f.maxTurns) || !inRange(f.maxTurns, 1, 1000)) p.push('turns are 1 to 1000');
  if (!Number.isInteger(f.timeoutSeconds) || !inRange(f.timeoutSeconds, 1, 86_400)) p.push('the timeout is 1 to 86400 seconds');
  if (!Number.isInteger(f.maxAttempts) || !inRange(f.maxAttempts, 1, 10)) p.push('attempts are 1 to 10');
  if (!Number.isInteger(f.concurrency) || !inRange(f.concurrency, 1, 32)) p.push('concurrency is 1 to 32');
  if (f.waveSize !== undefined && (!Number.isInteger(f.waveSize) || !inRange(f.waveSize, 1, 1000))) p.push('a wave is 1 to 1000 tickets');
  if (f.fixLane !== 'off' && (!Number.isInteger(f.fixLane.tickets) || !inRange(f.fixLane.tickets, 0, 5) || !inRange(f.fixLane.usd, 0, 10_000))) {
    p.push('the fix lane is 0 to 5 tickets a wave (P2-R10) at $0 to $10000 a ticket');
  }
  if (!Number.isInteger(f.notAfterHours) || !inRange(f.notAfterHours, 1, 720)) p.push('the authorization lasts 1 to 720 hours');
  return p;
}

/** Generated tickets (fix, follow-up) still proposed: a person's approve admits them (P2-R36). */
export function proposedTickets(show: ForgeCampaignShow): ForgeCampaignShow['tickets'] {
  return show.tickets.filter((t) => t.origin !== 'plan' && t.status === 'proposed');
}

// ---- rationales ---------------------------------------------------------------------------

export const RATIONALE_PRESETS_CAMPAIGN: Record<string, readonly string[]> = {
  'approve-plan': ['read the plan; lanes, scopes and gates are what I want built', 'plan revision reviewed against the spec'],
  authorize: ['run this plan inside these caps', 'mock rehearsal: no live spend'],
  retry: ['preflight cause fixed; run it again', 'transient failure; one more attempt'],
  resume: ['cause of the halt understood and addressed', 'spend checked by hand; continue'],
  'adopt-tip': ['the ref moved by my hand; adopt it', 'checked the new tip; it is what the campaign should build on'],
  confirm: ['the default is what I want', 'default checked against the spec'],
  decide: ['decided from the options in the plan', 'my call, recorded here'],
  overturn: ['the default was wrong; follow-up ticket proposed', 'spec says otherwise'],
  'approve-ticket': ['the finding is real and the fix is scoped', 'follow-up is needed'],
  'reject-ticket': ['the finding is not real', 'out of scope for this campaign', 'duplicate'],
};
