/**
 * The mission loop, end to end. Run: node engine/test/orchestrate.ts
 *
 * Every step goes through the CLI as a child process, so the argument parsing, the JSON
 * shapes the shell reads, and the exit codes are what is tested — not an internal function
 * that happens to agree with them.
 *
 * The reviewers are mocks. A roster entry `mock:<model>` runs a script that writes claims
 * straight into the claim store and appends MCP-shaped lines to `events.jsonl`, with the
 * session the orchestrator handed it — so correlation, blind-review plumbing and the compare
 * step are exercised for real, and nothing here spends money or pretends a model said
 * anything. Everything the mock produces is labelled `mock`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXPECTED_FIXTURE_COMMIT } from '../demo/fixture.ts';
import { createServer, visibleToReviewer } from '../mcp/server.ts';
import { ArtifactStore } from '../mission/artifacts.ts';
import type { Experiment, Mission } from '../mission/types.ts';
import { ClaimStore } from '../store/claims.ts';
import type { Claim } from '../store/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const ENGINE = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ENGINE, 'cli.ts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-orchestrate-'));
const out = path.join(tmp, 'out');
const repo = path.join(tmp, 'repo');
const mock = path.join(tmp, 'mock-reviewer.mjs');

fs.writeFileSync(mock, `
import fs from 'node:fs';
const [cfgPath, prompt] = process.argv.slice(2);
const env = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.daylight.env;
const { DAYLIGHT_DIR, DAYLIGHT_AGENT, DAYLIGHT_MODEL, DAYLIGHT_SESSION, DAYLIGHT_BLIND_PREFIX } = env;
if (!DAYLIGHT_BLIND_PREFIX) { console.error('no DAYLIGHT_BLIND_PREFIX in config'); process.exit(3); }
if (process.env.DAYLIGHT_SESSION !== DAYLIGHT_SESSION) { console.error('session mismatch'); process.exit(4); }
if (!prompt.includes('src/session-cache.ts')) { console.error('prompt lacks the scope'); process.exit(5); }
if (DAYLIGHT_AGENT !== 'mock') { console.error('not labelled mock'); process.exit(6); }
const { ClaimStore } = await import(${JSON.stringify(path.join(ENGINE, 'store', 'claims.ts'))});
const store = new ClaimStore(DAYLIGHT_DIR + '/claims.db');
const source = { kind: 'agent', tool: DAYLIGHT_AGENT, model: DAYLIGHT_MODEL, sessionId: DAYLIGHT_SESSION };
const ev = (tool, extra = {}) => fs.appendFileSync(DAYLIGHT_DIR + '/events.jsonl',
  JSON.stringify({ at: Date.now(), session: DAYLIGHT_SESSION, agent: DAYLIGHT_AGENT, model: DAYLIGHT_MODEL ?? null, tool, ...extra }) + '\\n');
ev('get_overview');
ev('get_slice', { node: 'src/session-cache.ts', hops: 1 });
if (DAYLIGHT_MODEL === 'crash') { console.error('mock crash SECRET_MOCK_TOKEN_abcdefghijklmnop'); process.exit(1); }
const yes = DAYLIGHT_MODEL === 'yes';
store.submit({
  subject: 'src/session-cache.ts', predicate: 'bug_verdict', value: yes, confidence: yes ? 0.9 : 0.7, source,
  evidence: yes
    ? [{ file: 'src/session-cache.ts', line: 37, note: 'mock: the expiry check runs after the refresh and cannot fire' }]
    : [{ file: 'src/session-cache.ts', line: 34, note: 'mock: sliding expiry is documented' },
       { file: 'src/session-cache.ts', line: 37, note: 'mock: the check guards the refreshed record' }],
});
ev('submit_claim', { ok: true, subject: 'src/session-cache.ts', predicate: 'bug_verdict' });
store.close();
if (yes) console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.05, num_turns: 3 }));
`);

const env: Record<string, string | undefined> = {
  ...process.env,
  // A decision is refused inside an agent session; this test is the person deciding.
  CLAUDECODE: undefined,
  DAYLIGHT_SESSION: undefined,
  DAYLIGHT_MOCK_ADAPTER: mock,
  // A suspicious name with a long value: it must never reach an artifact.
  MOCK_SECRET_TOKEN: 'SECRET_MOCK_TOKEN_abcdefghijklmnop',
};

/** Run the CLI; never throws, so a refusal is a result rather than a crash. */
const run = (args: string[], o: Record<string, string> = {}): { code: number; out: string; err: string } => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...o }, timeout: 180_000,
  });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const json = <T>(r: { out: string }): T => JSON.parse(r.out) as T;

interface Prepared { root: string; commit: string; projectId: string; missionId: string; experimentId: string }
interface Inspection {
  mission: Mission;
  tasks: Array<{ id: string; role: string; state: string; runnerHint?: string }>;
  attempts: Array<{ id: string; taskId: string; runnerId: string; state: string; costUsd: number | null; failure?: string; artifacts: Array<{ id: string; label?: string }> }>;
  experiments: Experiment[];
  decisions: Array<{ id: string; artifactIds: string[]; subject?: string }>;
  disputes: Array<{ subject: string; predicate: string; status: string; sides: Array<{ source: string; value: unknown; evidence: unknown[] }>; decisionId?: string }>;
  unverified: unknown[];
  events: Array<{ sequence: number; name: string; attemptId?: string; category: string; payload: Record<string, unknown> }>;
}

