/**
 * Campaign authorization and derived decisions (WS-R5, ADR-37). Run: node engine/test/forge-campaign-authorize.ts
 *
 * What must hold: approve-plan and authorize-campaign are a person's guarded acts and every
 * row-writing campaign command is refused in an agent session; the confirm digest covers every
 * envelope field; a derived grant exists only inside its envelope (ticket, window, halt, plan,
 * lock, one mission a ticket) and only through recordDerivedDecision; a forged one is caught by
 * unauthorizedWriteAttempts and derivationRefusals and refused by startAttempt; campaign missions
 * never travel by export; a preflight-refused ticket is released by `campaign retry` only.
 * Mocks only: no model, no cargo, no bwrap.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  authorizeGrantRefusal, buildEnvelope, envelopeRefusal, haltCampaign, resumeCampaign, retryTicket, startTicketMission, campaignViolations,
  approvePlan, authorizeCampaign, importPlan, planOf,
} from '../forge/campaign.ts';
import { registerPlanGates } from '../forge/campaign-gates.ts';
import { campaignReadOnly, sessionRefusal } from '../forge/commands-campaign.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { assertImplementable, specIntakeViolations } from '../forge/work-items.ts';
import { openDaylight } from '../mission/context.ts';
import { DAYLIGHT_DB } from '../mission/db.ts';
import { exportMission, importMission } from '../mission/export.ts';
import { needsOf } from '../mission/needs.ts';
import { decisionRefusal, envelopeShapeRefusal, movesWorkItem, newId } from '../mission/store.ts';
import { campaignActorOf, type CampaignEnvelope } from '../mission/types.ts';
import {
  approve, authorize, authorized, CLEAN_ENV, code, FLAGS, GATE_SET, HUMAN, imported, lock, makeRepo, revisePlan, ROOT, samplePlan, throws, tmp,
} from './forge-campaign-fixture.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const CLI = path.join(ROOT, 'engine', 'cli.ts');

const cli = (args: string[], env: Record<string, string>) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tmp, ...env }, timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};

const author = (missionId: string, decisionId: string, exec = false) => ({
  missionId, decisionId,
  sandbox: { profile: 'author' as const, network: 'none' as const, write: true, exec, authorizeDecisionId: decisionId },
});

section('agent sessions write nothing (P2-R9, P2-R24, P2-R25)');
{
  const s = imported('session');
  const id = s.imp.campaign.id;
  s.ctx.close();
  for (const v of ['CLAUDECODE', 'DAYLIGHT_SESSION']) {
    const env = { [v]: '1' };
    const writes: Array<[string, string[]]> = [
      ['import', ['campaign', 'import', s.root, '--file', 'daylight.plan.json', '--out', s.out]],
      ['approve-plan', ['campaign', 'approve-plan', id, '--rationale', 'x', '--confirm', '00000000', '--out', s.out]],
      ['authorize', ['campaign', 'authorize', id, '--expected-gate-set', 'x', '--confirm', '00000000', '--out', s.out]],
      ['retry', ['campaign', 'retry', id, 'C1', '--confirm', '00000000', '--out', s.out]],
      ['run (R6, not a dry run)', ['campaign', 'run', id, s.root, '--out', s.out]],
      ['status --write (R6)', ['campaign', 'status', id, '--write', '--out', s.out]],
      ['assumption record', ['assumption', 'record', id, '--question', 'q', '--default', 'd', '--confirm', '00000000', '--out', s.out]],
      ['assumption confirm', ['assumption', 'confirm', 'u_x', '--confirm', '00000000', '--out', s.out]],
    ];
    const before = fs.statSync(path.join(s.out, DAYLIGHT_DB)).mtimeMs;
    for (const [name, args] of writes) {
      const r = cli(args, env);
      check(`${v}: campaign ${name} is refused, exit 1, naming the variable`, r.code === 1 && r.err.includes(v) && r.err.includes('refused'), `${r.code} ${r.err}`);
    }
    check(`${v}: the database was not written`, fs.statSync(path.join(s.out, DAYLIGHT_DB)).mtimeMs === before);
    const show = cli(['campaign', 'show', id, '--out', s.out, '--format', 'json'], env);
    check(`${v}: campaign show runs`, show.code === 0 && JSON.parse(show.out).campaign.id === id, show.err);
    const val = cli(['campaign', 'validate', 'daylight.plan.json', s.root, '--format', 'json'], env);
    check(`${v}: campaign validate runs and opens no store`, val.code === 0 && JSON.parse(val.out).ok === true, val.err);
    const list = cli(['assumption', 'list', id, '--out', s.out, '--format', 'json'], env);
    check(`${v}: assumption list runs`, list.code === 0 && JSON.parse(list.out).length === 2, list.err);
  }
  const confirmed = { positionals: [], flags: new Map([['confirm', '00000000']]) };
  check('the read-only set is show, validate, status, gate list, run --dry-run and a guarded act\'s preview',
    ['show', 'validate', 'status'].every((x) => campaignReadOnly(x))
      && campaignReadOnly('gate', { positionals: ['list'], flags: new Map() })
      && campaignReadOnly('run', { positionals: [], flags: new Map([['dry-run', 'true']]) })
      && !campaignReadOnly('gate', { positionals: ['register'], flags: new Map() })
      && !campaignReadOnly('status', { positionals: [], flags: new Map([['write', 'true']]) })
      && ['approve-plan', 'authorize', 'retry', 'lock', 'resume', 'adopt-tip'].every((x) => campaignReadOnly(x) && !campaignReadOnly(x, confirmed))
      && !['import', 'baseline', 'halt', 'run'].some((x) => campaignReadOnly(x)));
  check('sessionRefusal is null in a clean environment', sessionRefusal(CLEAN_ENV, 'x') === null && sessionRefusal({ CLAUDECODE: '' }, 'x') === null);
}

section('previews of guarded acts run in an agent session; the confirmed act does not (P2-R41)');
{
  const s = imported('session-preview');
  const id = s.imp.campaign.id;
  const assumptionId = s.ctx.store.assumptions(id)[0].id;
  // Registered by a person beforehand, so the lock preview has gates to name.
  registerPlanGates({ store: s.ctx.store, artifacts: s.ctx.artifacts, events: s.ctx.events, repoRoot: s.root, out: s.out, env: CLEAN_ENV }, id, planOf(s.ctx, id).plan);
  const rows = () => {
    const ctx = openDaylight(s.out);
    try {
      return JSON.stringify([ctx.store.decisions(id).length, ctx.store.assumptions(id).map((a) => a.status), ctx.store.campaignTickets(id).length]);
    } finally {
      ctx.close();
    }
  };
  s.ctx.close();
  const before = rows();
  const envelope = ['--expected-gate-set', GATE_SET, '--roster', 'mock', '--max-usd-total', '40', '--max-usd-per-mission', '2', '--max-turns', '60',
    '--timeout', '600', '--max-attempts', '3', '--concurrency', '2', '--auto-apply', 'integration-ref'];
  const previews: Array<[string, string[]]> = [
    ['campaign approve-plan', ['campaign', 'approve-plan', id, '--rationale', 'x']],
    ['campaign authorize', ['campaign', 'authorize', id, ...envelope, '--rationale', 'x']],
    ['campaign lock', ['campaign', 'lock', id, '--no-ratchet', '--rationale', 'x']],
    ['assumption record', ['assumption', 'record', id, '--question', 'q', '--default', 'd']],
    ['assumption confirm', ['assumption', 'confirm', assumptionId, '--rationale', 'x']],
    ['assumption decide', ['assumption', 'decide', assumptionId, '--value', 'v', '--rationale', 'x']],
  ];
  for (const v of ['CLAUDECODE', 'DAYLIGHT_SESSION']) {
    for (const [name, args] of previews) {
      const r = cli([...args, '--out', s.out, '--format', 'json'], { [v]: '1' });
      const digest = r.code === 2 ? (JSON.parse(r.out) as { digest?: string }).digest : undefined;
      check(`${v}: the ${name} preview exits 2 with its digest`, r.code === 2 && /^sha256:[0-9a-f]{64}$/.test(digest ?? ''), `${r.code} ${r.err}`);
      const text = cli([...args, '--out', s.out], { [v]: '1' });
      check(`${v}: and prints it as text`, text.code === 2 && /^digest sha256:|^gate set sha256:/m.test(text.out), `${text.code} ${text.err}`);
      const act = cli([...args, '--out', s.out, '--confirm', (digest ?? 'sha256:00000000').slice(7, 15)], { [v]: '1' });
      check(`${v}: ${name} --confirm is refused at the CLI`, act.code === 1 && act.err.includes(v) && act.err.includes('refused'), `${act.code} ${act.err}`);
      const bare = cli([...args, '--out', s.out, '--confirm'], { [v]: '1' });
      check(`${v}: a bare --confirm is not a preview`, bare.code === 1 && bare.err.includes('refused'), `${bare.code} ${bare.err}`);
    }
  }
  check('no row was written by any preview or refusal', rows() === before, `${before} -> ${rows()}`);
}

section('campaign commands outside an agent session');
{
  const s = imported('clean-cli');
  const id = s.imp.campaign.id;
  s.ctx.close();
  const bare = cli(['assumption', 'record', id, '--question', 'q', '--default', '--out', s.out], {});
  check('assumption record with a bare --default is a usage error, not the default "true" (review L6)', bare.code === 2 && /--default needs a value/.test(bare.err), bare.err);
  const empty = path.join(tmp, 'empty-out');
  fs.mkdirSync(empty);
  const shown = cli(['campaign', 'show', id, '--out', empty], { CLAUDECODE: '1' });
  check('campaign show on an empty out dir fails and creates nothing (review L7)', shown.code === 1 && fs.readdirSync(empty).length === 0, `${shown.code} ${fs.readdirSync(empty).join()}`);
  const listed = cli(['assumption', 'list', id, '--out', empty], { CLAUDECODE: '1' });
  check('assumption list on an empty out dir creates nothing', listed.code === 1 && fs.readdirSync(empty).length === 0);
}

section('approve-plan is a guarded human act');
{
  const s = imported('approve');
  const id = s.imp.campaign.id;
  const c = confirmDigest(s.ctx, 'approve-plan', id);
  const base = { campaignId: id, actor: HUMAN, rationale: 'ok', env: CLEAN_ENV, confirm: code(c.digest) };
  check('refused under CLAUDECODE at the guard too', /CLAUDECODE/.test(throws(() => approvePlan(s.ctx, { ...base, env: { CLAUDECODE: '1' } }))?.message ?? ''));
  check('refused with a wrong confirm code', /--confirm/.test(throws(() => approvePlan(s.ctx, { ...base, confirm: '00000000' }))?.message ?? ''));
  check('refused for a non-human actor', /human/.test(throws(() => approvePlan(s.ctx, { ...base, actor: 'agent:mock' }))?.message ?? ''));
  check('refused without a rationale', /rationale/.test(throws(() => approvePlan(s.ctx, { ...base, rationale: ' ' }))?.message ?? ''));
  check('nothing moved after the refusals', s.ctx.store.workItems(s.imp.campaign.projectId).every((w) => w.status === 'proposed'));
  const d = approvePlan(s.ctx, base);
  const items = s.ctx.store.campaignTickets(id).map((t) => s.ctx.store.workItem(t.workItemId)!);
  check('one decision approves every plan ticket', items.every((w) => w.status === 'approved' && w.decisionId === d.id));
  check('the decision lists each work item at its digest', items.every((w) => (d.scope.workItems as Record<string, string>)[w.id] === w.contentDigest));
  check('the campaign is ready', s.ctx.store.mission(id)!.state === 'ready');
  {
    const w = items[0];
    const fake = { ...d, id: newId('decision'), actor: 'agent:mock' };
    check('an approve-plan by anyone but a person moves nothing (review L8)', !movesWorkItem(fake, w, 'approved') && movesWorkItem(d, w, 'approved'));
  }
  check('assertImplementable accepts an approve-plan item', assertImplementable(s.ctx, items[1].id).id === items[1].id);
  check('the spec-intake invariant holds over approve-plan items', specIntakeViolations(s.ctx, s.imp.campaign.projectId).length === 0,
    specIntakeViolations(s.ctx, s.imp.campaign.projectId).join('; '));
  check('the campaign invariants hold', campaignViolations(s.ctx, s.imp.campaign.projectId).length === 0, campaignViolations(s.ctx, s.imp.campaign.projectId).join('; '));

  {
    // D5: a revision may not change a ticket whose mission is still open (review L8).
    const sd = authorized('d5');
    const m = startTicketMission(sd.ctx, { campaignId: sd.imp.campaign.id, ticketId: 'C1', base: sd.commit });
    const p = samplePlan();
    p.tickets[0].statement = 'changed while building';
    revisePlan(sd.root, p);
    const err = throws(() => importPlan(sd.ctx, sd.root, 'daylight.plan.json', { campaignId: sd.imp.campaign.id }));
    check('import refuses a revision that changes a ticket an open mission builds', new RegExp(`mission ${m.id}`).test(err?.message ?? ''), err?.message);
    sd.ctx.close();
  }
  // A changed ticket is a new work item; the next approve-plan supersedes the old one.
  const p = samplePlan();
  p.tickets[2].statement = 'main prints -7 and a newline.';
  revisePlan(s.root, p);
  const r = importPlan(s.ctx, s.root, 'daylight.plan.json', { campaignId: id });
  check('a revision keeps unchanged tickets and adds the changed one', r.kept.length === 3 && r.added.join() === 'A1', JSON.stringify(r));
  const old = items[2];
  const c2 = confirmDigest(s.ctx, 'approve-plan', id);
  check('the code for the earlier plan no longer confirms', c2.digest !== c.digest);
  const d2 = approve(s.ctx, id);
  check('the next approve-plan supersedes the old work item', s.ctx.store.workItem(old.id)!.status === 'superseded'
    && (d2.scope.supersedes as string[]).includes(old.id));
  check('and approves the new one', s.ctx.store.workItem(s.ctx.store.campaignTicket(id, 'A1')!.workItemId)!.status === 'approved');
  check('the campaign invariants hold after the revision', campaignViolations(s.ctx, s.imp.campaign.projectId).length === 0, campaignViolations(s.ctx, s.imp.campaign.projectId).join('; '));
  s.ctx.close();
}

section('authorize-campaign');
{
  const s = imported('authz');
  const id = s.imp.campaign.id;
  check('refused without approve-plan', /approved/.test(throws(() => authorize(s.ctx, id))?.message ?? ''), throws(() => authorize(s.ctx, id))?.message);
  approve(s.ctx, id);
  check('refused without a gate lock', /gate lock/.test(throws(() => authorize(s.ctx, id))?.message ?? ''));
  lock(s.ctx, id);
  check('refused when --expected-gate-set is not the lock\'s digest', /gate lock/.test(throws(() => authorize(s.ctx, id, { expectedGateSetDigest: GATE_SET }))?.message ?? ''));
  const env = buildEnvelope(s.ctx, id, FLAGS);
  const digest = confirmDigest(s.ctx, 'authorize-campaign', id, { envelope: env }).digest;
  const changed: Array<[string, Partial<CampaignEnvelope>]> = [
    ['planDigest', { planDigest: `sha256:${'c'.repeat(64)}` }], ['gateSetDigest', { gateSetDigest: 'x' }], ['policyDigest', { policyDigest: 'p' }],
    ['ticketIds', { ticketIds: ['C1'] }], ['roster', { roster: ['mock:b'] }], ['reviewRoster', { reviewRoster: ['mock'] }],
    ['maxUsdTotal', { maxUsdTotal: 41 }], ['maxUsdPerMission', { maxUsdPerMission: 1 }], ['maxTurns', { maxTurns: 59 }],
    ['timeoutSeconds', { timeoutSeconds: 599 }], ['maxAttemptsPerTicket', { maxAttemptsPerTicket: 2 }], ['concurrency', { concurrency: 3 }],
    ['waveSize', { waveSize: 5 }], ['execute', { execute: true }], ['autoApply', { autoApply: 'none' }],
    ['fixLane', { fixLane: { ...env.fixLane, maxTicketsPerWave: 1 } }], ['identity', { identity: { name: 'x', email: 'x@y.z' } }],
    ['notAfter', { notAfter: env.notAfter + 3_600_000 }],
  ];
  for (const [field, patch] of changed) {
    check(`the confirm digest changes with ${field}`, confirmDigest(s.ctx, 'authorize-campaign', id, { envelope: { ...env, ...patch } }).digest !== digest);
  }
  check('the preview and the act agree on notAfter (rounded to the hour)', buildEnvelope(s.ctx, id, FLAGS).notAfter === env.notAfter && env.notAfter % 3_600_000 === 0);
  const refusals: Array<[string, Partial<typeof FLAGS>, RegExp]> = [
    ['a per-mission cap above the campaign cap', { maxUsdPerMission: 41 }, /per-mission cap/],
    ['a fix-lane cap above the per-mission cap', { fixLane: { enabled: true, maxTicketsPerWave: 1, maxUsdPerTicket: 3 } }, /fix lane/],
    ['more than 5 fix tickets a wave (P2-R10)', { fixLane: { enabled: true, maxTicketsPerWave: 6, maxUsdPerTicket: 1 } }, /5 tickets/],
    ['turns above authorLimits at the plan commit (P2-R20)', { maxTurns: 61 }, /max-turns/],
    ['a timeout above authorLimits', { timeoutSeconds: 601 }, /timeout/],
    ['a ticket that is not a plan ticket', { tickets: ['ZZ'] }, /not an approved plan ticket/],
    ['a roster entry that is not tool[:model]', { roster: ['mock; rm -rf /'] }, /roster/],
    ['--not-after beyond 30 days', { notAfter: '31d' }, /not-after/],
  ];
  for (const [name, patch, re] of refusals) {
    const err = throws(() => authorize(s.ctx, id, patch));
    check(`refused: ${name}`, re.test(err?.message ?? ''), err?.message);
  }
  for (const span of ['30d', '720h']) {
    const e = buildEnvelope(s.ctx, id, { ...FLAGS, notAfter: span });
    check(`--not-after ${span}, the documented maximum, passes the store's shape check (review L1)`, envelopeShapeRefusal(e, s.ctx.store.clock()) === null,
      String(envelopeShapeRefusal(e, s.ctx.store.clock())));
  }
  check('--not-after 721h is refused', /not-after/.test(throws(() => buildEnvelope(s.ctx, id, { ...FLAGS, notAfter: '721h' }))?.message ?? ''));
  const past = { ...buildEnvelope(s.ctx, id, FLAGS), notAfter: s.ctx.store.clock() - 1000 };
  check('the store refuses a notAfter in the past (review L8)', /not-after/.test(throws(() => s.ctx.store.authorizeCampaign(id, {
    actor: HUMAN, rationale: 'x', expectedGateSetDigest: past.gateSetDigest, policy: null, scope: { operation: 'authorize-campaign', ...past },
  }))?.message ?? ''));
  const big = { ...buildEnvelope(s.ctx, id, FLAGS), maxTurns: 5000 };
  check('the store applies authorLimits itself (review L3)', /turns and timeout/.test(throws(() => s.ctx.store.authorizeCampaign(id, {
    actor: HUMAN, rationale: 'x', expectedGateSetDigest: big.gateSetDigest, policy: null, scope: { operation: 'authorize-campaign', ...big },
  }))?.message ?? ''));
  const cc = s.ctx.store.mission(id)!;
  check('recordDecision refuses a raw authorize-campaign scope (review L3)', /authorizeCampaign only/.test(throws(() => s.ctx.store.recordDecision({
    missionId: id, projectId: cc.projectId, revision: cc.baseRevision, actor: HUMAN, kind: 'approve', rationale: 'x', artifactIds: [],
    scope: { operation: 'authorize-campaign', ...buildEnvelope(s.ctx, id, FLAGS), maxTurns: 99999 },
  }))?.message ?? ''));
  const e0 = buildEnvelope(s.ctx, id, FLAGS);
  check('refused for a non-human actor', /human/.test(throws(() => authorizeCampaign(s.ctx, {
    campaignId: id, actor: 'agent:mock', rationale: 'x', env: CLEAN_ENV, flags: FLAGS, confirm: code(confirmDigest(s.ctx, 'authorize-campaign', id, { envelope: e0 }).digest),
  }))?.message ?? ''));
  check('refused with a wrong confirm', /--confirm/.test(throws(() => authorizeCampaign(s.ctx, {
    campaignId: id, actor: HUMAN, rationale: 'x', env: CLEAN_ENV, flags: FLAGS, confirm: '00000000',
  }))?.message ?? ''));
  check('nothing was recorded by any refusal', s.ctx.store.campaignAuthorization(id) === null);
  const d = authorize(s.ctx, id);
  check('a valid envelope is recorded as a human authorize-campaign', d.actor === HUMAN && d.scope.operation === 'authorize-campaign'
    && s.ctx.store.campaignAuthorization(id)?.id === d.id);
  check('campaign.authorized carries ids and caps, no prose', s.ctx.events.forMission(id).some((e) => e.name === 'campaign.authorized'
    && e.payload.decisionId === d.id && e.payload.maxUsdTotal === 40 && !('rationale' in e.payload)));
  s.ctx.close();
}

section('derived decisions: only recordDerivedDecision writes them (P2-R19)');
{
  const s = authorized('derived');
  const id = s.imp.campaign.id;
  const c = s.ctx.store.mission(id)!;
  const actor = campaignActorOf(id);
  const err = throws(() => s.ctx.store.recordDecision({
    missionId: id, projectId: c.projectId, revision: c.baseRevision, actor, kind: 'defer', rationale: 'x',
    scope: { operation: 'halt-campaign', reason: 'operator', derivedFrom: s.auth.id }, artifactIds: [],
  }));
  check('recordDecision refuses a campaign actor, even on a derived operation', /derived/.test(err?.message ?? ''), err?.message);
  check('decisionRefusal refuses a campaign actor on a person\'s operation',
    /person's act/.test(decisionRefusal({ id: 'd', actor, kind: 'approve', scope: { operation: 'approve-plan', derivedFrom: s.auth.id } }) ?? ''));
  check('decisionRefusal refuses a derived decision with no derivedFrom',
    /derives from/.test(decisionRefusal({ id: 'd', actor, kind: 'approve', scope: { operation: 'authorize-mission' } }) ?? ''));
  check('decisionRefusal admits a derived operation that names its grant',
    decisionRefusal({ id: 'd', actor, kind: 'approve', scope: { operation: 'authorize-mission', derivedFrom: s.auth.id } }) === null);
  const base = { missionId: id, projectId: c.projectId, revision: c.baseRevision, kind: 'defer' as const, rationale: 'x', artifactIds: [] };
  check('recordDerivedDecision refuses another campaign\'s actor', /recorded as/.test(throws(() => s.ctx.store.recordDerivedDecision(s.auth.id, {
    ...base, actor: campaignActorOf(newId('mission')), scope: { operation: 'halt-campaign', reason: 'operator', derivedFrom: s.auth.id },
  }))?.message ?? ''));
  check('recordDerivedDecision refuses a mismatched derivedFrom', /derivedFrom/.test(throws(() => s.ctx.store.recordDerivedDecision(s.auth.id, {
    ...base, actor, scope: { operation: 'halt-campaign', reason: 'operator', derivedFrom: newId('decision') },
  }))?.message ?? ''));
  check('recordDerivedDecision refuses a non-derived operation', /person's act/.test(throws(() => s.ctx.store.recordDerivedDecision(s.auth.id, {
    ...base, actor, scope: { operation: 'lock-gates', derivedFrom: s.auth.id },
  }))?.message ?? ''));
  check('recordDerivedDecision refuses a parent that is not an authorize-campaign', /authorize-campaign/.test(throws(() => s.ctx.store.recordDerivedDecision(
    s.ctx.store.latestDecision(id, 'approve-plan')!.id, { ...base, actor, scope: { operation: 'halt-campaign', reason: 'operator', derivedFrom: s.ctx.store.latestDecision(id, 'approve-plan')!.id } },
  ))?.message ?? ''));
  s.ctx.close();
}

section('deriveAuthorizeMission stays inside the envelope');
{
  let t = Date.parse('2026-10-19T12:00:00Z');
  const s = authorized('envelope', {}, () => t);
  const id = s.imp.campaign.id;
  const m = startTicketMission(s.ctx, { campaignId: id, ticketId: 'C1', base: s.commit });
  const grant = s.ctx.store.authorizeDecision(m.id)!;
  check('a ticket mission is ready with write, from a derived grant', m.state === 'ready' && m.permissions.write && !m.permissions.execute
    && grant.actor === campaignActorOf(id) && grant.scope.derivedFrom === s.auth.id);
  check('its budget is the lesser of the ticket\'s and the envelope\'s', m.budget.maxUsd === 1.5 && grant.scope.maxUsd === 1.5);
  check('the derived decision is an authorize-mission on the ticket mission (R7 literally)', grant.missionId === m.id && grant.scope.operation === 'authorize-mission');
  check('authorizeGrantRefusal accepts it', authorizeGrantRefusal(s.ctx, m) === null);
  const task = s.ctx.store.createTask({ missionId: m.id, role: 'author', objective: 'a' });
  const a = s.ctx.store.startAttempt({ taskId: task.id, runnerId: 'agent:mock:x', sandbox: author(m.id, grant.id).sandbox, maxCostUsd: 1.25 });
  check('an author attempt starts with write under it', a.sandbox?.write === true);
  check('attempts.max_cost_usd round-trips', s.ctx.store.attempt(a.id)!.maxCostUsd === 1.25);
  s.ctx.store.finishAttempt(a.id, { state: 'failed', costUsd: null });
  check('exec is refused when the envelope did not grant execute', /exec/.test(throws(() => s.ctx.store.startAttempt({
    taskId: task.id, runnerId: 'agent:mock:x', sandbox: author(m.id, grant.id, true).sandbox,
  }))?.message ?? ''));
  check('R7 holds: unauthorizedWriteAttempts is empty', s.ctx.store.unauthorizedWriteAttempts().length === 0);
  check('derivationRefusals is empty', s.ctx.store.derivationRefusals().length === 0, s.ctx.store.derivationRefusals().join('; '));
  check('the campaign never holds write or execute', !s.ctx.store.mission(id)!.permissions.write && !s.ctx.store.mission(id)!.permissions.execute);

  const refusedFor = (ticketId: string) => throws(() => startTicketMission(s.ctx, { campaignId: id, ticketId, base: s.commit }))?.message ?? '';
  check('refused for a ticket outside ticketIds', /outside authorization/.test(refusedFor('A2')), refusedFor('A2'));
  check('nothing was left behind for it (one transaction)', !s.ctx.store.missions().some((x) => x.workItemId === s.ctx.store.campaignTicket(id, 'A2')!.workItemId));
  check('refused for a second mission on one ticket', /already built|consumed once/.test(refusedFor('C1')), refusedFor('C1'));
  const m2 = s.ctx.store.createMission({
    projectId: m.projectId, kind: 'implement', parentId: id, objective: 'a1', baseRevision: s.commit, workItemId: s.ctx.store.campaignTicket(id, 'A1')!.workItemId,
  });
  check('envelopeRefusal accepts A1 in force', envelopeRefusal(s.ctx.store, s.auth.id, {
    missionId: m2.id, operation: 'authorize-mission', ticketId: 'A1', permissions: { read: true, write: true, execute: false, deploy: false }, maxUsd: 2, at: t,
  }) === null);
  const outside = s.ctx.store.createMission({
    projectId: m.projectId, kind: 'implement', parentId: id, objective: 'a2', baseRevision: s.commit, workItemId: s.ctx.store.campaignTicket(id, 'A2')!.workItemId,
  });
  check('envelopeRefusal refuses a ticket outside ticketIds', /outside authorization/.test(envelopeRefusal(s.ctx.store, s.auth.id, {
    missionId: outside.id, operation: 'authorize-mission', ticketId: 'A2', permissions: { read: true, write: true, execute: false, deploy: false }, maxUsd: 1, at: t,
  }) ?? ''));
  check('envelopeRefusal refuses a ticket id the mission does not build', /builds ticket A2, not C1/.test(envelopeRefusal(s.ctx.store, s.auth.id, {
    missionId: outside.id, operation: 'authorize-mission', ticketId: 'C1', permissions: { read: true, write: true, execute: false, deploy: false }, maxUsd: 1, at: t,
  }) ?? ''));
  check('envelopeRefusal refuses execute the envelope lacks', /execute/.test(envelopeRefusal(s.ctx.store, s.auth.id, {
    missionId: m2.id, operation: 'authorize-mission', ticketId: 'A1', permissions: { read: true, write: true, execute: true, deploy: false }, maxUsd: 2, at: t,
  }) ?? ''));
  check('envelopeRefusal refuses a budget above the per-mission cap', /per mission/.test(envelopeRefusal(s.ctx.store, s.auth.id, {
    missionId: m2.id, operation: 'authorize-mission', ticketId: 'A1', permissions: { read: true, write: true, execute: false, deploy: false }, maxUsd: 2.5, at: t,
  }) ?? ''));

  t += 73 * 3_600_000;
  check('refused after notAfter', /not in force/.test(throws(() => s.ctx.store.deriveAuthorizeMission(m2.id, s.auth.id))?.message ?? ''));
  check('an attempt under the grant is refused after notAfter (fail closed)', /not in force/.test(throws(() => s.ctx.store.startAttempt({
    taskId: task.id, runnerId: 'agent:mock:x', sandbox: author(m.id, grant.id).sandbox,
  }))?.message ?? ''));
  check('authorizeGrantRefusal says so', /not in force/.test(authorizeGrantRefusal(s.ctx, m) ?? ''));
  t -= 73 * 3_600_000;

  haltCampaign(s.ctx, id, campaignActorOf(id), 'spend-unknown');
  check('a derived halt is recorded as the campaign actor', s.ctx.store.campaignHalts(id)[0]?.actor === campaignActorOf(id));
  check('refused after a halt', /halted/.test(throws(() => s.ctx.store.deriveAuthorizeMission(m2.id, s.auth.id))?.message ?? ''));
  check('campaign-halted is a need', needsOf(s.ctx, s.ctx.store.mission(id)!).some((n) => n.kind === 'campaign-halted'));
  const halt = s.ctx.store.campaignHalts(id)[0];
  const rc = confirmDigest(s.ctx, 'resume-campaign', id, { haltDecisionId: halt.id });
  check('resume is guarded', /CLAUDECODE/.test(throws(() => resumeCampaign(s.ctx, {
    campaignId: id, haltDecisionId: halt.id, actor: HUMAN, rationale: 'x', env: { CLAUDECODE: '1' }, confirm: code(rc.digest),
  }))?.message ?? ''));
  resumeCampaign(s.ctx, { campaignId: id, haltDecisionId: halt.id, actor: HUMAN, rationale: 'known cost', env: CLEAN_ENV, confirm: code(rc.digest) });
  check('after a resume the envelope admits again', s.ctx.store.campaignHalts(id).length === 0
    && s.ctx.store.deriveAuthorizeMission(m2.id, s.auth.id).mission.state === 'ready');

  const moved = haltCampaign(s.ctx, id, campaignActorOf(id), 'integration-moved');
  const cc = s.ctx.store.mission(id)!;
  s.ctx.store.recordDecision({
    missionId: id, projectId: cc.projectId, revision: cc.baseRevision, actor: HUMAN, kind: 'approve', rationale: 'adopted', artifactIds: [],
    scope: { operation: 'adopt-integration-tip', ref: 'refs/heads/daylight/campaign/x', from: 'a', to: 'b', haltDecisionId: moved.id },
  });
  check('a person\'s adopt-integration-tip resumes the halt it names', s.ctx.store.campaignHalts(id).length === 0);

  const p = samplePlan();
  p.title = 'retitled';
  revisePlan(s.root, p);
  importPlan(s.ctx, s.root, 'daylight.plan.json', { campaignId: id });
  const afterImport = s.ctx.store.envelopeRefusal(s.auth.id, { missionId: id, operation: 'admit-work-item', ticketId: '', at: t });
  check('refused after a plan re-import', /plan moved/.test(afterImport ?? ''), String(afterImport));
  check('and campaign-authorize / plan-approval are needs', ['plan-approval'].every((k) => needsOf(s.ctx, s.ctx.store.mission(id)!).some((n) => n.kind === k)));
  s.ctx.close();
}

section('a newer authorization supersedes the older one (review M6)');
{
  const s = authorized('superseded');
  const id = s.imp.campaign.id;
  const newer = authorize(s.ctx, id, { tickets: ['C1'] });
  const a1 = s.ctx.store.campaignTicket(id, 'A1')!;
  const c = s.ctx.store.mission(id)!;
  const input = { projectId: c.projectId, kind: 'implement' as const, parentId: id, objective: 'a1', baseRevision: s.commit, workItemId: a1.workItemId };
  const err = throws(() => s.ctx.store.createTicketMission(input, s.auth.id));
  check('a grant derived from the superseded authorization is refused', /not campaign .* current authorization/.test(err?.message ?? ''), err?.message);
  check('and leaves no mission behind', !s.ctx.store.missions().some((m) => m.workItemId === a1.workItemId));
  check('the newer one, which narrowed the tickets, refuses A1 too', /outside authorization/.test(throws(() => s.ctx.store.createTicketMission(input, newer.id))?.message ?? ''));
  check('the newer one admits C1', s.ctx.store.createTicketMission({ ...input, objective: 'c1', workItemId: s.ctx.store.campaignTicket(id, 'C1')!.workItemId }, newer.id).mission.state === 'ready');
  s.ctx.close();
}

section('a forged derived grant is caught and refused');
{
  const s = authorized('forged');
  const id = s.imp.campaign.id;
  const m = startTicketMission(s.ctx, { campaignId: id, ticketId: 'C1', base: s.commit });
  const task = s.ctx.store.createTask({ missionId: m.id, role: 'author', objective: 'a' });
  const db = new DatabaseSync(path.join(s.out, DAYLIGHT_DB));
  const forged = newId('decision');
  const lockId = s.ctx.store.latestDecision(id, 'lock-campaign-gates')!.id;
  db.prepare(`INSERT INTO decisions (id, mission_id, project_id, revision, actor, kind, rationale, scope, artifact_ids, at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    forged, m.id, m.projectId, m.baseRevision, campaignActorOf(id), 'approve', 'forged',
    JSON.stringify({ operation: 'authorize-mission', permissions: { read: true, write: true, execute: true, deploy: false }, maxUsd: 1, derivedFrom: lockId, ticketId: 'C1' }),
    '[]', Date.now(),
  );
  const att = newId('attempt');
  db.prepare(`INSERT INTO attempts (id, mission_id, task_id, project_id, runner_id, state, started_at, artifacts, origin, sandbox_profile, sandbox_network,
    sandbox_write, sandbox_exec, authorize_decision_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    att, m.id, task.id, m.projectId, 'agent:mock:x', 'completed', Date.now(), '[]', 'daylight', 'author', 'none', 1, 0, forged,
  );
  db.close();
  check('unauthorizedWriteAttempts names the attempt', s.ctx.store.unauthorizedWriteAttempts().some((a) => a.id === att));
  check('derivationRefusals names the decision', s.ctx.store.derivationRefusals().some((r) => r.includes(forged)), s.ctx.store.derivationRefusals().join('; '));
  check('startAttempt refuses it', /not a human authorize-mission/.test(throws(() => s.ctx.store.startAttempt({
    taskId: s.ctx.store.createTask({ missionId: m.id, role: 'author', objective: 'b' }).id, runnerId: 'agent:mock:x', sandbox: author(m.id, forged).sandbox,
  }))?.message ?? ''));
  check('campaignViolations reports it', campaignViolations(s.ctx, m.projectId).some((r) => r.includes(forged)));

  // Review P12a: a well-formed grant from the real authorization, naming an envelope ticket (C1),
  // on a mission that holds write and builds A2, outside the envelope.
  const a2 = s.ctx.store.createMission({
    projectId: m.projectId, kind: 'implement', parentId: id, objective: 'a2', baseRevision: s.commit, workItemId: s.ctx.store.campaignTicket(id, 'A2')!.workItemId,
  });
  const t2 = s.ctx.store.createTask({ missionId: a2.id, role: 'author', objective: 'a' });
  const db2 = new DatabaseSync(path.join(s.out, DAYLIGHT_DB));
  const mismatched = newId('decision');
  db2.prepare(`INSERT INTO decisions (id, mission_id, project_id, revision, actor, kind, rationale, scope, artifact_ids, at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    mismatched, a2.id, a2.projectId, a2.baseRevision, campaignActorOf(id), 'approve', 'forged',
    JSON.stringify({ operation: 'authorize-mission', permissions: { read: true, write: true, execute: false, deploy: false }, maxUsd: 1, derivedFrom: s.auth.id, ticketId: 'C1' }),
    '[]', Date.now(),
  );
  db2.prepare(`UPDATE missions SET permissions=? WHERE id=?`).run(JSON.stringify({ read: true, write: true, execute: false, deploy: false }), a2.id);
  const att2 = newId('attempt');
  db2.prepare(`INSERT INTO attempts (id, mission_id, task_id, project_id, runner_id, state, started_at, artifacts, origin, sandbox_profile, sandbox_network,
    sandbox_write, sandbox_exec, authorize_decision_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    att2, a2.id, t2.id, a2.projectId, 'agent:mock:x', 'completed', Date.now(), '[]', 'daylight', 'author', 'none', 1, 0, mismatched,
  );
  db2.close();
  check('unauthorizedWriteAttempts names an attempt under a grant for another ticket', s.ctx.store.unauthorizedWriteAttempts().some((a) => a.id === att2));
  check('derivationRefusals names that grant', s.ctx.store.derivationRefusals().some((r) => r.includes(mismatched) && /builds ticket A2/.test(r)),
    s.ctx.store.derivationRefusals().join('; '));
  check('campaignViolations reports it', campaignViolations(s.ctx, m.projectId).some((r) => r.includes(mismatched)));
  check('startAttempt refuses it', /builds ticket A2, not C1/.test(throws(() => s.ctx.store.startAttempt({
    taskId: s.ctx.store.createTask({ missionId: a2.id, role: 'author', objective: 'c' }).id, runnerId: 'agent:mock:x', sandbox: author(a2.id, mismatched).sandbox,
  }))?.message ?? ''));
  s.ctx.close();
}

section('integrate-candidate needs auto-apply and a real candidate (review M2)');
{
  /** A ticket mission with one captured candidate, as R6's capture would leave it. */
  const withCandidate = (name: string, autoApply: 'integration-ref' | 'none') => {
    const s = authorized(name, { autoApply });
    const id = s.imp.campaign.id;
    const m = startTicketMission(s.ctx, { campaignId: id, ticketId: 'C1', base: s.commit });
    const task = s.ctx.store.createTask({ missionId: m.id, role: 'author', objective: 'a' });
    const a = s.ctx.store.startAttempt({ taskId: task.id, runnerId: 'agent:mock:x', sandbox: author(m.id, s.ctx.store.authorizeDecision(m.id)!.id).sandbox });
    s.ctx.store.finishAttempt(a.id, { state: 'completed', costUsd: null });
    const put = (text: string, kind: 'diff' | 'summary') => s.ctx.artifacts.put(text, { kind, projectId: m.projectId });
    const c = s.ctx.store.createCandidate({
      missionId: m.id, attemptId: a.id, projectId: m.projectId, baseCommit: s.commit, diffArtifact: put('diff --git a b', 'diff'),
      summaryArtifact: put('{}', 'summary'), files: [], policyViolations: [], secretHits: 0, gateSetDigest: 'x',
      profile: { name: 'author', network: 'none', write: true, exec: false }, attemptState: 'completed',
    });
    const input = (scope: Record<string, unknown>) => ({
      missionId: m.id, projectId: m.projectId, revision: m.baseRevision, actor: campaignActorOf(id), kind: 'approve' as const, rationale: 'land', artifactIds: [],
      scope: { operation: 'integrate-candidate', derivedFrom: s.auth.id, candidateId: c.id, diffDigest: c.diffArtifact.digest, gateSetDigest: 'x',
        baseCommit: s.commit, integrationId: 'i_1', onto: s.commit, integratedCommit: s.commit, integratedDiffDigest: c.diffArtifact.digest, ...scope },
    });
    return { s, id, m, c, input };
  };
  const none = withCandidate('integrate-none', 'none');
  check('envelopeRefusal refuses integrate-candidate under auto-apply none', /does not auto-apply/.test(envelopeRefusal(none.s.ctx.store, none.s.auth.id, {
    missionId: none.m.id, operation: 'integrate-candidate', ticketId: 'C1', at: Date.now(),
  }) ?? ''));
  check('recordDerivedDecision refuses it', /does not auto-apply/.test(throws(() => none.s.ctx.store.recordDerivedDecision(none.s.auth.id, none.input({})))?.message ?? ''));
  const db = new DatabaseSync(path.join(none.s.out, DAYLIGHT_DB));
  const raw = newId('decision');
  const ri = none.input({});
  db.prepare('INSERT INTO decisions (id, mission_id, project_id, revision, actor, kind, rationale, scope, artifact_ids, at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    raw, ri.missionId, ri.projectId, ri.revision, ri.actor, 'approve', 'raw', JSON.stringify(ri.scope), '[]', Date.now(),
  );
  db.close();
  check('derivationRefusals reports a raw one', none.s.ctx.store.derivationRefusals().some((r) => r.includes(raw) && /auto-apply/.test(r)), none.s.ctx.store.derivationRefusals().join('; '));
  none.s.ctx.close();

  const ref = withCandidate('integrate-ref', 'integration-ref');
  check('a candidate id that names no candidate is refused', /not a candidate/.test(throws(() => ref.s.ctx.store.recordDerivedDecision(ref.s.auth.id, ref.input({ candidateId: newId('candidate') })))?.message ?? ''));
  check('a diff digest that is not the candidate\'s is refused', /another diff/.test(throws(() => ref.s.ctx.store.recordDerivedDecision(ref.s.auth.id, ref.input({ diffDigest: 'sha256:00' })))?.message ?? ''));
  const ok = ref.s.ctx.store.recordDerivedDecision(ref.s.auth.id, ref.input({}));
  check('a real candidate under integration-ref is recorded', ok.scope.operation === 'integrate-candidate' && ref.s.ctx.store.derivationRefusals().length === 0,
    ref.s.ctx.store.derivationRefusals().join('; '));
  ref.s.ctx.close();
}

