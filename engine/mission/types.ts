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

/**
 * Three versions, deliberately separate. P0 had one constant feeding the event stamp, the
 * export header and the database, so bumping the database would have relabelled every event.
 * The database and the export move to 2 with the Forge tables; events keep their shape.
 * Nothing reads an older database or export: there is no migration (RULINGS R2).
 */
export const DAYLIGHT_DB_VERSION = 2 as const;
export const EVENT_SCHEMA_VERSION = 1 as const;
export const EXPORT_SCHEMA_VERSION = 2 as const;
/** @deprecated Say which version you mean: `DAYLIGHT_DB_VERSION` or `EVENT_SCHEMA_VERSION`. */
export const DAYLIGHT_SCHEMA_VERSION = DAYLIGHT_DB_VERSION;

// ---- ids ---------------------------------------------------------------------

/**
 * Every row id is `<prefix>_<uuid without dashes>`, so an id names its kind and a lookup by
 * the wrong kind fails on sight. Artifact ids are not here: an artifact is `sha256:<hex>`.
 */
export const ID_PREFIX = {
  mission: 'm',
  task: 't',
  attempt: 'a',
  experiment: 'x',
  decision: 'd',
  event: 'ev',
  workItem: 'w',
  candidate: 'c',
  gateEvaluation: 'g',
  application: 'p',
} as const;
export type EntityKind = keyof typeof ID_PREFIX;

/**
 * Event ids also come content-derived, so that re-reading a source adds nothing twice:
 * `ev_mcp_<32 hex>` from an MCP tool-call line, `ev_cc_<hex>` from a Claude Code transcript.
 */
export function isEntityId(kind: EntityKind, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (kind === 'event') return /^ev_(?:[a-z]+_)?[0-9a-f]{32,64}$/.test(value);
  return new RegExp(`^${ID_PREFIX[kind]}_[0-9a-f]{32}$`).test(value);
}

/** `human:<name>`, the only actor a Forge decision accepts. Bare `human` names nobody. */
export const isHumanActor = (actor: string): boolean => /^human:\S+$/.test(actor);

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

/**
 * `work` is a ledger-only container for ingested sessions; nothing runs it. `spec` holds a
 * registered spec and the decompose attempts that propose work items from it; it never
 * writes or executes.
 */
export type MissionKind =
  | 'explore' | 'verify' | 'implement' | 'remediate' | 'audit' | 'work' | 'spec';
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
  | 'result' | 'expected' | 'summary' | 'narrative' | 'ingest-summary';

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
  /** The approved work item an implement mission builds, when it came from a spec. */
  workItemId?: string;
  state: MissionState;
  outcome?: MissionOutcome;
  /** Why the outcome is what it is, in a sentence a person wrote or a gate produced. */
  outcomeReason?: string;
  taskIds: string[];
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export type TaskRole =
  | 'map' | 'review' | 'compare' | 'experiment' | 'decide' | 'custom'
  | 'author' | 'gate' | 'decompose' | 'session';

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
 * `agent:<tool>:<model>`, `human`, `static:daylight`, `runner:experiment`.
 */
export type RunnerId = string;

/** Where token counts came from. `none` means nobody reported any, not that there were none. */
export type UsageSource = 'provider' | 'transcript' | 'none';
/**
 * Where a dollar figure came from. `stdout-scan` is a figure read out of a process's output
 * by pattern, which is a guess and is labelled as one; only `provider` is the provider's own.
 */
export type CostSource = 'provider' | 'stdout-scan' | 'none';

/** Token counts. Each is `null` when unreported, and a null is never summed as zero. */
export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** A cost is known only when the provider said it. A scraped figure is spend, not knowledge. */
export const costKnown = (source: CostSource): boolean => source === 'provider';

/** One provider turn's usage, as recorded in `attempt_usage`. */
export interface UsageTurn {
  attemptId: string;
  projectId: string;
  /** Per attempt, from 1, assigned by the store. */
  seq: number;
  /** The provider's message or request id; a second line with the same id is the same turn. */
  requestId: string | null;
  at: number;
  model: string | null;
  tokens: TokenUsage;
  costUsd: number | null;
  costSource: CostSource;
  source: Exclude<UsageSource, 'none'>;
}

/** What `recordUsage` did with a turn: a new row, a MAX-merge into a row with its request id, or nothing. */
export type UsageRecordResult = 'inserted' | 'merged' | 'duplicate';

