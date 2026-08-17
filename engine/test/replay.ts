/**
 * Replay of a recorded run. Run: node engine/test/replay.ts
 *
 * The scrubber's value depends entirely on it showing what actually happened, so the
 * properties worth testing are the ones that decide whether it can lie:
 *
 *  - Events replay in *time* order, not file order. `events.jsonl` is appended by several
 *    concurrent agents through one MCP boundary, so interleaving is normal and a replay in
 *    file order would show a sequence that never occurred.
 *  - The bus is one path. Live and replayed events reach the map through the same call, or
 *    the replay is a second renderer that drifts from the first.
 *  - Backwards is a reset-and-refeed. Undoing an event stream means every consumer must be
 *    correct in reverse as well as forwards; refeeding from the start needs each of them to
 *    be correct once.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitEvent, emitReset, onReplayEvent, onReplayReset } from '../replay/bus.ts';
import {
  delayFor, elapsedAt, formatElapsed, SPEEDS, speedLabel, timeline,
} from '../replay/timeline.ts';
import type { RunEvent } from '../replay/types.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ev = (at: number, tool: string, node?: string, session = 'a'): RunEvent =>
  ({ at, session, agent: 'claude', model: null, tool, ...(node ? { node } : {}) });

console.log('\nordering');
{
  // Two agents writing through one boundary: the file is append-ordered, not time-ordered.
  const outOfOrder = [ev(300, 'get_slice', 'c.ts'), ev(100, 'get_overview'), ev(200, 'get_slice', 'b.ts')];
  const t = timeline(outOfOrder);
  check('replays in time order, not file order',
    t.map((e) => e.at).join(',') === '100,200,300', t.map((e) => e.at).join(','));
  check('does not mutate the caller\'s array',
    outOfOrder[0].at === 300, 'timeline() sorted in place');
  check('an empty timeline is empty, not an error', timeline([]).length === 0);
  check('ties keep a stable order',
    timeline([ev(5, 'x'), ev(5, 'y')]).map((e) => e.tool).join('') === 'xy');
}

console.log('\nthe bus');
{
  const seen: RunEvent[] = [];
  let resets = 0;
  const off = onReplayEvent((e) => seen.push(e));
  const offReset = onReplayReset(() => { resets++; });

  emitEvent(ev(1, 'get_overview'));
  check('a subscriber receives an emitted event', seen.length === 1);

  const seen2: RunEvent[] = [];
  const off2 = onReplayEvent((e) => seen2.push(e));
  emitEvent(ev(2, 'get_slice', 'a.ts'));
  check('every subscriber receives it — live and replay share one path',
    seen.length === 2 && seen2.length === 1);

  emitReset();
  check('reset reaches its own listeners', resets === 1);
  check('reset is not delivered as an event', seen.length === 2);

  off2();
  emitEvent(ev(3, 'x'));
  check('unsubscribing stops delivery', seen2.length === 1 && seen.length === 3);

  off();
  offReset();
  emitEvent(ev(4, 'x'));
  emitReset();
  check('unsubscribing the last listener leaves nothing behind',
    seen.length === 3 && resets === 1);
}

console.log('\npacing');
{
  const a = ev(0, 'x');
  const b = ev(60_000, 'y');

  check('the first event does not wait', delayFor(undefined, a, 1) === 0);
  check('real gaps are divided by the speed', delayFor(a, b, 60) === 1000);
  check('a faster speed waits less', delayFor(a, b, 600) === 100);

  // A four-minute pause between tool calls is normal. Honouring it literally would stall
  // the scrubber to the point of looking broken.
  check('a long gap is clamped', delayFor(a, ev(600_000, 'z'), 1) === 4000);
  check('step mode ignores the run\'s timing entirely', delayFor(a, b, 0) === 400);
  check('an out-of-order pair does not wait a negative time',
    delayFor(b, a, 1) === 0, String(delayFor(b, a, 1)));

  check('step is among the offered speeds', SPEEDS.includes(0 as never));
  check('step is labelled as such, not as 0×', speedLabel(0) === 'step');
  check('the others read as multipliers', speedLabel(60) === '60×');
}

console.log('\nreadout');
{
  const t = timeline([ev(1000, 'a'), ev(4000, 'b'), ev(126_000, 'c')]);
  check('elapsed is measured from the run\'s own start, not the epoch',
    elapsedAt(t, 1) === 0);
  check('and grows with the scrub position', elapsedAt(t, 2) === 3000);
  check('position zero is zero', elapsedAt(t, 0) === 0);
  check('past the end clamps to the last event', elapsedAt(t, 99) === 125_000);
  check('an empty timeline reads zero', elapsedAt([], 3) === 0);

  check('formats as minutes and seconds', formatElapsed(125_000) === '2:05');
  check('pads the seconds', formatElapsed(65_000) === '1:05');
  check('zero reads as zero', formatElapsed(0) === '0:00');
}

console.log('\nagainst a real events file');
{
  // The shape on disk, not a shape invented for the test.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-replay-'));
  const file = path.join(tmp, 'events.jsonl');
  fs.writeFileSync(file, [
    '{"at": 1786937738852, "session": "vds-claude-0", "agent": "multi", "model": null, "tool": "get_overview"}',
    '{"at": 1786937797276, "session": "vds-claude-0", "agent": "multi", "model": null, "tool": "get_slice", "node": "engine/mcp/server.ts", "hops": 1}',
    '{"at": 1786937796818, "session": "vds-claude-1", "agent": "multi", "model": null, "tool": "get_slice", "node": "engine/focus/stack.ts", "hops": 1}',
  ].join('\n') + '\n');

  const parsed: RunEvent[] = fs.readFileSync(file, 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const t = timeline(parsed);

  check('reads the file the MCP server actually writes', t.length === 3);
  check('two sessions interleave into one ordered timeline',
    t[1].session === 'vds-claude-1' && t[2].session === 'vds-claude-0',
    t.map((e) => e.session).join(','));
  check('the run reads as under a minute',
    formatElapsed(elapsedAt(t, t.length)) === '0:58', formatElapsed(elapsedAt(t, t.length)));

  // Replaying the whole file must deliver every event, in order, exactly once.
  const delivered: string[] = [];
  const off = onReplayEvent((e) => delivered.push(`${e.at}`));
  for (const e of t) emitEvent(e);
  off();
  check('a full replay delivers every event once, in order',
    delivered.join(',') === t.map((e) => e.at).join(','), delivered.join(','));

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
