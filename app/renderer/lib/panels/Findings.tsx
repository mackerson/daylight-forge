import { useState } from 'react';
import type { Belief, LoadPayload, QueryPayload } from '../types.ts';

/**
 * Duplication families first, then the raw detector output. Families exist so a human
 * (or an agent) adjudicates once per family rather than once per pair.
 */
export function Findings({ data, query, onArbitrate }: {
  data: LoadPayload;
  query: QueryPayload | null;
  onRefresh: () => void;
  /**
   * Findings is where a disagreement is *seen*; until this existed you had to go find the
   * same subject again in Review to act on it. Adjudication now starts where the evidence is.
   */
  onArbitrate: (b: Belief) => void;
}) {
  const [view, setView] = useState<'families' | 'pairs' | 'bodies' | 'patterns' | 'structure'>(
    'families',
  );
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
        <button className={view === 'bodies' ? 'chip active' : 'chip'} onClick={() => setView('bodies')}>
          D4 bodies ({f.d4?.length ?? 0})
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
                  {belief && (
                    <button
                      className={`pill ${belief.status.toLowerCase()} as-button`}
                      onClick={() => onArbitrate(belief)}
                      title="Open arbitration"
                    >
                      {belief.status}
                    </button>
                  )}
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

      {view === 'bodies' && (
        <section className="card">
          <p className="dim">
            Bodies that do the same work, compared with identifiers and literals erased — so a
            copy survives being renamed. This is the only detector that read the code rather
            than its label, which is why a D4 link alone is enough to form a family.
          </p>
          {!f.d4?.length && <p className="dim">No duplicated bodies.</p>}
          {!!f.d4?.length && (
            <table className="grid">
              <thead>
                <tr><th>score</th><th>tokens</th><th>a</th><th>b</th><th /></tr>
              </thead>
              <tbody>
                {f.d4.map((p, i) => (
                  <tr key={i}>
                    <td>{p.score.toFixed(2)}</td>
                    <td className="dim">{p.tokens}</td>
                    <td className="mono">
                      <button className="link mono" onClick={() => window.vds.reveal({ file: p.a.split('#')[0] })}>
                        {short(p.a)}
                      </button>
                    </td>
                    <td className="mono">
                      <button className="link mono" onClick={() => window.vds.reveal({ file: p.b.split('#')[0] })}>
                        {short(p.b)}
                      </button>
                    </td>
                    <td className="dim">{p.sameName ? 'same name' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
                    {v && (
                      <button
                        className={`pill ${v.status.toLowerCase()} as-button`}
                        onClick={() => onArbitrate(v)}
                        title="Open arbitration"
                      >
                        {v.status}
                      </button>
                    )}
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

          {st.divergences.length > 0 && (
            <section className="card">
              <h3>Filed apart from what they use <span className="dim">{st.divergences.length}</span></h3>
              <p className="dim">
                The gap between how the code is filed and how it is wired, per file.
              </p>
              <ul className="rows">
                {st.divergences.slice(0, 12).map((d) => (
                  <li key={d.file}>
                    <code>{d.file}</code>
                    <div className="dim">
                      in <code>{d.home}</code>, but {(d.share * 100).toFixed(0)}% wired to{' '}
                      <code>{d.pull}</code>
                    </div>
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
                  <li key={g.id}>
                    <code>{g.id}</code>{' '}
                    <span className="dim">
                      fan-in {g.fanIn} · fan-out {g.fanOut}
                      {g.churn !== undefined ? ` · ${g.churn} commits · pain ${g.pain}` : ''}
                    </span>
                  </li>
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
