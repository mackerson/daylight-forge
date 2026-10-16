/**
 * Usage capture and the project ledger. Run: node engine/test/ledger.ts
 *
 * Mock streams only: every provider line here is synthetic, and no real agent binary runs.
 * The properties that carry the weight: a turn is counted once however its usage is split
 * across lines; a figure nobody reported is `unknown`, never zero; a scraped figure is spend,
 * never knowledge; and no secret value reaches an event, an artifact, the database or a report.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../mission/artifacts.ts';
import { projectReportText } from '../mission/commands-report.ts';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { EventLog } from '../mission/events.ts';
import { exportMission, importMission } from '../mission/export.ts';
import { dollarsOf, ledger, missionSpend, spendRefusal, totalOf, trailersFor } from '../mission/ledger.ts';
import { newId } from '../mission/store.ts';
import { costKnown, type ArtifactRef, type ProjectIdentity, type TokenUsage } from '../mission/types.ts';
import type { Adapter } from '../swarm/adapters.ts';
import { captureRun, type AttemptFinisher, type CaptureContext } from '../swarm/capture.ts';
import { normalize, type Provider } from '../swarm/normalize.ts';
import { credentialFor, LineSplitter, missionSpend as usageMissionSpend, UsageAccumulator } from '../swarm/usage.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-ledger-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// `commands.ts` does not dispatch `report --project` yet (the integrator adds that line), so the
// CLI tests drive the module's own entry in a child, as the dispatch will.
const driver = path.join(tmp, 'report-driver.mjs');
fs.writeFileSync(driver, `
  const { runProjectReport } = await import(${JSON.stringify(path.resolve(import.meta.dirname, '..', 'mission', 'commands-report.ts'))});
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf('--out') + 1];
  process.exitCode = runProjectReport(argv.slice(1), () => out);
`);
const cli = (args: string[]) => {
  const r = spawnSync(process.execPath, [driver, ...args], { encoding: 'utf8', env: { ...process.env } });
  return { code: r.status, stdout: r.stdout, err: r.stderr };
};

/** A child that prints `lines` to stdout, each a separate write, then exits 0. */
const printer = (lines: string[], opts: { name?: string; streamShape?: Provider } = {}): Adapter => ({
  name: opts.name ?? 'mock',
  bin: process.execPath,
  perInvocationMcp: true,
  streamShape: opts.streamShape,
  argv: () => ['-e', `for (const l of ${JSON.stringify(lines)}) process.stdout.write(l + '\\n');`],
});

/** Records what capture told the store, for the tests that need no database. */
class Finisher implements AttemptFinisher {
  calls: Array<Parameters<AttemptFinisher['finishAttempt']>[1]> = [];
  finishAttempt(_id: string, result: Parameters<AttemptFinisher['finishAttempt']>[1]) {
    this.calls.push(result);
  }
}

async function captureInto(dir: string, adapter: Adapter, store: AttemptFinisher, attemptId = 'a_1') {
  fs.mkdirSync(dir, { recursive: true });
  const events = new EventLog(dir);
  const artifacts = new ArtifactStore(dir);
  try {
    const result = await captureRun(adapter, { prompt: 'x', cwd: tmp, mcpConfigPath: '/dev/null', session: 's', timeoutMs: 10_000 }, {
      store, events, artifacts, projectId: 'git:aaaaaaaaaaaa', missionId: 'm_1', taskId: 't_1', attemptId,
      runnerId: `agent:${adapter.name}:test`, revision: 'base1',
    });
    return { result, events: events.forAttempt(attemptId) };
  } finally {
    events.close();
  }
}

const assistant = (id: string, usage: Record<string, number>, model = 'claude-test-1') =>
  JSON.stringify({ type: 'assistant', message: { id, model, content: [{ type: 'text', text: 'x' }], usage } });

section('normalize: usage per turn, provider cost under its own name');
{
  const turn = normalize('claude', assistant('msg_1', { input_tokens: 10, output_tokens: 3 })).find((e) => e.name === 'cost.usage');
  check('a claude assistant line with usage is a turn named by its message id',
    turn?.payload.scope === 'turn' && turn.payload.requestId === 'msg_1' && turn.payload.model === 'claude-test-1'
      && turn.payload.inputTokens === 10 && turn.payload.outputTokens === 3 && turn.payload.cacheReadTokens === null,
    JSON.stringify(turn?.payload));
  const result = normalize('claude', JSON.stringify({ type: 'result', total_cost_usd: 0.05, num_turns: 1 }));
  check('a claude result is provider.cost, not cost.reported',
    result.some((e) => e.name === 'provider.cost' && e.payload.costUsd === 0.05) && !result.some((e) => e.name === 'cost.reported'));
  const summary = result.find((e) => e.name === 'cost.usage');
  check('and a summary usage carrying the cost, with no tokens it did not report',
    summary?.payload.scope === 'summary' && summary.payload.requestId === 'result' && summary.payload.costUsd === 0.05
      && summary.payload.inputTokens === null, JSON.stringify(summary?.payload));
  check('a result with neither usage nor cost has no usage event',
    !normalize('claude', JSON.stringify({ type: 'result', num_turns: 1 })).some((e) => e.name === 'cost.usage'));
  const codexTurn = normalize('codex', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }))
    .find((e) => e.name === 'cost.usage');
  check('a codex turn has no id and no cost', codexTurn?.payload.scope === 'turn' && codexTurn.payload.requestId === null
    && codexTurn.payload.costUsd === null);
  const thread = normalize('codex', JSON.stringify({ type: 'thread.completed', usage: { input_tokens: 5 } })).find((e) => e.name === 'cost.usage');
  check('a codex thread total is a summary, a cross-check', thread?.payload.scope === 'summary');
}

