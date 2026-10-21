import path from 'node:path';
import { digestOf } from '../mission/artifacts.ts';
import { GateSetMoved } from '../mission/store.ts';
import type {
  CampaignLockScope, CampaignTicket, CampaignVerdictRows, Decision, ExpectedObservation, Experiment, GateEvaluation, GateHarness,
  Integration, Mission, PlanFileV1,
} from '../mission/types.ts';
import { harnessHolds, runGate } from '../experiment/runner.ts';
import { gitIn } from './apply.ts';
import { campaignVerdict, requiredChecks } from './campaign-verdict.ts';
import { gateCacheKey, removeGateCache } from './cargo.ts';
import { confirmDigest } from './confirm.ts';
import { cargoTargetOf, GateRefused, record, recordIntegrated, registerGate, runContext, type AuthorBriefGate, type GateContext } from './gate.ts';
import { expectedTip } from './integrate.ts';
import { assertHumanDecision } from './policy.ts';
import { policyAt } from './plan.ts';
import { defaultGateHarness } from './project-policy.ts';
import { createWorkspace } from './workspace.ts';

export { requiredChecks };

/**
 * Campaign gates (§3.1–3.3): what every ticket of a campaign is judged by, registered on the
 * campaign mission, baselined once at the campaign base, frozen by one human `campaign lock`,
 * and run on each candidate's integrated tree.
 *
 * Roles: `regression` (the plan's project gates: must pass at base and on every integration),
 * `gate` bound to a ticket (its public acceptance tests at the plan commit: must fail at base),
 * `holdout` bound or not (a person registers it from a host file; never in the plan, which
 * authors read), and `acceptance` (tests a writer-authored ticket's author wrote: run and
 * recorded on its own integration, never locked, never shown to another author). A binding
 * lives in the experiment's subject (`ticket:<id>`) and is frozen by the lock's digest.
 */

export type CampaignGateRole = 'regression' | 'gate' | 'holdout';

/** A campaign experiment's subject: its binding, or what it was registered for. */
export const ticketSubject = (ticketId: string): string => `ticket:${ticketId}`;
export const regressionSubject = (gateId: string): string => `regression:${gateId}`;
export const acceptanceSubject = (candidateId: string): string => `acceptance:${candidateId}`;
export const UNBOUND_SUBJECT = 'campaign';

function requireCampaign(ctx: GateContext, campaignId: string): Mission {
  const m = ctx.store.mission(campaignId);
  if (!m || m.kind !== 'campaign') throw new GateRefused(`${campaignId} is not a campaign`);
  return m;
}

const emit = (ctx: GateContext, m: Pick<Mission, 'id' | 'projectId'>, category: 'experiment' | 'approval', name: string, payload: Record<string, unknown>) =>
  ctx.events?.append({ projectId: m.projectId, missionId: m.id, actorId: 'daylight', category, name, payload });

// ---- registration -------------------------------------------------------------------------------

export interface RegisterCampaignGateInput {
  campaignId: string;
  role: CampaignGateRole;
  /** The ticket it is bound to; null for a regression gate or an unbound holdout. */
  ticketId: string | null;
  testSource: string;
  basename: string;
  prediction: ExpectedObservation;
  harness?: GateHarness;
  crate?: string;
  /** Overrides the subject the binding gives: a regression gate's plan id. */
  subject?: string;
}

/** One campaign gate, through R2's `registerGate`. A holdout's path never appears in an event. */
export function registerCampaignGate(ctx: GateContext, input: RegisterCampaignGateInput): Experiment {
  const m = requireCampaign(ctx, input.campaignId);
  if (input.role === 'regression' && input.ticketId !== null) throw new GateRefused('a regression gate applies to every ticket; it is bound to none');
  if (input.role === 'gate' && input.ticketId === null) throw new GateRefused('a campaign gate is bound to its ticket');
  if (input.ticketId !== null && !/^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$/.test(input.ticketId)) throw new GateRefused(`${input.ticketId} is not a ticket id`);
  return registerGate(ctx, {
    missionId: m.id, role: input.role, testSource: input.testSource, basename: input.basename, prediction: input.prediction,
    harness: input.harness, ...(input.crate !== undefined ? { crate: input.crate } : {}),
    subject: input.subject ?? (input.ticketId !== null ? ticketSubject(input.ticketId) : UNBOUND_SUBJECT),
  });
}

