import * as THREE from 'three';
import { layout } from '../../../../engine/scene/layout.ts';
import { layoutTree } from '../../../../engine/scene/tree.ts';
import { applyMoved, type MovedNodes, type SceneLayout } from '../../../../engine/scene/types.ts';
import type { FocusStack } from '../../../../engine/focus/types.ts';
import type { RunEvent } from '../../../../engine/replay/types.ts';
import {
  limitAfterSlowdown, SLOW_FRAME_MS, summarise, type FrameStats,
} from '../../../../engine/render/settings.ts';
import { onReplayEvent, onReplayReset } from '../replay.ts';
import { agentColor, channelColor, type Channel } from './palette.ts';
import type { SceneLod, SceneMode } from '../../../../engine/scene/lifecycle.ts';

/**
 * The festooned tree, as a thing with a lifetime.
 *
 * Two properties this is built around, both carried over from the standalone viewer: the
 * spine is a pure function of the focus stack (no force relaxation, no randomness, so flying
 * around builds spatial memory), and LOD is SEMANTIC — camera distance IS altitude on the
 * focus stack, so pulling back collapses nodes into their agent-named abstraction rather
 * than fading them out.
 *
 * It used to be one React effect. The effect created the WebGL context, laid the scene out,
 * installed every handler and ran the animation loop, and its dependency list named the lens
 * alongside the layout — so switching from structure to belief, or a belief changing colour
 * while a swarm ran, tore the context down and rebuilt all of it. On a live run the shell
 * re-derives the map every few seconds, which meant the camera snapped home every few seconds
 * while someone was trying to watch.
 *
 * Now the controller owns the renderer for as long as the mount exists, `loadProjection`
 * rebuilds the geometry on top of it when the layout genuinely changes, and `setChannel`
 * rewrites instance colours in place. Camera, hover, pulses and agent markers survive a
 * relayout; nothing survives `dispose`. React owns the controls; this owns the canvas.
 *
 * The counters are the proof: a headless run can switch lens twice and read back that one
 * renderer was ever created.
 */

export interface ProjectionInput {
  stack: FocusStack;
  fileEdges: Array<{ from: string; to: string; weight: number }>;
  symbols?: Record<string, Array<{ id: string; name: string; kind: string }>>;
  expanded: ReadonlySet<string>;
  moved: MovedNodes;
  mode: SceneMode;
  lod: SceneLod;
  allLevelsLimit: number;
  repoName: string;
}

export interface Colouring {
  channel: Channel;
  flagged: ReadonlySet<string>;
  defended: ReadonlySet<string>;
}

export interface SceneStats extends FrameStats {
  visible: number;
  draws: number;
  tris: number;
}

export interface SceneCounters {
  /** WebGL renderers created. One per mount; anything higher is the bug this file replaced. */
  renderers: number;
  /** Layouts computed and built into geometry. */
  projections: number;
  /** In-place instance recolourings. */
  recolors: number;
}

/** What the scene reports back to React. Every method may be called from inside the loop. */
export interface SceneHost {
  onSelect(node: any | null): void;
  onLevel(level: number): void;
  onLevels(levels: number[]): void;
  onAgents(agents: string[]): void;
  onNodeCount(count: number): void;
  onGpu(name: string): void;
  onStats(stats: SceneStats): void;
  /** The machine could not keep up drawing everything; this is the limit it learned. */
  onAdapted(limit: number, note: string): void;
  /** A node was dragged and released here. */
  onMoved(key: string, at: [number, number, number]): void;
  /** Alt-click on a file: open or close its symbols. */
  onToggleExpand(fileId: string): void;
}

export interface SceneOptions {
  /** Print per-frame cost breakdowns to the console every few seconds. */
  perf?: boolean;
  /** Headless benchmark: sample this many seconds, print one line, stop sampling. */
  bench?: number;
  /** Print screen positions of a few nodes, for driving synthetic input at them. */
  debugPick?: boolean;
}

interface Rope {
  from: string;
  to: string;
  weight: number;
  via?: string[];
  mesh: THREE.LineSegments;
  start: number;
  count: number;
}

interface Flyer {
  label: string;
  color: THREE.Color;
  pos: THREE.Vector3;
  target: THREE.Vector3;
  trail: THREE.Vector3[];
  lastAt: number;
  mesh: THREE.Mesh;
  line: THREE.Line;
}

interface Orbit {
  theta: number;
  phi: number;
  distance: number;
  target: THREE.Vector3;
}

/** Everything built from one layout. Replaced whole by `loadProjection`, disposed with it. */
interface Projection {
  laid: SceneLayout;
  mode: SceneMode;
  lod: SceneLod;
  limit: number;
  showAll: boolean;
  distinct: number[];
  bands: Array<{ level: number; minDistance: number }>;
  byLevel: Map<number, any[]>;
  meshes: Map<number, THREE.InstancedMesh>;
  spineGroup: THREE.Group;
  festoonGroup: THREE.Group;
  ropes: Rope[];
  ropesByNode: Map<string, number[]>;
  nodeKeysForFile: Map<string, string[]>;
  maxHeat: number;
  /** Framing to return to, so panning is always recoverable with one key. */
  home: Orbit;
  active: number;
}

const PULSE = new THREE.Color('#ffe9a8');
const PULSE_MS = 2200;
const HL_NODE = new THREE.Color('#6ea8fe');
const HL_EDGE = new THREE.Color('#ffd479');
const BASE_EDGE = new THREE.Color('#8a5cf6');
const HEAVY_EDGE = new THREE.Color('#c07ef0');
const TRAIL = 24;
const IDLE_MS = 45_000;
const FRAME_WINDOW = 90;
const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);
const MAX_LABELS = 90;

const scratch = new THREE.Color();

const esc = (t: string) =>
  t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
const shortId = (k: string) => esc(k.replace(/^t:/, '').split('/').slice(-2).join('/'));

export class SceneController {
  readonly counters: SceneCounters = { renderers: 0, projections: 0, recolors: 0 };

  private readonly mount: HTMLElement;
  private readonly host: SceneHost;
  private readonly opts: SceneOptions;

  private readonly canvas: HTMLCanvasElement;
  private readonly labelLayer: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly geo = new THREE.SphereGeometry(1, 20, 14);
  private readonly flyerGeo = new THREE.ConeGeometry(0.62, 1.9, 6);
  private readonly agentGroup = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ro: ResizeObserver;
  private readonly offEvent: () => void;
  private readonly offReset: () => void;

  private proj: Projection | null = null;
  private colouring: Colouring = { channel: 'structure', flagged: new Set(), defended: new Set() };
  private readonly orbit: Orbit = {
    theta: 0.7, phi: 1.15, distance: 300, target: new THREE.Vector3(),
  };
  private lastAspect = 0;

