/**
 * Gates and the candidate verdict. Run: node engine/test/forge-gate.ts
 *
 * What has to hold: a gate's role is said, never defaulted; nothing locks that passes on the
 * base (unless a human names it vacuous); the lock is the store's one transaction behind the
 * R13 guard; a verdict is computed from rows and is the same whatever the author's attempt
 * exited with or said; a sandbox that never started, a tree that moved and a test that was
 * rewritten are `invalid`, never a failing gate; and holdouts never reach the author.
 *
 * The runtime cases run the real `bwrap` on this machine against a fixture repository; where
 * it is not installed they are skipped and said to be. No agent is ever run: candidates are
 * diffs this file writes itself.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDaylight } from '../mission/context.ts';
import { holdoutContent } from '../mission/orchestrate.ts';
import type { MissionStore } from '../mission/store.ts';
import type {
  Candidate, CandidateFile, DaylightEventInput, Experiment, GateEvaluation, LockGatesScope,
} from '../mission/types.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { checkPolicy, DecisionRefused } from '../forge/policy.ts';
import {
  authorBrief, baseline, evaluate, GateRefused, listGates, lock, registerGate, verdictRows, type GateContext,
} from '../forge/gate.ts';
import { candidateVerdict, type VerdictRows } from '../forge/verdict.ts';
import { DIFF_FLAGS } from '../forge/diff.ts';
import { createWorkspace, siblingGit, type Workspace } from '../forge/workspace.ts';
import { noTestsReported, runGate, sweepAbandoned } from '../experiment/runner.ts';
import { detectSandbox } from '../experiment/sandbox.ts';
import type { ExecutionRecord } from '../experiment/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

/** The tree's changes against its commit, captured the way a candidate's are. */
const diffOf = (ws: Workspace): Buffer => {
  siblingGit(ws, ['add', '--all', '--force']);
  return siblingGit(ws, ['diff', '--cached', ...DIFF_FLAGS, ws.commit, '--']);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-forge-gate-'));
// Every scratch tree this file makes, and every one the code under test makes, lands here and
// nowhere else, so the tamper cases below can only ever touch their own.
const privateTmp = path.join(tmp, 'tmp');
fs.mkdirSync(privateTmp, { mode: 0o700 });
process.env.TMPDIR = privateTmp;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const throws = async (fn: () => unknown): Promise<Error | null> => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};

// ---- the verdict, pure ----------------------------------------------------------------

const D = (c: string) => `sha256:${c.repeat(64)}`;
const BASE = 'b'.repeat(40);
const FILE: CandidateFile = { path: 'src/add.js', change: 'modified', insertions: 1, deletions: 1, mode: 'file', previousMode: 'file' };

function rows(over: Partial<VerdictRows> = {}, conclusions: Record<string, string> = { x_g: 'supported', x_h: 'supported' }): VerdictRows {
  const scope: LockGatesScope = {
    operation: 'lock-gates', experimentIds: ['x_g', 'x_h'], harnessDigests: { x_g: D('1'), x_h: D('2') },
    gateSetDigest: D('9'), vacuousOverrides: [],
  };
  const ev = (id: string, target: 'base' | 'candidate', conclusion: string) => ({
    experimentId: id, target, candidateId: target === 'candidate' ? 'c_1' : undefined,
    diffDigest: target === 'candidate' ? D('d') : null, harnessDigest: scope.harnessDigests[id],
    conclusion: conclusion as GateEvaluation['conclusion'],
  });
  return {
    candidate: { id: 'c_1', baseCommit: BASE, files: [FILE], policyViolations: [], secretHits: 0, gateSetDigest: D('9'), diffDigest: D('d') },
    missionBase: BASE,
    lock: { decisionId: 'd_1', scope },
    locked: [
      { id: 'x_g', role: 'gate', harnessDigest: D('1'), lockedBy: 'd_1' },
      { id: 'x_h', role: 'holdout', harnessDigest: D('2'), lockedBy: 'd_1' },
    ],
    baseline: [ev('x_g', 'base', 'falsified'), ev('x_h', 'base', 'falsified')],
    evaluations: Object.entries(conclusions).map(([id, c]) => ev(id, 'candidate', c)),
    ...over,
  };
}
const verdict = (r: VerdictRows) => candidateVerdict(r).verdict;

