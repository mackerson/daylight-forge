# Daylight P0 — coordination plan

Working document for the two-week demo. The spec is `docs/DAYLIGHT_SPEC_v0.1.md`; this file
is what the workstreams agreed before editing in parallel. Code wins on current facts, the
spec wins on desired behaviour, and this file wins on *who owns which file* until the P0
branch merges.

Integration branch: `daylight` (off `multi-agent-runs`). One worktree per workstream, named
`dl-0N`. Merge order is the dependency order below. Nothing merges without
`pnpm typecheck`, `pnpm test:all`, and the workstream's own test file green.

## Spec vs code — conflicts found during verification

| Spec says | Code says | Resolution |
| --- | --- | --- |
| §3 lists `tree-sitter, knip, dep-cruiser` extractors (quoting DESIGN.md) | Extraction is the TypeScript compiler API behind a `Parser` seam; no tree-sitter | DESIGN.md's diagram is aspirational. P0 does not add a parser. |
| §4 `Attempt.costUsd?: number // unknown is not zero` | `AgentResult.cost` is `0` when a CLI reports nothing; `RunRecord.costKnown` carries the distinction | Attempts store `costUsd: number \| null`; `null` is unknown. The ledger is left as is. |
| §9 "current MCP `events.jsonl` observes tool calls" and "`vds:job-output` exposes wrapper output" | Correct. `adapters.run` buffers each agent's stdout into `AgentResult.stdout`; nothing streams it | DL-02 adds an `onOutput` seam to `run()`; buffering stays for callers that want the whole thing. |
| §8 "Landing screen: Open repository or Start project" | The shell opens on the last output directory and adopts its repo | P0 keeps that. Mission Control becomes a view in the stage strip, not a replacement shell. "Start project" is shown disabled with a P1 label. |
| §12 proposes `vds mission …` commands | `cli.ts` is a single 1,600-line switch | New commands land in `engine/cli.ts` as thin dispatch to `engine/mission/*`; no CLI rewrite. |
| §6 "worktree is not a sandbox" | Nothing executes anything today | DL-03: bubblewrap + prlimit, fail closed. See ADR-3. |
| §13 fixture "with a real, planted … defect" | No fixture repo exists; `fixtures/` holds invariant JSON | DL-07 adds `fixtures/daylight-demo/` as a plain tree with a script that materialises it as a git repo at a deterministic commit. |

## Decisions (ADRs, short)

**ADR-1 — Separate `daylight.db`.** Missions, tasks, attempts, experiments, decisions,
artifacts and events live in `<out>/daylight.db`, beside `claims.db`. The claim store is
already under a live `god_verdict` dispute; widening it would be taking a side. Claims are
referenced by integer id. `engine/mission/db.ts` owns the schema and numbered migrations.

**ADR-2 — Project identity is `git:<first-commit>`.** Two clones agree, two projects never
do, and a repo-relative path is the key that already caused one cross-project contamination.
Non-git directories get `path:<sha256>` and a revision of `unversioned`. Revision labels are
`<sha>` or `<sha>+dirty`; a dirty revision is recorded, never hidden.

**ADR-3 — Sandbox is bubblewrap, ceilings are prlimit, missing means refused.** Both are on
the dev machine (`bwrap 0.13`, unprivileged userns on). The runner builds an argv of
`prlimit … bwrap --unshare-all --die-with-parent --new-session --clearenv --ro-bind <worktree> /work …`
and *refuses* to run with a profile of `none`: an experiment on a machine without bwrap
concludes `invalid: sandbox unavailable`. Owner decision pending on whether Docker should be a
second profile; not built for P0. The command allowlist is `node` only, with every path argument
resolved inside the worktree.

**ADR-4 — Protected acceptance.** The test and its expected observation are artifacts in the
content-addressed store. At run time the runner *copies the registered test into the
worktree* from the artifact store and refuses if the worktree's copy differs. The author side
never has a write path to `<out>/artifacts`. `harnessDigest` covers test + expectation +
command + sandbox profile, so any change to any of them is a different experiment.

**ADR-5 — Events are a table, not a second JSONL.** `events.sequence` is SQLite's rowid, so
ordering is durable and monotonic across the MCP server, the driver and the shell writing at
once. The existing `events.jsonl` is left exactly as it is for the map's replay; DL-02
ingests it into the table keyed by `session → attempt`.

**ADR-6 — Blind review is enforced at the MCP server.** `get_slice` already returns stored
claims, so reviewer B would see A's answers. With `VDS_BLIND_PREFIX=<mission session prefix>`
the server omits agent claims whose `source.sessionId` starts with that prefix and is not
the caller's own. Human and static claims still show. Owned by DL-06.

