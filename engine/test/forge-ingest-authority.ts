/**
 * WS-R15: authority and invalidation (spec ingestion §9; P2-R53) on small synthetic corpora: the
 * revision row-state table case by case (carried, review, moved, split, renamed, stale by a missing,
 * an ambiguous or a removed quote, an overriding section changed, a config change), derived
 * staleness and what it invalidates, no existing row changed, and the recovery a person makes.
 * Run: node engine/test/forge-ingest-authority.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digestOf } from '../mission/artifacts.ts';
import { DAYLIGHT_DB } from '../mission/db.ts';
import type { BlueprintV1, PlanFile, WorkPacket } from '../mission/types.ts';
import type { GateContext } from '../forge/gate.ts';
import {
  authorityChainOf, carryForward, diffCorpus, ingestNeeds, irSetDigestAt, isIrStale, staleBlueprints, stalePackets, staleTickets,
} from '../forge/authority.ts';
import { approveBlueprint, importBlueprint } from '../forge/blueprint.ts';
import { approvePlan, authorizeCampaign, buildEnvelope, campaignAuthorizationRefusal, importPlan, type EnvelopeFlags } from '../forge/campaign.ts';
import { campaignLockConfirm, lockCampaign, registerPlanGates } from '../forge/campaign-gates.ts';
import { confirmIngest, corpusReviewReadOnly } from '../forge/commands-corpus-review.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { currentIrSetDigest } from '../forge/ir-review.ts';
import { emitPlan, importPackets } from '../forge/packets.ts';
import { harness } from './harness.ts';
import { addRecord, addRevision, approveRecords, HUMAN, makeWorld } from './lib/ingest-world.ts';

const { check, section, done } = harness();

/** Every row of the tables a revision must not rewrite, as JSON lines (ir_spans compared as a superset). */
function snapshot(out: string): Map<string, Set<string>> {
  const db = new DatabaseSync(path.join(out, DAYLIGHT_DB));
  try {
    return new Map(['ir_records', 'ir_spans', 'ir_links', 'ir_findings', 'blueprints', 'blueprint_derivations', 'packets', 'ticket_trace', 'work_items',
      'campaign_tickets', 'experiments', 'assumptions', 'decisions', 'corpus_revisions']
      .map((t) => [t, new Set((db.prepare(`SELECT * FROM ${t}`).all() as unknown[]).map((r) => JSON.stringify(r)))]));
  } finally {
    db.close();
  }
}
const unchanged = (a: Map<string, Set<string>>, b: Map<string, Set<string>>) =>
  [...a].every(([t, rows]) => [...rows].every((r) => b.get(t)!.has(r)) && (t === 'ir_spans' || rows.size === b.get(t)!.size));

