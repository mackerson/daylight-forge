/**
 * Usage capture and the project ledger. Run: node engine/test/ledger.ts
 *
 * Mock streams only: every provider line here is synthetic, and no real agent binary runs.
 * The properties that carry the weight: a turn is counted once however its usage is split
 * across lines; a figure nobody reported is `unknown`, never zero; a scraped figure is spend,
 * never knowledge; and no secret value reaches an event, an artifact, the database or a report.
 */
import { normalize } from '../swarm/normalize.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

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

done();
