import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../mission/artifacts.ts';
import type {
  ArtifactRef, DaylightEventInput, ExpectedObservation, Experiment, ExperimentConclusion,
} from '../mission/types.ts';
import { concludeFrom } from './conclude.ts';
import {
  checkAllowlist, DEFAULT_LIMITS, detectSandbox, SANDBOX_LIMITATIONS, sandboxArgv,
  type SandboxLimits, type SandboxProfile,
} from './sandbox.ts';
import type { ExecutionRecord, ExecutionStatus, Observation } from './types.ts';

/**
 * The experiment runner: a registered test, run inside a sandbox, at a named revision.
 *
 * Two properties carry the honesty of the result and both are enforced here rather than
 * asked for. The test and its prediction are artifacts, registered before anything runs and
 * covered by one digest, so the thing being tested cannot be rewritten to match whatever came
 * out; at run time the test is copied *from the artifact store into the worktree*, and a
 * worktree that already holds a different file at that path is refused. And the revision is
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
  const expectedArtifact = input.artifacts.put(JSON.stringify(input.prediction, null, 2), {
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

const git = (root: string, args: string[]): string =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
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

/** Spawn and wait, with a wall-clock ceiling that is actually enforced. */
function execute(
  argv: string[], timeoutMs: number,
): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve) => {
    // The outer process is prlimit, which execs bwrap; the sandbox has --die-with-parent, so
    // killing this one pid takes the whole tree with it.
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
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
    child.stdout.on('data', take('stdout'));
    child.stderr.on('data', take('stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, stdout, stderr: `${stderr}${err.message}`, truncated });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr, truncated });
    });
  });
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
      fs.writeFileSync(target, registered);
    }

    const allowed = checkAllowlist(experiment.command, worktree);
    if (!allowed.ok) {
      refuse('invalid', `command refused: ${allowed.why}`, startedAt);
      return finish();
    }

    for (let i = 0; i < runs; i++) {
      const runStarted = now();
      const argv = sandboxArgv(profile, {
        worktree,
        command: experiment.command,
        limits: ctx.limits ?? DEFAULT_LIMITS,
        env: { DAYLIGHT_RUN_INDEX: String(i), DAYLIGHT_EXPERIMENT: experiment.id },
      });
      const shown = argv.map((a) => (a === worktree || a === root ? '<worktree>' : a));
      emit('experiment.run.started', { runIndex: i, command: experiment.command, sandboxArgv: shown });

      const run = await execute(argv, timeoutMs);
      const label = (s: string) => `run ${i} ${s}`;
      const stdoutRef = ctx.artifacts.put(run.stdout, { ...meta, kind: 'log', label: label('stdout') });
      const stderrRef = ctx.artifacts.put(run.stderr, { ...meta, kind: 'log', label: label('stderr') });
      if (run.truncated) limitations.push(`run ${i}: output exceeded ${STREAM_CAP} bytes and was cut`);
      const { observed, matches } = observe(experiment.prediction, run);
      record({
        experimentId: experiment.id, runIndex: i,
        status: run.timedOut ? 'timeout' : 'ran',
        why: run.timedOut ? `killed at the ${timeoutMs}ms wall-clock ceiling` : undefined,
        command: experiment.command, sandboxArgv: shown, sandboxProfile: experiment.sandboxProfile,
        exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut,
        durationMs: now() - runStarted, stdoutRef, stderrRef,
        prediction: experiment.prediction, observed, matchesPrediction: matches,
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
