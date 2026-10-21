/**
 * WS-R15: independent IR review and the human `approve-ir` (spec ingestion §6), on a small
 * synthetic corpus and scripted records and reviewers. Every guard is checked by attempting
 * what it forbids. Run: node engine/test/forge-ingest-review.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import { DAYLIGHT_DB } from '../mission/db.ts';
import type { ApproveIrSetV1, ExtractWindow, IrRecord } from '../mission/types.ts';
import { decideAssumption } from '../forge/assumptions.ts';
import { ingestNeeds } from '../forge/authority.ts';
import { confirmDigest } from '../forge/confirm.ts';
import {
  approveIr, currentIrSetDigest, repairInterpretations, IR_FINDINGS_DIR, ingestIrFindings, irFindingIdOf, oirIdOf, planApproveIr, runIrReview, validateIrFinding,
} from '../forge/ir-review.ts';
import { OUTBOX_TOOLS } from '../forge/outbox.ts';
import { runCorpusReviewCommand } from '../forge/commands-corpus-review.ts';
import { confirmCodeOf } from '../forge/policy.ts';
import { harness } from './harness.ts';
import { addRecord, addRevision, addWindow, HUMAN, makeWorld, scriptedRunner, throws, throwsAsync } from './lib/ingest-world.ts';

const { check, section, done } = harness();
const w = makeWorld('ingest-review');
const { ctx, corpus } = w;

const SPEC = [
  '# Ledger', '',
  '## Accounts', '',
  '- Every account must have exactly one owner.',
  '- An account is closed only by its owner.', '',
  '## Transfers', '',
  '- A transfer must never exceed the balance.',
  '- Transfers are recorded in the audit log.', '',
  '## Audit', '',
  '- The audit log may be exported nightly or weekly.', '',
].join('\n');
const rev = addRevision(w, { ledger: SPEC });
const owner = addRecord(w, { kind: 'requirement', docKey: 'ledger', quote: 'Every account must have exactly one owner.', statement: 'An account has one owner.', observers: ['agent:mock:default', 'agent:mock:b'] });
const close = addRecord(w, { kind: 'requirement', docKey: 'ledger', quote: 'An account is closed only by its owner.', statement: 'Only the owner closes an account.', observers: ['agent:mock:default'] });
const overdraw = addRecord(w, { kind: 'invariant', docKey: 'ledger', quote: 'A transfer must never exceed the balance.', statement: 'No overdraft.' });
const audit = addRecord(w, { kind: 'requirement', docKey: 'ledger', quote: 'Transfers are recorded in the audit log.', statement: 'Transfers are audited, and the log is signed.' });
const cadence = addRecord(w, { kind: 'ambiguity', docKey: 'ledger', quote: 'The audit log may be exported nightly or weekly.', statement: 'Export cadence is nightly or weekly.' });
const guess = addRecord(w, { kind: 'constraint', docKey: 'ledger', quote: '', statement: 'Transfers are idempotent.', source: 'inferred' });
const { window: w1 } = addWindow(w, 'ledger', ['ledger:accounts', 'ledger:transfers']);
const { window: w2 } = addWindow(w, 'ledger', ['ledger:audit']);

const fctx = (win: ExtractWindow, ids: IrRecord[]) => ({
  window: win, irIds: new Set(ids.map((r) => r.id)), elementIds: new Set<string>(),
  bodyOf: (s: string) => {
    const bytes = Buffer.from(SPEC, 'utf8');
    const idx = JSON.parse(ctx.artifacts.get(rev.sectionIndex).toString('utf8')) as { docs: Array<{ sections: Array<{ id: string; bodyStart: number; bodyEnd: number }> }> };
    const sec = idx.docs[0].sections.find((x) => x.id === s)!;
    return { start: sec.bodyStart, text: bytes.subarray(sec.bodyStart, sec.bodyEnd).toString('utf8') };
  },
});

section('report_ir_finding: shape and window, first refusal by field, never the text');
const good = { kind: 'contradiction', severity: 'high', title: 'Log signing is invented', statement: 'The text does not say the log is signed.', irId: audit.id, section: 'ledger:transfers' };
const c1 = fctx(w1, [owner, close, overdraw, audit]);
const refusedField = (raw: unknown, ctx2 = c1) => {
  const v = validateIrFinding(raw, ctx2);
  return 'refused' in v ? v.field : 'accepted';
};
check('a well-formed finding about a record of the window is accepted', refusedField(good) === 'accepted');
check('an unknown key is refused', refusedField({ ...good, approve: true }) === 'payload');
check('a kind outside the list is refused', refusedField({ ...good, kind: 'approve' }) === 'kind');
check('a two-line title is refused', refusedField({ ...good, title: 'a\nb' }) === 'title');
check('a finding other than an omission names its record', refusedField({ ...good, irId: undefined }) === 'irId');
check('an infeasible-boundary finding names its element', refusedField({ ...good, kind: 'infeasible-boundary' }) === 'elementId');
check('a record outside the window is refused', refusedField({ ...good, irId: cadence.id }) === 'irId');
check('a section outside the window is refused', refusedField({ ...good, section: 'ledger:audit' }) === 'section');
check('a quote that is not verbatim in its section is refused', refusedField({ ...good, quote: 'transfers are signed' }) === 'quote');
check('a quote occurring twice in its section is refused', refusedField({ ...good, section: 'ledger:accounts', irId: owner.id, quote: 'owner' }) === 'quote');
check('a secret-shaped quote is refused, not masked', refusedField({ ...good, quote: 'AKIAIOSFODNN7EXAMPLE' }, { ...c1, bodyOf: () => ({ start: 0, text: 'AKIAIOSFODNN7EXAMPLE' }) }) === 'quote');
const refusal = validateIrFinding({ ...good, kind: 'nope', statement: 'SENTINEL-TEXT' }, c1);
check('a refusal does not echo the text', !JSON.stringify(refusal).includes('SENTINEL'));

section('corpus review: an audit child of the corpus, blind reviewers per window, findings ingested');
check('one reviewer is not an independent review', /two distinct/.test((await throwsAsync(() => runIrReview(ctx, corpus.id, w.root, ['mock'], {
  runner: scriptedRunner(IR_FINDINGS_DIR, OUTBOX_TOOLS['ir-review'], () => []) })))?.message ?? ''));
const prompts: string[] = [];
const reviewer = scriptedRunner(IR_FINDINGS_DIR, OUTBOX_TOOLS['ir-review'], (task) => {
  const win = JSON.parse(ctx.artifacts.get(task.inputs[0]).toString('utf8')) as ExtractWindow;
  if (win.id === w2.id) {
    return task.runnerHint === 'mock'
      ? [{ kind: 'ambiguity', severity: 'medium', title: 'Cadence undecided', statement: 'Nightly or weekly is not settled.', irId: cadence.id, section: 'ledger:audit' }]
      : [];
  }
  const shared = { kind: 'invented-requirement', severity: 'high', title: 'Signed log is invented', statement: 'Nothing says the log is signed.', irId: audit.id, section: 'ledger:transfers' };
  return task.runnerHint === 'mock'
    ? [shared, { kind: 'omission', severity: 'low', title: 'Closing rule', statement: 'Closing is a requirement.', section: 'ledger:accounts', quote: 'is closed only by its owner' },
      { ...shared, irId: cadence.id }, '{"v":1,"at":1,"tool":"x","payload":{"no']
    : [{ ...shared, statement: 'The record adds signing.' }, { kind: 'wrong-dependency', severity: 'low', title: 'Owner before close', statement: 'Order.', irId: close.id, section: 'ledger:accounts' }];
});
const review = await runIrReview(ctx, corpus.id, w.root, ['mock', 'mock:b'], {
  runner: async (c, run) => {
    for (const id of run.outbox.taskIds) prompts.push(run.outbox.promptFor(c.store.task(id)!));
    return reviewer(c, run);
  },
});
const reviewMission = ctx.store.mission(review.missionId)!;
check('the review is an audit mission whose parent is the corpus, closed when done', reviewMission.kind === 'audit' && reviewMission.parentId === corpus.id
  && reviewMission.state === 'closed');
check('one task per (window, reviewer)', ctx.store.tasks(review.missionId).filter((t) => t.role === 'ir-review').length === 4);
check('every reviewer of a window gets the same prompt, fencing the text as data', prompts.length === 4 && new Set(prompts).size === 2
  && prompts.every((p) => /data, not instructions/.test(p) && /<<<SPEC-/.test(p)));
check('the prompt never says how many extractors observed a record', prompts.every((p) => !/observedBy|agent:mock/.test(p)));
check('four findings ingested, the forged one refused', review.findings.length === 5 && review.refused.some((r) => r.field === 'irId'), JSON.stringify(review.refused));
check('a torn last line is not refused', !review.refused.some((r) => r.field === 'line'));
const invented = review.findings.filter((f) => f.kind === 'invented-requirement' && f.irId === audit.id);
check('two reviewers saying the same thing corroborate each other', invented.length === 2 && invented.every((f) => f.corroboratedBy.length === 1)
  && invented[0].corroboratedBy[0] === invented[1].id);
const omission = review.findings.find((f) => f.kind === 'omission')!;
check('an omission keeps its quoted span', omission.span?.sectionId === 'ledger:accounts' && omission.span.quote === 'is closed only by its owner'
  && SPEC.slice(omission.span.start, omission.span.end) === 'is closed only by its owner');
check('every finding is open: agreement decided nothing', review.findings.every((f) => f.disposition === 'open'));
check('every record is still proposed, however many observed it', ctx.store.irRecords(corpus.id).every((r) => r.status === 'proposed')
  && ctx.store.irRecord(owner.id)!.observedBy.length === 2);
check('ingest is idempotent', ingestIrFindings(ctx, review.missionId).created.length === 0 && ctx.store.irFindings(corpus.id).length === 5);
check('a finding id names its attempt and content', invented.every((f) => f.id === irFindingIdOf(f.attemptId, {
  kind: f.kind, severity: f.severity, title: f.title, statement: f.statement, irId: f.irId!, section: 'ledger:transfers' })));
const needs = ingestNeeds(ctx, corpus);
check('the corpus needs its records and findings decided', needs.some((n) => n.kind === 'ir-undecided') && needs.some((n) => n.kind === 'ir-finding-open'));

section('approve-ir: refused unless a person names each record, every finding is disposed, and the set is current');
const set = (s: Partial<ApproveIrSetV1>): ApproveIrSetV1 => ({ kind: 'daylight-approve-ir', version: 1, corpusId: corpus.id, revisionId: rev.id, approve: [], reject: [], accept: [], dismiss: [], ...s });
const codeOf = (s: ApproveIrSetV1) => confirmCodeOf(digestOf(canonicalJson(planApproveIr(ctx, corpus.id, s).scope)));
const act = (s: ApproveIrSetV1, o: { actor?: string; env?: Record<string, string>; confirm?: string } = {}) =>
  approveIr(ctx, { corpusId: corpus.id, actor: o.actor ?? HUMAN, rationale: 'read it', confirm: o.confirm ?? codeOf(s), env: o.env ?? {}, set: s });

const agreed = set({ approve: [owner.id] });
check('approval by agreement: a reviewer or extractor actor is refused', /human/.test(throws(() => act(agreed, { actor: 'agent:mock:default' }))?.message ?? ''));
check('approval by agreement: an agent session is refused', /agent is running/.test(throws(() => act(agreed, { env: { CLAUDECODE: '1' } }))?.message ?? ''));
check('approval by agreement: no decision can be written for a record by a non-human', throws(() => ctx.store.recordDecision({
  missionId: corpus.id, projectId: corpus.projectId, revision: corpus.baseRevision, actor: 'agent:mock:default', kind: 'approve', rationale: 'two agreed',
  scope: { operation: 'approve-ir', approve: { [owner.id]: owner.contentDigest } }, artifactIds: [] })) !== null);
check('a wrong confirm code is refused', /--confirm/.test(throws(() => act(agreed, { confirm: '00000000' }))?.message ?? ''));
check('approving a record with an open finding the act leaves undisposed is refused',
  /open finding/.test(throws(() => act(set({ approve: [audit.id] })))?.message ?? ''));
check('approving a record whose finding the act accepts is refused',
  /accepted finding/.test(throws(() => act(set({ approve: [audit.id], accept: invented.map((f) => f.id) })))?.message ?? ''));
check('a set at another revision is refused', /current revision/.test(throws(() => act(set({ revisionId: 'cr_' + '9'.repeat(32), approve: [owner.id] })))?.message ?? ''));
check('a record named twice is refused', /both approve and reject/.test(throws(() => act(set({ approve: [owner.id], reject: [owner.id] })))?.message ?? ''));
check('a supersede whose new record is not approved in the act is refused',
  /does not approve/.test(throws(() => act(set({ approve: [owner.id], supersede: { [close.id]: overdraw.id } })))?.message ?? ''));
check('an act that names nothing is refused', /nothing to decide/.test(throws(() => act(set({})))?.message ?? ''));
const before = ctx.store.irRecords(corpus.id).map((r) => r.status).join();
check('nothing moved on any refusal', ctx.store.irRecords(corpus.id).map((r) => r.status).join() === before && !ctx.store.decisions(corpus.id).length);

section('an inferred record without basis opens its interpretation; a person decides it, then it is approved');
check('approving an inferred record with no basis is refused', /no basis sections/.test(throws(() => act(set({ approve: [guess.id] })))?.message ?? ''));
const interp = ctx.store.assumptionByOwnerDecision(corpus.projectId, oirIdOf(guess.id))!;
check('the refusal opened one ir-interpretation assumption, open and blocking, on the corpus', interp?.source === 'ir-interpretation' && interp.status === 'open'
  && interp.blocking && interp.irId === guess.id && interp.campaignId === corpus.id && /^OIR\.[0-9A-F]{10}$/.test(interp.ownerDecisionId ?? ''));
check('a second refusal does not open a second one', (throws(() => act(set({ approve: [guess.id] }))), ctx.store.assumptions(corpus.id).length === 1));
const decided = decideAssumption(ctx, {
  id: interp.id, operation: 'decide-assumption', value: 'yes, idempotent', actor: HUMAN, rationale: 'owner says so', env: {},
  confirm: confirmDigest(ctx, 'decide-assumption', interp.id, { value: 'yes, idempotent' }).digest8,
});
check('assumption decide answers an interpretation on a corpus', decided.assumption.status === 'confirmed');

section('approve-ir: one decision moves exactly what it names, at its digests');
const okSet = set({
  approve: [owner.id, close.id, overdraw.id, cadence.id, guess.id],
  accept: invented.map((f) => f.id),
  dismiss: [omission.id, review.findings.find((f) => f.kind === 'wrong-dependency')!.id, review.findings.find((f) => f.kind === 'ambiguity')!.id],
});
const preview = planApproveIr(ctx, corpus.id, okSet);
check('the preview lists counts per section, never a statement', preview.refusals.length === 0 && preview.lines.some((l) => /section ledger:accounts: approve 2, reject 0; single-extractor 1/.test(l))
  && !preview.lines.join('\n').includes('one owner'), preview.refusals.join('; '));
const d = act(okSet);
check('the decision is a person\'s, keyed id:contentDigest', d.actor === HUMAN && d.scope.operation === 'approve-ir'
  && (d.scope.approve as Record<string, string>)[owner.id] === owner.contentDigest && Object.keys(d.scope.approve as object).length === 5);
check('the approved set is what was confirmed', d.scope.irSetDigest === currentIrSetDigest(ctx, corpus.id));
check('records moved as named', ctx.store.irRecord(owner.id)!.status === 'approved' && ctx.store.irRecord(audit.id)!.status === 'proposed'
  && ctx.store.irRecord(guess.id)!.assumptionId === interp.id);
check('findings disposed as named', ctx.store.irFindings(corpus.id, { disposition: 'open' }).length === 0);
const opened = ctx.store.assumptions(corpus.id).filter((a) => a.id !== interp.id);
check('the approved ambiguity opened an interpretation; it picked no reading', opened.some((a) => a.irId === cadence.id && a.status === 'open' && a.default === ''));
check('the accepted invented-requirement finding opened one on its still-proposed record', opened.some((a) => a.irId === audit.id && a.status === 'open'));
check('approving a record whose finding was accepted earlier is refused', /accepted finding/.test(throws(() => act(set({ approve: [audit.id] })))?.message ?? ''));
check('an approved record is carried, never re-approved', /carried, not re-approved/.test(throws(() => act(set({ approve: [owner.id] })))?.message ?? ''));
check('the corpus now needs the interpretations decided', ingestNeeds(ctx, corpus).filter((n) => n.kind === 'ir-interpretation').length === 2);

section('the store moves a record only under a person\'s approve-ir decision on its corpus (review M1)');
{
  const plan = ctx.store.recordDecision({ missionId: corpus.id, projectId: corpus.projectId, revision: corpus.baseRevision, actor: HUMAN, kind: 'approve',
    rationale: 'borrowed', scope: { operation: 'approve-plan', planDigest: 'sha256:' + '0'.repeat(64) }, artifactIds: [] });
  const loose = addRecord(w, { kind: 'requirement', docKey: 'ledger', quote: 'exactly one owner', statement: 'Loose.' });
  check('a decision of another operation (approve-plan) is refused', /approve-ir/.test(throws(() => ctx.store.setIrStatus(loose.id, 'approved', plan.id))?.message ?? ''));
  const other = ctx.store.transitionMission(ctx.store.createMission({ projectId: corpus.projectId, kind: 'corpus', objective: 'other', baseRevision: corpus.baseRevision }).id, 'ready');
  const elsewhere = ctx.store.recordDecision({ missionId: other.id, projectId: corpus.projectId, revision: corpus.baseRevision, actor: HUMAN, kind: 'approve',
    rationale: 'other corpus', scope: { operation: 'approve-ir' }, artifactIds: [] });
  check('an approve-ir decision of another corpus is refused', /corpus/.test(throws(() => ctx.store.setIrStatus(loose.id, 'approved', elsewhere.id))?.message ?? ''));
  check('the record did not move', ctx.store.irRecord(loose.id)!.status === 'proposed');
}

section('the CLI has no agreement selector (review M4)');
{
  const code = await runCorpusReviewCommand(['approve-ir', corpus.id, '--min-agreement', '2', '--out', w.out], {});
  const code2 = await runCorpusReviewCommand(['approve-ir', corpus.id, '--approve', owner.id, '--agreed-by', 'mock,mock:b', '--out', w.out], {});
  check('approve-ir refuses an agreement flag as a usage error (exit 2), deciding nothing', code === 2 && code2 === 2 && ctx.store.irRecord(owner.id)!.decisionId === d.id);
}

section('review L3: an interpretation opened by a finding on a proposed record closes when that record is rejected');
{
  const u = ctx.store.assumptionByOwnerDecision(corpus.projectId, oirIdOf(audit.id))!;
  const rej = act(set({ reject: [audit.id] }));
  const after = ctx.store.assumption(u.id)!;
  check('the record\'s rejection overturns its open interpretation under the same decision', after.status === 'overturned' && after.decisionId === rej.id);
  check('and nothing asks for it any more', !ingestNeeds(ctx, corpus).some((n) => n.ref === u.id));
}

section('review L5: an interpretation lost between an approve-ir commit and its write is repaired by the next act');
{
  const lost = ctx.store.assumptionByOwnerDecision(corpus.projectId, oirIdOf(cadence.id))!;
  const db = new DatabaseSync(path.join(w.out, DAYLIGHT_DB));
  db.prepare('DELETE FROM assumptions WHERE id=?').run(lost.id);
  db.close();
  check('the crash is simulated: no interpretation of the approved ambiguity', ctx.store.assumptionByOwnerDecision(corpus.projectId, oirIdOf(cadence.id)) === null);
  const extra = addRecord(w, { kind: 'requirement', docKey: 'ledger', quote: 'may be exported nightly', statement: 'Exports.' });
  act(set({ reject: [extra.id] }));
  check('the next approve-ir writes it again, once', ctx.store.assumptions(corpus.id).filter((a) => a.irId === cadence.id && a.status === 'open').length === 1);
  check('repairInterpretations is idempotent', repairInterpretations(ctx, corpus.id).length === 0);
}

section('supersede replaces an approved record only with one approved in the same act');
{
  const spare = addRecord(w, { kind: 'requirement', docKey: 'ledger', quote: 'A transfer must never', statement: 'Spare.' });
  const spare2 = addRecord(w, { kind: 'requirement', docKey: 'ledger', quote: 'exceed the balance', statement: 'Spare two.' });
  check('review L2: a proposed record is rejected, never superseded', /only an approved record is superseded/.test(throws(() => act(set({ approve: [spare2.id], supersede: { [spare.id]: spare2.id } })))?.message ?? ''));
}
const reworded = addRecord(w, { kind: 'requirement', docKey: 'ledger', quote: 'Transfers are recorded in the audit log.', statement: 'Each transfer is recorded in the audit log.' });
const sup = act(set({ approve: [reworded.id], supersede: { [close.id]: reworded.id } }));
check('the old record is superseded and the new one approved under one decision', ctx.store.irRecord(close.id)!.status === 'superseded'
  && ctx.store.irRecord(reworded.id)!.status === 'approved' && ctx.store.irRecord(close.id)!.decisionId === sup.id);
check('no set file is read from anywhere but the host path given', !fs.existsSync(path.join(w.root, 'approve-ir.json')));

section('ingest-approvals-callers: only the corpus review CLI calls approveIr and approveBlueprint (P2-R56)');
{
  const ROOT = path.resolve(import.meta.dirname, '..', '..');
  const CLI = path.join(ROOT, 'engine', 'cli.ts');
  const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'daylight.invariants.json'), 'utf8')) as Array<{ id: string }>;
  const inv = all.find((x) => x.id === 'ingest-approvals-callers');
  check('the invariant is declared', !!inv);
  const checkRepo = (name: string, files: Record<string, string>) => {
    const root = path.join(w.tmp, `inv-${name}`);
    for (const [rel, text] of Object.entries({ 'package.json': '{"name":"fx","type":"module"}\n', ...files })) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    fs.writeFileSync(path.join(root, 'daylight.invariants.json'), JSON.stringify([inv]));
    const out = path.join(root, 'out');
    const run = (args: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };
    run(['map', root, '--out', out, '--top', '0']);
    return run(['check', root, '--out', out]);
  };
  const DEFS = {
    'engine/forge/ir-review.ts': 'export function approveIr(x: string): string { return x; }\n',
    'engine/forge/blueprint.ts': 'export function approveBlueprint(x: string): string { return x; }\n',
    'engine/forge/commands-corpus-review.ts': "import { approveIr } from './ir-review.ts';\nimport { approveBlueprint } from './blueprint.ts';\nexport const run = () => approveIr('a') + approveBlueprint('b');\n",
    'engine/test/forge-ingest-x.ts': "import { approveIr } from '../forge/ir-review.ts';\nexport const t = () => approveIr('t');\n",
  };
  const green = checkRepo('ok', DEFS);
  check('the CLI file and the ingest tests may call them', green.code === 0, green.out);
  const red = checkRepo('fourth', { ...DEFS, 'engine/forge/director-x.ts': "import { approveBlueprint } from './blueprint.ts';\nexport const sneak = () => approveBlueprint.call(null, 'b');\n" });
  check('a fourth caller turns it red', red.code === 1 && /RED\s+ingest-approvals-callers/.test(red.out) && red.out.includes('engine/forge/director-x.ts'), red.out);
}

ctx.close();
done();
