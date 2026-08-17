import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { layout } from '../../../../engine/scene/layout.ts';
import { layoutTree } from '../../../../engine/scene/tree.ts';
import type { LoadPayload } from '../types.ts';
import { onReplayEvent, onReplayReset } from '../replay.ts';

/**
 * The festooned tree.
 *
 * Two properties this is built around, both carried over from the standalone viewer:
 * the spine is a pure function of the focus stack (no force relaxation, no randomness,
 * so flying around builds spatial memory), and LOD is SEMANTIC — camera distance IS
 * altitude on the focus stack, so pulling back collapses nodes into their agent-named
 * abstraction rather than fading them out.
 */

const COLORS = {
  named: new THREE.Color('#7ee0a8'),
  path: new THREE.Color('#5a6675'),
  defended: new THREE.Color('#f0a868'),
  hover: new THREE.Color('#6ea8fe'),
  symbol: new THREE.Color('#8f7fd0'),
};

export type Channel = 'structure' | 'belief' | 'frontier' | 'agent';

const CHANNEL_HELP: Record<Channel, string> = {
  structure: 'agent-named, path group, or defended',
  belief: 'how much is known, and what is disputed',
  frontier: 'where the swarm is heading next',
  agent: 'who has worked here',
};

/**
 * Belief palette. Unknown is deliberately near-invisible: the design's whole point is that
 * absence must look like absence, so an unexamined map should look unexamined.
 */
const BELIEF: Record<string, THREE.Color> = {
  // Muted, but not invisible: absence should read as absence without erasing the form.
  UNKNOWN: new THREE.Color('#3d4653'),
  INFERRED: new THREE.Color('#8a7bd8'),
  CORROBORATED: new THREE.Color('#7ee0a8'),
  CONFIRMED: new THREE.Color('#6ea8fe'),
  CONTRADICTED: new THREE.Color('#f07a7a'),
  STALE: new THREE.Color('#f0a868'),
};

const COLD = new THREE.Color('#333b46');
const HOT = new THREE.Color('#ffd479');

/** Stable per-agent hue, so the same tool keeps its colour across sessions. */
function agentColor(name: string): THREE.Color {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return new THREE.Color().setHSL(((h >>> 0) % 360) / 360, 0.55, 0.62);
}

const scratch = new THREE.Color();