section('the verdict ladder, from rows');
{
  check('every locked gate and holdout supported → accepted-by-gates', verdict(rows()) === 'accepted-by-gates');
  check('a failing holdout beside a passing gate → rejected-by-gates', verdict(rows({}, { x_g: 'supported', x_h: 'falsified' })) === 'rejected-by-gates');
  check('a flaky gate → gates-inconclusive', verdict(rows({}, { x_g: 'inconclusive', x_h: 'supported' })) === 'gates-inconclusive');
  check('any invalid evaluation → gates-invalid', verdict(rows({}, { x_g: 'invalid', x_h: 'supported' })) === 'gates-invalid');
  check('invalid outranks inconclusive', verdict(rows({}, { x_g: 'invalid', x_h: 'inconclusive' })) === 'gates-invalid');
  check('a locked gate with no evaluation on this diff → gates-invalid', verdict(rows({}, { x_g: 'supported' })) === 'gates-invalid');
  const r0 = rows();
  check('an evaluation of another diff does not count', verdict({ ...r0, evaluations: r0.evaluations.map((e) => ({ ...e, diffDigest: D('e') })) }) === 'gates-invalid');
  check('nor one at another harness', verdict({ ...r0, evaluations: r0.evaluations.map((e) => ({ ...e, harnessDigest: D('7') })) }) === 'gates-invalid');
  check('nor one of another candidate', verdict({ ...r0, evaluations: r0.evaluations.map((e) => ({ ...e, candidateId: 'c_2' })) }) === 'gates-invalid');
  check('the latest evaluation of a gate is the one that counts',
    verdict({ ...r0, evaluations: [{ ...r0.evaluations[0], conclusion: 'falsified' }, ...r0.evaluations] }) === 'accepted-by-gates');
  check('a gate whose harness changed after the lock → gates-invalid',
    verdict({ ...r0, locked: [{ ...r0.locked[0], harnessDigest: D('5') }, r0.locked[1]] }) === 'gates-invalid');
  check('a locked gate that no longer exists → gates-invalid', verdict({ ...r0, locked: [r0.locked[1]] }) === 'gates-invalid');
  check('a gate not locked by this decision → gates-invalid', verdict({ ...r0, locked: [{ ...r0.locked[0], lockedBy: 'd_0' }, r0.locked[1]] }) === 'gates-invalid');
  check('a candidate built against another gate set → gates-invalid',
    verdict({ ...r0, candidate: { ...r0.candidate, gateSetDigest: D('8') } }) === 'gates-invalid');
  check('no lock → gates-invalid', verdict({ ...r0, lock: null }) === 'gates-invalid');
  check('a vacuous baseline not overridden → gates-invalid',
    verdict({ ...r0, baseline: [{ ...r0.baseline[0], conclusion: 'supported' }, r0.baseline[1]] }) === 'gates-invalid');
  check('a vacuous baseline overridden by name is accepted', verdict({
    ...r0, baseline: [{ ...r0.baseline[0], conclusion: 'supported' }, r0.baseline[1]],
    lock: { ...r0.lock!, scope: { ...r0.lock!.scope, vacuousOverrides: ['x_g'] } },
  }) === 'accepted-by-gates');
  check('an invalid baseline → gates-invalid', verdict({ ...r0, baseline: [{ ...r0.baseline[0], conclusion: 'invalid' }, r0.baseline[1]] }) === 'gates-invalid');
  check('an unresolvable mission base → gates-invalid', verdict({ ...r0, missionBase: null }) === 'gates-invalid');
  check('a candidate on another base → stale-base', verdict({ ...r0, candidate: { ...r0.candidate, baseCommit: 'c'.repeat(40) } }) === 'stale-base');
  check('a policy violation → policy-violation, whatever the gates say',
    verdict({ ...r0, candidate: { ...r0.candidate, policyViolations: [{ rule: 'gate-path', path: '.daylight-gates/x/t.js' }] } }) === 'policy-violation');
  check('a secret hit → policy-violation', verdict({ ...r0, candidate: { ...r0.candidate, secretHits: 1 } }) === 'policy-violation');
  check('an empty diff → no-diff, ahead of everything',
    verdict({ ...r0, candidate: { ...r0.candidate, files: [], secretHits: 2, baseCommit: 'c'.repeat(40) } }) === 'no-diff');
  check('reasons name a failed gate by id', candidateVerdict(rows({}, { x_g: 'falsified', x_h: 'supported' })).reasons.join().includes('gate x_g'));
  check('and a failed holdout by count, never by id', (() => {
    const r = candidateVerdict(rows({}, { x_g: 'supported', x_h: 'falsified' })).reasons.join();
    return r.includes('1 holdout(s): falsified') && !r.includes('x_h');
  })());
  check('an invalid holdout is counted, not named', (() => {
    const r = candidateVerdict(rows({}, { x_g: 'supported' })).reasons.join();
    return r.includes('1 holdout(s)') && !r.includes('x_h');
  })());
}

section('the verdict does not read the attempt (ADR-19)');
{
  // The property half of `verdict-is-pure`: every combination of what the author's attempt
  // did and said, through the same row builder `evaluate` uses, yields the same verdict.
  const states = ['completed', 'failed', 'cancelled', 'running'] as const;
  const exits = [0, 1, 137, null];
  const narratives = ['all tests pass', 'I could not do it', undefined];
  const fakeStore = (c: Candidate) => ({
    mission: () => ({ id: 'm_1', kind: 'implement', projectId: 'git:p', baseRevision: 'unversioned' }),
    lockDecision: () => null, experiment: () => null, gateEvaluations: () => [], candidate: () => c,
  }) as unknown as MissionStore;
  const base: Candidate = {
    id: 'c_1', possibleSecretHits: 0, missionId: 'm_1', attemptId: 'a_1', projectId: 'git:p', baseCommit: BASE,
    diffArtifact: { id: D('d'), kind: 'diff', digest: D('d'), projectId: 'git:p' }, summaryArtifact: { id: D('s'), kind: 'summary', digest: D('s'), projectId: 'git:p' },
    files: [FILE], policyViolations: [], secretHits: 0, gateSetDigest: D('9'),
    profile: { name: 'author', network: 'none', write: true, exec: false }, attemptState: 'completed', verdict: 'pending', verdictReasons: [], createdAt: 1,
  };
  for (const scenario of [{ x_g: 'supported', x_h: 'supported' }, { x_g: 'supported', x_h: 'falsified' }, { x_g: 'inconclusive', x_h: 'supported' }]) {
    const seen = new Set<string>();
    for (const attemptState of states) {
      for (const exit of exits) {
        for (const narrative of narratives) {
          const c: Candidate = {
            ...base, attemptState, attemptFailure: exit === 0 ? undefined : `exited ${String(exit)}`,
            ...(narrative ? { narrativeArtifact: { id: D('n'), kind: 'narrative', digest: D('n'), projectId: 'git:p', label: narrative } } : {}),
          };
          const built = verdictRows({ store: fakeStore(c), artifacts: null as never, repoRoot: '/nonexistent' }, c);
          // The row builder carries none of it…
          const leaked = JSON.stringify(built.candidate).match(/attemptState|attemptFailure|narrative/);
          // …and the verdict over the scenario's rows is the scenario's.
          seen.add(`${leaked ? 'LEAK' : ''}${candidateVerdict({ ...rows({}, scenario), candidate: { ...rows().candidate, ...built.candidate } }).verdict}`);
        }
      }
    }
    check(`${Object.values(scenario).join('/')}: one verdict across ${states.length * exits.length * narratives.length} attempt outcomes`, seen.size === 1 && ![...seen][0].startsWith('LEAK'), [...seen].join());
  }
}

section('a run that reports no tests is not a failing gate');
{
  check('a tap summary with tests is readable', noTestsReported('1..1\n# tests 1\n# pass 0\n# fail 1\n') === null);
  check('a spec summary with tests is readable', noTestsReported('ℹ tests 2\nℹ pass 2\n') === null);
  check('no summary at all is unreadable', noTestsReported('Error: Cannot find module\n') !== null);
  check('tests 0 is unreadable', noTestsReported('# tests 0\n') !== null);
}

// ---- the fixture -------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@daylight',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@daylight',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const git = (args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(['init', '-q']);
const BUGGY = 'module.exports = (a, b) => a - b;\n';
fs.writeFileSync(path.join(repo, 'src', 'add.js'), BUGGY);
fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
git(['add', '.']);
git(['commit', '-q', '-m', 'fixture']);
const commit = git(['rev-parse', 'HEAD']);
const headBefore = commit;
const statusBefore = git(['status', '--porcelain']);

const out = path.join(tmp, 'out');
const dctx = openDaylight(out);
const PROJECT = { id: 'git:cccccccccccc', root: repo, name: 'fixture' };
dctx.store.ensureProject(PROJECT);
const HUMAN = 'human:miz';
const events: DaylightEventInput[] = [];
const sink = { append: (e: DaylightEventInput) => { events.push(e); dctx.events.append(e); return e; } };
const ctx: GateContext = { store: dctx.store, artifacts: dctx.artifacts, events: sink, repoRoot: repo, env: {} };
const named = (name: string) => events.filter((e) => e.name === name);

