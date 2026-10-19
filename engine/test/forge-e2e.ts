/**
 * The Forge end to end, through the CLI. Run: node engine/test/forge-e2e.ts
 *
 * A fixture repository with a bug and a spec goes through every human act and every engine
 * step the P1 loop has: spec → blind decomposer over the attempt socket → work item approved
 * → implement mission → authorize → gate and holdout → baseline → lock → a mock author in the
 * bwrap author profile writes the fix → gates → approve → apply onto a new branch → the
 * project ledger → export, import and replay. Then exec as the author's nested no-network
 * `run` tool (R17.1), granted and not, and the refusals: exec without write, an author who
 * touches a protected path, a decision taken from inside an agent session, and no sandbox.
 *
 * Mocks only: no real provider binary is ever run. bwrap is required: without it this file
 * fails, it does not skip (R15.3), because a Forge without its sandbox is not the thing tested.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { detectSandbox } from '../experiment/sandbox.ts';
import { openDaylight } from '../mission/context.ts';
import type { Attempt, Candidate, Decision, Mission, Need, WorkItem } from '../mission/types.ts';
import { ImplementRefused, runImplement } from '../forge/orchestrate.ts';
import { runMission } from '../mission/orchestrate.ts';
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

section('authorize: exec without write is refused (R17.1), write is granted');
let authorizeId = '';
{
  const ex = confirmOf('authorize-mission', implement.id, ['--execute']);
  check('confirm refuses an exec grant without write before any dialog', !!ex.refusal && /without --write/.test(ex.refusal), String(ex.refusal));
  const exr = run(['mission', 'authorize', implement.id, '--out', out, '--execute', '--rationale', 'r', '--confirm', ex.digest8]);
  check('and mission authorize --execute without --write is refused', exr.code === 1 && /without --write/.test(exr.err), exr.err.slice(-200));
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

section('holdout content reaches no renderer-facing read: events, artifact, the shell\'s direct read');
{
  const d = openDaylight(out);
  let holdout!: { id: string; path: string; test: string; expected: string; runs: string[] };
  try {
    const x = d.store.experimentsFor(implement.id, 'holdout')[0];
    const runs = d.store.gateEvaluations({ missionId: implement.id }).filter((g) => g.experimentId === x.id).flatMap((g) => g.executions.map((r) => r.id));
    holdout = { id: x.id, path: x.testArtifact.path!, test: x.testArtifact.id, expected: x.expectedArtifact.id, runs };
  } finally {
    d.close();
  }
  const leaks = (text: string) => [SENTINEL, holdout.path, holdout.test, holdout.expected, ...holdout.runs].filter((s) => text.includes(s));
  check('the holdout was evaluated, so it has runs to leak', holdout.runs.length >= 2, String(holdout.runs.length));
  const all = run(['events', '--out', out, '--limit', '100000', '--format', 'json']).out;
  check('events --format json (the shell\'s fallback read) carries no holdout path, body or digest', all.length > 1000 && leaks(all).length === 0, leaks(all).join(' '));
  const mine = run(['events', '--mission', implement.id, '--out', out, '--limit', '100000', '--format', 'json']).out;
  check('nor does events --mission', leaks(mine).length === 0, leaks(mine).join(' '));
  const inspected = run(['mission', 'inspect', implement.id, '--out', out, '--format', 'json']).out;
  check('nor does mission inspect', leaks(inspected).length === 0, leaks(inspected).join(' '));
  // Acceptance F3: replay and gate list named the holdout's path.
  for (const form of [['--format', 'json'], []]) {
    const replayed = run(['mission', 'replay', implement.id, '--out', out, ...form]).out;
    check(`nor does mission replay ${form.join(' ') || '(text)'}`, replayed.length > 100 && leaks(replayed).length === 0, leaks(replayed).join(' '));
    const listed = run(['gate', 'list', implement.id, '--out', out, ...form]);
    check(`nor does gate list ${form.join(' ') || '(text)'}, which still lists the holdout by id`,
      listed.code === 0 && listed.out.includes(holdout.id) && leaks(listed.out).length === 0, leaks(listed.out).join(' ') + listed.err.slice(-200));
  }
  for (const [what, digest] of [['test', holdout.test], ['expectation', holdout.expected], ['run record', holdout.runs[0]]] as const) {
    const r = run(['artifact', digest, '--out', out, '--format', 'json']);
    check(`artifact <the holdout's ${what} digest> is refused`, r.code === 1 && !r.out.includes(SENTINEL) && /holdout/.test(r.err), `${r.code} ${r.err.slice(-200)}`);
  }
  const reveal = run(['artifact', holdout.test, '--out', out, '--reveal-holdout', '--format', 'json']);
  check('a person at the CLI can still read it with --reveal-holdout', reveal.code === 0 && reveal.out.includes(SENTINEL), reveal.err.slice(-200));
  const agent = run(['artifact', holdout.test, '--out', out, '--reveal-holdout', '--format', 'json'], { CLAUDECODE: '1' });
  check('but not from inside an agent session', agent.code !== 0 && !agent.out.includes(SENTINEL), agent.err.slice(-200));

  // The shell reads daylight.db directly for its live event view; that read withholds too.
  const shell = createRequire(import.meta.url)(path.join(ENGINE, '..', 'app', 'main', 'daylight-db.cjs')) as {
    openEventsReadOnly(file: string): { db: { prepare(sql: string): { all(...a: unknown[]): unknown[] }; close(): void } | null; refused: string | null };
    withholdHoldouts(db: unknown, events: unknown[]): unknown[];
    rowToEvent(row: unknown): unknown;
  };
  const opened = shell.openEventsReadOnly(path.join(out, 'daylight.db'));
  try {
    const rows = opened.db!.prepare('SELECT * FROM events ORDER BY sequence').all();
    const direct = JSON.stringify(shell.withholdHoldouts(opened.db, rows.map(shell.rowToEvent)));
    check('the shell\'s direct read of daylight.db withholds the same', direct.length > 1000 && leaks(direct).length === 0, leaks(direct).join(' '));
  } finally {
    opened.db?.close();
  }
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
  run(['gate', 'add', m.id, '--role', 'gate', '--test', path.join(tmp, 'add.test.js'), '--expect-exit', '0', '--expect-stdout', '# fail 0', '--name', 'late.test.js', '--out', out]);
  check('a gate added after the baseline raises a gate-lock need until it is baselined',
    inspect(m.id).needs.some((n) => n.kind === 'gate-lock' && /no baseline/.test(n.why)), JSON.stringify(inspect(m.id).needs));
  const neither = run(['mission', 'create', repo, '--kind', 'implement', '--out', out]);
  check('an implement mission with neither --work-item nor --no-work-item is a usage error (exit 2)', neither.code === 2, `${neither.code} ${neither.err.slice(-200)}`);
}

section('exec (R17.1): the author\'s run tool, only on an exec grant, in a nested no-network sandbox');
{
  const listener = net.createServer((c) => c.destroy());
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  /** An ad hoc implement mission granted `grant`, with a gate and a holdout locked, and their test paths. */
  const lockedMission = (objective: string, grant: string[]) => {
    const c0 = confirmOf('adhoc-mission', objective);
    const m = json<Mission>(run(['mission', 'create', repo, '--kind', 'implement', '--no-work-item', '--objective', objective,
      '--rationale', 'r', '--confirm', c0.digest8, '--out', out, '--format', 'json']));
    const c1 = confirmOf('authorize-mission', m.id, grant);
    const auth = run(['mission', 'authorize', m.id, '--out', out, ...grant, '--rationale', 'r', '--confirm', c1.digest8, '--format', 'json']);
    for (const [role, file] of [['gate', 'add.test.js'], ['holdout', 'holdout.test.js']]) {
      run(['gate', 'add', m.id, '--role', role, '--test', path.join(tmp, file), '--expect-exit', '0', '--expect-stdout', '# fail 0', '--name', file, '--out', out]);
    }
    run(['gate', 'baseline', m.id, repo, '--out', out]);
    const c2 = confirmOf('lock-gates', m.id);
    run(['gate', 'lock', m.id, '--out', out, '--rationale', 'r', '--confirm', c2.digest8]);
    const d = openDaylight(out);
    try {
      const testPaths = (['gate', 'holdout'] as const).flatMap((role) => d.store.experimentsFor(m.id, role).map((x) => x.testArtifact.path!));
      return { mission: json<Mission>(auth), authorized: auth, testPaths };
    } finally {
      d.close();
    }
  };
  /** An author that writes the fix, then asks its MCP server to `run` a probe of the sandbox the command lands in. */
  const runner = (testPaths: string[]) => {
    const probe = [
      "const net = require('node:net'); const fs = require('node:fs');",
      `const present = ${JSON.stringify(testPaths)}.filter((p) => fs.existsSync('/work/' + p));`,
      "const report = (v) => { console.log(JSON.stringify({ connect: v, present, gateDir: fs.existsSync('/work/.daylight-gates'),",
      "  socket: fs.existsSync('/run/daylight/mcp.sock'), cwd: process.cwd() })); process.exit(0); };",
      `const s = net.connect(${port}, '127.0.0.1');`,
      "s.on('connect', () => report('connected')); s.on('error', (e) => report(e.code)); setTimeout(() => report('timeout'), 3000);",
    ].join('\n');
    // The second call carries a secret-shaped argument: what the ledger records of it must be masked.
    return mcpMock([
      { name: 'run', arguments: { argv: ['node', '-e', probe], timeoutSeconds: 30 } },
      { name: 'run', arguments: { argv: ['node', '-e', 'process.exit(3)', EXEC_SECRET] } },
    ]).replace("'use strict';\n",
      `'use strict';\nrequire('node:fs').writeFileSync('/work/src/add.js', ${JSON.stringify('module.exports = (a, b) => a + b;\n')});\n`);
  };
  type Reply = { result?: { isError?: boolean; tools?: Array<{ name: string }>; content?: Array<{ text: string }> }; error?: unknown };
  /** The mock's MCP replies, from the stdout log captureRun kept on its attempt. */
  const repliesOf = (a: Attempt): Record<string, Reply> => {
    const d = openDaylight(out);
    try {
      const log = d.store.attempt(a.id)!.artifacts.find((r) => r.kind === 'log' && r.label?.startsWith('stdout'));
      return log ? JSON.parse(d.artifacts.text(log).trim().split('\n').at(-1)!) as Record<string, Reply> : {};
    } finally {
      d.close();
    }
  };
  const EXEC_SECRET = `sk-ant-api03-${'EXECARGSECRET'.repeat(6)}`;
  const grantOf = (id: string) => inspect(id).decisions.find((d) => d.scope.operation === 'authorize-mission');

  try {
    const granted = lockedMission('make add return the sum (with exec)', ['--write', '--execute']);
    check('authorize --write --execute is granted: write and execute, carried explicitly on the decision',
      granted.authorized.code === 0 && granted.mission.permissions.write && granted.mission.permissions.execute
      && (grantOf(granted.mission.id)?.scope.permissions as { execute?: unknown } | undefined)?.execute === true,
      granted.authorized.err.slice(-300));
    const script = path.join(tmp, 'mock-author-run.cjs');
    fs.writeFileSync(script, runner(granted.testPaths));
    const r = run(['forge', 'run', granted.mission.id, repo, '--tools', 'mock', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: script });
    const res = json<{ candidate: Candidate; verdict: string; attempt: Attempt }>(r);
    check('the attempt is stamped exec, still write, no network, its decision named',
      r.code === 0 && res.attempt.sandbox?.exec === true && res.attempt.sandbox.write && res.attempt.sandbox.network === 'none'
      && res.attempt.sandbox.authorizeDecisionId === grantOf(granted.mission.id)?.id,
      `${JSON.stringify(res.attempt?.sandbox)} ${r.err.slice(-400)}`);
    check('as are the candidate\'s profile and the attempt.started event', res.candidate?.profile.exec === true
      && inspect(granted.mission.id).events.some((e) => e.name === 'attempt.started' && e.attemptId === res.attempt.id && e.payload.exec === true));
    const replies = repliesOf(res.attempt);
    check('the author\'s MCP server offers run', !!replies['2']?.result?.tools?.some((t) => t.name === 'run'), JSON.stringify(replies['2']).slice(0, 300));
    const reply = JSON.parse(replies['3']?.result?.content?.[0]?.text ?? '{}') as { exitCode?: number; stdout?: string; artifacts?: string[] };
    check('the run call succeeded', reply.exitCode === 0 && !replies['3']?.result?.isError, JSON.stringify(replies['3']).slice(0, 400));
    const seen = JSON.parse(reply.stdout?.trim() || '{}') as { connect?: string; present?: string[]; gateDir?: boolean; socket?: boolean; cwd?: string };
    check('the command ran in the nested sandbox: at /work, with no MCP socket bound', seen.cwd === '/work' && seen.socket === false, JSON.stringify(seen));
    check('a TCP connect to a listening 127.0.0.1 port fails inside it', !!seen.connect && seen.connect !== 'connected' && seen.connect !== 'timeout', String(seen.connect));
    check('the gate and holdout test paths are absent inside it', granted.testPaths.length === 2 && seen.present?.length === 0 && seen.gateDir === false, JSON.stringify(seen));
    const stored = reply.artifacts?.[0] ? run(['artifact', reply.artifacts[0], '--out', out, '--format', 'json']) : null;
    check('its output is captured as an artifact in <out>', !!stored && stored.code === 0 && json<{ text: string }>(stored).text.includes('"connect"'), stored?.err.slice(-200));

    // Review R1: every run call is on the ledger, not only on disk.
    type ExecEvent = { name: string; attemptId?: string; artifactIds?: string[]; payload: Record<string, unknown> };
    const ledgerOf = (dir: string) => {
      const v = json<{ attempts: Array<Attempt & { execRuns?: number }>; events: ExecEvent[] }>(run(['mission', 'inspect', granted.mission.id, '--out', dir, '--format', 'json']));
      const a = v.attempts.find((x) => x.id === res.attempt.id);
      return { a, runs: v.events.filter((e) => e.name === 'attempt.exec' && e.attemptId === res.attempt.id), raw: JSON.stringify(v) };
    };
    const here = ledgerOf(out);
    check('each run call emits attempt.exec with a command digest, exit code, duration and both artifact ids',
      here.runs.length === 2 && here.runs.every((e) => /^sha256:[0-9a-f]{64}$/.test(String(e.payload.commandDigest)) && typeof e.payload.durationMs === 'number'
        && typeof e.payload.stdoutArtifactId === 'string' && typeof e.payload.stderrArtifactId === 'string')
      && here.runs[0].payload.exitCode === 0 && here.runs[1].payload.exitCode === 3, JSON.stringify(here.runs.map((e) => e.payload)).slice(0, 600));
    check('the first event names the artifacts the run tool returned', reply.artifacts?.[0] === here.runs[0]?.payload.stdoutArtifactId
      && JSON.stringify(here.runs[0]?.artifactIds) === JSON.stringify([here.runs[0]?.payload.stdoutArtifactId, here.runs[0]?.payload.stderrArtifactId]));
    check('the exec artifacts are recorded rows on the attempt, and it counts its runs',
      here.a?.execRuns === 2 && here.runs.every((e) => (e.artifactIds ?? []).every((id) => here.a!.artifacts.some((r) => r.id === id)))
      && json<{ ref: unknown }>(run(['artifact', String(here.runs[0].payload.stdoutArtifactId), '--out', out, '--format', 'json'])).ref !== null,
      `${here.a?.execRuns} ${JSON.stringify(here.a?.artifacts.map((r) => r.label))}`);
    check('a secret in a run command never reaches the ledger: the event carries it masked', !here.raw.includes(EXEC_SECRET)
      && /REDACTED/.test(String(here.runs[1]?.payload.command)), String(here.runs[1]?.payload.command));
    const execExport = path.join(tmp, 'exec-mission.json');
    const out3 = path.join(tmp, 'out-exec');
    run(['mission', 'export', granted.mission.id, '--file', execExport, '--out', out]);
    run(['map', repo, '--out', out3, '--top', '0']);
    const imported = run(['mission', 'import', '--file', execExport, '--out', out3]);
    const there = ledgerOf(out3);
    check('export → import carries the exec runs: events, count, and readable artifact rows',
      imported.code === 0 && there.a?.execRuns === 2 && there.runs.length === 2
      && JSON.stringify(there.runs.map((e) => e.payload)) === JSON.stringify(here.runs.map((e) => e.payload))
      && json<{ ref: unknown; text: string }>(run(['artifact', String(there.runs[0].payload.stdoutArtifactId), '--out', out3, '--format', 'json'])).text.includes('"connect"'),
      imported.err.slice(-300) + ` ${there.a?.execRuns} ${there.runs.length}`);
    check('and the export file never holds the secret argument', !fs.readFileSync(execExport, 'utf8').includes(EXEC_SECRET));

    const plain = lockedMission('make add return the sum (no exec)', ['--write']);
    const noExec = path.join(tmp, 'mock-author-run-refused.cjs');
    fs.writeFileSync(noExec, runner(plain.testPaths));
    const r2 = run(['forge', 'run', plain.mission.id, repo, '--tools', 'mock', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: noExec });
    const res2 = json<{ attempt: Attempt }>(r2);
    check('authorized without exec, the attempt is stamped exec false', r2.code === 0 && plain.mission.permissions.execute === false && res2.attempt.sandbox?.exec === false,
      `${JSON.stringify(res2.attempt?.sandbox)} ${r2.err.slice(-300)}`);
    const replies2 = repliesOf(res2.attempt);
    // A server with no tools at all answers tools/list with "method not found"; either way, no run.
    check('its MCP server has no run tool', !!replies2['2'] && (!!replies2['2'].error || !replies2['2'].result?.tools?.some((t) => t.name === 'run')),
      JSON.stringify(replies2['2']).slice(0, 300));
    check('and the run call is refused, nothing executed', (!!replies2['3']?.error || replies2['3']?.result?.isError === true)
      && !JSON.stringify(replies2['3']).includes('connect'), JSON.stringify(replies2['3']).slice(0, 300));
    const plainView = json<{ attempts: Array<Attempt & { execRuns?: number }>; events: Array<{ name: string }> }>(
      run(['mission', 'inspect', plain.mission.id, '--out', out, '--format', 'json']));
    check('and the ledger shows no exec run for it', plainView.attempts.every((a) => (a.execRuns ?? 0) === 0) && !plainView.events.some((e) => e.name === 'attempt.exec'));
  } finally {
    listener.close();
  }
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
  const real = run(['mission', 'run', m3.id, repo, '--tools', 'mock:c,codex', '--out', out, '--format', 'json'], stubbed);
  const untouched = inspect(m3.id);
  check('by default a real provider is refused, naming both ways forward, and nothing is spawned',
    real.code === 1 && /live spike/.test(real.err) && /--unsandboxed-review/.test(real.err) && !fs.existsSync(marker)
    && untouched.attempts.length === 0 && untouched.mission.state === 'ready', `${real.code} ${real.err.slice(-300)}`);
  const both = run(['mission', 'run', m3.id, repo, '--tools', 'mock:c', '--no-review-sandbox', '--unsandboxed-review', '--out', out], stubbed);
  check('the two opt-outs together are refused', both.code !== 0 && inspect(m3.id).attempts.length === 0, both.err.slice(-200));

  const open = run(['mission', 'run', m3.id, repo, '--tools', 'claude', '--unsandboxed-review', '--out', out, '--format', 'json'], stubbed);
  const ran = inspect(m3.id).attempts.find((x) => x.runnerId.startsWith('agent:claude'));
  check('--unsandboxed-review runs a real-provider review as P0 did (here, the stand-in)', fs.existsSync(marker) && !!ran, `${open.err.slice(-300)}`);
  check('and warns that the reviewer can read <out> (Sec H5)', /Sec H5/.test(open.err) && /<out>|can read/.test(open.err), open.err.slice(-300));
  check('and the attempt is stamped profile none, reason unsandboxed-review', ran?.sandbox?.profile === 'none' && ran.sandbox.reason === 'unsandboxed-review', JSON.stringify(ran?.sandbox));
  check('--no-review-sandbox on mocks is stamped reason no-review-sandbox', b?.sandbox?.reason === 'no-review-sandbox', JSON.stringify(b?.sandbox));
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

