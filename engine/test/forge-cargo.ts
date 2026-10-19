/**
 * Cargo inside the sandbox: the crate snapshot, the two build caches and cargo gates.
 * Run: node engine/test/forge-cargo.ts
 *
 * What has to hold: `deps snapshot` records a digest of what `cargo fetch --locked` fetched and
 * the Cargo.lock it was fetched for; a cargo gate runs `cargo test` in bwrap with no network
 * against that snapshot read-only, fails on a base that lacks the function and passes on a diff
 * that adds it; the author's `run` tool builds against the same snapshot into its own cache, and
 * the gates' cache is never mounted there; a Cargo.lock that is not the snapshot's is refused
 * in one line naming the command; `wipeAuthorCache` removes the author cache and nothing else,
 * and `forge run` calls it when a candidate breaks policy; no mount is ever `$HOME` or `<out>`.
 *
 * Mocks only: no provider binary runs. The one real thing run is `/usr/bin/cargo` on the
 * fixture under fixtures/cargo-workspace/. bwrap is required: without it this file fails, it
 * does not skip, like forge-e2e. The snapshot is fetched from crates.io once, below, in the step
 * labelled NETWORK; with DAYLIGHT_OFFLINE=1 everything from there on is skipped, said in one line.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { noCargoTestsReported } from '../experiment/runner.ts';
import { checkAllowlist, DEFAULT_LIMITS, detectSandbox, sandboxCommand } from '../experiment/sandbox.ts';
import type { ExecutionRecord } from '../experiment/types.ts';
import {
  cargoConfigRefusal, cargoMounts, CargoRefused, createSnapshot, gateCacheDir, gateCacheKey, lockDigestOf, readSnapshot, snapshotDigest, snapshotDir, snapshotFile, snapshotRefusal,
  snapshotStatus, targetDir, wipeAuthorCache,
} from '../forge/cargo.ts';
import { DIFF_FLAGS } from '../forge/diff.ts';
import {
  baseline, CARGO_GATE_LIMITS, CARGO_GATE_TIMEOUT_MS, cargoTargetOf, DEFAULT_CARGO_GATE_COMMAND, evaluate, GateRefused, lock, registerGate, type GateContext,
} from '../forge/gate.ts';
import { checkPolicy } from '../forge/policy.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { execLaunch, mountRefusal, runExec, SandboxRefused } from '../forge/sandbox.ts';
import { createWorkspace, siblingGit, type Workspace } from '../forge/workspace.ts';
import { openDaylight } from '../mission/context.ts';
import { identifyProject } from '../mission/project.ts';
import type { Attempt, Candidate, CandidateFile, Experiment, GateEvaluation, Mission } from '../mission/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const ENGINE = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ENGINE, 'cli.ts');
const FIXTURE = path.resolve(ENGINE, '..', 'fixtures', 'cargo-workspace');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-forge-cargo-')));
const privateTmp = path.join(tmp, 'tmp');
fs.mkdirSync(privateTmp, { mode: 0o700 });
process.env.TMPDIR = privateTmp;
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const throws = async (fn: () => unknown): Promise<Error | null> => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};
const listing = (dir: string): string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).sort() : []);

section('preflight: the sandbox and the toolchain this depends on');
const live = detectSandbox();
check('bwrap and prlimit are installed (without them this file fails, never skips)', live.available, live.why);
const cargoBin = fs.statSync('/usr/bin/cargo', { throwIfNoEntry: false });
check('the system cargo is at /usr/bin/cargo', !!cargoBin?.isFile());
if (!live.available || !cargoBin?.isFile()) done();

// ---- the cargo allowlist, pure ----------------------------------------------------------

section('the cargo allowlist');
{
  const ok = (c: string[]) => checkAllowlist(c, '/work', 'cargo').ok;
  const why = (c: string[]) => {
    const r = checkAllowlist(c, '/work', 'cargo');
    return r.ok ? '' : r.why;
  };
  const target = cargoTargetOf('x_0123abcd');
  const cmd = DEFAULT_CARGO_GATE_COMMAND.map((a) => (a === '{test}' ? target : a));
  check('the default cargo gate command is admitted', ok(cmd), why(cmd));
  check('so are -p, --package=, --lib, --locked, --frozen, --release', ok(['cargo', 'test', '-p', 'fixture-core', '--package=fixture-app', '--lib', '--locked', '--frozen', '--release']));
  check('a manifest inside the worktree is admitted', ok(['cargo', 'test', '--manifest-path', 'crates/core/Cargo.toml']));
  check('only cargo test', !ok(['cargo', 'build']) && !ok(['cargo', 'run']) && !ok(['cargo']));
  check('--config is refused, by name', /--config/.test(why(['cargo', 'test', '--config', 'net.offline=false'])) && !ok(['cargo', 'test', '--config=x']));
  check('-Z is refused, attached or not', !ok(['cargo', 'test', '-Z', 'unstable-options']) && !ok(['cargo', 'test', '-Zbuild-std']));
  check('a manifest outside the worktree is refused', /outside the worktree/.test(why(['cargo', 'test', '--manifest-path', '../other/Cargo.toml']))
    && !ok(['cargo', 'test', '--manifest-path=/etc/Cargo.toml']));
  check('a manifest that is not a Cargo.toml is refused', !ok(['cargo', 'test', '--manifest-path', 'build.rs']));
  check('--target-dir, which would move the build out of its cache, is refused', !ok(['cargo', 'test', '--target-dir', '/work/t']));
  check('an unknown flag is refused', !ok(['cargo', 'test', '--features', 'x']) && !ok(['cargo', 'test', '--all-targets']));
  check('a bare test-name filter is refused', !ok(['cargo', 'test', 'some_test']));
  check('after --, only --test-threads=N', ok(['cargo', 'test', '--', '--test-threads=4']) && !ok(['cargo', 'test', '--', '--nocapture'])
    && !ok(['cargo', 'test', '--', '--test-threads=0']) && !ok(['cargo', 'test', '--', '--test-threads=4', 'filter']));
  check('an option-shaped package or target name is refused (-p --config, --package=--config, --test --config, -p -Zunstable-options)',
    !ok(['cargo', 'test', '-p', '--config']) && !ok(['cargo', 'test', '--package=--config']) && !ok(['cargo', 'test', '--test', '--config'])
    && !ok(['cargo', 'test', '-p', '-Zunstable-options']));
  check('two --test flags are refused', !ok(['cargo', 'test', '--test', 'a', '--test', 'b']) && !ok(['cargo', 'test', '--test=a', '--test', 'b']));
  check('a --test name that is not a plain target name is refused', !ok(['cargo', 'test', '--test', '../x']) && !ok(['cargo', 'test', '--test']));
  check('the node harness refuses cargo', /cargo harness/.test((() => { const r = checkAllowlist(cmd, '/work'); return r.ok ? '' : r.why; })()));
  check('the cargo harness refuses node', !checkAllowlist(['node', '--test', 'a.js'], '/work', 'cargo').ok);
  check('inside the sandbox it is the system cargo, its manifest path under /work',
    JSON.stringify(sandboxCommand(['cargo', 'test', '--manifest-path', 'crates/core/Cargo.toml', '--manifest-path=a/Cargo.toml'], '/host/tree', 'cargo'))
      === JSON.stringify(['/usr/bin/cargo', 'test', '--manifest-path', '/work/crates/core/Cargo.toml', '--manifest-path=/work/a/Cargo.toml']));
}

section('reading a cargo run');
{
  const t = 'daylight_x_1';
  const ran = `     Running tests/${t}.rs (/cargo-target/debug/deps/${t}-0123)\n`;
  check('an ok result with tests is readable', noCargoTestsReported('test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n', ran, t) === null);
  check('a FAILED result is readable: it is a failing gate', noCargoTestsReported('test result: FAILED. 0 passed; 1 failed; 0 ignored;\n', ran, t) === null);
  check('0 passed, 0 failed is vacuous, so unreadable', /0 tests/.test(noCargoTestsReported('test result: ok. 0 passed; 0 failed; 0 ignored;\n', ran, t) ?? ''));
  check('a result with no Running line for the placed test is unreadable', /not the placed test/.test(noCargoTestsReported('test result: ok. 2 passed; 0 failed;\n', '', t) ?? ''));
  check('a Running line for another file under the target\'s name is unreadable',
    /not the placed test/.test(noCargoTestsReported('test result: ok. 2 passed; 0 failed;\n', `     Running src/evil.rs (/cargo-target/debug/deps/${t}-0)\n`, t) ?? ''));
  check('the gate\'s own target not compiling is a failing gate',
    noCargoTestsReported('', 'error[E0425]: cannot find function\n --> crates/core/tests/daylight_x_1.rs:2:43\nerror: could not compile `fixture-core` (test "daylight_x_1") due to 1 previous error\n', t) === null);
  check('a compile error with no rustc diagnostic located in the placed test is unreadable',
    noCargoTestsReported('', 'error[E0425]: cannot find function\n --> crates/core/src/lib.rs:2:43\nerror: could not compile `fixture-core` (test "daylight_x_1") due to 1 previous error\n', t) !== null);
  check('a linker killed by a file-size limit is unreadable, never a failing gate',
    /resource limit/.test(noCargoTestsReported('', 'error: linking with `cc` failed: exit status: 1\n  = note: collect2: fatal error: ld terminated with signal 25 [File size limit exceeded]\n --> tests/daylight_x_1.rs:1:1\nerror: could not compile `fixture-core` (test "daylight_x_1") due to 1 previous error\n', t) ?? ''));
  check('a test binary killed by SIGXCPU is unreadable', /resource limit/.test(noCargoTestsReported('test result: ok. 1 passed; 0 failed;\n',
    `     Running tests/${t}.rs (/x)\nerror: test failed, to rerun pass \`--test ${t}\`\nCaused by:\n  process didn't exit successfully: \`/x\` (signal: 24, SIGXCPU: CPU time limit exceeded)\n`, t) ?? ''));
  check('cargo itself killed by a signal is unreadable', /SIGKILL/.test(noCargoTestsReported('', '', t, 'SIGKILL') ?? ''));
  check('another unit not compiling is unreadable', noCargoTestsReported('', 'error: could not compile `fixture-core` (lib) due to 1 previous error\n', t) !== null);
  check('another target with a longer name is not mistaken for the gate\'s',
    noCargoTestsReported('', 'error: could not compile `c` (test "daylight_x_10") due to 1 previous error\n', t) !== null);
  check('no output at all is unreadable', noCargoTestsReported('', 'error: failed to download\n', t) !== null);
}

section('mounts under <out> and $HOME');
{
  const home = path.join(tmp, 'home');
  const out = path.join(home, '.local', 'share', 'daylight', 'git-p', 'c0ffee00');
  const snap = path.join(out, 'cargo', 'snapshot');
  const author = path.join(out, 'cargo', 'target', 'author');
  fs.mkdirSync(snap, { recursive: true });
  fs.mkdirSync(author, { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  const r = (src: string, outAllow?: string[]) => mountRefusal(src, { home, out, allow: [src], ...(outAllow ? { outAllow } : {}) });
  check('without outAllow the snapshot under <out> is refused', r(snap) !== null);
  check('with outAllow naming it exactly, the snapshot passes', r(snap, [snap]) === null, String(r(snap, [snap])));
  check('and so does the author cache', r(author, [author]) === null, String(r(author, [author])));
  check('<out> itself is refused even when named in outAllow', r(out, [out]) !== null);
  check('outAllow naming one directory does not admit its parent', r(path.join(out, 'cargo'), [snap]) !== null);
  check('outAllow naming one directory does not admit its sibling', r(author, [snap]) !== null);
  check('a credential store is refused whatever outAllow says', r(path.join(home, '.ssh'), [path.join(home, '.ssh')]) !== null);
  check('the home directory itself is refused', r(home, [home]) !== null);
  const sshOut = path.join(home, '.ssh', 'out');
  const sshSnap = path.join(sshOut, 'cargo', 'snapshot');
  fs.mkdirSync(sshSnap, { recursive: true });
  check('an <out> under ~/.ssh does not make its snapshot bindable', mountRefusal(sshSnap, { home, out: sshOut, allow: [sshSnap], outAllow: [sshSnap] }) !== null);
  const homeSnap = path.join(home, 'cargo', 'snapshot');
  fs.mkdirSync(homeSnap, { recursive: true });
  check('nor does an <out> that is $HOME itself', mountRefusal(homeSnap, { home, out: home, allow: [homeSnap], outAllow: [homeSnap] }) !== null);
}

section('the snapshot digest and the author cache wipe, on a synthetic <out>');
{
  const out = path.join(tmp, 'synthetic-out');
  const snap = snapshotDir(out);
  fs.mkdirSync(path.join(snap, 'registry', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(snap, 'registry', 'cache', 'a.crate'), 'a');
  fs.writeFileSync(path.join(snap, '.package-cache'), 'lock');
  const d1 = snapshotDigest(snap);
  fs.writeFileSync(path.join(snap, '.package-cache'), 'lock, rewritten');
  check('cargo\'s own lock files beside registry/ are not part of the digest', snapshotDigest(snap).digest === d1.digest && d1.files === 1);
  fs.writeFileSync(path.join(snap, 'registry', 'cache', 'a.crate'), 'b');
  check('a changed crate changes the digest', snapshotDigest(snap).digest !== d1.digest);
  fs.mkdirSync(path.join(snap, 'git', 'db'), { recursive: true });
  fs.writeFileSync(path.join(snap, 'git', 'db', 'x'), 'x');
  check('git/ is covered too', snapshotDigest(snap).files === 2);
  check('cargoMounts refuses an <out> with no recorded snapshot, naming the command',
    (() => { try { cargoMounts('gate', out); return ''; } catch (err) { return err instanceof CargoRefused ? err.message : ''; } })().includes('daylight deps snapshot'));
  check('cargoMounts refuses a relative <out>', (() => { try { cargoMounts('gate', 'rel/out'); return false; } catch (err) { return err instanceof CargoRefused; } })());
  fs.mkdirSync(path.join(targetDir(out, 'author'), 'debug'), { recursive: true });
  fs.writeFileSync(path.join(targetDir(out, 'author'), 'debug', 'x'), 'x');
  fs.mkdirSync(targetDir(out, 'gate'), { recursive: true });
  fs.writeFileSync(path.join(targetDir(out, 'gate'), 'y'), 'y');
  fs.writeFileSync(path.join(out, 'daylight.db'), 'not touched');
  check('wipeAuthorCache says it removed something', wipeAuthorCache(out) === true);
  check('the author cache is gone', !fs.existsSync(targetDir(out, 'author')));
  check('the gate cache, the snapshot and the rest of <out> are not',
    fs.readFileSync(path.join(targetDir(out, 'gate'), 'y'), 'utf8') === 'y' && fs.existsSync(path.join(snap, 'registry', 'cache', 'a.crate'))
    && fs.readFileSync(path.join(out, 'daylight.db'), 'utf8') === 'not touched');
  check('wiping again is a no-op', wipeAuthorCache(out) === false);
  const victim = path.join(tmp, 'victim');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep'), 'keep');
  fs.symlinkSync(victim, targetDir(out, 'author'));
  wipeAuthorCache(out);
  check('an author cache that is a symlink is removed as a link; what it pointed at is kept',
    !fs.existsSync(targetDir(out, 'author')) && fs.readFileSync(path.join(victim, 'keep'), 'utf8') === 'keep');
}

section('deps snapshot reads no ancestor config and refuses what would leave the repository (P2-R29); no network');
{
  const crate = (dir: string, name: string, deps = '', lockExtra = '') => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n${deps}`);
    fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), 'pub fn one() -> u8 { 1 }\n');
    fs.writeFileSync(path.join(dir, 'Cargo.lock'), `version = 4\n\n[[package]]\nname = "${name}"\nversion = "0.1.0"\n${lockExtra}`);
  };
  const anc = path.join(tmp, 'ancestor');
  const nested = path.join(anc, 'sub', 'repo');
  crate(nested, 'nodeps');
  fs.mkdirSync(path.join(anc, '.cargo'));
  fs.writeFileSync(path.join(anc, '.cargo', 'config.toml'), '[build]\nrustc = "/usr/bin/false"\n[source.crates-io]\nreplace-with = "nowhere"\n[source.nowhere]\ndirectory = "/nonexistent"\n');
  const control = spawnSync('/usr/bin/cargo', ['fetch', '--locked', '--manifest-path', path.join(nested, 'Cargo.toml')], {
    cwd: nested, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(tmp, 'anc-home'), CARGO_HOME: path.join(tmp, 'anc-home') },
  });
  check('control: from inside the repository, cargo does read that ancestor config', control.status !== 0 && /\/usr\/bin\/false/.test(control.stderr), control.stderr.slice(-300));
  const r1 = await throws(() => createSnapshot(nested, path.join(tmp, 'anc-out')));
  check('an ancestor .cargo/config.toml naming build.rustc=/usr/bin/false is not read by the fetch', r1 === null, r1?.message);
  check('and the snapshot was recorded', readSnapshot(path.join(tmp, 'anc-out'))?.lockDigest === lockDigestOf(nested));

  const withRustc = path.join(tmp, 'repo-rustc');
  crate(withRustc, 'nodeps');
  fs.mkdirSync(path.join(withRustc, '.cargo'));
  fs.writeFileSync(path.join(withRustc, '.cargo', 'config.toml'), '[build]\nrustflags = ["-Cdebuginfo=0"]\nrustc = "/usr/bin/false"\n');
  const r2 = await throws(() => createSnapshot(withRustc, path.join(tmp, 'rustc-out')));
  check('a repository .cargo/config.toml setting build.rustc is refused, naming the key',
    r2 instanceof CargoRefused && /sets build\.rustc\b/.test(r2.message) && !fs.existsSync(snapshotFile(path.join(tmp, 'rustc-out'))), r2?.message);
  fs.writeFileSync(path.join(withRustc, '.cargo', 'config.toml'), '[build]\nrustflags = ["-Cdebuginfo=0"]\n[profile.dev]\nopt-level = 1\n[alias]\nb = "build"\n');
  check('the tolerated keys pass', (await throws(() => createSnapshot(withRustc, path.join(tmp, 'rustc-out')))) === null);
  fs.writeFileSync(path.join(withRustc, '.cargo', 'config.toml'), 'net = { offline = false }\n');
  check('an inline table is read too', /sets net\.offline|sets net\b/.test((await throws(() => createSnapshot(withRustc, path.join(tmp, 'rustc-out'))))?.message ?? ''));

  const outside = path.join(tmp, 'outside-crate');
  crate(outside, 'outside');
  const withPath = path.join(tmp, 'repo-path-dep');
  crate(withPath, 'pathdep', `outside = { path = "${outside}" }\n`, `dependencies = [\n "outside",\n]\n\n[[package]]\nname = "outside"\nversion = "0.1.0"\n`);
  const r3 = await throws(() => createSnapshot(withPath, path.join(tmp, 'path-out')));
  check('a path dependency outside the repository is refused, naming it', r3 instanceof CargoRefused && /outside/.test(r3.message) && r3.message.includes(outside), r3?.message);

  const withPatch = path.join(tmp, 'repo-patch');
  crate(withPatch, 'patched');
  fs.appendFileSync(path.join(withPatch, 'Cargo.toml'), '\n[patch.crates-io]\nitoa = { path = "vendor/itoa" }\n');
  const r4 = await throws(() => createSnapshot(withPatch, path.join(tmp, 'patch-out')));
  check('a [patch] is refused', r4 instanceof CargoRefused && /\[patch\]/.test(r4.message), r4?.message);

  const withGit = path.join(tmp, 'repo-git');
  crate(withGit, 'gitdep', '', 'dependencies = [\n "x",\n]\n\n[[package]]\nname = "x"\nversion = "0.1.0"\nsource = "git+https://example.invalid/x#0000"\n');
  const r5 = await throws(() => createSnapshot(withGit, path.join(tmp, 'git-out')));
  check('a git dependency in the lock is refused', r5 instanceof CargoRefused && /git dependenc/.test(r5.message), r5?.message);
  check('cargoConfigRefusal refuses a .cargo that is a symlink', (() => {
    const d = path.join(tmp, 'linked-cargo');
    fs.mkdirSync(d);
    fs.symlinkSync(path.join(anc, '.cargo'), path.join(d, '.cargo'));
    return /link/.test(cargoConfigRefusal(d) ?? '');
  })());
}

// ---- the fixture repository -----------------------------------------------------------------

const baseEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) baseEnv[k] = v;
delete baseEnv.CLAUDECODE;
delete baseEnv.DAYLIGHT_SESSION;
delete baseEnv.DAYLIGHT_MOCK_ADAPTER;
delete baseEnv.XDG_RUNTIME_DIR;
baseEnv.TMPDIR = privateTmp;
const run = (args: string[], o: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...baseEnv, ...o }, timeout: 600_000 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const json = <T>(r: { out: string; err: string }): T => {
  try {
    return JSON.parse(r.out) as T;
  } catch {
    throw new Error(`not JSON: ${r.out.slice(0, 400)} ${r.err.slice(-600)}`);
  }
};

const repo = path.join(tmp, 'repo');
const out = path.join(tmp, 'out');
fs.cpSync(FIXTURE, repo, { recursive: true });
const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
  encoding: 'utf8', env: { ...baseEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
}).trim();
git(['init', '-q', '-b', 'main']);
git(['add', '-A']);
git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@daylight.invalid', 'commit', '-q', '-m', 'a workspace without padded()']);
const commit = git(['rev-parse', 'HEAD']);

if (process.env.DAYLIGHT_OFFLINE === '1') {
  console.log('\nskipped: the snapshot, gate and exec cases need one cargo fetch from crates.io, and DAYLIGHT_OFFLINE=1');
  done();
}

section('map the fixture, then NETWORK: deps snapshot fetches itoa 1.0.11 from crates.io on the host');
{
  const mapped = run(['map', repo, '--out', out, '--top', '0']);
  check('the fixture maps', mapped.code === 0, mapped.err.slice(-300));
  const before = run(['deps', 'status', repo, '--out', out, '--format', 'json']);
  const b = json<{ recorded: unknown; refusal: string }>(before);
  check('before a snapshot, status runs and says what to run', before.code === 0 && b.recorded === null
    && b.refusal.includes(`daylight deps snapshot ${repo} --out ${out}`), b.refusal);
  // NETWORK: the only step in this file that leaves the machine. cargo fetch --locked, run on
  // the host with CARGO_HOME at <out>/cargo/snapshot, downloads the crates.io index entry and
  // the itoa 1.0.11 crate the fixture's Cargo.lock pins.
  const snap = run(['deps', 'snapshot', repo, '--out', out, '--format', 'json']);
  const rec = snap.code === 0 ? json<{ digest: string; lockDigest: string; files: number }>(snap) : null;
  check('deps snapshot ran', snap.code === 0, snap.err.slice(-400));
  if (!rec) throw new Error(`deps snapshot failed, so nothing below can run: ${snap.err.slice(-400)}`);
  check('it created <out>/cargo/snapshot with the fetched crate in it', fs.readdirSync(path.join(snapshotDir(out), 'registry', 'cache'), { recursive: true })
    .some((f) => String(f).endsWith('itoa-1.0.11.crate')));
  check('and recorded the digest, which is the snapshot\'s', readSnapshot(out)?.digest === rec.digest && snapshotDigest(snapshotDir(out)).digest === rec.digest);
  check('with the repository\'s Cargo.lock digest', rec.lockDigest === lockDigestOf(repo) && /^sha256:[0-9a-f]{64}$/.test(rec.lockDigest));
  check('in <out>/cargo/snapshot.json', fs.existsSync(snapshotFile(out)));
  check('nothing was written into the repository', git(['status', '--porcelain', '--untracked-files=all']) === '');
  const st = json<{ lockMatches: boolean; intact: boolean; refusal: string | null; caches: { author: number; gate: number } }>(
    run(['deps', 'status', repo, '--out', out, '--format', 'json']));
  check('status: the lock matches and the snapshot is intact', st.lockMatches && st.intact === true && st.refusal === null, JSON.stringify(st));
  check('status reports both caches, empty', st.caches.author === 0 && st.caches.gate === 0);
  const text = run(['deps', 'status', repo, '--out', out]);
  check('the plain status names the digest and the match', text.code === 0 && text.out.includes(rec.digest) && /Cargo\.lock sha256:\S+ matches/.test(text.out), text.out);
  const lockFile = path.join(repo, 'Cargo.lock');
  const lock = fs.readFileSync(lockFile);
  fs.appendFileSync(lockFile, '\n');
  const changed = json<{ lockMatches: boolean; refusal: string | null }>(run(['deps', 'status', repo, '--out', out, '--format', 'json']));
  check('status: an edited Cargo.lock no longer matches, and the refusal names the command',
    !changed.lockMatches && !!changed.refusal && changed.refusal.includes('does not match the crate snapshot')
    && changed.refusal.includes(`daylight deps snapshot ${repo}`) && !changed.refusal.includes('\n'), String(changed.refusal));
  fs.writeFileSync(lockFile, lock);
  check('and matches again once restored', snapshotStatus(repo, out).lockMatches);
  check('deps --help prints usage and exits 0', run(['deps', '--help']).code === 0);
  check('deps with no subcommand is a usage error', run(['deps']).code === 2);
}

// ---- the author's exec tool -----------------------------------------------------------------

const execAttempt: Pick<Attempt, 'id' | 'sandbox' | 'projectId'> = {
  id: 'a_cargo', projectId: 'git:cargo',
  sandbox: { profile: 'author', network: 'none', write: true, exec: true, authorizeDecisionId: 'd_cargo' },
};
const home = os.homedir();
const bindsOf = (argv: string[]) => {
  const out: Array<{ flag: string; src: string; dest: string }> = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bind' || argv[i] === '--ro-bind') out.push({ flag: argv[i], src: argv[i + 1], dest: argv[i + 2] });
  }
  return out;
};
const noHomeNoOut = (argv: string[]) => bindsOf(argv).every((b) => b.src !== home && b.src !== out && b.src !== '/'
  && !home.startsWith(`${b.src}/`) && !out.startsWith(`${b.src}/`));

section('the author exec tool builds against the snapshot, into the author cache only');
{
  const ws = createWorkspace(repo, commit);
  try {
    const l = execLaunch(live, execAttempt, { tree: ws.tree, out, command: ['/usr/bin/cargo', 'build', '--offline'] });
    const binds = bindsOf(l.argv);
    check('the snapshot is bound read-only at /cargo-home', binds.some((b) => b.flag === '--ro-bind' && b.src === fs.realpathSync(snapshotDir(out)) && b.dest === '/cargo-home'));
    check('the author cache read-write at /cargo-target', binds.some((b) => b.flag === '--bind' && b.src === fs.realpathSync(targetDir(out, 'author')) && b.dest === '/cargo-target'));
    check('the gate cache is never bound into it', !l.argv.some((a) => a.startsWith(targetDir(out, 'gate'))));
    check('CARGO_HOME, CARGO_TARGET_DIR and CARGO_NET_OFFLINE are set; HOME stays /tmp', (() => {
      const env = (k: string) => l.argv[l.argv.findIndex((a, i) => a === '--setenv' && l.argv[i + 1] === k) + 2];
      return env('CARGO_HOME') === '/cargo-home' && env('CARGO_TARGET_DIR') === '/cargo-target' && env('CARGO_NET_OFFLINE') === 'true' && env('HOME') === '/tmp';
    })());
    check('--unshare-all and no --share-net', l.argv.includes('--unshare-all') && !l.argv.includes('--share-net'));
    check('no mount is $HOME, <out> or an ancestor of either', noHomeNoOut(l.argv), JSON.stringify(binds));
    const r = await runExec(execAttempt, { tree: ws.tree, out, command: ['/usr/bin/cargo', 'build', '--offline'], timeoutMs: 300_000, profile: live });
    check('cargo build --offline succeeds in the author profile', r.exitCode === 0, r.stderr.slice(-600));
    check('it built into the author cache', listing(targetDir(out, 'author')).some((f) => f.includes('fixture')), listing(targetDir(out, 'author')).slice(0, 5).join(','));
    check('the gate cache stays empty', listing(targetDir(out, 'gate')).length === 0, listing(targetDir(out, 'gate')).slice(0, 5).join(','));
    check('and the snapshot is unchanged by the build', snapshotDigest(snapshotDir(out)).digest === readSnapshot(out)?.digest);
    fs.appendFileSync(path.join(ws.tree, 'Cargo.lock'), '\n');
    const refused = await throws(() => execLaunch(live, execAttempt, { tree: ws.tree, out, command: ['/usr/bin/cargo', 'build', '--offline'] }));
    check('a tree whose Cargo.lock is not the snapshot\'s is refused in one line naming the command',
      refused instanceof SandboxRefused && /does not match the crate snapshot/.test(refused.message) && refused.message.includes('daylight deps snapshot')
      && !refused.message.includes('\n'), refused?.message);
    check('and names no host path: <out> and <repo> are placeholders', !!refused && !refused.message.includes(out) && !refused.message.includes(tmp)
      && refused.message.includes('--out <out>'), refused?.message);
    const plain = path.join(tmp, 'not-cargo');
    fs.mkdirSync(plain);
    const pl = execLaunch(live, execAttempt, { tree: plain, out, command: ['node', '-v'] });
    check('a tree without a Cargo.toml gets no cargo mounts at all', !pl.argv.includes('/cargo-home') && !pl.argv.includes('/cargo-target'));
  } finally {
    ws.dispose();
  }
}

// ---- cargo gates --------------------------------------------------------------------------

const PADDED_GATE = [
  '#[test]',
  'fn pads_to_width() {',
  '    assert_eq!(fixture_core::padded(7, 3), "007");',
  '}', '',
].join('\n');
const PADDED_FIX = [
  '', '/// `n` in decimal, left-padded with zeros to `width`.',
  'pub fn padded(n: u64, width: usize) -> String {',
  '    let d = decimal(n);',
  '    format!("{}{}", "0".repeat(width.saturating_sub(d.len())), d)',
  '}', '',
].join('\n');
const EMPTY_GATE = '// no tests at all\n';
const PASS = { exitCode: 0, stdoutIncludes: ['test result: ok.'] };
const HUMAN = 'human:miz';

const listener = net.createServer((s) => s.end('hello\n'));
await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
const port = (listener.address() as net.AddressInfo).port;
const NET_GATE = [
  '#[test]',
  'fn reaches_the_host() {',
  `    std::net::TcpStream::connect(("127.0.0.1", ${port})).expect("a TCP connect to a listener on the host");`,
  '}', '',
].join('\n');

const dctx = openDaylight(out);
const project = identifyProject(repo);
dctx.store.ensureProject(project);
const ctx: GateContext = { store: dctx.store, artifacts: dctx.artifacts, events: dctx.events, repoRoot: repo, out, env: {}, timeoutMs: 300_000 };
const newMission = (objective: string, base = commit) => dctx.store.createMission({
  projectId: project.id, kind: 'implement', objective, baseRevision: base, adhoc: { actor: HUMAN, rationale: 'test fixture' },
});
const recordsOf = (g: GateEvaluation): ExecutionRecord[] =>
  g.executions.filter((r) => r.kind === 'result').map((r) => JSON.parse(dctx.artifacts.text(r)) as ExecutionRecord);
const stdoutOf = (r: ExecutionRecord) => (r.stdoutRef ? dctx.artifacts.text(r.stdoutRef) : '');
const stderrOf = (r: ExecutionRecord) => (r.stderrRef ? dctx.artifacts.text(r.stderrRef) : '');

section('registering a cargo gate');
const mission = newMission('add padded()');
let gate!: Experiment;
let netGate!: Experiment;
{
  const input = { missionId: mission.id, role: 'gate' as const, testSource: PADDED_GATE, basename: 'padded.rs', prediction: PASS, harness: 'cargo' as const, crate: 'crates/core' };
  check('a cargo gate that is not a .rs file is refused', (await throws(() => registerGate(ctx, { ...input, basename: 'padded.txt' }))) instanceof GateRefused);
  check('a crate outside the repository is refused', (await throws(() => registerGate(ctx, { ...input, crate: '../elsewhere' }))) instanceof GateRefused);
  check('a crate under .daylight-gates is refused', (await throws(() => registerGate(ctx, { ...input, crate: '.daylight-gates/x' }))) instanceof GateRefused);
  check('a command that does not run its own target is refused',
    (await throws(() => registerGate(ctx, { ...input, command: ['cargo', 'test', '--offline', '--workspace', '--', '--test-threads=1', '{test}'] }))) instanceof GateRefused);
  check('a command naming a second --test target is refused at registration',
    (await throws(() => registerGate(ctx, { ...input, command: ['cargo', 'test', '--test', '{test}', '--test', 'other'] }))) instanceof GateRefused);
  check('a command with --config is refused at registration',
    !!(await throws(() => registerGate(ctx, { ...input, command: ['cargo', 'test', '--config', 'x', '--test', '{test}'] }))));
  check('--crate on a node gate is refused', (await throws(() => registerGate(ctx, { ...input, harness: 'node', basename: 'p.test.js' }))) instanceof GateRefused);
  check('nothing was registered by the refusals', dctx.store.experiments(mission.id).length === 0);

  gate = registerGate(ctx, input);
  netGate = registerGate(ctx, { ...input, role: 'holdout', testSource: NET_GATE, basename: 'net.rs' });
  const target = cargoTargetOf(gate.id);
  const expectation = JSON.parse(dctx.artifacts.text(gate.expectedArtifact)) as Record<string, unknown>;
  check('it is filed under .daylight-gates/<x_id>/<basename> like any gate', gate.testArtifact.path === `.daylight-gates/${gate.id}/padded.rs`);
  check('its row says harness cargo', dctx.store.experiment(gate.id)?.harness === 'cargo');
  check('its expectation carries the harness and the crate test path, so the digest covers both',
    expectation.harness === 'cargo' && expectation.cargoTestPath === `crates/core/tests/${target}.rs`, JSON.stringify(expectation));
  check('the default command runs its own target, offline, one thread',
    gate.command.join(' ') === `cargo test --offline --workspace --test ${target} -- --test-threads=1`, gate.command.join(' '));
  const node = registerGate(ctx, { missionId: newMission('compare').id, role: 'gate', testSource: PADDED_GATE, basename: 'padded.rs', prediction: PASS, command: ['node', '--test', '{test}'] });
  check('a node row reads harness node', dctx.store.experiment(node.id)?.harness === 'node');
}

section('baseline: falsified on the base, which lacks padded(); in bwrap with no network');
{
  const bs = await baseline(ctx, mission.id);
  const g = bs.find((b) => b.experimentId === gate.id)!;
  const n = bs.find((b) => b.experimentId === netGate.id)!;
  const rs = recordsOf(g);
  check('the cargo gate is falsified on the base', g.conclusion === 'falsified', `${g.conclusion} ${rs[0]?.why ?? ''} ${stderrOf(rs[0] ?? ({} as ExecutionRecord)).slice(-400)}`);
  check('it ran twice, both ran, neither met the prediction', rs.length === 2 && rs.every((r) => r.status === 'ran' && !r.matchesPrediction));
  check('because its own test target did not compile against the base', rs.every((r) => /could not compile `fixture-core` \(test "daylight_/.test(stderrOf(r))));
  const argv = rs[0].sandboxArgv;
  const binds = bindsOf(argv);
  check('it ran the system cargo in bwrap with --unshare-all and no --share-net',
    argv.includes('bwrap') && argv.includes('--unshare-all') && !argv.includes('--share-net') && argv.includes('/usr/bin/cargo'));
  check('the snapshot read-only at /cargo-home, the gate cache read-write at /cargo-target',
    binds.some((b) => b.flag === '--ro-bind' && b.src === fs.realpathSync(snapshotDir(out)) && b.dest === '/cargo-home')
    && binds.some((b) => b.flag === '--bind' && b.src === fs.realpathSync(gateCacheDir(out, 'base')) && b.dest === '/cargo-target'));
  check('the author cache is never bound into a gate', !argv.some((a) => a.includes(path.join('cargo', 'target', 'author'))));
  check('offline and non-incremental', argv.join(' ').includes('--setenv CARGO_NET_OFFLINE true') && argv.join(' ').includes('--setenv CARGO_INCREMENTAL 0'));
  check('the test is bound in from memory at both of its paths', argv.filter((a) => a === '--ro-bind-data').length === 2
    && argv.some((a) => a.endsWith(`/crates/core/tests/${cargoTargetOf(gate.id)}.rs`)));
  check('no mount is $HOME, <out> or an ancestor of either', noHomeNoOut(argv), JSON.stringify(binds));
  const hostConnect = await new Promise<string>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => { s.end(); resolve('connected'); });
    s.on('error', (e) => resolve(String((e as NodeJS.ErrnoException).code)));
  });
  check('control: on the host, the listener the network gate dials is reachable', hostConnect === 'connected', hostConnect);
  const nr = recordsOf(n);
  check('inside the sandbox the same TCP connect fails: the network gate is falsified, its test ran and failed',
    n.conclusion === 'falsified' && nr.every((r) => r.status === 'ran' && /test result: FAILED\. 0 passed; 1 failed/.test(stdoutOf(r))),
    `${n.conclusion} ${stdoutOf(nr[0] ?? ({} as ExecutionRecord)).slice(-300)} ${nr[0]?.why ?? ''}`);
  check('the base gate cache now holds what the baseline built', listing(gateCacheDir(out, 'base')).length > 0);
}

section('a vacuous cargo gate is invalid, never a pass');
{
  const m = newMission('nothing to test');
  const x = registerGate(ctx, { missionId: m.id, role: 'gate', testSource: EMPTY_GATE, basename: 'empty.rs', prediction: PASS, harness: 'cargo', crate: 'crates/core' });
  const [b] = await baseline(ctx, m.id);
  check('0 tests run is invalid', b.conclusion === 'invalid' && recordsOf(b).every((r) => /0 tests run/.test(r.why ?? '')), `${b.conclusion} ${recordsOf(b)[0]?.why}`);
  check('it was run, not refused before running', recordsOf(b).every((r) => r.status === 'invalid' && !!r.observed));
  void x;
}

/** The tree's changes against its commit, captured the way a candidate's are. */
const diffOf = (ws: Workspace): Buffer => {
  siblingGit(ws, ['add', '--all', '--force']);
  return siblingGit(ws, ['diff', '--cached', ...DIFF_FLAGS, ws.commit, '--']);
};
const grant = dctx.store.authorizeMission({
  missionId: mission.id, actor: HUMAN, rationale: 'go', permissions: { write: true, execute: false }, maxUsd: null,
}).decision;

