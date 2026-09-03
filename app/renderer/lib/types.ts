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
export type VdsEvent = RunEvent & {
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
  dir: string;
  stack: FocusStack | null;
  /** Aggregated file→file edges; the hierarchy view's leaves are files. */
  fileEdges: Array<{ from: string; to: string; weight: number }>;
  /** Lets a headless screenshot open straight into a given layout. */
  initialMode?: 'graph' | 'tree';
  /** Panel to open on. Set from VDS_TAB so `pnpm shot` can capture a specific screen. */
  initialTab?: string | null;
  /** Enables the frame-time probe; set from VDS_PERF. */
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
  events: VdsEvent[];
  error?: string;
}

declare global {
  interface Window {
    vds: {
      state(): Promise<{
        repo: string | null; dir: string; hasGraph: boolean; missingRepo?: string | null;
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
      onEvent(fn: (e: VdsEvent) => void): () => void;
      onJob(fn: (j: Job) => void): () => void;
      onDerived(fn: (p: { at: number }) => void): () => void;
      onJobStats(fn: (p: {
        id: string; cost: number; turns: number;
        /** Per tool:model, because a run's total tells you nothing about which agent spent it. */
        sources?: Array<{ source: string; cost: number; turns: number }>;
      }) => void): () => void;
      onJobOutput(fn: (o: { id: string; stream: string; text: string }) => void): () => void;
    };
  }
}
