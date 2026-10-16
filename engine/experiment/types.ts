import type { ArtifactRef, ExpectedObservation } from '../mission/types.ts';

/**
 * Experiment-runner shapes, free of any runtime import.
 *
 * A `result` artifact holds one of these as JSON, so the renderer and the report can read an
 * execution back without the runner — the same reason the mission vocabulary sits apart
 * from the store that writes it.
 */

export type ExecutionStatus =
  /** The command ran to completion inside the sandbox, whatever it exited with. */
  | 'ran'
  /** Killed at the wall-clock ceiling. Says nothing about the hypothesis. */
  | 'timeout'
  /** The harness itself was wrong: allowlist, tampered test, unreproducible revision. */
  | 'invalid'
  /** Nothing was spawned because the sandbox was not available. */
  | 'denied';

export interface Observation {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  /** Per predicted substring: whether it was seen. Only the predicted ones are checked. */
  stdoutIncludes: Record<string, boolean>;
  stderrIncludes: Record<string, boolean>;
}

export interface ExecutionRecord {
  experimentId: string;
  runIndex: number;
  status: ExecutionStatus;
  /** When `status` is not `ran`: what went wrong, in a sentence. */
  why?: string;
  command: string[];
  /** The full argv as spawned, with the worktree path replaced by `<worktree>`. */
  sandboxArgv: string[];
  sandboxProfile: string;
  /** The absolute launcher binaries, as resolved at detection. Absent when nothing was spawned. */
  sandboxBinaries?: { prlimit: string; bwrap: string; scope?: string };
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutRef?: ArtifactRef;
  stderrRef?: ArtifactRef;
  /** What the run was predicted to show, copied so the record stands on its own. */
  prediction: ExpectedObservation;
  observed?: Observation;
  /** False for anything other than a `ran` execution whose observation met the prediction. */
  matchesPrediction: boolean;
  harnessDigest: string;
  startedAt: number;
  finishedAt: number;
}
