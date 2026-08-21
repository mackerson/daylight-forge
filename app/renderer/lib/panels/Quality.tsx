import { useCallback, useEffect, useState } from 'react';
import type { ClaimStatus, QualityReport, QualityWarning, SourceUse } from '../types.ts';

/**
 * How much of this map can be believed, and why not more.
 *
 * The signals were all present and each lived on a different screen: a claim count here, a
 * contradiction badge there, focus coverage on a third, invariants on a fourth. Assembled by
 * a reader they compose into optimism, because every one of them goes up when work happens
 * and none of them goes up only when the work was any good. A claim count cannot distinguish
 * fifty things one agent asserted from fifty things two agents checked.
 *
 * So this leads with what is wrong. The numbers are underneath, and they are arranged around
 * the one distinction that matters: how many independent sources stand behind a belief.
 */

/** Ordered worst-first, which is also how confident you may be at each step. */
const STATUS_ORDER: ClaimStatus[] = [
  'CONTRADICTED', 'STALE', 'INFERRED', 'CORROBORATED', 'CONFIRMED',
];

const STATUS_MEANS: Record<string, string> = {
  CONFIRMED: 'a person decided this',
  CORROBORATED: 'two or more independent sources agreed',
  INFERRED: 'one source said so, and nothing has checked it',
  CONTRADICTED: 'sources read the same subject and disagreed',
  STALE: 'the file changed after the claim was made',
  UNKNOWN: 'never examined',
};