/** `path` at `commit` of `repo`, read from git objects: the plan's tests, never the working tree. */
export function blobAt(repo: string, commit: string, rel: string): Buffer {
  return gitIn({ repo }, ['cat-file', 'blob', `${commit}:${rel}`]);
}

/**
 * `campaign baseline`, first half: register the plan's regression gates and every `gate`
 * ticket's tests, read at the plan commit (the campaign's base), idempotently. A test already
 * registered with the same subject, bytes and expectation is not registered again.
 */
export function registerPlanGates(ctx: GateContext, campaignId: string, plan: PlanFileV1, o: { defaultHarness?: GateHarness } = {}): Experiment[] {
  const m = requireCampaign(ctx, campaignId);
  const have = ctx.store.experimentsFor(m.id);
  const out: Experiment[] = [];
  // The policy at the plan commit, as validation read it; only when a test names no harness.
  let defaultHarness: GateHarness | undefined;
  const one = (role: 'regression' | 'gate', subject: string, ticketId: string | null,
    t: { path: string; harness?: GateHarness; crate?: string; expect: ExpectedObservation }) => {
    const source = blobAt(ctx.repoRoot, m.baseRevision, t.path).toString('utf8');
    const harness = t.harness ?? (defaultHarness ??= o.defaultHarness ?? defaultGateHarness(policyAt(ctx.repoRoot, m.baseRevision)));
    const found = have.find((x) => x.subject === subject && x.role === role && x.testArtifact.digest === digestOf(source)
      && (x.harness ?? 'node') === harness && JSON.stringify(x.prediction) === JSON.stringify(t.expect));
    if (found) {
      out.push(found);
      return;
    }
    out.push(registerCampaignGate(ctx, {
      campaignId: m.id, role, ticketId, testSource: source, basename: path.posix.basename(t.path), prediction: t.expect, harness,
      ...(t.crate !== undefined ? { crate: t.crate } : {}), subject,
    }));
  };
  for (const g of plan.campaignGates) one('regression', regressionSubject(g.id), null, g);
  for (const t of plan.tickets) {
    const acceptance = t.acceptance ?? plan.defaults?.acceptance;
    if (acceptance?.kind !== 'gate') continue;
    for (const test of acceptance.tests) one('gate', ticketSubject(t.id), t.id, test);
  }
  return out;
}

const LOCKABLE = (x: Experiment) => x.role === 'regression' || x.role === 'gate' || x.role === 'holdout';

/** `campaign baseline`, second half: every regression gate, gate and holdout on the campaign base, N ≥ 2. */
export async function baselineCampaign(ctx: GateContext, campaignId: string, o: { experimentIds?: readonly string[] } = {}): Promise<GateEvaluation[]> {
  const m = requireCampaign(ctx, campaignId);
  const all = ctx.store.experimentsFor(m.id).filter(LOCKABLE);
  const gates = o.experimentIds ? all.filter((x) => o.experimentIds!.includes(x.id)) : all;
  const out: GateEvaluation[] = [];
  for (const x of gates) {
    const r = await runGate(x, {
      ...runContext(ctx, x, 'base'), ...(x.role === 'holdout' ? { events: undefined } : {}),
      target: { kind: 'base', diffDigest: null }, materialise: () => createWorkspace(ctx.repoRoot, x.baseRevision),
    });
    out.push(record(ctx, m, x, r, { target: 'base', revision: x.baseRevision }));
  }
  return out;
}

function baselineOf(ctx: GateContext, m: Mission, x: Experiment): GateEvaluation | undefined {
  return ctx.store.gateEvaluations({ missionId: m.id, target: 'base' }).filter((g) => g.experimentId === x.id && g.harnessDigest === x.harnessDigest).at(-1);
}

/** `campaign gate list`, a person's view: each gate with its role, binding and baseline; a holdout's path withheld. */
export function listCampaignGates(ctx: Pick<GateContext, 'store'>, campaignId: string) {
  const m = ctx.store.mission(campaignId);
  if (!m || m.kind !== 'campaign') throw new GateRefused(`${campaignId} is not a campaign`);
  const lock = campaignLockOf(ctx, campaignId);
  return {
    campaignId, lock: lock?.scope ?? null,
    gates: ctx.store.experimentsFor(m.id).filter(LOCKABLE).map((x) => ({
      experimentId: x.id, role: x.role, ticketId: x.role === 'holdout' ? null : x.subject.startsWith('ticket:') ? x.subject.slice('ticket:'.length) : null,
      testPath: x.role === 'holdout' ? null : x.testArtifact.path ?? '', harness: x.harness ?? 'node', harnessDigest: x.harnessDigest,
      baseline: baselineOf({ store: ctx.store } as GateContext, m, x)?.conclusion ?? null, lockedBy: x.lockedBy ?? null,
    })),
  };
}

