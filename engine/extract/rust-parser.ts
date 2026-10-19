import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Language, Parser as TreeSitter, type Node } from 'web-tree-sitter';
import type { FunctionRecord, GraphNode, LiteralRecord, NodeKind, ShapeRecord } from '../graph/types.ts';
import type { CallSite, ImportBinding, ParsedFile, Parser } from './parser.ts';
import { minhashSignature } from './signature.ts';

/**
 * The vendored WebAssembly files and the sha256 each must have.
 *
 * Checked on every load, not only in CI: a grammar is code the engine runs, and a swapped
 * file should stop the provider rather than parse with it. `grammars/README.md` says where
 * each came from; `engine/test/rust-parser.ts` asserts both agree with the bytes on disk.
 */
export const GRAMMAR_FILES = {
  'web-tree-sitter.wasm': '99fa2281fc4c6da713ccdadce72e81571b032ab9901b751be2d5aa127c843aaf',
  'tree-sitter-rust.wasm': 'f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57',
} as const;

export const GRAMMAR_DIR = path.join(import.meta.dirname, 'grammars');

function readVerified(name: keyof typeof GRAMMAR_FILES): Uint8Array {
  const bytes = fs.readFileSync(path.join(GRAMMAR_DIR, name));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== GRAMMAR_FILES[name]) {
    throw new Error(`${name} sha256 ${actual} does not match the recorded ${GRAMMAR_FILES[name]}`);
  }
  return bytes;
}

/** One parser for the process: compiling the grammar is the expensive part, parsing is not. */
let loading: Promise<TreeSitter> | null = null;
let shared: TreeSitter | null = null;

async function load(): Promise<TreeSitter> {
  const runtime = readVerified('web-tree-sitter.wasm');
  await TreeSitter.init({ wasmBinary: runtime });
  const language = await Language.load(readVerified('tree-sitter-rust.wasm'));
  const parser = new TreeSitter();
  parser.setLanguage(language);
  return parser;
}

/** Collapse whitespace so `Vec<\n  T\n>` and `Vec<T>` compare equal. */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const lineOf = (n: Node): number => n.startPosition.row + 1;
const endLineOf = (n: Node): number => n.endPosition.row + 1;

const STRING_TYPES = new Set(['string_literal', 'raw_string_literal']);
const IDENTIFIER_TYPES = new Set([
  'identifier', 'field_identifier', 'type_identifier', 'shorthand_field_identifier', 'metavariable',
]);
const COMMENT_TYPES = new Set(['line_comment', 'block_comment']);

/** The text of a string literal without its quotes, `r#"..."#` included. */
function stringValue(n: Node): string {
  return n.namedChildren
    .filter((c): c is Node => !!c && (c.type === 'string_content' || c.type === 'escape_sequence'))
    .map((c) => c.text)
    .join('');
}

/** `pub`, `pub(crate)`, `pub(super)` reach outside the module; `pub(self)` does not. */
function isPublic(n: Node): boolean {
  const vis = n.namedChildren.find((c) => c?.type === 'visibility_modifier');
  return !!vis && squash(vis.text) !== 'pub(self)';
}