const newMission = (objective: string) => dctx.store.createMission({
  projectId: PROJECT.id, kind: 'implement', objective, baseRevision: commit, adhoc: { actor: HUMAN, rationale: 'test fixture' },
});
const mission = newMission('make add add');
const grant = dctx.store.authorizeMission({
  missionId: mission.id, actor: HUMAN, rationale: 'go', permissions: { write: true, execute: false }, maxUsd: null,
}).decision;

const GATE_TEST = [
  "const test = require('node:test');", "const assert = require('node:assert');",
  "const add = require('../../src/add.js');", "test('adds small numbers', () => assert.strictEqual(add(2, 3), 5));", '',
].join('\n');
const HOLDOUT_TEST = [
  "const test = require('node:test');", "const assert = require('node:assert');",
  "const add = require('../../src/add.js');", "test('adds a negative', () => assert.strictEqual(add(10, -4), 6));", '',
].join('\n');
const VACUOUS_TEST = "const test = require('node:test');\ntest('always', () => {});\n";
const PASS = { exitCode: 0, stdoutIncludes: ['# fail 0'] };

const live = detectSandbox();
const UNAVAILABLE = { name: 'bwrap' as const, available: false, why: 'forced off by the test' };

section('registering a gate');
let gate!: Experiment;
let holdout!: Experiment;
let vacuous!: Experiment;
{
  const input = { missionId: mission.id, testSource: GATE_TEST, basename: 'add.test.js', prediction: PASS };
  check('without --role it is refused', (await throws(() => registerGate(ctx, { ...input, role: undefined }))) instanceof GateRefused);
  check('as a probe it is refused', (await throws(() => registerGate(ctx, { ...input, role: 'probe' }))) instanceof GateRefused);
  check('with no reporter marker it is refused', !!(await throws(() => registerGate(ctx, { ...input, role: 'gate', prediction: { exitCode: 0 } }))));
  check('with no exit code it is refused', !!(await throws(() => registerGate(ctx, { ...input, role: 'gate', prediction: { stdoutIncludes: ['# fail 0'] } }))));
  check('a basename that climbs is refused', !!(await throws(() => registerGate(ctx, { ...input, role: 'gate', basename: '../x.js' }))));
  check('a command that is not the node test runner is refused', !!(await throws(() => registerGate(ctx, { ...input, role: 'gate', command: ['node', '{test}'] }))));
  check('the dot reporter, which prints no summary, is refused',
    !!(await throws(() => registerGate(ctx, { ...input, role: 'gate', command: ['node', '--test', '--test-reporter=dot', '{test}'] }))));
  check('nothing was registered by the refusals', dctx.store.experiments(mission.id).length === 0);

  gate = registerGate(ctx, { ...input, role: 'gate' });
  holdout = registerGate(ctx, { ...input, role: 'holdout', testSource: HOLDOUT_TEST });
  vacuous = registerGate(ctx, { ...input, role: 'gate', testSource: VACUOUS_TEST, basename: 'always.test.js' });
  check('a gate is filed under .daylight-gates/<x_id>/<basename>', gate.testArtifact.path === `.daylight-gates/${gate.id}/add.test.js`);
  check('its row says its role', dctx.store.experiment(gate.id)?.role === 'gate' && dctx.store.experiment(holdout.id)?.role === 'holdout');
  check('its expectation carries role and base', (() => {
    const e = JSON.parse(dctx.artifacts.text(holdout.expectedArtifact));
    return e.role === 'holdout' && e.baseRevision === commit && e.testPath === holdout.testArtifact.path;
  })());
  check('the default command runs the test under the tap reporter', gate.command.join(' ') === `node --test --test-reporter=tap ${gate.testArtifact.path}`);
  check('gate.registered names id, role and harness', named('gate.registered').length === 3
    && named('gate.registered')[1].payload.role === 'holdout' && named('gate.registered')[0].payload.harnessDigest === gate.harnessDigest);
}

