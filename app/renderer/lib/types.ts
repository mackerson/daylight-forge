/**
 * Renderer-local types.
 *
 * The focus, claim and duplication shapes are imported from the engine rather than
 * redeclared — the tool caught the copies on this very repo, scoring `FocusLevel` and
 * `FocusEdge` at 1.00 against their originals. Only what genuinely belongs to the
 * renderer lives here: the IPC payloads and the preload surface.
 */
export type {
  FocusNode, FocusEdge, FocusLevel, FocusStack, NodeBelief,
} from '../../../engine/focus/types.ts';
export type {
  Claim, ClaimStatus, Belief, Evidence, Source,
} from '../../../engine/store/types.ts';
export type { InvariantResult } from '../../../engine/invariants/engine.ts';
export type {
  CampaignEntry, CampaignLimits, CampaignSample, Progress, StopProgress, StopReason,
} from '../../../engine/swarm/progress.ts';
export type {
  StructureReport, DeadCandidate, Cycle, Limb, GodNode, Tier,
} from '../../../engine/detect/structure-types.ts';
export type {
  D1Pair, Family, D2Group, D3Group, D4Pair, Pattern,
  // The renderer had its own `Findings`: the same five fields with the discriminants
  // dropped and `patterns` widened to plain string. The tool caught it on this repo, so
  // it is now the engine's type under the renderer's name rather than a restatement.
} from '../../../engine/detect/duplication.ts';

/** The map's findings file: the duplication report, plus the file-level detector. */
export type Findings = DuplicationReport & { d6?: ParallelPair[] };

export type { ParallelPair } from '../../../engine/detect/parallel.ts';
export type { Candidate, CandidateKind } from '../../../engine/detect/candidates.ts';

import type { DuplicationReport } from '../../../engine/detect/duplication.ts';
import type { ParallelPair } from '../../../engine/detect/parallel.ts';
import type { FocusStack } from '../../../engine/focus/types.ts';
import type { Belief, ClaimStatus } from '../../../engine/store/types.ts';
import type { InvariantResult } from '../../../engine/invariants/engine.ts';
import type { RunEvent } from '../../../engine/replay/types.ts';
import type { CampaignEntry, CampaignSample } from '../../../engine/swarm/progress.ts';
import type { RenderSettings } from '../../../engine/render/settings.ts';
export type { RenderSettings, FrameStats } from '../../../engine/render/settings.ts';
import type { StructureReport } from '../../../engine/detect/structure-types.ts';
import type { AdapterStatus } from '../../../engine/swarm/types.ts';
export type { AdapterStatus } from '../../../engine/swarm/types.ts';
import type { QualityReport } from '../../../engine/quality/types.ts';
import type { RunRecord } from '../../../engine/swarm/types.ts';
export type { RunRecord } from '../../../engine/swarm/types.ts';
export type { QualityReport, QualityWarning, SourceUse } from '../../../engine/quality/types.ts';
export type {
  Mission, MissionKind, MissionState, MissionOutcome, Task, TaskState, Attempt, AttemptState,
  Experiment, ExperimentConclusion, ExpectedObservation, Decision, DecisionKind, ArtifactRef,
  DaylightEvent, EventCategory, ProjectIdentity,
} from '../../../engine/mission/types.ts';
export type { ExecutionRecord, ExecutionStatus, Observation } from '../../../engine/experiment/types.ts';
/**
 * The Forge's records, by the engine's names. Type-only, so nothing of the engine reaches the
 * bundle; `engine/mission/types.ts` has no runtime imports by design. The Forge `Candidate` is
 * renamed here because the detector's `Candidate` above had the name first.
 */
