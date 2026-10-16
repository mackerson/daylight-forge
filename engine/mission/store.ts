import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DAYLIGHT_DB, openDaylightDb, parseJson } from './db.ts';
import {
  ATTEMPT_TRANSITIONS, canTransition, MISSION_TRANSITIONS, TASK_TRANSITIONS,
} from './types.ts';
import type {
  ArtifactKind, ArtifactRef, Attempt, AttemptState, Decision, Experiment,
  ExperimentConclusion, Mission, MissionBudget, MissionKind, MissionOutcome,
  MissionPermissions, MissionScope, MissionState, ProjectIdentity, Task, TaskRole, TaskState,
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

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '')}`;

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
}

export interface FinishAttemptInput {
  state: Extract<AttemptState, 'completed' | 'failed' | 'cancelled'>;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  /** `null` when the runner reported nothing. Not the same as zero. */
  costUsd: number | null;
  failure?: string;
  artifacts?: ArtifactRef[];
}

export type CreateExperimentInput = Omit<
  Experiment, 'id' | 'executions' | 'conclusion' | 'createdAt' | 'updatedAt'
>;

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
    const at = this.now();
    const m: Mission = {
      id: id('m'),
      projectId: input.projectId,
      parentId: input.parentId,
      kind: input.kind,
      objective: input.objective,
      baseRevision: input.baseRevision,
      scope: input.scope ?? {},
      permissions: { ...DEFAULT_PERMISSIONS, ...input.permissions },
      budget: input.budget ?? {},
      requirementIds: input.requirementIds ?? [],
      acceptanceGateIds: input.acceptanceGateIds ?? [],
      state: 'draft',
      taskIds: [],
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO missions
         (id, project_id, parent_id, kind, objective, base_revision, scope, permissions, budget,
          requirement_ids, acceptance_gate_ids, state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        m.id, m.projectId, m.parentId ?? null, m.kind, m.objective, m.baseRevision,
        JSON.stringify(m.scope), JSON.stringify(m.permissions), JSON.stringify(m.budget),
        JSON.stringify(m.requirementIds), JSON.stringify(m.acceptanceGateIds),
        m.state, m.createdAt, m.updatedAt,
      );
    return m;
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
    for (const dep of input.dependsOn ?? []) {
      const d = this.task(dep);
      if (!d || d.missionId !== m.id) {
        throw new Error(`task dependency ${dep} is not a task of mission ${m.id}`);
      }
    }
    const at = this.now();
    const t: Task = {
      id: id('t'),
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
    if (t.state === 'queued') t = this.transitionTask(t.id, 'leased');
    if (t.state === 'leased') t = this.transitionTask(t.id, 'running');
    if (t.state !== 'running') {
      throw new IllegalTransition('task', t.id, t.state, 'running');
    }
    const at = this.now();
    const a: Attempt = {
      id: id('a'),
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
    };
    this.db
      .prepare(
        `INSERT INTO attempts
         (id, mission_id, task_id, project_id, runner_id, session_id, worktree, state,
          started_at, cost_usd, timed_out, artifacts)
         VALUES (?,?,?,?,?,?,?,?,?,NULL,0,'[]')`,
      )
      .run(
        a.id, a.missionId, a.taskId, a.projectId, a.runnerId, a.sessionId ?? null,
        a.worktree ?? null, a.state, a.startedAt,
      );
    return a;
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
    const at = this.now();
    // One transaction: a crash between the attempt row and its task would leave the attempt
    // finished and the task running, which no later run can tell from a live attempt.
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE attempts SET state=?, finished_at=?, cost_usd=?, exit_code=?, signal=?,
             timed_out=?, failure=?, artifacts=?
           WHERE id=?`,
        )
        .run(
          result.state, at, result.costUsd, result.exitCode ?? null, result.signal ?? null,
          result.timedOut ? 1 : 0, result.failure ?? null,
          JSON.stringify(result.artifacts ?? []), attemptId,
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

  /** The attempt a `VDS_SESSION` belongs to, which is how an MCP event finds its attempt. */
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
    const at = this.now();
    const x: Experiment = {
      ...input,
      id: id('x'),
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
          sandbox_profile, executions, conclusion, limitations, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        x.id, x.missionId, x.projectId, JSON.stringify(x.claimIds), x.subject, x.predicate,
        x.hypothesis, JSON.stringify(x.prediction), x.baseRevision,
        JSON.stringify(x.testArtifact), JSON.stringify(x.expectedArtifact), x.harnessDigest,
        JSON.stringify(x.command), x.sandboxProfile, '[]', x.conclusion,
        JSON.stringify(x.limitations), x.createdAt, x.updatedAt,
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
    const d: Decision = { ...input, id: id('d'), at: this.now() };
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
