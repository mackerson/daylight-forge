import type { Tier } from '../detect/structure-types.ts';
import type { Violation } from '../invariants/engine.ts';

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
  assumption: 'u',
  integration: 'i',
  finding: 'f',
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
  | 'explore' | 'verify' | 'implement' | 'remediate' | 'audit' | 'work' | 'spec' | 'campaign';
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
 * `write` and a grant that carried `execute: true` (R17.1); it offers the author the MCP `run`
 * tool, whose commands run in a nested sandbox with no network (R11.1).
 */
export interface AttemptSandbox {
  profile: SandboxProfileName;
  network: NetworkMode;
  write: boolean;
  exec: boolean;
  authorizeDecisionId: string | null;
  /**
   * Why a review that could have been sandboxed was not, when a person said so (profile `none`
   * only): `unsandboxed-review` for real providers run as P0 did (Sec H5), `no-review-sandbox`
   * for mock test doubles. Absent when no profile was available or none was declined.
   */
  reason?: SandboxReason;
}

export type SandboxReason = 'unsandboxed-review' | 'no-review-sandbox';
export const SANDBOX_REASONS: readonly SandboxReason[] = ['unsandboxed-review', 'no-review-sandbox'];

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
  /**
   * How many times an exec attempt's author called its `run` tool (R17.1): its `attempt.exec`
   * events, present only on an attempt stamped exec. Derived, so the schema (which never
   * migrates) is unchanged and an export carries it with the events.
   */
  execRuns?: number;
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
  /** The spend ceiling handed to the runner (`maxCost`), USD: a campaign's reservation (P2-R18). */
  maxCostUsd?: number;
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
 * `holdout` is one it is not. `regression` is a campaign's project-wide gate, which must pass at
 * the campaign base and on every integrated tree; `acceptance` is a test a campaign author wrote
 * for its own ticket, run and recorded, never locked (docs/daylight/CAMPAIGN-RUN.md).
 */
export type ExperimentRole = 'probe' | 'gate' | 'holdout' | 'regression' | 'acceptance';

/**
 * The test runner a gate runs under: `node --test`, or `cargo test` against a per-project crate
 * snapshot (docs/daylight/CARGO.md). A probe is always `node`; a row without one reads as `node`.
 */
export type GateHarness = 'node' | 'cargo';

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
  /** Recorded on the row and in the expectation, so it is covered by the harness digest. */
  harness?: GateHarness;
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
  | 'gates-invalid' | 'policy-violation' | 'no-diff' | 'stale-base'
  /** A campaign candidate whose diff does not merge onto the integration tip (§3.4). */
  | 'rebase-conflict';

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
  /** Under a project policy, which protected set matched (`protected by the rust set`). */
  why?: string;
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
  /**
   * Low-confidence secret matches in the diff (R16): a curable warning, never a violation.
   * Approve and override need the person's explicit acknowledgement while it is non-zero.
   */
  possibleSecretHits: number;
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

/** `integrated`: a campaign candidate's diff applied onto the integration tip (§3.2). */
export type GateTarget = 'base' | 'candidate' | 'integrated';

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
  /**
   * `sha256:<hex>` of the applied diff; null on the base. On an `integrated` evaluation, the
   * digest of the tip → integrated-commit diff, and `revision` is the integrated commit.
   */
  diffDigest: string | null;
  /** The integration an `integrated` evaluation ran on. */
  integrationId?: string;
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
  /** The commit's tree, recorded at apply; re-derivable as `<commit>^{tree}`. */
  tree: string;
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
  | 'candidate-decision' | 'apply' | 'work-item-undecided' | 'mission-awaiting-authorize'
  | 'request-dependency'
  | 'plan-approval' | 'campaign-authorize' | 'campaign-halted' | 'assumption-pending' | 'owner-decision';

/** Something a person must do. Derived from rows on every read, never stored. */
export interface Need {
  kind: NeedKind;
  ref: string;
  why: string;
}

// ---- campaign integration, waves and the director (WS-R6) --------------------
//
// The director lands a campaign's tickets on its own integration ref by plumbing, judges each on
// the integrated tree, repairs what fails, and reviews each wave of landings blind. Rows only;
// docs/daylight/CAMPAIGN-RUN.md, ADR-38, ADR-39.

/** A candidate's diff on its way onto the integration tip. `conflict` and `rejected` are final. */
export type IntegrationState = 'pending' | 'evaluating' | 'integrated' | 'conflict' | 'rejected' | 'abandoned';
/** `apply`: the tip was the candidate's own base. `three-way`: `git merge-tree` onto a tip that moved. */
export type IntegrationMethod = 'apply' | 'three-way';

