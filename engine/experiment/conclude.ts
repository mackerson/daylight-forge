import type { ExperimentConclusion } from '../mission/types.ts';
import type { ExecutionRecord } from './types.ts';

/**
 * What a set of executions adds up to.
 *
 * Deliberately blunt. One run that could not be trusted makes the whole experiment invalid,
 * because a conclusion drawn from the runs that happened to work is exactly the selective
 * reading this exists to prevent. A run that timed out says nothing either way. Two valid
 * runs that disagree with each other are reported as inconclusive — a flaky test is a
 * finding about the test, not evidence about the code.
 */

export type ExecutionVerdict = 'match' | 'mismatch' | 'timeout' | 'invalid' | 'denied';

export function verdictOf(e: ExecutionRecord): ExecutionVerdict {
  if (e.status === 'denied') return 'denied';
  if (e.status === 'invalid') return 'invalid';
  if (e.status === 'timeout' || e.timedOut) return 'timeout';
  return e.matchesPrediction ? 'match' : 'mismatch';
}

export function concludeFrom(executions: ExecutionRecord[]): ExperimentConclusion {
  if (!executions.length) return 'pending';
  const verdicts = executions.map(verdictOf);
  if (verdicts.some((v) => v === 'denied' || v === 'invalid')) return 'invalid';
  // A run that never finished is not dropped from the count: a test that completes once and
  // hangs once has not reproduced anything, and reading only the run that finished would be
  // the selective reading again.
  if (verdicts.some((v) => v === 'timeout')) return 'inconclusive';
  if (verdicts.every((v) => v === 'match')) return 'supported';
  if (verdicts.every((v) => v === 'mismatch')) return 'falsified';
  return 'inconclusive';
}
