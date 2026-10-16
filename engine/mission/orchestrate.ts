import fs from 'node:fs';
import path from 'node:path';
import {
  registerExperiment, runExperiment, type RegisterInput,
} from '../experiment/runner.ts';
import type { RunEvent } from '../replay/types.ts';
import {
  ADAPTERS, mcpConfig, parseSpec, specKey, sourceDiversity,
  type Adapter, type AgentSpec,
} from '../swarm/adapters.ts';
import { captureRun } from '../swarm/capture.ts';
import { serverCommand, SYSTEM_RULES } from '../swarm/driver.ts';
import { available } from '../swarm/adapters.ts';
import type { Belief, ClaimStatus } from '../store/types.ts';
import type { DaylightContext } from './context.ts';
import { requireMappedRepo } from './context.ts';
import {
  compare, MISSION_CLAIM_FILTER, missionClaims, type Comparison, type Dispute, type DisputeSide,
} from './disputes.ts';
import { currentRevision } from './project.ts';
import type {
  ArtifactRef, Attempt, DaylightEvent, Decision, Experiment, ExpectedObservation, Mission,
  MissionKind, MissionOutcome, Task,
} from './types.ts';

/**
 * The mission loop, as far as P0 takes it: independent reviews → compare → experiment →
 * a person decides.
 *
 * Nothing here closes a mission. Reviews finishing moves a task, comparison finishing moves
 * a task, and a mission with every task done is a mission *waiting for someone* — which is
 * the state the whole product exists to produce, not a state to be tidied away as success.
 * The only transitions this file makes on its own are into `running` and into `blocked`,
 * and `blocked` always carries a reason a person can act on.
 */

const DEFAULT_TIMEOUT_MS = 300_000;
const slug = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '-');

// ---- creation --------------------------------------------------------------------

export interface CreateMissionOptions {
  repo: string;
  kind: MissionKind;
  objective: string;
  scope?: { paths?: string[]; symbols?: string[]; claimIds?: number[] };
  maxCost?: number;
}

/**
 * A mission is created `ready`, not `draft`: in P0 the objective, scope and revision are
 * all there is to configure, and they are all required arguments. `execute` is granted to
 * explore and verify missions because the experiment step is the point of both; `write`
 * and `deploy` are never granted here — nothing in P0 authors code.
 */
export function createMission(ctx: DaylightContext, opts: CreateMissionOptions): Mission {
  const { root, project } = requireMappedRepo(ctx.out, opts.repo);
  if (!opts.objective.trim()) throw new Error('a mission needs an objective');
  ctx.store.ensureProject(project);
  const revision = currentRevision(root);
  let mission = ctx.store.createMission({
    projectId: project.id,
    kind: opts.kind,
    objective: opts.objective.trim(),
    baseRevision: revision.label,
    scope: opts.scope ?? {},
    permissions: {
      read: true, write: false, deploy: false,
      execute: opts.kind === 'explore' || opts.kind === 'verify',
    },
    budget: opts.maxCost ? { maxUsd: opts.maxCost } : {},
  });
  lifecycle(ctx, mission, 'mission.created', {
    kind: mission.kind, objective: mission.objective, scope: mission.scope,
    baseRevision: mission.baseRevision, dirty: revision.dirty, permissions: mission.permissions,
  });
  mission = ctx.store.transitionMission(mission.id, 'ready');
  lifecycle(ctx, mission, 'mission.ready', {});
  return mission;
}

function lifecycle(
  ctx: DaylightContext, mission: Mission, name: string, payload: Record<string, unknown>,
  extra: { taskId?: string; attemptId?: string; artifactIds?: string[] } = {},
): DaylightEvent {
  return ctx.events.append({
    projectId: mission.projectId,
    missionId: mission.id,
    taskId: extra.taskId,
    attemptId: extra.attemptId,
    actorId: 'daylight',
    category: 'lifecycle',
    name,
    artifactIds: extra.artifactIds,
    payload: { state: mission.state, ...payload },
  });
}

// ---- roster ----------------------------------------------------------------------

/**
 * A reviewer that is only ever a test double.
 *
 * `VDS_MOCK_ADAPTER` names a script; a roster entry `mock:<model>` runs it with our node,
 * handing it the MCP config path and the prompt. It is registered as `mock` everywhere it
 * leaves a trace — claims, attempts, events — so nothing it produces can be mistaken for a
 * model's. Without the variable, `mock` is simply not an adapter.
 */
