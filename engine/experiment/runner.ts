import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ArtifactStore, canonicalJson } from '../mission/artifacts.ts';
import type {
  ArtifactRef, DaylightEventInput, ExpectedObservation, Experiment, ExperimentConclusion,
  ExperimentRole, GateHarness, NewExperiment,
} from '../mission/types.ts';
import { concludeFrom } from './conclude.ts';
import {
  checkAllowlist, DEFAULT_LIMITS, detectSandbox, NO_SCOPE_LIMITATION, SANDBOX_LIMITATIONS, sandboxArgv,
  sandboxBinaries, scopeEnv, SYSTEM_PATH, WORK, type SandboxBind, type SandboxLimits, type SandboxProfile,
} from './sandbox.ts';
import type { ExecutionRecord, ExecutionStatus, ExecutionTarget, Observation } from './types.ts';

/**
 * The experiment runner: a registered test, run inside a sandbox, at a named revision.
 *
 * Two properties carry the honesty of the result and both are enforced here rather than
 * asked for. The test and its prediction are artifacts, registered before anything runs and
 * covered by one digest, so the thing being tested cannot be rewritten to match whatever came
 * out; at run time the test is copied *from the artifact store into the worktree*, and a
 * worktree that already holds a different file at that path is refused. Each run then sees
 * the registered bytes bound in from the runner's memory, not the worktree copy, which the
 * same uid could rewrite between runs. And the revision is
 * a commit — a `+dirty` tree is uncommitted code nobody else can check out, so an experiment
 * on it is recorded as invalid rather than run.
 *
 * Everything that happened is written down as artifacts: each stream, and one `result`
 * record per run carrying the exact argv (worktree path elided), the observation and whether
 * it met the prediction. The experiment row only holds the references.
 */

/**
 * The slice of the mission store this module needs. DL-01 owns the real one; typing the seam
 * structurally keeps the runner testable against a two-method stub.
 */
export interface ExperimentStoreLike {
  createExperiment(input: NewExperiment): Experiment;
  updateExperiment(
    id: string,
    patch: { executions?: ArtifactRef[]; conclusion?: ExperimentConclusion; limitations?: string[] },
  ): Experiment;
  /** When present, lets the sweep conclude what a dead runner left pending. */
  experiment?(id: string): Experiment | null;
}

export interface EventSink {
  append(e: DaylightEventInput): unknown;
}

export class InvalidExperiment extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExperiment';
  }
}

export interface RegisterInput {
  store: ExperimentStoreLike;
  artifacts: ArtifactStore;
  events?: EventSink;
  missionId: string;
  projectId: string;
  baseRevision: string;
  subject: string;
  predicate: string;
  claimIds: number[];
  hypothesis: string;
  prediction: ExpectedObservation;
  /** The test, as text. Stored as an artifact; the worktree copy is written from it. */
  testSource: string;
  /** Repo-relative path the test is placed at inside the worktree. */
  testPath: string;
  command: string[];
  sandboxProfile?: string;
  /** `gate` or `holdout` for a Forge gate. Absent, the experiment is a P0 probe. */
  role?: ExperimentRole;
  /** Minted first (`newId('experiment')`) when the test path has to name the experiment. */
  id?: string;
  /** `cargo` for a gate run by `cargo test`. Defaults to `node`; a probe is always `node`. */
  harness?: GateHarness;
  /**
   * A cargo gate's second placement: repo-relative, under a crate's `tests/`, where cargo finds
   * the registered test as an integration test target. Covered by the expectation's digest.
   */
  cargoTestPath?: string;
}

const isForgeRole = (role: ExperimentRole | undefined): boolean =>
  role === 'gate' || role === 'holdout' || role === 'regression' || role === 'acceptance';

const isEmptyPrediction = (p: ExpectedObservation): boolean =>
  p.exitCode === undefined && !p.stdoutIncludes?.length && !p.stderrIncludes?.length;

/**
 * One digest over everything that decides what a run means: the test, the prediction, how it
 * is invoked and where. Change any of them and it is a different experiment.
 */
export function harnessDigestOf(
  testDigest: string, expectedDigest: string, command: string[], sandboxProfile: string,
): string {
  return `sha256:${createHash('sha256')
    .update(`${testDigest}\n${expectedDigest}\n${JSON.stringify(command)}\n${sandboxProfile}`)
    .digest('hex')}`;
}

/**
 * Does the row still describe the experiment that was registered?
 *
 * The row — which artifact is the test, where it goes, what counts as a match — is a plain
 * UPDATE away for any process with this uid, so at run time it is checked against the digest
 * rather than believed. `legacy` is a row registered before the path was part of it.
 */
export function harnessHolds(
  x: Experiment, artifacts: ArtifactStore,
): { ok: true; legacy: boolean; cargoTestPath?: string } | { ok: false; why: string } {
  const edited = (what: string) => ({
    ok: false as const,
    why: `the harness digest no longer holds: ${what} on the experiment row is not what was registered`,
  });
  if (harnessDigestOf(x.testArtifact.digest, x.expectedArtifact.digest, x.command, x.sandboxProfile) !== x.harnessDigest) {
    return edited('the test, prediction, command or profile');
  }
  let registered: Record<string, unknown>;
  try {
    registered = JSON.parse(artifacts.text(x.expectedArtifact)) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, why: `the registered prediction cannot be read: ${(err as Error).message}` };
  }
  const { testPath, role, baseRevision, harness, cargoTestPath, ...prediction } = registered;
  if (canonicalJson(prediction) !== canonicalJson(x.prediction)) return edited('the prediction');
  // The harness is in the expectation too, so a row re-stamped from node to cargo (or back) is
  // a different harness, not a different runner for the same one. Absent means node.
  if ((harness ?? 'node') !== (x.harness ?? 'node')) return edited('the harness');
  if ((x.harness === 'cargo') !== (typeof cargoTestPath === 'string')) return edited('the cargo test path');
  // A gate's role and base are in its expectation, so an UPDATE turning a holdout into a gate,
  // a probe into either, or re-pointing its base is a different harness. Probes carry neither.
  if (role !== undefined || baseRevision !== undefined || isForgeRole(x.role)) {
    if (role !== x.role) return edited('the role');
    if (baseRevision !== x.baseRevision) return edited('the base revision');
  }
  if (testPath === undefined) return { ok: true, legacy: true };
  if (testPath !== x.testArtifact.path) return edited('the test path');
  return { ok: true, legacy: false, ...(typeof cargoTestPath === 'string' ? { cargoTestPath } : {}) };
}

