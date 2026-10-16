/**
 * The Forge screens' pure helpers. Run: node app/renderer/lib/screens/forge-words.test.mjs
 *
 * What a Forge screen shows is decided here, so the rules that must hold are tested here: an
 * unknown figure is the word unknown and never 0, a holdout never reaches a component, write is
 * shown with the decision that granted it, ingested work is labelled outside Daylight's
 * controls, approve is only for accepted-by-gates, and each need opens the screen that answers it.
 */
import {
  usd, tokens, ledgerUsd, ledgerTokens, costSourceOf, attemptCost, sandboxBadges, gateSetView,
  approveAllowed, applyAllowed, flaggedFiles, diffLines, workItemQueue, needTarget, mergeNeeds,
  needsStrip, guardWord, isIngestedKey, OUTSIDE, OPEN_ITEMS, IMPLEMENT_RUNNERS, verdictWord,
} from './forge-words.ts';
import {
  FORGE_IMPLEMENT, FORGE_CANDIDATES, C_ACCEPTED, C_POLICY, C_REJECTED, X_HOLDOUT, HOLDOUT_SECRET, IMPL_M,
  CONFIRM_OK, CONFIRM_REFUSED,
} from '../fixtures/forge-implement.sample.ts';
import { FORGE_WORK_ITEMS } from '../fixtures/forge-work-items.sample.ts';
import { FORGE_LEDGER, FORGE_INGEST } from '../fixtures/forge-ledger.sample.ts';
import { harness } from '../../../../engine/test/harness.ts';

const { check, section, done } = harness();

section('unknown is a word, never zero');
{
  check('a null cost is unknown', usd(null) === 'unknown');
  check('an undefined cost is unknown', usd(undefined) === 'unknown');
  check('a zero cost the provider reported is $0.00', usd(0) === '$0.00');
  check('null tokens are unknown', tokens(null) === 'unknown');
  const none = { attempts: 2, usdKnown: 0, usdUnknownCount: 2, usdScanned: 0 };
  check('a row where no attempt has a known cost reads unknown, not $0.00', ledgerUsd(none) === 'unknown', ledgerUsd(none));
  const some = { attempts: 3, usdKnown: 0.05, usdUnknownCount: 2, usdScanned: 0.31 };
  check('a partly known row is a floor with the unknown counted and the scan beside it',
    ledgerUsd(some) === '≥ $0.05 (2 unknown, $0.31 scanned)', ledgerUsd(some));
  check('a fully known row is the figure', ledgerUsd({ attempts: 2, usdKnown: 0.82, usdUnknownCount: 0, usdScanned: 0 }) === '$0.82');
  check('scanned spend never becomes known spend',
    ledgerUsd({ attempts: 1, usdKnown: 0, usdUnknownCount: 1, usdScanned: 0.4 }).startsWith('unknown'));
  check('tokens all unknown read unknown', ledgerTokens(0, 2, 2) === 'unknown');
  check('tokens partly unknown read as a floor', ledgerTokens(1830, 1, 3) === '≥ 1830');
  check('the cost source names the mix', costSourceOf(some) === 'provider ×1 · stdout-scan · none ×2', costSourceOf(some));
  check('an attempt with no cost says cost unknown', attemptCost({ costUsd: null, costSource: 'none' }) === 'cost unknown');
  check('a scanned attempt cost is labelled a guess', /stdout-scan, not known/.test(attemptCost({ costUsd: 0.31, costSource: 'stdout-scan' })));
  const rendered = FORGE_LEDGER.rows.map((r) => ledgerUsd(r));
  check('no ledger row with an unknown cost renders as $0.00',
    FORGE_LEDGER.rows.every((r, i) => !(r.usdUnknownCount > 0 && rendered[i] === '$0.00')), rendered.join(' | '));
}

section('sandbox badges: write is a mode, shown with its grant (R7)');
{
  const [a1, a2, a3, review] = FORGE_IMPLEMENT.attempts;
  const b = sandboxBadges(a1, FORGE_IMPLEMENT.decisions).map((x) => x.name);
  check('an author shows its profile', b.includes('profile author'));
  check('write on names the authorize decision and its human', b.some((n) => /^write on — d_e1e1e1e1 human:miz$/.test(n)), b.join(' | '));
  check('exec and network are shown', b.includes('exec off') && b.includes('network none'));
  const r = sandboxBadges(review, FORGE_IMPLEMENT.decisions).map((x) => x.name);
  check('a P0 reviewer reads unsandboxed — H5 open', r.includes('unsandboxed — H5 open') && r.includes('write off'));
  const ing = sandboxBadges({ origin: 'ingested', sandbox: null });
  check(`ingested work is labelled "${OUTSIDE}" and nothing else`, ing.length === 1 && ing[0].name === "outside Daylight's controls");
  const lost = sandboxBadges({ ...a1, sandbox: { ...a1.sandbox, authorizeDecisionId: 'd_ffffffffffffffffffffffffffffffff' } }, FORGE_IMPLEMENT.decisions);
  check('a grant whose decision is not in view says so rather than inventing an actor', lost.some((x) => /decision not in view/.test(x.name)));
  check('the open items are all present (R9 never hidden)', ['R9.2', 'H5', 'Q5'].every((id) => OPEN_ITEMS.some((o) => o.id === id)));
  check('claude is listed for implement, as unavailable — Q5 pending',
    IMPLEMENT_RUNNERS.some((r) => r.tool === 'claude' && !r.available && /Q5 pending/.test(r.why)));
  void a2; void a3;
}