section('the row-state table, case by case');
{
  const w = makeWorld('ingest-authority-rows');
  const { ctx, corpus } = w;
  const doc = (s: Record<string, string[]>) => ['# Std', '', ...Object.entries(s).flatMap(([h, lines]) => [h, ...lines, ''])].join('\n');
  const BASE = {
    '## Alpha': ['- Alpha one must hold.', '- Alpha two must hold.'], '## Beta': ['- Beta one must hold.'], '## Gamma': ['- Gamma one must hold.', '- Gamma two must hold.'],
    '## Delta': ['- Delta one must hold.'], '## Epsilon': ['- Epsilon one must hold.'], '## Zeta': ['- Zeta one must hold.'], '## Eta': ['- Eta one must hold.'],
    '## Errata': ['- Errata one overrides eta.'], '## Omega': ['- Omega one must hold.'],
  };
  const rev1 = addRevision(w, { std: doc(BASE) });
  const rec = (quote: string, more: Partial<Parameters<typeof addRecord>[1]> = {}) =>
    addRecord(w, { kind: 'requirement', docKey: 'std', quote, statement: `S: ${quote}`, ...more });
  const carried = rec('Alpha one must hold.');
  const rejected = rec('Alpha two must hold.');
  const review = rec('Beta one must hold.');
  const moved = rec('Gamma one must hold.');
  const ambiguous = rec('Gamma two must hold.');
  const split = rec('Delta one must hold.');
  const renamed = rec('Epsilon one must hold.');
  const missing = rec('Zeta one must hold.');
  const overridden = rec('Eta one must hold.');
  const errata = rec('Errata one overrides eta.', { kind: 'decision' });
  const removed = rec('Omega one must hold.');
  const contra = rec('Alpha one must', { kind: 'contradiction', other: { docKey: 'std', quote: 'Zeta one must hold' }, statement: 'Alpha against Zeta' });
  const inferredKept = rec('', { source: 'inferred', basisSections: ['std:zeta'], statement: 'Zeta implies a ledger.' });
  const inferredGone = rec('', { source: 'inferred', basisSections: ['std:omega', 'std:delta'], statement: 'Omega implies an audit.' });
  ctx.store.insertIrLink({ fromIr: errata.id, toIr: overridden.id, kind: 'overrides', basis: 'precedence', createdAt: 1 });
  approveRecords(w, [carried, review, moved, ambiguous, split, renamed, missing, overridden, errata, removed, contra].map((r) => r.id), { reject: [rejected.id] });

  const REV2 = {
    '## Alpha': BASE['## Alpha'], '## Beta': ['- Beta one must hold.', '- Beta two must hold.'], '## Gamma': BASE['## Gamma'],
    '## Delta': [], '### Delta part': ['- Delta one must hold.'], '## Epsilon renamed': BASE['## Epsilon'], '## Zeta': ['- Zeta one must now hold.'],
    '## Eta': BASE['## Eta'], '## Errata': ['- Errata one overrides eta, firmly.'], '## Theta': ['- Gamma two must hold.'],
  };
  const rev2 = addRevision(w, { std: doc(REV2) });
  const before = snapshot(w.out);
  const result = new Map(carryForward(ctx, corpus.id, rev1.id, rev2.id).map((r) => [r.irId, r]));
  const after = snapshot(w.out);
  const row = (id: string) => ctx.store.irSpans(id).find((s) => s.revisionId === rev2.id && s.role === 'primary');
  const is = (r: { id: string }, status: string, reason: string | null) => result.get(r.id)?.status === status && result.get(r.id)?.reason === reason;
  const text2 = doc(REV2);
  check('same bytes, same section, same units: carried, a row at the same bytes', is(carried, 'carried', null) && row(carried.id)?.carry === 'carried'
    && row(carried.id)?.start === ctx.store.irRecord(carried.id, rev1.id)!.span!.start);
  check('same bytes, its section gained a scored unit: review (row added)', is(review, 'review', 'section-changed') && row(review.id)?.carry === 'review');
  check('shifted, found exactly once in the same section: moved', is(moved, 'moved', null) && text2.slice(row(moved.id)!.start, row(moved.id)!.end) === 'Gamma one must hold.');
  check('split: the quote now in a new sub-section is moved there and keeps its record', is(split, 'moved', 'section-changed') && row(split.id)?.sectionId === 'std:delta-part');
  check('renamed section: moved, section-changed', is(renamed, 'moved', 'section-changed') && row(renamed.id)?.sectionId === 'std:epsilon-renamed');
  check('the quote edited: stale (quote-missing), no row', is(missing, 'stale', 'quote-missing') && !row(missing.id));
  check('the quote now twice in the document: stale (quote-ambiguous), no row', is(ambiguous, 'stale', 'quote-ambiguous') && !row(ambiguous.id));
  check('section and quote gone: stale (section-removed), no row', is(removed, 'stale', 'section-removed') && !row(removed.id));
  check('the overriding section changed: review (overriding-doc-changed)', is(overridden, 'review', 'overriding-doc-changed') && row(overridden.id)?.carry === 'review');
  check('a record losing its second passage is stale though its first carried', result.get(contra.id)?.status === 'stale' && !!row(contra.id) && isIrStale(ctx, contra.id));
  check('a rejected record is not carried', !result.has(rejected.id) && !ctx.store.irSpans(rejected.id).some((s) => s.revisionId === rev2.id));
  check('no existing row of any table changed; only span rows were added', unchanged(before, after)
    && after.get('ir_spans')!.size > before.get('ir_spans')!.size);
  check('the moved record keeps its approval and its content digest', ctx.store.irRecord(split.id)!.status === 'approved'
    && ctx.store.irRecord(split.id)!.contentDigest === split.contentDigest);
  check('an inferred record follows its basis sections: current while one remains', !isIrStale(ctx, inferredKept.id)
    && !isIrStale(ctx, inferredGone.id) && ctx.store.irSpans(inferredKept.id).length === 0);
  check('staleness is per revision: current at the old one, stale at the new one', !isIrStale(ctx, missing.id, rev1.id) && isIrStale(ctx, missing.id));
  check('carrying again adds nothing (one row per role per revision)', (carryForward(ctx, corpus.id, rev1.id, rev2.id), snapshot(w.out).get('ir_spans')!.size === after.get('ir_spans')!.size));

  const d = diffCorpus(ctx, corpus.id, rev1.id, rev2.id);
  check('the diff reads the rows: statuses as carried', d.records.find((r) => r.irId === split.id)?.status === 'moved' && d.records.find((r) => r.irId === missing.id)?.reason === 'quote-missing');
  check('sections: a rename is a rename, a new section is added, a changed body is changed', d.sections.renamed.some((x) => x.from === 'std:epsilon' && x.to === 'std:epsilon-renamed')
    && d.sections.added.includes('std:delta-part') && d.sections.added.includes('std:theta') && d.sections.changed.includes('std:beta') && d.sections.removed.includes('std:omega'));
  check('the diff writes nothing', unchanged(snapshot(w.out), snapshot(w.out)) && snapshot(w.out).get('ir_spans')!.size === after.get('ir_spans')!.size);
  check('the approved set moved with the stale records', irSetDigestAt(ctx, corpus.id, rev1.id) !== irSetDigestAt(ctx, corpus.id, rev2.id));
  check('the corpus needs the stale and changed records looked at', ingestNeeds(ctx, corpus).some((n) => n.kind === 'spec-stale' && n.ref === missing.id)
    && ingestNeeds(ctx, corpus).some((n) => n.kind === 'spec-review' && n.ref === review.id));

  const rev3 = addRevision(w, { std: doc({ ...REV2, '## Delta': ['- Delta stays.'] }).replace('### Delta part\n- Delta one must hold.\n\n', '').replace('## Delta\n', '## Delta again\n'), notes: '# Notes\n' },
    { configDigest: digestOf('config:other') });
  check('an inferred record whose every basis section is gone is stale', isIrStale(ctx, inferredGone.id) && !isIrStale(ctx, inferredGone.id, rev2.id)
    && !isIrStale(ctx, inferredKept.id));
  const r3 = new Map(carryForward(ctx, corpus.id, rev2.id, rev3.id).map((r) => [r.irId, r]));
  check('a config change re-sections; records carry by quote, the reason says why', r3.get(carried.id)?.status === 'carried' && r3.get(carried.id)?.reason === 'config-changed');
  check('a record stale at the last revision is not brought back', !r3.has(missing.id) && isIrStale(ctx, missing.id));
  w.ctx.close();
}

