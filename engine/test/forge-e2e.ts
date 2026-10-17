/**
 * The Forge end to end, through the CLI. Run: node engine/test/forge-e2e.ts
 *
 * A fixture repository with a bug and a spec goes through every human act and every engine
 * step the P1 loop has: spec → blind decomposer over the attempt socket → work item approved
 * → implement mission → authorize → gate and holdout → baseline → lock → a mock author in the
 * bwrap author profile writes the fix → gates → approve → apply onto a new branch → the
 * project ledger → export, import and replay. Then the refusals: an exec grant, an author who
 * touches a protected path, a decision taken from inside an agent session, and no sandbox.
 *
 * Mocks only: no real provider binary is ever run. bwrap is required: without it this file
 * fails, it does not skip (R15.3), because a Forge without its sandbox is not the thing tested.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSandbox } from '../experiment/sandbox.ts';
import { openDaylight } from '../mission/context.ts';
import type { Attempt, Candidate, Decision, Mission, Need, WorkItem } from '../mission/types.ts';
import { ImplementRefused, runImplement } from '../forge/orchestrate.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const ENGINE = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ENGINE, 'cli.ts');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-forge-e2e-')));
// Workspaces, sockets and spill dirs of this run land here, so "none left" is about this run only.
const privateTmp = path.join(tmp, 'tmp');
fs.mkdirSync(privateTmp, { mode: 0o700 });
process.env.TMPDIR = privateTmp;
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

section('preflight: the sandbox this loop depends on');
const live = detectSandbox();
check('bwrap and prlimit are installed (without them the Forge e2e fails, never skips)', live.available, live.why);
if (!live.available) done();

// ---- the child environment ----------------------------------------------------------------

const baseEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) baseEnv[k] = v;
// A decision taken from inside an agent session is refused; this test is the human.
delete baseEnv.CLAUDECODE;
delete baseEnv.DAYLIGHT_SESSION;
delete baseEnv.DAYLIGHT_MOCK_ADAPTER;
baseEnv.TMPDIR = privateTmp;
delete baseEnv.XDG_RUNTIME_DIR;

const run = (args: string[], o: Record<string, string | undefined> = {}): { code: number; out: string; err: string } => {
  const env = { ...baseEnv };
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 300_000 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const json = <T>(r: { out: string; err: string }): T => {
  try {
    return JSON.parse(r.out) as T;
  } catch {
    throw new Error(`not JSON: ${r.out.slice(0, 400)} ${r.err.slice(-600)}`);
  }
};
const ACTOR = `human:${os.userInfo().username}`;
const SENTINEL = 'HOLDOUT_SENTINEL_q8v3k2';

// ---- the fixture --------------------------------------------------------------------------

const repo = path.join(tmp, 'repo');
const out = path.join(tmp, 'out');
const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
  encoding: 'utf8', env: { ...baseEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
}).trim();
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src', 'add.js'), 'module.exports = (a, b) => a - b;\n');
fs.writeFileSync(path.join(repo, 'package.json'), '{ "name": "fixture", "private": true }\n');
fs.writeFileSync(path.join(repo, 'docs', 'spec.md'), '# Calculator\n\n## Add\n\n`add(a, b)` returns the sum of `a` and `b`.\n');
git(['init', '-q', '-b', 'main']);
git(['add', '-A']);
git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@daylight.invalid', 'commit', '-q', '-m', 'fixture with a bug']);
const base = git(['rev-parse', 'HEAD']);

const GATE_TEST = [
  "const test = require('node:test');", "const assert = require('node:assert');",
  "const add = require('../../src/add.js');", "test('adds small numbers', () => assert.strictEqual(add(2, 3), 5));", '',
].join('\n');
const HOLDOUT_TEST = [
  "const test = require('node:test');", "const assert = require('node:assert');",
  "const add = require('../../src/add.js');", `test('${SENTINEL} adds a negative', () => assert.strictEqual(add(10, -4), 6));`, '',
].join('\n');
fs.writeFileSync(path.join(tmp, 'add.test.js'), GATE_TEST);
fs.writeFileSync(path.join(tmp, 'holdout.test.js'), HOLDOUT_TEST);

/** An agent that speaks MCP over the shim its config names: initialize, list, then each call. */
const mcpMock = (calls: unknown[], tokenOverride?: string) => `'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).mcpServers.daylight;
const env = { ...process.env, ...cfg.env${tokenOverride ? `, DAYLIGHT_MCP_TOKEN: ${JSON.stringify(tokenOverride)}` : ''} };
const child = spawn(cfg.command, cfg.args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
const calls = ${JSON.stringify(calls)};
const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ...calls.map((c, i) => ({ jsonrpc: '2.0', id: 3 + i, method: 'tools/call', params: c })),
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
    if (Object.keys(replies).length === want) { console.log(JSON.stringify(replies)); process.exit(0); }
  }
});
child.on('exit', (code) => { console.log(JSON.stringify({ shimExit: code, replies })); process.exit(0); });
pump();
setTimeout(() => { console.log(JSON.stringify({ timeout: true, replies })); process.exit(0); }, 20000).unref();
`;
const proposal = {
  anchor: '#add', title: 'Make add return the sum', statement: 'add(a, b) returns a + b for every pair of numbers.',
  examples: ['add(2, 3) is 5'], negativeExamples: ['add(2, 3) is -1'], touches: ['src/add.js'],
};
const decomposer = path.join(tmp, 'mock-decompose.cjs');
fs.writeFileSync(decomposer, mcpMock([{ name: 'propose_work_item', arguments: proposal }]));
const forger = path.join(tmp, 'mock-decompose-forged-token.cjs');
fs.writeFileSync(forger, mcpMock([{ name: 'propose_work_item', arguments: { ...proposal, title: 'Forged' } }], 'f'.repeat(64)));

