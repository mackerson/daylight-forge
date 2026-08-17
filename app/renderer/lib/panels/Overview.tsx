import type { LoadPayload, QueryPayload } from '../types.ts';

/** The map's current shape, and — bluntly — how much of it is actually focused. */
export function Overview({ data, query }: { data: LoadPayload; query: QueryPayload | null }) {
  const stack = data.stack;
  if (!stack) {
    return <div className="empty"><h2>Not mapped yet</h2><p>Run <strong>Map</strong>.</p></div>;
  }

  const [l1, l2, l3] = stack.levels;
  const named = l2.nodes.filter((n) => n.purpose).length;
  const s = query?.stats;

  return (
    <div className="stack">
      <section className="card">
        <h3>Focus stack</h3>
        <table className="grid">
          <tbody>
            <tr>
              <td>L0 exhaustive</td>
              <td>{stack.l0.files} files</td>
              <td>{stack.l0.symbols} symbols</td>
              <td>{stack.l0.edges} edges</td>
            </tr>
            {stack.levels.map((l) => (
              <tr key={l.level}>
                <td>L{l.level} {l.name}</td>
                <td>{l.nodes.length} nodes</td>
                <td>{l.edges.length} edges</td>
                <td>{l.elided.length ? `${l.elided.length} elisions` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={stack.l3Status === 'TRUE' ? 'ok' : stack.l3Status === 'STALE' ? 'bad' : 'dim'}>
          L3 status: {stack.l3Status}
          {stack.l3Status === 'UNPROVEN' && ' — no invariants defined for this repo'}
        </p>
      </section>

      <section className="card">
        <h3>Focus coverage</h3>
        <Meter value={named} total={l2.nodes.length} />
        <p className="dim">
          {named} of {l2.nodes.length} L2 nodes carry an agent-written purpose. The rest are path
          groups: how the code is filed, not what it is for.
        </p>
        {named === 0 && <p className="hint">Run <strong>Focus</strong> to start clustering.</p>}
        {(l3.rejected?.length ?? 0) > 0 && (
          <>
            <h4>Rejected elisions</h4>
            <ul className="rows">
              {l3.rejected!.map((r) => (
                <li key={r.id}><code>{r.into}</code> — {r.why}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      {s && (
        <section className="card">
          <h3>Claim store</h3>
          <table className="grid">
            <tbody>
              <tr><td>claims</td><td>{s.claims}</td><td>subjects</td><td>{s.subjects}</td></tr>
              <tr><td>clusters</td><td>{s.clusters}</td><td>elisions</td><td>{s.elisions}</td></tr>
              <tr><td>defences</td><td>{s.defences}</td><td /><td /></tr>
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Meter({ value, total }: { value: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div className="meter" role="img" aria-label={`${pct}% focused`}>
      <div className="meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
