import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { layout } from '../scene/layout.ts';
import { layoutTree } from '../scene/tree.ts';
import type { LoadPayload } from '../types.ts';

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
};

export function Scene({ data }: { data: LoadPayload | null }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<any>(null);
  const [level, setLevel] = useState(3);
  const [levels, setLevels] = useState<number[]>([3, 2, 1]);
  const [mode, setMode] = useState<'graph' | 'tree'>('graph');
  const seededMode = useRef(false);
  const apiRef = useRef<{ setLevel: (n: number) => void } | null>(null);
  // Selection survives a layout switch: spot a tangle in the graph, then see where it
  // lives in the tree without hunting for it again.
  const keepId = useRef<string | null>(null);

  // `data` is null on first render, so an initial mode from the host has to be applied
  // when it actually arrives — once, so it never fights the user's own toggle.
  useEffect(() => {
    if (seededMode.current || !data?.initialMode) return;
    seededMode.current = true;
    if (data.initialMode !== 'graph') setMode(data.initialMode);
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
    scene.fog = new THREE.Fog('#0a0c10', 320, 900);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.5, 3000);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.8);
    dir.position.set(120, 220, 140);
    scene.add(dir);

    const repoName = (data.repo ?? 'repo').split('/').filter(Boolean).pop() ?? 'repo';
    const laid = mode === 'tree' ? layoutTree(data, repoName) : layout(data.stack, repoName);
    const bands = laid.bands;
    const distinct = bands.map((b: any) => b.level);
    setLevels(distinct);
    const defended = new Set((data.defended ?? []).map(String));

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
        mesh.setColorAt(i, node.defended ? COLORS.defended : node.purpose ? COLORS.named : COLORS.path);
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
    const perChild = new Map<number, number[]>();
    for (const e of laid.spine) {
      const a = laid.nodes.get(e.from);
      const b = laid.nodes.get(e.to);
      if (!a || !b) continue;
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
      distance: laid.mode === 'tree' ? Math.max(220, extent * 2.6, depthSpan * 2.2) : 300,
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
        mesh.visible = shallower;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.transparent = l !== lvl;
        mat.opacity = l === lvl ? 1 : 0.32;
        mat.depthWrite = l === lvl;
      }
      for (const lines of festoonGroup.children) {
        lines.visible = laid.mode === 'tree' ? true : lines.userData.level === lvl;
      }
      for (const line of spineGroup.children) {
        line.visible = laid.mode === 'tree'
          ? line.userData.level <= lvl
          : line.userData.level >= lvl;
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
    const onClick = () => {
      keepId.current = hovered ? hovered.id : null;
      setSelected(hovered ? { ...hovered } : null);
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

    const resize = () => {
      const r = mount.getBoundingClientRect();
      camera.aspect = Math.max(r.width, 1) / Math.max(r.height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(r.width, r.height, false);
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
    const tick = (now = 0) => {
      raf = requestAnimationFrame(tick);
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

      const band = bands.find((b: any) => distance >= b.minDistance) ?? bands[bands.length - 1];
      if (band.level !== active) applyLevel(band.level);

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
          m.setColorAt(n.index, n.defended ? COLORS.defended : n.purpose ? COLORS.named : COLORS.path);
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
      drawLabels();
      renderer.render(scene, camera);
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

      for (const c of candidates as any[]) {
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
      canvas.remove();
      labelLayer.remove();
      tip.remove();
    };
  }, [data?.stack, data?.defended, data?.repo, data?.fileEdges, mode]);

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
          {levels.map((n) => (
            <button
              key={n}
              className={n === level ? 'chip active' : 'chip'}
              onClick={() => apiRef.current?.setLevel(n)}
            >
              {mode === 'tree' ? `d${n}` : `L${n}`}
            </button>
          ))}
          <span className="dim">
            {mode === 'tree'
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
    </div>
  );
}