/** An author: writes what it is told under /work and claims success whatever it did. */
const author = (writes: Record<string, string>) => `'use strict';
const fs = require('node:fs');
const path = require('node:path');
for (const [rel, text] of Object.entries(${JSON.stringify(writes)})) {
  fs.mkdirSync(path.dirname(path.join('/work', rel)), { recursive: true });
  fs.writeFileSync(path.join('/work', rel), text);
}
console.log('all tests pass; I fixed it');
`;
const fixer = path.join(tmp, 'mock-author-fix.cjs');
fs.writeFileSync(fixer, author({ 'src/add.js': 'module.exports = (a, b) => a + b;\n' }));
const protectedEdit = path.join(tmp, 'mock-author-protected.cjs');
fs.writeFileSync(protectedEdit, author({
  'src/add.js': 'module.exports = (a, b) => a + b;\n',
  'package.json': '{ "name": "fixture", "private": true, "scripts": { "postinstall": "node -e 1" } }\n',
}));

const confirmOf = (op: string, subject: string, extra: string[] = []) =>
  json<{ digest: string; digest8: string; lines: string[]; refusal: string | null }>(
    run(['confirm', op, subject, '--out', out, ...extra, '--format', 'json']));
const inspect = (id: string) => json<Record<string, unknown> & {
  mission: Mission; attempts: Attempt[]; decisions: Decision[]; needs: Need[]; candidates: Candidate[];
  events: Array<{ name: string; attemptId?: string; payload: Record<string, unknown> }>;
}>(run(['mission', 'inspect', id, '--out', out, '--format', 'json']));
const kinds = (needs: Need[]) => needs.map((n) => n.kind);
const repoState = () => ({
  head: git(['rev-parse', 'HEAD']), branch: git(['symbolic-ref', 'HEAD']), status: git(['status', '--porcelain', '--untracked-files=all']),
  index: fs.readFileSync(path.join(repo, '.git', 'index')).toString('hex'), add: fs.readFileSync(path.join(repo, 'src', 'add.js'), 'utf8'),
});
const workspacesLeft = () => fs.readdirSync(privateTmp).filter((n) => n.startsWith('daylight-forge-'));

