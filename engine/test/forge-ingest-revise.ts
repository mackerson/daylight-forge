/**
 * One end-to-end `corpus revise` on the merged wave-4 tree (r15-review M3): register → extract
 * (two mock extractors) → approve-ir → blueprint → packets → emit → import → lock → authorize;
 * then a person edits one document and Daylight revises the corpus. The chain's ir link breaks,
 * authorize is refused naming the stale record, `--accept-ir-drift <current>` is accepted, and the
 * ticket reads `stale` (never dispatched) until a re-emitted plan is imported. Daylight never
 * moves the repository's HEAD, index or worktree (P2-R13): only the person's commits do.
 * Run: node engine/test/forge-ingest-revise.ts
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import { openDaylight } from '../mission/context.ts';
import type { BlueprintV1, PlanFile, WorkPacket } from '../mission/types.ts';
import type { GateContext } from '../forge/gate.ts';
import { authorityChainOf, corpusPathsOf, irSetDigestAt, reviseCorpus, staleTickets } from '../forge/authority.ts';
import { approveBlueprint, importBlueprint } from '../forge/blueprint.ts';
import { approvePlan, authorizeCampaign, buildEnvelope, campaignAuthorizationRefusal, importPlan, type EnvelopeFlags } from '../forge/campaign.ts';
import { campaignLockConfirm, lockCampaign, registerPlanGates } from '../forge/campaign-gates.ts';
import { r5StatusHost } from '../forge/campaign-status.ts';
import { confirmIngest } from '../forge/commands-corpus-review.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { registerCorpus } from '../forge/corpus.ts';
import { ticketStates } from '../forge/director.ts';
import { extract } from '../forge/extract.ts';
import { approveIr, planApproveIr } from '../forge/ir-review.ts';
import { emitPlan, importPackets } from '../forge/packets.ts';
import { confirmCodeOf } from '../forge/policy.ts';
import { harness } from './harness.ts';
import { git, initRepo, inProcessExtractor, writeAndCommit } from './lib/ingest-fixture.ts';

const { check, section, done } = harness();
const HUMAN = 'human:miz';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-ingest-e2e-')));
const privateTmp = path.join(tmp, 'tmp');
fs.mkdirSync(privateTmp, { mode: 0o700 });
process.env.TMPDIR = privateTmp;
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const LINE_A = 'Every parcel must be assigned to exactly one courier.';
const LINE_B = 'A courier must never carry more than ten parcels.';
const LINE_B2 = 'A courier must never carry more than twelve parcels.';
const spec = (b: string) => `# Courier service\n\n## Dispatch\n\n${LINE_A}\n\n${b}\n`;
const repo = path.join(tmp, 'svc');
initRepo(repo, {
  'daylight.corpus.json': JSON.stringify({ kind: 'daylight-corpus', version: 1, title: 'Courier', docs: [{ key: 'svc', path: 'docs/spec.md', role: 'primary', domain: 'svc' }], precedence: [], dependencies: [] }),
  'docs/spec.md': spec(LINE_B),
  'svc/dispatch/q.ts': 'export {};\n',
  'tests/suite.test.mjs': "import test from 'node:test';\ntest('ok', () => {});\n",
});
const out = path.join(tmp, 'out');
fs.mkdirSync(out);
fs.writeFileSync(path.join(out, 'view.json'), JSON.stringify({ root: repo }));
const ctx = openDaylight(out);

/** HEAD, the index file's bytes and every tracked and untracked path's bytes: what P2-R13 says Daylight never moves. */
function repoState(): string {
  const h = createHash('sha256');
  h.update(git(repo, 'rev-parse', 'HEAD'));
  h.update(fs.readFileSync(path.join(repo, '.git', 'index')));
  h.update(git(repo, 'status', '--porcelain', '--untracked-files=all'));
  for (const f of fs.readdirSync(repo, { recursive: true }).map(String).filter((f) => !f.startsWith('.git')).sort()) {
    const p = path.join(repo, f);
    h.update(f);
    if (fs.statSync(p).isFile()) h.update(fs.readFileSync(p));
  }
  return h.digest('hex');
}
let held = repoState();
/** Run a Daylight act and check the repository is byte-equal after it. */
async function untouched<T>(what: string, fn: () => T | Promise<T>): Promise<T> {
  const r = await fn();
  check(`${what}: HEAD, index and worktree unchanged (P2-R13)`, repoState() === held);
  return r;
}
/** A person's own commit: the one thing that moves the repository. */
const personCommits = (files: Record<string, string>, message: string) => {
  const sha = writeAndCommit(repo, files, message);
  held = repoState();
  return sha;
};

