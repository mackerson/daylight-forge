import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { ArtifactStore } from '../mission/artifacts.ts';
import type {
  ArtifactRef, DaylightEventInput, ExpectedObservation, Experiment, ExperimentConclusion,
} from '../mission/types.ts';
import { concludeFrom } from './conclude.ts';
import {
  checkAllowlist, DEFAULT_LIMITS, detectSandbox, SANDBOX_LIMITATIONS, sandboxArgv, sandboxBinaries,
  SYSTEM_PATH, type SandboxLimits, type SandboxProfile,
} from './sandbox.ts';
import type { ExecutionRecord, ExecutionStatus, Observation } from './types.ts';

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
  createExperiment(
    input: Omit<Experiment, 'id' | 'executions' | 'conclusion' | 'createdAt' | 'updatedAt'>,
  ): Experiment;
  updateExperiment(
    id: string,
    patch: { executions?: ArtifactRef[]; conclusion?: ExperimentConclusion; limitations?: string[] },
  ): Experiment;
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
}

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

const canonicalJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x);

/**
 * Does the row still describe the experiment that was registered?
 *
 * The row — which artifact is the test, where it goes, what counts as a match — is a plain
 * UPDATE away for any process with this uid, so at run time it is checked against the digest
 * rather than believed. `legacy` is a row registered before the path was part of it.
 */
export function harnessHolds(
  x: Experiment, artifacts: ArtifactStore,
): { ok: true; legacy: boolean } | { ok: false; why: string } {
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
  const { testPath, ...prediction } = registered;
  if (canonicalJson(prediction) !== canonicalJson(x.prediction)) return edited('the prediction');
  if (testPath === undefined) return { ok: true, legacy: true };
  if (testPath !== x.testArtifact.path) return edited('the test path');
  return { ok: true, legacy: false };
}