section('map, register the spec, decompose it blind over the attempt socket');
let workItem!: WorkItem;
let specMission!: Mission;
{
  const mapped = run(['map', repo, '--out', out, '--top', '0']);
  check('the fixture maps', mapped.code === 0, mapped.err.slice(-300));
  const reg = json<{ mission: Mission; specRevision: string }>(run(['spec', 'register', repo, '--file', 'docs/spec.md', '--out', out, '--format', 'json']));
  specMission = reg.mission;
  check('spec register makes a ready spec mission', specMission.kind === 'spec' && specMission.state === 'ready', JSON.stringify(specMission).slice(0, 200));

  const forged = run(['spec', 'decompose', specMission.id, repo, '--tools', 'mock:forged', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: forger });
  const fr = json<{ proposed: WorkItem[] }>(forged);
  check('a decomposer presenting another token is refused by the socket: nothing is proposed', forged.code === 0 && fr.proposed.length === 0, forged.out.slice(0, 300) + forged.err.slice(-300));

  const r = run(['spec', 'decompose', specMission.id, repo, '--tools', 'mock', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: decomposer });
  const d = json<{ proposed: WorkItem[]; refused: unknown[]; needs: Need[] }>(r);
  check('the decomposer\'s one proposal crossed the socket and became one proposed work item',
    r.code === 0 && d.proposed.length === 1 && d.proposed[0].status === 'proposed' && d.proposed[0].anchor === '#add', r.out.slice(0, 400) + r.err.slice(-400));
  workItem = d.proposed[0];
  check('and a work-item-undecided need names it', d.needs.some((n) => n.kind === 'work-item-undecided' && n.ref === workItem?.id), JSON.stringify(d.needs));
  const view = inspect(specMission.id);
  const dec = view.attempts.filter((a) => a.runnerId.startsWith('agent:mock'));
  check('decompose attempts ran under the review profile with no network and no write',
    dec.length === 2 && dec.every((a) => a.sandbox?.profile === 'review' && a.sandbox.network === 'none' && !a.sandbox.write && !a.sandbox.exec),
    JSON.stringify(dec.map((a) => a.sandbox)));
  check('no compare task on a spec mission', !(view.tasks as Array<{ role: string }>).some((t) => t.role === 'compare'));
}

section('approve the work item: refused from an agent session, recorded as the OS user otherwise');
let implement!: Mission;
{
  const c = confirmOf('approve-work-item', workItem.id);
  const agent = run(['work-item', 'approve', workItem.id, '--out', out, '--rationale', 'r', '--confirm', c.digest8], { CLAUDECODE: '1' });
  check('with CLAUDECODE set the approval is refused', agent.code === 1 && /CLAUDECODE/.test(agent.err), agent.err.slice(-200));
  check('confirm says why before any dialog', confirmOf('approve-work-item', workItem.id).refusal === null
    && json<{ refusal: string | null }>(run(['confirm', 'approve-work-item', workItem.id, '--out', out, '--format', 'json'], { CLAUDECODE: '1' })).refusal !== null);
  const other = run(['work-item', 'approve', workItem.id, '--out', out, '--rationale', 'r', '--confirm', c.digest8, '--actor', 'human:someone-else-entirely']);
  check('naming an actor other than the OS user is refused', other.code === 2, other.err.slice(-200));
  const ok = json<{ workItem: WorkItem; decision: Decision }>(run(['work-item', 'approve', workItem.id, '--out', out, '--rationale', 'the spec says sum', '--confirm', c.digest8, '--format', 'json']));
  check('approved by the OS user', ok.workItem.status === 'approved' && ok.decision.actor === ACTOR, JSON.stringify(ok).slice(0, 200));

  implement = json<Mission>(run(['mission', 'create', repo, '--kind', 'implement', '--work-item', workItem.id, '--out', out, '--format', 'json']));
  check('the implement mission is a draft without write, at the base commit',
    implement.state === 'draft' && !implement.permissions.write && implement.baseRevision === base && implement.workItemId === workItem.id, JSON.stringify(implement).slice(0, 300));
  check('and needs a person to authorize it', kinds(inspect(implement.id).needs).includes('mission-awaiting-authorize'));
}

section('authorize: exec is refused (R15.5), write is granted');
let authorizeId = '';
{
  const ex = confirmOf('authorize-mission', implement.id, ['--write', '--execute']);
  check('confirm refuses an exec grant before any dialog', !!ex.refusal && /R9\.2/.test(ex.refusal), String(ex.refusal));
  const exr = run(['mission', 'authorize', implement.id, '--out', out, '--write', '--execute', '--rationale', 'r', '--confirm', ex.digest8]);
  check('and mission authorize --execute is refused', exr.code === 1 && /R9\.2/.test(exr.err), exr.err.slice(-200));
  check('leaving the mission a draft without write', inspect(implement.id).mission.state === 'draft' && !inspect(implement.id).mission.permissions.write);
  const c = confirmOf('authorize-mission', implement.id, ['--write']);
  const m = json<Mission>(run(['mission', 'authorize', implement.id, '--out', out, '--write', '--rationale', 'build the approved item', '--confirm', c.digest8, '--format', 'json']));
  check('authorized: ready with write, never execute', m.state === 'ready' && m.permissions.write && !m.permissions.execute, JSON.stringify(m.permissions));
  const v = inspect(implement.id);
  authorizeId = v.decisions.find((d) => d.scope.operation === 'authorize-mission')?.id ?? '';
  check('mission.authorized names the decision', v.events.some((e) => e.name === 'mission.authorized' && e.payload.decisionId === authorizeId) && !!authorizeId);
}

