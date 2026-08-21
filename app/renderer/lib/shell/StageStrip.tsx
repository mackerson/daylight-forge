import type { ReactNode } from 'react';
import { money } from '../vocab.ts';

/**
 * The loop, as a strip that owns navigation.
 *
 * Two things make this different from the tab rail it replaces. It is the same five places
 * on every screen, so where you are is never a question; and each one carries its own live
 * state underneath rather than a label, so the strip answers "what does this need from me"
 * without being clicked. A stage that reads "blocked on you" is the whole design.
 */

export type Stage = 'map' | 'detect' | 'explore' | 'beliefs' | 'plan';
export type View = Stage | 'invariants' | 'runs';

export const STAGES: Stage[] = ['map', 'detect', 'explore', 'beliefs', 'plan'];

/** What the dot means. Not severity — where the work is. */
export type Tick = 'idle' | 'done' | 'ready' | 'live' | 'blocked';

export interface StageState {
  tick: Tick;
  /** The live answer, in the fewest words that are still true. */
  state: string;
  /** Off when the stage cannot mean anything yet — no map, no repo. */
  enabled: boolean;
}

export function StageStrip({
  view, onView, stages, invariants, spend, running, onStop,
}: {
  view: View;
  onView: (v: View) => void;
  stages: Record<Stage, StageState>;
  invariants: { held: number; violated: number } | null;
  spend: { cost: number; known: boolean };
  running: number;
  onStop: () => void;
}) {
  return (
    <nav className="stages">
      {STAGES.map((s) => (
        <button
          key={s}
          className="stage"
          aria-current={view === s}
          disabled={!stages[s].enabled}
          onClick={() => onView(s)}
        >
          <i className={`tick ${stages[s].tick}`} />
          <span className="stage-text">
            <span className="what">{s}</span>
            <span className="state">{stages[s].state}</span>
          </span>
        </button>
      ))}

      <div className="spacer" />

      <div className="aside">
        {running > 0 && (
          <button className="red" onClick={onStop}>
            stop {running} running
          </button>
        )}
        {invariants && (
          <button
            className={invariants.violated ? 'red' : undefined}
            aria-current={view === 'invariants'}
            onClick={() => onView('invariants')}
            title="the rules a plan may not break, and the build gate they drive"
          >
            {invariants.violated
              ? `${invariants.violated} invariant${invariants.violated === 1 ? '' : 's'} violated`
              : `${invariants.held} invariants gating build`}
          </button>
        )}
        <button
          aria-current={view === 'runs'}
          onClick={() => onView('runs')}
          title="what each run cost, and what it moved"
        >
          {/* A floor is not a figure. When an adapter reports no price at all, saying
              "$1.98" flat would read as cheaper than the run actually was. */}
          <span className="money">{spend.known ? money(spend.cost) : `${money(spend.cost)}+`}</span>
          {' today'}
        </button>
      </div>
    </nav>
  );
}

/** The titlebar: what you are looking at, and which tree it came from. */
export function TitleBar({ name, where, onPick, busy, children }: {
  name: string;
  where: string | null;
  onPick: () => void;
  busy: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="titlebar">
      <i className={busy ? 'dot busy' : 'dot'} />
      <div className="name">{name}</div>
      <div className="spacer" />
      {children}
      <button className="where" onClick={onPick} title={where ?? 'choose a repository'}>
        {where ?? 'choose a repository…'}
      </button>
    </header>
  );
}
