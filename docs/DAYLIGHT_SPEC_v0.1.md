> **P0 record, kept verbatim.** It uses the pre-rename names (`vds`, `VDS_*`, `visual-desloppify`); the product is now Daylight Software Forge and the CLI is `daylight`.

# Daylight Software Factory
## Product and Engineering Specification — v0.1

**Status:** Proposed engineering spec; not a description of completed features  
**Prepared:** 2026-10-12  
**Starting codebase:** private `mackerson/visual-desloppify`, `main` as reviewed 2026-10-12  
**Primary goal:** An impressive, honest, repeatable demonstration for a prospective internal design partner during the two-week sprint ending around October 26, 2026.  
**Audience:** Owner, coding/review agents, design partners, and subsequent contributors.

> **Projects preserve knowledge. Missions pursue objectives. Tasks organize work. Agents execute attempts. Evidence determines outcomes. Humans govern authority.**

### Instructions to the development swarm

1. Treat **P0 / Demo** as the committed scope. **P1 / Product** and **P2 / Research** document the destination, not permission to implement everything now.
2. Extend the existing codebase **incrementally**. Preserve static detectors, the claim store, existing CI invariants, deterministic spatial layout, CLI integrations, and the read-only behavior of existing agent paths.
3. Do not silently change permissions, merge into shared branches, execute untrusted code without sandboxing, or call model consensus “proof.”
4. Each workstream must ship its own tests, measurable acceptance evidence, and a short architecture-decision note for any new dependency or cross-layer contract.
5. Before implementation, verify this document against current `README.md`, `DESIGN.md`, `TODO.md`, and the actual APIs; repository code wins on *current implementation facts*, this spec wins on *proposed product behavior*. Flag conflicts rather than guessing.
6. There must be a **deterministic prerecorded/fixture demo** as well as an optional live agent run. Never present staged or seeded results as an independently discovered production defect.

---

## 1. Product definition

**Daylight is a local-first verification and software-development workbench for human-supervised AI engineering.** It combines an inspectable code graph, independent model reviews, falsifiable behavioral claims, executable experiments, agent operations, and controlled implementation workflows. Its differentiator is not simply 3D code visualization: it is the linkage among code, intent, evidence, work, decisions, and observable execution.

**Daylight Insight** — discover, describe, contest, test, and verify software behavior. **Daylight Forge** — specify, author, repair, preview/launch, and validate changes with interchangeable agents. **Mission Control** — supervise both through missions, task attempts, logs, cost, approvals, and replay.

**North-star question:** How quickly can a human reach an evidence-backed engineering decision about software being developed by multiple autonomous agents?

**Product promises**
- Inspectability: “show me why” traverses real source, assertions, experiments, executions, and decisions.
- Independence: model agreement is not evidence, and a reviewer should not inherit another reviewer’s answer before producing its own assessment.
- Reproducibility: findings and changes are bound to repository revisions, environments, and artifacts.
- Safety and agency: humans authorize scope and privileged actions; missions may revise methods but may not silently expand authority or objectives.
- Scalability: exhaustive intelligence resides in the engine; the UI consumes bounded, reversible projections.

**Explicitly not promised:** mathematical proof of arbitrary programs; infallible AI reviewers; zero human supervision; support for all languages or all CLI providers in the demo.

## 2. Scope and delivery phases

### P0 — Two-week demonstration (must ship)

- Import an **existing local Git repository** and build the existing static/structural map.
- Create and open an **Exploration** or **Verification** Mission from Mission Control or a selected graph node.
- Run or replay two **independent** agent reviews that submit source-linked claims.
- Surface a genuine disagreement or deliberately labeled fixture disagreement in the queue and graph.
- Convert a disputed behavioral claim into a **testable hypothesis**; generate or load an executable experiment; run it in an isolated test environment.
- Show **result, logs, reproduction command, repository revision, and affected node** in one evidence pane. Permit human adjudication with rationale.
- Live mission/task/attempt activity with per-agent stdout/stderr, structured events where available, spend if reported, and clear “no events observed” states.
- Keep the existing 3D tree/graph, but avoid rebuilding the full WebGL scene for routine color/status changes.
- Provide a dependable guided demo, fixture data, smoke tests, and baseline performance measurements.

### P1 — Commercially testable product (next)

- Real authoring/repair missions: protected specification -> scoped author worktree -> independent test -> repair/escalation -> approved merge.
- New-project onboarding from human intent to versioned contracts and executable acceptance scenarios.
- CI/PR verification reports and gates; shareable evidence and mission exports; configurable team policy.
- Adaptive model routing, reliable per-provider telemetry, richer evaluation benchmarks, and polished installers.
- Queryable graph store and incremental derived projections for larger codebases.