section('gates: a gate and a holdout, both failing on the base, then locked');
let gateSetDigest = '';
{
  const add = (role: string, file: string) => run(['gate', 'add', implement.id, '--role', role, '--test', file, '--expect-exit', '0',
    '--expect-stdout', '# fail 0', '--name', 'add.test.js', '--out', out, '--format', 'json']);
  const g = add('gate', path.join(tmp, 'add.test.js'));
  const h = add('holdout', path.join(tmp, 'holdout.test.js'));
  check('gate and holdout registered', g.code === 0 && h.code === 0, g.err.slice(-200) + h.err.slice(-200));
  const b = json<Array<{ conclusion: string }>>(run(['gate', 'baseline', implement.id, repo, '--out', out, '--format', 'json']));
  check('both fail on the base', b.length === 2 && b.every((x) => x.conclusion === 'falsified'), JSON.stringify(b.map((x) => x.conclusion)));
  check('and a gate-lock need appears', kinds(inspect(implement.id).needs).includes('gate-lock'));
  const c = confirmOf('lock-gates', implement.id);
  const locked = run(['gate', 'lock', implement.id, '--out', out, '--rationale', 'these define done', '--confirm', c.digest8, '--format', 'json']);
  const d = json<Decision>(locked);
  gateSetDigest = String(d.scope.gateSetDigest);
  check('locked the full set the preview showed, as the OS user', locked.code === 0 && gateSetDigest === c.digest && d.actor === ACTOR, locked.err.slice(-200));
  check('the gate-lock need is gone', !kinds(inspect(implement.id).needs).includes('gate-lock'));
}

section('forge run: a mock author in the author profile writes the fix');
let candidate!: Candidate;
{
  const before = repoState();
  const r = run(['forge', 'run', implement.id, repo, '--tools', 'mock', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: fixer });
  const res = json<{ candidate: Candidate; verdict: string; attempt: Attempt; needs: Need[] }>(r);
  candidate = res.candidate;
  check('the candidate is accepted by the gates', r.code === 0 && res.verdict === 'accepted-by-gates', `${res.verdict} ${JSON.stringify(res.candidate?.verdictReasons)} ${r.err.slice(-500)}`);
  check('the attempt was an authorized author: write, no exec, no network, its decision named',
    res.attempt.sandbox?.profile === 'author' && res.attempt.sandbox.write && !res.attempt.sandbox.exec
    && res.attempt.sandbox.network === 'none' && res.attempt.sandbox.authorizeDecisionId === authorizeId, JSON.stringify(res.attempt.sandbox));
  check('it is stamped with the locked gate set, as is the candidate', res.attempt.gateSetDigest === gateSetDigest && candidate.gateSetDigest === gateSetDigest);
  check('the mock\'s cost is unknown, not zero', res.attempt.costUsd === null);
  const v = inspect(implement.id);
  const names = v.events.filter((e) => e.attemptId === res.attempt.id).map((e) => e.name);
  check('workspace created and removed, candidate recorded', names.includes('forge.workspace.created') && names.includes('forge.workspace.removed') && names.includes('forge.candidate.recorded'), names.join(','));
  check('no workspace is left behind', workspacesLeft().length === 0, workspacesLeft().join(','));
  const after = repoState();
  check('the real checkout is untouched: HEAD, branch, index, status and files', JSON.stringify(after) === JSON.stringify(before));
  check('the narrative is labelled author-claimed, unverified', candidate.narrativeArtifact?.label === 'narrative (author-claimed, unverified)');

  const d = openDaylight(out);
  try {
    const prompt = d.store.attempt(res.attempt.id)!.artifacts.find((a) => a.label === 'prompt')!;
    const text = d.artifacts.text(prompt);
    const holdout = d.store.experimentsFor(implement.id, 'holdout')[0];
    check('the author prompt carries the work item and the gate test', text.includes(proposal.statement) && text.includes("add(2, 3), 5"));
    check('and nothing of the holdout: not its text, id or path', !text.includes(SENTINEL) && !text.includes(holdout.id) && !text.includes(holdout.testArtifact.path!));
  } finally {
    d.close();
  }
}