section('campaign missions never travel by file (P2-R14)');
{
  const s = authorized('export');
  const id = s.imp.campaign.id;
  const m = startTicketMission(s.ctx, { campaignId: id, ticketId: 'C1', base: s.commit });
  check('a campaign is not exported', /not exported/.test(throws(() => exportMission(s.ctx, id))?.message ?? ''));
  check('a campaign child is not exported', /not exported/.test(throws(() => exportMission(s.ctx, m.id))?.message ?? ''));
  const plain = s.ctx.store.createMission({ projectId: m.projectId, kind: 'explore', objective: 'look', baseRevision: s.commit });
  const file = exportMission(s.ctx, plain.id);
  const other = makeRepo('export-target');
  const ctx2 = openDaylight(other.out);
  const asChild = { ...file, mission: { ...file.mission, parentId: id } };
  check('a file whose mission names a parent is not imported', /not imported/.test(throws(() => importMission(ctx2, asChild, { force: true }))?.message ?? ''));
  const withActor = { ...file, decisions: [{ ...s.auth, id: newId('decision'), missionId: plain.id, actor: campaignActorOf(id) }] };
  check('a file carrying a campaign actor\'s decision is not imported', /not imported/.test(throws(() => importMission(ctx2, withActor, { force: true }))?.message ?? ''));
  check('a plain mission still round-trips', importMission(ctx2, file, { force: true }).added.tasks >= 0);
  ctx2.close();
  s.ctx.close();
}