### P2 — Research / optional extensions (later)

- Pluggable alternative spatial renderers, including a code-city or office simulation; optional WebXR/VR exploration.
- Dependency source deep-indexing on demand; polyglot parsers beyond the present TS/JS baseline.
- Formal specification and proof integrations; distributed/hosted missions, enterprise governance, organization-level collaboration.
- Experiment-driven model-routing optimization and large-scale program-synthesis workflows.

**P0 exclusions:** full autonomous deployment, broad cloud infrastructure, VR, real dependency full-source indexing, marketplace, enterprise auth, universal CLI parity, and any renderer rewrite without a measured reason.

## 3. Current architecture: preserve vs extend

The inspected `visual-desloppify` repository already has:
- `engine/extract/`, `detect/`, `focus/`: TypeScript/JavaScript extraction, deterministic duplicate/dead-code/architecture analysis, reversible levels of focus.
- `engine/graph/`, `scene/`: data types and deterministic tree/graph layout with hierarchical dependency routing.
- `engine/store/claims.ts` and `store/types.ts`: SQLite-backed provenance, evidence-at-ingest, and `UNKNOWN`, `INFERRED`, `CORROBORATED`, `CONTRADICTED`, `CONFIRMED`, `STALE` beliefs.
- `engine/swarm/`, `mcp/`: frontier scheduling, leases, cost controls, CLI adapters, MCP evidence boundary. Existing agent invocations remain **read-only**. Provider capabilities vary; a documented Codex/MCP read-only integration difficulty must not be “fixed” with unsafe bypass flags.
- `engine/invariants/`: architecture predicates and CI build gate.
- `engine/replay/`: activity event bus, timeline, and scene replay.
- `app/main/`: Electron orchestration and IPC; `app/renderer/`: React + Three.js, inspection/review/agent panels.
- Optimizations for a ~10,498-file, ~245,214-symbol, ~2M-line repository: precomputed `view.json` (~888 KB) instead of UI reparsing `graph.json` (~322 MB); symbol details fetched per file. Recorded render results include ~14,651 visible nodes at ~92–107 FPS on integrated GPU in that fixture. These are *repository-reported measurements*, not fresh independently reproduced benchmarks.

**Compatibility rule:** Retain original CLI commands and exported knowledge formats unless versioned migration is required. Add mission metadata alongside existing claims instead of overloading the claim-state enum.

## 4. Unified domain model and invariants

### Objects

**Project** — identity, repository locator, source-ownership policy, default branch, revisions, source and evidence namespaces, current projections. Never identify a project solely by repo-relative path.

**Specification / Requirement** — versioned normative statement of what should happen, with status (`draft`, `approved`, `superseded`), author/provenance, examples, constraints, and acceptance criteria. Distinct from inferred implementation behavior.

**Claim / Belief** — descriptive or predictive assertion about an existing revision with source provenance, precise code spans, and confidence. Preserve existing claim store statuses; `CONFIRMED` means human-adjudicated per the current implementation, **not formally proven**.

**Experiment** — hypothesis; claim IDs; test content/hash; harness/environment; protected expected result; execution records; validity/flakiness assessment; limitations; generated artifacts; affected revision(s). A passing experiment supports only what it actually tests.

**Evidence artifact** — immutable-ish content-addressed record of source snapshot, log, diff, test, trace, screenshot, metrics, human decision, or tool output. Store hash, provenance, timestamp, revision, and optional redaction metadata. A textual explanation without supporting artifacts is not a verified result.

**Mission** — durable user objective with project/revision, template, scope, policy/budget, plan, status, outcome, dependencies, acceptance gates, and the resulting evidence links. Mission = business/engineering unit of work.

**Task** — scoped unit within a mission with declared input artifacts, output contract, dependencies, and completion checks. **Attempt** — one execution by an agent, human, static tool, or deterministic runner; multiple attempts may address one task.

**Agent runtime** — reusable resource/adapter with identity, capabilities, provider/model, session, status, observed output and cost. An agent is not the owner of the mission, task, or truth.

**Decision / Approval** — typed event recording who authorized, rejected, deferred, or overrode a proposed operation and the exact scope and revision involved.

### Core invariants