/** Every usage row a stream yields, fed through the splitter in chunks of `size` bytes. */
function accumulate(provider: Provider, stream: string, size: number) {
  const acc = new UsageAccumulator(provider);
  const split = new LineSplitter();
  for (let i = 0; i < stream.length; i += size) {
    for (const line of split.push(stream.slice(i, i + size))) for (const ev of normalize(provider, line)) acc.observe(ev);
  }
  for (const line of split.end()) for (const ev of normalize(provider, line)) acc.observe(ev);
  return acc;
}

section('usage accumulation: one row per turn, however the lines split');
{
  // One claude message whose usage is repeated, growing, across three lines; then a second
  // message; then the result. The second line of msg_1 is the full count.
  const stream = [
    assistant('msg_1', { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50 }),
    assistant('msg_1', { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 50, cache_creation_input_tokens: 7 }),
    assistant('msg_1', { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 50, cache_creation_input_tokens: 7 }),
    assistant('msg_2', { input_tokens: 20, output_tokens: 5 }),
    JSON.stringify({ type: 'result', total_cost_usd: 0.07, num_turns: 2,
      usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 50, cache_creation_input_tokens: 7 } }),
  ].join('\n') + '\n';
  const whole = accumulate('claude', stream, stream.length);
  const bytewise = accumulate('claude', stream, 1);
  check('byte-by-byte is the same as the whole stream',
    JSON.stringify(bytewise.rows()) === JSON.stringify(whole.rows()) && JSON.stringify(bytewise.totals()) === JSON.stringify(whole.totals()));
  const rows = whole.rows();
  check('one message id over three lines is one row', rows.filter((r) => r.requestId === 'msg_1').length === 1, JSON.stringify(rows));
  check('and the fullest line wins (MAX merge)', rows[0].tokens.output === 40 && rows[0].tokens.cacheWrite === 7);
  check('two repeats are counted as dupes, not as turns', whole.totals().dupes === 2, String(whole.totals().dupes));
  const result = rows.find((r) => r.requestId === 'result');
  check('the result carries the dollars and none of the tokens the turns already have',
    result?.costUsd === 0.07 && result.costSource === 'provider' && result.tokens.input === null, JSON.stringify(result));
  const t = whole.totals();
  check('totals are the turns, not turns plus summary',
    t.tokens.input === 120 && t.tokens.output === 45 && t.tokens.cacheRead === 50 && t.tokens.cacheWrite === 7, JSON.stringify(t.tokens));
  check('the cost is the provider\'s and known', t.costUsd === 0.07 && t.costSource === 'provider' && t.usageSource === 'provider');
  check('the model is the one the provider reported', t.model === 'claude-test-1');

  const disagree = new UsageAccumulator('claude');
  for (const line of [assistant('m', { input_tokens: 10 }), JSON.stringify({ type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 99 } })]) {
    for (const ev of normalize('claude', line)) disagree.observe(ev);
  }
  const mism = new UsageAccumulator('claude');
  const changes = [assistant('m', { input_tokens: 10 }), JSON.stringify({ type: 'result', usage: { input_tokens: 99 } })]
    .flatMap((l) => normalize('claude', l)).flatMap((ev) => mism.observe(ev));
  check('a summary that disagrees with the turns is reported, and the turns stand',
    changes.some((c) => c.kind === 'mismatch' && c.field === 'input' && c.summary === 99 && c.turns === 10)
      && disagree.totals().tokens.input === 10);

  const resultOnly = accumulate('claude', JSON.stringify({ type: 'result', total_cost_usd: 0.02,
    usage: { input_tokens: 9, output_tokens: 4 } }) + '\n', 7);
  check('a result-only stream falls back to the result\'s tokens',
    resultOnly.rows().length === 1 && resultOnly.totals().tokens.input === 9 && resultOnly.totals().costUsd === 0.02);

  const empty = accumulate('claude', '{"type":"system","subtype":"init"}\n', 3);
  check('a stream with no usage has null tokens and no cost, never zero',
    empty.rows().length === 0 && empty.totals().tokens.input === null && empty.totals().costUsd === null
      && empty.totals().usageSource === 'none' && empty.totals().costSource === 'none');

  const codex = accumulate('codex', [
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 6 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 2 } }),
    JSON.stringify({ type: 'thread.completed', usage: { input_tokens: 42, cached_input_tokens: 10, output_tokens: 8 } }),
  ].join('\n'), 5);
  const ct = codex.totals();
  check('codex turns are numbered rows', codex.rows().map((r) => r.requestId).join() === 'turn:1,turn:2', codex.rows().map((r) => r.requestId).join());
  check('codex tokens are kept, cached input beside input and never added to it',
    ct.tokens.input === 42 && ct.tokens.cacheRead === 10 && ct.tokens.output === 8 && ct.tokens.cacheWrite === null, JSON.stringify(ct.tokens));
  check('codex cost is null with source none', ct.costUsd === null && ct.costSource === 'none'
    && codex.rows().every((r) => r.costUsd === null && r.costSource === 'none'));
}

