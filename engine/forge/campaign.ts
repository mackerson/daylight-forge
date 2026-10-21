import os from 'node:os';
import { requireMappedRepo, mappedRoot, type DaylightContext } from '../mission/context.ts';
import { CAMPAIGN_AUTHOR_DEFAULTS, grantsWrite, workItemContentDigest } from '../mission/store.ts';
import { redact } from '../mission/redact.ts';
import type { MissionStore } from '../mission/store.ts';
import type {
  ArtifactRef, CampaignAuthorizedPayload, CampaignEnvelope, CampaignHaltReason, Decision, EnvelopeRequest, Mission, MissionPermissions,
  PlanFileV1, PlanRefusal, RetryTicketScope, TicketTraceRow,
} from '../mission/types.ts';
import { campaignActorOf, isCampaignActor, isHumanActor } from '../mission/types.ts';
import { confirmDigest } from './confirm.ts';
import {
  acceptanceOf, budgetOf, isPlanRefusals, parsePlan, planTicketToWorkItem, policyAt, prefixOf, ticketDigestOf, ticketWorkItemId, validatePlanAt,
} from './plan.ts';
import { MAX_STATEMENT_BYTES, MAX_TITLE_CHARS, repoPathRefusal, textRefusal } from './proposal.ts';
import { assertHumanDecision, DecisionRefused, pathViolations } from './policy.ts';
import { authorLimits, ProjectPolicyError } from './project-policy.ts';
import { specRevisionOf } from './spec.ts';
import { seedPlanAssumptions } from './assumptions.ts';
import { authorityChainOf, isIrStale, packetSetDigestOf, staleBlueprints, ticketIrRefs } from './authority.ts';
import { unboundObligations } from './campaign-gates.ts';

/**
 * Campaigns: a plan imported as data, approved once, and run by the director process under one
 * human `authorize-campaign` decision (docs/daylight/CAMPAIGN.md, ADR-36, ADR-37).
 *
 * Every person's act here goes through the one guard (`assertHumanDecision`) with the digest
 * `confirmDigest` defines for it. Every director act is a derived decision the store writes
 * through `recordDerivedDecision`, which re-checks the envelope against rows; nothing here
 * reads `process.env` (the session refusal is the CLI's, P2-R9).
 */

export type { EnvelopeRequest };

type Env = Readonly<Record<string, string | undefined>>;

/** The author defaults `forge run` uses (forge/orchestrate.ts), which a campaign may only lower. */
export const AUTHOR_DEFAULTS = CAMPAIGN_AUTHOR_DEFAULTS;
const HOUR_MS = 60 * 60 * 1000;
const MAX_NOT_AFTER_MS = 30 * 24 * HOUR_MS;
const ROSTER_ENTRY = /^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9._-]{1,64})?$/;
const MAX_ROSTER = 16;

export class PlanInvalid extends Error {
  readonly refusals: PlanRefusal[];
  constructor(refusals: PlanRefusal[]) {
    super(`the plan is refused: ${refusals.length} rule(s) broken (${[...new Set(refusals.map((r) => r.rule))].join(', ')})`);
    this.name = 'PlanInvalid';
    this.refusals = refusals;
  }
}

const emit = (
  ctx: DaylightContext, m: Pick<Mission, 'id' | 'projectId'>, category: 'lifecycle' | 'approval', name: string, actorId: string,
  payload: Record<string, unknown>, artifactIds?: string[],
) => ctx.events.append({ projectId: m.projectId, missionId: m.id, actorId, category, name, payload, ...(artifactIds ? { artifactIds } : {}) });

/** The campaign a mission belongs to: itself, its parent, or none. */
export function campaignOf(ctx: DaylightContext, mission: Mission): Mission | null {
  if (mission.kind === 'campaign') return mission;
  const parent = mission.parentId ? ctx.store.mission(mission.parentId) : null;
  return parent?.kind === 'campaign' ? parent : null;
}

function requireCampaign(ctx: DaylightContext, id: string): Mission {
  const m = ctx.store.mission(id);
  if (!m || m.kind !== 'campaign') throw new Error(`${id} is not a campaign mission`);
  return m;
}

/** The plan a campaign was last imported at: its artifact, its bytes re-verified, parsed. */
export function planOf(ctx: DaylightContext, campaignId: string): {
  plan: PlanFileV1; planArtifact: ArtifactRef; planDigest: string; planRevision: string; commit: string; path: string;
} {
  const c = requireCampaign(ctx, campaignId);
  const at = ctx.store.currentPlan(c.id);
  const ref = at ? ctx.store.artifact(at.planArtifact) : null;
  if (!at || !ref || ref.digest !== at.planDigest || ref.projectId !== c.projectId) throw new Error(`campaign ${c.id} has no recorded plan`);
  if (c.scope.paths?.[0] !== at.path || specRevisionOf(at.planDigest, at.commit) !== at.planRevision) {
    throw new Error(`campaign ${c.id}'s plan record does not match the campaign`);
  }
  const parsed = parsePlan(ctx.artifacts.get(ref));
  if (isPlanRefusals(parsed)) throw new Error(`campaign ${c.id}'s recorded plan no longer parses`);
  return { plan: parsed, planArtifact: ref, planDigest: at.planDigest, planRevision: at.planRevision, commit: at.commit, path: at.path };
}

