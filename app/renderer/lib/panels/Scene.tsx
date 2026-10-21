import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { LoadPayload, NodeBelief } from '../types.ts';
import { DEFAULT_SETTINGS, normaliseSettings } from '../../../../engine/render/settings.ts';
import type { RenderSettings } from '../types.ts';
import { SceneController, type SceneCounters, type SceneStats } from '../scene/controller.ts';
import { layoutReadable, sceneIo } from '../scene/read-only.ts';
import {
  agentColor, BELIEF, CHANNEL_HELP, COLD, COLORS, FLAGGED, HOT, SETTLED, type Channel,
} from '../scene/palette.ts';

export type { Channel } from '../scene/palette.ts';

/**
 * The festooned tree, as React sees it.
 *
 * React owns the controls and the accessibility surface: the HUD, the legend, the meter and
 * every piece of state a person can toggle. The canvas belongs to `SceneController`, which is
 * built once per mount and told about changes through methods whose cost matches the change —
 * a new lens recolours in place, a new layout rebuilds geometry on the same renderer, and only
 * a new repository gets a new WebGL context. The classification itself lives in
 * `scene/lifecycle.ts`, where the engine's tests can reach it.
 */

declare global {
  interface Window {
    /**
     * For the headless harness: read the lifecycle counters and drive a lens change through
     * the real React path, so a shot can assert that switching lens twice created one renderer.
     */
    __daylightScene?: { counters: SceneCounters; setChannel: (c: Channel) => void };
  }
}

/**
 * What the scene hands out when you click something.
 *
 * A narrow read of the laid-out node — the fields an inspector can be written against —
 * rather than the layout record itself, which carries meshes and positions the shell has
 * no business seeing.
 */
export interface SceneNode {
  id: string;
  label: string;
  level: number;
  fileCount: number;
  origin: string;
  purpose?: string;
  members?: string[];
  belief?: NodeBelief;
  isFile?: boolean;
  isSymbol?: boolean;
}

/**
 * The legend has to follow the channel. A fixed key would describe one colouring while the
 * scene showed another, which is worse than no key at all — the viewer would trust it.
 */
