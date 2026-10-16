/**
 * The mission store. Run: node engine/test/mission-store.ts
 *
 * Two properties carry the weight. A state the design never drew cannot be reached, and
 * nothing a runner does — least of all exiting 0 — ever closes a mission on its own. Both
 * are what make "the mission succeeded" a claim a person made rather than one a process
 * implied.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../mission/artifacts.ts';
import { inScope } from '../mission/disputes.ts';
import { IllegalTransition, MissionStore } from '../mission/store.ts';
import type { ProjectIdentity } from '../mission/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-mission-store-'));

const PROJECT: ProjectIdentity = { id: 'git:aaaaaaaaaaaa', root: '/repo/a', name: 'a' };
const OTHER: ProjectIdentity = { id: 'git:bbbbbbbbbbbb', root: '/repo/b', name: 'b' };

/** A clock that advances by a tick per read, so updated_at is observable. */
const clock = () => {
  let t = 1_000_000;
  return () => (t += 1);
};

const throws = (fn: () => unknown): Error | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};

section('ids and creation');
{
  const store = new MissionStore(path.join(tmp, 'ids'), clock());
  store.ensureProject(PROJECT);
  const m = store.createMission({
    projectId: PROJECT.id, kind: 'explore', objective: 'what does the cache do',
    baseRevision: 'abc123',
  });
  check('a mission id is prefixed and dashless', /^m_[0-9a-f]{32}$/.test(m.id), m.id);
  check('a mission starts in draft', m.state === 'draft');
  check('permissions default to read-only', m.permissions.read && !m.permissions.write
    && !m.permissions.execute && !m.permissions.deploy);
  check('no outcome until closed', m.outcome === undefined);
  check('the base revision is kept verbatim', m.baseRevision === 'abc123');

  const t = store.createTask({ missionId: m.id, role: 'review', objective: 'review it', runnerHint: 'claude:sonnet' });
  check('a task id is prefixed', /^t_[0-9a-f]{32}$/.test(t.id), t.id);
  check('a task inherits the project of its mission', t.projectId === PROJECT.id);
  check('a task starts queued', t.state === 'queued');
  check('the mission lists it', store.mission(m.id)!.taskIds.join() === t.id);

  check('creating a mission for an unknown project is refused',
    !!throws(() => store.createMission({ projectId: 'git:nope', kind: 'explore', objective: 'x', baseRevision: 'r' })));
  store.close();
}

section('transitions');
{
  const store = new MissionStore(path.join(tmp, 'transitions'), clock());
  store.ensureProject(PROJECT);
  const m = store.createMission({ projectId: PROJECT.id, kind: 'verify', objective: 'o', baseRevision: 'r' });

  const skip = throws(() => store.transitionMission(m.id, 'running'));
  check('draft cannot skip to running', skip instanceof IllegalTransition);
  check('and the error names both states', !!skip && /draft/.test(skip.message) && /running/.test(skip.message), skip?.message);
  check('and names the mission', !!skip && skip.message.includes(m.id));
  check('the mission is unchanged after a refused transition', store.mission(m.id)!.state === 'draft');

  const before = store.mission(m.id)!.updatedAt;
  const ready = store.transitionMission(m.id, 'ready');
  check('draft → ready is allowed', ready.state === 'ready');
  check('and bumps updated_at', ready.updatedAt > before);
  check('ready → running', store.transitionMission(m.id, 'running').state === 'running');
  const blocked = store.transitionMission(m.id, 'blocked', 'an attempt timed out');
  check('running → blocked keeps the reason where a person will read it',
    blocked.state === 'blocked' && blocked.outcomeReason === 'an attempt timed out');
  const resumed = store.transitionMission(m.id, 'running');
  check('blocked → running clears the block reason', resumed.state === 'running' && resumed.outcomeReason === undefined);

  check('transitionMission refuses to close — closing needs an outcome',
    !!throws(() => store.transitionMission(m.id, 'closed')));
  check('closing without a reason is refused',
    !!throws(() => store.closeMission(m.id, 'succeeded', '   ')));
  check('and the mission is still running', store.mission(m.id)!.state === 'running');

  const closed = store.closeMission(m.id, 'inconclusive', 'the experiment timed out twice');
  check('closeMission records state, outcome and reason',
    closed.state === 'closed' && closed.outcome === 'inconclusive'
      && closed.outcomeReason === 'the experiment timed out twice');
  check('and when', typeof closed.closedAt === 'number' && closed.closedAt === closed.updatedAt);
  const reopen = throws(() => store.transitionMission(m.id, 'running'));
  check('closed is terminal', reopen instanceof IllegalTransition);

  const t = store.createTask({ missionId: m.id, role: 'custom', objective: 'x' });
  const bad = throws(() => store.transitionTask(t.id, 'done'));
  check('a task cannot jump from queued to done', bad instanceof IllegalTransition && /queued/.test(bad.message) && /done/.test(bad.message));
  store.transitionTask(t.id, 'leased');
  store.transitionTask(t.id, 'running');
  store.transitionTask(t.id, 'failed');
  check('a failed task can be requeued', store.transitionTask(t.id, 'queued').state === 'queued');
  store.close();
}