  // ---- input state ---------------------------------------------------------
  private readonly pointer = new THREE.Vector2(-2, -2);
  private readonly lastPointer = { x: 0, y: 0 };
  private dragging = false;
  private panning = false;
  private last = { x: 0, y: 0 };
  private hovered: any = null;
  private hoveredRope: number | null = null;
  private highlighted: number[] = [];
  private moving: { key: string; plane: THREE.Plane; offset: THREE.Vector3 } | null = null;
  private readonly dragPoint = new THREE.Vector3();
  private readonly held = new Set<string>();
  /** The node to re-select after a layout switch, if the new layout has it. */
  private selectedId: string | null = null;

  // ---- toggles React owns ---------------------------------------------------
  private pulses = true;
  private swarm = true;
  private showFps = false;

  // ---- live overlays --------------------------------------------------------
  private readonly pulseUntil = new Map<string, number>();
  private readonly flyers = new Map<string, Flyer>();

  // ---- the loop -------------------------------------------------------------
  private raf = 0;
  private disposed = false;
  private lastFrame = 0;
  private frames = 0;
  private accum = 0;
  private labelWork = 0;
  private pickWork = 0;
  private reportAt = 0;
  private readonly frameTimes: number[] = [];
  private meterAt = 0;
  private readonly adaptTimes: number[] = [];
  private slowSince = 0;
  private adapted = false;
  private readonly benchTimes: number[] = [];
  private benchUntil = 0;
  private readonly projected = new THREE.Vector3();
  private readonly nudgeMatrix = new THREE.Matrix4();

