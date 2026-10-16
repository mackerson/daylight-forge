/**
 * Daylight mission vocabulary, kept free of any runtime import.
 *
 * The renderer needs these shapes and must not pull in node:sqlite, which is the same rule
 * `store/types.ts` follows and for the same reason. Everything that can be *done* to a
 * mission lives in `store.ts`; this file only says what one is.
 *
 * The claim store is deliberately not touched. A mission is a unit of work *about* a
 * repository; a claim is a fact *about* it. Mission metadata sits alongside claims and
 * references them by id — it never widens `ClaimStatus`, because `CONFIRMED` already has a
 * meaning (a human adjudicated) and that meaning must not drift into "a mission succeeded".
 */

export const DAYLIGHT_SCHEMA_VERSION = 1 as const;

// ---- identity ----------------------------------------------------------------

/**
 * Which repository this is, independent of where it is checked out.
 *
 * `git:<root-commit>` when the repository has history: the first commit is the one thing two
 * clones of a project share and two unrelated projects never do. `path:<hash>` otherwise,
 * which is honest about being machine-local. Never a repo-relative path — that is exactly
 * the key that let one project's human-confirmed claim land on another's same-named file.
 */
export interface ProjectIdentity {
  id: string;
  /** Absolute, resolved. */
  root: string;
  name: string;
}

export interface Revision {
  /** HEAD, or null when the directory is not a git repository. */
  commit: string | null;
  /** Uncommitted changes present. A dirty tree is a revision nobody else can reproduce. */
  dirty: boolean;
  /** `<commit>`, `<commit>+dirty`, `<commit>+unknown` (status failed) or `unversioned`. What goes in a `baseRevision` field. */
  label: string;
}

// ---- states ------------------------------------------------------------------

export type MissionKind = 'explore' | 'verify' | 'implement' | 'remediate' | 'audit';
export type MissionState = 'draft' | 'ready' | 'running' | 'blocked' | 'closed';
/**
 * Recorded separately from state, and only ever set by `close`. A process exiting 0 is not an
 * outcome; an outcome is a judgement about acceptance gates, made explicitly.
 */
export type MissionOutcome = 'succeeded' | 'failed' | 'inconclusive' | 'cancelled';
export type TaskState = 'queued' | 'leased' | 'running' | 'blocked' | 'done' | 'failed';
export type AttemptState = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Legal transitions. The store refuses anything not listed, and names what it refused. */
export const MISSION_TRANSITIONS: Record<MissionState, readonly MissionState[]> = {
  draft: ['ready', 'closed'],
  ready: ['running', 'closed'],
  running: ['blocked', 'closed'],
  blocked: ['running', 'closed'],
  closed: [],
};

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ['leased', 'blocked', 'failed'],
  leased: ['running', 'queued', 'failed'],
  running: ['done', 'failed', 'blocked'],
  blocked: ['queued', 'failed'],
  // A failed task can be retried; the retry is a new attempt on the same task, so history
  // is kept rather than replaced.
  failed: ['queued'],
  done: [],
};

export const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  starting: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition<S extends string>(
  table: Record<S, readonly S[]>, from: S, to: S,
): boolean {
  return (table[from] ?? []).includes(to);
}

// ---- artifacts ---------------------------------------------------------------

export type ArtifactKind =
  | 'source' | 'claim' | 'spec' | 'diff' | 'test' | 'log' | 'trace' | 'report' | 'decision'
  | 'result' | 'expected';

/**
 * A pointer to immutable content.
 *
 * `digest` is `sha256:<hex>` over the bytes, and `id` is the digest — content-addressed, so
 * the same bytes recorded twice are one artifact and a record that says it holds something
 * can be checked against what it actually holds. `path` is where the content came from in
 * the repository, when it came from one; it is a label, not a locator.
 */
export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  digest: string;
  projectId: string;
  revision?: string;
  path?: string;
  label?: string;
  bytes?: number;
  mediaType?: string;
}

// ---- missions, tasks, attempts -----------------------------------------------

export interface MissionScope {
  paths?: string[];
  symbols?: string[];
  claimIds?: number[];
}

export interface MissionPermissions {
  read: boolean;
  write: boolean;
  execute: boolean;
  deploy: boolean;
}

export interface MissionBudget {
  maxUsd?: number;
  maxAttempts?: number;
  deadlineAt?: number;
}

