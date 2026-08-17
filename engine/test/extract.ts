/**
 * Extraction, resolution and the invariant engine. Run: node engine/test/extract.ts
 *
 * These three had no direct tests and shipped two real bugs because of it: a hand-rolled
 * tsconfig comment-stripper that ate the `/*` inside `"@/*"` and silently disabled every
 * path alias (2773 missing edges, 127 live components reported dead), and a parser that
 * recorded `CallExpression` but not `NewExpression`, hiding every instantiation in every
 * codebase. Both have a regression case below, named for what they were.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from '../extract/index.ts';
import { aliasesFromTsconfig, Resolver } from '../extract/resolve.ts';
import { evaluate } from '../invariants/engine.ts';
import type { Graph } from '../graph/types.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-extract-'));
const write = (rel: string, body: string) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

console.log('\ntsconfig path aliases');
{
  // The exact shape that broke: `/*` inside a path pattern reads as a comment opener to
  // any regex-based stripper, which then eats the rest of the block.
  const raw = `{
  "compilerOptions": {
    // a line comment, which is legal here
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/renderer/*"],
      "@shared/*": ["./src/shared/*"]
    }
  }
}`;
  const aliases = aliasesFromTsconfig(raw);
  check('parses paths containing /* — the bug that cost 2773 edges',
    aliases.length === 2, JSON.stringify(aliases));
  check('maps the prefix to its target',
    aliases[0]?.prefix === '@/' && aliases[0]?.targets[0] === 'src/renderer');

  check('survives a block comment', aliasesFromTsconfig(
    '{ /* leading */ "compilerOptions": { "paths": { "@/*": ["./a/*"] } } }').length === 1);
  check('survives trailing commas', aliasesFromTsconfig(
    '{ "compilerOptions": { "paths": { "@/*": ["./a/*"], }, }, }').length === 1);
  check('malformed json yields no aliases rather than throwing',
    aliasesFromTsconfig('{ not json').length === 0);
  check('no paths key yields none', aliasesFromTsconfig('{"compilerOptions":{}}').length === 0);

  const r = new Resolver(
    ['src/renderer/App.tsx', 'src/shared/types.ts', 'src/lib/index.ts', 'src/util.ts'],
    aliases,
  );
  check('resolves through an alias', r.resolve('@/App', 'src/main.ts') === 'src/renderer/App.tsx');
  check('resolves a second alias', r.resolve('@shared/types', 'src/main.ts') === 'src/shared/types.ts');
  check('resolves a relative import', r.resolve('./util', 'src/main.ts') === 'src/util.ts');
  check('resolves a directory to its index', r.resolve('./lib', 'src/main.ts') === 'src/lib/index.ts');
  // ESM-style `./x.js` routinely means `./x.ts` in a TypeScript source tree.
  check('resolves a .js specifier to its .ts source',
    r.resolve('./util.js', 'src/main.ts') === 'src/util.ts');
  check('leaves a package external', r.resolve('react', 'src/main.ts') === null);
  check('leaves an unknown alias target external', r.resolve('@/Nope', 'src/main.ts') === null);
}

