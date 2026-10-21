import fs from 'node:fs';
import { processAlive } from '../experiment/runner.ts';
import type { DaylightContext } from '../mission/context.ts';
import { runClaimFile } from '../mission/orchestrate.ts';
import { FINDING_SEVERITIES, FORGERY_CLASSES, STATUS_BUCKET_OF, STATUS_BUCKETS } from '../mission/types.ts';
import type {
  Attempt, CampaignEnvelope, CampaignSpend, CampaignTicket, DiffStat, ExperimentConclusion, Finding, FindingSeverity, ForgeCampaignList,
  ForgeCampaignRow, ForgeryClass, Integration, Mission, Need, ReportAssumption, ReportBlocked, ReportFinding, ReportForgeryShapes, ReportLanding,
  ReportReview, RunClaim, SpendLine, StatusBucket, StatusTable, StatusTableRow, TicketStatus, WaveReport,
} from '../mission/types.ts';
import { gitIn } from './apply.ts';
import { heldTickets } from './assumptions.ts';
import { campaignAuthorizationRefusal, planOf } from './campaign.ts';
import { campaignNeeds } from './campaign-needs.ts';
import { campaignStatus, r5StatusHost } from './campaign-status.ts';
import { campaignRunNeeds, campaignSpend, haltOf, ticketStates, type TicketState } from './director.ts';
import { envelopeOf, integrationRefFor, integrationTip } from './integrate.ts';

/**
 * The wave report, the campaign list and the STATUS table (WS-R8, docs/daylight/REFINE.md).
 * Everything here is derived on read from rows and refs and never stored; holdouts are counts,
 * reviewer text is labelled as claimed, and spend is never a figure for what nobody reported.
 */

export const REPORT_VERSION = 1 as const;

export type ReportScope = WaveReport['scope'];

const zeroBuckets = (): Record<StatusBucket, number> => Object.fromEntries(STATUS_BUCKETS.map((b) => [b, 0])) as Record<StatusBucket, number>;
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** kitkraft's STATUS table over ticket states: one row per lane, sorted by lane id. */
export function statusTable(states: Iterable<{ ticket: { ticketId: string; lane: string }; status: TicketStatus | 'regressed' }>): StatusTable {
  const rows = new Map<string, StatusTableRow>();
  const totals = zeroBuckets();
  for (const s of states) {
    const bucket = STATUS_BUCKET_OF[s.status];
    const row = rows.get(s.ticket.lane) ?? {
      lane: s.ticket.lane, total: 0, byBucket: zeroBuckets(),
      tickets: Object.fromEntries(STATUS_BUCKETS.map((b) => [b, [] as string[]])) as Record<StatusBucket, string[]>,
    };
    row.total++;
    row.byBucket[bucket]++;
    row.tickets[bucket].push(s.ticket.ticketId);
    totals[bucket]++;
    rows.set(s.ticket.lane, row);
  }
  return { rows: [...rows.values()].sort((a, b) => byId(a.lane, b.lane)), totals };
}

/** The STATUS table as markdown rows, with an `all` row; STATUS.md and the report share it. */
export function statusTableLines(t: StatusTable): string[] {
  return [
    `| lane | ${STATUS_BUCKETS.join(' | ')} | total |`, `|---|${STATUS_BUCKETS.map(() => '---|').join('')}---|`,
    ...t.rows.map((row) => `| ${row.lane} | ${STATUS_BUCKETS.map((b) => row.byBucket[b]).join(' | ')} | ${row.total} |`),
    `| all | ${STATUS_BUCKETS.map((b) => t.totals[b]).join(' | ')} | ${STATUS_BUCKETS.reduce((n, b) => n + t.totals[b], 0)} |`,
  ];
}

/**
 * The campaign's run claim, read and never written or signalled beyond `kill(pid, 0)`. A reused
 * pid reads as a claim; the UI words it as one.
 */
export function runClaimOf(out: string, campaignId: string): RunClaim | null {
  let text: string;
  try {
    text = fs.readFileSync(runClaimFile(out, campaignId), 'utf8').trim();
  } catch {
    return null;
  }
  const pid = /^\d{1,10}$/.test(text) ? Number(text) : NaN;
  // kill(0) and kill(-1) signal groups, so anything but a positive pid is a dead claim.
  if (!Number.isSafeInteger(pid) || pid <= 0) return { pid: 0, alive: false };
  return { pid, alive: processAlive(pid) };
}

// ---- spend --------------------------------------------------------------------------------

const live = (a: Attempt) => a.state === 'starting' || a.state === 'running';

/**
 * Attempt spend over `missionIds`, read from attempt rows as `missionSpend` reads them. A
 * reservation charge (P2-R44) is in `spentUsd`, as `campaignSpend` counts it, and never in
 * `knownUsd`; scanned dollars are kept apart so a renderer never subtracts.
 */
