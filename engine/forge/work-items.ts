import type { DaylightContext } from '../mission/context.ts';
import { workItemContentDigest } from '../mission/store.ts';
import type {
  Decision, Mission, MissionBudget, MissionScope, Need, WorkItem, WorkItemDecisionScope, WorkItemStatus,
} from '../mission/types.ts';
import { isHumanActor } from '../mission/types.ts';
import { ambiguities } from './decompose.ts';
import { confirmDigest } from './confirm.ts';
import { assertHumanDecision, DecisionRefused, guardCheck } from './policy.ts';

/**
 * The work-item lifecycle after ingest: `proposed → approved | rejected`, by a person only,
 * through the one authenticity guard (R10.4, R14 D-9); then an approved item is consumed by
 * exactly one implement mission.
 *
 * Every act here goes through `assertHumanDecision` with the digest `confirmDigest` defines
 * for it (R-5): for a work item, the store's `workItemContentDigest` of what the person read
 * (R-6). Nothing here slices a digest or reimplements a check the guard makes.
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface DecideWorkItemInput {
  id: string;
  kind: 'approve' | 'reject';
  actor: string;
  rationale: string;
  /** The first eight hex of the item's content digest, as the person typed it. */
  confirm: string | undefined;
  /** The environment the command runs in; `process.env` at the CLI. */
  env: Env;
}

/** The item as a person would be asked to decide it: digest, lines, and whether the guard would pass. */
export interface WorkItemView {
  workItem: WorkItem;
  /** The digest `--confirm` is checked against, and what a prompt or dialog shows beside it. */
  confirm: { digest: string; lines: string[] };
  /** The decision that moved it out of `proposed`, if any. */
  decision: Decision | null;
  /** The implement mission that consumed it, if any. */
  consumedBy: string | null;
  /** True when the stored fields no longer hash to the stored digest: the row was edited. */
  tampered: boolean;
}

function requireItem(ctx: DaylightContext, id: string): WorkItem {
  const w = ctx.store.workItem(id);
  if (!w) throw new Error(`unknown work item ${id}`);
  return w;
}

/** Implement missions in the item's project that name it. More than one is a broken invariant. */
function consumers(ctx: DaylightContext, w: WorkItem): Mission[] {
  return ctx.store.missions(w.projectId).filter((m) => m.kind === 'implement' && m.workItemId === w.id);
}

const intact = (w: WorkItem) => workItemContentDigest(w) === w.contentDigest;

export function showWorkItem(ctx: DaylightContext, id: string): WorkItemView {
  const w = requireItem(ctx, id);
  const c = confirmDigest(ctx, 'approve-work-item', w.id);
  return {
    workItem: w,
    confirm: { digest: c.digest, lines: c.lines },
    decision: w.decisionId ? ctx.store.decision(w.decisionId) : null,
    consumedBy: consumers(ctx, w)[0]?.id ?? null,
    tampered: !intact(w),
  };
}

export function listWorkItems(
  ctx: DaylightContext, projectId: string, opts: { missionId?: string; status?: WorkItemStatus } = {},
): { workItems: WorkItem[]; needs: Need[] } {
  const workItems = ctx.store.workItems(projectId, opts);
  const missions = opts.missionId ? [opts.missionId] : [...new Set(workItems.map((w) => w.missionId))];
  return { workItems, needs: missions.flatMap((m) => ambiguities(ctx, m)) };
}

/**
 * Why the guard would refuse this decision, or null; never acts. For a UI that shows why a
 * button is disabled (R12.5).
 */
export function workItemGuard(ctx: DaylightContext, input: Omit<DecideWorkItemInput, 'rationale'>): string | null {
  const w = requireItem(ctx, input.id);
  const digest = confirmDigest(ctx, input.kind === 'approve' ? 'approve-work-item' : 'reject-work-item', w.id).digest;
  return guardCheck(input.env, input.actor, input.confirm, digest);
}

/**
 * Approve or reject a proposed work item. Refused, before anything is written, when the guard
 * refuses (agent environment, non-human actor, wrong `--confirm`), when there is no rationale,
 * when the item is not `proposed`, or when its stored fields no longer hash to its digest.
 * Records the decision, naming the content digest, then moves the item compare-and-set.
 */
