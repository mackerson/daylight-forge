import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { candidates as deriveCandidates, flaggedFiles } from '../../../engine/detect/candidates.ts';
import { remediate } from '../../../engine/plan/remediation.ts';
import { emitEvent } from './replay.ts';
import { Scene } from './panels/Scene.tsx';
import type { Channel, SceneNode } from './panels/Scene.tsx';
import { StageStrip, TitleBar } from './shell/StageStrip.tsx';
import type { Stage, StageState, View } from './shell/StageStrip.tsx';
import { FilterBar, LensRail } from './shell/LensRail.tsx';
import { applyFilters } from './shell/lens.ts';
import type { Filter } from './shell/lens.ts';
import { Inspector } from './shell/Inspector.tsx';
import { Detect } from './screens/Detect.tsx';
import { Explore } from './screens/Explore.tsx';
import { Monitor } from './screens/Monitor.tsx';
import { Beliefs } from './screens/Beliefs.tsx';
import { BeliefDetail } from './screens/BeliefDetail.tsx';
import { Invariants } from './screens/Invariants.tsx';
import { Plan } from './screens/Plan.tsx';
import { Runs } from './screens/Runs.tsx';
import type { Belief, Job, LoadPayload, QueryPayload, VdsEvent } from './types.ts';
import { shorten } from './vocab.ts';

/**
 * The shell.
 *
 * The map is not a tab any more; it is the window, and the loop — map, detect, explore,
 * beliefs, plan — is a strip above it that owns navigation and reports its own state. The
 * lens rail on the left decides what question the canvas is answering and the filters stack
 * inside whichever lens is on. Everything else is an inspector.
 *
 * Two rules hold the layout together. Only the map view carries the lens rail and the
 * inspector, because they belong to the canvas rather than to the window; and the live
 * monitor keeps the canvas rather than replacing it, because watching a run means watching
 * it happen on the map.
 */

/** Panels the old tab rail had, so `VDS_TAB=review pnpm shot` keeps working. */
const TAB_ALIASES: Record<string, View> = {
  overview: 'map',
  map: 'map',
  findings: 'detect',
  detect: 'detect',
  agents: 'explore',
  explore: 'explore',
  review: 'beliefs',
  beliefs: 'beliefs',
  plan: 'plan',
  quality: 'runs',
  runs: 'runs',
  invariants: 'invariants',
};