export interface Integration {
  id: string; campaignId: string; projectId: string; missionId: string; candidateId: string;
  /** `refs/heads/daylight/campaign/<campaignId>`. */
  ref: string;
  /** The integration tip the diff was put onto. */
  onto: string;
  candidateBase: string;
  method: IntegrationMethod | null;
  integratedCommit: string | null; integratedTree: string | null;
  /** `sha256:` of the `onto` → integrated-commit diff, with capture's flags: exactly what the checks ran on. */
  integratedDiffDigest: string | null;
  state: IntegrationState;
  conflictPaths: string[];
  /** Whether the ticket's own acceptance tests also pass on `onto` without the change: weak evidence, never a verdict input. */
  acceptanceVacuous: boolean | null;
  decisionId: string | null; applicationId: string | null;
  createdAt: number; updatedAt: number;
}

/** A run of landings closed for review: `fromCommit..toCommit` on the integration ref. */
export interface CampaignWave {
  campaignId: string; seq: number; fromCommit: string; toCommit: string; ticketIds: string[];
  reviewMissionId: string | null; closedAt: number;
}

/** One wave reviewer's report, re-validated and redacted on the host. A claim, never a verdict input (ADR-19). */
export interface Finding {
  id: string; projectId: string; campaignId: string; waveSeq: number; reviewMissionId: string; attemptId: string;
  /** A file the wave changed. */
  path: string; severity: FindingSeverity;
  /** One line, at most 120 characters. */
  title: string;
  /** At most 4 KiB, redacted. */
  statement: string;
  /** The line as it crossed the MCP boundary. */
  findingArtifact: ArtifactRef;
  /** Other reviewers' findings with the same path and title. */
  corroboratedBy: string[];
  fixTicketId?: string;
  createdAt: number;
}

/** What a campaign has spent, from rows, over every child mission (§4.6). Unknown is counted, never summed as zero. */
export interface CampaignSpend {
  /** Provider plus stdout-scan figures: scanned spend is money, not knowledge. */
  spentUsd: number;
  /** Provider figures only. */
  knownUsd: number;
  /** Finished attempts with no figure. Any one halts the campaign (P2-R11). */
  unknownCount: number;
  scannedCount: number;
  runningCount: number;
  /** Σ `attempts.max_cost_usd` over running attempts (P2-R18). */
  reservedUsd: number;
  capUsd: number;
}

/** What a repair attempt is told about the attempt before it, fenced as data in its prompt (§4.7). */
export interface RepairBrief {
  attempt: number; priorCandidateId: string;
  outcome: 'rejected-by-gates' | 'gates-inconclusive' | 'rebase-conflict' | 'capture-refused' | 'policy-violation';
  /** Public checks only; each tail redacted and at most 8 KiB, all of them at most 24 KiB. */
  failures: Array<{ check: string; role: 'regression' | 'gate' | 'acceptance'; tail: string }>;
  /** Holdouts that failed: a count, never an id, path or output. */
  hiddenFailures: number;
  conflictPaths: string[];
  /** Violated policy rules, by path. */
  policy: string[];
  /** The author's own prior diff, redacted, at most 64 KiB. */
  priorDiff: string;
}

/**
 * The rows `campaignVerdict` reads, and nothing else: no attempt state, narrative, reviewer
 * claim or finding (ADR-19). Holdouts are counted, never named, in what it returns.
 */
export interface CampaignVerdictRows {
  candidate: Pick<Candidate, 'id' | 'files' | 'policyViolations' | 'secretHits' | 'gateSetDigest'> & { diffDigest: string };
  ticketId: string;
  /** The ticket's acceptance is `writer-authored`: at least one supported acceptance test is required. */
  writerAuthored: boolean;
  /** The integration row being judged, or null when none was recorded. */
  integration: Pick<Integration, 'id' | 'state' | 'onto' | 'integratedCommit' | 'integratedDiffDigest' | 'conflictPaths'> | null;
  /** The campaign's current `lock-campaign-gates` decision, or null. */
  lock: { decisionId: string; scope: CampaignLockScope } | null;
  /** The locked experiments as their rows read now; a missing one is absent. */
  locked: Array<Pick<Experiment, 'id' | 'role' | 'harnessDigest' | 'lockedBy'>>;
  /** Base evaluations of the campaign's experiments. */
  baseline: Array<Pick<GateEvaluation, 'experimentId' | 'target' | 'harnessDigest' | 'conclusion'>>;
  /** `integrated` evaluations of this integration. */
  evaluations: Array<Pick<GateEvaluation, 'experimentId' | 'target' | 'integrationId' | 'diffDigest' | 'harnessDigest' | 'conclusion'>>;
  /** `integrated` evaluations of the landing whose commit is `onto`: what the ratchet reads. */
  ontoEvaluations: Array<Pick<GateEvaluation, 'experimentId' | 'harnessDigest' | 'conclusion'>>;
  /** This candidate's acceptance experiments and their latest integrated conclusion. */
  acceptance: Array<{ experimentId: string; conclusion: ExperimentConclusion | null }>;
}

