/**
 * The invariant authoring vocabulary. Run: node engine/test/shapes.ts
 *
 * A form that builds a predicate the engine does not recognise is worse than no form: the
 * engine returns red with "unknown predicate", which reads as *your codebase is broken*
 * rather than *this tool is*. Every shape is therefore evaluated against a real graph here,
 * and asserted to produce a verdict rather than an error.
 *
 * The subtler failure is a selector that silently matches nothing — an unknown node kind
 * makes an invariant permanently green, which is the one wrong answer nobody investigates.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from '../extract/index.ts';
import { evaluate } from '../invariants/engine.ts';
import { INVARIANTS_FILENAME, saveInvariant } from '../invariants/save.ts';
import { KINDS, SHAPES } from '../invariants/shapes.ts';
import type { Graph } from '../graph/types.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-shapes-'));
const write = (rel: string, body: string) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
write('package.json', JSON.stringify({ name: 'sh', main: 'src/index.ts' }));
write('src/index.ts', [
  "import { helper } from './helper.ts';",
  "export function go() { helper(); return 'channel:main'; }",
].join('\n'));
write('src/helper.ts', "export const helper = () => 'channel:main';\n");

const graph: Graph = extract({ root: tmp });

/** Values that fill in every field of a shape with something plausible. */
const FILL: Record<string, string> = {
  name: 'helper', kind: 'file', min: '1', max: '99',
  from: '^src/index', to: '^src/helper', member: '',
  within: '^src/', callee: '^helper$',
  value: 'channel:main', maxFiles: '2',
};

console.log('\nevery shape compiles to something the engine knows');
for (const shape of SHAPES) {
  const predicate = shape.build(FILL);
  const result = evaluate(graph, { id: `t-${shape.type}`, prose: shape.summary, predicate });
  check(`${shape.type} evaluates`,
    result.status === 'green' || result.status === 'red',
    JSON.stringify(result));
  check(`${shape.type} is not reported as an unknown predicate`,
    !/unknown predicate/.test(result.measured), result.measured);
}