section('evaluate: supported on a diff that adds padded()');
{
  const code = confirmDigest(ctx, 'lock-gates', mission.id, { experimentIds: [gate.id, netGate.id] }).digest8;
  lock(ctx, { missionId: mission.id, actor: HUMAN, rationale: 'padded, and no network', confirm: code });
  const ws = createWorkspace(repo, commit);
  let diff: Buffer;
  try {
    fs.appendFileSync(path.join(ws.tree, 'crates', 'core', 'src', 'lib.rs'), PADDED_FIX);
    diff = diffOf(ws);
  } finally {
    ws.dispose();
  }
  const files: CandidateFile[] = [{ path: 'crates/core/src/lib.rs', change: 'modified', insertions: 6, deletions: 0, mode: 'file', previousMode: 'file' }];
  const task = dctx.store.createTask({ missionId: mission.id, role: 'author', objective: 'add padded' });
  const a = dctx.store.startAttempt({
    taskId: task.id, runnerId: 'agent:mock:author',
    sandbox: { profile: 'author', network: 'none', write: true, exec: false, authorizeDecisionId: grant.id },
  });
  dctx.store.finishAttempt(a.id, { state: 'completed', exitCode: 0, costUsd: null });
  const meta = { projectId: project.id, revision: commit };
  const c: Candidate = dctx.store.createCandidate({
    missionId: mission.id, attemptId: a.id, projectId: project.id, baseCommit: commit,
    diffArtifact: dctx.artifacts.put(diff, { ...meta, kind: 'diff' }),
    summaryArtifact: dctx.artifacts.put('{}', { ...meta, kind: 'summary' }),
    files, policyViolations: checkPolicy(files, { diffBytes: diff.length }), secretHits: 0,
    gateSetDigest: dctx.store.lockDecision(mission.id)!.scope.gateSetDigest as string,
    profile: { name: 'author', network: 'none', write: true, exec: false }, attemptState: 'completed',
  });
  const v = await evaluate(ctx, c.id);
  const rows = dctx.store.gateEvaluations({ candidateId: c.id, target: 'candidate' });
  const g = rows.find((r) => r.experimentId === gate.id);
  const n = rows.find((r) => r.experimentId === netGate.id);
  check('the cargo gate is supported on the diff that adds padded()', g?.conclusion === 'supported',
    `${g?.conclusion} ${recordsOf(g!)[0]?.why ?? ''} ${stderrOf(recordsOf(g!)[0] ?? ({} as ExecutionRecord)).slice(-400)}`);
  check('its run printed the result line it is read from', recordsOf(g!).every((r) => /test result: ok\. 1 passed; 0 failed/.test(stdoutOf(r))));
  check('the network holdout still fails: no network on a candidate either', n?.conclusion === 'falsified', n?.conclusion);
  check('so the verdict is rejected-by-gates', v.verdict === 'rejected-by-gates', `${v.verdict} ${v.verdictReasons.join('; ')}`);
  check('the author cache was not touched by the gates', !recordsOf(g!).some((r) => r.sandboxArgv.some((x) => x.includes(path.join('cargo', 'target', 'author')))));
  const key = gateCacheKey(c.diffArtifact.digest);
  check('the candidate\'s gates built in its own cache, gate/<diffDigest16>, never in gate/base',
    recordsOf(g!).every((r) => bindsOf(r.sandboxArgv).some((b) => b.flag === '--bind' && b.dest === '/cargo-target' && b.src === path.join(fs.realpathSync(targetDir(out, 'gate')), key))));
  check('and that cache is gone after evaluate, gate/base kept', !fs.existsSync(gateCacheDir(out, key)) && listing(gateCacheDir(out, 'base')).length > 0);
}

