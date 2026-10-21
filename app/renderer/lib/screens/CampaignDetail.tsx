import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  CampaignRunResult, DaylightEvent, ForgeCampaignPayload, ForgeCampaignRow, GuardedResult, WaveReport,
} from '../types.ts';
import {
  authorizeDefaults, authorizeProblems, BUCKET_WORDS, blockedActWord, campaignSpendBar, CAMPAIGN_TABS, dateWord, envelopeRows,
  haltWord, proposedTickets, RATIONALE_PRESETS_CAMPAIGN, runWord, spendBar, STATUS_BUCKETS, type AuthorizeFields, type CampaignTab,
} from './campaign-words.ts';
import { NEED_WORDS, shortRef, type AnyNeed, type NeedTarget } from './forge-words.ts';
import { CampaignDag } from './CampaignDag.tsx';
import { SpendBarView } from './CampaignParts.tsx';
import { Choice, GuardOutcome, KEEP_CASE, RationalePicker, toneClass, useAct, type ForgeApi } from './ForgeParts.tsx';
import { WaveReportView } from './WaveReport.tsx';
import { Assumptions } from './Assumptions.tsx';
import { Refine } from './Refine.tsx';

/** How often a campaign whose loop is alive is read again. */
const RUN_POLL_MS = 5000;

/**
 * One campaign: its overview, the wave report, the assumptions queue and refine.
 *
 * Everything shown is the engine's, re-read rather than patched; every act goes through main,
 * which asks `daylight confirm` and shows the digest in a native dialog. A run the UI did not
 * start shows from its claim file; while it is alive this re-reads the status every five
 * seconds and follows the campaign's events. The UI never starts `campaign run` (P2-R9).
 */