export function Quality({ active }: { active: boolean }) {
  const [report, setReport] = useState<QualityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const r = await window.vds.quality();
    if (r.error) setError(r.error);
    else {
      setReport(r);
      setError(null);
    }
    setBusy(false);
  }, []);

  // Recomputing re-reads the graph and rebuilds the frontier, so it happens when this panel
  // is looked at rather than on every refresh the rest of the app does.
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  if (error) {
    return (
      <div className="stack">
        <section className="card bad-border">
          <h3>Could not read the map</h3>
          <p className="dim">{error}</p>
          <div className="actions"><button onClick={load}>Retry</button></div>
        </section>
      </div>
    );
  }
  if (!report) return <div className="empty"><h2>{busy ? 'Measuring…' : 'Not measured'}</h2></div>;

  const { beliefs, sources, frontier, focus, invariants, detectors } = report;
  const checked = beliefs.total ? beliefs.multiSource / beliefs.total : 0;

  return (
    <div className="stack">
      <section className="card">
        <h3>
          What is wrong with this map
          <span className="pill">{report.warnings.length}</span>
          <button className="link" disabled={busy} onClick={load}>
            {busy ? 'measuring…' : 'remeasure'}
          </button>
        </h3>
        {!report.warnings.length && (
          <p className="ok">Nothing outstanding. Every signal below is where it should be.</p>
        )}
        {report.warnings.map((w) => (
          <Warning key={w.id} warning={w} />
        ))}
      </section>

      <section className="card">
        <h3>How much has been checked</h3>
        {/* The headline number. Not "how many claims" — how many of them anything ever
            checked, which is a different and much smaller number. */}
        <Meter value={beliefs.multiSource} total={beliefs.total} />
        <p className="dim">
          <strong>{beliefs.multiSource}</strong> of {beliefs.total} beliefs have been looked at
          by more than one independent source ({Math.round(checked * 100)}%). The other{' '}
          {beliefs.singleSource} rest on one, which is not the same as being wrong — it is not
          having been checked.
        </p>
        <p className="dim">
          Checked twice is not the same as agreed twice: {beliefs.byStatus.CORROBORATED ?? 0}{' '}
          of those {beliefs.multiSource} agreed, and{' '}
          {beliefs.byStatus.CONTRADICTED ?? 0} did not.
        </p>
        <table className="grid">
          <tbody>
            {STATUS_ORDER.filter((s) => beliefs.byStatus[s]).map((s) => (
              <tr key={s}>
                <td><span className={`pill ${s.toLowerCase()}`}>{s}</span></td>
                <td>{beliefs.byStatus[s]}</td>
                <td className="dim">{STATUS_MEANS[s]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>
          Who has looked
          <span className={sources.diversity < 2 ? 'pill bad' : 'pill ok'}>
            {sources.diversity} source{sources.diversity === 1 ? '' : 's'}
          </span>
        </h3>
        <p className="dim">
          Independence is counted per tool <em>and</em> model, because that is the unit that
          can disagree with itself. Two runs of one model are one source however far apart.
        </p>
        <table className="grid">
          <tbody>
            {sources.used.map((s) => (
              <SourceRow key={s.key} source={s} />
            ))}
          </tbody>
        </table>
        {!sources.humanReviewed && (
          <p className="dim">No human has confirmed anything here yet.</p>
        )}
      </section>

      <section className="card">
        <h3>
          What is left to ask
          {frontier.converged && <span className="pill ok">converged</span>}
        </h3>
        <p className="dim">
          {frontier.open} open question{frontier.open === 1 ? '' : 's'}, top score{' '}
          {frontier.topScore.toFixed(3)}.{' '}
          {frontier.converged
            ? 'Nothing left scores above the floor — another run would be paying to answer questions nobody needs answered.'
            : 'The queue drains when the top score falls below the floor, not at a fixed count.'}
        </p>
        <ul className="rows">
          {Object.entries(frontier.byKind)
            .sort((a, b) => b[1] - a[1])
            .map(([kind, n]) => (
              <li key={kind}>
                <code>{kind}</code> <span className="dim">{n}</span>
              </li>
            ))}
        </ul>
      </section>

      <section className="card">
        <h3>The rest of the signals</h3>
        <table className="grid">
          <tbody>
            <tr>
              <td>focus</td>
              <td>{focus.named}/{focus.l2Nodes} L2 named</td>
              <td className="dim">
                the unnamed ones are path groups — filing, not intent
              </td>
            </tr>
            <tr>
              <td>elisions</td>
              <td>{focus.elisions} kept{focus.rejected ? `, ${focus.rejected} rejected` : ''}</td>
              <td className="dim">a collapse a defended node refused is a rejection worth having</td>
            </tr>
            <tr>
              <td>L3</td>
              <td className={focus.l3Status === 'TRUE' ? 'ok' : focus.l3Status === 'STALE' ? 'bad' : ''}>
                {focus.l3Status}
              </td>
              <td className="dim">
                {focus.l3Status === 'UNPROVEN'
                  ? 'no invariants declared, so nothing constrains the architecture level'
                  : 'checked against this repo’s own invariants'}
              </td>
            </tr>
            <tr>
              <td>invariants</td>
              <td className={invariants.red ? 'bad' : 'ok'}>
                {invariants.green}/{invariants.total} green
              </td>
              <td className="dim">the build gate</td>
            </tr>
            <tr>
              <td>duplication</td>
              <td>
                {detectors.adjudicatedFamilies}/{detectors.families} adjudicated
              </td>
              <td className="dim">found deterministically; a verdict needs an agent or a person</td>
            </tr>
            <tr>
              <td>structure</td>
              <td>
                {detectors.dead} dead · {detectors.cycles} cycles · {detectors.gods} gods ·{' '}
                {detectors.limbs} limbs
              </td>
              <td className="dim">candidates, not verdicts</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Warning({ warning }: { warning: QualityWarning }) {
  const tone =
    warning.severity === 'blocking' ? 'bad' : warning.severity === 'weak' ? 'hint' : 'dim';
  return (
    <div className="weakness">
      <span className={`pill ${warning.severity === 'blocking' ? 'bad' : ''}`}>
        {warning.severity}
      </span>
      <div>
        <p className={tone}>{warning.message}</p>
        {warning.fix && <p className="dim">→ {warning.fix}</p>}
      </div>
    </div>
  );
}

function SourceRow({ source }: { source: SourceUse }) {
  const human = source.kind === 'human';
  return (
    <tr>
      <td>
        <span className={human ? 'pill confirmed' : 'pill'}>
          {human ? 'human' : source.tool ?? '?'}
        </span>
      </td>
      <td className="dim">{human ? '' : source.model ?? 'default'}</td>
      <td>{source.claims} claim{source.claims === 1 ? '' : 's'}</td>
      {/* The provenance bug, still legible in any store written before it was fixed: every
          agent recorded itself as the same "multi" source, so none of them could corroborate
          another. Named here rather than quietly counted, because those claims are still in
          the store and still cannot be told apart. */}
      {source.tool === 'multi' && (
        <td className="hint">recorded before per-agent provenance — not attributable</td>
      )}
    </tr>
  );
}

function Meter({ value, total }: { value: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div className="meter" role="img" aria-label={`${pct}% corroborated`}>
      <div className="meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
