import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { key, layout, LEVEL_Y } from '../scene/layout.ts';
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

const LOD_BANDS = [
  { level: 3, minDistance: 250 },
  { level: 2, minDistance: 135 },
  { level: 1, minDistance: 0 },
];

export function Scene({ data }: { data: LoadPayload | null }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<any>(null);
  const [level, setLevel] = useState(3);
  const apiRef = useRef<{ setLevel: (n: number) => void } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !data?.stack) return;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    mount.appendChild(canvas);

    const labelLayer = document.createElement('div');
    labelLayer.className = 'labels';
    mount.appendChild(labelLayer);

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

    const laid = layout(data.stack);
    const defended = new Set((data.defended ?? []).map(String));

    const byLevel = new Map<number, any[]>([[1, []], [2, []], [3, []]]);
    for (const node of laid.nodes.values()) byLevel.get(node.level)!.push(node);

    const meshes = new Map<number, THREE.InstancedMesh>();
    const geo = new THREE.SphereGeometry(1, 20, 14);

    for (const [lvl, nodes] of byLevel) {
      if (!nodes.length) continue;
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.InstancedMesh(geo, mat, nodes.length);
      const m = new THREE.Matrix4();
      nodes.forEach((node: any, i: number) => {
        // Compressed so a 200-file bucket does not render a 3-file one invisible.
        const s = 2.4 + Math.pow(Math.max(node.fileCount, 1), 0.42) * 1.5;
        m.makeScale(s, s, s);
        m.setPosition(node.x, node.y, node.z);
        mesh.setMatrixAt(i, m);
        node.defended = node.members.some((mm: string) => defended.has(mm)) || defended.has(node.id);
        mesh.setColorAt(i, node.defended ? COLORS.defended : node.purpose ? COLORS.named : COLORS.path);
        node.index = i;
        node.radius = s;
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
    const trunk: number[] = [];
    for (const n of byLevel.get(3)!) trunk.push(0, LEVEL_Y[3] - 30, 0, n.x, n.y, n.z);
    perChild.set(3, trunk);

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
    const festoonGroup = new THREE.Group();
    const perLevel = new Map<number, any[]>();
    for (const f of laid.festoons) {
      if (!perLevel.has(f.level)) perLevel.set(f.level, []);
      perLevel.get(f.level)!.push(f);
    }
    for (const [lvl, list] of perLevel) {
      const positions: number[] = [];
      const colors: number[] = [];
      const base = new THREE.Color('#8a5cf6');
      const heavy = new THREE.Color('#c07ef0');
      for (const f of list) {
        const a = laid.nodes.get(f.from);
        const b = laid.nodes.get(f.to);
        if (!a || !b) continue;
        const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        const span = Math.hypot(a.x - b.x, a.z - b.z);
        mid.x *= 0.34;
        mid.z *= 0.34;
        mid.y -= Math.min(span * 0.16, 26);
        const pts = new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(a.x, a.y, a.z), mid, new THREE.Vector3(b.x, b.y, b.z),
        ).getPoints(14);
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
        g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.34 }),
      );
      lines.userData.level = lvl;
      festoonGroup.add(lines);
    }
    scene.add(festoonGroup);

    const orbit = { theta: 0.7, phi: 1.15, distance: 300, target: new THREE.Vector3(0, 0, 0) };
    let active = 3;

    const applyLevel = (lvl: number) => {
      active = lvl;
      setLevel(lvl);
      // Cumulative rather than exclusive: L3 is the trunk and stays, dropping altitude
      // reveals the branches under it.
      for (const [l, mesh] of meshes) {
        mesh.visible = l >= lvl;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.transparent = l !== lvl;
        mat.opacity = l === lvl ? 1 : 0.32;
        mat.depthWrite = l === lvl;
      }
      for (const lines of festoonGroup.children) lines.visible = lines.userData.level === lvl;
      for (const line of spineGroup.children) line.visible = line.userData.level >= lvl;
      orbit.target.y = lvl === 3 ? LEVEL_Y[3] : (LEVEL_Y[3] + LEVEL_Y[lvl]) / 2;
    };
    apiRef.current = {
      setLevel: (n) => {
        applyLevel(n);
        orbit.distance = (LOD_BANDS.find((b) => b.level === n)?.minDistance || 90) + 60;
      },
    };
    applyLevel(3);

    // ---- input ---------------------------------------------------------------
    const pointer = new THREE.Vector2(-2, -2);
    const raycaster = new THREE.Raycaster();
    let dragging = false;
    let last = { x: 0, y: 0 };
    let hovered: any = null;

    const onDown = (e: PointerEvent) => {
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => (dragging = false);
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (dragging) {
        orbit.theta -= (e.clientX - last.x) * 0.005;
        orbit.phi = Math.max(0.08, Math.min(Math.PI - 0.08, orbit.phi - (e.clientY - last.y) * 0.005));
        last = { x: e.clientX, y: e.clientY };
      }
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      orbit.distance = Math.max(45, Math.min(1200, orbit.distance * (1 + Math.sign(e.deltaY) * 0.09)));
    };
    const onClick = () => setSelected(hovered ? { ...hovered } : null);

    canvas.addEventListener('pointerdown', onDown);
    addEventListener('pointerup', onUp);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('click', onClick);

    const resize = () => {
      const r = mount.getBoundingClientRect();
      camera.aspect = Math.max(r.width, 1) / Math.max(r.height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(r.width, r.height, false);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { theta, phi, distance, target } = orbit;
      camera.position.set(
        target.x + distance * Math.sin(phi) * Math.cos(theta),
        target.y + distance * Math.cos(phi),
        target.z + distance * Math.sin(phi) * Math.sin(theta),
      );
      camera.lookAt(target);

      const band = LOD_BANDS.find((b) => distance >= b.minDistance) ?? LOD_BANDS[LOD_BANDS.length - 1];
      if (band.level !== active) applyLevel(band.level);

      const mesh = meshes.get(active);
      if (mesh) {
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObject(mesh, false);
        const hit = hits.length && hits[0].instanceId != null ? byLevel.get(active)![hits[0].instanceId] : null;
        if (hit !== hovered) {
          if (hovered && hovered.level === active) {
            mesh.setColorAt(hovered.index, hovered.defended ? COLORS.defended : hovered.purpose ? COLORS.named : COLORS.path);
          }
          if (hit) mesh.setColorAt(hit.index, COLORS.hover);
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          hovered = hit;
          canvas.style.cursor = hit ? 'pointer' : 'default';
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
      const nodes = byLevel.get(active) ?? [];
      const rect = mount!.getBoundingClientRect();
      const placed: Array<{ l: number; r: number; t: number; b: number }> = [];
      const frag = document.createDocumentFragment();

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
        .sort((a: any, b: any) => b.node.fileCount - a.node.fileCount);

      for (const c of candidates as any[]) {
        const w = c.node.label.length * 6 + 10;
        const box = { l: c.x - w / 2, r: c.x + w / 2, t: c.y - 8, b: c.y + 8 };
        if (box.l < 0 || box.r > rect.width || box.t < 0 || box.b > rect.height) continue;
        if (placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) continue;
        placed.push(box);

        const el = document.createElement('div');
        el.className = c.node.purpose ? 'label' : 'label dim';
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
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('click', onClick);
      renderer.dispose();
      geo.dispose();
      canvas.remove();
      labelLayer.remove();
    };
  }, [data?.stack, data?.defended]);

  if (!data?.stack) {
    return <div className="scene-empty">Map a repo to see the tree.</div>;
  }

  return (
    <div className="scene-wrap">
      <div className="scene-canvas" ref={mountRef} />
      <div className="scene-hud">
        <div className="lod">
          {[3, 2, 1].map((n) => (
            <button
              key={n}
              className={n === level ? 'chip active' : 'chip'}
              onClick={() => apiRef.current?.setLevel(n)}
            >
              L{n}
            </button>
          ))}
          <span className="dim">camera distance = altitude</span>
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