export function spendLineOf(ctx: Pick<DaylightContext, 'store'>, key: string, missionIds: readonly string[]): SpendLine {
  const attempts = missionIds.flatMap((id) => ctx.store.tasks(id).flatMap((t) => ctx.store.attempts(t.id)));
  // `reservation` is WS-R12's cost source; compared as a string so this reads rows before and after it.
  const source = (a: Attempt) => a.costSource as string;
  const sum = (as: Attempt[]) => round(as.reduce((n, a) => n + (a.costUsd ?? 0), 0));
  return {
    key, attempts: attempts.length,
    spentUsd: sum(attempts),
    knownUsd: sum(attempts.filter((a) => source(a) === 'provider')),
    scannedUsd: sum(attempts.filter((a) => source(a) === 'stdout-scan')),
    scannedCount: attempts.filter((a) => source(a) === 'stdout-scan').length,
    unknownCount: attempts.filter((a) => !live(a) && a.costUsd === null).length,
    runningCount: attempts.filter(live).length,
    reservationCount: attempts.filter((a) => source(a) === 'reservation').length,
  };
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * A spend line as words a reader cannot misread (the ledger's rule, `ledger.ts` dollarsOf):
 * `—` for no attempt, `unknown` when nothing finished reported a figure, a floor `≥` when some
 * did not or some still run; scanned and reservation-charged dollars beside, never inside.
 */
export function spendWords(l: SpendLine): string {
  if (l.attempts === 0) return '—';
  const finished = l.attempts - l.runningCount;
  const running = l.runningCount ? ` +${l.runningCount} running` : '';
  if (finished === 0) return `${l.runningCount} running, nothing reported yet`;
  const reservedUsd = round(l.spentUsd - l.knownUsd - l.scannedUsd);
  const beside = [
    l.scannedCount ? `${money(l.scannedUsd)} scanned, not known` : '',
    l.reservationCount ? `${money(reservedUsd)} charged at reservation for ${l.reservationCount} unfinished` : '',
  ].filter(Boolean);
  if (l.unknownCount === finished && !beside.length) return `unknown${running}`;
  const unknown = l.unknownCount ? `${l.unknownCount} unknown` : '';
  const known = l.knownUsd > 0 || !beside.length ? money(l.knownUsd) : '';
  const floor = l.unknownCount || l.runningCount ? '≥ ' : '';
  const lead = known ? `${floor}${known}${unknown ? ` (${unknown})` : ''}` : unknown;
  return [lead, ...beside].filter(Boolean).join('; ') + running;
}

/**
 * `CampaignSpend` as words for STATUS.md, by the same rules as `spendWords`: scanned and
 * reservation-charged dollars beside the known figure, never inside it, and no `$0.00` for spend
 * nobody reported. Reads WS-R12's reservation fields when present.
 */
export function campaignSpendWords(s: CampaignSpend): string {
  const r = s as CampaignSpend & { reservationUsd?: number; reservationCount?: number };
  const reservedUsd = r.reservationUsd ?? 0;
  const scannedUsd = round(s.spentUsd - s.knownUsd - reservedUsd);
  const beside = [
    s.scannedCount ? `${money(scannedUsd)} scanned, not known` : '',
    r.reservationCount ? `${money(reservedUsd)} charged at reservation for ${r.reservationCount} unfinished` : '',
  ].filter(Boolean);
  const running = s.runningCount ? ` +${s.runningCount} running` : '';
  if (s.knownUsd === 0 && s.unknownCount && !beside.length) return `unknown (${s.unknownCount} attempt(s) reported no cost)${running}`;
  const floor = s.unknownCount || s.runningCount ? '≥ ' : '';
  const known = s.knownUsd > 0 || !beside.length ? `${floor}${money(s.knownUsd)}${s.unknownCount ? ` (${s.unknownCount} unknown)` : ''}` : '';
  return [known, ...beside].filter(Boolean).join('; ') + running;
}

// ---- git --------------------------------------------------------------------------------

const DIFF_ARGS = ['--no-renames', '--no-textconv', '--no-ext-diff', '--no-color', '-z'];

/** `from..to` by `git diff --numstat -z --no-renames`; a binary file counts in `files` and `binary`. */
export function diffStat(repo: string, from: string, to: string): DiffStat {
  const out: DiffStat = { files: 0, insertions: 0, deletions: 0, binary: 0 };
  for (const f of changedFiles(repo, from, to)) {
    out.files++;
    if (f.insertions === null || f.deletions === null) out.binary++;
    else {
      out.insertions += f.insertions;
      out.deletions += f.deletions;
    }
  }
  return out;
}

/** Per file of `from..to`: change kind and line counts (null for a binary file), sorted by path. */
export function changedFiles(repo: string, from: string, to: string): Array<{ path: string; change: 'added' | 'modified' | 'deleted'; insertions: number | null; deletions: number | null }> {
  if (from === to) return [];
  const kinds = new Map<string, 'added' | 'modified' | 'deleted'>();
  const status = gitIn({ repo }, ['diff', '--name-status', ...DIFF_ARGS, from, to, '--']).toString('utf8').split('\0');
  for (let i = 0; i + 1 < status.length; i += 2) kinds.set(status[i + 1], status[i] === 'A' ? 'added' : status[i] === 'D' ? 'deleted' : 'modified');
  const out: ReturnType<typeof changedFiles> = [];
  for (const rec of gitIn({ repo }, ['diff', '--numstat', ...DIFF_ARGS, from, to, '--']).toString('utf8').split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    out.push({ path: m[3], change: kinds.get(m[3]) ?? 'modified', insertions: m[1] === '-' ? null : Number(m[1]), deletions: m[2] === '-' ? null : Number(m[2]) });
  }
  return out.sort((a, b) => byId(a.path, b.path));
}

// ---- rows the report reads ---------------------------------------------------------------

/** Every implement child of the ticket's work item, released ones included, so a retried ticket carries both missions' spend. */
export function ticketMissions(ctx: Pick<DaylightContext, 'store'>, campaign: Mission, t: CampaignTicket): Mission[] {
  return ctx.store.missions(campaign.projectId).filter((m) => m.parentId === campaign.id && m.kind === 'implement' && m.workItemId === t.workItemId);
}

const authorAttemptCount = (ctx: Pick<DaylightContext, 'store'>, missionId: string) =>
  ctx.store.tasks(missionId).filter((t) => t.role === 'author').reduce((n, t) => n + ctx.store.attempts(t.id).length, 0);

/** The classes of a `gate-forgery-shape` why, read from the shape names WS-R13 writes into it (never matched text). */
export function forgeryClasses(why: string | undefined): Array<ForgeryClass | 'unclassified'> {
  const w = why ?? '';
  const out: ForgeryClass[] = [];
  if (/from_raw_fd\(1\)|libc::write\(1|fs\.writeSync\(1|process\.stdout\.write\(|stdout-fd-write/.test(w)) out.push('stdout-fd-write');
  if (/test result: ok\.|running 0 tests|TAP version|test summary|test-summary-literal/.test(w)) out.push('test-summary-literal');
  if (/process::exit|process\.exit|process-exit/.test(w)) out.push('process-exit');
  return out.length ? out : ['unclassified'];
}

/** The forgery-shape warnings on the candidates of `tickets` (P2-R43, P2-R49): counts, ids, paths and classes only. */
export function forgeryShapesOf(ctx: Pick<DaylightContext, 'store'>, campaign: Mission, tickets: readonly CampaignTicket[], landed: ReadonlySet<string>): ReportForgeryShapes {
  const byClass = Object.fromEntries([...FORGERY_CLASSES, 'unclassified'].map((c) => [c, 0])) as ReportForgeryShapes['byClass'];
  const items: ReportForgeryShapes['items'] = [];
  for (const t of [...tickets].sort((a, b) => byId(a.ticketId, b.ticketId))) {
    for (const m of ticketMissions(ctx, campaign, t)) {
      for (const c of ctx.store.candidates(m.id)) {
        const hits = c.policyViolations.filter((v) => (v.rule as string) === 'gate-forgery-shape');
        if (!hits.length) continue;
        const classes = [...new Set(hits.flatMap((v) => forgeryClasses(v.why)))].sort(byId);
        for (const k of classes) byClass[k]++;
        items.push({
          ticketId: t.ticketId, missionId: m.id, candidateId: c.id, attemptId: c.attemptId,
          paths: [...new Set(hits.map((v) => v.path).filter((p): p is string => !!p))].sort(byId), classes, ticketLanded: landed.has(t.ticketId),
        });
      }
    }
  }
  return { candidates: items.length, byClass, items, heuristic: true };
}

/** Holdouts of the current lock, counted, and their conclusions on the tip's integrated evaluation. Never an id or path. */
function holdoutCounts(ctx: Pick<DaylightContext, 'store'>, campaignId: string, tip: string): WaveReport['holdouts'] {
  const lock = ctx.store.latestDecision(campaignId, 'lock-campaign-gates');
  const roles = (lock?.scope.roles ?? {}) as Record<string, string>;
  const ids = Object.keys(roles).filter((x) => roles[x] === 'holdout');
  const atTip = Object.fromEntries((['pending', 'supported', 'falsified', 'inconclusive', 'invalid', 'not-run'] as const).map((k) => [k, 0])) as Record<ExperimentConclusion | 'not-run', number>;
  const integration = ctx.store.integrations(campaignId, { state: 'integrated' }).find((i) => i.integratedCommit === tip);
  const evals = integration ? ctx.store.gateEvaluations({ integrationId: integration.id, target: 'integrated' }) : [];
  for (const id of ids) {
    const e = evals.filter((x) => x.experimentId === id).at(-1);
    atTip[e ? e.conclusion : 'not-run']++;
  }
  return { locked: ids.length, atTip };
}

/** Integrated rows after `from` up to and including `to` (null: to the end), in row order: wave.ts's rule. */
function landingsBetween(rows: readonly Integration[], base: string, from: string, to: string | null): Integration[] {
  const at = (commit: string) => rows.findIndex((i) => i.integratedCommit === commit);
  const start = from === base ? 0 : at(from) + 1;
  if (start === 0 && from !== base) return [];
  if (to === null) return rows.slice(start);
  const end = at(to);
  return end < 0 ? [] : rows.slice(start, end + 1);
}

// ---- the wave report ---------------------------------------------------------------------

/** `wave-<n>`, `open-<tip12>` or `all-<tip12>`; the writer adds `.json` and `.md`. */
export function reportFileName(scope: ReportScope, tip: string): string {
  return scope.kind === 'wave' ? `wave-${scope.seq}` : `${scope.kind}-${tip.slice(0, 12)}`;
}

/**
 * What one wave (or the open run of landings, or the whole campaign) did, derived from rows and
 * the integration ref. Default scope: the latest closed wave, else the open landings.
 */
export function buildWaveReport(ctx: DaylightContext, campaignId: string, repo: string, o: { scope?: ReportScope } = {}): WaveReport {
  const campaign = ctx.store.mission(campaignId);
  if (!campaign || campaign.kind !== 'campaign') throw new Error(`${campaignId} is not a campaign`);
  const plan = planOf(ctx, campaignId);
  const host = r5StatusHost(ctx);
  const status = campaignStatus(ctx, campaignId, repo, host);
  const states = ticketStates(ctx, campaignId, repo, host);
  const tickets = ctx.store.campaignTickets(campaignId);
  const waves = ctx.store.waves(campaignId);
  const scope: ReportScope = o.scope ?? (waves.length ? { kind: 'wave', seq: waves.at(-1)!.seq } : { kind: 'open' });
  const wave = scope.kind === 'wave' ? waves.find((w) => w.seq === scope.seq) : undefined;
  if (scope.kind === 'wave' && !wave) throw new Error(`campaign ${campaignId} has no closed wave ${scope.seq}`);
  const tip = status.integration.tip;
  const range = wave ? { from: wave.fromCommit, to: wave.toCommit }
    : scope.kind === 'open' ? { from: waves.at(-1)?.toCommit ?? campaign.baseRevision, to: tip }
      : { from: campaign.baseRevision, to: tip };

  const integrated = ctx.store.integrations(campaignId, { state: 'integrated' });
  const inRange = landingsBetween(integrated, campaign.baseRevision, range.from, wave ? range.to : null);
  const ticketOfWorkItem = new Map(tickets.map((t) => [t.workItemId, t]));
  const ticketOfMission = (missionId: string) => {
    const m = ctx.store.mission(missionId);
    return m?.workItemId ? ticketOfWorkItem.get(m.workItemId) : undefined;
  };
  const landed: ReportLanding[] = [];
  for (const i of inRange) {
    const t = ticketOfMission(i.missionId);
    if (!t || !i.integratedCommit) continue;
    landed.push({
      ticketId: t.ticketId, lane: t.lane, origin: t.origin, title: ctx.store.workItem(t.workItemId)?.title ?? '',
      missionId: i.missionId, integrationId: i.id, candidateId: i.candidateId, decisionId: i.decisionId,
      onto: i.onto, commit: i.integratedCommit, method: i.method, attempts: authorAttemptCount(ctx, i.missionId),
      acceptance: t.acceptance.kind, acceptanceVacuous: i.acceptanceVacuous, diff: diffStat(repo, i.onto, i.integratedCommit),
    });
  }
  const landedTickets = new Set([...states.values()].filter((s) => s.status === 'landed').map((s) => s.ticket.ticketId));

  const items = ctx.store.assumptions(campaignId);
  const assumptionRow = (a: (typeof items)[number]): ReportAssumption => {
    const held = heldTickets(ctx, a).sort(byId);
    return {
      id: a.id, status: a.status as 'open' | 'pending', ...(a.ownerDecisionId ? { ownerDecisionId: a.ownerDecisionId } : {}),
      ...(a.ticketId ? { ticketId: a.ticketId } : {}), question: a.question, default: a.default, blocking: a.blocking, source: a.source,
      heldTickets: held, landedOnIt: held.filter((id) => landedTickets.has(id)),
    };
  };

  const authorization = ctx.store.campaignAuthorization(campaignId);
  const env: CampaignEnvelope | null = authorization ? envelopeOf(authorization) : null;
  const scopeWaves = wave ? [wave] : scope.kind === 'all' ? waves : [];
  const review: ReportReview[] = scopeWaves.map((w) => {
    const fs = ctx.store.findings(campaignId, { waveSeq: w.seq });
    const tasks = w.reviewMissionId ? ctx.store.tasks(w.reviewMissionId) : [];
    const running = tasks.some((t) => ctx.store.attempts(t.id).some(live));
    return {
      seq: w.seq, reviewMissionId: w.reviewMissionId,
      state: !w.reviewMissionId ? (env && !env.reviewRoster.length ? 'off' : 'not-run') : running ? 'running' : 'done',
      reviewers: tasks.length,
      findings: Object.fromEntries(FINDING_SEVERITIES.map((s) => [s, fs.filter((f) => f.severity === s).length])) as Record<FindingSeverity, number>,
    };
  });
  const admissionOf = (workItemId: string): ReportFinding['fixAdmission'] => {
    const d = ctx.store.admission(campaignId, workItemId);
    return !d ? 'none' : d.actor.startsWith('campaign:') ? 'derived' : 'person';
  };
  const fixTicket = (f: Finding) => (f.fixTicketId ? tickets.find((t) => t.ticketId === f.fixTicketId) : undefined);
  const findings: ReportFinding[] = scopeWaves.flatMap((w) => ctx.store.findings(campaignId, { waveSeq: w.seq })).map((f): ReportFinding => {
    const t = fixTicket(f);
    return {
      id: f.id, waveSeq: f.waveSeq, severity: f.severity, path: f.path, title: f.title, statement: f.statement, corroboratedBy: [...f.corroboratedBy],
      fixTicketId: f.fixTicketId ?? null, fixStatus: t ? states.get(t.ticketId)?.status ?? 'none' : 'none', fixAdmission: t ? admissionOf(t.workItemId) : 'none',
    };
  }).sort((a, b) => FINDING_SEVERITIES.indexOf(b.severity) - FINDING_SEVERITIES.indexOf(a.severity) || a.waveSeq - b.waveSeq || byId(a.path, b.path) || byId(a.id, b.id));
  const fixes = tickets.filter((t) => t.origin === 'fix');
  const superseded = (t: CampaignTicket) => states.get(t.ticketId)?.status === 'superseded';
  const fixLane = {
    filed: fixes.length,
    admittedDerived: fixes.filter((t) => admissionOf(t.workItemId) === 'derived').length,
    approvedByPerson: fixes.filter((t) => admissionOf(t.workItemId) === 'person').length,
    landed: fixes.filter((t) => landedTickets.has(t.ticketId)).length,
    waiting: fixes.filter((t) => !landedTickets.has(t.ticketId) && !superseded(t)).length,
    rejected: fixes.filter(superseded).length,
  };

  // Spend: lines over every child mission, closed so that Σ lanes + Σ reviews = campaignSpend.
  const children = ctx.store.missions(campaign.projectId).filter((m) => m.parentId === campaignId);
  const missionsOfTicket = new Map(tickets.map((t) => [t.ticketId, ticketMissions(ctx, campaign, t).map((m) => m.id)]));
  const of = (ids: readonly string[]) => ids.flatMap((id) => missionsOfTicket.get(id) ?? []);
  const ticketLines = tickets.map((t) => spendLineOf(ctx, t.ticketId, of([t.ticketId]))).sort((a, b) => byId(a.key, b.key));
  const lanes = [...new Set(tickets.map((t) => t.lane))].sort(byId)
    .map((lane) => spendLineOf(ctx, lane, of(tickets.filter((t) => t.lane === lane).map((t) => t.ticketId))));
  const reviewMissions = new Set(waves.map((w) => w.reviewMissionId).filter((x): x is string => !!x));
  const ticketMissionIds = new Set([...missionsOfTicket.values()].flat());
  const unlinked = children.filter((m) => !ticketMissionIds.has(m.id) && !reviewMissions.has(m.id)).map((m) => m.id);
  const reviews = [
    ...waves.filter((w) => w.reviewMissionId).map((w) => spendLineOf(ctx, `review:${w.seq}`, [w.reviewMissionId!])),
    // A review mission a crash left before its wave named it, or any other child: kept so the sums close.
    ...(unlinked.length ? [spendLineOf(ctx, 'review:unlinked', unlinked)] : []),
  ];
  const waveLines = waves.map((w) => spendLineOf(ctx, `wave:${w.seq}`, of(w.ticketIds)));
  const scopeTickets = [...new Set(landed.map((l) => l.ticketId))];
  const scopeLine = spendLineOf(ctx, 'scope', [...of(scopeTickets), ...scopeWaves.map((w) => w.reviewMissionId).filter((x): x is string => !!x)]);

  const needs = campaignNeeds(ctx, campaign);
  const retryable = new Set(campaignRunNeeds(ctx, campaign).filter((n) => n.kind === 'blocked').map((n) => n.ref));
  const blocked: ReportBlocked[] = [...states.values()]
    .filter((s): s is TicketState & { status: ReportBlocked['status'] } => s.status === 'blocked' || s.status === 'waiting-dependency' || s.status === 'waiting-owner')
    .map((s) => blockedRow(ctx, s, retryable, needs, campaignId))
    .sort((a, b) => byId(a.ticketId, b.ticketId));

  // Forgery shapes: the scope's tickets, plus every ticket not landed yet.
  const inScope = (t: CampaignTicket) => (wave ? wave.ticketIds.includes(t.ticketId) : scopeTickets.includes(t.ticketId));
  const forgeryScope = scope.kind === 'all' ? tickets : tickets.filter((t) => inScope(t) || !landedTickets.has(t.ticketId));

  return {
    kind: 'daylight-wave-report', version: REPORT_VERSION,
    campaignId, projectId: campaign.projectId, title: plan.plan.title, planRevision: status.planRevision,
    scope, range,
    integration: status.integration, authorization: status.authorization, run: runClaimOf(ctx.out, campaignId),
    landed, diff: diffStat(repo, range.from, range.to),
    assumptions: {
      open: items.filter((a) => a.status === 'open').map(assumptionRow), pending: items.filter((a) => a.status === 'pending').map(assumptionRow),
      confirmed: items.filter((a) => a.status === 'confirmed').length, overturned: items.filter((a) => a.status === 'overturned').length,
    },
    review, findings, fixLane,
    spend: { campaign: campaignSpend(ctx, campaignId), scope: scopeLine, tickets: ticketLines, lanes, waves: waveLines, reviews },
    needs, blocked,
    holdouts: holdoutCounts(ctx, campaignId, tip),
    forgeryShapes: forgeryShapesOf(ctx, campaign, forgeryScope, landedTickets),
    status: status.table,
  };
}

const NEED_OF_ACT: Record<ReportBlocked['act'], readonly string[]> = {
  retry: ['blocked'], 'resolve-dependency': ['request-dependency'], 'owner-decision': ['owner-decision', 'assumption-pending'],
  'approve-work-item': ['work-item-undecided'], authorize: ['campaign-authorize'], read: ['blocked', 'candidate-decision', 'apply'],
};

function blockedRow(ctx: DaylightContext, s: TicketState & { status: ReportBlocked['status'] }, retryable: ReadonlySet<string>, needs: readonly Need[], campaignId: string): ReportBlocked {
  const t = s.ticket;
  const owners = t.blocksOn.length
    ? ctx.store.assumptions(campaignId).filter((a) => a.ownerDecisionId && t.blocksOn.includes(a.ownerDecisionId) && a.status === 'open') : [];
  const proposed = t.origin !== 'plan' && ctx.store.workItem(t.workItemId)?.status === 'proposed';
  const act: ReportBlocked['act'] = s.status === 'waiting-dependency' ? 'resolve-dependency'
    : s.status === 'waiting-owner' ? (owners.length ? 'owner-decision' : proposed ? 'approve-work-item' : 'authorize')
      : s.mission && retryable.has(s.mission.id) ? 'retry' : 'read';
  const refs = new Set<string>([...(s.mission ? [s.mission.id] : []), t.workItemId, ...owners.map((a) => a.id), ...(act === 'authorize' ? [campaignId] : [])]);
  const need = needs.find((n) => refs.has(n.ref) && NEED_OF_ACT[act].includes(n.kind))?.kind ?? null;
  return { ticketId: t.ticketId, lane: t.lane, status: s.status, reason: s.reason ?? '', ...(s.mission ? { missionId: s.mission.id } : {}), need, act };
}

// ---- markdown -----------------------------------------------------------------------------

/** Agent-authored or row text on one line, backticks and table bars escaped. */
const line = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[\u0060|]/g, (c) => '\\' + c).trim();

/** The campaign's spend as one line: the report's lines carry what CampaignSpend does not (scanned dollars, reservation count). */
function campaignLine(r: WaveReport): SpendLine {
  const c = r.spend.campaign;
  const all = [...r.spend.lanes, ...r.spend.reviews];
  return {
    key: 'campaign', attempts: all.reduce((n, l) => n + l.attempts, 0), spentUsd: c.spentUsd, knownUsd: c.knownUsd,
    scannedUsd: round(all.reduce((n, l) => n + l.scannedUsd, 0)), scannedCount: c.scannedCount, unknownCount: c.unknownCount,
    runningCount: c.runningCount, reservationCount: all.reduce((n, l) => n + l.reservationCount, 0),
  };
}

/** The report as markdown: no finding statement, no holdout name, no timestamp. */
export function renderWaveReport(r: WaveReport): string {
  const scope = r.scope.kind === 'wave' ? `wave ${r.scope.seq}` : r.scope.kind === 'open' ? 'open landings (no wave closed over them yet)' : 'the whole campaign';
  const out: string[] = [
    `# ${line(r.title)}: ${scope}`, '',
    `Campaign ${r.campaignId}, plan ${r.planRevision}. Range ${r.range.from.slice(0, 12)}..${r.range.to.slice(0, 12)}: `
      + `${r.diff.files} file(s), +${r.diff.insertions} −${r.diff.deletions}${r.diff.binary ? `, ${r.diff.binary} binary` : ''}.`,
    `Integration ${r.integration.ref} at ${r.integration.tip.slice(0, 12)}; ${r.integration.landed} landed in all. Merge it yourself: \`${r.integration.mergeHint}\``,
    r.run ? (r.run.alive ? `A run holds the campaign (pid ${r.run.pid}).` : `A run claim was left by pid ${r.run.pid}, which is not running.`) : 'No run holds the campaign.',
    r.authorization.decisionId ? `Authorized by ${r.authorization.decisionId}${r.authorization.halted ? `; halted (${r.authorization.halted})` : ''}.` : 'Not authorized.',
    '', '## Landed', '',
  ];
  if (r.landed.length) {
    out.push('| ticket | lane | commit | lines | files | acceptance |', '|---|---|---|---|---|---|');
    for (const l of r.landed) {
      out.push(`| ${l.ticketId} | ${l.lane} | ${l.commit.slice(0, 12)} | +${l.diff.insertions} −${l.diff.deletions}${l.diff.binary ? ` (${l.diff.binary} binary)` : ''} `
        + `| ${l.diff.files} | ${l.acceptance}${l.acceptanceVacuous ? ' (vacuous: passes without the change)' : ''} |`);
    }
  } else out.push('- none in this range');
  out.push('', '## Assumptions waiting on you', '');
  const waiting = [...r.assumptions.open, ...r.assumptions.pending];
  for (const a of waiting) {
    out.push(`- ${a.id} ${a.status}${a.blocking ? ', blocking' : ''}: ${line(a.question)} (proceeds on: ${a.default ? line(a.default) : 'nothing; it waits'})`
      + `${a.heldTickets.length ? `; holds ${a.heldTickets.join(', ')}` : ''}${a.landedOnIt.length ? `; landed on it: ${a.landedOnIt.join(', ')}` : ''}`);
  }
  if (!waiting.length) out.push('- none');
  out.push(`- ${r.assumptions.confirmed} confirmed, ${r.assumptions.overturned} overturned`);
  out.push('', '## Review', '');
  if (!r.review.length) out.push('- no wave in this scope');
  for (const v of r.review) out.push(`- wave ${v.seq}: ${v.state}, ${v.reviewers} reviewer(s); findings high ${v.findings.high}, medium ${v.findings.medium}, low ${v.findings.low}`);
  if (r.findings.length) {
    out.push('', 'Findings (reviewer-claimed; statements are in the JSON report only):', '');
    for (const f of r.findings) {
      out.push(`- ${f.severity} · ${line(f.path)} · ${line(f.title)} (reviewer-claimed)${f.corroboratedBy.length ? `, corroborated by ${f.corroboratedBy.length}` : ''}`
        + `; fix ${f.fixTicketId ? `${f.fixTicketId} ${f.fixStatus}, admitted: ${f.fixAdmission}` : 'none'}`);
    }
  }
  const fl = r.fixLane;
  out.push('', '## Fix lane', '',
    `- ${fl.filed} filed; ${fl.admittedDerived} admitted by the envelope, ${fl.approvedByPerson} approved by a person; ${fl.landed} landed, ${fl.waiting} waiting, ${fl.rejected} rejected`);
  const c = r.spend.campaign;
  out.push('', '## Spend', '',
    `- campaign: ${spendWords(campaignLine(r))} of ${money(c.capUsd)}${c.reservedUsd ? `, ${money(c.reservedUsd)} reserved by running attempts` : ''}`,
    `- this scope: ${spendWords(r.spend.scope)}`,
    ...r.spend.lanes.map((l) => `- lane ${l.key}: ${spendWords(l)}`),
    ...r.spend.reviews.map((l) => `- ${l.key}: ${spendWords(l)}`));
  out.push('', '## Needs', '', ...(r.needs.length ? r.needs.map((n) => `- ${n.kind} ${n.ref}: ${line(n.why)}`) : ['- none']));
  out.push('', '## Blocked', '', ...(r.blocked.length ? r.blocked.map((b) => `- ${b.ticketId} (${b.lane}) ${b.status}, act: ${b.act}: ${line(b.reason)}`) : ['- none']));
  const h = r.holdouts;
  const concl = Object.entries(h.atTip).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ');
  out.push('', '## Holdouts', '', `- ${h.locked} locked, counted and never named${h.locked ? `; at the tip: ${concl}` : ''}`);
  const f = r.forgeryShapes;
  out.push('', '## Forgery-shaped candidates (heuristic)', '',
    `- ${f.candidates} candidate(s) carried a \`gate-forgery-shape\` warning; it parks a candidate with a \`forgery-shape-review\` need until a person acknowledges or rejects it. A count, not a finding of fact`
      + `${f.candidates ? ` (${Object.entries(f.byClass).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`,
    ...f.items.map((i) => `- ${i.ticketId} · ${i.candidateId.slice(0, 10)} · ${i.classes.join(', ')} · ${i.paths.map(line).join(', ')}${i.ticketLanded ? ' · the ticket landed' : ''}`));
  out.push('', '## Status', '', ...statusTableLines(r.status), '');
  return out.join('\n');
}

// ---- the campaign list --------------------------------------------------------------------

const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Every campaign in `<out>`, newest first, with what the Campaigns screen shows. Read-only. */
export function campaignList(ctx: DaylightContext): ForgeCampaignList {
  const campaigns = ctx.store.missions().filter((m) => m.kind === 'campaign').sort((a, b) => b.createdAt - a.createdAt || byId(a.id, b.id));
  return { kind: 'daylight-campaign-list', campaigns: campaigns.map((c) => campaignRow(ctx, c)) };
}

function campaignRow(ctx: DaylightContext, c: Mission): ForgeCampaignRow {
  const root = ctx.store.project(c.projectId)?.root ?? null;
  const plan = ctx.store.currentPlan(c.id);
  const auth = ctx.store.campaignAuthorization(c.id);
  const attempt = <T>(fn: () => T, fallback: (why: string) => T): T => {
    try {
      return fn();
    } catch (err) {
      return fallback(err instanceof Error ? err.message.split('\n')[0] : String(err));
    }
  };
  const title = attempt<string | null>(() => planOf(ctx, c.id).plan.title, () => null);
  const refusal = attempt<string | null>(() => campaignAuthorizationRefusal(ctx, c.id), (why) => why);
  const assumptions = ctx.store.assumptions(c.id);
  let table: StatusTable = { rows: [], totals: zeroBuckets() };
  let tip: string | null = null;
  let needs = 0;
  let unavailable: string | null = root && fs.existsSync(root) ? null : `the project root ${root ?? '(unknown)'} is not here; statuses are not derived`;
  if (!unavailable) {
    unavailable = attempt<string | null>(() => {
      tip = integrationTip(root!, c.id);
      table = statusTable(ticketStates(ctx, c.id, root!, r5StatusHost(ctx)).values());
      needs = campaignNeeds(ctx, c).length;
      return null;
    }, (why) => `statuses could not be derived: ${why}`);
  }
  return {
    id: c.id, projectId: c.projectId, title, state: c.state, createdAt: c.createdAt,
    planRevision: plan?.planRevision ?? null,
    planApproved: !!plan && ctx.store.latestDecision(c.id, 'approve-plan')?.scope.planDigest === plan.planDigest,
    authorization: { decisionId: auth?.id ?? null, refusal, notAfter: auth ? envelopeOf(auth).notAfter : null },
    halted: haltOf(ctx.store, c.id)?.reason ?? null,
    run: runClaimOf(ctx.out, c.id),
    runHint: `daylight campaign run ${c.id} ${shellWord(root ?? '<repo>')} --out ${shellWord(ctx.out)}`,
    integrationRef: integrationRefFor(c.id), tip,
    tickets: ctx.store.campaignTickets(c.id).length, byBucket: table.totals,
    needs, assumptions: { open: assumptions.filter((a) => a.status === 'open').length, pending: assumptions.filter((a) => a.status === 'pending').length },
    spend: campaignSpend(ctx, c.id), unavailable,
  };
}
