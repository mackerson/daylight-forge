import type { FunctionRecord, GraphNode, ShapeRecord } from '../graph/types.ts';

/** `import { a as b } from 'x'` → { local: 'b', imported: 'a', spec: 'x' }. */
export interface ImportBinding {
  local: string;
  /** Exported name, or `*` for namespace imports, `default` for default imports. */
  imported: string;
  spec: string;
}

/** A call site, attributed to the symbol that encloses it. */
export interface CallSite {
  /** Enclosing symbol id, or the file id at top level. */
  from: string;
  /** Full callee text, e.g. `eventBus.emitEvent`. */
  callee: string;
  /** Leftmost identifier, for matching against import bindings. */
  base?: string;
  /** Final property name, when the callee is a member access. */
  member?: string;
  line: number;
}

/**
 * A string literal passed to a call. Channel names, event names and IPC keys are
 * the real coupling in an Electron app, and they are invisible to import graphs.
 */
export interface LiteralUse {
  from: string;
  file: string;
  callee: string;
  member?: string;
  value: string;
  line: number;
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
  literals: LiteralUse[];
}

export interface Parser {
  name: string;
  /** File extensions this provider claims, with leading dot. */
  extensions: string[];
  parse(relPath: string, source: string, contentHash: string): ParsedFile;
}