**ADR-7 — Live agent runs are recorded, never fabricated.** Tests use a mock adapter that is
labelled `mock` in every artifact it produces. The demo replay is recorded from a real run
on the fixture; until that run is authorised and done, the demo script says "no recording
yet" rather than playing a synthetic one.

## Shared contracts (wave 0, done)

- `engine/mission/types.ts` — `Mission`, `Task`, `Attempt`, `Experiment`, `Decision`,
  `ArtifactRef`, `DaylightEvent`, state tables and `canTransition`.
- `engine/mission/db.ts` — `openDaylightDb`, `migrate`, `parseJson`. Schema v1.
- `engine/mission/project.ts` — `identifyProject`, `currentRevision`, `shortRevision`.
- `engine/mission/artifacts.ts` — `ArtifactStore.put/get/text/has`, `digestOf`.
- Test: `engine/test/daylight-core.ts` (40).

Ids: `m_`, `t_`, `a_`, `x_`, `d_`, `ev_` + `crypto.randomUUID()` without dashes. Artifact
ids are digests. Sessions handed to adapters are `${missionId}:${attemptId}` so an
`events.jsonl` line correlates to an attempt by prefix match on nothing — exact match on the
attempt's `sessionId`.

## Workstreams, ownership, interfaces

### DL-01 — Mission store (wave 1)
Owns: `engine/mission/store.ts`, `engine/test/mission-store.ts`.
```ts
class MissionStore {
  constructor(outDir: string, now?: () => number)   // opens <out>/daylight.db
  ensureProject(p: ProjectIdentity): void
  createMission(input: {projectId, kind, objective, baseRevision, scope?, permissions?, budget?, parentId?}): Mission
  mission(id): Mission | null;  missions(projectId?): Mission[]
  transitionMission(id, to: MissionState, reason?): Mission      // throws IllegalTransition
  closeMission(id, outcome: MissionOutcome, reason: string): Mission
  createTask(input: {missionId, role, objective, dependsOn?, inputs?, requiredOutputs?, runnerHint?}): Task
  tasks(missionId): Task[];  transitionTask(id, to): Task
  readyTasks(missionId): Task[]                                 // queued, all dependsOn done
  startAttempt(input: {taskId, runnerId, sessionId?, worktree?}): Attempt   // task → running
  finishAttempt(id, result: {state: 'completed'|'failed'|'cancelled', exitCode?, signal?, timedOut?, costUsd: number|null, failure?, artifacts?: ArtifactRef[]}): Attempt
  attempt(id); attempts(taskId); attemptBySession(sessionId): Attempt | null
  recordArtifact(ref: ArtifactRef): void;  artifact(id): ArtifactRef | null
  createExperiment(input: Omit<Experiment,'id'|'executions'|'conclusion'|'createdAt'|'updatedAt'>): Experiment
  updateExperiment(id, patch: {executions?, conclusion?, limitations?}): Experiment
  experiments(missionId): Experiment[]
  recordDecision(input: Omit<Decision,'id'|'at'>): Decision;  decisions(missionId): Decision[]
  close(): void
}
```
Rules to test: illegal transitions throw and name both states; `finishAttempt` with exit 0
leaves the mission `running` and the task `done` — never closes a mission; `closeMission`
requires a reason; restart (close and reopen the store) returns identical ids and states;
`costUsd: null` round-trips as null; a mission for project A cannot attach a task whose
project differs (throws). Cross-project: two stores in two output dirs do not see each other.

