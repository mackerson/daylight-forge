/**
 * Director assumptions and the fix-lane admission (WS-R5, §5, §6.3). Run: node engine/test/forge-campaign-assumptions.ts
 *
 * What must hold: import seeds one open row per owner decision and approve-plan moves only the
 * non-blocking defaults to pending; a row nobody human recorded is never pending (a DDL CHECK);
 * an open owner decision holds its tickets and is a need; confirm, decide and overturn are
 * guarded human decisions; an overturn creates exactly one proposed follow-up and changes no
 * other row; admitIfWithinEnvelope admits only High findings within the envelope, at most
 * maxTicketsPerWave a wave. Mocks only.
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decideAssumption, recordAssumption, waitingOwner } from '../forge/assumptions.ts';
import { admitIfWithinEnvelope, campaignViolations, haltCampaign, importPlan, startTicketMission } from '../forge/campaign.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { assertImplementable, specIntakeViolations } from '../forge/work-items.ts';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { DAYLIGHT_DB } from '../mission/db.ts';
import { needsOf } from '../mission/needs.ts';
import { newId, workItemContentDigest } from '../mission/store.ts';
import type { Assumption } from '../mission/types.ts';
import { campaignActorOf } from '../mission/types.ts';
import { policyAt, ticketWorkItemId } from '../forge/plan.ts';
import { approve, authorize, authorized, CLEAN_ENV, code, HUMAN, imported, lockByHand, makeRepo, samplePlan, throws } from './forge-campaign-fixture.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const byOwner = (ctx: DaylightContext, campaignId: string, id: string): Assumption =>
  ctx.store.assumptions(campaignId).find((a) => a.ownerDecisionId === id)!;

/** Every row of the tables an overturn may touch, so "no other row" is checked, not assumed. */
function snapshot(out: string): Record<string, string[]> {
  const db = new DatabaseSync(path.join(out, DAYLIGHT_DB), { readOnly: true });
  const tables = ['missions', 'work_items', 'campaign_tickets', 'assumptions', 'decisions', 'attempts', 'experiments'];
  // A decision touches its mission's updated_at, and nothing else of it.
  const r = Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>)
    .map((x) => JSON.stringify(t === 'missions' ? { ...x, updated_at: 0 } : x)).sort()]));
  db.close();
  return r;
}

section('import seeds open rows; approve-plan moves the non-blocking defaults');
{
  const s = imported('seed');
  const id = s.imp.campaign.id;
  const rows = s.ctx.store.assumptions(id);
  check('one row per owner decision, all open, recorded by daylight', rows.length === 2 && rows.every((a) => a.status === 'open'
    && a.recordedBy === 'daylight' && a.source === 'plan-default'));
  check('the blocking one carries no default', byOwner(s.ctx, id, 'O1').default === '' && byOwner(s.ctx, id, 'O1').blocking);
  check('an open owner decision holds the tickets that block on it', waitingOwner(s.ctx, id).get('C2')?.join() === 'O1');
  check('and is an owner-decision need naming them', needsOf(s.ctx, s.ctx.store.mission(id)!).some((n) => n.kind === 'owner-decision' && n.why.includes('C2')));
  const d = approve(s.ctx, id);
  check('approve-plan moves the non-blocking default to pending, under its decision', byOwner(s.ctx, id, 'O2').status === 'pending'
    && byOwner(s.ctx, id, 'O2').decisionId === d.id);
  check('the blocking one stays open', byOwner(s.ctx, id, 'O1').status === 'open');
  check('a pending row is an assumption-pending need', needsOf(s.ctx, s.ctx.store.mission(id)!).some((n) => n.kind === 'assumption-pending'));
  const again = imported('seed-again');
  approve(again.ctx, again.imp.campaign.id);
  check('re-import seeds nothing twice', again.ctx.store.assumptions(again.imp.campaign.id).length === 2);
  again.ctx.close();
  s.ctx.close();
}

