import { useEffect, useMemo, useRef, useState } from 'react';
import type { Belief, CampaignEntry, Job, VdsEvent } from '../types.ts';
import { Burndown } from '../panels/Burndown.tsx';
import { money, sourceColor, state } from '../vocab.ts';
import { summarise } from '../shell/Inspector.tsx';

/**
 * The live monitor.
 *
 * It sits in the rail rather than replacing the canvas, because the design's own argument
 * for this screen is that a run should be visible *on the map* — the scene already lights
 * up the node an agent is reading and marks where each one is, so taking the map away to
 * show a progress bar would be removing the thing worth watching.
 *
 * What the rail adds is the part the map cannot show: who is spending what, which claims
 * have actually landed, and how long it has been since anything happened at all.
 */

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
 * cross our MCP boundary, so minutes can pass with nothing to show. Without an elapsed clock
 * that is indistinguishable from a hang, and the honest signal is "how long since anything
 * happened", not "nothing is happening".
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
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

export type Spend = Record<string, {
  cost: number; turns: number;
  sources?: Array<{ source: string; cost: number; turns: number }>;
}>;

export function Monitor({
  events, jobs, logs, spend, selected, onSelect, leases, beliefs, ceiling, campaign,
}: {
  events: VdsEvent[];
  jobs: Job[];
  logs: Record<string, string>;
  spend: Spend;
  selected: string | null;
  onSelect: (id: string | null) => void;
  leases: Array<{ subject: string; session: string; until: number }>;
  beliefs: Belief[];
  ceiling: number;
  /**
   * Every campaign sample in the output directory, unfiltered.
   *
   * A campaign is the only run that has an end anyone can point at, so it is the only run
   * with a burndown. A single agent launch has none and the panel says so rather than
   * drawing an empty chart.
   */
  campaign: CampaignEntry[];
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
   * Lanes: one per source that has actually written, not one per roster row.
   *
   * Every agent used to record itself as the same "multi" source, so a three-agent run was
   * one undifferentiated stream with no way to see that one had gone quiet. The events name
   * their own tool and model now, which is the same key the belief calculus counts
   * independence by — so this is a live view of whether the run is producing corroboration
   * or three copies of one opinion.
   */
  const lanes = useMemo(() => {
    const by = new Map<string, {
      calls: number; writes: number; last: number; doing: string; recent: boolean[];
    }>();
    for (const e of shown) {
      const key = `${e.agent ?? '?'}:${e.model ?? 'default'}`;
      const at = by.get(key) ?? { calls: 0, writes: 0, last: 0, doing: '', recent: [] };
      at.calls++;
      const wrote = WRITES.has(e.tool);
      if (wrote) at.writes++;
      at.recent.push(wrote);
      if (at.recent.length > 18) at.recent.shift();
      if (e.at >= at.last) {
        at.last = e.at;
        at.doing = `${LABEL[e.tool] ?? e.tool}${e.subject ? ` ${e.subject.split('/').pop()}` : ''}`;
      }
      by.set(key, at);
    }
    return [...by.entries()].sort((a, b) => b[1].writes - a[1].writes);
  }, [shown]);

  /**
   * Claims landing as they land, with the state they produced.
   *
   * The event says something was claimed; the store says what that claim did to the belief.
   * Joining them is the whole reassurance of watching a run: a stream of "claimed" tells you
   * an agent is busy, and this tells you whether being busy achieved anything.
   */
  const landing = useMemo(() => {
    const byBelief = new Map<string, Belief>(beliefs.map((b) => [`${b.subject} ${b.predicate}`, b]));
    const seen = new Set<string>();
    const out: Array<{ key: string; belief: Belief | undefined; subject: string; at: number }> = [];
    for (let i = shown.length - 1; i >= 0 && out.length < 6; i--) {
      const e = shown[i];
      if (e.tool !== 'submit_claim' || !e.subject) continue;
      const key = `${e.subject} ${e.predicate ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, belief: byBelief.get(key), subject: e.subject, at: e.at });
    }
    return out;
  }, [shown, beliefs]);

  const liveSpend = Object.entries(spend)
    .filter(([id]) => !selected || id === selected)
    .reduce((n, [, s]) => n + s.cost, 0);
  const lastEvent = shown.length ? shown[shown.length - 1].at : 0;
  const started = Math.min(...running.map((j) => j.startedAt ?? now), now);

  return (
    <aside className="inspector">
      <Burndown entries={campaign} />

      <div>
        <div className="rail-label">
          {running.length ? `${running.length} running · ${since(now - started)}` : 'run finished'}
        </div>
        <div className="facts" style={{ marginTop: 8 }}>
          <div className="fact">
            <span className="k">spent</span>
            <span className="v warn">
              {money(liveSpend)}{ceiling > 0 ? ` / ${money(ceiling)}` : ''}
            </span>
          </div>
          <div className="fact">
            <span className="k">agents done</span>
            <span className="v">
              {jobs.filter((j) => j.status !== 'running').length} of {jobs.length}
            </span>
          </div>
          {lastEvent > 0 && (
            <div className="fact">
              <span className="k">last activity</span>
              <span className="v">{since(now - lastEvent)} ago</span>
            </div>
          )}
        </div>
        {ceiling > 0 && (
          <div className="meter">
            <div
              className={liveSpend > ceiling ? 'meter-fill bad' : 'meter-fill warn'}
              style={{ width: `${Math.min(100, (liveSpend / ceiling) * 100)}%` }}
            />
          </div>
        )}
      </div>

      <div>
        <div className="rail-label">lanes</div>
        {!lanes.length && (
          <p className="dim">
            Nothing has crossed the MCP boundary yet. Agents read files with their own tools,
            so the first minute of a run is normally silent.
          </p>
        )}
        {lanes.map(([key, l]) => {
          const paid = Object.values(spend)
            .flatMap((s) => s.sources ?? [])
            .find((s) => s.source === key);
          return (
            <div className="lane" key={key}>
              <div className="lane-head">
                <i className="swatch" style={{ background: sourceColor(key) }} />
                <span className="who">{key}</span>
                <span className="tally">
                  {l.calls} call{l.calls === 1 ? '' : 's'} · {l.writes} claim
                  {l.writes === 1 ? '' : 's'}
                  {paid?.cost ? ` · ${money(paid.cost)}` : ''}
                </span>
                <span className="now">{since(now - l.last)}</span>
              </div>
              <div className="lane-head" style={{ marginTop: 4 }}>
                <span className="tally">{l.doing}</span>
              </div>
              <div className="lane-bar">
                {l.recent.map((wrote, i) => (
                  <span key={i} style={wrote ? { background: sourceColor(key) } : undefined} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <div className="rail-label">landing as it goes</div>
        {!landing.length && <p className="dim">No claims yet.</p>}
        {landing.map((l) => {
          const st = l.belief ? state(l.belief.status) : null;
          return (
            <div className="landing" key={l.key}>
              <i className="swatch" style={{
                background: st
                  ? `var(--${st.tone === 'dim' ? 'mark' : st.tone}${st.tone === 'dim' ? '' : '-mark'})`
                  : 'var(--mark)',
              }} />
              <div>
                <div className="t">{l.belief ? summarise(l.belief) : l.subject}</div>
                {/* Which file it was about. Two rows reading "god_verdict: no" are two
                    different findings, and without this they are indistinguishable. */}
                <div className="d">{l.subject}</div>
                <div className="d">
                  {st ? st.name : 'landing'}
                  {l.belief ? ` · ${[...new Set(l.belief.claims.map((c) => c.source.tool ?? c.source.kind))].join(' + ')}` : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <div className="rail-label">
          stream
          {running.length > 0 && <span className="live" style={{ marginLeft: 8 }}>live</span>}
        </div>
        <div className="stream" ref={feedRef}>
          {!shown.length && <p className="dim">No tool calls yet.</p>}
          {shown.slice(-40).map((e, i, list) => {
            const who = `${e.agent ?? '?'}${e.model ? `/${e.model}` : ''}`;
            const prev = list[i - 1];
            const repeat = prev && `${prev.agent ?? '?'}${prev.model ? `/${prev.model}` : ''}` === who;
            return (
            <div key={i} className={e.ok === false ? 'stream-row bad' : 'stream-row'}>
              <span className="t">{new Date(e.at).toLocaleTimeString(undefined, { hour12: false }).slice(3)}</span>
              <span className="who" title={who}>{repeat ? '' : who}</span>
              <span className="what">
                {LABEL[e.tool] ?? e.tool}
                {e.subject ? ` ${e.subject}` : e.node ? ` ${e.node}` : ''}
                {e.predicate ? ` · ${e.predicate}` : ''}
                {e.error ? ` — ${e.error}` : ''}
              </span>
            </div>
            );
          })}
        </div>
      </div>

      {jobs.length > 0 && (
        <div>
          <div className="rail-label">
            jobs
            {jobs.length > 1 && (
              <button className="link" style={{ marginLeft: 8 }} onClick={() => onSelect(null)}>
                {selected ? 'show all' : 'all shown'}
              </button>
            )}
          </div>
          {[...jobs].reverse().map((j) => (
            <div
              key={j.id}
              className={selected === j.id ? 'job-row selected' : 'job-row'}
              onClick={() => onSelect(selected === j.id ? null : j.id)}
              title="click to show only this job's tool calls"
            >
              <span className={`pill ${j.status}`}>{j.status}</span>
              <code style={{ fontSize: 10.5 }}>{j.label}</code>
              {j.status === 'running' && j.startedAt && (
                <span className="num">{since(now - j.startedAt)}</span>
              )}
              {j.status === 'running' && (
                <button
                  className="link"
                  onClick={(e) => { e.stopPropagation(); window.vds.stopJob(j.id); }}
                >
                  stop
                </button>
              )}
            </div>
          ))}
          {selected && logs[selected] && <pre className="log">{logs[selected].slice(-4000)}</pre>}
        </div>
      )}

      {leases.length > 0 && (
        <p className="dim" style={{ fontSize: 11 }}>
          {leases.length} question{leases.length === 1 ? '' : 's'} leased across{' '}
          {new Set(leases.map((l) => l.session)).size} session
          {new Set(leases.map((l) => l.session)).size === 1 ? '' : 's'} — agents running
          together are handed different work rather than repeating each other.
        </p>
      )}

      <div className="foot">nothing has touched your working tree</div>
    </aside>
  );
}