// ---- import ----------------------------------------------------------------------------

export interface ImportedPlan {
  campaign: Mission;
  planArtifact: ArtifactRef;
  planDigest: string;
  planRevision: string;
  commit: string;
  added: string[];
  kept: string[];
  dropped: string[];
  /** A version-2 plan with a derivation: tickets traced to packets, those a person edited after emission, and those with no packet. */
  trace?: { traced: number; handEdited: string[]; untraced: number };
}

/**
 * A version-2 plan's descent from its packets (P2-R50 F1, §8.3), checked against this project's
 * rows: the corpus revision, the approved and current blueprint, the IR set it was drawn over,
 * every cited record approved and current, each ticket's packet that blueprint's packet for that
 * ticket, the packet set's digest recomputed, every `OIR.*` a recorded interpretation. A ticket
 * whose digest (no defaults) is not its packet's is imported and flagged `hand_edited`, not refused:
 * a person may edit what they commit, and the edit is shown. Rows for `ticket_trace` come back.
 */
export function planDescent(ctx: DaylightContext, projectId: string, plan: PlanFileV1): {
  refusals: PlanRefusal[]; trace: Array<Omit<TicketTraceRow, 'campaignId'>>; handEdited: string[]; untraced: number;
} {
  const d = plan.derivation;
  const refusals: PlanRefusal[] = [];
  const no = (path: string, detail: string) => refusals.push({ path, rule: 'derivation', detail });
  if (!d) return { refusals, trace: [], handEdited: [], untraced: plan.tickets.length };
  const corpus = ctx.store.mission(d.corpusId);
  if (!corpus || corpus.kind !== 'corpus' || corpus.projectId !== projectId) no('$.derivation.corpusId', 'not a corpus of this project');
  else if (!ctx.store.corpusRevisionByDigest(corpus.id, d.corpusDigest)) no('$.derivation.corpusDigest', 'not a revision of that corpus');
  const bp = ctx.store.blueprint(d.blueprintId);
  if (!bp || bp.corpusId !== d.corpusId) no('$.derivation.blueprintId', 'not a blueprint of that corpus');
  else {
    if (bp.status !== 'approved') no('$.derivation.blueprintId', `the blueprint is ${bp.status}, not approved`);
    else if (staleBlueprints(ctx, bp.corpusId).has(bp.id)) no('$.derivation.blueprintId', 'the blueprint is stale');
    if (bp.blueprintDigest !== d.blueprintDigest) no('$.derivation.blueprintDigest', 'not the blueprint\'s digest');
    if (bp.body.irSetDigest !== d.irSetDigest) no('$.derivation.irSetDigest', 'not the IR set the blueprint was drawn over');
  }
  const trace: Array<Omit<TicketTraceRow, 'campaignId'>> = [];
  const handEdited: string[] = [];
  const pairs: Array<{ ticketId: string; packetDigest: string }> = [];
  let untraced = 0;
  plan.tickets.forEach((t, i) => {
    const refs = ticketIrRefs(t);
    for (const ref of refs) {
      const r = ctx.store.irRecord(ref.irId);
      if (!r || r.corpusId !== d.corpusId) no(`$.tickets[${i}]`, `cites ${ref.irId}, which is not a record of the corpus`);
      else if (r.status !== 'approved') no(`$.tickets[${i}]`, `cites ${ref.irId}, which is ${r.status}`);
      else if (isIrStale(ctx, r.id)) no(`$.tickets[${i}]`, `cites ${ref.irId}, which is stale`);
    }
    if (!t.packetId) {
      untraced++;
      for (const ref of refs) trace.push({ ticketId: t.id, irId: ref.irId, role: ref.role, detail: ref.detail, packetId: null, handEdited: false });
      return;
    }
    const p = ctx.store.packet(t.packetId);
    if (!p || p.blueprintId !== d.blueprintId || p.ticketId !== t.id) return no(`$.tickets[${i}].packetId`, 'not this blueprint\'s packet for this ticket');
    pairs.push({ ticketId: t.id, packetDigest: p.packetDigest });
    const edited = ticketDigestOf(t, undefined) !== p.packetDigest;
    if (edited) handEdited.push(t.id);
    for (const ref of refs) trace.push({ ticketId: t.id, irId: ref.irId, role: ref.role, detail: ref.detail, packetId: p.id, handEdited: edited });
  });
  if (packetSetDigestOf(pairs) !== d.packetSetDigest) no('$.derivation.packetSetDigest', 'the packets the tickets name do not hash to it');
  const oirs = new Set([...(plan.ownerDecisions ?? []).map((o) => o.id), ...plan.tickets.flatMap((t) => t.blocksOn ?? [])].filter((o) => o.startsWith('OIR.')));
  for (const o of oirs) {
    const a = ctx.store.assumptionByOwnerDecision(projectId, o);
    if (a?.source !== 'ir-interpretation' || a.campaignId !== d.corpusId) no('$.ownerDecisions', `${o} is not an interpretation recorded on the corpus`);
  }
  return { refusals, trace, handEdited, untraced };
}

