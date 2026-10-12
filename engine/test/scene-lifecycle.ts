/**
 * What a scene change costs. Run: node engine/test/scene-lifecycle.ts
 *
 * The renderer used to be recreated whenever the lens changed, because one effect's
 * dependency list mixed colouring in with layout. The decision is now a pure function, so the
 * property that matters — a colour change never asks for a new WebGL context — can be stated
 * here rather than read off a frame counter.
 */
import {
  planUpdate, REBUILD_INPUTS, RECOLOR_INPUTS, RELAYOUT_INPUTS, type SceneInputs,
} from '../scene/lifecycle.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const stack = { levels: [] };
const base: SceneInputs = {
  repo: '/r/a',
  stack,
  fileEdges: [],
  mode: 'graph',
  lod: 'all',
  expanded: new Set<string>(),
  symbols: {},
  moved: {},
  allLevelsLimit: 0,
  channel: 'structure',
  flagged: new Set<string>(['a.ts']),
  defended: [],
};

section('the three classes partition the inputs');
{
  const all = [...REBUILD_INPUTS, ...RELAYOUT_INPUTS, ...RECOLOR_INPUTS];
  check('every input is classified exactly once',
    new Set(all).size === all.length && all.length === Object.keys(base).length,
    `${all.length} classified, ${Object.keys(base).length} inputs`);
  check('the lens is never a reason to rebuild or relayout',
    !REBUILD_INPUTS.includes('channel') && !RELAYOUT_INPUTS.includes('channel'));
  check('nor is what the lens reads from',
    RECOLOR_INPUTS.includes('flagged') && RECOLOR_INPUTS.includes('defended'));
  check('only the repository rebuilds', REBUILD_INPUTS.length === 1 && REBUILD_INPUTS[0] === 'repo');
}

section('the decision');
{
  check('nothing to compare against means a rebuild', planUpdate(null, base) === 'rebuild');
  check('identical inputs need nothing', planUpdate(base, { ...base }) === 'none');
  check('a channel change recolours', planUpdate(base, { ...base, channel: 'belief' }) === 'recolor');
  check('a new stack relayouts', planUpdate(base, { ...base, stack: { levels: [] } }) === 'relayout');
  check('a repository change rebuilds', planUpdate(base, { ...base, repo: '/r/b' }) === 'rebuild');
  check('a mode switch relayouts, not rebuilds', planUpdate(base, { ...base, mode: 'tree' }) === 'relayout');
  check('a lod switch relayouts', planUpdate(base, { ...base, lod: 'auto' }) === 'relayout');
  check('opening a file relayouts', planUpdate(base, { ...base, expanded: new Set(['a.ts']) }) === 'relayout');
  check('a dragged node relayouts', planUpdate(base, { ...base, moved: { k: [1, 2, 3] } }) === 'relayout');
  check('a new render limit relayouts', planUpdate(base, { ...base, allLevelsLimit: 500 }) === 'relayout');
  check('new defences recolour', planUpdate(base, { ...base, defended: ['x'] }) === 'recolor');

  // Identity, deliberately: the shell hands over a fresh set on every reload, and repainting
  // colours is cheap. What matters is that it never costs a layout.
  check('a flagged set with the same contents but new identity recolours, not relayouts',
    planUpdate(base, { ...base, flagged: new Set(['a.ts']) }) === 'recolor');

  // The most expensive change wins when several arrive together.
  check('channel plus stack is a relayout',
    planUpdate(base, { ...base, channel: 'agent', stack: { levels: [] } }) === 'relayout');
  check('channel plus repo is a rebuild',
    planUpdate(base, { ...base, channel: 'agent', repo: '/r/c' }) === 'rebuild');
}

done();
