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
import { EventLog } from '../mission/events.ts';
import type { Adapter } from '../swarm/adapters.ts';
import { captureRun, type AttemptFinisher } from '../swarm/capture.ts';
import { normalize, type Provider } from '../swarm/normalize.ts';
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

done();