- Requirements, claims, and observations live in **separate namespaces and UI treatments**. Reverse-engineered behavior never becomes a requirement without approval.
- All claims and test outcomes carry exact project and revision identity; stale context remains visible but cannot silently validate new code.
- **No agreement-to-proof promotion.** Multi-model agreement can corroborate; independent experiments can support/falsify; human acceptance records a decision, not a theorem.
- Disagreements are retained; an arbiter selects an investigation or reports insufficient evidence rather than deciding based only on persuasive prose.
- A nonzero exit code, expired budget, unavailable model, or aborted process is **not** mission success.
- Missions may change **methods** inside delegated scope; modifying objective, permissions, cost ceiling, publication boundary, or deployment target requires authorization.
- The visual layer contains no authoritative business rules; maps are projections with reversible elisions and stable referents.
- Existing read-only analysis paths must continue to operate without code-writing permissions.

### Suggested TypeScript contracts (adapt to existing modules)

```ts
type MissionKind = 'explore' | 'verify' | 'implement' | 'remediate' | 'audit';
type MissionState = 'draft' | 'ready' | 'running' | 'blocked' | 'closed';
type MissionOutcome = 'succeeded' | 'failed' | 'inconclusive' | 'cancelled';
type TaskState = 'queued' | 'leased' | 'running' | 'blocked' | 'done' | 'failed';

type ArtifactRef = {
  id: string;
  kind: 'source' | 'claim' | 'spec' | 'diff' | 'test' | 'log' | 'trace' | 'report' | 'decision';
  digest: string;
  projectId: string;
  revision?: string;
  path?: string;
};

interface Mission {
  id: string;
  projectId: string;
  parentId?: string;
  kind: MissionKind;
  objective: string;
  baseRevision: string;
  scope: { paths?: string[]; symbols?: string[]; claimIds?: number[] };
  permissions: { read: boolean; write: boolean; execute: boolean; deploy: boolean };
  budget: { maxUsd?: number; maxAttempts?: number; deadlineAt?: number };
  requirementIds: string[];
  acceptanceGateIds: string[];
  state: MissionState;
  outcome?: MissionOutcome;
  taskIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface Task {
  id: string;
  missionId: string;
  objective: string;
  dependsOn: string[];
  inputs: ArtifactRef[];
  requiredOutputs: ArtifactRef['kind'][];
  state: TaskState;
  attemptIds: string[];
}

interface Attempt {
  id: string;
  missionId: string;
  taskId: string;
  runnerId: string;
  sessionId?: string;
  worktree?: string;
  state: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  costUsd?: number; // unknown is not zero
  exitCode?: number | null;
  artifacts: ArtifactRef[];
}

interface Experiment {
  id: string;
  missionId: string;
  claimIds: number[];
  hypothesis: string;
  baseRevision: string;
  testArtifact: ArtifactRef;
  harnessDigest: string;
  executions: ArtifactRef[];
  conclusion: 'supported' | 'falsified' | 'inconclusive' | 'invalid';
  limitations: string[];
}

type DaylightEvent = {
  schemaVersion: 1;
  id: string;
  sequence: number; // monotonic per durable stream; wall clock alone is insufficient
  at: number;
  projectId: string;
  missionId?: string;
  taskId?: string;
  attemptId?: string;
  actorId?: string;
  category: 'lifecycle' | 'tool' | 'process' | 'claim' | 'experiment' | 'approval' | 'cost' | 'ui';
  name: string;
  artifactIds?: string[];
  payload: Record<string, unknown>;
};
```

**Implementation note:** This is a contract proposal, not a mandate to duplicate types already present. Preserve `engine/store/types.ts`; introduce mission, task, attempt, experiment, and event schemas in shared headless engine modules. Use explicit schema versions and migration tests.

## 5. Mission orchestration and collaboration

### Templates

| Template | Default capabilities | Artifact(s) | Success condition |
| --- | --- | --- | --- |
| Explore | read + deterministic analysis + model review | graph slices, claims, unknowns | scope explored and unresolved questions surfaced; not necessarily “no bugs” |
| Verify | read + isolated test execution | hypotheses, counterexamples, test results | specified experiments concluded or honestly marked inconclusive |
| Implement | scoped worktree write + test | proposed diff and validation report | required acceptance gates pass; merge is separately authorized |
| Remediate | scoped worktree write + test | regression test, patch, before/after evidence | original failure no longer reproduces under stated conditions |
| Audit | read, export | signed/hash-linked report | findings and evidence lineage export successfully |

### Planner and execution rules