section('a test double declares the stream shape it wants read');
await (async () => {
  const result = JSON.stringify({ type: 'result', total_cost_usd: 0.05, num_turns: 1 });
  const declared = new Finisher();
  await captureInto(path.join(tmp, 'shape-claude'), printer([result], { streamShape: 'claude' }), declared);
  check('a mock declaring the claude shape has its cost read as the provider\'s',
    declared.calls[0]?.costUsd === 0.05 && declared.calls[0].costSource === 'provider', JSON.stringify(declared.calls[0]));
  const undeclared = new Finisher();
  await captureInto(path.join(tmp, 'shape-none'), printer([result]), undeclared);
  check('the same output from a mock that declares nothing is a scan, not knowledge',
    undeclared.calls[0]?.costUsd === 0.05 && undeclared.calls[0].costSource === 'stdout-scan', JSON.stringify(undeclared.calls[0]));
})();

const PROJECT: ProjectIdentity = { id: 'git:aaaaaaaaaaaa', root: '/repo/a', name: 'a' };
const HUMAN = 'human:miz';

function fresh(name: string): DaylightContext {
  const ctx = openDaylight(path.join(tmp, name));
  ctx.store.ensureProject(PROJECT);
  return ctx;
}

/** A review attempt on a new task of `missionId`, run through the real capture into the real store. */
async function captured(ctx: DaylightContext, missionId: string, adapter: Adapter, runnerId: string, extra: Partial<CaptureContext> = {}) {
  const task = ctx.store.createTask({ missionId, role: 'review', objective: runnerId });
  const a = ctx.store.startAttempt({ taskId: task.id, runnerId });
  await captureRun(adapter, { prompt: 'x', cwd: tmp, mcpConfigPath: '/dev/null', session: `${missionId}:${a.id}`, timeoutMs: 10_000 }, {
    store: ctx.store, events: ctx.events, artifacts: ctx.artifacts, projectId: PROJECT.id, missionId,
    taskId: task.id, attemptId: a.id, runnerId, revision: 'base1', ...extra,
  });
  return ctx.store.attempt(a.id)!;
}

section('capture records each turn once and promotes totals onto the attempt');
await (async () => {
  const ctx = fresh('capture');
  const m = ctx.store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'usage', baseRevision: 'base1' });
  const claudeStream = printer([
    assistant('msg_a', { input_tokens: 10, output_tokens: 1 }),
    assistant('msg_a', { input_tokens: 10, output_tokens: 8 }),
    assistant('msg_a', { input_tokens: 10, output_tokens: 8 }),
    assistant('msg_b', { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 30 }),
    JSON.stringify({ type: 'result', total_cost_usd: 0.03, num_turns: 2 }),
  ], { name: 'claude' });
  const a = await captured(ctx, m.id, claudeStream, 'agent:claude:test');
  const rows = ctx.store.usageRows(a.id);
  check('a duplicate request id is one attempt_usage row', rows.filter((r) => r.requestId === 'msg_a').length === 1 && rows.length === 3,
    rows.map((r) => r.requestId).join());
  check('the row holds the merged counts', rows[0].tokens.output === 8);
  check('attempt token columns are the sum of the rows',
    a.tokens.input === 14 && a.tokens.output === 10 && a.tokens.cacheRead === 30 && a.tokens.cacheWrite === null, JSON.stringify(a.tokens));
  check('with their source and the reported model', a.usageSource === 'provider' && a.model === 'claude-test-1');
  check('the cost is the provider\'s, known', a.costUsd === 0.03 && a.costSource === 'provider');
  const ev = ctx.events.forAttempt(a.id);
  const usageEvents = ev.filter((e) => e.name === 'cost.usage');
  check('a repeat that adds nothing writes no event; a merge says so',
    usageEvents.length === 4 && usageEvents.filter((e) => e.payload.merged === true).length === 1, String(usageEvents.length));
  check('every usage event names its row', usageEvents.every((e) => typeof e.payload.seq === 'number'));
  const summary = ev.filter((e) => e.name === 'cost.reported');
  check('one cost.reported, carrying the totals and the dupe count',
    summary.length === 1 && (summary[0].payload.tokens as TokenUsage).input === 14 && summary[0].payload.dupes === 2);

  const codexStream = printer([
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 3 } }),
  ], { name: 'codex' });
  const c = await captured(ctx, m.id, codexStream, 'agent:codex:test');
  check('a codex stream records tokens with cost null and source none',
    c.costUsd === null && c.costSource === 'none' && c.tokens.input === 7 && c.usageSource === 'provider'
      && ctx.store.usageRows(c.id).every((r) => r.costUsd === null && r.costSource === 'none'));

  const scraped = await captured(ctx, m.id, printer([JSON.stringify({ total_cost_usd: 0.2 })]), 'agent:mock:scan');
  check('a scraped cost is stdout-scan, never known', scraped.costUsd === 0.2 && scraped.costSource === 'stdout-scan'
    && !costKnown(scraped.costSource));
  check('and writes no usage row: a scan is not a provider turn', ctx.store.usageRows(scraped.id).length === 0
    && scraped.usageSource === 'none' && scraped.tokens.input === null);

  const cred = credentialFor('DAYLIGHT_TEST_CAPPED_KEY', 'forge-capped-1', { DAYLIGHT_TEST_CAPPED_KEY: 'x'.repeat(40) });
  check('a credential is a presence, a name and a label', cred.present && cred.envName === 'DAYLIGHT_TEST_CAPPED_KEY'
    && cred.label === 'forge-capped-1' && !JSON.stringify(cred).includes('xxxx'));
  check('an absent variable is recorded absent', !credentialFor('DAYLIGHT_TEST_ABSENT', null, {}).present);
  const labelled = await captured(ctx, m.id, printer(['ok']), 'agent:mock:cred', { credential: cred });
  const start = ctx.events.forAttempt(labelled.id).find((e) => e.name === 'process.start');
  check('process.start names the credential, never its value',
    JSON.stringify(start?.payload.credential) === JSON.stringify(cred));
  let refused: unknown = null;
  try {
    await captured(ctx, m.id, printer(['ok']), 'agent:mock:leak', {
      credential: { present: true, envName: 'ANTHROPIC_API_KEY', label: 'sk-ant-api03-abcdefghijklmnop' },
    });
  } catch (err) {
    refused = err;
  }
  check('a label shaped like a secret is refused before the agent runs', refused instanceof Error && /secret/.test(refused.message));

  const silent = await captured(ctx, m.id, printer(['hello']), 'agent:mock:silent');
  check('an attempt that reported nothing has unknown cost and tokens, not zero',
    silent.costUsd === null && silent.costSource === 'none' && silent.tokens.input === null && silent.usageSource === 'none');
  ctx.close();
})();