/**
 * A mission with one locked cargo gate, and a candidate on it made by `edit`. The policy
 * violations are recorded as none on purpose: the harness's own checks are under test here,
 * not policy's, and they must hold without it.
 */
async function lockedCargoGate(objective: string, testSource = PADDED_GATE): Promise<{ m: Mission; x: Experiment; base: GateEvaluation }> {
  const m = newMission(objective);
  const x = registerGate(ctx, { missionId: m.id, role: 'gate', testSource, basename: 'padded.rs', prediction: PASS, harness: 'cargo', crate: 'crates/core' });
  const [base] = await baseline(ctx, m.id);
  if (base.conclusion === 'falsified') {
    lock(ctx, { missionId: m.id, actor: HUMAN, rationale: 'r', confirm: confirmDigest(ctx, 'lock-gates', m.id, { experimentIds: [x.id] }).digest8 });
  }
  return { m, x, base };
}
async function judged(m: Mission, x: Experiment, edit: (tree: string) => void): Promise<{ c: Candidate; g: GateEvaluation | undefined }> {
  const g0 = dctx.store.authorizeMission({ missionId: m.id, actor: HUMAN, rationale: 'go', permissions: { write: true, execute: false }, maxUsd: null }).decision;
  const ws = createWorkspace(repo, commit);
  let diff: Buffer;
  try {
    edit(ws.tree);
    diff = diffOf(ws);
  } finally {
    ws.dispose();
  }
  const task = dctx.store.createTask({ missionId: m.id, role: 'author', objective: 'probe' });
  const a = dctx.store.startAttempt({
    taskId: task.id, runnerId: 'agent:mock:author',
    sandbox: { profile: 'author', network: 'none', write: true, exec: false, authorizeDecisionId: g0.id },
  });
  dctx.store.finishAttempt(a.id, { state: 'completed', exitCode: 0, costUsd: null });
  const meta = { projectId: project.id, revision: commit };
  const c0 = dctx.store.createCandidate({
    missionId: m.id, attemptId: a.id, projectId: project.id, baseCommit: commit,
    diffArtifact: dctx.artifacts.put(diff, { ...meta, kind: 'diff' }),
    summaryArtifact: dctx.artifacts.put('{}', { ...meta, kind: 'summary' }),
    files: [{ path: 'crates/core/src/lib.rs', change: 'modified', insertions: 1, deletions: 0, mode: 'file', previousMode: 'file' }],
    policyViolations: [], secretHits: 0,
    gateSetDigest: dctx.store.lockDecision(m.id)!.scope.gateSetDigest as string,
    profile: { name: 'author', network: 'none', write: true, exec: false }, attemptState: 'completed',
  });
  const c = await evaluate(ctx, c0.id);
  return { c, g: dctx.store.gateEvaluations({ candidateId: c.id, target: 'candidate' }).find((r) => r.experimentId === x.id) };
}
const OK_LINE = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s';