1. Create mission objective, scope, source revision, authority, budget, and acceptance gates **before** agent scheduling.
2. Build a task DAG with explicit input/output contracts. Tasks can be retried without losing history; leases prevent duplicate active attempts.
3. Scheduler chooses a capable runner based on role, cost and availability, not a permanent “team” assigned to the mission. Allow human or deterministic tools.
4. Independent reviewers initially receive the same bounded context **without each other’s conclusions**. Once submitted, compare claims, evidence spans and confidence; investigate disagreement. Unanimity without independent checks is not closure.
5. A challenger tries to falsify a significant claim; generate experimental candidates, select reproducible ones, run in isolation, evaluate validity, then link evidence to claims.
6. New missions may be **proposed** automatically but cannot inherit expanded write/execute/deploy powers by implication.
7. A mission is complete only when its acceptance gates and artifact checks are evaluated; partial completion and unknowns must be surfaced.
8. Agent crashes, provider changes, context exhaustion or retries replace attempts, not missions. Durable state resumes after restart.

### Mission state vs outcome

State: `draft` -> `ready` -> `running` <-> `blocked` -> `closed` (with allowed cancellation). Outcome recorded separately: `succeeded`, `failed`, `inconclusive`, `cancelled`.

**Human checkpoints:** approving inferred requirements, accepting nontrivial specification interpretations, expanding privileges or budget, approving a patch, merging, starting an external-facing preview, deployment, and publishing or sharing data.

## 6. Verification engine and adversarial specification loop

The verification engine's purpose is to detect the difference between **specified**, **observed**, **assumed**, and **unverified** behavior.

**Loop:** discover -> independently assert -> compare -> identify uncertainty -> propose falsification -> run experiment -> judge evidence quality -> human/automatic bounded resolution -> improve spec/tests/code -> revalidate.

Requirements must be **falsifiable where practical**, with concrete examples and negative cases. A precise requirement may be impossible to implement, and a passing safety invariant may still permit useless behavior; do not assume that a formal-looking spec is complete. Track liveness/progress requirements where applicable.

**Disagreement classes:** (a) opposite claims on same evidence, (b) different evidence subsets, (c) incompatible specification interpretations, (d) environmental discrepancy, (e) unsupported model confidence, (f) genuinely equivalent but differently phrased narrative. Each class has an explicit next action; do not treat all textual differences as contradictions.

**Experiment requirements:** hypothesis, input scenario, environment, expected observation, actual observation, reproducible command, stdout/stderr and traces, revision and hashes, failure classification, flakiness check where feasible. Preserve both passing and failing observations; report untested assumptions.

**Adversarial specification testing:** challenge the spec by seeking implementations or inputs that formally satisfy its literal text yet violate plausible human intent. Report ambiguity and proposed clarification rather than altering accepted requirements autonomously. Use mutation/seeded-defect suites to assess verification power.

**Independent test authority:** coding authors must not be able to modify or suppress the verifier's protected acceptance criteria. Public development tests may be shared; holdout checks, baselines and evaluation policy are protected by a separate runner or workspace.

**P0 executable experiment:** support a tightly bounded trusted fixture using an allowlisted command inside a disposable worktree/sandbox with timeout, resource ceiling and captured output. Do **not** advertise untrusted arbitrary code execution until isolation is demonstrated. P1 may generalize to project tests with stronger container/VM isolation.

## 7. Forge: authoring and launch workflows

**Existing repository entrance (P0):** choose path -> map/diagnostics -> provisional inferred claims -> Mission Control -> mission -> evidence and optionally a proposal. Do not automatically label inferred intent as approved.

**New project entrance (P1):** describe intended users, behavior and constraints -> generate competing interpretations and counterexamples -> human resolves material ambiguities -> approve initial requirements/tests -> implement -> independently verify -> preview/launch. P0 can show this as disabled/coming soon; never pretend it functions.

**Authoring (P1):** strong reviewer/architect agents produce an approved scoped task packet; a smaller/local author model may generate the diff; independent verifier tests it; bounded repairs or escalation occur. Routing compares *total expected cost* (planning + authoring + verification + repairs/escalation), not token price alone.

**Isolation:** each writing attempt gets its own worktree, scoped filesystem permissions, controlled tool permissions and network policy. Reviewers have read-only access and cannot mutate the author output. Run generated programs with safe sandbox defaults; surface irreversible or external side effects for human approval.

**Preview / launch:** distinguish local build, local ephemeral preview, approved remote preview, merge, and production deployment. Each has its own permission and audit event; there is no single ambiguous “Run” button that secretly publishes code. P0 may provide local demo fixture execution; production deployment is out of scope.

## 8. Daylight UX and information architecture

### Entry and navigation

Landing screen: **Open repository** or **Start project** (P1 if not available). A recent-projects section follows. After opening a project, **Mission Control is the home view**; the code graph is a persistent navigable work surface, not a substitute for a work queue.

