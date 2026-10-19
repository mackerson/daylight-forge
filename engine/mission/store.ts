import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, digestOf } from './artifacts.ts';
import { DAYLIGHT_DB, openDaylightDb, parseJson } from './db.ts';
import {
  ATTEMPT_TRANSITIONS, campaignActorOf, canTransition, DECISION_OPERATIONS, DERIVED_OPERATIONS, ID_PREFIX, isCampaignActor,
  isEntityId, isHumanActor, MISSION_TRANSITIONS,
  NETWORK_MODES, READ_ONLY_SANDBOX, SANDBOX_PROFILES, SANDBOX_REASONS, TASK_TRANSITIONS, WORK_ITEM_TRANSITIONS,
} from './types.ts';
import type {
  ArtifactKind, ArtifactRef, Attempt, AttemptCredential, AttemptOrigin, AttemptSandbox, AttemptState, CostSource, Decision,
  DecisionOperation, EntityKind, Experiment, ExperimentConclusion, ExperimentRole, Mission,
  MissionBudget, MissionKind, MissionOutcome, MissionPermissions, MissionScope, MissionState,
  NetworkMode, NewExperiment, ProjectIdentity, Task, TaskRole, TaskState, TokenUsage,
  UsageSource, Application, Candidate, CandidateFile, CandidateVerdict, GateEvaluation, GateTarget,
  IngestSource, PolicyViolation, SandboxReason, UsageRecordResult, UsageTurn, WorkItem, WorkItemStatus,
  ApprovePlanScope, Assumption, AssumptionDecisionScope, AssumptionSource, AssumptionStatus, AuthorizeCampaignScope,
  CampaignEnvelope, CampaignHaltReason, CampaignTicket, EnvelopeRequest, RetryTicketScope, TicketAcceptance, TicketBudget,
  TicketOrigin,
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

/** `lockGates` found a different gate set inside its transaction than the one the human confirmed. */
export class GateSetMoved extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateSetMoved';
  }
}

/** A WS-R5 interface whose body has not landed yet (merge step 0, P2-R26). */
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`${what}: not implemented`);
    this.name = 'NotImplemented';
  }
}

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
  ? [null, null, null, null, null, null]
  : [s.profile, s.network, s.write ? 1 : 0, s.exec ? 1 : 0, s.authorizeDecisionId ?? null, s.reason ?? null]);

const tokenColumns = (t: TokenUsage): [number | null, number | null, number | null, number | null] =>
  [t.input, t.output, t.cacheRead, t.cacheWrite];

const mergeRefs = (have: ArtifactRef[], add: ArtifactRef[]): ArtifactRef[] =>
  [...have, ...add.filter((r) => !have.some((h) => h.id === r.id))];

const maxOf = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

type GrantMission = Pick<Mission, 'id' | 'kind' | 'parentId'>;

/**
 * Why a `campaign:` actor's `authorize-mission` decision is not a grant on `mission`, or null.
 * Pure, over the three rows: `parent` must be a human `authorize-campaign` on the mission's
 * parent campaign that `d` names as `derivedFrom`, by that campaign's actor, inside its
 * `notAfter`, for a ticket it names (or one a derived `admit-work-item` admitted, which
 * `derivationRefusals` checks against rows), and asking for no more than it allows.
 */
export function campaignGrantRefusal(d: Decision, parent: Decision | null | undefined, mission: GrantMission): string | null {
  const scope = d.scope as { operation?: unknown; derivedFrom?: unknown; ticketId?: unknown; admittedBy?: unknown;
    maxUsd?: unknown; permissions?: { write?: unknown; execute?: unknown; deploy?: unknown } };
  if (!isCampaignActor(d.actor)) return `decision ${d.id} is not a campaign actor's`;
  if (!parent || scope.derivedFrom !== parent.id) return `derived decision ${d.id} names no recorded authorize-campaign decision`;
  if (parent.kind !== 'approve' || !isHumanActor(parent.actor) || parent.scope.operation !== 'authorize-campaign') {
    return `decision ${parent.id} is not a human authorize-campaign decision`;
  }
  if (d.actor !== campaignActorOf(parent.missionId)) return `decision ${d.id} is recorded as ${d.actor}, not campaign ${parent.missionId}'s actor`;
  if (d.missionId !== mission.id) return `decision ${d.id} is not on mission ${mission.id}`;
  if (mission.kind !== 'implement' || mission.parentId !== parent.missionId) {
    return `mission ${mission.id} is not an implement mission of campaign ${parent.missionId}`;
  }
  const env = parent.scope as unknown as CampaignEnvelope;
  if (!(d.at >= parent.at && d.at <= env.notAfter)) return `decision ${d.id} was recorded outside authorization ${parent.id}'s window`;
  if (scope.permissions?.deploy === true) return `decision ${d.id} grants deploy, which no campaign grants`;
  if (scope.permissions?.execute === true && env.execute !== true) return `decision ${d.id} grants execute, which authorization ${parent.id} does not`;
  if (typeof scope.maxUsd !== 'number' || !(scope.maxUsd <= env.maxUsdPerMission)) {
    return `decision ${d.id}'s budget is not within authorization ${parent.id}'s $${env.maxUsdPerMission} per mission`;
  }
  const inEnvelope = typeof scope.ticketId === 'string' && Array.isArray(env.ticketIds) && env.ticketIds.includes(scope.ticketId);
  if (!inEnvelope && !isEntityId('decision', scope.admittedBy)) return `decision ${d.id} names a ticket outside authorization ${parent.id}`;
  return null;
}

/**
 * An approving `authorize-mission` decision of this mission that granted write: by a human, or
 * by a campaign actor whose grant `campaignGrantRefusal` accepts against `parent` (its
 * `derivedFrom`) and `mission`. Without both, a campaign actor's decision grants nothing.
 */
export function grantsWrite(
  d: Decision | null | undefined, missionId: string, parent: Decision | null = null, mission?: GrantMission,
): boolean {
  const scope = d?.scope as { operation?: unknown; permissions?: { write?: unknown } } | undefined;
  if (!d || d.missionId !== missionId || d.kind !== 'approve' || scope?.operation !== 'authorize-mission' || scope.permissions?.write !== true) {
    return false;
  }
  if (isHumanActor(d.actor)) return true;
  return !!mission && mission.id === missionId && campaignGrantRefusal(d, parent, mission) === null;
}

/** A write grant (`grantsWrite`) that also carried `execute: true` explicitly (R17.1). */
export function grantsExec(
  d: Decision | null | undefined, missionId: string, parent: Decision | null = null, mission?: GrantMission,
): boolean {
  return grantsWrite(d, missionId, parent, mission) && (d!.scope as { permissions?: { execute?: unknown } }).permissions?.execute === true;
}

/**
 * Why a decision row is not one the store would have recorded, or null. `recordDecision` and
 * `importMission` both ask this, so a file cannot carry a decision the store would refuse.
 */
export function decisionRefusal(d: Pick<Decision, 'id' | 'actor' | 'kind' | 'scope'>): string | null {
  const operation = d.scope.operation;
  if (d.kind === 'adhoc-mission' && operation !== 'adhoc-mission') {
    return `decision ${d.id} is an adhoc-mission decision without the adhoc-mission operation`;
  }
  // Overriding gates is a Forge act whatever its scope says, so it names a person too.
  if (d.kind === 'override' && !isHumanActor(d.actor)) {
    return `override decision ${d.id} needs a human:<name> actor, not ${d.actor}`;
  }
  if (operation === undefined) return null;
  if (!DECISION_OPERATIONS.includes(operation as DecisionOperation)) {
    return `decision ${d.id} names unknown operation ${String(operation)}`;
  }
  // The director process, under a human authorize-campaign decision it names (P2-R19): only the
  // derived operations, and never without the grant it derives from.
  if (isCampaignActor(d.actor)) {
    if (!DERIVED_OPERATIONS.includes(operation as DecisionOperation)) {
      return `${String(operation)} decision ${d.id} is a person's act; a campaign actor never records it`;
    }
    if (!isEntityId('decision', d.scope.derivedFrom)) {
      return `derived ${String(operation)} decision ${d.id} names no authorize-campaign decision it derives from`;
    }
    return null;
  }
  // A Forge act is a person's, and says which person. An agent, a runner or a bare `human`
  // with no name cannot authorise, lock, approve or apply.
  if (!isHumanActor(d.actor)) return `${String(operation)} decision ${d.id} needs a human:<name> actor, not ${d.actor}`;
  return null;
}

/**
 * Why an attempt row breaks R7 or R12, or null: an ingested attempt outside a work mission or
 * with a sandbox record; a Daylight attempt without one, with an unknown profile or network,
 * with exec but no write, or with write or exec that `grant` (its named decision) does not give.
 * `startAttempt` and `importMission` both ask this.
 */