/**
 * One project, every kind of row the ledger reads: a spec mission whose decomposer reported no
 * cost, an approved work item, an implement mission with an author attempt, an accepted and
 * applied candidate, review attempts at known, unknown and scanned cost, and an ingested session.
 */
function buildFixture(ctx: DaylightContext) {
  const s = ctx.store;
  const art = (text: string, kind: ArtifactRef['kind']) => {
    const ref = ctx.artifacts.put(text, { kind, projectId: PROJECT.id, revision: 'base1' });
    s.recordArtifact(ref);
    return ref;
  };
  const finished = (taskId: string, runnerId: string, fin: Partial<Parameters<typeof s.finishAttempt>[1]>, start: Parameters<typeof s.startAttempt>[0] extends infer I ? Partial<I> : never = {}) => {
    const a = s.startAttempt({ taskId, runnerId, ...start });
    return s.finishAttempt(a.id, { state: 'completed', costUsd: null, ...fin });
  };
  const tokens = (input: number, output: number): TokenUsage => ({ input, output, cacheRead: 0, cacheWrite: 0 });

  const spec = s.createMission({ projectId: PROJECT.id, kind: 'spec', objective: 'decompose', baseRevision: 'base1' });
  const decompose = finished(s.createTask({ missionId: spec.id, role: 'decompose', objective: 'propose' }).id, 'agent:mock:plan', {});
  const wInput = {
    projectId: PROJECT.id, missionId: spec.id, attemptId: decompose.id, specArtifact: art('# Spec\n', 'spec'), specRevision: 'base1',
    anchor: 'login', title: 'Login', statement: 'Users can log in', examples: ['ok'], negativeExamples: ['bad'], proposedBy: 'agent:mock:plan',
  };
  const w = s.createWorkItem({ ...wInput, id: newId('workItem') });
  const approveItem = s.recordDecision({
    missionId: spec.id, projectId: PROJECT.id, revision: 'base1', actor: HUMAN, kind: 'approve', rationale: 'ok',
    scope: { operation: 'approve-work-item', workItemId: w.id, contentDigest: w.contentDigest }, artifactIds: [],
  });
  s.setWorkItemStatus(w.id, 'proposed', 'approved', approveItem.id);

  const impl = s.createMission({ projectId: PROJECT.id, kind: 'implement', objective: 'build login', baseRevision: 'base1', workItemId: w.id });
  const { decision: grant } = s.authorizeMission({
    missionId: impl.id, actor: HUMAN, rationale: 'go', permissions: { write: true, execute: false }, maxUsd: 1,
  });
  const author = finished(s.createTask({ missionId: impl.id, role: 'author', objective: 'write' }).id, 'agent:claude:sonnet',
    { costUsd: 0.41, costSource: 'provider', tokens: tokens(12034, 3311), usageSource: 'provider', model: 'claude-sonnet-test' },
    { sandbox: { profile: 'author', network: 'shared', write: true, exec: false, authorizeDecisionId: grant.id }, gateSetDigest: 'sha256:gs1' });
  const diff = art('diff --git a/x b/x\n', 'diff');
  const c = s.createCandidate({
    missionId: impl.id, attemptId: author.id, projectId: PROJECT.id, baseCommit: 'base1', diffArtifact: diff,
    summaryArtifact: art('{"files":1}', 'summary'), files: [], policyViolations: [], secretHits: 0, gateSetDigest: 'sha256:gs1',
    profile: { name: 'author', network: 'shared', write: true, exec: false }, attemptState: 'completed',
  });
  s.updateCandidateVerdict(c.id, 'accepted-by-gates', ['all gates supported']);
  const approve = s.recordDecision({
    missionId: impl.id, projectId: PROJECT.id, revision: 'base1', actor: HUMAN, kind: 'approve', rationale: 'good',
    scope: { operation: 'approve-candidate', candidateId: c.id, diffDigest: diff.digest, gateSetDigest: 'sha256:gs1', baseCommit: 'base1' }, artifactIds: [],
  });
  const p = s.recordApplication({ candidateId: c.id, decisionId: approve.id, baseCommit: 'base1', commit: 'c0ffee'.padEnd(40, '0'), ref: 'refs/heads/daylight/x/y', appliedBy: HUMAN });

  const review = s.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'look', baseRevision: 'base2' });
  const rt = () => s.createTask({ missionId: review.id, role: 'review', objective: 'r' }).id;
  const known = finished(rt(), 'agent:claude:sonnet', { costUsd: 0.05, costSource: 'provider', tokens: tokens(100, 10), usageSource: 'provider', model: 'claude-sonnet-test' });
  const unknown = finished(rt(), 'agent:codex:default', { tokens: { input: 70, output: 7, cacheRead: 20, cacheWrite: null }, usageSource: 'provider' });
  const scanned = finished(rt(), 'agent:mock:scan', { costUsd: 0.2, costSource: 'stdout-scan' });

  const work = s.createMission({ projectId: PROJECT.id, kind: 'work', objective: 'sessions', baseRevision: 'base2' });
  const ingested = finished(s.createTask({ missionId: work.id, role: 'session', objective: 's' }).id, 'ingest:claude-code',
    { tokens: tokens(500, 50), usageSource: 'transcript', model: 'claude-opus-test' }, { origin: 'ingested' });
  return { spec, w, impl, author, c, p, review, known, unknown, scanned, work, ingested, decompose };
}

