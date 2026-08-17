/**
 * P13 — budget ceilings and spend parsing. Run: node engine/test/budget.ts
 *
 * A run has already burned $2.11 and died at a timeout with no ceiling in place. Cost never
 * crosses the MCP boundary — it exists only in each CLI's own output — so this is the one
 * place adapter-specific parsing is unavoidable, and the one place it has to be tolerant.
 */
import { readSpend } from '../swarm/adapters.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

console.log('\nspend parsing');
{
  const claude = '{"type":"result","total_cost_usd":2.1066,"num_turns":47,"usage":{}}';
  const s1 = readSpend(claude);
  check('reads claude cost and turns', s1.cost > 2.1 && s1.turns === 47, JSON.stringify(s1));

  // Streamed output repeats a cumulative total; taking the max, not the sum, is correct.
  const streamed = '{"total_cost_usd":0.4}\n{"total_cost_usd":1.2}\n{"total_cost_usd":2.0}';
  check('cumulative totals do not compound', readSpend(streamed).cost === 2.0,
    String(readSpend(streamed).cost));

  const generic = '{"cost_usd":0.55}';
  check('reads a generic usd field', readSpend(generic).cost === 0.55);

  // Per-message costs are additive, unlike a running total.
  const perMessage = '{"cost":0.1}\n{"cost":0.25}\n{"cost":0.15}';
  const s2 = readSpend(perMessage);
  check('per-message costs accumulate', Math.abs(s2.cost - 0.5) < 1e-9, String(s2.cost));

  check('silence yields zero rather than breaking', readSpend('no json here').cost === 0);
  check('garbage yields zero', readSpend('{"total_cost_usd":"abc"}').cost === 0);
  check('empty output is safe', readSpend('').cost === 0 && readSpend('').turns === 0);

  // The failure that matters: a ceiling must not be silently defeated by unparsable output.
  // Zero spend means the between-runs check cannot stop anything, which is why the driver
  // also caps turns and wall-clock rather than relying on cost alone.
  check('unparsed spend is zero, not undefined',
    typeof readSpend('nothing').cost === 'number');
}

done();