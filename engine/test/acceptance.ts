/**
 * The P0 acceptance checklist, spec §13, as named assertions. Run: node engine/test/acceptance.ts
 *
 * One section per checklist item, in the spec's order, each a few assertions deep. The deep
 * coverage lives in the per-workstream tests (`mission-store`, `telemetry`, `experiment`,
 * `orchestrate`, `scene-lifecycle`); this file is the thing a reader checks the release
 * against, so it reads top to bottom like the list it implements and ends with that list.
 *
 * Everything that can go through the CLI does — the argument parsing and JSON shapes are what
 * the shell relies on. The reviewers are mocks, labelled `mock` in every artifact, and nothing
 * here spends money. The sandbox-denied case calls the runner directly because the CLI has no
 * switch for pretending bwrap is absent, and should not have one.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXPECTED_FIXTURE_COMMIT, materialiseFixture } from '../demo/fixture.ts';
import { runExperiment } from '../experiment/runner.ts';
import type { ExecutionRecord } from '../experiment/types.ts';
import { visibleToReviewer } from '../mcp/server.ts';
import { ArtifactStore } from '../mission/artifacts.ts';
import { openDaylight } from '../mission/context.ts';
import { identifyProject } from '../mission/project.ts';
import type { Experiment, Mission } from '../mission/types.ts';
import { planUpdate, type SceneInputs } from '../scene/lifecycle.ts';
import { ClaimStore, EvidenceRequired } from '../store/claims.ts';
import type { Claim } from '../store/types.ts';
import { CLAUDE } from '../swarm/adapters.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const ENGINE = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ENGINE, 'cli.ts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-acceptance-'));
const out = path.join(tmp, 'out');
const repo = path.join(tmp, 'repo');
const mock = path.join(tmp, 'mock-reviewer.mjs');

/** A reviewer that answers `bug_verdict` from its model name and talks to nothing. */
fs.writeFileSync(mock, `
import fs from 'node:fs';
const [cfgPath, prompt] = process.argv.slice(2);
const env = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.daylight.env;
const { DAYLIGHT_DIR, DAYLIGHT_AGENT, DAYLIGHT_MODEL, DAYLIGHT_SESSION } = env;
const { ClaimStore } = await import(${JSON.stringify(path.join(ENGINE, 'store', 'claims.ts'))});
const ev = (tool, extra = {}) => fs.appendFileSync(DAYLIGHT_DIR + '/events.jsonl',
  JSON.stringify({ at: Date.now(), session: DAYLIGHT_SESSION, agent: DAYLIGHT_AGENT, model: DAYLIGHT_MODEL ?? null, tool, ...extra }) + '\\n');
ev('get_overview');
ev('get_slice', { node: 'src/session-cache.ts', hops: 1 });
if (DAYLIGHT_MODEL === 'crash') { console.error('mock reviewer crashed on purpose'); process.exit(1); }
if (DAYLIGHT_MODEL === 'slow') { await new Promise((r) => setTimeout(r, 10_000)); }
const store = new ClaimStore(DAYLIGHT_DIR + '/claims.db');
const source = { kind: 'agent', tool: DAYLIGHT_AGENT, model: DAYLIGHT_MODEL, sessionId: DAYLIGHT_SESSION };
const yes = DAYLIGHT_MODEL === 'yes';
store.submit({
  subject: 'src/session-cache.ts', predicate: 'bug_verdict', value: yes, confidence: yes ? 0.9 : 0.7, source,
  evidence: yes
    ? [{ file: 'src/session-cache.ts', line: 37, note: 'mock: the check after the refresh cannot fire' }]
    : [{ file: 'src/session-cache.ts', line: 34, note: 'mock: sliding expiry' },
       { file: 'src/session-cache.ts', line: 37, note: 'mock: the check guards the refreshed record' }],
});
ev('submit_claim', { ok: true, subject: 'src/session-cache.ts', predicate: 'bug_verdict' });
store.close();
// Named per reviewer: two byte-identical streams would be one content-addressed artifact,
// which is correct and would make "separate artifacts" unobservable here.
console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.01, num_turns: 2, reviewer: DAYLIGHT_MODEL }));
`);