Three primary user verbs: **Understand**, **Investigate**, **Build**. Internally, they map to mission templates. Current `Map`, `Explore`, `Focus`, and `Rebuild` actions remain available in developer/advanced controls during migration but are not the primary novice navigation.

### Main workbench layout

- **Top bar:** project/revision, active mission, status, cost/time, safe pause/stop.
- **Left rail:** missions, queued investigations, human decisions required, filters and search.
- **Center:** existing deterministic 3D code graph, tree or dependency mode, semantic LOD, bundled edges; selection and camera state persist where practical.
- **Right inspector:** selected code symbol, normative requirements, descriptive claims, evidence, conflicting interpretations, experiment controls and result links.
- **Bottom drawer:** selected task/agent session, structured events, raw or sanitized CLI output, tests, diffs and timeline/replay.

### Interaction contracts

- Selecting a graph node filters related missions/claims/attempts; selecting a mission highlights affected graph nodes. Bidirectional navigation retains the referent/revision.
- “Show me why” traverses from any visible status to actual evidence, never merely a synthetic AI explanation.
- Render **unknown, stale, contradicted, supported, and human-confirmed** states distinctly with accessible textual labels; no color-only semantics.
- Mission-centric question views may dim irrelevant modules and overlay dependency/data-flow paths without rearranging the user's saved spatial map by default; alternative layouts must be explicit, reversible projections.
- Agent avatars/markers represent **last observed attention**, not a claim about what the model is internally thinking. Quiet stdout/MCP activity means “no recent observed events,” not “idle.”
- Error, permission denial, invalid experiment, and budget exhaustion are first-class visible states. UI cannot imply success from a clean-looking animation.
- Keep keyboard navigation, searchable node list, flat evidence/table view, and readable inspector. The 3D map is powerful but never compulsory.

### Visualization plugins

Provide a renderer-neutral **projection/selection interface**, not plugins that mutate claim state. Built-in default: present tree/graph layouts. Later: code-city, office metaphor, timeline, VR/WebXR. Each renderer consumes stable object IDs, relationships, projection metadata, selection and overlay state; invokes typed navigation/actions through a controlled host API. Three.js specifics remain within current renderer.

### Scene refactor (P0)

`app/renderer/lib/panels/Scene.tsx` currently owns a large React effect creating renderer, camera, meshes, geometry, event handlers, and animation loop. Its dependencies include view channel and other frequently updated state; changing a channel can recreate the entire scene. Extract a persistent controller/host with separate methods for `loadProjection`, `updateNodeStatuses`, `setSelection`, `updateAgentOverlay`, `expandSymbols`, `setCamera`, `dispose`. Keep React in charge of controls and accessibility, Three.js in charge of rendering. Maintain deterministic layout, semantic LOD, and drag overrides; add tests proving status changes do not remount the WebGL renderer.

**Do not** replace the graph with a code city, generic force layout, or novelty office; keep those as future plugins.

## 9. Agent observability and event ledger

Current MCP `events.jsonl` observes tool calls through the Daylight boundary, but it does not observe every operation performed through an agent's own CLI tools. The Electron `vds:job-output` stream currently exposes wrapper process output, while adapter subprocess output is accumulated internally in `engine/swarm/adapters.ts`. P0 should expose the meaningful agent subprocess stream, with timestamps and correlation IDs, to Mission Control.

**Capture:** structured provider events/JSONL where supported; stdout/stderr with provenance and bounds; normalized task/tool execution when present; optional PTY for interactive providers in P1. Never imply access to hidden private model reasoning. Record process launch/exit, session ID, provider/model, task, files accessed when observable, command, cost/usage when available, error, duration, and output references.

**Event reliability:** durable append-only log with schema version and stable event ID/sequence; persist before delivery to UI; tolerate duplicates/out-of-order provider timestamps; bound memory and rotate bulky outputs into artifacts; scrub secrets and sensitive environment values before display/export. Resume/replay must reconstruct mission state and per-attempt activity, not merely animate agents. Any “live” feed is a projection of the event store.

**Collaboration:** model-to-model communication should use structured task artifacts and cited claim references; independent blind review precedes discussion to reduce convergence on shared mistakes. Free chat can be a complementary view but is not the source of truth. Agent operations UI shows individual activity, current scope, pending checks, cost and console, with ability to jump directly to the relevant code and evidence.

## 10. Performance, dependencies and storage

### Principle

