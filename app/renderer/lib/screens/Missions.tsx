import { useState } from 'react';
import type { Mission, MissionCreateOptions, MissionList } from '../types.ts';
import { missionWord, shortId, shortRev, objectiveTitle } from './mission-words.ts';

/**
 * Mission Control, the list.
 *
 * A mission is the loop run on purpose: a question, a revision, a scope, and whatever the
 * reviewers, the experiments and you decided about it — kept. The list answers "what is in
 * flight and what is waiting on me" without opening anything, which is why state is a word
 * on every row and the rows that want a person sort first.
 */
export function Missions({
  list, error, sample, scopeDefault, busy, onOpen, onCreate, onDemoPrepare, onDemoReplay, onRefresh,
}: {
  list: MissionList | null;
  error: string | null;
  /** The bundled sample is on screen, not this machine's missions. Said out loud. */
  sample: boolean;
  /** The node selected on the map, offered as the scope of a new mission. */
  scopeDefault: string | null;
  busy: boolean;
  onOpen: (m: Mission) => void;
  onCreate: (opts: MissionCreateOptions) => Promise<void>;
  onDemoPrepare: () => void;
  onDemoReplay: () => void;
  onRefresh: () => void;
}) {
  const [kind, setKind] = useState<'explore' | 'verify'>('explore');
  const [objective, setObjective] = useState('');
  const [scope, setScope] = useState(scopeDefault ?? '');
  const [maxCost, setMaxCost] = useState(2);
  const [creating, setCreating] = useState(false);

  const missions = [...(list?.missions ?? [])].sort((a, b) => {
    const rank = (m: Mission) => (m.state === 'blocked' ? 0 : m.state === 'running' ? 1 : m.state === 'closed' ? 3 : 2);
    return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
  });
  const running = missions.filter((m) => m.state === 'running').length;
  const blocked = missions.filter((m) => m.state === 'blocked').length;

  const create = async () => {
    if (!objective.trim()) return;
    setCreating(true);
    await onCreate({
      kind,
      objective: objective.trim(),
      scope: scope.split(',').map((s) => s.trim()).filter(Boolean),
      maxCost: maxCost > 0 ? maxCost : undefined,
    });
    setCreating(false);
    setObjective('');
  };

  return (
    <div className="screen mission">
      <div className="screen-head">
        <div className="row">
          <div>
            <h2>Mission Control{sample ? ' — sample data' : ''}</h2>
            <p className="sub">
              A mission is a question asked of one revision: independent reviewers answer it,
              a disagreement becomes an experiment, the experiment produces evidence, and you
              decide. Everything a mission touched is kept and can be replayed.
              {sample && (
                <>
                  {' '}<strong>This screen is showing the bundled sample, not missions on this
                  machine.</strong>
                </>
              )}
            </p>
          </div>
          <div className="spacer" />
          <div className="toolbar">
            <button className="btn" onClick={onRefresh} disabled={busy}>refresh</button>
            <button
              className="btn warn"
              onClick={onDemoPrepare}
              disabled={busy || sample}
              title="materialise the planted-defect fixture, map it, and open a scoped mission on it"
            >
              fixture (PLANTED defect)
            </button>
            <button
              className="btn"
              onClick={onDemoReplay}
              disabled={busy || sample}
              title="import a recorded mission — real outputs from a real run, replayed"
            >
              replay recording
            </button>
            {/* The spec's second entrance. Shown so nobody thinks it was forgotten, disabled
                so nobody thinks it works: new-project onboarding is P1. */}
            <button className="btn" disabled title="New-project onboarding from intent to contracts is P1; not available in this build">
              start project (P1 — not yet)
            </button>
          </div>
        </div>
      </div>

      <div className="screen-cols">
        <div className="screen-body">
          {error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}

          {list?.project && (
            <div className="num">
              project {list.project.id} · {list.project.name} · {running} running · {blocked} blocked on you
            </div>
          )}

          {!missions.length && !error && (
            <p className="dim">
              No missions yet. Create one below, or start from the planted-defect fixture to see
              the whole loop on a repository built for it.
            </p>
          )}

          {missions.map((m) => {
            const w = missionWord(m);
            return (
              <button key={m.id} className={`mission-row ${m.state}`} onClick={() => onOpen(m)}>
                <span className={`pill ${w.tone === 'dim' ? '' : w.tone}`}>{w.name}</span>
                <span className="body">
                  <span className="claim-line" title={m.objective}>{objectiveTitle(m.objective)}</span>
                  <span className="meta">
                    {m.kind} · {shortId(m.id)} · rev {shortRev(m.baseRevision)} · {m.taskIds.length} task{m.taskIds.length === 1 ? '' : 's'}
                    {m.scope.paths?.length ? ` · scope ${m.scope.paths.slice(0, 2).join(', ')}${m.scope.paths.length > 2 ? '…' : ''}` : ''}
                    {m.outcomeReason ? ` · ${m.outcomeReason}` : ''}
                  </span>
                </span>
                <span className="num">{new Date(m.updatedAt).toLocaleString()}</span>
              </button>
            );
          })}
        </div>

        <div className="rail">
          <div className="rail-label">new mission</div>
          <div className="fields" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 4 }}>
            <label>
              kind
              <select value={kind} onChange={(e) => setKind(e.target.value as 'explore' | 'verify')} disabled={sample}>
                <option value="explore">explore — reviewers answer, disagreement surfaces</option>
                <option value="verify">verify — experiments against stated hypotheses</option>
              </select>
            </label>
            <label style={{ alignItems: 'flex-start' }}>
              objective
              <textarea
                rows={3}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="the question, as a sentence"
                disabled={sample}
              />
            </label>
            <label>
              scope
              <input
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="paths, comma separated — or select a node on the map"
                disabled={sample}
              />
            </label>
            <label>
              cost ceiling $
              <input type="number" min={0} step={0.5} value={maxCost} onChange={(e) => setMaxCost(Number(e.target.value))} disabled={sample} />
            </label>
          </div>
          <button className="btn accent wide" disabled={busy || creating || sample || !objective.trim()} onClick={() => void create()}>
            {creating ? 'creating…' : 'create mission'}
          </button>
          <p className="dim" style={{ fontSize: 11 }}>
            Creating a mission spends nothing. Running it hands the objective to the roster you
            choose on the mission, under the ceiling, read-only.
          </p>
          <div className="rail-label" style={{ marginTop: 10 }}>start project</div>
          <button className="btn" disabled title="P1 — not in this build">start from intent (coming later)</button>
          <p className="dim" style={{ fontSize: 11 }}>
            New-project onboarding from a description is not built. The button is here so the
            shape of the product is honest about what it does not do yet.
          </p>
        </div>
      </div>
    </div>
  );
}
