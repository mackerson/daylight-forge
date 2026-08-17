import ts from 'typescript';
import type { FunctionRecord, GraphNode, LiteralRecord, NodeKind, ShapeRecord } from '../graph/types.ts';
import type { CallSite, ImportBinding, ParsedFile, Parser } from './parser.ts';

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

/** Collapse whitespace so `{ a: string }` and `{\n  a: string\n}` compare equal. */
function normalizeType(node: ts.Node | undefined, sf: ts.SourceFile): string {
  if (!node) return 'any';
  return node.getText(sf).replace(/\s+/g, ' ').trim();
}

function nameOf(node: ts.Node | undefined, sf: ts.SourceFile): string {
  if (!node) return '(anonymous)';
  return node.getText(sf).replace(/\s+/g, ' ').trim();
}

function isExported(decl: ts.Declaration): boolean {
  return (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) !== 0;
}

const SIGNATURE_WIDTH = 12;
const SHINGLE = 5;
/** Bodies shorter than this are boilerplate — a one-line arrow is not copy-paste. */
const MIN_BODY_TOKENS = 24;

/**
 * A function whose whole body is one literal is *data*, not logic.
 *
 * Erasing identifiers and literals is what lets D4 see through a rename, but it also makes
 * every declarative table look alike — on the fixture it matched four sibling menu
 * definitions at 1.00, which share a shape only because they are all lists of the same kind
 * of entry. Nothing is deduplicated by learning that.
 */
function isDataLiteral(body: ts.Node): boolean {
  const literal = (n: ts.Node) =>
    ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n);
  if (literal(body)) return true;
  if (!ts.isBlock(body)) return false;
  const only = body.statements.length === 1 ? body.statements[0] : undefined;
  return !!only && ts.isReturnStatement(only) && !!only.expression && literal(only.expression);
}

/**
 * A structural fingerprint of a function body.
 *
 * Identifiers, literals and comments are erased, leaving only the *shape* of the code —
 * so a copy that renamed its variables still matches, which is the case that matters and
 * the one a textual diff misses. Shingles of consecutive tokens preserve ordering, and
 * MinHash reduces the set to a fixed-width signature that can be compared by counting
 * equal positions.
 */
function bodySignature(node: ts.Node, sf: ts.SourceFile): { sig: number[]; tokens: number } | null {
  if (isDataLiteral(node)) return null;

  /**
   * Every node's kind, in traversal order, with identifiers and literals flattened to a
   * placeholder.
   *
   * The first version emitted a token only for identifiers, literals and childless nodes,
   * which sounds like a token stream and is not one: `forEachChild` skips punctuation, so a
   * perfectly ordinary two-statement method produced fewer than the twenty-four tokens
   * required to earn a signature and got none at all. Recording the kind of *every* node
   * captures the shape — `IfStatement`, `BinaryExpression`, `CallExpression` — which is what
   * structural similarity is supposed to compare in the first place.
   */
  const tokens: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) tokens.push('id');
    else if (ts.isStringLiteralLike(n)) tokens.push('str');
    else if (ts.isNumericLiteral(n)) tokens.push('num');
    else tokens.push(ts.SyntaxKind[n.kind]);
    n.forEachChild(walk);
  };
  node.forEachChild(walk);
  if (tokens.length < MIN_BODY_TOKENS) return null;

  const hash = (s: string, seed: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0);
    return h >>> 0;
  };

  const sig = new Array<number>(SIGNATURE_WIDTH).fill(0xffffffff);
  for (let i = 0; i + SHINGLE <= tokens.length; i++) {
    const shingle = tokens.slice(i, i + SHINGLE).join(',');
    for (let k = 0; k < SIGNATURE_WIDTH; k++) {
      const h = hash(shingle, k * 2654435761);
      if (h < sig[k]) sig[k] = h;
    }
  }
  return { sig, tokens: tokens.length };
}

/** Leftmost identifier of `a.b.c()` → `a`. Used to match callees against imports. */
function leftmost(expr: ts.Expression): string | undefined {
  let cur: ts.Node = expr;
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) ? cur.text : undefined;
}