section('the ledger, by runner, model, origin, mission, work item and actor');
{
  const ctx = fresh('fixture');
  const f = buildFixture(ctx);
  const byRunner = ledger(ctx, { projectId: PROJECT.id, group: 'runner' });
  const row = (l: typeof byRunner, key: string) => l.rows.find((r) => r.key === key);
  const sonnet = row(byRunner, 'agent:claude:sonnet')!;
  check('grouping by runner equals the hand count', sonnet.attempts === 2 && sonnet.usdKnown === 0.46 && sonnet.usdUnknownCount === 0
    && sonnet.tokens.input === 12134 && sonnet.candidates.accepted === 1 && sonnet.candidates.applied === 1, JSON.stringify(sonnet));
  check('a decision about a candidate is counted on its runner\'s row', sonnet.decisions === 1);
  check('the gate set an attempt ran against is listed', sonnet.gateSetDigests.join() === 'sha256:gs1');
  const codex = row(byRunner, 'agent:codex:default')!;
  check('an unknown cost is a count, not a zero dollar', codex.usdUnknownCount === 1 && codex.usdKnown === 0 && dollarsOf(codex) === 'unknown');
  const scan = row(byRunner, 'agent:mock:scan')!;
  check('a scanned cost is never known', scan.usdKnown === 0 && scan.usdScanned === 0.2 && /scanned, not known/.test(dollarsOf(scan)));
  check('tokens nobody reported are counted as unknown', scan.tokens.unknownCount === 1 && row(byRunner, 'agent:mock:plan')!.tokens.unknownCount === 1);
  const t = totalOf(byRunner.rows);
  check('the total is a floor that says how much is unknown and scanned',
    dollarsOf(t) === '≥ $0.46 (3 unknown, $0.20 scanned, not known)', dollarsOf(t));

  const byModel = ledger(ctx, { projectId: PROJECT.id, group: 'model' });
  check('grouping by model uses the reported model', row(byModel, 'claude-sonnet-test')?.attempts === 2);
  check('and labels an asked-for model as asked when none was reported', row(byModel, 'plan (asked; not reported)')?.attempts === 1
    && row(byModel, 'unknown')?.attempts === 1, byModel.rows.map((r) => r.key).join());

  const byOrigin = ledger(ctx, { projectId: PROJECT.id, group: 'origin' });
  check('origin splits ingested work from Daylight\'s', row(byOrigin, 'ingested')?.attempts === 1 && row(byOrigin, 'daylight')?.attempts === 5);
  check('ingested dollars are unknown, never estimated from tokens', dollarsOf(row(byOrigin, 'ingested')!) === 'unknown'
    && row(byOrigin, 'ingested')!.tokens.input === 500);

  const byMission = ledger(ctx, { projectId: PROJECT.id, group: 'mission' });
  check('grouping by mission counts each mission\'s attempts and decisions', row(byMission, f.impl.id)?.attempts === 1
    && row(byMission, f.impl.id)?.decisions === 2 && row(byMission, f.spec.id)?.decisions === 1);
  const byItem = ledger(ctx, { projectId: PROJECT.id, group: 'work-item' });
  check('grouping by work item puts the implement attempt under its item', row(byItem, f.w.id)?.attempts === 1 && row(byItem, 'none')?.attempts === 5);

  const byActor = ledger(ctx, { projectId: PROJECT.id, group: 'actor' });
  const human = row(byActor, HUMAN);
  check('a human row carries decisions, never dollars or attempts', human?.attempts === 0 && human.decisions === 3
    && human.usdKnown === 0 && dollarsOf(human) === '—');
  check('decisions are counted by actor and operation', byRunner.decisions.map((d) => `${d.actor}:${d.operation}:${d.count}`).sort().join()
    === [`${HUMAN}:approve-candidate:1`, `${HUMAN}:approve-work-item:1`, `${HUMAN}:authorize-mission:1`].join());
  check('work items, applications and revisions are listed', byRunner.workItems.length === 1 && byRunner.workItems[0].status === 'approved'
    && byRunner.applications.map((p) => p.id).join() === f.p.id
    && byRunner.revisions.map((r) => `${r.revision}:${r.missions}:${r.attempts}`).join() === 'base1:2:2,base2:2:4');
  const onlyIngested = ledger(ctx, { projectId: PROJECT.id, group: 'runner', origin: 'ingested' });
  check('an origin filter keeps only that origin', onlyIngested.rows.map((r) => r.key).join() === 'ingest:claude-code'
    && onlyIngested.decisions.length === 0 && onlyIngested.workItems.length === 0);
  check('the ledger carries no timestamp', !/"(at|exportedAt|createdAt|generatedAt)"/.test(JSON.stringify({ ...byRunner, applications: [] })));
  check('the ledger reads no other project', ledger(ctx, { projectId: 'git:bbbbbbbbbbbb', group: 'runner' }).rows.length === 0);

  const text = projectReportText(ctx, PROJECT.id);
  if (process.env.DAYLIGHT_LEDGER_SHOW) process.stdout.write(text);
  check('the report shows an unknown-cost attempt as the word unknown', /`agent:codex:default` \| 1 \| unknown \|/.test(text), text);
  check('a token field an attempt did not report is unknown, not 0', /`agent:codex:default` \| 1 \| unknown \| 70 \| 7 \| 20 \| unknown \|/.test(text));
  check('and never prints a zero for it', !/`agent:codex:default` \| 1 \| \$0\.00/.test(text) && !/`agent:mock:plan` \| 1 \| \$0\.00/.test(text));
  check('ingested work is labelled outside Daylight\'s controls', text.includes("Ingested — outside Daylight's controls")
    && text.includes("ingested — outside Daylight's controls"));
  check('the report has decisions, work items, candidates, applications and revisions',
    ['## Decisions by actor', '## Work items', '## Candidates', '## Applications', '## Revisions'].every((h) => text.includes(h)));
  check('no price table and no tokens turned into dollars', !/per (1k|million|token)|price/i.test(text));
  ctx.close();
}