section('a candidate cannot forge a cargo gate\'s result (P2-R30)');
{
  const { m, x } = await lockedCargoGate('forged [[test]] entry');
  const t = cargoTargetOf(x.id);
  const forged = await judged(m, x, (tree) => {
    fs.appendFileSync(path.join(tree, 'crates/core/Cargo.toml'), `\n[[test]]\nname = "${t}"\npath = "src/evil.rs"\nharness = false\n`);
    fs.writeFileSync(path.join(tree, 'crates/core/src/evil.rs'), `fn main() { println!("${OK_LINE}"); }\n`);
  });
  const fr = forged.g ? recordsOf(forged.g) : [];
  check('a [[test]] entry giving the gate\'s target name to another file is invalid, never supported',
    forged.g?.conclusion === 'invalid' && fr.every((r) => /not the placed test/.test(r.why ?? '')), `${forged.g?.conclusion} ${fr[0]?.why}`);
  check('even though that file printed the ok line and exited 0', fr.some((r) => stdoutOf(r).includes('test result: ok.') && r.exitCode === 0));
  check('so the verdict is not an acceptance', forged.c.verdict !== 'accepted-by-gates', forged.c.verdict);

  const { m: m2, x: x2 } = await lockedCargoGate('forged runner');
  const runner = await judged(m2, x2, (tree) => {
    fs.appendFileSync(path.join(tree, 'crates/core/src/lib.rs'), '\npub fn padded(_n: u64, _w: usize) -> String { String::from("wrong") }\n');
    fs.mkdirSync(path.join(tree, '.cargo'));
    fs.writeFileSync(path.join(tree, '.cargo/config.toml'), '[target.x86_64-unknown-linux-gnu]\nrunner = ["/usr/bin/sh", "/work/fake-runner.sh"]\n');
    fs.writeFileSync(path.join(tree, 'fake-runner.sh'), `echo "running 1 test"; echo "${OK_LINE}"\n`);
  });
  const rr = runner.g ? recordsOf(runner.g) : [];
  check('a .cargo/config.toml runner in the candidate is invalid, refused before cargo runs',
    runner.g?.conclusion === 'invalid' && rr.length === 1 && !rr[0].observed && /\.cargo\/config\.toml sets target\.x86_64-unknown-linux-gnu\.runner/.test(rr[0].why ?? ''),
    `${runner.g?.conclusion} ${rr[0]?.why}`);
  check('and is not accepted', runner.c.verdict !== 'accepted-by-gates', runner.c.verdict);
  check('reading two binaries\' output is invalid',
    /not the placed test/.test(noCargoTestsReported(`${OK_LINE}\n${OK_LINE}\n`, `     Running tests/${t}.rs (/x)\n     Running src/evil.rs (/y)\n`, t) ?? ''));
  check('reading none is invalid', noCargoTestsReported(`${OK_LINE}\n`, '', t) !== null);
}

