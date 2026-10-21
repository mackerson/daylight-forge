import { useCallback, useEffect, useState } from 'react';
import type { ForgeCampaignList } from '../types.ts';
import { campaignSpendBar, campaignSpendWords, dateWord, haltWord, runWord } from './campaign-words.ts';
import { shortRef } from './forge-words.ts';
import { BucketBar } from './CampaignParts.tsx';
import { KEEP_CASE, toneClass, type ForgeApi } from './ForgeParts.tsx';

/**
 * Every campaign in the output directory, as `campaign list` derives them on read.
 *
 * A run shows from its claim file: a live pid is a run, a dead one a claim left behind, said
 * as such. Nothing here starts a run; that is a terminal's (P2-R9).
 */
export function Campaigns({ api, sample, onOpen }: { api: ForgeApi; sample: boolean; onOpen: (id: string) => void }) {
  const [data, setData] = useState<ForgeCampaignList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.campaigns();
    if (r.error) setError(r.error);
    else {
      setError(null);
      setData(r);
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const rows = data?.campaigns ?? [];
  return (
    <div className="screen mission" data-forge="campaigns">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>Campaigns{sample ? ' — sample data' : ''}</h2>
            <p className="sub">
              A plan of tickets run by the director inside an envelope a person authorized. Status, spend and
              needs are derived on every read. A run is started from a terminal, never from here.
            </p>
          </div>
          <div className="spacer" />
          <button className="btn" onClick={() => void load()}>refresh</button>
        </div>
      </div>
      <div className="screen-body">
        {error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}
        {sample && <p className="num">sample · nothing on this screen came from a model, and nothing here can be recorded</p>}
        {!rows.length && !error && data && (
          <p className="dim">No campaigns. A plan is imported from a terminal with <code>daylight campaign import</code>.</p>
        )}
        {rows.map((c) => {
          const run = runWord(c.run);
          const halt = haltWord(c.halted);
          const bar = campaignSpendBar(c.spend);
          return (
            <div key={c.id} className="card" data-forge="campaign-row">
              <div className="toolbar wrap">
                <button className="link" style={{ fontWeight: 600 }} onClick={() => onOpen(c.id)}>{c.title ?? '(untitled plan)'}</button>
                <code>{shortRef(c.id)}</code>
                <span className="pill">{c.state}</span>
                {run && <span className={`pill ${toneClass(run.tone)}`} style={KEEP_CASE} data-forge="run-badge">{run.name}</span>}
                {halt && <span className="pill bad" style={KEEP_CASE}>{halt.name}</span>}
                {!c.planApproved && <span className="pill warn">plan not approved</span>}
                <div className="spacer" />
                <span className={`pill ${c.needs ? 'warn' : ''}`}>{c.needs} need{c.needs === 1 ? '' : 's'} you</span>
              </div>
              {c.unavailable && <p className="hint" style={{ fontSize: 11 }}>{c.unavailable}</p>}
              <div style={{ marginTop: 6 }}><BucketBar counts={c.byBucket} /></div>
              <div className="num" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
                {c.tickets} ticket{c.tickets === 1 ? '' : 's'} · spend {campaignSpendWords(c.spend)} {bar.cap}
                {bar.open ? ' · open: some spend is unknown' : ''}
                {' · '}{c.integrationRef}{c.tip ? ` @ ${c.tip.slice(0, 12)}` : ''}
                {c.assumptions.open + c.assumptions.pending ? ` · ${c.assumptions.open} open, ${c.assumptions.pending} pending assumption(s)` : ''}
                {c.authorization.notAfter ? ` · authorized until ${dateWord(c.authorization.notAfter)}` : ''}
              </div>
              {c.authorization.refusal && (
                <p className="prose" style={{ fontSize: 12, margin: '6px 0 0', overflowWrap: 'anywhere' }} data-forge="authorization-refusal">{c.authorization.refusal}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