Render **projections**, not the whole codebase. UI performance depends on the scene projection and live update rate, not directly on LOC. Exhaustive graph storage and evidence history must scale separately.

### Preserve now

- `graph.json` exhaustive L0 remains a working artifact in P0; `view.json` is used for UI, with on-demand per-file symbol loading.
- Respect `.gitignore`, generated directory exclusions and vendored/minified bundle protection.
- Keep content-addressed per-file parse cache, stable/deterministic layout, batched `InstancedMesh`, edge bundling and label budgets.
- Report actual GPU, p95 frame time, node/draw count and other observed values, not guessed capabilities.

### Growth plan (P1)

- Move large graph adjacency/symbol queries toward indexed SQLite or equivalent with revision-scoped records, materialized summaries, and paged subgraph queries. Do not introduce a separate graph database without evidence of need.
- Make change propagation incremental: parse changed files -> update affected references/claims -> invalidate derived summaries -> refresh only affected projections; avoid wholesale JSON parse and scene rebuild in the live path.
- External dependencies have progressive levels: **A** package/import boundary (default); **B** declarations/exported interfaces (on demand); **C** source implementation at a pinned version (explicit deep inspection). Never eagerly index `node_modules` just to make the graph more impressive.
- Bound per-frame picking, labels, edge updates, pulse/agent overlays, event retention, and query latency. Handle high-degree nodes and huge fan-out safely.
- Store performance baselines per fixture/hardware; no absolute speed assertion without a tested machine and methodology.

### P0 measurable guardrails (targets, not existing results)

- Existing 10k-file fixture remains usable with responsive selection and camera control; no regression from baseline p95 frame times without explanation.
- Routine claim/overlay/color updates do not recreate the renderer; no full `graph.json` transfer to UI on routine refresh.
- Incremental edit -> visible affected status follows existing watch semantics and is measured end to end.
- UI can handle several concurrent agent event streams without unbounded in-memory growth or losing correlation IDs.
- Results are reported with FPS/p95 frame time, peak RAM, cold and warm scan times, time to first useful view, number of displayed elements, and measured environment.

### Benchmark suite

Use real 10k-file repository fixture plus synthetic scale datasets at 10k/50k/100k/250k files, variable symbols per file (10/25/50), varying dependency density (4/8/20 relations per file), deep hierarchies and high-degree hubs. Synthetic data tests graph/renderer capacity; real repositories validate extraction semantics. Exercise simultaneous indexing, live event ingestion, selection, mission filtering, and periodic file edits. Record degradation points and graceful fallback; don't claim 100k-repo support from rendering only.

## 11. Trust, security and data governance

- Default is local-first: source and evidence stay on the machine unless explicitly shared.
- Read-only agent paths stay read-only. Authoring runs are disposable and permission-scoped. A provider integration that requires broad unsafe sandbox bypass is marked unavailable; no silent downgrade.
- All generated test/code execution is untrusted; use isolated worktrees plus OS/container/VM execution restrictions as appropriate. Worktree alone is **not** an execution sandbox.
- Secrets in env, source, tool output, and logs must be redacted at export/display boundaries; do not send repositories to external models without informed approval and provider configuration.
- Separate reviewer/verifier control plane from author-controlled workspaces and test result manipulation.
- Sign or hash-link artifact provenance where practical; record human decisions, approval scope and revisions. Approvals are revocable for future actions, not retroactive deletion of history.
- Protect project identity: never apply a claim from Project A to a same-path file in Project B; preserve current repo isolation regression test.
- Respect contractual employer IP, repository security and authorized pilot permissions. A workplace pilot requires agreement on ownership and what third-party models may receive.

## 12. API/CLI extension seams

Prefer additive headless engine services. Proposed CLI commands, exact syntax subject to implementation:

```bash
vds mission create --repo <repo> --kind explore --objective '<question>'
vds mission list --repo <repo>
vds mission run <mission-id> --max-cost <usd>
vds mission inspect <mission-id> --format json
vds mission replay <mission-id>
vds experiment run <experiment-id> --sandbox <profile>
vds report <mission-id> --format markdown
```

Proposed IPC/service operations: `project.open`, `mission.create/list/read/start/block/close`, `task.list/retry`, `attempt.start/stop/events`, `experiment.propose/execute/result`, `evidence.get`, `graph.projection`, `graph.neighborhood`, `ui.select`, `approval.request/decide`.

Version and validate event and IPC schemas with Zod or existing schema conventions; reconcile with current preload security boundary. Do not let the renderer execute arbitrary shell commands or directly open unrestricted paths.

## 13. Demonstration and acceptance tests