export function mockAdapter(): Adapter | null {
  const script = process.env.VDS_MOCK_ADAPTER;
  if (!script || !fs.existsSync(script)) return null;
  return {
    name: 'mock',
    bin: process.execPath,
    perInvocationMcp: true,
    argv: (run) => [script, run.mcpConfigPath, run.prompt],
  };
}

export function adapterFor(tool: string): Adapter | null {
  if (tool === 'mock') return mockAdapter();
  return ADAPTERS[tool] ?? null;
}

export interface RosterPlan {
  runnable: Array<{ spec: AgentSpec; adapter: Adapter }>;
  unavailable: string[];
}

export function planMissionRoster(tools: string[], model?: string): RosterPlan {
  const runnable: RosterPlan['runnable'] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  for (const spec of tools.map((t) => parseSpec(t, model))) {
    const adapter = adapterFor(spec.tool);
    const key = specKey(spec);
    if (!adapter) {
      unavailable.push(`${spec.tool} (no adapter)`);
      continue;
    }
    if (adapter.name !== 'mock' && !available(adapter)) {
      unavailable.push(`${key} (not installed)`);
      continue;
    }
    if (seen.has(key)) {
      unavailable.push(`${key} (duplicate roster entry — same source, would corroborate nothing)`);
      continue;
    }
    seen.add(key);
    runnable.push({ spec, adapter });
  }
  return { runnable, unavailable };
}

// ---- the prompt ------------------------------------------------------------------

/**
 * What every reviewer is asked. Identical across the roster, and silent about what any
 * other reviewer concluded — that silence is enforced server-side by the blind prefix, but
 * the prompt must not undo it by quoting anyone.
 */
export function buildReviewPrompt(mission: Mission): string {
  const subjects = [...(mission.scope.paths ?? []), ...(mission.scope.symbols ?? [])];
  const lines = [
    SYSTEM_RULES,
    '',
    'Your assigned question:',
    '',
    ...mission.objective.split('\n').map((l) => `  ${l}`),
    '',
  ];
  if (subjects.length) {
    lines.push('Subjects in scope — answer about these and nothing else:', '');
    for (const s of subjects) lines.push(`  ${s}`);
    lines.push('');
  }
  lines.push(
    'Start with get_overview, then get_slice for each subject in scope with hops 1, and read ' +
      'the cited files with your own tools. Submit a claim for each thing you can evidence, ' +
      'and stop when you have answered the question as asked.',
  );
  return lines.join('\n');
}

// ---- running ---------------------------------------------------------------------

export interface RunMissionOptions {
  missionId: string;
  repo: string;
  tools: string[];
  model?: string;
  maxCost?: number;
  /** Lets `maxCost` exceed the budget recorded on the mission. Without it that is refused. */
  raiseBudget?: boolean;
  dryRun?: boolean;
  timeoutMs?: number;
  concurrency?: number;
  /** Fired on every state change, for a live meter. */
  onProgress?: (mission: Mission, note: string) => void;
  /** Redacted console chunks from the running agent, for a live console. */
  onChunk?: (attemptId: string, stream: 'stdout' | 'stderr', text: string) => void;
}

export interface ReviewPlan {
  spec: AgentSpec;
  taskId: string;
  prompt: string;
  mcpConfigPath: string;
}

export interface RunMissionReport {
  mission: Mission;
  plans: ReviewPlan[];
  attempts: Attempt[];
  unavailable: string[];
  sourceDiversity: number;
  comparison?: Comparison;
  notes: string[];
  spent: number;
  costKnown: boolean;
}

/**
 * The claim one process holds on running a mission: `<out>/mission-run.<id>.pid`.
 *
 * While it is held by a live process, a second run is refused rather than stacked on the
 * first. When it names a process that is gone — or is absent — whatever attempts the
 * mission still marks `running` have no owner, and the run that takes the claim cancels them
 * before it starts anything. Released on return and on process exit; a SIGKILL leaves the
 * file, which names a dead pid and so is taken over.
 */
