import { useState } from 'react';
import { SHAPES, type Shape } from '../../../../engine/invariants/shapes.ts';
import type { InvariantResult } from '../types.ts';

/**
 * Writing an invariant, with the answer visible before you commit to it.
 *
 * Invariants have been hand-written JSON since P1, which is fine for the person who built
 * the schema and a wall for everyone else. The wall is not the syntax though — it is that
 * you cannot see whether the claim holds until it is in the file and CI has run. The design
 * says an already-red invariant *should* break the branch that adds it, and it should; but
 * without a preview that rule punishes you for finding out, which is backwards.
 *
 * So: pick a shape, fill in the regexes, press Check. Red is a perfectly good outcome — it
 * means you have found something — and the form says so rather than blocking the save.
 */

export function Author({ onSaved }: { onSaved: () => void }) {
  const [shape, setShape] = useState<Shape>(SHAPES[0]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [id, setId] = useState('');
  const [prose, setProse] = useState('');
  const [result, setResult] = useState<(InvariantResult & { error?: string }) | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const predicate = JSON.stringify(shape.build(values), null, 2);

  const pick = (s: Shape) => {
    setShape(s);
    setValues({});
    setResult(null);
    setSaved(null);
  };

  const set = (k: string, v: string) => {
    setValues({ ...values, [k]: v });
    setResult(null);
  };

  const check = async () => {
    setBusy(true);
    setResult(await window.daylight.tryInvariant({ predicate }));
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    const r = await window.daylight.saveInvariant({ id: id.trim(), prose, predicate });
    setBusy(false);
    if (r.error) setSaved(`could not save: ${r.error}`);
    else {
      setSaved(`${r.replaced ? 'replaced' : 'added'} — ${r.count} invariant(s) in the repo`);
      onSaved();
    }
  };

  return (
    <section className="card author">
      <h3>Write an invariant</h3>
      <p className="dim">
        A claim about <em>this</em> codebase, checked against L0 on every run. It is saved into
        the repo's <code>daylight.invariants.json</code>, because an invariant belongs to the code it
        constrains — not to the tool looking at it.
      </p>

      <div className="toolbar wrap">
        {SHAPES.map((s) => (
          <button
            key={s.type}
            className={s.type === shape.type ? 'chip active' : 'chip'}
            onClick={() => pick(s)}
          >
            {s.type}
          </button>
        ))}
      </div>
      <p className="dim">{shape.summary}</p>

      <div className="fields">
        {shape.fields.map((f) => (
          <label key={f.key}>
            <span>{f.label}</span>
            <input
              value={values[f.key] ?? ''}
              placeholder={f.hint}
              inputMode={f.kind === 'number' ? 'numeric' : undefined}
              onChange={(e) => set(f.key, e.target.value)}
            />
          </label>
        ))}
        <label>
          <span>id</span>
          <input value={id} placeholder="no-random-in-scene" onChange={(e) => setId(e.target.value)} />
        </label>
        <label>
          <span>prose</span>
          <input
            value={prose}
            placeholder="what a human reads — “nothing under scene/ calls a randomness source”"
            onChange={(e) => setProse(e.target.value)}
          />
        </label>
      </div>

      <details>
        <summary className="dim">the predicate this compiles to</summary>
        <pre className="snip-code">{predicate}</pre>
      </details>

      <div className="toolbar">
        <button disabled={busy} onClick={check}>Check against the map</button>
        <button disabled={busy || !id.trim() || !prose.trim()} onClick={save}>
          Save to the repo
        </button>
      </div>

      {result?.error && <p className="bad">{result.error}</p>}
      {result && !result.error && (
        <div className={result.status === 'red' ? 'card bad-border' : 'card'}>
          <h4>
            <span className={result.status === 'red' ? 'pill bad' : 'pill ok'}>{result.status}</span>{' '}
            {result.measured}
          </h4>
          {result.status === 'red' && (
            <p className="dim">
              Red is a result, not a rejection — you can save it either way. But an invariant
              that is already red will fail the build on the branch that adds it, which is
              deliberate: the alternative is a permanently red main everyone learns to ignore.
              Fix the code, or narrow the claim.
            </p>
          )}
          {!!result.violations.length && (
            <ul className="rows">
              {result.violations.slice(0, 20).map((v, i) => (
                <li key={i}>
                  <button className="link mono" onClick={() => window.daylight.reveal({ file: v.where, line: v.line })}>
                    {v.where}{v.line ? `:${v.line}` : ''}
                  </button>{' '}
                  — {v.detail}
                </li>
              ))}
              {result.violations.length > 20 && (
                <li className="dim">… {result.violations.length - 20} more</li>
              )}
            </ul>
          )}
        </div>
      )}

      {saved && <p className={saved.startsWith('could not') ? 'bad' : 'ok'}>{saved}</p>}
    </section>
  );
}