### Demo story: “A disagreeing pair of reviewers uncovers a behavioral defect”

1. User selects a reproducible **fixture repository**, with a real, planted authentication/cache or transaction retry defect clearly identified in fixture documentation.
2. Daylight displays the existing deterministic graph. User starts an **Explore** mission.
3. Two independent models (or a saved replay of their actual runs) submit opposing, source-linked verdicts. Daylight highlights the disagreement and evidence discrepancy.
4. User opens the investigation, approves or selects a specific test hypothesis; a bounded trusted sandbox test executes and produces actual output.
5. Evidence pane links failing test, command, expected/observed behavior, code location and revision. User makes or defers a decision; status and rationale persist.
6. Optional **Forge preview**: demonstrate a *proposed* scoped patch or an approved pre-recorded patch and subsequent verification. Never imply unimplemented automatic authoring exists.
7. Replay can show the same sequence on a fresh laptop without reliance on live model responses or external secrets.

### P0 required automated acceptance cases

- Mission create/read/restart: stable mission, task and attempt IDs survive restart and replay.
- Run status separation: process exit 0 alone never closes a mission as success; failed tests, timed out experiments and budget exhaustion appear correctly.
- Cross-project isolation: same relative path cannot associate evidence with the wrong repository.
- Claim provenance: missing evidence rejected at ingress; contradictory claims persist; existing claim enum semantics unchanged.
- Blind review: reviewer B's initial input excludes reviewer A's conclusions.
- Experiment: known passing, known failing, flaky/inconclusive, invalid harness, timeout, sandbox permission denied; collect logs/hashes and mark conclusion honestly.
- Authorization: read-only reviewer cannot modify source; author cannot modify protected acceptance gate; expanded permission requests are blocked until approved.
- Stream/replay: two simultaneous agent attempts keep output separate; restart and replay reproduce state; missing provider telemetry shown as unknown.
- Scene stability: changing claim colors, selection, mission overlay, or agent activity does not destroy/recreate the renderer; project switch does.
- Projection correctness: no phantom nodes, wrong edge targets, or hidden evidence through irreversible summarization.
- Performance: benchmark records machine/GPU, cold/warm index timing, peak memory, p95 frame time and selected scenario size.

### Demo release gate

A demo is ready only if: cold-start setup works; all relevant tests pass; one real falsifiable disagreement can be viewed/replayed; experiment results are reproducible; read-only rights are respected; a failure state can be shown without a crash; UI remains responsive during activity; output can be explained to a technical manager in under five minutes.

## 14. Two-week sprint implementation plan

**Parallelization rule:** assign file ownership and shared API contracts before multiple agents edit; each independently testable workstream should use its own branch/worktree. Merge only after typecheck, the existing `pnpm test:all`, and the new relevant regression suite. No one works directly against a shared test fixture without coordination.

| Time | Workstream | Key deliverable | Dependency |
| --- | --- | --- | --- |
| Days 1–2 | Contracts / Mission core | headless mission/task/attempt persistence, schema, state transition tests | none |
| Days 1–2 | Fixture / verification design | documented planted defect; reproducible baseline test and honest demo script | none |
| Days 2–5 | Agent telemetry | structured event normalization, per-attempt stdout/stderr, correlation, replay tests | mission IDs |
| Days 3–6 | Scene lifecycle | persistent `SceneController`, incremental color/selection/agent updates | shared projection contract |
| Days 4–7 | Experiment runner | constrained trusted-fixture test harness, evidence artifacts and results | mission/evidence IDs, fixture |
| Days 5–9 | Mission Control UI | mission list/detail, work queue, evidence inspector, consoles, code links | mission/event contracts |
| Days 8–10 | Integrated review flow | independent review -> disagreement -> experiment -> decision | above |
| Days 10–12 | QA + performance | existing suite, new e2e, 10k fixture stress test, failure recovery | integrated build |
| Days 12–14 | Demo polish | repeatable guided demo, replay fallback, setup docs, packaging smoke test | release candidate |

**P0 minimum cut if behind:** preserve existing graph; add mission envelope, replayable two-model disagreement, one executable counterexample with real logs, and source-linked evidence inspector. Defer new authoring, structural UI redesign beyond necessary navigation, advanced renderer plugin APIs, and all dependency deep scans.

### Swarm-ready issue packets

**DL-01 — Mission domain & persistence:** deliver typed contracts, SQLite tables/migrations, project/revision isolation, state machine and tests. Acceptance: restart preserves mission/task/attempt and no process exit is mistaken for outcome.