section('an exit code is not an outcome');
{
  const store = new MissionStore(path.join(tmp, 'exit'), clock());
  store.ensureProject(PROJECT);
  const m = store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'o', baseRevision: 'r' });
  store.transitionMission(m.id, 'ready');
  store.transitionMission(m.id, 'running');
  const t = store.createTask({ missionId: m.id, role: 'review', objective: 'review' });

  const a = store.startAttempt({ taskId: t.id, runnerId: 'agent:mock:default', sessionId: `${m.id}:s1` });
  check('an attempt id is prefixed', /^a_[0-9a-f]{32}$/.test(a.id), a.id);
  check('starting an attempt runs its task', store.task(t.id)!.state === 'running');
  check('an attempt starts with unknown cost, not zero', a.costUsd === null);
  check('the task lists the attempt', store.task(t.id)!.attemptIds.join() === a.id);

  const finished = store.finishAttempt(a.id, { state: 'completed', exitCode: 0, costUsd: 0.42, costSource: 'provider' });
  check('the attempt is completed', finished.state === 'completed' && finished.exitCode === 0);
  check('and has a finish time', typeof finished.finishedAt === 'number');
  check('its task is done', store.task(t.id)!.state === 'done');
  check('the mission is still running — exit 0 closed nothing',
    store.mission(m.id)!.state === 'running' && store.mission(m.id)!.outcome === undefined);

  const again = throws(() => store.finishAttempt(a.id, { state: 'failed', costUsd: null }));
  check('a completed attempt cannot be finished again', again instanceof IllegalTransition);

  // A second task, where the attempt fails: the task follows, the mission still does not.
  const t2 = store.createTask({ missionId: m.id, role: 'experiment', objective: 'run it' });
  const a2 = store.startAttempt({ taskId: t2.id, runnerId: 'runner:experiment' });
  const failed = store.finishAttempt(a2.id, {
    state: 'failed', exitCode: null, signal: 'SIGTERM', timedOut: true, costUsd: null, failure: 'timed out',
  });
  check('a timed-out attempt records that it timed out', failed.timedOut === true && failed.failure === 'timed out');
  check('its task is failed', store.task(t2.id)!.state === 'failed');
  check('the mission is still running — a failure closed nothing either', store.mission(m.id)!.state === 'running');

  // A retry is a new attempt on the same task; the first one stays on the record.
  store.transitionTask(t2.id, 'queued');
  const a3 = store.startAttempt({ taskId: t2.id, runnerId: 'runner:experiment' });
  check('a retry is a second attempt on the same task', store.attempts(t2.id).length === 2 && a3.id !== a2.id);
  check('and the failed attempt is still there', store.attempt(a2.id)!.state === 'failed');
  store.close();
}