/** `campaign run`'s options as data; the director adds its sandbox and host (forge/director.ts). */
export interface CampaignRunOptions {
  campaignId: string; repo: string; concurrency?: number; maxWaves?: number; dryRun?: boolean;
}

export interface CampaignRunResult {
  campaignId: string;
  integrationRef: string;
  tip: string | null;
  /** True when nothing was written: no row, no event, no ref. */
  dryRun: boolean;
  statuses: Record<string, TicketStatus>;
  landed: string[];
  halted: CampaignHaltReason | null;
  /** Why the run did not start, or stopped. */
  refused: string | null;
  waves: number;
  spend: CampaignSpend;
  /** The dry run's plan: tickets that would be dispatched now, in order, with their reservation. */
  schedule: Array<{ ticketId: string; lane: string; reserveUsd: number }>;
}

export interface CampaignStatusReport {
  kind: 'daylight-campaign-status'; campaignId: string; projectId: string; planRevision: string;
  integration: { ref: string; base: string; tip: string; landed: number; mergeHint: string };
  authorization: { decisionId: string | null; notAfter: number | null; halted: CampaignHaltReason | null };
  lanes: Array<{ lane: string; total: number; byStatus: Record<TicketStatus, number> }>;
  tickets: Array<{ id: string; lane: string; status: TicketStatus; missionId?: string; attempts: number; commit?: string; reason?: string }>;
  assumptions: { open: number; pending: number; confirmed: number; overturned: number; items: Assumption[] };
  needs: Need[]; spend: CampaignSpend;
  waves: Array<{ seq: number; tickets: number; findings: Record<FindingSeverity, number>; fixTickets: number }>;
  /** kitkraft's STATUS table over the same ticket states (WS-R8). */
  table: StatusTable;
  run: RunClaim | null;
}

// ---- reports, the campaign list and refine (WS-R8) ---------------------------
//
// What `campaign report|list|refine` print as JSON, declared here so the renderer types them
// without importing an engine module (WS-R9). Derived on read, never stored; holdouts are
// counts only. docs/daylight/REFINE.md, ADR-40.

export type StatusBucket = 'done' | 'in-progress' | 'blocked' | 'requests' | 'queued' | 'superseded';
export const STATUS_BUCKETS: readonly StatusBucket[] = ['done', 'in-progress', 'blocked', 'requests', 'queued', 'superseded'];
/**
 * kitkraft's STATUS columns are the first four; `queued` and `superseded` are counted, never
 * hidden. `regressed` (P2-R44, P2-R47) is keyed here whether or not `TicketStatus` has it yet.
 */
export const STATUS_BUCKET_OF: Readonly<Record<TicketStatus | 'regressed', StatusBucket>> = {
  landed: 'done', running: 'in-progress', integrating: 'in-progress',
  blocked: 'blocked', regressed: 'blocked',
  'waiting-owner': 'requests', 'waiting-dependency': 'requests',   // a person acts (P2-R21)
  ready: 'queued', waiting: 'queued',
  superseded: 'superseded',
};
export interface StatusTableRow { lane: string; total: number; byBucket: Record<StatusBucket, number>; tickets: Record<StatusBucket, string[]> }
/** Rows sorted by lane id. */
export interface StatusTable { rows: StatusTableRow[]; totals: Record<StatusBucket, number> }

/** `git diff --numstat -z --no-renames`; a binary file counts in `files` and `binary`, never in the line counts. */
export interface DiffStat { files: number; insertions: number; deletions: number; binary: number }
/** Attempt spend summed over a set of missions. A line is never a figure for unknown spend. */
export interface SpendLine {
  /** ticket id | lane id | `wave:<n>` | `review:<n>` | 'scope' */
  key: string;
  attempts: number;
  /** Known + scanned + reservation-charged (P2-R44): what counts against the cap. */
  spentUsd: number;
  /** Provider figures only. */
  knownUsd: number;
  /** Stdout-scan figures: shown beside, never inside, a known figure. */
  scannedUsd: number;
  scannedCount: number; unknownCount: number; runningCount: number;
  /** Attempts charged at their reservation (cost_source 'reservation', P2-R44). */
  reservationCount: number;
}
/** The run claim `<out>/mission-run.<id>.pid`: a live pid is a run in progress; a dead one, a claim left behind. */
export interface RunClaim { pid: number; alive: boolean }

