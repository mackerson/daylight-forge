import { useState } from 'react';
import type { LoadPayload, QueryPayload } from '../types.ts';

/**
 * Duplication families first, then the raw detector output. Families exist so a human
 * (or an agent) adjudicates once per family rather than once per pair.
 */
export function Findings({ data, query }: { data: LoadPayload; query: QueryPayload | null; onRefresh: () => void }) {
  const [view, setView] = useState<'families' | 'pairs' | 'patterns'>('families');
  const f = data.findings;

  const verdicts = new Map(
    (query?.beliefs ?? [])
      .filter((b) => b.predicate.includes('duplicat'))
      .map((b) => [b.subject, b] as const),
  );

  if (!f?.families) return <div className="empty"><h2>Not mapped yet</h2></div>;

  return (
    <div className="stack">
      <div className="toolbar">
        <button className={view === 'families' ? 'chip active' : 'chip'} onClick={() => setView('families')}>
          Families ({f.families.length})
        </button>
        <button className={view === 'pairs' ? 'chip active' : 'chip'} onClick={() => setView('pairs')}>
          D1 pairs ({f.d1.length})
        </button>
        <button className={view === 'patterns' ? 'chip active' : 'chip'} onClick={() => setView('patterns')}>
          Patterns ({f.patterns.length})
        </button>
      </div>

      {view === 'families' && (
        <>
          {!f.families.length && <p className="dim">No duplication families. That is a result, not an absence.</p>}
          {f.families.map((fam) => {
            const belief = verdicts.get(fam.id);
            return (
              <section key={fam.id} className="card">
                <h3>
                  <span className="pill">{fam.detectors.join('+')}</span>
                  {fam.topScore !== undefined && <span className="score">{fam.topScore.toFixed(2)}</span>}
                  <span className="dim">{fam.members.length} members</span>
                  {belief && <span className={`pill ${belief.status.toLowerCase()}`}>{belief.status}</span>}
                </h3>
                <ul className="rows mono">
                  {fam.members.map((m) => (
                    <li key={m}>
                      <button className="link mono" onClick={() => window.vds.reveal({ file: m.split('#')[0] })}>{m}</button>
                    </li>
                  ))}
                </ul>
                <details>
                  <summary className="dim">why these are grouped</summary>
                  <ul className="rows dim">{fam.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </details>
              </section>
            );
          })}
        </>
      )}

      {view === 'pairs' && (
        <section className="card">
          <table className="grid">
            <thead>
              <tr><th>names</th><th>typed</th><th>a</th><th>b</th><th>differs</th></tr>
            </thead>
            <tbody>
              {f.d1.map((p, i) => (
                <tr key={i}>
                  <td>{p.nameScore.toFixed(2)}</td>
                  <td className={p.score < 0.2 ? 'dim' : ''}>{p.score.toFixed(2)}</td>
                  <td className="mono">{short(p.a)}</td>
                  <td className="mono">{short(p.b)}</td>
                  <td className="dim mono">
                    {p.onlyA.length ? `-${p.onlyA.join(',')}` : ''} {p.onlyB.length ? `+${p.onlyB.join(',')}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view === 'patterns' && (
        <section className="card">
          <p className="dim">
            Oversized detector groups: a shared <em>role</em> rather than copy-paste. Input to
            clustering, not a dedup finding.
          </p>
          <ul className="rows">
            {f.patterns.map((p, i) => (
              <li key={i}><code>{p.key}</code> <span className="dim">× {p.members.length}</span></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const short = (id: string) => {
  const [file, sym] = id.split('#');
  const base = file.split('/').slice(-1)[0];
  return sym ? `${base}#${sym}` : base;
};