section('mission spend is the sum over every attempt, across runs');
await (async () => {
  const dir = 'spend';
  let ctx = fresh(dir);
  const m = ctx.store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'budget', baseRevision: 'base1', budget: { maxUsd: 0.12 } });
  const mock = printer([JSON.stringify({ type: 'result', total_cost_usd: 0.05, num_turns: 1 })], { streamShape: 'claude' });
  await captured(ctx, m.id, mock, 'agent:mock:yes');
  ctx.close();
  // A second run: a new process, a new context, the same mission.
  ctx = openDaylight(path.join(tmp, dir));
  const before = missionSpend(ctx, m.id);
  check('a second run starts from what the first spent', before.spentUsd === 0.05 && before.knownUsd === 0.05 && before.costKnown);
  check('so under a $0.12 ceiling it may go on', spendRefusal(before, 0.12) === null);
  await captured(ctx, m.id, mock, 'agent:mock:yes');
  await captured(ctx, m.id, mock, 'agent:mock:yes');
  const after = missionSpend(ctx, m.id);
  check('three $0.05 attempts across two runs are $0.15', after.spentUsd === 0.15, String(after.spentUsd));
  check('and the next is refused under the ceiling', /budget exhausted/.test(spendRefusal(after, 0.12) ?? ''), String(spendRefusal(after, 0.12)));
  await captured(ctx, m.id, printer([JSON.stringify({ total_cost_usd: 0.01 })]), 'agent:mock:scan');
  await captured(ctx, m.id, printer(['quiet']), 'agent:mock:no');
  const mixed = missionSpend(ctx, m.id);
  check('a scanned figure counts toward spend, not toward known', mixed.spentUsd === 0.16 && mixed.knownUsd === 0.15 && mixed.scannedCount === 1);
  check('an unknown figure makes the total a floor', mixed.unknownCount === 1 && !mixed.costKnown);
  check('and an unknown cost blocks under a ceiling it might already be past', /cannot be enforced/.test(spendRefusal({ ...mixed, spentUsd: 0 }, 1) ?? ''));
  check('the swap site can import it from swarm/usage.ts', usageMissionSpend === missionSpend);
  ctx.close();
})();