section('campaign rows at mission creation');
{
  const s = authorized('create');
  const id = s.imp.campaign.id;
  const c = s.ctx.store.mission(id)!;
  const spec = s.ctx.store.createMission({ projectId: c.projectId, kind: 'explore', objective: 'x', baseRevision: s.commit });
  check('a parent must be a campaign', /not a campaign/.test(throws(() => s.ctx.store.createMission({
    projectId: c.projectId, kind: 'audit', objective: 'x', baseRevision: s.commit, parentId: spec.id,
  }))?.message ?? ''));
  check('a campaign child is implement or audit', /implement or audit/.test(throws(() => s.ctx.store.createMission({
    projectId: c.projectId, kind: 'explore', objective: 'x', baseRevision: s.commit, parentId: id,
  }))?.message ?? ''));
  check('a campaign never executes', /never executes/.test(throws(() => s.ctx.store.createMission({
    projectId: c.projectId, kind: 'campaign', objective: 'x', baseRevision: s.commit, permissions: { execute: true },
  }))?.message ?? ''));
  check('authorizeMission refuses execute on a campaign', /never executes/.test(throws(() => s.ctx.store.authorizeMission({
    missionId: id, actor: HUMAN, rationale: 'x', permissions: { write: false, execute: true }, maxUsd: null,
  }))?.message ?? ''));
  check('authorizeMission refuses write on a campaign', /write is granted only/.test(throws(() => s.ctx.store.authorizeMission({
    missionId: id, actor: HUMAN, rationale: 'x', permissions: { write: true, execute: false }, maxUsd: null,
  }))?.message ?? ''));
  const ad = s.ctx.store.createMission({ projectId: c.projectId, kind: 'audit', objective: 'review wave 1', baseRevision: s.commit, parentId: id });
  check('an audit child is allowed', ad.parentId === id);
  const needs = needsOf(s.ctx, startTicketMission(s.ctx, { campaignId: id, ticketId: 'C1', base: s.commit }));
  check('with auto-apply integration-ref, a ticket mission raises no authorize/candidate/apply need',
    !needs.some((n) => ['mission-awaiting-authorize', 'candidate-decision', 'apply'].includes(n.kind)));
  s.ctx.close();
}