section('one candidate\'s build cannot reach another\'s gate (P2-R28)');
{
  const POISON_GATE = [
    '#[test]',
    'fn pads() {',
    '    assert!(!std::path::Path::new("/cargo-target/poison.txt").exists(), "POISONED: left by an earlier candidate\'s build.rs");',
    '    assert_eq!(fixture_core::padded(7, 3), "007");',
    '}', '',
  ].join('\n');
  const { m, x } = await lockedCargoGate('gate cache poisoning', POISON_GATE);
  const addPadded = (tree: string) => fs.appendFileSync(path.join(tree, 'crates/core/src/lib.rs'), PADDED_FIX);
  const a = await judged(m, x, (tree) => {
    addPadded(tree);
    fs.writeFileSync(path.join(tree, 'crates/core/build.rs'),
      'fn main() { std::fs::write("/cargo-target/poison.txt", "from candidate A").unwrap(); println!("cargo:rerun-if-changed=build.rs"); }\n');
  });
  check('candidate A, whose build.rs writes into its gate cache, fails its own gate', a.g?.conclusion === 'falsified', `${a.g?.conclusion} ${recordsOf(a.g!)[0]?.why}`);
  check('nothing it wrote is in gate/base or left under gate/', !fs.existsSync(path.join(gateCacheDir(out, 'base'), 'poison.txt'))
    && fs.readdirSync(targetDir(out, 'gate')).every((n) => n === 'base'), fs.readdirSync(targetDir(out, 'gate')).join(','));
  const b = await judged(m, x, addPadded);
  check('clean candidate B is still accepted: its verdict does not depend on A', b.g?.conclusion === 'supported' && b.c.verdict === 'accepted-by-gates',
    `${b.g?.conclusion} ${b.c.verdict} ${stdoutOf(recordsOf(b.g!)[0] ?? ({} as ExecutionRecord)).slice(-300)}`);
}

