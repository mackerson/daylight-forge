import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, digestOf } from './artifacts.ts';
import { DAYLIGHT_DB, openDaylightDb, parseJson } from './db.ts';
import {
  ATTEMPT_TRANSITIONS, canTransition, DECISION_OPERATIONS, ID_PREFIX, isEntityId, isHumanActor,
  MISSION_TRANSITIONS,
  NETWORK_MODES, READ_ONLY_SANDBOX, SANDBOX_PROFILES, TASK_TRANSITIONS, WORK_ITEM_TRANSITIONS,
} from './types.ts';
import type {
  ArtifactKind, ArtifactRef, Attempt, AttemptCredential, AttemptOrigin, AttemptSandbox, AttemptState, CostSource, Decision,
  DecisionOperation, EntityKind, Experiment, ExperimentConclusion, ExperimentRole, Mission,
  MissionBudget, MissionKind, MissionOutcome, MissionPermissions, MissionScope, MissionState,
  NetworkMode, NewExperiment, ProjectIdentity, Task, TaskRole, TaskState, TokenUsage,
  UsageSource, Application, Candidate, CandidateFile, CandidateVerdict, GateEvaluation, GateTarget,
  IngestSource, PolicyViolation, UsageRecordResult, UsageTurn, WorkItem, WorkItemStatus,
} from './types.ts';

/**
 * The mission store: what work was asked for, who attempted it, and what each attempt
 * produced. Everything here is bookkeeping about *work*; facts about the repository stay
 * in the claim store and are referenced by id.
 *
 * Two rules the whole design leans on are enforced here rather than left to callers.
 * Transitions are checked against the tables in `types.ts`, so a state the design never
 * drew cannot be reached by a typo. And nothing in this file closes a mission as a side
 * effect: a finished attempt finishes its task, and that is all it does. An exit code is
 * an observation, an outcome is a judgement, and only `closeMission` records one.
 */

export class IllegalTransition extends Error {
  constructor(what: string, id: string, from: string, to: string) {
    super(`${what} ${id} cannot go from ${from} to ${to}`);
    this.name = 'IllegalTransition';
  }
}

/** A fresh id of the given kind: `<prefix>_<32 hex>`. */
export function newId(kind: EntityKind): string {
  return `${ID_PREFIX[kind]}_${randomUUID().replace(/-/g, '')}`;
}

const NO_TOKENS: TokenUsage = { input: null, output: null, cacheRead: null, cacheWrite: null };


const sandboxColumns = (s: AttemptSandbox | null): Array<string | number | null> => (s === null
  ? [null, null, null, null, null]
  : [s.profile, s.network, s.write ? 1 : 0, s.exec ? 1 : 0, s.authorizeDecisionId ?? null]);

const tokenColumns = (t: TokenUsage): [number | null, number | null, number | null, number | null] =>
  [t.input, t.output, t.cacheRead, t.cacheWrite];

const maxOf = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

/** An approving `authorize-mission` decision of this mission, by a human, that granted write. */
export function grantsWrite(d: Decision | null | undefined, missionId: string): boolean {
  const scope = d?.scope as { operation?: unknown; permissions?: { write?: unknown } } | undefined;
  return !!d && d.missionId === missionId && d.kind === 'approve' && isHumanActor(d.actor)
    && scope?.operation === 'authorize-mission' && scope.permissions?.write === true;
}

/**
 * Why a decision row is not one the store would have recorded, or null. `recordDecision` and
 * `importMission` both ask this, so a file cannot carry a decision the store would refuse.
 */
export function decisionRefusal(d: Pick<Decision, 'id' | 'actor' | 'kind' | 'scope'>): string | null {
  const operation = d.scope.operation;
  if (operation === undefined) return null;
  if (!DECISION_OPERATIONS.includes(operation as DecisionOperation)) {
    return `decision ${d.id} names unknown operation ${String(operation)}`;
  }
  // A Forge act is a person's, and says which person. An agent, a runner or a bare `human`
  // with no name cannot authorise, lock, approve or apply.
  if (!isHumanActor(d.actor)) return `${String(operation)} decision ${d.id} needs a human:<name> actor, not ${d.actor}`;
  return null;
}

/**
 * Why an attempt row breaks R7 or R12, or null: an ingested attempt outside a work mission or
 * with a sandbox record; a Daylight attempt without one, with an unknown profile or network,
 * with exec but no write, or with write that `grant` (its named decision) does not give.
 * `startAttempt` and `importMission` both ask this.
 */
export function attemptRefusal(
  a: Pick<Attempt, 'id' | 'missionId' | 'origin' | 'sandbox'>,
  mission: Pick<Mission, 'id' | 'kind' | 'permissions'>,
  grant: Decision | null | undefined,
): string | null {
  if (a.origin === 'ingested') {
    if (mission.kind !== 'work') return `attempt ${a.id} is ingested, and mission ${mission.id} is not a work mission; only work missions hold ingested attempts`;
    if (a.sandbox !== null) return `attempt ${a.id} is ingested, so it has no sandbox record; Daylight granted it nothing`;
    return null;
  }
  if (a.origin !== 'daylight') return `attempt ${a.id} has origin ${String(a.origin)}; it must be daylight or ingested`;
  const s = a.sandbox;
  if (!s) return `attempt ${a.id} was run by Daylight but has no sandbox record`;
  if (!NETWORK_MODES.includes(s.network)) return `attempt ${a.id} network must be one of ${NETWORK_MODES.join(', ')}, not ${String(s.network)}`;
  if (!SANDBOX_PROFILES.includes(s.profile)) return `attempt ${a.id} sandbox profile must be one of ${SANDBOX_PROFILES.join(', ')}, not ${String(s.profile)}`;
  if (s.exec && !s.write) return `attempt ${a.id} asks for exec without write; exec runs over the attempt's own writable tree`;
  if (s.write) {
    if (!s.authorizeDecisionId) return `attempt ${a.id} asks for write without naming the authorize decision that granted it`;
    if (!grantsWrite(grant, mission.id)) {
      return `decision ${s.authorizeDecisionId} is not a human authorize-mission decision granting write on mission ${mission.id}`;
    }
    if (!mission.permissions.write) return `mission ${mission.id} does not hold write`;
  }
  return null;
}

/** A credential record names a variable and a label. Anything shaped like a value is refused. */
function checkCredential(c: AttemptCredential): void {
  if (typeof c.present !== 'boolean') throw new Error('credential.present must be a boolean');
  if (c.envName !== null && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(c.envName)) {
    throw new Error('credential.envName must be an environment variable name');
  }
  if (c.label !== null && !/^[\w .:@/-]{1,64}$/.test(c.label)) {
    throw new Error('credential.label must be a short plain label of at most 64 characters');
  }
}

/**
 * Scope paths in the one spelling claims use: repo-relative, no `./`, no trailing or doubled
 * slash. Matching is by string prefix, so `src/` or `./src` typed into a form would otherwise
 * match nothing and the mission would report that nothing in scope is disputed.
 */
function normaliseScope(scope: MissionScope): MissionScope {
  if (!scope.paths) return scope;
  const paths = scope.paths
    .map((p) => path.posix.normalize(p.trim()).replace(/^(\.\/)+/, '').replace(/\/+$/, ''))
    .filter((p) => p && p !== '.');
  return { ...scope, paths };
}

const EXPERIMENT_ROLES: readonly ExperimentRole[] = ['probe', 'gate', 'holdout'];

const DEFAULT_PERMISSIONS: MissionPermissions = {
  read: true, write: false, execute: false, deploy: false,
};

export interface CreateMissionInput {
  projectId: string;
  kind: MissionKind;
  objective: string;
  baseRevision: string;
  scope?: MissionScope;
  permissions?: Partial<MissionPermissions>;
  budget?: MissionBudget;
  parentId?: string;
  requirementIds?: string[];
  acceptanceGateIds?: string[];
  /** Must name an `approved` work item of the same project. */
  workItemId?: string;
  /**
   * `--no-work-item`: an implement mission with no work item records who decided it needs
   * none, as an `adhoc-mission` decision on the mission (R10.1). Exactly one of this and
   * `workItemId` is required for an implement mission, and neither is accepted for another kind.
   */
  adhoc?: { actor: string; rationale: string };
}

/**
 * `mission authorize`: a human grants what the mission may do. `read` is always granted and
 * `deploy` never is in P1, so only `write` and `execute` are asked for.
 */
export interface AuthorizeMissionInput {
  missionId: string;
  actor: string;
  rationale: string;
  permissions: { write: boolean; execute: boolean };
  /** Becomes the mission's `budget.maxUsd`; null leaves the budget as it is. */
  maxUsd: number | null;
  artifactIds?: string[];
}

export interface CreateTaskInput {
  missionId: string;
  role: TaskRole;
  objective: string;
  dependsOn?: string[];
  inputs?: ArtifactRef[];
  requiredOutputs?: ArtifactKind[];
  runnerHint?: string;
  /** Defaults to the mission's. Supplying a different one is refused. */
  projectId?: string;
}

