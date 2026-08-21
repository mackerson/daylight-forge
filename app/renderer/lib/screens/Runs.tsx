import { useMemo, useState } from 'react';
import { Quality } from '../panels/Quality.tsx';
import { Scrubber } from '../panels/Scrubber.tsx';
import type { Belief, RunRecord, VdsEvent } from '../types.ts';
import { money, sourceKey, state } from '../vocab.ts';

/**
 * Runs, compared by what they changed your mind about.
 *
 * Turn counts and wall-clock are the easy numbers and they answer nothing: a run that took
 * four minutes and settled a contested belief was worth more than one that took forty and
 * produced twelve more things nobody has corroborated. So the middle column is belief
 * movement and the last one is cost per belief that actually got somewhere.
 *
 * One honesty note lives in the interface itself. The store does not record a belief's state
 * at the moment a run ended — only its state now — so this attributes each belief to the
 * runs whose sources and timing produced its claims, and says that is what it is doing. A
 * belief later overturned by a further run shows under both, which is correct: both runs
 * touched it.
 */

/** Slack on the run window: a claim lands a moment after the CLI reports finishing. */
const SETTLE_MS = 20_000;

interface Movement {
  touched: Belief[];
  byState: Map<string, number>;
  settled: number;
}

function movement(run: RunRecord, beliefs: Belief[]): Movement {
  const start = Date.parse(run.at);
  const span = Math.max(...run.results.map((r) => r.seconds), 0) * 1000;
  const end = start + span + SETTLE_MS;
  const sources = new Set(run.sources);

  const touched = beliefs.filter((b) =>
    b.claims.some((c) => {
      if (c.at < start - SETTLE_MS || c.at > end) return false;
      const key = sourceKey(c.source);
      return sources.has(key) || sources.has(key.replace(':default', ''));
    }),
  );

  const byState = new Map<string, number>();
  for (const b of touched) {
    const n = state(b.status).name;
    byState.set(n, (byState.get(n) ?? 0) + 1);
  }
  // "Settled" means it stopped needing another source: agreed on, or signed off.
  const settled = touched.filter(
    (b) => b.status === 'CORROBORATED' || b.status === 'CONFIRMED',
  ).length;

  return { touched, byState, settled };
}

const TONE: Record<string, string> = {
  corroborated: 'ok',
  confirmed: 'ok',
  contested: 'bad',
  inferred: 'warn',
  stale: 'warn',
};