export interface ReportLanding {
  ticketId: string; lane: string; origin: TicketOrigin; title: string;          // title: the work item's
  missionId: string; integrationId: string; candidateId: string; decisionId: string | null;
  onto: string; commit: string; method: IntegrationMethod | null; attempts: number;
  acceptance: TicketAcceptance['kind']; acceptanceVacuous: boolean | null;
  diff: DiffStat;                                                               // onto..commit
}
export interface ReportAssumption {
  id: string; status: 'open' | 'pending'; ownerDecisionId?: string; ticketId?: string;
  question: string; default: string; blocking: boolean; source: AssumptionSource;
  heldTickets: string[];
  /** Landed tickets whose blocksOn names its owner decision: what an overturn would not revert. */
  landedOnIt: string[];
}
export interface ReportFinding {
  id: string; waveSeq: number; severity: FindingSeverity; path: string;
  /** Reviewer-claimed, redacted; `statement` ≤ 4 KiB and never in the markdown report. */
  title: string; statement: string;
  corroboratedBy: string[];
  fixTicketId: string | null; fixStatus: TicketStatus | 'none';
  /** Who admitted the fix ticket: the director (`campaign:<m>`), a person, or nobody yet. */
  fixAdmission: 'derived' | 'person' | 'none';
}
export interface ReportReview {
  seq: number; reviewMissionId: string | null;
  /** off: reviewRoster [] */
  state: 'off' | 'not-run' | 'running' | 'done';
  reviewers: number; findings: Record<FindingSeverity, number>;
}
export interface ReportBlocked {
  ticketId: string; lane: string; status: Extract<TicketStatus, 'blocked' | 'waiting-dependency' | 'waiting-owner'>;
  /** TicketState.reason, verbatim. */
  reason: string;
  missionId?: string; need: NeedKind | null;
  act: 'retry' | 'resolve-dependency' | 'owner-decision' | 'approve-work-item' | 'authorize' | 'read';
}

/** The `why` classes of a `gate-forgery-shape` warning (P2-R43, P2-R49). */
export type ForgeryClass = 'stdout-fd-write' | 'test-summary-literal' | 'process-exit';
export const FORGERY_CLASSES: readonly ForgeryClass[] = ['stdout-fd-write', 'test-summary-literal', 'process-exit'];
/** Candidates that tripped `gate-forgery-shape`: a heuristic count, never a finding of fact, never the matched text. */
export interface ReportForgeryShapes {
  /** In scope: candidates of the scope's tickets with ≥ 1 such warning. */
  candidates: number;
  /** A `why` outside FORGERY_CLASSES counts as unclassified. */
  byClass: Record<ForgeryClass | 'unclassified', number>;
  items: Array<{ ticketId: string; missionId: string; candidateId: string; attemptId: string;
    /** Repo-relative, as the warning names them. */
    paths: string[];
    classes: Array<ForgeryClass | 'unclassified'>;
    /** The same ticket landed (by this candidate or a later one). */
    ticketLanded: boolean }>;
  heuristic: true;
}

export interface WaveReport {
  kind: 'daylight-wave-report'; version: 1;
  campaignId: string; projectId: string; title: string; planRevision: string;
  scope: { kind: 'wave'; seq: number } | { kind: 'open' } | { kind: 'all' };
  range: { from: string; to: string };
  integration: CampaignStatusReport['integration'];
  authorization: CampaignStatusReport['authorization'];
  run: RunClaim | null;
  landed: ReportLanding[];
  /** from..to */
  diff: DiffStat;
  assumptions: { open: ReportAssumption[]; pending: ReportAssumption[]; confirmed: number; overturned: number };
  /** The wave in scope (every wave for --all). */
  review: ReportReview[];
  /** Findings of the waves in scope, most severe first. */
  findings: ReportFinding[];
  fixLane: { filed: number; admittedDerived: number; approvedByPerson: number; landed: number; waiting: number; rejected: number };
  spend: {
    /** campaignSpend(), unchanged. */
    campaign: CampaignSpend;
    /** Missions that landed in scope plus the scope's reviews. */
    scope: SpendLine;
    /** Whole campaign; lane 'FIX' included. Σ lanes + Σ reviews = campaign. */
    tickets: SpendLine[]; lanes: SpendLine[];
    /** wave n = tickets in wave n's ticketIds; review n = its audit mission. */
    waves: SpendLine[]; reviews: SpendLine[];
  };
  /** campaignNeeds(), verbatim. */
  needs: Need[];
  blocked: ReportBlocked[];
  /** Counts only: no experiment id, path or basename of a holdout (P2-R37). */
  holdouts: { locked: number; atTip: Record<ExperimentConclusion | 'not-run', number> };
  forgeryShapes: ReportForgeryShapes;
  status: StatusTable;
}

