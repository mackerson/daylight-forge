/**
 * The experiment runner. Run: node engine/test/experiment.ts
 *
 * The runner is the one place this product executes anything, so the properties worth
 * testing are the ones that decide whether its results can be trusted: the test that runs is
 * the one that was registered, the sandbox actually confines, a ceiling actually kills, and a
 * run that could not be trusted is reported as such rather than quietly dropped.
 *
 * The sandbox cases run the real `bwrap` on this machine. Where it is not installed they are
 * skipped and said to be; the fail-closed cases run everywhere.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../mission/artifacts.ts';
import type {
  ArtifactRef, DaylightEventInput, ExpectedObservation, Experiment, ExperimentConclusion,
} from '../mission/types.ts';
import { concludeFrom, verdictOf } from '../experiment/conclude.ts';
import {
  commitOf, harnessDigestOf, registerExperiment, runExperiment, type ExperimentStoreLike,
} from '../experiment/runner.ts';
import {
  checkAllowlist, detectSandbox, nodeBind, nodeBinary, sandboxArgv, sandboxCommand,
} from '../experiment/sandbox.ts';
import type { ExecutionRecord } from '../experiment/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-experiment-'));

// ---- fixtures ------------------------------------------------------------------

class StubStore implements ExperimentStoreLike {
  rows = new Map<string, Experiment>();
  private n = 0;
  createExperiment(input: Omit<Experiment, 'id' | 'executions' | 'conclusion' | 'createdAt' | 'updatedAt'>): Experiment {
    const e: Experiment = { ...input, id: `x_${++this.n}`, executions: [], conclusion: 'pending', createdAt: 1, updatedAt: 1 };
    this.rows.set(e.id, e);
    return e;
  }
  updateExperiment(id: string, patch: { executions?: ArtifactRef[]; conclusion?: ExperimentConclusion; limitations?: string[] }): Experiment {
    const e = this.rows.get(id);
    if (!e) throw new Error(`no experiment ${id}`);
    const next = { ...e, ...patch, updatedAt: 2 };
    this.rows.set(id, next);
    return next;
  }
}

const events: DaylightEventInput[] = [];
const sink = { append: (e: DaylightEventInput) => { events.push(e); return e; } };
const named = (name: string, experimentId?: string) =>
  events.filter((e) => e.name === name && (!experimentId || e.payload.experimentId === experimentId));

const store = new StubStore();
const artifacts = new ArtifactStore(path.join(tmp, 'out'));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@daylight',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@daylight',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.mkdirSync(path.join(repo, 'test'));
const git = (args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(['init', '-q']);
fs.writeFileSync(path.join(repo, 'src', 'add.js'), 'module.exports = (a, b) => a + b;\n');
const SAME = 'console.log("same content as registered"); process.exit(0);\n';
fs.writeFileSync(path.join(repo, 'test', 'same.js'), SAME);
fs.writeFileSync(path.join(repo, 'test', 'tampered.js'), 'console.log("not what was registered"); process.exit(0);\n');
git(['add', '.']);
git(['commit', '-q', '-m', 'fixture']);
const commit = git(['rev-parse', 'HEAD']);

const worktreeCount = () => git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;
const strayDirs = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('daylight-experiment-')).length;
const straysBefore = strayDirs();

let seq = 0;
const register = (
  testSource: string, prediction: ExpectedObservation,
  extra: Partial<Parameters<typeof registerExperiment>[0]> = {},
) =>
  registerExperiment({
    store, artifacts, events: sink,
    missionId: 'm_test', projectId: 'git:fixture', baseRevision: commit,
    subject: 'src/add.js', predicate: 'bug_verdict', claimIds: [1, 2],
    hypothesis: 'the planted defect reproduces',
    prediction, testSource, testPath: `test/case${++seq}.js`, command: ['node', `test/case${seq}.js`],
    ...extra,
  });

const records = (e: Experiment): ExecutionRecord[] =>
  e.executions.filter((r) => r.kind === 'result').map((r) => JSON.parse(artifacts.text(r)) as ExecutionRecord);

const run = (e: Experiment, opts: Partial<Parameters<typeof runExperiment>[1]> = {}) =>
  runExperiment(e, { repoRoot: repo, store, artifacts, events: sink, ...opts });

const live = detectSandbox();
const UNAVAILABLE = { name: 'bwrap' as const, available: false, why: 'forced off by the test' };

// ---- pure pieces -----------------------------------------------------------------

section('the allowlist');
{
  const wt = path.join(tmp, 'wt');
  check('node on a file inside the worktree is allowed', checkAllowlist(['node', 'test/a.js'], wt).ok);
  check('flags are allowed', checkAllowlist(['node', '--test', 'test/a.js'], wt).ok);
  check('a flag with a value is allowed', checkAllowlist(['node', '--test-reporter=spec', 'test/a.js'], wt).ok);
  check('python3 is refused', !checkAllowlist(['python3', 'x.py'], wt).ok);
  check('a path outside the worktree is refused', !checkAllowlist(['node', '../x.js'], wt).ok);
  check('an absolute path outside is refused', !checkAllowlist(['node', '/etc/passwd'], wt).ok);
  check('an absolute path inside is allowed', checkAllowlist(['node', path.join(wt, 'test', 'a.js')], wt).ok);
  for (const flag of ['-e', '--eval', '-p', '-r', '--require', '--import', '--loader', '--inspect-brk=9229']) {
    check(`\`${flag}\` is refused`, !checkAllowlist(['node', flag, 'x'], wt).ok);
  }
  check('an empty command is refused', !checkAllowlist([], wt).ok);
  const mapped = sandboxCommand(['node', '--test', 'test/a.js', path.join(wt, 'src', 'b.js')], wt);
  check('inside the sandbox the command runs our own node', mapped[0] === nodeBinary());
  check('and paths are rewritten under /work',
    mapped.slice(1).join(' ') === '--test /work/test/a.js /work/src/b.js', mapped.join(' '));
}

section('the sandbox argv');
{
  const argv = sandboxArgv({ name: 'bwrap', available: true }, {
    worktree: path.join(tmp, 'wt'), command: ['node', 'test/a.js'], env: { DAYLIGHT_RUN_INDEX: '1' },
  });
  check('starts with prlimit then bwrap', argv[0] === 'prlimit' && argv.includes('bwrap'));
  check('every namespace is unshared', argv.includes('--unshare-all'));
  check('the sandbox dies with the runner', argv.includes('--die-with-parent'));
  check('the environment is cleared before anything is set', argv.indexOf('--clearenv') < argv.indexOf('--setenv'));
  check('the run index reaches the test', argv.join(' ').includes('--setenv DAYLIGHT_RUN_INDEX 1'));
  check('the worktree is bound read-only at /work', argv.join(' ').includes(`--ro-bind ${path.join(tmp, 'wt')} /work`));
  check('and nothing is bound read-write', !argv.some((a, i) => a === '--bind' && i > 0));
  check('address space is not limited (V8 would die at start-up)', !argv.some((a) => a.startsWith('--as')));
  check('cpu, file size and open files are', ['--cpu=', '--fsize=', '--nofile='].every((p) => argv.some((a) => a.startsWith(p))));
  const bind = nodeBind(nodeBinary());
  check('a node outside /usr gets its install dir bound, one under /usr does not',
    bind ? argv.join(' ').includes(`--ro-bind ${bind} ${bind}`) : !argv.join(' ').includes('--ro-bind /home'),
    String(bind));
  let threw = false;
  try { sandboxArgv(UNAVAILABLE, { worktree: tmp, command: ['node', 'x.js'] }); } catch { threw = true; }
  check('an unavailable profile cannot produce an argv at all', threw);
}

section('revisions');
{
  check('a commit is accepted', 'commit' in commitOf(commit));
  check('a dirty label is refused and says why', (commitOf(`${commit}+dirty`) as { why: string }).why.includes('uncommitted'));
  check('unversioned is refused', 'why' in commitOf('unversioned'));
  check('garbage is refused', 'why' in commitOf('not a sha'));
}

section('conclusions');
{
  const rec = (status: ExecutionRecord['status'], matches: boolean): ExecutionRecord => ({
    experimentId: 'x', runIndex: 0, status, command: [], sandboxArgv: [], sandboxProfile: 'bwrap',
    exitCode: 0, signal: null, timedOut: status === 'timeout', durationMs: 0, prediction: { exitCode: 0 },
    matchesPrediction: matches, harnessDigest: 'd', startedAt: 0, finishedAt: 0,
  });
  check('nothing ran → pending', concludeFrom([]) === 'pending');
  check('all match → supported', concludeFrom([rec('ran', true), rec('ran', true)]) === 'supported');
  check('none match → falsified', concludeFrom([rec('ran', false), rec('ran', false)]) === 'falsified');
  check('mixed → inconclusive (flaky)', concludeFrom([rec('ran', true), rec('ran', false)]) === 'inconclusive');
  check('one invalid poisons the set', concludeFrom([rec('ran', true), rec('invalid', false)]) === 'invalid');
  check('denied is invalid too', concludeFrom([rec('denied', false)]) === 'invalid');
  check('all timed out → inconclusive', concludeFrom([rec('timeout', false), rec('timeout', false)]) === 'inconclusive');
  check('a timeout beside a match is still inconclusive', concludeFrom([rec('timeout', false), rec('ran', true)]) === 'inconclusive');
  check('verdictOf names each case', verdictOf(rec('ran', true)) === 'match' && verdictOf(rec('ran', false)) === 'mismatch'
    && verdictOf(rec('timeout', false)) === 'timeout' && verdictOf(rec('denied', false)) === 'denied');
}

section('registration');
{
  const red = register('console.log("FAIL: expired session served"); process.exit(1);\n', { exitCode: 1, stdoutIncludes: ['FAIL'] });
  check('the test is stored as an artifact with its path', red.testArtifact.kind === 'test' && red.testArtifact.path === 'test/case1.js');
  check('the prediction is stored as an artifact', red.expectedArtifact.kind === 'expected'
    && JSON.parse(artifacts.text(red.expectedArtifact)).exitCode === 1);
  check('the harness digest covers test, prediction, command and profile',
    red.harnessDigest === harnessDigestOf(red.testArtifact.digest, red.expectedArtifact.digest, red.command, 'bwrap'));
  check('a different prediction is a different harness',
    harnessDigestOf(red.testArtifact.digest, artifacts.put('{"exitCode":0}', { kind: 'expected', projectId: 'p' }).digest, red.command, 'bwrap')
      !== red.harnessDigest);
  check('a different command is a different harness',
    harnessDigestOf(red.testArtifact.digest, red.expectedArtifact.digest, ['node', '--test', 'test/case1.js'], 'bwrap') !== red.harnessDigest);
  check('it starts pending with the sandbox limitations written down',
    red.conclusion === 'pending' && red.limitations.some((l) => l.includes('address space')));
  check('registration is an event', named('experiment.registered', red.id).length === 1);

  const refused = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
  check('an empty prediction is refused', refused(() => register('x', {})));
  check('python3 is refused at registration', refused(() => register('x', { exitCode: 0 }, { command: ['python3', 'x.py'] })));
  check('a path outside the worktree is refused', refused(() => register('x', { exitCode: 0 }, { command: ['node', '../x.js'] })));
  check('node -e is refused', refused(() => register('x', { exitCode: 0 }, { command: ['node', '-e', '1'] })));
  check('an absolute testPath is refused', refused(() => register('x', { exitCode: 0 }, { testPath: '/etc/x.js' })));
  check('a testPath that climbs out is refused', refused(() => register('x', { exitCode: 0 }, { testPath: '../x.js' })));
}

// ---- fail closed, everywhere -------------------------------------------------------

section('without a sandbox nothing runs');
{
  const e = register('process.exit(0);\n', { exitCode: 0 });
  const before = worktreeCount();
  const out = await run(e, { sandbox: UNAVAILABLE });
  check('the conclusion is invalid', out.conclusion === 'invalid', out.conclusion);
  const [r] = records(out);
  check('with one denied record saying why', r?.status === 'denied' && (r.why ?? '').includes('forced off'));
  check('no run was started', named('experiment.run.started', e.id).length === 0);
  check('no worktree was created', worktreeCount() === before);
  check('the limitation is on the experiment', out.limitations.some((l) => l.includes('sandbox unavailable')));
  check('concluded is still emitted', named('experiment.concluded', e.id).length === 1);
}

section('an unreproducible revision is refused before anything runs');
{
  const dirty = register('process.exit(0);\n', { exitCode: 0 }, { baseRevision: `${commit}+dirty` });
  const out = await run(dirty, { sandbox: { name: 'bwrap', available: true } });
  check('a dirty revision concludes invalid', out.conclusion === 'invalid');
  check('and says to commit first', records(out)[0]?.why?.includes('commit first') === true);
  check('no worktree was created for it', worktreeCount() === 1);
  const unv = register('process.exit(0);\n', { exitCode: 0 }, { baseRevision: 'unversioned' });
  check('unversioned concludes invalid', (await run(unv, { sandbox: { name: 'bwrap', available: true } })).conclusion === 'invalid');
}

section('the runtime allowlist is a second check');
{
  const e = register('process.exit(0);\n', { exitCode: 0 });
  // A row edited behind the store's back: the runner must not trust what registration checked.
  const edited = { ...e, command: ['python3', 'test/case.js'] };
  const out = await run(edited, { sandbox: { name: 'bwrap', available: true } });
  check('a command that is no longer allowed concludes invalid', out.conclusion === 'invalid');
  check('and the record names the refusal', records(out)[0]?.why?.includes('python3') === true);
  check('nothing was spawned', named('experiment.run.started', e.id).length === 0);
}

section('a committed symlink is never followed out of the worktree');
{
  // The author controls the tree at the base revision, so a link in it can point anywhere the
  // runner's uid can write. Placing the test must not follow it.
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'host file\n');
  fs.symlinkSync(outside, path.join(repo, 'linked'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'test', 'linked.js'));
  git(['add', '.']);
  git(['commit', '-q', '-m', 'symlinks']);
  const linkedCommit = git(['rev-parse', 'HEAD']);
  const avail = { sandbox: { name: 'bwrap' as const, available: true } };

  const viaDir = register('process.exit(0);\n', { exitCode: 0 }, {
    baseRevision: linkedCommit, testPath: 'linked/x.js', command: ['node', 'linked/x.js'],
  });
  const out = await run(viaDir, avail);
  check('a symlinked parent directory concludes invalid', out.conclusion === 'invalid', out.conclusion);
  check('and nothing was written outside the worktree', fs.readdirSync(outside).join() === 'secret.txt', fs.readdirSync(outside).join());
  check('the record names the symlink', /symlink/.test(records(out)[0]?.why ?? ''), records(out)[0]?.why);
  check('nothing ran', named('experiment.run.started', viaDir.id).length === 0);

  const atPath = register('process.exit(0);\n', { exitCode: 0 }, {
    baseRevision: linkedCommit, testPath: 'test/linked.js', command: ['node', 'test/linked.js'],
  });
  const out2 = await run(atPath, avail);
  check('a symlink at the test path itself concludes invalid, as a symlink', out2.conclusion === 'invalid'
    && /symlink/.test(records(out2)[0]?.why ?? ''), records(out2)[0]?.why);
  check('and the host file it points at is untouched', fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8') === 'host file\n');
}

section('the repository\'s own git hooks and config do not run on the host');
{
  // The runner checks out a worktree with the repository's config. A hook or fsmonitor set
  // there by anyone with write access to .git would otherwise run unsandboxed, as us.
  const marker = path.join(tmp, 'hook-ran');
  const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const fsmon = path.join(tmp, 'fsmonitor-ran');
  const fsmonScript = path.join(tmp, 'fsmonitor.sh');
  fs.writeFileSync(fsmonScript, `#!/bin/sh\ntouch ${JSON.stringify(fsmon)}\n`, { mode: 0o755 });
  git(['config', 'core.fsmonitor', fsmonScript]);
  const e = register('process.exit(0);\n', { exitCode: 0 });
  // Refused after the checkout, so the checkout happens and nothing is spawned.
  const out = await run({ ...e, command: ['python3', 'x.py'] }, { sandbox: { name: 'bwrap', available: true } });
  check('the run got as far as a checkout', /python3/.test(records(out)[0]?.why ?? ''), records(out)[0]?.why);
  check('a post-checkout hook in the repository did not fire', !fs.existsSync(marker));
  check('nor did a configured fsmonitor', !fs.existsSync(fsmon));
  fs.rmSync(hook);
  git(['config', '--unset', 'core.fsmonitor']);
}

// ---- the real sandbox -------------------------------------------------------------

if (!live.available) {
  console.log(`\nskipped: sandbox cases need bwrap and prlimit (${live.why})`);
} else {
  section('known red');
  {
    const e = register('console.log("FAIL: expired session served"); process.exit(1);\n', { exitCode: 1, stdoutIncludes: ['FAIL'] });
    const out = await run(e);
    check('a test that fails as predicted supports the hypothesis', out.conclusion === 'supported', out.conclusion);
    const rs = records(out);
    check('it ran twice', rs.length === 2 && rs.every((r) => r.status === 'ran'));
    check('both exited 1', rs.every((r) => r.exitCode === 1));
    check('both matched', rs.every((r) => r.matchesPrediction));
    check('stdout was captured as an artifact', rs.every((r) => r.stdoutRef && artifacts.text(r.stdoutRef).includes('FAIL')));
    check('every execution carries the harness digest', rs.every((r) => r.harnessDigest === e.harnessDigest));
    check('the worktree path is elided from the recorded argv',
      rs.every((r) => r.sandboxArgv.includes('<worktree>') && !r.sandboxArgv.some((a) => a.includes('daylight-experiment-'))));
    check('the run index was distinct per run', rs.map((r) => r.runIndex).join() === '0,1');
    check('started and finished events pair up', named('experiment.run.started', e.id).length === 2 && named('experiment.run.finished', e.id).length === 2);
    check('the result artifacts hang off the experiment', out.executions.filter((r) => r.kind === 'result').length === 2
      && out.executions.filter((r) => r.kind === 'log').length === 0);
    check('the worktree is gone', worktreeCount() === 1);
  }

  section('known green');
  {
    const src = 'console.log("ok"); process.exit(0);\n';
    const green = await run(register(src, { exitCode: 0, stdoutIncludes: ['ok'] }));
    check('a passing test with a passing prediction is supported', green.conclusion === 'supported');
    const wrong = await run(register(src, { exitCode: 1 }));
    check('the same test predicted to fail is falsified', wrong.conclusion === 'falsified', wrong.conclusion);
    check('with both runs recorded as mismatches', records(wrong).every((r) => r.status === 'ran' && !r.matchesPrediction));
    check('and the two experiments have different harness digests', green.harnessDigest !== wrong.harnessDigest);
  }

  section('flaky');
  {
    const e = register('process.exit(Number(process.env.DAYLIGHT_RUN_INDEX) % 2);\n', { exitCode: 0 });
    const out = await run(e);
    check('a test that disagrees with itself is inconclusive', out.conclusion === 'inconclusive', out.conclusion);
    const rs = records(out);
    check('the records show one match and one miss', rs[0]?.matchesPrediction === true && rs[1]?.matchesPrediction === false);
    check('and neither is marked invalid — the harness was fine, the test was not', rs.every((r) => r.status === 'ran'));
  }

  section('timeout');
  {
    const marker = `DAYLIGHT_TIMEOUT_MARKER_${process.pid}`;
    const e = register(`setTimeout(() => {}, 60000); console.log("${marker}");\n`, { exitCode: 0 });
    const t0 = Date.now();
    const out = await run(e, { runs: 1, timeoutMs: 1500 });
    const took = Date.now() - t0;
    check('a run past the ceiling is inconclusive', out.conclusion === 'inconclusive', out.conclusion);
    const [r] = records(out);
    check('recorded as a timeout', r?.status === 'timeout' && r.timedOut);
    check('the ceiling was enforced, not waited out', took < 8000, `${took}ms`);
    let lingering = '';
    try {
      lingering = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      // pgrep exits 1 when nothing matches, which is the answer we want.
    }
    check('the sandboxed process is actually gone', lingering.trim() === '', lingering);
  }

  section('tamper');
  {
    const e = register('console.log("registered"); process.exit(0);\n', { exitCode: 0 }, {
      testPath: 'test/tampered.js', command: ['node', 'test/tampered.js'],
    });
    const out = await run(e);
    check('a worktree holding a different file at the test path is refused', out.conclusion === 'invalid', out.conclusion);
    check('and says the registered artifact is the protected one', records(out)[0]?.why?.includes('protected') === true);
    check('nothing ran', named('experiment.run.started', e.id).length === 0);

    const same = register(SAME, { exitCode: 0, stdoutIncludes: ['same content'] }, {
      testPath: 'test/same.js', command: ['node', 'test/same.js'],
    });
    check('an identical file already there is fine', (await run(same)).conclusion === 'supported');
  }

  section('an edited experiment row does not match its harness digest');
  {
    // The row says which artifact is the test and what counts as a match; it lives in a
    // database the same uid can UPDATE. The runner re-derives the digest instead of trusting it.
    const e = register('console.log("ok");\n', { exitCode: 0, stdoutIncludes: ['ok'] });
    const prediction = await run({ ...e, prediction: { exitCode: 0, stdoutIncludes: ['anything'] } }, { runs: 1 });
    check('a rewritten prediction concludes invalid', prediction.conclusion === 'invalid', prediction.conclusion);
    check('and says the harness digest no longer holds', /harness digest/.test(records(prediction)[0]?.why ?? ''), records(prediction)[0]?.why);
    const moved = await run({ ...e, testArtifact: { ...e.testArtifact, path: 'test/elsewhere.js' } }, { runs: 1 });
    check('a rewritten test path concludes invalid', moved.conclusion === 'invalid', moved.conclusion);
    check('nothing ran for either', named('experiment.run.started', e.id).length === 0);
    check('the untouched row still runs', (await run(e, { runs: 1 })).conclusion === 'supported');
    check('the registered expectation names the test path', JSON.parse(artifacts.text(e.expectedArtifact)).testPath === e.testArtifact.path);
    const legacyExpected = artifacts.put(JSON.stringify(e.prediction, null, 2), { kind: 'expected', projectId: e.projectId });
    const legacy = await run({
      ...e, expectedArtifact: legacyExpected,
      harnessDigest: harnessDigestOf(e.testArtifact.digest, legacyExpected.digest, e.command, e.sandboxProfile),
    }, { runs: 1 });
    check('a row registered before the path was covered still runs, and says so',
      legacy.conclusion === 'supported' && legacy.limitations.some((l) => l.includes('test path was covered')), legacy.conclusion);
  }

  section('a bwrap or prlimit earlier on PATH is not the sandbox');
  {
    // ~/.local/bin precedes /usr/bin on most desktops and is writable by the same uid; a shim
    // there that execs its last argv is a complete bypass the recorded argv would not show.
    const shims = path.join(tmp, 'shims');
    const marker = path.join(tmp, 'shim-ran');
    fs.mkdirSync(shims);
    for (const bin of ['bwrap', 'prlimit']) {
      fs.writeFileSync(path.join(shims, bin), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });
    }
    const savedPath = process.env.PATH;
    process.env.PATH = `${shims}:${savedPath}`;
    try {
      const profile = detectSandbox();
      check('detection resolves bwrap under /usr/bin, not from PATH', profile.available && profile.bwrap?.startsWith('/usr/bin/') === true, profile.bwrap);
      const e = register('console.log("in the sandbox");\n', { exitCode: 0, stdoutIncludes: ['in the sandbox'] });
      const out = await run(e, { runs: 1, sandbox: profile });
      check('the run went through the real sandbox', out.conclusion === 'supported', out.conclusion);
      check('and no shim ran', !fs.existsSync(marker));
      check('the result records the binaries that were used', records(out)[0]?.sandboxBinaries?.prlimit.startsWith('/usr/bin/') === true);
    } finally {
      process.env.PATH = savedPath;
    }
  }

  section('tamper between runs');
  {
    // A same-uid process rewriting the worktree copy after the first run: what runs second
    // must still be the registered bytes, and the rewrite must poison the experiment.
    const e = register('console.log("registered bytes");\n', { exitCode: 0, stdoutIncludes: ['TAMPERED'] });
    const rel = e.testArtifact.path!;
    const tamperer = {
      append: (ev: DaylightEventInput) => {
        sink.append(ev);
        if (ev.name !== 'experiment.run.finished' || ev.payload.runIndex !== 0) return ev;
        for (const d of fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('daylight-experiment-'))) {
          const f = path.join(os.tmpdir(), d, 'work', rel);
          if (fs.existsSync(f)) {
            fs.chmodSync(f, 0o644);
            fs.writeFileSync(f, 'console.log("TAMPERED — unregistered code ran");\n');
          }
        }
        return ev;
      },
    };
    const out = await run(e, { events: tamperer });
    const rs = records(out);
    check('a rewrite between runs concludes invalid, not inconclusive or supported', out.conclusion === 'invalid', out.conclusion);
    check('the second run still executed the registered bytes',
      !!rs[1]?.stdoutRef && !artifacts.text(rs[1].stdoutRef).includes('TAMPERED'), rs[1]?.stdoutRef ? artifacts.text(rs[1].stdoutRef) : 'no stdout');
    check('and its record says the worktree copy changed', /changed/.test(rs[1]?.why ?? ''), rs[1]?.why);
  }

  section('the sandbox confines');
  {
    const net = register(
      'fetch("http://127.0.0.1:1").then(() => console.log("net ok"), (e) => console.log("net fail", e.cause?.code ?? e.message));\n',
      { exitCode: 0, stdoutIncludes: ['net fail'] },
    );
    const t0 = Date.now();
    const out = await run(net, { runs: 1 });
    check('a connection attempt fails inside --unshare-net', out.conclusion === 'supported', artifacts.text(records(out)[0].stdoutRef!));
    check('quickly, rather than hanging on a route that does not exist', Date.now() - t0 < 5000);

    const ro = register(
      'try { require("fs").writeFileSync("/work/x", "y"); console.log("wrote") } catch (e) { console.log("refused", e.code) }\n',
      { exitCode: 0, stdoutIncludes: ['refused EROFS'] },
    );
    check('the worktree is read-only inside the sandbox', (await run(ro, { runs: 1 })).conclusion === 'supported');

    const env = register(
      'console.log("env", Object.keys(process.env).sort().join(","));\n',
      { exitCode: 0, stdoutIncludes: ['env DAYLIGHT_EXPERIMENT,DAYLIGHT_RUN_INDEX,HOME,PATH'] },
    );
    const envOut = await run(env, { runs: 1 });
    check('the environment inside is exactly what the runner set', envOut.conclusion === 'supported',
      artifacts.text(records(envOut)[0].stdoutRef!));

    const which = register('console.log("node", process.version);\n', { exitCode: 0, stdoutIncludes: [`node ${process.version}`] });
    check('the test runs on the same node as the harness', (await run(which, { runs: 1 })).conclusion === 'supported');
  }

  section('forced off, every registered experiment is refused');
  {
    const before = worktreeCount();
    let allInvalid = true;
    for (const e of store.rows.values()) {
      const out = await run({ ...e, executions: [] }, { sandbox: UNAVAILABLE });
      if (out.conclusion !== 'invalid' || records(out).some((r) => r.status !== 'denied')) allInvalid = false;
    }
    check('without a sandbox every experiment concludes invalid with a denied record', allInvalid);
    check('and none of them created a worktree', worktreeCount() === before);
  }
}

section('nothing is left behind');
{
  check('the repository has only its own worktree', worktreeCount() === 1, String(worktreeCount()));
  check('no experiment directory lingers in tmp', strayDirs() === straysBefore, `${strayDirs()} vs ${straysBefore}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