export interface StartAttemptInput {
  taskId: string;
  runnerId: string;
  sessionId?: string;
  worktree?: string;
  /**
   * Defaults to `daylight`. An `ingested` attempt is recovered from a transcript, belongs to a
   * `work` mission only, and takes no sandbox: nothing about it was granted here (R12.1).
   */
  origin?: AttemptOrigin;
  /**
   * Defaults to `READ_ONLY_SANDBOX`. `write: true` needs `authorizeDecisionId`, an approving
   * `authorize-mission` decision of this attempt's mission that granted write.
   */
  sandbox?: Partial<AttemptSandbox>;
  /** When it started, for an attempt recovered after the fact. Defaults to now. */
  at?: number;
  parentAttemptId?: string;
  gateSetDigest?: string;
  pid?: number;
  credential?: AttemptCredential;
  /** The per-attempt MCP token. Hashed on the way in; only the digest is stored. */
  mcpToken?: string;
}

export interface FinishAttemptInput {
  state: Extract<AttemptState, 'completed' | 'failed' | 'cancelled'>;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  /** `null` when the runner reported nothing. Not the same as zero. */
  costUsd: number | null;
  /** Defaults to `none` for a null cost and `provider` otherwise; a scraped figure must say so. */
  costSource?: CostSource;
  /** The model the provider reported. */
  model?: string;
  /** Totals for the attempt; left as they are when absent. */
  tokens?: TokenUsage;
  usageSource?: UsageSource;
  failure?: string;
  artifacts?: ArtifactRef[];
  /** When it finished, for an attempt recovered after the fact. Defaults to now. */
  at?: number;
}

export type CreateExperimentInput = NewExperiment;

export interface LockGatesInput {
  experimentIds: string[];
  actor: string;
  rationale: string;
  /** Gates already passing at base that the human accepts anyway. */
  vacuousOverrides?: string[];
  artifactIds?: string[];
}

/** One turn's usage as a capture or an ingester reads it; the store assigns `seq`. */
export interface RecordUsageInput {
  requestId: string | null;
  at?: number;
  model: string | null;
  tokens: TokenUsage;
  costUsd: number | null;
  costSource: CostSource;
  source: UsageTurn['source'];
}

export type CreateWorkItemInput = Pick<
  WorkItem, 'projectId' | 'missionId' | 'specArtifact' | 'specRevision' | 'anchor' | 'title'
  | 'statement' | 'examples' | 'negativeExamples' | 'proposedBy'
> & { id?: string; attemptId?: string; proposalArtifact?: ArtifactRef };

export type CreateCandidateInput = Omit<Candidate, 'id' | 'verdict' | 'verdictReasons' | 'createdAt'>;

export type CreateGateEvaluationInput = Omit<GateEvaluation, 'id' | 'createdAt'>;

export interface CreateApplicationInput {
  candidateId: string;
  decisionId: string;
  baseCommit: string;
  commit: string;
  ref: string;
  appliedBy: string;
}

export type CreateDecisionInput = Omit<Decision, 'id' | 'at'>;

export class MissionStore {
  private db: DatabaseSync;
  /** Injected so restart tests can assert timestamps survive, not just ids. */
  private now: () => number;

  constructor(outDir: string, now: () => number = () => Date.now()) {
    // The output directory usually exists by the time anyone has a mission to record, but
    // the first thing a fresh mission does must not be to fail on a missing folder.
    fs.mkdirSync(outDir, { recursive: true });
    this.db = openDaylightDb(path.join(outDir, DAYLIGHT_DB));
    this.now = now;
  }

  close(): void {
    this.db.close();
  }

  // ---- projects --------------------------------------------------------------

