import type {
  Candidate, CandidateVerdict, Experiment, GateEvaluation, LockGatesScope,
} from '../mission/types.ts';

/**
 * A candidate's verdict, as a pure function of rows (PLAN F-4.8, ADR-19).
 *
 * The inputs are what the ledger can show: the candidate's diff and policy record, the
 * mission's base, the gate lock, the locked experiments as they are now, and the gate
 * evaluations. There is deliberately no field for the attempt's state or exit code, the
 * author's narrative, or any reviewer's claim (resolution 12): a killed author whose diff
 * passes every gate is evidence, and an author that exits 0 saying "all tests pass" is not.
 * `verdict-is-pure` in daylight.invariants.json keeps this file from calling into the store,
 * the runner or the swarm, so nothing can be looked up behind the rows' backs.
 *
 * First match wins: no-diff, policy-violation, stale-base, gates-invalid, gates-inconclusive,
 * accepted-by-gates, rejected-by-gates.
 */

type Evaluation = Pick<GateEvaluation, 'experimentId' | 'candidateId' | 'target' | 'diffDigest' | 'harnessDigest' | 'conclusion'>;

export interface VerdictRows {
  candidate: Pick<Candidate, 'id' | 'baseCommit' | 'files' | 'policyViolations' | 'secretHits' | 'gateSetDigest'> & {
    /** The digest of the candidate's diff artifact: what every evaluation must name. */
    diffDigest: string;
  };
  /** The mission's base revision resolved to a commit; null when it does not resolve. */
  missionBase: string | null;
  /** The mission's current `lock-gates` decision, or null when there is none. */
  lock: { decisionId: string; scope: LockGatesScope } | null;
  /** The experiments the lock names, as their rows read now. A missing one is simply absent. */
  locked: Array<Pick<Experiment, 'id' | 'role' | 'harnessDigest' | 'lockedBy'>>;
  /** Base evaluations of the mission, oldest first. */
  baseline: Evaluation[];
  /** Candidate evaluations of this candidate, oldest first. */
  evaluations: Evaluation[];
}

export interface CandidateVerdictResult {
  verdict: CandidateVerdict;
  reasons: string[];
}

const latest = <T>(xs: T[]): T | undefined => xs.at(-1);

export function candidateVerdict(rows: VerdictRows): CandidateVerdictResult {
  const c = rows.candidate;
  const out = (verdict: CandidateVerdict, reasons: string[]): CandidateVerdictResult => ({ verdict, reasons });

  if (!c.files.length || c.policyViolations.some((v) => v.rule === 'empty-diff')) {
    return out('no-diff', ['the candidate changes no file']);
  }
  if (c.policyViolations.length || c.secretHits > 0) {
    return out('policy-violation', [
      ...c.policyViolations.map((v) => (v.path === null ? v.rule : `${v.rule}: ${v.path}`)),
      ...(c.secretHits > 0 ? [`secret-in-diff: ${c.secretHits} hit(s)`] : []),
    ]);
  }
  if (rows.missionBase !== null && c.baseCommit !== rows.missionBase) {
    return out('stale-base', [`the candidate is built on ${c.baseCommit.slice(0, 12)}, not the mission base ${rows.missionBase.slice(0, 12)}`]);
  }

  const invalid: string[] = [];
  const results: Array<{ id: string; role: string; conclusion: string }> = [];
  if (rows.missionBase === null) invalid.push('the mission base does not resolve to a commit');
  const lock = rows.lock;
  if (!lock) {
    invalid.push('the mission has no gate lock');
  } else {
    const scope = lock.scope;
    if (c.gateSetDigest !== scope.gateSetDigest) {
      invalid.push(`the candidate was built against gate set ${c.gateSetDigest}, not the locked ${scope.gateSetDigest}`);
    }
    if (!scope.experimentIds.length) invalid.push('the lock names no gate');
    for (const id of [...scope.experimentIds].sort()) {
      const x = rows.locked.find((r) => r.id === id);
      const want = scope.harnessDigests[id];
      if (!x) {
        invalid.push(`${id}: locked, but no such experiment`);
        continue;
      }
      const who = `${x.role} ${id}`;
      if (x.role !== 'gate' && x.role !== 'holdout') invalid.push(`${who}: only gates and holdouts decide a verdict`);
      if (x.lockedBy !== lock.decisionId) invalid.push(`${who}: not locked by ${lock.decisionId}`);
      if (!want || x.harnessDigest !== want) {
        invalid.push(`${who}: harness ${x.harnessDigest} is not the locked ${want ?? 'none'}; it changed after the lock`);
        continue;
      }
      const base = latest(rows.baseline.filter((e) => e.target === 'base' && e.experimentId === id && e.harnessDigest === want));
      if (!base) invalid.push(`${who}: no baseline at the locked harness`);
      else if (base.conclusion === 'supported') {
        if (!scope.vacuousOverrides.includes(id)) invalid.push(`${who}: passes on the base and was not accepted as vacuous`);
      } else if (base.conclusion !== 'falsified') invalid.push(`${who}: baseline ${base.conclusion}, never lockable`);

      const e = latest(rows.evaluations.filter((r) => r.target === 'candidate' && r.experimentId === id
        && r.candidateId === c.id && r.diffDigest === c.diffDigest && r.harnessDigest === want));
      if (!e) invalid.push(`${who}: no evaluation on ${c.diffDigest} at the locked harness`);
      else if (e.conclusion !== 'supported' && e.conclusion !== 'falsified' && e.conclusion !== 'inconclusive') {
        invalid.push(`${who}: ${e.conclusion} on this diff`);
      } else results.push({ id, role: x.role, conclusion: e.conclusion });
    }
  }
  if (invalid.length) return out('gates-invalid', invalid);

  const unsure = results.filter((r) => r.conclusion === 'inconclusive');
  if (unsure.length) return out('gates-inconclusive', unsure.map((r) => `${r.role} ${r.id}: inconclusive (flaky or timed out)`));
  const failed = results.filter((r) => r.conclusion !== 'supported');
  if (!failed.length) {
    return out('accepted-by-gates', [`all ${results.length} locked gate(s) and holdout(s) supported on ${c.diffDigest}`]);
  }
  return out('rejected-by-gates', failed.map((r) => `${r.role} ${r.id}: ${r.conclusion} on this diff`));
}
