import { detectSandbox, type SandboxProfile } from '../experiment/sandbox.ts';
import { requireMappedRepo, type DaylightContext } from '../mission/context.ts';
import { missionSpend } from '../mission/ledger.ts';
import { takeRunClaim } from '../mission/orchestrate.ts';
import { redact } from '../mission/redact.ts';
import { NotImplemented, type MissionStore } from '../mission/store.ts';
import { isHumanActor } from '../mission/types.ts';
import type {
  CampaignEnvelope, CampaignHaltReason, CampaignRunOptions, CampaignRunResult, CampaignSpend, CampaignTicket, Candidate, Decision,
  FindingSeverity, Mission, Need, PlanFileV1, RepairBrief, TicketStatus,
} from '../mission/types.ts';
import type { ExecutionRecord } from '../experiment/types.ts';
import { gitIn } from './apply.ts';
import { campaignLockRefusal, concludeVerdict, evaluateIntegrated } from './campaign-gates.ts';
import { dependencyNeeds } from './dependency-requests.ts';
import type { GateContext } from './gate.ts';
import {
  authorizationOf, ensureIntegrationRef, envelopeOf, expectedTip, integrationRefFor, integrationTip, landCandidate, prepareIntegration,
  R5_INTEGRATE_DEPS, reconcileIntegrations, refTarget, type IntegrateDeps, type IntegrationStep,
} from './integrate.ts';
import { ImplementRefused, runImplement } from './orchestrate.ts';
import { closeWave, fixTicketsFrom, runWaveReview, waveDue } from './wave.ts';

/**
 * The director (§4): one process, started by a person from a terminal (P2-R9), that runs a
 * campaign's tickets to landings on its integration ref under one human `authorize-campaign`.
 *
 * It holds no state of its own. Every pass derives each ticket's status from rows (§4.2),
 * dispatches ready tickets in dependency order up to the concurrency and each lane's
 * `maxParallel`, integrates finished candidates one at a time onto the tip, repairs what failed
 * with the failure fenced into the next brief, blocks what is exhausted, and closes a wave for
 * blind review every `waveSize` landings. A crash loses nothing: the next run reconciles rows
 * and refs by §4.4 and carries on.
 *
 * Spend is reserved before launch (`attempts.max_cost_usd`, P2-R18) and checked against the
 * campaign cap; an attempt whose cost is unknown halts the campaign (P2-R11), as does any
 * breach of the cap. Nothing here records a decision a person owns: derived decisions go
 * through WS-R5 (`CampaignHost`, `IntegrateDeps`).
 */

export class DirectorRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectorRefused';
  }
}

// ---- the WS-R5 seam ---------------------------------------------------------------------------

/**
 * What the director needs of WS-R5's rows and acts (§8.2). The defaults (`r5Host`) are R5's
 * functions; until those bodies land they throw `NotImplemented`, and tests supply their own.
 */
export interface CampaignHost {
  /** Every ticket row of the campaign, plan order first (R5 `campaignTickets`). */
  tickets(campaignId: string): CampaignTicket[];
  /** The approved plan, read at its commit (R5 `readPlanBlob` + `parsePlan`). */
  plan(campaignId: string): PlanFileV1;
  /** Owner-decision ids still open: a ticket that `blocksOn` one waits (R5 assumptions). */
  openOwnerDecisions(campaignId: string): Set<string>;
  /** Plan, policy and authorization currency the director does not recompute itself (R5 `campaignAuthorizationRefusal`). */
  authorizationRefusal(campaignId: string, at: number): string | null;
  /** The ticket's implement mission with its derived grant; emits `campaign.mission.authorized` (R5 `startTicketMission`). */
  startTicketMission(campaignId: string, ticketId: string, base: string): Mission;
  /** A derived `halt-campaign`; emits `campaign.halted` (R5 `haltCampaign`, derived branch). */
  halt(campaignId: string, reason: CampaignHaltReason): Decision;
  /** A wave finding's fix ticket, filed proposed (R5 `insertCampaignTickets` + a proposed work item). */
  fileFixTicket(campaignId: string, ticket: Omit<CampaignTicket, 'campaignId' | 'projectId' | 'workItemId' | 'ticketDigest' | 'createdAt'> & { title: string; statement: string }): CampaignTicket;
  /** A derived `admit-work-item` when the envelope allows (R5 `admitIfWithinEnvelope`, P2-R10): High only, a per-wave cap. */
  admitIfWithinEnvelope(campaignId: string, workItemId: string, wave: { seq: number; admitted: number; severity: FindingSeverity; findingId?: string }): boolean;
  /** R5's envelope check and derived writer, called inside `landIntegration` (P2-R22). */
  integrate: IntegrateDeps;
}

const notYet = (what: string) => (): never => {
  throw new NotImplemented(what);
};

