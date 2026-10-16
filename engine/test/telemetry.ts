/**
 * Agent telemetry. Run: node engine/test/telemetry.ts
 *
 * The event log is the only thing a mission's "live" view and its replay have in common, so
 * the properties that matter are the ones that decide whether those two can disagree: that
 * concurrent attempts do not leak into each other, that a sequence read back is the sequence
 * that was written, that a secret in the environment never reaches an artifact, and that a
 * provider which said nothing about cost is recorded as unknown rather than free.
 *
 * Every adapter here is a mock — `node -e` printing lines — and says so in its runner id.
 * No agent CLI is spawned.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../mission/artifacts.ts';
import { EventLog, runEventId } from '../mission/events.ts';
import { redact, secretsFromEnv } from '../mission/redact.ts';
import type { ArtifactRef } from '../mission/types.ts';
import type { RunEvent } from '../replay/types.ts';
import { run, type Adapter } from '../swarm/adapters.ts';
import { captureRun, describeArgv, type AttemptFinisher } from '../swarm/capture.ts';
import { normalize } from '../swarm/normalize.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-telemetry-'));

/** A mock adapter: node printing `lines` of `tag` with a pause between each. */
const mock = (tag: string, lines: number, extra = ''): Adapter => ({
  name: 'mock',
  bin: process.execPath,
  perInvocationMcp: true,
  argv: (run) => [
    '-e',
    `let i = 0;
     const t = setInterval(() => {
       i++;
       console.log(JSON.stringify({ tag: ${JSON.stringify(tag)}, i, prompt: process.argv[1] }));
       if (i === ${lines}) { clearInterval(t); ${extra} }
     }, 15);`,
    run.prompt,
  ],
});

/** Records what the store was told; the real MissionStore is DL-01's. */
class Finisher implements AttemptFinisher {
  calls: Array<{ id: string; result: Parameters<AttemptFinisher['finishAttempt']>[1] }> = [];
  finishAttempt(id: string, result: Parameters<AttemptFinisher['finishAttempt']>[1]) {
    this.calls.push({ id, result });
  }
}

const ctxFor = (
  dir: string, events: EventLog, artifacts: ArtifactStore, store: Finisher, attemptId: string,
  extra: Partial<Parameters<typeof captureRun>[2]> = {},
) => ({
  store, events, artifacts,
  projectId: 'git:fixture00000', missionId: 'm_1', taskId: `t_${attemptId}`, attemptId,
  runnerId: 'agent:mock:default', revision: 'deadbeef', ...extra,
});

section('redaction');
{
  const env = { MOCK_API_KEY: 'abcdefghijklmnop-1234', SHORT_KEY: 'tiny', PATH: '/usr/bin:/bin' };
  const found = secretsFromEnv(env);
  check('a long value under a KEY name is a secret', found.includes('abcdefghijklmnop-1234'));
  check('a short value is not — too many false positives', !found.includes('tiny'));
  check('PATH is not a secret', !found.includes('/usr/bin:/bin'));

  const r = redact('token=abcdefghijklmnop-1234 and again abcdefghijklmnop-1234', [], env);
  check('a known env secret is masked everywhere it appears', !r.text.includes('abcdefghij') && r.redactions === 2, r.text);

  const shapes = redact(
    'sk-abcdefghijklmnopqrstuvwxyz ghp_ABCDEFGHIJKLMNOP AKIAABCDEFGHIJKLMNOP xoxb-1234-5678-abcdefgh Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc',
    [], {},
  );
  check('provider token shapes are masked without knowing the value',
    !/sk-abc|ghp_|AKIA|xoxb-1234|eyJ/.test(shapes.text) && shapes.redactions === 5, `${shapes.redactions} ${shapes.text}`);
  check('the Bearer scheme word survives so the line still reads as a header', shapes.text.includes('Bearer [REDACTED]'));
  check('a caller-supplied secret is masked regardless of length',
    redact('pw=hunter2 ok', ['hunter2'], {}).text === 'pw=[REDACTED] ok');
  check('clean text is untouched and counts zero', redact('nothing here', [], {}).redactions === 0);
}