/** What stands for a holdout's test path in an event (P2-R37): its basename never leaves the gate runner. */
export const HOLDOUT_REDACTED = '<holdout>';

/**
 * `payload` with every occurrence of a holdout's test path, in any string at any depth, replaced
 * by `<holdout>`. Events are read outside the gate runner; the path names the holdout's file.
 * A payload of any other role is returned as it is.
 */
export function withholdHoldoutPath<T>(role: ExperimentRole | undefined, testPath: string | undefined, payload: T): T {
  if (role !== 'holdout' || !testPath) return payload;
  const walk = (v: unknown): unknown => typeof v === 'string' ? v.split(testPath).join(HOLDOUT_REDACTED)
    : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    : v;
  return walk(payload) as T;
}

export function registerExperiment(input: RegisterInput): Experiment {
  if (isEmptyPrediction(input.prediction)) {
    throw new InvalidExperiment(
      'a prediction that names no exit code and no output matches anything — say what the ' +
        'run will show if the hypothesis is true',
    );
  }
  const harness = input.harness ?? 'node';
  if (harness !== 'node' && !isForgeRole(input.role)) throw new InvalidExperiment(`the ${harness} harness runs gates and holdouts only`);
  // The worktree does not exist yet; containment is a property of the path, not the tree.
  const allowed = checkAllowlist(input.command, '/work', harness);
  if (!allowed.ok) throw new InvalidExperiment(allowed.why);
  const rel = path.posix.normalize(input.testPath);
  if (path.posix.isAbsolute(rel) || rel.startsWith('..')) {
    throw new InvalidExperiment(`testPath must be repo-relative and inside the worktree: ${input.testPath}`);
  }
  let cargoRel: string | undefined;
  if (harness === 'cargo') {
    cargoRel = path.posix.normalize(input.cargoTestPath ?? '');
    if (!input.cargoTestPath || path.posix.isAbsolute(cargoRel) || cargoRel.startsWith('..') || !/(^|\/)tests\/[A-Za-z0-9_-]+\.rs$/.test(cargoRel)) {
      throw new InvalidExperiment(`a cargo gate places its test under a crate's tests/ as <name>.rs, repo-relative: ${String(input.cargoTestPath)}`);
    }
  } else if (input.cargoTestPath !== undefined) {
    throw new InvalidExperiment('a cargo test path belongs to a cargo gate');
  }

  const profile = input.sandboxProfile ?? 'bwrap';
  const meta = { projectId: input.projectId, revision: input.baseRevision };
  const testArtifact = input.artifacts.put(input.testSource, {
    ...meta, kind: 'test', path: rel, label: 'registered test',
  });
  // Where the test is placed decides what runs, so it is part of the protected expectation
  // and, through that artifact's digest, of the harness digest. A gate's role and base are
  // too; a probe's expectation is exactly what P0 wrote, so its digests do not move.
  const expectation = isForgeRole(input.role)
    ? {
        ...input.prediction, testPath: rel, role: input.role, baseRevision: input.baseRevision,
        ...(harness === 'cargo' ? { harness, cargoTestPath: cargoRel } : {}),
      }
    : { ...input.prediction, testPath: rel };
  const expectedArtifact = input.artifacts.put(JSON.stringify(expectation, null, 2), {
    ...meta, kind: 'expected', label: 'prediction', mediaType: 'application/json',
  });

  const experiment = input.store.createExperiment({
    ...(input.id !== undefined ? { id: input.id } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    missionId: input.missionId,
    projectId: input.projectId,
    claimIds: input.claimIds,
    subject: input.subject,
    predicate: input.predicate,
    hypothesis: input.hypothesis,
    prediction: input.prediction,
    baseRevision: input.baseRevision,
    testArtifact,
    expectedArtifact,
    harnessDigest: harnessDigestOf(testArtifact.digest, expectedArtifact.digest, input.command, profile),
    command: input.command,
    sandboxProfile: profile,
    harness,
    limitations: [...SANDBOX_LIMITATIONS],
  });

  input.events?.append({
    projectId: input.projectId,
    missionId: input.missionId,
    category: 'experiment',
    name: 'experiment.registered',
    artifactIds: [testArtifact.id, expectedArtifact.id],
    payload: withholdHoldoutPath(input.role, rel, {
      experimentId: experiment.id, subject: input.subject, predicate: input.predicate,
      harnessDigest: experiment.harnessDigest, command: input.command,
    }),
  });
  return experiment;
}

export interface RunContext {
  repoRoot: string;
  store: ExperimentStoreLike;
  artifacts: ArtifactStore;
  events?: EventSink;
  /** How many times to run. Two by default: one run cannot tell a flaky test from a verdict. */
  runs?: number;
  timeoutMs?: number;
  limits?: SandboxLimits;
  /** Injected so a test can force the fail-closed path on a machine that has bwrap. */
  sandbox?: SandboxProfile;
  now?: () => number;
}

const STREAM_CAP = 2 * 1024 * 1024;

/**
 * Git as the runner runs it: none of the repository's hooks, fsmonitor or ssh command, no
 * user or system config, and none of the caller's GIT_* variables. A linked worktree shares
 * the main repo's `.git/config`, which anyone with write access to the checkout can edit,
 * and a checkout runs `post-checkout` — on the host, outside the sandbox, as us.
 */
export const HARDENED_GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.sshCommand=false',
];

export const hardenedGitEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});

const git = (root: string, args: string[]): string =>
  execFileSync('git', [...HARDENED_GIT_CONFIG, '-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env: hardenedGitEnv(),
  }).trim();

/**
 * `-c` overrides that switch off every clean/smudge driver the repository's config names.
 *
 * A driver in `.git/config` (or a file it includes) plus a committed `.gitattributes` runs on
 * checkout, on the host. There is no wildcard for `filter.*`, so the names are listed first —
 * with `--includes`, which `--local` leaves off — and each is blanked. `required=false`
 * because a required driver with no command fails the checkout instead of skipping it.
 */
