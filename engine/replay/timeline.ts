import type { RunEvent } from './types.ts';

/**
 * Replaying a recorded run.
 *
 * Every tool call an agent makes is appended to `events.jsonl` by the MCP server, so a run
 * can be watched after the fact — which is when anyone is actually available to watch it.
 * This is the timing and ordering logic; the renderer owns only the controls.
 *
 * It lives in the engine because it is about the recorded run, not about the screen: nothing
 * here touches the DOM, and the same reasoning would apply to a replay printed to a terminal.
 */

export interface ReplayState {
  /** How many events of the timeline have been played. */
  index: number;
  playing: boolean;
  /** Multiples of real elapsed time. 0 means "one event per tick", ignoring real gaps. */
  speed: number;
}

export const SPEEDS = [1, 8, 60, 600, 0] as const;

export function speedLabel(speed: number): string {
  return speed === 0 ? 'step' : `${speed}\u00d7`;
}

/**
 * How long to wait before the next event, given the run's own timing.
 *
 * Real agent runs are mostly waiting — minutes between tool calls — so replaying at true
 * speed is watching paint dry, and replaying at a fixed tick throws away the rhythm that
 * shows you where the run actually laboured. Dividing real gaps by a speed factor keeps the
 * shape and compresses the dead air. Gaps are clamped: one four-minute pause should not
 * stall the scrubber even at 1x.
 */
export function delayFor(prev: RunEvent | undefined, next: RunEvent, speed: number): number {
  if (speed === 0) return 400;
  if (!prev) return 0;
  const gap = Math.max(0, next.at - prev.at);
  return Math.min(4000, gap / speed);
}

/**
 * Events in time order, which is not file order.
 *
 * `events.jsonl` is appended by several concurrent agents through one MCP boundary, so
 * interleaving is normal — replaying in file order would show a sequence that never happened.
 * Sorted into a copy, because the caller's array is usually React state.
 */
export function timeline<T extends RunEvent>(events: T[]): T[] {
  return [...events].sort((a, b) => a.at - b.at);
}

/** Where a scrub position sits in wall-clock terms, for the readout. */
export function elapsedAt(events: RunEvent[], index: number): number {
  if (!events.length || index <= 0) return 0;
  const first = events[0].at;
  const at = events[Math.min(index, events.length) - 1].at;
  return Math.max(0, at - first);
}

export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