section('a non-human row is never pending (P2-R12)');
{
  const s = imported('check');
  const id = s.imp.campaign.id;
  const err = throws(() => s.ctx.store.recordAssumption({
    campaignId: id, question: 'q', default: 'd', rationale: 'r', status: 'pending', blocking: false, source: 'operator', recordedBy: 'agent:mock',
  }));
  check('the store refuses a pending row recorded by an agent', /never pending/.test(err?.message ?? ''), err?.message);
  const err2 = throws(() => s.ctx.store.recordAssumption({
    campaignId: id, question: 'q', default: 'd', rationale: 'r', status: 'pending', blocking: false, source: 'plan-default', recordedBy: 'daylight',
  }));
  check('nor a plan default the plan approval did not move', /never pending/.test(err2?.message ?? ''), err2?.message);
  const db = new DatabaseSync(path.join(s.out, DAYLIGHT_DB));
  const raw = throws(() => db.prepare("UPDATE assumptions SET status='pending' WHERE campaign_id=? AND owner_decision_id='O1'").run(id));
  db.close();
  check('raw SQL cannot make a daylight-recorded row pending either', /CHECK/.test(raw?.message ?? ''), raw?.message);
  const lock = s.ctx.store.decisions(id)[0];
  check('nor a non-human plan default naming some decision (review L4)', /never pending/.test(throws(() => s.ctx.store.recordAssumption({
    campaignId: id, question: 'q', default: 'd', rationale: 'r', status: 'pending', blocking: false, source: 'plan-default', recordedBy: 'agent:mock',
    ...(lock ? { decisionId: lock.id } : {}),
  }))?.message ?? ''));
  const db2 = new DatabaseSync(path.join(s.out, DAYLIGHT_DB));
  const someDecision = db2.prepare('SELECT id FROM decisions LIMIT 1').get() as { id: string } | undefined;
  const emptyConfirmed = throws(() => db2.prepare("UPDATE assumptions SET status='confirmed', default_value='', decision_id=? WHERE campaign_id=? AND owner_decision_id='O1'")
    .run(someDecision?.id ?? null, id));
  db2.close();
  check('the CHECK refuses a confirmed row with an empty default (review L8)', /CHECK/.test(emptyConfirmed?.message ?? ''), emptyConfirmed?.message);
  check('an open row without a decision is allowed', s.ctx.store.recordAssumption({
    campaignId: id, question: 'q', default: '', rationale: 'r', status: 'open', blocking: false, source: 'operator', recordedBy: 'agent:mock',
  }).status === 'open');
  s.ctx.close();
}

section('assumption record is a guarded human act');
{
  const s = imported('record');
  const id = s.imp.campaign.id;
  const row = { question: 'Keep the old API?', default: 'yes' };
  const c = code(confirmDigest(s.ctx, 'record-assumption', id, { assumption: row }).digest);
  const input = { campaignId: id, ...row, rationale: 'we need an answer', actor: HUMAN, confirm: c, env: CLEAN_ENV };
  check('refused under CLAUDECODE', /CLAUDECODE/.test(throws(() => recordAssumption(s.ctx, { ...input, env: { CLAUDECODE: '1' } }))?.message ?? ''));
  check('refused under DAYLIGHT_SESSION', /DAYLIGHT_SESSION/.test(throws(() => recordAssumption(s.ctx, { ...input, env: { DAYLIGHT_SESSION: 's' } }))?.message ?? ''));
  check('refused with a wrong confirm', /--confirm/.test(throws(() => recordAssumption(s.ctx, { ...input, confirm: '00000000' }))?.message ?? ''));
  check('refused for a non-human actor', /human/.test(throws(() => recordAssumption(s.ctx, { ...input, actor: 'agent:mock' }))?.message ?? ''));
  const bidi = { question: 'Keep‮ it?', default: 'yes' };
  check('refused for a question with a bidi control', /bidirectional/.test(throws(() => recordAssumption(s.ctx, {
    ...input, ...bidi, confirm: code(confirmDigest(s.ctx, 'record-assumption', id, { assumption: bidi }).digest),
  }))?.message ?? ''));
  const bare = { question: 'Who owns the API?', default: '' };
  const open = recordAssumption(s.ctx, { ...input, ...bare, confirm: code(confirmDigest(s.ctx, 'record-assumption', id, { assumption: bare }).digest) });
  check('an operator row with no default is open (review L8)', open.status === 'open' && open.source === 'operator');
  const a = recordAssumption(s.ctx, input);
  check('a person\'s row with a default is pending', a.status === 'pending' && a.recordedBy === HUMAN && a.source === 'operator');
  s.ctx.close();
}