export class TypeScriptParser implements Parser {
  name = 'typescript-compiler-api';
  extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

  parse(relPath: string, source: string, contentHash: string): ParsedFile {
    const ext = relPath.slice(relPath.lastIndexOf('.'));
    const sf = ts.createSourceFile(
      relPath,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      SCRIPT_KINDS[ext] ?? ts.ScriptKind.TS,
    );

    const nodes: GraphNode[] = [];
    const imports: string[] = [];
    const bindings: ImportBinding[] = [];
    const heritage: ParsedFile['heritage'] = [];
    const shapes: ShapeRecord[] = [];
    const functions: FunctionRecord[] = [];
    const calls: CallSite[] = [];
    const literals: LiteralRecord[] = [];

    const lineOf = (n: ts.Node): number =>
      sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const endLineOf = (n: ts.Node): number =>
      sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;

    /** Enclosing-symbol stack, so call sites attribute to a symbol not just a file. */
    const scope: string[] = [relPath];
    const here = () => scope[scope.length - 1];

    const push = (id: string, kind: NodeKind, name: string, n: ts.Node, exported: boolean) => {
      nodes.push({
        id, kind, name, file: relPath,
        line: lineOf(n), endLine: endLineOf(n), exported, contentHash,
      });
    };

    const params = (ps: readonly ts.ParameterDeclaration[]) =>
      ps.map((p) => ({ name: nameOf(p.name, sf), type: normalizeType(p.type, sf) }));

    const recordImport = (spec: string, node: ts.ImportDeclaration | ts.ExportDeclaration) => {
      imports.push(spec);
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      if (!clause) return;
      if (clause.name) bindings.push({ local: clause.name.text, imported: 'default', spec });
      const nb = clause.namedBindings;
      if (!nb) return;
      if (ts.isNamespaceImport(nb)) {
        bindings.push({ local: nb.name.text, imported: '*', spec });
      } else {
        for (const el of nb.elements) {
          bindings.push({
            local: el.name.text,
            imported: el.propertyName?.text ?? el.name.text,
            spec,
          });
        }
      }
    };

    const visit = (node: ts.Node): void => {
      let pushedScope = false;

      // ---- imports -------------------------------------------------------------
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const spec = node.moduleSpecifier;
        if (spec && ts.isStringLiteral(spec)) recordImport(spec.text, node);
      } else if (ts.isImportEqualsDeclaration(node)) {
        const ref = node.moduleReference;
        if (ts.isExternalModuleReference(ref) && ref.expression && ts.isStringLiteral(ref.expression)) {
          imports.push(ref.expression.text);
        }
      } else if (ts.isNewExpression(node)) {
        // `new Foo()` is a call site. Recording only CallExpression missed every
        // instantiation — including `throw new EvidenceRequired(...)`, which meant an
        // invariant asserting that guard exists could not see it.
        const callee = nameOf(node.expression, sf);
        const line = lineOf(node);
        calls.push({
          from: here(), file: relPath, callee,
          base: leftmost(node.expression),
          member: undefined, line,
        });
        for (const arg of node.arguments ?? []) {
          if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            literals.push({ from: here(), file: relPath, callee, value: arg.text, line });
          }
        }
      } else if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const arg0 = node.arguments[0];
        if ((isDynamicImport || isRequire) && arg0 && ts.isStringLiteral(arg0)) {
          imports.push(arg0.text);
        } else {
          // A regular call: record the site, and any string literals it carries.
          const callee = nameOf(node.expression, sf);
          const member = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : undefined;
          const line = lineOf(node);
          calls.push({ from: here(), file: relPath, callee, base: leftmost(node.expression), member, line });

          for (const arg of node.arguments) {
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
              literals.push({ from: here(), file: relPath, callee, member, value: arg.text, line });
            }
          }
        }
      }

      // ---- declarations --------------------------------------------------------
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const id = `${relPath}#${name}`;
        push(id, 'function', name, node, isExported(node));
        const fnBody = node.body ? bodySignature(node.body, sf) : null;
        functions.push({
          nodeId: id, name, file: relPath, line: lineOf(node), kind: 'function', endLine: endLineOf(node),
          params: params(node.parameters), returnType: normalizeType(node.type, sf),
          exported: isExported(node),
          ...(fnBody ? { body: fnBody.sig, bodyTokens: fnBody.tokens } : {}),
        });
        scope.push(id);
        pushedScope = true;
      } else if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const id = `${relPath}#${name}`;
        push(id, 'class', name, node, isExported(node));

        for (const clause of node.heritageClauses ?? []) {
          const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
          for (const t of clause.types) heritage.push({ from: id, to: nameOf(t.expression, sf), kind });
        }

        const fields: ShapeRecord['fields'] = [];
        for (const m of node.members) {
          if (ts.isPropertyDeclaration(m) && m.name) {
            fields.push({ name: nameOf(m.name, sf), type: normalizeType(m.type, sf) });
          } else if (ts.isMethodDeclaration(m) && m.name) {
            const mName = nameOf(m.name, sf);
            const mId = `${id}.${mName}`;
            push(mId, 'method', mName, m, false);
            const mBody = m.body ? bodySignature(m.body, sf) : null;
            functions.push({
              nodeId: mId, name: mName, file: relPath, line: lineOf(m), kind: 'method', endLine: endLineOf(m),
              params: params(m.parameters), returnType: normalizeType(m.type, sf), exported: false,
              ...(mBody ? { body: mBody.sig, bodyTokens: mBody.tokens } : {}),
            });
            // Walk the method body under its own scope, then skip it below.
            scope.push(mId);
            ts.forEachChild(m, visit);
            scope.pop();
          }
        }
        if (fields.length) {
          shapes.push({ nodeId: id, name, file: relPath, line: lineOf(node), kind: 'class', fields });
        }

        // Members already walked (methods with scope, others plainly).
        for (const m of node.members) if (!ts.isMethodDeclaration(m)) ts.forEachChild(m, visit);
        return;
      } else if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        const id = `${relPath}#${name}`;
        push(id, 'interface', name, node, isExported(node));
        for (const clause of node.heritageClauses ?? []) {
          for (const t of clause.types) {
            heritage.push({ from: id, to: nameOf(t.expression, sf), kind: 'extends' });
          }
        }
        const fields = node.members
          .filter(ts.isPropertySignature)
          .map((m) => ({ name: nameOf(m.name, sf), type: normalizeType(m.type, sf) }));
        if (fields.length) {
          shapes.push({ nodeId: id, name, file: relPath, line: lineOf(node), kind: 'interface', fields });
        }
      } else if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        const id = `${relPath}#${name}`;
        push(id, 'typeAlias', name, node, isExported(node));
        if (ts.isTypeLiteralNode(node.type)) {
          const fields = node.type.members
            .filter(ts.isPropertySignature)
            .map((m) => ({ name: nameOf(m.name, sf), type: normalizeType(m.type, sf) }));
          if (fields.length) {
            shapes.push({ nodeId: id, name, file: relPath, line: lineOf(node), kind: 'typeAlias', fields });
          }
        }
      } else if (ts.isEnumDeclaration(node)) {
        const name = node.name.text;
        push(`${relPath}#${name}`, 'enum', name, node, isExported(node));
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const name = node.name.text;
        const id = `${relPath}#${name}`;
        const init = node.initializer;
        const isCallable = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        push(id, isCallable ? 'function' : 'variable', name, node, isExported(node));
        if (isCallable) {
          const arrowBody = init.body ? bodySignature(init.body, sf) : null;
          functions.push({
            nodeId: id, name, file: relPath, line: lineOf(node), kind: 'arrow', endLine: endLineOf(node),
            params: params(init.parameters), returnType: normalizeType(init.type, sf),
            exported: isExported(node),
            ...(arrowBody ? { body: arrowBody.sig, bodyTokens: arrowBody.tokens } : {}),
          });
          scope.push(id);
          pushedScope = true;
        }
      }

      ts.forEachChild(node, visit);
      if (pushedScope) scope.pop();
    };

    ts.forEachChild(sf, visit);

    return { nodes, imports, bindings, heritage, shapes, functions, calls, literals };
  }
}
