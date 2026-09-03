/**
 * Lens filters and candidate derivation. Run: node engine/test/lens.ts
 *
 * Two invariants worth holding. A filtered map must not keep an edge to a node it no longer
 * has, or the scene draws a rope tied to nothing; and "31 of 112 shown" must be a count of
 * what is actually drawn, because a caption that disagrees with the picture is worse than no
 * caption.
 *
 * The candidate half exists because the interface shipped a sentence that was not true: the
 * structural detector reports dead files and dead exported symbols in one list, and grouping
 * them together produced "nothing imports these 30 · 9 files, 0 importers" about a directory
 * whose files were all imported. The symbols were unused, not the files.
 */
import { candidates, flaggedFiles } from '../detect/candidates.ts';
import type { DuplicationReport } from '../detect/duplication.ts';
import type { StructureReport } from '../detect/structure-types.ts';
import { applyFilters, availableFilters } from '../focus/filter.ts';
import type { Filter } from '../focus/filter.ts';
import type { FocusNode, FocusStack } from '../focus/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const node = (id: string, over: Partial<FocusNode> = {}): FocusNode => ({
  id,
  label: id,
  members: [`${id}/a.ts`],
  fileCount: 1,
  symbolCount: 1,
  origin: 'path',
  ...over,
});

const stackOf = (nodes: FocusNode[], edges: Array<[string, string]>): FocusStack => ({
  l0: { files: nodes.length, symbols: nodes.length, edges: edges.length },
  levels: [{
    level: 1,
    name: 'L1',
    nodes,
    edges: edges.map(([from, to]) => ({ from, to, weight: 1, kinds: ['import'] })),
    elided: [],
    rejected: [],
  }],
  l3Status: 'UNPROVEN',
});

const belief = (over: Partial<NonNullable<FocusNode['belief']>> = {}) => ({
  status: 'INFERRED' as const, known: 1, claims: 1, contradictions: 0, heat: 0, agents: [], ...over,
});

const NONE: ReadonlySet<string> = new Set();

section('filtering the stack');
{
  const stack = stackOf(
    [
      node('a', { belief: belief({ status: 'CONTRADICTED' }) }),
      node('b', { belief: belief() }),
      node('c'),
    ],
    [['a', 'b'], ['b', 'c']],
  );

  const all = applyFilters(stack, [], NONE);
  check('no filters leaves the stack alone', all.stack === stack && all.shown === 3);

  const contested = applyFilters(stack, [{ kind: 'contested' }], NONE);
  check('contested keeps only the disputed node', contested.shown === 1, String(contested.shown));
  check('and the total still counts the whole map', contested.total === 3);
  check('no edge survives to a node that was removed',
    contested.stack!.levels[0].edges.length === 0,
    JSON.stringify(contested.stack!.levels[0].edges));

  const unexamined = applyFilters(stack, [{ kind: 'unexamined' }], NONE);
  check('unexamined finds the node with no belief at all', unexamined.shown === 1);

  // The count is the contract: it is printed next to the picture.
  check('shown equals the nodes actually left',
    contested.stack!.levels[0].nodes.length === contested.shown);
}

section('filters stack, and an empty result is refused');
{
  const stack = stackOf(
    [
      node('a', { belief: belief({ status: 'CONTRADICTED', agents: ['claude:opus'] }) }),
      node('b', { belief: belief({ status: 'CONTRADICTED', agents: ['codex:default'] }) }),
    ],
    [],
  );

  const both: Filter[] = [{ kind: 'contested' }, { kind: 'source', value: 'claude:opus' }];
  const narrowed = applyFilters(stack, both, NONE);
  check('two filters narrow further than one', narrowed.shown === 1, String(narrowed.shown));

  const impossible: Filter[] = [{ kind: 'contested' }, { kind: 'source', value: 'nobody' }];
  const empty = applyFilters(stack, impossible, NONE);
  check('a set matching nothing is not applied', empty.empty === true);
  check('and the map is left whole rather than blanked', empty.shown === empty.total);
}

section('only filters that would leave something are offered');
{
  const stack = stackOf([node('a', { belief: belief({ agents: ['claude:opus'] }) })], []);
  const offered = availableFilters(stack, NONE);
  const kinds = offered.map((f) => f.kind);
  check('contested is not offered when nothing is contested', !kinds.includes('contested'));
  check('flagged is not offered when nothing is flagged', !kinds.includes('flagged'));
  check('a source that has worked here is offered',
    offered.some((f) => f.kind === 'source' && f.value === 'claude:opus'));
  check('an empty stack offers nothing', availableFilters(null, NONE).length === 0);
}

section('dead files and unused exports are different questions');
{
  const structure = {
    entrypoints: [], dead: [
      { kind: 'file', id: 'engine/orphan.ts', tier: 'high', why: 'no importers' },
      { kind: 'symbol', id: 'engine/live.ts#Helper', tier: 'medium', why: 'exported, never imported' },
      { kind: 'symbol', id: 'engine/live.ts#Other', tier: 'low', why: 'exported, never imported' },
    ],
    cycles: [], limbs: [], gods: [], divergences: [], orphans: [],
    stats: { reachable: 1, unreachable: 1, files: 2 },
  } as unknown as StructureReport;
  const findings = { d1: [], d2: [], d3: [], d4: [], patterns: [], families: [] } as DuplicationReport;

  const list = candidates(findings, structure);
  const dead = list.filter((c) => c.kind === 'unreachable');
  const unused = list.filter((c) => c.kind === 'unused-export');

  check('a dead file makes one unreachable row', dead.length === 1);
  check('and it counts files, not symbols', dead[0].measure === '1 file, 0 importers', dead[0].measure);
  check('dead exports do not become "dead files"',
    !dead.some((c) => c.subjects.some((s) => s.includes('#'))));

  check('unused exports get their own row', unused.length === 1);
  check('which counts exports, not files',
    unused[0].measure.startsWith('2 exports'), unused[0].measure);
  check('and asks a different question',
    /surface someone is meant to use/.test(unused[0].question), unused[0].question);

  // The map colouring is the reason the scope field exists.
  const flagged = flaggedFiles(list);
  check('a genuinely dead file colours the map', flagged.has('engine/orphan.ts'));
  check('a live file with an unused export does not', !flagged.has('engine/live.ts'),
    [...flagged].join(','));

  check('both still reach an agent under the same predicate',
    dead[0].predicate === 'liveness_verdict' && unused[0].predicate === 'liveness_verdict');
  check('and every subject is preserved for the run',
    unused[0].subjects.length === 2, unused[0].subjects.join(','));
}

done();