section('register, extract with two mock extractors, approve-ir');
const rev1 = await untouched('register', () => registerCorpus(ctx, repo, 'daylight.corpus.json'));
const corpusId = rev1.corpusId;
const corpus = ctx.store.mission(corpusId)!;
const sectionId = (JSON.parse(ctx.artifacts.get(rev1.sectionIndex).toString('utf8')) as { docs: Array<{ sections: Array<{ id: string; label: string | null; title: string }> }> })
  .docs[0].sections.find((s) => /dispatch/i.test(s.title))!.id;
const proposals = (b: string) => [
  { kind: 'requirement', source: 'extracted', statement: 'One courier per parcel.', confidence: 0.9, section: sectionId, quote: LINE_A },
  { kind: 'acceptance-condition', source: 'extracted', statement: `At most ${b.includes('twelve') ? 'twelve' : 'ten'} parcels.`, confidence: 0.9, section: sectionId, quote: b },
];
let lineB = LINE_B;
const runner = inProcessExtractor((w) => (w.sectionIds.includes(sectionId) ? proposals(lineB) : []));
const ex = await untouched('extract', () => extract(ctx, corpusId, repo, ['mock', 'mock:b'], { runner }));
check('two blind readings give two proposed records', ex.proposed.length === 2 && ex.proposed.every((r) => ctx.store.irRecord(r.id)!.status === 'proposed' && ctx.store.irRecord(r.id)!.observedBy.length === 2),
  JSON.stringify({ n: ex.proposed.length, by: ex.proposed.map((r) => ctx.store.irRecord(r.id)!.observedBy), refused: ex.refused }));
const byQuote = (q: string) => ctx.store.irRecords(corpusId).find((r) => r.span?.quote === q || (r.status !== 'superseded' && r.statement.includes(q)))!;
const rA = byQuote(LINE_A);
const rB = byQuote(LINE_B);
const approveSet = async (approve: string[], more: { supersede?: Record<string, string> } = {}) => {
  const rev = ctx.store.currentCorpusRevision(corpusId)!;
  const set = { kind: 'daylight-approve-ir' as const, version: 1 as const, corpusId, revisionId: rev.id, approve, reject: [], accept: [], dismiss: [], ...more };
  const code = confirmCodeOf(digestOf(canonicalJson(planApproveIr(ctx, corpusId, set).scope)));
  return untouched('approve-ir', () => approveIr(ctx, { corpusId, actor: HUMAN, rationale: 'read', confirm: code, env: {}, set }));
};
await approveSet([rA.id, rB.id]);
check('both records approved by one person\'s decision', ctx.store.irRecord(rA.id)!.status === 'approved' && ctx.store.irRecord(rB.id)!.status === 'approved');

