import { useMemo } from 'react';
import type { SceneNode } from '../panels/Scene.tsx';
import type { Belief, Candidate, LoadPayload } from '../types.ts';
import { fileOf, settleCost, sourceColor, sourceKey, state } from '../vocab.ts';

/**
 * The inspector.
 *
 * Everything that is not the canvas or the loop is one of these, so it has to answer the
 * same three questions for whatever is selected: what do we believe about it, what do we
 * merely know about it, and what can be done next. Beliefs come first — the static facts
 * are true but they are not the point, and putting them at the top is how the old panel
 * ended up reading as a file browser.
 */
export function Inspector({ node, beliefs, candidates, data, onBelief, onExplore }: {
  node: SceneNode | null;
  beliefs: Belief[];
  candidates: Candidate[];
  data: LoadPayload | null;
  onBelief: (b: Belief) => void;
  onExplore: (files: string[]) => void;
}) {
  const members = useMemo(() => new Set(node?.members ?? []), [node]);

  const here = useMemo(
    () => beliefs
      .filter((b) => b.subject === node?.id || members.has(fileOf(b.subject)))
      .sort((a, b) => state(a.status).rank - state(b.status).rank),
    [beliefs, members, node?.id],
  );

  const flags = useMemo(
    () => candidates.filter((c) => c.files.some((f) => members.has(f))),
    [candidates, members],
  );

  // Fan-in over the whole selection, not per file: "what depends on this thing".
  const importedBy = useMemo(() => {
    if (!node) return 0;
    const from = new Set<string>();
    for (const e of data?.fileEdges ?? []) {
      if (members.has(e.to) && !members.has(e.from)) from.add(e.from);
    }
    return from.size;
  }, [data?.fileEdges, members, node]);

  if (!node) {
    return (
      <aside className="inspector">
        <div className="rail-label">nothing selected</div>
        <p className="dim">
          Click a node on the map. Whatever you pick stays picked while you change lens, so
          you can look at the same thing four different ways without finding it again.
        </p>
      </aside>
    );
  }

  const contested = here.find((b) => b.status === 'CONTRADICTED');

  return (
    <aside className="inspector">
      <div>
        <div className="rail-label">selected</div>
        <div className="path" style={{ fontSize: 12, color: 'var(--text-hi)' }}>{node.label}</div>
        <div className="toolbar wrap" style={{ marginTop: 8 }}>
          {node.belief && (
            <span className={`pill ${state(node.belief.status).name}`}>
              {state(node.belief.status).name}
            </span>
          )}
          {flags.slice(0, 2).map((c) => (
            <span key={c.id} className="pill">candidate: {c.kind}</span>
          ))}
        </div>
      </div>

      <div>
        <div className="rail-label">beliefs here · {here.length}</div>
        {!here.length && (
          <p className="dim">
            Nothing claimed about this yet. It is on the map because it exists, not because
            anything has been established about it.
          </p>
        )}
        <div className="stack">
          {here.slice(0, 6).map((b) => {
            const st = state(b.status);
            const sources = [...new Set(b.claims.map((c) => sourceKey(c.source)))];
            return (
              <button
                key={`${b.subject}:${b.predicate}`}
                className={b.status === 'CONTRADICTED' ? 'belief-row contested' : 'belief-row'}
                onClick={() => onBelief(b)}
              >
                <div className="body">
                  <div className="claim-line">{summarise(b)}</div>
                  <div className="meta">
                    {b.claims.length} claim{b.claims.length === 1 ? '' : 's'} · {sources.join(', ')}
                  </div>
                </div>
                <div className="sources">
                  {sources.map((s) => (
                    <i key={s} style={{ background: sourceColor(s) }} title={s} />
                  ))}
                </div>
                <span className={`pill ${st.name}`}>{st.name}</span>
              </button>
            );
          })}
        </div>
        {here.length > 6 && (
          <p className="dim" style={{ marginTop: 8 }}>
            {here.length - 6} more, in the beliefs screen.
          </p>
        )}
      </div>

      <div>
        <div className="rail-label">static facts</div>
        <div className="facts">
          <div className="fact"><span className="k">files</span><span className="v">{node.fileCount}</span></div>
          <div className="fact"><span className="k">imported by</span><span className="v">{importedBy}</span></div>
          <div className="fact">
            <span className="k">origin</span>
            <span className="v">{node.origin}</span>
          </div>
          {flags.map((c) => (
            <div className="fact" key={c.id}>
              <span className="k">{c.kind}</span>
              <span className="v warn">{c.measure}</span>
            </div>
          ))}
        </div>
        {!node.purpose && (
          <p className="dim" style={{ marginTop: 8 }}>
            No agent-written purpose — this is a path grouping, i.e. filing, not intent.
          </p>
        )}
        {node.purpose && <p className="prose">{node.purpose}</p>}
      </div>

      <div>
        <div className="rail-label">act</div>
        <div className="stack">
          <button
            className="btn wide"
            onClick={() => onExplore(node.members ?? [])}
            disabled={!node.members?.length}
          >
            Explore this subtree
          </button>
          {contested && (
            <button className="btn bad wide" onClick={() => onBelief(contested)}>
              Settle the contested belief
            </button>
          )}
          {here.some((b) => b.status === 'INFERRED') && (
            <span className="dim" style={{ fontSize: 11 }}>
              {here.filter((b) => b.status === 'INFERRED').length} inferred here · about{' '}
              {Math.round(
                here.filter((b) => b.status === 'INFERRED')
                  .reduce((n, b) => n + settleCost(b.claims), 0),
              )}{' '}
              claims' worth of work to corroborate
            </span>
          )}
        </div>
      </div>

      <div className="foot">selection survives lens switches</div>
    </aside>
  );
}

/**
 * A belief as one line.
 *
 * Claim values are whatever an agent chose to write — a boolean, a sentence, or a JSON
 * object with five keys. The row has one line, so a structured value is reduced to its
 * verdict and the rest is left for the detail screen, which is built to show it properly.
 */
export function summarise(b: Belief): string {
  const v = b.value;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return `${b.predicate}: ${v ? 'yes' : 'no'}`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['verdict', 'summary', 'reason', 'purpose', 'answer']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
    return `${b.predicate} · ${Object.keys(o).length} fields`;
  }
  return b.predicate;
}