/** WS-R5's functions over `ctx`. The merge wires each to its body (see the R6 hand-off). */
export function r5Host(ctx: DaylightContext): CampaignHost {
  void ctx;
  return {
    tickets: notYet('campaignTickets'),
    plan: notYet('readPlanBlob/parsePlan'),
    openOwnerDecisions: notYet('assumptions'),
    authorizationRefusal: notYet('campaignAuthorizationRefusal'),
    startTicketMission: notYet('startTicketMission'),
    halt: notYet('haltCampaign'),
    fileFixTicket: notYet('insertCampaignTickets'),
    admitIfWithinEnvelope: notYet('admitIfWithinEnvelope'),
    integrate: R5_INTEGRATE_DEPS,
  };
}

// ---- rows → status ---------------------------------------------------------------------------

/**
 * The campaign's latest halt that no person answered, or null. A person answers a halt by a
 * `resume-campaign` or an `adopt-integration-tip` naming it (as WS-R5's `campaignHalts` reads).
 */
export function haltOf(store: Pick<MissionStore, 'decisions'>, campaignId: string): { decision: Decision; reason: CampaignHaltReason } | null {
  const ds = store.decisions(campaignId);
  const answered = new Set(ds.filter((d) => (d.scope.operation === 'resume-campaign' || d.scope.operation === 'adopt-integration-tip')
    && isHumanActor(d.actor)).map((d) => d.scope.haltDecisionId));
  const halt = ds.filter((d) => d.scope.operation === 'halt-campaign' && !answered.has(d.id)).at(-1);
  return halt ? { decision: halt, reason: halt.scope.reason as CampaignHaltReason } : null;
}

/** The ticket's implement missions under this campaign, oldest first. */
function missionsOf(ctx: Pick<DaylightContext, 'store'>, campaign: Mission, t: CampaignTicket): Mission[] {
  return ctx.store.missions(campaign.projectId).filter((m) => m.parentId === campaign.id && m.kind === 'implement' && m.workItemId === t.workItemId);
}

const authorAttempts = (store: MissionStore, m: Mission) =>
  store.tasks(m.id).filter((t) => t.role === 'author').flatMap((t) => store.attempts(t.id)).sort((a, b) => a.startedAt - b.startedAt);

const latestCandidate = (store: MissionStore, m: Mission): Candidate | undefined => store.candidates(m.id).at(-1);

