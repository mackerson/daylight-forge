/**
 * The first real campaign run: every step through the CLI (a child process each), on WS-R5's
 * host and WS-R6's director, under bwrap with mock authors and a mock reviewer. Run:
 * node engine/test/forge-campaign-e2e.ts
 *
 * validate → import → approve-plan → holdout register → baseline → lock → authorize → run: a
 * three-ticket plan (B on A, C on A and B) lands three times on refs/heads/daylight/campaign/<id>
 * under derived authorize-mission grants; B is repaired once; the wave review files one High,
 * which becomes a fix ticket admitted and landed in the same run. Then an overturned assumption's
 * follow-up ticket, approved by a person, lands; halt refuses a run until a confirmed resume; a
 * child mission's export is refused; under CLAUDECODE `run` is refused while `run --dry-run` and
 * `status` read only. HEAD, the index and the worktree never change and no hook runs.
 *
 * Mocks only. bwrap is required: without it this file fails, it does not skip.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { detectSandbox } from '../experiment/sandbox.ts';
import { applicationRefusals } from '../forge/apply.ts';
import { campaignViolations } from '../forge/campaign.ts';
import { integrationRefFor, integrationRefusals, integrationTip } from '../forge/integrate.ts';
import { openDaylight } from '../mission/context.ts';
import type { CampaignStatusReport, Decision, PlanFileV1 } from '../mission/types.ts';
import { harness } from './harness.ts';
import { git, repoState, tempDir } from './forge-campaign-run-fixture.ts';

const { check, section, done } = harness();
const CLI = path.resolve(import.meta.dirname, '..', 'cli.ts');
const root = tempDir('daylight-campaign-e2e-');
const privateTmp = path.join(root, 'tmp');
fs.mkdirSync(privateTmp, { mode: 0o700 });
process.env.TMPDIR = privateTmp;

section('preflight: the sandbox the campaign depends on');
const live = detectSandbox();
check('bwrap and prlimit are installed (without them this file fails, never skips)', live.available, live.why);
if (!live.available) done();

// ---- the fixture repository ------------------------------------------------------------------

const PASS = { exitCode: 0, stdoutIncludes: ['# fail 0'] };
const SENTINEL = 'HOLDOUT_SENTINEL_e2e7';
const nodeTest = (body: string) => `const test = require('node:test');\nconst assert = require('node:assert');\nconst path = require('node:path');\n${body}\n`;
const load = (f: string) => `require(path.resolve('${f}'))`;
const repo = path.join(root, 'repo');
const out = path.join(root, 'out');
const plan: PlanFileV1 = {
  kind: 'daylight-plan', version: 1, title: 'e2e',
  lanes: [{ id: 'LA', title: 'a', owns: ['src/'], shared: ['src/'] }, { id: 'LB', title: 'b', owns: ['src/'], shared: ['src/'] }, { id: 'LC', title: 'c', owns: ['src/'], shared: ['src/'] }],
  campaignGates: [{ id: 'loads', role: 'regression', path: 'checks/regression.test.js', expect: PASS }],
  tickets: [
    { id: 'A', lane: 'LA', title: 'Ticket A', statement: 'a says A', scope: ['src/a.js'],
      acceptance: { kind: 'gate', tests: [{ path: 'checks/a.test.js', expect: PASS }] } },
    { id: 'B', lane: 'LB', title: 'Ticket B', statement: 'b says B:A', scope: ['src/b.js'], dependsOn: ['A'],
      acceptance: { kind: 'gate', tests: [{ path: 'checks/b.test.js', expect: PASS }] } },
    { id: 'C', lane: 'LC', title: 'Ticket C', statement: 'c says B:A+C', scope: ['src/c.js'], dependsOn: ['A', 'B'],
      acceptance: { kind: 'gate', tests: [{ path: 'checks/c.test.js', expect: PASS }] } },
  ],
};
const files: Record<string, string> = {
  'src/a.js': "module.exports = () => 'a0';\n", 'src/b.js': "module.exports = () => 'b0';\n", 'src/c.js': "module.exports = () => 'c0';\n",
  'src/d.js': "module.exports = () => 'd0';\n", 'package.json': '{ "name": "e2e", "private": true }\n',
  'checks/regression.test.js': nodeTest(`test('every module loads', () => { for (const f of ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']) assert.strictEqual(typeof require(path.resolve(f)), 'function'); });`),
  'checks/a.test.js': nodeTest(`test('a is A', () => assert.strictEqual(${load('src/a.js')}(), 'A'));`),
  'checks/b.test.js': nodeTest(`test('b is B:A', () => assert.strictEqual(${load('src/b.js')}(), 'B:A'));`),
  'checks/c.test.js': nodeTest(`test('c is B:A+C', () => assert.strictEqual(${load('src/c.js')}(), 'B:A+C'));`),
  'daylight.plan.json': `${JSON.stringify(plan, null, 2)}\n`,
};
for (const [rel, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}
git(repo, ['init', '-q', '-b', 'main']);
git(repo, ['add', '-A']);
git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@daylight.invalid', 'commit', '-q', '-m', 'fixture']);
const holdoutFile = path.join(root, 'hidden.test.js');
fs.writeFileSync(holdoutFile, nodeTest(`test('${SENTINEL} b starts with B', () => assert.ok(${load('src/b.js')}().startsWith('B')));`));

/**
 * One mock for authors and the reviewer, told apart by the prompt. Authors write by ticket title;
 * B's first attempt is wrong and its repair right. The reviewer speaks MCP over the shim its
 * config names and files one High on wave 1 only.
 */