/**
 * `campaign import`: not a decision. Validates the plan at `rev`, then creates the campaign
 * mission (or, with `campaignId`, revises it), files the plan artifact, one proposed work item
 * and one ticket row per ticket (unchanged tickets keep theirs), one open assumption per new
 * owner decision, and emits `campaign.plan.imported`, the record of the current plan.
 */
export function importPlan(ctx: DaylightContext, repo: string, rel: string, o: { rev?: string; campaignId?: string } = {}): ImportedPlan {
  const { root, project } = requireMappedRepo(ctx.out, repo);
  const v = validatePlanAt(root, rel, o.rev ?? 'HEAD');
  if (!v.plan || !v.bytes || !v.planDigest) throw new PlanInvalid(v.refusals);
  const plan = v.plan;
  ctx.store.ensureProject(project);
  const descent = planDescent(ctx, project.id, plan);
  if (descent.refusals.length) throw new PlanInvalid(descent.refusals);
  let campaign: Mission;
  if (o.campaignId) {
    campaign = requireCampaign(ctx, o.campaignId);
    if (campaign.projectId !== project.id) throw new Error(`campaign ${campaign.id} belongs to ${campaign.projectId}, not ${project.id}`);
    if (campaign.state === 'closed') throw new Error(`campaign ${campaign.id} is closed`);
    if (campaign.scope.paths?.[0] !== rel) throw new Error(`campaign ${campaign.id}'s plan is ${campaign.scope.paths?.[0]}, not ${rel}`);
  } else {
    campaign = ctx.store.createMission({
      projectId: project.id, kind: 'campaign', objective: `campaign: ${plan.title}`, baseRevision: v.commit,
      scope: { paths: [rel, ...(plan.statusPath ? [plan.statusPath] : [])] }, permissions: { execute: false },
    });
  }
  const planArtifact = ctx.artifacts.put(v.bytes, {
    kind: 'spec', projectId: project.id, revision: v.commit, path: rel, label: 'campaign plan', mediaType: 'application/json',
  });
  ctx.store.recordArtifact(planArtifact);
  const planRevision = specRevisionOf(planArtifact.digest, v.commit);
  const entries = plan.tickets.map((t) => ({
    workItem: planTicketToWorkItem(t, { campaignId: campaign.id, projectId: project.id, planArtifact, planRevision }),
    ticket: {
      campaignId: campaign.id, ticketId: t.id, projectId: project.id, origin: 'plan' as const, lane: t.lane, dependsOn: t.dependsOn ?? [],
      scope: t.scope.map(prefixOf), acceptance: acceptanceOf(t, plan.defaults), budget: budgetOf(t, plan.defaults), blocksOn: t.blocksOn ?? [],
      ticketDigest: ticketDigestOf(t, plan.defaults),
    },
  }));
  // The tickets and their trace in one transaction: a plan's trace is what that plan states.
  const rows = ctx.store.tx(() => {
    const r = ctx.store.importPlanTickets(campaign.id, entries);
    ctx.store.replaceTicketTrace(campaign.id, descent.trace.map((t) => ({ ...t, campaignId: campaign.id })));
    return r;
  });
  seedPlanAssumptions(ctx, campaign.id, plan);
  const trace = plan.derivation ? { traced: plan.tickets.length - descent.untraced, handEdited: descent.handEdited, untraced: descent.untraced } : undefined;
  emit(ctx, campaign, 'lifecycle', 'campaign.plan.imported', 'daylight', {
    planArtifact: planArtifact.id, planDigest: planArtifact.digest, planRevision, commit: v.commit, path: rel,
    tickets: plan.tickets.length, lanes: plan.lanes.length, ownerDecisions: plan.ownerDecisions?.length ?? 0,
    added: rows.added.length, kept: rows.kept.length, dropped: rows.dropped.length,
    ...(trace ? { version: plan.version, traced: trace.traced, handEdited: trace.handEdited.length, untraced: trace.untraced } : {}),
  }, [planArtifact.id]);
  return { campaign: ctx.store.mission(campaign.id)!, planArtifact, planDigest: planArtifact.digest, planRevision, commit: v.commit, ...rows, ...(trace ? { trace } : {}) };
}

// ---- approve-plan ----------------------------------------------------------------------

export interface GuardedInput {
  campaignId: string;
  actor: string;
  rationale: string | undefined;
  confirm: string | undefined;
  env: Env;
}

/**
 * `approve-plan`: the one human approval of a plan (ADR-20 guard). One decision lists every plan
 * ticket's work item at its digest; the store moves them all `proposed → approved`, supersedes
 * what the plan dropped or changed, moves the non-blocking defaults to `pending`, and readies
 * the campaign, in one transaction.
 */
