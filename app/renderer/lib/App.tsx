import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Agents } from './panels/Agents.tsx';
import { Findings } from './panels/Findings.tsx';
import { Launch } from './panels/Launch.tsx';
import { Invariants } from './panels/Invariants.tsx';
import { Overview } from './panels/Overview.tsx';
import { Quality } from './panels/Quality.tsx';
import { Arbitrate } from './panels/Arbitrate.tsx';
import { Scrubber } from './panels/Scrubber.tsx';
import { emitEvent } from './replay.ts';
import { Review } from './panels/Review.tsx';
import { Scene } from './panels/Scene.tsx';
import type { Belief, Job, LoadPayload, QueryPayload, VdsEvent } from './types.ts';

type Tab = 'overview' | 'quality' | 'findings' | 'review' | 'agents' | 'invariants';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Map' },
  // Second, because "can I believe this?" is the question you have before any of the
  // findings below it mean anything.
  { id: 'quality', label: 'Quality' },
  { id: 'findings', label: 'Findings' },
  { id: 'review', label: 'Review' },
  { id: 'agents', label: 'Agents' },
  { id: 'invariants', label: 'Invariants' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<LoadPayload | null>(null);
  const [query, setQuery] = useState<QueryPayload | null>(null);
  const [events, setEvents] = useState<VdsEvent[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [spend, setSpend] = useState<
    Record<string, { cost: number; turns: number; sources?: Array<{ source: string; cost: number; turns: number }> }>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The scene is the point of the app, so it takes the space and the info pane is sized
  // to taste. Persisted, because re-dragging it every launch would be its own annoyance.
  const [infoWidth, setInfoWidth] = useState(() => {
    const saved = Number(localStorage.getItem('vds.infoWidth'));
    return Number.isFinite(saved) && saved >= 280 ? saved : 460;
  });
  const [infoOpen, setInfoOpen] = useState(
    () => localStorage.getItem('vds.infoOpen') !== 'false',
  );
  const dragRef = useRef<{ active: boolean }>({ active: false });
  const [toast, setToast] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [arbitrating, setArbitrating] = useState<Belief | null>(null);
  const [replaying, setReplaying] = useState(false);
  // A ref as well as state: the live-event subscription is installed once and must read the
  // current value, not the one captured when it was installed.
  const replayingRef = useRef(false);
  replayingRef.current = replaying;

  // Open on a named panel when asked. Screenshots need it; so does a link into a finding.
  const seededTab = useRef(false);
  useEffect(() => {
    if (seededTab.current || !data?.initialTab) return;
    if (TABS.some((t) => t.id === data.initialTab)) {
      seededTab.current = true;
      setTab(data.initialTab as Tab);
    }
  }, [data?.initialTab]);

  const [watching, setWatching] = useState(false);
  // Snapshot of the store before a job, so completion can report the delta rather than
  // making you read a log to find out what happened.
  const statsRef = useRef<QueryPayload['stats'] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [d, q] = await Promise.all([window.vds.load(), window.vds.query()]);
      setData(d);
      setQuery(q);
      if (!statsRef.current) statsRef.current = q.stats;
      if (q.events?.length) setEvents(q.events);
      setError(q.error ?? null);
    } catch (err) {
      console.error('refresh failed', err);
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const seededArb = useRef(false);
  useEffect(() => {
    if (seededArb.current || !data?.autoArbitrate) return;
    const first = query?.contradictions?.[0];
    if (!first) return;
    seededArb.current = true;
    setArbitrating(first);
  }, [data?.autoArbitrate, query]);

  // Live wiring: MCP tool calls, job lifecycle, job stdout.
  useEffect(() => {
    // Live events go into the same bus the replay uses, so the scene has one code path for
    // both. While a replay is running the live feed is withheld from the map — it still
    // accumulates into `events`, so leaving replay catches up, but it does not draw over a
    // reconstruction of an earlier moment.
    const offEvent = window.vds.onEvent((e) => {
      setEvents((prev) => [...prev.slice(-800), e]);
      if (!replayingRef.current) emitEvent(e);
    });
    const offJob = window.vds.onJob((j) => {
      setJobs((prev) => {
        const next = prev.filter((p) => p.id !== j.id);
        return [...next, j];
      });
      if (j.status === 'running') {
        statsRef.current = query?.stats ?? statsRef.current;
        return;
      }
      // A finished job usually changed the store, so pull fresh state and say what moved.
      void (async () => {
        const before = statsRef.current;
        const q = await window.vds.query();
        setQuery(q);
        setData(await window.vds.load());
        const parts: string[] = [];
        if (before) {
          const d = (k: keyof typeof q.stats) => q.stats[k] - before[k];
          for (const k of ['claims', 'clusters', 'elisions', 'defences'] as const) {
            if (d(k) > 0) parts.push(`+${d(k)} ${k}`);
          }
        }
        statsRef.current = q.stats;
        setToast(
          j.status === 'failed'
            ? `${j.label} failed (exit ${j.code})`
            : `${j.label} finished${parts.length ? ` — ${parts.join(', ')}` : ' — nothing changed'}`,
        );
      })();
    });
    // The stack was re-derived because claims changed; pull the new one.
    const offDerived = window.vds.onDerived(() => void refresh());
    const offStats = window.vds.onJobStats(({ id, cost, turns, sources }) =>
      setSpend((prev) => ({ ...prev, [id]: { cost, turns, sources } })),
    );
    const offOut = window.vds.onJobOutput(({ id, text }) =>
      setLogs((prev) => ({ ...prev, [id]: (prev[id] ?? '') + text })),
    );
    return () => {
      offEvent();
      offJob();
      offDerived();
      offStats();
      offOut();
    };
  }, [refresh]);

  const running = jobs.filter((j) => j.status === 'running');
  // Data can exist without a repo path (launched against an output dir directly), so the
  // panels key off whether a map was produced, not off the repo setting.
  const mapped = !!data?.stack;
  const totalCost = Object.values(spend).reduce((sum, s) => sum + s.cost, 0);
  const totalTurns = Object.values(spend).reduce((sum, s) => sum + s.turns, 0);
  const contradictions = query?.contradictions ?? [];

  const act = async (fn: () => Promise<{ error?: string } | unknown>) => {
    setBusy(true);
    setError(null);
    const res = (await fn()) as { error?: string; id?: string } | undefined;
    if (res?.error) setError(res.error);
    // Starting a job takes you to it. A run you cannot see is a run you cannot judge,
    // and the panel it belongs in is one click away that nobody makes.
    if (res?.id) {
      setSelectedJob(res.id);
      setTab('agents');
      setInfoOpen(true);
    }
    setBusy(false);
    await refresh();
  };

  const startResize = (e: React.PointerEvent) => {
    dragRef.current.active = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onResize = (e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    const next = Math.min(Math.max(window.innerWidth - e.clientX, 280), window.innerWidth - 480);
    setInfoWidth(next);
  };
  const endResize = (e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    localStorage.setItem('vds.infoWidth', String(infoWidth));
  };

  useEffect(() => {
    localStorage.setItem('vds.infoOpen', String(infoOpen));
  }, [infoOpen]);

  const counts = useMemo(
    () => ({
      findings: data?.findings?.families?.length ?? 0,
      review: contradictions.length,
      agents: running.length,
      invariants: data?.invariants?.results?.length ?? 0,
    }),
    [data, contradictions.length, running.length],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">visual&#8209;desloppify</div>

        <button className="path" onClick={() => act(async () => window.vds.pickRepo())}>
          <span className="dim">repo</span>{' '}
          {data?.repo ? shorten(data.repo) : <em>choose…</em>}
        </button>
        <button className="path" onClick={() => act(async () => window.vds.setDir())}>
          <span className="dim">out</span> {data?.dir ? shorten(data.dir) : '—'}
        </button>

        <div className="spacer" />

        {(totalCost > 0 || running.length > 0) && (
          <div className="spend" title="spend and turns this session, parsed from agent output">
            <strong>${totalCost.toFixed(2)}</strong>
            <span className="dim">{totalTurns} turns</span>
          </div>
        )}

        <button disabled={!data?.repo || busy} onClick={() => act(() => window.vds.map())}>
          Map
        </button>
        {/* These used to be Explore and Focus, each hardcoded to a single claude on its
            default model — which is why nothing in the store had ever been corroborated.
            Both live in the launcher now, where the roster is a decision rather than a
            default nobody was shown. */}
        <button
          disabled={!data?.repo || busy}
          onClick={() => {
            setTab('agents');
            setInfoOpen(true);
          }}
        >
          Run agents…
        </button>
        <button disabled={!data?.repo || busy} onClick={() => act(() => window.vds.refocus())}>
          Rebuild
        </button>
        <button
          className={watching ? 'watching' : ''}
          disabled={!data?.repo}
          title="re-map automatically when the code changes; only changed files re-parse"
          onClick={async () => {
            const r = await window.vds.watch(!watching);
            setWatching(r.watching);
          }}
        >
          {watching ? 'Watching' : 'Watch'}
        </button>
      </header>

      {data?.missingRepo && (
        <div className="banner error">
          {/* One flowing sentence: the banner is a flex row, so a bare <code> holding an
              absolute path becomes its own column and pushes the prose into a third. */}
          <span>
            This map was made from <code className="wrap">{data.missingRepo}</code>, which is no
            longer there. The map still reads, but nothing that has to open the source can
            run — choose the repo if it moved.
          </span>
          <button className="link" onClick={() => act(async () => window.vds.pickRepo())}>
            choose repo
          </button>
        </div>
      )}

      {toast && (
        <div className="banner toast">
          {toast}
          <button className="link" onClick={() => setToast(null)}>dismiss</button>
        </div>
      )}

      {error && (
        <div className="banner error">
          {error}
          <button className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      {arbitrating && (
        <div className="overlay">
          <Arbitrate
            belief={arbitrating}
            pair={data?.findings?.d1?.find(
              (p) => p.a === arbitrating.subject || p.b === arbitrating.subject,
            )}
            onClose={() => setArbitrating(null)}
            onDecided={refresh}
          />
        </div>
      )}

      <div className="body">
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab && infoOpen ? 'tab active' : 'tab'}
              onClick={() => {
                if (tab === t.id && infoOpen) setInfoOpen(false);
                else {
                  setTab(t.id);
                  setInfoOpen(true);
                }
              }}
              title={tab === t.id && infoOpen ? 'click again to collapse the panel' : undefined}
            >
              <span>{t.label}</span>
              <Badge tab={t.id} counts={counts} />
            </button>
          ))}
          <div className="tabs-foot">
            {running.length > 0 && (
              <div className="running">
                {running.length} running
                {running.map((j) => (
                  <button key={j.id} className="link" onClick={() => window.vds.stopJob(j.id)}>
                    stop {j.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>

        <main className="scene">
          <Scene data={data} />
        </main>

        {infoOpen && (
          <>
            <div
              className="splitter"
              onPointerDown={startResize}
              onPointerMove={onResize}
              onPointerUp={endResize}
              onDoubleClick={() => setInfoWidth(460)}
              title="drag to resize · double-click to reset"
            />
            <aside className="info" style={{ width: infoWidth }}>
              {!mapped && <Empty hasRepo={!!data?.repo} />}
              {mapped && tab === 'overview' && <Overview data={data!} query={query} />}
              {mapped && tab === 'quality' && <Quality active={tab === 'quality'} />}
              {mapped && tab === 'findings' && <Findings data={data!} query={query} onRefresh={refresh} onArbitrate={setArbitrating} />}
              {mapped && tab === 'review' && <Review query={query} onRefresh={refresh} onArbitrate={setArbitrating} />}
              {mapped && tab === 'agents' && (
                <>
                  <Launch
                    busy={busy}
                    disabled={!data?.repo}
                    onLaunch={(opts) => act(() => window.vds.agent(opts))}
                  />
                  <Scrubber events={events} active={replaying} onActiveChange={setReplaying} />
                  <Agents events={events} jobs={jobs} logs={logs} spend={spend}
                    selected={selectedJob} onSelect={setSelectedJob}
                    leases={query?.leases ?? []} runs={query?.runs ?? []} />
                </>
              )}
              {mapped && tab === 'invariants' && <Invariants data={data!} onRefresh={refresh} />}
            </aside>
          </>
        )}
      </div>
    </div>
  );
}

function Badge({ tab, counts }: { tab: Tab; counts: Record<string, number> }) {
  const n = counts[tab as keyof typeof counts];
  if (!n) return null;
  const warn = tab === 'review';
  return <span className={warn ? 'badge warn' : 'badge'}>{n}</span>;
}

function Empty({ hasRepo }: { hasRepo: boolean }) {
  return (
    <div className="empty">
      <h2>{hasRepo ? 'Not mapped yet' : 'No repository selected'}</h2>
      <p>
        Choose a repo, then <strong>Map</strong> it. That gives the exhaustive L0 graph and the
        deterministic duplication findings — no agents involved, nothing spent.
      </p>
      <p className="dim">
        Focusing is the part that needs agents: <strong>Explore</strong> answers frontier questions,
        <strong> Focus</strong> proposes clusters and elisions. Until then L2 and L3 just mirror the
        path grouping, which is a filing decision rather than intent.
      </p>
    </div>
  );
}

const shorten = (p: string) => {
  const parts = p.split('/');
  return parts.length <= 3 ? p : `…/${parts.slice(-2).join('/')}`;
};
