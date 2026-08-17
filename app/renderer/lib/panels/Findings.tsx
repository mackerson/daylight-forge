import { useState } from 'react';
import type { LoadPayload, QueryPayload } from '../types.ts';

/**
 * Duplication families first, then the raw detector output. Families exist so a human
 * (or an agent) adjudicates once per family rather than once per pair.
 */
export function Findings({ data, query }: { data: LoadPayload; query: QueryPayload | null; onRefresh: () => void }) {
  const [view, setView] = useState<'families' | 'pairs' | 'patterns' | 'structure'>('families');
  const f = data.findings;
  const st = data.structure;

  // Verdicts on structural findings, so an adjudicated candidate stops looking unexamined.
  const structureVerdicts = new Map(
    (query?.beliefs ?? [])
      .filter((b) => /_verdict$/.test(b.predicate) && !b.predicate.startsWith('duplication'))
      .map((b) => [b.subject, b] as const),
  );

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
        <button className={view === 'structure' ? 'chip active' : 'chip'} onClick={() => setView('structure')}>
          Structure ({st ? st.dead.length + st.cycles.length + st.limbs.length + st.gods.length : 0})
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

      {view === 'structure' && st && (
        <>
          {st.warning && <p className="hint">{st.warning}</p>}
          <section className="card">
            <h3>Reachability</h3>
            <p className="dim">
              {st.stats.reachable} of {st.stats.files} files reachable from{' '}
              {st.entrypoints.length} entrypoint(s).
            </p>
          </section>

          <section className="card">
            <h3>Dead candidates <span className="dim">{st.dead.length}</span></h3>
            <p className="dim">
              Candidates, not verdicts — static reachability misses dynamic dispatch, DI,
              registries and framework conventions. The tier says how much to trust it.
            </p>
            <ul className="rows">
              {st.dead.filter((d) => d.tier !== 'low').slice(0, 40).map((d) => {
                const v = structureVerdicts.get(d.id);
                return (
                  <li key={d.id}>
                    <span className={`pill ${d.tier === 'high' ? 'bad' : 'running'}`}>{d.tier}</span>{' '}
                    <button className="link mono" onClick={() => window.vds.reveal({ file: d.id.split('#')[0] })}>
                      {d.id}
                    </button>
                    {v && <span className={`pill ${v.status.toLowerCase()}`}>{v.status}</span>}
                    <div className="dim">{d.why}</div>
                  </li>
                );
              })}
            </ul>
          </section>

          {st.cycles.length > 0 && (
            <section className="card">
              <h3>Cycles <span className="dim">{st.cycles.length}</span></h3>
              <ul className="rows mono">
                {st.cycles.map((c, i) => (
                  <li key={i}>{c.members.length} files · {c.internalEdges} internal edges — {c.members.slice(0, 3).join(' → ')}…</li>
                ))}
              </ul>
            </section>
          )}

          {st.limbs.length > 0 && (
            <section className="card">
              <h3>Weird limbs <span className="dim">{st.limbs.length}</span></h3>
              <p className="dim">Subtrees whose edges mostly leave them — folders rather than modules.</p>
              <ul className="rows">
                {st.limbs.map((l) => (
                  <li key={l.dir}>
                    <code>{l.dir}</code> — {(l.leakage * 100).toFixed(0)}% of edges leave ({l.files} files)
                  </li>
                ))}
              </ul>
            </section>
          )}

          {st.gods.length > 0 && (
            <section className="card">
              <h3>Most depended upon <span className="dim">{st.gods.length}</span></h3>
              <ul className="rows">
                {st.gods.slice(0, 12).map((g) => (
                  <li key={g.id}><code>{g.id}</code> <span className="dim">fan-in {g.fanIn} · fan-out {g.fanOut}</span></li>
                ))}
              </ul>
            </section>
          )}
        </>
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