### DL-02 — Agent telemetry (wave 1)
Owns: `engine/mission/events.ts`, `engine/mission/redact.ts`, `engine/swarm/capture.ts`,
`engine/swarm/normalize.ts`, `engine/test/telemetry.ts`. May edit `engine/swarm/adapters.ts`
**only** to add `onOutput?: (stream: 'stdout'|'stderr', chunk: string) => void` to `AgentRun`
and call it from `run()`.
```ts
class EventLog {                       // engine/mission/events.ts, same daylight.db
  constructor(outDir: string, now?)
  append(e: DaylightEventInput): DaylightEvent          // assigns id, sequence, schemaVersion
  since(sequence: number, filter?: {missionId?, attemptId?}, limit?): DaylightEvent[]
  forMission(missionId): DaylightEvent[]; forAttempt(attemptId): DaylightEvent[]
  ingestRunEvents(lines: RunEvent[], resolve: (session: string) => {missionId, taskId, attemptId} | null): number  // from events.jsonl
}
redact(text: string, secrets?: string[]): { text: string; redactions: number }   // engine/mission/redact.ts
  // env values ≥ 12 chars from *KEY*/*TOKEN*/*SECRET*/*PASSWORD* names, plus common token shapes (sk-…, ghp_…, AKIA…, Bearer …)
normalize(provider: 'claude'|'codex'|'grok'|'opencode'|'unknown', line: string): DaylightEventInput[]   // engine/swarm/normalize.ts
  // claude stream-json: assistant tool_use → tool.call; result → cost.reported + process.result; unknown lines → nothing (not an event)
captureRun(adapter, run: AgentRun, ctx: {store: MissionStore, events: EventLog, artifacts: ArtifactStore, attemptId, projectId, revision}): Promise<AgentResult>
  // engine/swarm/capture.ts: streams via onOutput; bounded in memory (last 2MB per stream, rest spilled to a temp file); on close writes stdout/stderr artifacts (redacted), emits process.start/process.exit, cost.reported (null when none), and attaches artifacts to the attempt via store.finishAttempt
```
Tests: two mock adapters run concurrently (a tiny `node -e` script that prints N lines with
delays) keep separate artifacts and separate event streams; a replay from `since(0)`
reconstructs the same per-attempt sequence; a secret in the env never reaches an artifact;
claude `stream-json` fixture lines normalise; garbage lines are dropped not thrown;
`costUsd` is `null` for a provider that printed no cost. Mock adapter must be labelled
`mock` in `runnerId`.

### DL-03 — Experiment runner (wave 1)
Owns: `engine/experiment/*`, `engine/test/experiment.ts`.
```ts
interface SandboxProfile { name: 'bwrap'; available: boolean; why?: string }
detectSandbox(): SandboxProfile                                 // engine/experiment/sandbox.ts
sandboxArgv(profile, {worktree, command, limits, env}): string[] // prlimit … bwrap … -- node …
checkAllowlist(command: string[], worktree: string): { ok: true } | { ok: false; why: string }
registerExperiment(input: {store, artifacts, missionId, projectId, baseRevision, subject, predicate, claimIds, hypothesis, prediction, testSource: string, testPath: string, command: string[]}): Experiment
  // writes test + expected artifacts, computes harnessDigest, store.createExperiment
runExperiment(experiment, ctx: {repoRoot, outDir, store, events, artifacts, runs?: number, timeoutMs?}): Promise<Experiment>
  // git worktree add --detach <tmp> <baseRevision commit>; copy test artifact to testPath, refusing if a different file is there; run N times (default 2); each run → execution artifact {command, sandbox argv, exitCode, signal, timedOut, durationMs, stdout/stderr refs, observed, matchesPrediction}; conclude; emits experiment.* events; always removes the worktree
concludeFrom(executions: ExecutionRecord[]): ExperimentConclusion
  // all valid & all match → supported; all valid & none match → falsified; valid but mixed → inconclusive (flaky); any denied/invalid-harness → invalid; all timed out → inconclusive
```
Tests, each with a real `node` run under bwrap when available and a forced
`available:false` path: known red, known green, flaky (a test that reads a counter file in
/tmp… no, /tmp is a fresh tmpfs per run — use `Date.now() % 2`-free determinism: flaky is
simulated by two registered runs with different predictions is NOT allowed; instead run a
test whose output depends on an env var the runner sets per run index), invalid harness (a
command not on the allowlist; a test path outside the worktree), timeout (a sleep longer
than `timeoutMs` → `inconclusive`, process actually killed), sandbox denied (`available:false`
→ `invalid`, nothing executed), tamper (worktree already has a different file at `testPath`
→ `invalid`), network (a test that tries `fetch('http://127.0.0.1:1')` fails inside bwrap
`--unshare-net`). Every execution's `harnessDigest` equals the experiment's.

### DL-04 — Scene controller (wave 1)
Owns: `app/renderer/lib/panels/Scene.tsx`, new `app/renderer/lib/scene/*`,
`engine/test/scene-lifecycle.ts`. Nothing else.
Extract the single 1,300-line effect into a `SceneController` (plain class, no React) with
`loadProjection(layoutInput)`, `setChannel(channel, flagged)`, `setSelection(id|null)`,
`updateAgentOverlay(event)`, `expandSymbols(set)`, `setLod`, `setMode`, `setMoved`, `dispose()`.
`Scene.tsx` builds it once per mount and calls methods from small effects. Hard rule: the
dependency array that creates the `WebGLRenderer` must not include `channel`, `flagged`,
`defended` or any belief/claim-derived value. Expose `window.__vdsScene = { renderers,
projections, recolors }` counters in dev/shot builds. Keep the pure decision of *what a change
requires* in `app/renderer/lib/scene/lifecycle.ts` with no three.js import so
`engine/test/scene-lifecycle.ts` can run it under node: `planUpdate(prev, next) →
'rebuild' | 'relayout' | 'recolor' | 'none'`. Acceptance: `pnpm shot` with
`VDS_SHOT_ASSERT='window.__vdsScene'` after a scripted channel change shows `renderers === 1`;
existing `engine/test/scene.ts` unchanged and green; drag, hover, pulse, flyers, labels, LOD,
tree/graph toggle still work (verify with the existing `VDS_SHOT_DRAG`/`VDS_SHOT_KEYS`
harness and say which you ran).

