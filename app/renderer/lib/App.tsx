import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { candidates as deriveCandidates, flaggedFiles } from '../../../engine/detect/candidates.ts';
import { remediate } from '../../../engine/plan/remediation.ts';
import { emitEvent } from './replay.ts';
import { Scene } from './panels/Scene.tsx';
import type { Channel, SceneNode } from './panels/Scene.tsx';
import { StageStrip, TitleBar } from './shell/StageStrip.tsx';
import type { Stage, StageState, View } from './shell/StageStrip.tsx';
import { FilterBar, LensRail } from './shell/LensRail.tsx';
import { applyFilters, filterSetName } from './shell/lens.ts';
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
  // The monitor is explore-with-a-run-on-screen rather than a view of its own, so it needs
  // its own alias to be reachable headlessly — which is the only way the shot harness can
  // answer a layout question about the burndown.
  monitor: 'explore',
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
  /**
   * Filter sets worth keeping, named after what they narrow to.
   *
   * Auto-named on purpose: a dialog asking for a name is a dialog most people cancel, and
   * "contested · engine" describes the view better than anything anyone would type.
   */
  const [saved, setSaved] = useState<Array<{ name: string; filters: Filter[] }>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('vds.savedFilters') ?? '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem('vds.savedFilters', JSON.stringify(saved));
  }, [saved]);
  const [node, setNode] = useState<SceneNode | null>(null);
  const [openBelief, setOpenBelief] = useState<Belief | null>(null);
  const [pickedCandidates, setPickedCandidates] = useState<ReadonlySet<string>>(() => new Set());
  const [scope, setScope] = useState<string[]>([]);
  /** Explore is two screens: the work order, and the run it launched. */
  const [watching, setWatchingRun] = useState(false);
  /**
   * The ceiling the last launch was given.
   *
   * Held here rather than read back out of the launcher's saved shape, because the number the
   * monitor has to meter against is the one *this* run was started with — editing the form
   * mid-run must not move the line the run is being measured against.
   */
  const [ceiling, setCeiling] = useState(0);

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

  /**
   * Refresh fires from mount, from every action, from every finished job and from every
   * derive — and `vds:query` shells out to the CLI, so two are routinely in flight at once.
   * Without a generation the slower earlier answer lands last and repaints stale state; across
   * a repo switch that is the previous repo's beliefs under the new repo's name.
   */
  const refreshSeq = useRef(0);

  /**
   * Returns what it pulled. `applied` is false when a later refresh overtook this one and
   * has already painted a newer answer — the caller still gets its numbers, because a job
   * that finished has something to report either way.
   */
  const refresh = useCallback(async (): Promise<
    { data: LoadPayload; query: QueryPayload; applied: boolean } | null
  > => {
    const gen = ++refreshSeq.current;
    try {
      const [d, q] = await Promise.all([window.vds.load(), window.vds.query()]);
      const applied = gen === refreshSeq.current;
      if (applied) {
        setData(d);
        setQuery(q);
        if (q.events?.length) setEvents(q.events);
        setError(q.error ?? null);
      }
      if (!statsRef.current) statsRef.current = q.stats;
      return { data: d, query: q, applied };
    } catch (err) {
      console.error('refresh failed', err);
      if (gen === refreshSeq.current) setError(String(err));
      return null;
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
      if (data.initialTab === 'monitor') setWatchingRun(true);
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
        const q = (await refresh())?.query;
        const parts: string[] = [];
        if (before && q) {
          const d = (k: keyof typeof q.stats) => q.stats[k] - before[k];
          for (const k of ['claims', 'clusters', 'elisions', 'defences'] as const) {
            if (d(k) > 0) parts.push(`+${d(k)} ${k}`);
          }
        }
        if (q) statsRef.current = q.stats;
        setToast(
          j.status === 'failed'
            ? `${j.label} failed (exit ${j.code})`
            : `${j.label} finished${parts.length ? ` — ${parts.join(', ')}` : ' — nothing changed'}`,
        );
      })();
    });
    // The stack was re-derived because claims changed; pull the new one.
    const offDerived = window.vds.onDerived(() => void refresh());
    /**
     * A campaign round finished. The sample is already on disk by the time this arrives, so
     * the payload is a signal rather than the data — pulling it back with everything else
     * keeps one source of truth for what the burndown draws.
     */
    const offCampaign = window.vds.onCampaign(({ sample }) => {
      setToast(`round ${sample.round} — ${sample.open} open, ${sample.settled} settled`);
      void refresh();
    });
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
      offCampaign();
      offStats();
      offOut();
    };
  }, [refresh]);

  const running = jobs.filter((j) => j.status === 'running');
  const mapped = !!data?.stack;
  // Main owns the watcher and stops it when the repo changes, so main is what reports it.
  const watchingFiles = !!data?.watching;
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
        {/* Re-derive the stack from the cached graph. Far cheaper than a remap, and the
            thing you want after arbitrating: the map is stale with respect to your decision,
            not with respect to the source. */}
        <button
          className="where"
          disabled={!mapped || busy}
          onClick={() => act(() => window.vds.refocus())}
          title="rebuild the focus stack from the cached graph — no re-extraction, nothing spent"
        >
          rebuild
        </button>
        <button
          className="where"
          disabled={!data?.repo}
          style={watchingFiles ? { color: 'var(--ok)' } : undefined}
          title="re-map automatically when the code changes; only changed files re-parse"
          onClick={() => act(async () => window.vds.watch(!watchingFiles))}
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
            saved={saved}
            onApply={setFilters}
            onForget={(name) => setSaved((s) => s.filter((x) => x.name !== name))}
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
              saved={saved.some((s) => s.name === filterSetName(filters))}
              onSave={() => {
                const name = filterSetName(filters);
                setSaved((s) => (s.some((x) => x.name === name) ? s : [...s, { name, filters }]));
              }}
            />
          )}

          <div className={onMap ? 'stage-view scene' : 'stage-view'}>
            {onMap && mapped && (
              <Scene data={sceneData} channel={lens} onChannel={setLens} flagged={flagged} onSelect={setNode} />
            )}

            {/* One owner for the unmapped moment. The scene has an empty state of its own and
                it used to print underneath this one. */}
            {!mapped && <Empty hasRepo={!!data?.repo} />}

            {mapped && data && view === 'detect' && (
              <Detect
                data={data}
                query={query}
                candidates={candidates}
                selected={pickedCandidates}
                onSelected={setPickedCandidates}
                onExplore={scopeRun}
                onRefresh={refresh}
                onOpenBelief={(b) => { setOpenBelief(b); setView('beliefs'); }}
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
                onLaunch={(opts) => {
                  setCeiling(opts.maxCost);
                  return act(() => window.vds.agent(opts));
                }}
                onRun={(opts) => {
                  setCeiling(opts.maxCost);
                  void act(() => window.vds.run(opts));
                }}
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
                  ceiling={ceiling}
                  campaign={data?.campaign ?? []}
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
