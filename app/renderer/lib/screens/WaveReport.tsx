import { useEffect, useState } from 'react';
import type { CampaignStatusReport, Need, ReportWave, WaveReport } from '../types.ts';
import {
  BUCKET_WORDS, blockedActWord, diffWords, FORGERY_WORDS, scopeWord, severityWord, spendBar, spendWords, STATUS_BUCKETS,
} from './campaign-words.ts';
import { NEED_WORDS, shortRef, type NeedTarget } from './forge-words.ts';
import { SpendBarView } from './CampaignParts.tsx';
import { Choice, KEEP_CASE, toneClass, type ForgeApi } from './ForgeParts.tsx';

/**
 * The wave report: what one wave did, the landings since the last one, or the whole campaign,
 * as `campaign report --format json` derives it. Section by section as the markdown report,
 * plus the finding statements, which the markdown never carries (P2-R40): each is shown as
 * text in a `<pre>` labelled reviewer-claimed and redacted. Holdouts are counts.
 */
export function WaveReportView({ api, id, status, onOpen, onNeed }: {
  api: ForgeApi;
  id: string;
  status: CampaignStatusReport;
  onOpen: (t: NeedTarget) => void;
  onNeed: (n: Need) => void;
}) {
  const latest = status.waves.length ? status.waves[status.waves.length - 1].seq : 'open';
  const [wave, setWave] = useState<ReportWave>(latest);
  const [r, setR] = useState<WaveReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setR(null);
    void api.report({ id, wave }).then((x) => {
      if (!live) return;
      if (x.error) { setError(x.error); return; }
      setError(null);
      setR(x);
    });
    return () => { live = false; };
  }, [api, id, wave]);

  const options = [
    ...status.waves.map((w) => ({ value: String(w.seq), label: `wave ${w.seq}` })),
    { value: 'open', label: 'open' }, { value: 'all', label: 'whole campaign' },
  ];
  return (
    <div className="stack" data-forge="wave-report">
      <div className="toolbar wrap">
        <Choice options={options} value={String(wave)} onChange={(v) => setWave(v === 'open' || v === 'all' ? v : Number(v))} />
      </div>
      {error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}
      {!r && !error && <p className="dim">reading the report…</p>}
      {r && <Report r={r} onOpen={onOpen} onNeed={onNeed} />}
    </div>
  );
}