export function registerExperiment(input: RegisterInput): Experiment {
  if (isEmptyPrediction(input.prediction)) {
    throw new InvalidExperiment(
      'a prediction that names no exit code and no output matches anything — say what the ' +
        'run will show if the hypothesis is true',
    );
  }
  // The worktree does not exist yet; containment is a property of the path, not the tree.
  const allowed = checkAllowlist(input.command, '/work');
  if (!allowed.ok) throw new InvalidExperiment(allowed.why);
  const rel = path.posix.normalize(input.testPath);
  if (path.posix.isAbsolute(rel) || rel.startsWith('..')) {
    throw new InvalidExperiment(`testPath must be repo-relative and inside the worktree: ${input.testPath}`);
  }

  const profile = input.sandboxProfile ?? 'bwrap';
  const meta = { projectId: input.projectId, revision: input.baseRevision };
  const testArtifact = input.artifacts.put(input.testSource, {
    ...meta, kind: 'test', path: rel, label: 'registered test',
  });
  // Where the test is placed decides what runs, so it is part of the protected expectation
  // and, through that artifact's digest, of the harness digest.
  const expectedArtifact = input.artifacts.put(JSON.stringify({ ...input.prediction, testPath: rel }, null, 2), {
    ...meta, kind: 'expected', label: 'prediction', mediaType: 'application/json',
  });

  const experiment = input.store.createExperiment({
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
    limitations: [...SANDBOX_LIMITATIONS],
  });

  input.events?.append({
    projectId: input.projectId,
    missionId: input.missionId,
    category: 'experiment',
    name: 'experiment.registered',
    artifactIds: [testArtifact.id, expectedArtifact.id],
    payload: {
      experimentId: experiment.id, subject: input.subject, predicate: input.predicate,
      harnessDigest: experiment.harnessDigest, command: input.command,
    },
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

/**
 * Spawn and wait, with a wall-clock ceiling that is actually enforced. `feed`, when given, is
 * written to the child's fd 3 and closed — bwrap reads it into the sandbox at setup.
 */
function execute(
  argv: string[], timeoutMs: number, feed: Buffer | undefined, bin: string,
): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; truncated: boolean; spawnError?: string }> {
  return new Promise((resolve) => {
    // The outer process is prlimit, which execs bwrap; the sandbox has --die-with-parent, so
    // killing this one pid takes the whole tree with it. `bin` is the absolute launcher and
    // the PATH it resolves bwrap on is the system's, never the caller's.
    const child = spawn(bin, argv.slice(1), {
      argv0: argv[0],
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: { PATH: SYSTEM_PATH },
    });
    const pipe = child.stdio[TEST_FD] as Writable;
    // A launcher that dies before reading closes the pipe; that failure is reported by the
    // exit status, not by an unhandled EPIPE here.
    pipe.on('error', () => {});
    pipe.end(feed ?? Buffer.alloc(0));
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
      resolve({ exitCode: null, signal: null, timedOut, stdout, stderr: `${stderr}${err.message}`, truncated, spawnError: err.message });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr, truncated });
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
 * Exit codes cannot tell this apart — bwrap and prlimit exit 1, 126 or 127 for their own
 * failures, which is exactly what a known-red test may predict — but both prefix their own
 * diagnostics with their name. A test that imitates the prefix only makes its own experiment
 * invalid, which is the direction a false positive is allowed to go.
 */
function launchFailure(run: { stderr: string; spawnError?: string }): string | null {
  if (run.spawnError) return `the sandbox did not start: ${run.spawnError}`;
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

export async function runExperiment(experiment: Experiment, ctx: RunContext): Promise<Experiment> {
  const now = ctx.now ?? (() => Date.now());
  const runs = Math.max(1, ctx.runs ?? 2);
  const timeoutMs = ctx.timeoutMs ?? 60_000;
  const profile = ctx.sandbox ?? detectSandbox();
  const emit = (name: string, payload: Record<string, unknown>, artifactIds?: string[]) =>
    ctx.events?.append({
      projectId: experiment.projectId,
      missionId: experiment.missionId,
      category: 'experiment',
      name,
      artifactIds,
      payload: { experimentId: experiment.id, ...payload },
    });
  const meta = { projectId: experiment.projectId, revision: experiment.baseRevision };
  const records: ExecutionRecord[] = [];
  const refs: ArtifactRef[] = [];
  const limitations = [...experiment.limitations];

  const record = (r: ExecutionRecord) => {
    records.push(r);
    const ref = ctx.artifacts.put(JSON.stringify(r, null, 2), {
      ...meta, kind: 'result', label: `run ${r.runIndex}: ${r.status}`, mediaType: 'application/json',
    });
    refs.push(ref);
    emit('experiment.run.finished', {
      runIndex: r.runIndex, status: r.status, exitCode: r.exitCode, timedOut: r.timedOut,
      matchesPrediction: r.matchesPrediction, why: r.why,
    }, [ref.id, ...(r.stdoutRef ? [r.stdoutRef.id] : []), ...(r.stderrRef ? [r.stderrRef.id] : [])]);
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
  const finish = (): Experiment => {
    const conclusion = concludeFrom(records);
    const updated = ctx.store.updateExperiment(experiment.id, {
      executions: [...experiment.executions, ...refs], conclusion, limitations,
    });
    emit('experiment.concluded', { conclusion, runs: records.length }, refs.map((r) => r.id));
    return updated;
  };

  const startedAt = now();

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

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-experiment-'));
  const worktree = path.join(base, 'work');
  try {
    try {
      git(ctx.repoRoot, ['worktree', 'add', '--detach', worktree, rev.commit]);
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
    const registered = ctx.artifacts.get(experiment.testArtifact);
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

    const binaries = sandboxBinaries(profile);
    for (let i = 0; i < runs; i++) {
      const runStarted = now();
      // The test is bound into the sandbox from the verified buffer on every run. The worktree
      // copy is only the mount point, and a same-uid process can rewrite it between runs.
      const argv = sandboxArgv(profile, {
        worktree,
        command: experiment.command,
        limits: ctx.limits ?? DEFAULT_LIMITS,
        env: { DAYLIGHT_RUN_INDEX: String(i), DAYLIGHT_EXPERIMENT: experiment.id },
        files: [{ fd: TEST_FD, path: testRel }],
      });
      const shown = argv.map((a) => (a === worktree || a === root ? '<worktree>' : a));
      emit('experiment.run.started', { runIndex: i, command: experiment.command, sandboxArgv: shown });

      const run = await execute(argv, timeoutMs, registered, binaries.prlimit);
      const label = (s: string) => `run ${i} ${s}`;
      const stdoutRef = ctx.artifacts.put(run.stdout, { ...meta, kind: 'log', label: label('stdout') });
      const stderrRef = ctx.artifacts.put(run.stderr, { ...meta, kind: 'log', label: label('stderr') });
      if (run.truncated) limitations.push(`run ${i}: output exceeded ${STREAM_CAP} bytes and was cut`);
      const { observed, matches } = observe(experiment.prediction, run);
      // Something rewrote the copy while we held the worktree. The bytes that ran were still
      // the registered ones, but a harness under attack is not one to draw a conclusion from.
      const drifted = !sameFile(target, registered);
      const unstarted = launchFailure(run);
      const status: ExecutionStatus = drifted || unstarted ? 'invalid' : run.timedOut ? 'timeout' : 'ran';
      record({
        experimentId: experiment.id, runIndex: i,
        status,
        why: drifted
          ? `the worktree copy of ${testRel} changed during the experiment; something else is writing to it`
          : unstarted ?? (run.timedOut ? `killed at the ${timeoutMs}ms wall-clock ceiling` : undefined),
        command: experiment.command, sandboxArgv: shown, sandboxProfile: experiment.sandboxProfile,
        sandboxBinaries: binaries,
        exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut,
        durationMs: now() - runStarted, stdoutRef, stderrRef,
        prediction: experiment.prediction, observed, matchesPrediction: status === 'ran' && matches,
        harnessDigest: experiment.harnessDigest, startedAt: runStarted, finishedAt: now(),
      });
    }
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