export function decideWorkItem(ctx: DaylightContext, input: DecideWorkItemInput): { decision: Decision; workItem: WorkItem } {
  const w = requireItem(ctx, input.id);
  if (input.kind !== 'approve' && input.kind !== 'reject') throw new Error(`a work item is approved or rejected, not ${String(input.kind)}`);
  const operation = input.kind === 'approve' ? 'approve-work-item' : 'reject-work-item';
  assertHumanDecision(input.env, input.actor, input.confirm, confirmDigest(ctx, operation, w.id).digest);
  if (!input.rationale?.trim()) throw new DecisionRefused('refused: a work-item decision needs a rationale');
  if (w.status !== 'proposed') throw new DecisionRefused(`refused: work item ${w.id} is ${w.status}; only a proposed item is decided`);
  if (!intact(w)) {
    throw new DecisionRefused(`refused: work item ${w.id}'s fields no longer hash to ${w.contentDigest}; it was changed after it was proposed`);
  }
  const mission = ctx.store.mission(w.missionId);
  if (!mission) throw new Error(`work item ${w.id} names unknown mission ${w.missionId}`);
  const scope: WorkItemDecisionScope & { specRevision: string; anchor: string } = {
    operation, workItemId: w.id, contentDigest: w.contentDigest, specRevision: w.specRevision, anchor: w.anchor,
  };
  const decision = ctx.store.recordDecision({
    missionId: mission.id, projectId: mission.projectId, revision: mission.baseRevision, actor: input.actor,
    kind: input.kind, subject: w.id, rationale: input.rationale.trim(), scope: { ...scope },
    artifactIds: [w.specArtifact.id, ...(w.proposalArtifact ? [w.proposalArtifact.id] : [])],
  });
  const workItem = ctx.store.setWorkItemStatus(w.id, 'proposed', input.kind === 'approve' ? 'approved' : 'rejected', decision.id);
  ctx.events.append({
    projectId: mission.projectId, missionId: mission.id, actorId: input.actor, category: 'approval',
    name: 'spec.work-item.decided', artifactIds: decision.artifactIds,
    payload: { workItemId: w.id, decisionId: decision.id, kind: input.kind, operation, contentDigest: w.contentDigest },
  });
  return { decision, workItem };
}

/**
 * The approved, intact, unconsumed work item an implement mission may build, or a refusal.
 * "Consumed" is any implement mission naming it, whatever that mission's outcome: an item is
 * built once, and building it again starts from a new proposal and a new approval.
 */
export function assertImplementable(ctx: DaylightContext, workItemId: string): WorkItem {
  const w = requireItem(ctx, workItemId);
  if (w.status !== 'approved') throw new Error(`work item ${w.id} is ${w.status}; only an approved item is built`);
  if (!intact(w)) throw new Error(`work item ${w.id}'s fields no longer hash to the digest that was approved`);
  const d = w.decisionId ? ctx.store.decision(w.decisionId) : null;
  const scope = d?.scope as { operation?: unknown; contentDigest?: unknown } | undefined;
  if (!d || d.kind !== 'approve' || scope?.operation !== 'approve-work-item' || scope.contentDigest !== w.contentDigest) {
    throw new Error(`work item ${w.id} has no approve-work-item decision naming ${w.contentDigest}`);
  }
  const taken = consumers(ctx, w);
  if (taken.length) throw new Error(`work item ${w.id} is already built by mission ${taken[0].id}; an item is consumed once`);
  return w;
}

export interface CreateImplementMissionInput {
  projectId: string;
  /** The `Revision.label` the author starts from. */
  baseRevision: string;
  /** Defaults to the work item's title. Required for an ad hoc mission (it is what is confirmed). */
  objective?: string;
  scope?: MissionScope;
  budget?: MissionBudget;
  env: Env;
  from:
    | { workItemId: string }
    | { adhoc: { actor: string; rationale: string; confirm: string | undefined } };
}

/**
 * The one way to create an implement mission (R10.1): from an approved, unconsumed work item,
 * or `--no-work-item`, which records an `adhoc-mission` decision under the same guard as every
 * other decision (D-9). Neither, or both, is refused; so is an item that is not implementable.
 */