section('confirm, decide and overturn are guarded decisions');
{
  const s = imported('decide');
  const id = s.imp.campaign.id;
  approve(s.ctx, id);
  const o2 = byOwner(s.ctx, id, 'O2');
  const cc = code(confirmDigest(s.ctx, 'confirm-assumption', o2.id).digest);
  const base = { id: o2.id, operation: 'confirm-assumption' as const, actor: HUMAN, rationale: 'fine', confirm: cc, env: CLEAN_ENV };
  check('confirm refused in an agent session', /CLAUDECODE/.test(throws(() => decideAssumption(s.ctx, { ...base, env: { CLAUDECODE: '1' } }))?.message ?? ''));
  check('confirm refused with a wrong code', /--confirm/.test(throws(() => decideAssumption(s.ctx, { ...base, confirm: '00000000' }))?.message ?? ''));
  check('confirm refused for a non-human actor', /human/.test(throws(() => decideAssumption(s.ctx, { ...base, actor: 'campaign:x' }))?.message ?? ''));
  const r = decideAssumption(s.ctx, base);
  check('pending → confirmed on its default', r.assumption.status === 'confirmed' && r.assumption.default === 'u64' && r.assumption.decisionId === r.decision.id);
  check('a confirmed row is not confirmed again', /is confirmed/.test(throws(() => decideAssumption(s.ctx, {
    ...base, confirm: code(confirmDigest(s.ctx, 'confirm-assumption', o2.id).digest),
  }))?.message ?? ''));

  const o1 = byOwner(s.ctx, id, 'O1');
  check('confirm refuses an open row (it has no default to confirm)', /is open/.test(throws(() => decideAssumption(s.ctx, {
    ...base, id: o1.id, confirm: code(confirmDigest(s.ctx, 'confirm-assumption', o1.id).digest),
  }))?.message ?? ''));
  const dc = code(confirmDigest(s.ctx, 'decide-assumption', o1.id, { value: 'error' }).digest);
  check('a code for one value does not decide another', /--confirm/.test(throws(() => decideAssumption(s.ctx, {
    id: o1.id, operation: 'decide-assumption', value: 'panic', actor: HUMAN, rationale: 'x', confirm: dc, env: CLEAN_ENV,
  }))?.message ?? ''));
  const r2 = decideAssumption(s.ctx, { id: o1.id, operation: 'decide-assumption', value: 'error', actor: HUMAN, rationale: 'owner said', confirm: dc, env: CLEAN_ENV });
  check('open → confirmed on the value decided', r2.assumption.status === 'confirmed' && r2.assumption.default === 'error');
  check('the ticket it held no longer waits', !waitingOwner(s.ctx, id).has('C2'));
  check('assumption.decided names ids only', s.ctx.events.forMission(id).some((e) => e.name === 'assumption.decided' && e.payload.decisionId === r2.decision.id
    && !JSON.stringify(e.payload).includes('error')));
  s.ctx.close();
}