section('blueprint, packets, emit; a person commits the plan; import, approve, lock, authorize');
let k = 0;
async function blueprintAndPlan(cite: string): Promise<{ plan: PlanFile; blueprintId: string }> {
  const rev = ctx.store.currentCorpusRevision(corpusId)!;
  const bp: BlueprintV1 = {
    kind: 'daylight-blueprint', version: 1, title: `Courier ${++k}`, corpusDigest: rev.corpusDigest, irSetDigest: irSetDigestAt(ctx, corpusId)!, scope: { milestones: ['W1'] },
    ticketIdTemplate: '{milestone}.{component}{k}',
    boundaries: [{ id: 'svc', title: 'Svc', domain: 'svc', lifecycle: 'in-repo', owns: ['svc'], bounds: [rA.id], invariants: [] }],
    components: [{ id: 'D', boundary: 'svc', title: 'Dispatch', owns: ['svc/dispatch'], sections: [sectionId], requirements: [], dependsOn: [], provides: [], consumes: [] }],
    interfaces: [], order: [['D']], constraints: [], deferred: [], outOfScope: [],
  };
  const f = path.join(tmp, `bp-${k}.json`);
  fs.writeFileSync(f, JSON.stringify(bp));
  const b = await untouched('blueprint import', () => importBlueprint(ctx, corpusId, f).blueprint);
  await untouched('approve-blueprint', () => approveBlueprint(ctx, { blueprintId: b.id, actor: HUMAN, rationale: 'ok', env: {}, confirm: confirmIngest(ctx, 'approve-blueprint', b.id).digest8 }));
  const body: Omit<WorkPacket, 'id' | 'packetDigest' | 'status'> = {
    blueprintId: b.id, componentId: 'D', ticketId: 'W1.D1', milestone: 'W1', title: 'Queue', objective: 'Assign parcels.', prerequisites: [], scope: ['svc/dispatch'],
    requirementIds: [rA.id, cite], interfaceContracts: [], artifacts: [], acceptanceObligations: [{ id: 'ob1', irIds: [cite], statement: 'The limit holds.' }],
    integrationDeps: [], blocksOn: [], examples: [], negativeExamples: [],
  };
  const pf = path.join(tmp, `p-${k}.json`);
  fs.writeFileSync(pf, JSON.stringify({ kind: 'daylight-packets', version: 1, packets: [body] }));
  await untouched('packets import', () => importPackets(ctx, b.id, pf));
  const emitted = await untouched('emit', () => emitPlan(ctx, b.id, { lanes: [], campaignGates: [{ id: 'suite', role: 'regression', path: 'tests/suite.test.mjs', harness: 'node',
    expect: { exitCode: 0, stdoutIncludes: ['# fail 0'] } }] }));
  return { plan: emitted.plan as PlanFile, blueprintId: b.id };
}
const first = await blueprintAndPlan(rB.id);
personCommits({ 'daylight.plan.json': JSON.stringify(first.plan) }, 'plan');
const campaign = (await untouched('import', () => importPlan(ctx, repo, 'daylight.plan.json'))).campaign;
await untouched('approve-plan', () => approvePlan(ctx, { campaignId: campaign.id, actor: HUMAN, rationale: 'read', env: {}, confirm: confirmDigest(ctx, 'approve-plan', campaign.id).digest8 }));
const g = { store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: repo, out: ctx.out, env: {} } as GateContext;
const [suite] = registerPlanGates(g, campaign.id, first.plan);
ctx.store.recordGateEvaluation({ missionId: campaign.id, projectId: campaign.projectId, revision: campaign.baseRevision, experimentId: suite.id, target: 'base',
  diffDigest: null, harnessDigest: suite.harnessDigest, executions: [], conclusion: 'supported' });
const obligations = { [suite.id]: ['W1.D1:ob1'] };
await untouched('lock', () => lockCampaign(g, { campaignId: campaign.id, actor: HUMAN, rationale: 'gates', ratchet: false, experimentIds: [suite.id], obligations, env: {},
  confirm: campaignLockConfirm(g, campaign.id, [suite.id], false, obligations).digest8 }));
const flags: EnvelopeFlags = { expectedGateSetDigest: ctx.store.campaignLockDecision(campaign.id)!.scope.gateSetDigest as string, roster: ['mock'], maxUsdTotal: 10,
  maxUsdPerMission: 2, maxTurns: 10, timeoutSeconds: 600, maxAttemptsPerTicket: 2, concurrency: 1, execute: false, autoApply: 'integration-ref', tickets: ['W1.D1'], notAfter: '24h' };
const authorize = (f: EnvelopeFlags) => untouched('authorize', () => authorizeCampaign(ctx, { campaignId: campaign.id, actor: HUMAN, rationale: 'go', env: {}, flags: f,
  confirm: confirmDigest(ctx, 'authorize-campaign', campaign.id, { envelope: buildEnvelope(ctx, campaign.id, f) }).digest8 }));