  ensureProject(p: ProjectIdentity): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, root, name, created_at) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET root=excluded.root, name=excluded.name`,
      )
      .run(p.id, p.root, p.name, this.now());
  }

  project(projectId: string): ProjectIdentity | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as
      | { id: string; root: string; name: string } | undefined;
    return r ? { id: r.id, root: r.root, name: r.name } : null;
  }

  // ---- missions --------------------------------------------------------------

  createMission(input: CreateMissionInput): Mission {
    if (!this.project(input.projectId)) {
      throw new Error(`unknown project ${input.projectId}; call ensureProject first`);
    }
    if (input.permissions?.write) {
      throw new Error(
        'a mission is created without write; only authorizeMission, a human authorize-mission ' +
          'decision, grants it',
      );
    }
    if (input.permissions?.deploy) throw new Error('deploy is never granted');
    if (input.kind === 'spec' && input.permissions?.execute) {
      throw new Error('a spec mission only decomposes; it never executes');
    }
    if (input.kind === 'implement') {
      if ((input.workItemId === undefined) === (input.adhoc === undefined)) {
        throw new Error(
          'an implement mission builds an approved work item, or names the human who decided it ' +
            'needs none (adhoc); exactly one of the two',
        );
      }
      if (input.adhoc && !isHumanActor(input.adhoc.actor)) {
        throw new Error(`an ad hoc implement mission needs a human:<name> actor, not ${input.adhoc.actor}`);
      }
    } else if (input.workItemId !== undefined || input.adhoc !== undefined) {
      throw new Error(`a ${input.kind} mission builds no work item`);
    }
    if (input.workItemId !== undefined) {
      const w = this.db.prepare('SELECT project_id, status FROM work_items WHERE id=?').get(input.workItemId) as
        | { project_id: string; status: string } | undefined;
      if (!w) throw new Error(`unknown work item ${input.workItemId}`);
      if (w.project_id !== input.projectId) {
        throw new Error(`work item ${input.workItemId} belongs to ${w.project_id}, not ${input.projectId}`);
      }
      if (w.status !== 'approved') {
        throw new Error(`work item ${input.workItemId} is ${w.status}; a mission builds only an approved one`);
      }
    }
    const at = this.now();
    const m: Mission = {
      id: newId('mission'),
      projectId: input.projectId,
      parentId: input.parentId,
      kind: input.kind,
      objective: input.objective,
      baseRevision: input.baseRevision,
      scope: normaliseScope(input.scope ?? {}),
      permissions: { ...DEFAULT_PERMISSIONS, ...input.permissions },
      budget: input.budget ?? {},
      requirementIds: input.requirementIds ?? [],
      acceptanceGateIds: input.acceptanceGateIds ?? [],
      workItemId: input.workItemId,
      state: 'draft',
      taskIds: [],
      createdAt: at,
      updatedAt: at,
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO missions
           (id, project_id, parent_id, kind, objective, base_revision, scope, permissions, budget,
            requirement_ids, acceptance_gate_ids, work_item_id, state, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          m.id, m.projectId, m.parentId ?? null, m.kind, m.objective, m.baseRevision,
          JSON.stringify(m.scope), JSON.stringify(m.permissions), JSON.stringify(m.budget),
          JSON.stringify(m.requirementIds), JSON.stringify(m.acceptanceGateIds),
          m.workItemId ?? null, m.state, m.createdAt, m.updatedAt,
        );
      if (input.adhoc) {
        this.recordDecision({
          missionId: m.id, projectId: m.projectId, revision: m.baseRevision,
          actor: input.adhoc.actor, kind: 'adhoc-mission', rationale: input.adhoc.rationale,
          scope: { operation: 'adhoc-mission', objective: m.objective }, artifactIds: [],
        });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.requireMission(m.id);
  }

  /**
   * Record a human's grant and apply it, in one transaction: the `authorize-mission`
   * decision, the mission's permissions and budget, and `draft → ready`.
   *
   * The only path to `write` (R7). Write is granted only to an implement mission, because a
   * review mission's read-only stance is the point of it; `deploy` is never granted in P1.
   */
  authorizeMission(input: AuthorizeMissionInput): { mission: Mission; decision: Decision } {
    const m = this.requireMission(input.missionId);
    if (m.state !== 'draft' && m.state !== 'ready') {
      throw new Error(`mission ${m.id} is ${m.state}; permissions are granted before it runs`);
    }
    if (input.permissions.write && m.kind !== 'implement') {
      throw new Error(`mission ${m.id} is ${m.kind}; write is granted only to an implement mission`);
    }
    if (input.maxUsd !== null && !(Number.isFinite(input.maxUsd) && input.maxUsd > 0)) {
      throw new Error(`mission ${m.id}: maxUsd must be a positive number or null`);
    }
    const permissions: MissionPermissions = {
      read: true, write: !!input.permissions.write, execute: !!input.permissions.execute, deploy: false,
    };
    const budget: MissionBudget = input.maxUsd === null ? m.budget : { ...m.budget, maxUsd: input.maxUsd };
    this.db.exec('BEGIN');
    try {
      const decision = this.recordDecision({
        missionId: m.id,
        projectId: m.projectId,
        revision: m.baseRevision,
        actor: input.actor,
        kind: 'approve',
        rationale: input.rationale,
        scope: { operation: 'authorize-mission', permissions, maxUsd: input.maxUsd },
        artifactIds: input.artifactIds ?? [],
      });
      this.db
        .prepare('UPDATE missions SET permissions=?, budget=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(permissions), JSON.stringify(budget), this.now(), m.id);
      const mission = m.state === 'draft' ? this.transitionMission(m.id, 'ready') : this.requireMission(m.id);
      this.db.exec('COMMIT');
      return { mission, decision };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  mission(missionId: string): Mission | null {
    const r = this.db.prepare('SELECT * FROM missions WHERE id=?').get(missionId);
    return r ? this.rowToMission(r) : null;
  }

  missions(projectId?: string): Mission[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM missions WHERE project_id=? ORDER BY created_at, id').all(projectId)
      : this.db.prepare('SELECT * FROM missions ORDER BY created_at, id').all();
    return rows.map((r) => this.rowToMission(r));
  }

  private requireMission(missionId: string): Mission {
    const m = this.mission(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    return m;
  }

  /**
   * Move a mission between states. `reason` is kept on the mission as `outcomeReason` only
   * for `blocked`, where it is the thing a person needs to read to unblock it.
   */
  transitionMission(missionId: string, to: MissionState, reason?: string): Mission {
    const m = this.requireMission(missionId);
    if (!canTransition(MISSION_TRANSITIONS, m.state, to)) {
      throw new IllegalTransition('mission', missionId, m.state, to);
    }
    if (to === 'closed') {
      throw new Error(`mission ${missionId}: use closeMission, which requires an outcome and a reason`);
    }
    this.db
      .prepare('UPDATE missions SET state=?, outcome_reason=?, updated_at=? WHERE id=?')
      .run(to, to === 'blocked' ? (reason ?? null) : null, this.now(), missionId);
    return this.requireMission(missionId);
  }

  /** The only path to `closed`. An outcome without a reason is refused. */
  closeMission(missionId: string, outcome: MissionOutcome, reason: string): Mission {
    const m = this.requireMission(missionId);
    if (!reason || !reason.trim()) {
      throw new Error(`mission ${missionId}: closing as ${outcome} needs a reason`);
    }
    if (!canTransition(MISSION_TRANSITIONS, m.state, 'closed')) {
      throw new IllegalTransition('mission', missionId, m.state, 'closed');
    }
    // An implement mission succeeds when its code is in a ref, not when a process exits 0.
    if (outcome === 'succeeded' && m.kind === 'implement') {
      const applied = this.db.prepare('SELECT 1 FROM applications WHERE mission_id=? LIMIT 1').get(missionId);
      if (!applied) {
        throw new Error(`mission ${missionId}: an implement mission succeeds only once a candidate is applied`);
      }
    }
    const at = this.now();
    this.db
      .prepare(
        `UPDATE missions SET state='closed', outcome=?, outcome_reason=?, updated_at=?, closed_at=?
         WHERE id=?`,
      )
      .run(outcome, reason.trim(), at, at, missionId);
    return this.requireMission(missionId);
  }

  // ---- tasks -----------------------------------------------------------------

  createTask(input: CreateTaskInput): Task {
    const m = this.requireMission(input.missionId);
    // A task carries its project so a query by project needs no join, which is exactly why
    // it must be the mission's project: a task filed under another project is the
    // cross-contamination the identity scheme exists to prevent.
    if (input.projectId !== undefined && input.projectId !== m.projectId) {
      throw new Error(
        `task for mission ${m.id} names project ${input.projectId}, but the mission belongs ` +
          `to ${m.projectId}`,
      );
    }
    if (m.kind === 'spec' && input.role !== 'decompose') {
      throw new Error(`mission ${m.id} is a spec mission; its only tasks are decompose tasks`);
    }
    for (const dep of input.dependsOn ?? []) {
      const d = this.task(dep);
      if (!d || d.missionId !== m.id) {
        throw new Error(`task dependency ${dep} is not a task of mission ${m.id}`);
      }
    }
    const at = this.now();
    const t: Task = {
      id: newId('task'),
      missionId: m.id,
      projectId: m.projectId,
      role: input.role,
      objective: input.objective,
      dependsOn: input.dependsOn ?? [],
      inputs: input.inputs ?? [],
      requiredOutputs: input.requiredOutputs ?? [],
      state: 'queued',
      runnerHint: input.runnerHint,
      attemptIds: [],
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, mission_id, project_id, role, objective, depends_on, inputs, required_outputs,
          state, runner_hint, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.id, t.missionId, t.projectId, t.role, t.objective, JSON.stringify(t.dependsOn),
        JSON.stringify(t.inputs), JSON.stringify(t.requiredOutputs), t.state,
        t.runnerHint ?? null, t.createdAt, t.updatedAt,
      );
    this.db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(at, m.id);
    return t;
  }

  task(taskId: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    return r ? this.rowToTask(r) : null;
  }

  tasks(missionId: string): Task[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE mission_id=? ORDER BY created_at, id')
      .all(missionId)
      .map((r) => this.rowToTask(r));
  }

  private requireTask(taskId: string): Task {
    const t = this.task(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    return t;
  }

  transitionTask(taskId: string, to: TaskState): Task {
    const t = this.requireTask(taskId);
    if (!canTransition(TASK_TRANSITIONS, t.state, to)) {
      throw new IllegalTransition('task', taskId, t.state, to);
    }
    const at = this.now();
    this.db.prepare('UPDATE tasks SET state=?, updated_at=? WHERE id=?').run(to, at, taskId);
    this.db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(at, t.missionId);
    return this.requireTask(taskId);
  }

  /** Queued tasks whose every dependency is done — what a scheduler may hand out now. */
  readyTasks(missionId: string): Task[] {
    const all = this.tasks(missionId);
    const done = new Set(all.filter((t) => t.state === 'done').map((t) => t.id));
    return all.filter((t) => t.state === 'queued' && t.dependsOn.every((d) => done.has(d)));
  }

  // ---- attempts --------------------------------------------------------------

  /**
   * Opens an attempt and moves its task to `running`, via `leased` when it was queued.
   *
   * One live attempt per task. A second one stacked on a task whose first never finished
   * (its process died) would leave the first `running` for ever and let whichever finishes
   * last decide the task; the dead one has to be cancelled first, which is what
   * `cancelRunningAttempts` is for.
   */
  startAttempt(input: StartAttemptInput): Attempt {
    let t = this.requireTask(input.taskId);
    const live = this.db
      .prepare(`SELECT id FROM attempts WHERE task_id=? AND state IN ('starting','running') LIMIT 1`)
      .get(t.id) as { id: string } | undefined;
    if (live) {
      throw new IllegalTransition('task', t.id, `running (attempt ${live.id} has not finished)`, 'a second attempt');
    }
    const origin: AttemptOrigin = input.origin ?? 'daylight';
    let sandbox: AttemptSandbox | null = null;
    if (origin === 'ingested') {
      if (input.sandbox !== undefined) throw new Error('an ingested attempt has no sandbox record; Daylight granted it nothing');
      if (this.requireMission(t.missionId).kind !== 'work') {
        throw new Error(`mission ${t.missionId} is not a work mission; only work missions hold ingested attempts`);
      }
    } else {
      sandbox = { ...READ_ONLY_SANDBOX, ...input.sandbox };
    }
    const why = attemptRefusal(
      { id: `on task ${t.id}`, missionId: t.missionId, origin, sandbox }, this.requireMission(t.missionId),
      sandbox?.authorizeDecisionId ? this.decision(sandbox.authorizeDecisionId) : null,
    );
    if (why) throw new Error(why);
    if (input.mcpToken !== undefined && input.mcpToken.length < 32) {
      throw new Error('an MCP token must be at least 32 characters of randomness');
    }
    if (input.credential) checkCredential(input.credential);
    if (input.parentAttemptId !== undefined) {
      const parent = this.attempt(input.parentAttemptId);
      if (!parent || parent.missionId !== t.missionId) {
        throw new Error(`parent attempt ${input.parentAttemptId} is not an attempt of mission ${t.missionId}`);
      }
    }
    if (t.state === 'queued') t = this.transitionTask(t.id, 'leased');
    if (t.state === 'leased') t = this.transitionTask(t.id, 'running');
    if (t.state !== 'running') {
      throw new IllegalTransition('task', t.id, t.state, 'running');
    }
    const at = input.at ?? this.now();
    const a: Attempt = {
      id: newId('attempt'),
      missionId: t.missionId,
      taskId: t.id,
      projectId: t.projectId,
      runnerId: input.runnerId,
      sessionId: input.sessionId,
      worktree: input.worktree,
      state: 'running',
      startedAt: at,
      costUsd: null,
      artifacts: [],
      tokens: { ...NO_TOKENS },
      usageSource: 'none',
      costSource: 'none',
      parentAttemptId: input.parentAttemptId,
      gateSetDigest: input.gateSetDigest,
      pid: input.pid,
      heartbeatAt: input.pid !== undefined ? at : undefined,
      origin,
      sandbox,
      credential: input.credential,
      mcpTokenDigest: input.mcpToken !== undefined ? digestOf(input.mcpToken) : undefined,
    };
    this.db
      .prepare(
        `INSERT INTO attempts
         (id, mission_id, task_id, project_id, runner_id, session_id, worktree, state,
          started_at, cost_usd, timed_out, artifacts, parent_attempt_id, gate_set_digest, pid,
          heartbeat_at, origin, sandbox_profile, sandbox_network, sandbox_write, sandbox_exec,
          authorize_decision_id, credential, mcp_token_digest)
         VALUES (?,?,?,?,?,?,?,?,?,NULL,0,'[]',?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        a.id, a.missionId, a.taskId, a.projectId, a.runnerId, a.sessionId ?? null,
        a.worktree ?? null, a.state, a.startedAt, a.parentAttemptId ?? null,
        a.gateSetDigest ?? null, a.pid ?? null, a.heartbeatAt ?? null, origin,
        ...sandboxColumns(sandbox), a.credential ? JSON.stringify(a.credential) : null,
        a.mcpTokenDigest ?? null,
      );
    return a;
  }

  /**
   * The live attempt an MCP token belongs to, or null. A token dies with its attempt: once
   * the attempt has finished, the same token finds nothing.
   */
  attemptByMcpToken(token: string): Attempt | null {
    const r = this.db
      .prepare(`SELECT * FROM attempts WHERE mcp_token_digest=? AND state IN ('starting','running')`)
      .get(digestOf(token));
    return r ? this.rowToAttempt(r) : null;
  }

  /** The runner is alive. A no-op on an attempt that has already finished. */
  heartbeat(attemptId: string, at: number = this.now()): void {
    this.db
      .prepare(`UPDATE attempts SET heartbeat_at=? WHERE id=? AND state IN ('starting','running')`)
      .run(at, attemptId);
  }

  /**
   * The R7 invariant as a query: attempts recorded with write whose grant is missing, is not an
   * approving `authorize-mission` decision of their own mission, or did not grant write. Empty
   * is the only acceptable answer; the store refuses to create one, and this is what checks it.
   */
  unauthorizedWriteAttempts(projectId?: string): Attempt[] {
    const rows = this.db
      .prepare(`SELECT * FROM attempts WHERE sandbox_write != 0 ${projectId ? 'AND project_id=?' : ''} ORDER BY started_at, id`)
      .all(...(projectId ? [projectId] : []));
    return rows.map((r) => this.rowToAttempt(r)).filter((a) => {
      const grant = a.sandbox?.authorizeDecisionId ?? null;
      const d = grant !== null ? this.decision(grant) : null;
      return !grantsWrite(d, a.missionId);
    });
  }

  /**
   * Record how an attempt ended. The task follows — done on completion, failed otherwise —
   * and the mission does not move at all. Whether the mission succeeded is a question about
   * its acceptance gates, answered elsewhere and recorded by `closeMission`.
   */
  finishAttempt(attemptId: string, result: FinishAttemptInput): Attempt {
    const a = this.requireAttempt(attemptId);
    if (!canTransition(ATTEMPT_TRANSITIONS, a.state, result.state)) {
      throw new IllegalTransition('attempt', attemptId, a.state, result.state);
    }
    const at = result.at ?? this.now();
    // One transaction: a crash between the attempt row and its task would leave the attempt
    // finished and the task running, which no later run can tell from a live attempt.
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE attempts SET state=?, finished_at=?, cost_usd=?, cost_source=?, exit_code=?,
             signal=?, timed_out=?, failure=?, artifacts=?, model=COALESCE(?, model),
             input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=?,
             usage_source=?
           WHERE id=?`,
        )
        .run(
          result.state, at, result.costUsd,
          // An unlabelled figure keeps P0's meaning, the runner's own report. Scraped figures
          // must say `stdout-scan`; the CHECK refuses a cost labelled `none`.
          result.costSource ?? (result.costUsd === null ? 'none' : 'provider'),
          result.exitCode ?? null, result.signal ?? null,
          result.timedOut ? 1 : 0, result.failure ?? null,
          JSON.stringify(result.artifacts ?? []), result.model ?? null,
          ...tokenColumns(result.tokens ?? a.tokens), result.usageSource ?? a.usageSource, attemptId,
        );
      for (const ref of result.artifacts ?? []) this.recordArtifact(ref);

      const t = this.requireTask(a.taskId);
      if (t.state === 'running') {
        this.transitionTask(t.id, result.state === 'completed' ? 'done' : 'failed');
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.requireAttempt(attemptId);
  }

  /**
   * Cancel every attempt of a mission that is still marked live, with `failure` as the reason,
   * failing their tasks so they can be retried. For attempts whose owning process is known to
   * be gone; the caller decides that, this only records it.
   */
  cancelRunningAttempts(missionId: string, failure: string): Attempt[] {
    const ids = (
      this.db
        .prepare(`SELECT id FROM attempts WHERE mission_id=? AND state IN ('starting','running') ORDER BY started_at, id`)
        .all(missionId) as Array<{ id: string }>
    ).map((r) => r.id);
    return ids.map((id) => this.finishAttempt(id, { state: 'cancelled', costUsd: null, failure }));
  }

  attempt(attemptId: string): Attempt | null {
    const r = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(attemptId);
    return r ? this.rowToAttempt(r) : null;
  }

  attempts(taskId: string): Attempt[] {
    return this.db
      .prepare('SELECT * FROM attempts WHERE task_id=? ORDER BY started_at, id')
      .all(taskId)
      .map((r) => this.rowToAttempt(r));
  }

  /** The attempt a `DAYLIGHT_SESSION` belongs to, which is how an MCP event finds its attempt. */
  attemptBySession(sessionId: string): Attempt | null {
    const r = this.db
      .prepare('SELECT * FROM attempts WHERE session_id=? ORDER BY started_at DESC LIMIT 1')
      .get(sessionId);
    return r ? this.rowToAttempt(r) : null;
  }

  private requireAttempt(attemptId: string): Attempt {
    const a = this.attempt(attemptId);
    if (!a) throw new Error(`unknown attempt ${attemptId}`);
    return a;
  }

  // ---- artifacts -------------------------------------------------------------

  /** Idempotent: an artifact id is its digest, so recording it twice is one row. */
  recordArtifact(ref: ArtifactRef): void {
    this.db
      .prepare(
        `INSERT INTO artifacts
         (id, kind, digest, project_id, revision, path, label, bytes, media_type, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        ref.id, ref.kind, ref.digest, ref.projectId, ref.revision ?? null, ref.path ?? null,
        ref.label ?? null, ref.bytes ?? null, ref.mediaType ?? null, this.now(),
      );
  }

  artifact(artifactId: string): ArtifactRef | null {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactId) as
      | Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      kind: r.kind as ArtifactKind,
      digest: r.digest as string,
      projectId: r.project_id as string,
      revision: (r.revision as string | null) ?? undefined,
      path: (r.path as string | null) ?? undefined,
      label: (r.label as string | null) ?? undefined,
      bytes: (r.bytes as number | null) ?? undefined,
      mediaType: (r.media_type as string | null) ?? undefined,
    };
  }

  // ---- experiments -----------------------------------------------------------

  createExperiment(input: CreateExperimentInput): Experiment {
    const m = this.requireMission(input.missionId);
    if (input.projectId !== m.projectId) {
      throw new Error(
        `experiment for mission ${m.id} names project ${input.projectId}, but the mission ` +
          `belongs to ${m.projectId}`,
      );
    }
    const role: ExperimentRole = input.role ?? 'probe';
    if (!EXPERIMENT_ROLES.includes(role)) {
      throw new Error(`experiment role must be one of ${EXPERIMENT_ROLES.join(', ')}, not ${String(role)}`);
    }
    if (input.id !== undefined && !isEntityId('experiment', input.id)) {
      throw new Error(`${input.id} is not an experiment id; mint one with newId('experiment')`);
    }
    const at = this.now();
    const x: Experiment = {
      ...input,
      role,
      id: input.id ?? newId('experiment'),
      executions: [],
      conclusion: 'pending',
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO experiments
         (id, mission_id, project_id, claim_ids, subject, predicate, hypothesis, prediction,
          base_revision, test_artifact, expected_artifact, harness_digest, command,
          sandbox_profile, executions, conclusion, limitations, role, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        x.id, x.missionId, x.projectId, JSON.stringify(x.claimIds), x.subject, x.predicate,
        x.hypothesis, JSON.stringify(x.prediction), x.baseRevision,
        JSON.stringify(x.testArtifact), JSON.stringify(x.expectedArtifact), x.harnessDigest,
        JSON.stringify(x.command), x.sandboxProfile, '[]', x.conclusion,
        JSON.stringify(x.limitations), x.role, x.createdAt, x.updatedAt,
      );
    this.recordArtifact(x.testArtifact);
    this.recordArtifact(x.expectedArtifact);
    return x;
  }

  updateExperiment(
    experimentId: string,
    patch: { executions?: ArtifactRef[]; conclusion?: ExperimentConclusion; limitations?: string[] },
  ): Experiment {
    const x = this.experiment(experimentId);
    if (!x) throw new Error(`unknown experiment ${experimentId}`);
    const next: Experiment = {
      ...x,
      executions: patch.executions ?? x.executions,
      conclusion: patch.conclusion ?? x.conclusion,
      limitations: patch.limitations ?? x.limitations,
      updatedAt: this.now(),
    };
    this.db
      .prepare('UPDATE experiments SET executions=?, conclusion=?, limitations=?, updated_at=? WHERE id=?')
      .run(
        JSON.stringify(next.executions), next.conclusion, JSON.stringify(next.limitations),
        next.updatedAt, experimentId,
      );
    for (const ref of patch.executions ?? []) this.recordArtifact(ref);
    return next;
  }

  experiment(experimentId: string): Experiment | null {
    const r = this.db.prepare('SELECT * FROM experiments WHERE id=?').get(experimentId);
    return r ? this.rowToExperiment(r) : null;
  }

  experiments(missionId: string): Experiment[] {
    return this.db
      .prepare('SELECT * FROM experiments WHERE mission_id=? ORDER BY created_at, id')
      .all(missionId)
      .map((r) => this.rowToExperiment(r));
  }

  experimentsFor(missionId: string, role?: ExperimentRole): Experiment[] {
    return this.experiments(missionId).filter((x) => role === undefined || x.role === role);
  }

  /** A run is starting now. What the row-side reaper measures from. */
  markExperimentStarted(experimentId: string, at: number = this.now()): void {
    const r = this.db.prepare('UPDATE experiments SET started_at=? WHERE id=?').run(at, experimentId);
    if (!r.changes) throw new Error(`unknown experiment ${experimentId}`);
  }

  /**
   * Conclude, as invalid, this project's pending experiments whose last run started before
   * `startedBefore` and that `isLive` (when given) does not vouch for.
   *
   * The scratch-dir sweep only sees the current `/tmp`; a runner killed before a reboot
   * leaves a pending row nothing else will ever conclude. Rows that never started are left
   * alone: pending-and-never-run is a registered experiment, not a dead one.
   */
  reapPendingExperiments(opts: {
    projectId: string; startedBefore: number; isLive?: (experimentId: string) => boolean;
  }): Experiment[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM experiments WHERE project_id=? AND conclusion='pending'
         AND started_at IS NOT NULL AND started_at < ? ORDER BY started_at, id`,
      )
      .all(opts.projectId, opts.startedBefore) as Array<{ id: string }>;
    const reaped: Experiment[] = [];
    for (const { id } of rows) {
      if (opts.isLive?.(id)) continue;
      const x = this.experiment(id)!;
      reaped.push(this.updateExperiment(id, {
        conclusion: 'invalid', limitations: [...x.limitations, 'runner died: found pending by the row-side reaper'],
      }));
    }
    return reaped;
  }

  /**
   * `gate lock`, as one transaction: compute the gate-set digest from the experiments' own
   * harness digests, record the human's `lock-gates` decision naming it, stamp `locked_by` on
   * every gate and holdout, and make the mission's `acceptanceGateIds` exactly that set. A
   * lock is never half-written, and nothing but these rows decides what the digest covers.
   */
  lockGates(missionId: string, input: LockGatesInput): { mission: Mission; decision: Decision; gateSetDigest: string } {
    const m = this.requireMission(missionId);
    const ids = [...new Set(input.experimentIds)].sort();
    if (!ids.length) throw new Error(`mission ${m.id}: a gate lock names at least one gate`);
    const experiments = ids.map((id) => {
      const x = this.experiment(id);
      if (!x || x.missionId !== m.id) throw new Error(`experiment ${id} is not an experiment of mission ${m.id}`);
      if (x.role === 'probe') throw new Error(`experiment ${id} is a probe; only gates and holdouts are locked`);
      return x;
    });
    const vacuous = [...new Set(input.vacuousOverrides ?? [])].sort();
    for (const id of vacuous) {
      if (!ids.includes(id)) throw new Error(`vacuous override ${id} is not one of the gates being locked`);
    }
    const gateSetDigest = gateSetDigestOf(experiments);
    const at = this.now();
    this.db.exec('BEGIN');
    try {
      const decision = this.recordDecision({
        missionId: m.id, projectId: m.projectId, revision: m.baseRevision, actor: input.actor,
        kind: 'approve', rationale: input.rationale,
        scope: {
          operation: 'lock-gates', experimentIds: ids,
          harnessDigests: Object.fromEntries(experiments.map((x) => [x.id, x.harnessDigest])),
          gateSetDigest, vacuousOverrides: vacuous,
        },
        artifactIds: input.artifactIds ?? [],
      });
      const lock = this.db.prepare('UPDATE experiments SET locked_by=?, updated_at=? WHERE id=?');
      for (const id of ids) lock.run(decision.id, at, id);
      this.db
        .prepare('UPDATE missions SET acceptance_gate_ids=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(ids), at, m.id);
      this.db.exec('COMMIT');
      return { mission: this.requireMission(m.id), decision, gateSetDigest };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The most recent approving `lock-gates` decision of a mission, or null. */
  lockDecision(missionId: string): Decision | null {
    return this.latestOperation(missionId, 'lock-gates');
  }

  /** The most recent approving `authorize-mission` decision of a mission, or null. */
  authorizeDecision(missionId: string): Decision | null {
    return this.latestOperation(missionId, 'authorize-mission');
  }

  private latestOperation(missionId: string, operation: DecisionOperation): Decision | null {
    const all = this.decisions(missionId).filter((d) => d.kind === 'approve' && d.scope.operation === operation);
    return all.at(-1) ?? null;
  }

  // ---- usage -------------------------------------------------------------------

  /**
   * One provider turn. A turn whose request id is already recorded for the attempt is the
   * same turn seen again (providers split one message's usage across lines): its counts are
   * MAX-merged into the existing row, and a line that adds nothing is a duplicate. Attempt
   * totals are not touched; the capture that owns the attempt writes them in `finishAttempt`.
   */
  recordUsage(attemptId: string, turn: RecordUsageInput): { result: UsageRecordResult; seq: number } {
    const a = this.requireAttempt(attemptId);
    if (turn.costSource === 'none' && turn.costUsd !== null) {
      throw new Error(`usage on attempt ${attemptId}: a cost with source none is not a cost`);
    }
    const at = turn.at ?? this.now();
    this.db.exec('BEGIN');
    try {
      const existing = turn.requestId === null ? undefined : this.db
        .prepare('SELECT * FROM attempt_usage WHERE attempt_id=? AND request_id=?')
        .get(attemptId, turn.requestId) as Record<string, unknown> | undefined;
      let out: { result: UsageRecordResult; seq: number };
      if (existing) {
        const was = rowToUsage(existing);
        const tokens: TokenUsage = {
          input: maxOf(was.tokens.input, turn.tokens.input),
          output: maxOf(was.tokens.output, turn.tokens.output),
          cacheRead: maxOf(was.tokens.cacheRead, turn.tokens.cacheRead),
          cacheWrite: maxOf(was.tokens.cacheWrite, turn.tokens.cacheWrite),
        };
        const costUsd = maxOf(was.costUsd, turn.costUsd);
        const costSource = was.costSource === 'provider' || turn.costSource === 'provider' ? 'provider'
          : costUsd === null ? 'none' : 'stdout-scan';
        const model = was.model ?? turn.model;
        const same = canonical(tokens) === canonical(was.tokens) && costUsd === was.costUsd
          && costSource === was.costSource && model === was.model;
        if (!same) {
          this.db
            .prepare(
              `UPDATE attempt_usage SET input_tokens=?, output_tokens=?, cache_read_tokens=?,
                 cache_write_tokens=?, cost_usd=?, cost_source=?, model=?
               WHERE attempt_id=? AND seq=?`,
            )
            .run(...tokenColumns(tokens), costUsd, costSource, model, attemptId, was.seq);
        }
        out = { result: same ? 'duplicate' : 'merged', seq: was.seq };
      } else {
        const seq = ((this.db.prepare('SELECT MAX(seq) AS n FROM attempt_usage WHERE attempt_id=?').get(attemptId) as
          { n: number | null }).n ?? 0) + 1;
        this.db
          .prepare(
            `INSERT INTO attempt_usage
             (attempt_id, project_id, seq, request_id, at, model, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd, cost_source, source)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            attemptId, a.projectId, seq, turn.requestId, at, turn.model, ...tokenColumns(turn.tokens),
            turn.costUsd, turn.costSource, turn.source,
          );
        out = { result: 'inserted', seq };
      }
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  usageRows(attemptId: string): UsageTurn[] {
    return (this.db.prepare('SELECT * FROM attempt_usage WHERE attempt_id=? ORDER BY seq').all(attemptId) as
      Array<Record<string, unknown>>).map(rowToUsage);
  }

  /** Per-field sums over an attempt's turns. A field no turn reported stays null, never 0. */
  usageTotals(attemptId: string): TokenUsage {
    const sum = (f: keyof TokenUsage) => {
      const vals = this.usageRows(attemptId).map((u) => u.tokens[f]).filter((v): v is number => v !== null);
      return vals.length ? vals.reduce((x, y) => x + y, 0) : null;
    };
    return { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') };
  }

  /** Every attempt of a project, oldest first: the ledger's one join (Ledger L11). */
  projectAttempts(projectId: string, opts: { since?: number } = {}): Attempt[] {
    return this.db
      .prepare('SELECT * FROM attempts WHERE project_id=? AND started_at >= ? ORDER BY started_at, id')
      .all(projectId, opts.since ?? 0)
      .map((r) => this.rowToAttempt(r));
  }

  // ---- work items ----------------------------------------------------------------

  /**
   * File a proposed work item. Idempotent on `id`: the same id with the same content returns
   * the row already here, and with different content is refused.
   */
  createWorkItem(input: CreateWorkItemInput): WorkItem {
    const m = this.requireMission(input.missionId);
    if (m.projectId !== input.projectId) {
      throw new Error(`work item for mission ${m.id} names project ${input.projectId}, but the mission belongs to ${m.projectId}`);
    }
    if (input.specArtifact.projectId !== input.projectId) {
      throw new Error(`work item spec ${input.specArtifact.id} belongs to ${input.specArtifact.projectId}, not ${input.projectId}`);
    }
    if (input.attemptId !== undefined) {
      const a = this.attempt(input.attemptId);
      if (!a || a.missionId !== m.id) throw new Error(`attempt ${input.attemptId} is not an attempt of mission ${m.id}`);
    }
    if (input.id !== undefined && !isEntityId('workItem', input.id)) {
      throw new Error(`${input.id} is not a work item id`);
    }
    const contentDigest = workItemContentDigest(input);
    if (input.id !== undefined) {
      const have = this.workItem(input.id);
      if (have) {
        if (have.contentDigest !== contentDigest || have.projectId !== input.projectId || have.missionId !== m.id) {
          throw new Error(`work item ${input.id} is already recorded with different content`);
        }
        return have;
      }
    }
    const at = this.now();
    const w: WorkItem = {
      id: input.id ?? newId('workItem'),
      projectId: input.projectId,
      missionId: m.id,
      attemptId: input.attemptId,
      proposalArtifact: input.proposalArtifact,
      contentDigest,
      specArtifact: input.specArtifact,
      specRevision: input.specRevision,
      anchor: input.anchor,
      title: input.title,
      statement: input.statement,
      examples: input.examples,
      negativeExamples: input.negativeExamples,
      status: 'proposed',
      proposedBy: input.proposedBy,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO work_items
         (id, project_id, mission_id, attempt_id, proposal_artifact, content_digest, spec_artifact,
          spec_revision, anchor, title, statement, examples, negative_examples, status, proposed_by,
          decision_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
      )
      .run(
        w.id, w.projectId, w.missionId, w.attemptId ?? null,
        w.proposalArtifact ? JSON.stringify(w.proposalArtifact) : null, w.contentDigest,
        JSON.stringify(w.specArtifact), w.specRevision, w.anchor, w.title, w.statement,
        JSON.stringify(w.examples), JSON.stringify(w.negativeExamples), w.status, w.proposedBy,
        w.createdAt, w.updatedAt,
      );
    this.recordArtifact(w.specArtifact);
    if (w.proposalArtifact) this.recordArtifact(w.proposalArtifact);
    return w;
  }

  workItem(workItemId: string): WorkItem | null {
    const r = this.db.prepare('SELECT * FROM work_items WHERE id=?').get(workItemId);
    return r ? rowToWorkItem(r) : null;
  }

  workItems(projectId: string, opts: { missionId?: string; status?: WorkItemStatus } = {}): WorkItem[] {
    return (this.db.prepare('SELECT * FROM work_items WHERE project_id=? ORDER BY created_at, id').all(projectId))
      .map(rowToWorkItem)
      .filter((w) => (opts.missionId === undefined || w.missionId === opts.missionId)
        && (opts.status === undefined || w.status === opts.status));
  }

  /**
   * Move a work item, compare-and-set: refused unless it is `from` now. Every move needs a
   * human decision naming this item and the content digest it was approved or rejected as:
   * `approve-work-item` to approve, `reject-work-item` to reject or supersede.
   */
  setWorkItemStatus(workItemId: string, from: WorkItemStatus, to: WorkItemStatus, decisionId: string): WorkItem {
    const w = this.workItem(workItemId);
    if (!w) throw new Error(`unknown work item ${workItemId}`);
    if (w.status !== from) throw new IllegalTransition('work item', workItemId, `${w.status} (expected ${from})`, to);
    if (!canTransition(WORK_ITEM_TRANSITIONS, from, to)) throw new IllegalTransition('work item', workItemId, from, to);
    const d = this.decision(decisionId);
    const scope = d?.scope as { operation?: unknown; workItemId?: unknown; contentDigest?: unknown } | undefined;
    const operation = to === 'approved' ? 'approve-work-item' : 'reject-work-item';
    if (!d || d.projectId !== w.projectId || scope?.operation !== operation || scope.workItemId !== w.id
      || scope.contentDigest !== w.contentDigest) {
      throw new Error(`decision ${decisionId} is not a ${operation} decision naming ${w.id} at ${w.contentDigest}`);
    }
    const r = this.db
      .prepare('UPDATE work_items SET status=?, decision_id=?, updated_at=? WHERE id=? AND status=?')
      .run(to, d.id, this.now(), w.id, from);
    if (!r.changes) throw new IllegalTransition('work item', workItemId, 'changed underneath', to);
    return this.workItem(w.id)!;
  }

  // ---- candidates ------------------------------------------------------------------

  createCandidate(input: CreateCandidateInput): Candidate {
    const a = this.requireAttempt(input.attemptId);
    if (a.missionId !== input.missionId) {
      throw new Error(`attempt ${a.id} is not an attempt of mission ${input.missionId}`);
    }
    if (a.projectId !== input.projectId) {
      throw new Error(`candidate names project ${input.projectId}, but attempt ${a.id} belongs to ${a.projectId}`);
    }
    for (const ref of [input.diffArtifact, input.summaryArtifact, input.narrativeArtifact]) {
      if (ref && ref.projectId !== input.projectId) {
        throw new Error(`artifact ${ref.id} belongs to ${ref.projectId}, not ${input.projectId}`);
      }
    }
    const c: Candidate = {
      ...input,
      id: newId('candidate'),
      verdict: 'pending',
      verdictReasons: [],
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO candidates
         (id, mission_id, attempt_id, project_id, base_commit, diff_artifact, summary_artifact,
          narrative_artifact, files, policy_violations, secret_hits, gate_set_digest, profile,
          attempt_state, attempt_failure, verdict, verdict_reasons, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.id, c.missionId, c.attemptId, c.projectId, c.baseCommit, JSON.stringify(c.diffArtifact),
        JSON.stringify(c.summaryArtifact), c.narrativeArtifact ? JSON.stringify(c.narrativeArtifact) : null,
        JSON.stringify(c.files), JSON.stringify(c.policyViolations), c.secretHits, c.gateSetDigest,
        JSON.stringify(c.profile), c.attemptState, c.attemptFailure ?? null, c.verdict,
        JSON.stringify(c.verdictReasons), c.createdAt,
      );
    for (const ref of [c.diffArtifact, c.summaryArtifact, c.narrativeArtifact]) if (ref) this.recordArtifact(ref);
    return c;
  }

  candidate(candidateId: string): Candidate | null {
    const r = this.db.prepare('SELECT * FROM candidates WHERE id=?').get(candidateId);
    return r ? rowToCandidate(r) : null;
  }

  candidates(missionId: string): Candidate[] {
    return this.db
      .prepare('SELECT * FROM candidates WHERE mission_id=? ORDER BY created_at, id')
      .all(missionId)
      .map(rowToCandidate);
  }

  /** The verdict is computed elsewhere, from rows; this only records it. */
  updateCandidateVerdict(candidateId: string, verdict: CandidateVerdict, reasons: string[]): Candidate {
    const r = this.db
      .prepare('UPDATE candidates SET verdict=?, verdict_reasons=? WHERE id=?')
      .run(verdict, JSON.stringify(reasons), candidateId);
    if (!r.changes) throw new Error(`unknown candidate ${candidateId}`);
    return this.candidate(candidateId)!;
  }

  // ---- gate evaluations --------------------------------------------------------------

  recordGateEvaluation(input: CreateGateEvaluationInput): GateEvaluation {
    const m = this.requireMission(input.missionId);
    const x = this.experiment(input.experimentId);
    if (!x || x.missionId !== m.id) throw new Error(`experiment ${input.experimentId} is not an experiment of mission ${m.id}`);
    if (input.projectId !== m.projectId) {
      throw new Error(`gate evaluation names project ${input.projectId}, but mission ${m.id} belongs to ${m.projectId}`);
    }
    if (input.target === 'base' && (input.candidateId !== undefined || input.diffDigest !== null)) {
      throw new Error('a base evaluation names no candidate and no diff');
    }
    if (input.target === 'candidate') {
      const c = input.candidateId ? this.candidate(input.candidateId) : null;
      if (!c || c.missionId !== m.id) throw new Error(`candidate ${String(input.candidateId)} is not a candidate of mission ${m.id}`);
      if (input.diffDigest !== c.diffArtifact.digest) {
        throw new Error(`gate evaluation diff ${String(input.diffDigest)} is not candidate ${c.id}'s diff ${c.diffArtifact.digest}`);
      }
    }
    const g: GateEvaluation = { ...input, id: newId('gateEvaluation'), createdAt: this.now() };
    this.db
      .prepare(
        `INSERT INTO gate_evaluations
         (id, mission_id, project_id, revision, experiment_id, candidate_id, target, diff_digest,
          harness_digest, executions, conclusion, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        g.id, g.missionId, g.projectId, g.revision, g.experimentId, g.candidateId ?? null, g.target,
        g.diffDigest, g.harnessDigest, JSON.stringify(g.executions), g.conclusion, g.createdAt,
      );
    for (const ref of g.executions) this.recordArtifact(ref);
    return g;
  }

  gateEvaluations(filter: { missionId?: string; candidateId?: string; target?: GateTarget }): GateEvaluation[] {
    if (filter.missionId === undefined && filter.candidateId === undefined) {
      throw new Error('gateEvaluations needs a missionId or a candidateId');
    }
    const where: string[] = [];
    const args: string[] = [];
    if (filter.missionId !== undefined) { where.push('mission_id=?'); args.push(filter.missionId); }
    if (filter.candidateId !== undefined) { where.push('candidate_id=?'); args.push(filter.candidateId); }
    if (filter.target !== undefined) { where.push('target=?'); args.push(filter.target); }
    return this.db
      .prepare(`SELECT * FROM gate_evaluations WHERE ${where.join(' AND ')} ORDER BY created_at, id`)
      .all(...args)
      .map(rowToGateEvaluation);
  }

  // ---- applications ------------------------------------------------------------------

  /**
   * Record that a candidate was committed. Refused unless a human approved or overrode this
   * exact diff of this candidate, on its mission; one application per candidate.
   */
  recordApplication(input: CreateApplicationInput): Application {
    const c = this.candidate(input.candidateId);
    if (!c) throw new Error(`unknown candidate ${input.candidateId}`);
    const d = this.decision(input.decisionId);
    const scope = d?.scope as { operation?: unknown; candidateId?: unknown; diffDigest?: unknown } | undefined;
    const approving = (d?.kind === 'approve' && scope?.operation === 'approve-candidate')
      || (d?.kind === 'override' && scope?.operation === 'override-candidate');
    if (!d || !approving || d.missionId !== c.missionId || scope?.candidateId !== c.id
      || scope.diffDigest !== c.diffArtifact.digest) {
      throw new Error(`decision ${input.decisionId} does not approve candidate ${c.id} at ${c.diffArtifact.digest}`);
    }
    if (input.baseCommit !== c.baseCommit) {
      throw new Error(`application base ${input.baseCommit} is not candidate ${c.id}'s base ${c.baseCommit}`);
    }
    if (!isHumanActor(input.appliedBy)) throw new Error(`apply needs a human:<name> actor, not ${input.appliedBy}`);
    if (this.application(c.id)) throw new Error(`candidate ${c.id} is already applied`);
    const p: Application = {
      id: newId('application'),
      candidateId: c.id,
      missionId: c.missionId,
      decisionId: d.id,
      projectId: c.projectId,
      baseCommit: input.baseCommit,
      commit: input.commit,
      ref: input.ref,
      appliedBy: input.appliedBy,
      at: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO applications
         (id, candidate_id, mission_id, decision_id, project_id, base_commit, commit_sha, ref, applied_by, at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(p.id, p.candidateId, p.missionId, p.decisionId, p.projectId, p.baseCommit, p.commit, p.ref, p.appliedBy, p.at);
    return p;
  }

  application(candidateId: string): Application | null {
    const r = this.db.prepare('SELECT * FROM applications WHERE candidate_id=?').get(candidateId);
    return r ? rowToApplication(r) : null;
  }

  applications(missionId: string): Application[] {
    return this.db
      .prepare('SELECT * FROM applications WHERE mission_id=? ORDER BY at, id')
      .all(missionId)
      .map(rowToApplication);
  }

  // ---- ingest sources ----------------------------------------------------------------

  /**
   * Upsert how far one transcript (a session's main thread or one subagent) has been read.
   * A session stays with the first project it was ingested into.
   */
  recordIngestSource(s: IngestSource): IngestSource {
    const a = this.requireAttempt(s.attemptId);
    if (a.missionId !== s.missionId || a.projectId !== s.projectId) {
      throw new Error(`ingest source for ${s.sessionId} names attempt ${a.id}, which is not of mission ${s.missionId} in ${s.projectId}`);
    }
    if (a.origin !== 'ingested') throw new Error(`attempt ${a.id} was run by Daylight, not ingested`);
    const elsewhere = this.db
      .prepare('SELECT project_id FROM ingest_sources WHERE session_id=? AND project_id<>? LIMIT 1')
      .get(s.sessionId, s.projectId) as { project_id: string } | undefined;
    if (elsewhere) {
      throw new Error(`session ${s.sessionId} was ingested into project ${elsewhere.project_id}, not ${s.projectId}`);
    }
    this.db
      .prepare(
        `INSERT INTO ingest_sources
         (session_id, agent_id, project_id, path_digest, prefix_digest, bytes_seen, lines_seen,
          mission_id, attempt_id, ingested_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, agent_id) DO UPDATE SET path_digest=excluded.path_digest,
           prefix_digest=excluded.prefix_digest, bytes_seen=excluded.bytes_seen,
           lines_seen=excluded.lines_seen, mission_id=excluded.mission_id,
           attempt_id=excluded.attempt_id, ingested_at=excluded.ingested_at`,
      )
      .run(
        s.sessionId, s.agentId, s.projectId, s.pathDigest, s.prefixDigest, s.bytesSeen, s.linesSeen,
        s.missionId, s.attemptId, s.ingestedAt,
      );
    return this.ingestSource(s.sessionId, s.agentId)!;
  }

  /** `agentId` is `''` for the session's main transcript. */
  ingestSource(sessionId: string, agentId = ''): IngestSource | null {
    const r = this.db.prepare('SELECT * FROM ingest_sources WHERE session_id=? AND agent_id=?').get(sessionId, agentId) as
      | Record<string, unknown> | undefined;
    return r ? rowToIngestSource(r) : null;
  }

  ingestSources(projectId: string, opts: { missionId?: string } = {}): IngestSource[] {
    const rows = opts.missionId === undefined
      ? this.db.prepare('SELECT * FROM ingest_sources WHERE project_id=? ORDER BY session_id, agent_id').all(projectId)
      : this.db.prepare('SELECT * FROM ingest_sources WHERE project_id=? AND mission_id=? ORDER BY session_id, agent_id')
        .all(projectId, opts.missionId);
    return (rows as Array<Record<string, unknown>>).map(rowToIngestSource);
  }

  // ---- decisions -------------------------------------------------------------

  recordDecision(input: CreateDecisionInput): Decision {
    const m = this.requireMission(input.missionId);
    if (input.projectId !== m.projectId) {
      throw new Error(
        `decision for mission ${m.id} names project ${input.projectId}, but the mission ` +
          `belongs to ${m.projectId}`,
      );
    }
    if (!input.rationale || !input.rationale.trim()) {
      throw new Error(`decision on mission ${m.id} needs a rationale`);
    }
    const refusal = decisionRefusal({ ...input, id: `on mission ${m.id}` });
    if (refusal) throw new Error(refusal);
    const d: Decision = { ...input, id: newId('decision'), at: this.now() };
    this.db
      .prepare(
        `INSERT INTO decisions
         (id, mission_id, project_id, revision, actor, kind, subject, predicate, value,
          rationale, scope, artifact_ids, at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        d.id, d.missionId, d.projectId, d.revision, d.actor, d.kind, d.subject ?? null,
        d.predicate ?? null, d.value === undefined ? null : JSON.stringify(d.value),
        d.rationale, JSON.stringify(d.scope), JSON.stringify(d.artifactIds), d.at,
      );
    this.db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(d.at, m.id);
    return d;
  }

  decision(decisionId: string): Decision | null {
    const r = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(decisionId);
    return r ? this.rowToDecision(r) : null;
  }

  decisions(missionId: string): Decision[] {
    return this.db
      .prepare('SELECT * FROM decisions WHERE mission_id=? ORDER BY at, id')
      .all(missionId)
      .map((r) => this.rowToDecision(r));
  }

  // ---- rows ------------------------------------------------------------------

  private rowToMission(row: unknown): Mission {
    const r = row as Record<string, unknown>;
    const taskIds = (
      this.db.prepare('SELECT id FROM tasks WHERE mission_id=? ORDER BY created_at, id').all(r.id as string) as Array<{ id: string }>
    ).map((t) => t.id);
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      parentId: (r.parent_id as string | null) ?? undefined,
      kind: r.kind as MissionKind,
      objective: r.objective as string,
      baseRevision: r.base_revision as string,
      scope: parseJson<MissionScope>(r.scope as string, {}),
      permissions: parseJson<MissionPermissions>(r.permissions as string, DEFAULT_PERMISSIONS),
      budget: parseJson<MissionBudget>(r.budget as string, {}),
      requirementIds: parseJson<string[]>(r.requirement_ids as string, []),
      acceptanceGateIds: parseJson<string[]>(r.acceptance_gate_ids as string, []),
      workItemId: (r.work_item_id as string | null) ?? undefined,
      state: r.state as MissionState,
      outcome: (r.outcome as MissionOutcome | null) ?? undefined,
      outcomeReason: (r.outcome_reason as string | null) ?? undefined,
      taskIds,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      closedAt: (r.closed_at as number | null) ?? undefined,
    };
  }

  private rowToTask(row: unknown): Task {
    const r = row as Record<string, unknown>;
    const attemptIds = (
      this.db.prepare('SELECT id FROM attempts WHERE task_id=? ORDER BY started_at, id').all(r.id as string) as Array<{ id: string }>
    ).map((a) => a.id);
    return {
      id: r.id as string,
      missionId: r.mission_id as string,
      projectId: r.project_id as string,
      role: r.role as TaskRole,
      objective: r.objective as string,
      dependsOn: parseJson<string[]>(r.depends_on as string, []),
      inputs: parseJson<ArtifactRef[]>(r.inputs as string, []),
      requiredOutputs: parseJson<ArtifactKind[]>(r.required_outputs as string, []),
      state: r.state as TaskState,
      runnerHint: (r.runner_hint as string | null) ?? undefined,
      attemptIds,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    };
  }

  private rowToAttempt(row: unknown): Attempt {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      missionId: r.mission_id as string,
      taskId: r.task_id as string,
      projectId: r.project_id as string,
      runnerId: r.runner_id as string,
      sessionId: (r.session_id as string | null) ?? undefined,
      worktree: (r.worktree as string | null) ?? undefined,
      state: r.state as AttemptState,
      startedAt: r.started_at as number,
      finishedAt: (r.finished_at as number | null) ?? undefined,
      // NULL in the column is "nobody said", and must come back as null rather than 0.
      costUsd: (r.cost_usd as number | null) ?? null,
      exitCode: r.exit_code as number | null,
      signal: r.signal as string | null,
      timedOut: !!(r.timed_out as number),
      failure: (r.failure as string | null) ?? undefined,
      artifacts: parseJson<ArtifactRef[]>(r.artifacts as string, []),
      tokens: {
        input: (r.input_tokens as number | null) ?? null,
        output: (r.output_tokens as number | null) ?? null,
        cacheRead: (r.cache_read_tokens as number | null) ?? null,
        cacheWrite: (r.cache_write_tokens as number | null) ?? null,
      },
      usageSource: r.usage_source as UsageSource,
      costSource: r.cost_source as CostSource,
      model: (r.model as string | null) ?? undefined,
      parentAttemptId: (r.parent_attempt_id as string | null) ?? undefined,
      gateSetDigest: (r.gate_set_digest as string | null) ?? undefined,
      pid: (r.pid as number | null) ?? undefined,
      heartbeatAt: (r.heartbeat_at as number | null) ?? undefined,
      origin: r.origin as AttemptOrigin,
      sandbox: r.sandbox_profile === null ? null : {
        profile: r.sandbox_profile as AttemptSandbox['profile'],
        network: r.sandbox_network as NetworkMode,
        write: !!(r.sandbox_write as number),
        exec: !!(r.sandbox_exec as number),
        authorizeDecisionId: (r.authorize_decision_id as string | null) ?? null,
      },
      credential: r.credential ? parseJson<AttemptCredential | undefined>(r.credential as string, undefined) : undefined,
      mcpTokenDigest: (r.mcp_token_digest as string | null) ?? undefined,
    };
  }

  private rowToExperiment(row: unknown): Experiment {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      missionId: r.mission_id as string,
      projectId: r.project_id as string,
      claimIds: parseJson<number[]>(r.claim_ids as string, []),
      subject: r.subject as string,
      predicate: r.predicate as string,
      hypothesis: r.hypothesis as string,
      prediction: parseJson(r.prediction as string, {}),
      baseRevision: r.base_revision as string,
      testArtifact: parseJson(r.test_artifact as string, null as unknown as ArtifactRef),
      expectedArtifact: parseJson(r.expected_artifact as string, null as unknown as ArtifactRef),
      harnessDigest: r.harness_digest as string,
      command: parseJson<string[]>(r.command as string, []),
      sandboxProfile: r.sandbox_profile as string,
      executions: parseJson<ArtifactRef[]>(r.executions as string, []),
      conclusion: r.conclusion as ExperimentConclusion,
      limitations: parseJson<string[]>(r.limitations as string, []),
      role: r.role as ExperimentRole,
      lockedBy: (r.locked_by as string | null) ?? undefined,
      startedAt: (r.started_at as number | null) ?? undefined,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    };
  }

  private rowToDecision(row: unknown): Decision {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      missionId: r.mission_id as string,
      projectId: r.project_id as string,
      revision: r.revision as string,
      actor: r.actor as string,
      kind: r.kind as Decision['kind'],
      subject: (r.subject as string | null) ?? undefined,
      predicate: (r.predicate as string | null) ?? undefined,
      value: r.value === null ? undefined : parseJson<unknown>(r.value as string, undefined),
      rationale: r.rationale as string,
      scope: parseJson<Record<string, unknown>>(r.scope as string, {}),
      artifactIds: parseJson<string[]>(r.artifact_ids as string, []),
      at: r.at as number,
    };
  }
}

// ---- forge rows --------------------------------------------------------------
//
// Module functions rather than methods: none of these rows embeds a list read from another
// table, so they need no database handle.

const canonical = (v: unknown): string => canonicalJson(v);

/** `sha256` over the sorted `"<x_id>:<harnessDigest>"` lines of a gate set. */
export function gateSetDigestOf(gates: Array<Pick<Experiment, 'id' | 'harnessDigest'>>): string {
  return digestOf(gates.map((x) => `${x.id}:${x.harnessDigest}`).sort().join('\n'));
}

/**
 * The digest of what a human approves when they approve a work item: its words, its examples
 * and the spec bytes it came from. A decision names this, so an edit after approval is visible.
 */
export function workItemContentDigest(w: Pick<
  WorkItem, 'specArtifact' | 'anchor' | 'title' | 'statement' | 'examples' | 'negativeExamples'
>): string {
  return digestOf(canonical({
    spec: w.specArtifact.digest, anchor: w.anchor, title: w.title, statement: w.statement,
    examples: w.examples, negativeExamples: w.negativeExamples,
  }));
}

function rowToUsage(r: Record<string, unknown>): UsageTurn {
  return {
    attemptId: r.attempt_id as string,
    projectId: r.project_id as string,
    seq: r.seq as number,
    requestId: (r.request_id as string | null) ?? null,
    at: r.at as number,
    model: (r.model as string | null) ?? null,
    tokens: {
      input: (r.input_tokens as number | null) ?? null,
      output: (r.output_tokens as number | null) ?? null,
      cacheRead: (r.cache_read_tokens as number | null) ?? null,
      cacheWrite: (r.cache_write_tokens as number | null) ?? null,
    },
    costUsd: (r.cost_usd as number | null) ?? null,
    costSource: r.cost_source as CostSource,
    source: r.source as UsageTurn['source'],
  };
}

const refOrUndefined = (v: unknown): ArtifactRef | undefined =>
  v ? parseJson<ArtifactRef | undefined>(v as string, undefined) : undefined;

function rowToWorkItem(row: unknown): WorkItem {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    missionId: r.mission_id as string,
    attemptId: (r.attempt_id as string | null) ?? undefined,
    proposalArtifact: refOrUndefined(r.proposal_artifact),
    contentDigest: r.content_digest as string,
    specArtifact: parseJson(r.spec_artifact as string, null as unknown as ArtifactRef),
    specRevision: r.spec_revision as string,
    anchor: r.anchor as string,
    title: r.title as string,
    statement: r.statement as string,
    examples: parseJson<string[]>(r.examples as string, []),
    negativeExamples: parseJson<string[]>(r.negative_examples as string, []),
    status: r.status as WorkItemStatus,
    proposedBy: r.proposed_by as string,
    decisionId: (r.decision_id as string | null) ?? undefined,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToCandidate(row: unknown): Candidate {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    missionId: r.mission_id as string,
    attemptId: r.attempt_id as string,
    projectId: r.project_id as string,
    baseCommit: r.base_commit as string,
    diffArtifact: parseJson(r.diff_artifact as string, null as unknown as ArtifactRef),
    summaryArtifact: parseJson(r.summary_artifact as string, null as unknown as ArtifactRef),
    narrativeArtifact: refOrUndefined(r.narrative_artifact),
    files: parseJson<CandidateFile[]>(r.files as string, []),
    policyViolations: parseJson<PolicyViolation[]>(r.policy_violations as string, []),
    secretHits: r.secret_hits as number,
    gateSetDigest: r.gate_set_digest as string,
    profile: parseJson<Candidate['profile']>(r.profile as string, null as unknown as Candidate['profile']),
    attemptState: r.attempt_state as AttemptState,
    attemptFailure: (r.attempt_failure as string | null) ?? undefined,
    verdict: r.verdict as CandidateVerdict,
    verdictReasons: parseJson<string[]>(r.verdict_reasons as string, []),
    createdAt: r.created_at as number,
  };
}

function rowToGateEvaluation(row: unknown): GateEvaluation {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    missionId: r.mission_id as string,
    projectId: r.project_id as string,
    revision: r.revision as string,
    experimentId: r.experiment_id as string,
    candidateId: (r.candidate_id as string | null) ?? undefined,
    target: r.target as GateTarget,
    diffDigest: (r.diff_digest as string | null) ?? null,
    harnessDigest: r.harness_digest as string,
    executions: parseJson<ArtifactRef[]>(r.executions as string, []),
    conclusion: r.conclusion as ExperimentConclusion,
    createdAt: r.created_at as number,
  };
}

function rowToApplication(row: unknown): Application {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    candidateId: r.candidate_id as string,
    missionId: r.mission_id as string,
    decisionId: r.decision_id as string,
    projectId: r.project_id as string,
    baseCommit: r.base_commit as string,
    commit: r.commit_sha as string,
    ref: r.ref as string,
    appliedBy: r.applied_by as string,
    at: r.at as number,
  };
}

function rowToIngestSource(r: Record<string, unknown>): IngestSource {
  return {
    sessionId: r.session_id as string,
    agentId: r.agent_id as string,
    projectId: r.project_id as string,
    pathDigest: r.path_digest as string,
    prefixDigest: r.prefix_digest as string,
    bytesSeen: r.bytes_seen as number,
    linesSeen: r.lines_seen as number,
    missionId: r.mission_id as string,
    attemptId: r.attempt_id as string,
    ingestedAt: r.ingested_at as number,
  };
}
