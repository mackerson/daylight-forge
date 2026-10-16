> **P0 record, kept verbatim.** It uses the pre-rename names (`vds`, `VDS_*`, `visual-desloppify`); the product is now Daylight Software Forge and the CLI is `daylight`.

# Performance baseline — before Daylight P0 changes

Measured 2026-10-12 on the `daylight` branch at `02c7a5c` (renderer and engine unchanged
from `multi-agent-runs` `ac32e79`). One machine, one run each; these are the numbers later
measurements are compared against, not claims about other hardware.

**Machine:** Arch Linux, kernel 7.2.6, Wayland session, Node 24.18.0, Electron 43.
**GPU in use:** `ANGLE (AMD, AMD Radeon 610M (radeonsi raphael_mendocino ACO), OpenGL ES 3.2)`
— the integrated chip. The discrete GPU path (`pnpm gui:dgpu`) was not used, so a later
comparison must use the same chip.

## Index timings (engine, CPU)

| Repository | Files | Cold `map` (cache cleared) | Warm `map` (cache hit) | `derive` |
| --- | --- | --- | --- | --- |
| this repo | 112 | 0.64 s | 0.36 s | 0.25 s |

Method: `node engine/cli.ts map . --out ./out --top 0` timed with `process.hrtime` around
`execFileSync`, after `rm -rf out/.cache` for the cold run. Includes Node startup.

## Frame stats (renderer, headless `VDS_BENCH=6`)

| Map | Mode | Nodes (visible) | Ropes | fps | mean ms | p95 ms | worst ms | draws | tris |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| this repo (`./out`) | graph | 76 (76) | 261 | 186.7 | 5.35 | 8.4 | 8.5 | 9 | 39,520 |
| 10k-file monorepo map | tree | 11,713 (9,833) | 29,274 | 86.5 | 11.56 | 12.6 | 16.8 | 12 | 5,113,160 |

Method: `VDS_BENCH=6 VDS_SHOT=<png> VDS_SHOT_DELAY=<ms> electron app/main/main.cjs`, reading
the `BENCH {…}` line the renderer prints. The 10k map is an existing output directory under
`~/.config/visual-desloppify/maps/` for a private employer repository: it is used here only
as a local load fixture and is not part of the demo, the tests, or anything shared.

## What the spec reported

The spec (§3) quotes ~14,651 visible nodes at ~92–107 fps on integrated GPU for the 10k
fixture, as repository-reported measurements. The run above saw 9,833 visible of 11,713 at
86.5 fps in tree mode with `showAll: false`, which is a different view of the same map; the
numbers are not directly comparable and neither is treated as the target. The P0 guardrail is
"no regression from this file's p95 without an explanation".

## After DL-04 (scene controller) — A/B on the same machine, same session

The first post-merge bench read 58 fps / p95 20.9 ms against the 187 fps / 8.4 ms above. That
was the machine, not the change: the desktop session had locked and unlocked in between, after
which every windowed Electron run — including the pre-change renderer rebuilt from `a44bc36` —
sits at a 60 Hz cap (mean ≈ 17.2 ms is one vsync). Interleaved runs, this repo's map (85 nodes,
279 ropes), integrated Radeon:

| Renderer | Mode | fps | mean ms | p95 ms | worst ms |
| --- | --- | --- | --- | --- | --- |
| before DL-04 (`a44bc36`) | windowed | 58.1 / 58.9 | 17.21 / 16.97 | 20.9 / 21.0 | 29.2 / 33.5 |
| after DL-04 (`1c8d30e`) | windowed | 57.9 / 57.9 | 17.26 / 17.27 | 20.9 / 20.9 | 29.2 / 21.0 |
| before DL-04 | `--headless=new --use-angle=swiftshader` | 56.3 / 56.3 | 17.77 / 17.76 | 21.0 / 20.9 | 25.0 / 21.0 |
| after DL-04 | headless swiftshader | 57.0 / 55.8 | 17.54 / 17.93 | 21.0 / 21.0 | 75.2 / 71.0 |

p95 is identical to the tenth of a millisecond in every pairing. The one difference is a single
worst-frame spike in both headless runs of the new renderer (71–75 ms once per ~500 frames),
not seen in the two base runs; too few samples to call it real, noted for DL-07b to re-measure
with the cap lifted. The uncapped number in the first table remains the baseline for anyone who
can reproduce an uncapped session.