export function createImplementMission(ctx: DaylightContext, input: CreateImplementMissionInput): Mission {
  // Read loosely: a caller outside the type system can pass both, and both is refused too.
  const from = (input.from ?? {}) as { workItemId?: string; adhoc?: { actor: string; rationale: string; confirm: string | undefined } };
  const hasItem = from.workItemId !== undefined;
  const hasAdhoc = from.adhoc !== undefined;
  if (hasItem === hasAdhoc) {
    throw new Error('an implement mission builds an approved work item, or is started ad hoc by a person who says why (--no-work-item); exactly one');
  }
  if (hasItem) {
    const w = assertImplementable(ctx, from.workItemId!);
    if (w.projectId !== input.projectId) throw new Error(`work item ${w.id} belongs to ${w.projectId}, not ${input.projectId}`);
    const mission = ctx.store.createMission({
      projectId: input.projectId, kind: 'implement', objective: (input.objective ?? w.title).trim(),
      baseRevision: input.baseRevision, scope: input.scope, budget: input.budget, workItemId: w.id,
    });
    // The store has no uniqueness on work_item_id, so a racing second create is caught here;
    // it cannot be undone from this side, only reported loudly (asked of WS1).
    const all = consumers(ctx, w);
    if (all.length > 1) throw new Error(`work item ${w.id} is now named by ${all.length} implement missions (${all.map((m) => m.id).join(', ')}); this is a broken invariant`);
    ctx.events.append({
      projectId: mission.projectId, missionId: mission.id, actorId: 'daylight', category: 'lifecycle',
      name: 'spec.work-item.consumed', payload: { workItemId: w.id, missionId: mission.id, contentDigest: w.contentDigest },
    });
    return mission;
  }
  const adhoc = from.adhoc!;
  const objective = input.objective?.trim();
  if (!objective) throw new Error('an ad hoc implement mission needs an objective; it is what the person confirms');
  assertHumanDecision(input.env, adhoc.actor, adhoc.confirm,
    confirmDigest(ctx, 'adhoc-mission', objective, { projectId: input.projectId }).digest);
  if (!adhoc.rationale?.trim()) throw new DecisionRefused('refused: an ad hoc implement mission needs a rationale');
  return ctx.store.createMission({
    projectId: input.projectId, kind: 'implement', objective, baseRevision: input.baseRevision,
    scope: input.scope, budget: input.budget, adhoc: { actor: adhoc.actor, rationale: adhoc.rationale.trim() },
  });
}

/**
 * The spec-intake invariant, over a project's rows. Empty when it holds:
 * - no work item is out of `proposed` without a `human:` decision of the right operation
 *   naming its id and content digest;
 * - every implement mission names an approved work item or carries an `adhoc-mission`
 *   decision by a human (R-16), and no work item is named by two of them;
 * - no spec mission holds an experiment.
 */
export function specIntakeViolations(ctx: DaylightContext, projectId: string): string[] {
  const out: string[] = [];
  for (const w of ctx.store.workItems(projectId)) {
    if (w.status === 'proposed') continue;
    const d = w.decisionId ? ctx.store.decision(w.decisionId) : null;
    const scope = d?.scope as { operation?: unknown; workItemId?: unknown; contentDigest?: unknown } | undefined;
    const op = w.status === 'approved' ? 'approve-work-item' : 'reject-work-item';
    if (!d || !isHumanActor(d.actor) || scope?.operation !== op || scope.workItemId !== w.id || scope.contentDigest !== w.contentDigest) {
      out.push(`work item ${w.id} is ${w.status} without a human ${op} decision naming ${w.contentDigest}`);
    }
  }
  const missions = ctx.store.missions(projectId);
  const named = new Map<string, string[]>();
  for (const m of missions) {
    if (m.kind === 'spec' && ctx.store.experiments(m.id).length) out.push(`spec mission ${m.id} holds an experiment`);
    if (m.kind !== 'implement') continue;
    if (m.workItemId) {
      named.set(m.workItemId, [...(named.get(m.workItemId) ?? []), m.id]);
      const w = ctx.store.workItem(m.workItemId);
      if (!w || w.status === 'proposed' || w.status === 'rejected') {
        out.push(`implement mission ${m.id} names work item ${m.workItemId}, which is ${w?.status ?? 'unknown'}`);
      }
    } else if (!ctx.store.decisions(m.id).some((d) => d.kind === 'adhoc-mission' && isHumanActor(d.actor))) {
      out.push(`implement mission ${m.id} has neither an approved work item nor a human adhoc-mission decision`);
    }
  }
  for (const [id, ms] of named) if (ms.length > 1) out.push(`work item ${id} is built by ${ms.length} implement missions: ${ms.join(', ')}`);
  return out;
}