export function approvePlan(ctx: DaylightContext, input: GuardedInput): Decision {
  const c = requireCampaign(ctx, input.campaignId);
  assertHumanDecision(input.env, input.actor, input.confirm, confirmDigest(ctx, 'approve-plan', c.id).digest);
  if (!input.rationale?.trim()) throw new DecisionRefused('refused: a plan approval needs a rationale');
  const plan = planOf(ctx, c.id);
  const set = ctx.store.planApprovalSet(c.id);
  const decision = ctx.store.approvePlan(c.id, {
    actor: input.actor, rationale: input.rationale.trim(), artifactIds: [plan.planArtifact.id],
    scope: { operation: 'approve-plan', planDigest: plan.planDigest, planRevision: plan.planRevision, ...set },
  });
  emit(ctx, c, 'approval', 'campaign.plan.approved', input.actor, {
    decisionId: decision.id, planDigest: plan.planDigest, tickets: Object.keys(set.workItems).length, superseded: set.supersedes.length,
  }, [plan.planArtifact.id]);
  return decision;
}

// ---- authorize-campaign ----------------------------------------------------------------

export interface EnvelopeFlags {
  expectedGateSetDigest: string;
  roster: string[];
  reviewRoster?: string[];
  maxUsdTotal: number;
  maxUsdPerMission: number;
  maxTurns: number;
  timeoutSeconds: number;
  maxAttemptsPerTicket: number;
  concurrency: number;
  waveSize?: number;
  execute: boolean;
  autoApply: CampaignEnvelope['autoApply'];
  fixLane?: CampaignEnvelope['fixLane'];
  /** Explicit ticket ids; absent: every approved plan ticket, expanded now. */
  tickets?: string[];
  /** `<n>h` or `<n>d`, at most 30 days; default 72h. */
  notAfter?: string;
  identity?: CampaignEnvelope['identity'];
  /** `<ticket>:ob<n>` acceptance obligations a person lets run with no locked gate bound (P2-R50 F3); recorded in the envelope. */
  unboundObligations?: string[];
}

/** `72h` / `3d` as milliseconds, at most 30 days, or null. */
export function notAfterSpan(s: string): number | null {
  const m = /^([1-9]\d{0,3})([hd])$/.exec(s);
  if (!m) return null;
  const ms = Number(m[1]) * (m[2] === 'd' ? 24 : 1) * HOUR_MS;
  return ms <= MAX_NOT_AFTER_MS ? ms : null;
}

/**
 * The envelope `campaign authorize` would record now, from the flags and the rows. `notAfter`
 * is rounded up to the hour, so the preview a person reads and the act they confirm agree.
 */
export function buildEnvelope(ctx: DaylightContext, campaignId: string, f: EnvelopeFlags, now = ctx.store.clock()): CampaignEnvelope & { unboundObligations?: string[] } {
  const plan = planOf(ctx, campaignId);
  const span = notAfterSpan(f.notAfter ?? '72h');
  if (span === null) throw new DecisionRefused('refused: --not-after is <n>h or <n>d, at most 30 days');
  const approved = ctx.store.campaignTickets(campaignId, { origin: 'plan' })
    .filter((t) => ctx.store.workItem(t.workItemId)?.status === 'approved').map((t) => t.ticketId);
  const user = os.userInfo().username.replace(/[^\w.-]/g, '_') || 'unknown';
  return {
    planDigest: plan.planDigest, gateSetDigest: f.expectedGateSetDigest, policyDigest: policyAtPlan(ctx, plan.commit)?.digest ?? null,
    ticketIds: f.tickets?.length ? [...new Set(f.tickets)] : approved,
    roster: f.roster, reviewRoster: f.reviewRoster ?? [],
    maxUsdTotal: f.maxUsdTotal, maxUsdPerMission: f.maxUsdPerMission, maxTurns: f.maxTurns, timeoutSeconds: f.timeoutSeconds,
    maxAttemptsPerTicket: f.maxAttemptsPerTicket, concurrency: f.concurrency, waveSize: f.waveSize ?? 2 * f.concurrency,
    execute: f.execute, autoApply: f.autoApply,
    fixLane: f.fixLane ?? { enabled: false, maxTicketsPerWave: 0, maxUsdPerTicket: 0 },
    identity: f.identity ?? { name: user, email: `${user}@daylight.invalid` },
    notAfter: Math.ceil((now + span) / HOUR_MS) * HOUR_MS,
    // Only when named, so every envelope without one confirms and records as it always did.
    ...(f.unboundObligations?.length ? { unboundObligations: [...new Set(f.unboundObligations)].sort() } : {}),
  };
}

function policyAtPlan(ctx: DaylightContext, commit: string) {
  const root = mappedRoot(ctx.out);
  if (!root) throw new Error(`${ctx.out} holds no map; the policy at the plan commit is read from its repository`);
  try {
    return policyAt(root, commit);
  } catch (err) {
    if (err instanceof ProjectPolicyError) throw new DecisionRefused('refused: the project policy at the plan commit does not parse (P2-R20)');
    throw err;
  }
}

