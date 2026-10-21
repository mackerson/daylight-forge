import type {
  CallRecord,
  FunctionRecord,
  GraphNode,
  LiteralRecord,
  ShapeRecord,
} from '../graph/types.ts';

/** `import { a as b } from 'x'` → { local: 'b', imported: 'a', spec: 'x' }. */
export interface ImportBinding {
  local: string;
  /** Exported name, or `*` for namespace imports, `default` for default imports. */
  imported: string;
  spec: string;
}

/**
 * A call site as the parser sees it: the graph's `CallRecord` plus the one field that
 * only matters during resolution and never reaches the graph.
 */
export interface CallSite extends CallRecord {
  /** Leftmost identifier, for matching against import bindings. */
  base?: string;
}

/**
 * What a language provider returns for one file. Resolution of import specifiers
 * to files happens outside the parser — providers only report what was written.
 */
export interface ParsedFile {
  nodes: GraphNode[];
  /** Import/re-export/dynamic-import specifiers as written. */
  imports: string[];
  bindings: ImportBinding[];
  /** `extends` / `implements` targets by local name, resolved later where possible. */
  heritage: Array<{ from: string; to: string; kind: 'extends' | 'implements' }>;
  shapes: ShapeRecord[];
  functions: FunctionRecord[];
  calls: CallSite[];
  literals: LiteralRecord[];
  /**
   * Problems the provider recovered from, e.g. a syntax error an error-tolerant parser parsed
   * around. Reported as graph diagnostics; the records above are still whatever it could read.
   */
  diagnostics?: string[];
}

export interface Parser {
  name: string;
  /** File extensions this provider claims, with leading dot. */
  extensions: string[];
  /**
   * One-time async setup, e.g. compiling a WebAssembly grammar. `loadParsers()` awaits it for
   * every provider; `parse()` stays synchronous and may throw if called before it settles.
   */
  init?(): Promise<void>;
  parse(relPath: string, source: string, contentHash: string): ParsedFile;
}
