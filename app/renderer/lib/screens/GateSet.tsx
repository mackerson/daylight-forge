import { useMemo, useState } from 'react';
import type { MissionInspect } from '../types.ts';
import { gateSetView, RATIONALE_PRESETS, shortDigest, shortRef } from './forge-words.ts';
import { GuardOutcome, KEEP_CASE, RationalePicker, useAct, type ForgeApi } from './ForgeParts.tsx';

/**
 * What counts as done for this mission, and whether it is frozen.
 *
 * Gates are shown in full: the author is shown them too. Holdouts are a number and nothing
 * else — `gateSetView` drops them before this component sees the list, so no render path here
 * can show a holdout's hypothesis, command or digest. A lock is a human decision naming a
 * digest over every gate's harness; a harness that changes afterwards makes it stale, and the
 * screen says so rather than trusting the old lock.
 */
export function GateSet({ inspect, api, sample, onDone }: {
  inspect: MissionInspect;
  api: ForgeApi;
  sample: boolean;
  onDone: () => void;
}) {
  const view = useMemo(
    () => gateSetView(inspect.experiments, inspect.decisions, inspect.gateEvaluations ?? []),
    [inspect.experiments, inspect.decisions, inspect.gateEvaluations],
  );
  const vacuous = view.gates.filter((g) => g.vacuous);
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(() => new Set());
  const [rationale, setRationale] = useState(RATIONALE_PRESETS.lock[0]);
  const [pending, result, run] = useAct();
  const closed = inspect.mission.state === 'closed';
  const unaccepted = vacuous.filter((g) => !accepted.has(g.id));
  const lockBlocked = closed ? 'the mission is closed'
    : !view.gates.length ? 'there are no gates to lock'
    : unaccepted.length ? `${unaccepted.length} gate${unaccepted.length === 1 ? '' : 's'} already pass at base; accept each by name, or remove it`
    : !rationale.trim() ? 'a lock needs a rationale'
    : null;

  return (
    <div className="stack" data-forge="gates">
      <div className={`card ${view.lock.state === 'locked' ? 'ok' : view.lock.state === 'stale' ? 'bad' : 'warn'}`}>
        <h3>gate set</h3>
        <div className="toolbar wrap">
          {view.lock.state === 'locked' && (
            <>
              <span style={KEEP_CASE} className="pill ok">locked by {shortRef(view.lock.decisionId)}</span>
              <span className="num">{view.lock.actor} · gate set {shortDigest(view.lock.digest)}</span>
            </>
          )}
          {view.lock.state === 'stale' && (
            <>
              <span style={KEEP_CASE} className="pill bad">stale lock — {view.lock.why}</span>
              <span className="num">was {shortRef(view.lock.decisionId)} · {view.lock.actor} · {shortDigest(view.lock.digest)}</span>
            </>
          )}
          {view.lock.state === 'unlocked' && <span className="pill warn">unlocked — forge run needs a lock</span>}
          <div className="spacer" />
          <span className="pill" data-forge="holdout-count">{view.holdoutCount} holdout{view.holdoutCount === 1 ? '' : 's'} · content withheld</span>
        </div>
        <p className="dim" style={{ fontSize: 11, margin: '8px 0 0' }}>
          Holdouts run on every candidate but are never shown to the author or on this screen;
          only how many there are, and whether they passed.
        </p>
      </div>

      <div className="card">
        <h3>gates · {view.gates.length}</h3>
        <table className="grid">
          <thead>
            <tr><th>gate</th><th>hypothesis</th><th>harness</th><th>baseline</th><th>vacuous</th></tr>
          </thead>
          <tbody>
            {view.gates.map((g) => (
              <tr key={g.id}>
                <td className="mono">{shortRef(g.id)}</td>
                <td style={{ color: 'var(--text)' }}>{g.hypothesis}</td>
                <td className="mono">{shortDigest(g.harnessDigest)}</td>
                <td>
                  <span className={`pill ${g.baseline === 'falsified' ? 'ok' : g.baseline === 'supported' ? 'warn' : ''}`}>
                    {g.baseline === 'falsified' ? 'fails at base' : g.baseline === 'supported' ? 'passes at base' : g.baseline}
                  </span>
                </td>
                <td>{g.vacuous ? <span className="pill warn">{g.acceptedAtLock ? 'vacuous · accepted at lock' : 'vacuous'}</span> : <span className="num">no</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!view.gates.length && <p className="dim">No gates registered. A gate is an acceptance test the author is shown.</p>}
        <p className="dim" style={{ fontSize: 11, margin: '8px 0 0' }}>
          A usable gate fails at base for the reason the work item names. One that already passes
          cannot tell a change from no change.
        </p>
      </div>

      {!closed && view.lock.state !== 'locked' && (
        <div className="card">
          <h3>{view.lock.state === 'stale' ? 'lock again' : 'lock gates'}</h3>
          {!!vacuous.length && (
            <div className="toolbar wrap" style={{ marginBottom: 8 }}>
              <span className="num">accept by name</span>
              {vacuous.map((g) => {
                const on = accepted.has(g.id);
                return (
                  <button
                    key={g.id}
                    className={on ? 'chip active' : 'chip'}
                    aria-pressed={on}
                    onClick={() => setAccepted((s) => {
                      const next = new Set(s);
                      if (on) next.delete(g.id); else next.add(g.id);
                      return next;
                    })}
                  >
                    {on ? 'accepted' : 'accept'} vacuous {shortRef(g.id)}
                  </button>
                );
              })}
            </div>
          )}
          <RationalePicker presets={RATIONALE_PRESETS.lock} value={rationale} onChange={setRationale} />
          <div className="toolbar wrap" style={{ marginTop: 8 }}>
            <button
              className="btn accent"
              disabled={pending || !!lockBlocked}
              onClick={() => void run(async () => {
                const r = await api.lockGates({ id: inspect.mission.id, rationale: rationale.trim(), acceptVacuous: [...accepted] });
                if (r.ok) onDone();
                return r;
              })}
            >
              {pending ? 'asking…' : 'lock gates'}
            </button>
            {lockBlocked && <span className="hint" style={{ fontSize: 11 }}>{lockBlocked}</span>}
          </div>
          <GuardOutcome result={result} sample={sample} />
        </div>
      )}
    </div>
  );
}