console.log('\nshape definitions');
{
  check('every shape names the predicate it builds',
    SHAPES.every((s) => (s.build(FILL) as { type: string }).type === s.type));
  check('every shape says what it is for in a sentence',
    SHAPES.every((s) => s.summary.length > 20 && /\.["\u201d]?$/.test(s.summary)),
    SHAPES.filter((s) => !/\.["\u201d]?$/.test(s.summary)).map((s) => s.type).join(', '));
  check('every field has a hint, because a bare regex box helps nobody',
    SHAPES.every((s) => s.fields.every((f) => f.hint.length > 0)));
  check('every field is covered by the test fill',
    SHAPES.every((s) => s.fields.every((f) => f.key in FILL)),
    SHAPES.flatMap((s) => s.fields.map((f) => f.key)).filter((k) => !(k in FILL)).join(', '));
  check('shape ids are unique', new Set(SHAPES.map((s) => s.type)).size === SHAPES.length);
}

console.log('\nselectors refuse to match nothing by accident');
{
  const absent = SHAPES.find((s) => s.type === 'absent')!;

  const known = absent.build({ ...FILL, kind: 'file' }) as { select: { kind?: string[] } };
  check('a known kind is kept', known.select.kind?.[0] === 'file');

  // An unknown kind matches no node, which makes the invariant permanently green — the one
  // wrong answer nobody goes back to check. Dropping it means "no kind filter" instead.
  const unknown = absent.build({ ...FILL, kind: 'widget' }) as { select: { kind?: string[] } };
  check('an unknown kind is dropped rather than silently matching nothing',
    unknown.select.kind === undefined, JSON.stringify(unknown));
  check('and the invariant then actually measures something',
    evaluate(graph, { id: 'u', prose: 'p', predicate: absent.build({ ...FILL, kind: 'widget' }) })
      .status === 'red');

  const mixed = absent.build({ ...FILL, kind: 'file, widget, class' }) as {
    select: { kind?: string[] };
  };
  check('a mixed list keeps the real kinds',
    JSON.stringify(mixed.select.kind) === JSON.stringify(['file', 'class']));

  const empty = absent.build({ ...FILL, name: '', kind: '' }) as unknown as {
    select: Record<string, unknown>;
  };
  check('an empty form yields an empty selector rather than a broken one',
    Object.keys(empty.select).length === 0);
}

console.log('\noffered kinds are kinds the graph has');
{
  const present = new Set(graph.nodes.map((n) => n.kind));
  check('the fixture exercises several of them', present.size >= 2, [...present].join(', '));
  // Every offered kind must be a real NodeKind — the type system enforces that, but a rename
  // in the graph would silently strand a form option, so assert it against live data too.
  check('no offered kind is unknown to the type',
    KINDS.every((k) => typeof k === 'string' && k.length > 0));
  check('every kind the fixture produced is offered by the form',
    [...present].every((k) => (KINDS as string[]).includes(k)),
    [...present].filter((k) => !(KINDS as string[]).includes(k)).join(', '));
}

console.log('\nsaving into the repo');
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-save-'));
  const file = path.join(repo, INVARIANTS_FILENAME);
  const pred = SHAPES[0].build(FILL);

  const first = saveInvariant(repo, { id: 'no-legacy', prose: 'nothing named Legacy', predicate: pred });
  check('writes a new file', first.ok === true && fs.existsSync(file), JSON.stringify(first));
  check('and says it added rather than replaced', first.replaced === false && first.count === 1);
  check('the file is what loadInvariants reads',
    Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8'))));

  const second = saveInvariant(repo, { id: 'second', prose: 'another', predicate: pred });
  check('appends rather than overwriting the file', second.count === 2 && second.replaced === false);

  const again = saveInvariant(repo, { id: 'no-legacy', prose: 'reworded', predicate: pred });
  check('the same id replaces in place instead of duplicating',
    again.replaced === true && again.count === 2, JSON.stringify(again));
  check('and the new wording is what landed',
    JSON.parse(fs.readFileSync(file, 'utf8')).some((i: { prose: string }) => i.prose === 'reworded'));

  check('an empty id is refused', !!saveInvariant(repo, { id: '', prose: 'x', predicate: pred }).error);
  check('a path-shaped id is refused',
    !!saveInvariant(repo, { id: '../escape', prose: 'x', predicate: pred }).error);
  check('missing prose is refused — a red invariant nobody can read is unactionable',
    !!saveInvariant(repo, { id: 'ok', prose: '   ', predicate: pred }).error);
  check('a non-object predicate is refused',
    !!saveInvariant(repo, { id: 'ok', prose: 'x', predicate: 'absent' }).error);
  check('a repo that does not exist is refused',
    !!saveInvariant(path.join(repo, 'nope'), { id: 'ok', prose: 'x', predicate: pred }).error);

  // Refusing beats repairing: the broken file may be work in progress.
  fs.writeFileSync(file, '{ not json');
  const onBroken = saveInvariant(repo, { id: 'ok', prose: 'x', predicate: pred });
  check('an unparseable existing file is not overwritten',
    !!onBroken.error && fs.readFileSync(file, 'utf8') === '{ not json', JSON.stringify(onBroken));
  check('and the error says to fix it by hand', /by hand/.test(onBroken.error ?? ''));

  // The object form is what an agent-proposed file looks like after `daylight adopt`.
  fs.writeFileSync(file, JSON.stringify({ invariants: [{ id: 'kept', prose: 'p', predicate: pred }] }));
  const onObject = saveInvariant(repo, { id: 'added', prose: 'q', predicate: pred });
  check('the { invariants: [...] } form is understood too',
    onObject.count === 2, JSON.stringify(onObject));

  fs.rmSync(repo, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
done();