section('trailers carry mission and attempt ids only');
{
  const m = newId('mission');
  const a = newId('attempt');
  const t = trailersFor(m, a);
  check('exactly a Daylight-Mission and a Daylight-Attempt line', t.length === 2 && t[0] === `Daylight-Mission: ${m}` && t[1] === `Daylight-Attempt: ${a}`);
  check('no dollars or tokens in git history', !t.some((l) => /cost|usd|token|\$/i.test(l)));
  let refused = 0;
  for (const [mm, aa] of [[`${m}\nDaylight-Cost: usd=9`, a], [m, 'a_short'], [a, m]]) {
    try {
      trailersFor(mm, aa);
    } catch {
      refused++;
    }
  }
  check('anything but well-formed ids is refused, so nothing can be smuggled into a trailer', refused === 3);
}

section('export v2 carries the ledger: export → import → ledger is byte-equal');
{
  const ctx = fresh('roundtrip');
  buildFixture(ctx);
  const before = JSON.stringify(ledger(ctx, { projectId: PROJECT.id, group: 'runner' }));
  const beforeModel = JSON.stringify(ledger(ctx, { projectId: PROJECT.id, group: 'model' }));
  const files = ctx.store.missions(PROJECT.id).map((m) => JSON.parse(JSON.stringify(exportMission(ctx, m.id))));
  ctx.close();
  const into = openDaylight(path.join(tmp, 'roundtrip-into'));
  for (const file of files) importMission(into, file);
  check('the runner ledger survives the round trip byte for byte', JSON.stringify(ledger(into, { projectId: PROJECT.id, group: 'runner' })) === before);
  check('and the model ledger', JSON.stringify(ledger(into, { projectId: PROJECT.id, group: 'model' })) === beforeModel);
  into.close();
}

section('report --project: refusals and formats');
{
  const out = path.join(tmp, 'fixture');
  const json = cli(['report', '--project', PROJECT.id, '--out', out, '--format', 'json', '--group', 'runner']);
  type JsonRow = { key: string; tokensKnown: boolean; tokensReported: Record<string, number | null>; tokensUnknownByField: Record<string, number> };
  const parsed = json.code === 0 ? JSON.parse(json.stdout) as { kind: string; rows: JsonRow[] } : null;
  check('json is one Ledger document', parsed?.kind === 'daylight-ledger' && parsed.rows.length > 0, json.err);
  const jrow = (k: string) => parsed?.rows.find((r) => r.key === k);
  check('json says a token field nobody reported is unknown (null), not 0',
    jrow('agent:codex:default')?.tokensReported.cacheWrite === null && jrow('agent:codex:default')?.tokensReported.input === 70
      && jrow('agent:codex:default')?.tokensUnknownByField.cacheWrite === 1 && jrow('agent:codex:default')?.tokensKnown === false,
    JSON.stringify(jrow('agent:codex:default')));
  check('and an attempt with no usage at all is null in every field',
    Object.values(jrow('agent:mock:plan')?.tokensReported ?? { x: 0 }).every((v) => v === null) && jrow('agent:mock:plan')?.tokensKnown === false);
  check('a fully reported row is known', jrow('agent:claude:sonnet')?.tokensKnown === true);
  const text = cli(['report', '--project', PROJECT.id, '--out', out]);
  check('text is the whole ledger', text.code === 0 && text.stdout.includes('# Ledger') && text.stdout.includes('unknown'), text.err);
  const bare = cli(['report', '--project', '--out', out]);
  check('a bare --project means the one project this directory holds', bare.code === 0, bare.err);
  const foreign = cli(['report', '--project', 'git:bbbbbbbbbbbb', '--out', out]);
  check('a project this directory does not hold is refused', foreign.code === 1 && /not the project/.test(foreign.err), foreign.err);
  check('a bad --group is a usage error', cli(['report', '--project', PROJECT.id, '--out', out, '--group', 'price']).code === 2);
}