export interface Mission {
  id: string;
  projectId: string;
  parentId?: string;
  kind: MissionKind;
  objective: string;
  /** `Revision.label` at creation. Everything the mission finds is about this revision. */
  baseRevision: string;
  scope: MissionScope;
  permissions: MissionPermissions;
  budget: MissionBudget;
  requirementIds: string[];
  acceptanceGateIds: string[];
  state: MissionState;
  outcome?: MissionOutcome;
  /** Why the outcome is what it is, in a sentence a person wrote or a gate produced. */
  outcomeReason?: string;
  taskIds: string[];
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export type TaskRole = 'map' | 'review' | 'compare' | 'experiment' | 'decide' | 'custom';

export interface Task {
  id: string;
  missionId: string;
  projectId: string;
  role: TaskRole;
  objective: string;
  dependsOn: string[];
  inputs: ArtifactRef[];
  requiredOutputs: ArtifactKind[];
  state: TaskState;
  /**
   * For a review task, the `tool:model` it is pinned to. Two review tasks on two sources is
   * how a mission gets a second independent answer; the hint is what keeps them distinct.
   */
  runnerHint?: string;
  attemptIds: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Who or what executed an attempt, as a string the UI can group by:
 * `agent:<tool>:<model>`, `human`, `static:vds`, `runner:experiment`.
 */
export type RunnerId = string;

export interface Attempt {
  id: string;
  missionId: string;
  taskId: string;
  projectId: string;
  runnerId: RunnerId;
  /**
   * The session handed to the adapter and so to the MCP server as `VDS_SESSION`. Every
   * `events.jsonl` line the agent produces carries it, which is how tool calls are tied back
   * to the attempt without parsing any CLI's own output.
   */
  sessionId?: string;
  worktree?: string;
  state: AttemptState;
  startedAt: number;
  finishedAt?: number;
  /** USD. `null` means the runner reported nothing, which is not the same as zero. */
  costUsd: number | null;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  /** Short reason when the state is `failed` or `cancelled`. */
  failure?: string;
  artifacts: ArtifactRef[];
}

// ---- experiments -------------------------------------------------------------

/**
 * What a run is predicted to show if the hypothesis is true.
 *
 * Declared before the run and stored as a protected artifact, so the thing being tested
 * cannot be rewritten to match whatever came out. Matching is exact on exit code and
 * substring on output, both optional; an expectation that says nothing matches anything,
 * which is why the runner refuses an empty one.
 */
export interface ExpectedObservation {
  exitCode?: number;
  stdoutIncludes?: string[];
  stderrIncludes?: string[];
}

export type ExperimentConclusion =
  | 'pending' | 'supported' | 'falsified' | 'inconclusive' | 'invalid';

export interface Experiment {
  id: string;
  missionId: string;
  projectId: string;
  /** The claims this experiment bears on. Empty is allowed; an experiment can precede a claim. */
  claimIds: number[];
  subject: string;
  predicate: string;
  hypothesis: string;
  /** Observable prediction if the hypothesis holds. The protected half of the experiment. */
  prediction: ExpectedObservation;
  baseRevision: string;
  /** The test content, injected into the sandbox from here rather than trusted from disk. */
  testArtifact: ArtifactRef;
  /** `prediction` serialised, as an artifact, so it has a digest the harness digest covers. */
  expectedArtifact: ArtifactRef;
  /** sha256 over test digest + expected digest + command + sandbox profile. */
  harnessDigest: string;
  command: string[];
  sandboxProfile: string;
  executions: ArtifactRef[];
  conclusion: ExperimentConclusion;
  limitations: string[];
  createdAt: number;
  updatedAt: number;
}

// ---- decisions ---------------------------------------------------------------

export type DecisionKind = 'adjudicate' | 'approve' | 'reject' | 'defer' | 'override';

export interface Decision {
  id: string;
  missionId: string;
  projectId: string;
  revision: string;
  /** `human:<name>` — decisions are a person's, and say whose. */
  actor: string;
  kind: DecisionKind;
  subject?: string;
  predicate?: string;
  value?: unknown;
  rationale: string;
  /** Exactly what was authorised or settled, so a later reader can tell what this covers. */
  scope: Record<string, unknown>;
  artifactIds: string[];
  at: number;
}

// ---- events ------------------------------------------------------------------

export type EventCategory =
  | 'lifecycle' | 'tool' | 'process' | 'claim' | 'experiment' | 'approval' | 'cost' | 'ui';

/**
 * One durable event.
 *
 * `sequence` is assigned by the store on append and is monotonic per output directory, which
 * is the only ordering replay depends on. `at` is wall clock and is for display: providers
 * timestamp their own output and two of them need not agree. Anything "live" in the UI is a
 * projection of this table, never a second feed that could drift from it.
 */
export interface DaylightEvent {
  schemaVersion: typeof DAYLIGHT_SCHEMA_VERSION;
  id: string;
  sequence: number;
  at: number;
  projectId: string;
  missionId?: string;
  taskId?: string;
  attemptId?: string;
  actorId?: string;
  category: EventCategory;
  name: string;
  artifactIds?: string[];
  payload: Record<string, unknown>;
}

/** What a writer supplies; the store adds the version, the id and the sequence. */
export type DaylightEventInput = Omit<DaylightEvent, 'schemaVersion' | 'id' | 'sequence' | 'at'> & {
  at?: number;
};