export function Runs({ runs, beliefs, onOpen, events, replaying, onReplaying }: {
  runs: RunRecord[];
  beliefs: Belief[];
  onOpen: (b: Belief) => void;
  /** Recorded tool calls, so a finished run can be played back over the map. */
  events: VdsEvent[];
  replaying: boolean;
  onReplaying: (on: boolean) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);

  const rows = useMemo(
    () => [...runs]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map((r) => ({ run: r, move: movement(r, beliefs) })),
    [runs, beliefs],
  );

  const selected = rows.find((r) => r.run.at === picked) ?? null;

  return (
    <div className="screen">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>Runs</h2>
            <p className="sub">
              What each run actually moved. Beliefs are attributed by the sources and the
              window that produced their claims, and they show where they stand{' '}
              <em>now</em> — a belief a later run overturned appears under both.
            </p>
          </div>
        </div>
      </div>

      <div className="screen-cols">
        <div className="screen-body">
          {!runs.length && (
            <p className="dim">
              No runs recorded. This survives restarts, unlike the toast that used to be the
              only place a finished run was mentioned.
            </p>
          )}

          {runs.length > 0 && (
            <div className="run-head">
              <span>run</span>
              <span>belief movement</span>
              <span>sources</span>
              <span>cost</span>
              <span>per belief</span>
            </div>
          )}

          {rows.map(({ run, move }, i) => {
            const per = move.settled > 0 ? run.cost / move.settled : null;
            return (
              <button
                key={`${run.at}-${i}`}
                className="run-row"
                aria-pressed={picked === run.at}
                onClick={() => setPicked(picked === run.at ? null : run.at)}
              >
                <span className="id">{rows.length - i}</span>
                <span className="moved">
                  {move.byState.size === 0 && <span className="moved-pill">nothing settled</span>}
                  {[...move.byState].map(([name, n]) => (
                    <span key={name} className={`moved-pill ${TONE[name] ?? ''}`}>
                      {n} {name}
                    </span>
                  ))}
                </span>
                <span className="who">
                  {run.sources.join(', ')}
                  {run.diversity < 2 && <span className="hint"> · one source</span>}
                  {run.spread && ' · split'}
                </span>
                <span className="cost" title={run.costKnown ? undefined : 'a CLI reported no spend, so this is a floor'}>
                  {money(run.cost)}{run.costKnown ? '' : '+'}
                </span>
                <span className="per">
                  {per === null ? `${money(run.cost)} / 0` : money(per)}
                </span>
              </button>
            );
          })}

          {rows.some((r) => r.run.diversity < 2 && r.move.settled === 0) && (
            <p className="dim">
              A run with one source settled nothing — corroboration counts distinct tool:model
              pairs, so a single source can only ever produce inferred beliefs however much it
              claims.
            </p>
          )}

          {events.length > 0 && (
            <div className="card">
              <h3>Replay</h3>
              <p className="dim">
                Every tool call a run made was recorded, so the map can be wound back through
                it. The scene draws the reconstruction rather than the live feed while this is
                running.
              </p>
              <Scrubber events={events} active={replaying} onActiveChange={onReplaying} />
            </div>
          )}

          <details className="raw">
            <summary>how much of the map can be believed</summary>
            <div>
              <Quality active />
            </div>
          </details>
        </div>

        <div className="rail">
          {!selected && (
            <>
              <div className="rail-label">pick a run</div>
              <p className="dim">
                Selecting one shows the beliefs it produced and where each of them stands now.
              </p>
              {runs.length > 0 && (
                <div className="facts" style={{ marginTop: 12 }}>
                  <div className="fact">
                    <span className="k">runs recorded</span>
                    <span className="v">{runs.length}</span>
                  </div>
                  <div className="fact">
                    <span className="k">spent in total</span>
                    <span className="v warn">
                      {money(runs.reduce((n, r) => n + r.cost, 0))}
                      {runs.every((r) => r.costKnown) ? '' : '+'}
                    </span>
                  </div>
                  <div className="fact">
                    <span className="k">single-source runs</span>
                    <span className="v warn">{runs.filter((r) => r.diversity < 2).length}</span>
                  </div>
                </div>
              )}
            </>
          )}

          {selected && (
            <>
              <div className="rail-label">
                run of {new Date(selected.run.at).toLocaleString()}
              </div>
              <div className="facts">
                <div className="fact">
                  <span className="k">questions handed out</span>
                  <span className="v">{selected.run.assigned}</span>
                </div>
                <div className="fact">
                  <span className="k">beliefs touched</span>
                  <span className="v">{selected.move.touched.length}</span>
                </div>
                <div className="fact">
                  <span className="k">settled</span>
                  <span className="v ok">{selected.move.settled}</span>
                </div>
                <div className="fact">
                  <span className="k">claims recorded</span>
                  <span className="v">+{selected.run.delta.claims}</span>
                </div>
                <div className="fact">
                  <span className="k">converged</span>
                  <span className="v">{selected.run.converged ? 'yes' : 'no'}</span>
                </div>
              </div>

              {selected.run.results.map((r) => (
                <div className="fact" key={r.source}>
                  <span className="k">{r.source}</span>
                  <span className={r.ok ? 'v' : 'v bad'}>
                    {r.ok ? `${r.turns} turns · ${Math.round(r.seconds)}s` : r.failure ?? 'failed'}
                  </span>
                </div>
              ))}

              {selected.run.notes.map((n, i) => (
                <div className="card quiet" key={i}>
                  <p className="hint" style={{ margin: 0, fontSize: 11 }}>{n}</p>
                </div>
              ))}

              <div className="rail-label" style={{ marginTop: 4 }}>what it moved</div>
              {!selected.move.touched.length && (
                <p className="dim">
                  Nothing in the store can be attributed to this run. Either it failed, or its
                  claims were duplicates of ones already held.
                </p>
              )}
              {selected.move.touched.slice(0, 10).map((b) => (
                <button
                  key={`${b.subject}:${b.predicate}`}
                  className={b.status === 'CONTRADICTED' ? 'belief-row contested' : 'belief-row'}
                  onClick={() => onOpen(b)}
                >
                  <div className="body">
                    <div className="claim-line" style={{ fontSize: 11.5 }}>{b.predicate}</div>
                    <div className="meta">{b.subject}</div>
                  </div>
                  <span className={`pill ${state(b.status).name}`}>{state(b.status).name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