section('inspect and candidate: Forge rows and needs, holdout content withheld');
{
  const raw = run(['mission', 'inspect', implement.id, '--out', out, '--format', 'json']).out;
  const v = JSON.parse(raw) as Record<string, unknown>;
  check('the holdout sentinel is absent from inspect', !raw.includes(SENTINEL));
  const keys = ['mission', 'tasks', 'attempts', 'experiments', 'decisions', 'disputes', 'events', 'needs', 'candidates', 'gateEvaluations', 'applications'];
  check('inspect carries every key the UI reads (WS9 MissionInspect)', keys.every((k) => k in v), keys.filter((k) => !(k in v)).join(','));
  check('a candidate-decision need names the candidate', (v.needs as Need[]).some((n) => n.kind === 'candidate-decision' && n.ref === candidate.id));
  const xs = v.experiments as Array<Record<string, unknown>>;
  const h = xs.find((x) => x.role === 'holdout')!;
  check('the holdout row keeps only id, role, conclusion, harness and lock', !!h && h.withheld === true && !('hypothesis' in h) && !('command' in h) && !('testArtifact' in h) && !('prediction' in h));
  const craw = run(['forge', 'candidate', candidate.id, '--out', out, '--max-bytes', '100000', '--format', 'json']).out;
  const cv = JSON.parse(craw) as { candidate: Candidate; diff: { text: string; truncated: boolean }; gateEvaluations: Array<{ executions: unknown[] }> };
  check('forge candidate shows the diff, the candidate and its evaluations', cv.diff.text.includes('a + b') && !cv.diff.truncated && cv.candidate.id === candidate.id && cv.gateEvaluations.length === 2);
  check('the holdout sentinel is absent from forge candidate', !craw.includes(SENTINEL));
}