section('normalising provider output');
{
  const toolUse = JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: 'private' },
      { type: 'tool_use', id: 'toolu_1', name: 'mcp__vds__get_slice', input: { node: 'a.ts', hops: 1 } },
      { type: 'text', text: 'ok' },
    ] },
  });
  const ev = normalize('claude', toolUse);
  const call = ev.find((e) => e.name === 'tool.call');
  check('a claude tool_use block is a tool.call', !!call && call.payload.tool === 'mcp__vds__get_slice');
  check('its input is summarised, not reproduced', typeof call?.payload.input === 'string' && String(call?.payload.input).includes('a.ts'));
  const thought = ev.find((e) => e.name === 'process.thinking');
  check('thinking is counted, never quoted',
    !!thought && thought.payload.blocks === 1 && !JSON.stringify(thought).includes('private'));

  const result = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1.25, num_turns: 7, duration_ms: 900, is_error: false });
  const rs = normalize('claude', result);
  const cost = rs.find((e) => e.name === 'cost.reported');
  check('a claude result reports cost and turns', cost?.payload.costUsd === 1.25 && cost?.payload.turns === 7 && cost?.payload.known === true);
  check('and a process.result', rs.some((e) => e.name === 'process.result' && e.payload.subtype === 'success'));

  const noCost = normalize('claude', JSON.stringify({ type: 'result', num_turns: 3 }));
  check('a result without a price reports cost as null, not zero',
    noCost.find((e) => e.name === 'cost.reported')?.payload.costUsd === null);

  check('garbage is dropped, not thrown', normalize('claude', 'not json {').length === 0);
  check('an unrelated JSON line is not an event', normalize('claude', '{"type":"system","subtype":"init"}').length === 0);
  check('an unknown provider yields nothing', normalize('unknown', result).length === 0);
  check('an array line is not an event', normalize('claude', '[1,2]').length === 0);

  const codexCall = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'get_overview', status: 'completed', arguments: {} } });
  check('a codex completed tool item is a tool.call',
    normalize('codex', codexCall).some((e) => e.name === 'tool.call' && e.payload.tool === 'get_overview'));
  check('a codex started item is not double-counted',
    normalize('codex', JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', tool: 'x' } })).length === 0);
  check('a codex updated item is not a second call',
    !normalize('codex', JSON.stringify({ type: 'item.updated', item: { id: 'i1', type: 'mcp_tool_call', tool: 'x', status: 'in_progress' } }))
      .some((e) => e.name === 'tool.call'));
  check('codex never reports a cost', !normalize('codex', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5 } })).some((e) => e.name === 'cost.reported'));

  check('the prompt is replaced in a described argv',
    describeArgv(['-p', 'the prompt', '--x'], 'the prompt').join(' ').match(/<prompt 10 chars sha256:/) !== null);
}

section('the event log');
{
  const dir = path.join(tmp, 'log');
  fs.mkdirSync(dir);
  let t = 1000;
  const log = new EventLog(dir, () => t++);
  const a = log.append({ projectId: 'p', missionId: 'm', attemptId: 'a1', category: 'process', name: 'process.start', payload: {} });
  const b = log.append({ projectId: 'p', missionId: 'm', attemptId: 'a2', category: 'process', name: 'process.start', payload: { at: 'given' }, at: 5 });
  check('sequence is assigned and increases', a.sequence === 1 && b.sequence === 2);
  check('ids are prefixed and distinct', a.id.startsWith('ev_') && a.id !== b.id);
  check('at is injected when absent and honoured when given', a.at === 1000 && b.at === 5);
  check('schema version is stamped', a.schemaVersion === 1);
  check('since(0) returns everything in order', log.since(0).map((e) => e.sequence).join() === '1,2');
  check('since(1) resumes after the cursor', log.since(1).length === 1 && log.since(1)[0].id === b.id);
  check('a filter narrows to one attempt', log.forAttempt('a2').length === 1 && log.forAttempt('a2')[0].payload.at === 'given');
  check('forMission sees both', log.forMission('m').length === 2);
  check('head is the last sequence', log.head() === 2);
  check('limit is honoured', log.since(0, {}, 1).length === 1);

  const line: RunEvent = { at: 77, session: 'm_1:a_9', agent: 'claude', model: 'sonnet', tool: 'get_slice', node: 'x.ts' };
  const other: RunEvent = { at: 78, session: 'someone-else', agent: 'codex', model: null, tool: 'get_overview' };
  const resolve = (s: string) => (s === 'm_1:a_9' ? { projectId: 'p', missionId: 'm_1', taskId: 't_1', attemptId: 'a_9' } : null);
  const added = log.ingestRunEvents([line, other], resolve);
  check('only lines whose session resolves are ingested', added === 1);
  const got = log.forAttempt('a_9');
  check('the ingested line is a tool.call on the attempt',
    got.length === 1 && got[0].name === 'tool.call' && got[0].payload.tool === 'get_slice' && got[0].payload.node === 'x.ts');
  check('it keeps the recorded time, not the ingest time', got[0].at === 77);
  check('and names the agent as actor', got[0].actorId === 'agent:claude:sonnet');
  check('re-ingesting adds nothing', log.ingestRunEvents([line, other], resolve) === 0);
  check('the derived id is stable', runEventId(line) === runEventId({ ...line }) && runEventId(line) !== runEventId(other));
  check('a line with a nested payload key order difference is still one event',
    runEventId({ at: 1, session: 's', agent: 'a', model: null, tool: 't', x: 1, y: 2 } as RunEvent)
      === runEventId({ tool: 't', y: 2, x: 1, at: 1, session: 's', agent: 'a', model: null } as RunEvent));
  // Two get_slice calls in one millisecond that differ only below the top level are two calls.
  const sliceA = { at: 90, session: 'm_1:a_9', agent: 'claude', model: 'sonnet', tool: 'get_slice', args: { node: 'a.ts', hops: 1 } } as RunEvent;
  const sliceB = { ...sliceA, args: { node: 'b.ts', hops: 1 } } as RunEvent;
  check('lines differing only in a nested field get different ids', runEventId(sliceA) !== runEventId(sliceB));
  const nestedDir = path.join(tmp, 'log-nested');
  fs.mkdirSync(nestedDir);
  const nestedLog = new EventLog(nestedDir);
  check('and both are ingested', nestedLog.ingestRunEvents([sliceA, sliceB], resolve) === 2);
  nestedLog.close();
  check('nested key order still does not matter',
    runEventId(sliceA) === runEventId({ ...sliceA, args: { hops: 1, node: 'a.ts' } } as RunEvent));
  log.close();

  const reopened = new EventLog(dir);
  check('the log survives a restart', reopened.since(0).length === 3);
  reopened.close();
}