const mock = path.join(root, 'mock.cjs');
fs.writeFileSync(mock, `'use strict';
const fs = require('node:fs');
const prompt = process.argv[3] || '';
if (prompt.includes('You are reviewing wave')) {
  const { spawn } = require('node:child_process');
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).mcpServers.daylight;
  const calls = /You are reviewing wave 1 /.test(prompt)
    ? [{ name: 'report_finding', arguments: { path: 'src/a.js', severity: 'high', title: 'a has no doc comment', statement: 'a.js says nothing about what it returns' } }]
    : [];
  const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...calls.map((c, i) => ({ jsonrpc: '2.0', id: 2 + i, method: 'tools/call', params: c })),
  ];
  const want = msgs.filter((m) => m.id !== undefined).length;
  const replies = {};
  let buf = '';
  let next = 0;
  const pump = () => { while (next < msgs.length) { const m = msgs[next++]; child.stdin.write(JSON.stringify(m) + '\\n'); if (m.id !== undefined) break; } };
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const m = JSON.parse(line);
      if (m.id !== undefined) { replies[m.id] = m; pump(); }
      if (Object.keys(replies).length === want) { console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.02 })); process.exit(0); }
    }
  });
  pump();
  setTimeout(() => process.exit(0), 20000).unref();
} else {
  const title = (/^Title: (.*)$/m.exec(prompt) || [])[1] || '';
  const repair = prompt.includes('<<<REPAIR-');
  const w = (rel, text) => fs.writeFileSync('/work/' + rel, text);
  if (title === 'Ticket A') w('src/a.js', "module.exports = () => 'A';\\n");
  if (title === 'Ticket B') w('src/b.js', repair ? "module.exports = () => 'B:' + require('./a.js')();\\n" : "module.exports = () => 'wrong';\\n");
  if (title === 'Ticket C') w('src/c.js', "module.exports = () => require('./b.js')() + '+C';\\n");
  if (title.startsWith('Fix: ')) w('src/a.js', "// Returns 'A'.\\nmodule.exports = () => 'A';\\n");
  if (title.startsWith('Follow-up to assumption')) w('src/d.js', "module.exports = () => 'D';\\n");
  console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.05 }));
}
`);

// ---- the CLI --------------------------------------------------------------------------------

const human: NodeJS.ProcessEnv = { ...process.env, DAYLIGHT_MOCK_ADAPTER: mock, TMPDIR: privateTmp };
delete human.CLAUDECODE;
delete human.DAYLIGHT_SESSION;
const agent: NodeJS.ProcessEnv = { ...human, CLAUDECODE: '1' };

interface Ran { code: number; out: string; err: string }
const cli = (args: string[], env: NodeJS.ProcessEnv = human): Ran => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--out', out], { cwd: root, encoding: 'utf8', env, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const parsed = <T>(r: Ran): T => JSON.parse(r.out) as T;
const code8 = (digest: string) => digest.replace(/^sha256:/, '').slice(0, 8);
/** A guarded act: without --confirm it shows a digest and exits 2; with the digest's code it runs. */
const confirmed = (args: string[]): { preview: Ran; act: Ran } => {
  const preview = cli([...args, '--format', 'json']);
  const digest = preview.code === 2 ? parsed<{ digest: string }>(preview).digest : '';
  return { preview, act: cli([...args, '--format', 'json', '--confirm', code8(digest)]) };
};