section('the gate commands, through the module');
{
  const runner = path.join(tmp, 'gate-cli.ts');
  fs.writeFileSync(runner, [
    `import { runGateCommand } from ${JSON.stringify(path.join(HERE, '..', 'forge', 'commands-gate.ts'))};`,
    'process.exitCode = await runGateCommand(process.argv.slice(2));',
  ].join('\n'));
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [runner, ...args, '--out', out], {
      encoding: 'utf8', env: { ...process.env, CLAUDECODE: '', DAYLIGHT_SESSION: '', ...env },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const m = newMission('cli');
  const testFile = path.join(tmp, 'add.test.js');
  fs.writeFileSync(testFile, HOLDOUT_TEST);
  const noRole = cli(['add', m.id, '--test', testFile, '--expect-exit', '0', '--expect-stdout', '# fail 0']);
  check('gate add without --role is a usage error', noRole.code === 2 && /--role gate\|holdout is required/.test(noRole.stderr), noRole.stderr);
  const added = cli(['add', m.id, '--role', 'holdout', '--test', testFile, '--expect-exit', '0', '--expect-stdout', '# fail 0', '--format', 'json']);
  const x = added.code === 0 ? JSON.parse(added.stdout) as Experiment : null;
  check('gate add --role holdout registers under .daylight-gates', !!x && x.role === 'holdout' && x.testArtifact.path === `.daylight-gates/${x.id}/add.test.js`, added.stderr);
  const preview = cli(['lock', m.id, '--actor', HUMAN, '--rationale', 'r', '--format', 'json']);
  const shown = preview.code === 2 ? JSON.parse(preview.stdout) as { digest: string; lines: string[] } : null;
  check('gate lock without --confirm shows the digest and refuses', !!shown && shown.digest.startsWith('sha256:') && !preview.stdout.includes('"digest8"'), preview.stderr);
  const agent = cli(['lock', m.id, '--actor', HUMAN, '--rationale', 'r', '--confirm', shown?.digest.slice(7, 15) ?? '', '--format', 'json'], { CLAUDECODE: '1' });
  check('gate lock under CLAUDECODE is refused', agent.code === 1 && JSON.parse(agent.stdout).refused === true, agent.stdout);
  const listed = cli(['list', m.id, '--format', 'json']);
  check('gate list shows the human every gate, unlocked', listed.code === 0 && JSON.parse(listed.stdout).gates.length === 1 && JSON.parse(listed.stdout).lock === null);
}

/** A candidate: an edit of a fresh tree at `commit`, captured as a diff, filed against an attempt. */
function candidate(
  edit: (tree: string) => void, files: CandidateFile[],
  o: { state?: 'completed' | 'failed' | 'cancelled'; exitCode?: number | null; narrative?: string; gateSetDigest?: string; diff?: Buffer } = {},
): Candidate {
  const ws = createWorkspace(repo, commit);
  let diff: Buffer;
  try {
    edit(ws.tree);
    diff = o.diff ?? diffOf(ws);
  } finally {
    ws.dispose();
  }
  const task = dctx.store.createTask({ missionId: mission.id, role: 'author', objective: 'make add add' });
  const a = dctx.store.startAttempt({
    taskId: task.id, runnerId: 'agent:mock:author',
    sandbox: { profile: 'author', network: 'none', write: true, exec: false, authorizeDecisionId: grant.id },
  });
  const state = o.state ?? 'completed';
  dctx.store.finishAttempt(a.id, { state, exitCode: o.exitCode ?? 0, costUsd: null });
  const meta = { projectId: PROJECT.id, revision: commit };
  return dctx.store.createCandidate({
    missionId: mission.id, attemptId: a.id, projectId: PROJECT.id, baseCommit: commit,
    diffArtifact: dctx.artifacts.put(diff, { ...meta, kind: 'diff' }),
    summaryArtifact: dctx.artifacts.put(JSON.stringify({ files: files.length }), { ...meta, kind: 'summary' }),
    narrativeArtifact: dctx.artifacts.put(o.narrative ?? 'done', { ...meta, kind: 'narrative', label: 'author-claimed, unverified' }),
    files, policyViolations: checkPolicy(files, { diffBytes: diff.length }), secretHits: 0,
    gateSetDigest: o.gateSetDigest ?? (dctx.store.lockDecision(mission.id)?.scope.gateSetDigest as string),
    profile: { name: 'author', network: 'none', write: true, exec: false },
    attemptState: state, ...(state !== 'completed' ? { attemptFailure: `exited ${String(o.exitCode)}` } : {}),
  });
}
const writeAdd = (src: string) => (tree: string) => fs.writeFileSync(path.join(tree, 'src', 'add.js'), src);
const FIXED = 'module.exports = (a, b) => a + b;\n';
const gateRows = (c: Candidate) => dctx.store.gateEvaluations({ candidateId: c.id, target: 'candidate' });
const recordsOf = (g: GateEvaluation): ExecutionRecord[] =>
  g.executions.filter((r) => r.kind === 'result').map((r) => JSON.parse(dctx.artifacts.text(r)) as ExecutionRecord);

if (!live.available) {
  console.log(`\nskipped: gate runs need bwrap and prlimit (${live.why})`);
} else {
  section('baseline: each gate runs on the base');
  {
    const bs = await baseline(ctx, mission.id);
    const by = (x: Experiment) => bs.find((b) => b.experimentId === x.id);
    check('a gate that fails on the base is falsified', by(gate)?.conclusion === 'falsified', by(gate)?.conclusion);
    check('so is the holdout', by(holdout)?.conclusion === 'falsified', by(holdout)?.conclusion);
    check('a gate that already passes is supported, i.e. vacuous', by(vacuous)?.conclusion === 'supported', by(vacuous)?.conclusion);
    check('one base evaluation each, naming no diff and no candidate',
      bs.length === 3 && bs.every((b) => b.target === 'base' && b.diffDigest === null && b.candidateId === undefined));
    check('each at its experiment\'s harness, on the base revision', bs.every((b) => b.harnessDigest === dctx.store.experiment(b.experimentId)!.harnessDigest && b.revision === commit));
    const rs = recordsOf(by(gate)!);
    check('it ran twice, in the sandbox', rs.length === 2 && rs.every((r) => r.status === 'ran' && r.sandboxArgv.includes('--ro-bind-data')));
    check('each record says it ran against the base', rs.every((r) => r.target?.kind === 'base' && r.target.diffDigest === null));
    check('the experiment rows are not concluded by a gate run', [gate, holdout, vacuous].every((x) => dctx.store.experiment(x.id)!.conclusion === 'pending'));
    check('forge.gate.evaluated is recorded per gate', named('forge.gate.evaluated').length === 3);
    check('the real checkout is untouched', git(['rev-parse', 'HEAD']) === headBefore && git(['status', '--porcelain']) === statusBefore);
    check('and no worktree was added to it', git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length === 1);
  }

  section('lock: the R13 guard and the must-fail rule');
  let lockDecisionId = '';
  {
    const all = [gate.id, holdout.id, vacuous.id];
    const code = (ids: string[]) => confirmDigest(ctx, 'lock-gates', mission.id, { experimentIds: ids }).digest8;
    const attempt = (o: Partial<Parameters<typeof lock>[1]>, env: Record<string, string> = {}) =>
      throws(() => lock({ ...ctx, env }, { missionId: mission.id, actor: HUMAN, rationale: 'r', confirm: code(all), ...o }));
    check('under CLAUDECODE it is refused', (await attempt({}, { CLAUDECODE: '1' })) instanceof DecisionRefused);
    check('under DAYLIGHT_SESSION it is refused', (await attempt({}, { DAYLIGHT_SESSION: 's' })) instanceof DecisionRefused);
    check('an agent actor is refused', (await attempt({ actor: 'agent:claude:opus' })) instanceof DecisionRefused);
    check('a wrong --confirm is refused', (await attempt({ confirm: '00000000' })) instanceof DecisionRefused);
    const vac = await attempt({});
    check('a gate that passes on the base is refused at lock', vac instanceof GateRefused && /passes on the base/.test(vac.message), vac?.message);
    check('accepting a gate that fails on the base as vacuous is refused',
      (await attempt({ experimentIds: [gate.id, holdout.id], confirm: code([gate.id, holdout.id]), acceptVacuous: [gate.id] })) instanceof GateRefused);
    check('a lock of holdouts only is refused', (await attempt({ experimentIds: [holdout.id], confirm: code([holdout.id]) })) instanceof GateRefused);
    check('nothing was locked by any refusal', dctx.store.lockDecision(mission.id) === null
      && [gate, holdout, vacuous].every((x) => !dctx.store.experiment(x.id)!.lockedBy) && dctx.store.mission(mission.id)!.acceptanceGateIds.length === 0);

    const d = lock(ctx, { missionId: mission.id, actor: HUMAN, rationale: 'the two real ones', confirm: code([gate.id, holdout.id]), experimentIds: [gate.id, holdout.id] });
    lockDecisionId = d.id;
    const scope = d.scope as unknown as LockGatesScope;
    check('the gate and the holdout lock', d.kind === 'approve' && scope.operation === 'lock-gates' && scope.experimentIds.length === 2);
    check('locked_by and acceptanceGateIds are set together', dctx.store.experiment(gate.id)!.lockedBy === d.id
      && dctx.store.experiment(holdout.id)!.lockedBy === d.id && dctx.store.mission(mission.id)!.acceptanceGateIds.join() === [gate.id, holdout.id].sort().join());
    check('the recorded digest is the one the human confirmed', scope.gateSetDigest === confirmDigest(ctx, 'lock-gates', mission.id, { experimentIds: [gate.id, holdout.id] }).digest);
    check('forge.gates.locked names the decision and digest', named('forge.gates.locked').at(-1)?.payload.decisionId === d.id
      && named('forge.gates.locked').at(-1)?.payload.gateSetDigest === scope.gateSetDigest);
  }

  section('lock: a vacuous gate needs a human to name it; an invalid baseline never locks');
  {
    const m2 = newMission('second');
    const v2 = registerGate(ctx, { missionId: m2.id, role: 'gate', testSource: VACUOUS_TEST, basename: 'always.test.js', prediction: PASS });
    const g2 = registerGate(ctx, { missionId: m2.id, role: 'gate', testSource: GATE_TEST, basename: 'add.test.js', prediction: PASS });
    const h2 = registerGate(ctx, { missionId: m2.id, role: 'holdout', testSource: HOLDOUT_TEST, basename: 'add.test.js', prediction: PASS });
    await baseline(ctx, m2.id, { experimentIds: [v2.id, g2.id] });
    // The holdout's baseline: the launcher cannot start. That is not a failing test.
    const [hb] = await baseline({ ...ctx, sandbox: { ...live, prlimit: path.join(tmp, 'no-such-prlimit') } }, m2.id, { experimentIds: [h2.id] });
    check('a prlimit that cannot start makes the baseline invalid, not falsified', hb.conclusion === 'invalid', hb.conclusion);
    check('and its record says the sandbox did not start', /did not start/.test(recordsOf(hb)[0]?.why ?? ''), recordsOf(hb)[0]?.why);
    const [nb] = await baseline({ ...ctx, sandbox: UNAVAILABLE }, m2.id, { experimentIds: [h2.id] });
    check('no bwrap at all is invalid too', nb.conclusion === 'invalid' && recordsOf(nb)[0]?.status === 'denied', nb.conclusion);
    const code = (ids: string[]) => confirmDigest(ctx, 'lock-gates', m2.id, { experimentIds: ids }).digest8;
    const invalidLock = await throws(() => lock(ctx, { missionId: m2.id, actor: HUMAN, rationale: 'r', confirm: code([g2.id, h2.id]), experimentIds: [g2.id, h2.id] }));
    check('an invalid baseline can never be locked', invalidLock instanceof GateRefused && /baseline is invalid/.test(invalidLock.message), invalidLock?.message);
    // A same-uid writer re-stamping a gate between the human's confirm and the store's lock.
    const raw = new DatabaseSync(path.join(out, 'daylight.db'));
    const racing = Object.create(dctx.store) as MissionStore;
    racing.lockGates = (id, input) => {
      raw.prepare('UPDATE experiments SET harness_digest=? WHERE id=?').run(D('a'), g2.id);
      try {
        return dctx.store.lockGates(id, input);
      } finally {
        raw.prepare('UPDATE experiments SET harness_digest=? WHERE id=?').run(g2.harnessDigest, g2.id);
      }
    };
    const raced = await throws(() => lock({ ...ctx, store: racing }, { missionId: m2.id, actor: HUMAN, rationale: 'r', confirm: code([g2.id]), experimentIds: [g2.id] }));
    raw.close();
    check('a gate set that moved between confirm and lock is refused, not passed off as confirmed',
      raced instanceof GateRefused && /not the one confirmed/.test(raced.message), raced?.message);
    check('and the refusal is inside the lock\'s transaction: no decision, no locked_by, no acceptance gates',
      dctx.store.lockDecision(m2.id) === null && !dctx.store.experiment(g2.id)!.lockedBy
      && dctx.store.mission(m2.id)!.acceptanceGateIds.length === 0);
    const d = lock(ctx, { missionId: m2.id, actor: HUMAN, rationale: 'accepted: smoke check', confirm: code([g2.id, v2.id]), experimentIds: [g2.id, v2.id], acceptVacuous: [v2.id] });
    check('named in --accept-vacuous, a vacuous gate locks and the override is recorded',
      (d.scope as unknown as LockGatesScope).vacuousOverrides.join() === v2.id);
    check('gate list shows baselines, lock and override', (() => {
      const l = listGates(ctx, m2.id);
      const v = l.gates.find((g) => g.experimentId === v2.id);
      return l.gates.length === 3 && v?.baseline === 'supported' && v.vacuousOverride && v.lockedBy === d.id
        && l.gates.find((g) => g.experimentId === h2.id)?.lockedBy === null;
    })());
    check('gate list withholds a holdout\'s path and keeps a gate\'s', (() => {
      const l = listGates(ctx, m2.id);
      return l.gates.find((g) => g.experimentId === h2.id)?.testPath === null && !!l.gates.find((g) => g.experimentId === g2.id)?.testPath
        && !JSON.stringify(l).includes(dctx.store.experiment(h2.id)!.testArtifact.path!);
    })());
  }

  section('the author is shown gates, never holdouts');
  {
    const brief = authorBrief(ctx, mission.id);
    const text = JSON.stringify(brief);
    check('the brief carries the locked gate\'s test', brief.gates.length === 1 && brief.gates[0].experimentId === gate.id && brief.gates[0].testSource === GATE_TEST);
    check('and nothing of the holdout: not its id, path or text', !text.includes(holdout.id) && !text.includes('adds a negative'));
    check('nor how many there are', !/holdout/i.test(text));
    check('before a lock there is no brief', !!(await throws(() => authorBrief(ctx, newMission('unlocked').id))));
  }

  section('a correct diff is accepted, whatever the attempt exited with');
  {
    const failed = candidate(writeAdd(FIXED), [FILE], { state: 'failed', exitCode: 1, narrative: 'I gave up' });
    const c = await evaluate(ctx, failed.id);
    check('an attempt that exited 1 with a diff that passes every gate is accepted-by-gates', c.verdict === 'accepted-by-gates', `${c.verdict}: ${c.verdictReasons.join('; ')}`);
    check('the attempt\'s outcome is on the candidate for the human to see', c.attemptState === 'failed' && c.attemptFailure === 'exited 1');
    const gs = gateRows(c);
    check('one candidate evaluation per locked gate and holdout, on this exact diff',
      gs.length === 2 && gs.every((g) => g.diffDigest === c.diffArtifact.digest && g.candidateId === c.id && g.conclusion === 'supported'),
      gs.flatMap(recordsOf).map((r) => r.why).join(' | '));
    check('each run record names the diff it ran against', gs.flatMap(recordsOf).every((r) => r.target?.kind === 'candidate' && r.target.diffDigest === c.diffArtifact.digest));
    const killed = await evaluate(ctx, candidate(writeAdd(FIXED), [FILE], { state: 'cancelled', exitCode: null, narrative: 'killed at the ceiling' }).id);
    check('a killed author\'s passing diff is accepted too', killed.verdict === 'accepted-by-gates', killed.verdict);
    check('the experiment rows are still not concluded', [gate, holdout].every((x) => dctx.store.experiment(x.id)!.conclusion === 'pending'));
    check('forge.candidate.verdict is recorded', named('forge.candidate.verdict').filter((e) => e.payload.candidateId === c.id).at(-1)?.payload.verdict === 'accepted-by-gates');
    check('the real checkout is still untouched', git(['rev-parse', 'HEAD']) === headBefore && git(['status', '--porcelain']) === statusBefore);
  }

  section('no diff, a policy violation, a failing holdout, a flake');
  {
    const runsBefore = named('experiment.run.started').length;
    const noop = await evaluate(ctx, candidate(() => {}, [], { exitCode: 0, narrative: 'all tests pass' }).id);
    check('a no-op diff with exit 0 and "all tests pass" is no-diff', noop.verdict === 'no-diff', noop.verdict);
    const edit = (tree: string) => {
      writeAdd(FIXED)(tree);
      fs.mkdirSync(path.join(tree, '.daylight-gates', gate.id), { recursive: true });
      fs.writeFileSync(path.join(tree, '.daylight-gates', gate.id, 'add.test.js'), "require('node:test')('x', () => {});\n");
    };
    const gp = `.daylight-gates/${gate.id}/add.test.js`;
    const viol = await evaluate(ctx, candidate(edit, [FILE, { path: gp, change: 'added', insertions: 1, deletions: 0, mode: 'file' }]).id);
    check('a diff that edits .daylight-gates is a policy violation', viol.verdict === 'policy-violation' && viol.verdictReasons.some((r) => r.includes('gate-path')), viol.verdict);
    check('and neither was run through a gate', named('experiment.run.started').length === runsBefore && gateRows(noop).length + gateRows(viol).length === 0);

    const eventsBefore = events.length;
    const halfway = await evaluate(ctx, candidate(writeAdd('module.exports = (a, b) => (a === 2 && b === 3 ? 5 : a - b);\n'), [FILE]).id);
    check('a diff that passes the gate and fails the holdout is rejected-by-gates', halfway.verdict === 'rejected-by-gates', halfway.verdict);
    check('saying a holdout failed, by count', halfway.verdictReasons.some((r) => /^1 holdout\(s\): falsified/.test(r)), halfway.verdictReasons.join());
    const during = JSON.stringify(events.slice(eventsBefore));
    const asRow = JSON.stringify(dctx.store.candidate(halfway.id));
    check('no holdout id, path or harness reaches the candidate row',
      ![holdout.id, holdout.testArtifact.path!, holdout.harnessDigest].some((s) => asRow.includes(s)));
    check('nor any event the evaluation emitted', ![holdout.id, holdout.testArtifact.path!, holdout.harnessDigest].some((s) => during.includes(s)));
    check('while the public gate is still named in its events', during.includes(gate.id));
    check('the holdout\'s evaluation is in gate_evaluations for the human',
      gateRows(halfway).some((g) => g.experimentId === holdout.id && g.conclusion === 'falsified'));
    check('the holdout evaluation event carries its role and conclusion only',
      events.slice(eventsBefore).some((e) => e.name === 'forge.gate.evaluated' && e.payload.role === 'holdout' && e.payload.conclusion === 'falsified' && !('experimentId' in e.payload)));
    const flaky = await evaluate(ctx, candidate(writeAdd("module.exports = (a, b) => (process.env.DAYLIGHT_RUN_INDEX === '0' ? a + b : a - b);\n"), [FILE]).id);
    check('a diff that passes on one run and not the other is gates-inconclusive', flaky.verdict === 'gates-inconclusive', flaky.verdict);
  }

  section('an infrastructure failure is invalid, never a verdict about the code');
  {
    const c1 = candidate(writeAdd(FIXED), [FILE]);
    const startFail = await evaluate({ ...ctx, sandbox: { ...live, prlimit: path.join(tmp, 'no-such-prlimit') } }, c1.id);
    check('prlimit failing to start makes a correct diff gates-invalid, not rejected', startFail.verdict === 'gates-invalid', startFail.verdict);
    check('every evaluation is invalid and says the sandbox did not start',
      gateRows(c1).every((g) => g.conclusion === 'invalid' && recordsOf(g).some((r) => /did not start/.test(r.why ?? ''))));
    const again = await evaluate(ctx, c1.id);
    check('re-evaluated with a working sandbox, the latest evaluations decide', again.verdict === 'accepted-by-gates', again.verdict);
    const noBwrap = await evaluate({ ...ctx, sandbox: UNAVAILABLE }, candidate(writeAdd(FIXED), [FILE]).id);
    check('no sandbox at all is gates-invalid', noBwrap.verdict === 'gates-invalid', noBwrap.verdict);

    const wrongBase = candidate(() => {}, [FILE], { diff: Buffer.from('diff --git a/src/add.js b/src/add.js\n--- a/src/add.js\n+++ b/src/add.js\n@@ -1 +1 @@\n-not what is there\n+module.exports = 1;\n') });
    const unapplied = await evaluate(ctx, wrongBase.id);
    check('a diff that does not apply to the base is gates-invalid', unapplied.verdict === 'gates-invalid'
      && gateRows(wrongBase).every((g) => g.conclusion === 'invalid' && recordsOf(g)[0]?.why?.includes('does not apply')), unapplied.verdict);

    // Its own bytes: artifacts are content-addressed, and every other FIXED candidate shares one blob.
    const rot = candidate(writeAdd('module.exports = (a, b) => a + b; // rot\n'), [FILE]);
    const blob = path.join(out, 'artifacts', 'sha256', rot.diffArtifact.digest.slice('sha256:'.length));
    const realBlob = fs.existsSync(blob) ? blob : null;
    if (realBlob) {
      fs.chmodSync(realBlob, 0o644);
      fs.writeFileSync(realBlob, fs.readFileSync(realBlob, 'utf8').replace('a + b', 'a * b'));
      const rotted = await evaluate(ctx, rot.id);
      check('a diff artifact that no longer hashes to its digest is gates-invalid', rotted.verdict === 'gates-invalid'
        && gateRows(rot).every((g) => g.conclusion === 'invalid'), rotted.verdict);
    } else {
      check('the diff artifact is where the store files it', false, blob);
    }
  }

  section('the tree or the test changing between runs is invalid');
  {
    // A same-uid process writing into the materialised tree after the first run. Only this
    // file's private TMPDIR is searched, so nothing outside the test can be touched.
    const hook = (rewrite: (tree: string) => void) => ({
      append: (e: DaylightEventInput) => {
        sink.append(e);
        if (e.name === 'experiment.run.finished' && e.payload.runIndex === 0 && e.payload.target === 'candidate') {
          for (const d of fs.readdirSync(privateTmp).filter((n) => n.startsWith('daylight-forge-'))) {
            const tree = path.join(privateTmp, d, 'tree');
            if (fs.existsSync(tree)) rewrite(tree);
          }
        }
        return e;
      },
    });
    const c1 = candidate(writeAdd(FIXED), [FILE]);
    const moved = await evaluate({ ...ctx, events: hook((t) => fs.appendFileSync(path.join(t, 'README.md'), 'moved\n')) }, c1.id);
    check('a tree file rewritten between runs makes the verdict gates-invalid', moved.verdict === 'gates-invalid', moved.verdict);
    check('the second run\'s record says the tree changed', gateRows(c1).some((g) => /tree under test changed/.test(recordsOf(g)[1]?.why ?? '')), gateRows(c1).flatMap(recordsOf).map((r) => `${r.runIndex}:${r.status}:${r.why}`).join(' | '));

    const c2 = candidate(writeAdd(FIXED), [FILE]);
    const planted = await evaluate({ ...ctx, events: hook((t) => fs.writeFileSync(path.join(t, 'src', 'extra.js'), '1\n')) }, c2.id);
    check('a file planted in the tree between runs is gates-invalid', planted.verdict === 'gates-invalid', planted.verdict);

    const c3 = candidate(writeAdd(FIXED), [FILE]);
    const marker = 'TAMPERED_GATE_TEST_RAN';
    const tampered = await evaluate({
      ...ctx, events: hook((t) => {
        const f = path.join(t, '.daylight-gates', gate.id, 'add.test.js');
        if (fs.existsSync(f)) {
          fs.chmodSync(f, 0o644);
          fs.writeFileSync(f, `console.log('# fail 0 ${marker}');\n`);
        }
      }),
    }, c3.id);
    const gEval = gateRows(c3).find((g) => g.experimentId === gate.id)!;
    const second = recordsOf(gEval)[1];
    check('the protected test rewritten between runs is still invalid (WS0)', tampered.verdict === 'gates-invalid' && gEval.conclusion === 'invalid', `${tampered.verdict}/${gEval.conclusion}`);
    check('and the second run still executed the registered bytes', !!second?.stdoutRef && !dctx.artifacts.text(second.stdoutRef).includes(marker));
    check('its record says the copy changed', /changed during the experiment/.test(second?.why ?? ''), second?.why);
  }

  section('runGate on its own: a foreign test file, a suite that never reports');
  {
    const ws = () => createWorkspace(repo, commit);
    const r1 = await runGate(gate, {
      repoRoot: repo, store: dctx.store, artifacts: dctx.artifacts, target: { kind: 'base', diffDigest: null },
      materialise: () => {
        const w = ws();
        fs.mkdirSync(path.join(w.tree, '.daylight-gates', gate.id), { recursive: true });
        fs.writeFileSync(path.join(w.tree, gate.testArtifact.path!), GATE_TEST);
        return w;
      },
    });
    check('a file already at the gate\'s path, even an identical one, is invalid', r1.conclusion === 'invalid' && /belongs to the gate/.test(r1.records[0]?.why ?? ''), r1.records[0]?.why);
    const r2 = await runGate(gate, {
      repoRoot: repo, store: dctx.store, artifacts: dctx.artifacts, target: { kind: 'base', diffDigest: null }, runs: 1, materialise: ws,
    });
    check('fewer than two runs is invalid', r2.conclusion === 'invalid' && /at least 2/.test(r2.records[0]?.why ?? ''));
    const r3 = await runGate(gate, {
      repoRoot: repo, store: dctx.store, artifacts: dctx.artifacts, target: { kind: 'candidate', diffDigest: null }, materialise: ws,
    });
    check('a candidate run that names no diff is invalid', r3.conclusion === 'invalid');
    let disposed = false;
    const vanished = await throws(async () => {
      const r = await runGate(gate, {
        repoRoot: repo, store: dctx.store, artifacts: dctx.artifacts, target: { kind: 'base', diffDigest: null },
        materialise: () => {
          const w = ws();
          w.dispose();
          return { ...w, dispose: () => { disposed = true; } };
        },
      });
      check('a tree that vanishes after materialise is invalid, with the reason recorded',
        r.conclusion === 'invalid' && /tree under test cannot be read/.test(r.records[0]?.why ?? ''), r.records[0]?.why);
    });
    check('and runGate does not throw for it', vanished === null, vanished?.message);
    check('and the tree is still disposed of', disposed);
    const crash = registerGate(ctx, {
      missionId: newMission('crash').id, role: 'gate', basename: 'crash.test.js', prediction: { exitCode: 1, stdoutIncludes: ['# fail 1'] },
      testSource: "process.kill(process.ppid, 'SIGKILL');\n",
    });
    const r4 = await runGate(crash, { repoRoot: repo, store: dctx.store, artifacts: dctx.artifacts, target: { kind: 'base', diffDigest: null }, materialise: ws });
    check('a suite whose runner dies before its summary is invalid, not falsified', r4.conclusion === 'invalid'
      && r4.records.every((r) => r.status === 'invalid' && /no tests summary/.test(r.why ?? '')), `${r4.conclusion}: ${r4.records[0]?.why}`);
    const leftovers = fs.readdirSync(privateTmp).filter((n) => n.startsWith('daylight-forge-'));
    check('every tree a gate ran in was disposed of', leftovers.length === 0, leftovers.join());
  }

  section('a gate runner killed mid-run marks no row');
  {
    const m3 = newMission('sigkill');
    const sleeper = registerGate(ctx, {
      missionId: m3.id, role: 'gate', basename: 'slow.test.js', prediction: PASS,
      testSource: "require('node:test')('slow', () => new Promise((r) => setTimeout(r, 60000)));\n",
    });
    const before = dctx.store.gateEvaluations({ missionId: m3.id }).length;
    const script = path.join(tmp, 'kill-me.ts');
    fs.writeFileSync(script, [
      `import { openDaylight } from ${JSON.stringify(path.join(HERE, '..', 'mission', 'context.ts'))};`,
      `import { baseline } from ${JSON.stringify(path.join(HERE, '..', 'forge', 'gate.ts'))};`,
      `const d = openDaylight(${JSON.stringify(out)});`,
      'const events = { append: (e) => { if (e.name === "experiment.run.started") process.stdout.write("started\\n"); return d.events.append(e); } };',
      `await baseline({ store: d.store, artifacts: d.artifacts, events, repoRoot: ${JSON.stringify(repo)}, timeoutMs: 120000 }, ${JSON.stringify(m3.id)});`,
    ].join('\n'));
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: privateTmp } });
    const started = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 30_000);
      child.stdout.on('data', (b: Buffer) => {
        if (b.toString().includes('started')) {
          clearTimeout(t);
          resolve(true);
        }
      });
    });
    check('the child runner reached a sandboxed run', started);
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    sweepAbandoned({ repoRoot: repo, projectId: PROJECT.id, store: dctx.store });
    const reaped = dctx.store.reapPendingExperiments({ projectId: PROJECT.id, startedBefore: Date.now() + 1_000 });
    check('no gate evaluation row was written', dctx.store.gateEvaluations({ missionId: m3.id }).length === before);
    check('the sweep and the reaper leave the gate pending', dctx.store.experiment(sleeper.id)!.conclusion === 'pending' && !reaped.some((x) => x.id === sleeper.id));
    let lingering = '';
    try {
      lingering = execFileSync('pgrep', ['-f', 'slow.test.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      // pgrep exits 1 when nothing matches.
    }
    check('the sandboxed test died with its runner', lingering.trim() === '', lingering);
    // The workspace sweep is WS2's; the stub has none, so the dead runner's tree is removed here.
    for (const d of fs.readdirSync(privateTmp).filter((n) => n.startsWith('daylight-forge-'))) fs.rmSync(path.join(privateTmp, d), { recursive: true, force: true });
  }

  section('a lock that moves, or a gate edited after it, invalidates the candidate');
  {
    const c = candidate(writeAdd(FIXED), [FILE]);
    const raw = new DatabaseSync(path.join(out, 'daylight.db'));
    raw.prepare('UPDATE experiments SET prediction=? WHERE id=?').run(JSON.stringify({ exitCode: 0, stdoutIncludes: ['anything'] }), holdout.id);
    const edited = await evaluate(ctx, c.id);
    check('a holdout whose row was edited after the lock is gates-invalid', edited.verdict === 'gates-invalid'
      && gateRows(c).some((g) => g.experimentId === holdout.id && g.conclusion === 'invalid'), edited.verdict);
    raw.prepare('UPDATE experiments SET prediction=? WHERE id=?').run(JSON.stringify(PASS), holdout.id);
    raw.prepare('UPDATE experiments SET harness_digest=? WHERE id=?').run(D('f'), holdout.id);
    const restamped = await evaluate(ctx, c.id);
    check('one whose harness digest was rewritten is gates-invalid, naming the lock', restamped.verdict === 'gates-invalid'
      && restamped.verdictReasons.some((r) => r.includes('changed after the lock')), restamped.verdictReasons.join());
    raw.prepare('UPDATE experiments SET harness_digest=? WHERE id=?').run(holdout.harnessDigest, holdout.id);
    raw.close();
    const back = await evaluate(ctx, c.id);
    check('put back, it is accepted again', back.verdict === 'accepted-by-gates', back.verdictReasons.join('; '));

    const relock = lock(ctx, {
      missionId: mission.id, actor: HUMAN, rationale: 'gate only', experimentIds: [gate.id],
      confirm: confirmDigest(ctx, 'lock-gates', mission.id, { experimentIds: [gate.id] }).digest8,
    });
    check('a re-lock is a new decision', relock.id !== lockDecisionId && dctx.store.lockDecision(mission.id)?.id === relock.id);
    const stale = await evaluate(ctx, c.id);
    check('a candidate built against the earlier lock is gates-invalid', stale.verdict === 'gates-invalid'
      && stale.verdictReasons.some((r) => r.includes('gate set')), stale.verdictReasons.join());
  }
}

