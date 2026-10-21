/**
 * WS-R15: work packets and the version-2 plan (spec ingestion §8; P2-R50 F1, F3; P2-R53 D-b, D-d)
 * on a small synthetic corpus: one PlanFile with v1 digests unchanged, packet digest = ticket
 * digest, packet rules, emit under <out> only, a person's commit and `campaign import` checking
 * descent, `hand_edited`, re-pointed packets, OIR dedupe, obligations bound at lock and refused at
 * authorize, author context with holdouts withheld. Run: node engine/test/forge-ingest-packets.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import { DAYLIGHT_DB } from '../mission/db.ts';
import type { BlueprintV1, PlanFile, PlanTicket, WorkPacket } from '../mission/types.ts';
import type { GateContext } from '../forge/gate.ts';
import { assumptionNeeds, waitingOwner } from '../forge/assumptions.ts';
import { authorityChainOf } from '../forge/authority.ts';
import { approveBlueprint, importBlueprint } from '../forge/blueprint.ts';
import {
  approvePlan, authorizeCampaign, buildEnvelope, campaignAuthorizationRefusal, importPlan, PlanInvalid, type EnvelopeFlags,
} from '../forge/campaign.ts';
import { campaignLockConfirm, lockCampaign, registerCampaignGate, registerPlanGates, unboundObligations } from '../forge/campaign-gates.ts';
import { confirmIngest } from '../forge/commands-corpus-review.ts';
import { campaignConfirm, envelopeFlagsFrom } from '../forge/commands-campaign.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { currentIrSetDigest, oirIdOf } from '../forge/ir-review.ts';
import { buildAuthorPrompt, ImplementRefused } from '../forge/orchestrate.ts';
import { emitPlan, importPackets, packetContext, packetDigestOf, packetIdOf, packetToPlanTicket } from '../forge/packets.ts';
import { isPlanRefusals, parsePlan, prefixOf, ticketDigestOf } from '../forge/plan.ts';
import { harness } from './harness.ts';
import { addRecord, addRevision, approveRecords, git, HUMAN, makeWorld, throws } from './lib/ingest-world.ts';

const { check, section, done } = harness();

section('one PlanFile: version-1 tickets digest exactly as before; version-2 fields only on version 2');
{
  const t: PlanTicket = { id: 'A.B1', lane: 'A', title: 't', statement: ['one', 'two'], examples: ['e'], dependsOn: ['Z', 'A.A1'], blocksOn: ['O2', 'O1'],
    scope: ['src/a/'], budget: { maxUsd: 1 } };
  const defaults = { budget: { maxTurns: 3 }, acceptance: { kind: 'ci-only' as const } };
  const v1 = digestOf(canonicalJson({
    id: t.id, lane: t.lane, title: t.title, statement: 'one\ntwo', examples: ['e'], negativeExamples: [], dependsOn: ['A.A1', 'Z'], blocksOn: ['O1', 'O2'],
    scope: ['src/a'], acceptance: { kind: 'ci-only' }, budget: { maxTurns: 3, maxUsd: 1 },
  }));
  check('a version-1 ticket digests byte-identically to the version-1 formula', ticketDigestOf(t, defaults) === v1);
  check('empty trace lists are absent, not different', ticketDigestOf({ ...t, requirementIds: [], artifacts: [] }, defaults) === v1);
  check('a trace field moves the digest; packetId never does', ticketDigestOf({ ...t, requirementIds: ['ir_' + '1'.repeat(32)] }, defaults) !== v1
    && ticketDigestOf({ ...t, packetId: 'pk_' + '1'.repeat(32) }, defaults) === v1);
  const plan = { kind: 'daylight-plan', version: 1, title: 'p', campaignGates: [], lanes: [{ id: 'A', title: 'a', owns: ['src'] }], tickets: [{ ...t }] };
  const rule = (o: unknown) => {
    const v = parsePlan(JSON.stringify(o));
    return isPlanRefusals(v) ? v.map((x) => x.rule) : ['ok'];
  };
  check('a version-1 plan parses as before', rule(plan)[0] === 'ok');
  check('a version-1 plan carrying a version-2 key is refused', rule({ ...plan, tickets: [{ ...t, requirementIds: [] }] }).includes('version')
    && rule({ ...plan, derivation: {} }).includes('version'));
  check('version 2 shape-checks its trace fields', rule({ ...plan, version: 2, tickets: [{ ...t, requirementIds: ['ir_bad'] }] }).includes('trace-shape')
    && rule({ ...plan, version: 2, tickets: [{ ...t, acceptanceObligations: [{ id: 'o1', irIds: [], statement: 's' }] }] }).includes('trace-shape'));
}

// ---- the world ---------------------------------------------------------------------------------
const w = makeWorld('ingest-packets', {
  'svc/dispatch/src/queue.ts': 'export {};\n', 'svc/tracking/src/scan.ts': 'export {};\n',
  'tests/suite.test.mjs': "import test from 'node:test';\ntest('ok', () => {});\n",
});
const { ctx, corpus } = w;
const SPEC = [
  '# Courier', '',
  '## Dispatch', '', '- Every parcel must be assigned to exactly one courier.', '- A courier must never carry more than ten parcels.', '',
  '## Tracking', '', '- Each scan must be stored with its timestamp.', '- Tracking pages must load offline.', '- Tracking must pass offline.test.mjs before release.', '',
  '## Interfaces', '', '- The dispatch queue must expose a pull endpoint for tracking.', '',
  '## Open', '', '- Scans may be kept for thirty or ninety days.', '',
].join('\n');
const rev = addRevision(w, { svc: SPEC });
const r1 = addRecord(w, { kind: 'requirement', docKey: 'svc', quote: 'Every parcel must be assigned to exactly one courier.', statement: 'One courier per parcel.' });
const r2 = addRecord(w, { kind: 'acceptance-condition', docKey: 'svc', quote: 'A courier must never carry more than ten parcels.', statement: 'At most ten.' });
const r3 = addRecord(w, { kind: 'requirement', docKey: 'svc', quote: 'Each scan must be stored with its timestamp.', statement: 'Scans are timestamped.' });
const r4 = addRecord(w, { kind: 'invariant', docKey: 'svc', quote: 'Tracking pages must load offline.', statement: 'Offline.' });
const r7 = addRecord(w, { kind: 'requirement', docKey: 'svc', quote: 'Tracking must pass offline.test.mjs before release.', statement: 'Release gate.' });
const r6 = addRecord(w, { kind: 'interface', docKey: 'svc', quote: 'The dispatch queue must expose a pull endpoint for tracking.', statement: 'Pull.' });
const amb = addRecord(w, { kind: 'ambiguity', docKey: 'svc', quote: 'Scans may be kept for thirty or ninety days.', statement: 'Retention undecided.' });
approveRecords(w, [r1, r2, r3, r4, r7, r6, amb].map((r) => r.id));
const OIR = oirIdOf(amb.id);
check('approving the ambiguity opened its interpretation on the corpus', ctx.store.assumptionByOwnerDecision(w.projectId, OIR)?.status === 'open');

const blueprint: BlueprintV1 = {
  kind: 'daylight-blueprint', version: 1, title: 'Courier', corpusDigest: rev.corpusDigest, irSetDigest: currentIrSetDigest(ctx, corpus.id)!,
  scope: { milestones: ['W1'] }, ticketIdTemplate: '{milestone}.{component}{k}',
  boundaries: [{ id: 'svc', title: 'Service', domain: 'd', lifecycle: 'in-repo', owns: ['svc'], bounds: [r1.id], invariants: [r4.id] }],
  components: [
    { id: 'D', boundary: 'svc', title: 'Dispatch', owns: ['svc/dispatch'], sections: ['svc:dispatch'], requirements: [], dependsOn: [], provides: ['dispatch.pull'], consumes: [] },
    { id: 'T', boundary: 'svc', title: 'Tracking', owns: ['svc/tracking'], sections: ['svc:tracking'], requirements: [], dependsOn: ['D'], provides: [], consumes: ['dispatch.pull'] },
  ],
  interfaces: [{ id: 'dispatch.pull', owner: 'D', irIds: [r6.id], summary: 'Tracking pulls from dispatch.', crossesBoundary: false }],
  order: [['D'], ['T']], constraints: [], deferred: [{ irId: amb.id, to: 'W2' }], outOfScope: [],
};
const bpFile = path.join(w.tmp, 'bp.json');
fs.writeFileSync(bpFile, JSON.stringify(blueprint));
const { blueprint: bp, refusals: bpRefusals } = importBlueprint(ctx, corpus.id, bpFile);
check('the blueprint imports clean', bpRefusals.length === 0, JSON.stringify(bpRefusals));
approveBlueprint(ctx, { blueprintId: bp.id, actor: HUMAN, rationale: 'ok', env: {}, confirm: confirmIngest(ctx, 'approve-blueprint', bp.id).digest8 });

type Body = Omit<WorkPacket, 'id' | 'packetDigest' | 'status'>;
const D1: Body = {
  blueprintId: bp.id, componentId: 'D', ticketId: 'W1.D1', milestone: 'W1', title: 'Dispatch queue', objective: 'Assign parcels to couriers.', prerequisites: [],
  scope: ['svc/dispatch'], requirementIds: [r1.id, r2.id], interfaceContracts: [{ interfaceId: 'dispatch.pull', role: 'provides', irIds: [r6.id] }],
  artifacts: [{ path: 'svc/dispatch/src/queue.ts', kind: 'source', irIds: [r1.id] }], acceptanceObligations: [{ id: 'ob1', irIds: [r2.id], statement: 'Ten is the limit.' }],
  integrationDeps: [], blocksOn: [], examples: [], negativeExamples: [],
};
const T1: Body = {
  blueprintId: bp.id, componentId: 'T', ticketId: 'W1.T1', milestone: 'W1', title: 'Scans', objective: 'Record scans.', prerequisites: [], scope: ['svc/tracking'],
  requirementIds: [r3.id, r4.id, r7.id], interfaceContracts: [{ interfaceId: 'dispatch.pull', role: 'consumes', irIds: [r6.id] }], artifacts: [],
  acceptanceObligations: [{ id: 'ob1', irIds: [r4.id], statement: 'Works offline.' }], integrationDeps: ['W1.D1'], blocksOn: [OIR], examples: ['a scan has a time'], negativeExamples: [],
};
const packetsFile = (ps: unknown[]) => {
  const f = path.join(w.tmp, `packets-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ kind: 'daylight-packets', version: 1, packets: ps }));
  return f;
};
const importRules = (ps: unknown[]) => importPackets(ctx, bp.id, packetsFile(ps)).refusals.map((r) => r.rule);

section('packet digest is the digest of the ticket it becomes');
check('packetDigestOf = ticketDigestOf(packetToPlanTicket(p, { context: true }), undefined)', packetDigestOf(T1) === ticketDigestOf(packetToPlanTicket(T1, { context: true }), undefined));
check('the lane is the component; dependencies are prerequisites and integration deps', packetToPlanTicket(T1, { context: true }).lane === 'T'
  && packetToPlanTicket(T1, { context: true }).dependsOn?.join() === 'W1.D1');

section('packet rules, each by breaking a valid set');
check('a requirement of a component in no packet: uncovered-requirement', importRules([D1, { ...T1, requirementIds: [r3.id, r7.id] }]).includes('uncovered-requirement'));
check('an obligation citing an interface record: obligation-kind', importRules([{ ...D1, acceptanceObligations: [{ id: 'ob1', irIds: [r6.id], statement: 's' }] }, T1]).includes('obligation-kind'));
check('a scope outside the component: scope-outside-component', importRules([{ ...D1, scope: ['svc/tracking'] }, T1]).includes('scope-outside-component'));
check('a ticket id the template does not yield: ticket-id', importRules([{ ...D1, ticketId: 'W1.X1' }, T1]).includes('ticket-id'));
check('a prerequisite against the component order: prerequisite', importRules([{ ...D1, prerequisites: ['W1.T1'] }, T1]).includes('prerequisite'));
check('blocking on an owner decision no interpretation has: owner-decision', importRules([D1, { ...T1, blocksOn: ['OIR.0000000000'] }]).includes('owner-decision'));
check('a record another component derives from: not-assigned', importRules([{ ...D1, requirementIds: [r1.id, r2.id, r3.id] }, T1]).includes('not-assigned'));
check('nothing is recorded when a set is refused', ctx.store.packets(bp.id).length === 0);
const imported = importPackets(ctx, bp.id, packetsFile([D1, T1]));
check('a valid set is recorded proposed, ids from digests', imported.refusals.length === 0 && imported.packets.every((p) => p.status === 'proposed'
  && p.id === packetIdOf(bp.id, p.ticketId, p.packetDigest)), JSON.stringify(imported.refusals));
const pkD = imported.packets.find((p) => p.ticketId === 'W1.D1')!;
const pkT = imported.packets.find((p) => p.ticketId === 'W1.T1')!;

section('emit: a proposed version-2 plan under <out>, never in the repository (P2-R13)');
const before = git(w.root, 'status', '--porcelain');
const emitted = emitPlan(ctx, bp.id, { lanes: [], campaignGates: [{ id: 'suite', role: 'regression', path: 'tests/suite.test.mjs', harness: 'node', expect: { exitCode: 0, stdoutIncludes: ['# fail 0'] } }] });
check('the plan is written under <out>/corpus/<corpus>/', emitted.file.startsWith(path.join(w.out, 'corpus', corpus.id) + path.sep) && fs.existsSync(emitted.file));
check('the repository is untouched', git(w.root, 'status', '--porcelain') === before);
check('version 2, its derivation naming every digest', emitted.plan.version === 2 && emitted.plan.derivation?.blueprintDigest === bp.blueprintDigest
  && emitted.plan.derivation.irSetDigest === currentIrSetDigest(ctx, corpus.id) && emitted.plan.derivation.packetSetDigest === emitted.packetSetDigest);
check('every OIR the tickets block on is declared as a blocking owner decision', emitted.plan.ownerDecisions?.length === 1 && emitted.plan.ownerDecisions[0].id === OIR
  && emitted.plan.ownerDecisions[0].blocking);
check('each ticket names its packet and asks for context', emitted.plan.tickets.every((t) => t.packetId && t.context));
check('the packets are now emitted', ctx.store.packets(bp.id).every((p) => p.status === 'emitted'));

section('a person commits it; campaign import checks descent and writes the trace');
const PLAN = 'daylight.plan.json';
const commitPlan = (plan: PlanFile) => w.commitFiles({ [PLAN]: `${JSON.stringify(plan, null, 2)}\n` }, 'plan');
commitPlan(emitted.plan);
const imp = importPlan(ctx, w.root, PLAN);
const campaign = imp.campaign;
check('traced, nothing hand-edited, nothing untraced', imp.trace?.traced === 2 && imp.trace.handEdited.length === 0 && imp.trace.untraced === 0);
check('ticket_trace names each cited record by role, with its packet', ctx.store.ticketTrace(campaign.id, 'W1.T1').some((r) => r.irId === r4.id && r.role === 'obligation'
  && r.detail === 'ob1' && r.packetId === pkT.id) && ctx.store.ticketTrace(campaign.id, 'W1.D1').some((r) => r.irId === r6.id && r.role === 'interface'));
check('the OIR gets no second, plan-default assumption', !ctx.store.assumptions(campaign.id).some((a) => a.ownerDecisionId === OIR));
check('the ticket blocking on it waits for the corpus\'s interpretation', waitingOwner(ctx, campaign.id).get('W1.T1')?.[0] === OIR);
check('and the campaign needs that interpretation decided', assumptionNeeds(ctx, campaign).some((n) => n.kind === 'ir-interpretation'));
check('import is not approval: every ticket is proposed', ctx.store.campaignTickets(campaign.id).every((t) => ctx.store.workItem(t.workItemId)?.status === 'proposed'));

section('descent: an edited ticket is flagged hand_edited; a re-pointed packet is refused');
const edited: PlanFile = structuredClone(emitted.plan);
edited.tickets.find((t) => t.id === 'W1.T1')!.title = 'Scans, edited by a person';
commitPlan(edited);
const imp2 = importPlan(ctx, w.root, PLAN, { campaignId: campaign.id });
check('a person\'s edit to a ticket is imported and flagged, not refused', imp2.trace?.handEdited.join() === 'W1.T1'
  && ctx.store.ticketTrace(campaign.id, 'W1.T1').every((r) => r.handEdited) && ctx.store.ticketTrace(campaign.id, 'W1.D1').every((r) => !r.handEdited));
check('approve-plan\'s confirm lines say what a person approves of the descent (P2-R56)',
  confirmDigest(ctx, 'approve-plan', campaign.id).lines.includes('traced 2 ticket(s) to packets; 1 hand-edited (W1.T1); 0 untraced'));
const repoint: PlanFile = structuredClone(emitted.plan);
repoint.tickets.find((t) => t.id === 'W1.T1')!.packetId = pkD.id;
commitPlan(repoint);
const e1 = throws(() => importPlan(ctx, w.root, PLAN, { campaignId: campaign.id }));
check('a ticket pointed at another ticket\'s packet is refused (derivation)', e1 instanceof PlanInvalid && e1.refusals.some((r) => r.rule === 'derivation'));
const reset: PlanFile = structuredClone(emitted.plan);
reset.derivation!.packetSetDigest = digestOf('another set');
commitPlan(reset);
const e2 = throws(() => importPlan(ctx, w.root, PLAN, { campaignId: campaign.id }));
check('a derivation whose packet set does not hash from its tickets is refused', e2 instanceof PlanInvalid && e2.refusals.some((r) => r.path === '$.derivation.packetSetDigest'));
const e3plan: PlanFile = structuredClone(emitted.plan);
e3plan.tickets[0].requirementIds = [...(e3plan.tickets[0].requirementIds ?? []), 'ir_' + 'f'.repeat(32)];
commitPlan(e3plan);
check('citing a record that is not the corpus\'s is refused', (throws(() => importPlan(ctx, w.root, PLAN, { campaignId: campaign.id })) as PlanInvalid | null)?.refusals?.some((r) => r.rule === 'derivation') === true);
commitPlan(emitted.plan);
importPlan(ctx, w.root, PLAN, { campaignId: campaign.id });

check('re-imported as emitted, nothing is hand-edited', confirmDigest(ctx, 'approve-plan', campaign.id).lines.includes('traced 2 ticket(s) to packets; 0 hand-edited; 0 untraced'));
section('approve-plan, lock with obligations, and authorize (P2-R50 F3)');
approvePlan(ctx, { campaignId: campaign.id, actor: HUMAN, rationale: 'read', env: {}, confirm: confirmDigest(ctx, 'approve-plan', campaign.id).digest8 });
const g: GateContext = { store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: w.root, out: ctx.out, env: {} } as GateContext;
const [suite] = registerPlanGates(g, campaign.id, emitted.plan);
const holdout = registerCampaignGate(g, { campaignId: campaign.id, role: 'holdout', ticketId: null, testSource: 'export {};\n', basename: 'offline.test.mjs',
  prediction: { exitCode: 0, stdoutIncludes: ['# fail 0'] }, harness: 'node' });
for (const x of [suite, holdout]) {
  ctx.store.recordGateEvaluation({ missionId: campaign.id, projectId: campaign.projectId, revision: campaign.baseRevision, experimentId: x.id, target: 'base', diffDigest: null,
    harnessDigest: x.harnessDigest, executions: [], conclusion: x.role === 'regression' ? 'supported' : 'falsified' });
}
const ids = [suite.id, holdout.id];
const lockWith = (obligations: Record<string, string[]>) => lockCampaign(g, { campaignId: campaign.id, actor: HUMAN, rationale: 'gates read', ratchet: false, experimentIds: ids,
  obligations, env: {}, confirm: campaignLockConfirm(g, campaign.id, ids, false, obligations).digest8 });
check('binding an obligation no ticket has is refused', /not an acceptance obligation/.test(throws(() => lockWith({ [suite.id]: ['W1.Z9:ob1'] }))?.message ?? ''));
check('the obligations enter the gate-set digest', campaignLockConfirm(g, campaign.id, ids, false, { [suite.id]: ['W1.D1:ob1'] }).digest
  !== campaignLockConfirm(g, campaign.id, ids, false).digest);
{
  const ob = { [suite.id]: ['W1.D1:ob1'], [holdout.id]: ['W1.T1:ob1'] };
  const viaGates = campaignLockConfirm(g, campaign.id, ids, false, ob);
  const viaConfirm = confirmDigest(ctx, 'lock-campaign-gates', campaign.id, { experimentIds: ids, ratchet: false, obligations: ob });
  check('confirm lock-campaign-gates and campaign lock agree with obligations (one path, P2-R56)', viaGates.digest === viaConfirm.digest
    && viaGates.lines.join('\n') === viaConfirm.lines.join('\n'));
  check('a visible gate\'s obligations are named; a holdout\'s are counted', viaConfirm.lines.includes(`${suite.id} discharges W1.D1:ob1`)
    && viaConfirm.lines.includes('1 obligation(s) bound to holdouts, counted, not named') && !viaConfirm.lines.join().includes(holdout.id));
  check('accepting a vacuous gate beside obligations changes the code', confirmDigest(ctx, 'lock-campaign-gates', campaign.id, { experimentIds: ids, ratchet: false, obligations: ob, acceptVacuous: [suite.id] }).digest
    !== viaConfirm.digest && campaignLockConfirm(g, campaign.id, ids, false, ob, [suite.id]).digest !== viaConfirm.digest);
}
const lock = lockWith({ [suite.id]: ['W1.D1:ob1'] });
check('the lock records which gate discharges which obligation', (lock.scope.obligations as Record<string, string[]>)[suite.id]?.join() === 'W1.D1:ob1');
check('W1.T1:ob1 is bound to no locked gate', unboundObligations(ctx, campaign.id, ['W1.D1', 'W1.T1']).join() === 'W1.T1:ob1');
const flags: EnvelopeFlags = { expectedGateSetDigest: lock.scope.gateSetDigest as string, roster: ['mock'], maxUsdTotal: 10, maxUsdPerMission: 2, maxTurns: 10,
  timeoutSeconds: 600, maxAttemptsPerTicket: 2, concurrency: 1, execute: false, autoApply: 'integration-ref', tickets: ['W1.D1', 'W1.T1'], notAfter: '24h' };
const auth = (f: EnvelopeFlags) => authorizeCampaign(ctx, { campaignId: campaign.id, actor: HUMAN, rationale: 'go', env: {}, flags: f,
  confirm: confirmDigest(ctx, 'authorize-campaign', campaign.id, { envelope: buildEnvelope(ctx, campaign.id, f) }).digest8 });
check('an obligation bound to no locked gate fails closed at authorize', /W1\.T1:ob1 are bound to no locked gate/.test(throws(() => auth(flags))?.message ?? ''));
check('naming a bound obligation as unbound is refused', /W1\.D1:ob1/.test(throws(() => auth({ ...flags, unboundObligations: ['W1.T1:ob1', 'W1.D1:ob1'] }))?.message ?? ''));
const a = auth({ ...flags, unboundObligations: ['W1.T1:ob1'] });
check('listed by name, it is authorized and the envelope records it', (a.scope.unboundObligations as string[]).join() === 'W1.T1:ob1');
{
  // `daylight confirm authorize-campaign` reads the same flags as `campaign authorize` (the GUI confirms through it).
  const argv: Record<string, string> = { 'auto-apply': 'integration-ref', roster: 'mock', 'expected-gate-set': flags.expectedGateSetDigest, 'max-usd-total': '10',
    'max-usd-per-mission': '2', 'max-turns': '10', timeout: '600', 'max-attempts': '2', concurrency: '1', tickets: 'W1.D1,W1.T1', 'not-after': '24h',
    'unbound-obligations': 'W1.T1:ob1' };
  const parsed = envelopeFlagsFrom((k) => argv[k]);
  check('campaign authorize --unbound-obligations is parsed for confirm too (P2-R56)', parsed.unboundObligations?.join() === 'W1.T1:ob1'
    && campaignConfirm(ctx, 'authorize-campaign', campaign.id, (k) => argv[k]).lines.join() === confirmDigest(ctx, 'authorize-campaign', campaign.id,
      { envelope: buildEnvelope(ctx, campaign.id, parsed) }).lines.join());
}
check('the chain holds: every link re-derived', authorityChainOf(ctx, campaign.id).breaks.length === 0 && campaignAuthorizationRefusal(ctx, campaign.id) === null,
  JSON.stringify(authorityChainOf(ctx, campaign.id).breaks));

section('author context: exact quotes, holdout basenames withheld and counted, never the spec');
const c = packetContext(ctx, { campaignId: campaign.id, ticketId: 'W1.T1' });
check('the cited passages, verbatim', c.spans.map((s) => s.quote).includes('Each scan must be stored with its timestamp.') && c.spans.every((s) => SPEC.includes(s.quote)));
check('a quote naming a holdout\'s basename is withheld, counted, never masked', c.withheld === 1 && !JSON.stringify(c.spans).includes('offline.test.mjs')
  && !c.spans.some((s) => s.irId === r7.id));
check('the context is bounded, the rest counted', packetContext(ctx, { campaignId: campaign.id, ticketId: 'W1.T1' }, { maxBytes: 40 }).truncated > 0);
const prompt = buildAuthorPrompt({ title: 't', statement: 's', examples: [], negativeExamples: [] }, { missionId: campaign.id, gateSetDigest: 'g', gates: [] }, null, undefined, c);
check('the author prompt fences it as SPEC-CONTEXT and says only how many were withheld', /<<<SPEC-CONTEXT-/.test(prompt) && /1 passage\(s\) withheld/.test(prompt)
  && !prompt.includes('offline.test.mjs') && !prompt.includes('Scans may be kept'));

{
  const named = { title: 'Scans and offline.test.mjs', statement: 'Record scans.\nMake offline.test.mjs pass.', examples: ['offline.test.mjs passes', 'a scan has a time'], negativeExamples: [] };
  const p2 = buildAuthorPrompt(named, { missionId: campaign.id, gateSetDigest: 'g', gates: [] }, null, undefined, c);
  check('P2-R59: a holdout basename in the ticket\'s title, statement or examples never reaches the WORK fence', !p2.includes('offline.test.mjs')
    && p2.includes('Record scans.') && p2.includes('a scan has a time') && /3 line\(s\) of the work withheld/.test(p2), p2.slice(0, 600));
}

section('tampering: a re-pointed packet with the plan digest unchanged breaks the chain; a moved quote refuses the run');
const db = new DatabaseSync(path.join(w.out, DAYLIGHT_DB));
const planDigest = ctx.store.currentPlan(campaign.id)!.planDigest;
db.prepare('UPDATE ticket_trace SET packet_id=? WHERE campaign_id=? AND ticket_id=?').run(pkD.id, campaign.id, 'W1.T1');
check('the plan digest did not move', ctx.store.currentPlan(campaign.id)!.planDigest === planDigest);
check('the chain breaks at packets', authorityChainOf(ctx, campaign.id).breaks.some((b) => b.link === 'packets'));
check('and the director may not act: campaignAuthorizationRefusal names the chain', /authority chain is broken at packets/.test(campaignAuthorizationRefusal(ctx, campaign.id) ?? ''));
db.prepare('UPDATE ticket_trace SET packet_id=? WHERE campaign_id=? AND ticket_id=?').run(pkT.id, campaign.id, 'W1.T1');
check('restored, it holds again', campaignAuthorizationRefusal(ctx, campaign.id) === null);
db.prepare('UPDATE ir_spans SET quote_digest=? WHERE ir_id=?').run(digestOf('not the quote'), r3.id);
check('a quote that no longer hashes to its digest refuses the author run', throws(() => packetContext(ctx, { campaignId: campaign.id, ticketId: 'W1.T1' })) instanceof ImplementRefused);
db.close();
check('prefixes are normalised in tickets', emitted.plan.tickets.every((t) => t.scope.every((s) => s === prefixOf(s))));

ctx.close();
done();
