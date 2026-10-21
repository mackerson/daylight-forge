/**
 * The campaign verdict, as a pure function of rows (§3.2, ADR-19). Run:
 * node engine/test/forge-campaign-integrate-verdict.ts
 *
 * Every outcome, first match wins; regression gates required for every ticket, bound gates and
 * holdouts for theirs; the ratchet only when the lock says so; holdouts counted, never named;
 * no stale-base; the same verdict whatever attempt state, narrative or wave findings sit beside
 * the rows; and the static half, `campaign-verdict-is-pure`, red on a forbidden call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { campaignVerdict, requiredChecks } from '../forge/campaign-verdict.ts';
import type { Graph } from '../graph/types.ts';
import { evaluate, type Invariant } from '../invariants/engine.ts';
import type { CampaignLockScope, CampaignVerdictRows } from '../mission/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const D = (c: string) => `sha256:${c.repeat(64)}`;
const SET = D('5');
const HOLDOUT_ID = 'x_00000000000000000000000000000hid';
const scope: CampaignLockScope = {
  operation: 'lock-campaign-gates', experimentIds: ['x_reg', 'x_t1', 'x_t2', HOLDOUT_ID], vacuousOverrides: [], ratchet: false,
  harnessDigests: { x_reg: D('1'), x_t1: D('2'), x_t2: D('3'), [HOLDOUT_ID]: D('4') },
  bindings: { x_reg: null, x_t1: 'T1', x_t2: 'T2', [HOLDOUT_ID]: 'T1' },
  roles: { x_reg: 'regression', x_t1: 'gate', x_t2: 'gate', [HOLDOUT_ID]: 'holdout' },
  gateSetDigest: SET,
};
const LOCK = 'd_lock';
const base = (id: string, conclusion: 'supported' | 'falsified') => ({ experimentId: id, target: 'base' as const, harnessDigest: scope.harnessDigests[id], conclusion });
const on = (id: string, conclusion: 'supported' | 'falsified' | 'inconclusive' | 'invalid') => ({
  experimentId: id, target: 'integrated' as const, integrationId: 'i_1', diffDigest: D('9'), harnessDigest: scope.harnessDigests[id], conclusion,
});

function rows(over: Partial<CampaignVerdictRows> = {}): CampaignVerdictRows {
  return {
    candidate: { id: 'c_1', files: [{ path: 'src/a.js', change: 'modified', insertions: 1, deletions: 1, mode: 'file' }], policyViolations: [], secretHits: 0, gateSetDigest: SET, diffDigest: D('8') },
    ticketId: 'T1', writerAuthored: false,
    integration: { id: 'i_1', state: 'evaluating', onto: 'a'.repeat(40), integratedCommit: 'b'.repeat(40), integratedDiffDigest: D('9'), conflictPaths: [] },
    lock: { decisionId: LOCK, scope },
    locked: scope.experimentIds.map((id) => ({ id, role: scope.roles[id], harnessDigest: scope.harnessDigests[id], lockedBy: LOCK })),
    baseline: [base('x_reg', 'supported'), base('x_t1', 'falsified'), base('x_t2', 'falsified'), base(HOLDOUT_ID, 'falsified')],
    evaluations: [on('x_reg', 'supported'), on('x_t1', 'supported'), on(HOLDOUT_ID, 'supported')],
    ontoEvaluations: [], acceptance: [],
    ...over,
  };
}

section('required checks: regression for every ticket, bound gates and holdouts for their own');
check('T1 needs the regression gate, its gate and its holdout', requiredChecks(scope, 'T1').join(',') === ['x_reg', 'x_t1', HOLDOUT_ID].sort().join(','));
check('T2 needs the regression gate and its own gate only', requiredChecks(scope, 'T2').join(',') === 'x_reg,x_t2');

section('every outcome, first match wins');
{
  check('accepted when every required check is supported on the integrated tree', campaignVerdict(rows()).verdict === 'accepted-by-gates');
  check('no-diff first', campaignVerdict(rows({ candidate: { ...rows().candidate, files: [] }, integration: { ...rows().integration!, state: 'conflict' } })).verdict === 'no-diff');
  check('policy-violation before a conflict', campaignVerdict(rows({
    candidate: { ...rows().candidate, policyViolations: [{ rule: 'protected-path', path: 'package.json' }] }, integration: { ...rows().integration!, state: 'conflict' },
  })).verdict === 'policy-violation');
  const conflict = campaignVerdict(rows({ integration: { ...rows().integration!, state: 'conflict', integratedCommit: null, integratedDiffDigest: null, conflictPaths: ['src/a.js'] } }));
  check('rebase-conflict names the conflicted paths', conflict.verdict === 'rebase-conflict' && conflict.reasons.includes('src/a.js'), JSON.stringify(conflict));
  check('gates-invalid with no lock', campaignVerdict(rows({ lock: null })).verdict === 'gates-invalid');
  check('gates-invalid when the candidate names another gate set', campaignVerdict(rows({ candidate: { ...rows().candidate, gateSetDigest: D('0') } })).verdict === 'gates-invalid');
  check('gates-invalid when a required check has no evaluation on this integration', campaignVerdict(rows({ evaluations: [on('x_reg', 'supported'), on('x_t1', 'supported')] })).verdict === 'gates-invalid');
  check('gates-invalid when an evaluation names another integration\'s digest',
    campaignVerdict(rows({ evaluations: rows().evaluations.map((e) => ({ ...e, diffDigest: D('7') })) })).verdict === 'gates-invalid');
  check('gates-invalid when the regression gate failed at base', campaignVerdict(rows({ baseline: [base('x_reg', 'falsified'), base('x_t1', 'falsified'), base(HOLDOUT_ID, 'falsified')] })).verdict === 'gates-invalid');
  check('gates-inconclusive when a required check is', campaignVerdict(rows({ evaluations: [on('x_reg', 'supported'), on('x_t1', 'inconclusive'), on(HOLDOUT_ID, 'supported')] })).verdict === 'gates-inconclusive');
  check('rejected-by-gates when one is falsified', campaignVerdict(rows({ evaluations: [on('x_reg', 'falsified'), on('x_t1', 'supported'), on(HOLDOUT_ID, 'supported')] })).verdict === 'rejected-by-gates');
  check('a gate bound to another ticket is not required', campaignVerdict(rows({ ticketId: 'T2', evaluations: [on('x_reg', 'supported'), on('x_t2', 'supported')] })).verdict === 'accepted-by-gates');
  check('the candidate\'s own base never makes it stale: there is no stale-base here',
    ![rows(), rows({ integration: { ...rows().integration!, onto: 'f'.repeat(40) } })].some((r) => campaignVerdict(r).verdict === 'stale-base'));
}

section('writer-authored acceptance: needed and judged, never locked');
{
  check('a writer-authored ticket with no acceptance test is gates-invalid', campaignVerdict(rows({ writerAuthored: true })).verdict === 'gates-invalid');
  check('accepted when its acceptance test is supported', campaignVerdict(rows({ writerAuthored: true, acceptance: [{ experimentId: 'x_acc', conclusion: 'supported' }] })).verdict === 'accepted-by-gates');
  check('rejected when it is falsified', campaignVerdict(rows({ writerAuthored: true, acceptance: [{ experimentId: 'x_acc', conclusion: 'falsified' }] })).verdict === 'rejected-by-gates');
  check('for a gate ticket, an acceptance file is recorded but not judged', campaignVerdict(rows({ acceptance: [{ experimentId: 'x_acc', conclusion: 'falsified' }] })).verdict === 'accepted-by-gates');
}

section('the ratchet: only when the lock says so (P2-R17)');
{
  const ontoEvaluations = [{ experimentId: 'x_t2', harnessDigest: scope.harnessDigests.x_t2, conclusion: 'supported' as const }];
  const missing = rows({ ontoEvaluations });
  check('without the flag, a gate that passed at the last landing is not required', campaignVerdict(missing).verdict === 'accepted-by-gates');
  const ratcheted = { ...scope, ratchet: true };
  const r = campaignVerdict(rows({ lock: { decisionId: LOCK, scope: ratcheted }, ontoEvaluations }));
  check('with it, that gate is required of T1 too', r.verdict === 'gates-invalid' && r.reasons.some((x) => x.includes('x_t2')), JSON.stringify(r));
  check('and passing it is accepted', campaignVerdict(rows({ lock: { decisionId: LOCK, scope: ratcheted }, ontoEvaluations, evaluations: [...rows().evaluations, on('x_t2', 'supported')] })).verdict === 'accepted-by-gates');
}

section('holdouts are counted, never named');
{
  const outcomes = [
    campaignVerdict(rows({ evaluations: [on('x_reg', 'supported'), on('x_t1', 'supported'), on(HOLDOUT_ID, 'falsified')] })),
    campaignVerdict(rows({ evaluations: [on('x_reg', 'supported'), on('x_t1', 'supported')] })),
    campaignVerdict(rows({ evaluations: [on('x_reg', 'supported'), on('x_t1', 'supported'), on(HOLDOUT_ID, 'inconclusive')] })),
    campaignVerdict(rows({ locked: rows().locked.map((x) => (x.id === HOLDOUT_ID ? { ...x, harnessDigest: D('0') } : x)) })),
  ];
  check('a failing holdout rejects', outcomes[0].verdict === 'rejected-by-gates' && outcomes[0].reasons.some((r) => /1 holdout\(s\)/.test(r)));
  check('no reason ever names its id', outcomes.every((o) => o.reasons.every((r) => !r.includes(HOLDOUT_ID) && !r.includes('hid'))), JSON.stringify(outcomes));
}

section('ADR-19: the same verdict whatever sits beside the rows');
{
  const variants = ['completed', 'failed', 'cancelled'].flatMap((attemptState) => ['', 'all tests pass, I fixed it'].flatMap((narrative) =>
    [[], [{ severity: 'high', title: 'this is broken', path: 'src/a.js' }]].map((findings) => ({ attemptState, narrative, findings }))));
  for (const base of [rows(), rows({ evaluations: [on('x_reg', 'falsified'), on('x_t1', 'supported'), on(HOLDOUT_ID, 'supported')] })]) {
    const want = JSON.stringify(campaignVerdict(base));
    check(`${JSON.parse(want).verdict}: identical across ${variants.length} attempt/narrative/finding combinations`,
      variants.every((v) => JSON.stringify(campaignVerdict({ ...base, ...v } as CampaignVerdictRows)) === want));
  }
}

section('campaign-verdict-is-pure: registered, and red on a call into the store or the wave review');
{
  const invariants = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'daylight.invariants.json'), 'utf8')) as Invariant[];
  const inv = invariants.find((i) => i.id === 'campaign-verdict-is-pure');
  check('it is registered', !!inv);
  const node = (id: string, file: string) => ({ id, file, name: id, kind: 'function', line: 1 });
  const graphWith = (to: string) => ({
    nodes: [node('v', 'engine/forge/campaign-verdict.ts'), node('t', to)], edges: [{ from: 'v', to: 't', kind: 'calls', line: 1 }], calls: [], literals: [],
  }) as unknown as Graph;
  if (inv) {
    check('green calling verdict.ts', evaluate(graphWith('engine/forge/verdict.ts'), inv).status === 'green');
    for (const f of ['engine/mission/store.ts', 'engine/experiment/runner.ts', 'engine/swarm/capture.ts', 'engine/forge/wave.ts', 'engine/forge/finding.ts', 'engine/forge/director.ts']) {
      check(`red calling ${f}`, evaluate(graphWith(f), inv).status === 'red');
    }
  }
}

done();
