import { useEffect, useRef, useState } from 'react';
import type { Job, VdsEvent } from '../types.ts';

const LABEL: Record<string, string> = {
  get_overview: 'oriented',
  get_slice: 'read slice',
  get_open_questions: 'took questions',
  submit_claim: 'claimed',
  flag_contradiction: 'disputed',
  propose_cluster: 'clustered',
  propose_elision: 'elided',
  defend_node: 'defended',
  propose_invariant: 'proposed invariant',
};

/**
 * Live agent activity, streamed from the MCP server's event log rather than parsed
 * out of each CLI's stdout — every adapter writes through that one boundary.
 */
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

export function Agents({ events, jobs, logs, spend }: {
  events: VdsEvent[];
  jobs: Job[];
  logs: Record<string, string>;
  spend: Record<string, { cost: number; turns: number }>;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events.length]);

  const running = jobs.filter((j) => j.status === 'running');
  const now = useTicker(running.length > 0);
  const lastEvent = events.length ? events[events.length - 1].at : 0;

  return (
    <div className="stack">
      <section className="card">
        <h3>Jobs</h3>
        {!jobs.length && <p className="dim">Nothing has been run this session.</p>}
        {jobs.map((j) => (
          <div key={j.id} className="job">
            <span className={`pill ${j.status}`}>{j.status}</span>
            <code>{j.label}</code>
            {spend[j.id] && (
              <span className="dim">
                ${spend[j.id].cost.toFixed(2)} · {spend[j.id].turns} turns
              </span>
            )}
            {j.status === 'running' && (
              <>
                <span className="dim">
                  {j.startedAt ? since(now - j.startedAt) : ''}
                  {lastEvent ? ` · quiet ${since(now - lastEvent)}` : ''}
                </span>
                <button className="link" onClick={() => window.vds.stopJob(j.id)}>stop</button>
              </>
            )}
            {logs[j.id] && <pre className="log">{logs[j.id].slice(-2500)}</pre>}
          </div>
        ))}
      </section>

      <section className="card grow">
        <h3>
          Tool calls{' '}
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
          {!events.length && <p className="dim">No tool calls yet.</p>}
          {events.map((e, i) => (
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
