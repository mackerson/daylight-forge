import { useEffect, useMemo, useState } from 'react';
import { Console, type ReadArtifact } from '../panels/Console.tsx';
import { Evidence, type EvidenceSelection } from '../panels/Evidence.tsx';
import { Scrubber } from '../panels/Scrubber.tsx';
import type {
  Attempt, DaylightEvent, Dispute, Experiment, Job, MissionInspect, Task,
} from '../types.ts';
import { sourceColor } from '../vocab.ts';
import {
  attemptWord, conclusionWord, costWord, duration, eventLine, missionWord, shortId, shortRev,
  toRunEvents, objectiveTitle } from './mission-words.ts';
import { OUTSIDE, type ImplementTab } from './forge-words.ts';
import type { ForgeApi } from './ForgeParts.tsx';
import { ImplementDetail } from './ImplementDetail.tsx';

/**
 * One mission, end to end.
 *
 * Top to bottom this is the loop the product promises: who was asked, what each one actually
 * did (the console is the agent's own stream, not a summary of it), where they disagreed, what
 * was run to settle it, what the run observed, and the decision — which is yours, recorded
 * with a rationale and your name. The right-hand pane is "show me why" for whatever is
 * selected; the timeline at the bottom is the durable event table, and the replay feeds it
 * back through the map.
 *
 * Nothing here closes a mission on its own. A process exiting 0 moves a task; an outcome is a
 * judgement a person records.
 */