**DL-02 — Agent activity normalization:** wrap current adapter subprocess streams, normalize best-effort provider events, label unknowns, make event IDs stable, preserve per-session correlation. Acceptance: two concurrent mocked adapters are independently inspectable and replayable without leaking logs across sessions.

**DL-03 — Experiment/evidence service:** implement trusted fixture command runner with timeout, resource policies, hashes, transcript, expected-vs-actual and validity. Acceptance: deterministic red/green/inconclusive/invalid test fixtures with protected acceptance artifacts.

**DL-04 — Scene Controller separation:** extract renderer lifecycle and incremental updates; preserve current spatial semantics. Acceptance: channel change and live claim events do not create a new WebGL context; existing scene tests and performance guardrail pass.

**DL-05 — Mission Control UX:** navigation, mission detail, active attempts, console/evidence inspector, interactive graph synchronization; readable keyboard alternative. Acceptance: click claim -> affected symbol and click agent -> observed activity and associated work.

**DL-06 — Orchestration & challenge flow:** connect independent review tasks, contradictory claims, test proposal/run and adjudication, with approvals. Acceptance: fixture demonstration traverses states without manual database editing or invented model decisions.

**DL-07 — Release/evaluation:** integration tests, benchmark harness, scripted replay, demo packaging and concise operator guide. Acceptance: clean-machine run and manager-facing demonstration verified against acceptance checklist.

## 15. Metrics and learning agenda

**Product outcome measures:** human time to adjudicate a contested behavior, cost per verified finding, independently reproduced defect precision, recall on seeded/mutated defect sets, time from agent edit to legible map, review/verification completion rate, re-opened defects, mission success after independent acceptance, and usage per active team.

**Technical measures:** test execution time, model inference/API cost (unknown not zero), author retries, event ingestion lag, dropped/uncorrelated events, memory peak, UI time to first useful view, p95 frame time, incremental index latency and reproducibility rate.

**P1 pilot hypotheses (not validated facts):** small engineering teams using several coding agents will pay for cross-provider independent verification and human review reduction. Test Insight-only value before assuming Forge has higher willingness to pay. Initial business direction: open-source useful local engine, paid team policy/coordination/reporting; defer license/tier finalization pending customer conversations and employment/IP review. Do not build billing in P0.

## 16. Decisions and open questions

**Decided for now:** mission as primary work unit; agents interchangeable; evidence as first-class durable graph; P0 existing-repository first; current 3D tree/graph retained; pluggable visualizations later; independent verifier separated from author; local-first; worktree + actual sandbox for executable work; no unsafe provider bypass; bounded scope and human authority.

**Needs owner decision, not silent agent assumption:**
- Which existing repository or sanitized fixture can be demonstrated and shared with an employer/prospects?
- What specific sandbox technology and trusted command allowlist are acceptable on development hardware?
- Which CLI providers are actually usable in read-only MCP mode on current installed versions? Keep disabled providers visible as unsupported.
- Which interactions most need redesign after quick paper sketches: mission list, claim investigator, agent console or graph navigation?
- What exact approval steps govern authoring, test execution, previews and merge in the first paid pilot?
- Whether to brand/rename the repository as Daylight before or after the external product demo.

## 17. Risks and failure policies

**Shared-model blind spots:** use diverse model reviews and independent execution; never claim consensus implies correctness.  
**Spec incompleteness:** show unknowns, contradictory interpretations, liveness gaps and human checkpoints.  
**False positives / false evidence:** anchored spans, versioned tests, robust harness validation and seeded-defect calibration.  
**Agent reward hacking:** acceptance suite outside author-controlled worktrees; no test modification privilege.  
**UI performance debt:** incremental scene updates, bounded overlays, projection-based retrieval; measure before architecture migration.  
**Massive graph/evidence growth:** selective indexing, SQLite indexes, revision-scoped materialized views, artifact retention, paged queries.  
**Autonomous cost explosion:** budget, deadline, retry and child-mission limits; explicit approval to expand.  
**Data/IP leakage:** default local, permissions, secret redaction, explicit model-provider consent.  
**Demo theater:** label fixtures and replays clearly, never fake evidence or measured KPIs.

---

## Final acceptance statement

The **P0 Daylight demonstration** is successful when a human can open a real codebase, see an independently generated conflict about its behavior, inspect what each agent actually observed, run a bounded experiment, inspect reproducible evidence in context of the 3D code graph, make a traceable decision, and replay the sequence—without giving untrusted authoring agents uncontrolled access to the project.

The **long-term Daylight product** extends that same loop through implementation, verification, preview and controlled delivery without hiding the work from the human supervising it.