section('the gate set: lock state, vacuous gates, and holdouts as a count only');
{
  const v = gateSetView(FORGE_IMPLEMENT.experiments, FORGE_IMPLEMENT.decisions, FORGE_IMPLEMENT.gateEvaluations);
  check('two gates, one holdout counted', v.gates.length === 2 && v.holdoutCount === 1);
  check('no holdout field survives into the view', !JSON.stringify(v).includes(HOLDOUT_SECRET) && !JSON.stringify(v).includes(X_HOLDOUT));
  check('the lock names its decision, actor and digest', v.lock.state === 'locked' && v.lock.actor === 'human:miz' && v.lock.digest.startsWith('sha256:'));
  check('a gate that passes at base is vacuous', v.gates.filter((g) => g.vacuous).length === 1);
  check('and the lock that named it says it was accepted', v.gates.filter((g) => g.acceptedAtLock).every((g) => g.vacuous) && v.gates.some((g) => g.acceptedAtLock));
  check('a gate that fails at base is its baseline', v.gates.some((g) => g.baseline === 'falsified' && !g.vacuous));
  const drift = FORGE_IMPLEMENT.experiments.map((x) => (x.role === 'gate' ? { ...x, harnessDigest: `sha256:${'0'.repeat(64)}` } : x));
  const stale = gateSetView(drift, FORGE_IMPLEMENT.decisions, []);
  check('a harness changed after the lock makes it stale, with the reason', stale.lock.state === 'stale' && /harness/.test(stale.lock.why));
  check('no lock decision is unlocked', gateSetView(FORGE_IMPLEMENT.experiments, [], []).lock.state === 'unlocked');
  check('an unrun gate says not run', gateSetView(FORGE_IMPLEMENT.experiments, [], []).gates.every((g) => g.baseline === 'not run'));
}

section('candidates: approve only when the gates accepted it; flags as text');
{
  const acc = FORGE_CANDIDATES[C_ACCEPTED].candidate;
  const pol = FORGE_CANDIDATES[C_POLICY].candidate;
  const rej = FORGE_CANDIDATES[C_REJECTED].candidate;
  check('accepted-by-gates may be approved', approveAllowed(acc).enabled);
  check('a policy violation may not, and the reason is words', !approveAllowed(pol).enabled && /policy violation/.test(approveAllowed(pol).why));
  check('rejected-by-gates may not', !approveAllowed(rej).enabled && /override/i.test(approveAllowed(rej).why));
  const every = ['pending', 'rejected-by-gates', 'gates-inconclusive', 'gates-invalid', 'policy-violation', 'no-diff', 'stale-base'];
  check('no verdict but accepted-by-gates enables approve', every.every((v) => !approveAllowed({ verdict: v }).enabled));
  check('every verdict is a word', [...every, 'accepted-by-gates'].every((v) => verdictWord(v).name.length > 0));
  const f = flaggedFiles(pol);
  const by = Object.fromEntries(f.files.map((x) => [x.path, x.rules]));
  check('the protected path is flagged with its rule', by['daylight.invariants.json']?.includes('protected-path'));
  check('the gate file is flagged', by['.daylight-gates/x_f1f1.test.js']?.includes('gate-path'));
  check('the secret is flagged on its file', by['config/.env.example']?.includes('secret-in-diff'));
  const hidden = flaggedFiles({ files: [], policyViolations: [], secretHits: 2 });
  check('secret hits with no path still flag the diff as a whole', hidden.whole.includes('secret-in-diff'));
  check('apply needs an approve first', !applyAllowed(acc, FORGE_IMPLEMENT.decisions, []).enabled);
  const approved = [...FORGE_IMPLEMENT.decisions, { id: 'd_x', actor: 'human:miz', at: 9e15, scope: { operation: 'approve-candidate', candidateId: C_ACCEPTED } }];
  check('and is allowed after one, naming who', applyAllowed(acc, approved, []).enabled && /human:miz/.test(applyAllowed(acc, approved, []).why));
  check('an approve of another candidate does not count', !applyAllowed(pol, approved, []).enabled);
  check('an applied candidate cannot be applied twice',
    !applyAllowed(acc, approved, [{ candidateId: C_ACCEPTED, commit: 'abcdef1234567890', ref: 'refs/heads/daylight/x' }]).enabled);
}