/**
 * Which credential an attempt was given, never its value: whether one was present, the
 * variable it came in, and an operator-chosen label (Q4a: a dedicated, spend-capped key).
 */
export interface AttemptCredential {
  present: boolean;
  envName: string | null;
  label: string | null;
}

// ---- policy and permissions --------------------------------------------------

/**
 * `none` gives the attempt its own empty network namespace; `shared` is the host's. Bubblewrap
 * cannot filter egress, so there is nothing in between.
 */
export type NetworkMode = 'none' | 'shared';

/**
 * The sandbox an attempt ran under. `review`, `author` and `gate` are the bubblewrap profiles
 * WS2 builds; `none` is what a P0 reviewer and a static step actually get today, recorded as
 * such rather than dressed up as a profile they never ran under.
 */
export type SandboxProfileName = 'none' | 'review' | 'author' | 'gate';
export const SANDBOX_PROFILES: readonly SandboxProfileName[] = ['none', 'review', 'author', 'gate'];
export const NETWORK_MODES: readonly NetworkMode[] = ['none', 'shared'];

/**
 * What an attempt was allowed to do, recorded on the attempt row.
 *
 * `write` is a mode, not a violation: an implement attempt writes to its detached workspace.
 * It is only ever true when an `authorize-mission` decision of the attempt's mission granted
 * it (R7), named in `authorizeDecisionId`, and the store refuses anything else. `exec` needs
 * `write` and otherwise has no behaviour here: whether an author may execute at all is an open
 * owner question (R9.2, R11.1).
 */
export interface AttemptSandbox {
  profile: SandboxProfileName;
  network: NetworkMode;
  write: boolean;
  exec: boolean;
  authorizeDecisionId: string | null;
}

/**
 * The default for every attempt. `shared` network because that is what an unsandboxed P0
 * reviewer actually has: the record says what the attempt got, not what would be nicer.
 */
export const READ_ONLY_SANDBOX: Readonly<AttemptSandbox> = Object.freeze({
  profile: 'none', network: 'shared', write: false, exec: false, authorizeDecisionId: null,
});

/**
 * `daylight`: run by Daylight, under its permissions and sandbox. `ingested`: recovered from a
 * transcript of work done elsewhere. An ingested attempt is recorded, never presented as
 * verified, and outside Daylight's controls: it has no sandbox record, because Daylight
 * granted it nothing and cannot say what it had (R12.1).
 */
export type AttemptOrigin = 'daylight' | 'ingested';

export interface Attempt {
  id: string;
  missionId: string;
  taskId: string;
  projectId: string;
  runnerId: RunnerId;
  /**
   * The session handed to the adapter and so to the MCP server as `DAYLIGHT_SESSION`. Every
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
  /** Totals over the attempt's `attempt_usage` rows. The ledger of record, never a sum of events. */
  tokens: TokenUsage;
  usageSource: UsageSource;
  costSource: CostSource;
  /** The model the provider reported, when it reported one. The asked-for model is in `runnerId`. */
  model?: string;
  /** For a subagent recovered from a transcript: the attempt that spawned it. */
  parentAttemptId?: string;
  /** The locked gate set an author attempt ran against. */
  gateSetDigest?: string;
  /** The runner process, for liveness. Recorded beside WS0's per-mission claim file (R5). */
  pid?: number;
  heartbeatAt?: number;
  origin: AttemptOrigin;
  /** Null exactly when `origin` is `ingested`. */
  sandbox: AttemptSandbox | null;
  credential?: AttemptCredential;
  /**
   * `sha256:` of the per-attempt MCP token the host server checks on the sandbox socket
   * (R11.2). The token itself is never stored.
   */
  mcpTokenDigest?: string;
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

/**
 * `probe` is a P0 experiment about a claim. `gate` is an acceptance test the author is shown;
 * `holdout` is one it is not.
 */
export type ExperimentRole = 'probe' | 'gate' | 'holdout';

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
  role: ExperimentRole;
  /** The `lock-gates` decision that froze this gate, once one has. */
  lockedBy?: string;
  /** When a run last started, so a pending row whose runner died can be found without /tmp. */
  startedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a writer supplies; the store assigns the rest. `role` defaults to `probe`. `id` may be
 * minted first (`newId('experiment')`) when the test path has to name it.
 */
export type NewExperiment = Omit<
  Experiment, 'id' | 'executions' | 'conclusion' | 'createdAt' | 'updatedAt' | 'role' | 'lockedBy' | 'startedAt'
> & { role?: ExperimentRole; id?: string };

// ---- forge: work items, candidates, gates, applications ----------------------

export type WorkItemStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';

export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  proposed: ['approved', 'rejected', 'superseded'],
  approved: ['superseded'],
  rejected: [],
  superseded: [],
};