section('close before apply is refused; approve, apply, close');
{
  const early = run(['mission', 'close', implement.id, '--out', out, '--outcome', 'succeeded', '--reason', 'gates pass']);
  check('closing as succeeded before an application is refused (exit 1)', early.code === 1 && /applied/.test(early.err), early.err.slice(-200));

  const before = repoState();
  const c = confirmOf('approve-candidate', candidate.id);
  const ap = run(['forge', 'approve', candidate.id, '--out', out, '--rationale', 'gates pass and the diff is right', '--confirm', c.digest8, '--format', 'json']);
  check('approved as the OS user', ap.code === 0 && json<Decision>(ap).actor === ACTOR, ap.err.slice(-300));
  check('an apply need appears', kinds(inspect(implement.id).needs).includes('apply'));
  const a = confirmOf('apply', candidate.id);
  const applied = run(['forge', 'apply', candidate.id, repo, '--out', out, '--confirm', a.digest8, '--format', 'json']);
  const res = json<{ ref: string; commit: string }>(applied);
  check('apply wrote a commit on a new ref', applied.code === 0 && /^refs\/heads\/daylight\//.test(res.ref) && /^[0-9a-f]{40}$/.test(res.commit), applied.err.slice(-300));
  check('the ref holds the fix on top of the base', git(['rev-parse', `${res.ref}^`]) === base && git(['show', `${res.ref}:src/add.js`]).includes('a + b'));
  check('the base branch, index and working tree are byte-identical', JSON.stringify(repoState()) === JSON.stringify(before));
  const message = git(['log', '-1', '--format=%B', res.ref]);
  const trailers = execFileSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8' });
  check('its trailers parse and name the mission and attempt', trailers.includes(`Daylight-Mission: ${implement.id}`) && /Daylight-Attempt: a_/.test(trailers), trailers);
  check('and carry no dollars or tokens (R4 Q3a)', !/Daylight-Cost|Daylight-Tokens/.test(message));
  const closed = run(['mission', 'close', implement.id, '--out', out, '--outcome', 'succeeded', '--reason', 'applied and merged by hand']);
  check('now the mission closes as succeeded', closed.code === 0, closed.err.slice(-200));
}

section('the project ledger shows the attempt with its cost unknown');
{
  const l = json<{ rows: Array<{ key: string; attempts: number; usdKnown: number | null; usdUnknownCount: number }> }>(
    run(['report', '--project', '--group', 'model', '--out', out, '--format', 'json']));
  const unknown = l.rows.reduce((n, r) => n + r.usdUnknownCount, 0);
  check('rows exist and the unknown spend is counted, not summed as zero', l.rows.length > 0 && unknown >= 1, JSON.stringify(l.rows).slice(0, 400));
  const text = run(['report', '--project', '--out', out]).out;
  check('the text ledger says unknown', /unknown/.test(text), text.slice(0, 400));
}

section('export, import into a fresh directory, replay');
{
  const fileA = path.join(tmp, 'spec.json');
  const fileB = path.join(tmp, 'implement.json');
  const ea = run(['mission', 'export', specMission.id, '--file', fileA, '--out', out]);
  const eb = run(['mission', 'export', implement.id, '--file', fileB, '--out', out]);
  check('both missions export', ea.code === 0 && eb.code === 0, ea.err.slice(-200) + eb.err.slice(-200));
  const out2 = path.join(tmp, 'out2');
  check('the fresh directory maps the same repository', run(['map', repo, '--out', out2, '--top', '0']).code === 0);
  const ia = run(['mission', 'import', '--file', fileA, '--out', out2]);
  const ib = run(['mission', 'import', '--file', fileB, '--out', out2]);
  check('both import', ia.code === 0 && ib.code === 0, ia.err.slice(-300) + ib.err.slice(-300));
  const ledger = (dir: string) => run(['report', '--project', '--group', 'mission', '--out', dir, '--format', 'json']).out;
  check('the ledger JSON is byte-equal after the round trip', ledger(out) === ledger(out2), `${ledger(out).slice(0, 200)} vs ${ledger(out2).slice(0, 200)}`);
  const replay = (dir: string) => run(['mission', 'replay', implement.id, '--out', dir, '--format', 'json']).out;
  check('mission replay is byte-equal after the round trip', replay(out) === replay(out2) && replay(out).length > 100);
}

section('negative: an author that touches a protected path');
{
  const objective = 'make add return the sum (ad hoc)';
  const c0 = confirmOf('adhoc-mission', objective);
  const m = json<Mission>(run(['mission', 'create', repo, '--kind', 'implement', '--no-work-item', '--objective', objective,
    '--rationale', 'a person decided no work item is needed', '--confirm', c0.digest8, '--out', out, '--format', 'json']));
  check('an ad hoc implement mission records who decided it', m.kind === 'implement' && inspect(m.id).decisions.some((d) => d.kind === 'adhoc-mission' && d.actor === ACTOR));
  const c1 = confirmOf('authorize-mission', m.id, ['--write']);
  run(['mission', 'authorize', m.id, '--out', out, '--write', '--rationale', 'r', '--confirm', c1.digest8]);
  run(['gate', 'add', m.id, '--role', 'gate', '--test', path.join(tmp, 'add.test.js'), '--expect-exit', '0', '--expect-stdout', '# fail 0', '--name', 'add.test.js', '--out', out]);
  run(['gate', 'baseline', m.id, repo, '--out', out]);
  const c2 = confirmOf('lock-gates', m.id);
  run(['gate', 'lock', m.id, '--out', out, '--rationale', 'r', '--confirm', c2.digest8]);

  const r = run(['forge', 'run', m.id, repo, '--tools', 'mock', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: protectedEdit });
  const res = json<{ candidate: Candidate; verdict: string }>(r);
  check('the candidate is a policy violation naming package.json', res.verdict === 'policy-violation'
    && res.candidate.policyViolations.some((v) => v.rule === 'protected-path' && v.path === 'package.json'), r.out.slice(0, 300) + r.err.slice(-300));
  check('no gate ran on it', json<{ gateEvaluations: unknown[] }>(run(['forge', 'candidate', res.candidate.id, '--out', out, '--format', 'json'])).gateEvaluations.length === 0);
  for (const op of ['approve', 'override'] as const) {
    const c = confirmOf(`${op}-candidate`, res.candidate.id);
    const d = run(['forge', op, res.candidate.id, '--out', out, '--rationale', 'looks fine to me', '--confirm', c.digest8]);
    check(`${op} is refused: the violation is uncurable`, d.code === 1, d.err.slice(-200));
  }
  const ca = confirmOf('apply', res.candidate.id);
  const ap = run(['forge', 'apply', res.candidate.id, repo, '--out', out, '--confirm', ca.digest8]);
  check('apply is refused', ap.code === 1, ap.err.slice(-200));
  check('and no ref exists for this mission', !git(['for-each-ref', '--format=%(refname)', 'refs/heads/daylight/']).includes(m.id));
}

section('reviews run under the review profile by default whenever bwrap is present');
{
  const reviewer = path.join(tmp, 'mock-reviewer.cjs');
  fs.writeFileSync(reviewer, mcpMock([{ name: 'submit_claim', arguments: {
    subject: 'src/add.js', predicate: 'purpose', value: 'subtracts where it should add', confidence: 0.8, evidence: [{ file: 'src/add.js', line: 1 }],
  } }]));
  const m = json<Mission>(run(['mission', 'create', repo, '--kind', 'verify', '--objective', 'what does add do', '--scope', 'src/add.js', '--out', out, '--format', 'json']));
  const r = run(['mission', 'run', m.id, repo, '--tools', 'mock:a', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: reviewer });
  const rep = json<{ attempts: Attempt[] }>(r);
  const a = rep.attempts.find((x) => x.runnerId === 'agent:mock:a');
  check('with no flag, the mock reviewer ran under the review profile: read-only, no network',
    a?.state === 'completed' && a.sandbox?.profile === 'review' && !a.sandbox.write && a.sandbox.network === 'none', `${JSON.stringify(a?.sandbox)} ${r.err.slice(-300)}`);
  const d = openDaylight(out);
  try {
    const claims = d.claims.claimsFor('src/add.js', 'purpose');
    check('its claim reached <out> only through the MCP socket, under its own session', claims.some((c) => c.source.kind === 'agent' && c.source.sessionId === a?.sessionId), JSON.stringify(claims.map((c) => c.source)));
  } finally {
    d.close();
  }

  const m2 = json<Mission>(run(['mission', 'create', repo, '--kind', 'verify', '--objective', 'what does add do, unsandboxed', '--scope', 'src/add.js', '--out', out, '--format', 'json']));
  const declined = json<{ attempts: Attempt[] }>(run(['mission', 'run', m2.id, repo, '--tools', 'mock:b', '--no-review-sandbox', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: reviewer }));
  const b = declined.attempts.find((x) => x.runnerId === 'agent:mock:b');
  check('--no-review-sandbox on an all-mock roster runs as P0 did, stamped profile none', b?.state === 'completed' && b.sandbox?.profile === 'none', JSON.stringify(b?.sandbox));

  // Stand-ins named claude and codex, first on PATH, so the roster finds "real" providers without
  // the real binaries anywhere near this test. Each writes a marker if it is ever spawned.
  const fakeBin = path.join(tmp, 'fake-bin');
  const marker = path.join(tmp, 'fake-provider-ran');
  fs.mkdirSync(fakeBin);
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o755 });
  }
  const stubbed = { PATH: `${fakeBin}:${baseEnv.PATH ?? ''}`, DAYLIGHT_MOCK_ADAPTER: reviewer };
  const m3 = json<Mission>(run(['mission', 'create', repo, '--kind', 'verify', '--objective', 'a real reviewer', '--scope', 'src/add.js', '--out', out, '--format', 'json']));
  const refused = run(['mission', 'run', m3.id, repo, '--tools', 'mock:c,claude', '--no-review-sandbox', '--out', out, '--format', 'json'], stubbed);
  const after = inspect(m3.id);
  check('--no-review-sandbox with claude in the roster is refused before anything spawns',
    refused.code !== 0 && /--no-review-sandbox/.test(refused.err) && !fs.existsSync(marker) && after.attempts.length === 0 && after.mission.state === 'ready',
    `${refused.code} ${refused.err.slice(-300)} attempts=${after.attempts.length} state=${after.mission.state}`);
  const real = run(['mission', 'run', m3.id, repo, '--tools', 'codex', '--out', out, '--format', 'json'], stubbed);
  check('by default a real provider is refused under the profile until the live spike (R15.1), and never spawned',
    json<{ unavailable: string[] }>(real).unavailable.some((u) => /R15\.1/.test(u)) && !fs.existsSync(marker), real.out.slice(0, 300));
}