function isAncestor(repo: string, a: string, b: string): boolean {
  try {
    gitIn({ repo }, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

export interface TicketState {
  ticket: CampaignTicket;
  status: TicketStatus;
  mission?: Mission;
  attempts: number;
  /** min(the ticket's maxAttempts, the envelope's maxAttemptsPerTicket). */
  maxAttempts: number;
  commit?: string;
  reason?: string;
  /** A candidate waiting for integration: none of its integrations is live or final. */
  queued?: Candidate;
}

const FINAL_VERDICTS = new Set(['accepted-by-gates', 'rejected-by-gates', 'gates-inconclusive', 'gates-invalid', 'policy-violation', 'no-diff', 'rebase-conflict']);

/**
 * Every ticket's status, derived from rows and the integration ref on each call (§4.2). The
 * effective set is the envelope's tickets plus generated tickets a decision approved.
 */
export function ticketStates(ctx: Pick<DaylightContext, 'store' | 'out'>, campaignId: string, repo: string, host: CampaignHost): Map<string, TicketState> {
  const campaign = ctx.store.mission(campaignId);
  if (!campaign || campaign.kind !== 'campaign') throw new DirectorRefused(`${campaignId} is not a campaign`);
  const auth = authorizationOf(ctx.store, campaignId);
  const env = auth ? envelopeOf(auth) : null;
  const tickets = host.tickets(campaignId);
  const open = host.openOwnerDecisions(campaignId);
  const tip = integrationTip(repo, campaignId);
  const out = new Map<string, TicketState>();
  const landedOn = (m: Mission) => ctx.store.integrations(campaignId, { state: 'integrated', missionId: m.id })
    .find((i) => tip && i.integratedCommit && isAncestor(repo, i.integratedCommit, tip));
  for (const t of tickets) {
    const k = Math.max(1, Math.min(t.budget.maxAttempts ?? Infinity, env?.maxAttemptsPerTicket ?? 1));
    const ms = missionsOf(ctx, campaign, t);
    const m = ms.at(-1);
    const base = { ticket: t, mission: m, maxAttempts: k, attempts: m ? authorAttempts(ctx.store, m).length : 0 };
    const set = (status: TicketStatus, extra: Partial<TicketState> = {}) => out.set(t.ticketId, { ...base, status, ...extra });
    const w = ctx.store.workItem(t.workItemId);
    const landing = ms.map((x) => landedOn(x)).find(Boolean);
    if (landing) {
      set('landed', { commit: landing.integratedCommit! });
      continue;
    }
    if (!w || w.status === 'superseded' || w.status === 'rejected') {
      set('superseded', { reason: `work item ${t.workItemId} is ${w?.status ?? 'missing'}` });
      continue;
    }
    const outside = w.status !== 'approved' || (t.origin === 'plan' && env && !env.ticketIds.includes(t.ticketId));
    if (outside || t.blocksOn.some((o) => open.has(o))) {
      set('waiting-owner', { reason: outside ? 'outside the authorized set; a person approves or authorizes it' : `waits on owner decision ${t.blocksOn.filter((o) => open.has(o)).join(', ')}` });
      continue;
    }
    if (!m) {
      const deps = t.dependsOn.filter((d) => out.get(d)?.status !== 'landed' && !landedTicket(ctx, campaign, tickets, d, repo, tip));
      set(deps.length ? 'waiting' : 'ready', deps.length ? { reason: `waits on ${deps.join(', ')}` } : {});
      continue;
    }
    if (m.state === 'closed' || m.state === 'blocked') {
      set('blocked', { reason: m.outcomeReason ?? `mission ${m.id} is ${m.state}${m.outcome ? ` (${m.outcome})` : ''}` });
      continue;
    }
    if (dependencyNeeds(ctx, m).length) {
      set('waiting-dependency', { reason: 'its author asked for a dependency; a person resolves it' });
      continue;
    }
    const live = ctx.store.integrations(campaignId, { missionId: m.id }).some((i) => i.state === 'pending' || i.state === 'evaluating');
    if (live) {
      set('integrating');
      continue;
    }
    const attempts = authorAttempts(ctx.store, m);
    if (attempts.some((a) => a.state === 'running' || a.state === 'starting')) {
      set('running');
      continue;
    }
    const c = latestCandidate(ctx.store, m);
    const last = attempts.at(-1);
    if (c && last && c.attemptId === last.id && !ctx.store.integrations(campaignId, { missionId: m.id }).some((i) => i.candidateId === c.id && i.state !== 'abandoned')) {
      set('integrating', { queued: c });
      continue;
    }
    if (env?.autoApply === 'none' && c?.verdict === 'accepted-by-gates') {
      set('blocked', { reason: `candidate ${c.id} is accepted; with autoApply none a person approves and applies it` });
      continue;
    }
    if (attempts.length >= k) {
      set('blocked', { reason: `${attempts.length} attempt(s) of ${k} used; the last ended ${c?.verdict ?? 'without a candidate'}` });
      continue;
    }
    if (c && (c.verdict === 'gates-invalid' || c.verdict === 'no-diff') && c.attemptId === last?.id) {
      set('blocked', { reason: `candidate ${c.id} is ${c.verdict}: ${c.verdictReasons[0] ?? ''}`.trim() });
      continue;
    }
    set('ready');
  }
  return out;
}

function landedTicket(ctx: Pick<DaylightContext, 'store'>, campaign: Mission, tickets: CampaignTicket[], id: string, repo: string, tip: string | null): boolean {
  const t = tickets.find((x) => x.ticketId === id);
  if (!t || !tip) return false;
  return missionsOf(ctx, campaign, t).some((m) => ctx.store.integrations(campaign.id, { state: 'integrated', missionId: m.id })
    .some((i) => i.integratedCommit && isAncestor(repo, i.integratedCommit, tip)));
}

export function ticketStatuses(ctx: Pick<DaylightContext, 'store' | 'out'>, campaignId: string, repo: string, host: CampaignHost): Map<string, TicketStatus> {
  return new Map([...ticketStates(ctx, campaignId, repo, host)].map(([id, s]) => [id, s.status]));
}

// ---- spend ------------------------------------------------------------------------------------

/** The campaign's spend over every child mission (§4.6), from attempt rows only. */
export function campaignSpend(ctx: Pick<DaylightContext, 'store'>, campaignId: string): CampaignSpend {
  const campaign = ctx.store.mission(campaignId);
  if (!campaign) throw new DirectorRefused(`unknown campaign ${campaignId}`);
  const auth = authorizationOf(ctx.store, campaignId);
  const children = ctx.store.missions(campaign.projectId).filter((m) => m.parentId === campaignId);
  const out: CampaignSpend = {
    spentUsd: 0, knownUsd: 0, unknownCount: 0, scannedCount: 0, runningCount: 0, reservedUsd: 0, capUsd: auth ? envelopeOf(auth).maxUsdTotal : 0,
  };
  for (const m of children) {
    const s = missionSpend(ctx, m.id);
    out.spentUsd += s.spentUsd;
    out.knownUsd += s.knownUsd;
    out.unknownCount += s.unknownCount;
    out.scannedCount += s.scannedCount;
    out.runningCount += s.runningCount;
    for (const a of ctx.store.tasks(m.id).flatMap((t) => ctx.store.attempts(t.id))) {
      if (a.state === 'running' || a.state === 'starting') out.reservedUsd += a.maxCostUsd ?? 0;
    }
  }
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { ...out, spentUsd: round(out.spentUsd), knownUsd: round(out.knownUsd), reservedUsd: round(out.reservedUsd) };
}

/**
 * Whether another attempt reserving `nextUsd` may launch (§4.6). Unknown spend halts (P2-R11):
 * it is never charged at the cap and never summed as zero. A launch that would cross the cap
 * waits; with nothing running to free a reservation, the campaign halts `spend-cap`.
 */
export function campaignSpendRefusal(spend: CampaignSpend, envelope: Pick<CampaignEnvelope, 'maxUsdTotal'>, nextUsd: number): { refuse: string; halt: CampaignHaltReason | null } | null {
  if (spend.unknownCount > 0) {
    return { refuse: `cost unknown for ${spend.unknownCount} attempt(s); the $${envelope.maxUsdTotal.toFixed(2)} cap cannot be enforced`, halt: 'spend-unknown' };
  }
  if (spend.spentUsd > envelope.maxUsdTotal) {
    return { refuse: `spent $${spend.spentUsd.toFixed(2)}, past the $${envelope.maxUsdTotal.toFixed(2)} cap`, halt: 'spend-breach' };
  }
  if (!(nextUsd > 0) || spend.spentUsd + spend.reservedUsd + nextUsd > envelope.maxUsdTotal + 1e-9) {
    const why = `spent $${spend.spentUsd.toFixed(2)} + reserved $${spend.reservedUsd.toFixed(2)} + $${Math.max(0, nextUsd).toFixed(2)} would pass the $${envelope.maxUsdTotal.toFixed(2)} cap`;
    return { refuse: why, halt: spend.runningCount === 0 ? 'spend-cap' : null };
  }
  return null;
}

/** What the next attempt of `t` may spend: the mission's remaining budget, within the campaign's remaining cap. */
export function nextReservation(ctx: Pick<DaylightContext, 'store'>, spend: CampaignSpend, env: CampaignEnvelope, t: CampaignTicket, m: Mission | undefined): number {
  const perMission = Math.min(t.budget.maxUsd ?? Infinity, env.maxUsdPerMission);
  const used = m ? missionSpend(ctx, m.id).spentUsd : 0;
  return Math.round(Math.min(perMission - used, env.maxUsdTotal - spend.spentUsd - spend.reservedUsd) * 1e6) / 1e6;
}

// ---- repair -------------------------------------------------------------------------------------

const TAIL = 8 * 1024;
const ALL_TAILS = 24 * 1024;
const PRIOR_DIFF = 64 * 1024;

const tailOf = (s: string, n: number) => {
  const b = Buffer.from(s, 'utf8');
  return b.length <= n ? s : b.subarray(b.length - n).toString('utf8');
};

/**
 * What a repair attempt is told (§4.7): the public checks that failed with the tail of their
 * output, how many holdouts failed (a number only), the conflicted paths, the violated policy
 * rules, and the author's own prior diff. Every text is redacted and capped.
 */
export function repairBrief(ctx: Pick<DaylightContext, 'store' | 'artifacts'>, candidateId: string, attempt: number): RepairBrief {
  const c = ctx.store.candidate(candidateId);
  if (!c) throw new DirectorRefused(`unknown candidate ${candidateId}`);
  const m = ctx.store.mission(c.missionId)!;
  const integration = ctx.store.integrations(m.parentId!, { missionId: m.id }).filter((i) => i.candidateId === c.id).at(-1);
  const outcome: RepairBrief['outcome'] = c.verdict === 'gates-inconclusive' || c.verdict === 'rebase-conflict' || c.verdict === 'policy-violation'
    ? c.verdict : 'rejected-by-gates';
  const failures: RepairBrief['failures'] = [];
  let hiddenFailures = 0;
  let budget = ALL_TAILS;
  for (const e of integration ? ctx.store.gateEvaluations({ integrationId: integration.id, target: 'integrated' }) : []) {
    if (e.conclusion === 'supported') continue;
    const x = ctx.store.experiment(e.experimentId);
    if (!x || x.role === 'holdout') {
      hiddenFailures++;
      continue;
    }
    if (x.role !== 'regression' && x.role !== 'gate' && x.role !== 'acceptance') continue;
    let out = '';
    try {
      const rec = JSON.parse(ctx.artifacts.text(e.executions.at(-1)!)) as ExecutionRecord;
      const streams = [rec.stdoutRef, rec.stderrRef].filter((r) => !!r).map((r) => ctx.artifacts.text(r!));
      out = rec.why ? `${rec.why}\n${streams.join('\n')}` : streams.join('\n');
    } catch {
      out = `${e.conclusion} (no output recorded)`;
    }
    const tail = tailOf(redact(out).text, Math.min(TAIL, budget));
    budget -= Buffer.byteLength(tail, 'utf8');
    failures.push({ check: x.id, role: x.role, tail });
  }
  let priorDiff = '';
  try {
    priorDiff = redact(ctx.artifacts.get(c.diffArtifact).subarray(0, PRIOR_DIFF).toString('utf8')).text;
  } catch {
    priorDiff = '';
  }
  return {
    attempt, priorCandidateId: c.id, outcome, failures, hiddenFailures,
    conflictPaths: integration?.state === 'conflict' ? integration.conflictPaths : [],
    policy: c.policyViolations.map((v) => (v.path === null ? v.rule : `${v.rule}: ${v.path}`)),
    priorDiff,
  };
}

/** The brief for an attempt whose predecessor left no candidate (capture refused). */
function captureRefusedBrief(attempt: number, why: string): RepairBrief {
  return {
    attempt, priorCandidateId: '', outcome: 'capture-refused', failures: [{ check: 'capture', role: 'gate', tail: tailOf(redact(why).text, TAIL) }],
    hiddenFailures: 0, conflictPaths: [], policy: [], priorDiff: '',
  };
}

// ---- needs --------------------------------------------------------------------------------------

/** The director's needs on a campaign: tickets closed before an author ran, which nothing else lists (P2-R23). */
export function campaignRunNeeds(ctx: DaylightContext, campaign: Mission, host: CampaignHost = r5Host(ctx)): Need[] {
  const out: Need[] = [];
  let tickets: CampaignTicket[];
  try {
    tickets = host.tickets(campaign.id);
  } catch (err) {
    if (err instanceof NotImplemented) return out;
    throw err;
  }
  for (const t of tickets) {
    const m = missionsOf(ctx, campaign, t).at(-1);
    if (m?.state === 'closed' && (m.outcome === 'inconclusive' || m.outcome === 'failed')) {
      out.push({ kind: 'blocked', ref: m.id, why: `ticket ${t.ticketId}: ${m.outcomeReason ?? m.outcome}; a person retries it with \`daylight campaign retry\`` });
    }
  }
  const moved = (() => {
    const repo = ctx.store.project(campaign.projectId)?.root;
    const at = repo ? refTarget(repo, integrationRefFor(campaign.id)) : null;
    return at && at !== expectedTip(ctx.store, campaign.id) ? at : null;
  })();
  if (moved) out.push({ kind: 'campaign-halted', ref: campaign.id, why: `${integrationRefFor(campaign.id)} is at ${moved}, which no landing explains; a person runs \`daylight campaign adopt-tip\`` });
  return out;
}

// ---- the loop -----------------------------------------------------------------------------------

export interface DirectorOptions extends CampaignRunOptions {
  sandbox?: SandboxProfile;
  env?: NodeJS.ProcessEnv;
  host?: CampaignHost;
  /** Gate runs per check and their timeout. */
  runs?: number;
  gateTimeoutMs?: number;
  /** Tests only: crash the `n`th landing after `step`, as a killed process would. */
  crashLanding?: { n: number; step: IntegrationStep };
}

const emptySpend = (cap: number): CampaignSpend => ({ spentUsd: 0, knownUsd: 0, unknownCount: 0, scannedCount: 0, runningCount: 0, reservedUsd: 0, capUsd: cap });

const counts = (states: Map<string, TicketState>) => {
  const n: Partial<Record<TicketStatus, number>> = {};
  for (const s of states.values()) n[s.status] = (n[s.status] ?? 0) + 1;
  return n;
};

/**
 * `campaign run` (§4.1, §4.3). Refused before anything is launched when the authorization is
 * missing, expired or halted, or the lock, plan or policy it names is stale, or the asked
 * concurrency is above the envelope's. `dryRun` reads only: it writes no row, no event and no
 * ref, and returns the schedule the first pass would dispatch with each reservation.
 */
export async function runCampaign(ctx: DaylightContext, o: DirectorOptions): Promise<CampaignRunResult> {
  const host = o.host ?? r5Host(ctx);
  const campaign = ctx.store.mission(o.campaignId);
  if (!campaign || campaign.kind !== 'campaign') throw new DirectorRefused(`${o.campaignId} is not a campaign`);
  const { root, project } = requireMappedRepo(ctx.out, o.repo);
  if (project.id !== campaign.projectId) throw new DirectorRefused(`campaign ${campaign.id} belongs to ${campaign.projectId}; ${root} is ${project.id}`);
  const ref = integrationRefFor(campaign.id);
  const auth = authorizationOf(ctx.store, campaign.id);
  const env = auth ? envelopeOf(auth) : null;
  const now = () => Date.now();
  const result = (r: Partial<CampaignRunResult>): CampaignRunResult => ({
    campaignId: campaign.id, integrationRef: ref, tip: integrationTip(root, campaign.id), dryRun: !!o.dryRun, statuses: {}, landed: [], halted: haltOf(ctx.store, campaign.id)?.reason ?? null,
    refused: null, waves: 0, spend: env ? campaignSpend(ctx, campaign.id) : emptySpend(0), schedule: [], ...r,
  });

  const refusals: string[] = [];
  if (!auth || !env) refusals.push(`campaign ${campaign.id} has no human authorize-campaign decision; a person runs \`daylight campaign authorize\``);
  else {
    if (now() > env.notAfter) refusals.push(`the authorization ${auth.id} expired at ${new Date(env.notAfter).toISOString()}`);
    const halted = haltOf(ctx.store, campaign.id);
    if (halted) refusals.push(`campaign ${campaign.id} is halted (${halted.reason}, ${halted.decision.id}); a person resumes it`);
    const lock = campaignLockRefusal(ctx, campaign.id, env.gateSetDigest);
    if (lock) refusals.push(lock);
    const r5 = host.authorizationRefusal(campaign.id, now());
    if (r5) refusals.push(r5);
    if (o.concurrency !== undefined && (!Number.isInteger(o.concurrency) || o.concurrency < 1 || o.concurrency > env.concurrency)) {
      refusals.push(`--concurrency ${o.concurrency} is not within the authorized 1..${env.concurrency}`);
    }
  }
  if (refusals.length) return result({ refused: refusals.join('\n') });
  const envelope = env!;
  const concurrency = o.concurrency ?? envelope.concurrency;
  const plan = host.plan(campaign.id);
  const laneCap = (lane: string) => (lane === 'FIX' ? 1 : plan.lanes.find((l) => l.id === lane)?.maxParallel ?? 1);

  /** Ready tickets in dispatch order: plan order, round-robin by lane, within each lane's cap. */
  const schedule = (states: Map<string, TicketState>, running: Map<string, string>, room: number): TicketState[] => {
    const ready = [...states.values()].filter((s) => s.status === 'ready' && !running.has(s.ticket.ticketId));
    const busy = new Map<string, number>();
    for (const t of running.values()) busy.set(t, (busy.get(t) ?? 0) + 1);
    const lanes = [...new Set(ready.map((s) => s.ticket.lane))];
    const picked: TicketState[] = [];
    let progress = true;
    while (picked.length < room && progress) {
      progress = false;
      for (const lane of lanes) {
        if (picked.length >= room) break;
        if ((busy.get(lane) ?? 0) >= laneCap(lane)) continue;
        const next = ready.find((s) => s.ticket.lane === lane && !picked.includes(s));
        if (!next) continue;
        picked.push(next);
        busy.set(lane, (busy.get(lane) ?? 0) + 1);
        progress = true;
      }
    }
    return picked;
  };

  if (o.dryRun) {
    const states = ticketStates(ctx, campaign.id, root, host);
    const spend = campaignSpend(ctx, campaign.id);
    let reserved = spend.reservedUsd;
    const plannedRun: CampaignRunResult['schedule'] = [];
    for (const s of schedule(states, new Map(), concurrency)) {
      const next = nextReservation(ctx, { ...spend, reservedUsd: reserved }, envelope, s.ticket, s.mission);
      if (campaignSpendRefusal({ ...spend, reservedUsd: reserved }, envelope, next)) break;
      reserved += next;
      plannedRun.push({ ticketId: s.ticket.ticketId, lane: s.ticket.lane, reserveUsd: next });
    }
    return result({ statuses: Object.fromEntries([...states].map(([id, s]) => [id, s.status])), schedule: plannedRun, spend });
  }

  const release = takeRunClaim(ctx.out, campaign.id);
  const emit = (m: Pick<Mission, 'id' | 'projectId'>, category: 'lifecycle' | 'process' | 'cost' | 'approval', name: string, payload: Record<string, unknown>) =>
    ctx.events.append({ projectId: m.projectId, missionId: m.id, actorId: 'daylight', category, name, payload });
  const ictx = { store: ctx.store, events: ctx.events, artifacts: ctx.artifacts, repoRoot: root };
  const gctx: GateContext = { store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: root, out: ctx.out, runs: o.runs, sandbox: o.sandbox, timeoutMs: o.gateTimeoutMs };
  const sandbox = o.sandbox ?? detectSandbox();
  let halted: CampaignHaltReason | null = null;
  let stopped: string | null = null;
  let landings = 0;
  let wavesClosed = 0;
  const landedNow: string[] = [];
  const running = new Map<string, string>();
  const inflight = new Map<string, Promise<void>>();
  const reviews = new Set<Promise<void>>();
  const queue: Array<{ candidateId: string; ticketId: string }> = [];
  const parked = new Set<string>();

  /** Fail closed: a derived halt, which WS-R5 records and announces (`campaign.halted`). */
  const halt = (reason: CampaignHaltReason) => {
    if (halted) return;
    halted = reason;
    host.halt(campaign.id, reason);
  };
  const ticketOf = (missionId: string): string => {
    const m = ctx.store.mission(missionId);
    return host.tickets(campaign.id).find((t) => t.workItemId === m?.workItemId)?.ticketId ?? 'UNKNOWN';
  };

  try {
    const resumed = ctx.store.missions(campaign.projectId).some((m) => m.parentId === campaign.id);
    const tip = ensureIntegrationRef(root, campaign.id, campaign.baseRevision);
    for (const m of ctx.store.missions(campaign.projectId).filter((x) => x.parentId === campaign.id && x.state !== 'closed')) {
      ctx.store.cancelRunningAttempts(m.id, 'orphaned: the director running it is gone');
    }
    const rec = reconcileIntegrations(ictx, campaign.id, { ticketOf, deps: host.integrate });
    if (rec.moved) halt('integration-moved');
    emit(campaign, 'lifecycle', resumed ? 'campaign.resumed' : 'campaign.started', {
      integrationRef: ref, tip, statuses: counts(ticketStates(ctx, campaign.id, root, host)), reconciled: { requeued: rec.requeue.length, landed: rec.landed.length, refsDeleted: rec.deletedRefs.length },
    });

    /** Synchronous up to the attempt row, so the next reservation sees this one (P2-R18). */
    const dispatch = async (s: TicketState, reserve: number): Promise<void> => {
      const t = s.ticket;
      let m = s.mission;
      const tipNow = integrationTip(root, campaign.id)!;
      if (!m) m = host.startTicketMission(campaign.id, t.ticketId, tipNow);
      const attempt = s.attempts + 1;
      const tool = envelope.roster[(attempt - 1) % envelope.roster.length];
      const prior = latestCandidate(ctx.store, m);
      const lastAttempt = authorAttempts(ctx.store, m).at(-1);
      const repair = attempt === 1 ? undefined
        : prior && prior.attemptId === lastAttempt?.id ? repairBrief(ctx, prior.id, attempt)
          : lastAttempt ? captureRefusedBrief(attempt, lastAttempt.failure ?? 'the attempt left no capturable candidate') : undefined;
      emit(m, 'lifecycle', 'campaign.ticket.dispatched', { ticketId: t.ticketId, missionId: m.id, attempt, base: tipNow, tool });
      try {
        const r = await runImplement(ctx, {
          missionId: m.id, repo: root, tool, base: tipNow, ticket: t, brief: 'campaign', evaluate: false, repair, reserveUsd: reserve,
          maxTurns: Math.min(envelope.maxTurns, t.budget.maxTurns ?? Infinity),
          timeoutMs: Math.min(envelope.timeoutSeconds, t.budget.timeoutSeconds ?? Infinity) * 1000,
          sandbox, env: o.env, runs: o.runs,
        });
        if (r.candidate) queue.push({ candidateId: r.candidate.id, ticketId: t.ticketId });
      } catch (err) {
        if (!(err instanceof ImplementRefused)) throw err;
        const now = ctx.store.mission(m.id)!;
        const why = err.message.replace(/^forge run refused:\s*/, '').split('\n').map((l) => l.trim()).filter(Boolean).join('; ').slice(0, 500);
        if (now.state === 'ready') {
          // P2-R23: never redispatched; a person retries it.
          ctx.store.closeMission(now.id, 'inconclusive', `refused before an author ran: ${why}`);
          emit(now, 'lifecycle', 'campaign.ticket.blocked', { ticketId: t.ticketId, missionId: now.id, reason: 'preflight-refused' });
        } else if (now.state === 'running') {
          ctx.store.transitionMission(now.id, 'blocked', `refused: ${why}`);
          emit(now, 'lifecycle', 'campaign.ticket.blocked', { ticketId: t.ticketId, missionId: now.id, reason: 'refused' });
        }
      }
      const after = campaignSpend(ctx, campaign.id);
      if (after.spentUsd > envelope.maxUsdTotal) {
        emit(campaign, 'cost', 'campaign.spend.breached', { spent: after.spentUsd, reserved: after.reservedUsd, cap: after.capUsd, unknownCount: after.unknownCount });
        halt('spend-breach');
      }
    };

    const integrate = async (item: { candidateId: string; ticketId: string }): Promise<void> => {
      const t = host.tickets(campaign.id).find((x) => x.ticketId === item.ticketId)!;
      let i = prepareIntegration(ictx, item.candidateId, { ticketId: t.ticketId, deps: host.integrate });
      if (i.state === 'evaluating') {
        await evaluateIntegrated(gctx, i.id, t);
        i = ctx.store.integration(i.id)!;
      }
      const v = concludeVerdict(gctx, i.id, t);
      const m = ctx.store.mission(i.missionId)!;
      if (v.verdict === 'accepted-by-gates' && envelope.autoApply === 'integration-ref' && !halted) {
        const nth = landings + 1;
        const crashAfter = o.crashLanding?.n === nth ? o.crashLanding.step : undefined;
        const r = landCandidate(ictx, i.id, { ticketId: t.ticketId, deps: host.integrate, ...(crashAfter ? { crashAfter } : {}) });
        if ('landed' in r) {
          landings++;
          landedNow.push(t.ticketId);
          emit(m, 'lifecycle', 'campaign.ticket.landed', { ticketId: t.ticketId, missionId: m.id, commit: r.landed.integratedCommit });
        } else if (integrationTip(root, campaign.id) !== i.onto) {
          queue.push(item);
        } else {
          stopped = r.refused;
        }
        return;
      }
      if (i.state === 'evaluating') ctx.store.updateIntegration(i.id, 'evaluating', { state: 'rejected' });
      if (['rejected-by-gates', 'gates-inconclusive', 'rebase-conflict', 'policy-violation'].includes(v.verdict)) {
        const brief = repairBrief(ctx, item.candidateId, authorAttempts(ctx.store, m).length + 1);
        emit(m, 'process', 'campaign.repair.queued', {
          ticketId: t.ticketId, attempt: brief.attempt, outcome: brief.outcome, failures: brief.failures.length, hiddenFailures: brief.hiddenFailures,
        });
      }
    };

    /** Block what is exhausted or cannot be repaired, once; announce parked tickets once. */
    const settle = (states: Map<string, TicketState>) => {
      for (const s of states.values()) {
        const m = s.mission;
        if (!m) continue;
        if (s.status === 'blocked' && m.state === 'running') {
          ctx.store.transitionMission(m.id, 'blocked', s.reason ?? 'blocked');
          emit(m, 'lifecycle', 'campaign.ticket.blocked', { ticketId: s.ticket.ticketId, missionId: m.id, reason: s.attempts >= s.maxAttempts ? 'attempts-exhausted' : 'unrepairable' });
        }
        if (s.status === 'waiting-dependency' && !parked.has(m.id)) {
          parked.add(m.id);
          emit(m, 'lifecycle', 'campaign.ticket.parked', { ticketId: s.ticket.ticketId, missionId: m.id, requests: dependencyNeeds(ctx, m).map((n) => n.ref) });
        }
      }
    };

    const closeIfDue = (quiescent: boolean) => {
      if (o.maxWaves !== undefined && wavesClosed >= o.maxWaves) return;
      const due = waveDue(ctx, campaign.id, envelope.waveSize);
      if (!(due.due || (quiescent && due.landed > 0))) return;
      const w = closeWave(ctx, campaign.id, { ticketOf });
      if (!w) return;
      wavesClosed++;
      emit(campaign, 'lifecycle', 'campaign.wave.closed', { seq: w.seq, fromCommit: w.fromCommit, toCommit: w.toCommit, tickets: w.ticketIds.length });
      if (!envelope.reviewRoster.length) return;
      const p = (async () => {
        await runWaveReview(ctx, campaign.id, w.seq, { repo: root, roster: envelope.reviewRoster, sandbox, env: o.env });
        fixTicketsFrom(ctx, campaign.id, w.seq, host);
      })().finally(() => reviews.delete(p));
      reviews.add(p);
    };

    for (const id of rec.requeue) {
      const c = ctx.store.candidate(id);
      if (c) queue.push({ candidateId: id, ticketId: ticketOf(c.missionId) });
    }

    /** Launch what is ready, each under a reservation the cap still allows; stop at the first it does not. */
    const launch = (states: Map<string, TicketState>) => {
      for (const s of schedule(states, running, concurrency - running.size)) {
        const spend = campaignSpend(ctx, campaign.id);
        const reserve = nextReservation(ctx, spend, envelope, s.ticket, s.mission);
        const no = campaignSpendRefusal(spend, envelope, reserve);
        if (no) {
          emit(campaign, 'cost', 'campaign.spend.refused', {
            spent: spend.spentUsd, reserved: spend.reservedUsd, cap: spend.capUsd, unknownCount: spend.unknownCount, ticketId: s.ticket.ticketId,
          });
          if (no.halt) halt(no.halt);
          return;
        }
        const id = s.ticket.ticketId;
        running.set(id, s.ticket.lane);
        const p = dispatch(s, reserve).finally(() => {
          running.delete(id);
          inflight.delete(id);
        });
        inflight.set(id, p);
      }
    };
    const mayDispatch = () => !halted && !stopped && !(o.maxWaves !== undefined && wavesClosed >= o.maxWaves);

    for (;;) {
      if (!halted && !stopped) {
        const a = authorizationOf(ctx.store, campaign.id);
        const h = haltOf(ctx.store, campaign.id);
        if (!a || a.id !== auth!.id) stopped = 'the authorization changed while the campaign ran; a person runs it again';
        else if (h) halted = h.reason;
        else if (now() > envelope.notAfter) halt('authorization-expired');
      }
      if (queue.length) {
        await integrate(queue.shift()!);
        continue;
      }
      const states = ticketStates(ctx, campaign.id, root, host);
      settle(states);
      for (const s of states.values()) {
        if (s.queued && !running.has(s.ticket.ticketId)) queue.push({ candidateId: s.queued.id, ticketId: s.ticket.ticketId });
      }
      if (queue.length) continue;
      if (mayDispatch()) launch(states);
      closeIfDue(false);
      if (inflight.size) {
        await Promise.race(inflight.values());
        continue;
      }
      // Nothing running and nothing to integrate: close a partial wave, wait for reviews.
      closeIfDue(true);
      if (reviews.size) {
        await Promise.race(reviews);
        continue;
      }
      if (mayDispatch() && schedule(ticketStates(ctx, campaign.id, root, host), running, concurrency).length) continue;
      break;
    }
    const final = ticketStates(ctx, campaign.id, root, host);
    emit(campaign, 'lifecycle', 'campaign.finished', { integrationRef: ref, tip: integrationTip(root, campaign.id), statuses: counts(final), halted, landed: landings });
    return result({
      statuses: Object.fromEntries([...final].map(([id, s]) => [id, s.status])), landed: landedNow, halted, refused: stopped, waves: wavesClosed,
    });
  } finally {
    await Promise.allSettled([...inflight.values(), ...reviews]);
    release();
  }
}
