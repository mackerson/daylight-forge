import { useState } from 'react';
import type { Belief, Claim, QueryPayload } from '../types.ts';

/**
 * The arbitration surface — the screen the design calls the highest-value thing in the
 * product, and which until now was a JSON file. Contradictions first, because a
 * disagreement between two sources is worth more than another unexamined node.
 */
export function Review({ query, onRefresh }: { query: QueryPayload | null; onRefresh: () => void }) {
  const [filter, setFilter] = useState<'contradicted' | 'all'>('contradicted');
  if (!query) return <div className="empty"><h2>Loading…</h2></div>;

  const beliefs = filter === 'contradicted' ? query.contradictions : query.beliefs;

  if (!query.beliefs.length) {
    return (
      <div className="empty">
        <h2>Nothing claimed yet</h2>
        <p>Run <strong>Explore</strong> to have an agent answer frontier questions.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <button className={filter === 'contradicted' ? 'chip active' : 'chip'} onClick={() => setFilter('contradicted')}>
          Contradicted ({query.contradictions.length})
        </button>
        <button className={filter === 'all' ? 'chip active' : 'chip'} onClick={() => setFilter('all')}>
          All beliefs ({query.beliefs.length})
        </button>
      </div>

      {!beliefs.length && (
        <p className="dim">No contradictions. Sources agree on everything examined so far.</p>
      )}

      {beliefs.map((b) => (
        <BeliefCard key={`${b.subject}:${b.predicate}`} belief={b} onRefresh={onRefresh} />
      ))}
    </div>
  );
}

function BeliefCard({ belief, onRefresh }: { belief: Belief; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);

  const arbitrate = async (value: unknown) => {
    setBusy(true);
    await window.vds.arbitrate({
      subject: belief.subject,
      predicate: belief.predicate,
      value,
      note: 'arbitrated in GUI',
    });
    setBusy(false);
    onRefresh();
  };

  const contested = belief.status === 'CONTRADICTED';

  return (
    <section className={contested ? 'card bad-border' : 'card'}>
      <h3>
        <span className={`pill ${belief.status.toLowerCase()}`}>{belief.status}</span>
        <code>{belief.predicate}</code>
      </h3>
      <p className="mono dim">{belief.subject}</p>

      <div className="claims">
        {belief.claims.map((c) => (
          <ClaimRow key={c.id} claim={c} onPick={contested ? () => arbitrate(c.value) : undefined} busy={busy} />
        ))}
      </div>

      {belief.status !== 'CONFIRMED' && !contested && (
        <div className="actions">
          <button disabled={busy} onClick={() => arbitrate(belief.value)}>Confirm</button>
          <span className="dim">
            confidence {belief.confidence.toFixed(2)} · {belief.claims.length} source
            {belief.claims.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
      {contested && <p className="hint">Pick the claim that is right — that becomes CONFIRMED and outranks every agent.</p>}
    </section>
  );
}

function ClaimRow({ claim, onPick, busy }: { claim: Claim; onPick?: () => void; busy: boolean }) {
  const value = typeof claim.value === 'string' ? claim.value : JSON.stringify(claim.value);
  return (
    <div className="claim">
      <div className="claim-head">
        <span className={`src ${claim.source.kind}`}>
          {claim.source.kind === 'human' ? 'human' : `${claim.source.tool}/${claim.source.model ?? 'default'}`}
        </span>
        <span className="dim">{claim.confidence.toFixed(2)}</span>
        {onPick && (
          <button className="link" disabled={busy} onClick={onPick}>
            this one is right
          </button>
        )}
      </div>
      <p className="value">{value}</p>
      <ul className="ev">
        {claim.evidence.map((e, i) => (
          <li key={i}>
            <button className="link mono" onClick={() => window.vds.reveal({ file: e.file, line: e.line })}>
              {e.file}{e.line ? `:${e.line}` : ''}
            </button>
            {e.note && <span className="dim"> — {e.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
