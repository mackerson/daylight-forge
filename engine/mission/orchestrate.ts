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
import { credentialFor, missionSpend } from '../swarm/usage.ts';
import { detectSandbox, type SandboxProfile } from '../experiment/sandbox.ts';
import { authorFor, reviewLauncher } from '../forge/authors.ts';
import { ROLE_MCP_TOOLS } from '../forge/decompose.ts';
import { MCP_CONFIG, MCP_SERVER_KEY, mcpRuntimeDir, newMcpToken, type McpEndpoint } from '../forge/sandbox.ts';
import { specOf } from '../forge/spec.ts';
import { assertHumanDecision, confirmCodeOf } from '../forge/policy.ts';
import { canonicalJson, digestOf } from './artifacts.ts';
import { createDecomposeServer, createServer, listenAttemptSocket } from '../mcp/server.ts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AttemptCredential, AttemptSandbox, SandboxReason, TaskRole } from './types.ts';
import type { Belief, ClaimStatus } from '../store/types.ts';
import type { DaylightContext } from './context.ts';
import { requireMappedRepo } from './context.ts';
import {
  compare, MISSION_CLAIM_FILTER, missionClaims, type Comparison, type Dispute, type DisputeSide,
} from './disputes.ts';
import { currentRevision } from './project.ts';
import type {
  Application, ArtifactRef, Attempt, Candidate, DaylightEvent, Decision, Experiment, ExpectedObservation,
  GateEvaluation, Mission, MissionKind, MissionOutcome, Need, Task,
} from './types.ts';
import { needsOf } from './needs.ts';

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
 * `DAYLIGHT_MOCK_ADAPTER` names a script; a roster entry `mock:<model>` runs it with our node,
 * handing it the MCP config path and the prompt. It is registered as `mock` everywhere it
 * leaves a trace — claims, attempts, events — so nothing it produces can be mistaken for a
 * model's. Without the variable, `mock` is simply not an adapter.
 */
export function mockAdapter(): Adapter | null {
  const script = process.env.DAYLIGHT_MOCK_ADAPTER;
  if (!script || !fs.existsSync(script)) return null;
  return {
    name: 'mock',
    bin: process.execPath,
    perInvocationMcp: true,
    argv: (run) => [script, run.mcpConfigPath, run.prompt],
    // A mock that wants its cost known prints the claude stream's own result line (R10.3).
    streamShape: 'claude',
  };
}

/**
 * The variable each provider's own key is read from, for the ledger's credential record:
 * presence, name and label only, never the value (Q4a). A mock has its own, so a test can
 * say what it was given without touching a real provider's.
 */
export const CREDENTIAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', grok: 'XAI_API_KEY', opencode: 'OPENCODE_API_KEY',
  mock: 'DAYLIGHT_MOCK_CREDENTIAL',
});

/** Recorded before an attempt starts, so a refusal leaves no half-started attempt behind. */
export function attemptCredential(tool: string, env: NodeJS.ProcessEnv = process.env): AttemptCredential | undefined {
  const name = CREDENTIAL_ENV[tool];
  if (!name) return undefined;
  const label = env.DAYLIGHT_CREDENTIAL_LABEL;
  return credentialFor(name, label && /^[\w .:@/-]{1,64}$/.test(label) ? label : null, env);
}

/** `mcp__daylight__<tool>` for each of a role's MCP tools: the allowlist the adapter hook takes (D-2). */
export const roleAllowlist = (role: keyof typeof ROLE_MCP_TOOLS): string[] =>
  ROLE_MCP_TOOLS[role].map((t) => `mcp__${MCP_SERVER_KEY}__${t}`);

/**
 * One attempt's MCP socket (R11.2) for as long as `run` takes: a private runtime dir, a listener
 * that serves only this attempt's token, and both removed afterwards whatever happens.
 */