section('no sandbox: reviews are refused, not run open, unless a person opts out by name');
{
  const noSandbox = { name: 'bwrap' as const, available: false, why: 'forced off by the test' };
  const bin = path.join(tmp, 'fake-bin-h2');
  const marker = path.join(tmp, 'fake-provider-h2-ran');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o755 });
  const m = json<Mission>(run(['mission', 'create', repo, '--kind', 'verify', '--objective', 'no sandbox here', '--scope', 'src/add.js', '--out', out, '--format', 'json']));
  const savedPath = process.env.PATH;
  const savedMock = process.env.DAYLIGHT_MOCK_ADAPTER;
  process.env.PATH = `${bin}:${savedPath ?? ''}`;
  process.env.DAYLIGHT_MOCK_ADAPTER = fixer;
  const d = openDaylight(out);
  const attempts = () => d.store.tasks(m.id).flatMap((t) => d.store.attempts(t.id));
  const attemptRun = async (o: Partial<Parameters<typeof runMission>[1]>) => {
    try {
      await runMission(d, { missionId: m.id, repo, tools: ['claude'], sandbox: noSandbox, timeoutMs: 20_000, ...o });
      return null;
    } catch (e) {
      return e as Error;
    }
  };
  try {
    const real = await attemptRun({});
    check('a real provider is refused when the sandbox cannot be built, naming --unsandboxed-review',
      !!real && /--unsandboxed-review/.test(real.message) && !fs.existsSync(marker) && attempts().length === 0, String(real));
    const mock = await attemptRun({ tools: ['mock:z'] });
    check('so is a mock roster, naming --no-review-sandbox', !!mock && /--no-review-sandbox/.test(mock.message) && attempts().length === 0, String(mock));
    const open = await attemptRun({ unsandboxedReview: true });
    const a = attempts().find((x) => x.runnerId.startsWith('agent:claude'));
    check('with --unsandboxed-review it runs as P0 did (here, the stand-in), stamped profile none, reason unsandboxed-review',
      open === null && fs.existsSync(marker) && a?.sandbox?.profile === 'none' && a.sandbox.reason === 'unsandboxed-review', `${String(open)} ${JSON.stringify(a?.sandbox)}`);
  } finally {
    d.close();
    process.env.PATH = savedPath;
    if (savedMock === undefined) delete process.env.DAYLIGHT_MOCK_ADAPTER;
    else process.env.DAYLIGHT_MOCK_ADAPTER = savedMock;
  }
}