section('a task runs one attempt at a time');
{
  const store = new MissionStore(path.join(tmp, 'one-attempt'), clock());
  store.ensureProject(PROJECT);
  const m = store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'o', baseRevision: 'r' });
  const t = store.createTask({ missionId: m.id, role: 'review', objective: 'review' });
  const a1 = store.startAttempt({ taskId: t.id, runnerId: 'agent:mock:a', sessionId: `${m.id}:${t.id}:a1` });
  const second = throws(() => store.startAttempt({ taskId: t.id, runnerId: 'agent:mock:a', sessionId: `${m.id}:${t.id}:a2` }));
  check('a second attempt on a task with one running is refused', second instanceof IllegalTransition, second?.message);
  check('and names the attempt still running', !!second && second.message.includes(a1.id), second?.message);
  check('the task still has just the one attempt', store.attempts(t.id).length === 1);

  const cancelled = store.cancelRunningAttempts(m.id, 'orphaned: owning process gone');
  check('a mission\'s running attempts can be cancelled with a reason', cancelled.length === 1
    && store.attempt(a1.id)!.state === 'cancelled' && store.attempt(a1.id)!.failure === 'orphaned: owning process gone');
  check('which fails the task so it can be retried', store.task(t.id)!.state === 'failed');
  check('and leaves nothing running', store.cancelRunningAttempts(m.id, 'x').length === 0);
  store.close();
}

section('finishing an attempt is all or nothing');
{
  const store = new MissionStore(path.join(tmp, 'atomic'), clock());
  store.ensureProject(PROJECT);
  const m = store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'o', baseRevision: 'r' });
  const t = store.createTask({ missionId: m.id, role: 'review', objective: 'review' });
  const a = store.startAttempt({ taskId: t.id, runnerId: 'agent:mock:a' });
  // An artifact row the schema refuses, part-way through the finish.
  const bad = { id: 'sha256:bad', kind: 'log', digest: 'sha256:bad', projectId: null } as unknown as Parameters<MissionStore['recordArtifact']>[0];
  const err = throws(() => store.finishAttempt(a.id, { state: 'completed', exitCode: 0, costUsd: 0.1, costSource: 'provider', artifacts: [bad] }));
  check('a finish that fails part-way throws', !!err);
  check('and leaves the attempt as it was', store.attempt(a.id)!.state === 'running' && store.attempt(a.id)!.costUsd === null,
    store.attempt(a.id)!.state);
  check('with its task still running, not half-moved', store.task(t.id)!.state === 'running');
  check('so it can still be finished properly', store.finishAttempt(a.id, { state: 'completed', exitCode: 0, costUsd: 0.1, costSource: 'provider' }).state === 'completed'
    && store.task(t.id)!.state === 'done');
  store.close();
}

section('scope paths are normalised when a mission is created');
{
  const store = new MissionStore(path.join(tmp, 'scope'), clock());
  store.ensureProject(PROJECT);
  const m = store.createMission({
    projectId: PROJECT.id, kind: 'explore', objective: 'o', baseRevision: 'r',
    scope: { paths: ['src/', './lib', 'a//b/', 'docs'] },
  });
  check('trailing slashes, ./ and doubled slashes are dropped', m.scope.paths?.join() === 'src,lib,a/b,docs', m.scope.paths?.join());
  check('and read back the same', store.mission(m.id)!.scope.paths?.join() === 'src,lib,a/b,docs');
  check('so `src/` scopes src/a.ts', inScope('src/a.ts', m.scope) && inScope('lib/x/y.ts#f', m.scope) && !inScope('srcx/a.ts', m.scope));
  store.close();
}