// ---- the lock --------------------------------------------------------------------------------

export interface CampaignLockInput {
  campaignId: string;
  actor: string;
  rationale: string;
  /** Required, no default: a person says whether passing gates become required for later tickets (P2-R17). */
  ratchet: boolean;
  acceptVacuous?: string[];
  confirm: string | undefined;
  /** Defaults to every regression gate, gate and holdout of the campaign. */
  experimentIds?: string[];
  env?: Readonly<Record<string, string | undefined>>;
}

/** The ids `campaign lock` names by default: every lockable experiment of the campaign. */
export function lockableIds(ctx: Pick<GateContext, 'store'>, campaignId: string): string[] {
  return ctx.store.experimentsFor(campaignId).filter(LOCKABLE).map((x) => x.id);
}

/**
 * `campaign lock` (§3.1): the R13 guard against the campaign gate-set digest, then each gate's
 * baseline — a regression gate must pass at the campaign base ("the project gate fails at
 * base"), a gate or holdout must fail there or be accepted as vacuous by name — then the
 * store's one transaction. A new lock invalidates the campaign's authorization, which names it.
 */
export function lockCampaign(ctx: GateContext, input: CampaignLockInput): Decision {
  const m = requireCampaign(ctx, input.campaignId);
  const ids = input.experimentIds ?? lockableIds(ctx, m.id);
  if (!ids.length) throw new GateRefused(`campaign ${m.id} has no gate to lock; run \`daylight campaign baseline\` first`);
  if (typeof input.ratchet !== 'boolean') throw new GateRefused('--ratchet or --no-ratchet is required and has no default');
  const preview = confirmDigest(ctx, 'lock-campaign-gates', m.id, { experimentIds: ids, ratchet: input.ratchet, acceptVacuous: input.acceptVacuous ?? [] });
  assertHumanDecision(input.env ?? ctx.env ?? process.env, input.actor, input.confirm, preview.digest);
  const gates = ids.map((id) => ctx.store.experiment(id)!);
  const vacuous = [...new Set(input.acceptVacuous ?? [])];
  const refusals: string[] = [];
  for (const id of vacuous) if (!ids.includes(id)) refusals.push(`${id}: accepted as vacuous but not in the set being locked`);
  for (const x of gates) {
    const who = x.role === 'holdout' ? 'a holdout' : `${x.role} ${x.id}`;
    const holds = harnessHolds(x, ctx.artifacts);
    if (!holds.ok || holds.legacy) {
      refusals.push(`${who}: ${holds.ok ? 'its expectation names no test path, role or base' : holds.why}`);
      continue;
    }
    const b = baselineOf(ctx, m, x);
    if (!b) refusals.push(`${who}: no baseline at its harness; run \`daylight campaign baseline\` first`);
    else if (x.role === 'regression') {
      if (b.conclusion !== 'supported') refusals.push(`${who}: the project gate fails at base (${b.conclusion}); a regression gate must pass there`);
    } else if (b.conclusion === 'supported') {
      if (!vacuous.includes(x.id)) refusals.push(`${who}: passes on the base, so passing it says nothing; fix the test or accept it with --accept-vacuous`);
    } else if (b.conclusion !== 'falsified') refusals.push(`${who}: baseline is ${b.conclusion}; only a gate that fails on the base can be locked`);
    else if (vacuous.includes(x.id)) refusals.push(`${who}: fails on the base, so it is not vacuous; drop it from --accept-vacuous`);
  }
  if (refusals.length) throw new GateRefused(`campaign lock refused:\n  ${refusals.join('\n  ')}`);
  let locked: ReturnType<GateContext['store']['lockCampaignGates']>;
  try {
    locked = ctx.store.lockCampaignGates(m.id, {
      experimentIds: ids, ratchet: input.ratchet, expectedGateSetDigest: preview.digest, actor: input.actor, rationale: input.rationale,
      vacuousOverrides: vacuous,
    });
  } catch (err) {
    if (err instanceof GateSetMoved) throw new GateRefused(`campaign lock refused: ${err.message}`);
    throw err;
  }
  const count = (role: string) => gates.filter((x) => x.role === role).length;
  emit(ctx, m, 'approval', 'campaign.gates.locked', {
    decisionId: locked.decision.id, gateSetDigest: locked.gateSetDigest, regression: count('regression'), gates: count('gate'),
    holdouts: count('holdout'), ratchet: input.ratchet,
  });
  return locked.decision;
}

