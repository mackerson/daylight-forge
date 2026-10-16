/**
 * The Claude Code transcript ingester. Run: node engine/test/ingest.ts
 *
 * Every transcript here is a hand-written synthetic fixture (fixtures/claude-code-transcripts/,
 * first line `x-synthetic-fixture`) with the real line shapes and fake content. The weight is
 * on what must never happen: transcript text, a planted key or an unverified hex run reaching
 * the database or an artifact; another project's session being ingested; a re-run adding rows.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  assertVetted, eventId, ingestClaudeCode, OUTSIDE_CONTROLS, parseLine, projectSlug, vetModel,
  vetPath, vetTool,
} from '../ingest/claude-code.ts';
import { readNewLines } from '../ingest/cursor.ts';
import { runIngestCommand } from '../ingest/commands.ts';
import { openDaylight } from '../mission/context.ts';
import { redact } from '../mission/redact.ts';
import { isEntityId } from '../mission/types.ts';
import type { Attempt } from '../mission/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', '..', 'fixtures', 'claude-code-transcripts');
const SENTINEL = 'SENTINEL-TRANSCRIPT-TEXT-9F3K';
const PLANTED_KEY = 'sk-ant-api03-PLANTEDFAKEKEYforDaylightTestsOnly0000';
const RANDOM_HEX = '0123456789abcdef0123456789abcdef01234567';
const MAIN = '11111111-1111-4111-8111-111111111111';
const FOREIGN_SESSION = '22222222-2222-4222-8222-222222222222';
const GONE_SESSION = '33333333-3333-4333-8333-333333333333';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-ingest-')));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();
function makeRepo(name: string, content: string): { root: string; head: string } {
  const root = path.join(tmp, name);
  fs.mkdirSync(root);
  git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, 'a.txt'), content);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'init']);
  return { root, head: git(root, ['rev-parse', 'HEAD']) };
}

const repo = makeRepo('repo', 'project\n');
const foreign = makeRepo('foreign', 'another project\n');
const out = path.join(tmp, 'out');
fs.mkdirSync(out);
fs.writeFileSync(path.join(out, 'view.json'), JSON.stringify({ root: repo.root }));
const projectsDir = path.join(tmp, 'claude', 'projects');
const sessionDir = path.join(projectsDir, projectSlug(repo.root));

const substitute = (text: string) => text
  .replaceAll('@@ROOT@@', repo.root).replaceAll('@@FOREIGN@@', foreign.root)
  .replaceAll('@@GONE@@', path.join(tmp, 'deleted-checkout')).replaceAll('@@COMMIT@@', repo.head);
function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(path.join(from, e.name), path.join(to, e.name));
    else fs.writeFileSync(path.join(to, e.name), substitute(fs.readFileSync(path.join(from, e.name), 'utf8')));
  }
}
copyTree(path.join(FIXTURES, 'project'), sessionDir);

/** Every byte under `<out>`: the database, its WAL, artifacts, anything else. */
function allBytes(dir: string): Buffer {
  const parts: Buffer[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else parts.push(fs.readFileSync(p));
    }
  };
  walk(dir);
  return Buffer.concat(parts);
}

