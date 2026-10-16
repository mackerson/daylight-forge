/**
 * Structural findings. Run: node engine/test/structure.ts
 *
 * Every dead-code claim here is a candidate with a tier and a stated caveat, because a
 * confident wrong finding is worse than none — it is the one that gets acted on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from '../extract/index.ts';
import { detectStructure } from '../detect/structure.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-structure-'));
const write = (rel: string, body: string) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

write('package.json', JSON.stringify({ name: 'fx', main: 'src/index.ts' }));
write('src/index.ts', "import './a.ts';\nimport './cycleA.ts';\n");
write('src/a.ts', "export const a = 1;\n");
write('src/orphan.ts', "export const orphan = 1;\n");
write('src/plugin.ts', "export const plugin = 1;\n");
// Named in a string, which is how registries load things — must cap the tier.
write('src/registry.ts', "export const names = ['plugin'];\n");
write('src/cycleA.ts', "import './cycleB.ts';\nexport const A = 1;\n");
write('src/cycleB.ts', "import './cycleA.ts';\nexport const B = 1;\n");
// A file wired almost entirely to another directory.
write('src/stray.ts', "import '../far/one.ts';\nimport '../far/two.ts';\nimport '../far/three.ts';\nimport '../far/four.ts';\n");
write('far/one.ts', 'export const one = 1;\n');
write('far/two.ts', 'export const two = 1;\n');
write('far/three.ts', 'export const three = 1;\n');
write('far/four.ts', 'export const four = 1;\n');

const graph = extract({ root: tmp });
const st = detectStructure(graph);

console.log('\nreachability');
{
  check('finds the declared entrypoint', st.entrypoints.includes('src/index.ts'));
  check('reaches what the entrypoint imports', st.stats.reachable >= 4, String(st.stats.reachable));
  check('flags an unimported file', st.dead.some((d) => d.id === 'src/orphan.ts'));

  const plugin = st.dead.find((d) => d.id === 'src/plugin.ts');
  check('a file named in a string is capped, not confidently dead',
    plugin?.tier !== 'high', plugin?.tier);
  check('and says why it was capped', /string literal|dynamic/i.test(plugin?.why ?? ''));

  const orphan = st.dead.find((d) => d.id === 'src/orphan.ts');
  check('every candidate carries its caveat', !!orphan?.why && orphan.why.length > 20);
}

console.log('\ncycles and shape');
{
  const cyc = st.cycles.find((c) => c.members.some((m) => m.includes('cycleA')));
  check('detects an import cycle', !!cyc && cyc.members.length === 2);
  check('counts the edges inside it', (cyc?.internalEdges ?? 0) >= 2);

  const div = st.divergences.find((d) => d.file === 'src/stray.ts');
  check('detects a file filed apart from what it is wired to', !!div, JSON.stringify(st.divergences));
  check('names where it actually belongs', div?.pull === 'far');
  check('and how lopsided it is', (div?.share ?? 0) >= 0.66);

  check('gods carry churn when history exists, and omit it when not',
    st.gods.every((g) => g.churn === undefined || typeof g.pain === 'number'));
}

console.log('\ncoverage guard');
{
  // Half the tree unreachable almost always means missing entrypoints, not a dead half.
  write('package.json', JSON.stringify({ name: 'fx' }));
  for (let i = 0; i < 12; i++) write(`lib/mod${i}.ts`, `export const m${i} = ${i};\n`);
  const g2 = extract({ root: tmp });
  const s2 = detectStructure(g2);
  check('warns when reachability is too low to trust', !!s2.warning, s2.warning);
  check('and caps every candidate to medium rather than claiming high confidence',
    s2.dead.every((d) => d.tier !== 'high'));
  check('the cap says it is a cap', s2.dead.some((d) => /capped/.test(d.why)));
}

console.log('\ntest reachability');
{
  /**
   * The bug this is here for: excluding tests from the map also excluded them from
   * reachability, so on the fixture all 11 high-tier dead candidates were live code whose
   * only visible callers sat in files the walk had refused to open. High tier is the one
   * people act on without checking, which makes a false one the most expensive kind.
   */
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-tests-'));
  const w2 = (rel: string, body: string) => {
    const abs = path.join(t2, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  w2('package.json', JSON.stringify({ name: 'fx', main: 'src/index.ts' }));
  w2('src/index.ts', "import { used } from './used.ts';\nexport const go = () => used();\n");
  w2('src/used.ts', 'export const used = () => 1;\n');
  w2('src/tested.ts', 'export const tested = () => 2;\n');
  w2('src/nobody.ts', 'export const nobody = () => 3;\n');
  w2('src/tested.test.ts', "import { tested } from './tested.ts';\ntested();\n");

  const g3 = extract({ root: t2 });
  const s3 = detectStructure(g3);
  const dead = new Map(s3.dead.filter((d) => d.kind === 'file').map((d) => [d.id, d]));

  check('the test file itself stays out of the map',
    !g3.nodes.some((n) => n.id.includes('.test.')), 'a test file became a node');
  check('but what it imports is recorded',
    g3.testImports.some((t) => t.to === 'src/tested.ts'), JSON.stringify(g3.testImports));

  check('a file only the tests use is not called confidently dead',
    dead.get('src/tested.ts')?.tier === 'low', JSON.stringify(dead.get('src/tested.ts')));
  check('and it says why the tier is capped',
    /tests import it/.test(dead.get('src/tested.ts')?.why ?? ''));
  check('it is still reported, because test-only code is a real finding',
    dead.has('src/tested.ts'));

  // Not `high`: this tree is small enough that the coverage guard caps everything, which is
  // its job. What matters is that the test-only file ranks strictly below the unused one.
  check('a file genuinely nobody uses outranks one the tests use',
    dead.get('src/nobody.ts')?.tier === 'medium' && dead.get('src/tested.ts')?.tier === 'low',
    JSON.stringify([dead.get('src/nobody.ts')?.tier, dead.get('src/tested.ts')?.tier]));
  check('a reachable file is not a candidate at all', !dead.has('src/used.ts'));

  // Test edges must not leak into the graph proper: they would satisfy forbidden-call
  // invariants, join communities, and draw edges in the tree.
  check('test imports are not ordinary edges',
    !g3.edges.some((e) => e.from.includes('.test.') || e.to.includes('.test.')));

  fs.rmSync(t2, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
done();