export function MissionDetail({
  inspect, events, job, jobLog, username, sample, busy, read, replaying,
  onBack, onRefresh, onRun, onStop, onDecide, onClose, onRunExperiment, onShowOnMap, onReplaying,
  forgeApi, forgeTab, forgeCandidate,
}: {
  inspect: MissionInspect | null;
  /** The live event stream for this mission, in sequence order. */
  events: DaylightEvent[];
  /** The `mission run` or `experiment run` job for this mission, if one is running. */
  job: Job | null;
  jobLog: string | null;
  username: string;
  sample: boolean;
  busy: boolean;
  read: ReadArtifact;
  replaying: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onRun: (tools: string, maxCost: number | undefined, dryRun: boolean) => void;
  onStop: () => void;
  onDecide: (p: { subject: string; predicate: string; value: unknown; rationale: string; actor: string; experiment?: string }) => Promise<string | null>;
  onClose: (outcome: string, reason: string) => Promise<string | null>;
  onRunExperiment: (id: string) => void;
  onShowOnMap: (subject: string) => void;
  onReplaying: (on: boolean) => void;
  /** Implement missions open the Forge view; these say how to reach main and where to land. */
  forgeApi?: ForgeApi;
  forgeTab?: ImplementTab | null;
  forgeCandidate?: string | null;
}) {
  const [selection, setSelection] = useState<EvidenceSelection | null>(null);
  const [openAttempt, setOpenAttempt] = useState<string | null>(null);
  const [attemptFilter, setAttemptFilter] = useState<string | null>(null);
  const [tools, setTools] = useState(() => localStorage.getItem('daylight.missionRoster') ?? 'claude:sonnet,codex');
  const [maxCost, setMaxCost] = useState(2);
  const [rationale, setRationale] = useState('');
  const [verdict, setVerdict] = useState<'true' | 'false' | 'custom'>('true');
  const [custom, setCustom] = useState('');
  // Main records every decision as the OS user and ignores any actor sent from here (S-8).
  const actor = `human:${username}`;
  const [closeOutcome, setCloseOutcome] = useState('inconclusive');
  const [closeReason, setCloseReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => { localStorage.setItem('daylight.missionRoster', tools); }, [tools]);

  // Default the evidence pane to the thing most worth looking at: a concluded experiment,
  // else the first dispute. A blank pane on open would be a pane nobody finds.
  useEffect(() => {
    if (selection || !inspect) return;
    const x = inspect.experiments.find((e) => e.conclusion !== 'pending') ?? inspect.experiments[0];
    if (x) setSelection({ kind: 'experiment', experiment: x });
    else if (inspect.disputes[0]) setSelection({ kind: 'dispute', dispute: inspect.disputes[0] });
  }, [inspect, selection]);

  const attemptsByTask = useMemo(() => {
    const by = new Map<string, Attempt[]>();
    for (const a of inspect?.attempts ?? []) {
      const list = by.get(a.taskId) ?? [];
      list.push(a);
      by.set(a.taskId, list);
    }
    for (const list of by.values()) list.sort((a, b) => a.startedAt - b.startedAt);
    return by;
  }, [inspect?.attempts]);

  const shownEvents = useMemo(
    () => (attemptFilter ? events.filter((e) => e.attemptId === attemptFilter) : events),
    [events, attemptFilter],
  );
  const replayEvents = useMemo(() => toRunEvents(events), [events]);

  if (!inspect) {
    return (
      <div className="screen">
        <div className="screen-head">
          <button className="link" onClick={onBack}>← missions</button>
          <p className="dim">reading the mission…</p>
        </div>
      </div>
    );
  }

  if (inspect.mission.kind === 'implement' && forgeApi) {
    return (
      <ImplementDetail
        key={`${inspect.mission.id}:${forgeTab ?? ''}:${forgeCandidate ?? ''}`}
        inspect={inspect} api={forgeApi} sample={sample} busy={busy}
        initialTab={forgeTab} initialCandidate={forgeCandidate} onBack={onBack} onRefresh={onRefresh}
      />
    );
  }

  const { mission, tasks, experiments, decisions, disputes } = inspect;
  const w = missionWord(mission);
  const running = job?.status === 'running';
  const closed = mission.state === 'closed';
  const dispute: Dispute | null = selection?.kind === 'dispute'
    ? selection.dispute
    : disputes[0] ?? null;
  const experimentFor = (d: Dispute | null): Experiment | undefined =>
    d ? experiments.find((x) => x.subject === d.subject && x.predicate === d.predicate) : undefined;

  const decide = async () => {
    if (!dispute) return;
    if (!rationale.trim()) { setFormError('a decision needs a rationale'); return; }
    const value = verdict === 'custom' ? custom.trim() : verdict === 'true';
    if (verdict === 'custom' && !custom.trim()) { setFormError('write the verdict, or choose yes or no'); return; }
    setFormError(null);
    const err = await onDecide({
      subject: dispute.subject, predicate: dispute.predicate, value,
      rationale: rationale.trim(), actor,
      experiment: experimentFor(dispute)?.id,
    });
    if (err) setFormError(err);
    else setRationale('');
  };

  const close = async () => {
    if (!closeReason.trim()) { setFormError('closing needs a reason'); return; }
    setFormError(null);
    const err = await onClose(closeOutcome, closeReason.trim());
    if (err) setFormError(err);
  };

  return (
    <div className="screen mission">
      <div className="screen-head">
        <div className="toolbar wrap">
          <button className="link" onClick={onBack}>← missions</button>
          <span className={`pill ${w.tone === 'dim' ? '' : w.tone}`}>{w.name}</span>
          {mission.state === 'running' && !running && !!inspect.needs?.length && (
            <span className="pill warn" title={inspect.needs.map((n) => `${n.ref}: ${n.why}`).join('\n')}>needs you</span>
          )}
          <code style={{ color: 'var(--warn)' }}>{mission.kind}</code>
          <span className="subject">{shortId(mission.id)} · project {mission.projectId} · rev {shortRev(mission.baseRevision)}</span>
          {mission.baseRevision.endsWith('+dirty') && (
            <span className="pill bad">dirty revision — not reproducible</span>
          )}
          {sample && <span className="pill">sample data</span>}
          <div className="spacer" />
          {running && (
            <button className="btn bad" onClick={onStop}>stop {job?.label}</button>
          )}
          <button className="btn" onClick={onRefresh} disabled={busy}>refresh</button>
        </div>
        <h2 style={{ marginTop: 11 }}>{objectiveTitle(mission.objective)}</h2>
        {objectiveTitle(mission.objective) !== mission.objective.trim() && (
          <details className="dim" style={{ marginTop: 4 }}>
            <summary>full brief, as handed to every reviewer</summary>
            <pre className="wrap" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12 }}>
              {mission.objective}
            </pre>
          </details>
        )}
        {mission.outcomeReason && (
          <p className="sub">{mission.state === 'blocked' ? 'blocked: ' : ''}{mission.outcomeReason}</p>
        )}
        <div className="facts" style={{ flexDirection: 'row', gap: 18, flexWrap: 'wrap', marginTop: 8 }}>
          <span className="num">scope {mission.scope.paths?.length ? mission.scope.paths.join(', ') : 'whole repository'}</span>
          <span className="num">budget {mission.budget.maxUsd ? `$${mission.budget.maxUsd.toFixed(2)}` : 'none set'}</span>
          <span className="num">
            permissions {(['read', 'write', 'execute', 'deploy'] as const).filter((k) => mission.permissions[k]).join(', ') || 'none'}
          </span>
          <span className="num">{disputes.length} dispute{disputes.length === 1 ? '' : 's'} · {experiments.length} experiment{experiments.length === 1 ? '' : 's'} · {decisions.length} decision{decisions.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      <div className="screen-cols mission-cols">
        <div className="screen-body">
          {formError && <div className="banner error" style={{ margin: 0 }}>{formError}</div>}

          {/* ---- run ---- */}
          {!closed && (
            <div className="card">
              <h3>run</h3>
              <div className="toolbar wrap">
                <label className="num">
                  roster{' '}
                  <input value={tools} onChange={(e) => setTools(e.target.value)} style={{ width: 260 }} disabled={sample || running} />
                </label>
                <label className="num">
                  ceiling ${' '}
                  <input type="number" min={0} step={0.5} value={maxCost} onChange={(e) => setMaxCost(Number(e.target.value))} style={{ width: 64 }} disabled={sample || running} />
                </label>
                <button className="btn accent" disabled={sample || running || busy} onClick={() => onRun(tools, maxCost > 0 ? maxCost : undefined, false)}>
                  run reviews
                </button>
                <button className="btn" disabled={sample || running || busy} onClick={() => onRun(tools, undefined, true)} title="show what would be asked; spawn nothing">
                  dry run
                </button>
                {running && <span className="live">running · {job?.label}</span>}
              </div>
              <p className="dim" style={{ fontSize: 11, margin: '8px 0 0' }}>
                Each roster entry is one independent reviewer, read-only, and blind to the others'
                answers until all have filed. Agreement corroborates; disagreement becomes a dispute
                below. Neither is proof.
              </p>
            </div>
          )}

          {/* ---- tasks and attempts ---- */}
          <div className="card">
            <h3>tasks · {tasks.length}</h3>
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                attempts={attemptsByTask.get(t.id) ?? []}
                openAttempt={openAttempt}
                onToggle={(id) => setOpenAttempt(openAttempt === id ? null : id)}
                onFilter={(id) => setAttemptFilter(attemptFilter === id ? null : id)}
                filtered={attemptFilter}
                jobLog={running ? jobLog : null}
                read={read}
              />
            ))}
            {!tasks.length && <p className="dim">No tasks yet. Running the mission creates one review per roster entry.</p>}
          </div>

          {/* ---- disputes ---- */}
          <div className="card">
            <h3>disputes · {disputes.length}</h3>
            {!disputes.length && (
              <p className="dim">
                {tasks.some((t) => t.role === 'compare' && t.state === 'done')
                  ? 'The reviewers did not contradict each other inside this scope. Agreement is corroboration, not proof — an experiment can still be registered.'
                  : 'Nothing compared yet.'}
              </p>
            )}
            {disputes.map((d) => {
              const x = experimentFor(d);
              const picked = selection?.kind === 'dispute' && selection.dispute === d;
              return (
                <button
                  key={`${d.subject}:${d.predicate}`}
                  className={picked ? 'belief-row contested picked' : 'belief-row contested'}
                  onClick={() => setSelection({ kind: 'dispute', dispute: d })}
                  aria-pressed={picked}
                >
                  <div className="body">
                    <div className="claim-line">{d.predicate} on {d.subject}</div>
                    <div className="meta">
                      {d.sides.map((s) => `${s.source} says ${typeof s.value === 'boolean' ? (s.value ? 'yes' : 'no') : 'see evidence'} (${s.confidence.toFixed(2)})`).join(' · ')}
                      {x ? ` · experiment ${conclusionWord(x.conclusion).name}` : ' · no experiment yet'}
                    </div>
                  </div>
                  <span className="sources">
                    {d.sides.map((s) => <i key={s.source} style={{ background: sourceColor(s.source) }} />)}
                  </span>
                  <span className="pill contested">contradicted</span>
                </button>
              );
            })}
          </div>

          {/* ---- experiments ---- */}
          <div className="card">
            <h3>experiments · {experiments.length}</h3>
            {!experiments.length && (
              <p className="dim">
                None registered. An experiment is a hypothesis, a protected test and a prediction
                written down before anything runs — register one with <code>daylight experiment propose</code>.
              </p>
            )}
            {experiments.map((x) => {
              const cw = conclusionWord(x.conclusion);
              const picked = selection?.kind === 'experiment' && selection.experiment.id === x.id;
              return (
                <div key={x.id} className={picked ? 'experiment-row picked' : 'experiment-row'}>
                  <button className="body" onClick={() => setSelection({ kind: 'experiment', experiment: x })} aria-pressed={picked}>
                    <div className="claim-line">{x.hypothesis}</div>
                    <div className="meta">
                      {x.subject} · {x.predicate} · {x.command.join(' ')} · {x.sandboxProfile} · {x.executions.length} run{x.executions.length === 1 ? '' : 's'}
                    </div>
                  </button>
                  <span className={`pill ${cw.tone === 'dim' ? '' : cw.tone}`}>{cw.name}</span>
                  {!closed && (
                    <button className="btn" disabled={sample || running || busy} onClick={() => onRunExperiment(x.id)} title="run it in the sandbox, twice, and record what happens">
                      {x.executions.length ? 'run again' : 'run'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* ---- decisions ---- */}
          <div className="card">
            <h3>decisions · {decisions.length}</h3>
            {decisions.map((d) => (
              <div className="decision-row" key={d.id}>
                <span className="pill confirmed">{d.kind}</span>
                <div className="body">
                  <div className="claim-line">
                    {d.predicate ? `${d.predicate} on ${d.subject}: ` : ''}
                    <strong>{typeof d.value === 'boolean' ? (d.value ? 'yes' : 'no') : typeof d.value === 'string' ? d.value : d.value === undefined ? '' : JSON.stringify(d.value)}</strong>
                  </div>
                  <div className="meta">{d.actor} · {new Date(d.at).toLocaleString()} · rev {shortRev(d.revision)}</div>
                  <div className="prose" style={{ fontSize: 12 }}>{d.rationale}</div>
                </div>
              </div>
            ))}
            {!closed && dispute && (
              <div className="decide-form">
                <div className="rail-label" style={{ padding: 0 }}>
                  decide · {dispute.predicate} on {dispute.subject}
                </div>
                <div className="toolbar wrap">
                  {(['true', 'false', 'custom'] as const).map((v) => (
                    <button key={v} className={verdict === v ? 'chip active' : 'chip'} onClick={() => setVerdict(v)} disabled={sample}>
                      {v === 'true' ? 'yes' : v === 'false' ? 'no' : 'state it'}
                    </button>
                  ))}
                  {verdict === 'custom' && (
                    <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="the verdict, in your words" style={{ flex: 1 }} disabled={sample} />
                  )}
                </div>
                <textarea
                  rows={3}
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                  placeholder="rationale — required. What evidence settled it, and what it does not settle."
                  disabled={sample}
                />
                <div className="toolbar wrap">
                  <span className="num">as {actor} — your OS user</span>
                  {experimentFor(dispute) && (
                    <span className="num">links experiment {shortId(experimentFor(dispute)!.id)} · {conclusionWord(experimentFor(dispute)!.conclusion).name}</span>
                  )}
                  <div className="spacer" />
                  <button className="btn accent" disabled={sample || busy || !rationale.trim()} onClick={() => void decide()}>
                    record decision
                  </button>
                </div>
                <p className="dim" style={{ fontSize: 11, margin: 0 }}>
                  Recorded as a decision on this mission and as a human claim in the store, which
                  outranks every agent. It is a decision, not a theorem: the rationale is what a
                  later reader gets.
                </p>
              </div>
            )}
            {!closed && !dispute && !decisions.length && (
              <p className="dim">Nothing to decide yet — a dispute or an experiment has to exist first.</p>
            )}
          </div>

          {/* ---- close ---- */}
          {!closed && (
            <div className="card quiet">
              <h3>close the mission</h3>
              <div className="toolbar wrap">
                <select value={closeOutcome} onChange={(e) => setCloseOutcome(e.target.value)} disabled={sample}>
                  <option value="succeeded">succeeded — acceptance met</option>
                  <option value="failed">failed</option>
                  <option value="inconclusive">inconclusive</option>
                  <option value="cancelled">cancelled</option>
                </select>
                <input value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder="reason — required" style={{ flex: 1 }} disabled={sample} />
                <button className="btn" disabled={sample || busy || !closeReason.trim()} onClick={() => void close()}>close</button>
              </div>
              <p className="dim" style={{ fontSize: 11, margin: '8px 0 0' }}>
                No process exit closes a mission. The outcome is yours to record, with a reason.
              </p>
            </div>
          )}

          {/* ---- timeline + replay ---- */}
          <div className="card">
            <h3>
              events · {events.length}
              {attemptFilter && (
                <button className="link" style={{ marginLeft: 10 }} onClick={() => setAttemptFilter(null)}>
                  showing one attempt · show all
                </button>
              )}
            </h3>
            {!events.length && <p className="dim">No events observed yet.</p>}
            <div className="stream dl-stream">
              {shownEvents.slice(-200).map((e) => (
                <div key={e.id} className={`stream-row ${e.category}`}>
                  <span className="t" title={new Date(e.at).toLocaleString()}>{String(e.sequence).padStart(4, ' ')}</span>
                  <span className="who" title={e.actorId}>{(e.actorId ?? '').replace(/^agent:/, '')}</span>
                  <span className="what">
                    <span className="dl-name">{e.name}</span> {eventLine(e)}
                  </span>
                </div>
              ))}
            </div>
            {replayEvents.length > 0 && (
              <>
                <h4>replay on the map</h4>
                <Scrubber events={replayEvents} active={replaying} onActiveChange={onReplaying} />
              </>
            )}
          </div>
        </div>

        <Evidence selection={selection} read={read} onShowOnMap={onShowOnMap} />
      </div>
    </div>
  );
}

function TaskRow({ task, attempts, openAttempt, onToggle, onFilter, filtered, jobLog, read }: {
  task: Task;
  attempts: Attempt[];
  openAttempt: string | null;
  onToggle: (id: string) => void;
  onFilter: (id: string) => void;
  filtered: string | null;
  jobLog: string | null;
  read: ReadArtifact;
}) {
  const tone = task.state === 'done' ? 'ok' : task.state === 'failed' ? 'bad' : task.state === 'running' ? 'accent' : task.state === 'blocked' ? 'bad' : '';
  return (
    <div className="task-row">
      <div className="toolbar wrap">
        <span className={`pill ${tone}`}>{task.state}</span>
        <span className="num" style={{ textTransform: 'uppercase', letterSpacing: '.08em' }}>{task.role}</span>
        <span style={{ fontSize: 12 }}>{task.objective}</span>
        {task.runnerHint && (
          <span className="num" style={{ color: sourceColor(task.runnerHint) }}>{task.runnerHint}</span>
        )}
        <div className="spacer" />
        <span className="num">{attempts.length} attempt{attempts.length === 1 ? '' : 's'}</span>
      </div>
      {attempts.map((a, i) => {
        const aw = attemptWord(a);
        const open = openAttempt === a.id;
        return (
          <div className="attempt" key={a.id}>
            <div className="toolbar wrap">
              <span className="num">#{i + 1}</span>
              <span className={`pill ${aw.tone === 'dim' ? '' : aw.tone}`}>{aw.name}</span>
              <span className="num">{a.runnerId}</span>
              {a.origin === 'ingested' && <span className="pill warn">{OUTSIDE}</span>}
              <span className="num">{costWord(a.costUsd)}</span>
              <span className="num">{duration(a)}</span>
              {a.failure && !/^timed out/.test(a.failure) && <span className="hint" style={{ fontSize: 11 }}>{a.failure}</span>}
              <div className="spacer" />
              <button className="link mono" onClick={() => onFilter(a.id)} aria-pressed={filtered === a.id}>
                {filtered === a.id ? 'events: this one' : 'events'}
              </button>
              <button className="link mono" onClick={() => onToggle(a.id)} aria-expanded={open}>
                {open ? 'hide console' : 'console'}
              </button>
            </div>
            {open && <Console attempt={a} live={jobLog} read={read} />}
          </div>
        );
      })}
    </div>
  );
}