export function CampaignDetail({ api, sample, id, tab, onTab, onBack, onOpen, onNeed }: {
  api: ForgeApi;
  sample: boolean;
  id: string;
  tab: CampaignTab;
  onTab: (t: CampaignTab) => void;
  onBack: () => void;
  onOpen: (t: NeedTarget) => void;
  /** A need, answered where the needs strip would answer it (a candidate is looked up first). */
  onNeed: (n: AnyNeed) => void;
}) {
  const [data, setData] = useState<ForgeCampaignPayload | null>(null);
  const [row, setRow] = useState<ForgeCampaignRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<DaylightEvent[]>([]);

  const load = useCallback(async () => {
    const [r, list] = await Promise.all([api.campaign(id), api.campaigns()]);
    if (r.error) setError(r.error);
    else {
      setError(null);
      setData({ show: r.show, status: r.status });
    }
    if (!list.error) setRow(list.campaigns.find((c) => c.id === id) ?? null);
  }, [api, id]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const alive = !!data?.status.run?.alive;
  useEffect(() => {
    if (!alive) return;
    const t = setInterval(() => void load(), RUN_POLL_MS);
    void api.watchCampaign(id);
    const off = sample ? () => {} : window.daylight.onDlEvent(({ missionId, events: incoming }) => {
      if (missionId === id) setEvents((prev) => [...prev, ...incoming].slice(-50));
    });
    return () => { clearInterval(t); off(); void api.watchCampaign(null); };
  }, [alive, api, id, load, sample]);

  const title = data?.show.title ?? row?.title ?? shortRef(id);
  return (
    <div className="screen mission" data-forge="campaign-detail">
      <div className="screen-head">
        <div className="row">
          <div>
            <button className="link" onClick={onBack}>← campaigns</button>
            <h2>{title}{sample ? ' — sample data' : ''}</h2>
            <p className="sub"><code>{id}</code></p>
          </div>
          <div className="spacer" />
          <button className="btn" onClick={() => void load()}>refresh</button>
        </div>
        <div className="toolbar wrap" style={{ marginTop: 8 }}>
          <Choice options={CAMPAIGN_TABS} value={tab} onChange={onTab} />
        </div>
      </div>
      <div className="screen-body">
        {error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}
        {sample && <p className="num">sample · nothing on this screen came from a model, and nothing here can be recorded</p>}
        {!data && !error && <p className="dim">reading the campaign…</p>}
        {data && tab === 'overview' && <Overview api={api} sample={sample} data={data} row={row} events={events} onReload={load} onOpen={onOpen} onNeed={onNeed} onTab={onTab} />}
        {data && tab === 'report' && <WaveReportView api={api} id={id} status={data.status} onOpen={onOpen} onNeed={onNeed} />}
        {data && tab === 'assumptions' && <Assumptions api={api} id={id} sample={sample} lanes={data.show.lanes.map((l) => l.id)} />}
        {data && tab === 'refine' && <Refine api={api} id={id} sample={sample} />}
      </div>
    </div>
  );
}

function Section({ title, children, forge }: { title: string; children: ReactNode; forge?: string }) {
  return <div className="card" data-forge={forge}><h3>{title}</h3>{children}</div>;
}

function Overview({ api, sample, data, row, events, onReload, onOpen, onNeed, onTab }: {
  api: ForgeApi; sample: boolean; data: ForgeCampaignPayload; row: ForgeCampaignRow | null; events: DaylightEvent[];
  onReload: () => Promise<void>; onOpen: (t: NeedTarget) => void; onNeed: (n: AnyNeed) => void; onTab: (t: CampaignTab) => void;
}) {
  const { show, status } = data;
  const id = show.campaign.id;
  const [report, setReport] = useState<WaveReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [dry, setDry] = useState<CampaignRunResult | null>(null);
  const [dryError, setDryError] = useState<string | null>(null);
  const [retryTicket, setRetryTicket] = useState<string | null>(null);
  useEffect(() => {
    void api.report({ id }).then((r) => {
      if (r.error) setReportError(r.error);
      else { setReportError(null); setReport(r); }
    });
  }, [api, id]);

  const run = runWord(status.run);
  const halt = haltWord(status.authorization.halted);
  /** The halt decision a resume or adopt-tip names, as `campaign status` reports it. */
  const knownHalt = status.authorization.haltDecisionId ?? '';
  const proposed = proposedTickets(show);
  /** The commit adopt-tip leaves the ref at, as the halt need names it (`Need.commit`, WS-R8). */
  const adoptNeed = status.needs.find((n) => n.kind === 'campaign-halted' && !!n.commit);
  const adoptTo = adoptNeed?.commit ?? '';
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); };
  const needs = status.needs as AnyNeed[];

  return (
    <div className="stack">
      <Section title="run" forge="campaign-run">
        <div className="toolbar wrap">
          {run ? <span className={`pill ${toneClass(run.tone)}`} style={KEEP_CASE} data-forge="run-badge">{run.name}</span> : <span className="pill">no run claim</span>}
          {halt && <span className="pill bad" style={KEEP_CASE}>{halt.name}</span>}
          {status.authorization.notAfter && <span className="num">authorized until {dateWord(status.authorization.notAfter)}</span>}
        </div>
        {status.run?.alive && <p className="hint" style={{ fontSize: 11 }}>re-read every 5 s while the loop is alive{events.length ? ` · ${events.length} recent event(s), last ${events[events.length - 1].name}` : ''}</p>}
        {row?.runHint && (
          <div className="toolbar wrap" style={{ marginTop: 6 }}>
            <span className="num">run from a terminal:</span>
            <code style={{ overflowWrap: 'anywhere' }} data-forge="run-hint">{row.runHint}</code>
            <button className="link" onClick={() => copy(row.runHint)}>copy</button>
          </div>
        )}
        <div className="toolbar wrap" style={{ marginTop: 8 }}>
          <button className="btn" onClick={async () => {
            const r = await api.dryRun(id);
            if (r.error) { setDryError(r.error); setDry(null); } else { setDryError(null); setDry(r); }
          }}>dry run</button>
          {!status.authorization.halted && <HaltButton api={api} id={id} sample={sample} onDone={onReload} />}
          <span className="dim" style={{ fontSize: 11 }}>a dry run writes nothing and derives no grant; it shows what would be dispatched now</span>
        </div>
        {dryError && <div className="banner error" style={{ margin: '6px 0 0' }}>{dryError}</div>}
        {dry && (
          <div className="card quiet" style={{ marginTop: 8 }} data-forge="dry-run">
            {dry.refused && <p className="prose" style={{ fontSize: 12, margin: 0, overflowWrap: 'anywhere' }}>{dry.refused}</p>}
            <div className="num">{dry.schedule.length} ticket(s) would be dispatched now · {dry.landed.length} landed · {dry.waves} wave(s)</div>
            {!!dry.schedule.length && (
              <ul className="rows num">{dry.schedule.map((s) => <li key={s.ticketId}>{s.ticketId} · {s.lane} · reserves ${s.reserveUsd.toFixed(2)}</li>)}</ul>
            )}
          </div>
        )}
        {status.authorization.halted && (
          <div className="stack" style={{ marginTop: 10 }}>
            <HaltIdAct api={api} id={id} sample={sample} kind="resume" initial={knownHalt} onDone={onReload} />
            {(status.authorization.halted === 'integration-moved' || !!adoptNeed) && (
              <HaltIdAct api={api} id={id} sample={sample} kind="adopt-tip" initial={knownHalt} to={adoptTo} onDone={onReload} />
            )}
          </div>
        )}
      </Section>

      {!!needs.length && (
        <Section title={`needs you · ${needs.length}`} forge="campaign-needs">
          <ul className="rows">
            {needs.map((n) => (
              <li key={`${n.kind}:${n.ref}`} style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
                <span className="pill warn" style={KEEP_CASE}>{NEED_WORDS[n.kind] ?? n.kind}</span>{' '}
                {n.why}
                {(n.kind === 'owner-decision' || n.kind === 'assumption-pending') && <> · <button className="link" onClick={() => onTab('assumptions')}>assumptions</button></>}
                {n.kind === 'forgery-shape-review' && /^c_/.test(n.ref) && (
                  <> · <button className="link" onClick={() => onNeed(n)}>review the candidate</button></>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="plan" forge="campaign-plan">
        <div className="num" style={{ overflowWrap: 'anywhere' }}>
          revision {show.commit.slice(0, 12)} · plan {show.planDigest} · {show.tickets.length} tickets in {show.lanes.length} lanes ·{' '}
          {show.approved ? 'approved' : 'not approved'}
        </div>
        {!show.approved && (
          <ActForm label="approve plan" presets={RATIONALE_PRESETS_CAMPAIGN['approve-plan']} sample={sample}
            act={(rationale) => api.approvePlan({ id, rationale })} onDone={onReload} />
        )}
      </Section>

      <Section title="envelope" forge="campaign-envelope">
        {show.envelope ? (
          <table className="grid">
            <tbody>{envelopeRows(show.envelope).map((r) => <tr key={r.k}><td className="num">{r.k}</td><td className="mono" style={{ overflowWrap: 'anywhere' }}>{r.v}</td></tr>)}</tbody>
          </table>
        ) : <p className="dim">No authorization in force.{show.authorization ? ` ${show.authorization}` : ''}</p>}
        {show.lock
          ? <p className="num">gates locked by {shortRef(show.lock.decisionId)} · {show.lock.gates} gates · {show.lock.holdouts} holdouts (counted, never shown) · ratchet {show.lock.ratchet ? 'on' : 'off'}</p>
          : <p className="hint" style={{ fontSize: 11 }}>the campaign's gates are not locked; authorize needs a locked gate set</p>}
        <AuthorizeForm api={api} id={id} sample={sample} fields={authorizeDefaults(show.envelope)} identity={show.envelope?.identity ?? null} onDone={onReload} />
      </Section>

      <Section title="integration" forge="campaign-integration">
        <div className="num" style={{ overflowWrap: 'anywhere' }}>
          {status.integration.ref} @ {status.integration.tip.slice(0, 12)} · base {status.integration.base.slice(0, 12)} · {status.integration.landed} landed
        </div>
        <div className="toolbar wrap" style={{ marginTop: 6 }}>
          <code style={{ overflowWrap: 'anywhere' }}>{status.integration.mergeHint}</code>
          <button className="link" onClick={() => copy(status.integration.mergeHint)}>copy</button>
          <span className="dim" style={{ fontSize: 11 }}>the ref is untrusted until refine and your merge (P2-R43)</span>
        </div>
      </Section>

      <Section title="status" forge="status-table">
        <table className="grid">
          <thead><tr><th>lane</th><th>total</th>{STATUS_BUCKETS.map((b) => <th key={b}>{BUCKET_WORDS[b]}</th>)}</tr></thead>
          <tbody>
            {status.table.rows.map((r) => (
              <tr key={r.lane}>
                <td>{r.lane}</td><td className="mono">{r.total}</td>
                {STATUS_BUCKETS.map((b) => <td key={b} className="mono" title={r.tickets[b].join(', ')}>{r.byBucket[b] || ''}{r.tickets[b].length ? ` ${r.tickets[b].join(' ')}` : ''}</td>)}
              </tr>
            ))}
            <tr><td className="num">all</td><td className="mono">{STATUS_BUCKETS.reduce((n, b) => n + status.table.totals[b], 0)}</td>
              {STATUS_BUCKETS.map((b) => <td key={b} className="mono">{status.table.totals[b]}</td>)}</tr>
          </tbody>
        </table>
      </Section>

      <Section title="tickets" forge="campaign-tickets">
        <CampaignDag show={show} status={status} onOpenMission={(missionId) => onOpen({ screen: 'missions', missionId })} />
      </Section>

      <Section title="spend" forge="campaign-spend">
        <SpendBarView bar={campaignSpendBar(status.spend)} label="campaign" />
        {report?.spend.lanes.map((l) => <SpendBarView key={l.key} bar={spendBar(l, status.spend.capUsd)} label={`lane ${l.key}`} />)}
        {reportError && <p className="hint" style={{ fontSize: 11 }}>per-lane spend: {reportError}</p>}
      </Section>

      {!!proposed.length && (
        <Section title={`proposed tickets · ${proposed.length}`} forge="proposed-tickets">
          <p className="hint" style={{ fontSize: 11 }}>Generated from findings or overturned assumptions. A person's approve admits them (P2-R36).</p>
          {proposed.map((t) => <ProposedTicket key={t.ticketId} api={api} sample={sample} ticket={t} onDone={onReload} />)}
        </Section>
      )}

      {!!report?.blocked.length && (
        <Section title={`blocked · ${report.blocked.length}`} forge="campaign-blocked">
          <ul className="rows">
            {report.blocked.map((b) => {
              const w = blockedActWord(b.act);
              return (
                <li key={b.ticketId} style={{ fontSize: 12, overflowWrap: 'anywhere' }} data-forge="blocked-ticket">
                  <strong>{b.ticketId}</strong> · {b.lane} · {b.reason}{' '}
                  {b.act === 'retry' && <button className="link" onClick={() => setRetryTicket(b.ticketId)}>{w.name}</button>}
                  {b.act === 'resolve-dependency' && b.missionId && <button className="link" onClick={() => onOpen({ screen: 'missions', missionId: b.missionId })}>{w.name}</button>}
                  {b.act === 'owner-decision' && <button className="link" onClick={() => onTab('assumptions')}>{w.name}</button>}
                  {(b.act === 'approve-work-item' || b.act === 'authorize' || b.act === 'read') && <span className="num" title={w.hint}>{w.name}</span>}
                </li>
              );
            })}
          </ul>
          {retryTicket && (
            <ActForm label={`retry ${retryTicket}`} presets={RATIONALE_PRESETS_CAMPAIGN.retry} sample={sample}
              act={(rationale) => api.retry({ id, ticketId: retryTicket, rationale })} onDone={onReload} />
          )}
        </Section>
      )}
    </div>
  );
}

/** A rationale and one guarded act, its outcome shown as the engine and the dialog left it. */
function ActForm({ label, presets, sample, act, onDone, disabled }: {
  label: string; presets: readonly string[]; sample: boolean; act: (rationale: string) => Promise<GuardedResult>; onDone: () => void; disabled?: string | null;
}) {
  const [rationale, setRationale] = useState(presets[0] ?? '');
  const [pending, result, run] = useAct();
  return (
    <div className="stack" style={{ gap: 6, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }} data-forge="act-form">
      <RationalePicker presets={presets} value={rationale} onChange={setRationale} />
      <div className="toolbar wrap">
        <button className="btn" disabled={pending || !rationale.trim() || !!disabled} onClick={() => void run(async () => {
          const r = await act(rationale.trim());
          if (r.ok) onDone();
          return r;
        })}>{pending ? 'asking…' : label}</button>
        {disabled && <span className="hint" style={{ fontSize: 11 }}>{disabled}</span>}
        {!rationale.trim() && <span className="hint" style={{ fontSize: 11 }}>an act needs a rationale</span>}
        <span className="dim" style={{ fontSize: 11 }}>main shows the digest in a system dialog; Cancel is the default</span>
      </div>
      <GuardOutcome result={result} sample={sample} />
    </div>
  );
}

function HaltButton({ api, id, sample, onDone }: { api: ForgeApi; id: string; sample: boolean; onDone: () => void }) {
  const [pending, result, run] = useAct();
  return (
    <>
      <button className="btn bad" disabled={pending} data-forge="halt-button" onClick={() => void run(async () => {
        const r = await api.halt({ id });
        if (r.ok) onDone();
        return r;
      })}>{pending ? 'asking…' : 'halt'}</button>
      <span className="dim" style={{ fontSize: 11 }}>no new attempt starts; running ones finish. A plain dialog, no digest.</span>
      <GuardOutcome result={result} sample={sample} />
    </>
  );
}

/** Resume or adopt-tip: both name the halt decision they answer. */
function HaltIdAct({ api, id, sample, kind, initial, to: toInitial = '', onDone }: {
  api: ForgeApi; id: string; sample: boolean; kind: 'resume' | 'adopt-tip'; initial: string; to?: string; onDone: () => void;
}) {
  const [haltId, setHaltId] = useState(initial);
  const [to, setTo] = useState(toInitial);
  const ok = /^d_[0-9a-f]{32}$/.test(haltId) && (to === '' || /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(to));
  return (
    <div className="card quiet" data-forge={kind}>
      <div className="toolbar wrap">
        <strong>{kind === 'resume' ? 'resume' : 'adopt the moved tip'}</strong>
        <input value={haltId} onChange={(e) => setHaltId(e.target.value.trim())} placeholder="halt decision d_… (campaign status names it)"
          aria-label="halt decision" style={{ minWidth: 300 }} />
        {kind === 'adopt-tip' && (
          <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="--to commit (blank: adopt where the ref is)"
            aria-label="restore to commit" style={{ minWidth: 320 }} data-forge="adopt-to" />
        )}
      </div>
      <ActForm label={kind === 'resume' ? 'resume campaign' : 'adopt integration tip'} presets={RATIONALE_PRESETS_CAMPAIGN[kind]} sample={sample}
        disabled={ok ? null : 'name the halt decision this answers (d_ and 32 hex), and a full commit id or nothing for --to'}
        act={(rationale) => (kind === 'resume' ? api.resume({ id, haltId, rationale }) : api.adoptTip({ id, haltId, rationale, ...(to ? { to } : {}) }))} onDone={onDone} />
    </div>
  );
}

function ProposedTicket({ api, sample, ticket, onDone }: {
  api: ForgeApi; sample: boolean; ticket: ReturnType<typeof proposedTickets>[number]; onDone: () => void;
}) {
  const [kind, setKind] = useState<'approve' | 'reject'>('approve');
  const presets = RATIONALE_PRESETS_CAMPAIGN[kind === 'approve' ? 'approve-ticket' : 'reject-ticket'];
  return (
    <div className="card quiet" data-forge="proposed-ticket">
      <div className="toolbar wrap">
        <strong>{ticket.ticketId}</strong><span>{ticket.title}</span><span className="pill warn">{ticket.origin}</span>
        <span className="num">lane {ticket.lane} · scope {ticket.scope.join(', ')}</span>
      </div>
      <div className="toolbar wrap" style={{ marginTop: 6 }}>
        <Choice options={[{ value: 'approve', label: 'approve' }, { value: 'reject', label: 'reject' }]} value={kind} onChange={setKind} />
      </div>
      <ActForm key={kind} label={`${kind} ticket`} presets={presets} sample={sample}
        act={(rationale) => api.workItemDecide({ id: ticket.workItemId, kind, rationale })} onDone={onDone} />
    </div>
  );
}

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * The full envelope as a prefilled form (P2-R40). There is no identity field: the engine
 * records the OS user's default, labelled asserted, and shows it in the dialog (P2-R45 D2).
 * The gate set is not a field either; main reads it from `campaign gate list`.
 */
function AuthorizeForm({ api, id, sample, fields, identity, onDone }: {
  api: ForgeApi; id: string; sample: boolean; fields: AuthorizeFields; identity: { name: string; email: string } | null; onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<AuthorizeFields>(fields);
  const [roster, setRoster] = useState(fields.roster.join(','));
  const [review, setReview] = useState(fields.reviewRoster.join(','));
  const [tickets, setTickets] = useState((fields.tickets ?? []).join(','));
  const form: AuthorizeFields = { ...f, roster: csv(roster), reviewRoster: csv(review), tickets: tickets.trim() ? csv(tickets) : undefined };
  const problems = authorizeProblems(form);
  const numField = (key: 'maxUsdTotal' | 'maxUsdPerMission' | 'maxTurns' | 'timeoutSeconds' | 'maxAttempts' | 'concurrency' | 'notAfterHours', label: string) => (
    <label className="num" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {label}
      <input type="number" value={String(f[key])} onChange={(e) => setF({ ...f, [key]: Number(e.target.value) })} style={{ width: 110 }} />
    </label>
  );
  if (!open) return <button className="btn" style={{ marginTop: 8 }} onClick={() => setOpen(true)} data-forge="authorize-open">authorize…</button>;
  return (
    <div className="card quiet" style={{ marginTop: 8 }} data-forge="authorize-form">
      <div className="toolbar wrap" style={{ alignItems: 'flex-end' }}>
        <label className="num" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>roster<input value={roster} onChange={(e) => setRoster(e.target.value)} /></label>
        <label className="num" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>review roster ([] turns review off)<input value={review} onChange={(e) => setReview(e.target.value)} /></label>
        {numField('maxUsdTotal', 'cap $')}{numField('maxUsdPerMission', 'per ticket $')}{numField('maxTurns', 'turns')}
        {numField('timeoutSeconds', 'timeout s')}{numField('maxAttempts', 'attempts')}{numField('concurrency', 'concurrency')}
        <label className="num" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>wave size (blank: 2 × concurrency)
          <input type="number" value={f.waveSize === undefined ? '' : String(f.waveSize)} onChange={(e) => setF({ ...f, waveSize: e.target.value === '' ? undefined : Number(e.target.value) })} style={{ width: 110 }} />
        </label>
        {numField('notAfterHours', 'lasts hours')}
      </div>
      <div className="toolbar wrap" style={{ marginTop: 6 }}>
        <span className="num">exec</span>
        <Choice options={[{ value: 'off', label: 'off' }, { value: 'on', label: 'on (nested, no network)' }]} value={f.execute ? 'on' : 'off'} onChange={(v) => setF({ ...f, execute: v === 'on' })} />
        <span className="num">auto-apply</span>
        <Choice options={[{ value: 'integration-ref', label: 'integration ref' }, { value: 'none', label: 'none' }]} value={f.autoApply} onChange={(v) => setF({ ...f, autoApply: v })} />
        <span className="num">fix lane</span>
        <Choice options={[{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }]} value={f.fixLane === 'off' ? 'off' : 'on'}
          onChange={(v) => setF({ ...f, fixLane: v === 'off' ? 'off' : { tickets: 5, usd: 1.5 } })} />
        {f.fixLane !== 'off' && (
          <>
            <input type="number" aria-label="fix tickets a wave" value={String(f.fixLane.tickets)} style={{ width: 60 }}
              onChange={(e) => setF({ ...f, fixLane: { ...(f.fixLane as { tickets: number; usd: number }), tickets: Number(e.target.value) } })} />
            <span className="num">a wave at $</span>
            <input type="number" aria-label="fix dollars a ticket" value={String(f.fixLane.usd)} style={{ width: 70 }}
              onChange={(e) => setF({ ...f, fixLane: { ...(f.fixLane as { tickets: number; usd: number }), usd: Number(e.target.value) } })} />
          </>
        )}
      </div>
      <label className="num" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>tickets (blank: every approved plan ticket)
        <input value={tickets} onChange={(e) => setTickets(e.target.value)} />
      </label>
      <p className="num" style={{ marginTop: 6 }}>
        identity (asserted, read-only): {identity ? `${identity.name} <${identity.email}>` : 'the OS user\'s default, chosen by the engine'} — never set from here
      </p>
      {!!problems.length && <ul className="rows hint" style={{ fontSize: 11 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <ActForm label="authorize campaign" presets={RATIONALE_PRESETS_CAMPAIGN.authorize} sample={sample} disabled={problems.length ? 'fix the form first' : null}
        act={(rationale) => api.authorizeCampaign({ id, rationale, ...form, maxAttempts: form.maxAttempts })} onDone={onDone} />
    </div>
  );
}