section('capturing two concurrent attempts');
await (async () => {
  const dir = path.join(tmp, 'capture');
  fs.mkdirSync(dir);
  const events = new EventLog(dir);
  const artifacts = new ArtifactStore(dir);
  const store = new Finisher();

  // The secret rides in the parent env, which `run()` passes down whole.
  process.env.MOCK_API_KEY = 'super-secret-value-0001';
  const live: Record<string, string> = {};
  const runOne = (attemptId: string, tag: string, lines: number, extra = '') =>
    captureRun(
      mock(tag, lines, extra),
      { prompt: `prompt for ${tag}`, cwd: tmp, mcpConfigPath: '/dev/null', session: `m_1:${attemptId}`, timeoutMs: 10_000 },
      ctxFor(dir, events, artifacts, store, attemptId, {
        memoryBytes: 64,
        onChunk: (_s, text) => (live[attemptId] = (live[attemptId] ?? '') + text),
      }),
    );

  const [ra, rb] = await Promise.all([
    runOne('a_1', 'alpha', 6, 'console.log("key=" + process.env.MOCK_API_KEY); console.error("warn alpha");'),
    runOne('a_2', 'beta', 4, 'process.exit(3);'),
  ]);
  delete process.env.MOCK_API_KEY;

  check('both mock runs finished', ra.exitCode === 0 && rb.exitCode === 3);
  check('the existing buffered result still carries the output', ra.stdout.split('\n').filter(Boolean).length === 7);

  const ea = events.forAttempt('a_1');
  const eb = events.forAttempt('a_2');
  check('each attempt has its own process.start … process.exit',
    ea[0]?.name === 'process.start' && ea[ea.length - 1]?.name === 'process.exit'
      && eb[0]?.name === 'process.start' && eb[eb.length - 1]?.name === 'process.exit');
  check('no event of one attempt names the other', !ea.some((e) => e.attemptId !== 'a_1') && !eb.some((e) => e.attemptId !== 'a_2'));
  const all = events.since(0);
  check('sequences across both are strictly increasing', all.every((e, i) => i === 0 || e.sequence > all[i - 1].sequence));
  check('and interleaved — the runs really were concurrent',
    all.findIndex((e) => e.attemptId === 'a_2') < all.findLastIndex((e) => e.attemptId === 'a_1'));
  check('the per-attempt replay from since(0) is the attempt view',
    JSON.stringify(all.filter((e) => e.attemptId === 'a_1').map((e) => e.id)) === JSON.stringify(ea.map((e) => e.id)));

  const start = ea[0];
  check('process.start hides the prompt behind its length and digest',
    JSON.stringify(start.payload.argv).includes('<prompt 16 chars sha256:') && !JSON.stringify(start.payload).includes('prompt for alpha'));
  check('but the prompt is kept as an artifact', artifacts.text((start.artifactIds ?? [])[0]) === 'prompt for alpha');
  check('the runner is labelled mock', start.actorId === 'agent:mock:default' && start.payload.provider === 'unknown');

  const exitA = ea[ea.length - 1];
  const exitB = eb[eb.length - 1];
  check('process.exit records the real exit code', exitA.payload.exitCode === 0 && exitB.payload.exitCode === 3);
  check('and names the failure for the one that failed', exitB.payload.failure === 'exit 3' && exitA.payload.failure === undefined);

  const costA = ea.find((e) => e.name === 'cost.reported');
  check('a provider that printed no cost is recorded as unknown, not free', costA?.payload.costUsd === null && costA?.payload.known === false);

  const finA = store.calls.find((c) => c.id === 'a_1')!;
  const finB = store.calls.find((c) => c.id === 'a_2')!;
  check('the store was told how each attempt ended', finA.result.state === 'completed' && finB.result.state === 'failed' && finB.result.failure === 'exit 3');
  check('with costUsd null when unknown', finA.result.costUsd === null);

  const logsOf = (fin: typeof finA) => (fin.result.artifacts ?? []).filter((a: ArtifactRef) => a.kind === 'log');
  const outA = logsOf(finA).find((a) => a.label?.startsWith('stdout'))!;
  const errA = logsOf(finA).find((a) => a.label?.startsWith('stderr'))!;
  const outB = logsOf(finB).find((a) => a.label?.startsWith('stdout'))!;
  check('stdout and stderr are separate artifacts', !!outA && !!errA && artifacts.text(errA).includes('warn alpha') && !artifacts.text(outA).includes('warn alpha'));
  const textA = artifacts.text(outA);
  const textB = artifacts.text(outB);
  check('an attempt\'s log holds only its own lines', textA.includes('"alpha"') && !textA.includes('"beta"') && textB.includes('"beta"') && !textB.includes('"alpha"'));
  check('all lines survived the spill to disk (cap was 64 bytes)', textA.split('\n').filter(Boolean).length === 7 && textB.split('\n').filter(Boolean).length === 4);
  check('the secret never reached the artifact', !textA.includes('super-secret-value') && textA.includes('key=[REDACTED]'));
  check('and the label says it was redacted', outA.label === 'stdout (1 redacted)');
  check('nor any event payload', !JSON.stringify(all).includes('super-secret-value'));
  check('nor the live console', !live.a_1.includes('super-secret-value') && live.a_1.includes('"alpha"'));
  check('process.exit points at the log artifacts', (exitA.artifactIds ?? []).includes(outA.id) && (exitA.artifactIds ?? []).includes(errA.id));
  check('byte counts were kept', exitA.payload.stdoutBytes === Buffer.byteLength(ra.stdout));
  events.close();
})();