export type {
  WorkItem, WorkItemStatus, CandidateVerdict, CandidateFile, FileMode, PolicyRule, PolicyViolation,
  GateEvaluation, GateTarget, Application, IngestSource, Need, NeedKind, Ledger, LedgerRow,
  LedgerDecisionCount, LedgerWorkItem, LedgerRevision, AttemptSandbox, SandboxProfileName, NetworkMode,
  AttemptOrigin, CostSource, UsageSource, TokenUsage, ExperimentRole, DecisionOperation, SandboxReason,
  Candidate as ForgeCandidate,
} from '../../../engine/mission/types.ts';
/** The campaign screens' shapes (WS-R8's JSON forms), by the engine's names; type-only as above. */
export type {
  Assumption, AssumptionStatus, AssumptionSource, CampaignEnvelope, CampaignHaltReason, CampaignRunResult, CampaignSpend,
  CampaignStatusReport, CampaignTicket, TicketStatus, TicketOrigin, FindingSeverity, StatusBucket, StatusTable, StatusTableRow,
  DiffStat, SpendLine, RunClaim, ReportLanding, ReportAssumption, ReportFinding, ReportReview, ReportBlocked, WaveReport,
  ForgeryClass, ReportForgeryShapes, ForgeCampaignRow, ForgeCampaignList, ForgeCampaignShow, ForgeAssumptionRow,
  RefineMapRef, RefineDiff, RefineFamily, RefineDeadEnd, RefineCycle, RefineInvariant, RefineOverlay, RefineReport,
  FocusKind, FactValue, FocusItem, FocusCond, FocusRule,
} from '../../../engine/mission/types.ts';

import type {
  Mission, Task, Attempt, Experiment, Decision, DaylightEvent, ArtifactRef, ProjectIdentity,
  MissionKind, Need, WorkItem, Candidate as ForgeCandidate, GateEvaluation, Application, IngestSource,
  Ledger, LedgerRow, DecisionOperation,
  CampaignRunResult, CampaignStatusReport, ForgeAssumptionRow, ForgeCampaignList, ForgeCampaignShow, RefineReport, WaveReport,
} from '../../../engine/mission/types.ts';
import type { Evidence } from '../../../engine/store/types.ts';

/**
 * One side of a dispute, as `daylight mission inspect` reports it.
 *
 * A dispute is a CONTRADICTED belief inside a mission's scope, split by distinct answer; the
 * belief itself is carried so the existing arbitration screen can open it unchanged.
 */
export interface DisputeSide {
  source: string;
  value: unknown;
  confidence: number;
  evidence: Evidence[];
  claimId: number;
}

export interface Dispute {
  subject: string;
  predicate: string;
  belief: Belief;
  sides: DisputeSide[];
}

/** Something a person has to do before a mission can move; derived by the engine, never stored. */
export type MissionNeed = Need;

/**
 * A holdout as `mission inspect` reports it: ids, outcome and digests, never its test,
 * prediction or runs. The shape is engine/mission/orchestrate.ts's `WithheldExperiment`, built
 * from `Experiment` here because that module is not type-only.
 */
export type WithheldExperiment = Pick<Experiment, 'id' | 'missionId' | 'role' | 'conclusion' | 'harnessDigest' | 'lockedBy'> & { withheld: true };

export const isWithheld = (x: Experiment | WithheldExperiment): x is WithheldExperiment =>
  (x as { withheld?: unknown }).withheld === true;

/** `daylight mission inspect <id> --format json`. */

export interface MissionInspect {
  mission: Mission;
  tasks: Task[];
  attempts: Attempt[];
  experiments: Array<Experiment | WithheldExperiment>;
  decisions: Decision[];
  disputes: Dispute[];
  events: DaylightEvent[];
  needs?: MissionNeed[];
  /** Implement missions (WS8's `inspect` additions). Absent from older builds. */
  candidates?: ForgeCandidate[];
  gateEvaluations?: GateEvaluation[];
  applications?: Application[];
}

/** `daylight work-item list --format json`: the queue, and every need the engine derived. */
export interface WorkItemsPayload {
  workItems: WorkItem[];
  needs: Need[];
}