/** Why the envelope's roster or author bounds are refused against the policy at the plan commit, or null. */
export function envelopeBoundsRefusal(ctx: DaylightContext, e: CampaignEnvelope, planCommit: string): string | null {
  for (const r of [...e.roster, ...e.reviewRoster]) if (!ROSTER_ENTRY.test(r)) return 'a roster entry is tool or tool:model';
  if (e.roster.length > MAX_ROSTER || e.reviewRoster.length > MAX_ROSTER) return `a roster has at most ${MAX_ROSTER} entries`;
  const limits = authorLimits(policyAtPlan(ctx, planCommit), AUTHOR_DEFAULTS);
  if (e.maxTurns > limits.maxTurns) return `--max-turns ${e.maxTurns} is above the ${limits.maxTurns} the policy at the plan commit allows`;
  if (e.timeoutSeconds * 1000 > limits.timeoutMs) return `--timeout ${e.timeoutSeconds} is above the ${limits.timeoutMs / 1000}s the policy at the plan commit allows`;
  return null;
}

/**
 * `campaign authorize`: the human grant the director acts under (ADR-37). Guarded; refused
 * unless the plan is approved and current, the gate lock is the one the person names, every
 * ticket is an approved plan ticket, the caps are ordered, and the author bounds are within the
 * policy at the plan commit (P2-R20).
 */
export function authorizeCampaign(ctx: DaylightContext, input: GuardedInput & { flags: EnvelopeFlags; now?: number }): Decision {
  const c = requireCampaign(ctx, input.campaignId);
  const envelope = buildEnvelope(ctx, c.id, input.flags, input.now);
  assertHumanDecision(input.env, input.actor, input.confirm, confirmDigest(ctx, 'authorize-campaign', c.id, { envelope }).digest);
  if (!input.rationale?.trim()) throw new DecisionRefused('refused: an authorization needs a rationale');
  const bounds = envelopeBoundsRefusal(ctx, envelope, planOf(ctx, c.id).commit);
  if (bounds) throw new DecisionRefused(`refused: ${bounds}`);
  // A traced plan's chain must hold before a grant is made on it (fail closed); the envelope link is this act's.
  const chain = authorityChainOf(ctx, c.id).breaks.filter((b) => b.link !== 'envelope');
  if (chain.length) throw new DecisionRefused(`refused: the authority chain is broken at ${chain.map((b) => `${b.link} (${b.why})`).join('; ')}`);
  // P2-R50 F3: every acceptance obligation of the tickets is discharged by a locked gate, or named here.
  const unbound = unboundObligations(ctx, c.id, envelope.ticketIds);
  const named = new Set((envelope as CampaignEnvelope & { unboundObligations?: string[] }).unboundObligations ?? []);
  const missing = unbound.filter((ob) => !named.has(ob));
  if (missing.length) {
    throw new DecisionRefused(`refused: acceptance obligation(s) ${missing.join(', ')} are bound to no locked gate; bind them at \`campaign lock\` or name them in --unbound-obligations`);
  }
  const extra = [...named].filter((ob) => !unbound.includes(ob));
  if (extra.length) throw new DecisionRefused(`refused: --unbound-obligations names ${extra.join(', ')}, which are bound or are not obligations of these tickets`);
  const decision = ctx.store.authorizeCampaign(c.id, {
    actor: input.actor, rationale: input.rationale.trim(), expectedGateSetDigest: input.flags.expectedGateSetDigest,
    policy: policyAtPlan(ctx, planOf(ctx, c.id).commit),
    scope: { operation: 'authorize-campaign', ...envelope },
  });
  const payload: CampaignAuthorizedPayload = {
    decisionId: decision.id, planDigest: envelope.planDigest, gateSetDigest: envelope.gateSetDigest, maxUsdTotal: envelope.maxUsdTotal,
    maxUsdPerMission: envelope.maxUsdPerMission, concurrency: envelope.concurrency, execute: envelope.execute, autoApply: envelope.autoApply,
  };
  emit(ctx, c, 'approval', 'campaign.authorized', input.actor, { ...payload });
  return decision;
}

/** Why the campaign's authorization does not let the director act at `at`, or null. */
export function campaignAuthorizationRefusal(ctx: DaylightContext, campaignId: string, at = ctx.store.clock()): string | null {
  const c = requireCampaign(ctx, campaignId);
  const d = ctx.store.campaignAuthorization(c.id);
  if (!d) return `campaign ${c.id} has no authorization; a person runs \`daylight campaign authorize\``;
  const why = ctx.store.envelopeRefusal(d.id, { missionId: c.id, operation: 'admit-work-item', ticketId: '', at });
  if (why) return why;
  // Every director pass re-derives a traced plan's authority chain; a broken link stops it (§9, fail closed).
  const chain = authorityChainOf(ctx, c.id);
  return chain.breaks.length ? `campaign ${c.id}'s authority chain is broken at ${chain.breaks.map((b) => `${b.link} (${b.why})`).join('; ')}` : null;
}

/**
 * Why `parentDecisionId`'s envelope does not cover `request`, or null. Rows only; the store's
 * `recordDerivedDecision` runs the same check inside its caller's transaction, and R6's
 * `landIntegration` calls this there too.
 */
export function envelopeRefusal(store: MissionStore, parentDecisionId: string, request: EnvelopeRequest): string | null {
  return store.envelopeRefusal(parentDecisionId, request);
}