export function attemptRefusal(
  a: Pick<Attempt, 'id' | 'missionId' | 'origin' | 'sandbox'>,
  mission: Pick<Mission, 'id' | 'kind' | 'permissions' | 'parentId'>,
  grant: Decision | null | undefined,
  parent: Decision | null = null,
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
  if (s.reason !== undefined && (s.profile !== 'none' || !SANDBOX_REASONS.includes(s.reason))) {
    return `attempt ${a.id} records a declined-sandbox reason, which only a profile-none attempt can carry`;
  }
  if (s.write) {
    // Write is to the author's detached workspace (R7); no other profile has a writable tree.
    if (s.profile !== 'author') return `attempt ${a.id} asks for write under the ${s.profile} profile; only the author profile writes`;
    if (!s.authorizeDecisionId) return `attempt ${a.id} asks for write without naming the authorize decision that granted it`;
    if (!grantsWrite(grant, mission.id, parent, mission)) {
      const derived = grant && isCampaignActor(grant.actor) ? `: ${campaignGrantRefusal(grant, parent, mission) ?? 'not a write grant'}` : '';
      return `decision ${s.authorizeDecisionId} is not a human authorize-mission decision granting write on mission ${mission.id}${derived}`;
    }
    if (!mission.permissions.write) return `mission ${mission.id} does not hold write`;
    if (s.exec && (!grantsExec(grant, mission.id, parent, mission) || !mission.permissions.execute)) {
      return `attempt ${a.id} asks for exec, which decision ${s.authorizeDecisionId} did not grant on mission ${mission.id}`;
    }
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
  /** The spend ceiling handed to the runner, USD; a campaign reserves it while the attempt runs (P2-R18). */
  maxCostUsd?: number;
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
  /**
   * Required with a non-null cost: a figure says where it came from or is refused, because an
   * assumed `provider` would turn a scrape into knowledge (R10.2). Defaults to `none` for null.
   */
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
  /**
   * The gate-set digest the human confirmed (`confirmDigest`'s). Recomputed inside the lock's
   * transaction; any other set is refused there, so nothing is recorded for a set that moved.
   */
  expectedGateSetDigest: string;
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

export type CreateCandidateInput = Omit<Candidate, 'id' | 'verdict' | 'verdictReasons' | 'createdAt' | 'possibleSecretHits'>
  & { possibleSecretHits?: number };

export type CreateGateEvaluationInput = Omit<GateEvaluation, 'id' | 'createdAt'>;

export interface CreateApplicationInput {
  candidateId: string;
  decisionId: string;
  baseCommit: string;
  commit: string;
  tree: string;
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

  /** The store's clock, which every row it writes is stamped with. */
  clock(): number {
    return this.now();
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
    if (input.kind === 'campaign' && (input.permissions?.execute || input.parentId !== undefined)) {
      throw new Error('a campaign mission plans and grants; it never executes and has no parent');
    }
    if (input.parentId !== undefined) {
      // A parent is a campaign of the same project; its children build its tickets or review its waves.
      const parent = this.mission(input.parentId);
      if (!parent || parent.kind !== 'campaign' || parent.projectId !== input.projectId) {
        throw new Error(`parent ${input.parentId} is not a campaign mission of project ${input.projectId}`);
      }
      if (input.kind !== 'implement' && input.kind !== 'audit') throw new Error(`a campaign's child is an implement or audit mission, not ${input.kind}`);
      if (input.kind === 'implement' && (input.workItemId === undefined || this.campaignTicketByWorkItem(input.workItemId)?.campaignId !== parent.id)) {
        throw new Error(`an implement mission of campaign ${parent.id} builds one of its tickets' work items`);
      }
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
    // Inside a caller's transaction (a campaign creating and granting a ticket mission) it joins it.
    const own = !this.db.isTransaction;
    if (own) this.db.exec('BEGIN');
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
      // In the same transaction as the mission row: two creates from one item cannot both land.
      if (m.workItemId !== undefined && !this.claimWorkItem(m.workItemId, m.id, m.projectId)) {
        throw new Error(`work item ${m.workItemId} is already built by mission ${this.workItemConsumer(m.workItemId)}; an item is consumed once`);
      }
      if (input.adhoc) {
        this.recordDecision({
          missionId: m.id, projectId: m.projectId, revision: m.baseRevision,
          actor: input.adhoc.actor, kind: 'adhoc-mission', rationale: input.adhoc.rationale,
          scope: { operation: 'adhoc-mission', objective: m.objective }, artifactIds: [],
        });
      }
      if (own) this.db.exec('COMMIT');
    } catch (err) {
      if (own) this.db.exec('ROLLBACK');
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
    // A spec mission only decomposes and a work mission only records; neither runs anything.
    if (input.permissions.execute && (m.kind === 'spec' || m.kind === 'work' || m.kind === 'campaign')) {
      throw new Error(`mission ${m.id} is a ${m.kind} mission; it never executes`);
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
    const grant = sandbox?.authorizeDecisionId ? this.decision(sandbox.authorizeDecisionId) : null;
    const parent = this.grantParent(grant);
    const why = attemptRefusal(
      { id: `on task ${t.id}`, missionId: t.missionId, origin, sandbox }, this.requireMission(t.missionId), grant, parent,
    );
    if (why) throw new Error(why);
    // A derived grant is also checked against its envelope now: expired, halted, a moved plan or
    // gate lock, and nothing starts (fail closed).
    if (grant && sandbox?.write && isCampaignActor(grant.actor)) {
      const scope = grant.scope as { permissions?: MissionPermissions; maxUsd?: number | null };
      const refusal = this.envelopeRefusal(parent?.id ?? '', {
        missionId: t.missionId, operation: 'authorize-mission', ticketId: String(grant.scope.ticketId ?? ''),
        permissions: scope.permissions, maxUsd: scope.maxUsd ?? null, at: this.now(),
      });
      if (refusal) throw new Error(`refused: ${refusal}`);
    }
    if (input.mcpToken !== undefined && input.mcpToken.length < 32) {
      throw new Error('an MCP token must be at least 32 characters of randomness');
    }
    if (input.credential) checkCredential(input.credential);
    if (input.maxCostUsd !== undefined && !(Number.isFinite(input.maxCostUsd) && input.maxCostUsd >= 0)) {
      throw new Error('maxCostUsd must be a finite number of dollars, zero or more');
    }
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
      maxCostUsd: input.maxCostUsd,
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
          started_at, cost_usd, timed_out, artifacts, parent_attempt_id, gate_set_digest, max_cost_usd, pid,
          heartbeat_at, origin, sandbox_profile, sandbox_network, sandbox_write, sandbox_exec,
          authorize_decision_id, sandbox_reason, credential, mcp_token_digest)
         VALUES (?,?,?,?,?,?,?,?,?,NULL,0,'[]',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        a.id, a.missionId, a.taskId, a.projectId, a.runnerId, a.sessionId ?? null,
        a.worktree ?? null, a.state, a.startedAt, a.parentAttemptId ?? null,
        a.gateSetDigest ?? null, a.maxCostUsd ?? null, a.pid ?? null, a.heartbeatAt ?? null, origin,
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
      const grantId = a.sandbox?.authorizeDecisionId ?? null;
      const mission = this.mission(a.missionId);
      const grant = grantId !== null ? this.decision(grantId) : null;
      return !mission || attemptRefusal(a, mission, grant, this.grantParent(grant)) !== null;
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
    const costSource = result.costSource ?? (result.costUsd === null ? 'none' : undefined);
    if (costSource === undefined) {
      throw new Error(`attempt ${attemptId}: a cost of ${result.costUsd} needs a costSource; an unlabelled figure is not assumed known`);
    }
    if (a.origin === 'ingested' && costSource === 'provider') {
      throw new Error(`attempt ${attemptId} is ingested; a transcript's cost is never the provider's own figure`);
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
          // The CHECK refuses a cost labelled `none`.
          costSource,
          result.exitCode ?? null, result.signal ?? null,
          result.timedOut ? 1 : 0, result.failure ?? null,
          // Kept: what was attached while it ran (its exec logs) stays beside what it ended with.
          JSON.stringify(mergeRefs(a.artifacts, result.artifacts ?? [])), result.model ?? null,
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
   * Attach artifacts to a running attempt (its `run` tool's logs, R17.1) and record their rows,
   * so the attempt, `mission inspect` and an export all name them.
   */
  attachAttemptArtifacts(attemptId: string, refs: ArtifactRef[]): Attempt {
    const a = this.requireAttempt(attemptId);
    if (a.state !== 'running') throw new Error(`attempt ${attemptId} is ${a.state}; artifacts are attached while it runs`);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE attempts SET artifacts=? WHERE id=?').run(JSON.stringify(mergeRefs(a.artifacts, refs)), attemptId);
      for (const ref of refs) this.recordArtifact(ref);
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
      harness: input.harness ?? 'node',
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
          sandbox_profile, harness, executions, conclusion, limitations, role, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        x.id, x.missionId, x.projectId, JSON.stringify(x.claimIds), x.subject, x.predicate,
        x.hypothesis, JSON.stringify(x.prediction), x.baseRevision,
        JSON.stringify(x.testArtifact), JSON.stringify(x.expectedArtifact), x.harnessDigest,
        JSON.stringify(x.command), x.sandboxProfile, x.harness ?? 'node', '[]', x.conclusion,
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
   * alone: pending-and-never-run is a registered experiment, not a dead one. Gates and
   * holdouts are never reaped: their runs land in `gate_evaluations`, and their own row's
   * conclusion is not something a candidate run writes (interfaces-reconciled R-8).
   */
  reapPendingExperiments(opts: {
    projectId: string; startedBefore: number; isLive?: (experimentId: string) => boolean;
  }): Experiment[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM experiments WHERE project_id=? AND conclusion='pending' AND role='probe'
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
  /**
   * The gate set a lock of exactly these experiments would freeze, and its digest. The one
   * computation behind both `lockGates` and the `--confirm` preview, so the code a person
   * types is the digest the lock records, for any subset of the mission's gates.
   */
  gateSet(missionId: string, experimentIds: readonly string[]): { experiments: Experiment[]; gateSetDigest: string } {
    const m = this.requireMission(missionId);
    const ids = [...new Set(experimentIds)].sort();
    if (!ids.length) throw new Error(`mission ${m.id}: a gate lock names at least one gate`);
    const experiments = ids.map((id) => {
      const x = this.experiment(id);
      if (!x || x.missionId !== m.id) throw new Error(`experiment ${id} is not an experiment of mission ${m.id}`);
      if (x.role === 'probe') throw new Error(`experiment ${id} is a probe; only gates and holdouts are locked`);
      return x;
    });
    return { experiments, gateSetDigest: gateSetDigestOf(experiments) };
  }

  lockGates(missionId: string, input: LockGatesInput): { mission: Mission; decision: Decision; gateSetDigest: string } {
    const m = this.requireMission(missionId);
    if (typeof input.expectedGateSetDigest !== 'string' || !input.expectedGateSetDigest) {
      throw new Error(`mission ${m.id}: a gate lock names the gate-set digest the human confirmed`);
    }
    const at = this.now();
    // IMMEDIATE: the write lock is held before the set is read, so the set read is the set locked.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { experiments, gateSetDigest } = this.gateSet(m.id, input.experimentIds);
      if (gateSetDigest !== input.expectedGateSetDigest) {
        throw new GateSetMoved(
          `mission ${m.id}: the gate set is ${gateSetDigest}, not the one confirmed (${input.expectedGateSetDigest}); ` +
            'a gate changed after it was shown — review it and lock again',
        );
      }
      const ids = experiments.map((x) => x.id);
      const vacuous = [...new Set(input.vacuousOverrides ?? [])].sort();
      for (const id of vacuous) {
        if (!ids.includes(id)) throw new Error(`vacuous override ${id} is not one of the gates being locked`);
      }
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
    return this.latestDecision(missionId, 'lock-gates');
  }

  /** The most recent approving `authorize-mission` decision of a mission, or null. */
  authorizeDecision(missionId: string): Decision | null {
    return this.latestDecision(missionId, 'authorize-mission');
  }

  /** The most recent approving decision of `operation` on a mission, or null. */
  latestDecision(missionId: string, operation: DecisionOperation): Decision | null {
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

  /**
   * Set an attempt's token totals to the sum of its `attempt_usage` rows, in one transaction.
   * For an attempt that gains turns after it finished — an ingested transcript that grew — whose
   * totals `finishAttempt` can no longer write. An attempt with no rows is left as it is.
   */
  refreshUsageTotals(attemptId: string): Attempt {
    this.requireAttempt(attemptId);
    this.db.exec('BEGIN');
    try {
      const rows = this.usageRows(attemptId);
      if (rows.length) {
        this.db
          .prepare(
            `UPDATE attempts SET input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=?,
               usage_source=CASE WHEN usage_source='none' THEN ? ELSE usage_source END
             WHERE id=?`,
          )
          .run(...tokenColumns(this.usageTotals(attemptId)), rows[0].source, attemptId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.requireAttempt(attemptId);
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
    const operation = to === 'approved' ? 'approve-work-item' : 'reject-work-item';
    if (!d || d.projectId !== w.projectId || d.missionId !== w.missionId || !movesWorkItem(d, w, to)) {
      throw new Error(`decision ${decisionId} is not a ${operation} decision on mission ${w.missionId} naming ${w.id} at ${w.contentDigest}`);
    }
    const r = this.db
      .prepare('UPDATE work_items SET status=?, decision_id=?, updated_at=? WHERE id=? AND status=?')
      .run(to, d.id, this.now(), w.id, from);
    if (!r.changes) throw new IllegalTransition('work item', workItemId, 'changed underneath', to);
    return this.workItem(w.id)!;
  }

  /**
   * Record a work-item decision and move the item by it, in one transaction: either both are
   * written or neither is, so a refused move never leaves a decision behind it.
   */
  decideWorkItem(
    workItemId: string, from: WorkItemStatus, to: WorkItemStatus, decision: CreateDecisionInput,
  ): { decision: Decision; workItem: WorkItem } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const d = this.recordDecision(decision);
      const workItem = this.setWorkItemStatus(workItemId, from, to, d.id);
      this.db.exec('COMMIT');
      return { decision: d, workItem };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Mark an approved work item as built by `missionId`, compare-and-set: true when this call
   * (or an earlier one for the same mission) holds it, false when another mission already
   * does. Refused for an item that is not approved or a mission that is not an implement
   * mission of the item's project.
   */
  consumeWorkItem(workItemId: string, missionId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const m = this.requireMission(missionId);
      if (m.kind !== 'implement') throw new Error(`mission ${missionId} is a ${m.kind} mission; only an implement mission builds a work item`);
      if (m.workItemId !== undefined && m.workItemId !== workItemId) {
        throw new Error(`mission ${missionId} builds work item ${m.workItemId}, not ${workItemId}`);
      }
      const won = this.claimWorkItem(workItemId, missionId, m.projectId);
      this.db.exec('COMMIT');
      return won;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The implement mission that consumed this work item, or null. */
  workItemConsumer(workItemId: string): string | null {
    const r = this.db.prepare('SELECT consumed_by FROM work_items WHERE id=?').get(workItemId) as
      | { consumed_by: string | null } | undefined;
    return r?.consumed_by ?? null;
  }

  /** The compare-and-set itself; the caller holds the transaction. */
  private claimWorkItem(workItemId: string, missionId: string, projectId: string): boolean {
    const r = this.db
      .prepare(`UPDATE work_items SET consumed_by=?, updated_at=? WHERE id=? AND project_id=? AND status='approved' AND consumed_by IS NULL`)
      .run(missionId, this.now(), workItemId, projectId);
    if (r.changes === 1) return true;
    const w = this.db.prepare('SELECT status, project_id, consumed_by FROM work_items WHERE id=?').get(workItemId) as
      | { status: string; project_id: string; consumed_by: string | null } | undefined;
    if (!w) throw new Error(`unknown work item ${workItemId}`);
    if (w.project_id !== projectId) throw new Error(`work item ${workItemId} belongs to ${w.project_id}, not ${projectId}`);
    if (w.status !== 'approved') throw new Error(`work item ${workItemId} is ${w.status}; a mission builds only an approved one`);
    return w.consumed_by === missionId;
  }

  // ---- campaigns (WS-R5) -------------------------------------------------------------
  //
  // A campaign is a mission of kind `campaign`; its tickets are rows bound to work items, its
  // children are implement missions naming it as parent. Everything the director process may
  // do without a person is a derived decision, and `recordDerivedDecision` is its one writer.

  /** Run `fn` in the caller's transaction, or in its own `BEGIN IMMEDIATE` when there is none. */
  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private requireCampaign(campaignId: string): Mission {
    const m = this.requireMission(campaignId);
    if (m.kind !== 'campaign') throw new Error(`mission ${campaignId} is a ${m.kind} mission, not a campaign`);
    return m;
  }

  /** The `authorize-campaign` decision a campaign actor's grant names, or null. */
  private grantParent(grant: Decision | null | undefined): Decision | null {
    if (!grant || !isCampaignActor(grant.actor)) return null;
    const from = grant.scope.derivedFrom;
    return typeof from === 'string' ? this.decision(from) : null;
  }

  /**
   * The plan a campaign was last imported at, from its own `campaign.plan.imported` event, or
   * null. Only ever compared against digests a person approved and authorized, so a stale or
   * foreign record can refuse a derived act and never admit one.
   */
  currentPlan(campaignId: string): { planArtifact: string; planDigest: string; planRevision: string; commit: string; path: string } | null {
    const r = this.db
      .prepare(`SELECT payload FROM events WHERE mission_id=? AND name='campaign.plan.imported' AND actor_id='daylight' ORDER BY sequence DESC LIMIT 1`)
      .get(campaignId) as { payload: string } | undefined;
    const p = parseJson<Record<string, unknown>>(r?.payload, {});
    const fields = ['planArtifact', 'planDigest', 'planRevision', 'commit', 'path'] as const;
    if (!fields.every((k) => typeof p[k] === 'string')) return null;
    return { planArtifact: p.planArtifact as string, planDigest: p.planDigest as string, planRevision: p.planRevision as string,
      commit: p.commit as string, path: p.path as string };
  }

  insertCampaignTickets(rows: Array<Omit<CampaignTicket, 'createdAt'>>): CampaignTicket[] {
    return this.tx(() => rows.map((r) => {
      if (this.campaignTicket(r.campaignId, r.ticketId)) throw new Error(`campaign ${r.campaignId} already has ticket ${r.ticketId}`);
      return this.writeTicket(r);
    }));
  }

  private writeTicket(r: Omit<CampaignTicket, 'createdAt'>): CampaignTicket {
    const c = this.requireCampaign(r.campaignId);
    const w = this.workItem(r.workItemId);
    if (!w || w.missionId !== c.id || w.projectId !== c.projectId || r.projectId !== c.projectId) {
      throw new Error(`ticket ${r.ticketId}'s work item ${r.workItemId} is not a work item of campaign ${c.id}`);
    }
    this.db
      .prepare(
        `INSERT INTO campaign_tickets
         (campaign_id, ticket_id, project_id, work_item_id, origin, lane, depends_on, scope, acceptance, budget, blocks_on,
          ticket_digest, source_ref, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(campaign_id, ticket_id) DO UPDATE SET work_item_id=excluded.work_item_id, lane=excluded.lane,
           depends_on=excluded.depends_on, scope=excluded.scope, acceptance=excluded.acceptance, budget=excluded.budget,
           blocks_on=excluded.blocks_on, ticket_digest=excluded.ticket_digest`,
      )
      .run(
        r.campaignId, r.ticketId, r.projectId, r.workItemId, r.origin, r.lane, JSON.stringify(r.dependsOn), JSON.stringify(r.scope),
        JSON.stringify(r.acceptance), JSON.stringify(r.budget), JSON.stringify(r.blocksOn), r.ticketDigest, r.sourceRef ?? null, this.now(),
      );
    return this.campaignTicket(r.campaignId, r.ticketId)!;
  }

  /**
   * A plan import's rows, in one transaction: each ticket whose digest is unchanged keeps its row
   * and work item; a new or changed one gets its work item (idempotent by id) and its row; a plan
   * ticket the plan no longer names loses its row, and its work item is superseded by the next
   * `approve-plan`. Refused when a changed or dropped ticket's work item is being built by a
   * mission that is not closed.
   */
  importPlanTickets(
    campaignId: string, entries: Array<{ workItem: CreateWorkItemInput & { id: string }; ticket: Omit<CampaignTicket, 'createdAt' | 'workItemId'> }>,
  ): { added: string[]; kept: string[]; dropped: string[] } {
    return this.tx(() => {
      const c = this.requireCampaign(campaignId);
      const have = new Map(this.campaignTickets(c.id, { origin: 'plan' }).map((t) => [t.ticketId, t]));
      const named = new Set(entries.map((e) => e.ticket.ticketId));
      const busy = (t: CampaignTicket) => {
        const by = this.workItemConsumer(t.workItemId);
        return by !== null && this.mission(by)?.state !== 'closed' ? by : null;
      };
      const out = { added: [] as string[], kept: [] as string[], dropped: [] as string[] };
      for (const t of have.values()) {
        const entry = entries.find((e) => e.ticket.ticketId === t.ticketId);
        if (entry && entry.ticket.ticketDigest === t.ticketDigest) continue;
        const by = busy(t);
        if (by) throw new Error(`ticket ${t.ticketId} changed while mission ${by} builds it; close that mission first`);
      }
      for (const t of have.values()) {
        if (named.has(t.ticketId)) continue;
        this.db.prepare('DELETE FROM campaign_tickets WHERE campaign_id=? AND ticket_id=?').run(c.id, t.ticketId);
        out.dropped.push(t.ticketId);
      }
      for (const e of entries) {
        if (e.ticket.campaignId !== c.id || e.ticket.origin !== 'plan') throw new Error(`ticket ${e.ticket.ticketId} is not a plan ticket of campaign ${c.id}`);
        const was = have.get(e.ticket.ticketId);
        if (was && was.ticketDigest === e.ticket.ticketDigest) {
          out.kept.push(was.ticketId);
          continue;
        }
        const w = this.createWorkItem(e.workItem);
        this.writeTicket({ ...e.ticket, workItemId: w.id });
        out.added.push(e.ticket.ticketId);
      }
      return out;
    });
  }

  campaignTickets(campaignId: string, opts: { origin?: TicketOrigin } = {}): CampaignTicket[] {
    return (this.db.prepare('SELECT * FROM campaign_tickets WHERE campaign_id=? ORDER BY created_at, rowid').all(campaignId) as
      Array<Record<string, unknown>>).map(rowToTicket).filter((t) => opts.origin === undefined || t.origin === opts.origin);
  }

  campaignTicket(campaignId: string, ticketId: string): CampaignTicket | null {
    const r = this.db.prepare('SELECT * FROM campaign_tickets WHERE campaign_id=? AND ticket_id=?').get(campaignId, ticketId) as
      | Record<string, unknown> | undefined;
    return r ? rowToTicket(r) : null;
  }

  campaignTicketByWorkItem(workItemId: string): CampaignTicket | null {
    const r = this.db.prepare('SELECT * FROM campaign_tickets WHERE work_item_id=?').get(workItemId) as Record<string, unknown> | undefined;
    return r ? rowToTicket(r) : null;
  }

  /**
   * The plan work items `approve-plan` must list, and those it must supersede, as rows say now:
   * every plan ticket's work item at its digest; every plan work item of the campaign no ticket
   * row names that is not already rejected or superseded.
   */
  planApprovalSet(campaignId: string): { workItems: Record<string, string>; supersedes: string[] } {
    const tickets = this.campaignTickets(campaignId, { origin: 'plan' });
    const workItems: Record<string, string> = {};
    for (const t of tickets) workItems[t.workItemId] = this.workItem(t.workItemId)!.contentDigest;
    const c = this.requireCampaign(campaignId);
    const supersedes = this.workItems(c.projectId, { missionId: c.id })
      .filter((w) => w.proposedBy === 'plan' && !(w.id in workItems) && !this.campaignTicketByWorkItem(w.id)
        && (w.status === 'proposed' || w.status === 'approved'))
      .map((w) => w.id).sort();
    return { workItems, supersedes };
  }

  /**
   * `approve-plan`, in one transaction: the human decision naming every plan ticket's work item
   * at its digest; each proposed one approved; the work items the plan dropped or changed
   * superseded; the plan's non-blocking defaults moved `open → pending`; `draft → ready`.
   * Refused when the plan moved since it was shown, or when a superseded item is being built.
   */
  approvePlan(campaignId: string, input: { actor: string; rationale: string; scope: ApprovePlanScope; artifactIds?: string[] }): Decision {
    return this.tx(() => {
      const c = this.requireCampaign(campaignId);
      if (c.state !== 'draft' && c.state !== 'ready') throw new Error(`campaign ${c.id} is ${c.state}; a plan is approved before it runs`);
      const plan = this.currentPlan(c.id);
      if (!plan || plan.planDigest !== input.scope.planDigest || plan.planRevision !== input.scope.planRevision) {
        throw new Error(`campaign ${c.id}'s plan is not the one shown; review it and approve again`);
      }
      const want = this.planApprovalSet(c.id);
      if (canonical(want.workItems) !== canonical(input.scope.workItems) || canonical(want.supersedes) !== canonical([...input.scope.supersedes].sort())) {
        throw new Error(`campaign ${c.id}'s tickets changed since they were shown; review them and approve again`);
      }
      for (const id of want.supersedes) {
        const by = this.workItemConsumer(id);
        if (by !== null && this.mission(by)?.state !== 'closed') {
          throw new Error(`work item ${id} is being built by mission ${by}; close it before its ticket is superseded`);
        }
      }
      const decision = this.recordDecision({
        missionId: c.id, projectId: c.projectId, revision: c.baseRevision, actor: input.actor, kind: 'approve',
        rationale: input.rationale, scope: { ...input.scope, supersedes: want.supersedes }, artifactIds: input.artifactIds ?? [],
      });
      for (const id of Object.keys(want.workItems)) {
        if (this.workItem(id)!.status === 'proposed') this.setWorkItemStatus(id, 'proposed', 'approved', decision.id);
      }
      for (const id of want.supersedes) this.setWorkItemStatus(id, this.workItem(id)!.status, 'superseded', decision.id);
      this.db
        .prepare(`UPDATE assumptions SET status='pending', decision_id=?, updated_at=? WHERE campaign_id=? AND source='plan-default'
                  AND status='open' AND blocking=0 AND default_value<>''`)
        .run(decision.id, this.now(), c.id);
      if (c.state === 'draft') this.transitionMission(c.id, 'ready');
      return decision;
    });
  }

  /** The campaign's most recent human `authorize-campaign` decision, or null. */
  campaignAuthorization(campaignId: string): Decision | null {
    return this.decisions(campaignId)
      .filter((d) => d.kind === 'approve' && isHumanActor(d.actor) && d.scope.operation === 'authorize-campaign').at(-1) ?? null;
  }

  /**
   * `authorize-campaign`, as one transaction. Refused unless the latest `approve-plan` names the
   * current plan and the envelope does too; the latest `lock-campaign-gates` names the gate set
   * the human confirmed (`expectedGateSetDigest`, a string compare); every ticket is an approved
   * plan ticket; and the caps are ordered and bounded. Author turn and time bounds against the
   * policy are the caller's (`forge/campaign.ts`), which has the policy blob.
   */
  authorizeCampaign(
    campaignId: string, input: { actor: string; rationale: string; scope: AuthorizeCampaignScope; expectedGateSetDigest: string; artifactIds?: string[] },
  ): Decision {
    return this.tx(() => {
      const c = this.requireCampaign(campaignId);
      if (c.state !== 'ready') throw new Error(`campaign ${c.id} is ${c.state}; it is authorized once its plan is approved`);
      const e = input.scope;
      const why = envelopeShapeRefusal(e, this.now());
      if (why) throw new Error(`refused: ${why}`);
      const plan = this.currentPlan(c.id);
      const approve = this.latestDecision(c.id, 'approve-plan');
      if (!plan || !approve || approve.scope.planDigest !== plan.planDigest) throw new Error(`refused: campaign ${c.id}'s current plan is not approved`);
      if (e.planDigest !== plan.planDigest) throw new Error(`refused: the authorization names plan ${e.planDigest}, not the current ${plan.planDigest}`);
      const lock = this.latestDecision(c.id, 'lock-campaign-gates');
      if (!lock || lock.scope.gateSetDigest !== input.expectedGateSetDigest || e.gateSetDigest !== input.expectedGateSetDigest) {
        throw new Error(`refused: campaign ${c.id}'s gate lock is not the expected gate set`);
      }
      for (const id of e.ticketIds) {
        const t = this.campaignTicket(c.id, id);
        if (!t || t.origin !== 'plan' || this.workItem(t.workItemId)?.status !== 'approved') {
          throw new Error(`refused: ticket ${id} is not an approved plan ticket of campaign ${c.id}`);
        }
      }
      return this.recordDecision({
        missionId: c.id, projectId: c.projectId, revision: c.baseRevision, actor: input.actor, kind: 'approve',
        rationale: input.rationale, scope: { ...e }, artifactIds: input.artifactIds ?? [],
      });
    });
  }

  /**
   * The halts no person has resumed (`resume-campaign`, or `adopt-integration-tip`, which resumes
   * the halt it names); the latest first. Empty: not halted.
   */
  campaignHalts(campaignId: string): Decision[] {
    const all = this.decisions(campaignId);
    const resumed = new Set(all.filter((d) => (d.scope.operation === 'resume-campaign' || d.scope.operation === 'adopt-integration-tip')
      && isHumanActor(d.actor)).map((d) => d.scope.haltDecisionId));
    return all.filter((d) => d.scope.operation === 'halt-campaign' && !resumed.has(d.id)).reverse();
  }

  /**
   * Record a halt. A person's is recorded as theirs; the director's (`campaign:<id>`) is derived
   * from the current authorization (fail closed), which a halt may name even once expired.
   */
  recordHalt(campaignId: string, actor: string, reason: CampaignHaltReason): Decision {
    return this.tx(() => {
      const c = this.requireCampaign(campaignId);
      const base = { missionId: c.id, projectId: c.projectId, revision: c.baseRevision, actor, kind: 'defer' as const, artifactIds: [] };
      if (!isCampaignActor(actor)) {
        return this.recordDecision({ ...base, rationale: `halted: ${reason}`, scope: { operation: 'halt-campaign', reason } });
      }
      const parent = this.campaignAuthorization(c.id);
      if (!parent) throw new Error(`campaign ${c.id} has no authorization a director halt could derive from`);
      return this.recordDerivedDecision(parent.id, {
        ...base, rationale: `halted by the director: ${reason}`, scope: { operation: 'halt-campaign', reason, derivedFrom: parent.id },
      });
    });
  }

  /** A person resumes a halted campaign, naming the halt they read. */
  recordResume(campaignId: string, input: { actor: string; rationale: string; haltDecisionId: string }): Decision {
    return this.tx(() => {
      const c = this.requireCampaign(campaignId);
      const halt = this.campaignHalts(c.id).find((d) => d.id === input.haltDecisionId);
      if (!halt) throw new Error(`decision ${input.haltDecisionId} is not an unresumed halt of campaign ${c.id}`);
      return this.recordDecision({
        missionId: c.id, projectId: c.projectId, revision: c.baseRevision, actor: input.actor, kind: 'approve', rationale: input.rationale,
        scope: { operation: 'resume-campaign', haltDecisionId: halt.id, reason: halt.scope.reason }, artifactIds: [],
      });
    });
  }

  /** The derived `admit-work-item` that admitted this work item into its campaign, or null. */
  admission(campaignId: string, workItemId: string): Decision | null {
    return this.decisions(campaignId)
      .filter((d) => d.scope.operation === 'admit-work-item' && isCampaignActor(d.actor) && d.scope.workItemId === workItemId).at(-1) ?? null;
  }

  /** Implement missions released by a `retry-ticket` decision (P2-R25, P2-R27): closed inconclusive or cancelled. */
  releasedMissions(projectId?: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT scope FROM decisions WHERE scope LIKE '%"retry-ticket"%' ${projectId ? 'AND project_id=?' : ''}`)
      .all(...(projectId ? [projectId] : [])) as Array<{ scope: string }>;
    const out = new Set<string>();
    for (const r of rows) {
      const scope = parseJson<Record<string, unknown>>(r.scope, {});
      if (scope.operation !== 'retry-ticket' || typeof scope.closedMissionId !== 'string') continue;
      const m = this.mission(scope.closedMissionId);
      if (m?.state === 'closed' && (m.outcome === 'inconclusive' || m.outcome === 'cancelled')) out.add(m.id);
    }
    return out;
  }

  /**
   * Why `request` falls outside the envelope of the human `authorize-campaign` decision
   * `parentDecisionId`, or null. Rows only. The parent must be the campaign's current
   * authorization; except for a halt (always allowed, fail closed): inside `notAfter`, not
   * halted, the plan and gate lock it names still current, and for a ticket mission's act a
   * ticket it covers (named, or admitted by a derived `admit-work-item`), no more execute or
   * budget than it allows, and no second open mission on the ticket.
   */
  envelopeRefusal(parentDecisionId: string, req: EnvelopeRequest): string | null {
    const parent = parentDecisionId ? this.decision(parentDecisionId) : null;
    if (!parent || parent.kind !== 'approve' || !isHumanActor(parent.actor) || parent.scope.operation !== 'authorize-campaign') {
      return `decision ${parentDecisionId || '(none)'} is not a human authorize-campaign decision`;
    }
    const campaign = this.mission(parent.missionId);
    if (!campaign || campaign.kind !== 'campaign') return `decision ${parent.id} is not on a campaign`;
    const m = this.mission(req.missionId);
    if (!m) return `unknown mission ${req.missionId}`;
    if (!DERIVED_OPERATIONS.includes(req.operation)) return `${req.operation} is not a derived operation`;
    const onCampaign = m.id === campaign.id;
    const campaignAct = req.operation === 'admit-work-item' || req.operation === 'halt-campaign';
    if (campaignAct !== onCampaign) return `${req.operation} is recorded on ${campaignAct ? 'the campaign' : 'a ticket mission'}, not mission ${m.id}`;
    if (!onCampaign && (m.parentId !== campaign.id || m.kind !== 'implement')) return `mission ${m.id} is not an implement mission of campaign ${campaign.id}`;
    if (this.campaignAuthorization(campaign.id)?.id !== parent.id) return `decision ${parent.id} is not campaign ${campaign.id}'s current authorization`;
    if (req.operation === 'halt-campaign') return null;
    const env = parent.scope as unknown as CampaignEnvelope;
    if (!(req.at >= parent.at && req.at <= env.notAfter)) return `authorization ${parent.id} is not in force at ${req.at} (until ${env.notAfter})`;
    const halt = this.campaignHalts(campaign.id)[0];
    if (halt) return `campaign ${campaign.id} is halted (${String(halt.scope.reason)}, ${halt.id})`;
    const plan = this.currentPlan(campaign.id);
    const approve = this.latestDecision(campaign.id, 'approve-plan');
    if (!plan || !approve || approve.scope.planDigest !== plan.planDigest || env.planDigest !== plan.planDigest) {
      return `campaign ${campaign.id}'s plan moved since authorization ${parent.id}`;
    }
    if (this.latestDecision(campaign.id, 'lock-campaign-gates')?.scope.gateSetDigest !== env.gateSetDigest) {
      return `campaign ${campaign.id}'s gate lock moved since authorization ${parent.id}`;
    }
    if (req.operation === 'admit-work-item') return null;
    const t = m.workItemId ? this.campaignTicketByWorkItem(m.workItemId) : null;
    if (!t || t.campaignId !== campaign.id) return `mission ${m.id} builds no ticket of campaign ${campaign.id}`;
    if (req.ticketId && req.ticketId !== t.ticketId) return `mission ${m.id} builds ticket ${t.ticketId}, not ${req.ticketId}`;
    if (!env.ticketIds.includes(t.ticketId) && !this.admission(campaign.id, t.workItemId)) {
      return `ticket ${t.ticketId} is outside authorization ${parent.id}`;
    }
    if (req.operation === 'authorize-mission') {
      const p = req.permissions;
      if (!p || p.deploy) return 'a derived grant names its permissions and never deploy';
      if (p.execute && !env.execute) return `authorization ${parent.id} does not grant execute`;
      if (typeof req.maxUsd !== 'number' || !(req.maxUsd > 0 && req.maxUsd <= env.maxUsdPerMission)) {
        return `a derived grant's budget is at most $${env.maxUsdPerMission} per mission`;
      }
      const released = this.releasedMissions(campaign.projectId);
      const others = this.missions(campaign.projectId)
        .filter((o) => o.id !== m.id && o.kind === 'implement' && o.workItemId === t.workItemId && !released.has(o.id));
      if (others.length) return `ticket ${t.ticketId} is already built by mission ${others[0].id}`;
    }
    return null;
  }

  /**
   * The one writer of a `campaign:` actor's decision (P2-R19): re-checks the parent
   * `authorize-campaign` envelope against rows, then inserts. Opens no transaction; its callers
   * hold one. Called only from the files the `derived-writer-callers` invariant names.
   */
  recordDerivedDecision(parentDecisionId: string, input: CreateDecisionInput): Decision {
    const parent = this.decision(parentDecisionId);
    if (!parent) throw new Error(`refused: unknown decision ${parentDecisionId}`);
    const operation = input.scope.operation as DecisionOperation;
    if (input.actor !== campaignActorOf(parent.missionId)) {
      throw new Error(`refused: a decision derived from ${parent.id} is recorded as ${campaignActorOf(parent.missionId)}, not ${input.actor}`);
    }
    if (input.scope.derivedFrom !== parent.id) throw new Error(`refused: a derived decision names ${parent.id} as derivedFrom`);
    const m = this.requireMission(input.missionId);
    if (input.projectId !== m.projectId) throw new Error(`refused: decision names project ${input.projectId}, not ${m.projectId}`);
    if (!input.rationale?.trim()) throw new Error(`refused: decision on mission ${m.id} needs a rationale`);
    const refusal = decisionRefusal({ ...input, id: `on mission ${m.id}` });
    if (refusal) throw new Error(`refused: ${refusal}`);
    const scope = input.scope as { permissions?: MissionPermissions; maxUsd?: number | null; ticketId?: unknown };
    const why = this.envelopeRefusal(parent.id, {
      missionId: m.id, operation, ticketId: typeof scope.ticketId === 'string' ? scope.ticketId : '',
      permissions: scope.permissions, maxUsd: scope.maxUsd ?? null, at: this.now(),
    });
    if (why) throw new Error(`refused: ${why}`);
    const d: Decision = { ...input, id: newId('decision'), at: this.now() };
    if (operation === 'authorize-mission') {
      const grant = campaignGrantRefusal(d, parent, m);
      if (grant) throw new Error(`refused: ${grant}`);
    }
    return this.writeDecision(d);
  }

  /**
   * The director's grant on a ticket mission, as `authorizeMission` records a person's: the
   * derived `authorize-mission` (write, execute as the envelope allows, budget the lesser of the
   * ticket's and the envelope's per-mission cap), the permissions and budget, `draft → ready`.
   */
  deriveAuthorizeMission(missionId: string, campaignDecisionId: string): { mission: Mission; decision: Decision } {
    return this.tx(() => {
      const m = this.requireMission(missionId);
      if (m.kind !== 'implement' || !m.parentId) throw new Error(`mission ${m.id} is not a campaign's implement mission`);
      if (m.state !== 'draft') throw new Error(`mission ${m.id} is ${m.state}; a derived grant is made on a draft`);
      const parent = this.decision(campaignDecisionId);
      if (!parent || parent.missionId !== m.parentId) throw new Error(`decision ${campaignDecisionId} is not on mission ${m.id}'s campaign`);
      const env = parent.scope as unknown as CampaignEnvelope;
      const t = m.workItemId ? this.campaignTicketByWorkItem(m.workItemId) : null;
      if (!t) throw new Error(`mission ${m.id} builds no campaign ticket`);
      const maxUsd = Math.min(t.budget.maxUsd ?? Number.POSITIVE_INFINITY, env.maxUsdPerMission);
      const permissions: MissionPermissions = { read: true, write: true, execute: env.execute === true, deploy: false };
      const admittedBy = env.ticketIds?.includes(t.ticketId) ? undefined : this.admission(parent.missionId, t.workItemId)?.id;
      const decision = this.recordDerivedDecision(parent.id, {
        missionId: m.id, projectId: m.projectId, revision: m.baseRevision, actor: campaignActorOf(parent.missionId), kind: 'approve',
        rationale: `derived from ${parent.id} for ticket ${t.ticketId}`,
        scope: { operation: 'authorize-mission', permissions, maxUsd, derivedFrom: parent.id, ticketId: t.ticketId, ...(admittedBy ? { admittedBy } : {}) },
        artifactIds: [],
      });
      this.db
        .prepare('UPDATE missions SET permissions=?, budget=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(permissions), JSON.stringify({ ...m.budget, maxUsd }), this.now(), m.id);
      return { mission: this.transitionMission(m.id, 'ready'), decision };
    });
  }

  /** A ticket's implement mission and its derived grant, together: a refused grant leaves no mission. */
  createTicketMission(input: CreateMissionInput, campaignDecisionId: string): { mission: Mission; decision: Decision } {
    return this.tx(() => this.deriveAuthorizeMission(this.createMission(input).id, campaignDecisionId));
  }

  /**
   * The director admits a generated (fix) ticket's proposed work item within the envelope: the
   * derived `admit-work-item` and `proposed → approved`, together. Whether the finding and the
   * wave allow it is `admitIfWithinEnvelope`'s question.
   */
  admitWorkItem(workItemId: string, campaignDecisionId: string, scope: { ticketId: string; findingId?: string; waveSeq: number }): Decision {
    return this.tx(() => {
      const w = this.workItem(workItemId);
      if (!w || w.status !== 'proposed') throw new Error(`work item ${workItemId} is not a proposed work item`);
      const t = this.campaignTicketByWorkItem(w.id);
      if (!t || t.origin !== 'fix' || t.ticketId !== scope.ticketId) throw new Error(`work item ${w.id} is not fix ticket ${scope.ticketId}'s`);
      const parent = this.decision(campaignDecisionId);
      if (!parent || parent.missionId !== t.campaignId) throw new Error(`decision ${campaignDecisionId} is not on campaign ${t.campaignId}`);
      const c = this.requireCampaign(t.campaignId);
      const d = this.recordDerivedDecision(parent.id, {
        missionId: c.id, projectId: c.projectId, revision: c.baseRevision, actor: campaignActorOf(c.id), kind: 'approve',
        rationale: `admitted under ${parent.id}: fix ticket ${t.ticketId}`,
        scope: { operation: 'admit-work-item', derivedFrom: parent.id, workItemId: w.id, contentDigest: w.contentDigest, ticketId: t.ticketId,
          ...(scope.findingId ? { findingId: scope.findingId } : {}), waveSeq: scope.waveSeq },
        artifactIds: [],
      });
      this.setWorkItemStatus(w.id, 'proposed', 'approved', d.id);
      return d;
    });
  }

  /**
   * `campaign retry`: a person releases a ticket whose mission was refused at preflight (P2-R25):
   * that mission is closed inconclusive or cancelled, ran no attempt and applied nothing. Records
   * the `retry-ticket` decision on the campaign and clears `consumed_by`, compare-and-set.
   */
  retryTicket(campaignId: string, input: { actor: string; rationale: string; scope: RetryTicketScope }): Decision {
    return this.tx(() => {
      const c = this.requireCampaign(campaignId);
      const s = input.scope;
      const t = this.campaignTicket(c.id, s.ticketId);
      if (!t || t.workItemId !== s.workItemId) throw new Error(`refused: ticket ${s.ticketId} of campaign ${c.id} is not work item ${s.workItemId}`);
      const w = this.workItem(t.workItemId)!;
      if (w.contentDigest !== s.contentDigest) throw new Error(`refused: work item ${w.id} is not at ${s.contentDigest}`);
      if (this.workItemConsumer(w.id) !== s.closedMissionId) throw new Error(`refused: work item ${w.id} is not held by mission ${s.closedMissionId}`);
      const m = this.requireMission(s.closedMissionId);
      if (m.state !== 'closed' || (m.outcome !== 'inconclusive' && m.outcome !== 'cancelled')) {
        throw new Error(`refused: mission ${m.id} is ${m.state}${m.outcome ? ` ${m.outcome}` : ''}; only a mission closed inconclusive or cancelled is released`);
      }
      if (this.applications(m.id).length) throw new Error(`refused: mission ${m.id} applied a candidate`);
      const attempted = this.db.prepare('SELECT 1 FROM attempts WHERE mission_id=? LIMIT 1').get(m.id);
      if (attempted) throw new Error(`refused: mission ${m.id} ran an attempt; retry releases a mission refused at preflight only`);
      const d = this.recordDecision({
        missionId: c.id, projectId: c.projectId, revision: c.baseRevision, actor: input.actor, kind: 'approve',
        rationale: input.rationale, scope: { ...s }, artifactIds: [],
      });
      const r = this.db.prepare('UPDATE work_items SET consumed_by=NULL, updated_at=? WHERE id=? AND consumed_by=?').run(this.now(), w.id, m.id);
      if (r.changes !== 1) throw new Error(`refused: work item ${w.id} changed underneath`);
      return d;
    });
  }

  /**
   * Every campaign-actor decision that is not one `recordDerivedDecision` would have written: its
   * parent missing or not a human authorize-campaign on its campaign, outside the window, or (for
   * a grant) beyond the envelope or admitted by nothing. Empty is the only acceptable answer.
   */
  derivationRefusals(projectId?: string): string[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions WHERE actor LIKE 'campaign:%' ${projectId ? 'AND project_id=?' : ''} ORDER BY at, rowid`)
      .all(...(projectId ? [projectId] : []));
    const out: string[] = [];
    for (const d of rows.map((r) => this.rowToDecision(r))) {
      const why = decisionRefusal(d);
      if (why) {
        out.push(why);
        continue;
      }
      const parent = typeof d.scope.derivedFrom === 'string' ? this.decision(d.scope.derivedFrom) : null;
      if (!parent || parent.kind !== 'approve' || !isHumanActor(parent.actor) || parent.scope.operation !== 'authorize-campaign') {
        out.push(`derived decision ${d.id} names no human authorize-campaign decision`);
        continue;
      }
      if (d.actor !== campaignActorOf(parent.missionId)) out.push(`derived decision ${d.id} is recorded as ${d.actor}, not campaign ${parent.missionId}'s actor`);
      const m = this.mission(d.missionId);
      const env = parent.scope as unknown as CampaignEnvelope;
      if (!m || (m.id !== parent.missionId && m.parentId !== parent.missionId)) out.push(`derived decision ${d.id} is outside campaign ${parent.missionId}`);
      if (d.scope.operation !== 'halt-campaign' && !(d.at >= parent.at && d.at <= env.notAfter)) {
        out.push(`derived decision ${d.id} was recorded outside authorization ${parent.id}'s window`);
      }
      if (d.scope.operation === 'authorize-mission' && m) {
        const grant = campaignGrantRefusal(d, parent, m);
        if (grant) out.push(grant);
        const by = d.scope.admittedBy;
        if (!grant && typeof by === 'string') {
          const a = this.decision(by);
          const t = m.workItemId ? this.campaignTicketByWorkItem(m.workItemId) : null;
          if (!a || a.scope.operation !== 'admit-work-item' || !isCampaignActor(a.actor) || !t || a.scope.workItemId !== t.workItemId) {
            out.push(`derived grant ${d.id} names admission ${by}, which admitted nothing it builds`);
          }
        }
      }
      if (d.scope.operation === 'admit-work-item') {
        const t = typeof d.scope.workItemId === 'string' ? this.campaignTicketByWorkItem(d.scope.workItemId) : null;
        if (!t || t.campaignId !== parent.missionId || t.origin === 'plan') out.push(`derived admission ${d.id} names no generated ticket of campaign ${parent.missionId}`);
      }
    }
    return out;
  }

  // ---- assumptions ------------------------------------------------------------------

  recordAssumption(input: Omit<Assumption, 'id' | 'createdAt' | 'updatedAt' | 'projectId' | 'decisionId' | 'followUpWorkItemId'> & { decisionId?: string }): Assumption {
    const c = this.requireCampaign(input.campaignId);
    if (input.status !== 'open' && input.status !== 'pending') throw new Error('an assumption is recorded open or pending');
    for (const [k, v] of [['question', input.question], ['rationale', input.rationale]] as const) {
      if (typeof v !== 'string' || !v.trim()) throw new Error(`an assumption needs a ${k}`);
    }
    const at = this.now();
    const id = newId('assumption');
    // The CHECKs refuse a pending row nobody human recorded (P2-R12).
    this.db
      .prepare(
        `INSERT INTO assumptions (id, project_id, campaign_id, mission_id, ticket_id, owner_decision_id, question, default_value, rationale,
           status, blocking, source, recorded_by, decision_id, follow_up_work_item_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
      )
      .run(
        id, c.projectId, c.id, input.missionId ?? null, input.ticketId ?? null, input.ownerDecisionId ?? null, input.question, input.default,
        input.rationale, input.status, input.blocking ? 1 : 0, input.source, input.recordedBy, input.decisionId ?? null, at, at,
      );
    return this.assumption(id)!;
  }

  assumption(id: string): Assumption | null {
    const r = this.db.prepare('SELECT * FROM assumptions WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? rowToAssumption(r) : null;
  }

  assumptions(campaignId: string, opts: { status?: AssumptionStatus } = {}): Assumption[] {
    return (this.db.prepare('SELECT * FROM assumptions WHERE campaign_id=? ORDER BY created_at, rowid').all(campaignId) as
      Array<Record<string, unknown>>).map(rowToAssumption).filter((a) => opts.status === undefined || a.status === opts.status);
  }

  /**
   * A person's decision on an assumption, in one transaction: `confirm-assumption` (pending →
   * confirmed, on its default), `decide-assumption` (open → confirmed, on the value given),
   * `overturn-assumption` (to overturned; with `followUp`, its one proposed work item and ticket
   * row are written first and the decision names them). Nothing else moves.
   */
  decideAssumption(id: string, input: {
    actor: string; rationale: string; scope: AssumptionDecisionScope;
    followUp?: { workItem: CreateWorkItemInput & { id: string }; ticket: Omit<CampaignTicket, 'createdAt' | 'workItemId'> };
  }): Decision {
    return this.tx(() => {
      const a = this.assumption(id);
      if (!a) throw new Error(`unknown assumption ${id}`);
      const c = this.requireCampaign(a.campaignId);
      const op = input.scope.operation;
      if (input.scope.assumptionId !== a.id) throw new Error(`the decision names assumption ${input.scope.assumptionId}, not ${a.id}`);
      const from: Record<AssumptionDecisionScope['operation'], AssumptionStatus[]> = {
        'confirm-assumption': ['pending'], 'decide-assumption': ['open'], 'overturn-assumption': ['open', 'pending', 'confirmed'],
      };
      if (!from[op]?.includes(a.status)) throw new Error(`refused: assumption ${a.id} is ${a.status}; ${op} moves ${from[op]?.join(' or ') ?? 'nothing'}`);
      if (op === 'confirm-assumption' && input.scope.value !== a.default) throw new Error(`refused: confirm names the default assumption ${a.id} proceeds on`);
      if (op !== 'confirm-assumption' && !input.scope.value.trim()) throw new Error(`refused: ${op} needs a value`);
      let followUpWorkItemId: string | undefined;
      if (input.followUp) {
        if (op !== 'overturn-assumption') throw new Error('only an overturn creates a follow-up');
        const w = this.createWorkItem(input.followUp.workItem);
        if (this.campaignTicket(c.id, input.followUp.ticket.ticketId)) throw new Error(`campaign ${c.id} already has ticket ${input.followUp.ticket.ticketId}`);
        this.writeTicket({ ...input.followUp.ticket, workItemId: w.id });
        followUpWorkItemId = w.id;
      }
      if (input.scope.followUpWorkItemId !== followUpWorkItemId) throw new Error('the decision names a follow-up work item it does not create');
      const d = this.recordDecision({
        missionId: c.id, projectId: c.projectId, revision: c.baseRevision, actor: input.actor,
        kind: op === 'overturn-assumption' ? 'reject' : 'approve', rationale: input.rationale, scope: { ...input.scope }, artifactIds: [],
      });
      const status: AssumptionStatus = op === 'overturn-assumption' ? 'overturned' : 'confirmed';
      const value = op === 'decide-assumption' ? input.scope.value : a.default;
      this.db
        .prepare('UPDATE assumptions SET status=?, default_value=?, decision_id=?, follow_up_work_item_id=?, updated_at=? WHERE id=? AND status=?')
        .run(status, value, d.id, followUpWorkItemId ?? null, this.now(), a.id, a.status);
      return d;
    });
  }

  // ---- candidates ------------------------------------------------------------------

  createCandidate(input: CreateCandidateInput): Candidate {
    if (input.profile.name !== 'author') {
      throw new Error(`a candidate comes from the author profile, not ${String(input.profile.name)}`);
    }
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
    const possibleSecretHits = input.possibleSecretHits ?? 0;
    if (!Number.isInteger(possibleSecretHits) || possibleSecretHits < 0) {
      throw new Error('possibleSecretHits is a count of low-confidence secret matches');
    }
    const c: Candidate = {
      ...input,
      possibleSecretHits,
      id: newId('candidate'),
      verdict: 'pending',
      verdictReasons: [],
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO candidates
         (id, mission_id, attempt_id, project_id, base_commit, diff_artifact, summary_artifact,
          narrative_artifact, files, policy_violations, secret_hits, possible_secret_hits, gate_set_digest, profile,
          attempt_state, attempt_failure, verdict, verdict_reasons, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.id, c.missionId, c.attemptId, c.projectId, c.baseCommit, JSON.stringify(c.diffArtifact),
        JSON.stringify(c.summaryArtifact), c.narrativeArtifact ? JSON.stringify(c.narrativeArtifact) : null,
        JSON.stringify(c.files), JSON.stringify(c.policyViolations), c.secretHits, c.possibleSecretHits, c.gateSetDigest,
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
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input.tree)) throw new Error(`application tree ${JSON.stringify(input.tree)} is not a git object id`);
    if (this.application(c.id)) throw new Error(`candidate ${c.id} is already applied`);
    const p: Application = {
      id: newId('application'),
      candidateId: c.id,
      missionId: c.missionId,
      decisionId: d.id,
      projectId: c.projectId,
      baseCommit: input.baseCommit,
      commit: input.commit,
      tree: input.tree,
      ref: input.ref,
      appliedBy: input.appliedBy,
      at: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO applications
         (id, candidate_id, mission_id, decision_id, project_id, base_commit, commit_sha, tree_sha, ref, applied_by, at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(p.id, p.candidateId, p.missionId, p.decisionId, p.projectId, p.baseCommit, p.commit, p.tree, p.ref, p.appliedBy, p.at);
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
    // P2-R19: a campaign actor's decision is written by recordDerivedDecision only, after its envelope.
    if (isCampaignActor(input.actor)) {
      throw new Error(`a ${input.actor} decision is derived; recordDecision records a person's decision only`);
    }
    const refusal = decisionRefusal({ ...input, id: `on mission ${m.id}` });
    if (refusal) throw new Error(refusal);
    return this.insertDecision(input);
  }

  private insertDecision(input: CreateDecisionInput): Decision {
    return this.writeDecision({ ...input, id: newId('decision'), at: this.now() });
  }

  private writeDecision(d: Decision): Decision {
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
    this.db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(d.at, d.missionId);
    return d;
  }

  decision(decisionId: string): Decision | null {
    const r = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(decisionId);
    return r ? this.rowToDecision(r) : null;
  }

  decisions(missionId: string): Decision[] {
    // Two decisions in one millisecond are in the order they were recorded, not by random id.
    return this.db
      .prepare('SELECT * FROM decisions WHERE mission_id=? ORDER BY at, rowid')
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

  /** One `attempt.exec` event per `run` call (R17.1): the count travels with the events in an export. */
  private execRunsOf(attemptId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE attempt_id=? AND name='attempt.exec'").get(attemptId) as { n: number };
    return Number(row.n);
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
      ...(r.sandbox_exec === 1 ? { execRuns: this.execRunsOf(r.id as string) } : {}),
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
      maxCostUsd: (r.max_cost_usd as number | null) ?? undefined,
      pid: (r.pid as number | null) ?? undefined,
      heartbeatAt: (r.heartbeat_at as number | null) ?? undefined,
      origin: r.origin as AttemptOrigin,
      sandbox: r.sandbox_profile === null ? null : {
        profile: r.sandbox_profile as AttemptSandbox['profile'],
        network: r.sandbox_network as NetworkMode,
        write: !!(r.sandbox_write as number),
        exec: !!(r.sandbox_exec as number),
        authorizeDecisionId: (r.authorize_decision_id as string | null) ?? null,
        ...(r.sandbox_reason ? { reason: r.sandbox_reason as SandboxReason } : {}),
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
      harness: r.harness === 'cargo' ? 'cargo' : 'node',
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

/**
 * Whether decision `d` moves work item `w` to `to`: a person's `approve-work-item` /
 * `reject-work-item` naming it at its digest; an `approve-plan` listing it at its digest (to
 * approve) or among `supersedes`; a derived `admit-work-item` naming it at its digest.
 */
export function movesWorkItem(d: Decision, w: Pick<WorkItem, 'id' | 'contentDigest'>, to: WorkItemStatus): boolean {
  const scope = d.scope as { operation?: unknown; workItemId?: unknown; contentDigest?: unknown; workItems?: unknown; supersedes?: unknown };
  const names = scope.workItemId === w.id && scope.contentDigest === w.contentDigest;
  if (scope.operation === 'approve-plan') {
    if (d.kind !== 'approve' || !isHumanActor(d.actor)) return false;
    if (to === 'approved') return (scope.workItems as Record<string, unknown> | undefined)?.[w.id] === w.contentDigest;
    return to === 'superseded' && Array.isArray(scope.supersedes) && scope.supersedes.includes(w.id);
  }
  if (to === 'approved') {
    return names && ((scope.operation === 'approve-work-item' && isHumanActor(d.actor))
      || (scope.operation === 'admit-work-item' && isCampaignActor(d.actor)));
  }
  return names && scope.operation === 'reject-work-item' && isHumanActor(d.actor);
}

const MAX_NOT_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const posFinite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const intIn = (n: unknown, lo: number, hi: number): n is number => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;

/** Why an authorize-campaign envelope is malformed or its caps disordered, or null. Row-free. */
export function envelopeShapeRefusal(e: CampaignEnvelope, now: number): string | null {
  if (!e || typeof e !== 'object') return 'an authorization carries an envelope';
  if (typeof e.planDigest !== 'string' || typeof e.gateSetDigest !== 'string') return 'an authorization names its plan and gate set';
  if (!Array.isArray(e.ticketIds) || !e.ticketIds.length || new Set(e.ticketIds).size !== e.ticketIds.length) {
    return 'an authorization names its tickets, each once';
  }
  if (!Array.isArray(e.roster) || !e.roster.length || !Array.isArray(e.reviewRoster)) return 'an authorization names a roster of at least one author';
  if (!posFinite(e.maxUsdTotal) || !posFinite(e.maxUsdPerMission)) return 'the spend caps are positive dollar figures';
  if (e.maxUsdPerMission > e.maxUsdTotal) return 'the per-mission cap is above the campaign cap';
  if (!intIn(e.maxTurns, 1, 1_000_000) || !intIn(e.timeoutSeconds, 1, 1_000_000)) return 'turns and timeout are positive whole numbers';
  if (!intIn(e.maxAttemptsPerTicket, 1, 10)) return 'attempts per ticket are 1 to 10';
  if (!intIn(e.concurrency, 1, 64)) return 'concurrency is 1 to 64';
  if (!intIn(e.waveSize, 1, 10_000)) return 'the wave size is a positive whole number';
  if (typeof e.execute !== 'boolean') return 'execute is yes or no';
  if (e.autoApply !== 'integration-ref' && e.autoApply !== 'none') return 'auto-apply is integration-ref or none';
  const f = e.fixLane;
  if (!f || typeof f.enabled !== 'boolean' || !intIn(f.maxTicketsPerWave, 0, 5) || !(f.maxUsdPerTicket >= 0 && Number.isFinite(f.maxUsdPerTicket))) {
    return 'the fix lane admits at most 5 tickets a wave (P2-R10) at a dollar cap';
  }
  if (f.maxUsdPerTicket > e.maxUsdPerMission) return 'the fix lane\'s per-ticket cap is above the per-mission cap';
  if (!e.identity || typeof e.identity.name !== 'string' || typeof e.identity.email !== 'string') return 'an authorization names the committer identity';
  if (!Number.isInteger(e.notAfter) || e.notAfter <= now || e.notAfter > now + MAX_NOT_AFTER_MS) return 'not-after is in the future, at most 30 days away';
  return null;
}

function rowToTicket(r: Record<string, unknown>): CampaignTicket {
  return {
    campaignId: r.campaign_id as string,
    ticketId: r.ticket_id as string,
    projectId: r.project_id as string,
    workItemId: r.work_item_id as string,
    origin: r.origin as TicketOrigin,
    lane: r.lane as string,
    dependsOn: parseJson<string[]>(r.depends_on as string, []),
    scope: parseJson<string[]>(r.scope as string, []),
    acceptance: parseJson<TicketAcceptance>(r.acceptance as string, { kind: 'ci-only' }),
    budget: parseJson<TicketBudget>(r.budget as string, {}),
    blocksOn: parseJson<string[]>(r.blocks_on as string, []),
    ticketDigest: r.ticket_digest as string,
    sourceRef: (r.source_ref as string | null) ?? undefined,
    createdAt: r.created_at as number,
  };
}

function rowToAssumption(r: Record<string, unknown>): Assumption {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    campaignId: r.campaign_id as string,
    missionId: (r.mission_id as string | null) ?? undefined,
    ticketId: (r.ticket_id as string | null) ?? undefined,
    ownerDecisionId: (r.owner_decision_id as string | null) ?? undefined,
    question: r.question as string,
    default: r.default_value as string,
    rationale: r.rationale as string,
    status: r.status as AssumptionStatus,
    blocking: r.blocking === 1,
    source: r.source as AssumptionSource,
    recordedBy: r.recorded_by as string,
    decisionId: (r.decision_id as string | null) ?? undefined,
    followUpWorkItemId: (r.follow_up_work_item_id as string | null) ?? undefined,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
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
    possibleSecretHits: r.possible_secret_hits as number,
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
    tree: r.tree_sha as string,
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
