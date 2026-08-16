import * as THREE from './three.module.js';
import { layout, LEVEL_Y, key } from './layout.js';

/**
 * The festooned tree.
 *
 * Two things this scene is built around:
 *
 *  1. The spine is stable. Position is a pure function of the focus stack, with no force
 *     relaxation and no randomness, because flying around only builds spatial memory if
 *     the same repo lays out the same way every time.
 *  2. LOD is SEMANTIC, not cosmetic. Camera distance IS altitude on the focus stack.
 *     Pulling back does not fade nodes out, it collapses them into their agent-named
 *     abstraction. You are never looking at a view that isn't a defensible map at some
 *     altitude.
 */

const COLORS = {
  named: new THREE.Color('#7ee0a8'),
  path: new THREE.Color('#5a6675'),
  defended: new THREE.Color('#f0a868'),
  hover: new THREE.Color('#6ea8fe'),
};

const LOD_BANDS = [
  { level: 3, minDistance: 250 },
  { level: 2, minDistance: 135 },
  { level: 1, minDistance: 0 },
];

const canvas = document.getElementById('scene');
const labelLayer = document.getElementById('labels');
const inspect = document.getElementById('inspect');

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a0c10');
scene.fog = new THREE.Fog('#0a0c10', 320, 900);

const camera = new THREE.PerspectiveCamera(52, 1, 0.5, 3000);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

scene.add(new THREE.AmbientLight(0xffffff, 1.5));
const dir = new THREE.DirectionalLight(0xffffff, 1.8);
dir.position.set(120, 220, 140);
scene.add(dir);

// ---- a compact orbit controller (avoids vendoring another addon) --------------
const orbit = { theta: 0.7, phi: 1.15, distance: 300, target: new THREE.Vector3(0, 0, 0) };
let dragging = false;
let last = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  last = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    orbit.theta -= (e.clientX - last.x) * 0.005;
    orbit.phi = Math.max(0.08, Math.min(Math.PI - 0.08, orbit.phi - (e.clientY - last.y) * 0.005));
    last = { x: e.clientX, y: e.clientY };
  }
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    orbit.distance = Math.max(45, Math.min(1200, orbit.distance * (1 + Math.sign(e.deltaY) * 0.09)));
  },
  { passive: false },
);

function updateCamera() {
  const { theta, phi, distance, target } = orbit;
  camera.position.set(
    target.x + distance * Math.sin(phi) * Math.cos(theta),
    target.y + distance * Math.cos(phi),
    target.z + distance * Math.sin(phi) * Math.sin(theta),
  );
  camera.lookAt(target);
}

// ---- state -------------------------------------------------------------------
const pointer = new THREE.Vector2(-2, -2);
const raycaster = new THREE.Raycaster();
let laid = null;
let byLevel = new Map();
let activeLevel = 3;
let autoLod = true;
let showFestoons = true;
let hovered = null;
let selected = null;
let meshes = new Map();
let spineLines = null;
let festoonGroup = new THREE.Group();
scene.add(festoonGroup);

const $ = (id) => document.getElementById(id);

// ---- build -------------------------------------------------------------------
function build(data) {
  const { stack } = data;
  laid = layout(stack);

  $('dir').textContent = data.dir;
  $('s-files').textContent = stack.l0.files;
  $('s-symbols').textContent = stack.l0.symbols;
  $('s-edges').textContent = stack.l0.edges;
  for (const l of stack.levels) $(`s-l${l.level}`).textContent = `${l.nodes.length} nodes`;
  const status = stack.l3Status;
  $('s-status').textContent = status;
  $('s-status').style.color =
    status === 'TRUE' ? '#7ee0a8' : status === 'STALE' ? '#f0a868' : '#7c8798';

  // Group laid-out nodes by level, and note which are defended.
  byLevel = new Map([[1, []], [2, []], [3, []]]);
  for (const node of laid.nodes.values()) byLevel.get(node.level).push(node);

  const defendedIds = new Set((data.defended || []).map(String));
  const geo = new THREE.SphereGeometry(1, 20, 14);
  for (const [level, nodes] of byLevel) {
    if (!nodes.length) continue;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.InstancedMesh(geo, mat, nodes.length);
    const m = new THREE.Matrix4();

    nodes.forEach((node, i) => {
      // Size by mass, but compressed — a 200-file bucket must not dwarf a 3-file one
      // into invisibility.
      const s = 2.4 + Math.pow(Math.max(node.fileCount, 1), 0.42) * 1.5;
      m.makeScale(s, s, s);
      m.setPosition(node.x, node.y, node.z);
      mesh.setMatrixAt(i, m);
      const isDefended = node.members.some((m) => defendedIds.has(m)) || defendedIds.has(node.id);
      node.defended = isDefended;
      mesh.setColorAt(i, isDefended ? COLORS.defended : node.purpose ? COLORS.named : COLORS.path);
      node.index = i;
      node.radius = s;
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData.level = level;
    meshes.set(level, mesh);
    scene.add(mesh);
  }

  // Spine, split by the level it descends INTO, so we can reveal branches as the
  // camera drops through altitudes rather than drawing lines to invisible nodes.
  const perChild = new Map();
  for (const e of laid.spine) {
    const a = laid.nodes.get(e.from);
    const b = laid.nodes.get(e.to);
    if (!a || !b) continue;
    if (!perChild.has(b.level)) perChild.set(b.level, []);
    perChild.get(b.level).push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  // The trunk: origin up to each L3 node. Without it the base ring floats.
  const trunk = [];
  for (const n of byLevel.get(3)) trunk.push(0, LEVEL_Y[3] - 30, 0, n.x, n.y, n.z);
  perChild.set(3, trunk);

  spineLines = new THREE.Group();
  for (const [childLevel, pts] of perChild) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: '#6ea8fe', transparent: true, opacity: 0.3 }),
    );
    line.userData.level = childLevel;
    spineLines.add(line);
  }
  scene.add(spineLines);

  buildFestoons();
  setLevel(3);
}