/**
 * Why this mission's `authorize-mission` grant does not let it run, or null. What preflight asks
 * in place of `isHumanActor(authorize.actor)`: a human write grant, or a derived one that is a
 * grant on its rows and still inside its campaign's envelope now.
 */
export function authorizeGrantRefusal(ctx: DaylightContext, mission: Mission): string | null {
  const d = ctx.store.authorizeDecision(mission.id);
  if (!d) return `mission ${mission.id} has no authorize-mission decision granting write`;
  const parent = isCampaignActor(d.actor) && typeof d.scope.derivedFrom === 'string' ? ctx.store.decision(d.scope.derivedFrom) : null;
  if (!grantsWrite(d, mission.id, parent, mission)) return `mission ${mission.id} has no human authorize-mission decision granting write`;
  if (isHumanActor(d.actor)) return null;
  const scope = d.scope as { permissions?: MissionPermissions; maxUsd?: number | null; ticketId?: unknown };
  return ctx.store.envelopeRefusal(parent!.id, {
    missionId: mission.id, operation: 'authorize-mission', ticketId: typeof scope.ticketId === 'string' ? scope.ticketId : '',
    permissions: scope.permissions, maxUsd: scope.maxUsd ?? null, at: ctx.store.clock(),
  });
}

// ---- the director's acts ---------------------------------------------------------------

/**
 * The ticket's implement mission, created under the campaign and granted by a derived
 * `authorize-mission` (§4.3 dispatch step 1). Refused outside the envelope; the store re-checks.
 */
export function startTicketMission(ctx: DaylightContext, o: { campaignId: string; ticketId: string; base: string }): Mission {
  const c = requireCampaign(ctx, o.campaignId);
  const parent = ctx.store.campaignAuthorization(c.id);
  if (!parent) throw new DecisionRefused(`refused: campaign ${c.id} has no authorization`);
  const t = ctx.store.campaignTicket(c.id, o.ticketId);
  if (!t) throw new Error(`campaign ${c.id} has no ticket ${o.ticketId}`);
  const w = ctx.store.workItem(t.workItemId)!;
  const refused = ctx.store.envelopeRefusal(parent.id, { missionId: c.id, operation: 'admit-work-item', ticketId: '', at: ctx.store.clock() });
  if (refused) throw new DecisionRefused(`refused: ${refused}`);
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(o.base)) throw new Error('a ticket mission starts from a full commit id');
  const { mission: ready, decision } = ctx.store.createTicketMission({
    projectId: c.projectId, kind: 'implement', parentId: c.id, objective: w.title, baseRevision: o.base,
    scope: { paths: t.scope }, workItemId: w.id, ...(t.budget.maxUsd !== undefined ? { budget: { maxUsd: t.budget.maxUsd } } : {}),
  }, parent.id);
  emit(ctx, ready, 'approval', 'campaign.mission.authorized', campaignActorOf(c.id), {
    decisionId: decision.id, derivedFrom: parent.id, ticketId: t.ticketId, permissions: ready.permissions, maxUsd: ready.budget.maxUsd ?? null,
  });
  return ready;
}

/**
 * Admit a generated fix ticket under the envelope (P2-R10), or leave it proposed for a person:
 * only a `high` finding, with the fix lane on, fewer than `maxTicketsPerWave` admitted in this
 * wave (counted from rows as well as passed), a scope inside the plan's lanes and not protected,
 * and the authorization in force.
 */
export function admitIfWithinEnvelope(
  ctx: DaylightContext, campaignId: string, workItemId: string,
  wave: { seq: number; admitted: number; severity: 'low' | 'medium' | 'high'; findingId?: string },
): { admitted: true; decision: Decision } | { admitted: false; why: string } {
  const c = requireCampaign(ctx, campaignId);
  const parent = ctx.store.campaignAuthorization(c.id);
  if (!parent) return { admitted: false, why: 'no authorization' };
  const e = parent.scope as unknown as CampaignEnvelope;
  const t = ctx.store.campaignTicketByWorkItem(workItemId);
  if (!t || t.campaignId !== c.id || t.origin !== 'fix') return { admitted: false, why: 'not a fix ticket of this campaign' };
  if (wave.severity !== 'high') return { admitted: false, why: `a ${wave.severity} finding waits for a person` };
  if (!e.fixLane.enabled) return { admitted: false, why: 'the fix lane is off' };
  const counted = ctx.store.decisions(c.id).filter((d) => d.scope.operation === 'admit-work-item' && d.scope.waveSeq === wave.seq).length;
  if (Math.max(counted, wave.admitted) >= e.fixLane.maxTicketsPerWave) return { admitted: false, why: `wave ${wave.seq} already admitted ${e.fixLane.maxTicketsPerWave}` };
  if (e.fixLane.maxUsdPerTicket > e.maxUsdPerMission) return { admitted: false, why: 'the fix lane\'s cap is above the per-mission cap' };
  const { plan, path: planPath, commit } = planOf(ctx, c.id);
  const policy = policyAtPlan(ctx, commit);
  const owns = plan.lanes.flatMap((l) => l.owns.map(prefixOf));
  const fenced = new Set([planPath, plan.statusPath].filter((p): p is string => !!p));
  for (const s of t.scope) {
    if (!owns.some((o) => s === o || s.startsWith(`${o}/`))) return { admitted: false, why: 'its scope is outside every lane' };
    const v = pathViolations({ path: s, change: 'modified', insertions: 0, deletions: 0, mode: 'file' }, { policy });
    if (fenced.has(s) || v.some((r) => r === 'protected-path' || r === 'gate-path' || r === 'path-escape')) {
      return { admitted: false, why: 'its scope is protected' };
    }
  }
  const outside = campaignAuthorizationRefusal(ctx, c.id);
  if (outside) return { admitted: false, why: outside };
  const decision = ctx.store.admitWorkItem(workItemId, parent.id, { ticketId: t.ticketId, findingId: wave.findingId, waveSeq: wave.seq }, policy);
  emit(ctx, c, 'approval', 'campaign.work-item.admitted', campaignActorOf(c.id), {
    decisionId: decision.id, workItemId, ticketId: t.ticketId, ...(wave.findingId ? { findingId: wave.findingId } : {}),
  });
  return { admitted: true, decision };
}