section('cost: null is unknown, 0 is zero');
{
  const store = new MissionStore(path.join(tmp, 'cost'), clock());
  store.ensureProject(PROJECT);
  const m = store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'o', baseRevision: 'r' });
  const t1 = store.createTask({ missionId: m.id, role: 'review', objective: 'a' });
  const t2 = store.createTask({ missionId: m.id, role: 'review', objective: 'b' });
  const a1 = store.startAttempt({ taskId: t1.id, runnerId: 'agent:mock:x' });
  const a2 = store.startAttempt({ taskId: t2.id, runnerId: 'agent:mock:y' });
  store.finishAttempt(a1.id, { state: 'completed', exitCode: 0, costUsd: null });
  store.finishAttempt(a2.id, { state: 'completed', exitCode: 0, costUsd: 0, costSource: 'provider' });
  check('a runner that reported nothing reads back as null', store.attempt(a1.id)!.costUsd === null);
  check('a runner that reported zero reads back as zero', store.attempt(a2.id)!.costUsd === 0);
  check('and the two are distinguishable', store.attempt(a1.id)!.costUsd !== store.attempt(a2.id)!.costUsd);
  store.close();
}

section('dependencies and readiness');
{
  const store = new MissionStore(path.join(tmp, 'deps'), clock());
  store.ensureProject(PROJECT);
  const m = store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'o', baseRevision: 'r' });
  const review1 = store.createTask({ missionId: m.id, role: 'review', objective: 'a', runnerHint: 'claude:sonnet' });
  const review2 = store.createTask({ missionId: m.id, role: 'review', objective: 'b', runnerHint: 'codex:default' });
  const compare = store.createTask({ missionId: m.id, role: 'compare', objective: 'c', dependsOn: [review1.id, review2.id] });

  const ready = () => store.readyTasks(m.id).map((t) => t.id).sort().join();
  check('the two reviews are ready at once', ready() === [review1.id, review2.id].sort().join());
  check('compare waits on both', !store.readyTasks(m.id).some((t) => t.id === compare.id));

  const a1 = store.startAttempt({ taskId: review1.id, runnerId: 'agent:mock:a' });
  check('a running task is no longer ready', ready() === review2.id);
  store.finishAttempt(a1.id, { state: 'completed', exitCode: 0, costUsd: null });
  check('one review done is not enough', ready() === review2.id);
  const a2 = store.startAttempt({ taskId: review2.id, runnerId: 'agent:mock:b' });
  store.finishAttempt(a2.id, { state: 'completed', exitCode: 0, costUsd: null });
  check('both done makes compare ready', ready() === compare.id);

  check('a dependency on a task outside the mission is refused',
    !!throws(() => store.createTask({ missionId: m.id, role: 'custom', objective: 'x', dependsOn: ['t_nope'] })));
  store.close();
}

section('sessions and artifacts');
{
  const dir = path.join(tmp, 'sessions');
  const store = new MissionStore(dir, clock());
  const blobs = new ArtifactStore(dir);
  store.ensureProject(PROJECT);
  const m = store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'o', baseRevision: 'r' });
  const t = store.createTask({ missionId: m.id, role: 'review', objective: 'a' });
  const session = `${m.id}:${'a_fake'}`;
  const a = store.startAttempt({ taskId: t.id, runnerId: 'agent:mock:a', sessionId: session, worktree: '/tmp/wt' });
  check('an attempt is found by its session', store.attemptBySession(session)?.id === a.id);
  check('an unknown session finds nothing', store.attemptBySession('nope') === null);
  check('the worktree is kept', store.attempt(a.id)!.worktree === '/tmp/wt');

  const log = blobs.put('stdout line\n', { kind: 'log', projectId: PROJECT.id, label: 'stdout' });
  store.finishAttempt(a.id, { state: 'completed', exitCode: 0, costUsd: 0.1, costSource: 'provider', artifacts: [log] });
  check('finishing with artifacts attaches them to the attempt',
    store.attempt(a.id)!.artifacts.length === 1 && store.attempt(a.id)!.artifacts[0].digest === log.digest);
  check('and records them in the artifact table', store.artifact(log.id)?.kind === 'log');
  store.recordArtifact(log);
  check('recording the same artifact twice is one row', store.artifact(log.id)?.label === 'stdout');
  check('an unknown artifact is null', store.artifact('sha256:' + '0'.repeat(64)) === null);
  store.close();
}