/** A decision's scope read as a campaign lock; a row without that shape is refused, not trusted. */
export function campaignLockScopeOf(d: Decision): CampaignLockScope {
  const s = d.scope;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (s.operation !== 'lock-campaign-gates' || !strings(s.experimentIds) || !strings(s.vacuousOverrides) || typeof s.gateSetDigest !== 'string'
    || typeof s.ratchet !== 'boolean' || !record(s.harnessDigests) || !record(s.bindings) || !record(s.roles)) {
    throw new GateRefused(`decision ${d.id} is not a well-formed lock-campaign-gates decision`);
  }
  return s as unknown as CampaignLockScope;
}

export function campaignLockOf(ctx: Pick<GateContext, 'store'>, campaignId: string): { decisionId: string; scope: CampaignLockScope } | null {
  const d = ctx.store.campaignLockDecision(campaignId);
  return d ? { decisionId: d.id, scope: campaignLockScopeOf(d) } : null;
}

/** Why the campaign lock is not current, recomputed against the experiments as they are now, or null (§4.1). */
export function campaignLockRefusal(ctx: Pick<GateContext, 'store'>, campaignId: string, expected?: string): string | null {
  const lock = campaignLockOf(ctx, campaignId);
  if (!lock) return `campaign ${campaignId} has no gate lock; a person runs \`daylight campaign lock\``;
  try {
    const now = ctx.store.campaignGateSet(campaignId, lock.scope.experimentIds, lock.scope.ratchet).gateSetDigest;
    if (now !== lock.scope.gateSetDigest) return `campaign ${campaignId}'s gate lock is stale: a locked gate changed after it was locked`;
  } catch (err) {
    return `campaign ${campaignId}'s gate lock cannot be recomputed: ${(err as Error).message}`;
  }
  if (expected !== undefined && expected !== lock.scope.gateSetDigest) {
    return `the authorization names gate set ${expected}, not the current lock ${lock.scope.gateSetDigest}`;
  }
  return null;
}

/** The repo paths a workspace must not hold: the locked holdouts', so an author never reads one. */
export function holdoutPaths(ctx: Pick<GateContext, 'store'>, campaignId: string): string[] {
  const lock = campaignLockOf(ctx, campaignId);
  return (lock?.scope.experimentIds ?? []).map((id) => ctx.store.experiment(id)).filter((x) => x?.role === 'holdout')
    .map((x) => x!.testArtifact.path).filter((p): p is string => !!p);
}

// ---- acceptance ------------------------------------------------------------------------------

type TicketGates = Pick<CampaignTicket, 'ticketId' | 'acceptance'>;

const underAny = (p: string, prefixes: readonly string[]) => prefixes.some((q) => p === q || p.startsWith(q.endsWith('/') ? q : `${q}/`));

/**
 * `acceptance` experiments for a writer-authored ticket's candidate (§3.3): one per added or
 * modified file of the candidate under the ticket's `testPaths`, its bytes read from the
 * integrated commit. Idempotent per candidate and path. Never locked.
 */
export function registerAcceptance(ctx: GateContext, integrationId: string, ticket: TicketGates): Experiment[] {
  const i = ctx.store.integration(integrationId);
  if (!i || !i.integratedCommit) throw new GateRefused(`integration ${integrationId} has no integrated commit`);
  if (ticket.acceptance.kind !== 'writer-authored') return [];
  const a = ticket.acceptance;
  const c = ctx.store.candidate(i.candidateId)!;
  const subject = acceptanceSubject(c.id);
  const have = ctx.store.experimentsFor(i.campaignId, 'acceptance').filter((x) => x.subject === subject);
  const out: Experiment[] = [];
  for (const f of c.files.filter((x) => x.change !== 'deleted' && underAny(x.path, a.testPaths))) {
    if (a.harness === 'cargo' && !/(^|\/)tests\/[A-Za-z0-9_-]+\.rs$/.test(f.path)) continue;
    const found = have.find((x) => x.hypothesis.endsWith(` ${f.path}`));
    if (found) {
      out.push(found);
      continue;
    }
    const source = blobAt(ctx.repoRoot, i.integratedCommit, f.path).toString('utf8');
    out.push(registerGate(ctx, {
      missionId: i.campaignId, role: 'acceptance', testSource: source, basename: path.posix.basename(f.path), prediction: a.expect,
      harness: a.harness ?? 'node', ...(a.crate !== undefined ? { crate: a.crate } : {}), subject,
      hypothesis: `the author's own acceptance test passes on the integrated tree (weak evidence): ${f.path}`,
    }));
  }
  return out;
}

