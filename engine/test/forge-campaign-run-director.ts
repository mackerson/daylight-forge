/**
 * The director, end to end, under bwrap with mock authors (§4, §8.3). Run:
 * node engine/test/forge-campaign-run-director.ts
 *
 * A three-ticket plan where C depends on A and B and B on A runs to three landings on the
 * integration ref, judged by a node regression gate, ticket gates and a holdout on the
 * integrated tree: landing order follows the dependencies; B's first attempt fails its gate and
 * lands on attempt 2 with the gate's output fenced in its prompt and no holdout text; a dry run
 * writes nothing; HEAD, the index and the worktree are untouched. Then: a crash after the
 * compare-and-swap resumes to the same landings; unknown cost halts; a reservation holds a
 * launch until the cap allows it; a preflight refusal closes a ready ticket once; exhaustion
 * blocks a ticket and its dependents wait while another lane lands; a dependency request parks
 * a ticket; and one cargo-gate landing on a crate with no dependencies.
 *
 * Mocks only. bwrap is required: without it this file fails, it does not skip (R15.3).
 *
 * WS-R5 is stood in for by `testHost` (forge-campaign-run-fixture.ts): ticket missions are
 * authorized by a person (the surgical path), derived decisions are written as R5's writer
 * will write them. Once R5's bodies land, r5Host replaces it and this file is unchanged.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { detectSandbox } from '../experiment/sandbox.ts';
import { applicationRefusals } from '../forge/apply.ts';
import { createSnapshot } from '../forge/cargo.ts';
import { baselineCampaign, lockCampaign, lockableIds, registerCampaignGate, registerPlanGates } from '../forge/campaign-gates.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { requestOutboxFile } from '../forge/dependency-requests.ts';
import { campaignRunNeeds, campaignSpend, campaignSpendRefusal, runCampaign, ticketStates, type DirectorOptions } from '../forge/director.ts';
import type { GateContext } from '../forge/gate.ts';
import { adoptIntegrationTip, adoptScopeOf, InjectedCrash, integrationRefFor, integrationRefusals, integrationTip } from '../forge/integrate.ts';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { needsOf } from '../mission/needs.ts';
import type { CampaignTicket, Mission, PlanFileV1 } from '../mission/types.ts';
import { harness } from './harness.ts';
import {
  ACTOR, authorizeCampaign, commitOn, git, makeCampaign, makeCandidate, makeWorkItem, repoState, tempDir, testHost, ticketRow,
} from './forge-campaign-run-fixture.ts';

const { check, section, done } = harness();
const CLI = path.resolve(import.meta.dirname, '..', 'cli.ts');
const root = tempDir('daylight-campaign-director-');
const privateTmp = path.join(root, 'tmp');
fs.mkdirSync(privateTmp, { mode: 0o700 });
process.env.TMPDIR = privateTmp;

section('preflight: the sandbox the director depends on');
const live = detectSandbox();
check('bwrap and prlimit are installed (without them this file fails, never skips)', live.available, live.why);
if (!live.available) done();

const humanEnv: NodeJS.ProcessEnv = { ...process.env };
delete humanEnv.CLAUDECODE;
delete humanEnv.DAYLIGHT_SESSION;
const SENTINEL = 'HOLDOUT_SENTINEL_r6z9';
const PASS = { exitCode: 0, stdoutIncludes: ['# fail 0'] };
const nodeTest = (body: string) => `const test = require('node:test');\nconst assert = require('node:assert');\nconst path = require('node:path');\n${body}\n`;
const load = (f: string) => `require(path.resolve('${f}'))`;

/** A mock author: what it writes depends on the ticket in its prompt and whether the prompt is a repair. */
function mockAuthor(file: string, plan: Record<string, { first: Record<string, string>; repair?: Record<string, string>; cost?: number | null }>): string {
  fs.writeFileSync(file, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const prompt = process.argv[3] || '';
const title = (/^Title: (.*)$/m.exec(prompt) || [])[1] || '';
const plan = ${JSON.stringify(plan)};
const b = plan[title.replace(/^Ticket /, '')];
console.log('PROMPT ' + Buffer.from(prompt, 'utf8').toString('base64'));
if (b) {
  const repair = prompt.includes('<<<REPAIR-');
  for (const [rel, text] of Object.entries(repair && b.repair ? b.repair : b.first)) {
    fs.mkdirSync(path.dirname(path.join('/work', rel)), { recursive: true });
    fs.writeFileSync(path.join('/work', rel), text);
  }
  if (b.cost !== null) console.log(JSON.stringify({ type: 'result', total_cost_usd: b.cost === undefined ? 0.05 : b.cost }));
}
`);
  return file;
}

/** The prompt an attempt was given, from the author's own stdout log. */
function promptOf(ctx: DaylightContext, attemptId: string): string {
  const log = ctx.store.attempt(attemptId)!.artifacts.find((r) => r.kind === 'log' && r.label?.startsWith('stdout'));
  const m = log ? /PROMPT (\S+)/.exec(ctx.artifacts.text(log)) : null;
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
}

/** Every table's row count, events included: what a dry run must leave exactly as it was. */
const rowCounts = (ctx: DaylightContext) => {
  const db = (ctx.store as unknown as { db: DatabaseSync }).db;
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
};
const refsOf = (repo: string) => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);

interface World {
  dir: string; repo: string; base: string; out: string; ctx: DaylightContext; gctx: GateContext; campaign: Mission;
  tickets: CampaignTicket[]; plan: PlanFileV1;
}

/** A node repository with modules a, b, c, a regression gate that each loads, and a plan; mapped. */
function nodeWorld(name: string, tickets: Array<{ id: string; lane: string; dependsOn?: string[]; scope: string[]; gate?: string; budget?: CampaignTicket['budget'] }>,
  extraFiles: Record<string, string> = {}): World {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const repo = path.join(dir, 'repo');
  const files: Record<string, string> = {
    'src/a.js': "module.exports = () => 'a0';\n", 'src/b.js': "module.exports = () => 'b0';\n", 'src/c.js': "module.exports = () => 'c0';\n",
    'src/d.js': "module.exports = () => 'd0';\n",
    'checks/regression.test.js': nodeTest(`test('every module loads as a function', () => { for (const f of ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']) assert.strictEqual(typeof ${'require(path.resolve(f))'}, 'function'); });`),
    'package.json': '{ "name": "campaign-fixture", "private": true }\n',
    ...extraFiles,
  };
  const plan: PlanFileV1 = {
    kind: 'daylight-plan', version: 1, title: name,
    campaignGates: [{ id: 'loads', role: 'regression', path: 'checks/regression.test.js', expect: PASS }],
    lanes: [...new Set(tickets.map((t) => t.lane))].map((l) => ({ id: l, title: l, owns: ['src/'], shared: ['src/'] })),
    tickets: tickets.map((t) => ({
      id: t.id, lane: t.lane, title: `Ticket ${t.id}`, statement: `do ${t.id}`, scope: t.scope, dependsOn: t.dependsOn ?? [],
      ...(t.gate ? { acceptance: { kind: 'gate' as const, tests: [{ path: `checks/${t.id.toLowerCase()}.test.js`, expect: PASS }] } } : {}),
      ...(t.budget ? { budget: t.budget } : {}),
    })),
  };
  for (const t of tickets) if (t.gate) files[`checks/${t.id.toLowerCase()}.test.js`] = nodeTest(t.gate);
  files['daylight.plan.json'] = `${JSON.stringify(plan, null, 2)}\n`;
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@daylight.invalid', 'commit', '-q', '-m', 'fixture']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  const out = path.join(dir, 'out');
  const mapped = spawnSync(process.execPath, [CLI, 'map', repo, '--out', out, '--top', '0'], { encoding: 'utf8', env: humanEnv });
  if (mapped.status !== 0) throw new Error(`map failed: ${mapped.stderr.slice(-400)}`);
  const ctx = openDaylight(out);
  const { campaign } = makeCampaign(ctx, repo, base, {}, ['daylight.plan.json']);
  const rows = tickets.map((t) => ticketRow(campaign, makeWorkItem(ctx, campaign, t.id), {
    id: t.id, lane: t.lane, dependsOn: t.dependsOn, scope: t.scope, budget: t.budget,
    ...(t.gate ? { acceptance: { kind: 'gate', tests: [{ path: `checks/${t.id.toLowerCase()}.test.js`, expect: PASS }] } } : {}),
  }));
  const gctx: GateContext = { store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: repo, out, sandbox: live, env: humanEnv };
  return { dir, repo, base, out, ctx, gctx, campaign, tickets: rows, plan };
}

/** Register and baseline the plan's gates (plus `extra`), lock them, then authorize the campaign against that lock. */
async function lockAndAuthorize(w: World, env: Parameters<typeof authorizeCampaign>[2], extra?: (w: World) => void): Promise<void> {
  registerPlanGates(w.gctx, w.campaign.id, w.plan);
  extra?.(w);
  await baselineCampaign(w.gctx, w.campaign.id);
  const ids = lockableIds(w.gctx, w.campaign.id);
  const preview = confirmDigest(w.gctx, 'lock-campaign-gates', w.campaign.id, { experimentIds: ids, ratchet: false });
  const lock = lockCampaign(w.gctx, { campaignId: w.campaign.id, actor: ACTOR, rationale: 'fixture', ratchet: false, confirm: preview.digest8, env: humanEnv });
  authorizeCampaign(w.ctx, w.campaign, { ticketIds: w.tickets.map((t) => t.ticketId), gateSetDigest: String(lock.scope.gateSetDigest), ...env });
}

const run = (w: World, script: string, over: Partial<DirectorOptions> = {}) => runCampaign(w.ctx, {
  campaignId: w.campaign.id, repo: w.repo, sandbox: live, env: { ...humanEnv, DAYLIGHT_MOCK_ADAPTER: script },
  host: testHost(w.ctx, w.campaign, w.plan, w.tickets), ...over,
});

const namesOf = (w: World): string[] => {
  const all = w.ctx.store.missions(w.campaign.projectId).filter((m) => m.id === w.campaign.id || m.parentId === w.campaign.id).map((m) => m.id);
  return all.flatMap((id) => w.ctx.events.forMission(id)).sort((a, b) => a.sequence - b.sequence).map((e) => e.name);
};

// ---- the main campaign ------------------------------------------------------------------------

section('a three-ticket plan, C on A and B, B on A, runs to three landings');
{
  const w = nodeWorld('main', [
    { id: 'A', lane: 'LA', scope: ['src/a.js'], gate: `test('a is A', () => assert.strictEqual(${load('src/a.js')}(), 'A'));` },
    { id: 'B', lane: 'LB', scope: ['src/b.js'], dependsOn: ['A'], gate: `test('b is B:A', () => assert.strictEqual(${load('src/b.js')}(), 'B:A'));` },
    { id: 'C', lane: 'LC', scope: ['src/c.js'], dependsOn: ['A', 'B'], gate: `test('c is B:A+C', () => assert.strictEqual(${load('src/c.js')}(), 'B:A+C'));` },
  ]);
  await lockAndAuthorize(w, { concurrency: 2, waveSize: 2, maxUsdTotal: 5, maxUsdPerMission: 1, maxAttemptsPerTicket: 3, reviewRoster: [] }, (x) => {
    registerCampaignGate(x.gctx, {
      campaignId: x.campaign.id, role: 'holdout', ticketId: 'B', basename: 'hidden.test.js', prediction: PASS,
      testSource: nodeTest(`test('${SENTINEL} b says B', () => assert.ok(${load('src/b.js')}().startsWith('B')));`),
    });
  });
  const author = mockAuthor(path.join(w.dir, 'author.cjs'), {
    A: { first: { 'src/a.js': "module.exports = () => 'A';\n" } },
    B: { first: { 'src/b.js': "module.exports = () => 'wrong-' + 'value';\n" }, repair: { 'src/b.js': "module.exports = () => 'B:' + require('./a.js')();\n" } },
    C: { first: { 'src/c.js': "module.exports = () => require('./b.js')() + '+C';\n" } },
  });
  const state = repoState(w.repo);
  const host = testHost(w.ctx, w.campaign, w.plan, w.tickets);

  section('a dry run reads only: no row, no event, no ref');
  const rows = rowCounts(w.ctx);
  const evHead = w.ctx.events.head();
  const refs = refsOf(w.repo);
  const dry = await runCampaign(w.ctx, { campaignId: w.campaign.id, repo: w.repo, dryRun: true, host });
  check('it schedules A alone, with its reservation', dry.dryRun && dry.schedule.length === 1 && dry.schedule[0].ticketId === 'A' && dry.schedule[0].reserveUsd === 1, JSON.stringify(dry.schedule));
  check('and reports B and C waiting', dry.statuses.B === 'waiting' && dry.statuses.C === 'waiting', JSON.stringify(dry.statuses));
  check('zero new rows', rowCounts(w.ctx) === rows);
  check('zero new events', w.ctx.events.head() === evHead);
  check('zero ref changes (the integration ref is not even created)', refsOf(w.repo) === refs && integrationTip(w.repo, w.campaign.id) === null);

  section('the run');
  const r = await run(w, author, { concurrency: 2 });
  check('the run finished without a refusal or a halt', r.refused === null && r.halted === null, JSON.stringify({ refused: r.refused, halted: r.halted }));
  check('three landings, every ticket landed', r.landed.length === 3 && Object.values(r.statuses).every((s) => s === 'landed'), JSON.stringify(r));
  check('landing order follows the dependencies: A, B, C', r.landed.join(',') === 'A,B,C', r.landed.join(','));
  const tip = integrationTip(w.repo, w.campaign.id)!;
  check('the integration ref holds all three changes', git(w.repo, ['show', `${tip}:src/c.js`]).includes("+ '+C'") && git(w.repo, ['show', `${tip}:src/a.js`]).includes("'A'"));
  check('its first-parent history is the three landings on the base',
    git(w.repo, ['rev-list', '--first-parent', `${w.base}..${tip}`]).split('\n').length === 3);

  const missions = w.ctx.store.missions(w.campaign.projectId).filter((m) => m.parentId === w.campaign.id);
  const bMission = missions.find((m) => m.objective === 'ticket B')!;
  const bAttempts = w.ctx.store.tasks(bMission.id).flatMap((t) => w.ctx.store.attempts(t.id)).sort((a, b) => a.startedAt - b.startedAt);
  check('B took two attempts', bAttempts.length === 2, String(bAttempts.length));
  const second = promptOf(w.ctx, bAttempts[1].id);
  check('attempt 2 was briefed as a repair, fenced as data', /<<<REPAIR-[0-9a-f]{12}/.test(second) && second.indexOf('<<<REPAIR-') < second.indexOf('<<<WORK-'), second.slice(0, 200));
  const fence = second.slice(second.indexOf('<<<REPAIR-'), second.indexOf('<<<WORK-'));
  check('with the failing gate\'s own output in the fence (what it got)', fence.includes('wrong-value') && fence.includes('"failures"'), fence.slice(0, 1500));
  check('and the prior diff', fence.includes('src/b.js') && fence.includes('priorDiff'));
  check('and no holdout text, id or path anywhere in either prompt', bAttempts.every((a) => !promptOf(w.ctx, a.id).includes(SENTINEL) && !promptOf(w.ctx, a.id).includes('hidden.test.js')));
  check('the first prompt names the public gates and the regression gate', promptOf(w.ctx, bAttempts[0].id).includes('b is B:A') && promptOf(w.ctx, bAttempts[0].id).includes('every module loads'));
  check('every attempt ran under a reservation recorded on its row', missions.flatMap((m) => w.ctx.store.tasks(m.id).flatMap((t) => w.ctx.store.attempts(t.id)))
    .every((a) => a.maxCostUsd !== undefined && a.maxCostUsd > 0 && a.maxCostUsd <= 1));

  const names = namesOf(w);
  const order = ['campaign.started', 'campaign.ticket.dispatched', 'campaign.integration.started', 'campaign.gate.evaluated', 'campaign.candidate.integrated',
    'campaign.ticket.landed', 'campaign.repair.queued', 'campaign.wave.closed', 'campaign.finished'];
  check('the §4.8 events were emitted', order.every((n) => names.includes(n)), order.filter((n) => !names.includes(n)).join(','));
  check('started first, finished last', names.indexOf('campaign.started') < names.indexOf('campaign.ticket.dispatched') && names.lastIndexOf('campaign.finished') > names.lastIndexOf('campaign.ticket.landed'));
  check('one repair queued, three landed, two waves closed (2 landings, then 1 at quiescence)',
    names.filter((n) => n === 'campaign.repair.queued').length === 1 && names.filter((n) => n === 'campaign.ticket.landed').length === 3 && w.ctx.store.waves(w.campaign.id).length === 2);
  const evs = w.ctx.store.missions(w.campaign.projectId).flatMap((m) => w.ctx.events.forMission(m.id)).filter((e) => e.name.startsWith('campaign.'));
  check('no campaign event names the holdout', evs.every((e) => !JSON.stringify(e.payload).includes(SENTINEL) && !JSON.stringify(e.payload).includes('hidden.test.js')));
  check('reviewRoster [] runs no wave review', w.ctx.store.waves(w.campaign.id).every((x) => x.reviewMissionId === null));

  check('HEAD, the index, the worktree and every non-daylight ref are byte-equal', repoState(w.repo) === state);
  check('integrationRefusals is empty', integrationRefusals({ store: w.ctx.store, repoRoot: w.repo }, w.campaign.id).length === 0,
    integrationRefusals({ store: w.ctx.store, repoRoot: w.repo }, w.campaign.id).join('; '));
  check('applicationRefusals is empty', applicationRefusals({ store: w.ctx.store, repoRoot: w.repo }).length === 0, applicationRefusals({ store: w.ctx.store, repoRoot: w.repo }).join('; '));
  check('unauthorizedWriteAttempts is empty', w.ctx.store.unauthorizedWriteAttempts().length === 0);
  const spend = campaignSpend(w.ctx, w.campaign.id);
  check('campaign spend is within the cap, known, nothing reserved after', spend.spentUsd <= 5 && spend.unknownCount === 0 && spend.reservedUsd === 0 && spend.spentUsd > 0, JSON.stringify(spend));
  check('only refs under refs/heads/daylight/ were added', refsOf(w.repo).split('\n').filter((l) => !l.startsWith('refs/heads/daylight/')).join('\n') === refs);
  const again = await run(w, author, { concurrency: 2 });
  check('a second run finds nothing to do and lands nothing twice', again.landed.length === 0 && w.ctx.store.integrations(w.campaign.id, { state: 'integrated' }).length === 3);
  w.ctx.close();
}

// ---- resume after a crash -------------------------------------------------------------------------

section('resume: a director killed after the compare-and-swap of the second landing');
{
  const w = nodeWorld('resume', [
    { id: 'A', lane: 'LA', scope: ['src/a.js'], gate: `test('a is A', () => assert.strictEqual(${load('src/a.js')}(), 'A'));` },
    { id: 'B', lane: 'LB', scope: ['src/b.js'], gate: `test('b is B', () => assert.strictEqual(${load('src/b.js')}(), 'B'));` },
  ]);
  await lockAndAuthorize(w, { concurrency: 1, waveSize: 10, maxUsdTotal: 5, maxUsdPerMission: 1 });
  const author = mockAuthor(path.join(w.dir, 'author.cjs'), {
    A: { first: { 'src/a.js': "module.exports = () => 'A';\n" } }, B: { first: { 'src/b.js': "module.exports = () => 'B';\n" } },
  });
  let crashed = false;
  try {
    await run(w, author, { concurrency: 1, crashLanding: { n: 2, step: 'cas' } });
  } catch (err) {
    crashed = err instanceof InjectedCrash;
  }
  check('the director died there', crashed);
  const tipAtCrash = integrationTip(w.repo, w.campaign.id);
  check('the ref already names the second landing\'s commit; its rows do not', w.ctx.store.integrations(w.campaign.id, { state: 'integrated' }).length === 1
    && w.ctx.store.integrations(w.campaign.id, { state: 'evaluating' }).some((i) => i.integratedCommit === tipAtCrash));
  const r = await run(w, author, { concurrency: 1 });
  check('the next run resumes: both tickets landed', r.statuses.A === 'landed' && r.statuses.B === 'landed', JSON.stringify(r.statuses));
  const landed = w.ctx.store.integrations(w.campaign.id, { state: 'integrated' });
  check('two landings, two applications, no duplicate', landed.length === 2 && new Set(landed.map((i) => i.candidateId)).size === 2
    && w.ctx.store.missions(w.campaign.projectId).filter((m) => m.parentId === w.campaign.id).every((m) => w.ctx.store.applications(m.id).length === 1));
  check('the ref did not move again: the second landing is the commit the crash left', integrationTip(w.repo, w.campaign.id) === tipAtCrash);
  check('no attempt was run twice for it', w.ctx.store.missions(w.campaign.projectId).filter((m) => m.parentId === w.campaign.id)
    .every((m) => w.ctx.store.tasks(m.id).flatMap((t) => w.ctx.store.attempts(t.id)).length === 1));
  check('the invariants hold', integrationRefusals({ store: w.ctx.store, repoRoot: w.repo }, w.campaign.id).length === 0 && applicationRefusals({ store: w.ctx.store, repoRoot: w.repo }).length === 0);
  w.ctx.close();
}

section('a halt keeps accepted work: re-evaluated on the adopted tip, not re-authored (P2-R35, review B1)');
{
  const w = nodeWorld('moved', [{ id: 'A', lane: 'LA', scope: ['src/a.js'], gate: `test('a is A', () => assert.strictEqual(${load('src/a.js')}(), 'A'));` }]);
  await lockAndAuthorize(w, { concurrency: 1, maxUsdTotal: 5, maxUsdPerMission: 1, maxAttemptsPerTicket: 3 });
  const author = mockAuthor(path.join(w.dir, 'author.cjs'), { A: { first: { 'src/a.js': "module.exports = () => 'A';\n" } } });
  let crashed = false;
  try {
    await run(w, author, { concurrency: 1, crashLanding: { n: 1, step: 'mission-ref' } });
  } catch (err) {
    crashed = err instanceof InjectedCrash;
  }
  check('the director died after the per-mission ref of an accepted candidate', crashed);
  const foreign = commitOn(w.repo, w.base, { README: 'foreign\n' });
  git(w.repo, ['update-ref', integrationRefFor(w.campaign.id), foreign, w.base]);
  const r = await run(w, author, { concurrency: 1 });
  check('the next run halts integration-moved', r.halted === 'integration-moved', JSON.stringify({ halted: r.halted, refused: r.refused }));
  const ms = w.ctx.store.missions(w.campaign.projectId).filter((m) => m.parentId === w.campaign.id);
  const cands = ms.flatMap((m) => w.ctx.store.candidates(m.id));
  check('the candidate is still accepted-by-gates', cands.length === 1 && cands[0].verdict === 'accepted-by-gates', JSON.stringify(cands.map((c) => c.verdict)));
  check('no integration row was rejected; none was evaluated on the unexplained tip', w.ctx.store.integrations(w.campaign.id).every((i) => i.state === 'abandoned')
    && !w.ctx.store.integrations(w.campaign.id).some((i) => i.onto === foreign), JSON.stringify(w.ctx.store.integrations(w.campaign.id).map((i) => [i.state, i.onto === foreign])));
  check('the ticket reads integrating (pending), not ready', r.statuses.A === 'integrating', JSON.stringify(r.statuses));
  const halt = w.ctx.store.decisions(w.campaign.id).filter((d) => d.scope.operation === 'halt-campaign').at(-1)!;
  const ictx = { store: w.ctx.store, events: w.ctx.events, artifacts: w.ctx.artifacts, repoRoot: w.repo };
  const sc = adoptScopeOf(ictx, w.campaign.id, halt.id);
  adoptIntegrationTip(ictx, { campaignId: w.campaign.id, haltDecisionId: halt.id, actor: ACTOR, rationale: 'reviewed the foreign commit', env: humanEnv,
    confirm: confirmDigest(w.ctx, 'adopt-integration-tip', w.campaign.id, { adopt: { ref: sc.ref, from: sc.from, to: sc.to, haltDecisionId: halt.id } }).digest8 });
  const again = await run(w, author, { concurrency: 1 });
  check('after adopt-tip the accepted candidate lands on the adopted tip', again.statuses.A === 'landed' && again.halted === null, JSON.stringify(again.statuses));
  const landed = w.ctx.store.integrations(w.campaign.id, { state: 'integrated' });
  check('re-evaluated three-way onto the foreign commit', landed.length === 1 && landed[0].onto === foreign && landed[0].method === 'three-way' && landed[0].candidateId === cands[0].id);
  check('not re-authored: still one author attempt', ms.flatMap((m) => w.ctx.store.tasks(m.id).flatMap((t) => w.ctx.store.attempts(t.id))).length === 1);
  w.ctx.close();
}

// ---- spend --------------------------------------------------------------------------------------

section('spend: an attempt whose cost is unknown halts the campaign (P2-R11)');
{
  const w = nodeWorld('unknown', [
    { id: 'A', lane: 'LA', scope: ['src/a.js'], gate: `test('a is A', () => assert.strictEqual(${load('src/a.js')}(), 'A'));` },
    { id: 'B', lane: 'LB', scope: ['src/b.js'], gate: `test('b is B', () => assert.strictEqual(${load('src/b.js')}(), 'B'));` },
  ]);
  await lockAndAuthorize(w, { concurrency: 1, maxUsdTotal: 5, maxUsdPerMission: 1 });
  const author = mockAuthor(path.join(w.dir, 'author.cjs'), {
    A: { first: { 'src/a.js': "module.exports = () => 'A';\n" }, cost: null }, B: { first: { 'src/b.js': "module.exports = () => 'B';\n" } },
  });
  const r = await run(w, author, { concurrency: 1 });
  check('halted spend-unknown', r.halted === 'spend-unknown', JSON.stringify({ halted: r.halted, refused: r.refused }));
  check('the unknown-cost attempt\'s own candidate did not land (review B2)', r.landed.length === 0 && w.ctx.store.integrations(w.campaign.id, { state: 'integrated' }).length === 0
    && integrationTip(w.repo, w.campaign.id) === w.base, JSON.stringify(r.landed));
  check('B was never dispatched', !w.ctx.store.missions(w.campaign.projectId).some((m) => m.objective === 'ticket B'));
  const halt = w.ctx.store.decisions(w.campaign.id).find((d) => d.scope.operation === 'halt-campaign');
  check('a derived halt-campaign decision names the reason, as the campaign', halt?.scope.reason === 'spend-unknown' && halt.actor === `campaign:${w.campaign.id}`);
  check('the unknown cost is counted, never summed as zero', campaignSpend(w.ctx, w.campaign.id).unknownCount === 1);
  const again = await run(w, author, { concurrency: 1 });
  check('a halted campaign refuses to run until a person resumes it', again.refused !== null && /halted/.test(again.refused) && again.landed.length === 0);
  w.ctx.close();
}

section('spend: the refusal rule, as arithmetic');
{
  const s = { spentUsd: 0.5, knownUsd: 0.5, unknownCount: 0, scannedCount: 0, runningCount: 1, reservedUsd: 1, capUsd: 2 };
  check('within the cap: launches', campaignSpendRefusal(s, { maxUsdTotal: 2 }, 0.5) === null);
  check('past it with something running: waits, no halt', campaignSpendRefusal(s, { maxUsdTotal: 2 }, 0.6)?.halt === null);
  check('past it with nothing running: halts spend-cap', campaignSpendRefusal({ ...s, runningCount: 0 }, { maxUsdTotal: 2 }, 1.6)?.halt === 'spend-cap');
  check('a breach halts spend-breach', campaignSpendRefusal({ ...s, spentUsd: 2.1 }, { maxUsdTotal: 2 }, 0.1)?.halt === 'spend-breach');
  check('unknown cost halts before anything else', campaignSpendRefusal({ ...s, unknownCount: 1, spentUsd: 0 }, { maxUsdTotal: 2 }, 0.1)?.halt === 'spend-unknown');
}

section('spend: a reservation holds a second launch until the cap allows it (P2-R18)');
{
  const w = nodeWorld('reserve', [
    { id: 'A', lane: 'LA', scope: ['src/a.js'], gate: `test('a is A', () => assert.strictEqual(${load('src/a.js')}(), 'A'));` },
    { id: 'B', lane: 'LB', scope: ['src/b.js'], gate: `test('b is B', () => assert.strictEqual(${load('src/b.js')}(), 'B'));` },
  ]);
  await lockAndAuthorize(w, { concurrency: 2, maxUsdTotal: 1, maxUsdPerMission: 1 });
  const author = mockAuthor(path.join(w.dir, 'author.cjs'), {
    A: { first: { 'src/a.js': "module.exports = () => 'A';\n" } }, B: { first: { 'src/b.js': "module.exports = () => 'B';\n" } },
  });
  const r = await run(w, author, { concurrency: 2 });
  check('both landed', r.statuses.A === 'landed' && r.statuses.B === 'landed', JSON.stringify(r));
  check('a launch was refused while the first held the whole cap', namesOf(w).includes('campaign.spend.refused'));
  const attempts = w.ctx.store.missions(w.campaign.projectId).filter((m) => m.parentId === w.campaign.id)
    .flatMap((m) => w.ctx.store.tasks(m.id).flatMap((t) => w.ctx.store.attempts(t.id))).sort((a, b) => a.startedAt - b.startedAt);
  check('the second attempt started only after the first finished, under what was left', attempts.length === 2 && attempts[1].startedAt >= attempts[0].finishedAt!
    && Math.abs((attempts[1].maxCostUsd ?? 0) - (1 - (attempts[0].costUsd ?? 0))) < 1e-6, JSON.stringify(attempts.map((a) => [a.startedAt, a.finishedAt, a.maxCostUsd, a.costUsd])));
  check('spend never exceeded the cap', campaignSpend(w.ctx, w.campaign.id).spentUsd <= 1);
  w.ctx.close();
}

section('a ticket that used its own budget is blocked; the campaign goes on (P2-R35, review B3)');
{
  const w = nodeWorld('ticketbudget', [
    { id: 'A', lane: 'LA', scope: ['src/a.js'], gate: `test('a is A', () => assert.strictEqual(${load('src/a.js')}(), 'A'));`, budget: { maxUsd: 0.05 } },
    { id: 'B', lane: 'LB', scope: ['src/b.js'], gate: `test('b is B', () => assert.strictEqual(${load('src/b.js')}(), 'B'));` },
  ]);
  await lockAndAuthorize(w, { concurrency: 1, maxUsdTotal: 5, maxUsdPerMission: 1, maxAttemptsPerTicket: 3 });
  const author = mockAuthor(path.join(w.dir, 'author.cjs'), {
    A: { first: { 'src/a.js': "module.exports = () => 'no';\n" }, repair: { 'src/a.js': "module.exports = () => 'A';\n" } },
    B: { first: { 'src/b.js': "module.exports = () => 'B';\n" } },
  });
  const r = await run(w, author, { concurrency: 1 });
  check('the campaign is not halted', r.halted === null && r.refused === null, JSON.stringify({ halted: r.halted, refused: r.refused }));
  check('A is blocked after one attempt at $0.05 of its $0.05; B landed', r.statuses.A === 'blocked' && r.statuses.B === 'landed', JSON.stringify(r.statuses));
  const am = w.ctx.store.missions(w.campaign.projectId).find((m) => m.objective === 'ticket A')!;
  check('A\'s mission is blocked with a blocked need naming its budget', am.state === 'blocked' && needsOf(w.ctx, am).some((n) => n.kind === 'blocked' && /ticket budget exhausted/.test(n.why)));
  check('one ticket-budget-exhausted event', w.ctx.events.forMission(w.campaign.id).concat(w.ctx.events.forMission(am.id))
    .filter((e) => e.name === 'campaign.ticket.blocked' && e.payload.reason === 'ticket-budget-exhausted').length === 1);
  check('no spend refusal and no halt decision', !namesOf(w).includes('campaign.spend.refused') && !w.ctx.store.decisions(w.campaign.id).some((d) => d.scope.operation === 'halt-campaign'));
  check('a second run neither halts nor redispatches A', await run(w, author, { concurrency: 1 }).then((x) => x.halted === null && x.statuses.A === 'blocked'));
  w.ctx.close();
}

// ---- refusals, exhaustion, parking ----------------------------------------------------------

section('a ready ticket refused at preflight closes inconclusive once, with a blocked need (P2-R23)');
{
  const w = nodeWorld('preflight', [{ id: 'A', lane: 'LA', scope: ['src/a.js'], gate: `test('a is A', () => assert.strictEqual(${load('src/a.js')}(), 'A'));` }]);
  await lockAndAuthorize(w, { concurrency: 1 });
  const r = await run(w, path.join(w.dir, 'no-such-author.cjs'));
  const ms = w.ctx.store.missions(w.campaign.projectId).filter((m) => m.parentId === w.campaign.id);
  check('one mission, closed inconclusive, with the refusal as its reason', ms.length === 1 && ms[0].outcome === 'inconclusive' && /no author/.test(ms[0].outcomeReason ?? ''), JSON.stringify(ms.map((m) => [m.state, m.outcome, m.outcomeReason])));
  check('it was not dispatched again', namesOf(w).filter((n) => n === 'campaign.ticket.dispatched').length === 1 && r.statuses.A === 'blocked');
  check('one blocked event', namesOf(w).filter((n) => n === 'campaign.ticket.blocked').length === 1);
  check('campaignRunNeeds names it for a person to retry', campaignRunNeeds(w.ctx, w.campaign, testHost(w.ctx, w.campaign, w.plan, w.tickets)).some((n) => n.kind === 'blocked' && /campaign retry/.test(n.why)));
  w.ctx.close();
}

section('exhaustion: a ticket that keeps failing is blocked, its dependent waits, another lane lands');
{
  const w = nodeWorld('exhaust', [
    { id: 'X', lane: 'LX', scope: ['src/a.js'], gate: `test('a is A', () => assert.strictEqual(${load('src/a.js')}(), 'A'));`, budget: { maxAttempts: 2 } },
    { id: 'Y', lane: 'LY', scope: ['src/b.js'], dependsOn: ['X'], gate: `test('b is B', () => assert.strictEqual(${load('src/b.js')}(), 'B'));` },
    { id: 'Z', lane: 'LZ', scope: ['src/c.js'], gate: `test('c is C', () => assert.strictEqual(${load('src/c.js')}(), 'C'));` },
  ]);
  await lockAndAuthorize(w, { concurrency: 2, maxAttemptsPerTicket: 3 });
  const author = mockAuthor(path.join(w.dir, 'author.cjs'), {
    X: { first: { 'src/a.js': "module.exports = () => 'no';\n" } }, Z: { first: { 'src/c.js': "module.exports = () => 'C';\n" } },
  });
  const r = await run(w, author, { concurrency: 2 });
  check('X is blocked after its two attempts (the ticket budget lowers the envelope\'s 3)', r.statuses.X === 'blocked'
    && w.ctx.store.missions(w.campaign.projectId).filter((m) => m.objective === 'ticket X').flatMap((m) => w.ctx.store.tasks(m.id).flatMap((t) => w.ctx.store.attempts(t.id))).length === 2, JSON.stringify(r.statuses));
  check('Y waits on it', r.statuses.Y === 'waiting');
  check('Z, in another lane, landed', r.statuses.Z === 'landed');
  const xm = w.ctx.store.missions(w.campaign.projectId).find((m) => m.objective === 'ticket X')!;
  check('X\'s mission is blocked with a blocked need', xm.state === 'blocked' && needsOf(w.ctx, xm).some((n) => n.kind === 'blocked'));
  w.ctx.close();
}

section('a dependency request parks its ticket; the loop goes on (P2-R21)');
{
  const w = nodeWorld('park', [
    { id: 'P', lane: 'LP', scope: ['src/a.js'], gate: `test('a is A', () => assert.strictEqual(${load('src/a.js')}(), 'A'));` },
    { id: 'Q', lane: 'LQ', scope: ['src/b.js'], gate: `test('b is B', () => assert.strictEqual(${load('src/b.js')}(), 'B'));` },
  ]);
  await lockAndAuthorize(w, { concurrency: 2 });
  const host = testHost(w.ctx, w.campaign, w.plan, w.tickets);
  const tip = git(w.repo, ['rev-parse', 'HEAD']);
  git(w.repo, ['update-ref', integrationRefFor(w.campaign.id), tip]);
  const m = host.startTicketMission(w.campaign.id, 'P', tip);
  w.ctx.store.transitionMission(m.id, 'running');
  const c = makeCandidate(w.ctx, m, tip, Buffer.alloc(0), []);
  const box = requestOutboxFile(w.out, c.attemptId);
  fs.mkdirSync(path.dirname(box), { recursive: true });
  fs.writeFileSync(box, `${JSON.stringify({ v: 1, at: Date.now(), request: { ecosystem: 'npm', name: 'left-pad', version: '1.3.0', reason: 'padding' } })}\n`);
  w.ctx.store.updateCandidateVerdict(c.id, 'no-diff', ['the candidate changes no file']);
  check('the ticket reads waiting-dependency', ticketStates(w.ctx, w.campaign.id, w.repo, host).get('P')?.status === 'waiting-dependency');
  const author = mockAuthor(path.join(w.dir, 'author.cjs'), { Q: { first: { 'src/b.js': "module.exports = () => 'B';\n" } } });
  const r = await run(w, author, { concurrency: 2 });
  check('it is parked and not dispatched; Q lands', r.statuses.P === 'waiting-dependency' && r.statuses.Q === 'landed'
    && !w.ctx.events.forMission(m.id).some((e) => e.name === 'campaign.ticket.dispatched'), JSON.stringify(r.statuses));
  check('one parked event, on the ticket mission', w.ctx.events.forMission(m.id).filter((e) => e.name === 'campaign.ticket.parked').length === 1);
  w.ctx.close();
}

// ---- cargo ------------------------------------------------------------------------------------

section('one cargo-gate landing: a crate with no dependencies, gates under cargo test');
{
  const dir = path.join(root, 'cargo');
  const repo = path.join(dir, 'repo');
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "fixture_one"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
    'src/lib.rs': 'pub fn one() -> u8 { 1 }\n',
    'checks/one.rs': '#[test]\nfn one_is_one() { assert_eq!(fixture_one::one(), 1); }\n',
    'checks/two.rs': '#[test]\nfn two_is_two() { assert_eq!(fixture_one::two(), 2); }\n',
  };
  const CARGO_PASS = { exitCode: 0, stdoutIncludes: ['test result: ok.'] };
  const plan: PlanFileV1 = {
    kind: 'daylight-plan', version: 1, title: 'cargo', lanes: [{ id: 'R', title: 'rust', owns: ['src/'] }],
    campaignGates: [{ id: 'one', role: 'regression', harness: 'cargo', path: 'checks/one.rs', expect: CARGO_PASS }],
    tickets: [{ id: 'T', lane: 'R', title: 'Ticket T', statement: 'add two()', scope: ['src/lib.rs'],
      acceptance: { kind: 'gate', tests: [{ path: 'checks/two.rs', harness: 'cargo', expect: CARGO_PASS }] } }],
  };
  files['daylight.plan.json'] = JSON.stringify(plan);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  // Cargo's own lockfile for a crate with no dependencies: offline, and exactly what cargo would write.
  const generated = spawnSync('/usr/bin/cargo', ['generate-lockfile', '--offline', '--manifest-path', path.join(repo, 'Cargo.toml')], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir, CARGO_HOME: path.join(dir, 'cargo-home') },
  });
  check('cargo generates the fixture\'s lockfile offline', generated.status === 0, generated.stderr.slice(-300));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@daylight.invalid', 'commit', '-q', '-m', 'crate']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  const out = path.join(dir, 'out');
  const mapped = spawnSync(process.execPath, [CLI, 'map', repo, '--out', out, '--top', '0'], { encoding: 'utf8', env: humanEnv });
  check('the crate maps', mapped.status === 0, mapped.stderr.slice(-300));
  createSnapshot(repo, out);
  const ctx = openDaylight(out);
  const { campaign } = makeCampaign(ctx, repo, base, {}, ['daylight.plan.json']);
  const tickets = [ticketRow(campaign, makeWorkItem(ctx, campaign, 'T'), {
    id: 'T', lane: 'R', scope: ['src/lib.rs'], acceptance: { kind: 'gate', tests: [{ path: 'checks/two.rs', harness: 'cargo', expect: CARGO_PASS }] },
  })];
  const gctx: GateContext = { store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: repo, out, sandbox: live, env: humanEnv };
  const w: World = { dir, repo, base, out, ctx, gctx, campaign, tickets, plan };
  await lockAndAuthorize(w, { concurrency: 1, maxUsdTotal: 2, maxUsdPerMission: 1 });
  const lock = w.ctx.store.campaignLockDecision(campaign.id);
  check('the cargo regression gate passed at base and the ticket gate failed: the lock took both', (lock?.scope.experimentIds as string[]).length === 2);
  const author = mockAuthor(path.join(dir, 'author.cjs'), { T: { first: { 'src/lib.rs': 'pub fn one() -> u8 { 1 }\npub fn two() -> u8 { 2 }\n' } } });
  const r = await run(w, author, { concurrency: 1 });
  check('the ticket landed on the integration ref, judged by cargo gates on the integrated tree', r.statuses.T === 'landed', JSON.stringify({ r: r.statuses, refused: r.refused }));
  const evals = ctx.store.gateEvaluations({ missionId: campaign.id, target: 'integrated' });
  check('both cargo checks were supported on the integrated tree', evals.length === 2 && evals.every((e) => e.conclusion === 'supported'), JSON.stringify(evals.map((e) => e.conclusion)));
  check('the integration ref holds two()', git(repo, ['show', `${integrationTip(repo, campaign.id)}:src/lib.rs`]).includes('fn two()'));
  ctx.close();
}

done();
