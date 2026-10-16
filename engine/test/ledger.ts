/**
 * Usage capture and the project ledger. Run: node engine/test/ledger.ts
 *
 * Mock streams only: every provider line here is synthetic, and no real agent binary runs.
 * The properties that carry the weight: a turn is counted once however its usage is split
 * across lines; a figure nobody reported is `unknown`, never zero; a scraped figure is spend,
 * never knowledge; and no secret value reaches an event, an artifact, the database or a report.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../mission/artifacts.ts';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { EventLog } from '../mission/events.ts';
import { costKnown, type ProjectIdentity, type TokenUsage } from '../mission/types.ts';
import type { Adapter } from '../swarm/adapters.ts';
import { captureRun, type AttemptFinisher, type CaptureContext } from '../swarm/capture.ts';
import { normalize, type Provider } from '../swarm/normalize.ts';
import { credentialFor, LineSplitter, UsageAccumulator } from '../swarm/usage.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-ledger-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

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

done();