section('overturn: the store needs a follow-up, the digest covers its lane and scope (review L4, L5)');
{
  const s = imported('overturn-guard');
  const id = s.imp.campaign.id;
  approve(s.ctx, id);
  const o2 = byOwner(s.ctx, id, 'O2');
  check('the store refuses an overturn with no follow-up', /exactly one follow-up/.test(throws(() => s.ctx.store.decideAssumption(o2.id, {
    actor: HUMAN, rationale: 'x', scope: { operation: 'overturn-assumption', assumptionId: o2.id, value: 'u128' },
  }))?.message ?? ''));
  const statement = 'Widen it.';
  const without = code(confirmDigest(s.ctx, 'overturn-assumption', o2.id, { value: 'u128', followUp: statement }).digest);
  const base = { id: o2.id, operation: 'overturn-assumption' as const, value: 'u128', actor: HUMAN, rationale: 'x', env: CLEAN_ENV };
  check('a code read without --scope does not confirm an overturn with one', /--confirm/.test(throws(() => decideAssumption(s.ctx, {
    ...base, followUp: { statement, scope: ['crates/core/src/lib.rs'] }, confirm: without,
  }))?.message ?? ''));
  const gh = { statement, lane: 'CORE', scope: ['.github/workflows'] };
  check('a follow-up scope on a protected path is refused', /protected/.test(throws(() => decideAssumption(s.ctx, {
    ...base, followUp: gh, confirm: code(confirmDigest(s.ctx, 'overturn-assumption', o2.id, { value: 'u128', followUp: statement, followUpLane: 'CORE', followUpScope: gh.scope }).digest),
  }))?.message ?? ''));
  check('nothing was overturned', s.ctx.store.assumption(o2.id)!.status === 'pending');
  s.ctx.close();
}

section('overturn creates exactly one proposed follow-up and changes no other row');
{
  const s = imported('overturn');
  const id = s.imp.campaign.id;
  approve(s.ctx, id);
  const o2 = byOwner(s.ctx, id, 'O2');
  const statement = 'Widen decimal to u128 where the owner needs it.';
  const oc = code(confirmDigest(s.ctx, 'overturn-assumption', o2.id, { value: 'u128', followUp: statement, followUpLane: 'CORE', followUpScope: ['crates/core/src/lib.rs'] }).digest);
  const before = snapshot(s.out);
  const r = decideAssumption(s.ctx, {
    id: o2.id, operation: 'overturn-assumption', value: 'u128', followUp: { statement, lane: 'CORE', scope: ['crates/core/src/lib.rs'] },
    actor: HUMAN, rationale: 'owner wants u128', confirm: oc, env: CLEAN_ENV,
  });
  const after = snapshot(s.out);
  const added = (t: string) => after[t].filter((x) => !before[t].includes(x));
  const removed = (t: string) => before[t].filter((x) => !after[t].includes(x));
  check('one new work item, proposed', added('work_items').length === 1 && removed('work_items').length === 0
    && s.ctx.store.workItem(r.assumption.followUpWorkItemId!)!.status === 'proposed');
  const t = s.ctx.store.campaignTicketByWorkItem(r.assumption.followUpWorkItemId!)!;
  check('one new ticket FU.1 of origin follow-up, in the lane given, sourced from the assumption',
    added('campaign_tickets').length === 1 && t.ticketId === 'FU.1' && t.origin === 'follow-up' && t.lane === 'CORE' && t.sourceRef === o2.id);
  check('its statement is the person\'s text', s.ctx.store.workItem(t.workItemId)!.statement === statement);
  check('one new decision, the overturn', added('decisions').length === 1 && r.decision.scope.operation === 'overturn-assumption'
    && r.decision.scope.followUpWorkItemId === t.workItemId);
  check('only the overturned assumption changed', added('assumptions').length === 1 && removed('assumptions').length === 1
    && r.assumption.status === 'overturned');
  check('no mission, attempt or experiment changed', ['missions', 'attempts', 'experiments'].every((x) => !added(x).length && !removed(x).length));
  check('the follow-up raises work-item-undecided', needsOf(s.ctx, s.ctx.store.mission(id)!).some((n) => n.kind === 'work-item-undecided' && n.ref === t.workItemId));
  check('it is not implementable until a person approves it', /proposed/.test(throws(() => assertImplementable(s.ctx, t.workItemId))?.message ?? ''));
  check('spec intake and campaign invariants hold', specIntakeViolations(s.ctx, o2.projectId).length === 0
    && campaignViolations(s.ctx, o2.projectId).length === 0, [...specIntakeViolations(s.ctx, o2.projectId), ...campaignViolations(s.ctx, o2.projectId)].join('; '));
  s.ctx.close();
}

