import { useMemo, useState } from 'react';
import type { Attempt, MissionInspect } from '../types.ts';
import {
  attemptCost, budgetWord, EXEC_RULE, gateSetView, IMPLEMENT_RUNNERS, latestDecision, OPEN_ITEMS, RATIONALE_PRESETS,
  sandboxBadges, shortDigest, shortRef, tokens, verdictWord, type ImplementTab,
} from './forge-words.ts';
import { Badges, Choice, GuardOutcome, KEEP_CASE, RationalePicker, toneClass, useAct, type ForgeApi } from './ForgeParts.tsx';
import { attemptWord, duration, missionWord, objectiveTitle, shortRev } from './mission-words.ts';
import { GateSet } from './GateSet.tsx';
import { CandidateReview } from './CandidateReview.tsx';

/**
 * An implement mission: the one kind that writes.
 *
 * Write is a mode here, not a fault (R7). It is granted by one human authorize decision, and
 * every attempt says what it was given: profile, write with the decision and the person who
 * granted it, exec (only when that decision granted it, R17.1), network. The questions the
 * owner has not answered yet are on screen as open, not hidden until they are (R9).
 */
export function ImplementDetail({ inspect, api, sample, busy, initialTab, initialCandidate, onBack, onRefresh }: {
  inspect: MissionInspect;
  api: ForgeApi;
  sample: boolean;
  busy: boolean;
  initialTab?: ImplementTab | null;
  initialCandidate?: string | null;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const { mission } = inspect;
  const candidates = inspect.candidates ?? [];
  const [tab, setTab] = useState<ImplementTab>(initialTab ?? 'attempts');
  const [picked, setPicked] = useState<string | null>(initialCandidate ?? candidates[0]?.id ?? null);
  const w = missionWord(mission);
  const auth = latestDecision(inspect.decisions, 'authorize-mission');
  const grant = auth?.scope as { permissions?: { write?: boolean; execute?: boolean }; maxUsd?: number | null } | undefined;
  const gates = useMemo(
    () => gateSetView(inspect.experiments, inspect.decisions, inspect.gateEvaluations ?? []),
    [inspect.experiments, inspect.decisions, inspect.gateEvaluations],
  );

  return (
    <div className="screen mission" data-forge="implement">
      <div className="screen-head">
        <div className="toolbar wrap">
          <button className="link" onClick={onBack}>← missions</button>
          <span className={`pill ${toneClass(w.tone)}`}>{w.name}</span>
          {!!inspect.needs?.length && (
            <span className="pill warn" title={inspect.needs.map((n) => `${n.ref}: ${n.why}`).join('\n')}>
              {inspect.needs.length} need you
            </span>
          )}
          <code style={{ color: 'var(--warn)' }}>implement</code>
          <span className="subject">{shortRef(mission.id)} · project {mission.projectId} · rev {shortRev(mission.baseRevision)}</span>
          <span style={KEEP_CASE} className="pill">{budgetWord(mission)}</span>
          <span style={KEEP_CASE} className="pill">{mission.workItemId ? `work item ${shortRef(mission.workItemId)}` : 'ad hoc — no work item'}</span>
          {sample && <span className="pill">sample data</span>}
          <div className="spacer" />
          <button className="btn" onClick={onRefresh} disabled={busy}>refresh</button>
        </div>
        <h2 style={{ marginTop: 11 }}>{objectiveTitle(mission.objective)}</h2>
        <div className="toolbar wrap" style={{ marginTop: 8 }}>
          <span className="num">grant</span>
          {auth ? (
            <>
              <span style={KEEP_CASE} className={`pill ${grant?.permissions?.write ? 'warn' : ''}`}>
                {grant?.permissions?.write ? `write on — ${shortRef(auth.id)} ${auth.actor}` : 'write off'}
              </span>
              <span className="pill" title={grant?.permissions?.execute ? EXEC_RULE : undefined}>{grant?.permissions?.execute ? 'exec on' : 'exec off'}</span>
              <span style={KEEP_CASE} className="pill">maxUsd {grant?.maxUsd === null || grant?.maxUsd === undefined ? 'unchanged' : `$${grant.maxUsd.toFixed(2)}`}</span>
            </>
          ) : <span className="pill warn">not authorized — read-only until a person authorizes it</span>}
          <span className="num">gates</span>
          <span style={KEEP_CASE} className={`pill ${gates.lock.state === 'locked' ? 'ok' : gates.lock.state === 'stale' ? 'bad' : 'warn'}`}>
            {gates.lock.state === 'locked' ? `locked ${shortDigest(gates.lock.digest)}` : gates.lock.state === 'stale' ? 'stale lock' : 'unlocked'}
          </span>
          <span className="pill">{gates.holdoutCount} holdout{gates.holdoutCount === 1 ? '' : 's'}</span>
        </div>
        <div className="toolbar wrap" style={{ marginTop: 10 }}>
          <Choice
            options={[
              { value: 'attempts', label: `attempts · ${inspect.attempts.length}` },
              { value: 'gates', label: `gates · ${gates.gates.length}` },
              { value: 'candidate', label: `candidates · ${candidates.length}` },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </div>

      <div className="screen-body">
        <div className="toolbar wrap" data-forge="open-items">
          <span className="num">open items</span>
          {OPEN_ITEMS.map((o) => (
            <span key={o.id} className="pill warn" style={KEEP_CASE} title={o.text}>open · {o.text.split(':')[0]}</span>
          ))}
        </div>

        {tab === 'attempts' && (
          <>
            {mission.state !== 'closed' && <Authorize inspect={inspect} api={api} sample={sample} onDone={onRefresh} authorized={!!auth} />}
            {mission.state !== 'closed' && <RunAuthor inspect={inspect} api={api} sample={sample} locked={gates.lock.state === 'locked'} authorized={!!grant?.permissions?.write} />}
            <div className="card">
              <h3>tasks · {inspect.tasks.length}</h3>
              {inspect.tasks.map((t) => {
                const attempts = inspect.attempts.filter((a) => a.taskId === t.id).sort((a, b) => a.startedAt - b.startedAt);
                return (
                  <div className="task-row" key={t.id}>
                    <div className="toolbar wrap">
                      <span className={`pill ${t.state === 'done' ? 'ok' : t.state === 'failed' || t.state === 'blocked' ? 'bad' : t.state === 'running' ? 'accent' : ''}`}>{t.state}</span>
                      <span className="num" style={{ textTransform: 'uppercase', letterSpacing: '.08em' }}>{t.role}</span>
                      <span style={{ fontSize: 12 }}>{t.objective}</span>
                      <div className="spacer" />
                      <span className="num">{attempts.length} attempt{attempts.length === 1 ? '' : 's'}</span>
                    </div>
                    {attempts.map((a, i) => <AttemptRow key={a.id} attempt={a} index={i} inspect={inspect} />)}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {tab === 'gates' && <GateSet inspect={inspect} api={api} sample={sample} onDone={onRefresh} />}

        {tab === 'candidate' && (
          <>
            <div className="card">
              <h3>candidates · {candidates.length}</h3>
              <div className="toolbar wrap">
                {candidates.map((c) => {
                  const v = verdictWord(c.verdict);
                  return (
                    <button key={c.id} className={picked === c.id ? 'chip active' : 'chip'} aria-pressed={picked === c.id} onClick={() => setPicked(c.id)}>
                      {shortRef(c.id)} · {v.name} · {c.files.length} file{c.files.length === 1 ? '' : 's'}
                    </button>
                  );
                })}
              </div>
              {!candidates.length && <p className="dim">No candidates yet. A forge run produces one per author attempt.</p>}
            </div>
            {picked && <CandidateReview id={picked} inspect={inspect} api={api} sample={sample} onDone={onRefresh} />}
          </>
        )}
      </div>
    </div>
  );
}

function AttemptRow({ attempt: a, index, inspect }: { attempt: Attempt; index: number; inspect: MissionInspect }) {
  const aw = attemptWord(a);
  return (
    <div className="attempt" data-forge="attempt">
      <div className="toolbar wrap">
        <span className="num">#{index + 1}</span>
        <span className={`pill ${toneClass(aw.tone)}`}>{aw.name}</span>
        <span className="num">{a.runnerId}{a.model ? ` (${a.model})` : ''}</span>
        <span className="num">{attemptCost(a)}</span>
        <span className="num">tokens in {tokens(a.tokens?.input)} · out {tokens(a.tokens?.output)}</span>
        <span className="num">{duration(a)}</span>
      </div>
      <div className="toolbar wrap" style={{ marginTop: 4 }}>
        <Badges badges={sandboxBadges(a, inspect.decisions)} />
        {a.gateSetDigest && <span className="num">gates {shortDigest(a.gateSetDigest)}</span>}
        {a.credential && (
          <span className="num">
            credential {a.credential.present ? `present${a.credential.label ? ` · ${a.credential.label}` : ''}` : 'none'}
          </span>
        )}
        {a.failure && <span className="hint" style={{ fontSize: 11 }}>{a.failure}</span>}
      </div>
    </div>
  );
}

function Authorize({ inspect, api, sample, onDone, authorized }: {
  inspect: MissionInspect; api: ForgeApi; sample: boolean; onDone: () => void; authorized: boolean;
}) {
  const [write, setWrite] = useState<'on' | 'off'>('on');
  const [exec, setExec] = useState<'on' | 'off'>('off');
  const [budget, setBudget] = useState<'1' | '2' | '5' | 'keep'>('2');
  const [rationale, setRationale] = useState(RATIONALE_PRESETS.authorize[0]);
  const [pending, result, run] = useAct();
  return (
    <div className="card" data-forge="authorize">
      <h3>{authorized ? 'authorize again' : 'authorize'}</h3>
      <div className="toolbar wrap">
        <span className="num">write</span>
        <Choice options={[{ value: 'on', label: 'write on' }, { value: 'off', label: 'write off' }]} value={write} onChange={(v) => { setWrite(v); if (v === 'off') setExec('off'); }} />
        <span className="num">exec</span>
        <Choice
          options={[{ value: 'off', label: 'exec off' }, { value: 'on', label: 'exec on', disabled: write === 'off' ? 'exec needs write' : false }]}
          value={exec}
          onChange={setExec}
        />
        <span className="hint" style={{ fontSize: 11 }} title={EXEC_RULE}>exec: granted here only; nested sandbox, no network (R17.1)</span>
        <span className="num">maxUsd</span>
        <Choice
          options={[{ value: '1', label: '$1' }, { value: '2', label: '$2' }, { value: '5', label: '$5' }, { value: 'keep', label: 'keep current' }]}
          value={budget}
          onChange={setBudget}
        />
      </div>
      <div style={{ marginTop: 8 }}>
        <RationalePicker presets={RATIONALE_PRESETS.authorize} value={rationale} onChange={setRationale} />
      </div>
      <div className="toolbar wrap" style={{ marginTop: 8 }}>
        <button
          className="btn warn"
          disabled={pending || !rationale.trim()}
          onClick={() => void run(async () => {
            const r = await api.authorize({
              id: inspect.mission.id, write: write === 'on', exec: exec === 'on',
              maxUsd: budget === 'keep' ? null : Number(budget), rationale: rationale.trim(),
            });
            if (r.ok) onDone();
            return r;
          })}
        >
          {pending ? 'asking…' : 'authorize'}
        </button>
        {!rationale.trim() && <span className="hint" style={{ fontSize: 11 }}>authorizing needs a rationale</span>}
        <span className="dim" style={{ fontSize: 11 }}>the only act that turns write on; recorded as your OS user</span>
      </div>
      <GuardOutcome result={result} sample={sample} />
    </div>
  );
}

function RunAuthor({ inspect, api, sample, locked, authorized }: {
  inspect: MissionInspect; api: ForgeApi; sample: boolean; locked: boolean; authorized: boolean;
}) {
  const firstAvailable = IMPLEMENT_RUNNERS.find((r) => r.available)?.tool ?? 'mock';
  const [tool, setTool] = useState(firstAvailable);
  const [ceiling, setCeiling] = useState<'0.5' | '1' | '2'>('1');
  const [note, setNote] = useState<string | null>(null);
  const blocked = sample ? 'the sample is on screen'
    : !authorized ? 'forge run needs write granted by an authorize decision'
    : !locked ? 'forge run needs a locked gate set'
    : null;
  return (
    <div className="card" data-forge="run">
      <h3>run an author</h3>
      <div className="toolbar wrap">
        <Choice
          options={IMPLEMENT_RUNNERS.map((r) => ({ value: r.tool, label: r.available ? r.tool : `${r.tool} — ${r.why}`, disabled: r.available ? false : r.why }))}
          value={tool}
          onChange={setTool}
        />
        <span className="num">ceiling</span>
        <Choice options={[{ value: '0.5', label: '$0.50' }, { value: '1', label: '$1' }, { value: '2', label: '$2' }]} value={ceiling} onChange={setCeiling} />
        <button
          className="btn accent"
          disabled={!!blocked}
          onClick={async () => {
            const r = await api.run({ id: inspect.mission.id, tool, maxCost: Number(ceiling) });
            setNote(r.error ?? `started ${r.id}`);
          }}
        >
          run author
        </button>
        {blocked && <span className="hint" style={{ fontSize: 11 }}>{blocked}</span>}
      </div>
      <p className="dim" style={{ fontSize: 11, margin: '8px 0 0' }}>
        {IMPLEMENT_RUNNERS.filter((r) => !r.available).map((r) => `${r.tool}: ${r.why}`).join(' · ')}. The author
        writes in a detached workspace under the author sandbox; the gates decide, not its account.
      </p>
      {note && <p className="num">{note}</p>}
    </div>
  );
}