/** Colour for a node under the active channel. */
function channelColor(node: any, channel: Channel, maxHeat: number): THREE.Color {
  // A symbol has no belief, no heat and no agents of its own — every channel would paint it
  // "unknown", which reads as a finding rather than as a level of detail. One colour, so an
  // opened file is legible as structure regardless of what the rest of the map is showing.
  if (node.isSymbol) return COLORS.symbol;
  if (channel === 'belief') {
    const b = node.belief;
    if (!b) return BELIEF.UNKNOWN;
    const base = BELIEF[b.status] ?? BELIEF.UNKNOWN;
    // Coverage drives the gradient: a node where half the members are unexamined should
    // not look as settled as one where all of them are.
    return scratch.copy(BELIEF.UNKNOWN).lerp(base, 0.25 + 0.75 * b.known).clone();
  }
  if (channel === 'frontier') {
    const heat = node.belief?.heat ?? 0;
    return scratch.copy(COLD).lerp(HOT, maxHeat > 0 ? Math.min(1, heat / maxHeat) : 0).clone();
  }
  if (channel === 'agent') {
    const agents: string[] = node.belief?.agents ?? [];
    if (!agents.length) return BELIEF.UNKNOWN;
    return agentColor(agents[0]);
  }
  return node.defended ? COLORS.defended : node.purpose ? COLORS.named : COLORS.path;
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
          {channel === 'frontier' && (
            <>
              {swatch(COLD, 'cold', 'settled or unimportant')}
              {swatch(HOT, 'hot', 'next, by uncertainty x centrality')}
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

export function Scene({ data }: { data: LoadPayload | null }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<any>(null);
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
  const [nodeCount, setNodeCount] = useState(0);
  const [channel, setChannel] = useState<Channel>('structure');
  const [agents, setAgents] = useState<string[]>([]);
  const [pulses, setPulses] = useState(true);
  const pulsesRef = useRef(true);
  pulsesRef.current = pulses;
  const [swarm, setSwarm] = useState(true);
  const swarmRef = useRef(true);
  swarmRef.current = swarm;
  const seededMode = useRef(false);
  const apiRef = useRef<{ setLevel: (n: number) => void } | null>(null);
  // Selection survives a layout switch: spot a tangle in the graph, then see where it
  // lives in the tree without hunting for it again.
  const keepId = useRef<string | null>(null);
  /**
   * Files opened to show their symbols.
   *
   * Expand-on-demand rather than a depth setting: every symbol at once is roughly ten times
   * the nodes and reliably unreadable, so you pay the node count only where you asked a
   * question. A ref alongside the state because the click handler is installed once.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // `data` is null on first render, so an initial mode from the host has to be applied
  // when it actually arrives — once, so it never fights the user's own toggle.
  useEffect(() => {
    if (seededMode.current || !data?.initialMode) return;
    seededMode.current = true;
    if (data.initialMode !== 'graph') setMode(data.initialMode);
    const seedLod = (data as any).lodDefault;
    if (seedLod === 'auto') setLod('auto');
    const seedChannel = (data as any).channelDefault as Channel | undefined;
    if (seedChannel && seedChannel !== 'structure') setChannel(seedChannel);
  }, [data?.initialMode]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !data?.stack) return;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    mount.appendChild(canvas);

    const labelLayer = document.createElement('div');
    labelLayer.className = 'labels';
    mount.appendChild(labelLayer);

    const tip = document.createElement('div');
    tip.className = 'scene-tip';
    tip.style.display = 'none';
    mount.appendChild(tip);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0a0c10');
    // Fog has to follow the camera. A fixed range was tuned for the graph layout, and the
    // tree of a 400-file repo sits far enough out that every node fell past `far` and
    // rendered as pure background — the map looked empty while the DOM labels kept working.
    scene.fog = new THREE.Fog('#0a0c10', 320, 900);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.5, 3000);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.8);
    dir.position.set(120, 220, 140);
    scene.add(dir);

    const repoName = (data.repo ?? 'repo').split('/').filter(Boolean).pop() ?? 'repo';
    const laid = mode === 'tree'
      ? layoutTree(data, repoName, expanded)
      : layout(data.stack, repoName);
    const bands = laid.bands;
    const distinct = bands.map((b: any) => b.level);
    setLevels(distinct);
    // Count what is drawn, not what exists: with identical partitions the duplicate
    // levels never render, and reporting them inflated the number by 3x.
    setAgents([
      ...new Set(
        [...laid.nodes.values()].flatMap((n: any) => n.belief?.agents ?? []),
      ),
    ].sort() as string[]);
    setNodeCount(
      [...laid.nodes.values()].filter((n: any) => distinct.includes(n.level) || n.isRoot).length,
    );
    // Above this, per-frame label and pick work stops being bounded by screen area and
    // LOD starts genuinely paying for itself. Extrapolated from the measurement above.
    const LOD_THRESHOLD = 2500;
    const showAll = lod === 'all' && laid.nodes.size <= LOD_THRESHOLD;
    const defended = new Set((data.defended ?? []).map(String));

    // Defined before anything paints: the mesh loop below colours through it.
    const maxHeat = Math.max(
      0,
      ...[...laid.nodes.values()].map((n: any) => n.belief?.heat ?? 0),
    );
    const baseColor = (node: any) => channelColor(node, channel, maxHeat);

    const byLevel = new Map<number, any[]>();
    for (const lvl of distinct) byLevel.set(lvl, []);
    for (const node of laid.nodes.values()) {
      // The root sits above the shallowest band, so it rides along with that one.
      // Everything else must belong to a real band — funnelling non-distinct levels
      // here is what redrew the same partition three times over.
      if (byLevel.has(node.level)) byLevel.get(node.level)!.push(node);
      else if (node.isRoot) byLevel.get(distinct[0])!.push(node);
    }

    const meshes = new Map<number, THREE.InstancedMesh>();
    const geo = new THREE.SphereGeometry(1, 20, 14);

    for (const [lvl, nodes] of byLevel) {
      if (!nodes.length) continue;
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.InstancedMesh(geo, mat, nodes.length);
      const m = new THREE.Matrix4();
      nodes.forEach((node: any, i: number) => {
        // Compressed so a 200-file bucket does not render a 3-file one invisible.
        // The root holds every file, so size it as a marker rather than by mass.
        const s = node.isRoot
          ? 5
          // Symbols are smaller than the file that holds them, so an opened file still reads
          // as one thing with parts rather than as a cluster of peers.
          : node.isSymbol
            ? 1.3
            : node.isFile
              ? 2.2
              : 2.4 + Math.pow(Math.max(node.fileCount, 1), 0.42) * 1.5;
        m.makeScale(s, s, s);
        m.setPosition(node.x, node.y, node.z);
        mesh.setMatrixAt(i, m);
        // The root holds every file, so a membership test would always mark it defended.
        node.defended =
          !node.isRoot &&
          (node.members.some((mm: string) => defended.has(mm)) || defended.has(node.id));
        mesh.setColorAt(i, baseColor(node));
        node.index = i;
        node.radius = s;
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.userData.level = lvl;
      meshes.set(lvl, mesh);
      scene.add(mesh);
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
    const spineGroup = new THREE.Group();
    for (const [childLevel, pts] of perChild) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const line = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color: '#6ea8fe', transparent: true, opacity: 0.3 }),
      );
      line.userData.level = childLevel;
      spineGroup.add(line);
    }
    scene.add(spineGroup);

    // Festoons dip toward the axis so co-travelling cross-edges read as one rope.
    //
    // Each rope records its vertex range so hovering can recolour just that span, and a
    // vertex→edge lookup makes the lines pickable: tracing a connection by eye stops
    // working the moment two of them cross.
    const festoonGroup = new THREE.Group();
    const ropes: Array<{
      from: string; to: string; weight: number; via?: string[];
      mesh: THREE.LineSegments; start: number; count: number;
    }> = [];

    const perLevel = new Map<number, any[]>();
    for (const f of laid.festoons) {
      const a = laid.nodes.get(f.from);
      const b = laid.nodes.get(f.to);
      if (!a || !b || !drawn(a) || !drawn(b)) continue;
      if (!perLevel.has(f.level)) perLevel.set(f.level, []);
      perLevel.get(f.level)!.push(f);
    }

    const BASE_EDGE = new THREE.Color('#8a5cf6');
    const HEAVY_EDGE = new THREE.Color('#c07ef0');

    for (const [lvl, list] of perLevel) {
      const positions: number[] = [];
      const colors: number[] = [];
      const vertexToRope: number[] = [];

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
        const ropeIndex = ropes.length;
        for (let i = 0; i < pts.length - 1; i++) {
          positions.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
          colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
          vertexToRope.push(ropeIndex, ropeIndex);
        }
        ropes.push({
          from: f.from, to: f.to, weight: f.weight, via: f.via,
          mesh: null as any, start: startVertex, count: (pts.length - 1) * 2,
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
      for (const r of ropes) if (!r.mesh) r.mesh = lines;
      festoonGroup.add(lines);
    }
    scene.add(festoonGroup);

    const extent = Math.max(
      40,
      ...[...laid.nodes.values()].map((n: any) => Math.hypot(n.x, n.z)),
    );
    const depthSpan = Math.abs(
      Math.min(...[...laid.nodes.values()].map((n: any) => n.y)),
    );
    const orbit = {
      theta: 0.7,
      phi: laid.mode === 'tree' ? 1.35 : 1.15,
      // Fit to the vertical FOV rather than a guessed multiple: a deep tree and a wide one
      // need different distances, and the old constant framed both too far out.
      distance:
        laid.mode === 'tree'
          ? Math.max(200, extent * 1.5, depthSpan * 1.15)
          : 300,
      target: new THREE.Vector3(0, laid.mode === 'tree' ? -depthSpan / 2 : 0, 0),
    };
    // Framing to return to, so panning is always recoverable with one key.
    const home = {
      theta: orbit.theta,
      phi: orbit.phi,
      distance: orbit.distance,
      target: orbit.target.clone(),
    };
    let active = 3;

    const applyLevel = (lvl: number) => {
      active = lvl;
      setLevel(lvl);
      // Cumulative rather than exclusive: L3 is the trunk and stays, dropping altitude
      // reveals the branches under it.
      for (const [l, mesh] of meshes) {
        // Graph mode counts DOWN toward detail (L3→L1); tree mode counts UP by depth.
        // Either way "cumulative" means: keep everything shallower than the active band.
        const shallower = laid.mode === 'tree' ? l <= lvl : l >= lvl;
        mesh.visible = showAll || shallower;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const lit = showAll || l === lvl;
        mat.transparent = !lit;
        mat.opacity = lit ? 1 : 0.32;
        mat.depthWrite = lit;
      }
      for (const lines of festoonGroup.children) {
        const l = lines.userData.level;
        lines.visible =
          distinct.includes(l) && (showAll || laid.mode === 'tree' || l === lvl);
      }
      for (const line of spineGroup.children) {
        const l = line.userData.level;
        const levelDrawn = distinct.includes(l);
        line.visible =
          levelDrawn &&
          (showAll || (laid.mode === 'tree' ? l <= lvl : l >= lvl));
      }
      const ys = [...byLevel.values()].flat().map((n: any) => n.y);
      orbit.target.y = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
    };
    apiRef.current = {
      setLevel: (n) => {
        applyLevel(n);
        orbit.distance = (bands.find((b: any) => b.level === n)?.minDistance || 90) + 60;
      },
    };
    applyLevel(distinct[0]);

    // Re-select the same node after a layout switch, if this layout has it.
    if (keepId.current) {
      for (const n of laid.nodes.values()) {
        if (n.id === keepId.current) {
          setSelected({ ...n });
          break;
        }
      }
    }

    // ---- input ---------------------------------------------------------------
    const pointer = new THREE.Vector2(-2, -2);
    const lastPointer = { x: 0, y: 0 };
    const raycaster = new THREE.Raycaster();
    let dragging = false;
    let last = { x: 0, y: 0 };
    let hovered: any = null;

    let panning = false;
    const onDown = (e: PointerEvent) => {
      // Middle or right drag pans, matching what every other 3D tool does.
      panning = e.button === 1 || e.button === 2;
      dragging = !panning;
      last = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => {
      dragging = false;
      panning = false;
    };
    const onContextMenu = (e: Event) => e.preventDefault();
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (panning) {
        const speed = orbit.distance * 0.0022;
        const t = orbit.theta;
        const right = new THREE.Vector3(Math.sin(t), 0, -Math.cos(t));
        orbit.target.addScaledVector(right, -(e.clientX - last.x) * speed);
        orbit.target.y += (e.clientY - last.y) * speed;
        last = { x: e.clientX, y: e.clientY };
      } else if (dragging) {
        orbit.theta -= (e.clientX - last.x) * 0.005;
        orbit.phi = Math.max(0.08, Math.min(Math.PI - 0.08, orbit.phi - (e.clientY - last.y) * 0.005));
        last = { x: e.clientX, y: e.clientY };
      }
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      lastPointer.x = e.clientX;
      lastPointer.y = e.clientY;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      orbit.distance = Math.max(45, Math.min(1200, orbit.distance * (1 + Math.sign(e.deltaY) * 0.09)));
    };

    /**
     * WASD pans the orbit TARGET, it does not fly the camera.
     *
     * Camera distance is semantic in both layouts — focus altitude in the graph, tree
     * depth in the hierarchy — so moving the camera along its view axis would silently
     * change which level you are looking at as a side effect of moving sideways. Panning
     * the target keeps distance fixed, so the altitude you chose is the altitude you keep.
     */
    const held = new Set<string>();
    const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

    const typing = () => {
      const el = document.activeElement;
      return !!el && /^(input|textarea|select)$/i.test(el.tagName);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey) held.add('shift');
      if (PAN_KEYS.has(k)) {
        held.add(k);
        e.preventDefault();
        return;
      }
      if (k === '0' || k === 'home') {
        orbit.target.copy(home.target);
        orbit.distance = home.distance;
        orbit.theta = home.theta;
        orbit.phi = home.phi;
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.key.toLowerCase());
      if (!e.shiftKey) held.delete('shift');
    };
    const onBlur = () => held.clear();

    addEventListener('keydown', onKeyDown);
    addEventListener('keyup', onKeyUp);
    addEventListener('blur', onBlur);

    function applyPan(dt: number) {
      if (!held.size) return;
      // Per SECOND, not per frame — otherwise pan speed tracks refresh rate and the
      // same keypress travels 2.4x further on a 144Hz display than on a 60Hz one.
      // Scaled by distance so it feels the same at architecture altitude and among files.
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
    const onClick = (e: MouseEvent) => {
      keepId.current = hovered ? hovered.id : null;
      setSelected(hovered ? { ...hovered } : null);

      // Alt-click opens a file to its symbols, or shuts it again. On the modifier rather
      // than on a plain click because selecting a file is the common act and relaying out
      // the tree under the cursor every time you inspect something would be hostile.
      if (!e.altKey || !hovered?.isFile) return;
      const next = new Set(expandedRef.current);
      if (next.has(hovered.id)) next.delete(hovered.id);
      else next.add(hovered.id);
      setExpanded(next);
    };

    canvas.addEventListener('pointerdown', onDown);
    addEventListener('pointerup', onUp);
    canvas.addEventListener('pointermove', onMove);
    // Synthetic input (Electron's sendInputEvent, used for headless verification) emits
    // mouse events rather than pointer events, so track both.
    canvas.addEventListener('mousemove', onMove as unknown as EventListener);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('contextmenu', onContextMenu);

    let lastAspect = 0;
    const resize = () => {
      const r = mount.getBoundingClientRect();
      const aspect = Math.max(r.width, 1) / Math.max(r.height, 1);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.setSize(r.width, r.height, false);

      // Keep the scene the same apparent size when the panel narrows. Without this,
      // dragging the splitter silently zooms — and in graph mode camera distance is
      // semantic, so it would also change which level you were looking at.
      if (lastAspect && aspect > 0.2 && Math.abs(aspect - lastAspect) > 0.01) {
        orbit.distance = Math.max(45, Math.min(1200, orbit.distance * (lastAspect / aspect)));
      }
      lastAspect = aspect;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    /**
     * Hover highlighting.
     *
     * Ropes are recoloured in place over their own vertex range rather than rebuilt, and
     * everything not incident to the hovered thing is dimmed — following one connection
     * by eye stops working the moment two of them cross, so the view has to do it.
     */
    /**
     * Pulses: a node flashes when an agent claims something about it, decaying over a
     * couple of seconds. This is the swarm's work made visible on the map rather than
     * only in a log — you watch it resolve.
     */
    const PULSE = new THREE.Color('#ffe9a8');
    const pulseUntil = new Map<string, number>();
    const PULSE_MS = 2200;

    const nodeKeysForFile = new Map<string, string[]>();
    for (const n of laid.nodes.values()) {
      for (const m of n.members) {
        const list = nodeKeysForFile.get(m);
        if (list) list.push(n.key);
        else nodeKeysForFile.set(m, [n.key]);
      }
    }

    const pulseColor = (n: any): THREE.Color | null => {
      const until = pulseUntil.get(n.key);
      if (!until) return null;
      const left = until - performance.now();
      if (left <= 0) {
        pulseUntil.delete(n.key);
        return null;
      }
      return scratch.copy(baseColor(n)).lerp(PULSE, left / PULSE_MS).clone();
    };

    /**
     * Agent markers.
     *
     * An agent has no position — but it does have *attention*, and every get_slice records
     * which node it asked to look at. The marker sits on a node the agent genuinely
     * touched; the flight between two such nodes is a visual transition, not a claim that
     * it travelled through anything on the way.
     */
    const agentGroup = new THREE.Group();
    scene.add(agentGroup);

    const TRAIL = 24;
    const IDLE_MS = 45_000;
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
    const flyers = new Map<string, Flyer>();
    // A cone, not a sphere: it points where the agent is heading, so direction of travel
    // is readable at a glance and two markers on the same node stay distinguishable.
    const flyerGeo = new THREE.ConeGeometry(0.62, 1.9, 6);

    const flyerFor = (session: string, label: string): Flyer => {
      const existing = flyers.get(session);
      if (existing) return existing;
      const color = agentColor(label);
      const mesh = new THREE.Mesh(
        flyerGeo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
      );
      mesh.scale.setScalar(3.4);
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(TRAIL * 3), 3));
      const line = new THREE.Line(
        lineGeo,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 }),
      );
      agentGroup.add(mesh, line);
      const flyer: Flyer = {
        label, color,
        pos: new THREE.Vector3(), target: new THREE.Vector3(),
        trail: [], lastAt: performance.now(), mesh, line,
      };
      flyers.set(session, flyer);
      return flyer;
    };

    /**
     * Replay drops everything the map has accumulated.
     *
     * Markers and pulses are the state built up by watching events go past, so a jump
     * backwards has to clear them — otherwise the replay's first frame is the run's
     * beginning drawn on top of its end.
     */
    const offReset = onReplayReset(() => {
      pulseUntil.clear();
      for (const flyer of flyers.values()) {
        agentGroup.remove(flyer.mesh);
        agentGroup.remove(flyer.line);
        flyer.mesh.geometry.dispose?.();
        (flyer.mesh.material as THREE.Material).dispose?.();
        flyer.line.geometry.dispose?.();
        (flyer.line.material as THREE.Material).dispose?.();
      }
      flyers.clear();
    });

    // One path for live and replayed events: the scene cannot tell which it is drawing,
    // which is the only way a replay stays a picture of what actually happened.
    const offEvent = onReplayEvent((e) => {
      const subject = e.subject ?? e.node;
      const file = subject ? subject.split('#')[0] : null;
      const keys = file ? nodeKeysForFile.get(file) ?? [] : [];

      if (pulsesRef.current && keys.length) {
        // Ancestors pulse too — the path to the touched node lighting up is the point —
        // but not the root, which contains everything and would simply strobe.
        for (const key of keys) {
          if (!laid.nodes.get(key)?.isRoot) pulseUntil.set(key, performance.now() + PULSE_MS);
        }
      }

      if (!swarmRef.current) return;
      const label = `${e.agent}${e.model ? `/${e.model}` : ''}`;
      const flyer = flyerFor(e.session || label, label);
      flyer.lastAt = performance.now();

      // Fly to the MOST SPECIFIC node holding this file. The key list is built ancestors
      // first, so taking the head pinned every agent to the root and it never moved.
      //
      // Orientation calls like get_overview carry no subject, and inventing a destination
      // for them would be exactly the fabrication the referent rule forbids — so they
      // simply do not move the marker.
      const node = keys
        .map((k) => laid.nodes.get(k))
        .filter((n): n is NonNullable<typeof n> => !!n && !n.isRoot)
        .sort((a, b) => a.members.length - b.members.length)[0];
      if (!node) return;
      flyer.target.set(node.x, node.y + (node.radius ?? 4) + 6, node.z);
      if (!flyer.trail.length) flyer.pos.copy(flyer.target);
      flyer.trail.push(flyer.target.clone());
      if (flyer.trail.length > TRAIL) flyer.trail.shift();
    });

    const HL_NODE = new THREE.Color('#6ea8fe');
    const HL_EDGE = new THREE.Color('#ffd479');
    const ropesByNode = new Map<string, number[]>();
    ropes.forEach((r, i) => {
      // Register against the endpoints AND every ancestor on the route, so hovering a
      // directory lights every dependency entering or leaving its subtree — which is the
      // whole "this limb's edges all go elsewhere" reading. The root is skipped: it
      // contains everything, so highlighting from it would light the entire scene.
      const keys = new Set<string>([r.from, r.to, ...((r as any).via ?? [])]);
      for (const k of keys) {
        if (laid.nodes.get(k)?.isRoot) continue;
        const list = ropesByNode.get(k);
        if (list) list.push(i);
        else ropesByNode.set(k, [i]);
      }
    });

    let highlighted: number[] = [];

    const paintRope = (index: number, color: THREE.Color | null) => {
      const rope = ropes[index];
      if (!rope?.mesh) return;
      const attr = rope.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const base = rope.mesh.userData.baseColors as Float32Array;
      for (let v = rope.start; v < rope.start + rope.count; v++) {
        if (color) attr.setXYZ(v, color.r, color.g, color.b);
        else attr.setXYZ(v, base[v * 3], base[v * 3 + 1], base[v * 3 + 2]);
      }
      attr.needsUpdate = true;
    };

    const clearHighlight = () => {
      for (const i of highlighted) paintRope(i, null);
      highlighted = [];
      for (const lines of festoonGroup.children) {
        (lines as THREE.LineSegments).material as THREE.LineBasicMaterial;
        ((lines as any).material as THREE.LineBasicMaterial).opacity = 0.34;
      }
    };

    const setHighlight = (indices: number[]) => {
      clearHighlight();
      if (!indices.length) return;
      // Dim the field so the highlighted rope reads as the only lit thing.
      for (const lines of festoonGroup.children) {
        ((lines as any).material as THREE.LineBasicMaterial).opacity = 0.08;
      }
      for (const i of indices) paintRope(i, HL_EDGE);
      highlighted = indices;
    };

    const showTip = (html: string, x: number, y: number) => {
      tip.innerHTML = html;
      tip.style.display = 'block';
      const r = mount!.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max(x - r.left + 14, 8), r.width - 260)}px`;
      tip.style.top = `${Math.min(Math.max(y - r.top + 14, 8), r.height - 70)}px`;
    };
    const hideTip = () => (tip.style.display = 'none');

    const esc = (t: string) =>
      t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
    const shortId = (k: string) => esc(k.replace(/^t:/, '').split('/').slice(-2).join('/'));

    let hoveredRope: number | null = null;

    let raf = 0;
    let lastFrame = 0;
    let frames = 0;
    let accum = 0;
    let labelWork = 0;
    let pickWork = 0;
    let reportAt = 0;
    const perf = !!(data as any).perf;

    const tick = (now = 0) => {
      raf = requestAnimationFrame(tick);
      const frameStart = perf ? performance.now() : 0;
      // Clamp so a backgrounded window does not resume with one enormous step.
      const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0;
      lastFrame = now;
      applyPan(dt);
      const { theta, phi, distance, target } = orbit;
      camera.position.set(
        target.x + distance * Math.sin(phi) * Math.cos(theta),
        target.y + distance * Math.cos(phi),
        target.z + distance * Math.sin(phi) * Math.sin(theta),
      );
      camera.lookAt(target);
      const fog = scene.fog as THREE.Fog;
      fog.near = distance * 0.85;
      fog.far = distance * 3.2;

      if (!showAll) {
        const band = bands.find((b: any) => distance >= b.minDistance) ?? bands[bands.length - 1];
        if (band.level !== active) applyLevel(band.level);
      }

      const pickStart = perf ? performance.now() : 0;
      {
        raycaster.setFromCamera(pointer, camera);

        // Pick across every VISIBLE mesh, not just the active band. Cumulative rendering
        // draws shallower levels too, so testing only the active one left nodes you could
        // see but not hover.
        const pickable = [...meshes.values()].filter((m) => m.visible);
        const hits = raycaster.intersectObjects(pickable, false);
        const first = hits.find((h) => h.instanceId != null);
        const hitLevel = first ? (first.object as any).userData.level : null;
        const hit = first && hitLevel != null
          ? byLevel.get(hitLevel)![first.instanceId!]
          : null;

        const restore = (n: any) => {
          const m = meshes.get(n.level);
          if (!m) return;
          m.setColorAt(n.index, pulseColor(n) ?? baseColor(n));
          if (m.instanceColor) m.instanceColor.needsUpdate = true;
        };

        if (hit !== hovered) {
          if (hovered) restore(hovered);
          if (hit) {
            const m = meshes.get(hit.level)!;
            m.setColorAt(hit.index, HL_NODE);
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
          }
          hovered = hit;
          canvas.style.cursor = hit ? 'pointer' : 'default';

          if (hit) {
            hoveredRope = null;
            setHighlight(ropesByNode.get(hit.key) ?? []);
          } else {
            clearHighlight();
            hideTip();
          }
        }

        if (hit) {
          const degree = (ropesByNode.get(hit.key) ?? []).length;
          showTip(
            `<strong>${esc(hit.label)}</strong>` +
              `<div class="tip-path">${esc(hit.id)}</div>` +
              `<div class="tip-meta">${hit.fileCount} file${hit.fileCount === 1 ? '' : 's'}` +
              (hit.symbolCount ? ` · ${hit.symbolCount} symbols` : '') +
              ` · ${degree} connection${degree === 1 ? '' : 's'}</div>` +
              (hit.purpose ? `<div class="tip-purpose">${esc(hit.purpose)}</div>` : ''),
            lastPointer.x, lastPointer.y,
          );
        } else {
          // No node under the cursor — try the ropes, so a connection is traceable too.
          raycaster.params.Line = { threshold: Math.max(1.2, orbit.distance * 0.006) };
          const lineHits = raycaster.intersectObjects(
            festoonGroup.children.filter((c) => c.visible), false,
          );
          const first = lineHits[0];
          const map = first ? (first.object.userData.vertexToRope as number[]) : null;
          const idx = map && first?.index != null ? map[first.index] : null;

          if (idx !== hoveredRope) {
            hoveredRope = idx ?? null;
            setHighlight(idx != null ? [idx] : []);
            canvas.style.cursor = idx != null ? 'crosshair' : 'default';
          }
          if (idx != null) {
            const r = ropes[idx];
            showTip(
              `<strong>${shortId(r.from)} <span class="arrow">→</span> ${shortId(r.to)}</strong>` +
                `<div class="tip-meta">${r.weight} reference${r.weight === 1 ? '' : 's'}</div>`,
              lastPointer.x, lastPointer.y,
            );
          } else {
            hideTip();
          }
        }
      }
      if (flyers.size) {
        const nowMs = performance.now();
        for (const [session, f] of flyers) {
          // Ease toward the target rather than snapping: the movement is what makes the
          // swarm legible at a glance.
          const prev = f.pos.clone();
          f.pos.lerp(f.target, Math.min(1, dt * 2.4));
          f.mesh.position.copy(f.pos);

          // Point along travel; when parked, stand upright rather than freezing mid-turn.
          const vel = f.pos.clone().sub(prev);
          if (vel.lengthSq() > 1e-6) {
            f.mesh.quaternion.setFromUnitVectors(
              new THREE.Vector3(0, 1, 0), vel.normalize(),
            );
          } else {
            f.mesh.quaternion.slerp(new THREE.Quaternion(), Math.min(1, dt * 2));
          }

          const idle = nowMs - f.lastAt;
          const fade = idle > IDLE_MS ? 0 : 1 - idle / IDLE_MS;
          (f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.6 * fade;
          f.mesh.scale.setScalar(3.4 + Math.sin(nowMs / 260) * 0.5 * fade);
          (f.line.material as THREE.LineBasicMaterial).opacity = 0.4 * fade;
          f.mesh.visible = swarmRef.current;
          f.line.visible = swarmRef.current && f.trail.length > 1;

          const attr = f.line.geometry.getAttribute('position') as THREE.BufferAttribute;
          for (let i = 0; i < TRAIL; i++) {
            const pt = f.trail[Math.min(i, f.trail.length - 1)] ?? f.pos;
            attr.setXYZ(i, pt.x, pt.y, pt.z);
          }
          attr.needsUpdate = true;

          if (idle > IDLE_MS * 2) {
            agentGroup.remove(f.mesh, f.line);
            flyers.delete(session);
          }
        }
      }

      if (pulseUntil.size) {
        for (const [key] of [...pulseUntil]) {
          const node = laid.nodes.get(key) as any;
          const mesh = node && meshes.get(node.level);
          if (!mesh || node.index == null) {
            pulseUntil.delete(key);
            continue;
          }
          mesh.setColorAt(node.index, pulseColor(node) ?? baseColor(node));
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
      }

      const labelStart = perf ? performance.now() : 0;
      drawLabels();
      if (perf) labelWork += performance.now() - labelStart;

      renderer.render(scene, camera);

      if (perf) {
        accum += performance.now() - frameStart;
        frames++;
        if (!reportAt) reportAt = now + 4000;
        else if (now > reportAt) {
          const visible = [...meshes.entries()]
            .filter(([, m]) => m.visible)
            .reduce((sum, [l]) => sum + (byLevel.get(l)?.length ?? 0), 0);
          console.error(
            `PERF mode=${laid.mode} lod=${lod} nodes=${laid.nodes.size} visible=${visible} ` +
            `ropes=${ropes.length} frame=${(accum / frames).toFixed(2)}ms ` +
            `labels=${(labelWork / frames).toFixed(2)}ms pick=${(pickWork / frames).toFixed(2)}ms`,
          );
          frames = 0; accum = 0; labelWork = 0; pickWork = 0;
          reportAt = now + 4000;
        }
      }
    };

    /**
     * 3D buys room, not readability: perspective makes distant text unreadable and
     * billboards overlap as happily as in 2D. So project, sort by importance, place
     * greedily, and reject anything that collides.
     */
    const projected = new THREE.Vector3();
    function drawLabels() {
      const nodes: any[] = [];
      for (const [lvl, mesh] of meshes) {
        if (mesh.visible) nodes.push(...(byLevel.get(lvl) ?? []));
      }
      const rect = mount!.getBoundingClientRect();
      const placed: Array<{ l: number; r: number; t: number; b: number }> = [];
      const frag = document.createDocumentFragment();

      // Whatever is hovered gets its label unconditionally — declutter must never hide
      // the one thing the cursor is pointing at, nor the endpoints of a traced rope.
      const forced = new Set<string>();
      if (hovered) forced.add(hovered.key);
      if (hoveredRope != null) {
        forced.add(ropes[hoveredRope].from);
        forced.add(ropes[hoveredRope].to);
      }

      const candidates = nodes
        .map((node: any) => {
          projected.set(node.x, node.y, node.z).project(camera);
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
      const MAX_LABELS = 90;
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
        el.className = isForced
          ? 'label lit'
          : c.node.purpose ? 'label' : 'label dim';
        el.style.left = `${c.x}px`;
        el.style.top = `${c.y - c.node.radius - 9}px`;
        el.textContent = c.node.label;
        frag.appendChild(el);
      }
      // Agent labels ride above everything: knowing who is where is the point.
      if (swarmRef.current) {
        for (const f of flyers.values()) {
          projected.copy(f.pos).project(camera);
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

      labelLayer.replaceChildren(frag);
    }

    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('mousemove', onMove as unknown as EventListener);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
      removeEventListener('blur', onBlur);
      renderer.dispose();
      geo.dispose();
      offEvent();
      offReset();
      flyerGeo.dispose();
      canvas.remove();
      labelLayer.remove();
      tip.remove();
    };
  }, [data?.stack, data?.defended, data?.repo, data?.fileEdges, mode, lod, channel, expanded]);

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
          {(['structure', 'belief', 'frontier', 'agent'] as Channel[]).map((c) => (
            <button
              key={c}
              className={channel === c ? 'chip active' : 'chip'}
              onClick={() => setChannel(c)}
              title={CHANNEL_HELP[c]}
            >
              {c}
            </button>
          ))}
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
              onClick={() => apiRef.current?.setLevel(n)}
            >
              {mode === 'tree' ? `d${n}` : `L${n}`}
            </button>
          ))}
          <span className="dim">
            {channel !== 'structure'
              ? CHANNEL_HELP[channel]
              : lod === 'all'
              ? `${nodeCount} nodes`
              : mode === 'tree'
                ? 'camera distance = tree depth'
                : levels.length === 1
                  ? 'one level — nothing focused yet, so L1/L2/L3 are the same map'
                  : 'camera distance = focus altitude'}
          </span>
        </div>
        <div className="scene-keys">
          <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> pan ·
          <kbd>Q</kbd><kbd>E</kbd> up/down · <kbd>shift</kbd> faster ·
          <kbd>0</kbd> recentre · drag orbit · right-drag pan · scroll{' '}
          {mode === 'tree' ? 'depth' : 'altitude'}
          {mode === 'tree' && <> · <kbd>alt</kbd>-click a file to open its symbols</>}
        </div>
        {selected && (
          <div className="scene-inspect">
            <strong>{selected.label}</strong>
            <div className="dim">
              L{selected.level} · {selected.fileCount} files · {selected.origin}
            </div>
            {selected.purpose ? (
              <p className="prose">{selected.purpose}</p>
            ) : (
              <p className="dim">
                No agent-written purpose — a path grouping, i.e. filing, not intent.
              </p>
            )}
          </div>
        )}
      </div>
      <Legend channel={channel} agents={agents} mode={mode} />
    </div>
  );
}
