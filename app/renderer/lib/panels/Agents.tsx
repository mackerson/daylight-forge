import { useEffect, useMemo, useRef, useState } from 'react';
import type { Job, RunRecord, VdsEvent } from '../types.ts';

/** Tool calls that put something in the store, as opposed to reading it. */
const WRITES = new Set([
  'submit_claim', 'flag_contradiction', 'propose_cluster', 'propose_elision',
  'defend_node', 'propose_invariant',
]);

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
  events, jobs, logs, spend, selected, onSelect, leases, runs,
}: {
  events: VdsEvent[];
  jobs: Job[];
  logs: Record<string, string>;
  spend: Record<
    string,
    { cost: number; turns: number; sources?: Array<{ source: string; cost: number; turns: number }> }
  >;
  selected: string | null;
  onSelect: (id: string | null) => void;
  leases: Array<{ subject: string; session: string; until: number }>;
  runs: RunRecord[];
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

  /**
   * Which sources have actually written during a run, and how much each has done.
   *
   * Every agent used to record itself as the same "multi" source, so a three-agent run was
   * one undifferentiated stream and there was no way to see that one of them had gone quiet
   * or was doing nothing. Now the events name their own tool and model, which is the same
   * key the belief calculus counts independence by — so this is a live view of whether the
   * run is producing corroboration or three copies of one opinion.
   */
  const sourcesIn = (id: string | null) => {
    const list = id ? events.filter((e) => (e.session ?? '').startsWith(id)) : events;
    const by = new Map<string, { calls: number; writes: number; last: number }>();
    for (const e of list) {
      const key = `${e.agent ?? '?'}/${e.model ?? 'default'}`;
      const at = by.get(key) ?? { calls: 0, writes: 0, last: 0 };
      at.calls++;
      if (WRITES.has(e.tool)) at.writes++;
      at.last = Math.max(at.last, e.at);
      by.set(key, at);
    }
    return [...by.entries()].sort((a, b) => b[1].writes - a[1].writes);
  };

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

        {leases.length > 0 && (
          <p className="dim">
            {leases.length} frontier item(s) leased across{' '}
            {new Set(leases.map((l) => l.session)).size} session(s) — agents running together
            are handed different work rather than repeating each other.
          </p>
        )}
        {selected && (
          <Sources rows={sourcesIn(selected)} now={now} spend={spend[selected]?.sources} />
        )}
        {selected && logs[selected] && (
          <pre className="log">{logs[selected].slice(-4000)}</pre>
        )}
      </section>

      <Ledger runs={runs} />

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

/** Per-source activity inside one run. Reads/writes split, because they are not the same. */
function Sources({ rows, now, spend }: {
  rows: Array<[string, { calls: number; writes: number; last: number }]>;
  now: number;
  spend?: Array<{ source: string; cost: number; turns: number }>;
}) {
  if (!rows.length) return null;
  // Two halves of one picture that arrive by different routes: what an agent wrote comes
  // over the MCP boundary, what it charged only ever exists in its own CLI's output. The
  // key is the same `tool:model` pair either way, which is what lets them be joined at all.
  const cost = new Map((spend ?? []).map((s) => [s.source.replace(':', '/'), s]));
  return (
    <table className="grid sources">
      <tbody>
        {rows.map(([key, s]) => {
          const paid = cost.get(key);
          return (
            <tr key={key}>
              <td><code>{key}</code></td>
              <td>{s.writes} written</td>
              <td className="dim">{s.calls} call{s.calls === 1 ? '' : 's'}</td>
              <td className="dim">{paid?.cost ? `$${paid.cost.toFixed(2)}` : ''}</td>
              <td className="dim">{s.last ? `${since(now - s.last)} ago` : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * What earlier runs cost and what they bought.
 *
 * The question a swarm makes expensive to answer — *was the third source worth it* — needs
 * the run before it to still exist. This is the only part of a finished run that survives
 * closing the app.
 */
function Ledger({ runs }: { runs: RunRecord[] }) {
  if (!runs.length) return null;
  return (
    <section className="card">
      <h3>Previous runs</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>when</th><th>sources</th><th>bought</th><th>cost</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => {
            const bought = (['claims', 'clusters', 'elisions', 'defences'] as const)
              .filter((k) => r.delta[k] > 0)
              .map((k) => `+${r.delta[k]} ${k}`)
              .join(', ');
            const failed = r.results.filter((x) => !x.ok);
            return (
              <tr key={`${r.at}-${i}`}>
                <td className="dim">{new Date(r.at).toLocaleString()}</td>
                <td>
                  <span className={r.diversity < 2 ? 'hint' : ''}>{r.diversity}</span>
                  <span className="dim"> · {r.sources.join(', ')}</span>
                  {r.spread && <span className="dim"> · split</span>}
                </td>
                <td className={bought ? '' : 'dim'}>
                  {bought || 'nothing'}
                  {failed.length > 0 && (
                    <span className="bad"> · {failed.length} failed</span>
                  )}
                </td>
                <td title={r.costKnown ? undefined : 'a CLI reported no spend, so this is a floor'}>
                  ${r.cost.toFixed(2)}
                  {!r.costKnown && <span className="dim">+</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="dim">
        A run with one source cannot corroborate anything it claims, whatever it cost.
        <span className="dim"> A “+” on a cost means a tool in that run never said what it charged.</span>
      </p>
    </section>
  );
}
