import { useMemo, useState } from 'react';
import { Findings } from '../panels/Findings.tsx';
import type { Belief, Candidate, CandidateKind, LoadPayload, QueryPayload } from '../types.ts';
import { state } from '../vocab.ts';

/**
 * Detect.
 *
 * The static pass is fast, free and wrong a useful fraction of the time, and the interface
 * has to carry that or the numbers become verdicts by default. So every row is phrased as a
 * question, the measurement sits in the corner as a measurement, and the only real action
 * is to hand it to something that can actually read the code.
 *
 * The one destructive-looking action — dismissing — is honest about what it does: it writes
 * your answer as a claim, which is what stops the frontier asking again.
 */

const KIND_LABEL: Record<CandidateKind, string> = {
  duplication: 'duplication',
  unreachable: 'unreachable',
  'unused-export': 'unused export',
  overlap: 'overlap',
  divergence: 'divergence',
  tangle: 'cycle',
  hub: 'hub',
};

export function Detect({
  data, query, candidates, selected, onSelected, onExplore, onRefresh, onOpenBelief,
}: {
  data: LoadPayload;
  query: QueryPayload | null;
  candidates: Candidate[];
  selected: ReadonlySet<string>;
  onSelected: (ids: ReadonlySet<string>) => void;
  onExplore: (subjects: string[]) => void;
  onRefresh: () => void;
  /** A candidate somebody already answered opens where the answer is, not where the row is. */
  onOpenBelief: (b: Belief) => void;
}) {
  const [kind, setKind] = useState<CandidateKind | 'all'>('all');
  const [busy, setBusy] = useState(false);

  // A candidate someone has already answered is not a candidate any more; it stays visible
  // with its verdict rather than vanishing, because a list that quietly shrinks is a list
  // you cannot audit.
  const verdicts = useMemo(() => {
    const byKey = new Map<string, Belief>();
    for (const b of query?.beliefs ?? []) byKey.set(`${b.subject}\u0000${b.predicate}`, b);
    return byKey;
  }, [query?.beliefs]);

  const verdictFor = (c: Candidate): Belief | undefined => {
    for (const s of c.subjects) {
      const b = verdicts.get(`${s}\u0000${c.predicate}`);
      if (b) return b;
    }
    return undefined;
  };

  const counts = useMemo(() => {
    const m = new Map<CandidateKind, number>();
    for (const c of candidates) m.set(c.kind, (m.get(c.kind) ?? 0) + 1);
    return m;
  }, [candidates]);

  const shown = kind === 'all' ? candidates : candidates.filter((c) => c.kind === kind);
  const picked = candidates.filter((c) => selected.has(c.id));
  const questions = picked.flatMap((c) => c.subjects);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelected(next);
  };

  /**
   * Dismissal is a human claim, not a delete.
   *
   * Answering the verdict false is exactly what "not interesting" means to the scheduler —
   * a confirmed belief has zero uncertainty, so the frontier stops offering it — and it
   * leaves a record of who decided and when, which deleting a row would not.
   */
  const dismiss = async () => {
    setBusy(true);
    for (const c of picked) {
      for (const s of c.subjects) {
        await window.daylight.arbitrate({
          subject: s,
          predicate: c.predicate,
          value: false,
          note: 'dismissed in detect — not worth an agent',
        });
      }
    }
    setBusy(false);
    onSelected(new Set());
    onRefresh();
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>Candidates</h2>
            <p className="sub">
              Machine-found suspicion, not judgment. Agents decide; you arbitrate.
            </p>
          </div>
          <div className="spacer" />
          <span className="num">
            {data.structure?.stats
              ? `${data.structure.stats.files} files scanned · ${data.structure.stats.unreachable} unreachable`
              : 'static pass'}{' '}
            · 0.0s of agent time
          </span>
        </div>
      </div>

      <div className="screen-cols">
        <div className="screen-body">
          <div className="toolbar wrap">
            <button
              className={kind === 'all' ? 'chip active' : 'chip'}
              onClick={() => setKind('all')}
            >
              all {candidates.length}
            </button>
            {[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
              <button
                key={k}
                className={kind === k ? 'chip active' : 'chip'}
                onClick={() => setKind(k)}
              >
                {KIND_LABEL[k]} {n}
              </button>
            ))}
          </div>

          {!candidates.length && (
            <p className="dim">
              The static pass found nothing to ask about. That is a real result on a small or
              a tidy tree — but check the map is fresh before believing it.
            </p>
          )}

          {shown.map((c) => {
            const v = verdictFor(c);
            return (
              <button
                key={c.id}
                className="cand"
                aria-pressed={selected.has(c.id)}
                onClick={() => toggle(c.id)}
              >
                <span className="box" />
                <span className="body">
                  <span className="top">
                    <span className="kind">{KIND_LABEL[c.kind]}</span>
                    <span className="where">{c.where}</span>
                    <span className="measure">{c.measure}</span>
                  </span>
                  <span className="q">{c.question}</span>
                  <span className="ev">evidence · {c.evidence.join(' · ')}</span>
                  {v && (
                    <span className="top" style={{ marginTop: 8 }}>
                      <span className={`pill ${state(v.status).name}`}>{state(v.status).name}</span>
                      <span className="num">
                        {v.claims.length} claim{v.claims.length === 1 ? '' : 's'} from{' '}
                        {new Set(v.claims.map((c) => c.source.tool ?? c.source.kind)).size} source
                        {new Set(v.claims.map((c) => c.source.tool ?? c.source.kind)).size === 1 ? '' : 's'}
                      </span>
                    </span>
                  )}
                </span>
              </button>
            );
          })}

          {/* Nothing is hidden by a cap — but the detailed detector output is a different
              kind of reading, so it is a disclosure rather than a wall. */}
          <details className="raw">
            <summary>raw detector output</summary>
            <div>
              <Findings data={data} query={query} onRefresh={onRefresh} onArbitrate={onOpenBelief} />
            </div>
          </details>
        </div>

        <div className="rail">
          <div className="rail-label">{picked.length} selected</div>
          {!picked.length && (
            <p className="dim">
              Pick the ones worth an agent's time. Everything here is cheap to produce and
              cheap to be wrong about; reading the actual code is the part that costs.
            </p>
          )}

          {picked.length > 0 && (
            <>
              <p className="dim">
                Send {picked.length === 1 ? 'it' : 'them'} to <strong>explore</strong> and
                agents will read the actual code, then either agree — or disagree, which is
                the signal you want.
              </p>
              <div className="card">
                <div className="rail-label">
                  becomes {questions.length} question{questions.length === 1 ? '' : 's'}
                </div>
                <ol className="order-steps" style={{ padding: 0, margin: '8px 0 0' }}>
                  {picked.slice(0, 6).map((c, i) => (
                    <li key={c.id}>{i + 1} · {c.question}</li>
                  ))}
                </ol>
                {picked.length > 6 && (
                  <p className="dim" style={{ marginTop: 6 }}>+{picked.length - 6} more</p>
                )}
              </div>

              <div className="spacer" />

              <button className="btn ok wide" onClick={() => onExplore(questions)}>
                Set up explore →
              </button>
              <button className="btn wide" disabled={busy} onClick={dismiss}>
                Dismiss — not worth asking
              </button>
              <p className="dim" style={{ fontSize: 11 }}>
                Dismissing records your answer as a claim, so the scheduler stops offering it.
                It is a decision with your name on it, not a hidden row.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