section('demo prepare');
const prepared = json<Prepared>(run(['demo', 'prepare', '--out', out, '--dest', repo, '--format', 'json']));
{
  check('materialises the fixture at the pinned commit', prepared.commit === EXPECTED_FIXTURE_COMMIT, prepared.commit);
  check('identifies the project by its first commit', prepared.projectId === `git:${EXPECTED_FIXTURE_COMMIT.slice(0, 12)}`);
  check('creates a mission', /^m_[0-9a-f]{32}$/.test(prepared.missionId), prepared.missionId);
  check('registers an experiment', /^x_[0-9a-f]{32}$/.test(prepared.experimentId), prepared.experimentId);
  check('maps the fixture into the output directory', fs.existsSync(path.join(out, 'view.json')));

  const list = json<{ project: { id: string } | null; missions: Mission[] }>(run(['mission', 'list', '--out', out, '--format', 'json']));
  check('list names the project', list.project?.id === prepared.projectId);
  check('and the mission, ready and labelled as planted', list.missions.length === 1
    && list.missions[0].state === 'ready' && list.missions[0].objective.includes('PLANTED'));
  check('explore grants execute and nothing that writes', list.missions[0].permissions.execute
    && !list.missions[0].permissions.write && !list.missions[0].permissions.deploy);
}