const mapped = spawnSync(process.execPath, [CLI, 'map', repo, '--out', out, '--top', '0'], { encoding: 'utf8', env: human });
if (mapped.status !== 0) throw new Error(`map failed: ${mapped.stderr.slice(-400)}`);

// Planted after the map: any git hook that runs leaves a line here.
const hookLog = path.join(root, 'hooks-ran');
for (const h of ['pre-commit', 'post-commit', 'commit-msg', 'post-checkout', 'post-merge', 'reference-transaction', 'post-rewrite', 'pre-auto-gc', 'post-index-change']) {
  fs.writeFileSync(path.join(repo, '.git', 'hooks', h), `#!/bin/sh\necho ${h} >> ${JSON.stringify(hookLog)}\n`, { mode: 0o755 });
}
const state = repoState(repo);
const refsBefore = git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);

// ---- plan, approval, gates, authorization -------------------------------------------------------

section('validate, import, approve-plan');
const v = cli(['campaign', 'validate', 'daylight.plan.json', repo, '--format', 'json']);
check('validate: the plan is valid', v.code === 0 && parsed<{ ok: boolean }>(v).ok === true, v.err || v.out);
const imp = cli(['campaign', 'import', repo, '--file', 'daylight.plan.json', '--format', 'json']);
const campaignId = imp.code === 0 ? parsed<{ campaign: { id: string } }>(imp).campaign.id : '';
check('import: one campaign with three plan tickets', imp.code === 0 && parsed<{ added: string[] }>(imp).added.length === 3, imp.err);
const approve = confirmed(['campaign', 'approve-plan', campaignId, '--rationale', 'plan read']);
check('approve-plan: the digest first, then the approval', approve.preview.code === 2 && approve.act.code === 0, approve.act.err);

section('a holdout, the baseline and the lock');
const reg = cli(['campaign', 'gate', 'register', campaignId, '--role', 'holdout', '--ticket', 'B', '--file', holdoutFile, '--expect-exit', '0', '--expect-stdout', '# fail 0', '--format', 'json']);
check('the holdout is registered, its path and text withheld', reg.code === 0 && !reg.out.includes(SENTINEL) && !reg.out.includes('hidden.test.js'), reg.err);
const baseline = cli(['campaign', 'baseline', campaignId, repo, '--format', 'json']);
const baseRows = baseline.code === 0 ? parsed<Array<{ conclusion: string }>>(baseline) : [];
check('baseline: the regression gate passes at base, the three ticket gates and the holdout fail there', baseline.code === 0
  && baseRows.filter((g) => g.conclusion === 'supported').length === 1 && baseRows.filter((g) => g.conclusion === 'falsified').length === 4, baseline.err || baseline.out);
const lock = confirmed(['campaign', 'lock', campaignId, '--no-ratchet', '--rationale', 'gates read']);
const gateSet = lock.act.code === 0 ? String(parsed<Decision>(lock.act).scope.gateSetDigest) : '';
check('lock: the gate-set digest first, then the lock', lock.preview.code === 2 && lock.act.code === 0 && gateSet.startsWith('sha256:'), lock.act.err);

section('authorize-campaign against that lock');
const envelope = ['--roster', 'mock', '--max-usd-total', '10', '--max-usd-per-mission', '1', '--max-turns', '40', '--timeout', '600', '--max-attempts', '3',
  '--concurrency', '2', '--auto-apply', 'integration-ref', '--wave-size', '3', '--review-roster', 'mock', '--fix-lane', '2:0.5', '--rationale', 'go'];
const wrongSet = confirmed(['campaign', 'authorize', campaignId, '--expected-gate-set', `sha256:${'0'.repeat(64)}`, ...envelope]);
check('an --expected-gate-set that is not the lock\'s is refused', wrongSet.act.code === 1, wrongSet.act.err);
const authz = confirmed(['campaign', 'authorize', campaignId, '--expected-gate-set', gateSet, ...envelope]);
const auth = authz.act.code === 0 ? parsed<Decision>(authz.act) : null;
check('authorized', authz.preview.code === 2 && auth?.scope.operation === 'authorize-campaign' && auth.actor.startsWith('human:'), authz.act.err);