function Report({ r, onOpen, onNeed }: { r: WaveReport; onOpen: (t: NeedTarget) => void; onNeed: (n: Need) => void }) {
  const cap = r.spend.campaign.capUsd;
  return (
    <>
      <div className="card">
        <h3>{scopeWord(r.scope)}</h3>
        <div className="num" style={{ overflowWrap: 'anywhere' }}>
          {r.range.from.slice(0, 12)}..{r.range.to.slice(0, 12)} · {r.integration.ref} @ {r.integration.tip.slice(0, 12)} · {diffWords(r.diff)}
        </div>
        <code style={{ overflowWrap: 'anywhere', fontSize: 11 }}>{r.integration.mergeHint}</code>
      </div>

      <div className="card">
        <h3>landed · {r.landed.length}</h3>
        <table className="grid">
          <thead><tr><th>ticket</th><th>lane</th><th>commit</th><th>diff</th><th>acceptance</th><th>attempts</th></tr></thead>
          <tbody>
            {r.landed.map((l) => (
              <tr key={l.ticketId} data-forge="report-landing">
                <td><strong>{l.ticketId}</strong> {l.title}{l.origin !== 'plan' ? ` (${l.origin})` : ''}</td>
                <td>{l.lane}</td>
                <td className="mono">{l.commit.slice(0, 12)}{l.method === 'three-way' ? ' · 3-way' : ''}</td>
                <td className="mono">{diffWords(l.diff)}</td>
                <td>{l.acceptance}{l.acceptanceVacuous ? <span className="pill warn" style={{ marginLeft: 4 }}>vacuous</span> : null}</td>
                <td className="mono">{l.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>assumptions waiting on you · {r.assumptions.open.length + r.assumptions.pending.length}</h3>
        <ul className="rows" style={{ fontSize: 12 }}>
          {[...r.assumptions.open, ...r.assumptions.pending].map((a) => (
            <li key={a.id} style={{ overflowWrap: 'anywhere' }}>
              <span className={`pill ${a.status === 'open' ? 'bad' : 'warn'}`}>{a.status}{a.blocking ? ' · blocking' : ''}</span>{' '}
              {a.question} {a.default ? `— default: ${a.default}` : ''}
              {a.heldTickets.length ? ` · holds ${a.heldTickets.join(', ')}` : ''}
              {a.landedOnIt.length ? ` · landed on it, not reverted by an overturn: ${a.landedOnIt.join(', ')}` : ''}
            </li>
          ))}
        </ul>
        <div className="num">{r.assumptions.confirmed} confirmed · {r.assumptions.overturned} overturned</div>
      </div>

      <div className="card">
        <h3>review</h3>
        {r.review.map((v) => (
          <div key={v.seq} className="num">
            wave {v.seq} · {v.state} · {v.reviewers} reviewer(s) · high {v.findings.high} · medium {v.findings.medium} · low {v.findings.low}
            {v.reviewMissionId ? <> · <button className="link" onClick={() => onOpen({ screen: 'missions', missionId: v.reviewMissionId! })}>review mission</button></> : null}
          </div>
        ))}
        {r.findings.map((f) => {
          const w = severityWord(f.severity);
          return (
            <div key={f.id} className="card quiet" style={{ marginTop: 6 }} data-forge="report-finding">
              <div className="toolbar wrap">
                <span className={`pill ${toneClass(w.tone)}`}>{w.name}</span>
                <span className="mono" style={{ overflowWrap: 'anywhere' }}>{f.path}</span>
                <span>{f.title}</span>
                <span className="num">(reviewer-claimed) · wave {f.waveSeq}{f.corroboratedBy.length ? ` · corroborated by ${f.corroboratedBy.length}` : ''}</span>
                <span className="num">fix {f.fixTicketId ?? 'none'} · {f.fixStatus} · admitted {f.fixAdmission}</span>
              </div>
              <div className="num" style={{ marginTop: 4 }}>statement · reviewer-claimed, redacted</div>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11, margin: 0 }}>{f.statement}</pre>
            </div>
          );
        })}
        <div className="num" style={{ marginTop: 6 }}>
          fix lane: {r.fixLane.filed} filed · {r.fixLane.admittedDerived} admitted by the director · {r.fixLane.approvedByPerson} approved by a person ·{' '}
          {r.fixLane.landed} landed · {r.fixLane.waiting} waiting · {r.fixLane.rejected} rejected
        </div>
      </div>

      <div className="card" data-forge="report-spend">
        <h3>spend</h3>
        <SpendBarView bar={spendBar(r.spend.scope, cap)} label="this scope" />
        {r.spend.lanes.map((l) => <SpendBarView key={l.key} bar={spendBar(l, cap)} label={`lane ${l.key}`} />)}
        <table className="grid" style={{ marginTop: 6 }}>
          <thead><tr><th>line</th><th>attempts</th><th>spend</th></tr></thead>
          <tbody>
            {[...r.spend.waves, ...r.spend.reviews, ...r.spend.tickets].map((l) => (
              <tr key={l.key}><td className="mono">{l.key}</td><td className="mono">{l.attempts}</td><td className="mono">{spendWords(l)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {!!r.needs.length && (
        <div className="card">
          <h3>needs · {r.needs.length}</h3>
          <ul className="rows" style={{ fontSize: 12 }}>
            {r.needs.map((n) => (
              <li key={`${n.kind}:${n.ref}`} style={{ overflowWrap: 'anywhere' }}>
                <button className="chip" onClick={() => onNeed(n)} style={KEEP_CASE}>{NEED_WORDS[n.kind] ?? n.kind}</button> {n.why}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!!r.blocked.length && (
        <div className="card">
          <h3>blocked · {r.blocked.length}</h3>
          <ul className="rows" style={{ fontSize: 12 }}>
            {r.blocked.map((b) => (
              <li key={b.ticketId} style={{ overflowWrap: 'anywhere' }}>
                <strong>{b.ticketId}</strong> · {b.status} · {b.reason} · <span className="num" title={blockedActWord(b.act).hint}>{blockedActWord(b.act).name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card" data-forge="report-holdouts">
        <h3>holdouts · counts only</h3>
        <div className="num">
          {r.holdouts.locked} locked · at the tip: {Object.entries(r.holdouts.atTip).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'none run'}
        </div>
      </div>

      <div className="card" data-forge="report-forgery">
        <h3>forgery-shaped candidates · a heuristic, not a finding of fact</h3>
        <div className="num">
          {r.forgeryShapes.candidates} candidate(s) ·{' '}
          {Object.entries(r.forgeryShapes.byClass).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${FORGERY_WORDS[k as keyof typeof FORGERY_WORDS] ?? k}`).join(', ') || 'none'}
        </div>
        <ul className="rows num" style={{ overflowWrap: 'anywhere' }}>
          {r.forgeryShapes.items.map((i) => (
            <li key={i.candidateId}>
              {i.ticketId} · <button className="link" onClick={() => onOpen({ screen: 'missions', missionId: i.missionId, tab: 'candidate', candidateId: i.candidateId })}>{shortRef(i.candidateId)}</button>
              {' '}· {i.classes.map((c) => FORGERY_WORDS[c] ?? c).join(', ')} · {i.paths.join(', ')}{i.ticketLanded ? ' · the ticket landed' : ''}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>status</h3>
        <table className="grid">
          <thead><tr><th>lane</th>{STATUS_BUCKETS.map((b) => <th key={b}>{BUCKET_WORDS[b]}</th>)}</tr></thead>
          <tbody>{r.status.rows.map((row) => <tr key={row.lane}><td>{row.lane}</td>{STATUS_BUCKETS.map((b) => <td key={b} className="mono">{row.byBucket[b]}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </>
  );
}