/** `daylight forge candidate <c> --format json`. The diff is redacted and bounded by the CLI. */
export interface ForgeCandidatePayload {
  candidate: ForgeCandidate;
  /** Paths whose diff matched a low-confidence secret shape (R16). Approve and override need them acknowledged. */
  possibleSecrets: string[];
  /**
   * Test-output forgery shapes per file (P2-R49), read by main from the candidate summary's
   * flags: shape names and paths, never the matched text. Approve and override need them
   * acknowledged; in a campaign a person acknowledges or rejects them on their own.
   */
  forgeryShapes?: Array<{ path: string; shapes: string[] }>;
  diff: { text: string; truncated: boolean };
  gateEvaluations: GateEvaluation[];
}

/** `daylight ingest list --format json`. `skipped` is null when no run has recorded counts. */
export interface IngestSourcesPayload {
  sources: IngestSource[];
  skipped: Record<string, number> | null;
}

/**
 * What `daylight confirm` prints: the digest a guarded act will check, the lines the native
 * dialog shows, and the engine's `guardCheck` answer (null when the act would pass).
 */
export interface ConfirmPreview {
  operation: DecisionOperation | 'apply';
  subjectId: string;
  digest: string;
  digest8: string;
  lines: string[];
  refusal: string | null;
  actor: string;
  possibleSecrets: string[];
}

/** One `report --project --format json` row: `LedgerRow` with null where nothing was reported. */
export type LedgerJsonRow = Omit<LedgerRow, 'usdKnown' | 'tokens'> & {
  /** Null when no attempt in the row carries a provider figure. */
  usdKnown: number | null;
  tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; unknownCount: number };
  tokensUnknownByField: { input: number; output: number; cacheRead: number; cacheWrite: number };
  tokensKnown: boolean;
  costKnown: boolean;
  /** Present when any attempt in the row is ingested (R12.1), whatever the grouping. */
  outside?: string;
};

export type LedgerJson = Omit<Ledger, 'rows'> & { rows: LedgerJsonRow[] };
export type LedgerGroup = 'runner' | 'model' | 'origin' | 'mission' | 'work-item' | 'actor';

/**
 * How a guarded act ended: refused by the guard (no dialog), cancelled at the dialog, failed
 * in the act, or done. Main sets the actor and the code; the renderer only reads this.
 */
/**
 * What `forge-refine-map` returns: one revision's map, read by main from
 * `<out>/campaigns/<c>/maps/<rev>/` the way `daylight:load` reads the checkout's. It has no
 * `dir`, so the Scene drawing it reads and writes no layout (P2-R45 D3).
 */
export interface ForgeRefineMap {
  rev: string;
  stack: FocusStack | null;
  fileEdges: Array<{ from: string; to: string; weight: number }>;
  findings: Findings;
  structure: StructureReport | null;
  invariants: { results: InvariantResult[] } | null;
  graphStats: Record<string, number> | null;
  /** The project root, a label only. */
  repo: string;
  /** Nothing is defended on a refine map. */
  defended: [];
}

/** `forge-campaign`: the plan as recorded and the derived status, read together. */
export interface ForgeCampaignPayload { show: ForgeCampaignShow; status: CampaignStatusReport }

/** Where the wave report reads from: one closed wave, the landings since the last one, or the whole campaign. */
export type ReportWave = number | 'open' | 'all';

/** The envelope as the authorize form sends it; main turns it into flags and never adds an identity. */
export interface CampaignAuthorizeForm {
  id: string; rationale: string;
  roster: string[]; reviewRoster: string[];
  maxUsdTotal: number; maxUsdPerMission: number; maxTurns: number; timeoutSeconds: number;
  maxAttempts: number; concurrency: number; waveSize?: number;
  execute: boolean; autoApply: 'integration-ref' | 'none';
  fixLane: { tickets: number; usd: number } | 'off';
  tickets?: string[];
  notAfterHours: number;
}