section('the snapshot is verified in full before every gate run and exec launch (P2-R29)');
{
  const planted = path.join(snapshotDir(out), 'config.toml');
  fs.writeFileSync(planted, '[build]\nrustc = "/usr/bin/false"\n');
  try {
    const m = newMission('planted snapshot config');
    registerGate(ctx, { missionId: m.id, role: 'gate', testSource: PADDED_GATE, basename: 'padded.rs', prediction: PASS, harness: 'cargo', crate: 'crates/core' });
    const [b] = await baseline(ctx, m.id);
    const why = recordsOf(b)[0]?.why ?? '';
    check('a config.toml planted in the snapshot refuses the next gate run before cargo runs',
      b.conclusion === 'invalid' && recordsOf(b).length === 1 && !recordsOf(b)[0].observed && /config\.toml/.test(why) && why.includes('daylight deps snapshot'), `${b.conclusion} ${why}`);
    const ws = createWorkspace(repo, commit);
    try {
      const e = await throws(() => execLaunch(live, execAttempt, { tree: ws.tree, out, command: ['/usr/bin/cargo', 'build', '--offline'] }));
      check('and the next exec launch', e instanceof SandboxRefused && /config\.toml/.test(e.message), e?.message);
    } finally {
      ws.dispose();
    }
    const st = json<{ intact: boolean; refusal: string | null }>(run(['deps', 'status', repo, '--out', out, '--format', 'json']));
    check('deps status reports the mismatch', st.intact === false && /config\.toml/.test(st.refusal ?? ''), JSON.stringify(st));
  } finally {
    fs.rmSync(planted, { force: true });
  }
  const crate = fs.readdirSync(path.join(snapshotDir(out), 'registry', 'cache'), { recursive: true }).map(String).find((f) => f.endsWith('.crate'))!;
  const crateFile = path.join(snapshotDir(out), 'registry', 'cache', crate);
  const bytes = fs.readFileSync(crateFile);
  fs.appendFileSync(crateFile, 'x');
  const e = await throws(() => cargoMounts('gate', out));
  check('a rewritten crate in the snapshot refuses the mount, naming the command', e instanceof CargoRefused && /no longer hashes/.test(e.message)
    && e.message.includes('daylight deps snapshot'), e?.message);
  fs.writeFileSync(crateFile, bytes);
  check('restored, the snapshot mounts again', (await throws(() => cargoMounts('gate', out))) === null);
}