/** One buildable unit drawn from a registered spec. Only a human decision approves one. */
export interface WorkItem {
  id: string;
  projectId: string;
  /** The spec mission it was proposed in. */
  missionId: string;
  /** The decompose attempt that proposed it; absent when a person wrote it. */
  attemptId?: string;
  /** The proposal as it crossed the MCP boundary, verbatim. */
  proposalArtifact?: ArtifactRef;
  /** `workItemContentDigest` of what a human approves; the decision names it. */
  contentDigest: string;
  specArtifact: ArtifactRef;
  /** The revision the spec was registered at. */
  specRevision: string;
  /** Where in the spec this comes from (a heading slug or line range). */
  anchor: string;
  title: string;
  statement: string;
  examples: string[];
  negativeExamples: string[];
  status: WorkItemStatus;
  proposedBy: RunnerId;
  decisionId?: string;
  createdAt: number;
  updatedAt: number;
}

export type CandidateVerdict =
  | 'pending' | 'accepted-by-gates' | 'rejected-by-gates' | 'gates-inconclusive'
  | 'gates-invalid' | 'policy-violation' | 'no-diff' | 'stale-base';

/** A file's mode as git records it. Anything but `file` and `executable` is refused. */
export type FileMode = 'file' | 'executable' | 'symlink' | 'gitlink';

/** One path a candidate diff touches, from `--numstat` and the raw diff header. */
export interface CandidateFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  /** `null` for a binary file, which numstat cannot count. */
  insertions: number | null;
  deletions: number | null;
  mode: FileMode;
  /** Mode before the change, for a modified or deleted file. */
  previousMode?: FileMode;
}

export type PolicyRule =
  | 'protected-path' | 'gate-path' | 'spec-path' | 'outside-scope' | 'path-escape'
  | 'symlink' | 'gitlink' | 'exec-mode' | 'empty-diff' | 'too-many-files' | 'too-large'
  | 'secret-in-diff';

/** `path` is null for a rule about the diff as a whole (empty, too large, too many files). */
export interface PolicyViolation {
  rule: PolicyRule;
  path: string | null;
}

/**
 * An author attempt's output, captured from its workspace: the thing gates evaluate, a human
 * approves and `apply` commits. The narrative is the author's own account and is labelled
 * unverified wherever it is shown; the verdict is computed from rows, never from it.
 */
export interface Candidate {
  id: string;
  missionId: string;
  attemptId: string;
  projectId: string;
  /** The commit the workspace was materialised from. The candidate's revision. */
  baseCommit: string;
  diffArtifact: ArtifactRef;
  summaryArtifact: ArtifactRef;
  narrativeArtifact?: ArtifactRef;
  files: CandidateFile[];
  policyViolations: PolicyViolation[];
  secretHits: number;
  gateSetDigest: string;
  /** `name` uses the attempt's vocabulary (`Attempt.sandbox.profile`), so it is always `author`. */
  profile: { name: Extract<SandboxProfileName, 'author'>; network: NetworkMode; write: boolean; exec: boolean };
  /** Recorded and shown at approve time; never a verdict input (ADR-19). */
  attemptState: AttemptState;
  attemptFailure?: string;
  verdict: CandidateVerdict;
  verdictReasons: string[];
  createdAt: number;
}

export type GateTarget = 'base' | 'candidate';

/** One gate run against the base or against one candidate's diff. */
export interface GateEvaluation {
  id: string;
  missionId: string;
  projectId: string;
  /** The base revision the gate ran on; with `diffDigest`, exactly what was tested. */
  revision: string;
  experimentId: string;
  candidateId?: string;
  target: GateTarget;
  /** `sha256:<hex>` of the applied diff; null on the base. */
  diffDigest: string | null;
  harnessDigest: string;
  executions: ArtifactRef[];
  conclusion: ExperimentConclusion;
  createdAt: number;
}

/** A candidate committed to a ref by a human-approved apply. At most one per candidate. */
export interface Application {
  id: string;
  candidateId: string;
  missionId: string;
  decisionId: string;
  projectId: string;
  baseCommit: string;
  commit: string;
  ref: string;
  appliedBy: string;
  at: number;
}

/**
 * How far into one transcript an ingest has read, so a re-run reads only what is new. Keyed
 * on session and agent: a subagent's transcript shares its parent's session id (R12.2).
 */