function takeRunClaim(out: string, missionId: string): () => void {
  const file = path.join(out, `mission-run.${missionId}.pid`);
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = Number(fs.readFileSync(file, 'utf8').trim());
    if (holder !== process.pid && processAlive(holder)) {
      throw new Error(`mission ${missionId} is already being run by process ${holder}`);
    }
    fs.rmSync(file, { force: true });
  }
  throw new Error(`could not claim mission ${missionId} for this run`);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Review tasks already on the mission, by the source they are pinned to. */
function reviewTasksBySource(tasks: Task[]): Map<string, Task> {
  const out = new Map<string, Task>();
  for (const t of tasks) if (t.role === 'review' && t.runnerHint) out.set(t.runnerHint, t);
  return out;
}

export async function runMission(ctx: DaylightContext, opts: RunMissionOptions): Promise<RunMissionReport> {
  const found = ctx.store.mission(opts.missionId);
  if (!found) throw new Error(`unknown mission ${opts.missionId}`);
  let mission: Mission = found;
  if (mission.state === 'closed') {
    throw new Error(`mission ${mission.id} is closed (${mission.outcome}); it cannot be run again`);
  }
  if (mission.state === 'draft') throw new Error(`mission ${mission.id} is still a draft`);
  const budget = mission.budget.maxUsd;
  if (opts.maxCost !== undefined && budget !== undefined && opts.maxCost > budget && !opts.raiseBudget) {
    throw new Error(
      `--max-cost $${opts.maxCost} is above mission ${mission.id}'s budget of $${budget}; ` +
        'pass --raise-budget to spend past what the mission was created with',
    );
  }
  const { root, project } = requireMappedRepo(ctx.out, opts.repo);
  if (project.id !== mission.projectId) {
    throw new Error(
      `mission ${mission.id} belongs to project ${mission.projectId}; ${root} is ${project.id}`,
    );
  }
  const notes: string[] = [];
  const { runnable, unavailable } = planMissionRoster(opts.tools, opts.model);
  const diversity = sourceDiversity(runnable.map((r) => r.spec));
  if (runnable.length && diversity < 2) {
    notes.push(
      `roster has ${diversity} independent source; nothing it claims can be corroborated and ` +
        'no disagreement can be discovered',
    );
  }

  // Tasks are durable: a second run re-uses the review task for a source it has seen, so a
  // retry is a new attempt on the same task rather than a new task with no history.
  const existing = reviewTasksBySource(ctx.store.tasks(mission.id));
  const plans: ReviewPlan[] = [];
  for (const { spec, adapter } of runnable) {
    const key = specKey(spec);
    let task = existing.get(key);
    if (!task) {
      task = ctx.store.createTask({
        missionId: mission.id,
        role: 'review',
        objective: `independent review by ${key}`,
        requiredOutputs: ['claim'],
        runnerHint: key,
      });
      lifecycle(ctx, mission, 'task.created', { role: 'review', runnerHint: key }, { taskId: task.id });
    }
    const cfgPath = path.join(ctx.out, `mcp.${slug(key)}.${mission.id}.json`);
    plans.push({ spec, taskId: task.id, prompt: buildReviewPrompt(mission), mcpConfigPath: cfgPath });
    void adapter;
  }
  const reviewTasks = ctx.store.tasks(mission.id).filter((t) => t.role === 'review');
  let compareTask = ctx.store.tasks(mission.id).find((t) => t.role === 'compare');
  if (!compareTask && reviewTasks.length) {
    compareTask = ctx.store.createTask({
      missionId: mission.id,
      role: 'compare',
      objective: 'compare the independent reviews; record disputes and unverified beliefs',
      dependsOn: reviewTasks.map((t) => t.id),
      requiredOutputs: ['report'],
    });
    lifecycle(ctx, mission, 'task.created', { role: 'compare' }, { taskId: compareTask.id });
  }

  const report = (comparison?: Comparison, spent = 0, costKnown = true): RunMissionReport => ({
    mission: ctx.store.mission(mission.id)!,
    plans,
    attempts: ctx.store.tasks(mission.id).flatMap((t) => ctx.store.attempts(t.id)),
    unavailable,
    sourceDiversity: diversity,
    comparison,
    notes,
    spent,
    costKnown,
  });

  if (opts.dryRun) {
    notes.push('dry run — nothing spawned, nothing leased');
    return report();
  }

  const block = (why: string) => {
    mission = ctx.store.transitionMission(mission.id, 'blocked', why);
    lifecycle(ctx, mission, 'mission.blocked', { why });
    opts.onProgress?.(mission, why);
  };

  // Attempts this process opened and has not finished. If the process is stopped — the shell
  // sends SIGTERM, which the adapter layer turns into an exit — they are recorded as
  // cancelled on the way out rather than left `running` for ever.
  const open = new Set<string>();
  const releaseClaim = takeRunClaim(ctx.out, mission.id);
  const onExit = () => {
    for (const id of open) {
      try {
        ctx.store.finishAttempt(id, { state: 'cancelled', costUsd: null, failure: 'interrupted: the run was stopped' });
      } catch {
        // Finished in the meantime.
      }
    }
    releaseClaim();
  };
  process.on('exit', onExit);
  const finish = <T>(value: T): T => {
    process.off('exit', onExit);
    releaseClaim();
    return value;
  };
  for (const orphan of ctx.store.cancelRunningAttempts(mission.id, 'orphaned: the process running it is gone')) {
    lifecycle(ctx, mission, 'attempt.orphaned', { failure: orphan.failure }, { taskId: orphan.taskId, attemptId: orphan.id });
  }

  if (!runnable.length) {
    // `blocked` is re-entered through `running` so the new reason replaces the old one and
    // the transition table stays the only path between states. A mission already running
    // (a finished review waiting on a person, or a crashed run) goes straight to blocked.
    if (mission.state !== 'running') {
      mission = ctx.store.transitionMission(mission.id, 'running');
      lifecycle(ctx, mission, 'mission.started', { roster: opts.tools });
    }
    block(`no runnable agent in roster: ${unavailable.join(', ') || opts.tools.join(', ')}`);
    return finish(report());
  }

  if (mission.state === 'ready' || mission.state === 'blocked') {
    mission = ctx.store.transitionMission(mission.id, 'running');
    lifecycle(ctx, mission, 'mission.started', {
      roster: runnable.map((r) => specKey(r.spec)), sourceDiversity: diversity,
    });
    opts.onProgress?.(mission, 'running');
  }

  // Tasks a previous run left failed are retried; done ones are not paid for twice.
  const todo = plans.filter((p) => {
    const t = ctx.store.task(p.taskId)!;
    if (t.state === 'failed') ctx.store.transitionTask(t.id, 'queued');
    return t.state !== 'done';
  });

  const cmd = serverCommand();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ceiling = opts.maxCost ?? mission.budget.maxUsd;
  // The budget is the mission's, so a run starts from what every earlier attempt recorded —
  // the ledger's figure, not an adapter's — and a null anywhere makes the total a floor.
  const recorded = ctx.store.tasks(mission.id).flatMap((t) => ctx.store.attempts(t.id));
  let spent = recorded.reduce((n, a) => n + (a.costUsd ?? 0), 0);
  let costKnown = recorded.every((a) => a.costUsd !== null);
  const failures: string[] = [];
  const queue = [...todo];
  const limit = Math.max(1, opts.concurrency ?? 1);

  const unknownCost: string[] = [];
  const launch = async (plan: ReviewPlan, share: number | undefined): Promise<void> => {
    const { spec } = plan;
    const adapter = adapterFor(spec.tool)!;
    const key = specKey(spec);
    const task = ctx.store.task(plan.taskId)!;
    const runnerId = `agent:${spec.tool}:${spec.model ?? 'default'}`;
    // The session is the correlation key for every MCP event this agent produces. It carries
    // the mission id first so the server can withhold the other reviewers' claims by prefix.
    const session = `${mission.id}:${task.id}:a${task.attemptIds.length + 1}`;
    const attempt = ctx.store.startAttempt({ taskId: task.id, runnerId, sessionId: session });
    open.add(attempt.id);
    lifecycle(ctx, mission, 'attempt.started', { runnerId, session }, { taskId: task.id, attemptId: attempt.id });
    opts.onProgress?.(ctx.store.mission(mission.id)!, `${key} started`);

    fs.writeFileSync(
      plan.mcpConfigPath,
      JSON.stringify(
        mcpConfig(cmd, ctx.out, spec.tool, spec.model, session, { VDS_BLIND_PREFIX: mission.id }),
        null, 2,
      ),
    );

    const result = await captureRun(
      adapter,
      {
        prompt: plan.prompt,
        cwd: root,
        mcpConfigPath: plan.mcpConfigPath,
        session,
        model: spec.model,
        timeoutMs,
        maxTurns: 40,
        maxCost: share,
      },
      {
        store: ctx.store,
        events: ctx.events,
        artifacts: ctx.artifacts,
        projectId: mission.projectId,
        missionId: mission.id,
        taskId: task.id,
        attemptId: attempt.id,
        runnerId,
        revision: mission.baseRevision,
        onChunk: opts.onChunk ? (s, t) => opts.onChunk!(attempt.id, s, t) : undefined,
      },
    );
    open.delete(attempt.id);
    const costUsd = ctx.store.attempt(attempt.id)?.costUsd ?? null;
    spent += costUsd ?? 0;
    if (costUsd === null) {
      costKnown = false;
      unknownCost.push(key);
    }
    ingestMcpEvents(ctx, mission.id);
    if (!result.ok) {
      const why = result.timedOut ? 'timed out' : result.overBudget ? 'over budget' : `exit ${result.exitCode}`;
      failures.push(`${key}: ${why}`);
    }
    opts.onProgress?.(ctx.store.mission(mission.id)!, `${key} ${result.ok ? 'finished' : 'failed'}`);
  };

  while (queue.length) {
    if (ceiling && spent >= ceiling) {
      const left = queue.map((p) => specKey(p.spec)).join(', ');
      failures.push(`budget exhausted before ${left}: spent $${spent.toFixed(2)} of $${ceiling.toFixed(2)}`);
      break;
    }
    // A ceiling only holds while spend is known. Once an agent in this run finished without
    // reporting a cost, the next wave could already be over it; a person reruns to go on.
    if (ceiling && unknownCost.length) {
      const left = queue.map((p) => specKey(p.spec)).join(', ');
      failures.push(
        `cost unknown for ${unknownCost.join(', ')}, so the $${ceiling.toFixed(2)} ceiling cannot be enforced; ` +
          `not launching ${left}`,
      );
      break;
    }
    // Every attempt in a wave starts at once; each gets its share of what is left, or each
    // would believe it had the whole remainder to itself.
    const wave = queue.splice(0, limit);
    const share = ceiling ? Math.max(0, ceiling - spent) / wave.length : undefined;
    await Promise.all(wave.map((p) => launch(p, share)));
  }

  if (failures.length) {
    block(failures.join('; '));
    return finish(report(undefined, spent, costKnown));
  }

  if (compareTask && ctx.store.task(compareTask.id)!.state !== 'done') {
    const comparison = runCompare(ctx, ctx.store.mission(mission.id)!, compareTask.id);
    opts.onProgress?.(ctx.store.mission(mission.id)!, `compared: ${comparison.disputes.length} dispute(s)`);
    return finish(report(comparison, spent, costKnown));
  }
  return finish(report(compare(ctx.claims, mission.scope, missionClaims(mission.id)), spent, costKnown));
}