/**
 * Festoons dip toward the axis at their midpoint. That curvature is what makes a
 * bundle of cross-edges read as one rope instead of a hairball — and what makes a
 * limb whose garlands all fly elsewhere visible from across the scene.
 */
function buildFestoons() {
  festoonGroup.clear();
  if (!laid) return;

  const perLevel = new Map();
  for (const f of laid.festoons) {
    if (!perLevel.has(f.level)) perLevel.set(f.level, []);
    perLevel.get(f.level).push(f);
  }

  for (const [level, list] of perLevel) {
    const positions = [];
    const colors = [];
    const base = new THREE.Color('#8a5cf6');
    const heavy = new THREE.Color('#c07ef0');

    for (const f of list) {
      const a = laid.nodes.get(f.from);
      const b = laid.nodes.get(f.to);
      if (!a || !b) continue;

      const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      // Pull the control point toward the axis: deeper pull for longer spans, which
      // is what bundles co-travelling edges together.
      const span = Math.hypot(a.x - b.x, a.z - b.z);
      mid.x *= 0.34;
      mid.z *= 0.34;
      mid.y -= Math.min(span * 0.16, 26);

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(a.x, a.y, a.z),
        mid,
        new THREE.Vector3(b.x, b.y, b.z),
      );
      const pts = curve.getPoints(14);
      const c = f.weight > 12 ? heavy : base;
      for (let i = 0; i < pts.length - 1; i++) {
        positions.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
        colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const lines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.34 }),
    );
    lines.userData.level = level;
    festoonGroup.add(lines);
  }
}

function setLevel(level) {
  activeLevel = level;

  // Cumulative, not exclusive: L3 is the trunk and stays. Dropping altitude reveals
  // the branches below it, so the thing reads as a tree you are descending into
  // rather than three unrelated diagrams that swap.
  for (const [lvl, mesh] of meshes) {
    mesh.visible = lvl >= level;
    mesh.material.transparent = lvl !== level;
    mesh.material.opacity = lvl === level ? 1 : 0.32;
    mesh.material.depthWrite = lvl === level;
  }
  for (const lines of festoonGroup.children) {
    lines.visible = showFestoons && lines.userData.level === level;
  }
  if (spineLines) {
    for (const line of spineLines.children) line.visible = line.userData.level >= level;
  }
  orbit.target.y = level === 3 ? LEVEL_Y[3] : (LEVEL_Y[3] + LEVEL_Y[level]) / 2;
  for (const l of [1, 2, 3]) {
    const el = $(`lvl-${l}`);
    if (el) el.classList.toggle('active', l === level);
  }
}

// ---- interaction -------------------------------------------------------------
addEventListener('keydown', (e) => {
  if (e.key === '1' || e.key === '2' || e.key === '3') {
    autoLod = false;
    const lvl = Number(e.key);
    setLevel(lvl);
    orbit.distance = (LOD_BANDS.find((b) => b.level === lvl)?.minDistance || 90) + 60;
  }
  if (e.key === 'a') autoLod = !autoLod;
  if (e.key === 'f') {
    showFestoons = !showFestoons;
    setLevel(activeLevel);
  }
});

canvas.addEventListener('click', () => {
  selected = hovered;
  renderInspector();
});