console.log('\nextraction');
{
  write('package.json', JSON.stringify({ name: 'fx', main: 'src/index.ts' }));
  write('tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./src/*"]}}}');
  write('src/index.ts', [
    "import { helper } from './helper.ts';",
    "import { Thing } from '@/thing.ts';",
    "import './styles.css';",
    "import react from 'react';",
    'export function go() {',
    '  helper();',
    '  return new Thing("hello");',
    '}',
  ].join('\n'));
  write('src/helper.ts', 'export const helper = () => 1;\n');
  write('src/thing.ts', 'export class Thing { constructor(public name: string) {} }\n');
  write('src/styles.css', '.a { color: red }\n');
  // Large single-line file: a vendored bundle by shape rather than by name.
  write('src/vendor.js', 'var x=1;'.repeat(30000));

  const cacheDir = path.join(tmp, '.cache');
  const g: Graph = extract({ root: tmp, cacheDir });

  const files = g.nodes.filter((n) => n.kind === 'file').map((n) => n.id).sort();
  check('finds the source files', files.includes('src/index.ts') && files.includes('src/thing.ts'));
  check('skips a vendored bundle', !files.includes('src/vendor.js') && g.stats.vendoredSkipped === 1);
  check('counts assets separately from failures',
    g.stats.assetImports === 1 && g.stats.unresolvedImports === 0);
  check('marks a package external',
    g.edges.some((e) => e.external && e.spec === 'react'));

  const imports = g.edges.filter((e) => e.kind === 'imports' && !e.external);
  check('resolves a relative import to an edge',
    imports.some((e) => e.from === 'src/index.ts' && e.to === 'src/helper.ts'));
  check('resolves an aliased import to an edge',
    imports.some((e) => e.from === 'src/index.ts' && e.to === 'src/thing.ts'));

  // The second regression: `new Thing()` is a call site and used to be invisible.
  check('records a new-expression as a call — the bug that hid every instantiation',
    g.calls.some((c) => c.callee === 'Thing' && c.file === 'src/index.ts'));
  check('records a plain call too', g.calls.some((c) => c.callee === 'helper'));
  check('captures string literals passed to calls',
    g.literals.some((l) => l.value === 'hello'));

  check('attributes a call to its enclosing symbol',
    g.calls.some((c) => c.from === 'src/index.ts#go' && c.callee === 'helper'));

  // Cache is content-addressed, so an untouched tree re-parses nothing.
  const again = extract({ root: tmp, cacheDir });
  check('cold run parses everything', g.stats.parsedFiles > 0 && g.stats.reusedFiles === 0);
  check('warm run reuses the cache',
    again.stats.reusedFiles === g.stats.parsedFiles && again.stats.parsedFiles === 0,
    `parsed ${again.stats.parsedFiles}, reused ${again.stats.reusedFiles}`);
  check('warm run produces the same graph',
    again.edges.length === g.edges.length && again.nodes.length === g.nodes.length);

  write('src/helper.ts', 'export const helper = () => 2;\n');
  const changed = extract({ root: tmp, cacheDir });
  check('a changed file re-parses only itself',
    changed.stats.parsedFiles === 1, `parsed ${changed.stats.parsedFiles}`);
}

console.log('\ninvariant engine');
{
  const g: Graph = extract({ root: tmp });
  const run = (predicate: unknown) =>
    evaluate(g, { id: 't', prose: 'p', predicate: predicate as never });

  check('absent passes when nothing matches',
    run({ type: 'absent', select: { kind: ['file'], name: '^nope\\.ts$' } }).status === 'green');
  check('absent fails when something matches',
    run({ type: 'absent', select: { kind: ['file'], name: '^helper\\.ts$' } }).status === 'red');
  check('count enforces a range',
    run({ type: 'count', select: { kind: ['file'], name: '\\.ts$' }, min: 1, max: 2 }).status === 'red');
  check('forbidden-call catches a real edge',
    run({ type: 'forbidden-call', from: { file: 'index' }, to: { file: 'helper' } }).status === 'red');
  check('forbidden-callee catches a call',
    run({ type: 'forbidden-callee', within: { file: '^src/' }, callee: '^helper$' }).status === 'red');
  check('required-callee passes when present',
    run({ type: 'required-callee', within: { file: '^src/' }, callee: '^helper$', min: 1 }).status === 'green');
  check('required-callee fails when absent',
    run({ type: 'required-callee', within: { file: '^src/' }, callee: '^nothing$', min: 1 }).status === 'red');
  check('literal-fanin counts uses',
    run({ type: 'literal-fanin', value: 'hello', maxFiles: 1 }).status === 'green');

  // Invariants can be agent-proposed, so malformed input is expected rather than exceptional.
  const bad = run({ type: 'nonsense' });
  check('an unknown predicate fails loudly instead of returning undefined',
    bad?.status === 'red' && /unknown predicate/.test(bad.measured));
  check('a missing predicate does not throw', run(undefined)?.status === 'red');
  check('it says the invariant is at fault, not the code',
    /invariant itself is malformed/.test(run(null)?.violations[0]?.detail ?? ''));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