/** What `fileFixTicket` reads of a wave-review finding (WS-R6's `Finding`). */
export interface FixFinding { id: string; path: string; title: string; statement: string }

/**
 * A wave finding's fix ticket, filed **proposed** (§6.3, P2-R36): `FIX.<wave>.<n>` in the `FIX`
 * lane, scope the finding's path, budget the fix lane's per-ticket cap, acceptance the plan's
 * default. The finding's words are a reviewer's text: checked like a proposal (caps, no control
 * or bidi characters, a repo-relative path), redacted, and carried only as the work item's data,
 * which the author brief fences. Idempotent on the finding id. Admission is the caller's next
 * step (`admitIfWithinEnvelope`).
 */
export function fileFixTicket(ctx: DaylightContext, o: { campaignId: string; waveSeq: number; finding: FixFinding }): string {
  const c = requireCampaign(ctx, o.campaignId);
  const f = o.finding;
  if (!Number.isInteger(o.waveSeq) || o.waveSeq < 1) throw new DecisionRefused('refused: a fix ticket names the wave its finding came from');
  if (typeof f.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(f.id)) throw new DecisionRefused('refused: a finding id is a plain id');
  const had = ctx.store.campaignTickets(c.id).find((t) => t.origin === 'fix' && t.sourceRef === f.id);
  if (had) return had.ticketId;
  const pathWhy = repoPathRefusal(f.path);
  if (pathWhy) throw new DecisionRefused(`refused: the finding's path is refused: ${pathWhy}`);
  const title = `Fix: ${redact(String(f.title)).text}`;
  const titleWhy = textRefusal(title, MAX_TITLE_CHARS * 4, false) ?? (title.length > MAX_TITLE_CHARS ? `over ${MAX_TITLE_CHARS} characters` : null);
  if (titleWhy) throw new DecisionRefused(`refused: the finding's title is ${titleWhy}`);
  const statement = redact(String(f.statement)).text;
  const statementWhy = textRefusal(statement, MAX_STATEMENT_BYTES, true);
  if (statementWhy) throw new DecisionRefused(`refused: the finding's statement is ${statementWhy}`);
  const { plan, planArtifact, planRevision } = planOf(ctx, c.id);
  const env = ctx.store.campaignAuthorization(c.id)?.scope as unknown as CampaignEnvelope | undefined;
  const n = ctx.store.campaignTickets(c.id).filter((t) => t.origin === 'fix' && t.ticketId.startsWith(`FIX.${o.waveSeq}.`)).length + 1;
  const ticketId = `FIX.${o.waveSeq}.${n}`;
  const base = {
    projectId: c.projectId, missionId: c.id, specArtifact: planArtifact, specRevision: planRevision, anchor: `ticket:${ticketId}`,
    title, statement, examples: [], negativeExamples: [], proposedBy: 'wave-review',
  };
  const contentDigest = workItemContentDigest(base);
  const t = ctx.store.insertGeneratedTicket({ ...base, id: ticketWorkItemId(c.id, ticketId, contentDigest) }, {
    campaignId: c.id, ticketId, projectId: c.projectId, origin: 'fix', lane: 'FIX', dependsOn: [], scope: [f.path],
    acceptance: plan.defaults?.acceptance ?? { kind: 'ci-only' }, budget: env ? { maxUsd: env.fixLane.maxUsdPerTicket } : {}, blocksOn: [],
    ticketDigest: contentDigest, sourceRef: f.id,
  });
  return t.ticketId;
}

/** Halt the campaign: a person's halt, or the director's derived one (fail closed). */
export function haltCampaign(ctx: DaylightContext, campaignId: string, actor: string, reason: CampaignHaltReason): Decision {
  const c = requireCampaign(ctx, campaignId);
  const d = ctx.store.recordHalt(c.id, actor, reason);
  emit(ctx, c, 'lifecycle', 'campaign.halted', actor, { decisionId: d.id, reason });
  return d;
}