// ---- the run ------------------------------------------------------------------------------------

const ctx = openDaylight(out);
const rowCounts = () => {
  const db = (ctx.store as unknown as { db: DatabaseSync }).db;
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
  return JSON.stringify([ctx.events.head(), ...tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n])]);
};
const children = () => ctx.store.missions(ctx.store.mission(campaignId)!.projectId).filter((m) => m.parentId === campaignId);
const ticketMission = (ticketId: string) => {
  const t = ctx.store.campaignTicket(campaignId, ticketId);
  return t ? children().find((m) => m.kind === 'implement' && m.workItemId === t.workItemId) : undefined;
};
const attemptsOf = (missionId: string) => ctx.store.tasks(missionId).flatMap((t) => ctx.store.attempts(t.id));
interface RunResult { landed: string[]; statuses: Record<string, string>; refused: string | null; halted: string | null }

section('campaign run: three landings, a repair, a wave review, a fix ticket');
const run1 = cli(['campaign', 'run', campaignId, repo, '--format', 'json']);
const r1 = run1.code === 0 ? parsed<RunResult>(run1) : null;
check('the run finished with no refusal and no halt', run1.code === 0 && r1?.refused === null && r1.halted === null, run1.err || run1.out.slice(-800));
check('A, B and C landed in dependency order, then the fix ticket', r1?.landed.join(',') === 'A,B,C,FIX.1.1', r1?.landed.join(','));
const ref = integrationRefFor(campaignId);
check('the integration ref is refs/heads/daylight/campaign/<id>', ref === `refs/heads/daylight/campaign/${campaignId}`);
const tip = integrationTip(repo, campaignId)!;
const base = ctx.store.mission(campaignId)!.baseRevision;
check('its first-parent history is four landings on the base', git(repo, ['rev-list', '--first-parent', `${base}..${tip}`]).split('\n').length === 4);
check('the tip holds every change', git(repo, ['show', `${tip}:src/c.js`]).includes("+ '+C'") && git(repo, ['show', `${tip}:src/a.js`]).includes("// Returns 'A'."));

for (const id of ['A', 'B', 'C', 'FIX.1.1']) {
  const m = ticketMission(id);
  const grant = m ? ctx.store.decisions(m.id).find((d) => d.scope.operation === 'authorize-mission') : undefined;
  check(`${id}: its authorize-mission is derived, by campaign:<id>, from the human authorization`,
    grant?.actor === `campaign:${campaignId}` && grant.scope.derivedFrom === auth?.id, JSON.stringify(grant && { actor: grant.actor, scope: grant.scope }));
}
const bAttempts = attemptsOf(ticketMission('B')?.id ?? '');
const repairs = children().flatMap((m) => ctx.events.forMission(m.id)).filter((e) => e.name === 'campaign.repair.queued');
check('B took one repair: two author attempts, one repair queued, on B', bAttempts.length === 2 && repairs.length === 1 && repairs[0].missionId === ticketMission('B')?.id,
  JSON.stringify([bAttempts.length, repairs.map((e) => e.missionId)]));
check('A, C and the fix ticket took one attempt each', ['A', 'C', 'FIX.1.1'].every((id) => attemptsOf(ticketMission(id)?.id ?? '').length === 1));

const waves = ctx.store.waves(campaignId);
const findings = ctx.store.findings(campaignId);
check('wave 1 is A, B and C, reviewed by an audit mission', waves[0]?.ticketIds.slice().sort().join(',') === 'A,B,C' && !!waves[0].reviewMissionId
  && ctx.store.mission(waves[0].reviewMissionId)?.kind === 'audit');
check('the mock reviewer filed exactly one finding, High, on src/a.js', findings.length === 1 && findings[0].severity === 'high' && findings[0].path === 'src/a.js',
  JSON.stringify(findings.map((f) => [f.waveSeq, f.severity, f.path])));
