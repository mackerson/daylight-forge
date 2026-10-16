import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '../types.ts';
import {
  delayFor, elapsedAt, emitEvent, emitReset, formatElapsed, SPEEDS, speedLabel, timeline,
} from '../replay.ts';

/**
 * Replay the run.
 *
 * The map already shows the swarm working — markers moving, nodes pulsing — but only while
 * it is happening, which is exactly when nobody is watching. Every agent's tool call is
 * already on disk in `events.jsonl`, so the run can be watched afterwards, at a speed a
 * person can actually follow.
 *
 * Taking over the live feed is deliberate and stated. A scrubber that quietly blended
 * historical events with incoming ones would show a picture that never existed, so entering
 * replay stops the live feed and says so, and leaving it restores the present.
 */
export function Scrubber({
  events, active, onActiveChange,
}: {
  events: AgentEvent[];
  active: boolean;
  onActiveChange: (active: boolean) => void;
}) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(60);
  const played = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ordered = timeline(events);
  const total = ordered.length;

  /**
   * Move the timeline to `next`.
   *
   * Forwards is a matter of emitting what has not been emitted yet. Backwards resets every
   * consumer and refeeds from the start, because asking each of them to undo an event is
   * asking each of them to be correct twice.
   */
  const seek = useCallback((next: number) => {
    const target = Math.max(0, Math.min(total, next));
    if (target < played.current) {
      emitReset();
      played.current = 0;
    }
    for (let i = played.current; i < target; i++) emitEvent(ordered[i]);
    played.current = target;
    setIndex(target);
  }, [ordered, total]);

  // Entering replay clears whatever the live feed had accumulated, so the first frame of the
  // replay is the run's beginning rather than the run's beginning drawn over its end.
  useEffect(() => {
    if (!active) return;
    emitReset();
    played.current = 0;
    setIndex(0);
    return () => {
      emitReset();
      played.current = 0;
    };
  }, [active]);

  useEffect(() => {
    if (!active || !playing) return;
    if (index >= total) {
      setPlaying(false);
      return;
    }
    const wait = delayFor(ordered[index - 1], ordered[index], speed);
    timer.current = setTimeout(() => seek(index + 1), wait);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, playing, index, total, speed, ordered, seek]);

  if (!total) {
    return (
      <div className="scrub empty-note dim">
        No recorded events yet — run the swarm and this becomes a replay of it.
      </div>
    );
  }

  const current = ordered[Math.max(0, index - 1)];

  return (
    <div className={active ? 'scrub active' : 'scrub'}>
      <div className="toolbar">
        <button className={active ? 'chip active' : 'chip'} onClick={() => onActiveChange(!active)}>
          {active ? 'leave replay' : `replay ${total} events`}
        </button>

        {active && (
          <>
            <button onClick={() => setPlaying(!playing)} disabled={index >= total && !playing}>
              {playing ? 'pause' : 'play'}
            </button>
            <button onClick={() => { setPlaying(false); seek(0); }}>restart</button>
            <button onClick={() => { setPlaying(false); seek(index - 1); }} disabled={index <= 0}>
              ‹ step
            </button>
            <button onClick={() => { setPlaying(false); seek(index + 1); }} disabled={index >= total}>
              step ›
            </button>
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={s === speed ? 'chip active' : 'chip'}
                onClick={() => setSpeed(s)}
              >
                {speedLabel(s)}
              </button>
            ))}
          </>
        )}
      </div>

      {active && (
        <>
          <input
            className="scrub-range"
            type="range"
            min={0}
            max={total}
            value={index}
            onChange={(e) => { setPlaying(false); seek(Number(e.target.value)); }}
          />
          <div className="scrub-read dim">
            <span className="mono">{index}/{total}</span>
            <span className="mono">{formatElapsed(elapsedAt(ordered, index))}</span>
            {index > 0 && current && (
              <span className="mono">
                {current.agent}
                {current.model ? `/${current.model}` : ''} · {current.tool}
                {current.node || current.subject ? ` · ${current.node ?? current.subject}` : ''}
              </span>
            )}
          </div>
          <p className="dim">
            The live feed is paused while you are in here — blending recorded events with
            incoming ones would draw a state the run never passed through.
          </p>
        </>
      )}
    </div>
  );
}