section('admitIfWithinEnvelope (P2-R10)');
{
  const s = authorized('admit');
  const id = s.imp.campaign.id;
  const c = s.ctx.store.mission(id)!;
  const plan = s.ctx.store.currentPlan(id)!;
  const fix = (n: number, scope = ['crates/core/src/lib.rs']) => {
    const ticketId = `FIX.1.${n}`;
    const base = {
      projectId: c.projectId, missionId: id, specArtifact: s.ctx.store.artifact(plan.planArtifact)!, specRevision: plan.planRevision,
      anchor: `ticket:${ticketId}`, title: `Fix: finding ${n}`, statement: 'fenced finding text', examples: [], negativeExamples: [], proposedBy: 'campaign',
    };
    const w = s.ctx.store.createWorkItem({ ...base, id: ticketWorkItemId(id, ticketId, workItemContentDigest(base)) });
    s.ctx.store.insertCampaignTickets([{ campaignId: id, ticketId, projectId: c.projectId, workItemId: w.id, origin: 'fix', lane: 'FIX', dependsOn: [],
      scope, acceptance: { kind: 'ci-only' }, budget: { maxUsd: 1 }, blocksOn: [], ticketDigest: w.contentDigest, sourceRef: `f_${n}` }]);
    return w.id;
  };
  const w1 = fix(1);
  check('a medium finding stays proposed', admitIfWithinEnvelope(s.ctx, id, w1, { seq: 1, admitted: 0, severity: 'medium' }).admitted === false
    && s.ctx.store.workItem(w1)!.status === 'proposed');
  check('a low finding stays proposed', admitIfWithinEnvelope(s.ctx, id, w1, { seq: 1, admitted: 0, severity: 'low' }).admitted === false);
  const r = admitIfWithinEnvelope(s.ctx, id, w1, { seq: 1, admitted: 0, severity: 'high', findingId: 'f_1' });
  check('a high finding is admitted by a derived admit-work-item', r.admitted && r.decision.actor === campaignActorOf(id)
    && r.decision.scope.derivedFrom === s.auth.id && s.ctx.store.workItem(w1)!.status === 'approved');
  check('the admitted item is implementable', assertImplementable(s.ctx, w1).id === w1);
  const w2 = fix(2);
  check('a second in the same wave is admitted (cap 2)', admitIfWithinEnvelope(s.ctx, id, w2, { seq: 1, admitted: 0, severity: 'high' }).admitted);
  const w3 = fix(3);
  const third = admitIfWithinEnvelope(s.ctx, id, w3, { seq: 1, admitted: 0, severity: 'high' });
  check('a third in the same wave is not: counted from rows, whatever the caller passes', !third.admitted && s.ctx.store.workItem(w3)!.status === 'proposed', JSON.stringify(third));
  check('the next wave counts afresh', admitIfWithinEnvelope(s.ctx, id, w3, { seq: 2, admitted: 0, severity: 'high' }).admitted);
  const w4 = fix(4, ['Cargo.lock']);
  check('a protected scope is not admitted', !admitIfWithinEnvelope(s.ctx, id, w4, { seq: 3, admitted: 0, severity: 'high' }).admitted);
  const w5 = fix(5, ['docs/elsewhere.md']);
  check('a scope outside every lane is not admitted', !admitIfWithinEnvelope(s.ctx, id, w5, { seq: 3, admitted: 0, severity: 'high' }).admitted);
  const plain = s.ctx.store.campaignTicket(id, 'C2')!.workItemId;
  check('a plan ticket is never admitted this way', !admitIfWithinEnvelope(s.ctx, id, plain, { seq: 3, admitted: 0, severity: 'high' }).admitted);
  check('derivationRefusals is empty after admissions', s.ctx.store.derivationRefusals().length === 0, s.ctx.store.derivationRefusals().join('; '));
  check('spec intake holds over admitted items', specIntakeViolations(s.ctx, c.projectId).length === 0, specIntakeViolations(s.ctx, c.projectId).join('; '));
  haltCampaign(s.ctx, id, HUMAN, 'operator');
  const w6 = fix(6);
  check('nothing is admitted while halted', !admitIfWithinEnvelope(s.ctx, id, w6, { seq: 4, admitted: 0, severity: 'high' }).admitted);
  s.ctx.close();

  const off = authorized('admit-off', { fixLane: { enabled: false, maxTicketsPerWave: 0, maxUsdPerTicket: 0 } });
  const oc = off.ctx.store.mission(off.imp.campaign.id)!;
  const op = off.ctx.store.currentPlan(oc.id)!;
  const base = {
    projectId: oc.projectId, missionId: oc.id, specArtifact: off.ctx.store.artifact(op.planArtifact)!, specRevision: op.planRevision,
    anchor: 'ticket:FIX.1.1', title: 'Fix', statement: 's', examples: [], negativeExamples: [], proposedBy: 'campaign',
  };
  const w = off.ctx.store.createWorkItem({ ...base, id: ticketWorkItemId(oc.id, 'FIX.1.1', workItemContentDigest(base)) });
  off.ctx.store.insertCampaignTickets([{ campaignId: oc.id, ticketId: 'FIX.1.1', projectId: oc.projectId, workItemId: w.id, origin: 'fix', lane: 'FIX',
    dependsOn: [], scope: ['crates/core/src/lib.rs'], acceptance: { kind: 'ci-only' }, budget: {}, blocksOn: [], ticketDigest: w.contentDigest }]);
  check('with the fix lane off, a high finding stays proposed', !admitIfWithinEnvelope(off.ctx, oc.id, w.id, { seq: 1, admitted: 0, severity: 'high' }).admitted);
  off.ctx.close();
}