/**
 * The compare task is a deterministic runner, not an agent: it reads the claim store and
 * writes down what disagrees. Zero cost, and known to be zero — which is a number, unlike a
 * provider's silence.
 */
export function runCompare(ctx: DaylightContext, mission: Mission, taskId: string): Comparison {
  const attempt = ctx.store.startAttempt({ taskId, runnerId: 'static:vds' });
  const comparison = compare(ctx.claims, mission.scope, missionClaims(mission.id));
  const meta = { projectId: mission.projectId, revision: mission.baseRevision };
  const artifacts: ArtifactRef[] = [];
  const base = { taskId, attemptId: attempt.id };

  for (const d of comparison.disputes) {
    const ref = ctx.artifacts.put(JSON.stringify(disputeRecord(d), null, 2), {
      ...meta, kind: 'report', label: `dispute: ${d.subject} ${d.predicate}`, mediaType: 'application/json',
    });
    artifacts.push(ref);
    ctx.events.append({
      projectId: mission.projectId, missionId: mission.id, ...base, actorId: 'static:vds',
      category: 'claim', name: 'claim.disputed', artifactIds: [ref.id],
      payload: {
        subject: d.subject, predicate: d.predicate, sameEvidence: d.sameEvidence,
        sides: d.sides.map((s) => ({ source: s.source, value: s.value, confidence: s.confidence, claimId: s.claimId })),
      },
    });
  }
  for (const b of comparison.unverified) {
    ctx.events.append({
      projectId: mission.projectId, missionId: mission.id, ...base, actorId: 'static:vds',
      category: 'claim', name: 'claim.unverified',
      payload: {
        subject: b.subject, predicate: b.predicate, confidence: b.confidence,
        source: b.claims[0] ? `${b.claims[0].source.kind}:${b.claims[0].source.tool ?? ''}:${b.claims[0].source.model ?? ''}` : null,
      },
    });
  }
  const summary = ctx.artifacts.put(JSON.stringify({
    missionId: mission.id, scope: mission.scope, claims: MISSION_CLAIM_FILTER,
    disputes: comparison.disputes.map(disputeRecord),
    unverified: comparison.unverified.map(beliefRecord),
    settled: comparison.settled.map(beliefRecord),
  }, null, 2), { ...meta, kind: 'report', label: 'comparison', mediaType: 'application/json' });
  artifacts.push(summary);

  ctx.store.finishAttempt(attempt.id, { state: 'completed', exitCode: 0, costUsd: 0, artifacts });
  lifecycle(ctx, ctx.store.mission(mission.id)!, 'compare.finished', {
    disputes: comparison.disputes.length,
    unverified: comparison.unverified.length,
    settled: comparison.settled.length,
  }, { ...base, artifactIds: artifacts.map((a) => a.id) });
  return comparison;
}

