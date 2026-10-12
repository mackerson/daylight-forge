# Measured — Daylight P0 build

Written by `engine/bench/daylight.ts` on 2026-10-12T23:46:38.153Z at `f089b8a589cc`. Every number below
was measured on this machine by that script; compare with `docs/daylight/BASELINE.md`.

**Machine:** Linux 7.2.6-arch2-1, AMD Ryzen 9 7845HX with Radeon Graphics × 24, 62 GB RAM, Node v24.18.0, Electron 43.4.0, bubblewrap 0.13.0

## Index timings (engine, CPU)

Wall time around `execFileSync` of the CLI, including Node start-up. Peak RSS is the
child's `VmHWM` from `/proc`, sampled at 100 ms.

| Repository | Files | Cold `map` | Warm `map` | `derive` | Peak RSS (cold map) |
| --- | --- | --- | --- | --- | --- |
| this repo | 152 | 0.75 s | 0.39 s | 0.29 s | 267 MB |
| daylight-demo fixture (PLANTED) | 6 | 0.26 s | 0.25 s | 0.24 s | 155 MB |

## Mission loop (fixture, two mock reviewers, real bwrap sandbox)

| Step | Wall time | Peak RSS | Note |
| --- | --- | --- | --- |
| `demo prepare` (materialise + map + mission + experiment) | 0.53 s | 160 MB | exit 0 |
| `mission run` with two mock reviewers + compare | 0.35 s | 159 MB | mocks, not models; exit 0 |
| `experiment run` (bwrap, 2 runs) | 0.44 s | 160 MB | concluded `supported` |

## Renderer (headless `VDS_BENCH=6`, same method as BASELINE.md)

Windowed runs, on the GPU named below. The machine is vsync-capped at ~60 Hz (see BASELINE.md A/B); compare p95 with that table.

**GPU:** `ANGLE (AMD, AMD Radeon 610M (radeonsi raphael_mendocino ACO), OpenGL ES 3.2)`

| Map | Mode | Run | Nodes (visible) | Ropes | fps | mean ms | p95 ms | worst ms | draws |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| this repo | graph | 1 | 75 (25) | 82 | 232.2 | 4.31 | 4.3 | 25.0 | 3 |
| this repo | graph | 2 | 75 (25) | 82 | 232.4 | 4.30 | 4.3 | 33.3 | 3 |
| this repo | graph | 3 | 75 (25) | 82 | 226.7 | 4.41 | 8.3 | 8.5 | 3 |
| 10k-file map (private, load fixture only) | tree | 1 | 11713 (9833) | 29274 | 92.2 | 10.85 | 12.6 | 25.0 | 12 |

### Single renderer across lens changes

After two lens switches, `window.__vdsScene.counters` = `{"renderers":1,"projections":1,"recolors":3}`.
Expected: `renderers` 1, `projections` 1, `recolors` ≥ 2 — the WebGL context is created once per mount.

## Not measured

- Live model reviewers: no `claude`/`codex` run is made by this script (it would spend money).
- Incremental edit → visible status: the existing watch path is unchanged by P0 and was not re-timed.
- Peak RSS of the Electron renderer process: the bench reports frame stats only.