const fix = ctx.store.campaignTicket(campaignId, 'FIX.1.1');
const admission = fix ? ctx.store.admission(campaignId, fix.workItemId) : null;
check('it became fix ticket FIX.1.1, admitted by a derived admit-work-item', fix?.origin === 'fix' && fix.sourceRef === findings[0]?.id
  && admission?.actor === `campaign:${campaignId}` && admission.scope.derivedFrom === auth?.id);

section('campaign status shows it');
const st = cli(['campaign', 'status', campaignId, repo, '--format', 'json']);
const report = st.code === 0 ? parsed<CampaignStatusReport>(st) : null;
check('status: four landed on the integration ref', st.code === 0 && report?.integration.landed === 4 && report.integration.tip === tip && report.integration.ref === ref, st.err);
check('status: every ticket landed, B with two attempts', !!report && report.tickets.every((t) => t.status === 'landed') && report?.tickets.find((t) => t.id === 'B')?.attempts === 2);
check('status: wave 1 with one High and one fix ticket', report?.waves[0]?.findings.high === 1 && report.waves[0].fixTickets === 1, JSON.stringify(report?.waves));
check('status: spend known, within the cap, nothing reserved', !!report && report.spend.unknownCount === 0 && report.spend.spentUsd > 0
  && report.spend.spentUsd <= 10 && report.spend.reservedUsd === 0, JSON.stringify(report?.spend));
check('status: authorized by the human decision, not halted, no needs', !!report && report.authorization.decisionId === auth?.id && report.authorization.halted === null
  && report.needs.length === 0, JSON.stringify(report?.needs));
const needKinds = (r: CampaignStatusReport | null) => (r?.needs ?? []).map((n) => `${n.kind}:${n.ref}`);
check('status needs are listed once each', new Set(needKinds(report)).size === needKinds(report).length);

// ---- a follow-up a person approves ----------------------------------------------------------------

section('an overturned assumption\'s follow-up, approved by a person, lands');
const rec = confirmed(['assumption', 'record', campaignId, '--question', 'Does d stay d0?', '--default', 'yes', '--rationale', 'noted']);
const assumptionId = rec.act.code === 0 ? parsed<{ id: string }>(rec.act).id : '';
check('a person records an assumption', rec.preview.code === 2 && rec.act.code === 0, rec.act.err);
const over = confirmed(['assumption', 'overturn', assumptionId, '--value', 'no', '--follow-up', 'd says D', '--lane', 'LA', '--scope', 'src/d.js', '--rationale', 'changed my mind']);
check('and overturns it with a follow-up', over.preview.code === 2 && over.act.code === 0, over.act.err);
const fu = ctx.store.campaignTickets(campaignId).find((t) => t.origin === 'follow-up');
check('the follow-up FU.1 is filed proposed', fu?.ticketId === 'FU.1' && ctx.store.workItem(fu.workItemId)?.status === 'proposed');
const proposed = parsed<CampaignStatusReport>(cli(['campaign', 'status', campaignId, repo, '--format', 'json']));
check('status lists it as a need of a person, once', proposed.needs.filter((n) => n.kind === 'work-item-undecided' && n.ref === fu?.workItemId).length === 1, JSON.stringify(proposed.needs));
const appr = confirmed(['work-item', 'approve', fu?.workItemId ?? '', '--rationale', 'yes, D']);
check('a person approves it', appr.preview.code === 2 && appr.act.code === 0 && ctx.store.workItem(fu?.workItemId ?? '')?.status === 'approved', appr.act.err || appr.preview.err);
const run2 = cli(['campaign', 'run', campaignId, repo, '--format', 'json']);
const r2 = run2.code === 0 ? parsed<RunResult>(run2) : null;
check('the next run lands FU.1 and nothing else', r2?.landed.join(',') === 'FU.1', run2.err || run2.out.slice(-800));
const fuGrant = ctx.store.decisions(ticketMission('FU.1')?.id ?? '').find((d) => d.scope.operation === 'authorize-mission');
check('FU.1 ran under a derived grant from the same authorization', fuGrant?.actor === `campaign:${campaignId}` && fuGrant.scope.derivedFrom === auth?.id);
check('the tip now holds d says D', git(repo, ['show', `${integrationTip(repo, campaignId)}:src/d.js`]).includes("'D'"));

// ---- halt and resume ------------------------------------------------------------------------------