await authorize(flags);
const statusOf = () => ticketStates(ctx, campaign.id, repo, r5StatusHost(ctx)).get('W1.D1')!;
check('authorized over the current IR: the chain is whole, the director may act', authorityChainOf(ctx, campaign.id).breaks.length === 0 && campaignAuthorizationRefusal(ctx, campaign.id) === null,
  JSON.stringify(authorityChainOf(ctx, campaign.id).breaks));
check('the ticket is ready to dispatch', statusOf().status === 'ready', JSON.stringify(statusOf()));
check('the author is handed the corpus document as a protected path, from the current revision', corpusPathsOf(ctx, corpusId, campaign.projectId).join() === 'docs/spec.md');

section('a person edits one document; Daylight revises the corpus');
personCommits({ 'docs/spec.md': spec(LINE_B2) }, 'raise the limit');
const revised = await untouched('revise', () => reviseCorpus(ctx, repo, corpusId, {}));
check('a new revision of the same corpus mission', revised.revision.corpusId === corpusId && revised.revision.seq === rev1.seq + 1);
check('exactly the edited record is stale', revised.diff.records.filter((r) => r.status === 'stale').map((r) => r.irId).join() === rB.id);
check('the corpus mission\'s scope follows the revision (P2-R63)', JSON.stringify(ctx.store.mission(corpusId)!.scope.paths) === JSON.stringify(['docs/spec.md'])
  && ctx.store.mission(corpusId)!.baseRevision === git(repo, 'rev-parse', 'HEAD'));
const irBreak = authorityChainOf(ctx, campaign.id).breaks.find((b) => b.link === 'ir');
check('the chain\'s ir link breaks, naming the stale record', !!irBreak && irBreak.why.includes(rB.id), JSON.stringify(authorityChainOf(ctx, campaign.id).breaks));
check('the director pass is refused, naming it', (campaignAuthorizationRefusal(ctx, campaign.id) ?? '').includes(rB.id));
const refused = await (async () => {
  try {
    await authorize(flags);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
})();
check('authorize again is refused, naming the stale record and --accept-ir-drift', refused.includes(rB.id) && refused.includes('accept-ir-drift'), refused);
check('the ticket is stale, not ready: it is never dispatched', statusOf().status === 'stale' && (statusOf().reason ?? '').includes(rB.id), JSON.stringify(statusOf()));
const current = irSetDigestAt(ctx, corpusId) ?? digestOf('');
const accepted = await authorize({ ...flags, acceptIrDrift: current });
check('--accept-ir-drift <current> is accepted and recorded', accepted.scope.acceptIrDrift === current && campaignAuthorizationRefusal(ctx, campaign.id) === null);
check('accepting the drift does not dispatch the stale ticket', statusOf().status === 'stale' && staleTickets(ctx, campaign.id).get('W1.D1')?.join() === rB.id);

section('recovery: supersede, a new blueprint, re-emit; the person commits; import clears the stale ticket');
lineB = LINE_B2;
await untouched('extract again', () => extract(ctx, corpusId, repo, ['mock', 'mock:b'], { runner, force: true }));
const rB2 = ctx.store.irRecords(corpusId, { status: 'proposed' }).find((r) => r.span?.quote === LINE_B2)!;
await approveSet([rB2.id], { supersede: { [rB.id]: rB2.id } });
check('the stale record is superseded by the new reading', ctx.store.irRecord(rB.id)!.status === 'superseded' && ctx.store.irRecord(rB2.id)!.status === 'approved');
check('until the plan is re-emitted the ticket stays stale', statusOf().status === 'stale');
const second = await blueprintAndPlan(rB2.id);
personCommits({ 'daylight.plan.json': JSON.stringify(second.plan) }, 'plan again');
await untouched('re-import', () => importPlan(ctx, repo, 'daylight.plan.json', { campaignId: campaign.id }));
check('after the re-emitted plan is imported the ticket is no longer stale', !staleTickets(ctx, campaign.id).size && statusOf().status !== 'stale', JSON.stringify(statusOf()));

ctx.close();
done();
