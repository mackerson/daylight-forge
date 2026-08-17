/**
 * L0 graph — the exhaustive layer. Everything above it is derived by recorded elision.
 *
 * Language-neutral on purpose: a parser provider fills these in, and nothing here
 * mentions TypeScript. See src/extract/parser.ts for the provider contract.
 */

export type NodeKind =
  | 'file'
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'typeAlias'
  | 'enum'
  | 'variable';

export interface GraphNode {
  /** `path` for files, `path#Name` for symbols. See DESIGN.md open problem 1 — this is the fragile bit. */
  id: string;
  kind: NodeKind;
  name: string;
  /** Repo-relative, posix separators. */
  file: string;
  line: number;
  endLine: number;
  exported: boolean;
  /** Invalidation key: hash of the containing file's bytes. */
  contentHash: string;
}

export type EdgeKind = 'imports' | 'contains' | 'extends' | 'implements' | 'calls' | 'references';

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Import specifier as written, before resolution. */
  spec?: string;
  /** True when `to` is outside the analysed root (a package, a builtin). */
  external?: boolean;
  /** Final property name for member calls: `eventBus.emitEvent` → `emitEvent`. */
  member?: string;
  line?: number;
}

/**
 * A string literal passed to a call. Channel names, event names and IPC keys carry
 * the real coupling in an Electron app and are invisible to an import graph, so
 * invariants lean on these heavily.
 */
export interface CallRecord {
  /** Enclosing symbol id, or the file id at top level. */
  from: string;
  file: string;
  callee: string;
  member?: string;
  line: number;
}

export interface LiteralRecord extends CallRecord {
  value: string;
}

/** A structure's shape, for D1 (near-duplicate structures). */
export interface ShapeRecord {
  nodeId: string;
  name: string;
  file: string;
  line: number;
  kind: 'interface' | 'typeAlias' | 'class';
  fields: Array<{ name: string; type: string }>;
}

/** A callable's signature, for D2 (duplicate names) and D3 (duplicate signatures). */
/**
 * A MinHash signature over a function body's token shingles.
 *
 * Storing the body itself would bloat graph.json for no benefit; storing a signature keeps
 * D4 to a fixed cost per function and lets similarity be estimated by comparing integers.
 */
export type BodySignature = number[];

export interface FunctionRecord {
  nodeId: string;
  name: string;
  file: string;
  line: number;
  kind: 'function' | 'method' | 'arrow';
  params: Array<{ name: string; type: string }>;
  returnType: string;
  exported: boolean;
  /** Absent for bodies too short to be worth comparing. */
  body?: BodySignature;
  /** Token count of the body, so trivial functions can be excluded by size. */
  bodyTokens?: number;
  /** Last line of the declaration. Present so nesting can be detected. */
  endLine?: number;
}

export interface ParseDiagnostic {
  file: string;
  message: string;
}

export interface Graph {
  root: string;
  /** Stamped by the CLI, not the extractor — extraction stays deterministic. */
  generatedAt?: string;
  commit?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  shapes: ShapeRecord[];
  functions: FunctionRecord[];
  calls: CallRecord[];
  literals: LiteralRecord[];
  /**
   * What the tests import, when tests are excluded from the map.
   *
   * Kept out of `edges` deliberately: a test edge must not satisfy a `forbidden-call`
   * invariant, appear in the tree, or join a community. It exists so reachability can tell
   * "nothing uses this" apart from "only the tests use this" — which are different findings
   * and were being reported as the same one.
   */
  testImports: Array<{ from: string; to: string }>;
  diagnostics: ParseDiagnostic[];
  stats: {
    files: number;
    symbols: number;
    imports: number;
    unresolvedImports: number;
    externalImports: number;
    /** Bundler-handled non-code imports (css, images, fonts). Counted, never edges. */
    assetImports: number;
    calls: number;
    resolvedCalls: number;
    literals: number;
    /** Vendored bundles skipped. Reported, never silently dropped. */
    vendoredSkipped: number;
    /** Files actually parsed this run, versus served from the content-addressed cache. */
    parsedFiles: number;
    reusedFiles: number;
  };
}
