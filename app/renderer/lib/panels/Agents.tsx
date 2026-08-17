import { useEffect, useMemo, useRef, useState } from 'react';
import type { Job, VdsEvent } from '../types.ts';

const LABEL: Record<string, string> = {
  get_overview: 'oriented',
  get_slice: 'read slice',
  get_open_questions: 'took questions',
  get_focus_state: 'checked focus',
  submit_claim: 'claimed',
  flag_contradiction: 'disputed',
  propose_cluster: 'clustered',
  propose_elision: 'elided',
  defend_node: 'defended',
  propose_invariant: 'proposed invariant',
};

/**
 * A running agent is quiet most of the time: it reads files with its own tools, which never
 * cross our MCP boundary, so minutes can pass with nothing to show. Without an elapsed
 * clock that is indistinguishable from a hang, and the honest signal is "how long since
 * anything happened", not "nothing is happening".
 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const since = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

export function Agents({
  events, jobs, logs, spend, selected, onSelect,
}: {
  events: VdsEvent[];
  jobs: Job[];
  logs: Record<string, string>;
  spend: Record<string, { cost: number; turns: number }>;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const running = jobs.filter((j) => j.status === 'running');
  const now = useTicker(running.length > 0);

  // Events carry the job id in their session, so a stream can be narrowed to one run.
  // With several agents going at once the combined feed is unreadable otherwise.
  const shown = useMemo(
    () => (selected ? events.filter((e) => (e.session ?? '').startsWith(selected)) : events),
    [events, selected],
  );

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [shown.length]);

  const lastFor = (id: string | null) => {
    const list = id ? events.filter((e) => (e.session ?? '').startsWith(id)) : events;
    return list.length ? list[list.length - 1].at : 0;
  };
  const lastEvent = lastFor(selected);

  return (
    <div className="stack">
      <section className="card">
        <h3>
          Jobs
          {jobs.length > 1 && (
            <button className="link" onClick={() => onSelect(null)}>
              {selected ? 'show all' : 'all shown'}
            </button>
          )}
        </h3>
        {!jobs.length && <p className="dim">Nothing has been run this session.</p>}

        {[...jobs].reverse().map((j) => {
          const isSel = selected === j.id;
          const jobLast = lastFor(j.id);
          return (
            <div
              key={j.id}
              className={isSel ? 'job-row selected' : 'job-row'}
              onClick={() => onSelect(isSel ? null : j.id)}
              title="click to show only this job's tool calls"
            >
              <span className={`pill ${j.status}`}>{j.status}</span>
              <code>{j.label}</code>
              {j.status === 'running' && j.startedAt && (
                <span className="dim">
                  {since(now - j.startedAt)}
                  {jobLast ? ` · quiet ${since(now - jobLast)}` : ''}
                </span>
              )}
              {spend[j.id] && (
                <span className="dim">
                  ${spend[j.id].cost.toFixed(2)} · {spend[j.id].turns} turns
                </span>
              )}
              {j.status === 'running' && (
                <button
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.vds.stopJob(j.id);
                  }}
                >
                  stop
                </button>
              )}
            </div>
          );
        })}

        {selected && logs[selected] && (
          <pre className="log">{logs[selected].slice(-4000)}</pre>
        )}
      </section>

      <section className="card grow">
        <h3>
          Tool calls
          {selected && <span className="pill">{selected}</span>}
          {running.length > 0 && (
            <span className="live">
              live{lastEvent ? ` · last ${since(now - lastEvent)} ago` : ''}
            </span>
          )}
        </h3>
        <p className="dim">
          Every agent writes through the MCP boundary, so this is the whole swarm in one stream —
          claims landing, evidence attached, elisions proposed. Gaps are normal: an agent reading
          files with its own tools never crosses this boundary, so quiet is not stalled.
        </p>
        <div className="feed" ref={feedRef}>
          {!shown.length && <p className="dim">No tool calls yet.</p>}
          {shown.map((e, i) => (
            <div key={i} className={e.ok === false ? 'ev-row bad' : 'ev-row'}>
              <span className="ev-time">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="ev-agent">{e.agent}{e.model ? `/${e.model}` : ''}</span>
              <span className="ev-tool">{LABEL[e.tool] ?? e.tool}</span>
              <span className="ev-what mono">
                {e.subject ?? e.node ?? e.name ?? e.into ?? ''}
                {e.predicate ? ` · ${e.predicate}` : ''}
                {e.members ? ` · ${e.members} members` : ''}
                {e.evidence ? ` · ${e.evidence} evidence` : ''}
              </span>
              {e.error && <span className="ev-err">{e.error}</span>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