// ---- evaluation on the integrated tree ---------------------------------------------------------

/** The landing whose commit is `onto`, if any: what the ratchet reads. */
function landingAt(ctx: Pick<GateContext, 'store'>, campaignId: string, commit: string): Integration | undefined {
  return ctx.store.integrations(campaignId, { state: 'integrated' }).find((x) => x.integratedCommit === commit);
}

/**
 * Run what the verdict needs on the integration's tree (§3.2): the ticket's required checks,
 * every locked gate and holdout when the lock ratchets (so the next landing knows what passed),
 * and the candidate's acceptance tests. Each run gets a fresh tree of the integrated commit
 * with the holdouts' paths refused, and is recorded as an `integrated` evaluation. Then the
 * acceptance tests once more on `onto` alone: passing there makes them vacuous, which is
 * recorded on the integration and never read by the verdict.
 */
export async function evaluateIntegrated(ctx: GateContext, integrationId: string, ticket: TicketGates): Promise<GateEvaluation[]> {
  const i = ctx.store.integration(integrationId);
  if (!i || i.state !== 'evaluating' || !i.integratedCommit || !i.integratedDiffDigest) {
    throw new GateRefused(`integration ${integrationId} has no integrated commit to evaluate`);
  }
  const campaign = requireCampaign(ctx, i.campaignId);
  const lock = campaignLockOf(ctx, campaign.id);
  const ids = !lock ? [] : lock.scope.ratchet ? [...lock.scope.experimentIds].sort() : requiredChecks(lock.scope, ticket.ticketId);
  const hidden = holdoutPaths(ctx, campaign.id);
  const acceptance = registerAcceptance(ctx, i.id, ticket);
  const commit = i.integratedCommit;
  const digest = i.integratedDiffDigest;
  const cache = gateCacheKey(digest);
  if (ctx.out) removeGateCache(ctx.out, cache);
  const out: GateEvaluation[] = [];
  try {
    const run = async (x: Experiment, on: string) => runGate(x, {
      ...runContext(ctx, x, cache), ...(x.role === 'holdout' ? { events: undefined } : {}),
      target: { kind: 'integrated', diffDigest: digest }, materialise: () => createWorkspace(ctx.repoRoot, on, { hidden }),
    });
    for (const id of ids) {
      const x = ctx.store.experiment(id);
      if (!x || x.harnessDigest !== lock!.scope.harnessDigests[id]) continue;
      out.push(recordIntegrated(ctx, campaign, x, await run(x, commit), { id: i.id, candidateId: i.candidateId, integratedCommit: commit, integratedDiffDigest: digest }));
    }
    let vacuous = false;
    for (const x of acceptance) {
      out.push(recordIntegrated(ctx, campaign, x, await run(x, commit), { id: i.id, candidateId: i.candidateId, integratedCommit: commit, integratedDiffDigest: digest }));
      if ((await run(x, i.onto)).conclusion === 'supported') vacuous = true;
    }
    if (acceptance.length) ctx.store.updateIntegration(i.id, 'evaluating', { acceptanceVacuous: vacuous });
  } finally {
    if (ctx.out) removeGateCache(ctx.out, cache);
  }
  return out;
}