export function filterOverrides(root: string): string[] {
  let names: string;
  try {
    names = execFileSync(
      'git',
      [...HARDENED_GIT_CONFIG, '-C', root, 'config', '--includes', '--local', '--name-only', '--get-regexp', '^filter\\.'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, env: hardenedGitEnv() },
    );
  } catch {
    // Exit 1 is "no filter configured"; anything else surfaces at the checkout.
    return [];
  }
  const drivers = new Set<string>();
  for (const key of names.split('\n').map((k) => k.trim()).filter(Boolean)) {
    const driver = key.slice('filter.'.length, key.lastIndexOf('.'));
    if (driver && !/[=\s]/.test(driver)) drivers.add(driver);
  }
  return [...drivers].flatMap((d) => [
    '-c', `filter.${d}.smudge=`, '-c', `filter.${d}.process=`, '-c', `filter.${d}.required=false`,
  ]);
}

/** The commit a revision label names, or why it cannot be used. */
export function commitOf(baseRevision: string): { commit: string } | { why: string } {
  if (baseRevision === 'unversioned') {
    return { why: 'the project is not under version control, so there is no revision to reproduce' };
  }
  if (baseRevision.endsWith('+dirty')) {
    return {
      why: `revision ${baseRevision.slice(0, 12)}+dirty has uncommitted changes; an experiment on ` +
        'a tree nobody else can check out is not reproducible — commit first',
    };
  }
  if (!/^[0-9a-f]{7,64}$/.test(baseRevision)) return { why: `not a commit: ${baseRevision}` };
  return { commit: baseRevision };
}

function observe(
  prediction: ExpectedObservation,
  run: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string },
): { observed: Observation; matches: boolean } {
  const seen = (hay: string, needles: string[] | undefined) =>
    Object.fromEntries((needles ?? []).map((n) => [n, hay.includes(n)]));
  const observed: Observation = {
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    stdoutBytes: Buffer.byteLength(run.stdout),
    stderrBytes: Buffer.byteLength(run.stderr),
    stdoutIncludes: seen(run.stdout, prediction.stdoutIncludes),
    stderrIncludes: seen(run.stderr, prediction.stderrIncludes),
  };
  const matches =
    !run.timedOut &&
    (prediction.exitCode === undefined || run.exitCode === prediction.exitCode) &&
    Object.values(observed.stdoutIncludes).every(Boolean) &&
    Object.values(observed.stderrIncludes).every(Boolean);
  return { observed, matches };
}

/** The child's fd that carries the registered test into the sandbox. */
const TEST_FD = 3;
/** The child's fd bwrap reports on once the command has been started inside the sandbox. */
const STATUS_FD = 4;

/** A cargo gate's second copy of the test is fed on this fd (fd 4 is bwrap's status). */
const CARGO_TEST_FD = 5;

/**
 * Spawn and wait, with a wall-clock ceiling that is actually enforced. `feed`, when given, is
 * written to the child's fd 3 and closed — bwrap reads it into the sandbox at setup; `extra`
 * goes to fd 5 the same way.
 */
function execute(
  argv: string[], timeoutMs: number, feed: Buffer | undefined, bin: string, extra?: Buffer,
): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; truncated: boolean; spawnError?: string; started: boolean }> {
  return new Promise((resolve) => {
    // The outer process is prlimit, which execs bwrap; the sandbox has --die-with-parent, so
    // killing this one pid takes the whole tree with it. `bin` is the absolute launcher and
    // the PATH it resolves bwrap on is the system's, never the caller's.
    const child = spawn(bin, argv.slice(1), {
      argv0: argv[0],
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', ...(extra ? ['pipe' as const] : [])],
      env: { PATH: SYSTEM_PATH, ...scopeEnv() },
    });
    const pipe = child.stdio[TEST_FD] as Writable;
    // A launcher that dies before reading closes the pipe; that failure is reported by the
    // exit status, not by an unhandled EPIPE here.
    pipe.on('error', () => {});
    pipe.end(feed ?? Buffer.alloc(0));
    if (extra) {
      const second = (child.stdio as readonly unknown[])[CARGO_TEST_FD] as Writable;
      second.on('error', () => {});
      second.end(extra);
    }
    let status = '';
    (child.stdio[STATUS_FD] as Readable).on('data', (d: Buffer) => {
      if (status.length < 4096) status += d.toString('utf8');
    });
    const started = () => status.includes('"child-pid"');
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const take = (onto: 'stdout' | 'stderr') => (d: Buffer) => {
      const cur = onto === 'stdout' ? stdout : stderr;
      if (cur.length >= STREAM_CAP) {
        truncated = true;
        return;
      }
      const next = cur + d.toString('utf8');
      const bounded = next.length > STREAM_CAP ? next.slice(0, STREAM_CAP) : next;
      if (bounded.length < next.length) truncated = true;
      if (onto === 'stdout') stdout = bounded;
      else stderr = bounded;
    };
    child.stdout!.on('data', take('stdout'));
    child.stderr!.on('data', take('stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, stdout, stderr: `${stderr}${err.message}`, truncated, spawnError: err.message, started: false });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr, truncated, started: started() });
    });
  });
}

/**
 * The first symlink met walking `rel` down from `root`, as a repo-relative path, or null.
 * A component that does not exist ends the walk: nothing below it can be a link yet.
 */