section('a run that reports cost through provider JSON');
await (async () => {
  const dir = path.join(tmp, 'cost');
  fs.mkdirSync(dir);
  const events = new EventLog(dir);
  const artifacts = new ArtifactStore(dir);
  const store = new Finisher();
  const claudeLike: Adapter = {
    name: 'claude',
    bin: process.execPath,
    perInvocationMcp: true,
    argv: () => ['-e', `
      console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__vds__get_overview', input: {} }] } }));
      process.stdout.write('{"type":"result","total_cost_usd":0.42,"num_t');
      setTimeout(() => console.log('urns":2}'), 20);
    `],
  };
  const r = await captureRun(
    claudeLike,
    { prompt: 'x', cwd: tmp, mcpConfigPath: '/dev/null', session: 'm_1:a_3', timeoutMs: 10_000 },
    ctxFor(dir, events, artifacts, store, 'a_3', { runnerId: 'agent:claude:test' }),
  );
  const ev = events.forAttempt('a_3');
  check('a line split across chunks still normalises', ev.some((e) => e.name === 'process.result'));
  check('the tool call became an event', ev.some((e) => e.name === 'tool.call' && e.payload.tool === 'mcp__vds__get_overview'));
  check('process.exit counts the tool calls', ev[ev.length - 1].payload.toolCalls === 1);
  check('reported cost reaches the attempt', store.calls[0].result.costUsd === 0.42);
  check('and agrees with the adapter\'s own spend parser', r.cost === 0.42 && r.turns === 2);
  events.close();
})();

