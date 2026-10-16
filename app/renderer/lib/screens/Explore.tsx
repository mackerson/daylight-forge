import { useEffect, useMemo, useState } from 'react';
import type {
  AdapterStatus, RosterEntry, RunRecord, RunShape,
} from '../types.ts';
import { money, sourceColor } from '../vocab.ts';

/**
 * The explore launcher, as a work order.
 *
 * The question this screen exists to answer is "what will they actually do", and the old
 * launcher answered it with a roster and a batch size — which is the shape of the run, not
 * its content. So each agent gets a card you can read as instructions before spending
 * anything, and the estimate beside it comes from what that exact tool:model pair has cost
 * on this repo before rather than from a table of list prices.
 *
 * The other half of the screen is the argument for running more than one: two sources that
 * agree produce a corroborated belief, and two that disagree produce the most valuable
 * thing the tool can find. Disagreement is a goal here, not a failure.
 */

const DEFAULT_SHAPE: RunShape = {
  roster: [{ tool: 'claude', model: 'sonnet' }],
  mode: 'explore',
  batch: 5,
  concurrency: 2,
  maxCost: 2,
  spread: false,
  rounds: 8,
};

const STORAGE_KEY = 'daylight.runShape';

function loadShape(): RunShape {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && Array.isArray(saved.roster) && saved.roster.length) {
      return { ...DEFAULT_SHAPE, ...saved };
    }
  } catch {
    // A corrupt preference is not worth an error state; fall back and move on.
  }
  return DEFAULT_SHAPE;
}

/** The roster as the CLI takes it, and as the claim store will record it. */
const rosterArg = (roster: RosterEntry[]): string =>
  roster.map((r) => (r.model ? `${r.tool}:${r.model}` : r.tool)).join(',');

const keyOf = (r: RosterEntry) => `${r.tool}:${r.model || 'default'}`;

/**
 * What this pair has actually cost here, per run.
 *
 * A published price per token cannot tell you what a run costs, because the number of turns
 * is the variable and it depends on the repo. History can, and when there is no history the
 * honest answer is that there is none — not a guess with a currency symbol on it.
 */
interface Estimate { cost: number | null; seconds: number | null; runs: number; priced: boolean }

function estimates(runs: RunRecord[]): Map<string, Estimate> {
  const acc = new Map<string, { cost: number; seconds: number; n: number; priced: number }>();
  for (const r of runs) {
    for (const res of r.results) {
      const a = acc.get(res.source) ?? { cost: 0, seconds: 0, n: 0, priced: 0 };
      a.cost += res.cost;
      a.seconds += res.seconds;
      a.n += 1;
      // A CLI that reports token usage and no price makes its own total a floor. Averaging
      // its zeroes in would quietly halve the estimate for everyone else in the roster.
      if (res.cost > 0) a.priced += 1;
      acc.set(res.source, a);
    }
  }
  const out = new Map<string, Estimate>();
  for (const [k, a] of acc) {
    out.set(k, {
      cost: a.priced ? a.cost / a.priced : null,
      seconds: a.n ? a.seconds / a.n : null,
      runs: a.n,
      priced: a.priced > 0,
    });
  }
  return out;
}