function symlinkOnPath(root: string, rel: string): string | null {
  let at = root;
  for (const part of rel.split('/').filter(Boolean)) {
    at = path.join(at, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(at);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return path.relative(root, at);
  }
  return null;
}

/**
 * Why the sandbox itself never got as far as the command, or null when it did.
 *
 * Exit codes cannot tell this apart — bwrap, prlimit and systemd-run exit 1, 126 or 127 for
 * their own failures, which is exactly what a known-red test may predict. bwrap reports the
 * sandboxed child's pid on its status fd once it has one, so no report means the chain died
 * before bwrap got that far; and bwrap's own setup errors, after that point, are prefixed
 * with its name. A test that imitates the prefix only makes its own experiment invalid,
 * which is the direction a false positive is allowed to go.
 */
function launchFailure(run: { stderr: string; spawnError?: string; started: boolean }): string | null {
  if (run.spawnError) return `the sandbox did not start: ${run.spawnError}`;
  if (!run.started) return `the sandbox did not start: ${run.stderr.split('\n')[0].slice(0, 300) || 'no status from bwrap'}`;
  const m = /^(bwrap|prlimit): .*/.exec(run.stderr);
  return m ? `the sandbox did not start: ${m[0].slice(0, 300)}` : null;
}

/** Is `file` still a regular file holding exactly `bytes`? A symlink in its place is not. */
function sameFile(file: string, bytes: Buffer): boolean {
  try {
    return fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(bytes);
  } catch {
    return false;
  }
}

const SCRATCH_PREFIX = 'daylight-experiment-';
const OWNER_FILE = 'owner.json';

interface ScratchOwner { pid: number; experimentId: string; repoRoot: string; startedAt: number }

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Clean up after runners that died without reaching their `finally` — SIGKILL, OOM, power.
 *
 * Each run leaves `owner.json` in its scratch directory. One whose process is gone is taken
 * apart: its worktree removed and pruned, the directory deleted, and the experiment it was
 * running, if it is in this store and still pending, concluded `invalid`.
 *
 * `owner.json` is input from a shared /tmp, not an instruction: a planted one could name any
 * repository and point `work` at a real worktree full of uncommitted work. So only a
 * directory this uid made with mode 0700, whose owner names *this* run's repository, whose
 * `work` is a real directory (not a link) registered as a worktree *of that repository*, is
 * swept; and only a row of this project is concluded. Anything else is reported and left
 * exactly as it is.
 */
export function sweepAbandoned(
  ctx: { repoRoot: string; projectId: string; store: ExperimentStoreLike; events?: EventSink },
  tmp: string = os.tmpdir(),
): number {
  let swept = 0;
  const uid = process.getuid?.();
  const repoRoot = path.resolve(ctx.repoRoot);
  let worktreesDir: string | null = null;
  try {
    worktreesDir = fs.realpathSync(path.join(repoRoot, '.git', 'worktrees'));
  } catch {
    // No linked worktrees at all: nothing here can be one of ours.
  }
  const leave = (dir: string, why: string) =>
    process.stderr.write(`daylight: left ${dir} alone: ${why}\n`);
  for (const name of fs.readdirSync(tmp).filter((n) => n.startsWith(SCRATCH_PREFIX))) {
    const dir = path.join(tmp, name);
    let owner: ScratchOwner;
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) continue;
      owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')) as ScratchOwner;
    } catch {
      continue;
    }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || processAlive(owner.pid)) continue;
    if (typeof owner.repoRoot !== 'string' || path.resolve(owner.repoRoot) !== repoRoot) {
      leave(dir, 'its owner names another repository');
      continue;
    }
    const work = path.join(dir, 'work');
    const whyNot = foreignWorktree(work, worktreesDir);
    if (whyNot) {
      leave(dir, whyNot);
      continue;
    }
    try {
      git(repoRoot, ['worktree', 'remove', '--force', work]);
    } catch {
      // Already removed, or the repository is gone; the directory still goes.
    }
    try {
      git(repoRoot, ['worktree', 'prune']);
    } catch {
      // As above.
    }
    fs.rmSync(dir, { recursive: true, force: true });
    swept++;

    const x = typeof owner.experimentId === 'string' ? ctx.store.experiment?.(owner.experimentId) : null;
    if (x && x.conclusion === 'pending' && x.projectId === ctx.projectId) {
      const why = `runner died: process ${owner.pid} exited before concluding the experiment`;
      ctx.store.updateExperiment(x.id, { conclusion: 'invalid', limitations: [...x.limitations, why] });
      ctx.events?.append({
        projectId: x.projectId, missionId: x.missionId, category: 'experiment', name: 'experiment.concluded',
        payload: { experimentId: x.id, conclusion: 'invalid', runs: 0, why },
      });
    }
  }
  return swept;
}

/**
 * Why `work` is not a linked worktree of the repository whose `.git/worktrees` is given, or
 * null when it is: a real directory, holding a regular `.git` file whose `gitdir:` resolves
 * inside that directory, to metadata whose own `gitdir` file points back at it. A missing `work` is fine — the runner died before the checkout.
 */
function foreignWorktree(work: string, worktreesDir: string | null): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(work);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return 'its work is not a plain directory';
  let gitFile: string;
  try {
    const g = path.join(work, '.git');
    if (!fs.lstatSync(g).isFile()) return 'its work/.git is not a regular file';
    gitFile = fs.readFileSync(g, 'utf8');
  } catch {
    return 'its work has no .git file';
  }
  const m = /^gitdir: (.+)$/m.exec(gitFile);
  if (!m || !worktreesDir) return 'its work is not a worktree of this repository';
  let gitdir: string;
  try {
    gitdir = fs.realpathSync(path.resolve(work, m[1].trim()));
  } catch {
    return 'its worktree metadata does not exist';
  }
  if (!gitdir.startsWith(`${worktreesDir}${path.sep}`)) return 'its work is a worktree of another repository';
  // The forward link is only a file's say-so, and a copy of a real worktree's .git file says
  // the same. git's own record of where that worktree lives has to name this one.
  try {
    const back = fs.readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim();
    if (fs.realpathSync(path.resolve(gitdir, back)) === fs.realpathSync(path.join(work, '.git'))) return null;
  } catch {
    return 'its worktree metadata does not name it';
  }
  return 'its worktree metadata names another checkout';
}

type Emit = (name: string, payload: Record<string, unknown>, artifactIds?: string[]) => void;

/**
 * Where one experiment's runs are written down: each record an artifact and an event the
 * moment it exists. The P0 runner and the gate runner share it, so a gate run is recorded
 * exactly as a probe run is, plus what it ran against.
 */
interface Recorder {
  now: () => number;
  meta: { projectId: string; revision: string };
  records: ExecutionRecord[];
  refs: ArtifactRef[];
  emit: Emit;
  record(r: ExecutionRecord): ArtifactRef;
  refuse(status: ExecutionStatus, why: string, startedAt: number, argv?: string[]): void;
}

