import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, digestOf } from './artifacts.ts';
import { DAYLIGHT_DB, openDaylightDb, parseJson } from './db.ts';
import { pathViolations } from '../forge/policy.ts';
import { authorLimits, type ProjectPolicy } from '../forge/project-policy.ts';

/** The author defaults `forge run` uses, which a campaign may only lower (P2-R20). */
export const CAMPAIGN_AUTHOR_DEFAULTS = { maxTurns: 60, timeoutMs: 600_000 } as const;
import {
  ATTEMPT_TRANSITIONS, campaignActorOf, canTransition, DECISION_OPERATIONS, DERIVED_OPERATIONS, ID_PREFIX, isCampaignActor,
  isBenchActor, isEntityId, isHumanActor, isPersonActor, MISSION_TRANSITIONS,
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
import { FINDING_SEVERITIES } from './types.ts';
import type {
  CampaignLockScope, CampaignWave, Finding, FindingSeverity, Integration, IntegrationMethod, IntegrationState,
} from './types.ts';
import { IR_TRANSITIONS } from './types.ts';
import type {
  Blueprint, BlueprintDerivation, BlueprintV1, CorpusRevision, IrAttrs, IrFinding, IrFindingKind, IrKind, IrLinkRow, IrObservation,
  IrRecord, IrSpanRef, IrSpanRow, IrStatus, NewIrRecord, PacketRow, TicketTraceRow,
} from './types.ts';
import { ArtifactStore } from './artifacts.ts';

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
  if (parent.kind !== 'approve' || !isPersonActor(parent.actor) || parent.scope.operation !== 'authorize-campaign') {
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
  if (isPersonActor(d.actor)) return true;
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
  if (d.kind === 'override' && !isPersonActor(d.actor)) {
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
  if (!isPersonActor(d.actor)) return `${String(operation)} decision ${d.id} needs a human:<name> actor, not ${d.actor}`;
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

const EXPERIMENT_ROLES: readonly ExperimentRole[] = ['probe', 'gate', 'holdout', 'regression', 'acceptance'];

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
  /** Set only while authorizeCampaign records its decision. */
  private authorizingCampaign = false;
  /** Bodies the spec-ingestion rows hold by artifact id (a blueprint's), read and re-verified on load. */
  private bodies: ArtifactStore;

  constructor(outDir: string, now: () => number = () => Date.now()) {
    // The output directory usually exists by the time anyone has a mission to record, but
    // the first thing a fresh mission does must not be to fail on a missing folder.
    fs.mkdirSync(outDir, { recursive: true });
    this.db = openDaylightDb(path.join(outDir, DAYLIGHT_DB));
    this.now = now;
    this.bodies = new ArtifactStore(outDir);
  }

  close(): void {
    this.db.close();
  }

  /** Whether `ingest bench` created this store (P2-R61): a throwaway whose decisions are the bench's. */
  isBench(): boolean {
    const r = this.db.prepare("SELECT value FROM daylight_meta WHERE key='bench'").get() as { value: string } | undefined;
    return r?.value === '1';
  }

  /** Mark a fresh store as a bench store; refused once it holds any mission or decision. */
  markBench(): void {
    const used = this.db.prepare('SELECT (SELECT COUNT(*) FROM missions) + (SELECT COUNT(*) FROM decisions) AS n').get() as { n: number };
    if (used.n > 0) throw new Error('only a fresh store becomes a bench store');
    this.db.prepare("INSERT INTO daylight_meta (key, value) VALUES ('bench', '1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
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
    if (input.kind === 'corpus' && (input.permissions?.execute || input.parentId !== undefined)) {
      throw new Error('a corpus mission registers and reads specification documents; it never executes and has no parent');
    }
    const parentOf = input.parentId !== undefined ? this.mission(input.parentId) : null;
    if (parentOf?.kind === 'corpus') {
      // A corpus's only child is its blind IR review (spec ingestion §6.1).
      if (parentOf.projectId !== input.projectId || input.kind !== 'audit') {
        throw new Error(`a corpus mission's child is an audit mission of project ${parentOf.projectId}, not ${input.kind}`);
      }
    } else if (input.parentId !== undefined) {
      // A parent is a campaign of the same project; its children build its tickets or review its waves.
      const parent = parentOf;
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
      return !mission || attemptRefusal(a, mission, grant, this.grantParent(grant)) !== null
        || (!!grant && isCampaignActor(grant.actor) && this.grantTicketRefusal(grant, mission) !== null);
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
    if (result.costSource === 'reservation') {
      throw new Error(`attempt ${attemptId}: only the store charges an attempt at its reservation`);
    }
    // P2-R44: an attempt that ends unfinished and reports nothing is charged at its reservation,
    // the most it was allowed to spend, so a crash can neither hide spend nor wedge a cap.
    const charged = result.state !== 'completed' && result.costUsd === null && a.maxCostUsd !== undefined;
    const costUsd = charged ? a.maxCostUsd! : result.costUsd;
    const costSource = charged ? 'reservation' : result.costSource ?? (result.costUsd === null ? 'none' : undefined);
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
          result.state, at, costUsd,
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
   * be gone; the caller decides that, this only records it. One with a reservation is charged
   * at it (P2-R44).
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

  /**
   * Run `fn` in the caller's transaction, or in its own `BEGIN IMMEDIATE` when there is none, so
   * the write lock is held before anything is read (SQLite does not nest BEGIN).
   */
  tx<T>(fn: () => T): T {
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

  /** A generated ticket's proposed work item and its row, together (a fix ticket from a finding). */
  insertGeneratedTicket(workItem: CreateWorkItemInput & { id: string }, ticket: Omit<CampaignTicket, 'createdAt' | 'workItemId'>): CampaignTicket {
    return this.tx(() => {
      if (ticket.origin === 'plan') throw new Error('a plan ticket comes from a plan import');
      if (this.campaignTicket(ticket.campaignId, ticket.ticketId)) throw new Error(`campaign ${ticket.campaignId} already has ticket ${ticket.ticketId}`);
      const w = this.createWorkItem(workItem);
      return this.writeTicket({ ...ticket, workItemId: w.id });
    });
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
      .filter((d) => d.kind === 'approve' && isPersonActor(d.actor) && d.scope.operation === 'authorize-campaign').at(-1) ?? null;
  }

  /**
   * `authorize-campaign`, as one transaction. Refused unless the latest `approve-plan` names the
   * current plan and the envelope does too; the latest `lock-campaign-gates` names the gate set
   * the human confirmed (`expectedGateSetDigest`, a string compare); every ticket is an approved
   * plan ticket; the caps are ordered and bounded; and turns and timeout are within
   * `authorLimits` of `policy`, the parsed policy at the plan commit, which must be the one the
   * envelope names (P2-R20). The only writer of an `authorize-campaign` decision.
   */
  authorizeCampaign(
    campaignId: string,
    input: { actor: string; rationale: string; scope: AuthorizeCampaignScope; expectedGateSetDigest: string; policy: ProjectPolicy | null; artifactIds?: string[] },
  ): Decision {
    return this.tx(() => {
      const c = this.requireCampaign(campaignId);
      if (c.state !== 'ready') throw new Error(`campaign ${c.id} is ${c.state}; it is authorized once its plan is approved`);
      const e = input.scope;
      const why = envelopeShapeRefusal(e, this.now());
      if (why) throw new Error(`refused: ${why}`);
      if ((input.policy?.digest ?? null) !== (e.policyDigest ?? null)) throw new Error('refused: the policy given is not the one the envelope names');
      const limits = authorLimits(input.policy, CAMPAIGN_AUTHOR_DEFAULTS);
      if (e.maxTurns > limits.maxTurns || e.timeoutSeconds * 1000 > limits.timeoutMs) {
        throw new Error(`refused: turns and timeout are at most ${limits.maxTurns} and ${limits.timeoutMs / 1000}s under the policy at the plan commit`);
      }
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
      this.authorizingCampaign = true;
      try {
        return this.recordDecision({
          missionId: c.id, projectId: c.projectId, revision: c.baseRevision, actor: input.actor, kind: 'approve',
          rationale: input.rationale, scope: { ...e }, artifactIds: input.artifactIds ?? [],
        });
      } finally {
        this.authorizingCampaign = false;
      }
    });
  }

  /**
   * The halts no person has resumed (`resume-campaign`, or `adopt-integration-tip`, which resumes
   * the halt it names); the latest first. Empty: not halted.
   */
  campaignHalts(campaignId: string): Decision[] {
    const all = this.decisions(campaignId);
    const resumed = new Set(all.filter((d) => (d.scope.operation === 'resume-campaign' || d.scope.operation === 'adopt-integration-tip')
      && isPersonActor(d.actor)).map((d) => d.scope.haltDecisionId));
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
  private derivedAdmission(campaignId: string, workItemId: string): Decision | null {
    return this.decisions(campaignId)
      .filter((d) => d.scope.operation === 'admit-work-item' && isCampaignActor(d.actor) && d.scope.workItemId === workItemId).at(-1) ?? null;
  }

  /**
   * What admitted a generated (fix or follow-up) ticket's work item into its campaign, or null: a
   * derived `admit-work-item`, or a person's `approve-work-item` (`work-item approve`, P2-R36). A
   * plan ticket is never admitted this way; the envelope names it.
   */
  admission(campaignId: string, workItemId: string): Decision | null {
    const derived = this.derivedAdmission(campaignId, workItemId);
    if (derived) return derived;
    const t = this.campaignTicketByWorkItem(workItemId);
    const w = this.workItem(workItemId);
    if (!t || t.campaignId !== campaignId || t.origin === 'plan' || w?.status !== 'approved' || !w.decisionId) return null;
    const d = this.decision(w.decisionId);
    return d && d.scope.operation === 'approve-work-item' && isPersonActor(d.actor) && movesWorkItem(d, w, 'approved') ? d : null;
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
    if (!parent || parent.kind !== 'approve' || !isPersonActor(parent.actor) || parent.scope.operation !== 'authorize-campaign') {
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
    const shape = envelopeShapeRefusal(env, parent.at);
    if (shape) return `authorization ${parent.id} is malformed: ${shape}`;
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
    if (req.operation === 'admit-work-item') {
      // An empty ticket id asks only whether the authorization is in force.
      if (!req.ticketId) return null;
      const fix = this.campaignTicket(campaign.id, req.ticketId);
      if (!fix) return `campaign ${campaign.id} has no ticket ${req.ticketId}`;
      return this.fixLaneRefusal(campaign, env, fix, req.waveSeq, null, this.admissionsInWave(campaign.id, req.waveSeq));
    }
    // §2.2(4): the director integrates only under auto-apply to the integration ref.
    if (req.operation === 'integrate-candidate' && env.autoApply !== 'integration-ref') {
      return `authorization ${parent.id} does not auto-apply (${String(env.autoApply)}); a person decides each candidate`;
    }
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
      if (t.origin === 'fix' && this.derivedAdmission(campaign.id, t.workItemId) && req.maxUsd > env.fixLane.maxUsdPerTicket) return `a fix ticket's budget is at most $${env.fixLane.maxUsdPerTicket}`;
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
    const scope = input.scope as { permissions?: MissionPermissions; maxUsd?: number | null; ticketId?: unknown; waveSeq?: unknown; workItemId?: unknown };
    if (operation === 'integrate-candidate') {
      const why = this.integrateScopeRefusal(input.scope, m.id);
      if (why) throw new Error(`refused: ${why}`);
    }
    if (operation === 'admit-work-item') {
      const t = typeof scope.workItemId === 'string' ? this.campaignTicketByWorkItem(scope.workItemId) : null;
      if (!t || t.campaignId !== parent.missionId || t.ticketId !== scope.ticketId) throw new Error('refused: an admission names its fix ticket and its work item');
    }
    const why = this.envelopeRefusal(parent.id, {
      missionId: m.id, operation, ticketId: typeof scope.ticketId === 'string' ? scope.ticketId : '',
      permissions: scope.permissions, maxUsd: scope.maxUsd ?? null, at: this.now(),
      ...(typeof scope.waveSeq === 'number' ? { waveSeq: scope.waveSeq } : {}),
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
      // An admitted fix ticket runs at the fix lane's per-ticket cap (P2-R10).
      const maxUsd = Math.min(t.budget.maxUsd ?? Number.POSITIVE_INFINITY, env.maxUsdPerMission,
        t.origin === 'fix' && this.derivedAdmission(parent.missionId, t.workItemId) ? env.fixLane.maxUsdPerTicket : Number.POSITIVE_INFINITY);
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

  /** Why a derived grant names a ticket other than the one its mission builds, or null (the audit half of R7). */
  private grantTicketRefusal(d: Decision, m: Mission): string | null {
    const t = m.workItemId ? this.campaignTicketByWorkItem(m.workItemId) : null;
    if (!t || t.ticketId !== d.scope.ticketId) {
      return `derived grant ${d.id} names ticket ${String(d.scope.ticketId)}, but mission ${m.id} builds ${t ? `ticket ${t.ticketId}` : 'no ticket'}`;
    }
    return null;
  }

  /** Why an `integrate-candidate` scope does not name a candidate of `missionId` at its diff, or null. */
  private integrateScopeRefusal(scope: Record<string, unknown>, missionId: string): string | null {
    const c = typeof scope.candidateId === 'string' ? this.candidate(scope.candidateId) : null;
    if (!c || c.missionId !== missionId) return `integrate-candidate names ${String(scope.candidateId)}, which is not a candidate of mission ${missionId}`;
    if (scope.diffDigest !== c.diffArtifact.digest) return `integrate-candidate names candidate ${c.id} at another diff`;
    return null;
  }

  /** Derived admissions recorded in wave `seq` of the campaign, the first `before` decisions only when given. */
  private admissionsInWave(campaignId: string, seq: unknown, before?: string): number {
    let n = 0;
    for (const d of this.decisions(campaignId)) {
      if (d.id === before) break;
      if (d.scope.operation === 'admit-work-item' && isCampaignActor(d.actor) && d.scope.waveSeq === seq) n++;
    }
    return n;
  }

  /**
   * Why admitting fix ticket `t` in wave `waveSeq` is outside the envelope's fix lane, or null
   * (P2-R10, P2-R34): the lane is on, fewer than `maxTicketsPerWave` were admitted in the wave,
   * and no scope path is protected (the built-in sets, the policy when given, the plan and status
   * paths). Whether the finding is High is the caller's; the findings rows are WS-R6's.
   */
  private fixLaneRefusal(
    campaign: Mission, env: CampaignEnvelope, t: CampaignTicket, waveSeq: unknown, policy: ProjectPolicy | null, admitted: number,
  ): string | null {
    if (t.origin !== 'fix') return `ticket ${t.ticketId} is not a fix ticket; only those are admitted`;
    if (!env.fixLane?.enabled) return 'the fix lane is off';
    if (!Number.isInteger(waveSeq) || (waveSeq as number) < 1) return 'an admission names the wave it is admitted in';
    if (admitted >= env.fixLane.maxTicketsPerWave) return `wave ${String(waveSeq)} already admitted ${env.fixLane.maxTicketsPerWave}`;
    const fenced = campaign.scope.paths ?? [];
    for (const p of t.scope) {
      const child = `${p}/x`;
      const rules = [p, child].flatMap((x) => pathViolations({ path: x, change: 'modified', insertions: 0, deletions: 0, mode: 'file' }, { policy }));
      if (fenced.includes(p) || rules.some((r) => r === 'protected-path' || r === 'gate-path' || r === 'path-escape')) {
        return `ticket ${t.ticketId}'s scope is protected`;
      }
    }
    return null;
  }

  /**
   * The director admits a generated (fix) ticket's proposed work item within the envelope: the
   * derived `admit-work-item` and `proposed → approved`, together. The fix lane is checked here
   * against `policy`, the parsed policy at the plan commit (it must be the one the authorization
   * names), and again by `recordDerivedDecision` against the built-in sets. Whether the finding is
   * High is `admitIfWithinEnvelope`'s question.
   */
  admitWorkItem(
    workItemId: string, campaignDecisionId: string, scope: { ticketId: string; findingId?: string; waveSeq: number }, policy: ProjectPolicy | null,
  ): Decision {
    return this.tx(() => {
      const w = this.workItem(workItemId);
      if (!w || w.status !== 'proposed') throw new Error(`work item ${workItemId} is not a proposed work item`);
      const t = this.campaignTicketByWorkItem(w.id);
      if (!t || t.origin !== 'fix' || t.ticketId !== scope.ticketId) throw new Error(`work item ${w.id} is not fix ticket ${scope.ticketId}'s`);
      const parent = this.decision(campaignDecisionId);
      if (!parent || parent.missionId !== t.campaignId) throw new Error(`decision ${campaignDecisionId} is not on campaign ${t.campaignId}`);
      const c = this.requireCampaign(t.campaignId);
      const env = parent.scope as unknown as CampaignEnvelope;
      if ((policy?.digest ?? null) !== (env.policyDigest ?? null)) throw new Error(`refused: the policy given is not the one authorization ${parent.id} names`);
      const lane = this.fixLaneRefusal(c, env, t, scope.waveSeq, policy, this.admissionsInWave(c.id, scope.waveSeq));
      if (lane) throw new Error(`refused: ${lane}`);
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
      if (!parent || parent.kind !== 'approve' || !isPersonActor(parent.actor) || parent.scope.operation !== 'authorize-campaign') {
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
        const named = this.grantTicketRefusal(d, m);
        if (named) out.push(named);
        const built = m.workItemId ? this.campaignTicketByWorkItem(m.workItemId) : null;
        if (built?.origin === 'fix' && this.derivedAdmission(parent.missionId, built.workItemId) && !((d.scope.maxUsd as number) <= env.fixLane.maxUsdPerTicket)) {
          out.push(`derived grant ${d.id} gives fix ticket ${built.ticketId} more than the fix lane's $${env.fixLane.maxUsdPerTicket}`);
        }
        const by = d.scope.admittedBy;
        if (!grant && typeof by === 'string') {
          const a = this.decision(by);
          const t = m.workItemId ? this.campaignTicketByWorkItem(m.workItemId) : null;
          if (!a || !t || this.admission(parent.missionId, t.workItemId)?.id !== a.id) {
            out.push(`derived grant ${d.id} names admission ${by}, which admitted nothing it builds`);
          }
        }
      }
      if (d.scope.operation === 'integrate-candidate') {
        if (env.autoApply !== 'integration-ref') out.push(`derived integration ${d.id} was recorded under authorization ${parent.id}, which does not auto-apply`);
        const why = this.integrateScopeRefusal(d.scope, d.missionId);
        if (why) out.push(`derived integration ${d.id}: ${why}`);
      }
      if (d.scope.operation === 'admit-work-item') {
        const t = typeof d.scope.workItemId === 'string' ? this.campaignTicketByWorkItem(d.scope.workItemId) : null;
        const c = this.mission(parent.missionId);
        if (!t || !c || t.campaignId !== parent.missionId || t.origin === 'plan') out.push(`derived admission ${d.id} names no generated ticket of campaign ${parent.missionId}`);
        else {
          const lane = this.fixLaneRefusal(c, env, t, d.scope.waveSeq, null, this.admissionsInWave(c.id, d.scope.waveSeq, d.id));
          if (lane) out.push(`derived admission ${d.id} is outside authorization ${parent.id}'s fix lane: ${lane}`);
        }
      }
    }
    return out;
  }

  // ---- assumptions ------------------------------------------------------------------

  recordAssumption(input: Omit<Assumption, 'id' | 'createdAt' | 'updatedAt' | 'projectId' | 'decisionId' | 'followUpWorkItemId'> & { decisionId?: string }): Assumption {
    // An IR interpretation lives on its corpus mission and names its record; it is always a need (P2-R12, §6.3).
    const interpretation = input.source === 'ir-interpretation';
    const c = interpretation ? this.requireMission(input.campaignId) : this.requireCampaign(input.campaignId);
    if (interpretation && (c.kind !== 'corpus' || input.irId === undefined || input.status !== 'open')) {
      throw new Error('an ir-interpretation assumption is recorded open, on a corpus mission, naming its IR record');
    }
    if (!interpretation && input.irId !== undefined) throw new Error('only an ir-interpretation assumption names an IR record');
    if (input.status !== 'open' && input.status !== 'pending') throw new Error('an assumption is recorded open or pending');
    // P2-R12: only a person's row is recorded pending; a plan default becomes pending only by approve-plan.
    if (input.status === 'pending' && !isHumanActor(input.recordedBy)) throw new Error(`refused: a row recorded by ${input.recordedBy} is open, never pending`);
    for (const [k, v] of [['question', input.question], ['rationale', input.rationale]] as const) {
      if (typeof v !== 'string' || !v.trim()) throw new Error(`an assumption needs a ${k}`);
    }
    const at = this.now();
    const id = newId('assumption');
    // The CHECKs refuse a pending row nobody human recorded (P2-R12).
    this.db
      .prepare(
        `INSERT INTO assumptions (id, project_id, campaign_id, mission_id, ticket_id, owner_decision_id, question, default_value, rationale,
           status, blocking, source, recorded_by, decision_id, follow_up_work_item_id, ir_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
      )
      .run(
        id, c.projectId, c.id, input.missionId ?? null, input.ticketId ?? null, input.ownerDecisionId ?? null, input.question, input.default,
        input.rationale, input.status, input.blocking ? 1 : 0, input.source, input.recordedBy, input.decisionId ?? null, input.irId ?? null, at, at,
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
      // An IR interpretation lives on its corpus mission (§6.3); it holds tickets by owner decision id, never files one.
      const interpretation = a.source === 'ir-interpretation';
      const c = interpretation ? this.requireMission(a.campaignId) : this.requireCampaign(a.campaignId);
      const op = input.scope.operation;
      if (input.scope.assumptionId !== a.id) throw new Error(`the decision names assumption ${input.scope.assumptionId}, not ${a.id}`);
      const from: Record<AssumptionDecisionScope['operation'], AssumptionStatus[]> = {
        'confirm-assumption': ['pending'], 'decide-assumption': ['open'], 'overturn-assumption': ['open', 'pending', 'confirmed'],
      };
      if (!from[op]?.includes(a.status)) throw new Error(`refused: assumption ${a.id} is ${a.status}; ${op} moves ${from[op]?.join(' or ') ?? 'nothing'}`);
      if (op === 'confirm-assumption' && input.scope.value !== a.default) throw new Error(`refused: confirm names the default assumption ${a.id} proceeds on`);
      if (op !== 'confirm-assumption' && !input.scope.value.trim()) throw new Error(`refused: ${op} needs a value`);
      let followUpWorkItemId: string | undefined;
      if (op === 'overturn-assumption' && !input.followUp && !interpretation) throw new Error('refused: an overturn creates exactly one follow-up');
      if (interpretation && input.followUp) throw new Error('refused: an IR interpretation is overturned without a follow-up; the record is superseded by approve-ir');
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
    if (input.target === 'integrated') {
      // Exactly what was tested: the integration's own commit and onto → commit diff, on its campaign.
      const i = input.integrationId ? this.integration(input.integrationId) : null;
      if (!i || i.campaignId !== m.id || i.candidateId !== input.candidateId) {
        throw new Error(`integration ${String(input.integrationId)} is not campaign ${m.id}'s integration of candidate ${String(input.candidateId)}`);
      }
      if (!i.integratedDiffDigest || input.diffDigest !== i.integratedDiffDigest || input.revision !== i.integratedCommit) {
        throw new Error(`gate evaluation ${String(input.diffDigest)} at ${input.revision} is not integration ${i.id}'s ${String(i.integratedDiffDigest)} at ${String(i.integratedCommit)}`);
      }
    } else if (input.integrationId !== undefined) {
      throw new Error('only an integrated evaluation names an integration');
    }
    const g: GateEvaluation = { ...input, id: newId('gateEvaluation'), createdAt: this.now() };
    this.db
      .prepare(
        `INSERT INTO gate_evaluations
         (id, mission_id, project_id, revision, experiment_id, candidate_id, target, diff_digest,
          integration_id, harness_digest, executions, conclusion, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        g.id, g.missionId, g.projectId, g.revision, g.experimentId, g.candidateId ?? null, g.target,
        g.diffDigest, g.integrationId ?? null, g.harnessDigest, JSON.stringify(g.executions), g.conclusion, g.createdAt,
      );
    for (const ref of g.executions) this.recordArtifact(ref);
    return g;
  }

  gateEvaluations(filter: { missionId?: string; candidateId?: string; target?: GateTarget; integrationId?: string }): GateEvaluation[] {
    if (filter.missionId === undefined && filter.candidateId === undefined && filter.integrationId === undefined) {
      throw new Error('gateEvaluations needs a missionId, a candidateId or an integrationId');
    }
    const where: string[] = [];
    const args: string[] = [];
    if (filter.missionId !== undefined) { where.push('mission_id=?'); args.push(filter.missionId); }
    if (filter.candidateId !== undefined) { where.push('candidate_id=?'); args.push(filter.candidateId); }
    if (filter.target !== undefined) { where.push('target=?'); args.push(filter.target); }
    if (filter.integrationId !== undefined) { where.push('integration_id=?'); args.push(filter.integrationId); }
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
    if (d && scope?.operation === 'integrate-candidate') {
      // A campaign landing: the director's derived decision, onto the integration tip (§4.3).
      const why = this.integratedApplicationRefusal(c, d, input);
      if (why) throw new Error(why);
    } else {
      if (!d || !approving || d.missionId !== c.missionId || scope?.candidateId !== c.id
        || scope.diffDigest !== c.diffArtifact.digest) {
        throw new Error(`decision ${input.decisionId} does not approve candidate ${c.id} at ${c.diffArtifact.digest}`);
      }
      if (input.baseCommit !== c.baseCommit) {
        throw new Error(`application base ${input.baseCommit} is not candidate ${c.id}'s base ${c.baseCommit}`);
      }
      if (!isHumanActor(input.appliedBy)) throw new Error(`apply needs a human:<name> actor, not ${input.appliedBy}`);
    }
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

  /**
   * Why an `integrate-candidate` decision does not cover this application, or null: a campaign
   * actor's approval of this candidate's exact diff, naming an integration of it that is being
   * landed, whose commit, tip and integrated digest the application repeats.
   */
  private integratedApplicationRefusal(c: Candidate, d: Decision, input: CreateApplicationInput): string | null {
    const s = d.scope as Record<string, unknown>;
    if (d.kind !== 'approve' || !isCampaignActor(d.actor) || d.missionId !== c.missionId || s.candidateId !== c.id
      || s.diffDigest !== c.diffArtifact.digest) {
      return `decision ${d.id} is not a campaign's integrate-candidate decision for candidate ${c.id} at ${c.diffArtifact.digest}`;
    }
    const i = typeof s.integrationId === 'string' ? this.integration(s.integrationId) : null;
    if (!i || i.candidateId !== c.id || (i.state !== 'evaluating' && i.state !== 'integrated')) {
      return `decision ${d.id} names no integration of candidate ${c.id} that is being landed`;
    }
    if (input.commit !== i.integratedCommit || s.integratedCommit !== i.integratedCommit || input.baseCommit !== i.onto || s.onto !== i.onto
      || s.integratedDiffDigest !== i.integratedDiffDigest) {
      return `application ${input.commit} onto ${input.baseCommit} is not integration ${i.id}'s ${String(i.integratedCommit)} onto ${i.onto}`;
    }
    if (input.appliedBy !== d.actor || d.actor !== campaignActorOf(i.campaignId)) {
      return `an integrated application is recorded as ${d.actor}, the campaign that decided it, not ${input.appliedBy}`;
    }
    return null;
  }

  // ---- campaign integration (WS-R6) --------------------------------------------------
  //
  // The director's rows: integrations of candidates onto a campaign's integration ref, the
  // campaign gate lock, waves and wave-review findings. Refs live in git; these say why each
  // one moved, and nothing here touches git.

  recordIntegration(input: {
    id?: string; campaignId: string; missionId: string; candidateId: string; ref: string; onto: string; candidateBase: string;
  }): Integration {
    const campaign = this.requireMission(input.campaignId);
    if (campaign.kind !== 'campaign') throw new Error(`mission ${campaign.id} is ${campaign.kind}, not a campaign`);
    const m = this.requireMission(input.missionId);
    if (m.parentId !== campaign.id) throw new Error(`mission ${m.id} is not a ticket mission of campaign ${campaign.id}`);
    const c = this.candidate(input.candidateId);
    if (!c || c.missionId !== m.id) throw new Error(`candidate ${input.candidateId} is not a candidate of mission ${m.id}`);
    if (input.id !== undefined && !isEntityId('integration', input.id)) throw new Error(`${input.id} is not an integration id`);
    for (const sha of [input.onto, input.candidateBase]) {
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a git object id`);
    }
    const at = this.now();
    const i: Integration = {
      id: input.id ?? newId('integration'), campaignId: campaign.id, projectId: campaign.projectId, missionId: m.id,
      candidateId: c.id, ref: input.ref, onto: input.onto, candidateBase: input.candidateBase, method: null,
      integratedCommit: null, integratedTree: null, integratedDiffDigest: null, state: 'pending', conflictPaths: [],
      acceptanceVacuous: null, decisionId: null, applicationId: null, createdAt: at, updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO integrations
         (id, campaign_id, project_id, mission_id, candidate_id, ref, onto, candidate_base, state, conflict_paths, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(i.id, i.campaignId, i.projectId, i.missionId, i.candidateId, i.ref, i.onto, i.candidateBase, i.state, '[]', at, at);
    return i;
  }

  /**
   * Move an integration, compare-and-set on its state: refused unless it is `from` now and the
   * move is one `INTEGRATION_TRANSITIONS` draws. `evaluating → evaluating` only patches.
   */
  updateIntegration(id: string, from: IntegrationState, patch: Partial<Pick<Integration,
    'state' | 'method' | 'integratedCommit' | 'integratedTree' | 'integratedDiffDigest' | 'conflictPaths' | 'acceptanceVacuous'
    | 'decisionId' | 'applicationId'>>): Integration {
    const i = this.integration(id);
    if (!i) throw new Error(`unknown integration ${id}`);
    const to = patch.state ?? from;
    if (i.state !== from) throw new IllegalTransition('integration', id, `${i.state} (expected ${from})`, to);
    if (to !== from && !INTEGRATION_TRANSITIONS[from].includes(to)) throw new IllegalTransition('integration', id, from, to);
    const next: Integration = { ...i, ...patch, state: to, updatedAt: this.now() };
    const r = this.db
      .prepare(
        `UPDATE integrations SET state=?, method=?, integrated_commit=?, integrated_tree=?, integrated_diff_digest=?,
           conflict_paths=?, acceptance_vacuous=?, decision_id=?, application_id=?, updated_at=?
         WHERE id=? AND state=?`,
      )
      .run(
        next.state, next.method, next.integratedCommit, next.integratedTree, next.integratedDiffDigest,
        JSON.stringify(next.conflictPaths), next.acceptanceVacuous === null ? null : next.acceptanceVacuous ? 1 : 0,
        next.decisionId, next.applicationId, next.updatedAt, id, from,
      );
    if (!r.changes) throw new IllegalTransition('integration', id, 'changed underneath', to);
    return this.integration(id)!;
  }

  integration(id: string): Integration | null {
    const r = this.db.prepare('SELECT * FROM integrations WHERE id=?').get(id);
    return r ? rowToIntegration(r) : null;
  }

  integrations(campaignId: string, opts: { state?: IntegrationState; missionId?: string } = {}): Integration[] {
    return this.db
      .prepare('SELECT * FROM integrations WHERE campaign_id=? ORDER BY created_at, rowid')
      .all(campaignId)
      .map(rowToIntegration)
      .filter((i) => (opts.state === undefined || i.state === opts.state) && (opts.missionId === undefined || i.missionId === opts.missionId));
  }

  /** The candidate's latest integration that was not abandoned, or null. */
  integrationFor(candidateId: string): Integration | null {
    const r = this.db
      .prepare(`SELECT * FROM integrations WHERE candidate_id=? AND state <> 'abandoned' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(candidateId);
    return r ? rowToIntegration(r) : null;
  }

  /**
   * The campaign gate set a lock of exactly these experiments would freeze, its bindings and its
   * digest: the one computation behind `lockCampaignGates`, its `--confirm` preview and the
   * director's preflight. A binding comes from the experiment's subject (`ticket:<id>`), which
   * nothing rewrites after registration; the digest covers it and the ratchet flag (P2-R17).
   */
  campaignGateSet(campaignId: string, experimentIds: readonly string[], ratchet: boolean, obligations: Record<string, readonly string[]> = {}): {
    experiments: Experiment[]; bindings: Record<string, string | null>; roles: CampaignLockScope['roles']; gateSetDigest: string;
    obligations: Record<string, string[]>;
  } {
    const m = this.requireMission(campaignId);
    if (m.kind !== 'campaign') throw new Error(`mission ${m.id} is ${m.kind}, not a campaign`);
    const ids = [...new Set(experimentIds)].sort();
    if (!ids.length) throw new Error(`campaign ${m.id}: a gate lock names at least one gate`);
    const experiments = ids.map((id) => {
      const x = this.experiment(id);
      if (!x || x.missionId !== m.id) throw new Error(`experiment ${id} is not an experiment of campaign ${m.id}`);
      if (x.role !== 'regression' && x.role !== 'gate' && x.role !== 'holdout') {
        throw new Error(`experiment ${id} is a ${x.role}; a campaign lock names regression gates, gates and holdouts`);
      }
      return x;
    });
    const bindings = Object.fromEntries(experiments.map((x) => [x.id, campaignBindingOf(x)]));
    const roles = Object.fromEntries(experiments.map((x) => [x.id, x.role])) as CampaignLockScope['roles'];
    const lines = experiments.map((x) => `${x.id}:${x.harnessDigest}:${x.role}:${bindings[x.id] ?? '*'}`).sort();
    // Acceptance obligations a locked gate discharges (spec ingestion §8.4): in the digest only when
    // there are any, so a lock without them digests as it always did.
    const bound: Record<string, string[]> = {};
    for (const [x, obs] of Object.entries(obligations)) {
      if (!ids.includes(x)) throw new Error(`obligations name experiment ${x}, which is not in the set being locked`);
      if (!obs.every((o) => typeof o === 'string' && /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*:ob[0-9]{1,3}$/.test(o))) throw new Error(`experiment ${x}'s obligations are <ticket>:ob<n>`);
      if (obs.length) bound[x] = [...new Set(obs)].sort();
    }
    const obLines = Object.entries(bound).flatMap(([x, obs]) => obs.map((o) => `ob:${x}:${o}`)).sort();
    return { experiments, bindings, roles, obligations: bound, gateSetDigest: digestOf([...lines, ...obLines, `ratchet:${ratchet}`].join('\n')) };
  }

  /**
   * `campaign lock`, as one transaction: recompute the set inside `BEGIN IMMEDIATE`, refuse any
   * other than the one confirmed, record the human's `lock-campaign-gates` decision and stamp
   * `locked_by`. Same shape as `lockGates`.
   */
  lockCampaignGates(campaignId: string, input: LockGatesInput & { ratchet: boolean; obligations?: Record<string, readonly string[]> }): { decision: Decision; gateSetDigest: string } {
    const m = this.requireMission(campaignId);
    if (typeof input.expectedGateSetDigest !== 'string' || !input.expectedGateSetDigest) {
      throw new Error(`campaign ${m.id}: a gate lock names the gate-set digest the human confirmed`);
    }
    return this.tx(() => {
      const set = this.campaignGateSet(m.id, input.experimentIds, input.ratchet, input.obligations);
      if (set.gateSetDigest !== input.expectedGateSetDigest) {
        throw new GateSetMoved(
          `campaign ${m.id}: the gate set is ${set.gateSetDigest}, not the one confirmed (${input.expectedGateSetDigest}); ` +
            'a gate changed after it was shown — review it and lock again',
        );
      }
      const ids = set.experiments.map((x) => x.id);
      const vacuous = [...new Set(input.vacuousOverrides ?? [])].sort();
      for (const id of vacuous) if (!ids.includes(id)) throw new Error(`vacuous override ${id} is not one of the gates being locked`);
      const scope: CampaignLockScope = {
        operation: 'lock-campaign-gates', experimentIds: ids,
        harnessDigests: Object.fromEntries(set.experiments.map((x) => [x.id, x.harnessDigest])),
        vacuousOverrides: vacuous, bindings: set.bindings, roles: set.roles, ratchet: input.ratchet, gateSetDigest: set.gateSetDigest,
        ...(Object.keys(set.obligations).length ? { obligations: set.obligations } : {}),
      };
      const decision = this.recordDecision({
        missionId: m.id, projectId: m.projectId, revision: m.baseRevision, actor: input.actor, kind: 'approve',
        rationale: input.rationale, scope: scope as unknown as Record<string, unknown>, artifactIds: input.artifactIds ?? [],
      });
      const lock = this.db.prepare('UPDATE experiments SET locked_by=?, updated_at=? WHERE id=?');
      for (const id of ids) lock.run(decision.id, this.now(), id);
      return { decision, gateSetDigest: set.gateSetDigest };
    });
  }

  /** The campaign's latest approving `lock-campaign-gates` decision, or null. */
  campaignLockDecision(campaignId: string): Decision | null {
    return this.decisions(campaignId).filter((d) => d.kind === 'approve' && d.scope.operation === 'lock-campaign-gates').at(-1) ?? null;
  }

  recordWave(w: Omit<CampaignWave, 'closedAt' | 'reviewMissionId'>): CampaignWave {
    const m = this.requireMission(w.campaignId);
    if (m.kind !== 'campaign') throw new Error(`mission ${m.id} is ${m.kind}, not a campaign`);
    const want = (this.waves(m.id).at(-1)?.seq ?? 0) + 1;
    if (w.seq !== want) throw new Error(`campaign ${m.id}'s next wave is ${want}, not ${w.seq}`);
    const at = this.now();
    this.db
      .prepare('INSERT INTO campaign_waves (campaign_id, seq, from_commit, to_commit, ticket_ids, review_mission_id, closed_at) VALUES (?,?,?,?,?,NULL,?)')
      .run(m.id, w.seq, w.fromCommit, w.toCommit, JSON.stringify(w.ticketIds), at);
    return { ...w, reviewMissionId: null, closedAt: at };
  }

  /** Name the wave's review mission, once. */
  setWaveReview(campaignId: string, seq: number, reviewMissionId: string): CampaignWave {
    const r = this.db
      .prepare('UPDATE campaign_waves SET review_mission_id=? WHERE campaign_id=? AND seq=? AND review_mission_id IS NULL')
      .run(reviewMissionId, campaignId, seq);
    if (!r.changes) throw new Error(`wave ${seq} of campaign ${campaignId} is unknown or already has a review mission`);
    return this.waves(campaignId).find((w) => w.seq === seq)!;
  }

  waves(campaignId: string): CampaignWave[] {
    return (this.db.prepare('SELECT * FROM campaign_waves WHERE campaign_id=? ORDER BY seq').all(campaignId) as Array<Record<string, unknown>>)
      .map((r) => ({
        campaignId: r.campaign_id as string, seq: r.seq as number, fromCommit: r.from_commit as string, toCommit: r.to_commit as string,
        ticketIds: parseJson<string[]>(r.ticket_ids as string, []), reviewMissionId: (r.review_mission_id as string | null) ?? null,
        closedAt: r.closed_at as number,
      }));
  }

  /** Idempotent on `id`: the same finding ingested twice is one row. */
  recordFinding(f: Omit<Finding, 'createdAt' | 'corroboratedBy' | 'fixTicketId'>): Finding {
    if (!isEntityId('finding', f.id)) throw new Error(`${f.id} is not a finding id`);
    if (!(FINDING_SEVERITIES as readonly string[]).includes(f.severity)) throw new Error(`severity ${String(f.severity)} is not one of ${FINDING_SEVERITIES.join(', ')}`);
    const a = this.requireAttempt(f.attemptId);
    if (a.missionId !== f.reviewMissionId) throw new Error(`attempt ${a.id} is not an attempt of review mission ${f.reviewMissionId}`);
    const have = this.finding(f.id);
    if (have) return have;
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO findings (id, project_id, campaign_id, wave_seq, review_mission_id, attempt_id, path, severity, title, statement,
           finding_artifact, corroborated_by, fix_ticket_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'[]',NULL,?)`,
      )
      .run(f.id, f.projectId, f.campaignId, f.waveSeq, f.reviewMissionId, f.attemptId, f.path, f.severity, f.title, f.statement,
        JSON.stringify(f.findingArtifact), at);
    this.recordArtifact(f.findingArtifact);
    return this.finding(f.id)!;
  }

  finding(id: string): Finding | null {
    const r = this.db.prepare('SELECT * FROM findings WHERE id=?').get(id);
    return r ? rowToFinding(r) : null;
  }

  findings(campaignId: string, opts: { waveSeq?: number; severity?: FindingSeverity } = {}): Finding[] {
    return this.db
      .prepare('SELECT * FROM findings WHERE campaign_id=? ORDER BY wave_seq, created_at, id')
      .all(campaignId)
      .map(rowToFinding)
      .filter((f) => (opts.waveSeq === undefined || f.waveSeq === opts.waveSeq) && (opts.severity === undefined || f.severity === opts.severity));
  }

  /** Corroboration and the fix ticket a finding became; neither touches a verdict (ADR-19). */
  updateFinding(id: string, patch: { corroboratedBy?: string[]; fixTicketId?: string }): Finding {
    const f = this.finding(id);
    if (!f) throw new Error(`unknown finding ${id}`);
    if (patch.fixTicketId !== undefined && f.fixTicketId !== undefined && f.fixTicketId !== patch.fixTicketId) {
      throw new Error(`finding ${id} already became ${f.fixTicketId}`);
    }
    this.db.prepare('UPDATE findings SET corroborated_by=?, fix_ticket_id=? WHERE id=?')
      .run(JSON.stringify(patch.corroboratedBy ?? f.corroboratedBy), patch.fixTicketId ?? f.fixTicketId ?? null, id);
    return this.finding(id)!;
  }

  /**
   * The rows half of `integrationRefusals`: integrated rows without their decision or
   * application, decisions or applications that do not name them back, and more than one
   * landing per candidate. One line per breach; empty means it holds.
   */
  integrationRowRefusals(campaignId: string): string[] {
    const out: string[] = [];
    for (const i of this.integrations(campaignId)) {
      if (i.state !== 'integrated') {
        if (i.decisionId || i.applicationId) out.push(`${i.id}: ${i.state}, yet names a decision or an application`);
        continue;
      }
      const d = i.decisionId ? this.decision(i.decisionId) : null;
      if (!d || d.scope.operation !== 'integrate-candidate' || d.scope.integrationId !== i.id || d.actor !== campaignActorOf(campaignId)) {
        out.push(`${i.id}: decision ${String(i.decisionId)} is not this campaign's integrate-candidate decision for it`);
      }
      const p = this.application(i.candidateId);
      if (!p || p.id !== i.applicationId || p.commit !== i.integratedCommit || p.baseCommit !== i.onto || p.decisionId !== i.decisionId) {
        out.push(`${i.id}: application ${String(i.applicationId)} does not record commit ${String(i.integratedCommit)} onto ${i.onto}`);
      }
    }
    return out;
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

  // ---- spec ingestion (WS-R14/R15/R16) ------------------------------------------------
  //
  // Rows only; the rules are in engine/forge/{corpus,ir,ir-review,blueprint,packets,authority}.ts.
  // Every insert is idempotent on its key. A revision adds spans and never rewrites one, so
  // staleness is the absence of a row (P2-R53). Status setters move only along their tables.

  insertCorpusRevision(r: Omit<CorpusRevision, 'createdAt'>): CorpusRevision {
    const have = this.corpusRevision(r.id);
    if (have) return have;
    const corpus = this.requireMission(r.corpusId);
    if (corpus.kind !== 'corpus' || corpus.projectId !== r.projectId) throw new Error(`${r.corpusId} is not a corpus mission of project ${r.projectId}`);
    if (!isEntityId('corpusRevision', r.id)) throw new Error(`${r.id} is not a corpus revision id`);
    if (this.corpusRevisionByDigest(r.corpusId, r.corpusDigest)) throw new Error(`corpus ${r.corpusId} already has a revision at ${r.corpusDigest}`);
    this.db
      .prepare(
        `INSERT INTO corpus_revisions (id, corpus_id, project_id, seq, manifest_path, manifest_digest, commits, corpus_digest, docs, precedence,
           dependencies, unordered, section_index, section_set_digest, sectioner_version, config_digest, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id, r.corpusId, r.projectId, r.seq, r.manifestPath, r.manifestDigest, JSON.stringify(r.commits), r.corpusDigest, JSON.stringify(r.docs),
        JSON.stringify(r.precedence), JSON.stringify(r.dependencies), JSON.stringify(r.unordered), r.sectionIndex.id, r.sectionSetDigest,
        r.sectionerVersion, r.configDigest, this.now(),
      );
    return this.corpusRevision(r.id)!;
  }

  corpusRevision(id: string): CorpusRevision | null {
    const r = this.db.prepare('SELECT * FROM corpus_revisions WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToCorpusRevision(r) : null;
  }

  corpusRevisions(corpusId: string): CorpusRevision[] {
    return (this.db.prepare('SELECT * FROM corpus_revisions WHERE corpus_id=? ORDER BY seq').all(corpusId) as Array<Record<string, unknown>>)
      .map((r) => this.rowToCorpusRevision(r));
  }

  currentCorpusRevision(corpusId: string): CorpusRevision | null {
    const r = this.db.prepare('SELECT * FROM corpus_revisions WHERE corpus_id=? ORDER BY seq DESC LIMIT 1').get(corpusId) as
      Record<string, unknown> | undefined;
    return r ? this.rowToCorpusRevision(r) : null;
  }

  corpusRevisionByDigest(corpusId: string, corpusDigest: string): CorpusRevision | null {
    const r = this.db.prepare('SELECT * FROM corpus_revisions WHERE corpus_id=? AND corpus_digest=?').get(corpusId, corpusDigest) as
      Record<string, unknown> | undefined;
    return r ? this.rowToCorpusRevision(r) : null;
  }

  /** Recorded `proposed`; only `setIrStatus`, under a human decision, moves it. */
  insertIrRecord(r: NewIrRecord): IrRecord {
    const have = this.irRecord(r.id);
    if (have) return have;
    if (!isEntityId('irRecord', r.id)) throw new Error(`${r.id} is not an IR record id`);
    const corpus = this.requireMission(r.corpusId);
    if (corpus.kind !== 'corpus' || corpus.projectId !== r.projectId) throw new Error(`${r.corpusId} is not a corpus mission of project ${r.projectId}`);
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO ir_records (id, project_id, corpus_id, kind, source, doc_key, quote, other_quote, statement, attrs, basis_sections, confidence,
           content_digest, status, ir_version, proposed_by, first_revision, proposal_artifact, overridden_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?,?,?,'[]',?,?)`,
      )
      .run(
        r.id, r.projectId, r.corpusId, r.kind, r.source, r.docKey, r.quote, r.otherQuote, r.statement, JSON.stringify(r.attrs ?? {}),
        JSON.stringify(r.basisSections ?? []), r.confidence, r.contentDigest, r.irVersion, r.proposedBy, r.firstRevision, r.proposalArtifact ?? null,
        at, at,
      );
    return this.irRecord(r.id)!;
  }

  /** The record with its spans at `revisionId`, by default its corpus's current revision; no span there = stale. */
  irRecord(id: string, revisionId?: string): IrRecord | null {
    const r = this.db.prepare('SELECT * FROM ir_records WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToIrRecord(r, revisionId ?? this.currentCorpusRevision(r.corpus_id as string)?.id ?? null) : null;
  }

  irRecords(corpusId: string, f: { status?: IrStatus; kind?: IrKind; docKey?: string; sectionId?: string; revisionId?: string } = {}): IrRecord[] {
    const revisionId = f.revisionId ?? this.currentCorpusRevision(corpusId)?.id ?? null;
    return (this.db.prepare('SELECT * FROM ir_records WHERE corpus_id=? ORDER BY created_at, id').all(corpusId) as Array<Record<string, unknown>>)
      .map((r) => this.rowToIrRecord(r, revisionId))
      .filter((r) => (f.status === undefined || r.status === f.status) && (f.kind === undefined || r.kind === f.kind)
        && (f.docKey === undefined || r.span?.docKey === f.docKey) && (f.sectionId === undefined || r.span?.sectionId === f.sectionId));
  }

  /** Forbidden-call guarded (§9): called only from the approve-ir path. */
  setIrStatus(id: string, to: 'approved' | 'rejected' | 'superseded', decisionId: string, o: { assumptionId?: string } = {}): IrRecord {
    const r = this.irRecord(id);
    if (!r) throw new Error(`unknown IR record ${id}`);
    if (!canTransition(IR_TRANSITIONS, r.status, to)) throw new IllegalTransition('IR record', id, r.status, to);
    const d = this.decision(decisionId);
    if (!d || d.projectId !== r.projectId) throw new Error(`decision ${decisionId} is not a decision of project ${r.projectId}`);
    // Only a person's approve-ir on this record's corpus moves it (P2-R56, P2-R59): no borrowed decision.
    if (d.scope.operation !== 'approve-ir' || !isPersonActor(d.actor) || d.missionId !== r.corpusId) {
      throw new Error(`decision ${decisionId} is not a person's approve-ir decision on corpus ${r.corpusId}`);
    }
    // An inferred record without basis is approved on its confirmed interpretation, which it then names.
    const u = o.assumptionId !== undefined ? this.assumption(o.assumptionId) : null;
    if (o.assumptionId !== undefined && (u?.irId !== id || u.status !== 'confirmed')) throw new Error(`assumption ${o.assumptionId} is not a confirmed interpretation of ${id}`);
    this.db.prepare('UPDATE ir_records SET status=?, decision_id=?, assumption_id=COALESCE(?, assumption_id), updated_at=? WHERE id=?')
      .run(to, decisionId, u?.id ?? null, this.now(), id);
    return this.irRecord(id)!;
  }

  insertIrSpan(s: IrSpanRow): void {
    this.db
      .prepare(
        `INSERT INTO ir_spans (ir_id, revision_id, role, doc_key, section_id, start_byte, end_byte, quote_digest, carry)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      )
      .run(s.irId, s.revisionId, s.role, s.docKey, s.sectionId, s.start, s.end, s.quoteDigest, s.carry);
  }

  irSpans(irId: string): IrSpanRow[] {
    return (this.db.prepare(
      `SELECT s.* FROM ir_spans s JOIN corpus_revisions r ON r.id = s.revision_id WHERE s.ir_id=? ORDER BY r.seq, s.role`,
    ).all(irId) as Array<Record<string, unknown>>).map(rowToIrSpan);
  }

  /** Spans at a revision overlapping `[start, end)` of one document. */
  irSpansAt(revisionId: string, docKey: string, start: number, end: number): IrSpanRow[] {
    return (this.db.prepare(
      'SELECT * FROM ir_spans WHERE revision_id=? AND doc_key=? AND start_byte < ? AND end_byte > ? ORDER BY start_byte, ir_id, role',
    ).all(revisionId, docKey, end, start) as Array<Record<string, unknown>>).map(rowToIrSpan);
  }

  insertIrObservation(o: IrObservation): void {
    this.db
      .prepare('INSERT INTO ir_observations (ir_id, attempt_id, runner_id, window_id, confidence, at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(o.irId, o.attemptId, o.runnerId, o.windowId, o.confidence, o.at);
  }

  irObservations(irId: string): IrObservation[] {
    return (this.db.prepare('SELECT * FROM ir_observations WHERE ir_id=? ORDER BY at, attempt_id').all(irId) as Array<Record<string, unknown>>)
      .map((r) => ({
        irId: r.ir_id as string, attemptId: r.attempt_id as string, runnerId: r.runner_id as string, windowId: r.window_id as string,
        confidence: r.confidence as number, at: r.at as number,
      }));
  }

  insertIrLink(l: IrLinkRow): void {
    this.db
      .prepare('INSERT INTO ir_links (from_ir, to_ir, kind, basis, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(l.fromIr, l.toIr, l.kind, l.basis, l.createdAt);
  }

  /** Links from or to the record. */
  irLinks(irId: string): IrLinkRow[] {
    return (this.db.prepare('SELECT * FROM ir_links WHERE from_ir=? OR to_ir=? ORDER BY created_at, from_ir, to_ir, kind').all(irId, irId) as
      Array<Record<string, unknown>>).map((r) => ({
      fromIr: r.from_ir as string, toIr: r.to_ir as string, kind: r.kind as IrLinkRow['kind'], basis: r.basis as IrLinkRow['basis'],
      createdAt: r.created_at as number,
    }));
  }

  insertIrFinding(f: Omit<IrFinding, 'disposition' | 'decisionId'>): IrFinding {
    const have = this.irFinding(f.id);
    if (have) return have;
    if (!isEntityId('irFinding', f.id)) throw new Error(`${f.id} is not an IR finding id`);
    this.db
      .prepare(
        `INSERT INTO ir_findings (id, project_id, corpus_id, review_mission_id, attempt_id, kind, severity, ir_id, element_id, span, title, statement,
           finding_artifact, corroborated_by, disposition, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?)`,
      )
      .run(
        f.id, f.projectId, f.corpusId, f.reviewMissionId, f.attemptId, f.kind, f.severity, f.irId, f.elementId, f.span ? JSON.stringify(f.span) : null,
        f.title, f.statement, f.findingArtifact.id, JSON.stringify(f.corroboratedBy), f.createdAt,
      );
    return this.irFinding(f.id)!;
  }

  irFinding(id: string): IrFinding | null {
    const r = this.db.prepare('SELECT * FROM ir_findings WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToIrFinding(r) : null;
  }

  irFindings(corpusId: string, f: { disposition?: IrFinding['disposition']; irId?: string } = {}): IrFinding[] {
    return (this.db.prepare('SELECT * FROM ir_findings WHERE corpus_id=? ORDER BY created_at, id').all(corpusId) as Array<Record<string, unknown>>)
      .map((r) => this.rowToIrFinding(r))
      .filter((x) => (f.disposition === undefined || x.disposition === f.disposition) && (f.irId === undefined || x.irId === f.irId));
  }

  setIrFindingDisposition(id: string, d: 'accepted' | 'dismissed', decisionId: string): IrFinding {
    const f = this.irFinding(id);
    if (!f) throw new Error(`unknown IR finding ${id}`);
    if (f.disposition !== 'open') throw new IllegalTransition('IR finding', id, f.disposition, d);
    if (!this.decision(decisionId)) throw new Error(`unknown decision ${decisionId}`);
    this.db.prepare('UPDATE ir_findings SET disposition=?, decision_id=? WHERE id=?').run(d, decisionId, id);
    return this.irFinding(id)!;
  }

  insertBlueprint(b: Omit<Blueprint, 'status' | 'decisionId' | 'createdAt' | 'updatedAt'>): Blueprint {
    const have = this.blueprint(b.id);
    if (have) return have;
    if (!isEntityId('blueprint', b.id)) throw new Error(`${b.id} is not a blueprint id`);
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO blueprints (id, project_id, corpus_id, revision_id, ir_set_digest, body_artifact, blueprint_digest, status, proposed_by,
           attempt_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'proposed',?,?,?,?)`,
      )
      .run(b.id, b.projectId, b.corpusId, b.revisionId, b.body.irSetDigest, b.bodyArtifact.id, b.blueprintDigest, b.proposedBy, b.attemptId ?? null, at, at);
    return this.blueprint(b.id)!;
  }

  blueprint(id: string): Blueprint | null {
    const r = this.db.prepare('SELECT * FROM blueprints WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToBlueprint(r) : null;
  }

  blueprints(corpusId: string): Blueprint[] {
    return (this.db.prepare('SELECT * FROM blueprints WHERE corpus_id=? ORDER BY created_at, id').all(corpusId) as Array<Record<string, unknown>>)
      .map((r) => this.rowToBlueprint(r));
  }

  /** Forbidden-call guarded (§9): called only from the approve-blueprint path. */
  setBlueprintStatus(id: string, to: 'approved' | 'rejected' | 'superseded', decisionId: string): Blueprint {
    const b = this.blueprint(id);
    if (!b) throw new Error(`unknown blueprint ${id}`);
    if (!canTransition(IR_TRANSITIONS, b.status, to)) throw new IllegalTransition('blueprint', id, b.status, to);
    const d = this.decision(decisionId);
    if (!d || d.projectId !== b.projectId || d.scope.operation !== 'approve-blueprint' || !isPersonActor(d.actor) || d.missionId !== b.corpusId) {
      throw new Error(`decision ${decisionId} is not a person's approve-blueprint decision on corpus ${b.corpusId}`);
    }
    this.db.prepare('UPDATE blueprints SET status=?, decision_id=?, updated_at=? WHERE id=?').run(to, decisionId, this.now(), id);
    return this.blueprint(id)!;
  }

  insertDerivations(rows: BlueprintDerivation[]): void {
    const own = !this.db.isTransaction;
    if (own) this.db.exec('BEGIN');
    try {
      const ins = this.db.prepare('INSERT INTO blueprint_derivations (blueprint_id, element_id, ir_id, role) VALUES (?,?,?,?) ON CONFLICT DO NOTHING');
      for (const d of rows) ins.run(d.blueprintId, d.elementId, d.irId, d.role);
      if (own) this.db.exec('COMMIT');
    } catch (err) {
      if (own) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  derivations(blueprintId: string): BlueprintDerivation[] {
    return (this.db.prepare('SELECT * FROM blueprint_derivations WHERE blueprint_id=? ORDER BY element_id, ir_id, role').all(blueprintId) as
      Array<Record<string, unknown>>).map(rowToDerivation);
  }

  derivationsOfIr(irId: string): BlueprintDerivation[] {
    return (this.db.prepare('SELECT * FROM blueprint_derivations WHERE ir_id=? ORDER BY blueprint_id, element_id, role').all(irId) as
      Array<Record<string, unknown>>).map(rowToDerivation);
  }

  insertPacket(p: Omit<PacketRow, 'createdAt' | 'updatedAt'>): PacketRow {
    const have = this.packet(p.id);
    if (have) return have;
    if (!isEntityId('packet', p.id)) throw new Error(`${p.id} is not a packet id`);
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO packets (id, project_id, blueprint_id, component_id, ticket_id, packet_digest, body_artifact, status, proposed_by, attempt_id,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(p.id, p.projectId, p.blueprintId, p.componentId, p.ticketId, p.packetDigest, p.bodyArtifact.id, p.status, p.proposedBy, p.attemptId ?? null, at, at);
    return this.packet(p.id)!;
  }

  packet(id: string): PacketRow | null {
    const r = this.db.prepare('SELECT * FROM packets WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToPacket(r) : null;
  }

  packets(blueprintId: string): PacketRow[] {
    return (this.db.prepare('SELECT * FROM packets WHERE blueprint_id=? ORDER BY ticket_id, created_at, id').all(blueprintId) as
      Array<Record<string, unknown>>).map((r) => this.rowToPacket(r));
  }

  setPacketStatus(id: string, to: 'emitted' | 'superseded'): PacketRow {
    const p = this.packet(id);
    if (!p) throw new Error(`unknown packet ${id}`);
    const legal: Record<PacketRow['status'], readonly PacketRow['status'][]> = { proposed: ['emitted', 'superseded'], emitted: ['superseded'], superseded: [] };
    if (p.status !== to && !legal[p.status].includes(to)) throw new IllegalTransition('packet', id, p.status, to);
    this.db.prepare('UPDATE packets SET status=?, updated_at=? WHERE id=?').run(to, this.now(), id);
    return this.packet(id)!;
  }

  insertTicketTrace(rows: TicketTraceRow[]): void {
    const own = !this.db.isTransaction;
    if (own) this.db.exec('BEGIN');
    try {
      const ins = this.db.prepare(
        `INSERT INTO ticket_trace (campaign_id, ticket_id, ir_id, role, detail, packet_id, hand_edited) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      );
      for (const t of rows) ins.run(t.campaignId, t.ticketId, t.irId, t.role, t.detail, t.packetId, t.handEdited ? 1 : 0);
      if (own) this.db.exec('COMMIT');
    } catch (err) {
      if (own) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The campaign's trace as its current plan states it: the rows of an earlier import are replaced, in one transaction. */
  replaceTicketTrace(campaignId: string, rows: TicketTraceRow[]): void {
    this.tx(() => {
      if (rows.some((t) => t.campaignId !== campaignId)) throw new Error(`a trace row names another campaign than ${campaignId}`);
      this.db.prepare('DELETE FROM ticket_trace WHERE campaign_id=?').run(campaignId);
      this.insertTicketTrace(rows);
    });
  }

  ticketTrace(campaignId: string, ticketId?: string): TicketTraceRow[] {
    const rows = (ticketId === undefined
      ? this.db.prepare('SELECT * FROM ticket_trace WHERE campaign_id=? ORDER BY ticket_id, ir_id, role').all(campaignId)
      : this.db.prepare('SELECT * FROM ticket_trace WHERE campaign_id=? AND ticket_id=? ORDER BY ir_id, role').all(campaignId, ticketId)) as
      Array<Record<string, unknown>>;
    return rows.map(rowToTicketTrace);
  }

  ticketsTracing(irId: string): TicketTraceRow[] {
    return (this.db.prepare('SELECT * FROM ticket_trace WHERE ir_id=? ORDER BY campaign_id, ticket_id, role').all(irId) as
      Array<Record<string, unknown>>).map(rowToTicketTrace);
  }

  /**
   * Overturn the open interpretations of a record a person's approve-ir rejected or superseded:
   * a record that says nothing any more has no reading to decide. Returns the rows it moved.
   */
  closeInterpretations(irId: string, decisionId: string): string[] {
    const r = this.irRecord(irId);
    const d = this.decision(decisionId);
    if (!r || (r.status !== 'rejected' && r.status !== 'superseded')) throw new Error(`record ${irId} is not rejected or superseded`);
    if (!d || d.scope.operation !== 'approve-ir' || !isPersonActor(d.actor) || d.missionId !== r.corpusId) throw new Error(`decision ${decisionId} is not a person's approve-ir on corpus ${r.corpusId}`);
    const ids = (this.db.prepare(`SELECT id FROM assumptions WHERE ir_id=? AND source='ir-interpretation' AND status='open'`).all(irId) as Array<{ id: string }>).map((x) => x.id);
    for (const id of ids) this.db.prepare(`UPDATE assumptions SET status='overturned', decision_id=?, updated_at=? WHERE id=? AND status='open'`).run(decisionId, this.now(), id);
    return ids;
  }

  /** The first assumption of any mission of the project for an owner decision id (`OIR.*` dedupe across missions, §6.3). */
  assumptionByOwnerDecision(projectId: string, ownerDecisionId: string): Assumption | null {
    const r = this.db.prepare('SELECT * FROM assumptions WHERE project_id=? AND owner_decision_id=? ORDER BY created_at, rowid LIMIT 1')
      .get(projectId, ownerDecisionId) as Record<string, unknown> | undefined;
    return r ? rowToAssumption(r) : null;
  }

  private rowToCorpusRevision(r: Record<string, unknown>): CorpusRevision {
    const sectionIndex = this.artifact(r.section_index as string);
    if (!sectionIndex) throw new Error(`corpus revision ${r.id as string}: section index artifact is not recorded`);
    return {
      id: r.id as string, corpusId: r.corpus_id as string, projectId: r.project_id as string, seq: r.seq as number,
      manifestPath: r.manifest_path as string, manifestDigest: r.manifest_digest as string,
      commits: parseJson<Record<string, string>>(r.commits as string, {}), corpusDigest: r.corpus_digest as string,
      docs: parseJson<CorpusRevision['docs']>(r.docs as string, []), precedence: parseJson<CorpusRevision['precedence']>(r.precedence as string, []),
      dependencies: parseJson<CorpusRevision['dependencies']>(r.dependencies as string, []),
      unordered: parseJson<CorpusRevision['unordered']>(r.unordered as string, []),
      sectionIndex, sectionSetDigest: r.section_set_digest as string, sectionerVersion: r.sectioner_version as string,
      configDigest: r.config_digest as string, createdAt: r.created_at as number,
    };
  }

  private rowToIrRecord(r: Record<string, unknown>, revisionId: string | null): IrRecord {
    const id = r.id as string;
    const spans = revisionId === null ? [] : (this.db.prepare('SELECT * FROM ir_spans WHERE ir_id=? AND revision_id=?').all(id, revisionId) as
      Array<Record<string, unknown>>).map(rowToIrSpan);
    const spanOf = (role: 'primary' | 'other', quote: string | null): IrSpanRef | null => {
      const s = spans.find((x) => x.role === role);
      return s && quote !== null
        ? { revisionId: s.revisionId, docKey: s.docKey, sectionId: s.sectionId, start: s.start, end: s.end, quote, quoteDigest: s.quoteDigest }
        : null;
    };
    const observedBy = [...new Set((this.db.prepare('SELECT runner_id FROM ir_observations WHERE ir_id=? ORDER BY at, attempt_id').all(id) as
      Array<{ runner_id: string }>).map((o) => o.runner_id))];
    return {
      id, projectId: r.project_id as string, corpusId: r.corpus_id as string, kind: r.kind as IrKind, source: r.source as IrRecord['source'],
      statement: r.statement as string, attrs: parseJson<IrAttrs>(r.attrs as string, {}),
      span: spanOf('primary', r.quote as string), other: spanOf('other', (r.other_quote as string | null) ?? null),
      basisSections: parseJson<string[]>(r.basis_sections as string, []), confidence: r.confidence as number,
      contentDigest: r.content_digest as string, status: r.status as IrStatus, irVersion: r.ir_version as string, observedBy,
      proposedBy: r.proposed_by as string, decisionId: (r.decision_id as string | null) ?? undefined,
      assumptionId: (r.assumption_id as string | null) ?? undefined, overriddenBy: parseJson<string[]>(r.overridden_by as string, []),
      createdAt: r.created_at as number, updatedAt: r.updated_at as number,
    };
  }

  private rowToIrFinding(r: Record<string, unknown>): IrFinding {
    const findingArtifact = this.artifact(r.finding_artifact as string);
    if (!findingArtifact) throw new Error(`IR finding ${r.id as string}: its artifact is not recorded`);
    return {
      id: r.id as string, projectId: r.project_id as string, corpusId: r.corpus_id as string, reviewMissionId: r.review_mission_id as string,
      attemptId: r.attempt_id as string, kind: r.kind as IrFindingKind, severity: r.severity as FindingSeverity,
      irId: (r.ir_id as string | null) ?? null, elementId: (r.element_id as string | null) ?? null,
      span: parseJson<IrSpanRef | null>(r.span as string | null, null), title: r.title as string, statement: r.statement as string,
      findingArtifact, corroboratedBy: parseJson<string[]>(r.corroborated_by as string, []), disposition: r.disposition as IrFinding['disposition'],
      decisionId: (r.decision_id as string | null) ?? undefined, createdAt: r.created_at as number,
    };
  }

  private rowToBlueprint(r: Record<string, unknown>): Blueprint {
    const bodyArtifact = this.artifact(r.body_artifact as string);
    if (!bodyArtifact) throw new Error(`blueprint ${r.id as string}: its body artifact is not recorded`);
    return {
      id: r.id as string, projectId: r.project_id as string, corpusId: r.corpus_id as string, revisionId: r.revision_id as string,
      body: JSON.parse(this.bodies.get(bodyArtifact).toString('utf8')) as BlueprintV1, bodyArtifact,
      blueprintDigest: r.blueprint_digest as string, status: r.status as Blueprint['status'], proposedBy: r.proposed_by as string,
      attemptId: (r.attempt_id as string | null) ?? undefined, decisionId: (r.decision_id as string | null) ?? undefined,
      createdAt: r.created_at as number, updatedAt: r.updated_at as number,
    };
  }

  private rowToPacket(r: Record<string, unknown>): PacketRow {
    const bodyArtifact = this.artifact(r.body_artifact as string);
    if (!bodyArtifact) throw new Error(`packet ${r.id as string}: its body artifact is not recorded`);
    return {
      id: r.id as string, projectId: r.project_id as string, blueprintId: r.blueprint_id as string, componentId: r.component_id as string,
      ticketId: r.ticket_id as string, packetDigest: r.packet_digest as string, bodyArtifact, status: r.status as PacketRow['status'],
      proposedBy: r.proposed_by as string, attemptId: (r.attempt_id as string | null) ?? undefined,
      createdAt: r.created_at as number, updatedAt: r.updated_at as number,
    };
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
    // An envelope is recorded by authorizeCampaign only, after its plan, lock, shape and bounds.
    if (input.scope.operation === 'authorize-campaign' && !this.authorizingCampaign) {
      throw new Error('an authorize-campaign decision is recorded by authorizeCampaign only');
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
    // P2-R61: the bench's stand-in decides only on a store `ingest bench` created, and there only it decides.
    if (isBenchActor(d.actor) && !this.isBench()) throw new Error(`a ${d.actor} decision is recorded only on a bench store; this store is not one`);
    if (this.isBench() && !isBenchActor(d.actor)) throw new Error(`a bench store records bench:<step> decisions only, not ${d.actor}`);
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
    if (d.kind !== 'approve' || !isPersonActor(d.actor)) return false;
    if (to === 'approved') return (scope.workItems as Record<string, unknown> | undefined)?.[w.id] === w.contentDigest;
    return to === 'superseded' && Array.isArray(scope.supersedes) && scope.supersedes.includes(w.id);
  }
  if (to === 'approved') {
    return names && ((scope.operation === 'approve-work-item' && isPersonActor(d.actor))
      || (scope.operation === 'admit-work-item' && isCampaignActor(d.actor)));
  }
  return names && scope.operation === 'reject-work-item' && isPersonActor(d.actor);
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
  // The 30-day bound is on the span asked for; the CLI rounds the instant up to the hour after it.
  if (!Number.isInteger(e.notAfter) || e.notAfter <= now || e.notAfter > now + MAX_NOT_AFTER_MS + 60 * 60 * 1000) {
    return 'not-after is in the future, at most 30 days away';
  }
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
    irId: (r.ir_id as string | null) ?? undefined,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToIrSpan(r: Record<string, unknown>): IrSpanRow {
  return {
    irId: r.ir_id as string, revisionId: r.revision_id as string, role: r.role as IrSpanRow['role'], docKey: r.doc_key as string,
    sectionId: r.section_id as string, start: r.start_byte as number, end: r.end_byte as number, quoteDigest: r.quote_digest as string,
    carry: r.carry as IrSpanRow['carry'],
  };
}

function rowToDerivation(r: Record<string, unknown>): BlueprintDerivation {
  return { blueprintId: r.blueprint_id as string, elementId: r.element_id as string, irId: r.ir_id as string, role: r.role as BlueprintDerivation['role'] };
}

function rowToTicketTrace(r: Record<string, unknown>): TicketTraceRow {
  return {
    campaignId: r.campaign_id as string, ticketId: r.ticket_id as string, irId: r.ir_id as string, role: r.role as TicketTraceRow['role'],
    detail: (r.detail as string | null) ?? null, packetId: (r.packet_id as string | null) ?? null, handEdited: r.hand_edited === 1,
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
    ...(r.integration_id ? { integrationId: r.integration_id as string } : {}),
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

/** `pending → evaluating → integrated`, with the exits each step can take. */
const INTEGRATION_TRANSITIONS: Record<IntegrationState, readonly IntegrationState[]> = {
  pending: ['evaluating', 'conflict', 'rejected', 'abandoned'],
  evaluating: ['integrated', 'rejected', 'abandoned'],
  integrated: [],
  conflict: [],
  rejected: [],
  abandoned: [],
};

/** The ticket a campaign experiment is bound to, from its subject (`ticket:<id>`), or null. */
export function campaignBindingOf(x: Pick<Experiment, 'subject'>): string | null {
  return x.subject.startsWith('ticket:') ? x.subject.slice('ticket:'.length) : null;
}

function rowToIntegration(row: unknown): Integration {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string, campaignId: r.campaign_id as string, projectId: r.project_id as string, missionId: r.mission_id as string,
    candidateId: r.candidate_id as string, ref: r.ref as string, onto: r.onto as string, candidateBase: r.candidate_base as string,
    method: (r.method as IntegrationMethod | null) ?? null, integratedCommit: (r.integrated_commit as string | null) ?? null,
    integratedTree: (r.integrated_tree as string | null) ?? null, integratedDiffDigest: (r.integrated_diff_digest as string | null) ?? null,
    state: r.state as IntegrationState, conflictPaths: parseJson<string[]>(r.conflict_paths as string, []),
    acceptanceVacuous: r.acceptance_vacuous === null || r.acceptance_vacuous === undefined ? null : r.acceptance_vacuous === 1,
    decisionId: (r.decision_id as string | null) ?? null, applicationId: (r.application_id as string | null) ?? null,
    createdAt: r.created_at as number, updatedAt: r.updated_at as number,
  };
}

function rowToFinding(row: unknown): Finding {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string, projectId: r.project_id as string, campaignId: r.campaign_id as string, waveSeq: r.wave_seq as number,
    reviewMissionId: r.review_mission_id as string, attemptId: r.attempt_id as string, path: r.path as string,
    severity: r.severity as FindingSeverity, title: r.title as string, statement: r.statement as string,
    findingArtifact: parseJson(r.finding_artifact as string, null as unknown as ArtifactRef),
    corroboratedBy: parseJson<string[]>(r.corroborated_by as string, []),
    ...(r.fix_ticket_id ? { fixTicketId: r.fix_ticket_id as string } : {}),
    createdAt: r.created_at as number,
  };
}
