import { useEffect, useRef } from 'react';
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
              <button className="link" onClick={() => window.vds.stopJob(j.id)}>stop</button>
            )}
            {logs[j.id] && <pre className="log">{logs[j.id].slice(-2500)}</pre>}
          </div>
        ))}
      </section>

      <section className="card grow">
        <h3>
          Tool calls {running.length > 0 && <span className="live">live</span>}
        </h3>
        <p className="dim">
          Every agent writes through the MCP boundary, so this is the whole swarm in one stream —
          claims landing, evidence attached, elisions proposed.
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