export type AssumptionAct = 'confirm' | 'decide' | 'overturn';
export interface AssumptionDecideForm {
  id: string; kind: AssumptionAct; rationale: string;
  value?: string; followUp?: string; lane?: string; scope?: string[];
}

export interface GuardedResult {
  ok?: boolean;
  refused?: string;
  canceled?: boolean;
  error?: string;
  operation?: DecisionOperation | 'apply' | 'acknowledge-forgery-shape';
  digest8?: string;
  lines?: string[];
  possibleSecrets?: string[];
  forgeryShapes?: Array<{ path: string; shapes: string[] }>;
  /** Why a dialog OK still recorded nothing (an unticked acknowledgement). */
  note?: string;
  result?: unknown;
}

/**
 * What a running `mission run` pushes on each state change: a few fields, not a Mission.
 * `note` is progress text for a console, not part of the mission.
 */
export interface MissionUpdate {
  id: string;
  state: Mission['state'];
  outcomeReason: string | null;
  note?: string;
}

/** `daylight mission list --format json`. */
export interface MissionList {
  project: ProjectIdentity | null;
  missions: Mission[];
  /** By mission id. Absent from older builds and the bundled sample. */
  needs?: Record<string, MissionNeed[]>;
}


export interface MissionCreateOptions {
  kind: MissionKind;
  objective: string;
  scope?: string[];
  maxCost?: number;
}

/**
 * One row of the launch roster: a tool and the model it runs on.
 *
 * The pair, not the tool, is what the claim store records as a source and what corroboration
 * counts — which is why the launcher edits pairs and lets the same tool appear twice.
 */
export interface RosterEntry {
  tool: string;
  model: string;
}

export interface RunShape {
  roster: RosterEntry[];
  mode: 'explore' | 'focus';
  batch: number;
  concurrency: number;
  maxCost: number;
  /** Split the frontier across the roster instead of asking everyone the same questions. */
  spread: boolean;
  /**
   * Round cap for a campaign. Ignored by a single launch, which is one round by definition.
   *
   * Always set, because an unbounded loop over paid agents is not a feature — convergence is
   * a property of the codebase, not a promise about how long this will take.
   */
  rounds: number;
}

/**
 * One recorded agent action, as the renderer reads it.
 *
 * Extends the engine's `RunEvent` rather than restating it — the same mistake the renderer's
 * old private `Findings` made. The engine owns what a recorded event *is*, because the MCP
 * server is what writes them; these are the fields the panels happen to display.
 */
export type AgentEvent = RunEvent & {
  ok?: boolean;
  predicate?: string;
  name?: string;
  into?: string;
  members?: number;
  evidence?: number;
  confidence?: number;
  error?: string;
};

export interface Job {
  id: string;
  label: string;
  status: 'running' | 'done' | 'failed';
  code?: number;
  startedAt?: number;
}