const env = { ...process.env, DAYLIGHT_MOCK_ADAPTER: mock };
const run = (args: string[]): { code: number; out: string; err: string } => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 240_000,
  });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const json = <T>(r: { out: string }): T => JSON.parse(r.out) as T;

interface Inspection {
  mission: Mission;
  tasks: Array<{ id: string; role: string; state: string }>;
  attempts: Array<{
    id: string; runnerId: string; state: string; failure?: string; costUsd: number | null;
    artifacts: Array<{ id: string; label?: string }>;
  }>;
  experiments: Experiment[];
  disputes: Array<{ subject: string; predicate: string; status: string; sides: Array<{ source: string; value: unknown }> }>;
  events: Array<{ sequence: number; name: string; attemptId?: string }>;
}
const inspect = (id: string, dir = out) =>
  json<Inspection>(run(['mission', 'inspect', id, '--out', dir, '--format', 'json']));

const results: Array<[string, boolean]> = [];
const item = (name: string, ok: boolean) => results.push([name, ok]);

// ---- 1. mission create/read/restart ----------------------------------------------------
section('1. mission create / read / restart: ids stable');
const prepared = json<{ root: string; commit: string; projectId: string; missionId: string; experimentId: string }>(
  run(['demo', 'prepare', '--out', out, '--dest', repo, '--format', 'json']),
);
{
  check('the fixture is at its pinned commit', prepared.commit === EXPECTED_FIXTURE_COMMIT);
  const a = inspect(prepared.missionId);
  // "Restart" is a fresh process opening the same directory: every CLI call is one.
  const b = inspect(prepared.missionId);
  check('two separate processes read the same mission, task and experiment ids',
    a.mission.id === b.mission.id && JSON.stringify(a.tasks) === JSON.stringify(b.tasks)
      && a.experiments[0]?.id === b.experiments[0]?.id);
  check('ids are prefixed and opaque',
    /^m_[0-9a-f]{32}$/.test(a.mission.id) && /^x_[0-9a-f]{32}$/.test(a.experiments[0].id));
  item('mission create/read/restart: stable ids', a.mission.id === b.mission.id && a.experiments.length === 1);
}