section('diff text: numbered, bounded, text only');
{
  const { lines, cut } = diffLines(FORGE_CANDIDATES[C_ACCEPTED].diff.text);
  check('lines are numbered from 1', lines[0].n === 1 && lines[lines.length - 1].n === lines.length);
  check('adds, deletes and hunks are told apart', lines.some((l) => l.kind === 'add') && lines.some((l) => l.kind === 'del') && lines.some((l) => l.kind === 'hunk'));
  check('markup in a diff stays a string', lines.some((l) => l.text.includes('<script>')) && lines.every((l) => typeof l.text === 'string'));
  check('nothing cut from a short diff', cut === 0);
  const big = diffLines(Array.from({ length: 50 }, (_, i) => `+${i}`).join('\n'), 10);
  check('a long diff is bounded and says how much was cut', big.lines.length === 10 && big.cut === 40);
  check('a giant line is cut', diffLines(`+${'x'.repeat(5000)}`).lines[0].text.length <= 2001);
}

section('work items: by status, then anchor; siblings side by side');
{
  const q = workItemQueue(FORGE_WORK_ITEMS.workItems, FORGE_WORK_ITEMS.needs);
  check('statuses come in queue order', q.map((g) => g.status).join(',') === 'proposed,approved,rejected');
  const proposed = q[0];
  check('the ambiguous anchor sorts first and carries both proposals',
    proposed.anchors[0].anchor === 'cache-invalidation' && proposed.anchors[0].ambiguous && proposed.anchors[0].items.length === 2);
  check('a lone proposal is not called ambiguous', proposed.anchors.find((a) => a.anchor === 'ttl-config')?.ambiguous === false);
  check('an empty queue is empty', workItemQueue([]).length === 0);
}

section('needs: rendered, merged, and each one opens its screen');
{
  const m = (id) => (FORGE_IMPLEMENT.candidates.some((c) => c.id === id) ? IMPL_M : undefined);
  check('a spec ambiguity opens work items', needTarget({ kind: 'spec-ambiguity', ref: 'cache-invalidation', why: '' }).screen === 'work-items');
  const g = needTarget({ kind: 'gate-lock', ref: IMPL_M, why: '' });
  check('a gate lock opens the mission on its gates', g.missionId === IMPL_M && g.tab === 'gates');
  const c = needTarget({ kind: 'candidate-decision', ref: C_ACCEPTED, why: '' }, m);
  check('a candidate decision opens that candidate', c.missionId === IMPL_M && c.tab === 'candidate' && c.candidateId === C_ACCEPTED);
  const lost = needTarget({ kind: 'apply', ref: 'c_00000000000000000000000000000000', why: '' }, m);
  check('a candidate the view does not know opens the list, not a guess', lost.screen === 'missions' && !lost.missionId);
  const b = needTarget({ kind: 'blocked', ref: IMPL_M, why: '' });
  check('blocked opens the mission', b.missionId === IMPL_M && !b.tab);
  const merged = mergeNeeds(FORGE_WORK_ITEMS.needs, FORGE_IMPLEMENT.needs);
  check('a need reported twice counts once', merged.length === FORGE_WORK_ITEMS.needs.length, String(merged.length));
  check('the strip says running and need you', needsStrip(1, 4) === '1 running · 4 need you');
}

section('guarded acts: the outcome as words');
{
  check('a refusal carries the engine\'s text verbatim',
    guardWord({ refused: CONFIRM_REFUSED.refusal }).detail === CONFIRM_REFUSED.refusal && guardWord({ refused: 'x' }).tone === 'bad');
  check('cancel says nothing was recorded', /nothing recorded/.test(guardWord({ canceled: true, digest8: CONFIRM_OK.digest8 }).name));
  check('done names the code', guardWord({ ok: true, digest8: '7a7a7a7a' }).name === 'done · confirmed 7a7a7a7a');
  check('the confirm fixtures\' codes are their digests\' heads',
    [CONFIRM_OK, CONFIRM_REFUSED].every((p) => p.digest.slice(7, 15) === p.digest8));
}

section('ingested work');
{
  check('ingest: keys are ingested', isIngestedKey('ingest:claude-code') && !isIngestedKey('agent:claude:sonnet'));
  check('the ingest fixture keys sources on session and agent',
    new Set(FORGE_INGEST.sources.map((s) => `${s.sessionId}/${s.agentId}`)).size === FORGE_INGEST.sources.length);
}

section('every fixture is marked synthetic');
{
  const all = [FORGE_IMPLEMENT, FORGE_WORK_ITEMS, FORGE_LEDGER, FORGE_INGEST, CONFIRM_OK, CONFIRM_REFUSED, ...Object.values(FORGE_CANDIDATES)];
  check('each carries _sample: SYNTHETIC', all.every((f) => f._sample === 'SYNTHETIC'));
}

done();
