/**
 * Replay, as the renderer sees it.
 *
 * The bus and the timing live in the engine — nothing about either touches the screen, and
 * keeping them there is what lets the engine's tests reach them. This is the seam, so a panel
 * imports one module rather than three.
 */
export {
  emitEvent, emitReset, onReplayEvent, onReplayReset,
} from '../../../engine/replay/bus.ts';
export {
  delayFor, elapsedAt, formatElapsed, SPEEDS, speedLabel, timeline, type ReplayState,
} from '../../../engine/replay/timeline.ts';