export interface IngestSource {
  sessionId: string;
  /** The subagent's id, or `''` for the session's main transcript. */
  agentId: string;
  projectId: string;
  /** sha256 of the transcript path; the path itself is not stored. */
  pathDigest: string;
  /** sha256 of the first `bytesSeen` bytes, so a rewritten file is noticed and re-read from zero. */
  prefixDigest: string;
  bytesSeen: number;
  linesSeen: number;
  missionId: string;
  attemptId: string;
  ingestedAt: number;
}

export type NeedKind =
  | 'blocked' | 'dispute' | 'spec-ambiguity' | 'gate-lock' | 'gate-vacuous'
  | 'candidate-decision' | 'apply';

/** Something a person must do. Derived from rows on every read, never stored. */
export interface Need {
  kind: NeedKind;
  ref: string;
  why: string;
}

// ---- decisions ---------------------------------------------------------------

/** `adhoc-mission`: a human started an implement mission with no work item (R10.1). */
export type DecisionKind =
  | 'adjudicate' | 'approve' | 'reject' | 'defer' | 'override' | 'adhoc-mission';

/**
 * The Forge act a decision records, in `scope.operation`. Each needs a `human:` actor. P0
 * decisions (adjudication) carry no operation and are unchanged.
 */
export type DecisionOperation =
  | 'authorize-mission' | 'lock-gates' | 'approve-work-item' | 'reject-work-item'
  | 'approve-candidate' | 'reject-candidate' | 'override-candidate' | 'adhoc-mission';

export const DECISION_OPERATIONS: readonly DecisionOperation[] = [
  'authorize-mission', 'lock-gates', 'approve-work-item', 'reject-work-item',
  'approve-candidate', 'reject-candidate', 'override-candidate', 'adhoc-mission',
];

/** `mission authorize`: the only act that turns `write` on (ADR-9, ADR-34). */
export interface AuthorizeScope {
  operation: 'authorize-mission';
  permissions: MissionPermissions;
  maxUsd: number | null;
}

/** `gate lock`: what counts as done, frozen by digest. */
export interface LockGatesScope {
  operation: 'lock-gates';
  experimentIds: string[];
  harnessDigests: Record<string, string>;
  /** `sha256` over sorted `"<x_id>:<harnessDigest>"` lines. */
  gateSetDigest: string;
  /** Gates a human accepted although they already passed at base. */
  vacuousOverrides: string[];
}

export interface CandidateDecisionScope {
  operation: 'approve-candidate' | 'reject-candidate' | 'override-candidate';
  candidateId: string;
  diffDigest: string;
  gateSetDigest: string;
  baseCommit: string;
}

/** `reject-work-item` also covers retiring an approved item as superseded. */
export interface WorkItemDecisionScope {
  operation: 'approve-work-item' | 'reject-work-item';
  workItemId: string;
  contentDigest: string;
}

/** `--no-work-item`: who decided this implement mission needs no spec, recorded on it. */
export interface AdhocMissionScope {
  operation: 'adhoc-mission';
  objective: string;
}

export type ForgeDecisionScope =
  | AuthorizeScope | LockGatesScope | CandidateDecisionScope | WorkItemDecisionScope
  | AdhocMissionScope;

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
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
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

/** `ingest.session.finished`: counts and digests, never transcript text. */
export interface IngestSessionFinishedPayload {
  sessionId: string;
  agentId: string;
  pathDigest: string;
  turns: number;
  dedupedLines: number;
  skippedLines: number;
  subagents: number;
}

/**
 * One row of the project ledger (PLAN F-9), as JSON. Dollar and token figures are known sums
 * plus a count of the unknown, never a null summed as zero. WS5 computes it.
 */
export interface LedgerRow {
  key: string;
  attempts: number;
  usdKnown: number;
  usdUnknownCount: number;
  /** Spend read from output by pattern: counted, never known. */
  usdScanned: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; unknownCount: number };
  candidates: { accepted: number; rejected: number; applied: number; overridden: number };
  decisions: number;
  gateSetDigests: string[];
}

/** `mission.authorized`: ids and grants, never prose. */
export interface MissionAuthorizedPayload {
  decisionId: string;
  permissions: MissionPermissions;
  maxUsd: number | null;
}

/** What a writer supplies; the store adds the version, the id and the sequence. */
export type DaylightEventInput = Omit<DaylightEvent, 'schemaVersion' | 'id' | 'sequence' | 'at'> & {
  at?: number;
};
