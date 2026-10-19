import type { DaylightContext } from '../mission/context.ts';
import { workItemContentDigest } from '../mission/store.ts';
import type { Assumption, AssumptionDecisionScope, AssumptionStatus, Decision, Mission, Need, PlanFileV1 } from '../mission/types.ts';
import { confirmDigest } from './confirm.ts';
import { prefixOf, ticketWorkItemId } from './plan.ts';
import { assertHumanDecision, DecisionRefused } from './policy.ts';
import { MAX_EXAMPLE_BYTES, MAX_STATEMENT_BYTES, repoPathRefusal, textRefusal } from './proposal.ts';

/**
 * Director assumptions (§5): what a campaign proceeds on while a question waits for its owner.
 * Written by the director process only (P2-R12): one `open` row per plan owner decision at
 * import, and an operator's row by a person's guarded act. `approve-plan` moves the plan's
 * non-blocking defaults to `pending`; every move after that is a person's decision. Authors have
 * no assumption tool, and a row nobody human recorded is never `pending` (a DDL CHECK).
 */

type Env = Readonly<Record<string, string | undefined>>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function requireCampaign(ctx: DaylightContext, id: string): Mission {
  const m = ctx.store.mission(id);
  if (!m || m.kind !== 'campaign') throw new Error(`${id} is not a campaign mission`);
  return m;
}

/** One `open` row per owner decision the plan names that this campaign does not have yet. */
export function seedPlanAssumptions(ctx: DaylightContext, campaignId: string, plan: PlanFileV1): Assumption[] {
  const have = new Set(ctx.store.assumptions(campaignId).map((a) => a.ownerDecisionId).filter(Boolean));
  const out: Assumption[] = [];
  for (const o of plan.ownerDecisions ?? []) {
    if (have.has(o.id)) continue;
    const a = ctx.store.recordAssumption({
      campaignId, ownerDecisionId: o.id, question: o.question, default: o.default ?? '', rationale: o.rationale?.trim() || 'named in the plan',
      status: 'open', blocking: o.blocking, source: 'plan-default', recordedBy: 'daylight',
    });
    ctx.events.append({
      projectId: a.projectId, missionId: campaignId, actorId: 'daylight', category: 'approval', name: 'assumption.recorded',
      payload: { assumptionId: a.id, status: a.status, decisionId: null },
    });
    out.push(a);
  }
  return out;
}

export interface RecordAssumptionInput {
  campaignId: string;
  question: string;
  default: string;
  rationale: string | undefined;
  ticketId?: string;
  actor: string;
  confirm: string | undefined;
  env: Env;
}

/**
 * `assumption record`: an operator's assumption, by a person (guarded). With a default it is
 * `pending` (the director proceeds on it until the owner confirms or overturns); without one it
 * is `open` and holds nothing but a need.
 */
export function recordAssumption(ctx: DaylightContext, input: RecordAssumptionInput): Assumption {
  const c = requireCampaign(ctx, input.campaignId);
  const row = { question: input.question, default: input.default, ...(input.ticketId ? { ticketId: input.ticketId } : {}) };
  assertHumanDecision(input.env, input.actor, input.confirm, confirmDigest(ctx, 'record-assumption', c.id, { assumption: row }).digest);
  if (!input.rationale?.trim()) throw new DecisionRefused('refused: an assumption needs a rationale');
  const qWhy = textRefusal(input.question, MAX_STATEMENT_BYTES, true);
  if (qWhy) throw new DecisionRefused(`refused: the question is ${qWhy}`);
  if (input.default !== '' && textRefusal(input.default, MAX_EXAMPLE_BYTES, true)) throw new DecisionRefused('refused: the default is not plain text within its cap');
  if (input.ticketId && !ctx.store.campaignTicket(c.id, input.ticketId)) throw new DecisionRefused(`refused: campaign ${c.id} has no ticket ${input.ticketId}`);
  const a = ctx.store.recordAssumption({
    campaignId: c.id, ...(input.ticketId ? { ticketId: input.ticketId } : {}), question: input.question, default: input.default,
    rationale: input.rationale.trim(), status: input.default.trim() ? 'pending' : 'open', blocking: false, source: 'operator',
    recordedBy: input.actor,
  });
  ctx.events.append({
    projectId: a.projectId, missionId: c.id, actorId: input.actor, category: 'approval', name: 'assumption.recorded',
    payload: { assumptionId: a.id, status: a.status, decisionId: null },
  });
  return a;
}

export interface DecideAssumptionInput {
  id: string;
  operation: AssumptionDecisionScope['operation'];
  /** `decide` and `overturn`: the owner's answer. `confirm` takes the default. */
  value?: string;
  /** `overturn`: the follow-up ticket's statement, its lane and scope (default: the held ticket's). */
  followUp?: { statement: string; lane?: string; scope?: string[] };
  actor: string;
  rationale: string | undefined;
  confirm: string | undefined;
  env: Env;
}

/** The tickets an assumption holds: its own, and every ticket whose `blocksOn` names its owner decision. */
export function heldTickets(ctx: DaylightContext, a: Assumption): string[] {
  const out = new Set<string>(a.ticketId ? [a.ticketId] : []);
  if (a.ownerDecisionId) for (const t of ctx.store.campaignTickets(a.campaignId)) if (t.blocksOn.includes(a.ownerDecisionId)) out.add(t.ticketId);
  return [...out];
}

/**
 * `assumption confirm|decide|overturn` (guarded). An overturn creates exactly one proposed
 * follow-up work item and ticket (`FU.<n>`, admitted by a person's `work-item approve` only) and
 * reverts nothing that landed.
 */