const TABLES = ['missions', 'tasks', 'attempts', 'attempt_usage', 'events', 'artifacts', 'ingest_sources', 'decisions'];
function rowCounts(): Record<string, number> {
  const db = new DatabaseSync(path.join(out, 'daylight.db'), { readOnly: true });
  try {
    return Object.fromEntries(TABLES.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
  } finally {
    db.close();
  }
}

function capture(fn: () => number): { code: number; stdout: string; stderr: string } {
  const w = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  const original = console.error;
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((s: string) => { stdout += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { stderr += s; return true; }) as typeof process.stderr.write;
  console.error = (...a: unknown[]) => { stderr += `${a.join(' ')}\n`; };
  try {
    return { code: fn(), stdout, stderr };
  } finally {
    process.stdout.write = w;
    process.stderr.write = e;
    console.error = original;
  }
}

const ingestAll = () => {
  const ctx = openDaylight(out);
  try {
    return ingestClaudeCode(ctx, repo.root, { all: true, projectsDir });
  } finally {
    ctx.close();
  }
};

// ---------------------------------------------------------------------------------
section('parseLine and vetting are pure and keep no text');
{
  const facts = parseLine(JSON.stringify({
    type: 'assistant', sessionId: MAIN, cwd: repo.root, timestamp: '2026-10-01T00:00:00.000Z',
    message: { id: 'msg_x', model: 'claude-x', content: [{ type: 'text', text: SENTINEL }], usage: { input_tokens: 3 } },
  }), repo.root);
  check('an assistant line yields its model, id and tokens', facts.kind === 'assistant' && facts.model === 'claude-x' && facts.requestId === 'msg_x' && facts.tokens?.input === 3);
  check('an unreported token field is null, never 0', facts.tokens?.output === null && facts.tokens?.cacheRead === null && facts.tokens?.cacheWrite === null);
  check('no fact carries the line\'s text', !JSON.stringify({ ...facts, cwd: null }).includes(SENTINEL));
  check('a torn line is corrupt', parseLine('{"type":"assistant","mess', repo.root).kind === 'corrupt');
  check('an unknown type is counted as unknown, not guessed at', parseLine('{"type":"x-new"}', repo.root).kind === 'unknown');
  check('a model with an odd shape is dropped', vetModel('<synthetic>') === null && vetModel(PLANTED_KEY) === null && vetModel('claude-opus-4-1[1m]') === 'claude-opus-4-1[1m]');
  check('a tool with an odd name is `other`', vetTool('Weird Tool!') === 'other' && vetTool('mcp__srv__get_slice') === 'mcp__srv__get_slice');
  const inside = vetPath(path.join(repo.root, 'src/a.ts'), null, repo.root);
  check('an inside path becomes project-relative', 'rel' in inside && inside.rel === 'src/a.ts');
  check('a relative path resolves against the line\'s cwd', (() => { const v = vetPath('b.ts', path.join(repo.root, 'src'), repo.root); return 'rel' in v && v.rel === 'src/b.ts'; })());
  check('an outside path is counted, not named', 'outside' in vetPath('/etc/passwd', null, repo.root) && 'outside' in vetPath(path.join(repo.root, '..', 'x'), null, repo.root));
  check('a path with a secret shape is dropped', 'dropped' in vetPath(path.join(repo.root, PLANTED_KEY), null, repo.root));
  check('a path with a control character is dropped', 'dropped' in vetPath(`${repo.root}/a\nb`, null, repo.root));
  const id = eventId(MAIN, '', 'usage:msg_x');
  check('event ids are ev_cc_ and deterministic', id === eventId(MAIN, '', 'usage:msg_x') && id.startsWith('ev_cc_') && isEntityId('event', id));
  check('the agent is part of the event id', id !== eventId(MAIN, 'a1', 'usage:msg_x'));
  let threw = false;
  try {
    assertVetted({ files: { read: ['ok.ts', SENTINEL] } }, new Set(['ok.ts']));
  } catch {
    threw = true;
  }
  check('assertVetted refuses a string nobody vetted', threw);
}

section('redact knows the added shapes');
{
  const shapes = [
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2EAAAADAQABAAABAQ\n-----END OPENSSH PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'https://deploy:hunter2hunter2@example.invalid/repo.git',
    'DATABASE_PASSWORD=correct-horse-battery',
    'glpat-ABCDEFGHIJKLMNOPQRST',
    'AIzaSyA-1234567890abcdefghijklmnopqrstu',
  ];
  for (const s of shapes) check(`redact masks ${s.slice(0, 14)}…`, redact(s, [], {}).redactions > 0);
  check('redact leaves a commit sha alone', redact(repo.head, [], {}).redactions === 0);
}

section('cursor reads complete lines only and notices a rewrite');
{
  const f = path.join(tmp, 'cursor.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"b":2}\n{"c":');
  const first = readNewLines(f, null);
  check('the unfinished last line is left unread', !('refused' in first) && first.lines.length === 2 && first.partialTailBytes === 5);
  if (!('refused' in first)) {
    fs.appendFileSync(f, '3}\n');
    const next = readNewLines(f, first);
    check('a re-run reads only what is new', !('refused' in next) && next.lines.length === 1 && next.lines[0] === '{"c":3}' && next.firstLine === 2 && next.linesSeen === 3);
    fs.writeFileSync(f, '{"z":9}\n{"b":2}\n{"c":3}\n');
    const again = readNewLines(f, 'refused' in next ? first : next);
    check('a changed prefix is read again from zero', !('refused' in again) && again.restarted && again.lines.length === 3);
  }
}

// ---------------------------------------------------------------------------------
section('first ingest: one work mission, child attempts, usage deduped');
const r1 = ingestAll();
const ctx = openDaylight(out);
const missions = r1.missionIds.map((id) => ctx.store.mission(id)!);
check('one session ingested of three seen', r1.sessions.seen === 3 && r1.sessions.ingested === 1, JSON.stringify(r1.sessions));
check('the other-project session is skipped and counted', r1.skipped.foreign === 1);
check('the session whose cwd is gone is skipped and counted', r1.skipped.unresolvable === 1);
check('one work mission, labelled outside Daylight\'s controls', missions.length === 1 && missions[0].kind === 'work' && missions[0].objective.includes(OUTSIDE_CONTROLS));
const mission = missions[0];
const attempts: Attempt[] = ctx.store.tasks(mission.id).flatMap((t) => ctx.store.attempts(t.id));
const sources = ctx.store.ingestSources(r1.projectId);
const attemptFor = (agentId: string) => ctx.store.attempt(sources.find((s) => s.agentId === agentId)!.attemptId)!;
const root = attemptFor('');
const sub1 = attemptFor('a1111111111111111');
const sub2 = attemptFor('a2222222222222222');
check('three attempts: the session and two subagents', attempts.length === 3 && r1.attempts === 3);
check('every attempt is ingested with no sandbox record', attempts.every((a) => a.origin === 'ingested' && a.sandbox === null));
check('every attempt\'s cost is null with source none', attempts.every((a) => a.costUsd === null && a.costSource === 'none'));
check('the subagent is a child of the session', sub1.parentAttemptId === root.id);
check('the nested subagent is a child of the subagent that spawned it', sub2.parentAttemptId === sub1.id);
check('the session\'s model comes from its lines', root.model === 'claude-fixture-main');
check('a subagent\'s model comes from its lines, not meta', sub1.model === 'claude-fixture-sub');
check('meta.json\'s model is the fallback when the lines carry none', sub2.model === 'claude-fixture-meta-model');
const rows = ctx.store.usageRows(root.id);
const msgA = rows.find((u) => u.requestId === 'msg_fixtureA0000000000000001');
const msgB = rows.find((u) => u.requestId === 'msg_fixtureB0000000000000002');
check('a message split over three lines is one usage row', rows.length === 3 && !!msgA, rows.map((u) => u.requestId).join(','));
check('split-line usage is MAX-merged, cache fields included', !!msgA && msgA.tokens.input === 10 && msgA.tokens.output === 20 && msgA.tokens.cacheRead === 100 && msgA.tokens.cacheWrite === 50, JSON.stringify(msgA?.tokens));
check('absent cache fields stay null', !!msgB && msgB.tokens.cacheRead === null && msgB.tokens.cacheWrite === null);
check('usage rows are transcript-sourced with no cost', rows.every((u) => u.source === 'transcript' && u.costUsd === null && u.costSource === 'none'));
check('attempt totals sum the rows', root.tokens.input === 21 && root.tokens.output === 29 && root.tokens.cacheRead === 300 && root.tokens.cacheWrite === 50 && root.usageSource === 'transcript', JSON.stringify(root.tokens));
check('the subagent\'s repeated line is counted once', ctx.store.usageRows(sub1.id).length === 1 && r1.deduped >= 3);
check('the line naming another session is skipped and counted', r1.skipped.mismatchedLines === 1 && !rows.some((u) => u.tokens.input === 999));
check('the corrupted line is skipped with a count', r1.skipped.corruptLines === 1);
check('unknown line types are counted', r1.skipped.unknownLines === 4, String(r1.skipped.unknownLines));
check('the unfinished last line is left for later', r1.skipped.partialTailBytes > 0 && !rows.some((u) => u.requestId === 'msg_fixtureD0000000000000004'));

section('the summary keeps facts only');
const summary = JSON.parse(ctx.artifacts.text(root.artifacts.find((a) => a.kind === 'ingest-summary')!)) as Record<string, any>;
check('written paths are project-relative', JSON.stringify(summary.files.written) === JSON.stringify(['engine/cli.ts', 'nb/analysis.ipynb', 'notes/new-file.ts']), JSON.stringify(summary.files));
check('read paths are project-relative', JSON.stringify(summary.files.read) === JSON.stringify(['src/relative.ts']));
check('the outside path is counted, not named', summary.counts.outsidePaths === 1 && r1.skipped.outsidePaths === 1);
check('the path holding a secret shape is dropped and counted', summary.counts.droppedValues === 1);
check('the commit the repository knows is kept and labelled', summary.commits.length === 1 && summary.commits[0].sha === repo.head && summary.commits[0].label === 'mentioned-in-session');
check('hex the repository does not know is dropped and counted', summary.counts.unverifiedHex === 1 && r1.skipped.unverifiedHex === 1);
check('tool names are kept; an odd one is `other`', ['Agent', 'Bash', 'Edit', 'NotebookEdit', 'Read', 'Write', 'other'].every((t) => t in summary.tools), JSON.stringify(summary.tools));
check('the summary says the work was outside Daylight\'s controls', summary.controls === OUTSIDE_CONTROLS && summary.origin === 'ingested');
const finished = ctx.events.forMission(mission.id).filter((e) => e.name === 'ingest.session.finished');
check('one ingest.session.finished per transcript', finished.length === 3);
check('every ingest event id is ev_cc_', ctx.events.forMission(mission.id).every((e) => e.id.startsWith('ev_cc_')));
ctx.close();

section('nothing from the transcripts\' text reaches the store or an artifact');
{
  const bytes = allBytes(out);
  // The control: the same scan does find what was meant to be stored, in the db and an artifact.
  check('the scan sees the stored facts (control)', bytes.includes('notes/new-file.ts') && bytes.includes(repo.head) && bytes.includes('claude-fixture-meta-model'));
  check('the fixture sentinel appears nowhere under <out>', !bytes.includes(SENTINEL));
  check('the planted key appears nowhere under <out>', !bytes.includes(PLANTED_KEY) && !bytes.includes('PLANTEDFAKEKEY'));
  check('the unverified hex appears nowhere under <out>', !bytes.includes(RANDOM_HEX));
  check('the outside path appears nowhere under <out>', !bytes.includes('daylight-fixture-outside'));
  check('nothing of the other-project session was stored', !bytes.includes('claude-fixture-foreign') && !bytes.includes('secret-plan') && !bytes.includes(FOREIGN_SESSION));
  check('nothing of the unresolvable session was stored', !bytes.includes('claude-fixture-gone') && !bytes.includes(GONE_SESSION));
  check('the client\'s cost estimate was not read', !bytes.includes('totalCostUSD'));
}

section('a subagent whose file name holds a secret shape is refused');
{
  const hostileId = PLANTED_KEY;
  const subDir = path.join(sessionDir, MAIN, 'subagents');
  const hostile = path.join(subDir, `agent-${hostileId}.jsonl`);
  fs.writeFileSync(hostile, fs.readFileSync(path.join(subDir, 'agent-a2222222222222222.jsonl'), 'utf8').replaceAll('a2222222222222222', hostileId));
  const before = rowCounts();
  const r = ingestAll();
  const listed = capture(() => runIngestCommand(['list', '--out', out], { projectsDir }));
  check('it is counted as a refused file', r.skipped.refusedFiles === 1, JSON.stringify(r.skipped));
  check('and adds no row', JSON.stringify(before) === JSON.stringify(rowCounts()));
  check('its id reaches neither <out> nor the listing', !allBytes(out).includes('PLANTEDFAKEKEY') && !listed.stdout.includes('PLANTEDFAKEKEY'));
  fs.rmSync(hostile);
}

section('re-ingest adds zero rows');
{
  const before = rowCounts();
  const r2 = ingestAll();
  const after = rowCounts();
  check('an identical re-run adds no row to any table', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  check('and reports nothing ingested', r2.sessions.ingested === 0 && r2.attempts === 0 && r2.turns === 0);
}

section('appended lines: only the tail is read');
{
  const before = rowCounts();
  fs.appendFileSync(path.join(sessionDir, `${MAIN}.jsonl`), substitute(fs.readFileSync(path.join(FIXTURES, `append-${MAIN}.jsonl`), 'utf8')));
  const r3 = ingestAll();
  const after = rowCounts();
  const c = openDaylight(out);
  const rows3 = c.store.usageRows(root.id);
  const src = c.store.ingestSource(MAIN, '')!;
  c.close();
  check('the completed tail line and the new line are two new turns', r3.turns === 2 && rows3.some((u) => u.requestId === 'msg_fixtureD0000000000000004') && rows3.some((u) => u.requestId === 'msg_fixtureE0000000000000005'));
  check('nothing already read is read again', r3.deduped === 0 && r3.skipped.corruptLines === 0 && r3.skipped.mismatchedLines === 0, JSON.stringify(r3.skipped));
  check('no new mission or attempt', after.missions === before.missions && after.attempts === before.attempts && r3.attempts === 0);
  check('the cursor moved to the new end', src.linesSeen === 17, String(src.linesSeen));
  check('the finished attempt\'s stale totals are reported, not hidden', r3.staleTotals.includes(root.id));
}

section('a rewritten transcript is re-read from zero as a no-op');
{
  const file = path.join(sessionDir, `${MAIN}.jsonl`);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('Hand-written', 'Hand-WRITTEN'));
  const before = rowCounts();
  const r4 = ingestAll();
  const after = rowCounts();
  const c = openDaylight(out);
  const src = c.store.ingestSource(MAIN, '')!;
  c.close();
  check('the rewrite adds no row', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  check('and is not reported as ingested', r4.sessions.ingested === 0 && r4.turns === 0);
  check('the cursor follows the rewritten file', src.linesSeen === 17 && src.bytesSeen === fs.statSync(file).size);
}

section('a symlinked transcript is refused');
{
  const link = path.join(sessionDir, '44444444-4444-4444-8444-444444444444.jsonl');
  fs.symlinkSync(path.join(sessionDir, `${MAIN}.jsonl`), link);
  const before = rowCounts();
  const r5 = ingestAll();
  check('it is counted, and nothing is ingested from it', r5.skipped.refusedFiles === 1 && JSON.stringify(before) === JSON.stringify(rowCounts()));
  fs.rmSync(link);
}

// ---------------------------------------------------------------------------------
section('the command, through its module');
{
  const run = (args: string[]) => capture(() => runIngestCommand(args, { projectsDir }));
  const before = rowCounts();
  const refused = run(['claude-code', '--out', out, '--session', FOREIGN_SESSION]);
  check('--session on another project\'s session is refused with exit 2', refused.code === 2 && refused.stderr.includes('another project'), refused.stderr);
  const gone = run(['claude-code', '--out', out, '--session', GONE_SESSION]);
  check('--session on a session whose cwd is gone is refused with exit 2', gone.code === 2);
  check('a refused session leaves no row', JSON.stringify(before) === JSON.stringify(rowCounts()));
  check('a malformed session id is a usage error', run(['claude-code', '--out', out, '--session', '../../etc']).code === 2);
  check('--session and --all together are a usage error', run(['claude-code', '--out', out, '--session', MAIN, '--all']).code === 2);
  check('neither is a usage error', run(['claude-code', '--out', out]).code === 2);
  check('an unknown session is an error, not a guess', run(['claude-code', '--out', out, '--session', '55555555-5555-4555-8555-555555555555']).code === 1);
  const ok = run(['claude-code', '--out', out, '--session', MAIN, '--format', 'json']);
  const parsed = JSON.parse(ok.stdout) as { sessions: { seen: number } };
  check('--session on this project\'s session runs', ok.code === 0 && parsed.sessions.seen === 1);
  const noMap = path.join(tmp, 'empty-out');
  check('an out with no map is an error', run(['claude-code', '--out', noMap, '--all']).code === 1);

  const list = run(['list', '--out', out, '--format', 'json']);
  const listing = JSON.parse(list.stdout) as { sources: Array<{ agentId: string; pathDigest: string }>; skipped: { foreign: number } | null; controls: string };
  check('ingest list prints every cursor', list.code === 0 && listing.sources.length === 3);
  check('ingest list carries the last run\'s skip counts', listing.skipped?.foreign === 1);
  check('ingest list names no transcript path', !list.stdout.includes(projectsDir) && listing.sources.every((s) => /^[0-9a-f]{64}$/.test(s.pathDigest)));
  check('ingest list says where the work happened', listing.controls === OUTSIDE_CONTROLS);
  const fresh = path.join(tmp, 'fresh-out');
  fs.mkdirSync(fresh);
  fs.writeFileSync(path.join(fresh, 'view.json'), JSON.stringify({ root: repo.root }));
  const empty = JSON.parse(run(['list', '--out', fresh, '--format', 'json']).stdout) as { skipped: unknown; sources: unknown[] };
  check('with no run yet, skipped is null rather than zero', empty.skipped === null && empty.sources.length === 0);
}

done();