export interface LoadPayload {
  repo: string | null;
  /**
   * Set when the map in `dir` names a repo that is no longer on disk.
   *
   * The map still draws — it is a file, and it is fine — but nothing that needs to read the
   * source can run, and saying which path went missing is the difference between a button
   * that is broken and a button that is correctly refusing.
   */
  missingRepo?: string | null;
  /** Set when `dir` is a stand-in because the checkout it would be derived from has no knowable id. */
  dirNote?: string | null;
  dir: string;
  stack: FocusStack | null;
  /** Aggregated file→file edges; the hierarchy view's leaves are files. */
  fileEdges: Array<{ from: string; to: string; weight: number }>;
  /** Lets a headless screenshot open straight into a given layout. */
  initialMode?: 'graph' | 'tree';
  /** Panel to open on. Set from DAYLIGHT_TAB so `pnpm shot` can capture a specific screen. */
  initialTab?: string | null;
  /** Enables the frame-time probe; set from DAYLIGHT_PERF. */
  perf?: boolean;
  /** Opens the first contradiction straight into arbitration; for headless capture. */
  autoArbitrate?: boolean;
  findings: Findings;
  structure: StructureReport | null;
  invariants: { results: InvariantResult[] } | null;
  defended: string[];
  graphStats: Record<string, number> | null;
  /** Whether a file watcher is running. Owned by main, which is what can stop one. */
  watching?: boolean;
  /**
   * Every campaign sample in the output directory, oldest first and unfiltered.
   *
   * Which of them belong to the run on screen is `seriesOf`'s answer, not the shell's — one
   * definition, so the chart cannot end up plotting a different campaign from the one the
   * live channel is feeding.
   */
  campaign?: CampaignEntry[];
  /**
   * Render Mission Control from the bundled sample rather than the CLI. Set from
   * DAYLIGHT_MISSION_SAMPLE so the headless harness can exercise the screens on a machine with no
   * missions, and so a reviewer can see the layout without spending anything. The sample is
   * labelled as such on screen.
   */
  missionSample?: boolean;
  /** Who decisions are recorded as, by default: `human:<os user>`. Main knows; the renderer does not. */
  username?: string;
}

export interface QueryPayload {
  stats: { claims: number; subjects: number; clusters: number; elisions: number; defences: number };
  beliefs: Belief[];
  contradictions: Belief[];
  clusters: Array<{
    id: string; name: string; purpose: string; members: string[];
    verdict: { status: ClaimStatus; value?: unknown } | null;
  }>;
  elisions: Array<{
    id: string; members: string[]; into?: string; reason: string;
    verdict: { status: ClaimStatus; value?: unknown } | null;
  }>;
  defences: Array<{ id: string; node: string; reason: string }>;
  leases: Array<{ subject: string; session: string; until: number }>;
  /** What previous runs cost and bought; survives a restart, unlike a toast. */
  runs: RunRecord[];
  events: AgentEvent[];
  error?: string;
}