/** One row of `campaign list --format json`. */
export interface ForgeCampaignRow {
  id: string; projectId: string; title: string | null; state: MissionState; createdAt: number;
  planRevision: string | null; planApproved: boolean;
  /** campaignAuthorizationRefusal, verbatim. */
  authorization: { decisionId: string | null; refusal: string | null; notAfter: number | null };
  halted: CampaignHaltReason | null;
  run: RunClaim | null;
  /** `daylight campaign run <id> <root> --out <out>`, built by the engine. */
  runHint: string;
  integrationRef: string; tip: string | null;
  tickets: number; byBucket: Record<StatusBucket, number>;
  needs: number; assumptions: { open: number; pending: number };
  spend: CampaignSpend;
  /** Project root missing: statuses not derived, counts zero, said so. */
  unavailable: string | null;
}
export interface ForgeCampaignList { kind: 'daylight-campaign-list'; campaigns: ForgeCampaignRow[] }

/** `campaign show --format json`. */
export interface ForgeCampaignShow {
  campaign: Mission; title: string; planDigest: string; commit: string; approved: boolean;
  /** campaignAuthorizationRefusal: null when an authorization is in force. */
  authorization: string | null;
  order: string[];
  lanes: Array<{ id: string; title: string; tickets: string[]; owns: string[]; maxParallel: number }>;
  /** A preview of dependency layers, not the run's waves. */
  waves: string[][];
  tickets: Array<CampaignTicket & { status: WorkItemStatus | 'unknown'; title: string }>;
  ownerDecisions: Assumption[];
  needs: Need[];
  /** The current authorize-campaign scope, or null. */
  envelope: CampaignEnvelope | null;
  lock: { decisionId: string; gateSetDigest: string; ratchet: boolean; gates: number; holdouts: number } | null;
}
/** `assumption list --format json` rows; `options` from the plan's ownerDecisions[].options. */
export type ForgeAssumptionRow = Assumption & { heldTickets: string[]; options: string[] };

export interface RefineMapRef {
  rev: string;
  /** Relative to <out>. */
  dir: string;
  files: number; parsers: string[]; invariantsSource: string | null;
}
export interface RefineDiff<T> { introduced: T[]; resolved: T[]; persisting: number }
export interface RefineFamily {
  /** Sorted members joined by \n. */
  key: string;
  members: string[]; detectors: Array<'D1' | 'D2' | 'D3' | 'D4'>; touched: boolean;
}
export interface RefineDeadEnd {
  /** `${kind}:${id}` | `orphan:${sorted}` */
  key: string;
  kind: 'file' | 'symbol' | 'orphan-cluster'; ids: string[]; tier: Tier | null; why: string; touched: boolean;
}
export interface RefineCycle { key: string; members: string[]; touched: boolean }
export interface RefineInvariant {
  id: string; prose: string; base: 'green' | 'red' | 'absent'; rev: 'green' | 'red' | 'absent';
  measured: string; violations: number;
  /** ≤ 5 */
  first: Violation[];
}
export type RefineOverlay = 'assumption' | 'finding' | 'forgery' | 'blocked' | 'untested' | 'introduced';
export interface RefineReport {
  kind: 'daylight-refine'; version: 1;
  campaignId: string; projectId: string; integrationRef: string;
  base: string; rev: string; stale: boolean;
  /** null with --rows-only */
  maps: { base: RefineMapRef; rev: RefineMapRef } | null;
  changed: Array<{ path: string; change: 'added' | 'modified' | 'deleted'; insertions: number | null; deletions: number | null; tickets: string[] }>;
  /** null with --rows-only */
  findings: {
    duplication: RefineDiff<RefineFamily>; deadEnds: RefineDiff<RefineDeadEnd>; cycles: RefineDiff<RefineCycle>;
    invariants: { source: string | null; regressed: number; fixed: number; results: RefineInvariant[] };
  } | null;
  /** Echoed so a reader sees why the order. */
  focusRules: readonly FocusRule[];
  /** Ranked by `focusRules`; an item's tier is its kind's rule's. */
  focus: FocusItem[];
  /** Repo-relative files per overlay. */
  overlays: Record<RefineOverlay, string[]>;
}