section('the store enforces the fix lane itself (P2-R34, review M1)');
{
  /** A proposed fix ticket filed as R6's wave would file it. */
  const fileFix = (ctx: DaylightContext, id: string, n: number, scope = ['crates/core/src/lib.rs'], budget: { maxUsd?: number } = {}) => {
    const c = ctx.store.mission(id)!;
    const plan = ctx.store.currentPlan(id)!;
    const ticketId = `FIX.9.${n}`;
    const base = {
      projectId: c.projectId, missionId: id, specArtifact: ctx.store.artifact(plan.planArtifact)!, specRevision: plan.planRevision,
      anchor: `ticket:${ticketId}`, title: `Fix ${n}`, statement: 's', examples: [], negativeExamples: [], proposedBy: 'campaign',
    };
    const w = ctx.store.createWorkItem({ ...base, id: ticketWorkItemId(id, ticketId, workItemContentDigest(base)) });
    ctx.store.insertCampaignTickets([{ campaignId: id, ticketId, projectId: c.projectId, workItemId: w.id, origin: 'fix', lane: 'FIX', dependsOn: [],
      scope, acceptance: { kind: 'ci-only' }, budget, blocksOn: [], ticketDigest: w.contentDigest }]);
    return { ticketId, w: w.id };
  };
  const off = authorized('lane-off', { fixLane: { enabled: false, maxTicketsPerWave: 5, maxUsdPerTicket: 1 } });
  const offId = off.imp.campaign.id;
  const f = fileFix(off.ctx, offId, 1);
  const err = throws(() => off.ctx.store.admitWorkItem(f.w, off.auth.id, { ticketId: f.ticketId, waveSeq: 1 }, null));
  check('store.admitWorkItem refuses with the fix lane off, whatever its cap', /fix lane is off/.test(err?.message ?? ''), err?.message);
  check('and the item stays proposed', off.ctx.store.workItem(f.w)!.status === 'proposed');
  // A raw admission past the store is caught by the row invariant.
  const c = off.ctx.store.mission(offId)!;
  const db = new DatabaseSync(path.join(off.out, DAYLIGHT_DB));
  const forged = newId('decision');
  db.prepare('INSERT INTO decisions (id, mission_id, project_id, revision, actor, kind, rationale, scope, artifact_ids, at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    forged, offId, c.projectId, c.baseRevision, campaignActorOf(offId), 'approve', 'raw',
    JSON.stringify({ operation: 'admit-work-item', derivedFrom: off.auth.id, workItemId: f.w, contentDigest: 'x', ticketId: f.ticketId, waveSeq: 1 }), '[]', Date.now(),
  );
  db.close();
  check('derivationRefusals reports an admission outside the fix lane', off.ctx.store.derivationRefusals().some((r) => r.includes(forged) && /fix lane/.test(r)),
    off.ctx.store.derivationRefusals().join('; '));
  check('campaignViolations reports it too', campaignViolations(off.ctx, c.projectId).some((r) => r.includes(forged)));
  off.ctx.close();

  const on = authorized('lane-cap', { fixLane: { enabled: true, maxTicketsPerWave: 2, maxUsdPerTicket: 0.5 } });
  const onId = on.imp.campaign.id;
  const a = fileFix(on.ctx, onId, 1);
  const b = fileFix(on.ctx, onId, 2);
  const x = fileFix(on.ctx, onId, 3);
  on.ctx.store.admitWorkItem(a.w, on.auth.id, { ticketId: a.ticketId, waveSeq: 1 }, null);
  on.ctx.store.admitWorkItem(b.w, on.auth.id, { ticketId: b.ticketId, waveSeq: 1 }, null);
  check('the store refuses a third admission in one wave', /already admitted 2/.test(throws(() => on.ctx.store.admitWorkItem(x.w, on.auth.id, { ticketId: x.ticketId, waveSeq: 1 }, null))?.message ?? ''));
  check('and refuses one that names no wave', /names the wave/.test(throws(() => on.ctx.store.admitWorkItem(x.w, on.auth.id, { ticketId: x.ticketId, waveSeq: 0 }, null))?.message ?? ''));
  const m = startTicketMission(on.ctx, { campaignId: onId, ticketId: a.ticketId, base: on.commit });
  check('an admitted fix ticket with no budget runs at the fix lane\'s per-ticket cap', m.budget.maxUsd === 0.5, String(m.budget.maxUsd));
  check('derivationRefusals stays empty for admissions inside the lane', on.ctx.store.derivationRefusals().length === 0, on.ctx.store.derivationRefusals().join('; '));
  on.ctx.close();

  // A scope the policy at the plan commit protects (review P13).
  const r = makeRepo('lane-policy', samplePlan(), {
    'daylight.policy.json': JSON.stringify({ schema: 'daylight.policy/v1', protectedPaths: ['crates/core/src/secret.rs'] }),
    'crates/core/src/secret.rs': '// secret\n',
  });
  const ctx = openDaylight(r.out);
  const imp = importPlan(ctx, r.root, 'daylight.plan.json');
  approve(ctx, imp.campaign.id);
  lockByHand(ctx, imp.campaign.id);
  const auth = authorize(ctx, imp.campaign.id);
  const p = fileFix(ctx, imp.campaign.id, 1, ['crates/core/src/secret.rs']);
  const viaForge = admitIfWithinEnvelope(ctx, imp.campaign.id, p.w, { seq: 1, admitted: 0, severity: 'high' });
  check('a High fix on a path the plan-commit policy protects is not admitted', !viaForge.admitted, JSON.stringify(viaForge));
  const policy = policyAt(r.root, r.commit);
  check('the store refuses it under the policy the authorization names', /protected/.test(throws(() => ctx.store.admitWorkItem(p.w, auth.id, { ticketId: p.ticketId, waveSeq: 1 }, policy))?.message ?? ''));
  check('the store refuses a policy other than the one the authorization names', /not the one/.test(throws(() => ctx.store.admitWorkItem(p.w, auth.id, { ticketId: p.ticketId, waveSeq: 1 }, null))?.message ?? ''));
  const yarn = fileFix(ctx, imp.campaign.id, 2, ['.yarn/releases']);
  check('a directory scope over a protected subtree is refused (.yarn/releases)', /protected/.test(throws(() => ctx.store.admitWorkItem(yarn.w, auth.id, { ticketId: yarn.ticketId, waveSeq: 1 }, policy))?.message ?? ''));
  ctx.close();
}

done();
