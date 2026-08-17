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
  Claim, ClaimStatus, Belief, Evidence,
} from '../../../engine/store/types.ts';
export type { InvariantResult } from '../../../engine/invariants/engine.ts';
export type {
  StructureReport, DeadCandidate, Cycle, Limb, GodNode, Tier,
} from '../../../engine/detect/structure-types.ts';
export type {
  D1Pair, Family, D2Group, D3Group, Pattern,
  // The renderer had its own `Findings`: the same five fields with the discriminants
  // dropped and `patterns` widened to plain string. The tool caught it on this repo, so
  // it is now the engine's type under the renderer's name rather than a restatement.
  DuplicationReport as Findings,
} from '../../../engine/detect/duplication.ts';

import type { DuplicationReport } from '../../../engine/detect/duplication.ts';
import type { FocusStack } from '../../../engine/focus/types.ts';
import type { Belief, ClaimStatus } from '../../../engine/store/types.ts';
import type { InvariantResult } from '../../../engine/invariants/engine.ts';
import type { StructureReport } from '../../../engine/detect/structure-types.ts';

export interface VdsEvent {
  at: number;
  session: string;
  agent: string;
  model: string | null;
  tool: string;
  ok?: boolean;
  subject?: string;
  predicate?: string;
  name?: string;
  node?: string;
  into?: string;
  members?: number;
  evidence?: number;
  confidence?: number;
  error?: string;
}

export interface Job {
  id: string;
  label: string;
  status: 'running' | 'done' | 'failed';
  code?: number;
  startedAt?: number;
}

export interface LoadPayload {
  repo: string | null;
  dir: string;
  stack: FocusStack | null;
  /** Aggregated file→file edges; the hierarchy view's leaves are files. */
  fileEdges: Array<{ from: string; to: string; weight: number }>;
  /** Lets a headless screenshot open straight into a given layout. */
  initialMode?: 'graph' | 'tree';
  /** Enables the frame-time probe; set from VDS_PERF. */
  perf?: boolean;
  /** Opens the first contradiction straight into arbitration; for headless capture. */
  autoArbitrate?: boolean;
  findings: DuplicationReport;
  structure: StructureReport | null;
  invariants: { results: InvariantResult[] } | null;
  defended: string[];
  graphStats: Record<string, number> | null;
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
  events: VdsEvent[];
  error?: string;
}

declare global {
  interface Window {
    vds: {
      state(): Promise<{ repo: string | null; dir: string; hasGraph: boolean }>;
      load(): Promise<LoadPayload>;
      query(): Promise<QueryPayload>;
      pickRepo(): Promise<{ repo: string | null; dir: string }>;
      setDir(): Promise<{ repo: string | null; dir: string }>;
      map(): Promise<{ id?: string; error?: string }>;
      refocus(): Promise<{ id?: string; error?: string }>;
      agent(opts: {
        tools?: string; mode?: 'explore' | 'focus'; batch?: number;
        model?: string; timeout?: number; dryRun?: boolean;
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
      onEvent(fn: (e: VdsEvent) => void): () => void;
      onJob(fn: (j: Job) => void): () => void;
      onDerived(fn: (p: { at: number }) => void): () => void;
      onJobStats(fn: (p: { id: string; cost: number; turns: number }) => void): () => void;
      onJobOutput(fn: (o: { id: string; stream: string; text: string }) => void): () => void;
    };
  }
}
