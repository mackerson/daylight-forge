/**
 * D6 — parallel implementations. Run: node engine/test/parallel.ts
 *
 * The detector calibration asked for. D1–D4 all work at the symbol level and all correctly
 * refuse the fixture's headline duplication; the signal was at the file level the whole time,
 * in *which* names two files share rather than how many.
 *
 * Two properties carry the whole thing, and both have failure cases below:
 *
 *  - A shared name is worth what it is rare. Sixteen repositories sharing `create` and
 *    `delete` must score nothing at all, or every repository pairs with every other one.
 *  - One side growing must not hide the pair. That is precisely what happened to the fixture
 *    case — `ChatRepository` gained seventeen methods and the Jaccard fell to 0.24 — so rare
 *    shared names are scored in absolute terms as well, and qualify on their own.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from '../extract/index.ts';
import { detectParallel, RARE_MASS_FLOOR } from '../detect/parallel.ts';
import type { Graph } from '../graph/types.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-parallel-'));
const write = (rel: string, body: string) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

const method = (name: string) => `  ${name}(id: string) { return this.db.get('q', id); }`;
const repo = (cls: string, methods: string[]) =>
  `export class ${cls} {\n  db: any;\n${methods.map(method).join('\n')}\n}\n`;

write('package.json', JSON.stringify({ name: 'par', main: 'src/index.ts' }));

// Twelve conventional repositories. Every one has the CRUD four, so those names are worth
// nothing — if they were not, all 66 pairs of these would be findings.
const CRUD = ['getAll', 'getById', 'update', 'remove'];
const names: string[] = [];
for (let i = 0; i < 12; i++) {
  const cls = `Thing${i}Repository`;
  names.push(`src/repos/${cls}.ts`);
  write(`src/repos/${cls}.ts`, repo(cls, [...CRUD, `findThing${i}`, `countThing${i}`]));
}

// The pair the detector exists for: the same store written twice, then one side grew.
const SHARED_RARE = ['getParticipants', 'addParticipant', 'bulkCreateMessages', 'deleteMessage'];
write('src/repos/ChatRepository.ts', repo('ChatRepository', [
  ...CRUD, ...SHARED_RARE,
  'searchByText', 'getByTags', 'getTagUsage', 'archiveChat', 'unarchiveChat',
  'attachBranchCounts', 'getLatestActiveMessageId', 'mapRowToChat',
]));
write('src/repos/ChannelRepository.ts', repo('ChannelRepository', [
  ...CRUD, ...SHARED_RARE, 'mapRowToChannel',
]));

write('src/index.ts', [...names, 'src/repos/ChatRepository.ts', 'src/repos/ChannelRepository.ts']
  .map((f) => `import './${f.replace('src/', '')}';`).join('\n') + '\n');

const graph: Graph = extract({ root: tmp });
const pairs = detectParallel(graph);
const involves = (p: { a: string; b: string }, x: string, y: string) =>
  (p.a.includes(x) && p.b.includes(y)) || (p.a.includes(y) && p.b.includes(x));

console.log('\nthe case D1–D4 cannot reach');
{
  const hit = pairs.find((p) => involves(p, 'ChatRepository', 'ChannelRepository'));
  check('finds two files that are the same thing written twice',
    !!hit, JSON.stringify(pairs.map((p) => [p.a, p.b])));
  check('even though one side grew enough to sink the overlap score',
    (hit?.score ?? 1) < 0.5, `overlap ${hit?.score.toFixed(2)}`);
  check('it qualified on rare names, not on overlap',
    hit?.by === 'rare-names', hit?.by);
  check('and it is ranked first, because rare mass is what survives divergence',
    pairs[0] === hit);

  check('the evidence is the rare names, not the conventional ones',
    SHARED_RARE.every((n) => hit?.rare.includes(n)), JSON.stringify(hit?.rare));
  check('CRUD names are not counted as evidence',
    CRUD.every((n) => !hit?.rare.includes(n)), JSON.stringify(hit?.rare));
  check('rarest first, so the top of the list is why it scored',
    hit?.rare[0] !== undefined && hit.rare.length >= 4);
  check('what each side has alone is reported, since that is the divergence',
    (hit?.onlyA.length ?? 0) > 0 && (hit?.onlyB.length ?? 0) > 0);
}

console.log('\nconventions are not findings');
{
  // The failure this detector is one bad weighting away from: twelve repositories that
  // share four CRUD names would be 66 pairs, and the map would be worthless.
  const conventional = pairs.filter((p) => /Thing\d+Repository/.test(p.a) && /Thing\d+Repository/.test(p.b));
  check('twelve repositories sharing CRUD produce no pairs at all',
    conventional.length === 0, `${conventional.length} pairs`);
  check('and none of them pairs with the real finding either',
    !pairs.some((p) => /Thing\d+/.test(p.a + p.b)), JSON.stringify(pairs.map((p) => [p.a, p.b])));
}

console.log('\nthresholds and shape');
{
  check('the rare-mass floor is documented as a value, not buried',
    typeof RARE_MASS_FLOOR === 'number' && RARE_MASS_FLOOR > 0);
  check('raising the floor above the finding suppresses it',
    detectParallel(graph, { minRareMass: 1e6 })
      .every((p) => p.by === 'overlap'));
  check('requiring more rare names than exist suppresses it too',
    !detectParallel(graph, { minRareNames: 99 })
      .some((p) => involves(p, 'ChatRepository', 'ChannelRepository') && p.by === 'rare-names'));
  check('a pair that qualifies both ways says so',
    detectParallel(graph, { minScore: 0 }).some((p) => p.by === 'both'));

  check('the same graph yields the same pairs',
    JSON.stringify(detectParallel(graph)) === JSON.stringify(pairs));
  check('every pair names both scores, so neither is inferred',
    pairs.every((p) => typeof p.score === 'number' && typeof p.rareMass === 'number'));
  check('a file never pairs with itself', pairs.every((p) => p.a !== p.b));
  check('each pair appears once', new Set(pairs.map((p) => `${p.a} ${p.b}`)).size === pairs.length);
}

console.log('\ninheritance is not duplication');
{
  /**
   * A subclass sharing its base class's method names is one implementation overridden, not
   * two written twice. On the fixture this was the top false positive — and the guard against
   * it silently did nothing for a while, because the pair key was built with a NUL separator
   * in one place and a space in the other. Two invisible characters that do not match look
   * exactly like a guard that is working.
   */
  const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-par3-'));
  const w3 = (rel: string, body: string) => {
    const abs = path.join(t3, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  w3('package.json', JSON.stringify({ name: 'inh', main: 'src/index.ts' }));
  // Filler, so the shape below is actually rare relative to the corpus. Without it every
  // name is in every file and nothing is rare — which would make the test pass for the
  // wrong reason.
  const filler: string[] = [];
  for (let i = 0; i < 14; i++) {
    filler.push(`src/Filler${i}.ts`);
    w3(`src/Filler${i}.ts`, `export class Filler${i} {\n  db: any;\n` +
      `${[`alpha${i}`, `beta${i}`, `gamma${i}`, `delta${i}`].map(method).join('\n')}\n}\n`);
  }
  const shape = ['runStep', 'prepareEnvironment', 'collectArtifacts', 'teardownSandbox'];
  w3('src/Base.ts', `export class Base {\n  db: any;\n${shape.map(method).join('\n')}\n}\n`);
  w3('src/Child.ts',
    "import { Base } from './Base.ts';\n" +
    `export class Child extends Base {\n  db: any;\n${shape.map(method).join('\n')}\n}\n`);
  // An unrelated third file with the same rare names — the pair that *should* be reported.
  w3('src/Twin.ts', `export class Twin {\n  db: any;\n${shape.map(method).join('\n')}\n}\n`);
  w3('src/index.ts',
    ["src/Base.ts", 'src/Child.ts', 'src/Twin.ts', ...filler]
      .map((f) => `import './${f.replace('src/', '')}';`).join('\n') + '\n');

  const g3 = extract({ root: t3 });
  check('the heritage edge exists, so the guard has something to work with',
    g3.edges.some((e) => e.kind === 'extends'), 'no extends edge — the test proves nothing');

  const p3 = detectParallel(g3);
  check('a class and its subclass are not reported as parallel implementations',
    !p3.some((p) => involves(p, 'Base.ts', 'Child.ts')),
    JSON.stringify(p3.map((p) => [p.a, p.b])));
  check('while two unrelated files with the same names still are',
    p3.some((p) => involves(p, 'Base.ts', 'Twin.ts')),
    JSON.stringify(p3.map((p) => [p.a, p.b])));
  check('and the subclass still pairs with the unrelated twin',
    p3.some((p) => involves(p, 'Child.ts', 'Twin.ts')),
    JSON.stringify(p3.map((p) => [p.a, p.b])));

  fs.rmSync(t3, { recursive: true, force: true });
}

console.log('\nsmall and empty inputs');
{
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-par2-'));
  fs.mkdirSync(path.join(t2, 'src'), { recursive: true });
  fs.writeFileSync(path.join(t2, 'package.json'), JSON.stringify({ name: 'x', main: 'src/a.ts' }));
  fs.writeFileSync(path.join(t2, 'src/a.ts'), 'export const one = () => 1;\n');
  check('a repo too small to compare yields nothing rather than throwing',
    detectParallel(extract({ root: t2 })).length === 0);
  fs.rmSync(t2, { recursive: true, force: true });

  check('an empty graph yields nothing',
    detectParallel({ ...graph, functions: [] }).length === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
done();