section('experiments and decisions');
{
  const dir = path.join(tmp, 'experiments');
  const store = new MissionStore(dir, clock());
  const blobs = new ArtifactStore(dir);
  store.ensureProject(PROJECT);
  const m = store.createMission({ projectId: PROJECT.id, kind: 'verify', objective: 'o', baseRevision: 'r' });
  const test = blobs.put('test content', { kind: 'test', projectId: PROJECT.id, path: 'test/x.test.js' });
  const expected = blobs.put('{"exitCode":1}', { kind: 'expected', projectId: PROJECT.id });
  const x = store.createExperiment({
    missionId: m.id, projectId: PROJECT.id, claimIds: [7], subject: 'src/cache.ts', predicate: 'bug_verdict',
    hypothesis: 'get() serves expired entries', prediction: { exitCode: 1 }, baseRevision: 'r',
    testArtifact: test, expectedArtifact: expected, harnessDigest: 'sha256:h', command: ['node', 'test/x.test.js'],
    sandboxProfile: 'bwrap', limitations: [],
  });
  check('an experiment id is prefixed', /^x_[0-9a-f]{32}$/.test(x.id), x.id);
  check('it starts pending with no executions', x.conclusion === 'pending' && x.executions.length === 0);
  check('its test and expected artifacts are recorded', store.artifact(test.id)?.kind === 'test' && store.artifact(expected.id)?.kind === 'expected');
  const run = blobs.put('{"exitCode":1}', { kind: 'result', projectId: PROJECT.id });
  const updated = store.updateExperiment(x.id, { executions: [run], conclusion: 'supported', limitations: ['one machine'] });
  check('an update lands executions, conclusion and limitations',
    updated.executions.length === 1 && updated.conclusion === 'supported' && updated.limitations[0] === 'one machine');
  check('and reads back the same', store.experiments(m.id)[0].conclusion === 'supported');
  check('the prediction round-trips', store.experiment(x.id)!.prediction.exitCode === 1);
  check('an experiment for the wrong project is refused',
    !!throws(() => store.createExperiment({ ...x, projectId: OTHER.id } as never)));

  const d = store.recordDecision({
    missionId: m.id, projectId: PROJECT.id, revision: 'r', actor: 'human:miz', kind: 'adjudicate',
    subject: 'src/cache.ts', predicate: 'bug_verdict', value: true, rationale: 'the experiment reproduced it',
    scope: { experimentId: x.id }, artifactIds: [run.id],
  });
  check('a decision id is prefixed', /^d_[0-9a-f]{32}$/.test(d.id), d.id);
  check('a decision reads back with its value and scope',
    store.decisions(m.id)[0].value === true && store.decisions(m.id)[0].scope.experimentId === x.id);
  check('a decision without a rationale is refused',
    !!throws(() => store.recordDecision({ ...d, rationale: '' })));
  const noValue = store.recordDecision({
    missionId: m.id, projectId: PROJECT.id, revision: 'r', actor: 'human:miz', kind: 'defer',
    rationale: 'need more runs', scope: {}, artifactIds: [],
  });
  check('a decision with no value reads back as undefined, not null-as-string',
    store.decisions(m.id).find((q) => q.id === noValue.id)!.value === undefined);
  store.close();
}