function recorder(
  experiment: Experiment, ctx: RunContext, limitations: string[], target?: ExecutionTarget,
): Recorder {
  const now = ctx.now ?? (() => Date.now());
  const meta = { projectId: experiment.projectId, revision: experiment.baseRevision };
  const records: ExecutionRecord[] = [];
  const refs: ArtifactRef[] = [];
  const emit: Emit = (name, payload, artifactIds) =>
    ctx.events?.append({
      projectId: experiment.projectId,
      missionId: experiment.missionId,
      category: 'experiment',
      name,
      artifactIds,
      payload: withholdHoldoutPath(experiment.role, experiment.testArtifact.path, {
        experimentId: experiment.id, ...(target ? { target: target.kind, diffDigest: target.diffDigest } : {}), ...payload,
      }),
    });
  const record = (r: ExecutionRecord) => {
    const full: ExecutionRecord = target ? { ...r, target } : r;
    records.push(full);
    const ref = ctx.artifacts.put(JSON.stringify(full, null, 2), {
      ...meta, kind: 'result', label: `run ${full.runIndex}: ${full.status}`, mediaType: 'application/json',
    });
    refs.push(ref);
    emit('experiment.run.finished', {
      runIndex: full.runIndex, status: full.status, exitCode: full.exitCode, timedOut: full.timedOut,
      matchesPrediction: full.matchesPrediction, why: full.why,
    }, [ref.id, ...(full.stdoutRef ? [full.stdoutRef.id] : []), ...(full.stderrRef ? [full.stderrRef.id] : [])]);
    return ref;
  };
  const refuse = (status: ExecutionStatus, why: string, startedAt: number, argv: string[] = []) => {
    limitations.push(why);
    record({
      experimentId: experiment.id, runIndex: records.length, status, why,
      command: experiment.command, sandboxArgv: argv, sandboxProfile: experiment.sandboxProfile,
      exitCode: null, signal: null, timedOut: false, durationMs: now() - startedAt,
      prediction: experiment.prediction, matchesPrediction: false,
      harnessDigest: experiment.harnessDigest, startedAt, finishedAt: now(),
    });
  };
  return { now, meta, records, refs, emit, record, refuse };
}

interface RunLoop {
  experiment: Experiment;
  ctx: RunContext;
  profile: SandboxProfile;
  rec: Recorder;
  /** The host directory bound read-only at `/work`, as given and as resolved. */
  worktree: string;
  root: string;
  testRel: string;
  /** Where the registered bytes were placed on the host, as the mount point. */
  placed: string;
  registered: Buffer;
  runs: number;
  timeoutMs: number;
  limitations: string[];
  /** After each run: why the tree under test is no longer the one it was, or null. */
  treeDrift?: () => string | null;
  /** After a run that finished: why its output cannot be read as a result, or null. */
  unreadable?: (stdout: string, stderr: string, signal: string | null) => string | null;
  /** A cargo gate's second placement of the same bytes, worktree-relative, and where it is on the host. */
  cargoTest?: { rel: string; placed: string };
  /** Everything a cargo run needs beside `/work`. */
  cargo?: { binds: SandboxBind[]; env: Record<string, string> };
}

/** The runs themselves: the registered test, bound in from memory, `runs` times. */
async function runRegistered(o: RunLoop): Promise<void> {
  const { experiment, ctx, rec } = o;
  const binaries = sandboxBinaries(o.profile);
  if (!binaries.scope) o.limitations.push(NO_SCOPE_LIMITATION);
  for (let i = 0; i < o.runs; i++) {
    const runStarted = rec.now();
    // The test is bound into the sandbox from the verified buffer on every run. The worktree
    // copy is only the mount point, and a same-uid process can rewrite it between runs.
    const argv = sandboxArgv(o.profile, {
      worktree: o.worktree,
      command: experiment.command,
      limits: ctx.limits ?? DEFAULT_LIMITS,
      env: { DAYLIGHT_RUN_INDEX: String(i), DAYLIGHT_EXPERIMENT: experiment.id, ...o.cargo?.env },
      files: [{ fd: TEST_FD, path: o.testRel }, ...(o.cargoTest ? [{ fd: CARGO_TEST_FD, path: o.cargoTest.rel }] : [])],
      statusFd: STATUS_FD,
      harness: experiment.harness ?? 'node',
      binds: o.cargo?.binds,
    });
    const shown = argv.map((a) => (a === o.worktree || a === o.root ? '<worktree>' : a));
    rec.emit('experiment.run.started', { runIndex: i, command: experiment.command, sandboxArgv: shown });

    const run = await execute(argv, o.timeoutMs, o.registered, binaries.scope ?? binaries.prlimit, o.cargoTest ? o.registered : undefined);
    const label = (s: string) => `run ${i} ${s}`;
    const stdoutRef = ctx.artifacts.put(run.stdout, { ...rec.meta, kind: 'log', label: label('stdout') });
    const stderrRef = ctx.artifacts.put(run.stderr, { ...rec.meta, kind: 'log', label: label('stderr') });
    if (run.truncated) o.limitations.push(`run ${i}: output exceeded ${STREAM_CAP} bytes and was cut`);
    const { observed, matches } = observe(experiment.prediction, run);
    // Something rewrote the copy while we held the worktree. The bytes that ran were still
    // the registered ones, but a harness under attack is not one to draw a conclusion from.
    const driftedAt = !sameFile(o.placed, o.registered) ? o.testRel
      : o.cargoTest && !sameFile(o.cargoTest.placed, o.registered) ? o.cargoTest.rel : null;
    const drifted = driftedAt !== null;
    const moved = drifted ? null : o.treeDrift?.() ?? null;
    const unstarted = launchFailure(run);
    const unreadable = drifted || moved || unstarted || run.timedOut ? null : o.unreadable?.(run.stdout, run.stderr, run.signal) ?? null;
    const status: ExecutionStatus = drifted || moved || unstarted || unreadable ? 'invalid' : run.timedOut ? 'timeout' : 'ran';
    rec.record({
      experimentId: experiment.id, runIndex: i,
      status,
      why: drifted
        ? `the worktree copy of ${driftedAt} changed during the experiment; something else is writing to it`
        : moved ?? unstarted ?? unreadable ?? (run.timedOut ? `killed at the ${o.timeoutMs}ms wall-clock ceiling` : undefined),
      command: experiment.command, sandboxArgv: shown, sandboxProfile: experiment.sandboxProfile,
      sandboxBinaries: binaries,
      exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut,
      durationMs: rec.now() - runStarted, stdoutRef, stderrRef,
      prediction: experiment.prediction, observed, matchesPrediction: status === 'ran' && matches,
      harnessDigest: experiment.harnessDigest, startedAt: runStarted, finishedAt: rec.now(),
    });
  }
}

