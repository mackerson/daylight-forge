/**
 * `daylight campaign gate|baseline|lock|run|status|halt|resume|adopt-tip` (WS-R6), in process.
 * Run: node engine/test/forge-campaign-run-cli.ts
 *
 * No sandbox: baselines are recorded as rows here (the bwrap runs are forge-campaign-run-director's).
 * The agent-session refusal of every writing subcommand is WS-R5's `runCampaignCommand`, which
 * dispatches here after it; the guarded acts below still refuse an agent session themselves
 * through `assertHumanDecision`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CAMPAIGN_RUN_SUBCOMMANDS, runCampaignRunCommand } from '../forge/commands-campaign-run.ts';
import { registerPlanGates } from '../forge/campaign-gates.ts';
import { openDaylight } from '../mission/context.ts';
import type { CampaignStatusReport, PlanFileV1 } from '../mission/types.ts';
import { harness } from './harness.ts';
import { authorizeCampaign, git, makeCampaign, makeWorkItem, tempDir, testHost, ticketRow } from './forge-campaign-run-fixture.ts';

const { check, section, done } = harness();
const CLI = path.resolve(import.meta.dirname, '..', 'cli.ts');
const human: NodeJS.ProcessEnv = { ...process.env };
delete human.CLAUDECODE;
delete human.DAYLIGHT_SESSION;

const dir = tempDir('daylight-campaign-cli-');
const repo = path.join(dir, 'repo');
const out = path.join(dir, 'out');
const PASS = { exitCode: 0, stdoutIncludes: ['# fail 0'] };
const plan: PlanFileV1 = {
  kind: 'daylight-plan', version: 1, title: 'cli', lanes: [{ id: 'L', title: 'l', owns: ['src/'] }],
  campaignGates: [{ id: 'loads', role: 'regression', path: 'checks/loads.test.js', expect: PASS }],
  tickets: [{ id: 'A', lane: 'L', title: 'Ticket A', statement: 'do A', scope: ['src/a.js'], acceptance: { kind: 'gate', tests: [{ path: 'checks/a.test.js', expect: PASS }] } }],
};
for (const [rel, text] of Object.entries({
  'src/a.js': 'module.exports = () => 0;\n', 'checks/loads.test.js': "require('node:test')('x', () => {});\n", 'checks/a.test.js': "require('node:test')('a', () => {});\n",
  'daylight.plan.json': JSON.stringify(plan), 'holdout.test.js': "require('node:test')('HIDDEN_q1', () => {});\n",
})) {
  fs.mkdirSync(path.dirname(path.join(dir, rel.startsWith('holdout') ? rel : `repo/${rel}`)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel.startsWith('holdout') ? rel : `repo/${rel}`), text);
}
git(repo, ['init', '-q', '-b', 'main']);
git(repo, ['add', '-A']);
git(repo, ['-c', 'user.name=F', '-c', 'user.email=f@daylight.invalid', 'commit', '-q', '-m', 'f']);
const base = git(repo, ['rev-parse', 'HEAD']);
const mapped = spawnSync(process.execPath, [CLI, 'map', repo, '--out', out, '--top', '0'], { encoding: 'utf8', env: human });
if (mapped.status !== 0) throw new Error(mapped.stderr);
const ctx = openDaylight(out);
const { campaign } = makeCampaign(ctx, repo, base);
const tickets = [ticketRow(campaign, makeWorkItem(ctx, campaign, 'A'), { id: 'A', lane: 'L', scope: ['src/a.js'], acceptance: plan.tickets[0].acceptance })];
const host = testHost(ctx, campaign, plan, tickets);

async function cli(argv: string[], env: NodeJS.ProcessEnv = human): Promise<{ code: number; out: string; err: string }> {
  let o = '';
  let e = '';
  const code = await runCampaignRunCommand([...argv, '--out', out], env, { host: () => host, stdout: (s) => { o += s; }, stderr: (s) => { e += s; } });
  return { code, out: o, err: e };
}
const rows = () => {
  const db = (ctx.store as unknown as { db: DatabaseSync }).db;
  return JSON.stringify((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((t) => (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n));
};

section('usage');
check('the subcommands are exactly §8\'s R6 set plus halt, resume and adopt-tip', CAMPAIGN_RUN_SUBCOMMANDS.join(',') === 'gate,baseline,lock,run,status,halt,resume,adopt-tip');
check('an unknown subcommand is a usage error', (await cli(['frobnicate', campaign.id])).code === 2);
check('a subcommand without its campaign is a usage error', (await cli(['run'])).code === 2);

section('gate register and list: a holdout is registered from a host file and never shown by path');
{
  const r = await cli(['gate', 'register', campaign.id, '--role', 'holdout', '--ticket', 'A', '--file', path.join(dir, 'holdout.test.js'), '--expect-exit', '0', '--expect-stdout', '# fail 0', '--format', 'json']);
  const x = JSON.parse(r.out) as { experimentId: string; role: string };
  check('registered', r.code === 0 && x.role === 'holdout', r.err);
  check('its JSON carries neither path nor source', !r.out.includes('holdout.test.js') && !r.out.includes('HIDDEN_q1'));
  const l = await cli(['gate', 'list', campaign.id, '--format', 'json']);
  check('gate list withholds the holdout\'s path', l.code === 0 && !l.out.includes('holdout.test.js') && !l.out.includes('HIDDEN_q1') && /"testPath": null/.test(l.out), l.out);
  check('--role has no default', (await cli(['gate', 'register', campaign.id, '--file', path.join(dir, 'holdout.test.js')])).code === 2);
}

section('lock: the ratchet is said, the digest confirmed, the baselines checked');
{
  registerPlanGates({ store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: repo, out }, campaign.id, plan);
  check('without --ratchet or --no-ratchet: usage', (await cli(['lock', campaign.id, '--rationale', 'r'])).code === 2);
  const preview = await cli(['lock', campaign.id, '--no-ratchet', '--rationale', 'r', '--format', 'json']);
  const digest = (JSON.parse(preview.out) as { digest: string }).digest;
  check('without --confirm: the digest is shown and the exit is 2', preview.code === 2 && /^sha256:/.test(digest), preview.out);
  check('the preview counts the holdout and does not name it', /1 holdout\(s\), counted, not named/.test(preview.out) && !preview.out.includes('HIDDEN_q1'));
  const code8 = digest.slice(7, 15);
  const unbaselined = await cli(['lock', campaign.id, '--no-ratchet', '--rationale', 'r', '--confirm', code8]);
  check('refused with no baseline: run campaign baseline first', unbaselined.code === 1 && /campaign baseline/.test(unbaselined.err), unbaselined.err);
  for (const x of ctx.store.experimentsFor(campaign.id)) {
    ctx.store.recordGateEvaluation({ missionId: campaign.id, projectId: campaign.projectId, revision: base, experimentId: x.id, target: 'base', diffDigest: null,
      harnessDigest: x.harnessDigest, executions: [], conclusion: x.role === 'regression' ? 'supported' : 'falsified' });
  }
  const agent = await cli(['lock', campaign.id, '--no-ratchet', '--rationale', 'r', '--confirm', code8], { ...human, CLAUDECODE: '1' });
  check('refused under CLAUDECODE', agent.code === 1 && /CLAUDECODE/.test(agent.err), agent.err);
  const ratchetCode = (JSON.parse((await cli(['lock', campaign.id, '--ratchet', '--rationale', 'r', '--format', 'json'])).out) as { digest: string }).digest;
  check('the ratchet flag changes the digest', ratchetCode !== digest);
  const ok = await cli(['lock', campaign.id, '--no-ratchet', '--rationale', 'r', '--confirm', code8, '--format', 'json']);
  check('locked from a person\'s shell', ok.code === 0 && (JSON.parse(ok.out) as { scope: { gateSetDigest: string; ratchet: boolean } }).scope.ratchet === false, ok.err);
}

section('run: refused under an authorization for another gate set; the dry run writes nothing');
{
  const refused = await cli(['run', campaign.id, repo, '--format', 'json']);
  check('exit 1 and says why', refused.code === 1 && /names gate set .* not the current lock/.test(refused.out), refused.out);
  const lock = ctx.store.campaignLockDecision(campaign.id)!;
  authorizeCampaign(ctx, campaign, { ticketIds: ['A'], gateSetDigest: String(lock.scope.gateSetDigest) });
  const before = rows();
  const refs = git(repo, ['for-each-ref']);
  const dry = await cli(['run', campaign.id, repo, '--dry-run', '--format', 'json']);
  const d = JSON.parse(dry.out) as { dryRun: boolean; schedule: Array<{ ticketId: string }> };
  check('exit 0, A scheduled', dry.code === 0 && d.dryRun && d.schedule[0]?.ticketId === 'A', dry.out + dry.err);
  check('no row, no event and no ref changed', rows() === before && git(repo, ['for-each-ref']) === refs);
  const wide = await cli(['run', campaign.id, repo, '--dry-run', '--concurrency', '99', '--format', 'json']);
  check('a concurrency above the envelope\'s is refused', wide.code === 1 && /--concurrency 99/.test(wide.out));
}

section('status: derived, written under <out> only');
{
  const r = await cli(['status', campaign.id, repo, '--write', '--format', 'json']);
  const s = JSON.parse(r.out) as CampaignStatusReport;
  check('a status report', r.code === 0 && s.kind === 'daylight-campaign-status' && s.tickets[0]?.id === 'A' && s.tickets[0].status === 'ready', r.out.slice(0, 300) + r.err);
  check('with the merge hint, never run', s.integration.mergeHint === `git merge --ff-only refs/heads/daylight/campaign/${campaign.id}`);
  check('STATUS.md under <out>/campaigns/<id>/', fs.readFileSync(path.join(out, 'campaigns', campaign.id, 'STATUS.md'), 'utf8').startsWith(`# Campaign ${campaign.id}`));
  check('nothing in the repository', git(repo, ['status', '--porcelain', '--untracked-files=all']) === '');
}

section('halt, resume, adopt-tip');
{
  const h = await cli(['halt', campaign.id, '--rationale', 'r']);
  check('halt and resume are WS-R5\'s acts: without them wired, a clear error (waiting on the R5 merge)', h.code === 1 && /haltCampaign: not implemented/.test(h.err), h.err);
  const a = await cli(['adopt-tip', campaign.id, repo, '--halt', 'd_00000000000000000000000000000000', '--rationale', 'r']);
  check('adopt-tip with no integration ref says there is nothing to adopt', a.code === 1 && /nothing to adopt/.test(a.err), a.err);
}

ctx.close();
done();
