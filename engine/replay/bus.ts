/**
 * The event bus the map renders from, live or replayed.
 *
 * The scene used to subscribe to the live IPC feed directly, which meant a replay could only
 * ever be a second renderer drawing the same data a second way — and two renderers drift, so
 * the replay would slowly stop being a picture of what happened. Everything goes through here
 * instead: live events are forwarded in, historical events are emitted in, and the consumer
 * cannot tell the difference. One implementation of what an event looks like on the map is
 * the only way the replay stays honest.
 *
 * Scrubbing backwards is a reset-and-refeed rather than an undo. Undoing an event stream
 * means every consumer has to know how to run itself in reverse, and one that gets that
 * subtly wrong shows a state the run never passed through. Replaying from the start is dumb,
 * obviously correct, and fast enough — the work is a few map writes per event.
 *
 * Deliberately untyped beyond the event shape and free of any DOM reference: it is a
 * publish-subscribe pair, and putting it here keeps the renderer from owning logic the
 * engine's tests cannot reach.
 */
import type { RunEvent } from './types.ts';

type Listener<T> = (e: T) => void;

const listeners = new Set<Listener<RunEvent>>();
const resetListeners = new Set<() => void>();

export function onReplayEvent<T extends RunEvent>(fn: Listener<T>): () => void {
  listeners.add(fn as Listener<RunEvent>);
  return () => listeners.delete(fn as Listener<RunEvent>);
}

/** Fired when the timeline jumps backwards and consumers must drop accumulated state. */
export function onReplayReset(fn: () => void): () => void {
  resetListeners.add(fn);
  return () => resetListeners.delete(fn);
}

export function emitEvent(e: RunEvent): void {
  // Copied before iterating: a listener that unsubscribes itself mid-delivery is legitimate
  // — the scene does it on teardown — and must not skip the listener after it.
  for (const fn of [...listeners]) fn(e);
}

export function emitReset(): void {
  for (const fn of [...resetListeners]) fn();
}