section('no secret value reaches an event, an artifact, the database or a report');
await (async () => {
  const shaped = 'sk-ant-api03-PLANTEDFAKEKEYabcdefghijklmnop0123';
  const unshaped = 'plantedfakecredentialvalue-0123456789';
  const saved = { a: process.env.ANTHROPIC_API_KEY, b: process.env.DAYLIGHT_TEST_CREDENTIAL };
  process.env.ANTHROPIC_API_KEY = shaped;
  process.env.DAYLIGHT_TEST_CREDENTIAL = unshaped;
  try {
    const ctx = fresh('secrets');
    const m = ctx.store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'leak', baseRevision: 'base1' });
    const leaky: Adapter = {
      name: 'mock', bin: process.execPath, perInvocationMcp: true, streamShape: 'claude',
      argv: () => ['-e', `
        const k = process.env.ANTHROPIC_API_KEY, u = process.env.DAYLIGHT_TEST_CREDENTIAL;
        console.log('ANTHROPIC_API_KEY=' + k + ' DAYLIGHT_TEST_CREDENTIAL=' + u);
        console.error('stderr also has ' + k + ' and ' + u);
        console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg_' + u, model: k, content: [{ type: 'tool_use', id: 't', name: 'Read', input: { path: k } }], usage: { input_tokens: 3 } } }));
        console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.01, num_turns: 1, subtype: u }));
      `],
    };
    const a = await captured(ctx, m.id, leaky, 'agent:mock:leak', {
      credential: credentialFor('ANTHROPIC_API_KEY', 'forge-capped-1'),
    });
    const report = projectReportText(ctx, PROJECT.id);
    const ledgerJson = JSON.stringify(ledger(ctx, { projectId: PROJECT.id, group: 'model' }));
    const exported = JSON.stringify(exportMission(ctx, m.id));
    ctx.close();
    const bytes: Buffer[] = [];
    const walk = (dir: string) => {
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n);
        if (fs.statSync(p).isDirectory()) walk(p);
        else bytes.push(fs.readFileSync(p));
      }
    };
    walk(path.join(tmp, 'secrets'));
    const everything = Buffer.concat([...bytes, Buffer.from(report), Buffer.from(ledgerJson), Buffer.from(exported)]);
    check('the planted key is in no file, event, report, ledger or export', !everything.includes(shaped) && !everything.includes('PLANTEDFAKEKEY'));
    check('nor the planted unshaped credential', !everything.includes(unshaped));
    check('the attempt still recorded its usage and cost', a.costUsd === 0.01 && a.tokens.input === 3);
    check('and the credential as present, by name and label', a.credential === undefined
      && exported.includes('"envName":"ANTHROPIC_API_KEY"') && exported.includes('"present":true'));
  } finally {
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.b === undefined) delete process.env.DAYLIGHT_TEST_CREDENTIAL; else process.env.DAYLIGHT_TEST_CREDENTIAL = saved.b;
  }
})();

section('a key nobody put in the environment, glued to a word, still persists nowhere');
await (async () => {
  // The reviewer's sentinels (ws5-review F1): not in process.env, so only shape and field
  // whitelisting can catch them. `msg_sk-…` defeated `\bsk-`: `_` then `s` is no boundary.
  const KEY = 'sk-ant-api03-FAKEPROBEKEYzzzz0123456789abcdef';
  const KEY2 = 'sk-ant-api03-SPACEDELIMzzzz0123456789abcdef';
  const BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.FAKEPROBETOKENpayload.FAKEsig';
  const ctx = fresh('glued');
  const m = ctx.store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'glued', baseRevision: 'base1' });
  const lines = [
    `Authorization: ${BEARER} and key ${KEY} and ${KEY2} x-api-key:${KEY2} api_key_${KEY2}`,
    assistant('msg_' + KEY, { input_tokens: 3 }, 'model-' + BEARER),
    assistant('msg_ok', { input_tokens: 1 }, `claude_${KEY}`),
    JSON.stringify({ type: 'result', total_cost_usd: 0.01, num_turns: 1, subtype: KEY }),
  ];
  const leaky: Adapter = {
    name: 'mock', bin: process.execPath, perInvocationMcp: true, streamShape: 'claude',
    argv: () => ['-e', `for (const l of ${JSON.stringify(lines)}) console.log(l); console.error(${JSON.stringify(`stderr tok_${KEY} ${BEARER}`)});`,
      '--', '--api-key', `key_${KEY}`, '--hdr', BEARER],
  };
  const a = await captured(ctx, m.id, leaky, 'agent:mock:glued');
  const rows = ctx.store.usageRows(a.id);
  const report = projectReportText(ctx, PROJECT.id);
  const exported = JSON.stringify(exportMission(ctx, m.id));
  const evs = JSON.stringify(ctx.events.forAttempt(a.id));
  ctx.close();
  const bytes: Buffer[] = [];
  const walk = (dir: string) => {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else bytes.push(fs.readFileSync(p));
    }
  };
  walk(path.join(tmp, 'glued'));
  const all = Buffer.concat([...bytes, Buffer.from(report + exported + evs + JSON.stringify(rows))]);
  check('a key glued to a word char is in no file, row, event, report or export',
    !all.includes('FAKEPROBEKEY') && !all.includes('SPACEDELIM'), rows.map((r) => r.requestId).join(' | '));
  check('nor the bearer token', !all.includes('FAKEPROBETOKEN'));
  check('a request id or model of any other shape is replaced, not stored',
    rows.every((r) => r.requestId === null || /^[A-Za-z0-9._:\/@+-]{1,128}$/.test(r.requestId))
      && rows.every((r) => r.model === null || /^[A-Za-z0-9._:\/@+-]{1,128}$/.test(r.model)), JSON.stringify(rows.map((r) => [r.requestId, r.model])));
  check('the turns are still counted once each', rows.length === 3 && a.tokens.input === 4 && a.costUsd === 0.01, JSON.stringify(a.tokens));
})();

done();