const beliefRecord = (b: Belief) => ({
  subject: b.subject, predicate: b.predicate, status: b.status, value: b.value,
  confidence: b.confidence, claimIds: b.claims.map((c) => c.id),
});

const disputeRecord = (d: Dispute) => ({
  subject: d.subject, predicate: d.predicate, status: d.belief.status, sameEvidence: d.sameEvidence,
  sides: d.sides,
});

/**
 * Bring the MCP server's `events.jsonl` lines into the durable log for this mission.
 *
 * Every line names its session, every attempt was started with the session it handed the
 * adapter, so the match is exact. Lines nobody owns are left where they are.
 */
export function ingestMcpEvents(ctx: DaylightContext, missionId: string): number {
  const file = path.join(ctx.out, 'events.jsonl');
  if (!fs.existsSync(file)) return 0;
  const lines: RunEvent[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as RunEvent);
    } catch {
      // A torn final line is normal while an agent is still writing.
    }
  }
  return ctx.events.ingestRunEvents(lines, (session) => {
    if (!session.startsWith(`${missionId}:`)) return null;
    const a = ctx.store.attemptBySession(session);
    return a ? { projectId: a.projectId, missionId: a.missionId, taskId: a.taskId, attemptId: a.id } : null;
  });
}

// ---- inspection ------------------------------------------------------------------

