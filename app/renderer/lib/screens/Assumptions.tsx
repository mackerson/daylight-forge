import { useCallback, useEffect, useState } from 'react';
import type { AssumptionAct, ForgeAssumptionRow } from '../types.ts';
import { assumptionActs, assumptionQueue, RATIONALE_PRESETS_CAMPAIGN } from './campaign-words.ts';
import { shortRef } from './forge-words.ts';
import { Choice, GuardOutcome, RationalePicker, useAct, type ForgeApi } from './ForgeParts.tsx';

/**
 * The assumptions waiting on a person: open blocking first, then open, then pending. Confirm
 * takes a pending default; decide answers an open question from the plan's options or a typed
 * value; overturn records another value and proposes a follow-up ticket, which a person still
 * approves. Nothing landed is reverted by an overturn (assumptions.ts).
 */
export function Assumptions({ api, id, sample, lanes }: { api: ForgeApi; id: string; sample: boolean; lanes: string[] }) {
  const [rows, setRows] = useState<ForgeAssumptionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api.assumptions(id);
    if (!Array.isArray(r)) setError(r.error);
    else { setError(null); setRows(r); }
  }, [api, id]);
  useEffect(() => { void load(); }, [load]);

  const queue = assumptionQueue(rows ?? []);
  const settled = (rows ?? []).length - queue.length;
  return (
    <div className="stack" data-forge="assumptions">
      {error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}
      {rows && !queue.length && <p className="dim">Nothing waits on you.</p>}
      {queue.map((a) => <AssumptionCard key={a.id} a={a} api={api} sample={sample} lanes={lanes} onDone={load} />)}
      {!!settled && <p className="num">{settled} confirmed or overturned</p>}
    </div>
  );
}

function AssumptionCard({ a, api, sample, lanes, onDone }: { a: ForgeAssumptionRow; api: ForgeApi; sample: boolean; lanes: string[]; onDone: () => void }) {
  const acts = assumptionActs(a);
  const [kind, setKind] = useState<AssumptionAct>(acts[0]);
  const [value, setValue] = useState(a.status === 'pending' ? a.default : a.options[0] ?? '');
  const [followUp, setFollowUp] = useState('');
  const [lane, setLane] = useState('');
  const [scope, setScope] = useState('');
  const [rationale, setRationale] = useState(RATIONALE_PRESETS_CAMPAIGN[acts[0]][0]);
  const [pending, result, run] = useAct();
  const blocked = kind !== 'confirm' && !value.trim() ? `${kind} needs a value`
    : kind === 'overturn' && !followUp.trim() ? 'an overturn needs the follow-up statement'
    : !rationale.trim() ? 'an act needs a rationale' : null;

  return (
    <div className="card" data-forge="assumption">
      <div className="toolbar wrap">
        <span className={`pill ${a.status === 'open' ? 'bad' : 'warn'}`}>{a.status}{a.blocking ? ' · blocking' : ''}</span>
        <strong style={{ fontSize: 12.5 }}>{a.question}</strong>
        <code>{shortRef(a.id)}</code>
      </div>
      <div className="num" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
        {a.default ? `default: ${a.default}` : 'no default: the director waits'} · source {a.source}
        {a.ownerDecisionId ? ` · ${a.ownerDecisionId}` : ''}{a.heldTickets.length ? ` · holds ${a.heldTickets.join(', ')}` : ''}
      </div>
      <div className="toolbar wrap" style={{ marginTop: 8 }}>
        <Choice options={acts.map((k) => ({ value: k, label: k }))} value={kind}
          onChange={(k) => { setKind(k); setRationale(RATIONALE_PRESETS_CAMPAIGN[k][0]); if (k !== 'confirm' && a.status === 'pending' && kind === 'confirm') setValue(''); }} />
      </div>
      {kind !== 'confirm' && (
        <div className="stack" style={{ gap: 6, marginTop: 6 }}>
          {!!a.options.length && (
            <div className="toolbar wrap">
              <span className="num">options</span>
              {a.options.map((o) => <button key={o} className={value === o ? 'chip active' : 'chip'} onClick={() => setValue(o)} aria-pressed={value === o}>{o}</button>)}
            </div>
          )}
          <input value={value} onChange={(e) => setValue(e.target.value.replace(/[\r\n]/g, ' '))} placeholder="the value, picked above or typed" aria-label="value" />
        </div>
      )}
      {kind === 'overturn' && (
        <div className="stack" style={{ gap: 6, marginTop: 6 }}>
          <p className="hint" style={{ fontSize: 11, margin: 0 }}>
            The follow-up becomes a proposed ticket that a person approves. Nothing already landed on this assumption is reverted.
          </p>
          <input value={followUp} onChange={(e) => setFollowUp(e.target.value.replace(/[\r\n]/g, ' '))} placeholder="follow-up: what the ticket should do" aria-label="follow-up" />
          <div className="toolbar wrap">
            <span className="num">lane</span>
            <Choice options={[{ value: '', label: 'the held ticket\'s' }, ...lanes.map((l) => ({ value: l, label: l }))]} value={lane} onChange={setLane} />
            <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="scope paths, comma separated (optional)" aria-label="scope" style={{ minWidth: 260 }} />
          </div>
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        <RationalePicker presets={RATIONALE_PRESETS_CAMPAIGN[kind]} value={rationale} onChange={setRationale} />
      </div>
      <div className="toolbar wrap" style={{ marginTop: 8 }}>
        <button className={kind === 'overturn' ? 'btn warn' : 'btn ok'} disabled={pending || !!blocked} onClick={() => void run(async () => {
          const r = await api.assumptionDecide({
            id: a.id, kind, rationale: rationale.trim(),
            ...(kind !== 'confirm' ? { value: value.trim() } : {}),
            ...(kind === 'overturn' ? { followUp: followUp.trim(), ...(lane ? { lane } : {}), ...(scope.trim() ? { scope: scope.split(',').map((x) => x.trim()).filter(Boolean) } : {}) } : {}),
          });
          if (r.ok) onDone();
          return r;
        })}>{pending ? 'asking…' : `${kind} assumption`}</button>
        {blocked && <span className="hint" style={{ fontSize: 11 }}>{blocked}</span>}
        <span className="dim" style={{ fontSize: 11 }}>main shows the digest in a system dialog; Cancel is the default</span>
      </div>
      <GuardOutcome result={result} sample={sample} />
    </div>
  );
}
