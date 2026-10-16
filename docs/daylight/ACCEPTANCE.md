> **P0 record, kept verbatim.** It uses the pre-rename names (`vds`, `VDS_*`, `visual-desloppify`); the product is now Daylight Software Forge and the CLI is `daylight`.

# Daylight P0 — acceptance

Spec §13, item by item, with the test that proves each. `engine/test/acceptance.ts` prints
this checklist at the end of its run; the per-workstream tests named here hold the depth.
Status as of the `daylight` branch on 2026-10-12.

## Required automated acceptance cases

| # | Case | Status | Proof |
| --- | --- | --- | --- |
| 1 | Mission create/read/restart: stable mission, task and attempt ids survive restart and replay | pass | `acceptance.ts` §1; `mission-store.ts` "restart returns identical" |
| 2 | Run status separation: exit 0 never closes a mission; failed, timed-out and budget-exhausted attempts show correctly | pass | `acceptance.ts` §2 (crash → `blocked — exit 1`, `--timeout 2` → `timed out`, `--max-cost 0.005` → blocked with spend); `orchestrate.ts` "a reviewer that fails blocks the mission" |
| 3 | Cross-project isolation: same relative path cannot associate evidence with the wrong repository | pass | `acceptance.ts` §3 (recording refused by another project's map holding `src/session-cache.ts`); `isolation.ts`; `mission-store.ts` two-directory case |
| 4 | Claim provenance: missing evidence rejected at ingress; contradictory claims persist; enum unchanged | pass | `acceptance.ts` §4 reads `engine/store/types.ts` and asserts exactly six `ClaimStatus` literals; `provenance.ts` |
| 5 | Blind review: reviewer B's initial input excludes reviewer A's conclusions | pass | `acceptance.ts` §5 on `visibleToReviewer` and the MCP config's `VDS_BLIND_PREFIX`; `orchestrate.ts` "blind review filter". Verified on the filter and the plumbing, not through a live stdio session |
| 6 | Experiment: known passing, known failing, flaky, invalid harness, timeout, sandbox denied; logs and hashes collected; honest conclusion | pass | `acceptance.ts` §6 (red → supported, green → supported, green-predicted-red → falsified, flaky → inconclusive, off-allowlist → refused, tamper → invalid, hang → inconclusive/timeout, no sandbox → invalid/denied); `experiment.ts` (103) |
| 7 | Authorisation: read-only reviewer cannot modify source; author cannot modify protected acceptance gate; expanded permission blocked until approved | pass | `acceptance.ts` §7: claude argv allow-list has no write tool and no bypass flag; test lives in the artifact store, not the repo; `audit` mission refused `experiment propose`. The `agents-run-read-only` invariant greps `engine/swarm/` in CI |
| 8 | Stream/replay: two simultaneous attempts keep output separate; restart and replay reproduce state; missing telemetry shown as unknown | pass | `acceptance.ts` §8; `telemetry.ts` (69: concurrent mocks, `costUsd: null` for silence); `orchestrate.ts` export → replay byte-equality |
| 9 | Scene stability: claim colours, selection, overlay, agent activity do not recreate the renderer; project switch does | pass | `acceptance.ts` §9 on `planUpdate`; `scene-lifecycle.ts` (18); live: `MEASURED.md` counters `{"renderers":1,"projections":1,"recolors":3}` after two lens switches |
| 10 | Projection correctness: no phantom nodes, wrong edge targets, or hidden evidence | pass | `acceptance.ts` §10 (every dispute/experiment subject is a `graph.json` node); `scene.ts` referent-rule assertions unchanged |
| 11 | Performance: machine/GPU, cold/warm index timing, peak memory, p95 frame time, scenario size | pass | `MEASURED.md` written by `engine/bench/daylight.ts`; compared against `BASELINE.md` |

Headline from `MEASURED.md` (this machine, integrated Radeon 610M): this repo maps cold in
0.74 s / warm 0.40 s at 271 MB peak RSS; the fixture in 0.27 s; `demo prepare` 0.55 s;
`mission run` with two mocks 0.35 s; `experiment run` under bwrap, two runs, 0.43 s. Renderer:
this repo's map p95 4.3–8.3 ms; the 10k-file map p95 **12.6 ms**, identical to the baseline's
12.6 ms, at 92 fps. One WebGL context across lens changes.

## Demo release gate (§13)

| Gate | Status | Note |
| --- | --- | --- |
| Cold-start setup works | done | `DEMO.md` "Cold start"; verified in this worktree from a fresh `out/` |
| All relevant tests pass | done | `pnpm test:all`: 1,197 assertions across 35 files, all green on 2026-10-12 |
| One real falsifiable disagreement can be viewed/replayed | **needs owner** | The pipeline is proven with mocks end to end. A *real* model disagreement requires the authorised live run in `DEMO.md`; whether the two models actually disagree on the planted defect is unknowable until then |
| Experiment results are reproducible | done | Same harness digest and conclusion across runs and across export → replay |
| Read-only rights are respected | done | Adapter allow-lists unchanged; invariant green; sandbox refuses without bwrap |
| A failure state can be shown without a crash | done | `DEMO.md` "Failure states" table, each produced by the acceptance test |
| UI remains responsive during activity | done, limited | Mission Control polls `daylight.db` while a job runs; measured renderer p95 unchanged. Not stress-tested against a live multi-model run |
| Output explainable to a technical manager in under five minutes | done | `DEMO.md` five-minute narrative; reviewed against the screens, not timed with an audience |

## Deferred to P1/P2 (explicitly not done)

Authoring/repair missions; new-project onboarding; CI/PR gates; adaptive routing; queryable
graph store; renderer plugins and VR; dependency deep scans; Docker as a second sandbox
profile (owner decision); live per-attempt console streaming through the CLI (the renderer
shows the wrapper job's output while an attempt runs and the agent's own streams on exit);
programmatic node highlight on "show on map" (selection and inspector follow; the canvas
highlight needs a controller method).