### DL-07a — Fixture (wave 1)
Owns: `fixtures/daylight-demo/**`, `engine/demo/fixture.ts`, `engine/test/fixture.ts`.
A small TypeScript library (session cache with TTL + a retrying client, ~6 files, no deps)
with **one planted defect** documented in `fixtures/daylight-demo/DEFECT.md`: `SessionCache.get`
refreshes `expiresAt` before checking it, so an expired session is served if read within one
TTL window of its expiry. A `node:test` file `test/session-cache.test.js` is red at the
planted commit. `materialiseFixture(dest)` copies the tree, `git init`s with fixed
identity and dates, commits, and returns `{root, commit, projectId}` — the commit sha must be
identical across runs and machines (test asserts the literal sha once measured). Every
README/DEFECT line says PLANTED. Also `fixtures/daylight-demo/review-prompts/` — the two
reviewer prompts a mission will send, so a recorded run is reproducible.

### DL-06 — Orchestration (wave 2, after 01/02/03)
Owns: `engine/mission/orchestrate.ts`, `engine/mission/report.ts`, new `cli.ts` cases
(`mission create|list|inspect|run|replay|decide`, `experiment propose|run`, `report`,
`demo prepare|run|replay`), `engine/mcp/server.ts` blind mode (ADR-6), `engine/test/orchestrate.ts`.
Flow: mission(explore, scope) → tasks: review×N (one per roster source, `runnerHint`), compare
(deterministic: `store.contradictions()` filtered to scope → disputes), experiment (per
dispute, from a registered hypothesis), decide (human). `run` drives review attempts via
`captureRun` with `VDS_BLIND_PREFIX`, then compare, then stops at the human checkpoint.
Outcome rules: any attempt failed/timed out → mission `blocked`, not failed; `closeMission`
only via `decide` or explicit `--close`. Report renders markdown with every artifact digest.

### DL-05 — Mission Control UI (wave 2, parallel with 06)
Owns: `app/main/main.cjs` (new IPC handlers only), `app/main/preload.cjs`,
`app/renderer/lib/types.ts` (additions), `app/renderer/lib/App.tsx` (one new view),
`app/renderer/lib/screens/Missions.tsx`, `app/renderer/lib/screens/MissionDetail.tsx`,
`app/renderer/lib/panels/Console.tsx`, `app/renderer/lib/panels/Evidence.tsx`, styles.
IPC (all shell out to the CLI; renderer never names a path or a command):
`vds:missions`, `vds:mission` {id}, `vds:mission-create`, `vds:mission-run` {id, tools},
`vds:mission-decide`, `vds:experiment-run` {id}, `vds:artifact` {id} (bounded, redacted text),
`vds:dl-events` {since} + push `vds:dl-event`. States rendered with text labels, never colour
alone: unknown, stale, contradicted, supported, falsified, confirmed, blocked, failed,
timed out, budget exhausted, sandbox unavailable. Selecting an experiment selects its
subject node on the map; selecting a node filters missions. Replay feeds `tool.call` events
into the existing replay bus as `RunEvent`s so the scene animates without a second renderer.

### DL-07b — QA, bench, demo (wave 3)
Owns: `engine/test/acceptance.ts`, `engine/bench/*`, `docs/daylight/DEMO.md`, README section,
`package.json` scripts. Runs the P0 acceptance checklist end to end on the fixture with the
mock adapter; measures cold/warm map time and the shot harness frame stats before and after
DL-04 on `./out` and on the 10k fixture if present; packaging smoke via `pnpm package`.

## Integration order

1. wave 0 contracts (done) → 2. DL-01, DL-02, DL-03, DL-04, DL-07a in parallel worktrees →
3. merge 01, 02, 03 → DL-06; merge 04 → DL-05 (parallel) → 4. DL-07b → 5. live recording run
on the fixture (needs owner authorisation: it spends money) → 6. report.