/** The rows `campaignVerdict` reads for one integration. Nothing else reaches it. */
export function campaignVerdictRows(ctx: Pick<GateContext, 'store'>, integrationId: string, ticket: TicketGates): CampaignVerdictRows {
  const i = ctx.store.integration(integrationId);
  if (!i) throw new GateRefused(`unknown integration ${integrationId}`);
  const c = ctx.store.candidate(i.candidateId)!;
  const lock = campaignLockOf(ctx, i.campaignId);
  const evals = ctx.store.gateEvaluations({ integrationId: i.id, target: 'integrated' });
  const prior = landingAt(ctx, i.campaignId, i.onto);
  const acceptance = ctx.store.experimentsFor(i.campaignId, 'acceptance').filter((x) => x.subject === acceptanceSubject(c.id));
  return {
    candidate: {
      id: c.id, files: c.files, policyViolations: c.policyViolations, secretHits: c.secretHits, gateSetDigest: c.gateSetDigest,
      diffDigest: c.diffArtifact.digest,
    },
    ticketId: ticket.ticketId,
    writerAuthored: ticket.acceptance.kind === 'writer-authored',
    integration: { id: i.id, state: i.state, onto: i.onto, integratedCommit: i.integratedCommit, integratedDiffDigest: i.integratedDiffDigest, conflictPaths: i.conflictPaths },
    lock,
    locked: (lock?.scope.experimentIds ?? []).map((id) => ctx.store.experiment(id)).filter((x): x is Experiment => !!x),
    baseline: ctx.store.gateEvaluations({ missionId: i.campaignId, target: 'base' }),
    evaluations: evals,
    ontoEvaluations: prior ? ctx.store.gateEvaluations({ integrationId: prior.id, target: 'integrated' }) : [],
    acceptance: acceptance.map((x) => ({ experimentId: x.id, conclusion: evals.filter((e) => e.experimentId === x.id).at(-1)?.conclusion ?? null })),
  };
}

export { campaignVerdict };

// ---- the author's brief ----------------------------------------------------------------------

export interface CampaignBrief {
  missionId: string;
  gateSetDigest: string;
  gates: AuthorBriefGate[];
  /** For a writer-authored ticket: where its own tests go and how they run. */
  writerAuthored?: { testPaths: string[]; harness: GateHarness; crate?: string };
}

/**
 * What a campaign author is shown (H12): the public regression gates, the gates bound to its
 * ticket, and, when the lock ratchets, the public gates that passed at the latest landing.
 * Never a holdout, nor how many there are; never another author's acceptance tests.
 */
export function campaignAuthorBrief(ctx: GateContext, missionId: string, ticket: TicketGates): CampaignBrief {
  const m = ctx.store.mission(missionId);
  const campaignId = m?.parentId;
  if (!m || !campaignId) throw new GateRefused(`mission ${missionId} is not a campaign ticket mission`);
  const lock = campaignLockOf(ctx, campaignId);
  if (!lock) throw new GateRefused(`campaign ${campaignId} has no gate lock; an author is briefed on locked gates only`);
  const ids = new Set(requiredChecks(lock.scope, ticket.ticketId));
  if (lock.scope.ratchet) {
    const last = landingAt(ctx, campaignId, expectedTip(ctx.store, campaignId));
    for (const e of last ? ctx.store.gateEvaluations({ integrationId: last.id, target: 'integrated' }) : []) {
      if (e.conclusion === 'supported' && lock.scope.experimentIds.includes(e.experimentId)) ids.add(e.experimentId);
    }
  }
  const gates = [...ids].sort().map((id) => ctx.store.experiment(id)).filter((x): x is Experiment => !!x && x.role !== 'holdout')
    .map((x) => ({
      experimentId: x.id, testPath: x.testArtifact.path ?? '', testSource: ctx.artifacts.text(x.testArtifact),
      command: x.harness === 'cargo' ? x.command.map((a) => (a === cargoTargetOf(x.id) ? '<the gate\'s registered test>' : a)) : x.command,
      prediction: x.prediction,
    }));
  const a = ticket.acceptance;
  return {
    missionId: m.id, gateSetDigest: lock.scope.gateSetDigest, gates,
    ...(a.kind === 'writer-authored' ? { writerAuthored: { testPaths: a.testPaths, harness: a.harness ?? 'node', ...(a.crate !== undefined ? { crate: a.crate } : {}) } } : {}),
  };
}

/** The verdict of one integration, from its rows, recorded on the candidate. */
export function concludeVerdict(ctx: GateContext, integrationId: string, ticket: TicketGates) {
  const i = ctx.store.integration(integrationId)!;
  const v = campaignVerdict(campaignVerdictRows(ctx, integrationId, ticket));
  const c = ctx.store.updateCandidateVerdict(i.candidateId, v.verdict, v.reasons);
  ctx.events?.append({
    projectId: i.projectId, missionId: i.missionId, actorId: 'daylight', category: 'experiment', name: 'forge.candidate.verdict',
    payload: { candidateId: c.id, verdict: v.verdict, reasons: v.reasons, gateSetDigest: c.gateSetDigest, integrationId: i.id },
  });
  return { candidate: c, ...v };
}
