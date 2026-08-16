import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Agents } from './panels/Agents.tsx';
import { Findings } from './panels/Findings.tsx';
import { Invariants } from './panels/Invariants.tsx';
import { Overview } from './panels/Overview.tsx';
import { Review } from './panels/Review.tsx';
import { Scene } from './panels/Scene.tsx';
import type { Job, LoadPayload, QueryPayload, VdsEvent } from './types.ts';

type Tab = 'overview' | 'findings' | 'review' | 'agents' | 'invariants';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Map' },
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

  const refresh = useCallback(async () => {
    try {
      const [d, q] = await Promise.all([window.vds.load(), window.vds.query()]);
      setData(d);
      setQuery(q);
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

  // Live wiring: MCP tool calls, job lifecycle, job stdout.
  useEffect(() => {
    const offEvent = window.vds.onEvent((e) => setEvents((prev) => [...prev.slice(-800), e]));
    const offJob = window.vds.onJob((j) => {
      setJobs((prev) => {
        const next = prev.filter((p) => p.id !== j.id);
        return [...next, j];
      });
      // A finished job usually changed the store, so pull fresh state.
      if (j.status !== 'running') void refresh();
    });
    const offOut = window.vds.onJobOutput(({ id, text }) =>
      setLogs((prev) => ({ ...prev, [id]: (prev[id] ?? '') + text })),
    );
    return () => {
      offEvent();
      offJob();
      offOut();
    };
  }, [refresh]);

  const running = jobs.filter((j) => j.status === 'running');
  // Data can exist without a repo path (launched against an output dir directly), so the
  // panels key off whether a map was produced, not off the repo setting.
  const mapped = !!data?.stack;
  const contradictions = query?.contradictions ?? [];

  const act = async (fn: () => Promise<{ error?: string } | unknown>) => {
    setBusy(true);
    setError(null);
    const res = (await fn()) as { error?: string } | undefined;
    if (res?.error) setError(res.error);
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

        <button disabled={!data?.repo || busy} onClick={() => act(() => window.vds.map())}>
          Map
        </button>
        <button
          disabled={!data?.repo || busy}
          onClick={() => act(() => window.vds.agent({ tools: 'claude', batch: 5 }))}
        >
          Explore
        </button>
        <button
          disabled={!data?.repo || busy}
          onClick={() => act(() => window.vds.agent({ tools: 'claude', mode: 'focus' }))}
        >
          Focus
        </button>
        <button disabled={!data?.repo || busy} onClick={() => act(() => window.vds.refocus())}>
          Rebuild
        </button>
      </header>

      {error && (
        <div className="banner error">
          {error}
          <button className="link" onClick={() => setError(null)}>
            dismiss
          </button>
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
              {mapped && tab === 'findings' && <Findings data={data!} query={query} onRefresh={refresh} />}
              {mapped && tab === 'review' && <Review query={query} onRefresh={refresh} />}
              {mapped && tab === 'agents' && <Agents events={events} jobs={jobs} logs={logs} />}
              {mapped && tab === 'invariants' && <Invariants data={data!} />}
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