export function Explore({
  scope, onClearScope, runs, busy, disabled, onLaunch, onRun, onMonitor, running,
}: {
  /** Subjects a selection on the map or in detect asked for. Empty lets the frontier choose. */
  scope: string[];
  onClearScope: () => void;
  runs: RunRecord[];
  busy: boolean;
  disabled: boolean;
  onLaunch: (opts: {
    tools: string; mode: 'explore' | 'focus'; batch: number;
    concurrency: number; maxCost: number; spread: boolean; dryRun: boolean;
    only: string[];
  }) => void;
  onMonitor: () => void;
  /**
   * The whole loop, unattended: rounds until the frontier converges or a ceiling stops it.
   *
   * Separate from `onLaunch` rather than a flag on it, because they are different decisions.
   * One round is "answer these questions"; a campaign is "keep going until it is not worth
   * it any more", and the ceiling stops being a per-run cap and becomes the whole budget.
   */
  onRun: (opts: {
    tools: string; rounds: number; maxCost: number; batch: number;
    concurrency: number; spread: boolean; only: string[];
  }) => void;
  running: number;
}) {
  const [shape, setShape] = useState<RunShape>(loadShape);
  const [adapters, setAdapters] = useState<AdapterStatus[] | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    void window.daylight.adapters().then((r) => setAdapters(r.adapters ?? []));
  }, []);
  // Runs every installed agent CLI to ask what models it has, so only when asked to.
  const refreshModels = () => {
    setAsking(true);
    void window.daylight.adapters({ refresh: true })
      .then((r) => setAdapters(r.adapters ?? []))
      .finally(() => setAsking(false));
  };
  const probed = (adapters ?? []).some((a) => a.probed);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  }, [shape]);

  const est = useMemo(() => estimates(runs), [runs]);
  const byName = useMemo(() => new Map((adapters ?? []).map((a) => [a.name, a])), [adapters]);
  const installed = (adapters ?? []).filter((a) => a.installed);

  const patch = (p: Partial<RunShape>) => setShape((s) => ({ ...s, ...p }));
  const setRow = (i: number, p: Partial<RosterEntry>) =>
    patch({ roster: shape.roster.map((r, j) => (j === i ? { ...r, ...p } : r)) });

  // Distinct tool:model pairs — the same arithmetic the belief calculus does.
  const sources = [...new Set(shape.roster.map(keyOf))];
  const diversity = sources.length;
  const dupes = shape.roster.length - diversity;

  const perAgent = shape.spread ? shape.batch : shape.batch;
  const askCount = scope.length
    ? Math.min(scope.length, shape.spread ? shape.batch * shape.roster.length : shape.batch)
    : perAgent;

  const known = shape.roster.filter((r) => est.get(keyOf(r))?.priced);
  const estimated = shape.roster.reduce((n, r) => n + (est.get(keyOf(r))?.cost ?? 0), 0);
  const allPriced = known.length === shape.roster.length;

  const spare = installed.filter((a) => !shape.roster.some((r) => r.tool === a.name));
  const rostered = [...new Set(shape.roster.map((r) => r.tool))]
    .map((t) => byName.get(t))
    .filter((a): a is AdapterStatus => !!a);
  const blocking = rostered.filter((a) => !a.installed || a.note || !a.perInvocationMcp);

  const campaign = () =>
    onRun({
      tools: rosterArg(shape.roster),
      rounds: shape.rounds,
      maxCost: shape.maxCost,
      batch: shape.batch,
      concurrency: shape.concurrency,
      spread: shape.spread,
      only: scope,
    });

  const go = (dryRun: boolean) =>
    onLaunch({
      tools: rosterArg(shape.roster),
      mode: shape.mode,
      batch: shape.batch,
      concurrency: shape.concurrency,
      maxCost: shape.maxCost,
      spread: shape.spread,
      only: scope,
      dryRun,
    });

  return (
    <div className="screen">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>Work order</h2>
            <p className="sub">
              Exactly what each source is told to do, and what it has cost here before. Edit
              any of it; nothing is spent until you launch.
            </p>
          </div>
          <div className="spacer" />
          {running > 0 && (
            <button className="btn accent" onClick={onMonitor}>
              {running} running — watch it →
            </button>
          )}
        </div>
      </div>

      <div className="screen-cols">
        <div className="screen-body">
          {scope.length > 0 ? (
            <div className="card accent">
              <h3>
                Scoped to {scope.length} subject{scope.length === 1 ? '' : 's'}
                <div className="spacer" />
                <button className="link" onClick={onClearScope}>use the whole frontier instead</button>
              </h3>
              <p className="dim">
                Ranking still applies inside the scope, so the most valuable question about
                these is asked first. {askCount} of them fit this run's batch.
              </p>
              <p className="subject">{scope.slice(0, 6).join(' · ')}{scope.length > 6 ? ` · +${scope.length - 6}` : ''}</p>
            </div>
          ) : (
            <p className="dim">
              Unscoped: the scheduler picks the {askCount} highest-scoring open questions,
              ranked by uncertainty x centrality. Select on the map or in detect to narrow it.
            </p>
          )}

          <div className="toolbar">
            {(['explore', 'focus'] as const).map((m) => (
              <button
                key={m}
                className={shape.mode === m ? 'chip active' : 'chip'}
                onClick={() => patch({ mode: m })}
                title={
                  m === 'explore'
                    ? 'answer open questions about what is true'
                    : 'propose clusters and elisions — what the map is FOR, not what is in it'
                }
              >
                {m === 'explore' ? 'Explore' : 'Focus'}
              </button>
            ))}
          </div>

          {/* One list per tool, not per row: two rows on the same tool would otherwise emit
              two elements sharing an id and the browser would quietly use the first. */}
          {(adapters ?? []).filter((a) => a.models.length).map((a) => (
            <datalist key={a.name} id={`models-${a.name}`}>
              {a.models.map((m) => <option key={m} value={m} />)}
            </datalist>
          ))}
          <p className="hint">
            {probed ? 'models: as each CLI reported them' : 'models: not asked'}
            {' · '}
            <button
              className="link"
              disabled={asking}
              onClick={refreshModels}
              title="runs each installed agent CLI to ask what models it has"
            >
              {asking ? 'asking…' : 'refresh models'}
            </button>
          </p>

          {shape.roster.map((row, i) => {
            const key = keyOf(row);
            const e = est.get(key);
            const a = byName.get(row.tool);
            const dupe = shape.roster.findIndex((r) => keyOf(r) === key) !== i;
            return (
              <div className="order" key={i}>
                <div className="order-head">
                  <i className="swatch" style={{ background: sourceColor(key) }} />
                  <select
                    className="who"
                    value={row.tool}
                    onChange={(ev) => setRow(i, { tool: ev.target.value, model: '' })}
                  >
                    {(adapters ?? []).map((opt) => (
                      <option key={opt.name} value={opt.name} disabled={!opt.installed}>
                        {opt.name}{opt.installed ? '' : ' (not installed)'}
                      </option>
                    ))}
                  </select>
                  <input
                    list={`models-${row.tool}`}
                    value={row.model}
                    placeholder={a?.models.length ? 'default' : 'model id'}
                    onChange={(ev) => setRow(i, { model: ev.target.value })}
                    style={{ maxWidth: 140 }}
                  />
                  <span className="cost">
                    {e?.priced && e.cost !== null
                      ? `~${money(e.cost)}${e.seconds ? ` · ~${Math.round(e.seconds)}s` : ''} · from ${e.runs} run${e.runs === 1 ? '' : 's'} here`
                      : e
                        ? `unpriced — this CLI reports turns, not dollars${e.seconds ? ` · ~${Math.round(e.seconds)}s` : ''}`
                        : 'never run here — no estimate'}
                  </span>
                  <button
                    className="link"
                    disabled={shape.roster.length === 1}
                    onClick={() => patch({ roster: shape.roster.filter((_, j) => j !== i) })}
                  >
                    remove
                  </button>
                </div>
                <ol className="order-steps">
                  <li>
                    1 · {shape.mode === 'focus'
                      ? 'Read the level-1 grouping and propose clusters and elisions for it'
                      : shape.spread
                        ? `Answer ${shape.batch} of the open questions — its own share, no overlap with the others`
                        : `Answer the same ${askCount} question${askCount === 1 ? '' : 's'} as every other agent here, independently and with no shared context`}
                  </li>
                  <li>2 · Read the actual source for each, and cite the file and line it answers from</li>
                  <li>
                    3 · Write claims through the MCP server. <strong>May not modify the repo</strong> —
                    unevidenced claims are rejected where they are ingested.
                  </li>
                </ol>
                {dupe && (
                  <p className="order-note hint">
                    Same source as a row above. It will be dropped — two rows on one tool:model
                    cost twice and corroborate nothing.
                  </p>
                )}
              </div>
            );
          })}

          {spare.length > 0 && (
            <div className="order reserve">
              <div className="order-head">
                <i className="swatch" style={{ background: 'var(--mark)' }} />
                <span className="who">+ add a source</span>
                <span className="trait">installed, not in this run</span>
              </div>
              <div className="order-note">
                {spare.map((a) => {
                  const e = est.get(`${a.name}:default`);
                  return (
                    <button
                      key={a.name}
                      className="link"
                      style={{ marginRight: 14 }}
                      onClick={() => patch({ roster: [...shape.roster, { tool: a.name, model: '' }] })}
                    >
                      {a.name}
                      {e?.priced && e.cost !== null
                        ? ` — adds ~${money(e.cost)} and an independent read`
                        : ' — adds an independent read'}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {blocking.map((a) => <Note key={a.name} adapter={a} />)}

          {shape.mode === 'focus' && diversity > 1 && (
            <p className="hint">
              Focus with more than one source currently makes the architecture level worse,
              not better. Explore corroborates because every agent answers the same fixed
              questions; Focus <em>proposes</em>, and nothing yet reconciles clusters that
              describe one subsystem in three different words — so L3 grows instead of
              collapsing. Corroborate with Explore, focus with one.
            </p>
          )}
        </div>

        <div className="rail">
          <div className="rail-label">the point of running {diversity === 1 ? 'more than one' : diversity}</div>

          {diversity < 2 ? (
            <p className="hint">
              One independent source. Corroboration counts distinct tool:model pairs, so
              nothing this run claims can rise above <strong>inferred</strong> and no
              disagreement can be discovered. Add a second tool, or the same tool on a
              different model.
            </p>
          ) : (
            <div className="card">
              <div className="outcome">
                <i className="swatch" style={{ background: 'var(--ok-mark)' }} />
                <div>
                  <div className="t">They agree</div>
                  <div className="d">Belief becomes <strong>corroborated</strong>. It stops asking.</div>
                </div>
              </div>
              <div className="outcome">
                <i className="swatch" style={{ background: 'var(--bad-mark)' }} />
                <div>
                  <div className="t">They disagree</div>
                  <div className="d">
                    Belief becomes <strong>contested</strong> — the highest-value thing this
                    tool can find. It comes to you.
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="rail-label">budget</div>
            <div className="facts" style={{ marginTop: 8 }}>
              <div className="fact">
                <span className="k">estimated</span>
                <span className="v warn">
                  {estimated > 0 ? `${allPriced ? '' : '≥ '}${money(estimated)}` : 'no history'}
                </span>
              </div>
              <div className="fact">
                <span className="k">hard stop</span>
                <span className="v">{shape.maxCost > 0 ? money(shape.maxCost) : 'none'}</span>
              </div>
            </div>
            {shape.maxCost > 0 && (
              <div className="meter">
                <div
                  className={estimated > shape.maxCost ? 'meter-fill bad' : 'meter-fill warn'}
                  style={{ width: `${Math.min(100, (estimated / shape.maxCost) * 100)}%` }}
                />
              </div>
            )}
            {!allPriced && (
              <p className="dim" style={{ fontSize: 11 }}>
                At least one adapter reports no price, so the total is a floor and the ceiling
                cannot be enforced against it.
              </p>
            )}

            <div className="fields">
              <label title="open questions handed to each agent">
                batch
                <input
                  type="number" min={1} max={25} value={shape.batch}
                  disabled={shape.mode === 'focus'}
                  onChange={(e) => patch({ batch: Number(e.target.value) })}
                />
              </label>
              <label title="most rounds a campaign may run before it gives up regardless">
                rounds
                <input
                  type="number" min={1} max={50} value={shape.rounds}
                  onChange={(e) => patch({ rounds: Math.max(1, Number(e.target.value) || 1) })}
                />
              </label>
              <label title="how many agents run at once">
                at once
                <input
                  type="number" min={1} max={8} value={shape.concurrency}
                  onChange={(e) => patch({ concurrency: Number(e.target.value) })}
                />
              </label>
              <label title="hard ceiling on spend for this run; 0 for no ceiling">
                ceiling $
                <input
                  type="number" min={0} step={0.5} value={shape.maxCost}
                  onChange={(e) => patch({ maxCost: Number(e.target.value) })}
                />
              </label>
            </div>

            {shape.mode === 'explore' && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={shape.spread}
                  onChange={(e) => patch({ spread: e.target.checked })}
                />
                split the questions between them
                <span className="dim">
                  {shape.spread
                    ? ` — ${shape.batch * shape.roster.length} subjects touched once each. Covers ground; corroborates nothing.`
                    : ` — all ${shape.roster.length} answer the same ${askCount}. Fewer subjects, but they can agree or disagree.`}
                </span>
              </label>
            )}
          </div>

          <p className="dim" style={{ fontSize: 11 }}>
            {askCount} question{askCount === 1 ? '' : 's'} · {diversity} source
            {diversity === 1 ? '' : 's'} · parallel {shape.concurrency} · repo read-only
            {dupes > 0 && ` · ${dupes} duplicate row${dupes === 1 ? '' : 's'} dropped`}
          </p>

          <div className="spacer" />

          <p className="dim" style={{ fontSize: 11 }}>
            {/* The ceilings are the one thing the frontier cannot decide for you, and the
                only reason an unattended loop is safe to start. */}
            A campaign stops at whichever comes first: the frontier converges, {' '}
            {money(shape.maxCost)} is spent, {shape.rounds} round
            {shape.rounds === 1 ? '' : 's'} have run, or two rounds change nothing.
          </p>

          {/* The ceilings are in the sentence above; repeating them here overflowed the card. */}
          <button
            className="btn ok wide"
            disabled={disabled || busy}
            onClick={campaign}
            title={`up to ${shape.rounds} rounds, ${money(shape.maxCost)} ceiling`}
          >
            Run to convergence
          </button>

          <button className="btn wide" disabled={disabled || busy} onClick={() => go(false)}>
            One round: {shape.roster.length} agent{shape.roster.length === 1 ? '' : 's'} on{' '}
            {askCount} question{askCount === 1 ? '' : 's'}
          </button>
          <button
            className="btn wide"
            disabled={disabled || busy}
            onClick={() => go(true)}
            title="show the plan and write the prompt; spawn nothing, spend nothing"
          >
            Dry run
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Why a tool in your roster is not simply going to work.
 *
 * Only shown for tools actually being launched, and only when something stands in the way:
 * not installed, not authenticated, or needing a registration we will not perform on the
 * user's behalf. The command is behind a disclosure because it is long, it is needed once,
 * and it should not push the launch button off the screen every time you open this.
 */
function Note({ adapter }: { adapter: AdapterStatus }) {
  if (!adapter.installed) {
    return <p className="hint"><code>{adapter.name}</code> is not installed — it will be skipped.</p>;
  }
  if (adapter.note) {
    return <p className="hint"><code>{adapter.name}</code> {adapter.note}</p>;
  }
  return (
    <details className="setup">
      <summary>
        <code>{adapter.name}</code> needs a one-time MCP registration you run yourself
      </summary>
      <p className="dim">
        It registers servers into your own config rather than per invocation, and we do not
        edit that for you.
      </p>
      <code className="hint-cmd">{adapter.registrationHint}</code>
    </details>
  );
}