section('what a stale record invalidates, read from rows; and the recovery a person makes');
{
  const w = makeWorld('ingest-authority-chain', { 'svc/dispatch/src/q.ts': 'export {};\n', 'tests/suite.test.mjs': "import test from 'node:test';\ntest('ok', () => {});\n" });
  const { ctx, corpus } = w;
  const V1 = '# Svc\n\n## Dispatch\n\n- Every parcel must be assigned to one courier.\n- A courier must never carry more than ten parcels.\n';
  const rev1 = addRevision(w, { svc: V1 });
  const r1 = addRecord(w, { kind: 'requirement', docKey: 'svc', quote: 'Every parcel must be assigned to one courier.', statement: 'One courier.' });
  const r2 = addRecord(w, { kind: 'acceptance-condition', docKey: 'svc', quote: 'A courier must never carry more than ten parcels.', statement: 'Ten.' });
  approveRecords(w, [r1.id, r2.id]);
  const u = ctx.store.recordAssumption({ campaignId: corpus.id, ownerDecisionId: 'OIR.' + r2.id.slice(3, 13).toUpperCase(), question: 'Which ten?', default: '',
    rationale: 'test', status: 'open', blocking: true, source: 'ir-interpretation', recordedBy: 'daylight', irId: r2.id });
  const bp: BlueprintV1 = {
    kind: 'daylight-blueprint', version: 1, title: 'Svc', corpusDigest: rev1.corpusDigest, irSetDigest: currentIrSetDigest(ctx, corpus.id)!, scope: { milestones: ['W1'] },
    ticketIdTemplate: '{milestone}.{component}{k}',
    boundaries: [{ id: 'svc', title: 'Svc', domain: 'd', lifecycle: 'in-repo', owns: ['svc'], bounds: [r1.id], invariants: [] }],
    components: [{ id: 'D', boundary: 'svc', title: 'Dispatch', owns: ['svc/dispatch'], sections: ['svc:dispatch'], requirements: [], dependsOn: [], provides: [], consumes: [] }],
    interfaces: [], order: [['D']], constraints: [], deferred: [], outOfScope: [],
  };
  const f = path.join(w.tmp, 'bp.json');
  fs.writeFileSync(f, JSON.stringify(bp));
  const b = importBlueprint(ctx, corpus.id, f).blueprint;
  approveBlueprint(ctx, { blueprintId: b.id, actor: HUMAN, rationale: 'ok', env: {}, confirm: confirmIngest(ctx, 'approve-blueprint', b.id).digest8 });
  const body: Omit<WorkPacket, 'id' | 'packetDigest' | 'status'> = {
    blueprintId: b.id, componentId: 'D', ticketId: 'W1.D1', milestone: 'W1', title: 'Queue', objective: 'Assign.', prerequisites: [], scope: ['svc/dispatch'],
    requirementIds: [r1.id, r2.id], interfaceContracts: [], artifacts: [], acceptanceObligations: [{ id: 'ob1', irIds: [r2.id], statement: 'Ten.' }],
    integrationDeps: [], blocksOn: [], examples: [], negativeExamples: [],
  };
  const pf = path.join(w.tmp, 'p.json');
  fs.writeFileSync(pf, JSON.stringify({ kind: 'daylight-packets', version: 1, packets: [body] }));
  const [pk] = importPackets(ctx, b.id, pf).packets;
  const emitted = emitPlan(ctx, b.id, { lanes: [], campaignGates: [{ id: 'suite', role: 'regression', path: 'tests/suite.test.mjs', harness: 'node', expect: { exitCode: 0, stdoutIncludes: ['# fail 0'] } }] });
  w.commitFiles({ 'daylight.plan.json': JSON.stringify(emitted.plan as PlanFile) });
  const campaign = importPlan(ctx, w.root, 'daylight.plan.json').campaign;
  approvePlan(ctx, { campaignId: campaign.id, actor: HUMAN, rationale: 'read', env: {}, confirm: confirmDigest(ctx, 'approve-plan', campaign.id).digest8 });
  const g = { store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: w.root, out: ctx.out, env: {} } as GateContext;
  const [suite] = registerPlanGates(g, campaign.id, emitted.plan);
  ctx.store.recordGateEvaluation({ missionId: campaign.id, projectId: campaign.projectId, revision: campaign.baseRevision, experimentId: suite.id, target: 'base',
    diffDigest: null, harnessDigest: suite.harnessDigest, executions: [], conclusion: 'supported' });
  const obligations = { [suite.id]: ['W1.D1:ob1'] };
  lockCampaign(g, { campaignId: campaign.id, actor: HUMAN, rationale: 'gates', ratchet: false, experimentIds: [suite.id], obligations, env: {},
    confirm: campaignLockConfirm(g, campaign.id, [suite.id], false, obligations).digest8 });
  check('before any revision nothing is stale', !staleTickets(ctx, campaign.id).size && !staleBlueprints(ctx, corpus.id).size && !ingestNeeds(ctx, campaign).length);
  const lockDecision = ctx.store.campaignLockDecision(campaign.id)!;
  const flags: EnvelopeFlags = { expectedGateSetDigest: lockDecision.scope.gateSetDigest as string, roster: ['mock'], maxUsdTotal: 10, maxUsdPerMission: 2,
    maxTurns: 10, timeoutSeconds: 600, maxAttemptsPerTicket: 2, concurrency: 1, execute: false, autoApply: 'integration-ref', tickets: ['W1.D1'], notAfter: '24h' };
  const auth = (f: EnvelopeFlags) => authorizeCampaign(ctx, { campaignId: campaign.id, actor: HUMAN, rationale: 'go', env: {}, flags: f,
    confirm: confirmDigest(ctx, 'authorize-campaign', campaign.id, { envelope: buildEnvelope(ctx, campaign.id, f) }).digest8 });
  auth(flags);
  check('authorized over a current IR set, the director may act', campaignAuthorizationRefusal(ctx, campaign.id) === null);

  const V2 = V1.replace('more than ten parcels', 'more than twelve parcels');
  const rev2 = addRevision(w, { svc: V2 });
  const before = snapshot(w.out);
  const decisionsBefore = ctx.store.decisions(corpus.id).length;
  carryForward(ctx, corpus.id, rev1.id, rev2.id);
  check('no existing row changed: not the record, blueprint, packet, ticket, gate or assumption', unchanged(before, snapshot(w.out)));
  const d = diffCorpus(ctx, corpus.id, rev1.id, rev2.id);
  check('exactly the edited record is stale', d.records.filter((r) => r.status === 'stale').map((r) => r.irId).join() === r2.id);
  check('the blueprint and its packet are invalidated, by reading', d.invalidated.blueprints.join() === b.id && d.invalidated.packets.join() === pk.id
    && staleBlueprints(ctx, corpus.id).has(b.id) && stalePackets(ctx, b.id).has(pk.id) && ctx.store.blueprint(b.id)!.status === 'approved');
  check('the ticket is invalidated with its state and the record', d.invalidated.tickets.length === 1 && d.invalidated.tickets[0].ticketId === 'W1.D1'
    && d.invalidated.tickets[0].state === 'unconsumed' && d.invalidated.tickets[0].irIds.join() === r2.id);
  check('the gate bound to the obligation is invalidated', d.invalidated.gates.length === 1 && d.invalidated.gates[0].experimentId === suite.id
    && d.invalidated.gates[0].obligations.join() === 'W1.D1:ob1');
  check('the interpretation of the record is invalidated', d.invalidated.assumptions.join() === u.id);
  check('staleTickets derives it for the director (TicketStatus stale lands with R16)', staleTickets(ctx, campaign.id).get('W1.D1')?.join() === r2.id);
  check('the campaign needs the gate looked at; the corpus the record and its interpretation', ingestNeeds(ctx, campaign).some((n) => n.kind === 'gate-stale' && n.ref === suite.id)
    && ingestNeeds(ctx, corpus).some((n) => n.kind === 'spec-stale' && n.ref === r2.id) && ingestNeeds(ctx, corpus).some((n) => n.kind === 'spec-stale' && n.ref === u.id));
  const drift = authorityChainOf(ctx, campaign.id).breaks.find((x) => x.link === 'ir');
  check('P2-R59: a stale cited record breaks the chain\'s ir link, naming it', !!drift && drift.why.includes(r2.id), JSON.stringify(authorityChainOf(ctx, campaign.id).breaks));
  check('P2-R59: the director pass after the revision is refused, naming the stale record', (campaignAuthorizationRefusal(ctx, campaign.id) ?? '').includes(r2.id));
  check('P2-R59: authorizing again over the drifted IR is refused', (() => {
    try {
      auth(flags);
      return false;
    } catch (err) {
      return (err as Error).message.includes(r2.id) && /accept-ir-drift/.test((err as Error).message);
    }
  })());
  const now = irSetDigestAt(ctx, corpus.id) ?? digestOf('');
  check('--accept-ir-drift naming another digest is refused', /accept-ir-drift/.test((() => {
    try {
      auth({ ...flags, acceptIrDrift: digestOf('elsewhere') });
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  })()));
  const accepted = auth({ ...flags, acceptIrDrift: now });
  check('a person accepting the current digest proceeds; the envelope records it', accepted.scope.acceptIrDrift === now
    && campaignAuthorizationRefusal(ctx, campaign.id) === null);
  check('the acceptance is in the confirm digest', confirmDigest(ctx, 'authorize-campaign', campaign.id, { envelope: buildEnvelope(ctx, campaign.id, { ...flags, acceptIrDrift: now }) }).digest
    !== confirmDigest(ctx, 'authorize-campaign', campaign.id, { envelope: buildEnvelope(ctx, campaign.id, flags) }).digest);
  check('nothing was approved, rejected or superseded by the revision', ctx.store.irRecord(r2.id)!.status === 'approved' && ctx.store.decisions(corpus.id).length === decisionsBefore);

  const r2b = addRecord(w, { kind: 'acceptance-condition', docKey: 'svc', quote: 'A courier must never carry more than twelve parcels.', statement: 'Twelve.' });
  approveRecords(w, [r2b.id], { supersede: { [r2.id]: r2b.id } });
  check('recovery is a person\'s: approve-ir supersedes the stale record with the new one', ctx.store.irRecord(r2.id)!.status === 'superseded'
    && ctx.store.irRecord(r2b.id)!.status === 'approved' && !ingestNeeds(ctx, corpus).some((n) => n.ref === r2.id));
  check('the old blueprint stays stale until a person approves a new one', staleBlueprints(ctx, corpus.id).has(b.id));
  check('P2-R59: drift past the accepted digest stops the director again', /ir \(/.test(campaignAuthorizationRefusal(ctx, campaign.id) ?? ''));
  w.ctx.close();
}

section('the CLI: what runs in an agent session');
{
  const p = (positionals: string[], flags: Record<string, string> = {}) => ({ positionals, flags: new Map(Object.entries(flags)), projects: [] });
  check('diff, blueprint validate|show, packets list|context are read-only', corpusReviewReadOnly('diff', p([])) && corpusReviewReadOnly('blueprint', p(['show']))
    && corpusReviewReadOnly('blueprint', p(['validate'])) && corpusReviewReadOnly('packets', p(['list'])) && corpusReviewReadOnly('packets', p(['context'])));
  check('a guarded act\'s preview runs; the act does not', corpusReviewReadOnly('approve-ir', p(['c'])) && !corpusReviewReadOnly('approve-ir', p(['c'], { confirm: 'x' }))
    && !corpusReviewReadOnly('approve-blueprint', p(['b'], { confirm: 'x' })));
  check('review runs only when every tool is a mock (P2-R50 Q5)', corpusReviewReadOnly('review', p([], { tools: 'mock,mock:b' })) && !corpusReviewReadOnly('review', p([], { tools: 'mock,claude' })));
  check('revise, imports and emit are a person\'s', !corpusReviewReadOnly('revise', p([])) && !corpusReviewReadOnly('blueprint', p(['import']))
    && !corpusReviewReadOnly('packets', p(['import'])) && !corpusReviewReadOnly('packets', p(['emit'])));
}

done();