section('campaign retry releases a preflight-refused ticket (P2-R25, P2-R27)');
{
  const s = authorized('retry');
  const id = s.imp.campaign.id;
  const m = startTicketMission(s.ctx, { campaignId: id, ticketId: 'C1', base: s.commit });
  check('retry is refused while the mission holds it unrefused', /not refused at preflight/.test(throws(() => retryTicket(s.ctx, {
    campaignId: id, ticketId: 'C1', actor: HUMAN, rationale: 'x', env: CLEAN_ENV, confirm: '00000000',
  }))?.message ?? ''));
  s.ctx.events.append({ projectId: m.projectId, missionId: m.id, actorId: 'daylight', category: 'process', name: 'forge.author.refused', payload: { why: ['no sandbox'] } });
  s.ctx.store.closeMission(m.id, 'inconclusive', 'refused at preflight: no sandbox');
  const scopeCode = () => code(confirmDigest(s.ctx, 'retry-ticket', id, { retry: { operation: 'retry-ticket', ticketId: 'C1',
    workItemId: m.workItemId!, contentDigest: s.ctx.store.workItem(m.workItemId!)!.contentDigest, closedMissionId: m.id, reason: 'refused at preflight: no sandbox' } }).digest);
  check('retry is guarded', /DAYLIGHT_SESSION/.test(throws(() => retryTicket(s.ctx, {
    campaignId: id, ticketId: 'C1', actor: HUMAN, rationale: 'x', env: { DAYLIGHT_SESSION: 's' }, confirm: scopeCode(),
  }))?.message ?? ''));
  check('before retry, a new mission on the ticket is refused', /already built|consumed/.test(throws(() => startTicketMission(s.ctx, { campaignId: id, ticketId: 'C1', base: s.commit }))?.message ?? ''));
  const d = retryTicket(s.ctx, { campaignId: id, ticketId: 'C1', actor: HUMAN, rationale: 'sandbox fixed', env: CLEAN_ENV, confirm: scopeCode() });
  check('the retry decision names the released mission', d.scope.closedMissionId === m.id && d.missionId === id);
  check('the work item is released', s.ctx.store.workItemConsumer(m.workItemId!) === null);
  const m2 = startTicketMission(s.ctx, { campaignId: id, ticketId: 'C1', base: s.commit });
  check('a new mission builds the released work item', m2.workItemId === m.workItemId && m2.state === 'ready');
  check('the spec-intake invariant exempts the released mission', specIntakeViolations(s.ctx, m.projectId).length === 0, specIntakeViolations(s.ctx, m.projectId).join('; '));
  check('derivationRefusals stays empty', s.ctx.store.derivationRefusals().length === 0, s.ctx.store.derivationRefusals().join('; '));
  // A mission that ran an attempt, or did not close inconclusive, is not released.
  const task = s.ctx.store.createTask({ missionId: m2.id, role: 'author', objective: 'a' });
  const a = s.ctx.store.startAttempt({ taskId: task.id, runnerId: 'agent:mock:x', sandbox: author(m2.id, s.ctx.store.authorizeDecision(m2.id)!.id).sandbox });
  s.ctx.store.finishAttempt(a.id, { state: 'failed', costUsd: null });
  s.ctx.events.append({ projectId: m2.projectId, missionId: m2.id, actorId: 'daylight', category: 'process', name: 'forge.author.refused', payload: { why: ['x'] } });
  s.ctx.store.transitionMission(m2.id, 'running');
  check('the store refuses to release a mission that is not closed', /only a mission closed/.test(throws(() => s.ctx.store.retryTicket(id, {
    actor: HUMAN, rationale: 'x', scope: { operation: 'retry-ticket', ticketId: 'C1', workItemId: m2.workItemId!, contentDigest: s.ctx.store.workItem(m2.workItemId!)!.contentDigest, closedMissionId: m2.id, reason: 'x' },
  }))?.message ?? ''));
  s.ctx.store.closeMission(m2.id, 'inconclusive', 'x');
  check('the store refuses to release a mission that ran an attempt', /ran an attempt/.test(throws(() => s.ctx.store.retryTicket(id, {
    actor: HUMAN, rationale: 'x', scope: { operation: 'retry-ticket', ticketId: 'C1', workItemId: m2.workItemId!, contentDigest: s.ctx.store.workItem(m2.workItemId!)!.contentDigest, closedMissionId: m2.id, reason: 'x' },
  }))?.message ?? ''));
  s.ctx.close();
}

section('the campaign needs before and after');
{
  const s = imported('needs');
  const id = s.imp.campaign.id;
  const kinds = () => needsOf(s.ctx, s.ctx.store.mission(id)!).map((n) => n.kind);
  check('an imported plan needs approval', kinds().includes('plan-approval'));
  approve(s.ctx, id);
  check('an approved plan with no authorization needs one', kinds().includes('campaign-authorize') && !kinds().includes('plan-approval'));
  lock(s.ctx, id);
  authorize(s.ctx, id);
  check('an authorized campaign does not', !kinds().includes('campaign-authorize'), kinds().join());
  s.ctx.close();
}

done();
