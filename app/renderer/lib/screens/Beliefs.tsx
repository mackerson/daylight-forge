import { useMemo, useState } from 'react';
import { summarise } from '../shell/Inspector.tsx';
import type { Belief, ClaimStatus, QueryPayload } from '../types.ts';
import { LADDER, settleCost, sourceColor, sourceKey, state } from '../vocab.ts';

/**
 * Beliefs — the triage screen, and the only queue that matters.
 *
 * The ladder is across the top as four tiles rather than described in a legend, because the
 * state a belief is in *is* the reason to look at it: contested wants a decision, inferred
 * wants a second source, corroborated wants nothing, confirmed is done. Reading the counts
 * left to right tells you what the run bought and what it left for you.
 *
 * Order is not alphabetical and not by time. Contested first, then inferred sorted cheapest
 * to settle, because the two questions this screen answers are "what is blocked on me" and
 * "what is the least work that moves something".
 */
export function Beliefs({ query, onOpen, onCorroborate, onRefresh }: {
  query: QueryPayload | null;
  onOpen: (b: Belief) => void;
  onCorroborate: (subjects: string[]) => void;
  onRefresh: () => void;
}) {
  const [only, setOnly] = useState<ClaimStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const beliefs = query?.beliefs ?? [];

  const counts = useMemo(() => {
    const m = new Map<ClaimStatus, number>();
    for (const b of beliefs) m.set(b.status, (m.get(b.status) ?? 0) + 1);
    return m;
  }, [beliefs]);

  const ordered = useMemo(() => {
    const list = only ? beliefs.filter((b) => b.status === only) : beliefs;
    return [...list].sort((a, b) => {
      const d = state(a.status).rank - state(b.status).rank;
      if (d !== 0) return d;
      // Within a rung: cheapest to move first.
      return settleCost(a.claims) - settleCost(b.claims);
    });
  }, [beliefs, only]);

  const accept = async (b: Belief) => {
    setBusy(`${b.subject}:${b.predicate}`);
    await window.vds.arbitrate({
      subject: b.subject,
      predicate: b.predicate,
      value: b.value,
      note: 'accepted as stated, without a second source',
    });
    setBusy(null);
    onRefresh();
  };

  if (!query) return <div className="empty"><h2>Loading…</h2></div>;

  if (!beliefs.length) {
    return (
      <div className="empty">
        <h2>Nothing claimed yet</h2>
        <p>
          The map says what is <em>there</em>. A belief is something an agent read the source
          and asserted, with the lines it read attached — so this screen stays empty until a
          run has happened.
        </p>
        <p className="dim">
          Detect first if you want to choose the questions; otherwise the scheduler picks the
          ones where an answer would change the most.
        </p>
      </div>
    );
  }

  const contested = counts.get('CONTRADICTED') ?? 0;

  return (
    <div className="screen">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>Beliefs</h2>
            <p className="sub">
              {beliefs.length} held.{' '}
              {contested
                ? `${contested} of them are contested and nothing downstream should move until you settle ${contested === 1 ? 'it' : 'them'}.`
                : 'None contested — every source that has spoken agrees with the others.'}
            </p>
          </div>
        </div>
      </div>

      <div className="screen-body">
        <div className="ladder">
          {LADDER.map((s) => {
            const st = state(s);
            return (
              <button
                key={s}
                className={`ladder-tile ${st.name}`}
                aria-pressed={only === s}
                onClick={() => setOnly(only === s ? null : s)}
              >
                <div className="top">
                  <i className="swatch" style={{ background: swatch(st.tone) }} />
                  <span className="name">{st.name}</span>
                </div>
                <div className="n">{counts.get(s) ?? 0}</div>
                <div className="why">{st.why}</div>
              </button>
            );
          })}
        </div>

        {only && (
          <p className="dim">
            Showing {state(only).name} only.{' '}
            <button className="link" onClick={() => setOnly(null)}>show every state</button>
          </p>
        )}

        <Rows
          rows={ordered}
          busy={busy}
          onOpen={onOpen}
          onAccept={accept}
          onCorroborate={onCorroborate}
        />
      </div>
    </div>
  );
}

function Rows({ rows, busy, onOpen, onAccept, onCorroborate }: {
  rows: Belief[];
  busy: string | null;
  onOpen: (b: Belief) => void;
  onAccept: (b: Belief) => void;
  onCorroborate: (subjects: string[]) => void;
}) {
  const out: React.ReactNode[] = [];
  let last: ClaimStatus | null = null;

  for (const b of rows) {
    if (b.status !== last) {
      last = b.status;
      out.push(
        <div className="group-label" key={`h-${b.status}`}>
          {state(b.status).name} · {state(b.status).why}
        </div>,
      );
    }

    const key = `${b.subject}:${b.predicate}`;
    const sources = [...new Set(b.claims.map((c) => sourceKey(c.source)))];
    const contested = b.status === 'CONTRADICTED';

    out.push(
      <div
        className={contested ? 'belief-row contested' : 'belief-row'}
        key={key}
        onClick={() => onOpen(b)}
        role="button"
        tabIndex={0}
      >
        <div className="body">
          <div className="claim-line">{summarise(b)}</div>
          <div className="meta">
            {b.subject} · {b.claims.length} claim{b.claims.length === 1 ? '' : 's'} ·{' '}
            {sources.join(', ')}
            {contested && ' · they do not agree'}
          </div>
        </div>

        <div className="sources">
          {sources.map((s) => (
            <i key={s} style={{ background: sourceColor(s) }} title={s} />
          ))}
        </div>

        {contested && (
          <button className="btn bad" onClick={(e) => { e.stopPropagation(); onOpen(b); }}>
            Settle
          </button>
        )}
        {b.status === 'INFERRED' && (
          <>
            <button
              className="btn"
              onClick={(e) => { e.stopPropagation(); onCorroborate([b.subject]); }}
              title="ask a second, independent source the same question"
            >
              Corroborate
            </button>
            <button
              className="btn"
              disabled={busy === key}
              onClick={(e) => { e.stopPropagation(); onAccept(b); }}
              title="confirm it yourself — your call outranks every agent"
            >
              Accept as-is
            </button>
          </>
        )}
        {b.status === 'CONFIRMED' && <span className="pill confirmed">locked</span>}
        {b.status === 'CORROBORATED' && (
          <span className="num">{b.confidence.toFixed(2)}</span>
        )}
      </div>,
    );
  }

  return <>{out}</>;
}

const swatch = (tone: string): string =>
  tone === 'ok' ? 'var(--ok-mark)'
    : tone === 'bad' ? 'var(--bad-mark)'
      : tone === 'warn' ? 'var(--warn-mark)'
        : tone === 'accent' ? 'var(--accent-mark)'
          : 'var(--mark)';
