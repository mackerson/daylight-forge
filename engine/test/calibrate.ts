/**
 * Calibration scoring. Run: node engine/test/calibrate.ts
 *
 * The sweep decides which thresholds we ship, so the thing that decides "better" needs to be
 * right. Its first version was not: it scored every pair any detector touched and reported
 * that all 100 settings found the known duplication. That was true, and it measured nothing —
 * D2 links the pair by method name and no swept threshold touches D2. A measurement that
 * cannot move is worse than no measurement, because it reads as a passing result.
 *
 * So the case that matters here is the negative one: a link that exists but is never
 * *reported* must score as missed.
 */
import { extract } from '../extract/index.ts';
import { detectDuplication } from '../detect/duplication.ts';
import { DEFAULT_SWEEP, grid, matches, reported } from '../tools/calibrate-sweep.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness } from './harness.ts';

const { check, done } = harness();

console.log('\nsweep grid');
{
  const g = grid({ a: [1, 2], b: [10, 20, 30] });
  check('covers every combination', g.length === 6, JSON.stringify(g));
  check('each combination is complete',
    g.every((o) => 'a' in o && 'b' in o));
  check('the order is stable',
    JSON.stringify(grid({ a: [1, 2], b: [10, 20, 30] })) === JSON.stringify(g));
  check('axis order does not depend on key insertion order',
    JSON.stringify(grid({ b: [10, 20, 30], a: [1, 2] })) === JSON.stringify(g));
  check('an empty sweep still yields the default setting',
    grid({}).length === 1 && Object.keys(grid({})[0]).length === 0);
  check('the shipped sweep covers every threshold that has one',
    Object.keys(DEFAULT_SWEEP).length === 3);
}

console.log('\nknown-pair matching');
{
  const families = [
    ['src/a/ChatRepository.ts#x', 'src/a/ChannelRepository.ts#y'],
    ['src/b/Lonely.ts#z'],
  ];
  check('finds a pair split across one family',
    matches(families, 'ChatRepository~ChannelRepository'));
  check('order within the spec does not matter',
    matches(families, 'ChannelRepository~ChatRepository'));
  check('a pair in two different families is not found',
    !matches([['src/a/ChatRepository.ts#x'], ['src/a/ChannelRepository.ts#y']],
      'ChatRepository~ChannelRepository'));
  check('a substring that matches nothing is not found',
    !matches(families, 'Nope~ChannelRepository'));
  // The bug this file exists for: one symbol satisfying both sides is not a pair.
  check('one member cannot satisfy both sides of a pair',
    !matches([['src/a/ChatRepositoryChannelRepository.ts#x']],
      'ChatRepository~ChannelRepository'),
    'a single symbol matched both substrings and scored as a found pair');
}

console.log('\nwhat gets scored');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-cal-'));
  const write = (rel: string, body: string) => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  write('package.json', JSON.stringify({ name: 'cal', main: 'src/index.ts' }));
  write('src/index.ts', "import './x.ts';\nimport './y.ts';\n");
  // Same method *names* in two files, but different parameter types — so D2 links them and
  // D3 does not corroborate. Under the qualification rule that is deliberately not a family,
  // and the sweep must score it as missed rather than found.
  write('src/x.ts', `export class Alpha {
  db: any;
  getById(id: string) { return this.db.get('select 1', id); }
  remove(id: string) { this.db.run('delete', id); }
}\n`);
  write('src/y.ts', `export class Beta {
  db: any;
  getById(id: number) { return this.db.get('select 2', id); }
  remove(key: number) { this.db.run('drop', key); }
}\n`);

  const graph = extract({ root: tmp });
  const raw = detectDuplication(graph);
  const families = reported(graph, {});

  check('the detectors do link the two files',
    raw.d2.some((g) => g.members.some((m) => m.includes('x.ts')) &&
      g.members.some((m) => m.includes('y.ts'))),
    JSON.stringify(raw.d2));
  check('but a D2-only link is not reported as a family',
    !matches(families, 'x.ts~y.ts'),
    JSON.stringify(families));
  check('so the sweep scores it missed rather than found — the bug that made this measurable',
    !matches(reported(graph, { minNameScore: 0.4 }), 'x.ts~y.ts'));

  check('reported() returns families, not pairs',
    families.every((m) => Array.isArray(m)));
  check('the same graph and options score the same way',
    JSON.stringify(reported(graph, {})) === JSON.stringify(families));

  fs.rmSync(tmp, { recursive: true, force: true });
}

done();