function Legend({ channel, agents, mode }: { channel: Channel; agents: string[]; mode: string }) {
  const [open, setOpen] = useState(true);
  const swatch = (c: THREE.Color | string, label: string, note?: string) => (
    <div className="key" key={label}>
      <i className="dot" style={{ background: typeof c === 'string' ? c : `#${c.getHexString()}` }} />
      <span>{label}</span>
      {note && <em>{note}</em>}
    </div>
  );

  return (
    <div className={open ? 'legend' : 'legend closed'}>
      <button className="legend-head" onClick={() => setOpen(!open)}>
        {channel} key {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="legend-body">
          {channel === 'structure' && (
            <>
              {swatch(COLORS.named, 'agent-named cluster', 'intent')}
              {swatch(COLORS.path, 'path group', 'filing, not intent')}
              {swatch(COLORS.defended, 'defended', 'must survive focusing')}
            </>
          )}
          {channel === 'belief' && (
            <>
              {swatch(BELIEF.UNKNOWN, 'unknown', 'never examined')}
              {swatch(BELIEF.INFERRED, 'inferred', 'one source')}
              {swatch(BELIEF.CORROBORATED, 'corroborated', 'two or more agree')}
              {swatch(BELIEF.CONFIRMED, 'confirmed', 'human-arbitrated')}
              {swatch(BELIEF.CONTRADICTED, 'contradicted', 'sources disagree')}
              {swatch(BELIEF.STALE, 'stale', 'file changed since')}
              <p className="legend-note">Brightness tracks how many members carry a claim.</p>
            </>
          )}
          {channel === 'candidates' && (
            <>
              {swatch(FLAGGED, 'flagged', 'a static tool pointed here')}
              {swatch(BELIEF.UNKNOWN, 'nothing flagged')}
              <p className="legend-note">
                Brightness tracks how many of the node's files were flagged, not how bad it is.
                A candidate is a question, never a verdict.
              </p>
            </>
          )}
          {channel === 'change' && (
            <>
              {swatch(BELIEF.STALE, 'stale', 'the file changed under the claim')}
              {swatch(SETTLED, 'still standing')}
              {swatch(BELIEF.UNKNOWN, 'nothing claimed here')}
            </>
          )}
          {channel === 'frontier' && (
            <>
              {swatch(COLD, 'looked at, or peripheral')}
              {swatch(HOT, 'unexamined and central')}
            </>
          )}
          {channel === 'agent' && (
            <>
              {agents.length
                ? agents.map((a) => swatch(agentColor(a), a))
                : <p className="legend-note">No agent has claimed anything here yet.</p>}
              {swatch(BELIEF.UNKNOWN, 'untouched')}
            </>
          )}

          <div className="legend-sep" />
          {swatch('#6ea8fe', 'spine', mode === 'tree' ? 'containment' : 'hierarchy')}
          {swatch('#8a5cf6', 'festoon', mode === 'tree' ? 'bundled via ancestors' : 'cross-edge')}
          {swatch('#ffd479', 'highlighted', 'hovered, and its subtree')}
        </div>
      )}
    </div>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * What the Scene draws from. `LoadPayload` is one; a refine map (`ForgeRefineMap`) is another,
 * with no `dir`, because it is not the checkout's map and nothing of the checkout's is read for it.
 */
export type SceneData = Pick<LoadPayload, 'stack' | 'fileEdges' | 'repo' | 'defended'> & { dir?: string; initialMode?: 'graph' | 'tree' };

export function Scene({ data, channel, onChannel, flagged, onSelect, readOnly }: {
  data: SceneData | null;
  /**
   * Controlled, because the lens is a mode in the shell rather than a chip on the canvas.
   * The scene renders a colouring; it does not decide which question is being asked.
   */
  channel: Channel;
  onChannel: (c: Channel) => void;
  /** Files a static detector pointed at, for the candidates lens. */
  flagged: ReadonlySet<string>;
  /**
   * Selection is reported outward because the inspector is a region of the shell now, not
   * a box floating over the canvas. Held here as well as there: the scene needs it to
   * re-select the same node across a layout switch.
   */
  onSelect: (node: SceneNode | null) => void;
  /**
   * Set, the reason this map is read-only (P2-R45 D3): no layout read or write, no symbols
   * call, no node drag and no alt-click expand, and the keys line says why instead.
   */
  readOnly?: string;
}) {
  const io = sceneIo(readOnly, window.daylight);
  const ioRef = useRef(io);
  ioRef.current = io;
  const mountRef = useRef<HTMLDivElement>(null);
  /**
   * Props the controller calls back into, through refs: the controller is built once and
   * would otherwise keep calling whichever `onSelect` existed when it was built.
   */
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const channelRef = useRef(onChannel);
  channelRef.current = onChannel;

  const [level, setLevel] = useState(3);
  const [levels, setLevels] = useState<number[]>([3, 2, 1]);
  const [mode, setMode] = useState<'graph' | 'tree'>('graph');
  /**
   * 'all' renders every level at once; 'auto' is the distance-driven LOD.
   *
   * Measured on the 449-node / 855-rope fixture: LOD 0.14ms/frame vs all-visible
   * 0.28ms — a 0.14ms saving against a 16.7ms budget, under 1% of a frame. Nodes are
   * instanced so a level costs one draw call whether it holds 7 or 449 of them, and the
   * per-frame CPU work (label layout, picking) is bounded by screen area, not tree size.
   *
   * So LOD is not a performance mechanism at this scale; it is a legibility one, and on a
   * small tree the popping costs more attention than the decluttering returns. Default to
   * showing everything and only fall back to LOD when the tree is genuinely large.
   */
  const [lod, setLod] = useState<'auto' | 'all'>('all');
  /** Per-machine render settings. Loaded once; only the limit is a layout input. */
  const [settings, setSettings] = useState<RenderSettings>(DEFAULT_SETTINGS);
  const [adaptNote, setAdaptNote] = useState<string | null>(null);
  const [gpu, setGpu] = useState<string>('');
  /**
   * Nodes the user has moved.
   *
   * The layout is deterministic so that spatial memory works — the same repo lands the same
   * way every session. These are deliberate exceptions on top of it: in a region dense enough
   * that nodes overlap, no automatic layout can show you the relationship you are chasing, so
   * you pull the thing out and look at it. Keyed by node id rather than by position, so they
   * survive a re-map as long as the node still exists.
   */
  const [moved, setMoved] = useState<Record<string, [number, number, number]>>({});
  const movedRef = useRef(moved);
  movedRef.current = moved;
  const [stats, setStats] = useState<SceneStats>(
    { fps: 0, meanMs: 0, p95Ms: 0, worstMs: 0, samples: 0, visible: 0, draws: 0, tris: 0 },
  );
  useEffect(() => {
    void window.daylight.settings().then((s) => setSettings(normaliseSettings(s)));
  }, []);
  // Positions the user moved last time. Loaded once, keyed by node id, so a re-map keeps
  // every override whose node still exists and silently forgets the rest.
  useEffect(() => {
    if (!layoutReadable(data?.dir, readOnly)) return;
    void ioRef.current.layout().then((r) => {
      if (r?.moved && Object.keys(r.moved).length) setMoved(r.moved);
    });
  }, [data?.dir, readOnly]);
  const [nodeCount, setNodeCount] = useState(0);
  const [agents, setAgents] = useState<string[]>([]);
  const [pulses, setPulses] = useState(true);
  const [swarm, setSwarm] = useState(true);
  const seededMode = useRef(false);
  /**
   * Files opened to show their symbols.
   *
   * Expand-on-demand rather than a depth setting: every symbol at once is roughly ten times
   * the nodes and reliably unreadable, so you pay the node count only where you asked a
   * question.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  /**
   * Symbols for the files that have been opened, fetched one file at a time.
   *
   * The whole index used to arrive with every load — 28MB on a large monorepo, to answer a
   * question about one file. Now it is asked for when you open something.
   */
  const [symbols, setSymbols] = useState<Record<string, Array<{ id: string; name: string; kind: string }>>>({});

  // `data` is null on first render, so an initial mode from the host has to be applied
  // when it actually arrives — once, so it never fights the user's own toggle.
  useEffect(() => {
    if (seededMode.current || !data?.initialMode) return;
    seededMode.current = true;
    if (data.initialMode !== 'graph') setMode(data.initialMode);
    const seedLod = (data as any).lodDefault;
    if (seedLod === 'auto') setLod('auto');
    const seedChannel = (data as any).channelDefault as Channel | undefined;
    if (seedChannel && seedChannel !== 'structure') onChannel(seedChannel);
  }, [data?.initialMode]);

  /**
   * The controller, as state rather than a ref, so the effects below re-run against a new
   * one when the mount or the repository changes. Toggling `pulses` or `swarm` goes through
   * the controller too, rather than through refs the loop reads: the loop is the controller's.
   */
  const [ctrl, setCtrl] = useState<SceneController | null>(null);
  const hasStack = !!data?.stack;
  const repo = data?.repo ?? null;
  const toggleExpand = useCallback((id: string) => {
    const next = new Set(expandedRef.current);
    if (next.has(id)) {
      next.delete(id);
      setExpanded(next);
      return;
    }
    next.add(id);
    // Fetch before expanding, so the relayout happens once with the symbols in hand
    // rather than once empty and again when they arrive.
    void ioRef.current.symbols({ file: id }).then((r) => {
      setSymbols((prev) => ({ ...prev, [id]: r.symbols ?? [] }));
      setExpanded(next);
    });
  }, []);
  const repoRef = useRef(repo);
  repoRef.current = repo;

  // ---- rebuild: one renderer per mount and per repository --------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !hasStack) return;
    const perfFlags = (data ?? {}) as { perf?: boolean; bench?: number; debugPick?: boolean };
    const controller = new SceneController(mount, {
      onSelect: (n) => selectRef.current(n),
      onLevel: setLevel,
      onLevels: setLevels,
      onAgents: setAgents,
      onNodeCount: setNodeCount,
      onGpu: setGpu,
      onStats: setStats,
      onAdapted: (learned, note) => {
        void window.daylight.settings({ allLevelsLimit: learned });
        setSettings((prev) => ({ ...prev, allLevelsLimit: learned }));
        setAdaptNote(note);
      },
      onMoved: (key, at) => {
        setMoved((prev) => ({ ...prev, [key]: at }));
        void ioRef.current.layout({ repo: repoRef.current ?? '', moved: { ...movedRef.current, [key]: at } });
      },
      onToggleExpand: toggleExpand,
    }, { perf: !!perfFlags.perf, bench: Number(perfFlags.bench ?? 0), debugPick: !!perfFlags.debugPick, readOnly: !!readOnly });
    setCtrl(controller);
    window.__daylightScene = { counters: controller.counters, setChannel: (c) => channelRef.current(c) };
    return () => {
      controller.dispose();
      setCtrl((cur) => (cur === controller ? null : cur));
      if (window.__daylightScene?.counters === controller.counters) delete window.__daylightScene;
    };
    // `data` is read for its one-shot flags only; it must not be a dependency here or
    // every reload would be a new WebGL context, which is the bug this file replaced.
  }, [hasStack, repo, toggleExpand, !!readOnly]);

  // ---- relayout: anything that moves a node or changes which nodes exist -------------
  useEffect(() => {
    if (!ctrl || !data?.stack) return;
    const repoName = (data.repo ?? 'repo').split('/').filter(Boolean).pop() ?? 'repo';
    ctrl.loadProjection({
      stack: data.stack,
      fileEdges: data.fileEdges,
      symbols,
      expanded,
      moved,
      mode,
      lod,
      allLevelsLimit: settings.allLevelsLimit,
      repoName,
    });
  }, [ctrl, data?.stack, data?.fileEdges, data?.repo, mode, lod, expanded, symbols, moved,
      settings.allLevelsLimit]);

  // ---- recolor: the lens, and what it reads from -------------------------------------
  const defended = data?.defended;
  useEffect(() => {
    if (!ctrl) return;
    ctrl.setChannel({
      channel,
      flagged: flagged ?? EMPTY_SET,
      defended: new Set((defended ?? []).map(String)),
    });
  }, [ctrl, channel, flagged, defended]);

  useEffect(() => { ctrl?.setPulses(pulses); }, [ctrl, pulses]);
  useEffect(() => { ctrl?.setSwarm(swarm); }, [ctrl, swarm]);
  useEffect(() => { ctrl?.setShowFps(settings.showFps); }, [ctrl, settings.showFps]);

  if (!data?.stack) {
    return <div className="scene-empty">Map a repo to see the tree.</div>;
  }

  return (
    <div className="scene-wrap">
      <div className="scene-canvas" ref={mountRef} />
      <div className="scene-hud">
        <div className="lod">
          <button
            className={mode === 'graph' ? 'chip active' : 'chip'}
            onClick={() => setMode('graph')}
            title="focus stack — weighted graph"
          >
            graph
          </button>
          <button
            className={mode === 'tree' ? 'chip active' : 'chip'}
            onClick={() => setMode('tree')}
            title="file tree — cone hierarchy"
          >
            tree
          </button>
          <span className="sep" />
          <button
            className={pulses ? 'chip active' : 'chip'}
            onClick={() => setPulses(!pulses)}
            title="flash a node when an agent claims something about it"
          >
            pulse
          </button>
          <button
            className={swarm ? 'chip active' : 'chip'}
            onClick={() => setSwarm(!swarm)}
            title="show each agent as a marker at the node it is currently looking at"
          >
            swarm
          </button>
          <span className="sep" />
          <button
            className={lod === 'all' ? 'chip active' : 'chip'}
            onClick={() => setLod(lod === 'all' ? 'auto' : 'all')}
            title={
              lod === 'all'
                ? 'showing every level — click for distance-driven detail'
                : 'detail follows camera distance — click to show everything'
            }
          >
            {lod === 'all' ? 'all levels' : 'auto detail'}
          </button>
          {lod === 'auto' && levels.map((n) => (
            <button
              key={n}
              className={n === level ? 'chip active' : 'chip'}
              onClick={() => ctrl?.setLevel(n)}
            >
              {mode === 'tree' ? `d${n}` : `L${n}`}
            </button>
          ))}
          <span className="dim">
            {channel !== 'structure'
              ? CHANNEL_HELP[channel]
              : lod === 'all'
              ? ''
              : mode === 'tree'
                ? 'camera distance = tree depth'
                : levels.length === 1
                  ? 'one level — nothing focused yet, so L1/L2/L3 are the same map'
                  : 'camera distance = focus altitude'}
          </span>
        </div>
        {adaptNote && (
          <div className="hint" onClick={() => setAdaptNote(null)}>{adaptNote}</div>
        )}
        {settings.showFps && (
          <div className={stats.p95Ms > 16.7 ? 'scene-fps over' : 'scene-fps'}>
            <span className="fps-headline">
              <strong>{stats.fps.toFixed(0)}</strong> fps
            </span>
            {/* Mean is the number that hides a stutter; p95 is the one you feel. */}
            <span>{stats.meanMs.toFixed(1)}ms mean</span>
            <span>{stats.p95Ms.toFixed(1)}ms p95</span>
            <span>{stats.worstMs.toFixed(1)}ms worst</span>
            <span className="dim">
              {stats.visible.toLocaleString()} of {nodeCount.toLocaleString()} drawn
            </span>
            <span className="dim">{stats.draws} draws · {(stats.tris / 1000).toFixed(0)}k tris</span>
            <span className="dim">
              limit {settings.allLevelsLimit === 0 ? 'off' : settings.allLevelsLimit.toLocaleString()}
            </span>
            {/* A discrete card the platform declined to use is worth saying out loud: the
                default is wrong on a laptop and wrong quietly. */}
            {gpu && (data as any).discreteGpu && !/nvidia/i.test(gpu) && (
              <span className="fps-hint" title={`pnpm gui:dgpu`}>
                {String((data as any).discreteGpu)} idle — <code>pnpm gui:dgpu</code>
              </span>
            )}
            {gpu && (
              <span className="dim" title={gpu}>
                {/* ANGLE wraps the real name in parentheses and a pile of driver detail. */}
                {(/\(([^,]+),\s*([^,)]+)/.exec(gpu)?.[2] ?? gpu).trim().slice(0, 28)}
              </span>
            )}
            <button
              className="link"
              onClick={() => {
                // Off means "draw everything, I have measured this machine".
                const next = settings.allLevelsLimit === 0 ? DEFAULT_SETTINGS.allLevelsLimit : 0;
                setSettings({ ...settings, allLevelsLimit: next });
                void window.daylight.settings({ allLevelsLimit: next });
              }}
            >
              {settings.allLevelsLimit === 0 ? 'restore limit' : 'draw everything'}
            </button>
          </div>
        )}
        <div className="scene-keys">
          <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> pan ·
          <kbd>Q</kbd><kbd>E</kbd> up/down · <kbd>shift</kbd> faster ·
          <kbd>0</kbd> recentre · drag orbit · right-drag pan · scroll{' '}
          {mode === 'tree' ? 'depth' : 'altitude'}
          {readOnly
            ? <span data-forge="read-only-reason"> · {readOnly}</span>
            : <>
              {mode === 'tree' && <> · <kbd>alt</kbd>-click a file to open its symbols</>}
              {' '}· drag a node to move it · <kbd>ctrl</kbd>-drag to orbit instead
            </>}
          {!readOnly && !!Object.keys(moved).length && (
            <>
              {' '}·{' '}
              <button
                className="link"
                onClick={() => {
                  setMoved({});
                  void ioRef.current.layout({ repo: data.repo ?? '', moved: {} });
                }}
              >
                put {Object.keys(moved).length} moved node
                {Object.keys(moved).length === 1 ? '' : 's'} back
              </button>
            </>
          )}
        </div>
      </div>
      <Legend channel={channel} agents={agents} mode={mode} />
    </div>
  );
}
