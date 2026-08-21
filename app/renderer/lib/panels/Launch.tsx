import { useEffect, useMemo, useState } from 'react';
import type { AdapterStatus, RosterEntry, RunShape } from '../types.ts';

/**
 * The launch surface.
 *
 * It used to be two buttons that both said `tools: 'claude'`, so every run in the product's
 * history came from one source. That is not a preference, it is a ceiling: the claim store
 * counts independent sources as tool+model, a belief needs two of them to reach CORROBORATED,
 * and two agents can only be seen to disagree if they were recorded as two agents. One tool
 * on one model can do neither, however many times you press the button.
 *
 * So the roster edits *pairs*, the same tool may appear twice on different models, and the
 * count of distinct pairs is shown before you spend anything — because a run that cannot
 * corroborate looks exactly like one that can until you go looking at the store afterwards.
 */

const DEFAULT_SHAPE: RunShape = {
  roster: [{ tool: 'claude', model: 'sonnet' }],
  mode: 'explore',
  batch: 5,
  concurrency: 2,
  maxCost: 2,
  spread: false,
};

const STORAGE_KEY = 'vds.runShape';

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

export function Launch({
  onLaunch, busy, disabled,
}: {
  onLaunch: (opts: {
    tools: string; mode: 'explore' | 'focus'; batch: number;
    concurrency: number; maxCost: number; spread: boolean; dryRun: boolean;
  }) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [shape, setShape] = useState<RunShape>(loadShape);
  const [adapters, setAdapters] = useState<AdapterStatus[] | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    void window.vds.adapters().then((r) => setAdapters(r.adapters ?? []));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  }, [shape]);

  const byName = useMemo(
    () => new Map((adapters ?? []).map((a) => [a.name, a])),
    [adapters],
  );
  const installed = (adapters ?? []).filter((a) => a.installed);

  // Distinct tool:model pairs — the same arithmetic the belief calculus does.
  const sources = new Set(shape.roster.map(keyOf));
  const diversity = sources.size;
  const dupes = shape.roster.length - diversity;

  const patch = (p: Partial<RunShape>) => setShape((s) => ({ ...s, ...p }));
  const setRow = (i: number, p: Partial<RosterEntry>) =>
    patch({ roster: shape.roster.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const addRow = () => {
    // Offer something that adds a source rather than repeating one already in the roster.
    const used = new Set(shape.roster.map(keyOf));
    for (const a of installed) {
      for (const m of a.models.length ? a.models : ['']) {
        if (!used.has(`${a.name}:${m || 'default'}`)) {
          patch({ roster: [...shape.roster, { tool: a.name, model: m }] });
          return;
        }
      }
    }
    patch({ roster: [...shape.roster, { tool: installed[0]?.name ?? 'claude', model: '' }] });
  };

  const go = (dryRun: boolean) =>
    onLaunch({
      tools: rosterArg(shape.roster),
      mode: shape.mode,
      batch: shape.batch,
      concurrency: shape.concurrency,
      maxCost: shape.maxCost,
      spread: shape.spread,
      dryRun,
    });

  // Setup notes belong to the tools you are about to run, not the ones you are not. The
  // first version had this backwards and told you how to register grok while you were
  // launching claude.
  const rostered = [...new Set(shape.roster.map((r) => r.tool))]
    .map((t) => byName.get(t))
    .filter((a): a is AdapterStatus => !!a);
  const blocking = rostered.filter((a) => !a.installed || a.note || !a.perInvocationMcp);
  const spare = installed.filter((a) => !shape.roster.some((r) => r.tool === a.name));
  const missing = (adapters ?? []).filter((a) => !a.installed);

  return (
    <section className="card launch">
      <h3>
        Launch
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'collapse' : 'expand'}
        </button>
      </h3>

      {!open && (
        <p className="dim">
          {shape.mode} · {shape.roster.length} agent(s) · {diversity} source(s) · ceiling $
          {shape.maxCost.toFixed(2)}
        </p>
      )}

      {open && (
        <>
          <div className="toolbar">
            {(['explore', 'focus'] as const).map((m) => (
              <button
                key={m}
                className={shape.mode === m ? 'chip active' : 'chip'}
                onClick={() => patch({ mode: m })}
                title={
                  m === 'explore'
                    ? 'answer the highest-uncertainty frontier questions'
                    : 'propose clusters and elisions — what the map is FOR, not what is in it'
                }
              >
                {m === 'explore' ? 'Explore' : 'Focus'}
              </button>
            ))}
          </div>

          {/* One list per tool, not per row: two rows on the same tool would otherwise emit
              two elements sharing an id and the browser would quietly use the first. */}
          {(adapters ?? [])
            .filter((a) => a.models.length)
            .map((a) => (
              <datalist key={a.name} id={`models-${a.name}`}>
                {a.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            ))}

          <div className="roster">
            {shape.roster.map((row, i) => {
              const a = byName.get(row.tool);
              const dupe =
                shape.roster.findIndex((r) => keyOf(r) === keyOf(row)) !== i;
              return (
                <div className={dupe ? 'roster-row dupe' : 'roster-row'} key={i}>
                  <select value={row.tool} onChange={(e) => setRow(i, { tool: e.target.value, model: '' })}>
                    {(adapters ?? []).map((opt) => (
                      <option key={opt.name} value={opt.name} disabled={!opt.installed}>
                        {opt.name}
                        {opt.installed ? '' : ' (not installed)'}
                      </option>
                    ))}
                  </select>

                  {/* Free text with suggestions, not a closed list: the suggestions come
                      from whatever the binary said, and it may not have been able to say. */}
                  <input
                    list={`models-${row.tool}`}
                    value={row.model}
                    placeholder={a?.models.length ? 'default' : 'model id'}
                    onChange={(e) => setRow(i, { model: e.target.value })}
                  />
                  <button
                    className="link"
                    title="remove this agent"
                    disabled={shape.roster.length === 1}
                    onClick={() => patch({ roster: shape.roster.filter((_, j) => j !== i) })}
                  >
                    remove
                  </button>
                  {dupe && <span className="dim">same source as a row above</span>}
                </div>
              );
            })}
            <button className="link" onClick={addRow}>+ add agent</button>
          </div>

          <Diversity count={diversity} dupes={dupes} roster={shape.roster} />

          {shape.mode === 'focus' && diversity > 1 && (
            <p className="hint">
              Focus with more than one source currently makes the architecture level worse, not
              better. Explore corroborates because every agent answers the same fixed questions;
              Focus <em>proposes</em>, and nothing yet reconciles clusters that describe one
              subsystem in three different words — so L3 grows instead of collapsing. Corroborate
              with Explore, focus with one.
            </p>
          )}

          {blocking.map((a) => (
            <Note key={a.name} adapter={a} />
          ))}
          {(spare.length > 0 || missing.length > 0) && (
            <p className="dim">
              {spare.length > 0 && `also installed: ${spare.map((a) => a.name).join(', ')}`}
              {spare.length > 0 && missing.length > 0 && ' · '}
              {missing.length > 0 && `not installed: ${missing.map((m) => m.name).join(', ')}`}
            </p>
          )}

          <div className="fields">
            <label title="frontier items handed to each agent">
              batch
              <input
                type="number" min={1} max={25} value={shape.batch}
                disabled={shape.mode === 'focus'}
                onChange={(e) => patch({ batch: Number(e.target.value) })}
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
            <label className="check" title="a choice with a real cost either way">
              <input
                type="checkbox"
                checked={shape.spread}
                onChange={(e) => patch({ spread: e.target.checked })}
              />
              split the frontier between them
              <span className="dim">
                {shape.spread
                  ? ` — ${shape.batch * shape.roster.length} subjects touched once each. Covers ground; corroborates nothing.`
                  : ` — all ${shape.roster.length} answer the same ${shape.batch}. Fewer subjects, but they can agree or disagree.`}
              </span>
            </label>
          )}

          <div className="actions">
            <button disabled={disabled || busy} onClick={() => go(false)}>
              Launch {shape.roster.length} agent{shape.roster.length === 1 ? '' : 's'}
            </button>
            <button
              className="secondary"
              disabled={disabled || busy}
              onClick={() => go(true)}
              title="show the plan and write the prompt; spawn nothing, spend nothing"
            >
              Dry run
            </button>
            {shape.maxCost > 0 && (
              <span className="dim">stops at ${shape.maxCost.toFixed(2)}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The pre-flight the product did not have.
 *
 * A single-source run fails silently and expensively: the claims land, the counters go up,
 * the panel fills with activity, and every belief it produced is stuck at INFERRED with the
 * frontier still holding residual uncertainty on all of them. Cheaper to say here.
 */
function Diversity({ count, dupes, roster }: {
  count: number; dupes: number; roster: RosterEntry[];
}) {
  return (
    <p className={count < 2 ? 'hint' : 'ok'}>
      {count} independent source{count === 1 ? '' : 's'}
      {dupes > 0 && ` · ${dupes} duplicate row${dupes === 1 ? '' : 's'} will be dropped`}
      {count < 2 ? (
        <>
          {' '}— corroboration counts distinct tool:model pairs, so nothing this run claims can
          rise above INFERRED and no disagreement can be found. Add a second tool, or the same
          tool on a different model.
        </>
      ) : (
        <>
          {' '}({[...new Set(roster.map(keyOf))].join(', ')}) — enough for a belief to be
          corroborated, or for two of them to be caught disagreeing.
        </>
      )}
    </p>
  );
}

/**
 * Why a tool in your roster is not simply going to work.
 *
 * Only shown for tools actually being launched, and only when something stands in the way:
 * not installed, not authenticated, or needing a registration we will not perform on the
 * user's behalf. The command is behind a disclosure because it is long, it is needed once,
 * and it should not push the launch button off the panel every time you open this.
 */
function Note({ adapter }: { adapter: AdapterStatus }) {
  if (!adapter.installed) {
    return (
      <p className="hint">
        <code>{adapter.name}</code> is not installed — it will be skipped.
      </p>
    );
  }
  if (adapter.note) {
    return (
      <p className="hint">
        <code>{adapter.name}</code> {adapter.note}
      </p>
    );
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