section('a possible secret (R16) is curable, but approve needs it acknowledged');
{
  const careless = path.join(tmp, 'mock-author-possible-secret.cjs');
  fs.writeFileSync(careless, author({ 'src/add.js': '// password: undefined\nmodule.exports = (a, b) => a + b;\n' }));
  const objective = 'make add return the sum (possible secret)';
  const c0 = confirmOf('adhoc-mission', objective);
  const m = json<Mission>(run(['mission', 'create', repo, '--kind', 'implement', '--no-work-item', '--objective', objective,
    '--rationale', 'r', '--confirm', c0.digest8, '--out', out, '--format', 'json']));
  const c1 = confirmOf('authorize-mission', m.id, ['--write']);
  run(['mission', 'authorize', m.id, '--out', out, '--write', '--rationale', 'r', '--confirm', c1.digest8]);
  run(['gate', 'add', m.id, '--role', 'gate', '--test', path.join(tmp, 'add.test.js'), '--expect-exit', '0', '--expect-stdout', '# fail 0', '--name', 'add.test.js', '--out', out]);
  run(['gate', 'baseline', m.id, repo, '--out', out]);
  const c2 = confirmOf('lock-gates', m.id);
  run(['gate', 'lock', m.id, '--out', out, '--rationale', 'r', '--confirm', c2.digest8]);
  const r = run(['forge', 'run', m.id, repo, '--tools', 'mock', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: careless });
  const res = json<{ candidate: Candidate; verdict: string }>(r);
  check('the candidate passes its gates and carries the low-tier hit, not a violation',
    res.verdict === 'accepted-by-gates' && res.candidate.possibleSecretHits > 0 && res.candidate.policyViolations.length === 0,
    `${res.verdict} ${res.candidate?.possibleSecretHits} ${JSON.stringify(res.candidate?.policyViolations)} ${r.err.slice(-300)}`);
  const shown = json<{ possibleSecrets: string[] }>(run(['forge', 'candidate', res.candidate.id, '--out', out, '--format', 'json']));
  check('forge candidate names the path to read', shown.possibleSecrets.includes('src/add.js'), JSON.stringify(shown.possibleSecrets));
  const c = confirmOf('approve-candidate', res.candidate.id);
  check('confirm lists it for the dialog', c.lines.some((l) => /possible secret in src\/add\.js/.test(l)), JSON.stringify(c.lines));
  const no = run(['forge', 'approve', res.candidate.id, '--out', out, '--rationale', 'read it: a comment', '--confirm', c.digest8]);
  check('approve without --acknowledge-possible-secret is refused', no.code === 1 && /acknowledge-possible-secret/.test(no.err), no.err.slice(-300));
  const yes = run(['forge', 'approve', res.candidate.id, '--out', out, '--rationale', 'read it: a comment', '--confirm', c.digest8, '--acknowledge-possible-secret', '--format', 'json']);
  check('with it, the approve is recorded and says what was acknowledged', yes.code === 0 && Number(json<Decision>(yes).scope.acknowledgedPossibleSecrets) > 0, yes.err.slice(-300));
}

section('negative: no sandbox means no author attempt');
{
  const d = openDaylight(out);
  try {
    const m = d.store.missions().find((x) => x.kind === 'implement' && x.state !== 'closed')!;
    const before = d.store.tasks(m.id).flatMap((t) => d.store.attempts(t.id)).length;
    let err: unknown = null;
    try {
      await runImplement(d, {
        missionId: m.id, repo, tool: 'mock', env: { ...baseEnv, DAYLIGHT_MOCK_ADAPTER: fixer },
        sandbox: { name: 'bwrap', available: false, why: 'forced off by the test' },
      });
    } catch (e) {
      err = e;
    }
    check('runImplement refuses when the sandbox cannot be built', err instanceof ImplementRefused && /sandbox/.test((err as Error).message), String(err));
    check('and starts no attempt', d.store.tasks(m.id).flatMap((t) => d.store.attempts(t.id)).length === before);
  } finally {
    d.close();
  }
}

done();