/**
 * A dispute as the mission saw it, with where it stands now.
 *
 * Recorded at compare time and kept: a human decision turns the belief CONFIRMED, and a view
 * that only listed *live* contradictions would then show the mission's central finding as
 * never having happened. `status` is the belief today; `decisionId` is what settled it.
 */
export interface InspectedDispute {
  subject: string;
  predicate: string;
  status: ClaimStatus;
  sameEvidence: boolean;
  sides: DisputeSide[];
  decisionId?: string;
}

/**
 * Something a person has to do before the mission can move, derived and never stored.
 *
 * A mission whose reviews are done and whose reviewers disagree is `running` — the state
 * table has no "waiting on you", and should not: a dispute is not a failure, so `blocked`
 * would be the wrong word. But it is the one moment the product exists to produce, so it is
 * computed here and the list counts it.
 */
export interface Need {
  kind: 'blocked' | 'dispute';
  ref: string;
  why: string;
}

export function needsOf(ctx: DaylightContext, mission: Mission, comparison?: Comparison): Need[] {
  if (mission.state === 'closed') return [];
  if (mission.state === 'blocked') {
    return [{ kind: 'blocked', ref: mission.id, why: mission.outcomeReason ?? 'blocked' }];
  }
  const tasks = ctx.store.tasks(mission.id);
  if (!tasks.length || tasks.some((t) => t.state !== 'done')) return [];
  const disputes = (comparison ?? compare(ctx.claims, mission.scope, missionClaims(mission.id))).disputes;
  return disputes
    .filter((d) => d.belief.status === 'CONTRADICTED')
    .map((d) => ({ kind: 'dispute', ref: `${d.subject} ${d.predicate}`, why: 'the reviewers disagree; a person decides' }));
}

