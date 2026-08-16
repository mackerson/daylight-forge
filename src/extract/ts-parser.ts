import ts from 'typescript';
import type { FunctionRecord, GraphNode, NodeKind, ShapeRecord } from '../graph/types.ts';
import type { CallSite, ImportBinding, LiteralUse, ParsedFile, Parser } from './parser.ts';

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
    const literals: LiteralUse[] = [];

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
          calls.push({ from: here(), callee, base: leftmost(node.expression), member, line });

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
        functions.push({
          nodeId: id, name, file: relPath, line: lineOf(node), kind: 'function',
          params: params(node.parameters), returnType: normalizeType(node.type, sf),
          exported: isExported(node),
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
            functions.push({
              nodeId: mId, name: mName, file: relPath, line: lineOf(m), kind: 'method',
              params: params(m.parameters), returnType: normalizeType(m.type, sf), exported: false,
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
          functions.push({
            nodeId: id, name, file: relPath, line: lineOf(node), kind: 'arrow',
            params: params(init.parameters), returnType: normalizeType(init.type, sf),
            exported: isExported(node),
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