section('halt, then a confirmed resume');
const halt = cli(['campaign', 'halt', campaignId, '--rationale', 'stop', '--format', 'json']);
const haltId = halt.code === 0 ? parsed<Decision>(halt).id : '';
check('a person halts the campaign', halt.code === 0 && ctx.store.campaignHalts(campaignId).length === 1, halt.err);
const missionsAtHalt = children().length;
const halted = cli(['campaign', 'run', campaignId, repo, '--format', 'json']);
check('a run while halted dispatches nothing and says so', halted.code === 1 && children().length === missionsAtHalt
  && parsed<RunResult>(halted).landed.length === 0, halted.err || halted.out.slice(-400));
const resume = confirmed(['campaign', 'resume', campaignId, '--halt', haltId, '--rationale', 'go on']);
check('resume without --confirm shows the digest (exit 2); with it the halt is answered', resume.preview.code === 2 && resume.act.code === 0
  && ctx.store.campaignHalts(campaignId).length === 0, resume.act.err);
const run3 = cli(['campaign', 'run', campaignId, repo, '--format', 'json']);
check('after the resume a run finds nothing left to do', run3.code === 0 && parsed<RunResult>(run3).landed.length === 0, run3.err);

// ---- refusals -----------------------------------------------------------------------------------

section('a campaign child mission is never exported (P2-R14)');
const exportFile = path.join(root, 'child-export.json');
const exp = cli(['mission', 'export', ticketMission('A')?.id ?? '', '--file', exportFile]);
check('export of a ticket mission is refused and writes nothing', exp.code !== 0 && /campaign missions are not exported/.test(exp.err) && !fs.existsSync(exportFile), exp.err);

section('under CLAUDECODE: run refused; run --dry-run and status read only');
const rows = rowCounts();
const refsNow = git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
const agentRun = cli(['campaign', 'run', campaignId, repo], agent);
check('campaign run is refused', agentRun.code === 1 && /CLAUDECODE/.test(agentRun.err), agentRun.err);
const agentDry = cli(['campaign', 'run', campaignId, repo, '--dry-run', '--format', 'json'], agent);
check('campaign run --dry-run succeeds', agentDry.code === 0, agentDry.err);
const agentStatus = cli(['campaign', 'status', campaignId, repo, '--format', 'json'], agent);
check('campaign status succeeds', agentStatus.code === 0 && parsed<CampaignStatusReport>(agentStatus).integration.landed === 5, agentStatus.err);
check('and none of the three added a row, an event or a ref', rowCounts() === rows
  && git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']) === refsNow);

// ---- what must hold after all of it ------------------------------------------------------------

section('afterwards');
check('HEAD, the index, the worktree and every non-daylight ref are byte-equal', repoState(repo) === state);
check('only refs under refs/heads/daylight/ were added', git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n')
  .filter((l) => !l.startsWith('refs/heads/daylight/')).join('\n') === refsBefore);
check('no git hook ran', !fs.existsSync(hookLog), fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8') : '');
const projectId = ctx.store.mission(campaignId)!.projectId;
check('unauthorizedWriteAttempts is empty', ctx.store.unauthorizedWriteAttempts(projectId).length === 0);
check('derivationRefusals is empty', ctx.store.derivationRefusals(projectId).length === 0, ctx.store.derivationRefusals(projectId).join('; '));
check('campaignViolations is empty', campaignViolations(ctx, projectId).length === 0, campaignViolations(ctx, projectId).join('; '));
check('integrationRefusals is empty', integrationRefusals({ store: ctx.store, repoRoot: repo }, campaignId).length === 0,
  integrationRefusals({ store: ctx.store, repoRoot: repo }, campaignId).join('; '));
check('applicationRefusals is empty', applicationRefusals({ store: ctx.store, repoRoot: repo }).length === 0, applicationRefusals({ store: ctx.store, repoRoot: repo }).join('; '));
const events = children().concat(ctx.store.mission(campaignId)!).flatMap((m) => ctx.events.forMission(m.id));
const leaks = events.filter((e) => JSON.stringify(e.payload).includes(SENTINEL) || JSON.stringify(e.payload).includes('hidden.test.js'));
check('no event names the holdout (P2-R37: every event, not only campaign.*)', events.some((e) => e.name === 'experiment.registered') && leaks.length === 0, JSON.stringify(leaks.map((e) => [e.name, e.payload])).slice(0, 1500));

ctx.close();
done();