export type FocusKind = 'assumption' | 'finding' | 'forgery-shape' | 'blocked-ticket' | 'untested-diff' | 'introduced';
export type FactValue = string | number | boolean;
export interface FocusItem { kind: FocusKind; ref: string; title: string; facts: Record<string, FactValue>; paths: string[]; why: string }
export type FocusCond = { fact: string; in: FactValue[] } | { fact: string; gt: number } | { anyOf: FocusCond[] };
/** `where` is AND; `order` sorts lexicographically, booleans false < true. */
export interface FocusRule { kind: FocusKind; tier: number; where: FocusCond[]; order: Array<{ fact: string; dir: 'asc' | 'desc' }> }

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
  | 'approve-candidate' | 'reject-candidate' | 'override-candidate' | 'adhoc-mission'
  | 'resolve-dependency-request'
  | 'approve-plan' | 'lock-campaign-gates' | 'authorize-campaign' | 'halt-campaign' | 'resume-campaign'
  | 'adopt-integration-tip' | 'integrate-candidate' | 'admit-work-item' | 'confirm-assumption' | 'decide-assumption'
  | 'overturn-assumption' | 'retry-ticket';

export const DECISION_OPERATIONS: readonly DecisionOperation[] = [
  'authorize-mission', 'lock-gates', 'approve-work-item', 'reject-work-item',
  'approve-candidate', 'reject-candidate', 'override-candidate', 'adhoc-mission',
  'resolve-dependency-request',
  'approve-plan', 'lock-campaign-gates', 'authorize-campaign', 'halt-campaign', 'resume-campaign',
  'adopt-integration-tip', 'integrate-candidate', 'admit-work-item', 'confirm-assumption', 'decide-assumption',
  'overturn-assumption', 'retry-ticket',
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
  | AdhocMissionScope
  | ApprovePlanScope | CampaignLockScope | AuthorizeCampaignScope | IntegrateCandidateScope | AdmitWorkItemScope
  | HaltCampaignScope | ResumeCampaignScope | AdoptTipScope | AssumptionDecisionScope | RetryTicketScope;

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

/** Who decided what, counted. Human rows in the ledger carry decisions, never dollars. */
export interface LedgerDecisionCount {
  actor: string;
  kind: DecisionKind;
  operation: DecisionOperation | null;
  count: number;
}

export interface LedgerWorkItem {
  id: string;
  missionId: string;
  title: string;
  status: WorkItemStatus;
}

export interface LedgerRevision {
  revision: string;
  missions: number;
  attempts: number;
}

/**
 * The project ledger as one JSON document (interfaces-reconciled R-28), declared here so the
 * renderer can type it without importing `mission/ledger.ts`. It carries no timestamp, so an
 * export → import → ledger round trip is byte-equal. WS5 builds it.
 */
export interface Ledger {
  kind: 'daylight-ledger';
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  projectId: string;
  rows: LedgerRow[];
  decisions: LedgerDecisionCount[];
  workItems: LedgerWorkItem[];
  applications: Application[];
  revisions: LedgerRevision[];
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

// ---- campaigns (WS-R5) -------------------------------------------------------
//
// A campaign is a mission of kind `campaign` whose children are ticket missions
// (`Mission.parentId`). Its plan is data a person approves once; the director process then acts
// under one human `authorize-campaign` decision, recording derived decisions as `campaign:<m_id>`.
// docs/daylight/CAMPAIGN.md; ADR-36, ADR-37.

export const PLAN_KIND = 'daylight-plan' as const;
export const PLAN_VERSION = 1 as const;

export interface PlanFileV1 {
  kind: typeof PLAN_KIND; version: typeof PLAN_VERSION; title: string;
  derivedStatus?: boolean; statusPath?: string;     // STATUS is derived; statusPath is protected for authors
  defaults?: { budget?: TicketBudget; acceptance?: TicketAcceptance };
  campaignGates: PlanCampaignGateV1[];              // project-wide regression gates
  lanes: PlanLaneV1[]; ownerDecisions?: PlanOwnerDecisionV1[]; tickets: PlanTicketV1[];
}
export interface PlanCampaignGateV1 {   // an ordinary R2 gate (P2-R16)
  id: string;                    // /^[a-z][a-z0-9-]{0,31}$/
  role: 'regression';            // must pass at base and on every integrated tree
  harness?: GateHarness; path: string; crate?: string;  // test file at the plan commit; harness defaults to defaultGateHarness(policy)
  expect: ExpectedObservation; timeoutSeconds?: number;
}
export interface PlanGateTestV1 { path: string; harness?: GateHarness; crate?: string; expect: ExpectedObservation }
export interface PlanLaneV1 {
  id: string;                    // /^[A-Z][A-Z0-9]{0,7}$/; 'FIX' reserved
  title: string; owns: string[]; // owns: repo-relative prefixes
  maxParallel?: number;          // default 1: one writer per lane, as kitkraft
  shared?: string[];             // prefixes this lane may share with another lane
}
export interface PlanOwnerDecisionV1 {
  id: string;                    // /^O[A-Z0-9.]{1,31}$/
  question: string; options?: string[]; blocking: boolean; rationale?: string;
  default?: string;              // required when blocking is false
}
export interface PlanTicketV1 {
  id: string;                    // /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$/, <= 32 chars, e.g. "M2.A1"
  lane: string; title: string;   // title <= MAX_TITLE_CHARS (proposal.ts), one line
  statement: string | string[];  // <= MAX_STATEMENT_BYTES joined (proposal.ts)
  examples?: string[]; negativeExamples?: string[];   // <= MAX_EXAMPLES each (proposal.ts)
  dependsOn?: string[]; blocksOn?: string[];          // ticket ids; owner-decision ids
  scope: string[];               // repo-relative prefixes; becomes MissionScope.paths
  acceptance?: TicketAcceptance; // default plan.defaults.acceptance, else { kind: 'ci-only' }
  budget?: TicketBudget;
}
export type TicketAcceptance =
  | { kind: 'gate'; tests: PlanGateTestV1[] }                                   // public tests at the plan commit, bound to the ticket
  | { kind: 'ci-only' }
  | { kind: 'writer-authored'; harness?: GateHarness; crate?: string; testPaths: string[]; expect: ExpectedObservation }; // author writes them
/** Each field lowers, never raises, the envelope's matching cap. */
export interface TicketBudget { maxUsd?: number; maxTurns?: number; timeoutSeconds?: number; maxAttempts?: number }
export interface PlanRefusal { path: string; rule: PlanRule; detail: string }
export type PlanRule = 'shape' | 'version' | 'duplicate-id' | 'unknown-lane' | 'unknown-dependency' | 'self-dependency' | 'cycle'
  | 'scope-path' | 'scope-protected' | 'scope-outside-lane' | 'lane-overlap' | 'unknown-owner-decision' | 'owner-default-missing'
  | 'acceptance-path' | 'acceptance-harness' | 'gate-expectation' | 'policy' | 'text' | 'too-many' | 'too-large';

/** Where a campaign ticket came from: the approved plan, a wave-review finding, or an overturned assumption. */
export type TicketOrigin = 'plan' | 'fix' | 'follow-up';

export interface CampaignTicket { campaignId: string; ticketId: string; projectId: string; workItemId: string; origin: TicketOrigin;
  lane: string; dependsOn: string[]; scope: string[]; acceptance: TicketAcceptance; budget: TicketBudget; blocksOn: string[];
  ticketDigest: string; sourceRef?: string; createdAt: number }

/**
 * A ticket's state, derived from rows on every pass and never stored (§4.2). `waiting-dependency`:
 * its mission has an open `request-dependency` need; the loop parks it and continues (P2-R21).
 */
export type TicketStatus =
  | 'superseded' | 'waiting-owner'   // work item superseded/rejected | blocksOn names an open owner decision
  | 'waiting' | 'ready'              // a dependency not landed | deps landed, no open mission, not exhausted
  | 'running' | 'integrating'        // live attempt | integration row pending/evaluating
  | 'waiting-dependency'             // its mission has an open request-dependency need: parked, the loop continues (P2-R21)
  | 'landed' | 'blocked';            // integrated and reachable from the ref | blocked or closed failed/inconclusive (a need)

export interface ApprovePlanScope { operation: 'approve-plan'; planDigest: string; planRevision: string;
  workItems: Record<string, string>;   // workItemId → contentDigest for every plan ticket: what setWorkItemStatus/assertImplementable check
  supersedes: string[] }

export const FINDING_SEVERITIES = ['low', 'medium', 'high'] as const;   // rank = index
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface CampaignEnvelope {
  planDigest: string; gateSetDigest: string;     // the plan and campaign lock this grant runs against
  policyDigest: string | null;                   // `ProjectPolicy.digest` at the plan commit, or null
  ticketIds: string[];                           // explicit; "all" is expanded at confirm time
  roster: string[]; reviewRoster: string[];      // author tools / wave reviewers ([] disables review)
  maxUsdTotal: number; maxUsdPerMission: number; // campaign cap; per ticket mission incl. its repairs
  maxTurns: number; timeoutSeconds: number;      // ≤ authorLimits(policyAtPlanCommit, defaults).maxTurns / timeoutMs (P2-R20)
  maxAttemptsPerTicket: number; concurrency: number; waveSize: number;  // 1 + repairs (default 3); --concurrency ceiling; default 2×concurrency
  execute: boolean;                              // nested `run` tool (ADR-35) for every ticket mission
  autoApply: 'integration-ref' | 'none';
  fixLane: { enabled: boolean; maxTicketsPerWave: number; maxUsdPerTicket: number };  // High only, maxTicketsPerWave ≤ 5 (P2-R10)
  identity: { name: string; email: string };     // committer of integrated commits, labelled asserted
  notAfter: number;                              // epoch ms; default now + 72h
}
export interface AuthorizeCampaignScope extends CampaignEnvelope { operation: 'authorize-campaign' }

/** Declared here for both writers; `campaign lock` (WS-R6) records it. */
export interface CampaignLockScope {
  operation: 'lock-campaign-gates'; experimentIds: string[]; harnessDigests: Record<string, string>; vacuousOverrides: string[];
  bindings: Record<string, string | null>;                       // experimentId → ticket id; null = regression / unbound holdout
  roles: Record<string, 'regression' | 'gate' | 'holdout'>; ratchet: boolean;
  gateSetDigest: string;      // sha256 over sorted "<x_id>:<harnessDigest>:<role>:<ticket|*>" lines plus "ratchet:<bool>"
}

/** `campaign:<m_id>`: the director process acting under a human authorize-campaign decision. Never a person. */
export const isCampaignActor = (actor: string): boolean => /^campaign:m_[0-9a-f]{32}$/.test(actor);
export const campaignActorOf = (campaignId: string): string => `campaign:${campaignId}`;
export const DERIVED_OPERATIONS: readonly DecisionOperation[] = ['authorize-mission', 'integrate-candidate', 'admit-work-item', 'halt-campaign'];
export interface DerivedScope { derivedFrom: string /* d_ of a human authorize-campaign */ }
export type DerivedAuthorizeScope = AuthorizeScope & DerivedScope;
export interface IntegrateCandidateScope extends DerivedScope { operation: 'integrate-candidate'; candidateId: string; diffDigest: string;
  gateSetDigest: string; baseCommit: string; integrationId: string; onto: string; integratedCommit: string; integratedDiffDigest: string }
export interface AdmitWorkItemScope extends DerivedScope { operation: 'admit-work-item'; workItemId: string; contentDigest: string;
  ticketId: string; findingId?: string }
export interface HaltCampaignScope { operation: 'halt-campaign'; reason: CampaignHaltReason; derivedFrom?: string }
export interface ResumeCampaignScope { operation: 'resume-campaign'; haltDecisionId: string; reason: CampaignHaltReason }
export interface AdoptTipScope { operation: 'adopt-integration-tip'; ref: string; from: string; to: string; haltDecisionId: string }
export type CampaignHaltReason = 'operator' | 'spend-unknown' | 'spend-cap' | 'spend-breach' | 'integration-moved' | 'invariant'
  | 'authorization-expired';

/** `campaign retry`: a human releases a preflight-closed ticket's work item (P2-R25, P2-R27). */
export interface RetryTicketScope { operation: 'retry-ticket'; ticketId: string; workItemId: string; contentDigest: string;
  closedMissionId: string; reason: string }

export type AssumptionStatus = 'open' | 'pending' | 'confirmed' | 'overturned';
export type AssumptionSource = 'plan-default' | 'operator';
export interface Assumption {
  id: string; projectId: string; campaignId: string;                 // id: u_…
  missionId?: string; ticketId?: string; ownerDecisionId?: string;   // what it was taken for; plan ownerDecisions[].id
  question: string; default: string; rationale: string;              // default: what the director proceeds on ('' while open)
  status: AssumptionStatus; blocking: boolean; source: AssumptionSource;
  recordedBy: string;                                                // 'daylight' (import) | human:<n>
  decisionId?: string; followUpWorkItemId?: string;                  // the human decision; overturn's follow-up
  createdAt: number; updatedAt: number;
}
export interface AssumptionDecisionScope { operation: 'confirm-assumption' | 'decide-assumption' | 'overturn-assumption';
  assumptionId: string; value: string; followUpWorkItemId?: string }

/** `campaign.authorized`: ids, digests and caps, never prose. */
export interface CampaignAuthorizedPayload {
  decisionId: string; planDigest: string; gateSetDigest: string;
  maxUsdTotal: number; maxUsdPerMission: number; concurrency: number; execute: boolean;
  autoApply: CampaignEnvelope['autoApply'];
}

/** What a derived decision asks of its campaign's envelope (`envelopeRefusal`). */
export interface EnvelopeRequest {
  missionId: string; operation: DecisionOperation; ticketId: string; permissions?: MissionPermissions; maxUsd?: number | null;
  at: number;
  /** `admit-work-item` of a fix ticket: the wave it is admitted in, for the per-wave cap (P2-R10). */
  waveSeq?: number;
}
