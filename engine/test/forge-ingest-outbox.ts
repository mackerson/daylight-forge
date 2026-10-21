/**
 * Spec ingestion step 0 (§13.0): the store rows for the new tables, the corpus mission rules, the
 * generic outbox server and its host-side ingest, and `runMission({ outbox })` running a mock
 * extract attempt end to end over the attempt socket. Run: node engine/test/forge-ingest-outbox.ts
 *
 * Mocks only. bwrap is required: an outbox role is always sandboxed, so without it this fails.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { detectSandbox } from '../experiment/sandbox.ts';
import { createOutboxServer, outboxPathOf, type OutboxToolSpec } from '../mcp/outbox-server.ts';
import { mappedProject, openDaylight } from '../mission/context.ts';
import { roleAllowlist, runMission, type OutboxRun } from '../mission/orchestrate.ts';
import type { CorpusRevision, IrSpanRow } from '../mission/types.ts';
import { ingestOutbox, OUTBOX_TOOLS } from '../forge/outbox.ts';
import { harness } from './harness.ts';
import { callsLine, PROMPT_CALLS_MOCK } from './lib/mcp-mock.ts';

const { check, section, done } = harness();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-ingest-outbox-')));
const privateTmp = path.join(tmp, 'tmp');
fs.mkdirSync(privateTmp, { mode: 0o700 });
process.env.TMPDIR = privateTmp;
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const throws = (fn: () => unknown): Error | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};
const throwsAsync = async (fn: () => Promise<unknown>): Promise<Error | null> => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};

const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (root: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args,
], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const root = path.join(tmp, 'repo');
fs.mkdirSync(root);
git(root, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(root, 'spec.md'), '# Spec\n\nThe service must refuse an unsigned request.\n');
git(root, 'add', '.');
git(root, 'commit', '-q', '-m', 'spec');
const commit = git(root, 'rev-parse', 'HEAD');
const out = path.join(tmp, 'out');
fs.mkdirSync(out);
fs.writeFileSync(path.join(out, 'view.json'), JSON.stringify({ root }));
const ctx = openDaylight(out);
const project = mappedProject(out)!;
ctx.store.ensureProject(project);
const HUMAN = 'human:miz';

section('corpus missions: no execute, no parent, only an audit child');
const corpus = ctx.store.transitionMission(ctx.store.createMission({ projectId: project.id, kind: 'corpus', objective: 'corpus', baseRevision: commit }).id, 'ready');
check('a corpus mission is created read-only', corpus.kind === 'corpus' && !corpus.permissions.execute && !corpus.permissions.write);
check('a corpus mission that executes is refused',
  /never executes/.test(throws(() => ctx.store.createMission({ projectId: project.id, kind: 'corpus', objective: 'x', baseRevision: commit, permissions: { execute: true } }))?.message ?? ''));
check('a corpus mission with a parent is refused',
  /no parent/.test(throws(() => ctx.store.createMission({ projectId: project.id, kind: 'corpus', objective: 'x', baseRevision: commit, parentId: corpus.id }))?.message ?? ''));
const audit = ctx.store.createMission({ projectId: project.id, kind: 'audit', objective: 'review IR', baseRevision: commit, parentId: corpus.id });
check('an audit mission may be a corpus mission\'s child', audit.parentId === corpus.id);
check('any other child of a corpus is refused',
  /audit mission/.test(throws(() => ctx.store.createMission({ projectId: project.id, kind: 'explore', objective: 'x', baseRevision: commit, parentId: corpus.id }))?.message ?? ''));

section('corpus revisions, IR records, spans, observations and links');
const index = ctx.artifacts.put('{}', { kind: 'report', projectId: project.id, revision: commit, label: 'section-index', mediaType: 'application/json' });
ctx.store.recordArtifact(index);
const revInput: Omit<CorpusRevision, 'createdAt'> = {
  id: 'cr_' + '1'.repeat(32), corpusId: corpus.id, projectId: project.id, seq: 1, manifestPath: 'daylight.corpus.json', manifestDigest: 'sha256:' + 'a'.repeat(64),
  commits: { [project.id]: commit }, corpusDigest: 'sha256:' + 'b'.repeat(64), docs: [], precedence: [], dependencies: [], unordered: [['a', 'b']],
  sectionIndex: index, sectionSetDigest: 'sha256:' + 'c'.repeat(64), sectionerVersion: 'daylight-sectioner/2', configDigest: 'sha256:' + 'd'.repeat(64),
};
const rev = ctx.store.insertCorpusRevision(revInput);
check('a revision round-trips its JSON columns', rev.unordered[0]?.[1] === 'b' && rev.commits[project.id] === commit && rev.sectionIndex.id === index.id);
check('inserting the same revision again is idempotent', ctx.store.insertCorpusRevision(revInput).createdAt === rev.createdAt);
check('a second revision with the same corpus digest is refused',
  /already has a revision/.test(throws(() => ctx.store.insertCorpusRevision({ ...revInput, id: 'cr_' + '2'.repeat(32), seq: 2 }))?.message ?? ''));
check('the current revision is the highest seq', ctx.store.currentCorpusRevision(corpus.id)?.id === rev.id);
check('a revision on a non-corpus mission is refused',
  /not a corpus mission/.test(throws(() => ctx.store.insertCorpusRevision({ ...revInput, id: 'cr_' + '3'.repeat(32), corpusId: audit.id, corpusDigest: 'sha256:' + 'e'.repeat(64) }))?.message ?? ''));

const irId = 'ir_' + '1'.repeat(32);
const rec = ctx.store.insertIrRecord({
  id: irId, projectId: project.id, corpusId: corpus.id, kind: 'requirement', source: 'extracted', statement: 'Unsigned requests are refused.',
  attrs: { polarity: 'negative' }, basisSections: [], confidence: 0.9, contentDigest: 'sha256:' + 'f'.repeat(64), irVersion: 'irv:x', proposedBy: 'agent:mock:default',
  docKey: 'spec', quote: 'must refuse an unsigned request', otherQuote: null, firstRevision: rev.id,
});
check('an IR record is recorded proposed, with no span until one is written', rec.status === 'proposed' && rec.span === null);
const span: IrSpanRow = { irId, revisionId: rev.id, role: 'primary', docKey: 'spec', sectionId: 'spec:spec', start: 21, end: 52, quoteDigest: 'sha256:' + '0'.repeat(64), carry: 'proposed' };
ctx.store.insertIrSpan(span);
ctx.store.insertIrSpan({ ...span, start: 0, end: 1 });
const withSpan = ctx.store.irRecord(irId)!;
check('the record carries its span at the current revision, quote from the row', withSpan.span?.start === 21 && withSpan.span.quote === 'must refuse an unsigned request');
check('a span row is never rewritten by a second insert on its key', ctx.store.irSpans(irId).length === 1 && ctx.store.irSpans(irId)[0].start === 21);
check('irSpansAt finds an overlap and only an overlap',
  ctx.store.irSpansAt(rev.id, 'spec', 50, 60).length === 1 && ctx.store.irSpansAt(rev.id, 'spec', 52, 60).length === 0 && ctx.store.irSpansAt(rev.id, 'other', 0, 99).length === 0);
check('a record filtered by section is found through its span', ctx.store.irRecords(corpus.id, { sectionId: 'spec:spec' }).length === 1
  && ctx.store.irRecords(corpus.id, { sectionId: 'spec:other' }).length === 0);
check('an extracted record with an empty quote is refused by the schema',
  throws(() => ctx.store.insertIrRecord({ ...ctx.store.irRecord(irId)!, id: 'ir_' + '2'.repeat(32), docKey: 'spec', quote: '', otherQuote: null, firstRevision: rev.id })) !== null);

const task = ctx.store.createTask({ missionId: corpus.id, role: 'extract', objective: 'extract window 1', runnerHint: 'mock' });
const att = ctx.store.startAttempt({ taskId: task.id, runnerId: 'agent:mock:default' });
ctx.store.insertIrObservation({ irId, attemptId: att.id, runnerId: 'agent:mock:default', windowId: 'win1:abc', confidence: 0.9, at: 1 });
ctx.store.insertIrObservation({ irId, attemptId: att.id, runnerId: 'agent:mock:default', windowId: 'win1:abc', confidence: 0.1, at: 2 });
check('an observation is one per (record, attempt)', ctx.store.irObservations(irId).length === 1 && ctx.store.irRecord(irId)!.observedBy[0] === 'agent:mock:default');
ctx.store.insertIrLink({ fromIr: irId, toIr: irId, kind: 'duplicates', basis: 'detector', createdAt: 1 });
check('links are read from either end', ctx.store.irLinks(irId).length === 1);

section('IR status moves only under a decision, along IR_TRANSITIONS');
check('approve without a decision row is refused',
  /decision/.test(throws(() => ctx.store.setIrStatus(irId, 'approved', 'd_' + '0'.repeat(32)))?.message ?? ''));
const d = ctx.store.recordDecision({ missionId: corpus.id, projectId: project.id, revision: commit, actor: HUMAN, kind: 'approve', rationale: 'ok', scope: {}, artifactIds: [] });
check('a human decision approves it', ctx.store.setIrStatus(irId, 'approved', d.id).status === 'approved');
check('approved → rejected is refused', throws(() => ctx.store.setIrStatus(irId, 'rejected', d.id)) !== null);
check('approved → superseded is legal', ctx.store.setIrStatus(irId, 'superseded', d.id).status === 'superseded');

section('ir-interpretation assumptions live on the corpus, open, naming their record');
const okAssumption = { campaignId: corpus.id, question: 'Which reading?', default: '', rationale: 'two readings', status: 'open' as const, blocking: true,
  source: 'ir-interpretation' as const, recordedBy: 'daylight', irId, ownerDecisionId: 'OIR.' + irId.slice(3, 13).toUpperCase() };
const u = ctx.store.recordAssumption(okAssumption);
check('an ir-interpretation row is recorded on a corpus mission with its ir id', u.irId === irId && u.campaignId === corpus.id && u.status === 'open');
check('one recorded pending is refused', throws(() => ctx.store.recordAssumption({ ...okAssumption, status: 'pending', recordedBy: HUMAN })) !== null);
check('one without an ir id is refused', throws(() => ctx.store.recordAssumption({ ...okAssumption, irId: undefined })) !== null);
check('one on a non-corpus mission is refused', throws(() => ctx.store.recordAssumption({ ...okAssumption, campaignId: audit.id })) !== null);
check('assumptionByOwnerDecision finds it across missions', ctx.store.assumptionByOwnerDecision(project.id, okAssumption.ownerDecisionId)?.id === u.id
  && ctx.store.assumptionByOwnerDecision(project.id, 'OIR.NONE') === null);

section('preflight: an outbox role is always sandboxed');
const live = detectSandbox();
check('bwrap and prlimit are installed (without them this fails, never skips)', live.available, live.why);
if (!live.available) done();

section('runMission({ outbox }): one mock extract attempt per task, over the attempt socket');
interface Note { note: string }
const NOTE_SPEC: OutboxToolSpec<Note> = {
  tool: OUTBOX_TOOLS.extract, description: 'record a note', inputSchema: { note: z.string().max(64) }, dirName: 'test-outbox', maxPerAttempt: 2, maxLineBytes: 512,
  validate: (raw) => {
    const r = raw as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Object.keys(r).some((k) => k !== 'note')) return { field: 'payload', refused: 'unknown field' };
    if (typeof r.note !== 'string' || !r.note) return { field: 'note', refused: 'not a string' };
    if (r.note === 'forbidden') return { field: 'note', refused: 'not allowed' };
    return { note: r.note };
  },
  redact: (v) => ({ note: v.note.replace(/secret/g, '[redacted]') }),
  eventDetail: () => ({ ok: true }),
};
const mockScript = path.join(tmp, 'mock-outbox.cjs');
fs.writeFileSync(mockScript, PROMPT_CALLS_MOCK);
process.env.DAYLIGHT_MOCK_ADAPTER = mockScript;
const t1 = ctx.store.createTask({ missionId: corpus.id, role: 'extract', objective: 'w1', runnerHint: 'mock' });
const t2 = ctx.store.createTask({ missionId: corpus.id, role: 'extract', objective: 'w2', runnerHint: 'mock:b' });
const notes: Record<string, string[]> = { [t1.id]: ['alpha', 'forbidden', 'a secret'], [t2.id]: ['beta'] };
const run: OutboxRun = {
  role: 'extract', taskIds: [t1.id, t2.id],
  promptFor: (t) => `extract window\n${callsLine((notes[t.id] ?? []).map((note) => ({ name: OUTBOX_TOOLS.extract, arguments: { note } })))}`,
  serve: (a) => createOutboxServer({ dir: out, attemptId: a.id, agentTool: 'mock', spec: NOTE_SPEC }).server,
  allowedTools: roleAllowlist('extract'),
};
const report = await runMission(ctx, { missionId: corpus.id, repo: root, tools: ['mock'], outbox: run, timeoutMs: 60_000 });
const attempts = [t1, t2].flatMap((t) => ctx.store.attempts(t.id));
check('one attempt per task, both completed, under the review profile', attempts.length === 2
  && attempts.every((a) => a.state === 'completed' && a.sandbox?.profile === 'review' && a.sandbox.network === 'none' && !a.sandbox.write),
  JSON.stringify(attempts.map((a) => [a.state, a.failure, a.sandbox?.profile])) + ' ' + report.unavailable.join(';'));
check('a repeated tool across tasks is not refused as a duplicate source', report.unavailable.length === 0, report.unavailable.join(';'));
check('no compare task follows an outbox run', !ctx.store.tasks(corpus.id).some((t) => t.role === 'compare'));
const a1 = ctx.store.attempts(t1.id)[0];
const box1 = fs.readFileSync(outboxPathOf(out, 'test-outbox', a1.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('the server filed what its validator accepted, redacted, at most its cap', box1.length === 2 && box1[0].payload.note === 'alpha'
  && box1[1].payload.note === 'a [redacted]' && box1.every((l) => l.v === 1 && l.tool === OUTBOX_TOOLS.extract), JSON.stringify(box1));

section('ingestOutbox: host re-validation, foreign and torn outboxes');
const forged = path.join(out, 'test-outbox', 'a_' + 'f'.repeat(32) + '.jsonl');
fs.writeFileSync(forged, JSON.stringify({ v: 1, at: 1, tool: OUTBOX_TOOLS.extract, payload: { note: 'forged' } }) + '\n');
const a2 = ctx.store.attempts(t2.id)[0];
const box2 = outboxPathOf(out, 'test-outbox', a2.id);
fs.appendFileSync(box2, JSON.stringify({ v: 1, at: 1, tool: 'x', payload: { note: 'forbidden' } }) + '\n'
  + JSON.stringify({ v: 1, at: 1, tool: 'x', payload: { note: 'secret' }, extra: 1 }) + '\n' + '{"v":1,"at":1,"tool":"x","payload":{"no');
const got: string[] = [];
const ingest = () => ingestOutbox(ctx, {
  missionId: corpus.id, role: 'extract', spec: NOTE_SPEC, validateFor: () => NOTE_SPEC.validate,
  accept: (_a, t, v) => got.push(`${t.runnerHint}:${v.note}`),
});
const r1 = ingest();
check('every line the host re-validates is accepted, attributed to its task', r1.accepted === 3 && [...got].sort().join(',') === 'mock:a [redacted],mock:alpha,mock:b:beta', got.join(','));
check('a line its validator refuses on the host is refused by field', r1.refused.some((x) => x.attemptId === a2.id && x.field === 'note' && x.line === 2));
check('an envelope with an extra key is refused', r1.refused.some((x) => x.attemptId === a2.id && x.field === 'line' && x.line === 3));
check('a torn last line is left for the next read, not refused', !r1.refused.some((x) => x.line === 4));
check('an outbox naming no known attempt is reported', r1.refused.some((x) => x.attemptId === 'a_' + 'f'.repeat(32) && x.field === 'attempt'));
check('no refusal echoes the text it refused', !JSON.stringify(r1.refused).includes('forbidden') && !JSON.stringify(r1.refused).includes('secret'));
fs.rmSync(box2);
fs.symlinkSync(path.join(out, 'view.json'), box2);
check('an outbox that is a link is refused, not followed', ingest().refused.some((x) => x.attemptId === a2.id && x.reason === 'the outbox is not a regular file'));

section('outbox runs are refused where they do not belong');
const spec = ctx.store.transitionMission(ctx.store.createMission({ projectId: project.id, kind: 'spec', objective: 's', baseRevision: commit }).id, 'ready');
check('an outbox run on a non-corpus mission is refused',
  /corpus mission/.test((await throwsAsync(() => runMission(ctx, { missionId: spec.id, repo: root, tools: ['mock'], outbox: run })))?.message ?? ''));
check('an outbox run that opts out of the sandbox is refused',
  /do not apply/.test((await throwsAsync(() => runMission(ctx, { missionId: corpus.id, repo: root, tools: ['mock'], outbox: run, noReviewSandbox: true })))?.message ?? ''));
check('an outbox run with a role or prompt as well is refused',
  /bring|brings/.test((await throwsAsync(() => runMission(ctx, { missionId: corpus.id, repo: root, tools: ['mock'], outbox: run, prompt: 'p' })))?.message ?? ''));
check('an outbox task of another role is not run', (await runMission(ctx, { missionId: corpus.id, repo: root, tools: ['mock'], outbox: { ...run, role: 'architect' }, dryRun: true }))
  .unavailable.length === 2);
check('createOutboxServer is bound to one attempt id', throws(() => createOutboxServer({ dir: out, attemptId: 'nope', spec: NOTE_SPEC })) !== null);

ctx.close();
done();