function renderInspector() {
  if (!selected) {
    inspect.style.display = 'none';
    return;
  }
  inspect.style.display = 'block';
  $('i-name').textContent = selected.label;
  $('i-meta').textContent =
    `L${selected.level} · ${selected.fileCount} files · ${selected.symbolCount} symbols · ${selected.origin}`;
  $('i-purpose').innerHTML = '';
  const p = document.createElement('div');
  if (selected.purpose) {
    p.className = 'purpose';
    p.textContent = selected.purpose;
  } else {
    p.className = 'none';
    p.textContent = 'No agent-written purpose — this node is a path grouping, i.e. a filing decision, not intent.';
  }
  $('i-purpose').appendChild(p);

  const wrap = $('i-members');
  wrap.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'sub';
  h.textContent = `members (${selected.members.length}) — every node expands back to files`;
  wrap.appendChild(h);
  const ul = document.createElement('ul');
  for (const m of selected.members.slice(0, 40)) {
    const li = document.createElement('li');
    li.textContent = m;
    ul.appendChild(li);
  }
  if (selected.members.length > 40) {
    const li = document.createElement('li');
    li.textContent = `… ${selected.members.length - 40} more`;
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
}

function pick() {
  const mesh = meshes.get(activeLevel);
  if (!mesh) return null;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(mesh, false);
  if (!hits.length || hits[0].instanceId == null) return null;
  return byLevel.get(activeLevel)[hits[0].instanceId] ?? null;
}

/**
 * Label declutter. 3D buys room, but it does not solve labels — perspective makes
 * distant text unreadable and billboards overlap as happily as in 2D. So: project,
 * sort by importance, place greedily, reject anything that collides.
 */
function drawLabels() {
  const nodes = byLevel.get(activeLevel) ?? [];
  const v = new THREE.Vector3();
  const placed = [];
  const frag = document.createDocumentFragment();

  const candidates = nodes
    .map((node) => {
      v.set(node.x, node.y, node.z).project(camera);
      if (v.z > 1) return null;
      const dist = camera.position.distanceTo(new THREE.Vector3(node.x, node.y, node.z));
      return {
        node,
        x: (v.x * 0.5 + 0.5) * innerWidth,
        y: (-v.y * 0.5 + 0.5) * innerHeight,
        dist,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.node.fileCount - a.node.fileCount || a.dist - b.dist);

  for (const c of candidates) {
    const text = c.node.label;
    const w = text.length * 6 + 10;
    const h = 15;
    const box = { l: c.x - w / 2, r: c.x + w / 2, t: c.y - h / 2, b: c.y + h / 2 };
    if (box.l < 0 || box.r > innerWidth || box.t < 0 || box.b > innerHeight) continue;

    const collides = placed.some(
      (p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t,
    );
    if (collides) continue;
    placed.push(box);

    const el = document.createElement('div');
    el.className = c.node.purpose ? 'label' : 'label dim';
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y - c.node.radius - 9}px`;
    el.textContent = text;
    frag.appendChild(el);
  }

  labelLayer.replaceChildren(frag);
}

// ---- loop --------------------------------------------------------------------
function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
}
addEventListener('resize', resize);

function tick() {
  requestAnimationFrame(tick);
  updateCamera();

  if (autoLod) {
    const band = LOD_BANDS.find((b) => orbit.distance >= b.minDistance) ?? LOD_BANDS.at(-1);
    if (band.level !== activeLevel) setLevel(band.level);
  }

  const mesh = meshes.get(activeLevel);
  const hit = pick();
  if (mesh && hit !== hovered) {
    const nodes = byLevel.get(activeLevel);
    if (hovered && hovered.level === activeLevel) {
      mesh.setColorAt(
        hovered.index,
        hovered.defended ? COLORS.defended : hovered.purpose ? COLORS.named : COLORS.path,
      );
    }
    if (hit) mesh.setColorAt(hit.index, COLORS.hover);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    hovered = hit;
    canvas.style.cursor = hit ? 'pointer' : 'default';
    void nodes;
  }

  drawLabels();
  renderer.render(scene, camera);
}

// ---- boot --------------------------------------------------------------------
function fatal(message) {
  const el = document.getElementById('error');
  el.style.display = 'block';
  el.textContent = message;
  console.error(message);
}

// Never fail silently: a blank scene with no explanation is the worst outcome here.
addEventListener('error', (e) => fatal(`renderer error: ${e.message}`));
addEventListener('unhandledrejection', (e) => fatal(`unhandled rejection: ${e.reason}`));

resize();
try {
  const data = await window.vds.load();
  if (data.error) fatal(data.error);
  else build(data);
} catch (err) {
  fatal(`load failed: ${err && err.stack ? err.stack : err}`);
}
tick();