export interface Inspection {
  mission: Mission;
  tasks: Task[];
  attempts: Attempt[];
  experiments: Experiment[];
  decisions: Decision[];
  disputes: InspectedDispute[];
  unverified: Belief[];
  settled: Belief[];
  events: DaylightEvent[];
  needs: Need[];
}

interface ComparisonRecord {
  disputes?: Array<{ subject: string; predicate: string; sameEvidence: boolean; sides: DisputeSide[] }>;
}

export function inspectMission(ctx: DaylightContext, missionId: string, eventLimit = 500): Inspection {
  const mission = ctx.store.mission(missionId);
  if (!mission) throw new Error(`unknown mission ${missionId}`);
  const tasks = ctx.store.tasks(missionId);
  const attempts = tasks.flatMap((t) => ctx.store.attempts(t.id));
  const decisions = ctx.store.decisions(missionId);
  const admit = missionClaims(mission.id);
  const comparison = compare(ctx.claims, mission.scope, admit);

  // Recorded first, then whatever is contradicted right now and was not recorded yet.
  const byKey = new Map<string, InspectedDispute>();
  const key = (d: { subject: string; predicate: string }) => `${d.subject}\u0000${d.predicate}`;
  const settle = (d: { subject: string; predicate: string; sameEvidence: boolean; sides: DisputeSide[] }) => {
    const status = ctx.claims.belief(d.subject, d.predicate, undefined, admit).status;
    const decision = decisions.find((x) => x.subject === d.subject && x.predicate === d.predicate);
    byKey.set(key(d), {
      subject: d.subject, predicate: d.predicate, status, sameEvidence: d.sameEvidence,
      sides: d.sides, decisionId: decision?.id,
    });
  };
  for (const a of attempts.filter((a) => a.runnerId === 'static:vds')) {
    for (const ref of a.artifacts.filter((r) => r.label === 'comparison')) {
      if (!ctx.artifacts.has(ref)) continue;
      try {
        const rec = JSON.parse(ctx.artifacts.text(ref)) as ComparisonRecord;
        for (const d of rec.disputes ?? []) settle(d);
      } catch {
        // An unreadable record contributes nothing; the live comparison still does.
      }
    }
  }
  for (const d of comparison.disputes) if (!byKey.has(key(d))) settle(d);

  const all = ctx.events.forMission(missionId);
  return {
    mission,
    tasks,
    attempts,
    experiments: ctx.store.experiments(missionId),
    decisions,
    disputes: [...byKey.values()].sort((a, b) => a.subject.localeCompare(b.subject)),
    unverified: comparison.unverified,
    settled: comparison.settled,
    events: all.slice(-eventLimit),
    needs: needsOf(ctx, mission, comparison),
  };
}

// ---- experiments -----------------------------------------------------------------

export interface ProposeOptions {
  missionId: string;
  subject: string;
  predicate: string;
  hypothesis: string;
  prediction: ExpectedObservation;
  testSource: string;
  testPath: string;
  command: string[];
  claimIds?: number[];
}

function requireExecute(mission: Mission): void {
  if (!mission.permissions.execute) {
    throw new Error(
      `mission ${mission.id} was not granted execute permission; an experiment runs code, ` +
        'and a mission cannot grant itself that',
    );
  }
  if (mission.state === 'closed') throw new Error(`mission ${mission.id} is closed`);
}

export function proposeExperiment(ctx: DaylightContext, opts: ProposeOptions): Experiment {
  const mission = ctx.store.mission(opts.missionId);
  if (!mission) throw new Error(`unknown mission ${opts.missionId}`);
  requireExecute(mission);
  const input: RegisterInput = {
    store: ctx.store,
    artifacts: ctx.artifacts,
    events: ctx.events,
    missionId: mission.id,
    projectId: mission.projectId,
    baseRevision: mission.baseRevision,
    subject: opts.subject,
    predicate: opts.predicate,
    claimIds: opts.claimIds ?? [],
    hypothesis: opts.hypothesis,
    prediction: opts.prediction,
    testSource: opts.testSource,
    testPath: opts.testPath,
    command: opts.command,
  };
  return registerExperiment(input);
}