export function App() {
  const [view, setView] = useState<View>('map');
  const [lens, setLens] = useState<Channel>('structure');
  const [filters, setFilters] = useState<Filter[]>([]);
  const [node, setNode] = useState<SceneNode | null>(null);
  const [openBelief, setOpenBelief] = useState<Belief | null>(null);
  const [pickedCandidates, setPickedCandidates] = useState<ReadonlySet<string>>(() => new Set());
  const [scope, setScope] = useState<string[]>([]);
  /** Explore is two screens: the work order, and the run it launched. */
  const [watching, setWatchingRun] = useState(false);

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
  const [toast, setToast] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [watchingFiles, setWatchingFiles] = useState(false);

  // The inspector is sized to taste and persisted, because re-dragging it every launch
  // would be its own annoyance.
  const [railWidth, setRailWidth] = useState(() => {
    const saved = Number(localStorage.getItem('vds.railWidth'));
    return Number.isFinite(saved) && saved >= 280 ? saved : 340;
  });
  const dragRef = useRef({ active: false });

  // A ref as well as state: the live-event subscription is installed once and must read the
  // current value, not the one captured when it was installed.
  const replayingRef = useRef(false);
  replayingRef.current = replaying;

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

  // Open on a named screen when asked. Screenshots need it; so does a link into a finding.
  const seededTab = useRef(false);
  useEffect(() => {
    if (seededTab.current || !data?.initialTab) return;
    const v = TAB_ALIASES[data.initialTab];
    if (v) {
      seededTab.current = true;
      setView(v);
    }
  }, [data?.initialTab]);

  const seededArb = useRef(false);
  useEffect(() => {
    if (seededArb.current || !data?.autoArbitrate) return;
    const first = query?.contradictions?.[0];
    if (!first) return;
    seededArb.current = true;
    setView('beliefs');
    setOpenBelief(first);
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
      setJobs((prev) => [...prev.filter((p) => p.id !== j.id), j]);
      if (j.status === 'running') {
        statsRef.current = statsRef.current ?? null;
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
  const mapped = !!data?.stack;
  const beliefs = query?.beliefs ?? [];
  const contradictions = query?.contradictions ?? [];

  const candidates = useMemo(
    () => deriveCandidates(data?.findings ?? null, data?.structure ?? null),
    [data?.findings, data?.structure],
  );
  const flagged = useMemo(() => flaggedFiles(candidates), [candidates]);
  const plan = useMemo(
    () => remediate(beliefs, data?.invariants?.results ?? []),
    [beliefs, data?.invariants],
  );

  const filtered = useMemo(
    () => applyFilters(data?.stack ?? null, filters, flagged),
    [data?.stack, filters, flagged],
  );
  // The scene reads a stack; filtering is a transform on that stack rather than a flag it
  // has to understand, so `Scene` never learns what a filter is.
  const sceneData = useMemo<LoadPayload | null>(
    () => (data ? { ...data, stack: filtered.stack } : null),
    [data, filtered.stack],
  );

  // Today's spend, from the ledger rather than from this session, so closing the app does
  // not reset the number that stops you overspending.
  const today = useMemo(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const runs = (query?.runs ?? []).filter((r) => Date.parse(r.at) >= midnight.getTime());
    const live = Object.values(spend).reduce((n, s) => n + s.cost, 0);
    return {
      cost: runs.reduce((n, r) => n + r.cost, 0) + live,
      known: runs.every((r) => r.costKnown),
    };
  }, [query?.runs, spend]);

  const invariantResults = data?.invariants?.results ?? [];
  const violated = invariantResults.filter((r) => r.status === 'red').length;

  const stages: Record<Stage, StageState> = {
    map: {
      tick: mapped ? 'done' : 'ready',
      state: mapped
        ? `${filtered.total} nodes${data?.missingRepo ? ' · source moved' : ''}`
        : data?.repo ? 'not mapped yet' : 'no repo',
      enabled: true,
    },
    detect: {
      tick: candidates.length ? 'ready' : mapped ? 'done' : 'idle',
      state: mapped ? `${candidates.length} candidates` : '—',
      enabled: mapped,
    },
    explore: {
      tick: running.length ? 'live' : 'idle',
      state: running.length ? `${running.length} running` : 'idle',
      enabled: mapped,
    },
    beliefs: {
      tick: contradictions.length ? 'blocked' : beliefs.length ? 'done' : 'idle',
      state: beliefs.length
        ? `${beliefs.length}${contradictions.length ? ` · ${contradictions.length} contested` : ''}`
        : 'none yet',
      enabled: mapped,
    },
    plan: {
      tick: plan.ready.length ? 'ready' : 'idle',
      state: plan.steps.length
        ? `${plan.ready.length} ready${plan.blocked.length ? `, ${plan.blocked.length} blocked` : ''}`
        : 'none yet',
      enabled: mapped,
    },
  };

  const act = async (fn: () => Promise<{ error?: string } | unknown>) => {
    setBusy(true);
    setError(null);
    const res = (await fn()) as { error?: string; id?: string } | undefined;
    if (res?.error) setError(res.error);
    // Starting a run takes you to it. A run you cannot see is a run you cannot judge.
    if (res?.id) {
      setSelectedJob(res.id);
      setView('explore');
      setWatchingRun(true);
    }
    setBusy(false);
    await refresh();
  };

  /** Anything that says "explore these" lands here: set the scope, show the work order. */
  const scopeRun = (subjects: string[]) => {
    setScope(subjects);
    setView('explore');
    setWatchingRun(false);
  };

  const startResize = (e: React.PointerEvent) => {
    dragRef.current.active = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onResize = (e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    setRailWidth(Math.min(Math.max(window.innerWidth - e.clientX, 280), window.innerWidth - 560));
  };
  const endResize = (e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    localStorage.setItem('vds.railWidth', String(railWidth));
  };

  // The queue behind the belief detail: what else is waiting on a decision.
  const queue = useMemo(
    () => [...contradictions, ...beliefs.filter((b) => b.status === 'INFERRED')],
    [contradictions, beliefs],
  );
  const queueIndex = openBelief
    ? queue.findIndex((b) => b.subject === openBelief.subject && b.predicate === openBelief.predicate)
    : -1;
  const nextInQueue = () => {
    const next = queue[queueIndex + 1];
    if (next) setOpenBelief(next);
    else setOpenBelief(null);
  };

  // Only the canvas carries a lens and an inspector; a document does not.
  const onMap = view === 'map' || (view === 'explore' && watching);

  return (
    <div className="app">
      <TitleBar
        name={`visual-desloppify${view === 'map' ? '' : ` — ${view}`}`}
        where={data?.repo ? shorten(data.repo) : null}
        busy={running.length > 0}
        onPick={() => act(async () => window.vds.pickRepo())}
      >
        <button
          className="where"
          disabled={!data?.repo || busy}
          onClick={() => act(() => window.vds.map())}
          title="re-extract and re-derive from source"
        >
          {mapped ? 'remap' : 'map it'}
        </button>
        <button
          className="where"
          disabled={!data?.repo}
          style={watchingFiles ? { color: 'var(--ok)' } : undefined}
          title="re-map automatically when the code changes; only changed files re-parse"
          onClick={async () => setWatchingFiles((await window.vds.watch(!watchingFiles)).watching)}
        >
          {watchingFiles ? 'watching' : 'watch'}
        </button>
        <button className="where" onClick={() => act(async () => window.vds.setDir())}>
          out {data?.dir ? shorten(data.dir) : '—'}
        </button>
      </TitleBar>

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
          <button className="link" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <StageStrip
        view={view}
        onView={(v) => {
          setView(v);
          if (v === 'beliefs') setOpenBelief(null);
          if (v === 'explore') setWatchingRun(running.length > 0);
        }}
        stages={stages}
        invariants={invariantResults.length ? { held: invariantResults.length - violated, violated } : null}
        spend={today}
        running={running.length}
        onStop={() => running.forEach((j) => window.vds.stopJob(j.id))}
      />

      <div className="workspace">
        {onMap && (
          <LensRail
            lens={lens}
            onLens={setLens}
            counts={{ candidates: candidates.length, belief: beliefs.length }}
            saved={[]}
            onSaved={setFilters}
          />
        )}

        <div className="canvas">
          {onMap && (
            <FilterBar
              filters={filters}
              onFilters={setFilters}
              stack={data?.stack ?? null}
              flagged={flagged}
              result={filtered}
              onExplore={scopeRun}
            />
          )}

          <div className={onMap ? 'stage-view scene' : 'stage-view'}>
            {onMap && <Scene data={sceneData} channel={lens} onChannel={setLens} flagged={flagged} onSelect={setNode} />}

            {!mapped && view !== 'map' && <Empty hasRepo={!!data?.repo} />}

            {mapped && data && view === 'detect' && (
              <Detect
                data={data}
                query={query}
                candidates={candidates}
                selected={pickedCandidates}
                onSelected={setPickedCandidates}
                onExplore={scopeRun}
                onRefresh={refresh}
              />
            )}

            {mapped && view === 'explore' && !watching && (
              <Explore
                scope={scope}
                onClearScope={() => setScope([])}
                runs={query?.runs ?? []}
                busy={busy}
                disabled={!data?.repo}
                running={running.length}
                onMonitor={() => setWatchingRun(true)}
                onLaunch={(opts) => act(() => window.vds.agent(opts))}
              />
            )}

            {mapped && view === 'beliefs' && !openBelief && (
              <Beliefs
                query={query}
                onOpen={setOpenBelief}
                onCorroborate={scopeRun}
                onRefresh={refresh}
              />
            )}

            {mapped && view === 'beliefs' && openBelief && (
              <BeliefDetail
                belief={openBelief}
                onBack={() => setOpenBelief(null)}
                onDecided={refresh}
                onNext={queueIndex >= 0 && queueIndex < queue.length - 1 ? nextInQueue : null}
                position={queueIndex >= 0 ? { index: queueIndex, total: queue.length } : null}
              />
            )}

            {mapped && data && view === 'invariants' && (
              <Invariants
                data={data}
                beliefs={beliefs}
                onRefresh={refresh}
                onPlan={() => setView('plan')}
              />
            )}

            {mapped && data && view === 'plan' && (
              <Plan
                data={data}
                beliefs={beliefs}
                onOpen={(b) => { setOpenBelief(b); setView('beliefs'); }}
                onExplore={scopeRun}
              />
            )}

            {mapped && view === 'runs' && (
              <Runs
                runs={query?.runs ?? []}
                beliefs={beliefs}
                events={events}
                replaying={replaying}
                onReplaying={setReplaying}
                onOpen={(b) => { setOpenBelief(b); setView('beliefs'); }}
              />
            )}

            {!mapped && view === 'map' && <Empty hasRepo={!!data?.repo} />}
          </div>
        </div>

        {onMap && (
          <>
            <div
              className="splitter"
              onPointerDown={startResize}
              onPointerMove={onResize}
              onPointerUp={endResize}
              onDoubleClick={() => setRailWidth(340)}
              title="drag to resize · double-click to reset"
            />
            <div style={{ width: railWidth, flex: 'none', display: 'flex', minHeight: 0 }}>
              {view === 'explore' && watching ? (
                <Monitor
                  events={events}
                  jobs={jobs}
                  logs={logs}
                  spend={spend}
                  selected={selectedJob}
                  onSelect={setSelectedJob}
                  leases={query?.leases ?? []}
                  beliefs={beliefs}
                  ceiling={0}
                />
              ) : (
                <Inspector
                  node={node}
                  beliefs={beliefs}
                  candidates={candidates}
                  data={data}
                  onBelief={(b) => { setOpenBelief(b); setView('beliefs'); }}
                  onExplore={scopeRun}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Empty({ hasRepo }: { hasRepo: boolean }) {
  return (
    <div className="empty">
      <h2>{hasRepo ? 'Not mapped yet' : 'No repository selected'}</h2>
      <p>
        Choose a repo, then <strong>map</strong> it. That gives the exhaustive graph and the
        deterministic duplication findings — no agents involved, nothing spent.
      </p>
      <p className="dim">
        Everything after that needs a source that can read code. Detect turns the static
        findings into questions; explore hands them to agents; beliefs is where you decide.
      </p>
    </div>
  );
}