section('a project policy (P2-R6): the rust set and the author limits come from daylight.policy.json');
{
  const policyFile = path.join(repo, 'daylight.policy.json');
  const rustEdit = path.join(tmp, 'mock-author-rust.cjs');
  fs.writeFileSync(rustEdit, author({
    'src/add.js': 'module.exports = (a, b) => a + b;\n',
    'crates/x/Cargo.toml': '[package]\nname = "x"\n[dependencies]\nevil = "1"\n',
    'crates/x/build.rs': 'fn main() {}\n',
  }));
  const objective = 'make add return the sum (rust policy)';
  const c0 = confirmOf('adhoc-mission', objective);
  const m = json<Mission>(run(['mission', 'create', repo, '--kind', 'implement', '--no-work-item', '--objective', objective,
    '--rationale', 'policy fixture', '--confirm', c0.digest8, '--out', out, '--format', 'json']));
  const c1 = confirmOf('authorize-mission', m.id, ['--write']);
  run(['mission', 'authorize', m.id, '--out', out, '--write', '--rationale', 'r', '--confirm', c1.digest8]);
  run(['gate', 'add', m.id, '--role', 'gate', '--test', path.join(tmp, 'add.test.js'), '--expect-exit', '0', '--expect-stdout', '# fail 0', '--name', 'add.test.js', '--out', out]);
  run(['gate', 'baseline', m.id, repo, '--out', out]);
  const c2 = confirmOf('lock-gates', m.id);
  run(['gate', 'lock', m.id, '--out', out, '--rationale', 'r', '--confirm', c2.digest8]);
  try {
    fs.writeFileSync(policyFile, '{ "schema": "daylight.policy/v1", "languages": ["rust"], "surprise": true }');
    const bad = run(['forge', 'run', m.id, repo, '--tools', 'mock', '--out', out], { DAYLIGHT_MOCK_ADAPTER: rustEdit });
    check('a policy with an unknown key refuses the run, in one line naming the file',
      bad.code === 1 && /daylight\.policy\.json: unknown key "surprise"/.test(bad.err), bad.err.slice(-300));
    fs.writeFileSync(policyFile, JSON.stringify({ schema: 'daylight.policy/v1', languages: ['rust', 'node'], author: { maxTurns: 300, timeoutSeconds: 3600 } }));
    const r = run(['forge', 'run', m.id, repo, '--tools', 'mock', '--out', out, '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: rustEdit });
    const res = json<{ candidate: Candidate; verdict: string; attempt: Attempt }>(r);
    const v = res.candidate.policyViolations;
    check('a crate manifest and a build script are protected-path under the rust set', res.verdict === 'policy-violation'
      && ['crates/x/Cargo.toml', 'crates/x/build.rs'].every((p) => v.some((x) => x.rule === 'protected-path' && x.path === p && x.why === 'protected by the rust set')),
      JSON.stringify(v));
    const started = inspect(m.id).events.find((e) => e.name === 'attempt.started' && e.attemptId === res.attempt.id);
    check('the run event records the limits the policy set', started?.payload.maxTurns === 300 && started?.payload.timeoutMs === 3_600_000
      && JSON.stringify(started?.payload.limitSources) === '{"maxTurns":"policy","timeoutMs":"policy"}', JSON.stringify(started?.payload));
    const flagged = run(['forge', 'run', m.id, repo, '--tools', 'mock', '--out', out, '--format', 'json', '--timeout', '120'], { DAYLIGHT_MOCK_ADAPTER: rustEdit });
    const again = json<{ attempt: Attempt }>(flagged);
    const second = inspect(m.id).events.find((e) => e.name === 'attempt.started' && e.attemptId === again.attempt.id);
    check('a --timeout flag overrides the policy, and nothing is recorded as clamped',
      second?.payload.timeoutMs === 120_000 && second?.payload.maxTurns === 300 && JSON.stringify(second?.payload.clamped) === '[]', JSON.stringify(second?.payload));
  } finally {
    fs.rmSync(policyFile, { force: true });
  }
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