export async function withAttemptSocket<T>(
  ctx: DaylightContext, attempt: Pick<Attempt, 'id'>, token: string, serve: () => McpServer,
  run: (mcp: McpEndpoint) => Promise<T>,
): Promise<T> {
  const rt = mcpRuntimeDir({ out: ctx.out });
  try {
    const sock = await listenAttemptSocket({
      socketPath: rt.socket, attemptId: attempt.id, resolve: (t) => ctx.store.attemptByMcpToken(t), serve,
    });
    try {
      return await run({ socket: rt.socket, token });
    } finally {
      await sock.close();
    }
  } finally {
    rt.dispose();
  }
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
  /**
   * `review` (the default) runs independent reviewers and then the compare step. `decompose`
   * runs blind decomposers on a spec mission's decompose tasks: no compare, only the
   * `propose_work_item` tool, always under the review profile over the attempt's socket.
   */
  role?: Extract<TaskRole, 'review' | 'decompose'>;
  /** The prompt every attempt gets. Defaults to the review prompt; decompose passes the spec's. */
  prompt?: string;
  /**
   * Whenever bwrap is present, review attempts run under the `review` profile over a
   * per-attempt MCP socket with `<out>` unmounted (R9.1); a profile that cannot be built fails
   * the attempt, never runs it open. This opts out, for test doubles only: accepted when every
   * roster entry is `mock`, refused before anything runs otherwise, and recorded on each
   * attempt as profile `none`. Real providers get no profile until the live spike (R15.1).
   */
  noReviewSandbox?: boolean;
  /**
   * Run reviews exactly as P0 did, with no profile, so real providers can review before the
   * live spike (R7: an explicit mode, recorded). Each attempt is stamped profile `none`, reason
   * `unsandboxed-review`; the reviewer can read `<out>` (Sec H5). The CLI warns.
   */
  unsandboxedReview?: boolean;
  /** Injected in tests; defaults to `detectSandbox()`. */
  sandbox?: SandboxProfile;
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
  /**
   * Review this materialised tree instead of the checkout: a campaign's wave review reads the
   * integration ref's commit, which is not what is checked out (§6.2). Bound read-only like the root.
   */
  tree?: string;
  /**
   * The MCP server each review attempt gets instead of the claims server, with the tools its
   * attempts may call. Sandboxed only; no compare step follows (a wave review files findings).
   */
  reviewServer?: { serve: (attempt: Attempt) => McpServer; allowedTools: string[] };
  /** Record each attempt's share of the ceiling on `attempts.max_cost_usd`: a campaign's reservation (P2-R18, P2-R35). */
  reserve?: boolean;
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
export function takeRunClaim(out: string, missionId: string): () => void {
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

/** Tasks of one role already on the mission, by the source they are pinned to. */
function tasksBySource(tasks: Task[], role: TaskRole): Map<string, Task> {
  const out = new Map<string, Task>();
  for (const t of tasks) if (t.role === role && t.runnerHint) out.set(t.runnerHint, t);
  return out;
}

/** A sandboxed review or decompose attempt: read-only, no exec, and no network for a mock. */
const SANDBOXED_REVIEW: AttemptSandbox = {
  profile: 'review', network: 'none', write: false, exec: false, authorizeDecisionId: null,
};

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
  const role = opts.role ?? 'review';
  if (role !== 'review' && role !== 'decompose') throw new Error(`runMission runs review or decompose attempts, not ${String(role)}`);
  if (role === 'decompose' && mission.kind !== 'spec') throw new Error(`mission ${mission.id} is ${mission.kind}; only a spec mission decomposes`);
  if (role === 'review' && mission.kind === 'spec') throw new Error(`mission ${mission.id} is a spec mission; it is decomposed, not reviewed`);
  // Decomposers reach their one tool only over the attempt socket, so they are always sandboxed.
  if (opts.noReviewSandbox && opts.unsandboxedReview) {
    throw new Error('--no-review-sandbox and --unsandboxed-review are two names for one opt-out; pass one');
  }
  if (role === 'decompose' && opts.unsandboxedReview) {
    throw new Error('--unsandboxed-review does not apply to decompose: a decomposer reaches its tool only over the socket');
  }
  if (opts.noReviewSandbox) {
    if (role === 'decompose') throw new Error('--no-review-sandbox does not apply to decompose: a decomposer reaches its tool only over the socket');
    // Checked on the roster as typed, before any binary is looked up or run.
    const real = opts.tools.map((t) => parseSpec(t, opts.model).tool).filter((t) => t !== 'mock');
    if (real.length) throw new Error(`--no-review-sandbox is for mock reviewers only; refused for ${[...new Set(real)].join(', ')}`);
  }
  const detected = opts.sandbox ?? detectSandbox();
  // Fail closed: sandboxed whenever bwrap is present, unless a person opted out by name.
  const declined: SandboxReason | undefined = opts.unsandboxedReview ? 'unsandboxed-review' : opts.noReviewSandbox ? 'no-review-sandbox' : undefined;
  if (role === 'review' && !declined && !detected.available) {
    // No profile can be built: refused, never run open by default (fail closed).
    throw new Error(
      `refused: reviews run under the bwrap review profile, which cannot be built here (${detected.why ?? 'unavailable'}); ` +
        'install bubblewrap and prlimit, or pass --unsandboxed-review to run them as P0 did (Sec H5: the reviewer can read <out>), ' +
        'or --no-review-sandbox for an all-mock roster',
    );
  }
  const sandboxed = role === 'decompose' || (!declined && detected.available);
  if (opts.reviewServer && (!sandboxed || role !== 'review')) {
    throw new Error('a custom review server runs only on sandboxed review attempts, over their own socket');
  }
  const profile = sandboxed ? detected : null;
  if (profile && !profile.available) {
    throw new Error(`${role} attempts run under the bwrap review profile, which cannot be built here: ${profile.why ?? 'unavailable'}`);
  }
  if (sandboxed && role === 'review') {
    // Refused before any binary is looked up or run.
    // A tool with no adapter is reported unavailable below, as it always was; only real providers are refused here.
    const real = [...new Set(opts.tools.map((t) => parseSpec(t, opts.model).tool).filter((t) => t !== 'mock' && Object.hasOwn(ADAPTERS, t)))];
    if (real.length) {
      throw new Error(
        `refused: ${real.join(', ')} would review under the bwrap review profile, which real providers do not get until ` +
          'the owner authorises the live spike (R15.1); after that spike they run sandboxed, or pass --unsandboxed-review ' +
          'to run them now exactly as P0 did, unsandboxed (Sec H5: the reviewer can read <out>)',
      );
    }
  }
  const planned = planMissionRoster(opts.tools, opts.model);
  const unavailable = [...planned.unavailable];
  const runnable = planned.runnable.filter(({ spec }) => {
    if (!sandboxed || spec.tool === 'mock') return true;
    unavailable.push(`${specKey(spec)} (real providers run under no sandbox profile until the owner authorises the live spike, R15.1)`);
    return false;
  });
  const prompt = opts.prompt ?? buildReviewPrompt(mission);
  // The registered spec, so the decompose server can refuse a bad anchor at once.
  const decomposeCheck = role === 'decompose' ? { spec: specOf(ctx, mission.id).bytes } : undefined;
  const diversity = sourceDiversity(runnable.map((r) => r.spec));
  if (role === 'review' && runnable.length && diversity < 2) {
    notes.push(
      `roster has ${diversity} independent source; nothing it claims can be corroborated and ` +
        'no disagreement can be discovered',
    );
  }

  // Tasks are durable: a second run re-uses the task for a source it has seen, so a retry is
  // a new attempt on the same task rather than a new task with no history.
  const existing = tasksBySource(ctx.store.tasks(mission.id), role);
  const plans: ReviewPlan[] = [];
  for (const { spec, adapter } of runnable) {
    const key = specKey(spec);
    // decompose() pins its tasks to the roster entry as typed (`mock`), not its key (`mock:default`).
    let task = existing.get(key) ?? [...existing.values()].find((t) => specKey(parseSpec(t.runnerHint!, opts.model)) === key);
    if (!task && role === 'decompose') {
      // decompose() creates its tasks before it runs them; a decompose run never invents one.
      unavailable.push(`${key} (no decompose task on mission ${mission.id})`);
      continue;
    }
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
    const cfgPath = sandboxed ? MCP_CONFIG : path.join(ctx.out, `mcp.${slug(key)}.${mission.id}.json`);
    plans.push({ spec, taskId: task.id, prompt, mcpConfigPath: cfgPath });
    void adapter;
  }
  const reviewTasks = ctx.store.tasks(mission.id).filter((t) => t.role === 'review');
  let compareTask = role === 'review' ? ctx.store.tasks(mission.id).find((t) => t.role === 'compare') : undefined;
  if (role === 'review' && !opts.reviewServer && !compareTask && reviewTasks.length) {
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

  if (!plans.length) {
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
  let spent = missionSpend(ctx, mission.id).spentUsd;
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
    const credential = attemptCredential(spec.tool);
    const token = sandboxed ? newMcpToken() : undefined;
    const attempt = ctx.store.startAttempt({
      taskId: task.id, runnerId, sessionId: session, credential,
      ...(opts.reserve && share !== undefined ? { maxCostUsd: share } : {}),
      ...(sandboxed ? { sandbox: SANDBOXED_REVIEW, mcpToken: token } : declined ? { sandbox: { reason: declined } } : {}),
    });
    open.add(attempt.id);
    lifecycle(ctx, mission, 'attempt.started', {
      runnerId, session, ...(sandboxed ? { profile: SANDBOXED_REVIEW.profile, network: SANDBOXED_REVIEW.network } : {}),
    }, { taskId: task.id, attemptId: attempt.id });
    opts.onProgress?.(ctx.store.mission(mission.id)!, `${key} started`);

    const run: Parameters<typeof captureRun>[1] = {
      prompt: plan.prompt,
      cwd: opts.tree ?? root,
      mcpConfigPath: plan.mcpConfigPath,
      session,
      model: spec.model,
      timeoutMs,
      maxTurns: 40,
      maxCost: share,
      ...(role === 'decompose' ? { allowedTools: roleAllowlist('decompose') } : opts.reviewServer ? { allowedTools: opts.reviewServer.allowedTools } : {}),
    };
    const capture: Parameters<typeof captureRun>[2] = {
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
      credential,
    };
    let result: Awaited<ReturnType<typeof captureRun>> | null = null;
    if (!sandboxed) {
      fs.writeFileSync(
        plan.mcpConfigPath,
        JSON.stringify(
          mcpConfig(cmd, ctx.out, spec.tool, spec.model, session, { DAYLIGHT_BLIND_PREFIX: mission.id }),
          null, 2,
        ),
      );
      result = await captureRun(adapter, run, capture);
    } else {
      // The store's own row is the only source of what this attempt was granted (ws2 ask).
      const row = ctx.store.attempt(attempt.id)!;
      // Only mocks reach here until the Q5 live spike; resolved by tool so a real provider then gets its own adapter.
      const mock = authorFor(spec.tool);
      try {
        if (mock.status !== 'available') throw new Error(mock.why);
        const serve = (): McpServer => (ctx.store.task(row.taskId)?.role === 'decompose'
          ? createDecomposeServer({ dir: ctx.out, attemptId: row.id, agentTool: spec.tool, model: spec.model, check: decomposeCheck }).server
          : opts.reviewServer ? opts.reviewServer.serve(row)
            : createServer({ dir: ctx.out, session, agentTool: spec.tool, model: spec.model, blindPrefix: mission.id }).server);
        result = await withAttemptSocket(ctx, row, token!, serve, (mcp) => captureRun(mock.adapter, {
          ...run,
          launch: reviewLauncher({ attempt: row, repo: opts.tree ?? root, mounts: mock.mounts, mcp, out: ctx.out, profile: profile! }),
        }, capture));
      } catch (err) {
        // Fail closed: a review profile that cannot be built is a failed attempt, never an unsandboxed one.
        const why = `the review sandbox could not be started: ${(err as Error).message}`.slice(0, 500);
        if (ctx.store.attempt(attempt.id)?.state === 'running') {
          ctx.store.finishAttempt(attempt.id, { state: 'failed', costUsd: null, failure: why });
        }
        lifecycle(ctx, mission, 'attempt.refused', { why }, { taskId: task.id, attemptId: attempt.id });
      }
    }
    open.delete(attempt.id);
    const costUsd = ctx.store.attempt(attempt.id)?.costUsd ?? null;
    spent = missionSpend(ctx, mission.id).spentUsd;
    if (costUsd === null) {
      unknownCost.push(key);
    }
    ingestMcpEvents(ctx, mission.id);
    if (!result) {
      failures.push(`${key}: the review sandbox could not be started`);
    } else if (!result.ok) {
      const why = result.timedOut ? 'timed out' : result.overBudget ? 'over budget' : `exit ${result.exitCode}`;
      failures.push(`${key}: ${why}`);
    }
    opts.onProgress?.(ctx.store.mission(mission.id)!, `${key} ${result?.ok ? 'finished' : 'failed'}`);
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

  const costKnown = missionSpend(ctx, mission.id).costKnown;
  if (failures.length) {
    block(failures.join('; '));
    return finish(report(undefined, spent, costKnown));
  }
  // A decompose run ends when its attempts do; what they proposed is ingested by decompose().
  // So does a run with its own review server: what it filed is ingested by its caller.
  if (role === 'decompose' || opts.reviewServer) return finish(report(undefined, spent, costKnown));

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
  const attempt = ctx.store.startAttempt({ taskId, runnerId: 'static:daylight' });
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
      projectId: mission.projectId, missionId: mission.id, ...base, actorId: 'static:daylight',
      category: 'claim', name: 'claim.disputed', artifactIds: [ref.id],
      payload: {
        subject: d.subject, predicate: d.predicate, sameEvidence: d.sameEvidence,
        sides: d.sides.map((s) => ({ source: s.source, value: s.value, confidence: s.confidence, claimId: s.claimId })),
      },
    });
  }
  for (const b of comparison.unverified) {
    ctx.events.append({
      projectId: mission.projectId, missionId: mission.id, ...base, actorId: 'static:daylight',
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

  // The comparison is static and runs here: it costs exactly nothing, and says so as its own source.
  ctx.store.finishAttempt(attempt.id, { state: 'completed', exitCode: 0, costUsd: 0, costSource: 'provider', artifacts });
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

export { needsOf, projectNeeds } from './needs.ts';
export type { Need } from './types.ts';

/**
 * A holdout as anyone outside the gate runner may see it: that it exists, its role, how it
 * concluded and what froze it. Never its hypothesis, prediction, command, test or runs (ADR-18,
 * ws9-review M1): withholding at render time is not enough, so it never leaves the engine.
 */
export type WithheldExperiment = Pick<Experiment, 'id' | 'missionId' | 'role' | 'conclusion' | 'harnessDigest' | 'lockedBy'> & { withheld: true };

export function publicExperiment(x: Experiment): Experiment | WithheldExperiment {
  if (x.role !== 'holdout') return x;
  return {
    id: x.id, missionId: x.missionId, role: x.role, conclusion: x.conclusion, harnessDigest: x.harnessDigest,
    ...(x.lockedBy ? { lockedBy: x.lockedBy } : {}), withheld: true,
  };
}

/** A holdout's evaluation keeps its conclusion and digests; its run records stay in the row. */
export function publicGateEvaluations(ctx: DaylightContext, rows: GateEvaluation[]): GateEvaluation[] {
  const holdout = (id: string) => ctx.store.experiment(id)?.role === 'holdout';
  return rows.map((g) => (holdout(g.experimentId) ? { ...g, executions: [] } : g));
}

/**
 * Events with a holdout's content withheld: an event about a holdout keeps its name, ids and
 * outcome, and loses every other payload field and every artifact it points at.
 */
export function publicEvents(ctx: DaylightContext, missionId: string, events: DaylightEvent[]): DaylightEvent[] {
  return withholdHoldoutEvents(holdoutContent(ctx, [missionId]), events);
}

/**
 * Every holdout of these missions (default: all of them), and every artifact that carries its
 * content: the test, the expectation, each run record and the logs those records name.
 */
const EMPTY_ARTIFACT = digestOf('');

export function holdoutContent(ctx: DaylightContext, missionIds?: string[]): { ids: Set<string>; artifacts: Set<string> } {
  const ids = new Set<string>();
  const artifacts = new Set<string>();
  const runs: ArtifactRef[] = [];
  for (const missionId of missionIds ?? ctx.store.missions().map((m) => m.id)) {
    const holdouts = ctx.store.experimentsFor(missionId, 'holdout');
    if (!holdouts.length) continue;
    for (const x of holdouts) {
      ids.add(x.id);
      artifacts.add(x.testArtifact.id);
      artifacts.add(x.expectedArtifact.id);
      runs.push(...x.executions);
    }
    for (const g of ctx.store.gateEvaluations({ missionId })) if (ids.has(g.experimentId)) runs.push(...g.executions);
  }
  for (const r of runs) {
    // Content-addressed: an empty log is every empty log, and withholding it would hide others' (an exec run's) too.
    if (r.id === EMPTY_ARTIFACT) continue;
    artifacts.add(r.id);
    try {
      const rec = JSON.parse(ctx.artifacts.text(r)) as { stdoutRef?: ArtifactRef; stderrRef?: ArtifactRef };
      if (rec.stdoutRef && rec.stdoutRef.id !== EMPTY_ARTIFACT) artifacts.add(rec.stdoutRef.id);
      if (rec.stderrRef && rec.stderrRef.id !== EMPTY_ARTIFACT) artifacts.add(rec.stderrRef.id);
    } catch {
      // A record that cannot be read names no log; its own id is already withheld.
    }
  }
  return { ids, artifacts };
}

/** Events with each holdout's content withheld: ids and outcome kept, every other field and artifact gone. */
export function withholdHoldoutEvents(h: { ids: Set<string>; artifacts: Set<string> }, events: DaylightEvent[]): DaylightEvent[] {
  const { ids, artifacts } = h;
  if (!ids.size) return events;
  return events.map((e) => {
    const p = e.payload as Record<string, unknown>;
    const about = typeof p.experimentId === 'string' && ids.has(p.experimentId);
    const points = (e.artifactIds ?? []).some((a) => artifacts.has(a));
    if (!about && !points && p.role !== 'holdout') return e;
    const keep: Record<string, unknown> = { role: 'holdout', withheld: true };
    for (const k of ['experimentId', 'gateEvaluationId', 'target', 'diffDigest', 'conclusion', 'runIndex', 'status', 'runs']) {
      if (k in p) keep[k] = p[k];
    }
    return { ...e, payload: keep, artifactIds: [] };
  });
}

export interface Inspection {
  mission: Mission;
  tasks: Task[];
  attempts: Attempt[];
  experiments: Array<Experiment | WithheldExperiment>;
  decisions: Decision[];
  disputes: InspectedDispute[];
  unverified: Belief[];
  settled: Belief[];
  events: DaylightEvent[];
  needs: Need[];
  candidates: Candidate[];
  gateEvaluations: GateEvaluation[];
  applications: Application[];
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
  for (const a of attempts.filter((a) => a.runnerId === 'static:daylight')) {
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
    experiments: ctx.store.experiments(missionId).map(publicExperiment),
    decisions,
    disputes: [...byKey.values()].sort((a, b) => a.subject.localeCompare(b.subject)),
    unverified: comparison.unverified,
    settled: comparison.settled,
    events: publicEvents(ctx, missionId, all.slice(-eventLimit)),
    needs: needsOf(ctx, mission, comparison),
    candidates: ctx.store.candidates(missionId),
    gateEvaluations: publicGateEvaluations(ctx, ctx.store.gateEvaluations({ missionId })),
    applications: ctx.store.applications(missionId),
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
  /** `human:<name>`; the CLI supplies the OS user's. */
  actor: string;
  experimentId?: string;
  /** `--confirm <digest8>` of `adjudicateConfirm` for exactly this subject, predicate and value. */
  confirm: string | undefined;
  /** Read by the guard; `process.env` at the CLI. */
  env: Readonly<Record<string, string | undefined>>;
}

/** A `--value` as the CLI reads it: true, false, a number, JSON, else the string itself. */
export function parseDecisionValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * What a person confirms for a P0 adjudication (R14 D-9: every decision goes through the one
 * guard): the mission, its revision, and exactly the belief being settled and the experiment
 * cited, so a code confirmed for one value does not record another.
 */
export function adjudicateConfirm(
  mission: Pick<Mission, 'id' | 'projectId' | 'baseRevision'>,
  o: { subject: string; predicate: string; value: unknown; experimentId?: string },
): { digest: string; digest8: string; lines: string[] } {
  const digest = digestOf(canonicalJson({
    operation: 'adjudicate', missionId: mission.id, projectId: mission.projectId, revision: mission.baseRevision,
    subject: o.subject, predicate: o.predicate, value: o.value ?? null, experimentId: o.experimentId ?? null,
  }));
  return {
    digest, digest8: confirmCodeOf(digest),
    lines: [
      `decide on mission ${mission.id} at ${mission.baseRevision}`,
      `${o.subject} ${o.predicate} = ${JSON.stringify(o.value ?? null)}`,
      `experiment: ${o.experimentId ?? 'none'}`,
    ],
  };
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
  assertHumanDecision(opts.env, opts.actor, opts.confirm,
    adjudicateConfirm(mission, { subject: opts.subject, predicate: opts.predicate, value: opts.value, experimentId: opts.experimentId }).digest);
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
  const actor = opts.actor;
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