/** Leftmost path segment: `a::b::c` → `a`, `self.x.y()` → `self`. Matches `use` bindings. */
function leftmost(n: Node | null): string | undefined {
  let cur = n;
  while (cur) {
    if (cur.type === 'scoped_identifier' || cur.type === 'scoped_type_identifier') {
      const next = cur.childForFieldName('path');
      if (!next) return cur.childForFieldName('name')?.text;
      cur = next;
    } else if (cur.type === 'field_expression' || cur.type === 'index_expression') {
      cur = cur.childForFieldName('value') ?? cur.namedChild(0);
    } else if (cur.type === 'generic_function') {
      cur = cur.childForFieldName('function');
    } else if (
      IDENTIFIER_TYPES.has(cur.type) ||
      cur.type === 'self' || cur.type === 'crate' || cur.type === 'super'
    ) {
      return cur.text;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** `fmt::Display<T>` → `Display`: heritage resolves by bare name, like TypeScript's does. */
function typeName(n: Node | null): string | undefined {
  if (!n) return undefined;
  if (n.type === 'generic_type') return typeName(n.childForFieldName('type'));
  if (n.type === 'scoped_type_identifier' || n.type === 'scoped_identifier') {
    return n.childForFieldName('name')?.text;
  }
  if (n.type === 'type_identifier' || n.type === 'identifier') return n.text;
  return undefined;
}

/**
 * Structural tokens of a body for D4: every named node's kind, identifiers and literals
 * flattened to placeholders, comments dropped — the same recipe as the TypeScript provider.
 */
function bodySignature(body: Node): { sig: number[]; tokens: number } | null {
  const tokens: string[] = [];
  const walk = (n: Node): void => {
    if (COMMENT_TYPES.has(n.type)) return;
    if (IDENTIFIER_TYPES.has(n.type)) tokens.push('id');
    else if (STRING_TYPES.has(n.type) || n.type === 'char_literal') return void tokens.push('str');
    else if (n.type === 'integer_literal' || n.type === 'float_literal') tokens.push('num');
    else tokens.push(n.type);
    for (const c of n.namedChildren) if (c) walk(c);
  };
  for (const c of body.namedChildren) if (c) walk(c);
  return minhashSignature(tokens);
}

/** Where syntax errors are, for diagnostics. Capped: one broken file should not flood the list. */
function syntaxErrors(root: Node, limit = 5): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (out.length >= limit || !n.hasError) return;
    if (n.isError || n.isMissing) {
      out.push(`syntax error at line ${lineOf(n)}${n.isMissing ? `: missing ${n.type}` : ''}`);
      return;
    }
    for (const c of n.children) if (c) walk(c);
  };
  walk(root);
  return out;
}

/**
 * Rust, via tree-sitter compiled to WebAssembly.
 *
 * No native addon and no cargo: the grammar and runtime are vendored `.wasm` files with
 * recorded hashes, so a map of a Rust repository needs nothing installed beyond Node.
 * Tree-sitter is error-tolerant, so a file that does not compile still yields every item the
 * parser could recover, plus a diagnostic saying where it gave up.
 */
export class RustParser implements Parser {
  name = 'rust';
  extensions = ['.rs'];

  async init(): Promise<void> {
    if (shared) return;
    loading ??= load();
    try {
      shared = await loading;
    } catch (err) {
      loading = null; // Let a later call retry rather than caching the failure forever.
      throw err;
    }
  }

  parse(relPath: string, source: string, contentHash: string): ParsedFile {
    if (!shared) throw new Error('rust provider used before init() — call loadParsers() or initParsers() first');
    const tree = shared.parse(source);
    if (!tree) throw new Error('tree-sitter returned no tree');
    try {
      return this.walk(tree.rootNode, relPath, contentHash);
    } finally {
      tree.delete(); // Trees live in WebAssembly memory; the GC will not free them.
    }
  }

  private walk(root: Node, relPath: string, contentHash: string): ParsedFile {
    const nodes: GraphNode[] = [];
    const imports: string[] = [];
    const bindings: ImportBinding[] = [];
    const heritage: ParsedFile['heritage'] = [];
    const shapes: ShapeRecord[] = [];
    const functions: FunctionRecord[] = [];
    const calls: CallSite[] = [];
    const literals: LiteralRecord[] = [];

    /** Enclosing-symbol stack, so call sites attribute to a symbol not just a file. */
    const scope: string[] = [relPath];
    const here = () => scope[scope.length - 1];
    /** Inline `mod a { ... }` names around the current node. */
    const modPath: string[] = [];

    const used = new Set<string>();
    /** Two inherent `impl` blocks for one type, or a fn nested in another, can share a name. */
    const uniq = (id: string, n: Node): string => {
      const out = used.has(id) ? `${id}@${lineOf(n)}` : id;
      used.add(out);
      return out;
    };
    const idFor = (name: string, n: Node): string =>
      uniq(`${relPath}#${modPath.length ? `${modPath.join('::')}::` : ''}${name}`, n);

    const push = (id: string, kind: NodeKind, name: string, n: Node, exported: boolean) => {
      nodes.push({
        id, kind, name, file: relPath,
        line: lineOf(n), endLine: endLineOf(n), exported, contentHash,
      });
    };

    const params = (fn: Node) =>
      (fn.childForFieldName('parameters')?.namedChildren ?? [])
        .filter((p): p is Node => !!p && p.type === 'parameter')
        .map((p) => ({
          name: squash(p.childForFieldName('pattern')?.text ?? '_'),
          type: squash(p.childForFieldName('type')?.text ?? 'any'),
        }));
    const returnType = (fn: Node) => squash(fn.childForFieldName('return_type')?.text ?? '()');

    const recordFunction = (fn: Node, id: string, name: string, kind: 'function' | 'method', exported: boolean) => {
      const body = fn.childForFieldName('body');
      const sig = body ? bodySignature(body) : null;
      functions.push({
        nodeId: id, name, file: relPath, line: lineOf(fn), kind, endLine: endLineOf(fn),
        params: params(fn), returnType: returnType(fn), exported,
        ...(sig ? { body: sig.sig, bodyTokens: sig.tokens } : {}),
      });
    };

    /**
     * Inside `mod tests { use super::*; }` the `super` is this file, not its parent. Folding
     * the inline levels away here keeps the resolver file-based and keeps that `super` from
     * becoming an edge to a module the code never meant.
     */
    const fromInline = (segs: string[]): string[] => {
      if (!modPath.length) return segs;
      if (segs[0] === 'self') return segs;
      if (segs[0] !== 'super') return segs;
      let n = 0;
      while (segs[n] === 'super') n++;
      const rest = segs.slice(n);
      return n <= modPath.length ? ['self', ...rest] : [...Array(n - modPath.length).fill('super'), ...rest];
    };

    const pathSegments = (n: Node): string[] => squash(n.text).replace(/\s/g, '').split('::');

    const recordUse = (segs: string[], alias?: string) => {
      if (!segs.length) return;
      const full = fromInline(segs);
      const spec = full.join('::');
      imports.push(spec);
      const last = segs[segs.length - 1];
      const local = alias ?? last;
      // `use Trait as _` brings a trait into scope without a name to call through.
      if (local === '_' || local === '*') return;
      if (full.length === 1 || (full.length === 2 && full[0] === '')) {
        bindings.push({ local, imported: '*', spec });
      } else {
        bindings.push({ local, imported: last, spec: full.slice(0, -1).join('::') });
      }
    };

    /** Flatten a use tree into one path per leaf: `a::{b, c::d as e}` → `a::b`, `a::c::d`. */
    const expandUse = (n: Node, prefix: string[]): void => {
      switch (n.type) {
        case 'use_as_clause': {
          const p = n.childForFieldName('path');
          if (p) recordUse([...prefix, ...pathSegments(p)], n.childForFieldName('alias')?.text);
          return;
        }
        case 'scoped_use_list': {
          const p = n.childForFieldName('path');
          const next = p ? [...prefix, ...pathSegments(p)] : prefix;
          const list = n.childForFieldName('list');
          for (const c of list?.namedChildren ?? []) if (c) expandUse(c, next);
          return;
        }
        case 'use_list':
          for (const c of n.namedChildren) if (c) expandUse(c, prefix);
          return;
        case 'use_wildcard': {
          const p = n.namedChildren.find((c) => !!c);
          recordUse([...prefix, ...(p ? pathSegments(p) : []), '*']);
          return;
        }
        case 'self':
          // `use a::b::{self}` imports `b` itself.
          if (prefix.length) recordUse(prefix);
          return;
        default:
          if (COMMENT_TYPES.has(n.type)) return;
          recordUse([...prefix, ...pathSegments(n)]);
      }
    };

    const recordCallLiterals = (args: Node | null, callee: string, member: string | undefined, line: number) => {
      for (const arg of args?.namedChildren ?? []) {
        if (arg && STRING_TYPES.has(arg.type)) {
          literals.push({ from: here(), file: relPath, callee, member, value: stringValue(arg), line });
        }
      }
    };

    const shapeFields = (body: Node | null): ShapeRecord['fields'] => {
      if (!body) return [];
      if (body.type === 'field_declaration_list') {
        return body.namedChildren
          .filter((f): f is Node => !!f && f.type === 'field_declaration')
          .map((f) => ({
            name: f.childForFieldName('name')?.text ?? '(anonymous)',
            type: squash(f.childForFieldName('type')?.text ?? 'any'),
          }));
      }
      if (body.type === 'ordered_field_declaration_list') {
        return body.childrenForFieldName('type')
          .filter((t): t is Node => !!t)
          .map((t, i) => ({ name: String(i), type: squash(t.text) }));
      }
      return [];
    };

    const visitChildren = (n: Node) => {
      for (const c of n.namedChildren) if (c) visit(c);
    };

    /** Methods, associated consts and types of an `impl` or `trait`, hung off its node id. */
    const visitMembers = (container: Node, ownerId: string, kind: 'impl' | 'trait'): ShapeRecord['fields'] => {
      const fields: ShapeRecord['fields'] = [];
      for (const m of container.childForFieldName('body')?.namedChildren ?? []) {
        if (!m) continue;
        const name = m.childForFieldName('name')?.text;
        if ((m.type === 'function_item' || m.type === 'function_signature_item') && name) {
          // Methods are not exported, as in the TypeScript provider: reachability treats an
          // exported symbol nobody references as dead, and method calls resolve by receiver
          // type, which a syntactic pass cannot see.
          const id = uniq(`${ownerId}.${name}`, m);
          push(id, 'method', name, m, false);
          fields.push({ name, type: `fn(${params(m).map((p) => p.type).join(', ')}) -> ${returnType(m)}` });
          if (m.type === 'function_item') {
            recordFunction(m, id, name, 'method', false);
            scope.push(id);
            visitChildren(m);
            scope.pop();
          }
        } else if ((m.type === 'const_item' || m.type === 'associated_type' || m.type === 'type_item') && name) {
          const id = uniq(`${ownerId}.${name}`, m);
          push(id, m.type === 'const_item' ? 'variable' : 'typeAlias', name, m, kind === 'impl' && isPublic(m));
          visitChildren(m);
        } else {
          visit(m);
        }
      }
      return fields;
    };

    const visit = (n: Node): void => {
      switch (n.type) {
        case 'use_declaration': {
          const arg = n.childForFieldName('argument');
          if (arg) expandUse(arg, []);
          return;
        }
        case 'extern_crate_declaration': {
          const name = n.childForFieldName('name')?.text;
          if (!name) return;
          imports.push(name);
          bindings.push({ local: n.childForFieldName('alias')?.text ?? name, imported: '*', spec: name });
          return;
        }
        case 'call_expression': {
          let fn = n.childForFieldName('function');
          if (fn?.type === 'generic_function') fn = fn.childForFieldName('function') ?? fn;
          if (fn) {
            const callee = squash(fn.text);
            const member = fn.type === 'field_expression' ? fn.childForFieldName('field')?.text : undefined;
            const line = lineOf(n);
            calls.push({ from: here(), file: relPath, callee, base: leftmost(fn), member, line });
            recordCallLiterals(n.childForFieldName('arguments'), callee, member, line);
          }
          visitChildren(n);
          return;
        }
        case 'macro_invocation': {
          const mac = n.childForFieldName('macro');
          if (mac) {
            const callee = `${squash(mac.text)}!`;
            const line = lineOf(n);
            calls.push({ from: here(), file: relPath, callee, base: leftmost(mac), member: undefined, line });
            recordCallLiterals(n.namedChildren.find((c) => c?.type === 'token_tree') ?? null, callee, undefined, line);
          }
          return; // A token tree is unparsed tokens; there are no calls in it to find.
        }
        case 'function_item': {
          const name = n.childForFieldName('name')?.text;
          if (!name) break;
          const id = idFor(name, n);
          push(id, 'function', name, n, isPublic(n));
          recordFunction(n, id, name, 'function', isPublic(n));
          scope.push(id);
          visitChildren(n);
          scope.pop();
          return;
        }
        case 'struct_item':
        case 'union_item':
        case 'enum_item': {
          const name = n.childForFieldName('name')?.text;
          if (!name) break;
          const id = idFor(name, n);
          const isEnum = n.type === 'enum_item';
          push(id, isEnum ? 'enum' : 'class', name, n, isPublic(n));
          const body = n.childForFieldName('body');
          const fields = isEnum
            ? (body?.namedChildren ?? [])
              .filter((v): v is Node => !!v && v.type === 'enum_variant')
              .map((v) => ({
                name: v.childForFieldName('name')?.text ?? '(anonymous)',
                type: squash(v.childForFieldName('body')?.text ?? '()'),
              }))
            : shapeFields(body);
          if (fields.length) {
            shapes.push({
              nodeId: id, name, file: relPath, line: lineOf(n), kind: isEnum ? 'typeAlias' : 'class', fields,
            });
          }
          return;
        }
        case 'trait_item': {
          const name = n.childForFieldName('name')?.text;
          if (!name) break;
          const id = idFor(name, n);
          push(id, 'interface', name, n, isPublic(n));
          for (const bound of n.childForFieldName('bounds')?.namedChildren ?? []) {
            const to = typeName(bound);
            if (to) heritage.push({ from: id, to, kind: 'extends' });
          }
          scope.push(id);
          const fields = visitMembers(n, id, 'trait');
          scope.pop();
          if (fields.length) {
            shapes.push({ nodeId: id, name, file: relPath, line: lineOf(n), kind: 'interface', fields });
          }
          return;
        }
        case 'impl_item': {
          const type = n.childForFieldName('type');
          if (!type) break;
          const trait = n.childForFieldName('trait');
          const name = squash(trait ? `impl ${trait.text} for ${type.text}` : `impl ${type.text}`);
          const id = idFor(name, n);
          push(id, 'class', name, n, false);
          const to = typeName(trait);
          if (to) heritage.push({ from: id, to, kind: 'implements' });
          scope.push(id);
          visitMembers(n, id, 'impl');
          scope.pop();
          return;
        }
        case 'const_item':
        case 'static_item':
        case 'type_item':
        case 'macro_definition': {
          const name = n.childForFieldName('name')?.text;
          if (!name) break;
          const kind: NodeKind =
            n.type === 'type_item' ? 'typeAlias' : n.type === 'macro_definition' ? 'function' : 'variable';
          // `macro_rules!` has no `pub`; `#[macro_export]` is what puts it at the crate root.
          const exported = n.type === 'macro_definition'
            ? /#\[\s*macro_export/.test(n.previousNamedSibling?.type === 'attribute_item' ? n.previousNamedSibling.text : '')
            : isPublic(n);
          push(idFor(name, n), kind, name, n, exported);
          if (n.type !== 'macro_definition') visitChildren(n);
          return;
        }
        case 'mod_item': {
          const name = n.childForFieldName('name')?.text;
          if (!name) break;
          push(idFor(name, n), 'variable', name, n, isPublic(n));
          const body = n.childForFieldName('body');
          if (!body) {
            // `mod a { mod b; }` lives at `a/b.rs`, so the inline path is part of the spec.
            const spec = `mod ${[...modPath, name].join('::')}`;
            imports.push(spec);
            // `report::print_total()` calls through the module, like a namespace import.
            if (!modPath.length) bindings.push({ local: name, imported: '*', spec });
            return;
          }
          modPath.push(name);
          visitChildren(body);
          modPath.pop();
          return;
        }
      }
      visitChildren(n);
    };

    visitChildren(root);
    const diagnostics = root.hasError ? syntaxErrors(root) : [];

    return {
      nodes, imports, bindings, heritage, shapes, functions, calls, literals,
      ...(diagnostics.length ? { diagnostics } : {}),
    };
  }
}