section('restart');
{
  const dir = path.join(tmp, 'restart');
  const first = new MissionStore(dir, clock());
  first.ensureProject(PROJECT);
  const m = first.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'survive', baseRevision: 'r', scope: { paths: ['src/'] } });
  first.transitionMission(m.id, 'ready');
  first.transitionMission(m.id, 'running');
  const t = first.createTask({ missionId: m.id, role: 'review', objective: 'a', runnerHint: 'claude:opus' });
  const a = first.startAttempt({ taskId: t.id, runnerId: 'agent:mock', sessionId: 's' });
  first.finishAttempt(a.id, { state: 'completed', exitCode: 0, costUsd: null });
  const snapshot = {
    mission: first.mission(m.id), tasks: first.tasks(m.id), attempts: first.attempts(t.id),
  };
  first.close();

  const second = new MissionStore(dir, clock());
  check('the mission comes back identical, timestamps included',
    JSON.stringify(second.mission(m.id)) === JSON.stringify(snapshot.mission));
  check('so do its tasks', JSON.stringify(second.tasks(m.id)) === JSON.stringify(snapshot.tasks));
  check('and its attempts', JSON.stringify(second.attempts(t.id)) === JSON.stringify(snapshot.attempts));
  check('the project is still known', second.project(PROJECT.id)?.root === PROJECT.root);
  check('and the mission is still running, not quietly closed by a restart', second.mission(m.id)!.state === 'running');
  second.close();
}

section('two output directories do not see each other');
{
  const a = new MissionStore(path.join(tmp, 'iso-a'), clock());
  const b = new MissionStore(path.join(tmp, 'iso-b'), clock());
  a.ensureProject(PROJECT);
  b.ensureProject(OTHER);
  const ma = a.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'same path', baseRevision: 'r', scope: { paths: ['src/Store.ts'] } });
  const mb = b.createMission({ projectId: OTHER.id, kind: 'explore', objective: 'same path', baseRevision: 'r', scope: { paths: ['src/Store.ts'] } });
  check('a mission is only in the store that made it', a.mission(mb.id) === null && b.mission(ma.id) === null);
  check('listing by the other project yields nothing', a.missions(OTHER.id).length === 0 && b.missions(PROJECT.id).length === 0);
  check('the other project is unknown to each', a.project(OTHER.id) === null && b.project(PROJECT.id) === null);

  // The same relative path in scope is the case that bit the claim store; here it is just two
  // missions about two projects, and nothing joins them.
  check('a task cannot be filed under a project the mission does not belong to',
    !!throws(() => a.createTask({ missionId: ma.id, role: 'review', objective: 'x', projectId: OTHER.id })));
  check('a decision cannot either',
    !!throws(() => a.recordDecision({
      missionId: ma.id, projectId: OTHER.id, revision: 'r', actor: 'human:x', kind: 'defer',
      rationale: 'r', scope: {}, artifactIds: [],
    })));
  a.close();
  b.close();
}

section('schema 2 attempt and experiment defaults');
{
  const store = new MissionStore(path.join(tmp, 'v2-defaults'), clock());
  store.ensureProject(PROJECT);
  const m = store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'o', baseRevision: 'r' });
  const t = store.createTask({ missionId: m.id, role: 'review', objective: 'r' });
  const a = store.startAttempt({ taskId: t.id, runnerId: 'agent:mock:x' });
  check('a P0 attempt is recorded read-only, unsandboxed', !a.sandbox!.write && !a.sandbox!.exec && a.sandbox!.profile === 'none');
  check('with no usage and no cost source', a.usageSource === 'none' && a.costSource === 'none'
    && a.tokens.input === null && a.tokens.output === null);
  check('a figure with no cost source is refused, not assumed known',
    !!throws(() => store.finishAttempt(a.id, { state: 'completed', costUsd: 0.05 })) && store.attempt(a.id)!.state === 'running');
  const done = store.finishAttempt(a.id, { state: 'completed', costUsd: 0.05, costSource: 'stdout-scan' });
  check('a labelled figure keeps its label', done.costSource === 'stdout-scan' && done.costUsd === 0.05);
  check('closing a non-implement mission as succeeded needs no application', (() => {
    store.transitionMission(m.id, 'ready');
    return store.closeMission(m.id, 'succeeded', 'answered').outcome === 'succeeded';
  })());
  store.close();
}

done();