section('one cost.reported per attempt, and usage under one name for every provider');
await (async () => {
  const dir = path.join(tmp, 'usage');
  fs.mkdirSync(dir);
  const events = new EventLog(dir);
  const artifacts = new ArtifactStore(dir);
  const store = new Finisher();
  const claudeLike: Adapter = {
    name: 'claude', bin: process.execPath, perInvocationMcp: true,
    argv: () => ['-e', `console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.3, num_turns: 4,
      usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 60 } }));`],
  };
  await captureRun(
    claudeLike,
    { prompt: 'x', cwd: tmp, mcpConfigPath: '/dev/null', session: 'm_1:a_4', timeoutMs: 10_000 },
    ctxFor(dir, events, artifacts, store, 'a_4', { runnerId: 'agent:claude:test' }),
  );
  const ev = events.forAttempt('a_4');
  const reported = ev.filter((e) => e.name === 'cost.reported');
  check('the log holds exactly one cost.reported for the attempt', reported.length === 1, String(reported.length));
  const summed = reported.reduce((n, e) => n + (Number(e.payload.costUsd) || 0), 0);
  check('so summing it gives the attempt\'s cost, not twice that', summed === store.calls[0].result.costUsd, `${summed}`);
  check('the provider\'s own figure is kept, under its own name', ev.some((e) => e.name === 'provider.cost' && e.payload.costUsd === 0.3));
  const usage = ev.find((e) => e.name === 'cost.usage');
  check('claude usage becomes cost.usage with cache reads and writes',
    usage?.payload.inputTokens === 120 && usage.payload.outputTokens === 40 && usage.payload.cacheReadTokens === 900 && usage.payload.cacheWriteTokens === 60,
    JSON.stringify(usage?.payload));
  events.close();

  const codexUsage = normalize('codex', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 3, output_tokens: 2 } }))
    .find((e) => e.name === 'cost.usage');
  // A spend figure scraped out of raw stdout is a guess, and says so; only a figure the
  // provider reported in its own structured result is known.
  const scraped = new Finisher();
  const scrapeDir = path.join(tmp, 'scraped');
  fs.mkdirSync(scrapeDir);
  const scrapeEvents = new EventLog(scrapeDir);
  await captureRun(
    { name: 'mock', bin: process.execPath, perInvocationMcp: true, argv: () => ['-e', 'console.log(JSON.stringify({ total_cost_usd: 0.2 }))'] },
    { prompt: 'x', cwd: tmp, mcpConfigPath: '/dev/null', session: 'm_1:a_5', timeoutMs: 10_000 },
    ctxFor(scrapeDir, scrapeEvents, new ArtifactStore(scrapeDir), scraped, 'a_5'),
  );
  const scrapedCost = scrapeEvents.forAttempt('a_5').find((e) => e.name === 'cost.reported');
  check('a cost found only by scanning stdout is recorded as not known',
    scrapedCost?.payload.costUsd === 0.2 && scrapedCost.payload.known === false && scrapedCost.payload.costSource === 'stdout-scan',
    JSON.stringify(scrapedCost?.payload));
  scrapeEvents.close();

  // Repository text echoed unescaped into a provider's stream must not move the budget.
  const echoing: Adapter = {
    name: 'claude', bin: process.execPath, perInvocationMcp: true,
    argv: () => ['-e', `console.log(JSON.stringify({ type: 'user', content: { total_cost_usd: 99, cost: 50 } }));
      setTimeout(() => console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.01, num_turns: 1 })), 50);`],
  };
  const echoed = await run(echoing, { prompt: 'x', cwd: tmp, mcpConfigPath: '/dev/null', session: 's', timeoutMs: 10_000, maxCost: 1 });
  check('a provider with structured cost is not killed by cost-shaped text in its stream', echoed.ok && !echoed.overBudget,
    `ok=${echoed.ok} overBudget=${echoed.overBudget}`);
  const overrun: Adapter = {
    name: 'claude', bin: process.execPath, perInvocationMcp: true,
    argv: () => ['-e', `console.log(JSON.stringify({ type: 'result', total_cost_usd: 2, num_turns: 1 })); setTimeout(() => {}, 5000);`],
  };
  const killed = await run(overrun, { prompt: 'x', cwd: tmp, mcpConfigPath: '/dev/null', session: 's', timeoutMs: 10_000, maxCost: 1 });
  check('but its own reported cost over the ceiling still stops it', killed.overBudget && !killed.ok);

  check('codex usage is the same event, cached input included',
    codexUsage?.payload.inputTokens === 5 && codexUsage.payload.cacheReadTokens === 3 && codexUsage.payload.outputTokens === 2 && codexUsage.payload.cacheWriteTokens === null,
    JSON.stringify(codexUsage?.payload));
})();

done();
