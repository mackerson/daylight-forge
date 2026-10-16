/**
 * Mission Control's pure helpers. Run: node app/renderer/lib/screens/mission-words.test.mjs
 *
 * The renderer is drawn by Electron, but what it draws from is decided by small functions
 * that need no window. These are the ones where a wrong shape crashes a screen rather than
 * showing a wrong number. Plain JS so the renderer's DOM-only tsconfig does not have to know
 * about node, and outside engine/ because the engine may not import the app.
 */
import { mergeMissionUpdate } from './mission-words.ts';
import { harness } from '../../../../engine/test/harness.ts';

const { check, section, done } = harness();

/** @returns {import('../types.ts').Mission} */
const mission = (id, over = {}) => ({
  id, projectId: 'git:aaaaaaaaaaaa', kind: 'verify', objective: 'is the cache wrong', baseRevision: 'abc123',
  scope: { paths: ['src'] }, permissions: { read: true, write: false, execute: true, deploy: false },
  budget: {}, requirementIds: [], acceptanceGateIds: [], state: 'running', taskIds: ['t_1', 't_2'],
  createdAt: 1, updatedAt: 2, ...over,
});

section('a partial mission update from a running job');
{
  // `mission run` pushes {id, state, outcomeReason, note} on every state change; the list
  // rows read objective, kind, baseRevision and taskIds, which the push does not carry.
  const list = { project: null, missions: [mission('m_1'), mission('m_2')] };
  const merged = mergeMissionUpdate(list, { id: 'm_1', state: 'blocked', outcomeReason: 'exit 1', note: 'mock:crash failed' });
  const row = merged.missions.find((m) => m.id === 'm_1');
  check('the pushed fields land on the row', row?.state === 'blocked' && row.outcomeReason === 'exit 1');
  check('and every field the list renders is still there',
    row?.objective === 'is the cache wrong' && row.kind === 'verify' && row.baseRevision === 'abc123' && row.taskIds.length === 2,
    JSON.stringify(row));
  check('the progress note is not mistaken for a mission field', !!row && !('note' in row));
  check('the other mission is untouched', merged.missions.find((m) => m.id === 'm_2')?.state === 'running');
  check('a null reason clears it rather than storing null',
    mergeMissionUpdate(merged, { id: 'm_1', state: 'running', outcomeReason: null }).missions.find((m) => m.id === 'm_1')?.outcomeReason === undefined);
  const unknown = mergeMissionUpdate(list, { id: 'm_9', state: 'running', outcomeReason: null });
  check('an update for a mission not in the list adds no half-mission', unknown.missions.length === 2 && !unknown.missions.some((m) => m.id === 'm_9'));
}

done();
