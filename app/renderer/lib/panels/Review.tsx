import { useState } from 'react';
import type { Belief, Claim, QueryPayload } from '../types.ts';

/**
 * The arbitration surface — the screen the design calls the highest-value thing in the
 * product, and which until now was a JSON file. Contradictions first, because a
 * disagreement between two sources is worth more than another unexamined node.
 */
export function Review({ query, onRefresh, onArbitrate }: {
  query: QueryPayload | null;
  onRefresh: () => void;
  onArbitrate: (b: Belief) => void;
}) {
  const [filter, setFilter] = useState<'contradicted' | 'all' | 'focus'>('contradicted');
  if (!query) return <div className="empty"><h2>Loading…</h2></div>;

  const beliefs = filter === 'contradicted' ? query.contradictions : query.beliefs;
  const unjudged =
    query.clusters.filter((c) => !c.verdict).length +
    query.elisions.filter((e) => !e.verdict).length;

  if (filter === 'focus') {
    return (
      <div className="stack">
        <Tabs filter={filter} setFilter={setFilter} query={query} unjudged={unjudged} />
        <FocusReview query={query} onRefresh={onRefresh} />
      </div>
    );
  }

  if (!query.beliefs.length && !query.clusters.length) {
    return (
      <div className="empty">
        <h2>Nothing claimed yet</h2>
        <p>Run <strong>Explore</strong> to have an agent answer frontier questions.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <Tabs filter={filter} setFilter={setFilter} query={query} unjudged={unjudged} />

      {!beliefs.length && (
        <p className="dim">No contradictions. Sources agree on everything examined so far.</p>
      )}

      {beliefs.map((b) => (
        <BeliefCard
          key={`${b.subject}:${b.predicate}`}
          belief={b}
          onRefresh={onRefresh}
          onArbitrate={onArbitrate}
        />
      ))}
    </div>
  );
}

function Tabs({ filter, setFilter, query, unjudged }: {
  filter: string;
  setFilter: (f: any) => void;
  query: QueryPayload;
  unjudged: number;
}) {
  return (
    <div className="toolbar">
      <button className={filter === 'contradicted' ? 'chip active' : 'chip'} onClick={() => setFilter('contradicted')}>
        Contradicted ({query.contradictions.length})
      </button>
      <button className={filter === 'all' ? 'chip active' : 'chip'} onClick={() => setFilter('all')}>
        All beliefs ({query.beliefs.length})
      </button>
      <button className={filter === 'focus' ? 'chip active' : 'chip'} onClick={() => setFilter('focus')}>
        Focus ({unjudged} unjudged)
      </button>
    </div>
  );
}

/**
 * Arbitrating the focus itself, not just claims about nodes.
 *
 * Confirming a cluster is the more valuable act once focusing is underway — it is what
 * turns an agent's proposal into part of the map. Rejection is consequential: a rejected
 * cluster or elision is dropped from the stack on the next derive, so this is editing the
 * map rather than annotating it.
 */
function FocusReview({ query, onRefresh }: { query: QueryPayload; onRefresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const judge = async (subject: string, predicate: string, value: boolean) => {
    setBusy(subject);
    await window.vds.arbitrate({ subject, predicate, value, note: 'arbitrated in GUI' });
    setBusy(null);
    onRefresh();
  };

  const Verdict = ({ v }: { v: { status: string; value?: unknown } | null }) =>
    !v ? null : (
      <span className={v.value === false ? 'pill bad' : 'pill confirmed'}>
        {v.value === false ? 'rejected' : 'kept'}
      </span>
    );

  return (
    <>
      {!query.clusters.length && !query.elisions.length && (
        <p className="dim">
          Nothing to arbitrate. Run <strong>Focus</strong> to have an agent propose clusters and
          elisions.
        </p>
      )}

      {query.clusters.map((c) => (
        <section key={c.id} className="card">
          <h3>
            <span className="pill">cluster</span>
            {c.name}
            <Verdict v={c.verdict} />
          </h3>
          <p className="prose">{c.purpose}</p>
          <p className="dim">{c.members.length} members</p>
          <div className="actions">
            <button disabled={busy === c.id} onClick={() => judge(c.id, 'cluster_verdict', true)}>
              Keep
            </button>
            <button disabled={busy === c.id} onClick={() => judge(c.id, 'cluster_verdict', false)}>
              Reject
            </button>
          </div>
        </section>
      ))}

      {query.elisions.map((e) => (
        <section key={e.id} className="card">
          <h3>
            <span className="pill">elision</span>
            <code>→ {e.into ?? '(none)'}</code>
            <Verdict v={e.verdict} />
          </h3>
          <p className="prose">{e.reason}</p>
          <p className="dim">{e.members.length} members collapsed</p>
          <div className="actions">
            <button disabled={busy === e.id} onClick={() => judge(e.id, 'elision_verdict', true)}>
              Keep
            </button>
            <button disabled={busy === e.id} onClick={() => judge(e.id, 'elision_verdict', false)}>
              Reject
            </button>
          </div>
        </section>
      ))}
    </>
  );
}

function BeliefCard({ belief, onRefresh, onArbitrate }: {
  belief: Belief;
  onRefresh: () => void;
  onArbitrate: (b: Belief) => void;
}) {
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
      {contested && (
        <div className="actions">
          <button disabled={busy} onClick={() => onArbitrate(belief)}>
            Open arbitration
          </button>
          <span className="dim">side by side, with the source each side cited</span>
        </div>
      )}
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
