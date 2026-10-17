import { useCallback, useEffect, useState } from 'react';
import type { LedgerJson, LedgerJsonRow } from '../types.ts';
import {
  costSourceOf, isIngestedRow, ledgerTokens, ledgerUsd, OUTSIDE, shortRef,
} from './forge-words.ts';
import { Choice, type ForgeApi, type LedgerGroup } from './ForgeParts.tsx';

/**
 * The project ledger: who spent what, who decided what, what shipped.
 *
 * Money is a floor. A cost nobody reported is counted as unknown and printed as the word
 * `unknown`, never `0`; a figure read out of stdout is shown beside the floor and never added to
 * it (R10.2). People appear with decisions, not dollars. Ingested work is recorded here and
 * labelled as outside Daylight's controls (R12.1).
 */
export function Ledger({ api, sample }: { api: ForgeApi; sample: boolean }) {
  const [group, setGroup] = useState<LedgerGroup>('runner');
  const [since, setSince] = useState<'all' | '7d' | '24h'>('all');
  const [doc, setDoc] = useState<LedgerJson | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const ms = since === '7d' ? 7 * 86_400_000 : since === '24h' ? 86_400_000 : 0;
    const r = await api.ledger({ group, since: ms ? new Date(Date.now() - ms).toISOString() : undefined });
    if (r.error) setError(r.error);
    else { setError(null); setDoc(r); }
  }, [api, group, since]);
  useEffect(() => { void load(); }, [load]);

  const rows = doc?.rows ?? [];
  // A known sum stays null until some row has a provider figure: no row's null becomes a zero.
  const total = rows.reduce<Pick<LedgerJsonRow, 'attempts' | 'usdKnown' | 'usdUnknownCount' | 'usdScanned'>>(
    (t, r) => ({
      attempts: t.attempts + r.attempts,
      usdKnown: r.usdKnown === null ? t.usdKnown : (t.usdKnown ?? 0) + r.usdKnown,
      usdUnknownCount: t.usdUnknownCount + r.usdUnknownCount, usdScanned: t.usdScanned + r.usdScanned,
    }),
    { attempts: 0, usdKnown: null, usdUnknownCount: 0, usdScanned: 0 },
  );
  const ingestedRows = rows.filter(isIngestedRow).length;

  return (
    <div className="screen mission" data-forge="ledger">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>Ledger{sample ? ' — sample data' : ''}</h2>
            <p className="sub">
              Spend, tokens, candidates and decisions for this project{doc ? ` (${doc.projectId})` : ''}.
              Unknown is counted, never summed as zero; scanned spend is a guess and is shown beside the floor.
            </p>
          </div>
          <div className="spacer" />
          <button className="btn" onClick={() => void load()}>refresh</button>
        </div>
        <div className="toolbar wrap" style={{ marginTop: 10 }}>
          <span className="num">group by</span>
          <Choice
            options={[
              { value: 'runner', label: 'runner' }, { value: 'model', label: 'model' },
              { value: 'origin', label: 'origin' }, { value: 'mission', label: 'mission' },
              { value: 'work-item', label: 'work item' }, { value: 'actor', label: 'actor' },
            ]}
            value={group}
            onChange={setGroup}
          />
          <span className="num">since</span>
          <Choice options={[{ value: 'all', label: 'all time' }, { value: '7d', label: '7 days' }, { value: '24h', label: '24 hours' }]} value={since} onChange={setSince} />
        </div>
      </div>
      <div className="screen-body">
        {error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}
        <div className="card">
          <div className="toolbar wrap">
            <span className="num">total</span>
            <strong className="money" data-forge="ledger-total">{ledgerUsd(total)}</strong>
            <span className="num">{total.attempts} attempts</span>
            {ingestedRows > 0 && <span className="pill warn">{ingestedRows} row{ingestedRows === 1 ? '' : 's'} include work {OUTSIDE}</span>}
          </div>
        </div>
        <div className="card">
          <h3>by {group} · {rows.length}</h3>
          {!rows.length && <p className="dim">{sample ? 'The sample has no rows grouped this way.' : 'Nothing recorded yet.'}</p>}
          {!!rows.length && (
            <table className="grid" data-forge="ledger-rows">
              <thead>
                <tr><th>{group}</th><th>attempts</th><th>cost</th><th>cost source (inferred)</th><th>tokens in</th><th>tokens out</th><th>candidates</th><th>decisions</th><th>gate sets</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td style={{ color: 'var(--text)', overflowWrap: 'anywhere' }}>
                      {r.key}
                      {isIngestedRow(r) && <span className="pill warn" style={{ marginLeft: 6 }}>{OUTSIDE}</span>}
                    </td>
                    <td className="mono">{r.attempts}</td>
                    <td className="mono">{r.attempts ? ledgerUsd(r) : r.decisions ? 'decisions only' : '—'}</td>
                    <td className="mono">{r.attempts ? costSourceOf(r) : '—'}</td>
                    <td className="mono">{r.attempts ? ledgerTokens(r.tokens.input, r.tokensUnknownByField.input) : '—'}</td>
                    <td className="mono">{r.attempts ? ledgerTokens(r.tokens.output, r.tokensUnknownByField.output) : '—'}</td>
                    <td className="mono">
                      {r.candidates.accepted} acc · {r.candidates.rejected} rej · {r.candidates.applied} applied
                      {r.candidates.overridden ? ` · ${r.candidates.overridden} overridden` : ''}
                    </td>
                    <td className="mono">{r.decisions}</td>
                    <td className="mono">{r.gateSetDigests.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="dim" style={{ fontSize: 11, margin: '8px 0 0' }}>
            Cost source per row, inferred from the row's totals (it carries no per-source counts):
            provider (reported by the provider, known), stdout-scan (read out of output by pattern,
            not known), none (nothing reported). A row marked {OUTSIDE} holds attempts recovered
            from transcripts, under any grouping; Daylight granted them nothing and verified none of it.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }}>
          <div className="card">
            <h3>decisions · {doc?.decisions.reduce((n, d) => n + d.count, 0) ?? 0}</h3>
            <table className="grid">
              <thead><tr><th>actor</th><th>operation</th><th>kind</th><th>count</th></tr></thead>
              <tbody>
                {(doc?.decisions ?? []).map((d) => (
                  <tr key={`${d.actor}:${d.operation}:${d.kind}`}>
                    <td>{d.actor}</td><td className="mono">{d.operation ?? 'adjudication'}</td><td>{d.kind}</td><td className="mono">{d.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>work items · applications</h3>
            <ul className="rows" style={{ fontSize: 12 }}>
              {(doc?.workItems ?? []).map((w) => <li key={w.id}><span className="pill">{w.status}</span> {w.title} <span className="num">{shortRef(w.id)}</span></li>)}
            </ul>
            <p className="num">
              {doc?.applications.length
                ? doc.applications.map((a) => `${a.commit.slice(0, 12)} on ${a.ref} by ${a.appliedBy}`).join(' · ')
                : 'no candidate applied yet'}
            </p>
            <p className="num">
              {(doc?.revisions ?? []).map((r) => `rev ${r.revision.slice(0, 12)}: ${r.missions} missions, ${r.attempts} attempts`).join(' · ')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
