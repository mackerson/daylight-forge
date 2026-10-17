import { ambiguities } from '../forge/decompose.ts';
import type { DaylightContext } from './context.ts';
import { compare, missionClaims, type Comparison } from './disputes.ts';
import type { Candidate, Decision, Experiment, GateEvaluation, Mission, Need } from './types.ts';

/**
 * What a person has to do before a mission can move: derived from rows on every read, never
 * stored (PLAN resolution 6). A need is not a state. A mission whose reviewers disagree is
 * `running`, and one whose candidate passed every gate is `running` too; the state table has
 * no "waiting on you" and should not, so the list is computed here and counted by the UI.
 *
 * Holdouts are counted, never named: a need's text is shown to whoever looks at the strip,
 * and the point of a holdout is that nobody shaping the change can read it.
 */

const CANDIDATE_OPERATIONS = new Set(['approve-candidate', 'reject-candidate', 'override-candidate']);

/** The latest approve, reject or override of `c`, or null. */
export function candidateDecision(decisions: readonly Decision[], c: Pick<Candidate, 'id'>): Decision | null {
  return decisions.filter((d) => CANDIDATE_OPERATIONS.has(String(d.scope.operation)) && d.scope.candidateId === c.id).at(-1) ?? null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The P0 rule: every task done, and the reviewers' claims contradict each other. */
function disputeNeeds(ctx: DaylightContext, mission: Mission, comparison?: Comparison): Need[] {
  const tasks = ctx.store.tasks(mission.id);
  if (!tasks.length || tasks.some((t) => t.state !== 'done')) return [];
  const disputes = (comparison ?? compare(ctx.claims, mission.scope, missionClaims(mission.id))).disputes;
  return disputes
    .filter((d) => d.belief.status === 'CONTRADICTED')
    .map((d) => ({ kind: 'dispute', ref: `${d.subject} ${d.predicate}`, why: 'the reviewers disagree; a person decides' }));
}

/** Readings that disagree on an anchor, and every other proposal still waiting for a person. */
function specNeeds(ctx: DaylightContext, mission: Mission): Need[] {
  const ambiguous = ambiguities(ctx, mission.id);
  const contested = new Set(ambiguous.map((n) => n.ref.slice(mission.id.length + 1)));
  const undecided = ctx.store.workItems(mission.projectId, { missionId: mission.id, status: 'proposed' })
    .filter((w) => !contested.has(w.anchor))
    .map((w): Need => ({
      kind: 'work-item-undecided', ref: w.id,
      why: `work item ${w.id} (${w.anchor}) is proposed; a person approves or rejects it`,
    }));
  return [...ambiguous, ...undecided];
}

/** The latest base evaluation of `x` at its current harness. */
function baselineOf(evals: readonly GateEvaluation[], x: Experiment): GateEvaluation | undefined {
  return evals.filter((g) => g.experimentId === x.id && g.harnessDigest === x.harnessDigest).at(-1);
}

function gateNeeds(ctx: DaylightContext, mission: Mission): Need[] {
  const gates = ctx.store.experimentsFor(mission.id).filter((x) => x.role === 'gate' || x.role === 'holdout');
  if (!gates.length) return [];
  const evals = ctx.store.gateEvaluations({ missionId: mission.id, target: 'base' });
  const lock = ctx.store.lockDecision(mission.id);
  const lockedIds = Array.isArray(lock?.scope.experimentIds) ? (lock!.scope.experimentIds as string[]) : [];
  const overrides = Array.isArray(lock?.scope.vacuousOverrides) ? (lock!.scope.vacuousOverrides as string[]) : [];
  let stale = false;
  if (lock) {
    try {
      stale = ctx.store.gateSet(mission.id, lockedIds).gateSetDigest !== lock.scope.gateSetDigest;
    } catch {
      stale = true;
    }
  }
  const out: Need[] = [];
  const falsified = gates.filter((x) => baselineOf(evals, x)?.conclusion === 'falsified');
  const unlocked = falsified.filter((x) => !lockedIds.includes(x.id));
  if (falsified.length && (!lock || stale || unlocked.length)) {
    const holdouts = unlocked.filter((x) => x.role === 'holdout').length;
    const why = !lock
      ? `${plural(falsified.length, 'gate')} fail on the base and nothing is locked; a person locks the gate set before an author runs`
      : stale
        ? 'the gate lock is stale: a locked gate changed after it was locked; a person locks again'
        : `${plural(unlocked.length, 'gate')} that fail on the base ${unlocked.length === 1 ? 'is' : 'are'} not in the lock`
          + `${holdouts ? ` (${plural(holdouts, 'holdout')})` : ''}; a person locks again`;
    out.push({ kind: 'gate-lock', ref: mission.id, why });
  }
  const vacuous = gates.filter((x) => baselineOf(evals, x)?.conclusion === 'supported' && !overrides.includes(x.id));
  for (const x of vacuous.filter((g) => g.role === 'gate')) {
    out.push({
      kind: 'gate-vacuous', ref: x.id,
      why: `gate ${x.id} already passes on the base, so passing it says nothing; fix the test or accept it at lock`,
    });
  }
  const vacuousHoldouts = vacuous.filter((g) => g.role === 'holdout').length;
  if (vacuousHoldouts) {
    out.push({
      kind: 'gate-vacuous', ref: mission.id,
      why: `${plural(vacuousHoldouts, 'holdout')} already pass on the base; fix or accept at lock`,
    });
  }
  return out;
}

function candidateNeeds(ctx: DaylightContext, mission: Mission): Need[] {
  const decisions = ctx.store.decisions(mission.id);
  const out: Need[] = [];
  for (const c of ctx.store.candidates(mission.id)) {
    const d = candidateDecision(decisions, c);
    if (!d && (c.verdict === 'accepted-by-gates' || c.verdict === 'gates-inconclusive')) {
      out.push({
        kind: 'candidate-decision', ref: c.id,
        why: `candidate ${c.id} is ${c.verdict}; a person approves, rejects or overrides it`,
      });
    }
    const op = d?.scope.operation;
    if ((op === 'approve-candidate' || op === 'override-candidate') && !ctx.store.application(c.id)) {
      out.push({
        kind: 'apply', ref: c.id,
        why: `candidate ${c.id} was ${op === 'override-candidate' ? 'overridden' : 'approved'} and is not applied; a person applies it to a branch`,
      });
    }
  }
  return out;
}

function implementNeeds(ctx: DaylightContext, mission: Mission): Need[] {
  const out: Need[] = [];
  if (mission.state === 'draft' && !ctx.store.authorizeDecision(mission.id)) {
    out.push({
      kind: 'mission-awaiting-authorize', ref: mission.id,
      why: `implement mission ${mission.id} is a draft without write; a person authorizes it before anything runs`,
    });
  }
  return [...out, ...gateNeeds(ctx, mission), ...candidateNeeds(ctx, mission)];
}

export function needsOf(ctx: DaylightContext, mission: Mission, comparison?: Comparison): Need[] {
  if (mission.state === 'closed') return [];
  if (mission.state === 'blocked') {
    return [{ kind: 'blocked', ref: mission.id, why: mission.outcomeReason ?? 'blocked' }];
  }
  switch (mission.kind) {
    case 'spec': return specNeeds(ctx, mission);
    case 'implement': return implementNeeds(ctx, mission);
    case 'work': return [];
    default: return disputeNeeds(ctx, mission, comparison);
  }
}

/** Every need of every mission in a project (or in `<out>`, when none is named). */
export function projectNeeds(ctx: DaylightContext, projectId?: string): Need[] {
  return ctx.store.missions(projectId).flatMap((m) => needsOf(ctx, m));
}