/** A person resumes a halted campaign, naming the halt they read (guarded). */
export function resumeCampaign(ctx: DaylightContext, input: GuardedInput & { haltDecisionId: string }): Decision {
  const c = requireCampaign(ctx, input.campaignId);
  assertHumanDecision(input.env, input.actor, input.confirm, confirmDigest(ctx, 'resume-campaign', c.id, { haltDecisionId: input.haltDecisionId }).digest);
  if (!input.rationale?.trim()) throw new DecisionRefused('refused: a resume needs a rationale');
  return ctx.store.recordResume(c.id, { actor: input.actor, rationale: input.rationale.trim(), haltDecisionId: input.haltDecisionId });
}

// ---- retry -----------------------------------------------------------------------------

/** What `campaign retry` would record for this ticket now, from rows and the mission's refusal event. */
export function retryScopeOf(ctx: DaylightContext, campaignId: string, ticketId: string): RetryTicketScope {
  const c = requireCampaign(ctx, campaignId);
  const t = ctx.store.campaignTicket(c.id, ticketId);
  if (!t) throw new Error(`campaign ${c.id} has no ticket ${ticketId}`);
  const w = ctx.store.workItem(t.workItemId)!;
  const held = ctx.store.workItemConsumer(w.id);
  if (!held) throw new DecisionRefused(`refused: ticket ${ticketId}'s work item is not held by any mission; there is nothing to release`);
  const m = ctx.store.mission(held)!;
  const refused = ctx.events.forMission(m.id).some((e) => e.name === 'forge.author.refused' && e.actorId === 'daylight');
  if (!refused) throw new DecisionRefused(`refused: mission ${m.id} was not refused at preflight; retry releases only such a mission`);
  return {
    operation: 'retry-ticket', ticketId: t.ticketId, workItemId: w.id, contentDigest: w.contentDigest, closedMissionId: m.id,
    reason: (m.outcomeReason ?? 'refused at preflight').split('\n')[0].slice(0, 200),
  };
}

/**
 * `campaign retry`: a person releases a ticket whose mission was refused at preflight and closed
 * inconclusive (P2-R23, P2-R25), so a new mission may build its work item (P2-R27).
 */
export function retryTicket(ctx: DaylightContext, input: GuardedInput & { ticketId: string }): Decision {
  const c = requireCampaign(ctx, input.campaignId);
  const scope = retryScopeOf(ctx, c.id, input.ticketId);
  assertHumanDecision(input.env, input.actor, input.confirm, confirmDigest(ctx, 'retry-ticket', c.id, { retry: scope }).digest);
  if (!input.rationale?.trim()) throw new DecisionRefused('refused: a retry needs a rationale');
  const d = ctx.store.retryTicket(c.id, { actor: input.actor, rationale: input.rationale.trim(), scope });
  emit(ctx, c, 'approval', 'campaign.ticket.released', input.actor, {
    decisionId: d.id, ticketId: scope.ticketId, workItemId: scope.workItemId, closedMissionId: scope.closedMissionId,
  });
  return d;
}

// ---- invariants over rows --------------------------------------------------------------

/**
 * The campaign invariants that are about rows, for a project: every derived decision derives
 * from a human grant it stays inside (`derivationRefusals`); no campaign mission holds write,
 * execute or deploy; every plan ticket's work item is approved by an `approve-plan` listing its
 * digest (or still proposed), and its `ticketDigest` re-derives from the current plan.
 */
export function campaignViolations(ctx: DaylightContext, projectId: string): string[] {
  const out = [...ctx.store.derivationRefusals(projectId)];
  for (const c of ctx.store.missions(projectId).filter((m) => m.kind === 'campaign')) {
    const p = c.permissions;
    if (p.write || p.execute || p.deploy) out.push(`campaign ${c.id} holds ${[p.write && 'write', p.execute && 'execute', p.deploy && 'deploy'].filter(Boolean).join(', ')}`);
    let plan: PlanFileV1 | null = null;
    try {
      plan = planOf(ctx, c.id).plan;
    } catch (err) {
      out.push((err as Error).message);
    }
    const byId = new Map((plan?.tickets ?? []).map((t) => [t.id, t]));
    for (const t of ctx.store.campaignTickets(c.id, { origin: 'plan' })) {
      const w = ctx.store.workItem(t.workItemId);
      const pt = byId.get(t.ticketId);
      if (plan && (!pt || ticketDigestOf(pt, plan.defaults) !== t.ticketDigest)) out.push(`ticket ${t.ticketId} of campaign ${c.id} does not re-derive from its plan`);
      if (!w || w.status === 'proposed') continue;
      const d = w.decisionId ? ctx.store.decision(w.decisionId) : null;
      const listed = d?.scope.operation === 'approve-plan' && (d.scope.workItems as Record<string, unknown>)?.[w.id] === w.contentDigest;
      if (w.status === 'approved' && !listed) out.push(`ticket ${t.ticketId}'s work item ${w.id} is approved by no approve-plan listing its digest`);
    }
    if (plan && [...byId.keys()].some((id) => !ctx.store.campaignTicket(c.id, id))) out.push(`campaign ${c.id}'s plan names a ticket with no row`);
  }
  return out;
}
