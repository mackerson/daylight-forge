import { useEffect, useMemo, useState } from 'react';
import type { Belief, Claim, D1Pair, Evidence } from '../types.ts';

/**
 * The arbitration screen.
 *
 * A contradiction is not a list of claims; it is a question two sources answered
 * differently, and the decision needs three things a list cannot give: what each side
 * said, what each side *looked at*, and whether they looked at the same thing.
 *
 * That last one is the load-bearing distinction. If both cited the same spans and reached
 * opposite conclusions, it is a judgement call and someone has to pick. If they cited
 * different spans, neither is necessarily wrong — they searched different places, and the
 * right move is usually to make each look at what the other saw rather than to crown a
 * winner. The screen names which case you are in rather than leaving you to infer it.
 */

const evKey = (e: Evidence) => `${e.file}:${e.line ?? ''}`;

function Snippet({ ev, tone }: { ev: Evidence; tone: string }) {
  const [state, setState] = useState<{ lines?: string[]; start?: number; error?: string }>({});
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let live = true;
    if (!ev.file) return;
    void window.vds.snippet({ file: ev.file, line: ev.line, context: 3 }).then((r) => {
      if (live) setState(r);
    });
    return () => {
      live = false;
    };
  }, [ev.file, ev.line]);

  return (
    <div className={`snip ${tone}`}>
      <button className="snip-head" onClick={() => setOpen(!open)}>
        <code>{ev.file}{ev.line ? `:${ev.line}` : ''}</code>
        {ev.note && <em>{ev.note}</em>}
      </button>
      {open && state.error && <div className="snip-err">{state.error}</div>}
      {open && state.lines && (
        <pre className="snip-code">
          {state.lines.map((l, i) => {
            const n = (state.start ?? 1) + i;
            return (
              <div key={n} className={n === ev.line ? 'snip-line hit' : 'snip-line'}>
                <span className="snip-n">{n}</span>
                {l || ' '}
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}

export function Arbitrate({
  belief, pair, onClose, onDecided,
}: {
  belief: Belief;
  /** The D1 pair behind a duplication verdict, when there is one. */
  pair?: D1Pair;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState('');

  // Group by what was asserted: everyone saying the same thing is one side.
  const sides = useMemo(() => {
    const byValue = new Map<string, Claim[]>();
    for (const c of belief.claims) {
      const k = JSON.stringify(c.value ?? null);
      (byValue.get(k) ?? byValue.set(k, []).get(k)!).push(c);
    }
    return [...byValue.entries()].map(([key, claims]) => ({ key, claims }));
  }, [belief]);

  // Which spans were cited by more than one side, and which by only one.
  const { shared, unique } = useMemo(() => {
    const bySide = sides.map((s) => new Set(s.claims.flatMap((c) => c.evidence.map(evKey))));
    const all = new Set(bySide.flatMap((s) => [...s]));
    const shared = new Set([...all].filter((k) => bySide.filter((s) => s.has(k)).length > 1));
    return { shared, unique: new Set([...all].filter((k) => !shared.has(k))) };
  }, [sides]);

  const sameGround = shared.size > 0 && unique.size === 0;
  const disjoint = shared.size === 0;

  const decide = async (value: unknown, note: string) => {
    setBusy(true);
    await window.vds.arbitrate({
      subject: belief.subject, predicate: belief.predicate, value, note,
    });
    setBusy(false);
    onDecided();
    onClose();
  };

  return (
    <div className="arb">
      <header className="arb-head">
        <div>
          <span className="pill contradicted">contradicted</span>
          <code>{belief.predicate}</code>
          <span className="dim mono">{belief.subject}</span>
        </div>
        <button className="link" onClick={onClose}>close</button>
      </header>

      <div className={`arb-verdict ${sameGround ? 'judgement' : disjoint ? 'incomplete' : 'mixed'}`}>
        {sameGround && (
          <>
            <strong>Same evidence, opposite conclusions.</strong> Both sides read the same
            spans and disagree about what they mean. This is a judgement call — someone has
            to pick.
          </>
        )}
        {disjoint && (
          <>
            <strong>No shared evidence.</strong> The sides looked at different places, so
            neither is necessarily wrong — this is more likely an incomplete search than a
            real disagreement. Consider having each look at what the other cited before
            crowning a winner.
          </>
        )}
        {!sameGround && !disjoint && (
          <>
            <strong>{shared.size} shared span(s), {unique.size} cited by only one side.</strong>{' '}
            Partly a judgement call and partly a difference in what was examined.
          </>
        )}
      </div>

      {pair && (
        <section className="arb-diff">
          <h3>What the detector compared</h3>
          <div className="arb-cols">
            <div>
              <code>{pair.a}</code>
              <ul className="rows mono">
                {pair.shared.map((f) => <li key={f} className="same">{f}</li>)}
                {pair.onlyA.map((f) => <li key={f} className="only">− {f}</li>)}
              </ul>
            </div>
            <div>
              <code>{pair.b}</code>
              <ul className="rows mono">
                {pair.shared.map((f) => <li key={f} className="same">{f}</li>)}
                {pair.onlyB.map((f) => <li key={f} className="only">+ {f}</li>)}
              </ul>
            </div>
          </div>
          <p className="dim">
            {pair.nameScore.toFixed(2)} of field names match, {pair.score.toFixed(2)} of
            name-and-type pairs. Names matching while types do not is usually drift, not
            duplication.
          </p>
        </section>
      )}

      <div className="arb-cols">
        {sides.map((side, i) => {
          const value = side.claims[0].value;
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          return (
            <section key={side.key} className={`arb-side s${i}`}>
              <h3>
                {side.claims.map((c) => (
                  <span key={c.id} className={`src ${c.source.kind}`}>
                    {c.source.kind === 'human'
                      ? 'human'
                      : `${c.source.tool}/${c.source.model ?? 'default'}`}
                  </span>
                ))}
                <span className="dim">
                  {Math.max(...side.claims.map((c) => c.confidence)).toFixed(2)}
                </span>
              </h3>
              <p className="value">{text}</p>

              <h4>Evidence</h4>
              {side.claims.flatMap((c) => c.evidence).map((ev, k) => (
                <Snippet
                  key={`${evKey(ev)}-${k}`}
                  ev={ev}
                  tone={shared.has(evKey(ev)) ? 'shared' : 'unique'}
                />
              ))}

              <button disabled={busy} onClick={() => decide(value, `arbitrated: chose ${i === 0 ? 'first' : 'second'} side`)}>
                This one is right
              </button>
            </section>
          );
        })}
      </div>

      <footer className="arb-foot">
        <input
          value={custom}
          placeholder="…or state the answer yourself"
          onChange={(e) => setCustom(e.target.value)}
        />
        <button disabled={busy || !custom.trim()} onClick={() => decide(custom.trim(), 'arbitrated: human wrote the verdict')}>
          Record my verdict
        </button>
        <span className="dim">
          Whatever you choose becomes CONFIRMED and outranks every agent.
        </span>
      </footer>
    </div>
  );
}
