/**
 * D4 — duplicated function bodies. Run: node engine/test/duplication.ts
 *
 * D2 and D3 read the outside of a function: its name, its signature. D4 is the only
 * detector that reads the inside, which makes it the only one that can catch the case
 * everyone actually means by "copy-paste" — a body moved to a second file and renamed.
 *
 * That power is also its failure mode. Erasing identifiers and literals is what lets a copy
 * survive a rename, but it also makes every declarative table look alike; the fixture run
 * that motivated `isDataLiteral` matched four sibling menu definitions at 1.00. Both
 * properties have a case below.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from '../extract/index.ts';
import { buildFamilies, detectD4 } from '../detect/duplication.ts';
import type { Graph } from '../graph/types.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-dup-'));
const write = (rel: string, body: string) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

/** Long enough to clear the token floor; the point is the shape, not the arithmetic. */
const BODY = (a: string, b: string, c: string) => `{
  const ${a} = [];
  for (const item of ${b}) {
    if (item.kind === 'x') { ${a}.push(item.value * 2); continue; }
    if (item.kind === 'y') { ${a}.push(item.value + 1); continue; }
    ${a}.push(0);
  }
  const ${c} = ${a}.filter((v) => v > 0);
  if (!${c}.length) return { total: 0, values: [] };
  return { total: ${c}.length, values: ${c} };
}`;

write('package.json', JSON.stringify({ name: 'dup', main: 'src/index.ts' }));
write('src/index.ts', [
  "import './a.ts';",
  "import './b.ts';",
  "import './c.ts';",
  "import './menus.ts';",
  "import './tiny.ts';",
].join('\n'));

// a and b are the same body with every name changed — the case D4 exists for.
write('src/a.ts', `export function summarise(input: unknown[]) ${BODY('out', 'input', 'kept')}\n`);
write('src/b.ts', `export function collect(rows: unknown[]) ${BODY('acc', 'rows', 'live')}\n`);
// c does structurally different work while sharing names and shape at a glance.
write('src/c.ts', `export function summarise(input: unknown[]) {
  const out = new Map();
  while (input.length) {
    const item = input.pop();
    out.set(item, (out.get(item) ?? 0) + 1);
  }
  return [...out.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10);
}\n`);
// The regression: sibling data tables are structurally identical and mean nothing alike.
write('src/menus.ts', `export const editMenu = () => [
  { id: 'undo', label: 'Undo', accel: 'Ctrl+Z', role: 'undo' },
  { id: 'redo', label: 'Redo', accel: 'Ctrl+Y', role: 'redo' },
  { id: 'cut', label: 'Cut', accel: 'Ctrl+X', role: 'cut' },
];
export const goMenu = () => [
  { id: 'back', label: 'Back', accel: 'Alt+Left', role: 'back' },
  { id: 'fwd', label: 'Forward', accel: 'Alt+Right', role: 'forward' },
  { id: 'home', label: 'Home', accel: 'Alt+Home', role: 'home' },
];\n`);
// Two identical one-liners: identical, and far too short to mean anything.
write('src/tiny.ts', `export const first = (xs: number[]) => xs[0];
export const head = (ys: number[]) => ys[0];\n`);

const graph: Graph = extract({ root: tmp });

console.log('\nD4 body similarity');
{
  const pairs = detectD4(graph.functions);
  const has = (a: string, b: string) =>
    pairs.some((p) => (p.a.includes(a) && p.b.includes(b)) || (p.a.includes(b) && p.b.includes(a)));

  check('finds a body copied and renamed — the case D2 and D3 cannot see',
    has('a.ts#summarise', 'b.ts#collect'), JSON.stringify(pairs.map((p) => [p.a, p.b])));
  check('the match scores at or near identical',
    (pairs.find((p) => p.a.includes('#summarise') && p.b.includes('#collect'))
      ?? pairs.find((p) => p.b.includes('#summarise') && p.a.includes('#collect')))!.score >= 0.85);
  check('reports how much code the finding is about',
    pairs.every((p) => p.tokens >= 40));

  check('does not match a body that does different work',
    !has('a.ts#summarise', 'c.ts#summarise'));
  check('a shared name alone does not make a body pair',
    !pairs.some((p) => p.sameName && p.a.includes('c.ts')));

  // The two `summarise` functions share a name; D4 says whether the bodies agree too.
  check('flags when a pair also shares a name, so D2 overlap is visible',
    pairs.every((p) => p.sameName === (p.a.split('#')[1] === p.b.split('#')[1])));

  check('ignores sibling data tables — the fixture false positive that cost 6 pairs',
    !has('menus.ts#editMenu', 'menus.ts#goMenu'));
  check('ignores bodies too short to mean anything',
    !has('tiny.ts#first', 'tiny.ts#head'));

  check('same graph yields the same pairs',
    JSON.stringify(detectD4(graph.functions)) === JSON.stringify(pairs));

  const strict = detectD4(graph.functions, { minBodyScore: 1.01 });
  check('the threshold is honoured', strict.length === 0);
  const floored = detectD4(graph.functions, { minBodyTokens: 10_000 });
  check('the token floor is honoured', floored.length === 0);
}

console.log('\nsignatures');
{
  const named = new Map(graph.functions.map((f) => [f.nodeId, f]));
  const a = [...named.values()].find((f) => f.nodeId.includes('a.ts#summarise'))!;
  const menu = [...named.values()].find((f) => f.nodeId.includes('menus.ts#editMenu'))!;
  const tiny = [...named.values()].find((f) => f.nodeId.includes('tiny.ts#first'))!;

  check('a substantial body carries a fixed-width signature',
    Array.isArray(a.body) && a.body.length === 12, JSON.stringify(a.body));
  check('the signature is a fingerprint, not the source', (a.bodyTokens ?? 0) > a.body!.length);
  check('a data literal carries none', menu.body === undefined);
  check('a trivial body carries none', tiny.body === undefined);
}

console.log('\nfamilies');
{
  const d4 = detectD4(graph.functions);
  const families = buildFamilies([], [], [], d4);
  check('a body match alone forms a family — it is the most specific evidence we have',
    families.length === 1 && families[0].members.length === 2, JSON.stringify(families));
  check('the family names D4 as its detector', families[0]?.detectors.join('') === 'D4');
  check('and says what the score was',
    /^D4 body [01]\.\d\d token-shingle Jaccard$/.test(families[0]?.evidence[0] ?? ''),
    families[0]?.evidence.join(' | '));

  check('no D4 links means no D4 families', buildFamilies([], [], [], []).length === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
done();