declare global {
  interface Window {
    daylight: {
      state(): Promise<{
        repo: string | null; dir: string; hasGraph: boolean; missingRepo?: string | null; dirNote?: string | null;
        watching?: boolean;
      }>;
      load(): Promise<LoadPayload>;
      query(): Promise<QueryPayload>;
      pickRepo(): Promise<{ repo: string | null; dir: string }>;
      /** Refuses, with a reason, when the directory holds a different repository's map. */
      setDir(): Promise<{ repo: string | null; dir: string; error?: string }>;
      map(): Promise<{ id?: string; error?: string }>;
      refocus(): Promise<{ id?: string; error?: string }>;
      quality(): Promise<QualityReport & { error?: string }>;
      adapters(opts?: { refresh?: boolean }): Promise<{
        adapters: AdapterStatus[]; error?: string;
      }>;
      /**
       * The whole loop as one job. The ceilings are all a person is for; everything else
       * the frontier already knows.
       */
      run(opts: {
        tools?: string; rounds?: number; maxCost?: number; batch?: number;
        concurrency?: number; spread?: boolean; skipMap?: boolean; only?: string[];
      }): Promise<{ id?: string; error?: string }>;
      onCampaign(fn: (p: { id: string; sample: CampaignSample }) => void): () => void;
      agent(opts: {
        tools?: string; mode?: 'explore' | 'focus'; batch?: number;
        model?: string; timeout?: number; dryRun?: boolean;
        maxCost?: number; concurrency?: number; spread?: boolean;
        /** Restrict the run to these subjects; empty lets the frontier choose. */
        only?: string[];
      }): Promise<{ id?: string; error?: string }>;
      stopJob(id: string): Promise<{ ok: boolean }>;
      arbitrate(p: {
        subject: string; predicate: string; value: unknown; note?: string;
      }): Promise<{ ok: boolean; error?: string }>;
      reveal(p: { file: string; line?: number }): Promise<{ ok: boolean }>;
      watch(on: boolean): Promise<{ watching: boolean }>;
      onWatch(fn: (p: { reason: string }) => void): () => void;
      snippet(p: { file: string; line?: number; context?: number }): Promise<{
        file?: string; start?: number; line?: number; lines?: string[]; error?: string;
      }>;
      settings(patch?: Partial<RenderSettings>): Promise<Partial<RenderSettings>>;
      layout(payload?: { repo: string; moved: Record<string, [number, number, number]> }): Promise<{
        moved?: Record<string, [number, number, number]>; ok?: boolean; error?: string;
      }>;
      symbols(p: { file: string }): Promise<{
        symbols: Array<{ id: string; name: string; kind: string }>; error?: string;
      }>;
      tryInvariant(p: { predicate: string }): Promise<InvariantResult & { error?: string }>;
      saveInvariant(p: { id: string; prose: string; predicate: string }): Promise<{
        ok?: boolean; file?: string; count?: number; replaced?: boolean; error?: string;
      }>;
      onEvent(fn: (e: AgentEvent) => void): () => void;
      onJob(fn: (j: Job) => void): () => void;
      onDerived(fn: (p: { at: number }) => void): () => void;
      onJobStats(fn: (p: {
        id: string; cost: number; turns: number;
        /** Per tool:model, because a run's total tells you nothing about which agent spent it. */
        sources?: Array<{ source: string; cost: number; turns: number }>;
      }) => void): () => void;
      onJobOutput(fn: (o: { id: string; stream: string; text: string }) => void): () => void;

      // ---- Mission Control. Every call shells out to a `daylight mission …` command in main. ----
      missions(): Promise<MissionList & { error?: string }>;
      mission(p: { id: string }): Promise<MissionInspect & { error?: string }>;
      missionCreate(p: MissionCreateOptions): Promise<Mission & { error?: string }>;
      /** Starts a job; its output streams through the ordinary job channels. */
      /** `unsandboxedReview` runs real-provider reviews with no sandbox, as P0 did (Sec H5); default off. */
      missionRun(p: { id: string; tools: string; maxCost?: number; dryRun?: boolean; unsandboxedReview?: boolean }): Promise<{ id?: string; error?: string }>;
      missionDecide(p: {
        id: string; subject: string; predicate: string; value: unknown; rationale: string;
        actor?: string; experiment?: string;
      }): Promise<{ decision?: Decision; belief?: Belief; error?: string }>;
      missionClose(p: { id: string; outcome: string; reason: string }): Promise<Mission & { error?: string }>;
      experimentRun(p: { id: string; runs?: number }): Promise<{ id?: string; error?: string }>;
      /** Redacted, bounded text of a content-addressed artifact. */
      artifact(p: { id: string; maxBytes?: number }): Promise<{
        ref?: ArtifactRef; text?: string; truncated?: boolean; error?: string;
      }>;
      dlEvents(p: { since: number; missionId?: string; limit?: number }): Promise<{ events: DaylightEvent[]; error?: string }>;
      /** Tell main which mission to poll events for; null stops polling. */
      missionWatch(missionId: string | null): Promise<{ watching: string | null }>;
      onDlEvent(fn: (p: { missionId: string; events: DaylightEvent[] }) => void): () => void;
      /** A `mission run` job reported a state change on a `##daylight {"mission":…}` line. */
      onMissionUpdate(fn: (p: { id: string; mission: MissionUpdate }) => void): () => void;
      demoPrepare(): Promise<{ id?: string; error?: string }>;
      /** Main opens the file picker; the renderer never names a path. */
      demoReplay(): Promise<{ id?: string; error?: string; canceled?: boolean }>;

      // ---- Forge. No call takes an actor, a confirm code or a path; main supplies them. ----
      workItems(): Promise<WorkItemsPayload & { error?: string }>;
      forgeCandidate(p: { id: string }): Promise<ForgeCandidatePayload & { error?: string }>;
      /** `since` is an ISO 8601 date. */
      ledger(p?: { group?: LedgerGroup; since?: string }): Promise<LedgerJson & { error?: string }>;
      ingestSources(): Promise<IngestSourcesPayload & { error?: string }>;
      missionAuthorize(p: { id: string; write: boolean; exec?: boolean; maxUsd: number | null; rationale: string }): Promise<GuardedResult>;
      gateLock(p: { id: string; rationale: string; acceptVacuous?: string[] }): Promise<GuardedResult>;
      forgeDecide(p: { id: string; kind: 'approve' | 'reject' | 'override'; rationale: string }): Promise<GuardedResult>;
      forgeApply(p: { id: string }): Promise<GuardedResult>;
      workItemDecide(p: { id: string; kind: 'approve' | 'reject'; rationale: string }): Promise<GuardedResult>;
      /** A job; one author, never a roster. */
      forgeRun(p: { id: string; tool: string; maxCost?: number }): Promise<{ id?: string; error?: string }>;
      /** Main opens the file picker inside the repository. */
      specRegister(): Promise<{ error?: string; canceled?: boolean } & Record<string, unknown>>;
      /** A job. No session means `--all`. */
      ingest(p?: { session?: string }): Promise<{ id?: string; error?: string }>;

      // ---- Forge campaigns. Same rule: ids and form fields only; main supplies actor, code, paths, refs. ----
      forgeCampaigns(): Promise<ForgeCampaignList & { error?: string }>;
      forgeCampaign(p: { id: string }): Promise<ForgeCampaignPayload & { error?: string }>;
      forgeCampaignReport(p: { id: string; wave?: ReportWave }): Promise<WaveReport & { error?: string }>;
      /** Read-only: the schedule and reservations a run would take now. Never starts a run. */
      forgeCampaignDryRun(p: { id: string }): Promise<CampaignRunResult & { error?: string }>;
      forgeAssumptions(p: { id: string }): Promise<ForgeAssumptionRow[] | { error: string }>;
      forgeRefine(p: { id: string }): Promise<RefineReport & { error?: string }>;
      forgeRefineMap(p: { id: string; which: 'base' | 'rev' }): Promise<ForgeRefineMap & { error?: string }>;
      forgeRefineTryInvariant(p: { id: string; which: 'base' | 'rev'; predicate: string }): Promise<InvariantResult & { error?: string }>;
      /** A job; when it ends the view reads `forgeRefine` again and never parses its output. */
      forgeRefineRun(p: { id: string }): Promise<{ id?: string; error?: string }>;
      forgeCampaignWatch(p: { id: string | null }): Promise<{ watching: string | null; error?: string }>;
      forgeCampaignApprovePlan(p: { id: string; rationale: string }): Promise<GuardedResult>;
      forgeCampaignAuthorize(p: CampaignAuthorizeForm): Promise<GuardedResult>;
      forgeCampaignRetry(p: { id: string; ticketId: string; rationale: string }): Promise<GuardedResult>;
      forgeCampaignResume(p: { id: string; haltId: string; rationale: string }): Promise<GuardedResult>;
      /** `to`: restore a deleted or rewound integration ref to this commit (WS-R12). */
      forgeCampaignAdoptTip(p: { id: string; haltId: string; to?: string; rationale: string }): Promise<GuardedResult>;
      /** A plain native dialog, then the halt; the one campaign write with no digest. */
      forgeCampaignHalt(p: { id: string }): Promise<GuardedResult>;
      forgeAssumptionDecide(p: AssumptionDecideForm): Promise<GuardedResult>;
      /** `forge acknowledge-forgery`: acknowledge a candidate's forgery shapes, or reject them (`declined`). */
      forgeCampaignForgeryReview(p: { id: string; declined: boolean; rationale: string }): Promise<GuardedResult>;
    };
  }
}
