import { useState } from 'react';
import { Author } from '../panels/Author.tsx';
import type { Belief, LoadPayload } from '../types.ts';
import { state } from '../vocab.ts';

/**
 * Invariants — the one screen where the app says no.
 *
 * Everything else here is a belief, which is to say a thing that might be revised by the
 * next run. An invariant is a rule you wrote, and it does not move: agents are told them
 * before they explore, and a remediation step that breaks one is rejected rather than
 * ranked. That asymmetry is the whole point, so the screen leads with what each one checks
 * and what it is costing you right now rather than with a list of ids.
 */
export function Invariants({ data, beliefs, onRefresh, onPlan }: {
  data: LoadPayload;
  beliefs: Belief[];
  onRefresh: () => void;
  onPlan: () => void;
}) {
  const [authoring, setAuthoring] = useState(false);
  const results = data.invariants?.results ?? [];
  const violated = results.filter((r) => r.status === 'red');
  const holding = results.filter((r) => r.status !== 'red');

  // A confirmed belief is the raw material for an invariant: it is something you decided is
  // true, and promoting it is how a decision stops needing to be re-made every run.
  const promotable = beliefs.filter((b) => b.status === 'CONFIRMED');

  return (
    <div className="screen">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>Invariants</h2>
            <p className="sub">
              Rules you decided. They gate the build and constrain every remediation plan.
            </p>
          </div>
          <div className="spacer" />
          <div className="toolbar">
            <span className={violated.length ? 'pill bad' : 'pill ok'}>
              {violated.length ? `${violated.length} violated` : `${holding.length} holding`}
            </span>
            {violated.length > 0 && (
              <span className="pill">{holding.length} holding</span>
            )}
            <span className="num">
              {data.stack ? `L3 is ${data.stack.l3Status}` : 'not mapped'}
            </span>
          </div>
        </div>
      </div>

      <div className="screen-body">
        {!results.length && (
          <div className="empty">
            <h2>No invariants defined</h2>
            <p>
              Invariants are claims about <em>this</em> codebase — “the event bus is
              storage-only”, “streaming has one consumer” — so they live with the code they
              constrain, not in the tool.
            </p>
            <p className="dim">
              Create <code>daylight.invariants.json</code> in the repo root. Each one needs an{' '}
              <code>id</code>, the <code>prose</code> a human reads, and a{' '}
              <code>predicate</code> compiled against L0. Until then L3 reports UNPROVEN
              rather than failing.
            </p>
            <button className="btn ok" onClick={() => setAuthoring(true)}>
              Write the first one
            </button>
          </div>
        )}

        {[...violated, ...holding].map((r) => (
          <div className={r.status === 'red' ? 'inv violated' : 'inv'} key={r.id}>
            <div className="body">
              <div className="title">
                <span className={r.status === 'red' ? 'pill bad' : 'pill ok'}>
                  {r.status === 'red' ? 'violated' : 'holding'}
                </span>
                <span className="rule">{r.prose}</span>
              </div>
              <div className="checks">checks: {r.measured}</div>
              {r.violations.length > 0 && (
                <div className="checks" style={{ color: 'var(--bad)' }}>
                  {r.violations.slice(0, 4).map((v, i) => (
                    <span key={i}>
                      {i > 0 && ' · '}
                      {v.where}{v.line ? `:${v.line}` : ''}
                    </span>
                  ))}
                  {r.violations.length > 4 && ` · +${r.violations.length - 4}`}
                </div>
              )}
            </div>
            {r.status === 'red' && (
              <button className="btn bad" onClick={onPlan}>Plan a fix</button>
            )}
            <span className="origin">{r.id}</span>
          </div>
        ))}

        {results.length > 0 && (
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button
              className={authoring ? 'chip active' : 'chip'}
              onClick={() => setAuthoring(!authoring)}
            >
              {authoring ? 'close' : '+ new invariant'}
            </button>
            <span className="dim">
              write it in plain language, or promote one of the {promotable.length} belief
              {promotable.length === 1 ? '' : 's'} you have confirmed
            </span>
          </div>
        )}

        {authoring && <Author onSaved={onRefresh} />}

        {promotable.length > 0 && (
          <details className="raw">
            <summary>promote a confirmed belief</summary>
            <div className="stack">
              {promotable.map((b) => (
                <div className="card" key={`${b.subject}:${b.predicate}`}>
                  <h3>
                    <span className={`pill ${state(b.status).name}`}>{state(b.status).name}</span>
                    <code>{b.predicate}</code>
                  </h3>
                  <p className="subject">{b.subject}</p>
                  <p className="dim">
                    Confirmed by you. An invariant made from it would fail the build the next
                    time something contradicts it, instead of waiting for a run to notice.
                    Write the predicate above — the prose is the sentence you already agreed to.
                  </p>
                </div>
              ))}
            </div>
          </details>
        )}

        <p className="dim" style={{ marginTop: 8 }}>
          Agents are told these rules before they explore, and a plan that breaks one is
          rejected rather than ranked.
        </p>
      </div>
    </div>
  );
}