  constructor(mount: HTMLElement, host: SceneHost, opts: SceneOptions = {}) {
    this.mount = mount;
    this.host = host;
    this.opts = opts;

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block';
    mount.appendChild(this.canvas);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'labels';
    mount.appendChild(this.labelLayer);

    this.tip = document.createElement('div');
    this.tip.className = 'scene-tip';
    this.tip.style.display = 'none';
    mount.appendChild(this.tip);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a0c10');
    // Fog has to follow the camera. A fixed range was tuned for the graph layout, and the
    // tree of a 400-file repo sits far enough out that every node fell past `far` and
    // rendered as pure background — the map looked empty while the DOM labels kept working.
    this.scene.fog = new THREE.Fog('#0a0c10', 320, 900);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 3000);
    /**
     * Ask for the discrete GPU.
     *
     * Without `powerPreference` the browser picks, and on a laptop it picks the integrated
     * chip: a benchmark on this machine reported an AMD Radeon 610M while a mobile 4080 sat
     * idle. It is a hint rather than a guarantee — the driver and the platform's power policy
     * both get a say — which is why the meter reports the GPU that actually rendered.
     */
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.counters.renderers++;
    const gpu = this.gpuName();
    if (gpu) host.onGpu(gpu);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.8);
    dir.position.set(120, 220, 140);
    this.scene.add(dir);
    this.scene.add(this.agentGroup);

    this.canvas.addEventListener('pointerdown', this.onDown);
    addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointermove', this.onMove);
    // Synthetic input (Electron's sendInputEvent, used for headless verification) emits
    // mouse events rather than pointer events, so track both.
    this.canvas.addEventListener('mousemove', this.onMove as unknown as EventListener);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('click', this.onClick);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);

    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(mount);
    this.resize();

    /**
     * Replay drops everything the map has accumulated.
     *
     * Markers and pulses are the state built up by watching events go past, so a jump
     * backwards has to clear them — otherwise the replay's first frame is the run's
     * beginning drawn on top of its end.
     */
    this.offReset = onReplayReset(() => this.resetAgents());
    // One path for live and replayed events: the scene cannot tell which it is drawing,
    // which is the only way a replay stays a picture of what actually happened.
    this.offEvent = onReplayEvent((e) => this.updateAgentOverlay(e));

    this.tick();
  }

  // ---- public surface ---------------------------------------------------------

  /**
   * Lay the stack out and build its geometry on the existing renderer.
   *
   * The camera is kept where it was unless the mode changed — a tree and a graph are framed
   * differently enough that carrying an orbit between them shows nothing — or this is the
   * first projection. Hover and drag state are dropped, because they point at nodes of a
   * layout that no longer exists; pulses and markers are keyed by node and carry over.
   */
  loadProjection(input: ProjectionInput): void {
    if (this.disposed) return;
    const prev = this.proj;
    const resetCamera = !prev || prev.mode !== input.mode;
    if (prev) this.disposeProjection(prev);

    const laid: SceneLayout = input.mode === 'tree'
      ? layoutTree(
        { stack: input.stack, fileEdges: input.fileEdges, symbols: input.symbols },
        input.repoName, input.expanded,
      )
      : layout(input.stack, input.repoName);

    // Before anything is built from the layout, so ropes, labels and picking all agree with
    // where the node actually is.
    applyMoved(laid, input.moved);
    const bands = laid.bands;
    const distinct = bands.map((b) => b.level);
    this.host.onLevels(distinct);
    // Count what is drawn, not what exists: with identical partitions the duplicate
    // levels never render, and reporting them inflated the number by 3x.
    this.host.onAgents(
      [...new Set([...laid.nodes.values()].flatMap((n: any) => n.belief?.agents ?? []))]
        .sort() as string[],
    );
    this.host.onNodeCount(
      [...laid.nodes.values()].filter((n) => distinct.includes(n.level) || n.isRoot).length,
    );
    /**
     * The limit is a setting now, not a constant.
     *
     * It was 2500, hard-coded, and it silently overrode the user's own choice: on any repo
     * past it the 'all levels' button was inert and nothing in the interface said so. A limit
     * is reasonable — a limit you cannot see or move is a bug wearing a constant's clothes.
     * Zero means never fall back, for a machine whose owner has measured it.
     */
    const limit = input.allLevelsLimit;
    const showAll = input.lod === 'all' && (limit === 0 || laid.nodes.size <= limit);
    // 6% of the layout's radius: big enough to read as "this holds a lot", small enough that
    // it cannot hide what is behind it.
    const layoutExtent = Math.max(1, ...[...laid.nodes.values()].map((n) => Math.hypot(n.x, n.z)));
    const maxNodeRadius = layoutExtent * 0.06;
    const maxHeat = Math.max(0, ...[...laid.nodes.values()].map((n: any) => n.belief?.heat ?? 0));

    const byLevel = new Map<number, any[]>();
    for (const lvl of distinct) byLevel.set(lvl, []);
    for (const node of laid.nodes.values()) {
      // The root sits above the shallowest band, so it rides along with that one.
      // Everything else must belong to a real band — funnelling non-distinct levels
      // here is what redrew the same partition three times over.
      if (byLevel.has(node.level)) byLevel.get(node.level)!.push(node);
      else if (node.isRoot) byLevel.get(distinct[0])!.push(node);
    }

    const proj: Projection = {
      laid, mode: input.mode, lod: input.lod, limit, showAll, distinct, bands, byLevel,
      meshes: new Map(), spineGroup: new THREE.Group(), festoonGroup: new THREE.Group(),
      ropes: [], ropesByNode: new Map(), nodeKeysForFile: new Map(), maxHeat,
      home: { theta: 0.7, phi: 1.15, distance: 300, target: new THREE.Vector3() },
      active: distinct[0],
    };
    // Set before anything paints: the mesh loop below colours through `baseColor`.
    this.proj = proj;
    this.counters.projections++;

    const defended = this.colouring.defended;
    for (const [lvl, nodes] of byLevel) {
      if (!nodes.length) continue;
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.InstancedMesh(this.geo, mat, nodes.length);
      const m = new THREE.Matrix4();
      nodes.forEach((node: any, i: number) => {
        /**
         * Size follows the layout's own density when it offers one.
         *
         * The old formula was absolute — a directory of 8424 files came out at radius 65,
         * which is fine in a layout 28,000 units wide and absurd in one shrunk to 520. It
         * also had a 27x dynamic range, so on a monorepo one sphere swallowed everything
         * near it. `unit` is a fraction of the mean gap between nodes, and the log keeps a
         * ten-thousand-file directory about three times a single file rather than thirty.
         *
         * Without a unit, no node may be a sizeable fraction of the whole map either: size
         * came from file count on an unbounded curve, so the cap is a share of the layout's
         * own extent and never fires on a repo whose largest node was already reasonable.
         */
        const u = laid.unit;
        const s = u
          ? node.isRoot
            ? u * 3
            : node.isSymbol
              ? u * 0.6
              : node.isFile
                ? u
                : u * (1 + Math.log10(1 + Math.max(node.fileCount, 1)) * 0.55)
          : node.isRoot
            ? 5
            : node.isSymbol
              ? 1.3
              : node.isFile
                ? 2.2
                : Math.min(maxNodeRadius, 2.4 + Math.pow(Math.max(node.fileCount, 1), 0.42) * 1.5);
        m.makeScale(s, s, s);
        m.setPosition(node.x, node.y, node.z);
        mesh.setMatrixAt(i, m);
        // The root holds every file, so a membership test would always mark it defended.
        node.defended =
          !node.isRoot &&
          (node.members.some((mm: string) => defended.has(mm)) || defended.has(node.id));
        mesh.setColorAt(i, this.baseColor(node));
        node.index = i;
        node.radius = s;
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.userData.level = lvl;
      proj.meshes.set(lvl, mesh);
      this.scene.add(mesh);
    }

    // Spine, grouped by the level it descends into, plus a trunk from the origin.
    // Only levels that actually render as spheres get geometry. When partitions are
    // identical the duplicate levels are never drawn, and edges to their positions were
    // still being rendered — lines fanning out to nodes that do not exist.
    const drawn = (n: any) => distinct.includes(n.level) || n.isRoot;
    const perChild = new Map<number, number[]>();
    for (const e of laid.spine) {
      const a = laid.nodes.get(e.from);
      const b = laid.nodes.get(e.to);
      if (!a || !b || !drawn(a) || !drawn(b)) continue;
      if (!perChild.has(b.level)) perChild.set(b.level, []);
      perChild.get(b.level)!.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (const [childLevel, pts] of perChild) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const line = new THREE.LineSegments(
        g, new THREE.LineBasicMaterial({ color: '#6ea8fe', transparent: true, opacity: 0.3 }),
      );
      line.userData.level = childLevel;
      proj.spineGroup.add(line);
    }
    this.scene.add(proj.spineGroup);

    // Festoons dip toward the axis so co-travelling cross-edges read as one rope.
    //
    // Each rope records its vertex range so hovering can recolour just that span, and a
    // vertex→edge lookup makes the lines pickable: tracing a connection by eye stops
    // working the moment two of them cross.
    const perLevel = new Map<number, any[]>();
    for (const f of laid.festoons) {
      const a = laid.nodes.get(f.from);
      const b = laid.nodes.get(f.to);
      if (!a || !b || !drawn(a) || !drawn(b)) continue;
      if (!perLevel.has(f.level)) perLevel.set(f.level, []);
      perLevel.get(f.level)!.push(f);
    }
    for (const [lvl, list] of perLevel) {
      const positions: number[] = [];
      const colors: number[] = [];
      const vertexToRope: number[] = [];
      const fresh: Rope[] = [];

      for (const f of list) {
        const a = laid.nodes.get(f.from);
        const b = laid.nodes.get(f.to);
        if (!a || !b) continue;

        let pts: THREE.Vector3[];
        if (f.via && f.via.length > 2) {
          const route = f.via
            .map((k: string) => laid.nodes.get(k))
            .filter(Boolean)
            .map((n: any) => new THREE.Vector3(n.x, n.y, n.z));
          const beta = 0.82;
          const start = route[0];
          const end = route[route.length - 1];
          const relaxed = route.map((pt: THREE.Vector3, i: number) => {
            const t = i / (route.length - 1);
            return pt.clone().lerp(start.clone().lerp(end, t), 1 - beta);
          });
          pts = new THREE.CatmullRomCurve3(relaxed).getPoints(Math.min(48, route.length * 8));
        } else {
          const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
          const span = Math.hypot(a.x - b.x, a.z - b.z);
          mid.x *= 0.34;
          mid.z *= 0.34;
          mid.y -= Math.min(span * 0.16, 26);
          pts = new THREE.QuadraticBezierCurve3(
            new THREE.Vector3(a.x, a.y, a.z), mid, new THREE.Vector3(b.x, b.y, b.z),
          ).getPoints(14);
        }

        const c = f.weight > 12 ? HEAVY_EDGE : BASE_EDGE;
        const startVertex = positions.length / 3;
        const ropeIndex = proj.ropes.length + fresh.length;
        for (let i = 0; i < pts.length - 1; i++) {
          positions.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
          colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
          vertexToRope.push(ropeIndex, ropeIndex);
        }
        fresh.push({
          from: f.from, to: f.to, weight: f.weight, via: f.via,
          mesh: null as unknown as THREE.LineSegments, start: startVertex, count: (pts.length - 1) * 2,
        });
      }

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const lines = new THREE.LineSegments(
        g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.34 }),
      );
      lines.userData.level = lvl;
      lines.userData.vertexToRope = vertexToRope;
      lines.userData.baseColors = Float32Array.from(colors);
      for (const r of fresh) r.mesh = lines;
      proj.ropes.push(...fresh);
      proj.festoonGroup.add(lines);
    }
    this.scene.add(proj.festoonGroup);

    proj.ropes.forEach((r, i) => {
      // Register against the endpoints AND every ancestor on the route, so hovering a
      // directory lights every dependency entering or leaving its subtree — which is the
      // whole "this limb's edges all go elsewhere" reading. The root is skipped: it
      // contains everything, so highlighting from it would light the entire scene.
      const keys = new Set<string>([r.from, r.to, ...(r.via ?? [])]);
      for (const k of keys) {
        if (laid.nodes.get(k)?.isRoot) continue;
        const list = proj.ropesByNode.get(k);
        if (list) list.push(i);
        else proj.ropesByNode.set(k, [i]);
      }
    });

    for (const n of laid.nodes.values()) {
      for (const m of n.members) {
        const list = proj.nodeKeysForFile.get(m);
        if (list) list.push(n.key);
        else proj.nodeKeysForFile.set(m, [n.key]);
      }
    }

    /**
     * Frame what will actually be drawn, not the whole layout.
     *
     * LOD renders cumulatively up to whichever band the distance selects, so on a large tree
     * the first view is the top few levels — and those are wide but shallow. Framing to the
     * full depth pointed the camera a couple of hundred units below anything visible, which
     * put a 10k-file monorepo in the top-left corner of the window and made a correct layout
     * look broken. So: guess a distance, see which levels that shows, then frame those. One
     * pass is enough — the second only ever tightens it.
     */
    const treeNodes = [...laid.nodes.values()];
    const frameFor = (maxLevel: number) => {
      const shown = treeNodes.filter((n) => n.level <= maxLevel);
      const pool = shown.length ? shown : treeNodes;
      const radial = Math.max(...pool.map((n) => Math.hypot(n.x, n.z)), 1);
      const lo = Math.min(...pool.map((n) => n.y));
      const hi = Math.max(...pool.map((n) => n.y));
      return {
        distance: Math.max(200, radial * 1.5, (hi - lo) * 1.15),
        centreY: (lo + hi) / 2,
      };
    };
    let frame = frameFor(laid.maxDepth ?? 99);
    if (laid.mode === 'tree' && !showAll) {
      const band = laid.bands.find((b) => frame.distance >= b.minDistance);
      if (band) frame = frameFor(band.level);
    }
    proj.home = {
      theta: 0.7,
      phi: laid.mode === 'tree' ? 1.35 : 1.15,
      distance: laid.mode === 'tree' ? frame.distance : 300,
      target: new THREE.Vector3(0, laid.mode === 'tree' ? frame.centreY : 0, 0),
    };
    if (resetCamera) this.goHome();

    // The old layout's nodes are gone; anything pointing at one is stale.
    this.hovered = null;
    this.hoveredRope = null;
    this.highlighted = [];
    this.moving = null;
    this.canvas.style.cursor = '';
    this.hideTip();

    this.applyLevel(distinct[0], resetCamera);

    // Re-select the same node after a layout switch, if this layout has it.
    if (this.selectedId) {
      for (const n of laid.nodes.values()) {
        if (n.id === this.selectedId) {
          this.host.onSelect({ ...n });
          break;
        }
      }
    }

    if (this.opts.debugPick) {
      setTimeout(() => {
        if (this.proj !== proj) return;
        const r = this.canvas.getBoundingClientRect();
        const v = new THREE.Vector3();
        const picks = [...laid.nodes.values()]
          .filter((n: any) => !n.isRoot && proj.meshes.get(n.level)?.visible)
          .slice(0, 6)
          .map((n: any) => {
            v.set(n.x, n.y, n.z).project(this.camera);
            return {
              id: n.id,
              x: Math.round(r.left + ((v.x + 1) / 2) * r.width),
              y: Math.round(r.top + ((1 - v.y) / 2) * r.height),
            };
          });
        console.error(`PICKS ${JSON.stringify(picks)}`);
      }, 3500);
    }
  }

  /**
   * Change what the colours mean, without touching geometry.
   *
   * Every instance is repainted from the new channel; the hovered node keeps its highlight
   * and a pulsing node keeps its pulse, both of which are computed over the base colour.
   */
  setChannel(colouring: Colouring): void {
    if (this.disposed) return;
    this.colouring = colouring;
    const proj = this.proj;
    if (!proj) return;
    const defended = colouring.defended;
    for (const [lvl, mesh] of proj.meshes) {
      for (const node of proj.byLevel.get(lvl) ?? []) {
        node.defended =
          !node.isRoot &&
          (node.members.some((mm: string) => defended.has(mm)) || defended.has(node.id));
        mesh.setColorAt(
          node.index,
          node === this.hovered ? HL_NODE : this.pulseColor(node) ?? this.baseColor(node),
        );
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.counters.recolors++;
  }

  /** Remember which node is selected, so a layout switch can re-select it. */
  setSelection(id: string | null): void {
    this.selectedId = id;
  }

  /** Jump the camera to a level's altitude. The HUD's level chips call this. */
  setLevel(n: number): void {
    const proj = this.proj;
    if (!proj) return;
    this.applyLevel(n, true);
    this.orbit.distance = (proj.bands.find((b) => b.level === n)?.minDistance || 90) + 60;
  }

  setPulses(on: boolean): void { this.pulses = on; }
  setSwarm(on: boolean): void { this.swarm = on; }
  setShowFps(on: boolean): void { this.showFps = on; }

  /**
   * Move an agent's marker to the node its latest event touched, and pulse that node.
   *
   * An agent has no position — but it does have *attention*, and every get_slice records
   * which node it asked to look at. The marker sits on a node the agent genuinely touched;
   * the flight between two such nodes is a visual transition, not a claim that it travelled
   * through anything on the way.
   */
  updateAgentOverlay(e: RunEvent): void {
    const proj = this.proj;
    if (!proj || this.disposed) return;
    const subject = (e.subject ?? e.node) as string | undefined;
    const file = subject ? subject.split('#')[0] : null;
    const keys = file ? proj.nodeKeysForFile.get(file) ?? [] : [];

    if (this.pulses && keys.length) {
      // Ancestors pulse too — the path to the touched node lighting up is the point —
      // but not the root, which contains everything and would simply strobe.
      for (const key of keys) {
        if (!proj.laid.nodes.get(key)?.isRoot) this.pulseUntil.set(key, performance.now() + PULSE_MS);
      }
    }

    if (!this.swarm) return;
    const label = `${e.agent}${e.model ? `/${e.model}` : ''}`;
    const flyer = this.flyerFor(e.session || label, label);
    flyer.lastAt = performance.now();

    // Fly to the MOST SPECIFIC node holding this file. The key list is built ancestors
    // first, so taking the head pinned every agent to the root and it never moved.
    //
    // Orientation calls like get_overview carry no subject, and inventing a destination
    // for them would be exactly the fabrication the referent rule forbids — so they
    // simply do not move the marker.
    const node = keys
      .map((k) => proj.laid.nodes.get(k))
      .filter((n): n is NonNullable<typeof n> => !!n && !n.isRoot)
      .sort((a, b) => a.members.length - b.members.length)[0];
    if (!node) return;
    flyer.target.set(node.x, node.y + (node.radius ?? 4) + 6, node.z);
    if (!flyer.trail.length) flyer.pos.copy(flyer.target);
    flyer.trail.push(flyer.target.clone());
    if (flyer.trail.length > TRAIL) flyer.trail.shift();
  }

  /** Drop every marker and pulse — the replay jumped backwards. */
  resetAgents(): void {
    this.pulseUntil.clear();
    for (const flyer of this.flyers.values()) this.removeFlyer(flyer);
    this.flyers.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('mousemove', this.onMove as unknown as EventListener);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('click', this.onClick);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('blur', this.onBlur);
    this.offEvent();
    this.offReset();
    this.resetAgents();
    if (this.proj) this.disposeProjection(this.proj);
    this.proj = null;
    this.renderer.dispose();
    this.geo.dispose();
    this.flyerGeo.dispose();
    this.canvas.remove();
    this.labelLayer.remove();
    this.tip.remove();
  }

  // ---- projection internals ---------------------------------------------------

  private disposeProjection(proj: Projection): void {
    for (const mesh of proj.meshes.values()) {
      this.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    for (const group of [proj.spineGroup, proj.festoonGroup]) {
      this.scene.remove(group);
      for (const child of group.children) {
        const line = child as THREE.LineSegments;
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
    }
  }

  private goHome(): void {
    const home = this.proj?.home;
    if (!home) return;
    this.orbit.theta = home.theta;
    this.orbit.phi = home.phi;
    this.orbit.distance = home.distance;
    this.orbit.target.copy(home.target);
  }

  private baseColor(node: any): THREE.Color {
    return channelColor(node, this.colouring.channel, this.proj?.maxHeat ?? 0, this.colouring.flagged);
  }

  /**
   * Pulses: a node flashes when an agent claims something about it, decaying over a
   * couple of seconds. This is the swarm's work made visible on the map rather than
   * only in a log — you watch it resolve.
   */
  private pulseColor(n: any): THREE.Color | null {
    const until = this.pulseUntil.get(n.key);
    if (!until) return null;
    const left = until - performance.now();
    if (left <= 0) {
      this.pulseUntil.delete(n.key);
      return null;
    }
    return scratch.copy(this.baseColor(n)).lerp(PULSE, left / PULSE_MS).clone();
  }

  /**
   * Show levels cumulatively down to `lvl`: L3 is the trunk and stays, dropping altitude
   * reveals the branches under it. Graph mode counts DOWN toward detail (L3→L1); tree mode
   * counts UP by depth. Either way "cumulative" means: keep everything shallower than the
   * active band.
   */
  private applyLevel(lvl: number, recentre: boolean): void {
    const proj = this.proj;
    if (!proj) return;
    proj.active = lvl;
    this.host.onLevel(lvl);
    const { showAll, distinct } = proj;
    for (const [l, mesh] of proj.meshes) {
      const shallower = proj.mode === 'tree' ? l <= lvl : l >= lvl;
      mesh.visible = showAll || shallower;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const lit = showAll || l === lvl;
      mat.transparent = !lit;
      mat.opacity = lit ? 1 : 0.32;
      mat.depthWrite = lit;
    }
    for (const lines of proj.festoonGroup.children) {
      const l = lines.userData.level;
      lines.visible = distinct.includes(l) && (showAll || proj.mode === 'tree' || l === lvl);
    }
    for (const line of proj.spineGroup.children) {
      const l = line.userData.level;
      line.visible = distinct.includes(l) && (showAll || (proj.mode === 'tree' ? l <= lvl : l >= lvl));
    }
    if (recentre) {
      const ys = [...proj.byLevel.values()].flat().map((n: any) => n.y);
      this.orbit.target.y = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
    }
  }

  private visibleCount(proj: Projection): number {
    return [...proj.meshes.entries()]
      .filter(([, m]) => m.visible)
      .reduce((sum, [l]) => sum + (proj.byLevel.get(l)?.length ?? 0), 0);
  }

  private gpuName(): string {
    // Which chip actually rendered, so a frame time is never read as a fact about the wrong
    // hardware — `powerPreference` is a hint, and on this laptop the driver ignored it.
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    } catch { /* never worth failing a render over */ }
    return '';
  }

  // ---- ropes and highlight ----------------------------------------------------

  private paintRope(index: number, color: THREE.Color | null): void {
    const rope = this.proj?.ropes[index];
    if (!rope?.mesh) return;
    const attr = rope.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const base = rope.mesh.userData.baseColors as Float32Array;
    for (let v = rope.start; v < rope.start + rope.count; v++) {
      if (color) attr.setXYZ(v, color.r, color.g, color.b);
      else attr.setXYZ(v, base[v * 3], base[v * 3 + 1], base[v * 3 + 2]);
    }
    attr.needsUpdate = true;
  }

  private clearHighlight(): void {
    for (const i of this.highlighted) this.paintRope(i, null);
    this.highlighted = [];
    for (const lines of this.proj?.festoonGroup.children ?? []) {
      ((lines as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity = 0.34;
    }
  }

  /**
   * Hover highlighting.
   *
   * Ropes are recoloured in place over their own vertex range rather than rebuilt, and
   * everything not incident to the hovered thing is dimmed — following one connection
   * by eye stops working the moment two of them cross, so the view has to do it.
   */
  private setHighlight(indices: number[]): void {
    this.clearHighlight();
    if (!indices.length) return;
    for (const lines of this.proj?.festoonGroup.children ?? []) {
      ((lines as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity = 0.08;
    }
    for (const i of indices) this.paintRope(i, HL_EDGE);
    this.highlighted = indices;
  }

  private showTip(html: string, x: number, y: number): void {
    this.tip.innerHTML = html;
    this.tip.style.display = 'block';
    const r = this.mount.getBoundingClientRect();
    this.tip.style.left = `${Math.min(Math.max(x - r.left + 14, 8), r.width - 260)}px`;
    this.tip.style.top = `${Math.min(Math.max(y - r.top + 14, 8), r.height - 70)}px`;
  }

  private hideTip(): void {
    this.tip.style.display = 'none';
  }

  // ---- agents -------------------------------------------------------------------

  private flyerFor(session: string, label: string): Flyer {
    const existing = this.flyers.get(session);
    if (existing) return existing;
    const color = agentColor(label);
    // A cone, not a sphere: it points where the agent is heading, so direction of travel
    // is readable at a glance and two markers on the same node stay distinguishable.
    const mesh = new THREE.Mesh(
      this.flyerGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
    );
    mesh.scale.setScalar(3.4);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(TRAIL * 3), 3));
    const line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 }),
    );
    this.agentGroup.add(mesh, line);
    const flyer: Flyer = {
      label, color,
      pos: new THREE.Vector3(), target: new THREE.Vector3(),
      trail: [], lastAt: performance.now(), mesh, line,
    };
    this.flyers.set(session, flyer);
    return flyer;
  }

  private removeFlyer(flyer: Flyer): void {
    this.agentGroup.remove(flyer.mesh, flyer.line);
    (flyer.mesh.material as THREE.Material).dispose();
    flyer.line.geometry.dispose();
    (flyer.line.material as THREE.Material).dispose();
  }

  // ---- input ----------------------------------------------------------------------

  private pointOnPlane(plane: THREE.Plane, out: THREE.Vector3): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray.intersectPlane(plane, out);
  }

  /**
   * Dragging a node moves it.
   *
   * A deterministic layout is what makes the map memorable, but in a region dense enough
   * that nodes sit on top of each other no automatic arrangement can show you the edge you
   * are following — you have to pull the thing out and look. So a drag that starts on a
   * node moves that node, and a drag that starts on empty space still orbits.
   *
   * The awkward case is a region so dense there is no empty space to orbit from, which is
   * exactly the region where you want to drag. Hence ctrl: hold it and a drag always
   * orbits, whatever is under the cursor.
   */
  private readonly onDown = (e: PointerEvent) => {
    // Middle or right drag pans, matching what every other 3D tool does.
    this.panning = e.button === 1 || e.button === 2;
    const hovered = this.hovered;

    if (!this.panning && !e.ctrlKey && hovered && !hovered.isRoot) {
      // The drag plane faces the camera and passes through the node, so the node tracks
      // the cursor exactly rather than sliding away along the view direction.
      const normal = this.camera.getWorldDirection(new THREE.Vector3()).negate();
      const at = new THREE.Vector3(hovered.x, hovered.y, hovered.z);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, at);
      const hit = this.pointOnPlane(plane, this.dragPoint);
      this.moving = {
        key: hovered.key,
        plane,
        offset: hit ? at.clone().sub(hit) : new THREE.Vector3(),
      };
      this.dragging = false;
      this.last = { x: e.clientX, y: e.clientY };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    this.moving = null;
    this.dragging = !this.panning;
    this.last = { x: e.clientX, y: e.clientY };
  };

  private readonly onUp = () => {
    const moving = this.moving;
    if (moving) {
      const node = this.proj?.laid.nodes.get(moving.key);
      if (node) {
        // Recorded on release rather than per frame: the host relayouts ropes and labels
        // from the override, which is right once but far too much work sixty times a second.
        this.host.onMoved(moving.key, [node.x, node.y, node.z]);
      }
      this.canvas.style.cursor = '';
    }
    this.moving = null;
    this.dragging = false;
    this.panning = false;
  };

  private readonly onContextMenu = (e: Event) => e.preventDefault();

  private readonly onMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    const orbit = this.orbit;
    const moving = this.moving;
    if (moving) {
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      const hit = this.pointOnPlane(moving.plane, this.dragPoint);
      const node = this.proj?.laid.nodes.get(moving.key);
      if (hit && node) {
        node.x = hit.x + moving.offset.x;
        node.y = hit.y + moving.offset.y;
        node.z = hit.z + moving.offset.z;
        // Move only what is cheap to move while the pointer is down: the instance and its
        // label. Everything routed through the node catches up when the drag ends.
        this.nudgeNode(node);
      }
      this.last = { x: e.clientX, y: e.clientY };
      return;
    }
    if (this.panning) {
      const speed = orbit.distance * 0.0022;
      const t = orbit.theta;
      const right = new THREE.Vector3(Math.sin(t), 0, -Math.cos(t));
      orbit.target.addScaledVector(right, -(e.clientX - this.last.x) * speed);
      orbit.target.y += (e.clientY - this.last.y) * speed;
      this.last = { x: e.clientX, y: e.clientY };
    } else if (this.dragging) {
      orbit.theta -= (e.clientX - this.last.x) * 0.005;
      orbit.phi = Math.max(0.08, Math.min(Math.PI - 0.08, orbit.phi - (e.clientY - this.last.y) * 0.005));
      this.last = { x: e.clientX, y: e.clientY };
    }
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.lastPointer.x = e.clientX;
    this.lastPointer.y = e.clientY;
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.orbit.distance = Math.max(45, Math.min(1200, this.orbit.distance * (1 + Math.sign(e.deltaY) * 0.09)));
  };

  /**
   * WASD pans the orbit TARGET, it does not fly the camera.
   *
   * Camera distance is semantic in both layouts — focus altitude in the graph, tree
   * depth in the hierarchy — so moving the camera along its view axis would silently
   * change which level you are looking at as a side effect of moving sideways. Panning
   * the target keeps distance fixed, so the altitude you chose is the altitude you keep.
   */
  private readonly onKeyDown = (e: KeyboardEvent) => {
    const el = document.activeElement;
    const typing = !!el && /^(input|textarea|select)$/i.test(el.tagName);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.shiftKey) this.held.add('shift');
    if (PAN_KEYS.has(k)) {
      this.held.add(k);
      e.preventDefault();
      return;
    }
    if (k === '0' || k === 'home') {
      this.goHome();
      e.preventDefault();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.held.delete(e.key.toLowerCase());
    if (!e.shiftKey) this.held.delete('shift');
  };

  private readonly onBlur = () => this.held.clear();

  private applyPan(dt: number): void {
    const held = this.held;
    if (!held.size) return;
    // Per SECOND, not per frame — otherwise pan speed tracks refresh rate and the
    // same keypress travels 2.4x further on a 144Hz display than on a 60Hz one.
    // Scaled by distance so it feels the same at architecture altitude and among files.
    const orbit = this.orbit;
    const speed = orbit.distance * 0.45 * dt * (held.has('shift') ? 2.5 : 1);
    const t = orbit.theta;
    const forward = new THREE.Vector3(-Math.cos(t), 0, -Math.sin(t));
    const right = new THREE.Vector3(Math.sin(t), 0, -Math.cos(t));

    if (held.has('w')) orbit.target.addScaledVector(forward, speed);
    if (held.has('s')) orbit.target.addScaledVector(forward, -speed);
    if (held.has('d')) orbit.target.addScaledVector(right, speed);
    if (held.has('a')) orbit.target.addScaledVector(right, -speed);
    if (held.has('e')) orbit.target.y += speed;
    if (held.has('q')) orbit.target.y -= speed;
  }

  private readonly onClick = (e: MouseEvent) => {
    const hovered = this.hovered;
    this.selectedId = hovered ? hovered.id : null;
    this.host.onSelect(hovered ? { ...hovered } : null);

    // Alt-click opens a file to its symbols, or shuts it again. On the modifier rather
    // than on a plain click because selecting a file is the common act and relaying out
    // the tree under the cursor every time you inspect something would be hostile.
    if (!e.altKey || !hovered?.isFile) return;
    this.host.onToggleExpand(hovered.id);
  };

  private readonly resize = () => {
    const r = this.mount.getBoundingClientRect();
    const aspect = Math.max(r.width, 1) / Math.max(r.height, 1);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(r.width, r.height, false);

    // Keep the scene the same apparent size when the panel narrows. Without this,
    // dragging the splitter silently zooms — and in graph mode camera distance is
    // semantic, so it would also change which level you were looking at.
    if (this.lastAspect && aspect > 0.2 && Math.abs(aspect - this.lastAspect) > 0.01) {
      this.orbit.distance = Math.max(45, Math.min(1200, this.orbit.distance * (this.lastAspect / aspect)));
    }
    this.lastAspect = aspect;
  };

  /**
   * Move one node's instance without rebuilding anything.
   *
   * Used while a drag is in flight. Labels are positioned from the node each frame, so they
   * follow for free; ropes are baked into a vertex buffer and do not, which is why the drag
   * commits through the host on release and lets a relayout rebuild them properly.
   */
  private nudgeNode(node: any): void {
    const mesh = this.proj?.meshes.get(node.level);
    if (!mesh || node.index === undefined) return;
    const s = node.radius ?? 1;
    this.nudgeMatrix.makeScale(s, s, s);
    this.nudgeMatrix.setPosition(node.x, node.y, node.z);
    mesh.setMatrixAt(node.index, this.nudgeMatrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ---- the frame --------------------------------------------------------------------

  private readonly tick = (now = 0) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const perf = !!this.opts.perf;
    const benchSeconds = Number(this.opts.bench ?? 0);
    const bench = benchSeconds > 0;
    const frameStart = perf ? performance.now() : 0;
    // Clamp so a backgrounded window does not resume with one enormous step.
    const wall = this.lastFrame ? now - this.lastFrame : 0;
    const dt = this.lastFrame ? Math.min(wall / 1000, 0.05) : 0;
    this.lastFrame = now;
    const proj = this.proj;
    const orbit = this.orbit;

    /**
     * Adaptive fallback: draw everything, and if this machine cannot keep up, stop.
     *
     * Sampled continuously rather than only when the meter is open, because the machine's
     * capability is not a function of whether anyone is looking at the number. It gives up
     * once — after a sustained slow patch, not a single stutter — records what it learned,
     * and never re-litigates it. Popping the detail level back and forth while someone is
     * moving the camera is worse than showing less.
     */
    if (proj?.showAll && !this.adapted && !bench && wall > 0) {
      this.adaptTimes.push(wall);
      if (this.adaptTimes.length > FRAME_WINDOW) this.adaptTimes.shift();
      if (this.adaptTimes.length === FRAME_WINDOW) {
        const slow = summarise(this.adaptTimes).p95Ms > SLOW_FRAME_MS;
        if (!slow) this.slowSince = 0;
        else if (!this.slowSince) this.slowSince = now;
        else if (now - this.slowSince > 2000) {
          this.adapted = true;
          const learned = limitAfterSlowdown(proj.laid.nodes.size);
          this.host.onAdapted(
            learned,
            `This machine could not hold 60fps drawing all ${proj.laid.nodes.size.toLocaleString()} ` +
              `nodes, so detail now follows camera distance above ${learned.toLocaleString()}. ` +
              'Change it in the fps panel.',
          );
        }
      }
    }

    /**
     * Frame times for the meter, as a ring buffer over about a second.
     *
     * Wall-clock between frames rather than the time spent inside `tick`: the cost of a frame
     * includes what the GPU does after we hand it the scene, and measuring only our own
     * JavaScript reports a comfortable 2ms while the window drops to 20fps.
     */
    if ((this.showFps || bench) && wall > 0) {
      this.frameTimes.push(wall);
      if (this.frameTimes.length > FRAME_WINDOW) this.frameTimes.shift();
    }
    /**
     * Headless benchmark: sample for N seconds, print one line, quit.
     *
     * The only way to answer "does this machine need LOD at all" is to measure it on that
     * machine, and a question answered by opinion is how the 2500 limit got there. Orbits
     * slowly while sampling, because a still camera measures a best case nobody experiences.
     */
    if (bench && wall > 0 && proj) {
      // Warm up for a second: the first frames include shader compilation and upload.
      if (!this.benchUntil) this.benchUntil = now + 1000 + benchSeconds * 1000;
      else if (now > this.benchUntil - benchSeconds * 1000) this.benchTimes.push(wall);
      orbit.theta += dt * 0.25;
      if (now > this.benchUntil) {
        const info = this.renderer.info.render;
        // Which GPU actually rendered this, so a software-rasterised run is never mistaken
        // for a measurement of the machine.
        console.error(`BENCH ${JSON.stringify({
          gpu: this.gpuName() || 'unknown', mode: proj.laid.mode, lod: proj.lod,
          limit: proj.limit, showAll: proj.showAll,
          nodes: proj.laid.nodes.size, visible: this.visibleCount(proj), ropes: proj.ropes.length,
          ...summarise(this.benchTimes),
          draws: info.calls, tris: info.triangles,
        })}`);
        this.benchUntil = Infinity;
      }
    }

    this.applyPan(dt);
    const { theta, phi, distance, target } = orbit;
    this.camera.position.set(
      target.x + distance * Math.sin(phi) * Math.cos(theta),
      target.y + distance * Math.cos(phi),
      target.z + distance * Math.sin(phi) * Math.sin(theta),
    );
    this.camera.lookAt(target);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = distance * 0.85;
    fog.far = distance * 3.2;

    if (proj) {
      if (!proj.showAll) {
        const band = proj.bands.find((b) => distance >= b.minDistance) ?? proj.bands[proj.bands.length - 1];
        if (band.level !== proj.active) this.applyLevel(band.level, true);
      }

      const pickStart = perf ? performance.now() : 0;
      this.pick(proj);
      if (perf) this.pickWork += performance.now() - pickStart;

      this.animateFlyers(dt);

      if (this.pulseUntil.size) {
        for (const [key] of [...this.pulseUntil]) {
          const node = proj.laid.nodes.get(key) as any;
          const mesh = node && proj.meshes.get(node.level);
          if (!mesh || node.index == null) {
            this.pulseUntil.delete(key);
            continue;
          }
          mesh.setColorAt(node.index, this.pulseColor(node) ?? this.baseColor(node));
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
      }

      const labelStart = perf ? performance.now() : 0;
      this.drawLabels(proj);
      if (perf) this.labelWork += performance.now() - labelStart;
    }

    this.renderer.render(this.scene, this.camera);

    if (proj && this.showFps && now > this.meterAt && this.frameTimes.length > 8) {
      this.meterAt = now + 400;
      const info = this.renderer.info.render;
      this.host.onStats({
        ...summarise(this.frameTimes),
        visible: this.visibleCount(proj),
        draws: info.calls,
        tris: info.triangles,
      });
    }

    if (perf && proj) {
      this.accum += performance.now() - frameStart;
      this.frames++;
      if (!this.reportAt) this.reportAt = now + 4000;
      else if (now > this.reportAt) {
        console.error(
          `PERF mode=${proj.laid.mode} lod=${proj.lod} nodes=${proj.laid.nodes.size} ` +
          `visible=${this.visibleCount(proj)} ropes=${proj.ropes.length} ` +
          `frame=${(this.accum / this.frames).toFixed(2)}ms ` +
          `labels=${(this.labelWork / this.frames).toFixed(2)}ms pick=${(this.pickWork / this.frames).toFixed(2)}ms`,
        );
        this.frames = 0; this.accum = 0; this.labelWork = 0; this.pickWork = 0;
        this.reportAt = now + 4000;
      }
    }
  };

  private pick(proj: Projection): void {
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Pick across every VISIBLE mesh, not just the active band. Cumulative rendering
    // draws shallower levels too, so testing only the active one left nodes you could
    // see but not hover.
    const pickable = [...proj.meshes.values()].filter((m) => m.visible);
    const hits = this.raycaster.intersectObjects(pickable, false);
    const first = hits.find((h) => h.instanceId != null);
    const hitLevel = first ? (first.object as any).userData.level : null;
    const hit = first && hitLevel != null ? proj.byLevel.get(hitLevel)![first.instanceId!] : null;

    const restore = (n: any) => {
      const m = proj.meshes.get(n.level);
      if (!m || n.index == null) return;
      m.setColorAt(n.index, this.pulseColor(n) ?? this.baseColor(n));
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    };

    if (hit !== this.hovered) {
      if (this.hovered) restore(this.hovered);
      if (hit) {
        const m = proj.meshes.get(hit.level)!;
        m.setColorAt(hit.index, HL_NODE);
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      this.hovered = hit;
      this.canvas.style.cursor = hit ? 'pointer' : 'default';

      if (hit) {
        this.hoveredRope = null;
        this.setHighlight(proj.ropesByNode.get(hit.key) ?? []);
      } else {
        this.clearHighlight();
        this.hideTip();
      }
    }

    if (hit) {
      const degree = (proj.ropesByNode.get(hit.key) ?? []).length;
      this.showTip(
        `<strong>${esc(hit.label)}</strong>` +
          `<div class="tip-path">${esc(hit.id)}</div>` +
          `<div class="tip-meta">${hit.fileCount} file${hit.fileCount === 1 ? '' : 's'}` +
          (hit.symbolCount ? ` · ${hit.symbolCount} symbols` : '') +
          ` · ${degree} connection${degree === 1 ? '' : 's'}</div>` +
          (hit.purpose ? `<div class="tip-purpose">${esc(hit.purpose)}</div>` : ''),
        this.lastPointer.x, this.lastPointer.y,
      );
      return;
    }

    // No node under the cursor — try the ropes, so a connection is traceable too.
    this.raycaster.params.Line = { threshold: Math.max(1.2, this.orbit.distance * 0.006) };
    const lineHits = this.raycaster.intersectObjects(
      proj.festoonGroup.children.filter((c) => c.visible), false,
    );
    const firstLine = lineHits[0];
    const map = firstLine ? (firstLine.object.userData.vertexToRope as number[]) : null;
    const idx = map && firstLine?.index != null ? map[firstLine.index] : null;

    if (idx !== this.hoveredRope) {
      this.hoveredRope = idx ?? null;
      this.setHighlight(idx != null ? [idx] : []);
      this.canvas.style.cursor = idx != null ? 'crosshair' : 'default';
    }
    if (idx != null) {
      const r = proj.ropes[idx];
      this.showTip(
        `<strong>${shortId(r.from)} <span class="arrow">→</span> ${shortId(r.to)}</strong>` +
          `<div class="tip-meta">${r.weight} reference${r.weight === 1 ? '' : 's'}</div>`,
        this.lastPointer.x, this.lastPointer.y,
      );
    } else {
      this.hideTip();
    }
  }

  private animateFlyers(dt: number): void {
    if (!this.flyers.size) return;
    const nowMs = performance.now();
    for (const [session, f] of this.flyers) {
      // Ease toward the target rather than snapping: the movement is what makes the
      // swarm legible at a glance.
      const prev = f.pos.clone();
      f.pos.lerp(f.target, Math.min(1, dt * 2.4));
      f.mesh.position.copy(f.pos);

      // Point along travel; when parked, stand upright rather than freezing mid-turn.
      const vel = f.pos.clone().sub(prev);
      if (vel.lengthSq() > 1e-6) {
        f.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vel.normalize());
      } else {
        f.mesh.quaternion.slerp(new THREE.Quaternion(), Math.min(1, dt * 2));
      }

      const idle = nowMs - f.lastAt;
      const fade = idle > IDLE_MS ? 0 : 1 - idle / IDLE_MS;
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.6 * fade;
      f.mesh.scale.setScalar(3.4 + Math.sin(nowMs / 260) * 0.5 * fade);
      (f.line.material as THREE.LineBasicMaterial).opacity = 0.4 * fade;
      f.mesh.visible = this.swarm;
      f.line.visible = this.swarm && f.trail.length > 1;

      const attr = f.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < TRAIL; i++) {
        const pt = f.trail[Math.min(i, f.trail.length - 1)] ?? f.pos;
        attr.setXYZ(i, pt.x, pt.y, pt.z);
      }
      attr.needsUpdate = true;

      if (idle > IDLE_MS * 2) {
        this.removeFlyer(f);
        this.flyers.delete(session);
      }
    }
  }

  /**
   * 3D buys room, not readability: perspective makes distant text unreadable and
   * billboards overlap as happily as in 2D. So project, sort by importance, place
   * greedily, and reject anything that collides.
   */
  private drawLabels(proj: Projection): void {
    const nodes: any[] = [];
    for (const [lvl, mesh] of proj.meshes) {
      if (mesh.visible) nodes.push(...(proj.byLevel.get(lvl) ?? []));
    }
    const rect = this.mount.getBoundingClientRect();
    const placed: Array<{ l: number; r: number; t: number; b: number }> = [];
    const frag = document.createDocumentFragment();
    const projected = this.projected;

    // Whatever is hovered gets its label unconditionally — declutter must never hide
    // the one thing the cursor is pointing at, nor the endpoints of a traced rope.
    const forced = new Set<string>();
    if (this.hovered) forced.add(this.hovered.key);
    if (this.hoveredRope != null) {
      forced.add(proj.ropes[this.hoveredRope].from);
      forced.add(proj.ropes[this.hoveredRope].to);
    }

    const candidates = nodes
      .map((node: any) => {
        projected.set(node.x, node.y, node.z).project(this.camera);
        if (projected.z > 1) return null;
        return {
          node,
          x: (projected.x * 0.5 + 0.5) * rect.width,
          y: (-projected.y * 0.5 + 0.5) * rect.height,
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => {
        const af = forced.has(a.node.key) ? 1 : 0;
        const bf = forced.has(b.node.key) ? 1 : 0;
        return bf - af || b.node.fileCount - a.node.fileCount;
      });

    // Hard cap: label layout is the only per-frame cost that scales with node count,
    // and past a screenful of text more labels help nobody anyway.
    for (const c of candidates as any[]) {
      if (placed.length >= MAX_LABELS && !forced.has(c.node.key)) break;
      const isForced = forced.has(c.node.key);
      const w = c.node.label.length * 6 + 10;
      const box = { l: c.x - w / 2, r: c.x + w / 2, t: c.y - 8, b: c.y + 8 };
      if (!isForced) {
        if (box.l < 0 || box.r > rect.width || box.t < 0 || box.b > rect.height) continue;
        if (placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) continue;
      }
      placed.push(box);

      const el = document.createElement('div');
      el.className = isForced ? 'label lit' : c.node.purpose ? 'label' : 'label dim';
      el.style.left = `${c.x}px`;
      el.style.top = `${c.y - c.node.radius - 9}px`;
      el.textContent = c.node.label;
      frag.appendChild(el);
    }
    // Agent labels ride above everything: knowing who is where is the point.
    if (this.swarm) {
      for (const f of this.flyers.values()) {
        projected.copy(f.pos).project(this.camera);
        if (projected.z > 1) continue;
        const el = document.createElement('div');
        el.className = 'label agent-label';
        el.style.left = `${(projected.x * 0.5 + 0.5) * rect.width}px`;
        el.style.top = `${(-projected.y * 0.5 + 0.5) * rect.height - 14}px`;
        el.style.color = `#${f.color.getHexString()}`;
        el.textContent = f.label;
        frag.appendChild(el);
      }
    }

    this.labelLayer.replaceChildren(frag);
  }
}