section('a holdout\'s basename reaches no event payload and no shared artifact (P2-R37)');
{
  const BASENAME = 'zz-withheld-holdout.test.js';
  const m = newMission('holdout redaction');
  const from = events.length;
  const h = registerGate(ctx, { missionId: m.id, role: 'holdout', testSource: HOLDOUT_TEST, basename: BASENAME, prediction: PASS });
  await baseline({ ...ctx, sandbox: UNAVAILABLE }, m.id, { experimentIds: [h.id] });
  if (live.available) await baseline(ctx, m.id, { experimentIds: [h.id] });
  const mine = events.slice(from);
  const reg = mine.find((e) => e.name === 'experiment.registered');
  check('experiment.registered is still written, its path redacted',
    !!reg && reg.payload.subject === '<holdout>' && (reg.payload.command as string[]).at(-1) === '<holdout>', JSON.stringify(reg?.payload));
  const leaks = mine.filter((e) => JSON.stringify(e.payload).includes(BASENAME));
  check('no event payload names the basename', mine.length > 2 && leaks.length === 0, JSON.stringify(leaks.map((e) => [e.name, e.payload])).slice(0, 800));
  const stored = dctx.events.forMission(m.id);
  check('nor does any stored event of the mission', stored.length > 0 && !stored.some((e) => JSON.stringify(e).includes(BASENAME)));
  const withheld = holdoutContent(dctx, [m.id]).artifacts;
  const dir = path.join(dctx.artifacts.dir, 'sha256');
  const shared = fs.readdirSync(dir).filter((f) => /^[0-9a-f]{64}$/.test(f) && !withheld.has(`sha256:${f}`));
  const named = shared.filter((f) => fs.readFileSync(path.join(dir, f)).includes(BASENAME));
  check('nor any artifact outside the holdout\'s withheld content', shared.length > 0 && named.length === 0, named.join());
  const refs = [...new Set(mine.flatMap((e) => e.artifactIds ?? []))].map((id) => dctx.store.artifact(id)).filter((a) => !!a && !withheld.has(a.id));
  check('and no artifact row an event names carries it as its path', refs.every((a) => !JSON.stringify(a).includes(BASENAME)));
  check('a gate\'s path is not redacted', named.length === 0 && events.some((e) => e.name === 'experiment.registered' && e.payload.subject === gate.testArtifact.path));
}

section('nothing is left behind');
{
  dctx.close();
  check('the real checkout is untouched', git(['rev-parse', 'HEAD']) === headBefore && git(['status', '--porcelain']) === statusBefore);
  const left = fs.readdirSync(privateTmp);
  check('no scratch tree lingers', left.length === 0, left.join());
  fs.rmSync(tmp, { recursive: true, force: true });
}

done();