export async function runExperiment(experiment: Experiment, ctx: RunContext): Promise<Experiment> {
  sweepAbandoned({ ...ctx, projectId: experiment.projectId });
  const runs = Math.max(1, ctx.runs ?? 2);
  const timeoutMs = ctx.timeoutMs ?? 60_000;
  const profile = ctx.sandbox ?? detectSandbox();
  const limitations = [...experiment.limitations];
  const rec = recorder(experiment, ctx, limitations);
  const { records, refs, emit, refuse } = rec;
  const finish = (): Experiment => {
    const conclusion = concludeFrom(records);
    const updated = ctx.store.updateExperiment(experiment.id, {
      executions: [...experiment.executions, ...refs], conclusion, limitations,
    });
    emit('experiment.concluded', { conclusion, runs: records.length }, refs.map((r) => r.id));
    return updated;
  };

  const startedAt = rec.now();

  // Everything that can disqualify the experiment is checked before a worktree exists, so a
  // refused run leaves nothing behind and spawns nothing.
  if (!profile.available) {
    refuse('denied', `sandbox unavailable: ${profile.why ?? 'no profile'}`, startedAt);
    return finish();
  }
  const rev = commitOf(experiment.baseRevision);
  if ('why' in rev) {
    refuse('invalid', rev.why, startedAt);
    return finish();
  }
  if (!ctx.artifacts.has(experiment.testArtifact)) {
    refuse('invalid', `registered test ${experiment.testArtifact.digest} is not in the artifact store`, startedAt);
    return finish();
  }
  const testRel = experiment.testArtifact.path;
  if (!testRel) {
    refuse('invalid', 'the registered test has no path to be placed at', startedAt);
    return finish();
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
  const worktree = path.join(base, 'work');
  const owner: ScratchOwner = { pid: process.pid, experimentId: experiment.id, repoRoot: ctx.repoRoot, startedAt };
  fs.writeFileSync(path.join(base, OWNER_FILE), JSON.stringify(owner));
  try {
    try {
      git(ctx.repoRoot, [...filterOverrides(ctx.repoRoot), 'worktree', 'add', '--detach', worktree, rev.commit]);
    } catch (err) {
      refuse('invalid', `could not check out ${rev.commit.slice(0, 12)}: ${String((err as Error).message).split('\n').pop()}`, startedAt);
      return finish();
    }

    // ADR-4: the test that runs is the test that was registered. The worktree's own copy is
    // not trusted; a different file already at that path is a tamper, not a coincidence.
    const target = path.resolve(worktree, testRel);
    const root = fs.realpathSync(worktree);
    if (!path.resolve(root, testRel).startsWith(`${root}${path.sep}`)) {
      refuse('invalid', `test path ${testRel} escapes the worktree`, startedAt);
      return finish();
    }
    // The tree at the base revision is the author's, and a link committed in it can point at
    // any directory this uid can write. String containment above says nothing about that.
    const link = symlinkOnPath(root, testRel);
    if (link) {
      refuse('invalid', `${link} is a symlink in the checked-out tree; the test is never placed through one`, startedAt);
      return finish();
    }
    // A committed file where a directory is needed, a corrupt artifact: either way the test
    // cannot be placed, and an exception here would leave the row pending for ever.
    let registered: Buffer;
    try {
      registered = ctx.artifacts.get(experiment.testArtifact);
      if (fs.existsSync(target)) {
        const existing = fs.readFileSync(target);
        if (!existing.equals(registered)) {
          refuse(
            'invalid',
            `${testRel} already exists at ${rev.commit.slice(0, 12)} with different content from the ` +
              'registered test; the registered artifact is the protected one and is not overwritten',
            startedAt,
          );
          return finish();
        }
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const parent = fs.realpathSync(path.dirname(target));
        if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
          refuse('invalid', `the directory for ${testRel} resolves outside the worktree`, startedAt);
          return finish();
        }
        const fd = fs.openSync(
          target,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o644,
        );
        try {
          fs.writeFileSync(fd, registered);
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (err) {
      refuse('invalid', `the registered test could not be placed at ${testRel}: ${(err as Error).message}`, startedAt);
      return finish();
    }

    const allowed = checkAllowlist(experiment.command, worktree);
    if (!allowed.ok) {
      refuse('invalid', `command refused: ${allowed.why}`, startedAt);
      return finish();
    }
    const harness = harnessHolds(experiment, ctx.artifacts);
    if (!harness.ok) {
      refuse('invalid', harness.why, startedAt);
      return finish();
    }
    if (harness.legacy) {
      limitations.push('registered before the test path was covered by the harness digest; the path on the row is trusted as is');
    }

    await runRegistered({
      experiment, ctx, profile, rec, worktree, root, testRel, placed: target, registered, runs, timeoutMs, limitations,
    });
    return finish();
  } finally {
    // The worktree is disposable by definition. Removed whatever happened above, and pruned
    // so the repository's own bookkeeping does not keep naming a directory that is gone.
    try {
      git(ctx.repoRoot, ['worktree', 'remove', '--force', worktree]);
    } catch {
      // Already gone, or never added. Prune handles the metadata either way.
    }
    try {
      git(ctx.repoRoot, ['worktree', 'prune']);
    } catch {
      // Nothing to prune is not an error worth surfacing.
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/**
 * Write `bytes` at `target` as a new regular file, through no symlink, inside `root`. The
 * parent is created; a parent that resolves outside `root` refuses.
 */
function placeExclusive(root: string, target: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const parent = fs.realpathSync(path.dirname(target));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
    throw new Error(`the directory for ${path.relative(root, target)} resolves outside the worktree`);
  }
  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    fs.writeFileSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

// ---- gates -------------------------------------------------------------------------

/**
 * A tree a gate runs in. The Forge workspace (WS2) materialises it from a sibling git dir,
 * never the real checkout: the base, or the base with one candidate's diff applied.
 */
export interface GateTree {
  /** Host directory bound read-only at `/work`. */
  tree: string;
  /** The sibling git dir whose `index` describes `tree`. */
  gitDir: string;
  dispose(): void;
}

export interface GateRunContext extends RunContext {
  target: ExecutionTarget;
  /** Builds the tree to run in. Throws to refuse: the run is then `invalid`. */
  materialise: () => GateTree;
  /**
   * What a cargo gate runs with (forge/gate.ts builds it from forge/cargo.ts): its binds and
   * environment, and a check of the materialised tree (its `Cargo.lock` against the snapshot).
   * `refused` says why there is none; a cargo gate without this is `invalid`, never run bare.
   */
  cargo?: { binds: SandboxBind[]; env: Record<string, string>; preflight: (tree: string) => string | null } | { refused: string };
}

export interface GateRunResult {
  conclusion: ExperimentConclusion;
  executions: ArtifactRef[];
  limitations: string[];
  records: ExecutionRecord[];
}

/** One run cannot tell a flaky gate from a verdict, so a gate never runs fewer. */
export const MIN_GATE_RUNS = 2;

const TESTS_SUMMARY = /^(?:# |ℹ )tests (\d+)\s*$/m;

/**
 * Why a gate run's output is not a result: the node test runner prints a `tests N` summary
 * in both the tap and spec reporters, so no summary means the suite never got going, and
 * `tests 0` means there was nothing in it. Either is `invalid`, never a failing gate.
 */
export function noTestsReported(stdout: string): string | null {
  const m = TESTS_SUMMARY.exec(stdout);
  if (!m) return 'the test runner printed no tests summary; a suite that never reports crashed at load, which is not a failing gate';
  if (Number(m[1]) === 0) return 'the test runner reported 0 tests; an empty gate is not evidence either way';
  return null;
}

const CARGO_RESULT = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/gm;
const CARGO_RUNNING = /^\s+Running (.*)$/gm;
/** What a process killed by a resource ceiling leaves in cargo's stderr: rustc, the linker or the test binary. */
const RESOURCE_KILL = /\bsignal: (?:9|24|25)\b|\bsignal (?:9|24|25)\b|SIGKILL|SIGXCPU|SIGXFSZ|File size limit exceeded|CPU time limit exceeded|memory allocation of \d+ bytes failed/;

/**
 * The cargo counterpart of `noTestsReported`: `cargo test` prints `test result: ok. N passed;
 * M failed; …` per test binary, and N + M summed is how many tests ran. None ran is `invalid`.
 * A result is read only when stderr names exactly one binary run, `Running
 * tests/<target>.rs (…)`: the placed test. A `[[test]]` entry that gives the target's name to
 * another file, or a second target, is `invalid` (P2-R30).
 * No result line at all is `invalid` too, with one exception: the gate's own test target
 * failing to compile (`error: could not compile … (test "<target>")`). That is what a gate
 * calling a function the base lacks looks like in Rust, and it is a failing gate. A workspace
 * that does not build anywhere else, or a run that never got to cargo, says nothing either way.
 */
export function noCargoTestsReported(stdout: string, stderr: string, target: string, signal: string | null = null): string | null {
  const t = target.replace(/[^A-Za-z0-9_-]/g, '');
  // A ceiling killing cargo, rustc, the linker or the test is the harness's limit, not the change.
  if (signal) return `cargo was killed by ${signal}; a resource limit is not a failing gate`;
  const kill = RESOURCE_KILL.exec(stderr);
  if (kill) return `a resource limit killed part of the build or the test (${kill[0]}); that is not a failing gate`;
  const results = [...stdout.matchAll(CARGO_RESULT)];
  const running = [...stderr.matchAll(CARGO_RUNNING)].map((m) => m[1]);
  if (!results.length && !running.length) {
    // Only a rustc diagnostic located in the placed test itself: a linker failure or anything
    // else that also ends in `could not compile … (test "<target>")` is not the change failing.
    const own = new RegExp(`^error: could not compile \`[^\`\n]+\` \\(test "${t}"\\)`, 'm');
    const located = new RegExp(`^\\s*--> (?:\\S*/)?tests/${t}\\.rs:\\d+:\\d+`, 'm');
    const diagnostic = /^error(?:\[E\d+\])?: (?!could not compile|linking with)/m;
    if (own.test(stderr) && located.test(stderr) && diagnostic.test(stderr)) return null;
    return 'cargo printed no test result and the gate\'s own test target is not what failed to build; the workspace did not build or the run never started, which is not a failing gate';
  }
  if (running.length !== 1 || !running[0].startsWith(`tests/${t}.rs (`)) {
    return `the target that ran is not the placed test: cargo ran ${running.length} binar${running.length === 1 ? 'y' : 'ies'} (${running.map((r) => r.split(' (')[0]).join(', ').slice(0, 200) || 'none'}), not tests/${t}.rs alone`;
  }
  if (!results.length) return 'the placed test ran but printed no test result; it did not finish, which is not a failing gate';
  if (results.length !== 1) return `cargo printed ${results.length} test results for one binary; the output is not the placed test's alone`;
  const ran = results.reduce((n, m) => n + Number(m[1]) + Number(m[2]), 0);
  if (ran === 0) return 'cargo reported 0 tests run; an empty gate is not evidence either way';
  return null;
}

/**
 * Why `t.tree` no longer matches its index, apart from the placed test, or null. A same-uid
 * process can write to the host directory between runs; a tree that moved is not the one the
 * digest names.
 */
function treeDriftOf(t: GateTree, testRel: string, alsoPlaced?: string): string | null {
  const run = (args: string[]) =>
    execFileSync('git', [
      ...HARDENED_GIT_CONFIG, '-c', 'core.autocrlf=false', `--git-dir=${t.gitDir}`, `--work-tree=${t.tree}`, ...args,
    ], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      env: { ...hardenedGitEnv(), GIT_INDEX_FILE: path.join(t.gitDir, 'index') },
    });
  try {
    try {
      run(['update-index', '-q', '--refresh']);
    } catch {
      // Non-zero when entries need updating; diff-files below names them.
    }
    const changed = run(['diff-files', '--name-only', '-z']).split('\0').filter(Boolean);
    const extra = run(['ls-files', '--others', '-z']).split('\0').filter((f) => f && f !== testRel && f !== alsoPlaced);
    const moved = [...changed, ...extra];
    if (!moved.length) return null;
    return `the tree under test changed during the gate run (${moved.slice(0, 5).join(', ')}${moved.length > 5 ? ', …' : ''}); something else is writing to it`;
  } catch (err) {
    return `the tree under test could not be checked against its index: ${String((err as Error).message).split('\n')[0].slice(0, 300)}`;
  }
}

const lexists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Run a gate or holdout against the base or one candidate, in a tree the caller materialises.
 *
 * The same sandbox, the same verified-buffer binding and the same records as a P0 run, with
 * three differences. The tree is a detached Forge workspace, never a worktree of the real
 * repository. After every run the tree is checked against its own index, so anything but the
 * placed test having moved is `invalid`. And nothing is written to the experiment row: a
 * gate's conclusion belongs to the gate evaluation the caller records, so a dead runner
 * leaves no row naming a locked gate (interfaces-reconciled R-8).
 */
export async function runGate(x: Experiment, ctx: GateRunContext): Promise<GateRunResult> {
  if (!isForgeRole(x.role)) throw new Error(`runGate runs gates and holdouts; ${x.id} is a ${String(x.role)}`);
  const runs = ctx.runs ?? MIN_GATE_RUNS;
  const timeoutMs = ctx.timeoutMs ?? 60_000;
  const profile = ctx.sandbox ?? detectSandbox();
  const limitations = [...x.limitations];
  const target: ExecutionTarget = { kind: ctx.target.kind, diffDigest: ctx.target.diffDigest };
  const rec = recorder(x, ctx, limitations, target);
  const done = (): GateRunResult => ({
    conclusion: rec.records.length ? concludeFrom(rec.records) : 'invalid',
    executions: rec.refs, limitations, records: rec.records,
  });
  const startedAt = rec.now();
  const refuse = (why: string): GateRunResult => {
    rec.refuse('invalid', why, startedAt);
    return done();
  };

  if (!profile.available) {
    rec.refuse('denied', `sandbox unavailable: ${profile.why ?? 'no profile'}`, startedAt);
    return done();
  }
  if (target.kind === 'base' ? target.diffDigest !== null : !/^sha256:[0-9a-f]{64}$/.test(target.diffDigest ?? '')) {
    return refuse('a base run names no diff, and a candidate run names its diff by sha256 digest');
  }
  if (runs < MIN_GATE_RUNS) return refuse(`a gate runs at least ${MIN_GATE_RUNS} times; one run cannot tell a flake from a verdict`);
  const rev = commitOf(x.baseRevision);
  if ('why' in rev) return refuse(rev.why);
  if (!ctx.artifacts.has(x.testArtifact)) return refuse(`registered test ${x.testArtifact.digest} is not in the artifact store`);
  const testRel = x.testArtifact.path;
  if (!testRel) return refuse('the registered test has no path to be placed at');
  const harness = harnessHolds(x, ctx.artifacts);
  if (!harness.ok) return refuse(harness.why);
  if (harness.legacy) return refuse('a gate\'s expectation must name its test path, role and base; this one names no path');
  const kind = x.harness ?? 'node';
  const allowed = checkAllowlist(x.command, WORK, kind);
  if (!allowed.ok) return refuse(`command refused: ${allowed.why}`);
  const cargoRel = harness.cargoTestPath;
  let cargo: { binds: SandboxBind[]; env: Record<string, string>; preflight: (tree: string) => string | null } | undefined;
  if (kind === 'cargo') {
    if (!cargoRel) return refuse('a cargo gate\'s expectation names no crate test path');
    if (!ctx.cargo) return refuse('a cargo gate runs only with its crate snapshot and gate build cache, and none was given');
    if ('refused' in ctx.cargo) return refuse(ctx.cargo.refused);
    cargo = ctx.cargo;
  }

  let tree: GateTree;
  try {
    tree = ctx.materialise();
  } catch (err) {
    return refuse(`the tree under test could not be materialised: ${String((err as Error).message).split('\n')[0].slice(0, 300)}`);
  }
  try {
    // A tree that is gone or unreadable by now is a broken harness: recorded, never thrown.
    let root: string;
    let link: string | null;
    try {
      root = fs.realpathSync(tree.tree);
      link = symlinkOnPath(root, testRel);
    } catch (err) {
      return refuse(`the tree under test cannot be read: ${(err as Error).message}`);
    }
    const placed = path.resolve(root, testRel);
    if (!placed.startsWith(`${root}${path.sep}`)) return refuse(`test path ${testRel} escapes the tree under test`);
    if (link) return refuse(`${link} is a symlink in the tree under test; the test is never placed through one`);
    // The gate's path is the gate's alone. Anything already there came from the base or the
    // diff, and either way it is not the registered test, identical or not.
    if (lexists(placed)) return refuse(`a file is already at ${testRel} in the tree under test; a gate's test path belongs to the gate`);
    let registered: Buffer;
    try {
      registered = ctx.artifacts.get(x.testArtifact);
      placeExclusive(root, placed, registered);
    } catch (err) {
      return refuse(`the registered test could not be placed at ${testRel}: ${(err as Error).message}`);
    }
    let cargoTest: { rel: string; placed: string } | undefined;
    if (cargo && cargoRel) {
      // The same registered bytes, a second time, where cargo looks for integration tests.
      // Held to the same rules as the first: no link on the way, nothing already there.
      const at = path.resolve(root, cargoRel);
      if (!at.startsWith(`${root}${path.sep}`)) return refuse(`cargo test path ${cargoRel} escapes the tree under test`);
      let cargoLink: string | null;
      try {
        cargoLink = symlinkOnPath(root, cargoRel);
      } catch (err) {
        return refuse(`the tree under test cannot be read: ${(err as Error).message}`);
      }
      if (cargoLink) return refuse(`${cargoLink} is a symlink in the tree under test; the test is never placed through one`);
      if (lexists(at)) return refuse(`a file is already at ${cargoRel} in the tree under test; a cargo gate's test path belongs to the gate`);
      try {
        placeExclusive(root, at, registered);
      } catch (err) {
        return refuse(`the registered test could not be placed at ${cargoRel}: ${(err as Error).message}`);
      }
      const lock = cargo.preflight(root);
      if (lock) return refuse(lock);
      cargoTest = { rel: cargoRel, placed: at };
    }
    const before = treeDriftOf(tree, testRel, cargoRel);
    if (before) return refuse(before);
    const here = checkAllowlist(x.command, root, kind);
    if (!here.ok) return refuse(`command refused: ${here.why}`);

    const target = cargoRel ? path.posix.basename(cargoRel, '.rs') : '';
    await runRegistered({
      experiment: x, ctx, profile, rec, worktree: tree.tree, root, testRel, placed, registered, runs, timeoutMs,
      limitations, treeDrift: () => treeDriftOf(tree, testRel, cargoRel),
      unreadable: kind === 'cargo' ? (stdout, stderr, signal) => noCargoTestsReported(stdout, stderr, target, signal) : noTestsReported,
      ...(cargo && cargoTest ? { cargoTest, cargo: { binds: cargo.binds, env: cargo.env } } : {}),
    });
    return done();
  } finally {
    tree.dispose();
  }
}