export function decideAssumption(ctx: DaylightContext, input: DecideAssumptionInput): { decision: Decision; assumption: Assumption } {
  const a = ctx.store.assumption(input.id);
  if (!a) throw new Error(`unknown assumption ${input.id}`);
  const value = input.operation === 'confirm-assumption' ? a.default : input.value;
  if (value === undefined) throw new DecisionRefused(`refused: ${input.operation} needs --value`);
  assertHumanDecision(input.env, input.actor, input.confirm, confirmDigest(ctx, input.operation, a.id, { value, followUp: input.followUp?.statement }).digest);
  if (!input.rationale?.trim()) throw new DecisionRefused('refused: an assumption decision needs a rationale');
  if (input.operation !== 'confirm-assumption' && textRefusal(value, MAX_EXAMPLE_BYTES, true)) {
    throw new DecisionRefused('refused: the value is not plain text within its cap');
  }
  if (input.followUp && input.operation !== 'overturn-assumption') throw new DecisionRefused('refused: only an overturn creates a follow-up');
  let followUp: Parameters<typeof ctx.store.decideAssumption>[1]['followUp'];
  if (input.followUp) followUp = followUpOf(ctx, a, input.followUp, input.actor);
  const decision = ctx.store.decideAssumption(a.id, {
    actor: input.actor, rationale: input.rationale.trim(), followUp,
    scope: { operation: input.operation, assumptionId: a.id, value, ...(followUp ? { followUpWorkItemId: followUp.workItem.id } : {}) },
  });
  const after = ctx.store.assumption(a.id)!;
  ctx.events.append({
    projectId: a.projectId, missionId: a.campaignId, actorId: input.actor, category: 'approval', name: 'assumption.decided',
    payload: { assumptionId: a.id, status: after.status, decisionId: decision.id, ...(after.followUpWorkItemId ? { followUpWorkItemId: after.followUpWorkItemId } : {}) },
  });
  return { decision, assumption: after };
}

function followUpOf(
  ctx: DaylightContext, a: Assumption, f: NonNullable<DecideAssumptionInput['followUp']>, actor: string,
): NonNullable<Parameters<typeof ctx.store.decideAssumption>[1]['followUp']> {
  const why = textRefusal(f.statement, MAX_STATEMENT_BYTES, true);
  if (why) throw new DecisionRefused(`refused: the follow-up statement is ${why}`);
  const held = heldTickets(ctx, a);
  const from = held.map((id) => ctx.store.campaignTicket(a.campaignId, id)).find(Boolean) ?? null;
  const lane = f.lane ?? from?.lane;
  const scope = (f.scope?.length ? f.scope : from?.scope ?? []).map(prefixOf);
  if (!lane || !/^[A-Z][A-Z0-9]{0,7}$/.test(lane)) throw new DecisionRefused('refused: a follow-up names its lane (--lane) when the assumption holds no ticket');
  if (!scope.length || scope.some((s) => repoPathRefusal(s))) throw new DecisionRefused('refused: a follow-up names a repo-relative scope (--scope)');
  const n = ctx.store.campaignTickets(a.campaignId).filter((t) => t.origin === 'follow-up').length + 1;
  const ticketId = `FU.${n}`;
  const plan = ctx.store.currentPlan(a.campaignId);
  const specArtifact = plan ? ctx.store.artifact(plan.planArtifact) : null;
  if (!plan || !specArtifact) throw new Error(`campaign ${a.campaignId} has no recorded plan`);
  const base = {
    projectId: a.projectId, missionId: a.campaignId, specArtifact, specRevision: plan.planRevision, anchor: `ticket:${ticketId}`,
    title: `Follow-up to assumption ${a.id}`, statement: f.statement, examples: [], negativeExamples: [], proposedBy: actor,
  };
  const workItem = { ...base, id: ticketWorkItemId(a.campaignId, ticketId, workItemContentDigest(base)) };
  return {
    workItem,
    ticket: {
      campaignId: a.campaignId, ticketId, projectId: a.projectId, origin: 'follow-up', lane, dependsOn: held, scope,
      acceptance: from?.acceptance ?? { kind: 'ci-only' }, budget: {}, blocksOn: [], ticketDigest: workItemContentDigest(base), sourceRef: a.id,
    },
  };
}

/** Tickets that wait on an owner: every ticket whose `blocksOn` names an owner decision still `open`. */
export function waitingOwner(ctx: DaylightContext, campaignId: string): Map<string, string[]> {
  const open = new Set(ctx.store.assumptions(campaignId, { status: 'open' }).map((a) => a.ownerDecisionId).filter((x): x is string => !!x));
  const out = new Map<string, string[]>();
  for (const t of ctx.store.campaignTickets(campaignId)) {
    const on = t.blocksOn.filter((o) => open.has(o));
    if (on.length) out.set(t.ticketId, on);
  }
  return out;
}

/** `assumption-pending` per pending row; `owner-decision` per open row, naming the tickets it holds. */
export function assumptionNeeds(ctx: DaylightContext, campaign: Mission): Need[] {
  const out: Need[] = [];
  for (const a of ctx.store.assumptions(campaign.id)) {
    if (a.status === 'pending') {
      out.push({ kind: 'assumption-pending', ref: a.id, why: `assumption ${a.id} is proceeding on its default; its owner confirms or overturns it` });
    } else if (a.status === 'open') {
      const held = heldTickets(ctx, a);
      out.push({
        kind: 'owner-decision', ref: a.id,
        why: `assumption ${a.id} waits for its owner${held.length ? `; it holds ${plural(held.length, 'ticket')}: ${held.join(', ')}` : ''}`,
      });
    }
  }
  return out;
}

export const ASSUMPTION_STATUSES: readonly AssumptionStatus[] = ['open', 'pending', 'confirmed', 'overturned'];