section('dry run spawns nothing and leases nothing');
{
  const r = run(['mission', 'run', prepared.missionId, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:yes,mock:no', '--dry-run', '--format', 'json']);
  check('exits 0', r.code === 0, r.err.slice(-300));
  const report = json<{ mission: Mission; plans: unknown[]; attempts: unknown[] }>(r);
  check('plans both reviewers', report.plans.length === 2);
  check('starts no attempt', report.attempts.length === 0);
  check('leaves the mission ready', report.mission.state === 'ready');
  const claims = new ClaimStore(path.join(out, 'claims.db'));
  check('takes no lease', claims.activeLeases().length === 0);
  check('writes no claim', claims.stats().claims === 0);
  claims.close();
  check('writes no MCP events', !fs.existsSync(path.join(out, 'events.jsonl')));
}

section('two independent reviewers, blind to each other');
{
  const r = run(['mission', 'run', prepared.missionId, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:yes,mock:no', '--format', 'json']);
  check('exits 0', r.code === 0, r.err.slice(-500));
  check('reports progress as ##daylight lines on stderr', r.err.includes('##daylight {"mission"'));
  const report = json<{ mission: Mission; attempts: Inspection['attempts']; comparison: { disputes: Inspection['disputes']; unverified: unknown[] }; sourceDiversity: number; costKnown: boolean }>(r);
  check('the mission is running, not closed — reviews finishing is not an outcome', report.mission.state === 'running' && !report.mission.outcome);
  check('two sources', report.sourceDiversity === 2);
  const reviews = report.attempts.filter((a) => a.runnerId.startsWith('agent:mock:'));
  check('two review attempts, both completed', reviews.length === 2 && reviews.every((a) => a.state === 'completed'));
  check('a reviewer that printed a cost has it', reviews.find((a) => a.runnerId === 'agent:mock:yes')?.costUsd === 0.05);
  check('a reviewer that printed none is unknown, not zero', reviews.find((a) => a.runnerId === 'agent:mock:no')?.costUsd === null);
  check('and the run says its total is a floor', report.costKnown === false);
  const compare = report.attempts.find((a) => a.runnerId === 'static:daylight');
  check('compare ran as a deterministic attempt at known zero cost', compare?.state === 'completed' && compare.costUsd === 0);
  check('exactly one dispute', report.comparison.disputes.length === 1, String(report.comparison.disputes.length));
  const d = report.comparison.disputes[0];
  check('on the planted subject', d.subject === 'src/session-cache.ts' && d.predicate === 'bug_verdict');
  check('with both sides and their evidence', d.sides.length === 2 && d.sides.every((s) => s.evidence.length > 0)
    && new Set(d.sides.map((s) => s.value)).size === 2);
  check('nothing left unverified in scope', report.comparison.unverified.length === 0);

  const cfg = JSON.parse(fs.readFileSync(path.join(out, `mcp.mock-yes.${prepared.missionId}.json`), 'utf8'));
  check('the MCP config carries the blind prefix', cfg.mcpServers.daylight.env.DAYLIGHT_BLIND_PREFIX === prepared.missionId);
  check('and the agent label', cfg.mcpServers.daylight.env.DAYLIGHT_AGENT === 'mock' && cfg.mcpServers.daylight.env.DAYLIGHT_MODEL === 'yes');

  const view = json<Inspection>(run(['mission', 'inspect', prepared.missionId, '--out', out, '--format', 'json']));
  for (const a of reviews) {
    const calls = view.events.filter((e) => e.attemptId === a.id && e.name === 'tool.call');
    check(`${a.runnerId}: its three MCP tool calls were ingested and correlated`, calls.length === 3, String(calls.length));
    check(`${a.runnerId}: no other attempt's calls leaked in`, calls.every((c) => c.payload.session === view.events.find((e) => e.attemptId === a.id && e.name === 'process.start')?.payload.sessionId));
  }
  const seqs = view.events.map((e) => e.sequence);
  check('event sequences are strictly increasing', seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
  check('the prompt is an artifact on every attempt', reviews.every((a) => a.artifacts.some((x) => x.label === 'prompt')));
  const again = run(['mission', 'inspect', prepared.missionId, '--out', out, '--format', 'json']);
  check('inspecting twice ingests nothing twice', json<Inspection>(again).events.length === view.events.length);
  check('tasks: two reviews and a compare, all done', view.tasks.filter((t) => t.state === 'done').length === 3 && view.tasks.length === 3);
}

section('blind review filter');
{
  const claim = (sessionId: string | undefined, kind: 'agent' | 'human' | 'static' = 'agent'): Claim => ({
    id: 1, subject: 's', predicate: 'p', value: true, confidence: 1, evidence: [], at: 0,
    source: { kind, tool: 't', model: 'm', sessionId },
  });
  const mine = claim('m_1:t_1:a1');
  const other = claim('m_1:t_2:a1');
  const elsewhere = claim('m_2:t_9:a1');
  const human = claim(undefined, 'human');
  const stat = claim(undefined, 'static');
  const seen = visibleToReviewer([mine, other, elsewhere, human, stat], 'm_1', 'm_1:t_1:a1');
  check('the other reviewer in the mission is withheld', !seen.includes(other));
  check('my own claims show', seen.includes(mine));
  // ADR-6 as amended: independence holds across missions too — last week's reviewer on the
  // same subject is as much someone else's answer as today's other reviewer.
  check('another mission\'s agent claims are withheld too', !seen.includes(elsewhere));
  check('and so is an agent claim with no session', !visibleToReviewer([claim(undefined)], 'm_1', 'm_1:t_1:a1').length);
  check('human and static claims show', seen.includes(human) && seen.includes(stat));
  check('no prefix means not blind', visibleToReviewer([mine, other], undefined, 'x').length === 2);
}

section('blind review holds on every read, not only claims');
{
  // Reviewer A has written a claim, a cluster, a defence and holds a lease. Reviewer B, blind
  // to A in the same mission, must see none of it through the overview, focus state or
  // frontier tools — and B's own disagreement must not come back as A's CONTRADICTED.
  const dir = path.join(tmp, 'blind');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ root: dir, commit: null, nodes: [], edges: [] }));
  const A = { kind: 'agent' as const, tool: 'mock', model: 'a', sessionId: 'm_9:t_1:a1' };
  const raw = new ClaimStore(path.join(dir, 'claims.db'));
  const ev = [{ file: 'src/x.ts', line: 1 }, { file: 'src/x.ts', line: 2 }];
  raw.submit({ subject: 'src/x.ts', predicate: 'bug_verdict', value: true, confidence: 0.9, source: A, evidence: ev });
  raw.putCluster({ level: 2, name: 'A\'s subsystem', purpose: 'what A thinks', members: ['src/x.ts', 'src/y.ts'], source: A, evidence: ev });
  raw.putDefence({ node: 'src/x.ts', reason: 'A says this is load-bearing', source: A });
  raw.lease(['src/x.ts'], A.sessionId);
  raw.close();

  const { store } = createServer({ dir, session: 'm_9:t_2:a1', agentTool: 'mock', model: 'b', blindPrefix: 'm_9' });
  store.submit({ subject: 'src/x.ts', predicate: 'bug_verdict', value: false, confidence: 0.7,
    source: { kind: 'agent', tool: 'mock', model: 'b', sessionId: 'm_9:t_2:a1' }, evidence: ev });
  check('B does not see A\'s defence', store.defences().length === 0, JSON.stringify(store.defences()));
  check('or A\'s cluster', store.clusters().length === 0);
  check('the counts B is shown are of what B can see', store.stats().claims === 1 && store.stats().clusters === 0, JSON.stringify(store.stats()));
  check('B\'s belief is its own, not a contradiction with A', store.belief('src/x.ts', 'bug_verdict').status === 'INFERRED',
    store.belief('src/x.ts', 'bug_verdict').status);
  check('nothing reads as contested to B', store.contradictions().length === 0);
  check('and A\'s lease does not steer B off A\'s subject', !store.leasedElsewhere('m_9:t_2:a1').has('src/x.ts'));
  store.close();
}

section('the experiment, in the sandbox');
let experiment: Experiment;
{
  const r = run(['experiment', 'run', prepared.experimentId, repo, '--out', out, '--format', 'json']);
  check('exits 0', r.code === 0, r.err.slice(-500));
  experiment = json<Experiment>(r);
  check('the planted test fails at the planted commit, so the hypothesis is supported', experiment.conclusion === 'supported', experiment.conclusion);
  check('two runs', experiment.executions.length === 2);
  const store = new ArtifactStore(out);
  const records = experiment.executions.map((ref) => JSON.parse(store.text(ref)) as { harnessDigest: string; exitCode: number; status: string; sandboxArgv: string[] });
  check('every result carries the experiment\'s harness digest', records.every((x) => x.harnessDigest === experiment.harnessDigest));
  check('every run ran and exited 1', records.every((x) => x.status === 'ran' && x.exitCode === 1));
  check('and ran under bwrap with the worktree elided', records.every((x) => x.sandboxArgv.includes('bwrap') && x.sandboxArgv.includes('<worktree>')));
  check('the experiment is labelled planted', experiment.hypothesis.includes('PLANTED'));

  const stdout = run(['artifact', records[0] ? (JSON.parse(store.text(experiment.executions[0])) as { stdoutRef: { id: string } }).stdoutRef.id : 'x', '--out', out]);
  check('the run\'s stdout can be read back by digest', stdout.code === 0 && /not ok|fail/i.test(stdout.out), stdout.out.slice(0, 200));
}

section('execute permission is a grant, not a default');
{
  const audit = json<Mission>(run(['mission', 'create', repo, '--out', out, '--kind', 'audit', '--objective', 'read only', '--format', 'json']));
  check('an audit mission has no execute permission', audit.permissions.execute === false);
  const r = run(['experiment', 'propose', audit.id, '--out', out, '--subject', 'src/session-cache.ts', '--predicate', 'bug_verdict',
    '--hypothesis', 'h', '--test', path.join(repo, 'test', 'session-cache.test.js'), '--test-path', 'test/session-cache.test.js', '--expect-exit', '1']);
  check('proposing an experiment on it is refused', r.code === 1 && /execute permission/.test(r.err), r.err.slice(-200));
  run(['mission', 'close', audit.id, '--out', out, '--outcome', 'cancelled', '--reason', 'test only']);
}

section('a human decides');
{
  const what = ['--subject', 'src/session-cache.ts', '--predicate', 'bug_verdict', '--value', 'true', '--experiment', prepared.experimentId];
  const confirm = json<{ digest: string; digest8: string; lines: string[]; refusal: string | null }>(
    run(['confirm', 'adjudicate', prepared.missionId, '--out', out, ...what, '--format', 'json']));
  check('confirm shows what the decision records', confirm.refusal === null && /^[0-9a-f]{8}$/.test(confirm.digest8)
    && confirm.lines.some((l) => l.includes('bug_verdict')), JSON.stringify(confirm));
  const decideWith = (extra: string[], o: Record<string, string> = {}) => run(['mission', 'decide', prepared.missionId, '--out', out, ...what,
    '--rationale', 'The registered test fails at this revision.', ...extra, '--format', 'json'], o);
  const unconfirmed = decideWith([]);
  check('without --confirm nothing is recorded: the digest is shown, exit 2', unconfirmed.code === 2 && unconfirmed.out.includes(confirm.digest), unconfirmed.err.slice(-200));
  const agentSession = decideWith(['--confirm', confirm.digest8], { CLAUDECODE: '1' });
  check('under CLAUDECODE the decision is refused', agentSession.code === 1 && /CLAUDECODE/.test(agentSession.err), agentSession.err.slice(-200));
  check('under DAYLIGHT_SESSION too', decideWith(['--confirm', confirm.digest8], { DAYLIGHT_SESSION: 's' }).code === 1);
  check('an agent actor is refused', decideWith(['--confirm', confirm.digest8, '--actor', 'agent:claude:x']).code !== 0);
  check('a confirm for another value is refused', decideWith(['--confirm', '00000000']).code === 1);
  const r = decideWith(['--confirm', confirm.digest8, '--actor', 'human:test']);
  check('exits 0', r.code === 0, r.err.slice(-300));
  const { decision, belief } = json<{ decision: { id: string; artifactIds: string[]; actor: string }; belief: { status: string } }>(r);
  check('the belief is CONFIRMED by a human claim', belief.status === 'CONFIRMED');
  check('the decision links the experiment\'s result records', decision.artifactIds.length === 2
    && decision.artifactIds.every((id) => experiment.executions.some((x) => x.id === id)));
  check('and names who decided: the OS user, whatever --actor said', decision.actor === `human:${os.userInfo().username}`, decision.actor);
  const view = json<Inspection>(run(['mission', 'inspect', prepared.missionId, '--out', out, '--format', 'json']));
  check('the dispute is still on record, now CONFIRMED, with its decision', view.disputes.length === 1
    && view.disputes[0].status === 'CONFIRMED' && view.disputes[0].decisionId === decision.id);
  check('the mission is still running — a decision is not a close', view.mission.state === 'running');
  check('an approval event was recorded', view.events.some((e) => e.name === 'approval.decided'));
}

section('report');
let reportMd = '';
{
  const r = run(['report', prepared.missionId, '--out', out]);
  check('exits 0', r.code === 0, r.err.slice(-300));
  reportMd = r.out;
  check('says PLANTED, verbatim from the mission', reportMd.includes('PLANTED fixture'));
  check('lists the harness digest', reportMd.includes(experiment.harnessDigest));
  check('lists every result digest', experiment.executions.every((x) => reportMd.includes(x.digest)));
  check('shows the dispute and its resolution', /Disputes \(1\)/.test(reportMd) && /now CONFIRMED/.test(reportMd));
  check('shows the unknown cost as unknown', /cost unknown/.test(reportMd));
  check('never contains the environment secret', !reportMd.includes('SECRET_MOCK_TOKEN'));
}

section('export, then replay on a fresh output directory');
const recording = path.join(tmp, 'recording.json');
{
  const r = run(['mission', 'export', prepared.missionId, '--out', out, '--file', recording, '--format', 'json']);
  check('exports', r.code === 0, r.err.slice(-300));
  const file = JSON.parse(fs.readFileSync(recording, 'utf8')) as { claims: unknown[]; artifacts: Record<string, unknown>; events: unknown[] };
  check('the recording carries the in-scope claims', file.claims.length === 3, String(file.claims.length));
  check('and every artifact the mission names', Object.keys(file.artifacts).length >= 12, String(Object.keys(file.artifacts).length));

  const out2 = path.join(tmp, 'out2');
  const repo2 = path.join(tmp, 'repo2');
  const replay = run(['demo', 'replay', '--out', out2, '--dest', repo2, '--recording', recording, '--format', 'json']);
  check('replays', replay.code === 0, replay.err.slice(-500));
  const replayed = json<{ mission: Mission; added: Record<string, number>; skipped: Record<string, number> }>(replay);
  check('the same mission id', replayed.mission.id === prepared.missionId);
  check('everything added once', replayed.added.events > 0 && replayed.skipped.events === 0 && replayed.added.claims === 3);

  // Sequences are per output directory (the original shares its log with other missions);
  // claim ids are remapped on import, so everything else must agree byte for byte.
  const strip = (v: Inspection) =>
    JSON.stringify(v, (k, x) => (k === 'sequence' ? undefined : x));
  const a = json<Inspection>(run(['mission', 'inspect', prepared.missionId, '--out', out, '--format', 'json']));
  const b = json<Inspection>(run(['mission', 'inspect', prepared.missionId, '--out', out2, '--format', 'json']));
  check('inspect on the replay equals inspect on the original', strip(a) === strip(b),
    strip(a) === strip(b) ? '' : `events ${a.events.length} vs ${b.events.length}, attempts ${a.attempts.length} vs ${b.attempts.length}`);
  check('the replay\'s belief is CONFIRMED too', b.disputes[0]?.status === 'CONFIRMED');
  const store2 = new ArtifactStore(out2);
  check('every artifact is present by digest and verifies', experiment.executions.every((x) => store2.has(x)) && store2.text(experiment.testArtifact).includes('an expired session is not served'));
  const report2 = run(['report', prepared.missionId, '--out', out2]);
  check('the replayed report is the original report', report2.out.replace(/\/repo2\b/g, '/repo') === reportMd.replace(/\/repo\b/g, '/repo'));
  check('and names this machine\'s checkout, not the exporter\'s', report2.out.includes(`\`${repo2}\``), report2.out.split('\n').find((l) => l.includes('**Project.**')));

  const again = run(['mission', 'import', '--out', out2, '--file', recording, '--format', 'json']);
  const second = json<{ added: Record<string, number>; skipped: Record<string, number> }>(again);
  check('re-importing the same recording adds nothing', again.code === 0 && second.added.events === 0 && second.added.claims === 0 && second.skipped.events === a.events.length);
}

section('a recording of one project does not land on another');
{
  const other = path.join(tmp, 'other');
  fs.mkdirSync(path.join(other, 'src'), { recursive: true });
  fs.writeFileSync(path.join(other, 'src', 'index.ts'), 'export const x = 1;\n');
  const out3 = path.join(tmp, 'out3');
  run(['map', other, '--out', out3, '--top', '0']);
  const r = run(['mission', 'import', '--out', out3, '--file', recording]);
  check('import into another project\'s map is refused', r.code === 1 && /Refusing/.test(r.err), r.err.slice(-300));
  const forced = run(['mission', 'import', '--out', out3, '--file', recording, '--force', '--format', 'json']);
  check('--force overrides, explicitly', forced.code === 0 && json<{ mission: Mission }>(forced).mission.id === prepared.missionId);
}

section('an import that disagrees with what is already here says so');
{
  const out2 = path.join(tmp, 'out2');
  const file = JSON.parse(fs.readFileSync(recording, 'utf8')) as {
    mission: Mission; attempts: Array<{ costUsd: number | null }>;
    artifacts: Record<string, { ref: { id: string; digest: string; kind: string } }>;
  };
  file.mission.objective = 'TAMPERED';
  file.attempts[0].costUsd = 9999;
  const tampered = path.join(tmp, 'tampered.json');
  fs.writeFileSync(tampered, JSON.stringify(file));
  const r = run(['mission', 'import', '--out', out2, '--file', tampered, '--format', 'json']);
  check('rows that differ from the ones here are refused', r.code === 1 && /conflict/.test(r.err), r.err.slice(-300));
  const forced = run(['mission', 'import', '--out', out2, '--file', tampered, '--force', '--format', 'json']);
  const result = forced.code === 0 ? json<{ conflicts?: string[] }>(forced) : {};
  check('--force imports anyway and lists every conflict', forced.code === 0
    && ['mission', 'attempt'].every((k) => (result.conflicts ?? []).some((c) => c.startsWith(k))),
    JSON.stringify(result.conflicts));
  check('and keeps what was here', json<Inspection>(run(['mission', 'inspect', prepared.missionId, '--out', out2, '--format', 'json'])).mission.objective !== 'TAMPERED');

  const misfiled = JSON.parse(fs.readFileSync(recording, 'utf8')) as typeof file;
  const [first, second] = Object.keys(misfiled.artifacts);
  misfiled.artifacts[first].ref = { ...misfiled.artifacts[second].ref };
  const misfiledPath = path.join(tmp, 'misfiled.json');
  fs.writeFileSync(misfiledPath, JSON.stringify(misfiled));
  const m = run(['mission', 'import', '--out', path.join(tmp, 'out-misfiled'), '--file', misfiledPath, '--force']);
  check('an artifact whose ref names another digest is refused', m.code === 1 && /does not name/.test(m.err), m.err.slice(-300));
}

section('a reviewer that fails blocks the mission; it does not fail it');
{
  const m = json<Mission>(run(['mission', 'create', repo, '--out', out, '--kind', 'verify', '--objective', 'crash test', '--scope', 'src/session-cache.ts', '--format', 'json']));
  const r = run(['mission', 'run', m.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:crash,mock:yes', '--format', 'json']);
  check('exits 0 — a blocked mission is data', r.code === 0, r.err.slice(-300));
  const report = json<{ mission: Mission; attempts: Inspection['attempts'] }>(r);
  check('the mission is blocked, with the failure as its reason', report.mission.state === 'blocked' && /exit 1/.test(report.mission.outcomeReason ?? ''), report.mission.outcomeReason);
  check('no outcome was recorded', report.mission.outcome === undefined);
  const crashed = report.attempts.find((a) => a.runnerId === 'agent:mock:crash');
  check('the failed attempt says how it failed', crashed?.state === 'failed' && crashed.failure === 'exit 1');
  check('the other reviewer still completed', report.attempts.some((a) => a.runnerId === 'agent:mock:yes' && a.state === 'completed'));
  check('compare did not run on a broken set', !report.attempts.some((a) => a.runnerId === 'static:daylight'));
  const stderrRef = crashed?.artifacts.find((x) => x.label?.startsWith('stderr'));
  const text = stderrRef ? run(['artifact', stderrRef.id, '--out', out]).out : '';
  check('the failed reviewer\'s stderr is kept', text.includes('mock crash'), text.slice(0, 100));
  check('with the secret redacted', !text.includes('SECRET_MOCK_TOKEN') && text.includes('[REDACTED]'), text.slice(0, 120));

  const retry = json<{ mission: Mission; attempts: Inspection['attempts'] }>(run(['mission', 'run', m.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:crash,mock:yes', '--format', 'json']));
  check('a second run retries only the failed task', retry.attempts.filter((a) => a.runnerId === 'agent:mock:crash').length === 2
    && retry.attempts.filter((a) => a.runnerId === 'agent:mock:yes').length === 1);
  check('and is blocked again', retry.mission.state === 'blocked');

  const none = json<{ mission: Mission; unavailable: string[] }>(run(['mission', 'run', m.id, repo, '--out', out, '--tools', 'nosuchtool', '--format', 'json']));
  check('a roster with nothing runnable blocks with a reason', none.mission.state === 'blocked' && /no runnable agent/.test(none.mission.outcomeReason ?? '') && none.unavailable.length === 1);

  const closed = run(['mission', 'close', m.id, '--out', out, '--outcome', 'cancelled', '--reason', 'gave up', '--format', 'json']);
  check('closing needs and records a reason', closed.code === 0 && json<Mission>(closed).outcomeReason === 'gave up');
  const rerun = run(['mission', 'run', m.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:yes']);
  check('a closed mission cannot be run', rerun.code === 1 && /closed/.test(rerun.err), rerun.err.slice(-200));
  const noReason = run(['mission', 'close', prepared.missionId, '--out', out, '--outcome', 'succeeded', '--reason', '  ']);
  check('closing without a reason is refused', noReason.code === 1 && /needs a reason/.test(noReason.err));
}

section('events');
{
  const r = run(['events', '--out', out, '--since', '0', '--mission', prepared.missionId, '--format', 'json']);
  const rows = json<Array<{ sequence: number }>>(r);
  check('events can be read since a sequence', r.code === 0 && rows.length > 10);
  const tail = json<Array<{ sequence: number }>>(run(['events', '--out', out, '--since', String(rows[rows.length - 3].sequence), '--mission', prepared.missionId, '--format', 'json']));
  check('and since the tail returns just what followed', tail.length === 2);
}

section('an empty roster blocks a mission that is already running');
{
  const m = json<Mission>(run(['mission', 'create', repo, '--out', out, '--kind', 'verify', '--objective', 'empty roster', '--scope', 'src/session-cache.ts', '--format', 'json']));
  const first = json<{ mission: Mission }>(run(['mission', 'run', m.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:yes,mock:no', '--format', 'json']));
  check('a finished review leaves the mission running', first.mission.state === 'running');
  const none = run(['mission', 'run', m.id, repo, '--out', out, '--tools', 'nosuchtool', '--format', 'json']);
  check('a roster with nothing runnable still exits 0', none.code === 0, none.err.slice(-300));
  const blocked = none.code === 0 ? json<{ mission: Mission }>(none).mission : null;
  check('and blocks with the reason, rather than failing on running → running',
    blocked?.state === 'blocked' && /no runnable agent/.test(blocked.outcomeReason ?? ''), blocked?.outcomeReason);
  run(['mission', 'close', m.id, '--out', out, '--outcome', 'cancelled', '--reason', 'test only']);
}

section('the budget is the mission\'s, across runs');
{
  const m = json<Mission>(run(['mission', 'create', repo, '--out', out, '--kind', 'verify', '--objective', 'budget across runs',
    '--scope', 'src/session-cache.ts', '--max-cost', '0.05', '--format', 'json']));
  type Ran = { mission: Mission; attempts: Inspection['attempts']; spent: number; costKnown: boolean };
  const first = json<Ran>(run(['mission', 'run', m.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:yes', '--format', 'json']));
  check('the first run spends what its reviewer reported', first.spent === 0.05 && first.costKnown, `${first.spent} ${first.costKnown}`);
  const second = json<Ran>(run(['mission', 'run', m.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:yes,mock:no', '--format', 'json']));
  check('a second run starts from what the mission has already spent', second.spent === 0.05, String(second.spent));
  check('so a spent budget blocks it before launching anyone',
    second.mission.state === 'blocked' && /budget exhausted/.test(second.mission.outcomeReason ?? ''), second.mission.outcomeReason);
  check('and the new reviewer never ran', !second.attempts.some((a) => a.runnerId === 'agent:mock:no'));
  run(['mission', 'close', m.id, '--out', out, '--outcome', 'cancelled', '--reason', 'test only']);
}

section('a ceiling holds under concurrency, unknown spend and a raised flag');
{
  type Ran = { mission: Mission; attempts: Inspection['attempts']; spent: number; costKnown: boolean };
  const mk = (objective: string, maxCost: string) => json<Mission>(run(['mission', 'create', repo, '--out', out, '--kind', 'verify',
    '--objective', objective, '--scope', 'src/session-cache.ts', '--max-cost', maxCost, '--format', 'json']));

  const raise = mk('raise', '0.05');
  const raised = run(['mission', 'run', raise.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:yes', '--max-cost', '1', '--format', 'json']);
  check('--max-cost above the mission\'s budget is refused', raised.code === 1 && /--raise-budget/.test(raised.err), raised.err.slice(-200));
  const allowed = run(['mission', 'run', raise.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:yes', '--max-cost', '1', '--raise-budget', '--format', 'json']);
  check('and allowed when the raise is explicit', allowed.code === 0, allowed.err.slice(-200));

  // Two reviewers that each report $0.05, launched together under a $0.06 ceiling.
  const costly = path.join(tmp, 'mock-costly.mjs');
  fs.writeFileSync(costly, `console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.05 })); setTimeout(() => process.exit(0), 300);\n`);
  const shared = mk('shared ceiling', '0.06');
  const wave = json<Ran>(run(['mission', 'run', shared.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:a,mock:b', '--concurrency', '2', '--format', 'json'],
    { DAYLIGHT_MOCK_ADAPTER: costly }));
  const reviews = wave.attempts.filter((a) => a.runnerId.startsWith('agent:mock:'));
  check('each reviewer in a wave gets its share of the remainder, not all of it',
    reviews.length === 2 && reviews.every((a) => a.failure === 'over budget'), JSON.stringify(reviews.map((a) => a.failure)));

  const unknown = mk('unknown spend', '1');
  const blind = json<Ran>(run(['mission', 'run', unknown.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:no,mock:yes', '--format', 'json']));
  check('an attempt with unknown cost blocks the next wave under a ceiling',
    blind.mission.state === 'blocked' && /unknown/.test(blind.mission.outcomeReason ?? ''), blind.mission.outcomeReason);
  check('so the second reviewer did not run', !blind.attempts.some((a) => a.runnerId === 'agent:mock:yes'));
  for (const m of [raise, shared, unknown]) run(['mission', 'close', m.id, '--out', out, '--outcome', 'cancelled', '--reason', 'test only']);
}

section('a mission compares and exports its own reviewers, not another mission\'s');
{
  // A fresh directory where one mission's two reviewers disagree, and no human has decided.
  const out4 = path.join(tmp, 'out4');
  const repo4 = path.join(tmp, 'repo4');
  const first = json<Prepared>(run(['demo', 'prepare', '--out', out4, '--dest', repo4, '--format', 'json']));
  const a = json<{ comparison: { disputes: unknown[] } }>(run(['mission', 'run', first.missionId, repo4, '--out', out4, '--no-review-sandbox', '--tools', 'mock:yes,mock:no', '--format', 'json']));
  check('the first mission has its dispute', a.comparison.disputes.length === 1);
  // A second mission with a single reviewer has nobody to disagree with.
  const m = json<Mission>(run(['mission', 'create', repo4, '--out', out4, '--kind', 'verify', '--objective', 'one reviewer',
    '--scope', 'src/session-cache.ts', '--format', 'json']));
  const r = json<{ comparison: { disputes: unknown[] } }>(run(['mission', 'run', m.id, repo4, '--out', out4, '--no-review-sandbox', '--tools', 'mock:no', '--format', 'json']));
  check('one reviewer\'s mission records no dispute from another mission\'s reviewers', r.comparison.disputes.length === 0, String(r.comparison.disputes.length));
  const view = json<Inspection>(run(['mission', 'inspect', m.id, '--out', out4, '--format', 'json']));
  check('and inspect agrees', view.disputes.length === 0, String(view.disputes.length));
  check('its own claim is unverified, as a single source is', view.unverified.length === 1, String(view.unverified.length));
  const file = path.join(tmp, 'one-reviewer.json');
  run(['mission', 'export', m.id, '--out', out4, '--file', file]);
  const exported = JSON.parse(fs.readFileSync(file, 'utf8')) as { claims: Claim[] };
  check('its export carries no other mission\'s agent claims',
    exported.claims.every((c) => c.source.kind !== 'agent' || (c.source.sessionId ?? '').startsWith(`${m.id}:`)),
    exported.claims.map((c) => c.source.sessionId ?? c.source.kind).join(' '));
  check('but does carry its own', exported.claims.some((c) => (c.source.sessionId ?? '').startsWith(`${m.id}:`)));

  // The first mission is running with every task done and a dispute open: it is waiting on a
  // person, and the state machine (rightly) has no state for that, so it is derived.
  type Need = { kind: string; ref: string; why: string };
  const disputed = json<Inspection & { needs?: Need[] }>(run(['mission', 'inspect', first.missionId, '--out', out4, '--format', 'json']));
  check('a running mission with an open dispute says it needs a person', disputed.mission.state === 'running'
    && disputed.needs?.length === 1 && disputed.needs[0].kind === 'dispute' && disputed.needs[0].ref.includes('src/session-cache.ts'),
    JSON.stringify(disputed.needs));
  const listed = json<{ missions: Mission[]; needs?: Record<string, Need[]> }>(run(['mission', 'list', '--out', out4, '--format', 'json']));
  check('and the list says so per mission', listed.needs?.[first.missionId]?.[0]?.kind === 'dispute', JSON.stringify(listed.needs));
  check('a mission with nothing open needs nobody', (listed.needs?.[m.id] ?? []).length === 0);

  // out4 already numbers its own claims, so the recording's claims get new ids here. What the
  // recording's rows point at must follow them.
  const imported = run(['mission', 'import', '--out', out4, '--file', recording, '--format', 'json']);
  check('a recording imports into a directory that has claims of its own', imported.code === 0, imported.err.slice(-300));
  const replayed = json<Inspection & { decisions: Array<{ scope: { claimId?: number } }> }>(
    run(['mission', 'inspect', prepared.missionId, '--out', out4, '--format', 'json']));
  const store4 = new ClaimStore(path.join(out4, 'claims.db'));
  const byId = (id: number | undefined) => store4.claimsFor('src/session-cache.ts').find((c) => c.id === id);
  const decided = byId(replayed.decisions[0]?.scope.claimId);
  check('the decision still points at the human claim it recorded', decided?.source.kind === 'human', JSON.stringify(decided?.source));
  const disputedEvent = replayed.events.find((e) => e.name === 'claim.disputed');
  const sides = (disputedEvent?.payload.sides ?? []) as Array<{ claimId: number; source: string }>;
  check('and the dispute event\'s sides point at the reviewers\' claims here',
    sides.length === 2 && sides.every((s) => {
      const c = byId(s.claimId);
      return !!c && `${c.source.kind}:${c.source.tool}:${c.source.model}` === s.source && (c.source.sessionId ?? '').startsWith(`${prepared.missionId}:`);
    }),
    JSON.stringify(sides));
  store4.close();
}

section('a run that dies does not leave an attempt running for ever');
{
  // A reviewer that waits while MOCK_SLOW is set, so the CLI can be killed mid-attempt.
  const slowMock = path.join(tmp, 'mock-slow.mjs');
  fs.writeFileSync(slowMock, `
if (process.env.MOCK_SLOW) { console.log('slow reviewer waiting'); await new Promise((r) => setTimeout(r, 30_000)); }
process.exit(0);
`);
  const m = json<Mission>(run(['mission', 'create', repo, '--out', out, '--kind', 'verify', '--objective', 'crash recovery', '--scope', 'src/session-cache.ts', '--format', 'json']));
  const { spawn } = await import('node:child_process');
  const startSlow = () => spawn(process.execPath, [CLI, 'mission', 'run', m.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:slow', '--format', 'json'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, DAYLIGHT_MOCK_ADAPTER: slowMock, MOCK_SLOW: '1' },
  });
  const untilStarted = (child: ReturnType<typeof startSlow>) => new Promise<void>((resolve) => {
    child.stderr.on('data', (d) => { if (String(d).includes('started')) resolve(); });
    setTimeout(resolve, 20_000);
  });
  const closed = (child: ReturnType<typeof startSlow>) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.on('close', () => resolve());
  });
  const attemptsOf = () => json<Inspection>(run(['mission', 'inspect', m.id, '--out', out, '--format', 'json'])).attempts;

  const stopped = startSlow();
  await untilStarted(stopped);
  const busy = run(['mission', 'run', m.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:slow', '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: slowMock });
  check('a second run of a mission that is being run is refused', busy.code === 1 && /already being run/.test(busy.err), busy.err.slice(-200));
  stopped.kill('SIGTERM');
  await closed(stopped);
  const afterStop = attemptsOf();
  check('stopping the run cancels the attempt it had open', afterStop.length === 1 && afterStop[0].state === 'cancelled'
    && /interrupted/.test(afterStop[0].failure ?? ''), JSON.stringify(afterStop.map((a) => [a.state, a.failure])));

  const crashed = startSlow();
  await untilStarted(crashed);
  crashed.kill('SIGKILL');
  await closed(crashed);
  check('a killed run leaves its attempt running', attemptsOf().filter((a) => a.state === 'running').length === 1);
  const rerun = run(['mission', 'run', m.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:slow', '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: slowMock });
  check('the next run proceeds', rerun.code === 0, rerun.err.slice(-300));
  const after = attemptsOf();
  check('and nothing is left running', after.every((a) => a.state !== 'running'), JSON.stringify(after.map((a) => a.state)));
  check('the orphan is cancelled, saying why', after.filter((a) => a.state === 'cancelled' && /orphaned/.test(a.failure ?? '')).length === 1,
    JSON.stringify(after.map((a) => [a.state, a.failure])));
  check('and the retry completed on the same task', after.filter((a) => a.runnerId === 'agent:mock:slow' && a.state === 'completed').length === 1);
  run(['mission', 'close', m.id, '--out', out, '--outcome', 'cancelled', '--reason', 'test only']);
}

section('usage');
{
  check('a missing subcommand is exit 2', run(['mission', '--out', out]).code === 2);
  check('a missing required flag is exit 2', run(['mission', 'create', repo, '--out', out]).code === 2);
  check('an unknown mission is exit 1', run(['mission', 'inspect', 'm_nope', '--out', out]).code === 1);
}

done();