// ---- 2. run status separation -----------------------------------------------------------
section('2. run status separation: exit 0 is not an outcome');
{
  const r = json<{ mission: Mission; attempts: Inspection['attempts'] }>(
    run(['mission', 'run', prepared.missionId, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:yes,mock:no', '--format', 'json']),
  );
  const reviews = r.attempts.filter((a) => a.runnerId.startsWith('agent:mock:'));
  check('both reviewers exited 0', reviews.length === 2 && reviews.every((a) => a.state === 'completed'));
  check('the mission is running with no outcome', r.mission.state === 'running' && r.mission.outcome === undefined);
  item('exit 0 never closes a mission', r.mission.state === 'running' && r.mission.outcome === undefined);

  const mk = (objective: string, extra: string[] = []) => json<Mission>(run([
    'mission', 'create', repo, '--out', out, '--kind', 'verify', '--objective', objective,
    '--scope', 'src/session-cache.ts', ...extra, '--format', 'json',
  ]));
  const crash = mk('crash');
  const c = json<{ mission: Mission; attempts: Inspection['attempts'] }>(
    run(['mission', 'run', crash.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:crash', '--format', 'json']),
  );
  check('a failed reviewer blocks the mission and says why',
    c.mission.state === 'blocked' && /exit 1/.test(c.mission.outcomeReason ?? ''), c.mission.outcomeReason);
  check('the attempt is failed, with the exit named', c.attempts[0]?.state === 'failed' && c.attempts[0].failure === 'exit 1');

  const slow = mk('timeout');
  const t = json<{ mission: Mission; attempts: Inspection['attempts'] }>(
    run(['mission', 'run', slow.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:slow', '--timeout', '2', '--format', 'json']),
  );
  check('a timed-out reviewer blocks the mission with "timed out"',
    t.mission.state === 'blocked' && /timed out/.test(t.mission.outcomeReason ?? ''), t.mission.outcomeReason);
  check('the attempt says it timed out', t.attempts[0]?.failure === 'timed out', t.attempts[0]?.failure);

  const budget = mk('budget', ['--max-cost', '0.005']);
  const b = json<{ mission: Mission; attempts: Inspection['attempts'] }>(
    run(['mission', 'run', budget.id, repo, '--out', out, '--no-review-sandbox', '--tools', 'mock:yes,mock:no', '--max-cost', '0.005', '--format', 'json']),
  );
  const budgeted = b.mission.state === 'blocked' && /budget|spent/i.test(b.mission.outcomeReason ?? '');
  check('budget exhaustion between launches blocks the mission with the spend named', budgeted, b.mission.outcomeReason);
  item('failed / timed out / budget attempts block with a reason',
    c.mission.state === 'blocked' && t.mission.state === 'blocked' && budgeted);
  for (const m of [crash, slow, budget]) {
    run(['mission', 'close', m.id, '--out', out, '--outcome', 'cancelled', '--reason', 'checklist']);
  }
}

// ---- 3. cross-project isolation --------------------------------------------------------
section('3. cross-project isolation');
const recording = path.join(tmp, 'recording.json');
{
  const twin = materialiseFixture(path.join(tmp, 'twin'));
  check('the fixture at another path is the same project',
    twin.projectId === prepared.projectId && twin.root !== prepared.root);

  run(['mission', 'export', prepared.missionId, '--out', out, '--file', recording]);
  const other = path.join(tmp, 'other');
  fs.mkdirSync(path.join(other, 'src'), { recursive: true });
  fs.writeFileSync(path.join(other, 'src', 'session-cache.ts'),
    'export const same = "relative path, different project";\n');
  const otherOut = path.join(tmp, 'other-out');
  run(['map', other, '--out', otherOut, '--top', '0']);
  const r = run(['mission', 'import', '--out', otherOut, '--file', recording]);
  check('a recording about one project is refused by another project\'s map, same relative path and all',
    r.code === 1 && /Refusing/.test(r.err), r.err.slice(-200));
  check('the other project has a different identity', identifyProject(other).id !== prepared.projectId);
  const otherClaims = new ClaimStore(path.join(otherOut, 'claims.db'));
  check('and no claim about src/session-cache.ts landed there',
    otherClaims.claimsFor('src/session-cache.ts').length === 0);
  otherClaims.close();
  item('cross-project isolation: same relative path cannot cross repositories', r.code === 1);
}

// ---- 4. claim provenance ---------------------------------------------------------------
section('4. claim provenance unchanged');
{
  const store = new ClaimStore(path.join(tmp, 'prov.db'));
  let rejected = false;
  try {
    store.submit({
      subject: 'a.ts', predicate: 'purpose', value: 'x', confidence: 1, evidence: [],
      source: { kind: 'agent', tool: 'mock' },
    });
  } catch (e) {
    rejected = e instanceof EvidenceRequired;
  }
  check('a claim without evidence is rejected at ingress', rejected);
  store.submit({
    subject: 'a.ts', predicate: 'bug_verdict', value: true, confidence: 0.8,
    evidence: [{ file: 'a.ts', line: 1 }], source: { kind: 'agent', tool: 'mock', model: 'yes' },
  });
  store.submit({
    subject: 'a.ts', predicate: 'bug_verdict', value: false, confidence: 0.8,
    evidence: [{ file: 'a.ts', line: 1 }, { file: 'a.ts', line: 2 }],
    source: { kind: 'agent', tool: 'mock', model: 'no' },
  });
  check('contradictory claims both persist and the belief is CONTRADICTED',
    store.claimsFor('a.ts').length === 2 && store.belief('a.ts', 'bug_verdict').status === 'CONTRADICTED');
  store.close();
  const types = fs.readFileSync(path.join(ENGINE, 'store', 'types.ts'), 'utf8');
  const literals = ['UNKNOWN', 'INFERRED', 'CORROBORATED', 'CONTRADICTED', 'CONFIRMED', 'STALE'];
  const enumBlock = types.slice(types.indexOf('export type ClaimStatus'), types.indexOf('export interface Belief'));
  const untouched = literals.every((l) => enumBlock.includes(`'${l}'`))
    && (enumBlock.match(/'[A-Z]+'/g) ?? []).length === 6;
  check('the ClaimStatus enum still has exactly its six literals', untouched, enumBlock.replace(/\s+/g, ' '));
  item('claim provenance: evidence at ingress, contradictions kept, enum unchanged', rejected && untouched);
}

// ---- 5. blind review --------------------------------------------------------------------
section('5. blind review');
{
  const claim = (sessionId: string | undefined, kind: 'agent' | 'human' = 'agent'): Claim => ({
    id: 1, subject: 's', predicate: 'p', value: true, confidence: 1, evidence: [], at: 0,
    source: { kind, tool: 'mock', model: 'm', sessionId },
  });
  const a = claim(`${prepared.missionId}:t_a:a1`);
  const b = claim(`${prepared.missionId}:t_b:a1`);
  const seenByB = visibleToReviewer([a, b, claim(undefined, 'human')], prepared.missionId, b.source.sessionId!);
  const blind = !seenByB.includes(a) && seenByB.includes(b) && seenByB.length === 2;
  check('reviewer B\'s view excludes reviewer A\'s claim and keeps its own and the human\'s', blind);
  const cfg = JSON.parse(fs.readFileSync(path.join(out, `mcp.mock-no.${prepared.missionId}.json`), 'utf8'));
  const plumbed = cfg.mcpServers.daylight.env.DAYLIGHT_BLIND_PREFIX === prepared.missionId;
  check('the run handed each reviewer the blind prefix through its MCP config', plumbed);
  item('blind review: B\'s initial input excludes A\'s conclusions', blind && plumbed);
}

// ---- 6. experiment ----------------------------------------------------------------------
section('6. experiment: red, green, flaky, invalid, timeout, denied');
let redExperiment: Experiment;
{
  const artifacts = new ArtifactStore(out);
  const records = (x: Experiment) => x.executions.map((ref) => JSON.parse(artifacts.text(ref)) as ExecutionRecord);
  const propose = (name: string, source: string, flags: string[]) => {
    const file = path.join(tmp, `${name}.test.js`);
    fs.writeFileSync(file, source);
    const r = run([
      'experiment', 'propose', prepared.missionId, '--out', out, '--subject', 'src/session-cache.ts',
      '--predicate', 'bug_verdict', '--hypothesis', `checklist ${name}`, '--test', file,
      '--test-path', `test/${name}.test.js`, ...flags, '--format', 'json',
    ]);
    return r.code === 0 ? json<Experiment>(r) : null;
  };
  const runX = (x: Experiment, flags: string[] = []) =>
    json<Experiment>(run(['experiment', 'run', x.id, repo, '--out', out, ...flags, '--format', 'json']));

  redExperiment = runX(inspect(prepared.missionId).experiments[0]);
  const red = records(redExperiment);
  check('known red: the planted test fails, the hypothesis is supported', redExperiment.conclusion === 'supported');
  check('with logs and digests on every run',
    red.every((e) => e.stdoutRef && e.stderrRef && e.harnessDigest === redExperiment.harnessDigest));

  const green = runX(propose('green', 'process.exit(0);\n', ['--expect-exit', '0', '--command', 'node,test/green.test.js'])!);
  check('known green: a passing test with prediction exit 0 is supported', green.conclusion === 'supported', green.conclusion);
  const greenWrong = runX(propose('green-wrong', 'process.exit(0);\n', ['--expect-exit', '1', '--command', 'node,test/green-wrong.test.js'])!);
  check('and predicted to fail, it is falsified — not quietly matched', greenWrong.conclusion === 'falsified', greenWrong.conclusion);

  const flaky = runX(propose('flaky', 'process.exit(Number(process.env.DAYLIGHT_RUN_INDEX) % 2);\n',
    ['--expect-exit', '1', '--command', 'node,test/flaky.test.js'])!);
  check('flaky: one match and one miss conclude inconclusive', flaky.conclusion === 'inconclusive'
    && new Set(records(flaky).map((e) => e.matchesPrediction)).size === 2, flaky.conclusion);

  const invalidCmd = propose('invalid', 'process.exit(1);\n', ['--expect-exit', '1', '--command', 'python3,test/invalid.test.js']);
  check('invalid harness: a command off the allowlist is refused at proposal', invalidCmd === null);

  // The tamper case: the test path already holds different content in the worktree.
  const collide = propose('collide', 'process.exit(1);\n',
    ['--expect-exit', '1', '--command', 'node,src/session-cache.ts', '--test-path', 'src/session-cache.ts']);
  const collided = collide ? runX(collide) : null;
  check('tamper: a test path already holding different content is invalid, nothing runs',
    collided?.conclusion === 'invalid' && records(collided).every((e) => e.status === 'invalid'), collided?.conclusion);
  const clean = runX(propose('clean', 'process.exit(1);\n', ['--expect-exit', '1', '--command', 'node,test/clean.test.js'])!);
  check('while a clean path at the same revision runs fine', clean.conclusion === 'supported');

  const slow = runX(propose('slow', 'setTimeout(() => process.exit(1), 10000);\n',
    ['--expect-exit', '1', '--command', 'node,test/slow.test.js'])!, ['--timeout', '2', '--runs', '1']);
  check('timeout: a hung test is inconclusive and recorded as timed out',
    slow.conclusion === 'inconclusive' && records(slow)[0].status === 'timeout', slow.conclusion);

  const ctx = openDaylight(out);
  const deniedX = ctx.store.experiment(clean.id)!;
  const denied = await runExperiment({ ...deniedX, executions: [], conclusion: 'pending' }, {
    repoRoot: repo, store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, runs: 1,
    sandbox: { name: 'bwrap', available: false, why: 'forced off by the checklist' },
  });
  ctx.close();
  check('denied: without a sandbox the experiment is invalid and nothing is spawned',
    denied.conclusion === 'invalid' && records(denied)[0].status === 'denied'
      && denied.limitations.some((l) => /sandbox unavailable/.test(l)));

  item('experiment: red / green / flaky / invalid / timeout / denied conclude honestly',
    redExperiment.conclusion === 'supported' && green.conclusion === 'supported'
      && greenWrong.conclusion === 'falsified' && flaky.conclusion === 'inconclusive' && invalidCmd === null
      && collided?.conclusion === 'invalid' && slow.conclusion === 'inconclusive' && denied.conclusion === 'invalid');
}

// ---- 7. authorisation -------------------------------------------------------------------
section('7. authorisation');
{
  const argv = CLAUDE.argv({ prompt: 'p', cwd: repo, mcpConfigPath: '/dev/null', session: 's' });
  const allow = argv[argv.indexOf('--allowedTools') + 1] ?? '';
  const readOnly = /\bRead\b/.test(allow) && !/\b(Write|Edit|Bash|MultiEdit|NotebookEdit)\b/.test(allow)
    && !argv.some((a) => a.includes('dangerously') || a.includes('always-approve'));
  check('the claude adapter allows only read tools and the MCP tools, and no bypass flag', readOnly, allow);
  const swarm = fs.readdirSync(path.join(ENGINE, 'swarm'))
    .map((f) => fs.readFileSync(path.join(ENGINE, 'swarm', f), 'utf8')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('no adapter source passes a dangerous flag outside its comments', !/--dangerously|always-approve/.test(swarm));

  const audit = json<Mission>(run(['mission', 'create', repo, '--out', out, '--kind', 'audit', '--objective', 'audit', '--format', 'json']));
  const r = run([
    'experiment', 'propose', audit.id, '--out', out, '--subject', 'src/session-cache.ts', '--predicate', 'bug_verdict',
    '--hypothesis', 'h', '--test', path.join(repo, 'test', 'session-cache.test.js'),
    '--test-path', 'test/session-cache.test.js', '--expect-exit', '1',
  ]);
  check('a mission without execute permission cannot propose or run an experiment', r.code === 1 && /execute permission/.test(r.err));
  run(['mission', 'close', audit.id, '--out', out, '--outcome', 'cancelled', '--reason', 'checklist']);

  const test = new ArtifactStore(out).text(redExperiment.testArtifact);
  const protectedTest = test.includes('an expired session is not served') && !fs.existsSync(path.join(repo, 'artifacts'));
  check('the protected test is an artifact outside the repository the author side sees', protectedTest);
  item('authorisation: read-only reviewers, protected acceptance, execute is a grant', readOnly && r.code === 1 && protectedTest);
}

// ---- 8. stream / replay -----------------------------------------------------------------
section('8. stream and replay');
{
  const view = inspect(prepared.missionId);
  const reviews = view.attempts.filter((a) => a.runnerId.startsWith('agent:mock:'));
  const logs = reviews.map((a) => a.artifacts.filter((x) => x.label?.startsWith('stdout')).map((x) => x.id));
  const separate = logs.length === 2 && !!logs[0][0] && !!logs[1][0] && logs[0][0] !== logs[1][0];
  check('two attempts keep separate stdout artifacts', separate);
  const perAttempt = reviews.map((a) => view.events.filter((e) => e.attemptId === a.id).length);
  check('each attempt has its own event stream', perAttempt.every((n) => n >= 5), perAttempt.join(','));
  check('a provider that reported cost has it', reviews.every((a) => a.costUsd === 0.01));

  run(['mission', 'export', prepared.missionId, '--out', out, '--file', recording]);
  const out2 = path.join(tmp, 'out2');
  const replay = run(['demo', 'replay', '--out', out2, '--dest', path.join(tmp, 'repo2'), '--recording', recording, '--format', 'json']);
  check('a recording replays into a fresh directory', replay.code === 0, replay.err.slice(-300));
  const strip = (v: Inspection) =>
    JSON.stringify(v, (k, x) => (k === 'claimId' || k === 'sequence' || (k === 'id' && typeof x === 'number') ? undefined : x));
  const same = strip(inspect(prepared.missionId)) === strip(inspect(prepared.missionId, out2));
  check('inspect on the replay equals inspect on the original', same);
  item('stream/replay: separate attempt streams, restart and replay reproduce state', separate && same);
}

// ---- 9. scene stability -----------------------------------------------------------------
section('9. scene stability (lifecycle classes; the live WebGL counter is measured by engine/bench/daylight.ts)');
{
  const base: SceneInputs = {
    repo: '/r', stack: {}, fileEdges: [], mode: 'graph', lod: 'all', expanded: new Set(), symbols: {}, moved: {},
    allLevelsLimit: 500, channel: 'structure', flagged: new Set(), defended: [],
  };
  const recolor = planUpdate(base, { ...base, channel: 'belief' }) === 'recolor'
    && planUpdate(base, { ...base, flagged: new Set() }) === 'recolor';
  const rebuild = planUpdate(base, { ...base, repo: '/other' }) === 'rebuild';
  check('a lens or claim-colour change is a recolor, never a rebuild', recolor);
  check('a project switch is a rebuild', rebuild);
  check('a new stack is a relayout', planUpdate(base, { ...base, stack: {} }) === 'relayout');
  item('scene stability: colours/selection/overlay never recreate the renderer; project switch does', recolor && rebuild);
}

// ---- 10. projection correctness --------------------------------------------------------
section('10. projection correctness');
{
  const graph = JSON.parse(fs.readFileSync(path.join(out, 'graph.json'), 'utf8')) as { nodes: Array<{ id: string }> };
  const ids = new Set(graph.nodes.map((n) => n.id));
  const view = inspect(prepared.missionId);
  const grounded = view.disputes.length === 1 && view.disputes.every((d) => ids.has(d.subject))
    && view.experiments.every((x) => ids.has(x.subject));
  check('every dispute and experiment names a node the map actually has', grounded);
  check('the dispute carries both sides with distinct values', new Set(view.disputes[0].sides.map((s) => s.value)).size === 2);
  item('projection correctness: no phantom subjects', grounded);
}

// ---- 11. performance ----------------------------------------------------------------------
section('11. performance');
{
  const measured = path.join(ENGINE, '..', 'docs', 'daylight', 'MEASURED.md');
  const text = fs.existsSync(measured) ? fs.readFileSync(measured, 'utf8') : '';
  const has = /GPU/.test(text) && /p95/.test(text) && /peak RSS/i.test(text);
  check('MEASURED.md records GPU, p95 and peak RSS (written by engine/bench/daylight.ts)', has);
  item('performance: machine, GPU, index timing, peak memory, p95 recorded', has);
}

console.log('\nP0 acceptance checklist');
for (const [name, ok] of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
done();
