import { useCallback, useEffect, useState } from 'react';
import type { WorkItem, WorkItemsPayload } from '../types.ts';
import { RATIONALE_PRESETS, shortDigest, shortRef, workItemQueue } from './forge-words.ts';
import { Choice, GuardOutcome, RationalePicker, useAct, type ForgeApi } from './ForgeParts.tsx';

/**
 * The work-item queue: what a spec was decomposed into, by status and anchor.
 *
 * Two proposals for one anchor are a spec ambiguity — the decomposers were blind to each other
 * and read the spec differently — so they sit side by side, and the person picks one or
 * neither. Only a human decision approves an item, and only an approved item can parent an
 * implement mission.
 */
export function WorkItems({ api, sample }: { api: ForgeApi; sample: boolean }) {
  const [data, setData] = useState<WorkItemsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.workItems();
    if (r.error) setError(r.error);
    else {
      setError(null);
      setData({ workItems: r.workItems ?? [], needs: r.needs ?? [] });
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const queue = workItemQueue(data?.workItems ?? [], data?.needs ?? []);

  return (
    <div className="screen mission" data-forge="work-items">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>Work items{sample ? ' — sample data' : ''}</h2>
            <p className="sub">
              Buildable units drawn from a registered spec. Each is approved or rejected by a person;
              approval is what lets an implement mission start from it. Sibling proposals for one
              anchor mean the spec can be read two ways.
            </p>
          </div>
          <div className="spacer" />
          <div className="toolbar">
            <button className="btn" onClick={() => void load()}>refresh</button>
            <button
              className="btn"
              disabled={sample}
              title={sample ? 'the sample is on screen' : 'main opens a file picker inside the repository'}
              onClick={async () => {
                const r = await api.specRegister();
                setNote(r.error ?? (r.canceled ? null : 'spec registered'));
                if (!r.error && !r.canceled) void load();
              }}
            >
              register spec…
            </button>
          </div>
        </div>
      </div>
      <div className="screen-body">
        {error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}
        {note && <div className="banner toast" style={{ margin: 0 }}>{note}</div>}
        {sample && <p className="num">sample · nothing on this screen came from a model, and nothing here can be recorded</p>}
        {!queue.length && !error && <p className="dim">No work items. Register a spec and decompose it to propose some.</p>}
        {queue.map((g) => (
          <div key={g.status} className="card">
            <h3>{g.status} · {g.anchors.reduce((n, a) => n + a.items.length, 0)}</h3>
            {g.anchors.map((a) => (
              <div key={a.anchor} style={{ marginTop: 8 }}>
                <div className="toolbar wrap">
                  <span className="num">anchor {a.anchor}</span>
                  {a.ambiguous && <span className="pill warn">spec ambiguity · {a.items.length} readings</span>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: a.ambiguous ? 'repeat(auto-fit, minmax(320px, 1fr))' : '1fr', gap: 10, marginTop: 6 }}>
                  {a.items.map((w) => <WorkItemCard key={w.id} item={w} api={api} sample={sample} onDone={load} />)}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkItemCard({ item, api, sample, onDone }: { item: WorkItem; api: ForgeApi; sample: boolean; onDone: () => void }) {
  const [kind, setKind] = useState<'approve' | 'reject'>('approve');
  const presets = RATIONALE_PRESETS[kind === 'approve' ? 'approve-work-item' : 'reject-work-item'];
  const [rationale, setRationale] = useState(presets[0]);
  const [pending, result, run] = useAct();
  const tone = item.status === 'approved' ? 'ok' : item.status === 'rejected' ? 'bad' : item.status === 'proposed' ? 'warn' : '';

  return (
    <div className="card" style={{ margin: 0 }} data-forge="work-item">
      <div className="toolbar wrap">
        <span className={`pill ${tone}`}>{item.status}</span>
        <strong style={{ fontSize: 12.5 }}>{item.title}</strong>
      </div>
      <p className="prose" style={{ fontSize: 12 }}>{item.statement}</p>
      {!!item.examples.length && (
        <>
          <div className="num">examples</div>
          <ul className="rows num">{item.examples.map((e) => <li key={e}>{e}</li>)}</ul>
        </>
      )}
      {!!item.negativeExamples.length && (
        <>
          <div className="num">must not</div>
          <ul className="rows num">{item.negativeExamples.map((e) => <li key={e}>{e}</li>)}</ul>
        </>
      )}
      <div className="num" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
        {shortRef(item.id)} · proposed by {item.proposedBy} · content {shortDigest(item.contentDigest)} · spec {item.specArtifact.path ?? shortDigest(item.specArtifact.digest)}
        {item.decisionId ? ` · decided ${shortRef(item.decisionId)}` : ''}
      </div>
      {item.status === 'proposed' && (
        <div className="decide-form" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
          <div className="toolbar wrap">
            <Choice
              options={[{ value: 'approve', label: 'approve' }, { value: 'reject', label: 'reject' }]}
              value={kind}
              onChange={(k) => { setKind(k); setRationale(RATIONALE_PRESETS[k === 'approve' ? 'approve-work-item' : 'reject-work-item'][0]); }}
            />
          </div>
          <RationalePicker presets={presets} value={rationale} onChange={setRationale} />
          <div className="toolbar wrap">
            <button
              className={kind === 'approve' ? 'btn ok' : 'btn bad'}
              disabled={pending || !rationale.trim()}
              onClick={() => void run(async () => {
                const r = await api.workItemDecide({ id: item.id, kind, rationale: rationale.trim() });
                if (r.ok) onDone();
                return r;
              })}
            >
              {pending ? 'asking…' : `${kind} work item`}
            </button>
            {!rationale.trim() && <span className="hint" style={{ fontSize: 11 }}>a decision needs a rationale</span>}
            <span className="dim" style={{ fontSize: 11 }}>main shows the content digest in a system dialog; Cancel is the default</span>
          </div>
          <GuardOutcome result={result} sample={sample} />
        </div>
      )}
    </div>
  );
}
