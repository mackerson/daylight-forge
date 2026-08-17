import { useState } from 'react';
import type { LoadPayload } from '../types.ts';
import { Author } from './Author.tsx';

/** Invariants belong to the analysed repo, so an empty state here is normal, not a failure. */
export function Invariants({ data, onRefresh }: { data: LoadPayload; onRefresh: () => void }) {
  const results = data.invariants?.results ?? [];
  const [authoring, setAuthoring] = useState(false);

  if (!results.length) {
    return (
      <div className="stack">
        <div className="empty">
        <h2>No invariants defined</h2>
        <p>
          Invariants are claims about <em>this</em> codebase — “the event bus is storage-only”,
          “streaming has one consumer” — so they live with the code they constrain, not in the tool.
        </p>
        <p className="dim">
          Create <code>vds.invariants.json</code> in the repo root. Each one needs an <code>id</code>,
          the <code>prose</code> a human reads, and a <code>predicate</code> compiled against L0.
          Until then L3 reports UNPROVEN rather than failing.
        </p>
        <button onClick={() => setAuthoring(true)}>Write the first one</button>
        </div>
        {authoring && <Author onSaved={onRefresh} />}
      </div>
    );
  }

  const red = results.filter((r) => r.status === 'red');

  return (
    <div className="stack">
      <div className="toolbar">
        <span className={red.length ? 'bad' : 'ok'}>
          {results.length - red.length} green · {red.length} red
        </span>
        <button className={authoring ? 'chip active' : 'chip'} onClick={() => setAuthoring(!authoring)}>
          {authoring ? 'close' : 'write one'}
        </button>
      </div>
      {authoring && <Author onSaved={onRefresh} />}
      {results.map((r) => (
        <section key={r.id} className={r.status === 'red' ? 'card bad-border' : 'card'}>
          <h3>
            <span className={r.status === 'red' ? 'pill bad' : 'pill ok'}>{r.status}</span> {r.id}
          </h3>
          <p className="prose">{r.prose}</p>
          <p className="dim mono">{r.measured}</p>
          {r.violations.length > 0 && (
            <ul className="rows">
              {r.violations.map((v, i) => (
                <li key={i}>
                  <code>{v.where}{v.line ? `:${v.line}` : ''}</code> — {v.detail}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