export async function runMissionExperiment(
  ctx: DaylightContext,
  opts: { experimentId: string; repo?: string; runs?: number; timeoutMs?: number },
): Promise<Experiment> {
  const experiment = ctx.store.experiment(opts.experimentId);
  if (!experiment) throw new Error(`unknown experiment ${opts.experimentId}`);
  const mission = ctx.store.mission(experiment.missionId)!;
  requireExecute(mission);
  const repo = opts.repo ?? ctx.store.project(mission.projectId)?.root;
  if (!repo) throw new Error(`no repository recorded for project ${mission.projectId}`);
  const { root } = requireMappedRepo(ctx.out, repo);
  return runExperiment(experiment, {
    repoRoot: root,
    store: ctx.store,
    artifacts: ctx.artifacts,
    events: ctx.events,
    runs: opts.runs,
    timeoutMs: opts.timeoutMs,
  });
}

// ---- decisions -------------------------------------------------------------------

export interface DecideOptions {
  missionId: string;
  subject: string;
  predicate: string;
  value: unknown;
  rationale: string;
  actor?: string;
  experimentId?: string;
}

/**
 * A human settles a belief. Two records, deliberately: the claim store gets a human claim
 * exactly as `arbitrate` has always written one, so every existing reader sees CONFIRMED;
 * and the mission gets a Decision that says who, why, against which revision, and which
 * experiment results they were looking at.
 */
export function decide(ctx: DaylightContext, opts: DecideOptions): { decision: Decision; belief: Belief } {
  const mission = ctx.store.mission(opts.missionId);
  if (!mission) throw new Error(`unknown mission ${opts.missionId}`);
  if (mission.state === 'closed') throw new Error(`mission ${mission.id} is closed`);
  if (!opts.rationale.trim()) throw new Error('a decision needs a rationale');

  const experiment = opts.experimentId ? ctx.store.experiment(opts.experimentId) : null;
  if (opts.experimentId && !experiment) throw new Error(`unknown experiment ${opts.experimentId}`);
  if (experiment && experiment.missionId !== mission.id) {
    throw new Error(`experiment ${experiment.id} belongs to mission ${experiment.missionId}, not ${mission.id}`);
  }
  const resultIds = experiment ? experiment.executions.map((r) => r.id) : [];

  const claim = ctx.claims.submit({
    subject: opts.subject,
    predicate: opts.predicate,
    value: opts.value,
    source: { kind: 'human' },
    confidence: 1,
    evidence: [
      { file: opts.subject.split('#')[0], note: opts.rationale.trim() },
      ...(experiment
        ? [{
            file: opts.subject.split('#')[0],
            note: `experiment ${experiment.id} concluded ${experiment.conclusion}; results ${resultIds.join(', ')}`,
          }]
        : []),
    ],
  });
  const actor = opts.actor ?? 'human';
  const record = {
    missionId: mission.id,
    projectId: mission.projectId,
    revision: mission.baseRevision,
    actor,
    kind: 'adjudicate' as const,
    subject: opts.subject,
    predicate: opts.predicate,
    value: opts.value,
    rationale: opts.rationale.trim(),
    scope: { claimId: claim.id, experimentId: experiment?.id ?? null, conclusion: experiment?.conclusion ?? null },
    artifactIds: resultIds,
  };
  const decision = ctx.store.recordDecision(record);
  const ref = ctx.artifacts.put(JSON.stringify(decision, null, 2), {
    kind: 'decision', projectId: mission.projectId, revision: mission.baseRevision,
    label: `decision ${decision.id}`, mediaType: 'application/json',
  });
  ctx.store.recordArtifact(ref);
  const belief = ctx.claims.belief(opts.subject, opts.predicate);
  ctx.events.append({
    projectId: mission.projectId, missionId: mission.id, actorId: actor,
    category: 'approval', name: 'approval.decided', artifactIds: [ref.id, ...resultIds],
    payload: {
      decisionId: decision.id, subject: opts.subject, predicate: opts.predicate, value: opts.value,
      status: belief.status, experimentId: experiment?.id ?? null,
    },
  });
  return { decision, belief };
}

export function closeMission(
  ctx: DaylightContext, missionId: string, outcome: MissionOutcome, reason: string,
): Mission {
  const mission = ctx.store.closeMission(missionId, outcome, reason);
  lifecycle(ctx, mission, 'mission.closed', { outcome, reason: mission.outcomeReason });
  return mission;
}