section('a resource limit hit while building the gate is invalid, never falsified (P2-R30)');
{
  check('cargo gates default to 900 CPU-s, 2 GiB files, 4 GiB memory and a 600 s wall clock',
    CARGO_GATE_LIMITS.cpuSeconds === 900 && CARGO_GATE_LIMITS.fileSizeBytes === 2 * 1024 ** 3 && CARGO_GATE_LIMITS.memoryBytes === 4 * 1024 ** 3
    && CARGO_GATE_TIMEOUT_MS === 600_000);
  const m = newMission('fsize');
  const x = registerGate(ctx, { missionId: m.id, role: 'gate', testSource: '#[test]\nfn dec() { assert_eq!(fixture_core::decimal(7), "7"); }\n',
    basename: 'p.rs', prediction: PASS, harness: 'cargo', crate: 'crates/core' });
  const [b] = await baseline({ ...ctx, limits: { ...DEFAULT_LIMITS, fileSizeBytes: 256 * 1024 } }, m.id);
  const rs = recordsOf(b);
  check('a gate that passes at base, run under a 256 KiB file-size ceiling, is invalid',
    b.conclusion === 'invalid' && rs.every((r) => /resource limit|SIGXFSZ/.test(r.why ?? '')), `${b.conclusion} ${rs[0]?.why} ${stderrOf(rs[0] ?? ({} as ExecutionRecord)).slice(-300)}`);
  check('the run records the ceiling it ran under', rs.every((r) => r.sandboxArgv.includes(`--fsize=${256 * 1024}`)));
  const [ok] = await baseline(ctx, m.id);
  check('under the cargo defaults the same gate runs to a result', ok.conclusion === 'supported'
    && recordsOf(ok).every((r) => r.sandboxArgv.includes('--cpu=900') && r.sandboxArgv.includes(`--fsize=${2 * 1024 ** 3}`)), ok.conclusion);
}

