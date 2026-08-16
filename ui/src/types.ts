export interface FocusNode {
  id: string;
  label: string;
  purpose?: string;
  members: string[];
  fileCount: number;
  symbolCount: number;
  origin: 'path' | 'cluster' | 'elision' | 'defended';
}

export interface FocusEdge {
  from: string;
  to: string;
  weight: number;
  kinds: string[];
}

export interface FocusLevel {
  level: 1 | 2 | 3;
  name: string;
  nodes: FocusNode[];
  edges: FocusEdge[];
  elided: Array<{ id: string; members: number; reason: string }>;
  rejected?: Array<{ id: string; into: string; why: string }>;
}

export interface FocusStack {
  l0: { files: number; symbols: number; edges: number };
  levels: FocusLevel[];
  l3Status: 'TRUE' | 'STALE' | 'UNPROVEN';
}

export interface InvariantResult {
  id: string;
  prose: string;
  status: 'green' | 'red';
  measured: string;
  violations: Array<{ where: string; detail: string; line?: number }>;
}

export interface Evidence {
  file: string;
  line?: number;
  endLine?: number;
  note?: string;
}

export interface Claim {
  id: number;
  subject: string;
  predicate: string;
  value: unknown;
  source: { kind: 'static' | 'agent' | 'human'; tool?: string; model?: string };
  confidence: number;
  evidence: Evidence[];
  at: number;
}

export type ClaimStatus =
  | 'UNKNOWN' | 'INFERRED' | 'CORROBORATED' | 'CONTRADICTED' | 'CONFIRMED' | 'STALE';

export interface Belief {
  subject: string;
  predicate: string;
  status: ClaimStatus;
  value?: unknown;
  confidence: number;
  claims: Claim[];
}

export interface Family {
  id: string;
  members: string[];
  detectors: string[];
  topScore?: number;
  evidence: string[];
}

export interface D1Pair {
  a: string;
  b: string;
  score: number;
  nameScore: number;
  shared: string[];
  onlyA: string[];
  onlyB: string[];
}

export interface Findings {
  d1: D1Pair[];
  d2: Array<{ key: string; members: string[] }>;
  d3: Array<{ key: string; members: string[] }>;
  patterns: Array<{ detector: string; key: string; members: string[] }>;
  families: Family[];
}

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
}

export interface LoadPayload {
  repo: string | null;
  dir: string;
  stack: FocusStack | null;
  /** Aggregated file→file edges; the hierarchy view's leaves are files. */
  fileEdges: Array<{ from: string; to: string; weight: number }>;
  /** Lets a headless screenshot open straight into a given layout. */
  initialMode?: 'graph' | 'tree';
  findings: Findings;
  invariants: { results: InvariantResult[] } | null;
  defended: string[];
  graphStats: Record<string, number> | null;
}

export interface QueryPayload {
  stats: { claims: number; subjects: number; clusters: number; elisions: number; defences: number };
  beliefs: Belief[];
  contradictions: Belief[];
  clusters: Array<{ id: string; name: string; purpose: string; members: string[] }>;
  elisions: Array<{ id: string; members: string[]; into?: string; reason: string }>;
  defences: Array<{ id: string; node: string; reason: string }>;
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
      onEvent(fn: (e: VdsEvent) => void): () => void;
      onJob(fn: (j: Job) => void): () => void;
      onJobOutput(fn: (o: { id: string; stream: string; text: string }) => void): () => void;
    };
  }
}
