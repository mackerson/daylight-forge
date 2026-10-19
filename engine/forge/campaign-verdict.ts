import type { CampaignLockScope, CampaignVerdictRows, CandidateVerdict } from '../mission/types.ts';
import type { CandidateVerdictResult } from './verdict.ts';

/**
 * A campaign candidate's verdict, as a pure function of rows (§3.2, ADR-19).
 *
 * The same discipline as `verdict.ts`, judged on the integrated tree instead of the candidate's
 * own base: every required check must be `supported` on the integration's commit and digest.
 * There is no `stale-base` here (a moved tip is integrated, not refused), and a diff that does
 * not merge onto the tip is a `rebase-conflict`. Inputs carry no attempt state, narrative,
 * reviewer claim or wave finding; `campaign-verdict-is-pure` keeps this file from calling into
 * the store, the runner, the swarm, the wave review or the findings.
 *
 * First match wins: no-diff, policy-violation, rebase-conflict, gates-invalid,
 * gates-inconclusive, accepted-by-gates, rejected-by-gates.
 *
 * Required for candidate C of ticket T on integration I: every `regression` gate; every gate
 * and holdout bound to T; and, when the lock ratchets, every other gate or holdout that was
 * `supported` when the tip I was put onto landed. Holdouts are counted, never named.
 */

const latest = <T>(xs: T[]): T | undefined => xs.at(-1);

/** The locked experiments `ticketId`'s candidate must pass, before the ratchet: regression ∪ bound to the ticket. */
export function requiredChecks(lock: Pick<CampaignLockScope, 'experimentIds' | 'roles' | 'bindings'>, ticketId: string): string[] {
  return [...lock.experimentIds].sort()
    .filter((id) => lock.roles[id] === 'regression' || lock.bindings[id] === ticketId);
}

export function campaignVerdict(rows: CampaignVerdictRows): CandidateVerdictResult {
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
  const i = rows.integration;
  if (i?.state === 'conflict') {
    return out('rebase-conflict', [`the diff does not merge onto ${i.onto.slice(0, 12)}: ${i.conflictPaths.length} conflicted path(s)`, ...i.conflictPaths]);
  }

  const invalid: string[] = [];
  const hidden = new Map<string, number>();
  const note = (role: string, id: string, text: string) => {
    if (role === 'holdout') hidden.set(text, (hidden.get(text) ?? 0) + 1);
    else invalid.push(`${role} ${id}: ${text}`);
  };
  const lock = rows.lock;
  if (!i || !i.integratedCommit || !i.integratedDiffDigest) invalid.push('the candidate has no integrated commit to judge');
  if (!lock) invalid.push('the campaign has no gate lock');
  const results: Array<{ id: string; role: string; conclusion: string }> = [];
  if (lock && i?.integratedDiffDigest) {
    const scope = lock.scope;
    if (c.gateSetDigest !== scope.gateSetDigest) {
      invalid.push(`the candidate was built against gate set ${c.gateSetDigest}, not the locked ${scope.gateSetDigest}`);
    }
    const required = new Set(requiredChecks(scope, rows.ticketId));
    if (scope.ratchet) {
      for (const id of scope.experimentIds) {
        const want = scope.harnessDigests[id];
        const prior = latest(rows.ontoEvaluations.filter((e) => e.experimentId === id && e.harnessDigest === want));
        if (prior?.conclusion === 'supported') required.add(id);
      }
    }
    if (!required.size) invalid.push(`no locked check applies to ticket ${rows.ticketId}`);
    for (const id of [...required].sort()) {
      const x = rows.locked.find((r) => r.id === id);
      const role = scope.roles[id] ?? 'holdout';
      const want = scope.harnessDigests[id];
      if (!x) {
        note(role, id, 'locked, but no such experiment');
        continue;
      }
      if (x.lockedBy !== lock.decisionId) note(role, id, `not locked by ${lock.decisionId}`);
      if (!want || x.harnessDigest !== want) {
        note(role, id, 'changed after the lock');
        continue;
      }
      const base = latest(rows.baseline.filter((e) => e.target === 'base' && e.experimentId === id && e.harnessDigest === want));
      if (!base) note(role, id, 'no baseline at the locked harness');
      else if (role === 'regression') {
        if (base.conclusion !== 'supported') note(role, id, `baseline ${base.conclusion}; a regression gate must pass at the campaign base`);
      } else if (base.conclusion === 'supported') {
        if (!scope.vacuousOverrides.includes(id)) note(role, id, 'passes on the base and was not accepted as vacuous');
      } else if (base.conclusion !== 'falsified') note(role, id, `baseline ${base.conclusion}, never lockable`);

      const e = latest(rows.evaluations.filter((r) => r.target === 'integrated' && r.experimentId === id && r.integrationId === i.id
        && r.diffDigest === i.integratedDiffDigest && r.harnessDigest === want));
      if (!e) note(role, id, 'no evaluation on this integration at the locked harness');
      else if (e.conclusion !== 'supported' && e.conclusion !== 'falsified' && e.conclusion !== 'inconclusive') note(role, id, `${e.conclusion} on the integrated tree`);
      else results.push({ id, role, conclusion: e.conclusion });
    }
  }
  if (rows.writerAuthored && !rows.acceptance.length) invalid.push('the ticket asks for writer-authored tests and the candidate carries none');
  for (const [t, n] of hidden) invalid.push(`${n} holdout(s): ${t}`);
  if (invalid.length) return out('gates-invalid', invalid);

  const acceptance = rows.acceptance.map((a) => ({ id: a.experimentId, role: 'acceptance', conclusion: a.conclusion ?? 'invalid' }));
  const brokenAcceptance = acceptance.filter((a) => a.conclusion !== 'supported' && a.conclusion !== 'falsified' && a.conclusion !== 'inconclusive');
  if (rows.writerAuthored && brokenAcceptance.length) {
    return out('gates-invalid', brokenAcceptance.map((a) => `acceptance ${a.id}: ${a.conclusion} on the integrated tree`));
  }
  const all = [...results, ...(rows.writerAuthored ? acceptance : [])];
  const describe = (rs: typeof all, t: string): string[] => {
    const holdouts = rs.filter((r) => r.role === 'holdout').length;
    return [
      ...rs.filter((r) => r.role !== 'holdout').map((r) => `${r.role} ${r.id}: ${t}`),
      ...(holdouts ? [`${holdouts} holdout(s): ${t}`] : []),
    ];
  };
  const unsure = all.filter((r) => r.conclusion === 'inconclusive');
  if (unsure.length) return out('gates-inconclusive', describe(unsure, 'inconclusive (flaky or timed out)'));
  const failed = all.filter((r) => r.conclusion !== 'supported');
  if (!failed.length) {
    return out('accepted-by-gates', [`all ${all.length} required check(s) supported on the integrated tree ${i!.integratedDiffDigest}`]);
  }
  return out('rejected-by-gates', describe(failed, 'falsified on the integrated tree'));
}