section('a Cargo.lock change refuses the run, in one line naming the command');
{
  fs.appendFileSync(path.join(repo, 'Cargo.lock'), '\n# a hand edit\n');
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@daylight.invalid', 'commit', '-q', '-am', 'edit the lock']);
  const edited = git(['rev-parse', 'HEAD']);
  const m = newMission('padded against an edited lock', edited);
  registerGate(ctx, { missionId: m.id, role: 'gate', testSource: PADDED_GATE, basename: 'padded.rs', prediction: PASS, harness: 'cargo', crate: 'crates/core' });
  const [b] = await baseline(ctx, m.id);
  const why = recordsOf(b)[0]?.why ?? '';
  check('the baseline is invalid, refused before cargo ran', b.conclusion === 'invalid' && recordsOf(b).length === 1 && !recordsOf(b)[0].observed, `${b.conclusion} ${why}`);
  check('the refusal is one line naming `daylight deps snapshot <repo> --out <out>`',
    /Cargo\.lock .* does not match the crate snapshot/.test(why) && why.includes(`daylight deps snapshot ${repo} --out ${out}`) && !why.includes('\n'), why);
  check('snapshotRefusal says the same about the working tree', snapshotRefusal(repo, out, repo)?.includes('daylight deps snapshot') === true);
  git(['reset', '-q', '--hard', commit]);
  check('restored, the lock matches again', snapshotRefusal(repo, out, repo) === null);
}

dctx.close();

section('forge run wipes the author cache when a candidate breaks policy');
{
  const marker = path.join(targetDir(out, 'author'), 'debug', 'left-by-an-earlier-author');
  check('the author cache holds an earlier build', listing(targetDir(out, 'author')).length > 0);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, 'x');
  const confirmOf = (op: string, subject: string, extra: string[] = []) =>
    json<{ digest8: string }>(run(['confirm', op, subject, '--out', out, ...extra, '--format', 'json']));
  const objective = 'add padded() (author edits Cargo.lock)';
  const m = json<Mission>(run(['mission', 'create', repo, '--kind', 'implement', '--no-work-item', '--objective', objective,
    '--rationale', 'r', '--confirm', confirmOf('adhoc-mission', objective).digest8, '--out', out, '--format', 'json']));
  run(['mission', 'authorize', m.id, '--out', out, '--write', '--rationale', 'r', '--confirm', confirmOf('authorize-mission', m.id, ['--write']).digest8]);
  const testFile = path.join(tmp, 'padded.rs');
  fs.writeFileSync(testFile, PADDED_GATE);
  const added = run(['gate', 'add', m.id, '--role', 'gate', '--harness', 'cargo', '--crate', 'crates/core', '--test', testFile,
    '--expect-exit', '0', '--expect-stdout', 'test result: ok.', '--out', out, '--format', 'json']);
  check('gate add --harness cargo registers through the CLI', added.code === 0 && json<Experiment>(added).harness === 'cargo', added.err.slice(-300));
  const baselined = run(['gate', 'baseline', m.id, repo, '--out', out]);
  check('gate baseline through the CLI: falsified', baselined.code === 0 && /falsified on the base/.test(baselined.out), baselined.out + baselined.err.slice(-300));
  run(['gate', 'lock', m.id, '--out', out, '--rationale', 'r', '--confirm', confirmOf('lock-gates', m.id).digest8]);
  // A candidate with a violation is settled before any gate runs, so the gate cache holds still.
  const gateBefore = listing(targetDir(out, 'gate'));
  const snapBefore = snapshotDigest(snapshotDir(out)).digest;
  const author = path.join(tmp, 'mock-author-lock.cjs');
  fs.writeFileSync(author, `'use strict';
const fs = require('node:fs');
fs.appendFileSync('/work/crates/core/src/lib.rs', ${JSON.stringify(PADDED_FIX)});
fs.appendFileSync('/work/Cargo.lock', '\\n');
console.log('done');
`);
  const r = run(['forge', 'run', m.id, repo, '--tools', 'mock', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: author });
  const res = r.code === 0 ? json<{ candidate: Candidate | null }>(r) : null;
  check('the run produced a candidate with a lockfile violation',
    !!res?.candidate && res.candidate.policyViolations.some((v) => v.path === 'Cargo.lock'), `${r.code} ${r.err.slice(-400)} ${JSON.stringify(res?.candidate?.policyViolations)}`);
  check('the author cache is gone', !fs.existsSync(targetDir(out, 'author')));
  check('the gate cache and the snapshot are untouched', JSON.stringify(listing(targetDir(out, 'gate'))) === JSON.stringify(gateBefore)
    && snapshotDigest(snapshotDir(out)).digest === snapBefore && !!readSnapshot(out));
  const view = json<{ events: Array<{ name: string; payload: Record<string, unknown> }> }>(run(['mission', 'inspect', m.id, '--out', out, '--format', 'json']));
  check('and the wipe is on the ledger', view.events.some((e) => e.name === 'forge.cargo.author-cache.wiped' && e.payload.candidateId === res?.candidate?.id));

  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, 'x');
  const clean = path.join(tmp, 'mock-author-clean.cjs');
  fs.writeFileSync(clean, `'use strict';
require('node:fs').appendFileSync('/work/crates/core/src/lib.rs', ${JSON.stringify(PADDED_FIX)});
console.log('done');
`);
  const objective2 = 'add padded() (clean)';
  const m2 = json<Mission>(run(['mission', 'create', repo, '--kind', 'implement', '--no-work-item', '--objective', objective2,
    '--rationale', 'r', '--confirm', confirmOf('adhoc-mission', objective2).digest8, '--out', out, '--format', 'json']));
  run(['mission', 'authorize', m2.id, '--out', out, '--write', '--rationale', 'r', '--confirm', confirmOf('authorize-mission', m2.id, ['--write']).digest8]);
  run(['gate', 'add', m2.id, '--role', 'gate', '--harness', 'cargo', '--crate', 'crates/core', '--test', testFile,
    '--expect-exit', '0', '--expect-stdout', 'test result: ok.', '--out', out]);
  run(['gate', 'baseline', m2.id, repo, '--out', out]);
  run(['gate', 'lock', m2.id, '--out', out, '--rationale', 'r', '--confirm', confirmOf('lock-gates', m2.id).digest8]);
  const r2 = run(['forge', 'run', m2.id, repo, '--tools', 'mock', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: clean });
  const res2 = r2.code === 0 ? json<{ candidate: Candidate | null; verdict: string }>(r2) : null;
  check('a clean candidate is accepted by its cargo gate', res2?.verdict === 'accepted-by-gates', `${res2?.verdict} ${r2.err.slice(-300)}`);
  check('and leaves the author cache alone', fs.existsSync(marker));

  fs.appendFileSync(path.join(repo, 'Cargo.lock'), '\n');
  const refused = run(['forge', 'run', m2.id, repo, '--tools', 'mock', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: clean });
  check('forge run on a repository whose Cargo.lock moved is refused, naming the command',
    refused.code === 1 && /does not match the crate snapshot/.test(refused.err) && refused.err.includes('daylight deps snapshot'), refused.err.slice(-400));
  git(['checkout', '-q', '--', 'Cargo.lock']);
}

listener.close();
done();
