# visual-desloppify — design

**Working premise:** an Electron app that extracts everything a codebase contains, then drives a
swarm of coding agents to **focus that down** to a small map that is actually true — and keeps
checking it stays true. Static analysis is the bootstrap, not the source of truth. The human
arbitrates.

> Get all the data, then focus it down.

## Why

We ran this playbook by hand: a swarm of Sonnet agents over a codebase, progressively building and
refining a Mermaid diagram. It worked — it surfaced several data structures that were near-identical
but for a few fields, and a whole section of the app that could collapse into one stronger system.

Those two findings are the target output. They are not dependency-graph findings; they are
*similarity* findings. The design has to produce them on purpose, not by luck.

What the manual run lacked: persistence, provenance, incrementality, and a view that scales past what
Mermaid can lay out. That's what this is.

### Focusing is the target activity

The hand-authored artifact that came out of the manual run closes with a line aimed squarely at this
project:

> Diagram topology stays hand-authored; it encodes intent, not import graphs.

and, in its own maintenance rules: *"Prefer fewer nodes; constants belong in notes or code, never in
boxes"*, and *"deliberately **not** a full service map."*

Read as a warning, that says an exhaustive generated map is worth less than a hand-drawn one. Read as
a guide, it says something more useful: **that map had to be focused before it was correct.** The
resolution wasn't reduced for readability after the fact — reduction is what made it true. Intent is
only visible at the right altitude.

So the product's core loop is not extract → visualise → plan. It is:

> **Get all the data, then focus it down.**

Consequences that shape everything below:

- **Completeness and correctness are different axes, and they trade off.** The exhaustive graph is
  maximally complete and barely true — it asserts that 570 files and 40k edges are all equally real,
  which is false. The focused map is lossy and correct. Neither replaces the other; the tool's job is
  to hold both and move between them.
- **Focusing is a recorded operation, not a view setting.** Every collapse is an artifact: what was
  elided, into what, on whose authority, with what evidence. A focused map that can't be expanded
  back to its members is indistinguishable from a lie.
- **The agents' primary job is focus, not decoration.** "What collapses into what, and what is
  load-bearing enough to survive?" is the expensive judgment. Topology is the cheap half and static
  analysis already has it.
- **Cluster names and purposes come from agents**, not from directory names. A folder name is a
  filing decision; a purpose is an intent claim and needs evidence like any other.

### The referent rule

> **Nothing is shown unless it resolves to members. No node, edge, level or status may
> exist on screen without a path back to spans in files.**

This has been violated three times, in three different layers, and each time it produced
something that looked like a finding and wasn't:

| Incident | What was asserted | What backed it |
| --- | --- | --- |
| Phantom subsystems | an elision named `AgentTurnService.ts` sat in the architecture view as a peer of *Plugin Sandbox* | nothing — an unresolved elision target invented a bucket |
| Fixture invariants | five RED invariants on every repo analysed | nothing — they were claims about *enclave*, compiled into the tool |
| The fake trunk and phantom strata | a nexus every subsystem converged on, and three levels of depth | nothing — a hardcoded vertex at `(0,-30,0)`, and one partition drawn three times |

The failure mode is always the same and it is specific to this product: a tool whose
output is a *picture of what is true* fails silently, because a confident-looking artifact
is indistinguishable from a real one until someone asks "what is that?" No exception
throws. No test goes red. The map just quietly lies.

So the rule is enforced structurally rather than by review:

- Every renderable node carries a non-optional `members` array. A node that cannot
  enumerate its members cannot be constructed.
- Decoration that implies data is forbidden. If the tree wants a trunk, the trunk is the
  repo root — labelled, clickable, with every file as its members — not a vertex chosen to
  make the layout look settled.
- Derived structure must be *derived*. Levels are compared by their partition signature;
  identical partitions are one map rendered once, not three altitudes implying depth the
  data does not have.
- Anything refused is reported, never dropped: rejected elisions, skipped vendored
  bundles, legacy claims that no longer pass. Silence reads as "nothing to see".

The same instinct drives the evidence requirement on claims and the `UNPROVEN` status for
a repo with no invariants. **Absence must look like absence.**

## The focus stack

Not one map — a stack of maps, each valid and defensible at its own altitude.

```
L0  exhaustive    every symbol, every edge          machine-truth, never rendered whole
L1  module        files and modules                 the working map
L2  subsystem     agent-named clusters + purposes   where intent starts
L3  architecture  ~10 nodes + invariants            the thing worth hand-drawing
```

Each level is derived from the one below by recorded elisions. Moving up is `focus`; moving down is
`expand`. Every node at L1–L3 carries its member set, so any claim at any altitude resolves to spans
in files.

**Correctness is asserted at the top and checked from the bottom.** An L3 map ships with
**invariants** — the load-bearing facts that make it true. The prior manual artifact wrote them by
hand:

> *"Startup order is load-bearing"* · *"The EventBus is storage-only — nothing on it starts a turn"* ·
> *"Streaming has one consumer"* · *"`ai.ts` never persists."*

and then wrote the obligation nobody honors: *"If a code change breaks one, the diagrams above are
wrong and this page must be updated."*

That obligation is automatable, because **an invariant is a query against L0.** "Nothing on the bus
starts a turn" is a reachability assertion. "Streaming has one consumer" is a fan-in count. "`ai.ts`
never persists" is a forbidden-edge rule. So:

- Invariants are authored (by human or agent) as graph queries, in natural language with a compiled
  form attached and its evidence.
- They re-run on every extraction pass.
- When one goes false, the focused map above it is marked **STALE** with the specific violating edge,
  not a vague "may be out of date."

This is the thing hand-maintenance structurally cannot do, and it's the answer to why a generated
tool should exist next to a hand-drawn diagram: **we don't out-draw the human map, we keep it
honest.**

## Decisions locked

| Question | Decision |
| --- | --- |
| Agent integration | MCP data plane + headless process control plane |
| Conflicting claims | Provenance + contradiction surfacing, human arbiter |
| Exploration order | Uncertainty × centrality priority queue |
| Static depth | tree-sitter skeleton + wrap existing detectors |
| Stack | TypeScript everywhere |
| Persistence | Committed confirmed layer + local raw traces |
| v1 scope | TS/JS first, polyglot-ready schema |
| Write scope | Read-only map + target-diff plan |
| Shell | Electron desktop app, three.js for the main view |

## Architecture

```
┌─ Electron main / utility process ──────────────────────┐
│                                                        │
│  Extractors ──► Graph store (SQLite) ◄── Claim ingest   │
│  (tree-sitter,      │                         ▲        │
│   knip, dep-cruiser)│                         │        │
│                     ▼                         │        │
│  Analyzers ──► derived signals          MCP server      │
│  (SCC, centrality, similarity,          (stdio)         │
│   community detection)                        ▲        │
│                     │                         │        │
│                     ▼                         │        │
│  Frontier scheduler ──► Agent driver ──► claude/codex/  │
│                         (spawn, budget)  grok/opencode  │
└───────────────────┬────────────────────────────────────┘
                    │ IPC (snapshots + deltas)
┌───────────────────▼────────────────────────────────────┐
│ Renderer: three.js scene + 2D panels                   │
└────────────────────────────────────────────────────────┘
```

Agents get the graph through MCP and the repo through their own read-only file tools. The **only**
write path out of an agent is a claim submitted to the MCP server. Agents never write code and never
write the graph directly.

## Data model

The graph is nodes and edges; everything interesting hangs off them as **claims**.

```ts
type NodeId = string;            // stable identity, see Open problems

interface Node {
  id: NodeId;
  kind: 'dir' | 'file' | 'module' | 'symbol' | 'type';
  path: string;
  name: string;
  span?: [number, number];
  contentHash: string;           // invalidation key
}

interface Edge {
  id: string;
  from: NodeId;
  to: NodeId;
  kind: 'imports' | 'calls' | 'references' | 'extends' | 'implements' | 'instantiates';
}

interface Claim<T = unknown> {
  subject: NodeId | EdgeId;
  predicate: string;             // 'is_dead' | 'purpose' | 'duplicates' | 'layer' | ...
  value: T;
  source: SourceRef;             // { kind: 'static', tool: 'knip' } | { kind: 'agent', cli, model, sessionId } | { kind: 'human' }
  confidence: number;            // 0..1
  evidence: Evidence[];          // file:line spans, or a reasoning trace — REQUIRED
  observedHash: string;          // contentHash at claim time; stale if it drifts
  at: number;
}
```

Derived per subject+predicate:

```
status = UNKNOWN | INFERRED | CORROBORATED | CONTRADICTED | CONFIRMED | STALE
```

Rules:

- **No evidence, no claim.** An agent assertion without a citable span or an explicit reasoning
  trace is rejected at the MCP boundary. This is the single guard against a confabulated map.
- Agreement across independent sources raises confidence; it does not erase the individual claims.
- Disagreement is preserved as `CONTRADICTED` and queued for the human. It is never auto-resolved.
- `CONFIRMED` is only ever set by a human.
- A claim whose `observedHash` no longer matches goes `STALE` and re-enters the frontier.

Contradictions are the highest-value screen in the app, not an error state:

```
edge: auth/session → legacy/tokens          status: CONTRADICTED ⚠
  ├─ tree-sitter : exists (0.9)  src/auth/session.ts:42
  ├─ claude-code : DEAD   (0.8)  "only ref is a commented-out block"
  └─ codex       : LIVE   (0.7)  "reached via plugin registry string key"
```

## Findings taxonomy

What the app exists to surface. Ordered by how much the prior manual run suggests they matter.

### 1. Duplication families — the headline

Five cheap, fully deterministic detectors. None needs an LLM to *find* anything; agents only
adjudicate.

| # | Detector | Signature | Catches |
| --- | --- | --- | --- |
| D1 | Structure shape | set of `(fieldName, normalizedType)` over interfaces / type aliases / classes / schemas | "same but for a few fields" — the original manual finding |
| D2 | Duplicate function names | exact + case/separator-normalized name index | copy-paste families, and genuine convention collisions |
| D3 | Duplicate signatures | name-agnostic: arity + normalized param types + return type | the same function written four times under four names |
| D4 | Repeated code blocks | token-stream MinHash / winnowing over bodies | copy-paste that drifted enough to hide from D2/D3 |
| D5 | Near-duplicate purpose | embeddings over agent-written module summaries | semantically redundant subsystems with no textual overlap |

### Corrections the build forced on this design

Three, all found by running it rather than by reading it:

1. **Family clustering over-merged** (P0). Union-find on any detector link took transitive closure
   through common signatures and welded 107 unrelated symbols into one "family". Qualification is
   now D1-alone or D2+D3-together.
2. **Elisions could conjure phantom subsystems** (P3). An elision whose `into` target did not resolve
   to a real cluster silently created a bucket named after it — which is how `AgentTurnService.ts`
   appeared as a peer of *Plugin Sandbox* in the architecture view. Unresolvable targets are now
   rejected and reported, never applied.
3. **The belief calculus had exactly the wrong sensitivity** (P4). Comparing claim values by equality
   made every pair of prose `purpose` claims a contradiction, while a real disagreement expressed as
   `duplicates` vs `not_duplicates` was never compared at all, because the predicate names differed.
   Loud false contradictions, silent real ones. Now: narrative predicates corroborate instead of
   contradicting, verdict predicates are normalised onto a canonical polarity, and — because an agent
   will otherwise send `duplicates` with the value `"false — these are NOT duplicates"` — verdict
   predicates must carry a **boolean** at the boundary, with the reasoning in evidence.

4. **Invariants were baked into the tool** (found by running it on itself). Shipping the fixture's
   invariants as code meant every other repo was measured against claims about *enclave* — five false
   REDs and an L3 wrongly marked STALE. They now load from `<repo>/vds.invariants.json`, and a repo
   with none defined reports `UNPROVEN` rather than failing. Invariants describe a specific
   architecture, so they live with the code they constrain.
5. **Vendored bundles were being analysed** (same run). A committed copy of three.js contributed
   ~7900 of 8800 symbols in a 24-file repo, inflating D2 groups 4→20 and inventing 3 patterns. Files
   over 200KB (or smaller but minified) are now skipped and counted. The walk also respects
   `.gitignore` via `git ls-files` where available.

The third is the one worth remembering: it means the contradiction queue, which the design calls the
highest-value screen in the product, was showing noise and hiding signal until it was exercised with
two real models.

**Cluster into families, don't report pairs.** A thing that is name-duplicated *and* shape-duplicated
*and* body-duplicated should land in one family, so we run **one adjudication per family** rather than
one per pair — the difference between N² and N agent calls, and between a coherent "here is the
canonical form" answer and a pile of pairwise opinions.

**But union-find over *any* detector link is wrong** — corrected in P0 after it fired. Transitive
closure runs through common signatures: one enclave run welded 107 unrelated symbols into a single
"family" via chains of `(string) => Promise<void>`. A link qualifies only when the evidence is
specific:

- **D1 alone qualifies.** Shape similarity over ≥3 named fields is specific.
- **D2 + D3 together qualify.** Two independent weak detectors agreeing on the same pair is
  corroboration.
- **D2 or D3 alone does not.** They still surface as their own groups; they don't get to merge
  clusters on their own authority.

An over-merged family is worse than no family, because it hides the real one inside it.

**Oversized D2/D3 groups are patterns, not duplication.** `getById` across 19 repositories is the
repository pattern. Groups above the size cap are reclassified as *patterns* and kept — they're
evidence of a shared **role**, which makes them input to L2 clustering rather than a dedup finding.

Scaling: never compute the full N² similarity matrix. MinHash + LSH banding to get candidate pairs,
exact scoring only within buckets.

Adjudication asks: same concept, or coincidence? Which member is canonical? What's the union type or
the extracted common function? What breaks if we merge — from the graph's blast radius, not a guess.

### 2. Everything else

1. **Collapse candidates** — community detection (Louvain/Leiden) over the module graph, cross-cut
   with D5. Two communities with high-similarity purposes, or one community with high internal
   cohesion and a near-identical external interface to another, is a merge candidate. This is the
   "whole section that could become one stronger system."
2. **Dead / unreachable** — from entrypoints, with the confidence tiering the whole design exists
   for. False positives come from dynamic dispatch, DI, file-based routing, decorators, plugin
   registries, string-keyed lookups, test-only use, and public library surface. Static proposes;
   agents adjudicate; the human confirms.
3. **Cycles, back-edges, layering violations** — SCCs and any edge pointing up the layer stack.
4. **Weird limbs** — a subtree whose edges almost all leave the subtree. Cohesion is a lie there.
   Visually: a limb whose festoons all fly elsewhere.
5. **God nodes** — high fan-in × high churn. The thing actually hurting you day to day.
6. **Orphan clusters** — connected components unreachable from any entrypoint.
7. **Tree divergence** — where the authored directory tree and the actual dependency tree disagree.
   The gap between how it's filed and how it's wired is itself the mess.

## MCP tool surface

One server, stdio, spawned per agent session with the repo root and a session token.

| Tool | Purpose |
| --- | --- |
| `get_overview` | Top-level shape: dirs, layers, counts, current frontier summary. Cheap orientation. |
| `get_slice` | Subgraph around a node — n-hop neighborhood, with current claims and confidences. The context-budget primitive. |
| `get_open_questions` | The agent's assigned frontier items, with why each is uncertain. |
| `submit_claim` | Assert a predicate with evidence. Rejected without evidence. |
| `submit_finding` | A taxonomy finding (duplicate pair, collapse candidate) with its members and rationale. |
| `flag_contradiction` | Explicitly dispute an existing claim, with counter-evidence. |
| `propose_node` / `propose_edge` | Add structure static analysis missed — e.g. an edge through a string-keyed registry. Always low initial confidence. |

Focus operations — the expensive half, and the primary agent activity:

| Tool | Purpose |
| --- | --- |
| `propose_cluster` | Group members into a subsystem with a **name and a purpose**, plus evidence for why they belong together. Promotes L1 → L2. |
| `propose_elision` | Argue a set of nodes should collapse or disappear at a given altitude, with the reason. Recorded, reversible, attributable. |
| `defend_node` | Argue something must *survive* focusing — it's load-bearing and eliding it makes the map wrong. The counterweight that stops over-collapse. |
| `propose_invariant` | State a load-bearing fact in natural language plus a compiled graph query, with the evidence that it currently holds. |
| `get_focus_state` | Current stack, what's collapsed where, and which invariants are green, red or unproven. |

Deliberately absent: anything that writes files, and any bulk graph dump. Agents pull slices.

`propose_elision` and `defend_node` are deliberately adversarial — over-collapse and under-collapse
are both failures, and having agents argue both directions with evidence is how the altitude gets set
honestly rather than by a threshold nobody can justify.

## Agent adapters

Verified against the binaries installed on this machine, not from memory.

| CLI | Headless | Structured output | Session | Sandbox |
| --- | --- | --- | --- | --- |
| `claude` | `-p/--print` | `--output-format stream-json\|json\|text`, `--include-partial-messages` | `--session-id <uuid>`, `--resume`, `--fork-session` | `--allowedTools`, `--permission-mode`, `--strict-mcp-config` |
| `codex` | `codex exec` | `--json` (JSONL), `--output-schema <file>`, `-o <file>` | `codex exec resume --last` | `-s read-only` |
| `grok` | `-p/--single` | `--output-format json\|streaming-json\|streaming-messages-json`, `--json-schema` | `--session-id`, `--resume`, `--continue`, `--fork-session` | `--sandbox <profile>`, `--allow`/`--deny` |
| `opencode` | `opencode run` | `--format json` | `--session`, `--continue`, `--fork` | agent permission config |

MCP wiring: `claude --mcp-config <json> --strict-mcp-config` is the tightest. `codex mcp` and
`opencode mcp` manage server registration; `grok`'s MCP config mechanism is **not yet verified** —
check before building that adapter.

Notes worth exploiting later: `opencode serve` exposes a headless HTTP API and `opencode acp` /
`grok --output-format streaming-json` both speak ACP session updates; `codex app-server` similar.
Richer control channels than process spawn exist for three of the four. Start with spawn + JSON as
the common denominator, keep the adapter interface narrow enough to swap.

**Every agent runs read-only and sandboxed.** The harness never passes `--dangerously-*`,
`--always-approve`, or `--auto`. Repo access is read; graph access is via MCP only.

## Frontier scheduler

Priority queue over unresolved subjects:

```
score = uncertainty(subject) × centrality(subject) × staleness_boost
```

- `uncertainty` — 1 for `UNKNOWN`, scaled down as confidence and corroboration rise, spiked for
  `CONTRADICTED`.
- `centrality` — betweenness or PageRank over the current edge set. Resolving a hub changes more
  downstream beliefs than resolving a leaf.
- Human pinning overrides score entirely.
- Budget-aware: per-run token/cost ceiling, per-agent concurrency cap. Stop when the top score falls
  below a floor — that's the natural "the map has converged" signal.

**Multi-model consensus is opt-in, not the default.** Fan the same question to a second and third CLI
only for high-centrality nodes, dead-code calls, and anything the human is about to act on. Running
every model on every question is 3–5× cost for correlated errors.

## Static bootstrap

- **tree-sitter** — files, symbols, imports, type/interface/class shapes. Works on broken and
  unbuildable code, which is the whole point for a vibe-coded repo.
- **knip** — dead exports, dead files, dead deps. Best in class for TS; wrap, don't rebuild.
- **dependency-cruiser** — cycles and rule violations.
- **jscpd** — copy-paste bodies.

All optional providers behind one schema. If a provider can't run (no build, no toolchain), the
skeleton still renders and the agents just have more work to do.

## Visualization

Electron shell, three.js for the main scene, ordinary DOM/2D for everything precise.

**Why 3D, specifically.** Not a technology preference — three things it actually buys:

1. **Room.** The pile-of-labels problem is a 2D density problem. A third axis plus camera distance
   gives space to spread into. (Caveat below — this is not free.)
2. **Perceptual tangle-spotting.** A knot reads as a knot when you can orbit it. Flying around
   festooned structure surfaces relatedness that no metric ranks well, because you're pattern-matching
   on shape rather than reading a list.
3. **Spatial memory.** You navigate back to "that gnarled thing near the auth branch" the way you
   navigate a room — but *only* if the layout is stable across frames.

**The layout: a festooned tree.** Hierarchy is the spine; cross-edges are the garlands.

- **Spine** = the containment hierarchy, laid out as a 3D tree. Root at the trunk, directories and
  modules as branches, symbols as leaves. Deterministic and stable — the same repo lays out the same
  way every session, which is what makes flying around it navigable.
- **Toggle the spine** between the *authored* tree (directories, as filed) and the *actual* tree
  (dependency layers, as wired). Morph between them. The divergence is a finding in its own right.
- **Festoons** = every edge that doesn't follow the spine, hierarchically bundled so they read as
  ropes rather than static. Bundling is what makes cross-cutting structure legible instead of noise.
- **Pruning reads visually.** A limb attached by one thin bundle detaches cleanly. A limb whose
  garlands all fly to the far side of the tree is misfiled. A limb with no garlands at all is dead or
  genuinely independent — the graph says which.
- **Belief state is the primary visual channel**, not an afterthought: unknown regions dim and
  untextured, inferred translucent, corroborated solid, contradicted marked, confirmed crisp. The map
  visibly resolves as the swarm works. That's the Gource feeling, but the time axis is *analysis
  progress* rather than git history — more useful, and it doubles as the progress bar.
- **2D panels** for the contradiction queue, findings, current-vs-target diff and the plan. The scene
  is for finding things; the panels are for deciding about them.

**LOD is semantic, not cosmetic.** Camera distance *is* altitude on the focus stack. Pulling back
doesn't fade nodes out — it collapses them into their L2/L3 abstraction, with the agent-written
cluster name as the label. Flying in expands an elision back to its members. One mechanism serves
both the fly-around-and-spot-tangles goal and the focus-until-correct method, and it means the user
is never looking at a view that isn't a defensible map at some altitude. Invariant state renders in
the scene: a red invariant lights up the specific violating edge at whatever altitude you're at.

**Two layouts, one scene.** The festooned graph answers *what depends on what*; it groups by
the focus stack, which is intent. The **cone tree** answers *where does this live*; it reads the
real path tree at arbitrary depth, files as leaves, which is how people actually hold a codebase
in their head. Both are the same data and the same selection — spot a tangle in one, toggle, see
where it lives in the other.

The focus stack alone cannot serve the second question: it flattens to three levels of buckets,
so `src/main/services/sandbox/PluginWorker.ts` and `src/main/services/ai.ts` land together with no
memory that one is nested deeper. The tree view exists because that shape was being discarded.

In the tree, cross-edges are **hierarchically bundled** — routed up to the lowest common ancestor
and back down, then relaxed toward the straight line (β ≈ 0.82) so ropes stay distinguishable.
That routing is what makes "this limb's dependencies all leave the subtree" visible, rather than a
haze beneath the leaves. Camera distance maps to tree depth here, the same way it maps to focus
altitude in the graph view.

**Caveat on labels.** 3D gives room but doesn't solve labels by itself — perspective scaling makes
distant text unreadable and depth-sorted billboards overlap just as happily as 2D ones. Needs an
explicit declutter policy: LOD tiers by camera distance, labels on approach and on hover, aggregate
labels for collapsed branches, screen-space collision rejection per frame.

Rendering budget: instanced meshes for nodes, batched/bundled line geometry for festoons, GPU picking
for selection, SDF text atlas. Target 10k+ nodes at 60fps. Analysis runs in the main/utility process;
the renderer receives snapshots and deltas over IPC and never blocks.

Electron hardening: `contextIsolation: true`, `nodeIntegration: false`, narrow preload IPC surface.
The renderer displays agent-authored text — treat it as untrusted content.

## Target architecture and the plan

The differentiator, and what the manual Mermaid run couldn't do.

The user (or an agent) draws the **target** tree — the shape it should be. We diff current against
target and emit an ordered refactor plan: moves, merges, extractions, deletions, each with its
blast radius from the graph and its blockers.

Exports, all first-class:

- **Mermaid** — keeps parity with the manual playbook, drops into PRs and docs, and is how the map
  gets into any agent's context cheaply.
- **Task packets** — each plan step as a self-contained prompt plus subgraph slice, ready to hand to
  whichever CLI you like. v1 doesn't execute; it makes execution trivial.

## Persistence

```
.codemap/
  graph.json        ← committed: nodes + edges
  confirmed.json    ← committed: human-confirmed and high-confidence claims
  target.json       ← committed: the intended architecture
  findings.json     ← committed: adjudicated findings
  .cache/           ← gitignored
    sqlite.db       ← full claim log, all provenance
    traces/         ← raw agent transcripts
    parse-cache/    ← keyed by contentHash
```

The committed layer is reviewable in PRs and diffable, so the map accrues value across the team and
survives a clone. The churn stays local.

## Calibration fixture

`/home/miz/personal/eaves/Archive/enclave` — an Electron app, ~570 source files, ~127k LOC, mostly
TS/TSX, 843 commits. It already carries `knip.json` and `.jscpd.json`, so two of our four wrapped
providers have existing in-repo config to diff against. It has a plugin system with a runtime
registry and three load paths, which exercises the dynamic-dispatch dead-code false-positive path
immediately rather than eventually.

The valuable part is that it comes with **written answer keys from the manual runs**, at three
labeled points:

| Point | Commit | State | Answer key |
| --- | --- | --- | --- |
| **Pre-collapse** | `2a1645e` (2026-07-14) | `ChatRepository` and `ChannelRepository` coexist; three inconsistent AI assembly lines | `docs/architecture/collapse-plan.md` @ `a18995b` |
| **Pre-remediation** | `e946f57` (2026-08-08) | stale/dead code present across four partitioned areas | `docs/qa/stale-code-audit-2026-08.md` |
| **HEAD** | current | both remediated | negative control — see the corrected criterion below |

Pre-collapse is the primary fixture: it's where the duplicate structures and the collapsible
subsystem actually exist, and `collapse-plan.md` states what the right answer was before anyone acted
on it. Pre-remediation gives us a labeled dead-code set with CONFIRMED/SUSPECTED tiers already
assigned by hand.

**Corrected negative-control criterion (P0, 2026-08-16).** The original criterion — "detectors should
go quiet at HEAD" — is wrong, and the first P0 run proved it. Two things it got wrong:

1. **Aggregate counts are the wrong metric.** The tree *grew* 326 → 404 files between pre-collapse
   and HEAD, so raw finding counts stay flat even when the targeted duplication is gone. The right
   measure is whether the *specific* findings the remediation addressed disappear.
2. **HEAD is not clean in general, only clean of what was remediated.** At HEAD the detector still
   flags three chat/channel structure pairs. Two — `Chat`/`Channel` and
   `ChatItemProps`/`ChannelItemProps` — are documented in `README.md` as *deliberate* surface
   ("compat surface", "intentional UX skins"). The third, `ChatParticipantRow`, is byte-identical to
   `ChannelParticipantRow` and referenced exactly once, by its own declaration: dead and duplicate,
   left behind when the `chat_*` tables went away, and missed by both manual sweeps.

So the criterion becomes: **every finding surviving at HEAD must be triaged to either documented-
deliberate or genuine-residual — no finding may be merely unexplained.** That is a per-finding
judgment, not a threshold, and it is precisely the adjudication work the design hands to agents and
the human. A detector cannot know "deliberate"; only the intent layer can.

This is also the first evidence the tool earns its keep: P0 found in 0.3s a real residual that two
hand-run agent sweeps did not.

Note the audit's own method mirrors this design independently: four non-overlapping partitions,
CONFIRMED vs SUSPECTED tiers, five load-bearing claims re-verified outside the agent that found them,
every finding required to be traced end to end rather than inferred from a grep hit, and the whole
sweep read-only. That's the claim model, the corroboration rule, the evidence requirement and the
read-only stance, arrived at by hand. Good evidence the shape is right; also a reason to hold the
tool to the same bar.

### The invariant acceptance test

The fixture gives us a direct, labelled test of the invariant mechanism — the highest-risk new idea
in the design — with no hand-labelling work required.

`docs/architecture/README.md` at HEAD states six invariants in prose. Compile them as L0 queries and
run them at two fixture points:

| Invariant | HEAD | Pre-collapse `2a1645e` | Why |
| --- | --- | --- | --- |
| *"Chats are channels"* | green | **red** | `ChatRepository` still exists as a separate store |
| *"Streaming has one consumer"* | green | **red** | streaming unified in Phase 3 Round 1, 2026-07-15 |
| *"EventBus is storage-only — nothing on it starts a turn"* | green | **red** | ADR-001 lands in Phase 2 |
| *"`ai.ts` never persists"* | green | ? | unverified — worth checking |
| *"Startup order is load-bearing"* | green | green | expected stable |
| *"Trust model"* | green | green | expected stable |

If the compiled queries don't reproduce that pattern, either the compilation is wrong or the
mechanism doesn't work — and we find out at P1, before building the swarm or the renderer on top of
it. Three known flips and two known holds is a real test, not a smoke test.

Access is read-only and via `git show` / a detached worktree — **never check out or mutate branches in
the fixture repo.**

## Open problems

1. **Stable node identity across renames and moves.** Path+name is fragile and breaks time-travel,
   incremental caching, and any claim's survival across a refactor. Probably content-and-context
   fingerprinting with a similarity-matched rename detector. Expensive to retrofit — decide early.
2. **Where similarity thresholds sit.** Every threshold across D1–D5 is currently a guess. Calibrate
   against the three fixture points above: tune on pre-collapse until D1–D3 surface the ChatRepository
   /ChannelRepository duplication that `collapse-plan.md` describes, then check the same thresholds go
   quiet at HEAD. Precision matters more than recall here — a noisy map is ignored.
3. **Cross-agent session cost.** Four CLIs × repeated frontier passes gets expensive fast. Budget
   ceilings need to be real, visible, and enforced in the driver.
4. **Grok MCP configuration** — unverified. Confirm before building that adapter.

## Phases

Ordered by **risk retired per unit of work**, not by architecture layer. Each phase has a gate test
against the calibration fixture, because "we built it" is not the same as "it works."

| Phase | What becomes true | Gate test | Size |
| --- | --- | --- | --- |
| **P0 Extract** ✅ | L0 graph, D1–D3, families, L1 Mermaid — headless | reproduces the manual swarm's duplication finding on pre-collapse | done |
| **P1 Invariants** | prose invariants compile to L0 queries; drift detected automatically | the six-invariant flip test — 3 red at pre-collapse, 2 hold | small |
| **P2 Claims + one agent** | agents decorate the map through MCP, evidence enforced at the boundary | an agent adjudicates a D1 family; unciteable claims are rejected | medium |
| **P3 Focus** | L1→L2→L3 by recorded, reversible, defended elisions | agents produce an L3 for the fixture comparable to the hand-drawn `README.md`, and its invariants pass | large |
| **P4 Swarm** | four adapters, frontier scheduler, contradiction queue, budget caps | two models genuinely disagree on a real claim and arbitration resolves it | medium |
| **P5 The view** | Electron + three.js festooned tree, semantic LOD, belief state | fly the fixture and spot a tangle you didn't already know about | large |
| **P6 Target + plan** | target architecture, current-vs-target diff, task packets | generate the collapse plan for pre-collapse; compare against the real one | medium |

### Why this order

**P1 matters more than its size suggests.** It is the cheapest test of the riskiest idea in the
design, and it is independently shippable **with no LLM at all** — hand-write invariants, run them in
CI, get told when the architecture doc has gone stale. The project therefore has real standalone value
before a single agent runs, which de-risks everything downstream. If invariants don't compile
usefully we learn it in a day, not after building a renderer on top of them.

**P3 is the thesis gate.** Everything before it is machinery; everything after it is amplification. If
agents cannot produce a defensible L3, what we have is a dependency visualiser with unusually good
provenance — useful, but not the thing this is for. Treat P3 as a go/no-go, not a milestone.

**Nothing before P5 needs a UI.** P0–P4 are headless and testable from a terminal, which keeps the
feedback loop fast and the fixture honest.

### Open ordering question — a thin viewer before P4?

Judging whether a focus operation is *good* is itself a visual task; reading elision decisions as
JSON is miserable. There's a real argument for a **P3.5**: a plain 2D web view of the focus stack —
no Electron, no three.js — purely to evaluate P3's output. Probably makes P3 converge faster. Against:
it's throwaway work that delays the swarm. Unresolved.

### Cheap parallel track — land whenever

Wrapping `knip`, `dependency-cruiser` and `jscpd` is near-free and buys dead-code candidates, cycles,
and D4 copy-paste bodies. The fixture already ships `knip.json` and `.jscpd.json`, so there's existing
config to diff against. Blocks nothing; slot it into any gap.

### Explicitly deferred

**D5 (embedding module purposes)** and **polyglot via a tree-sitter provider**. Both are additive,
neither retires risk, and both get substantially easier once the claim and focus machinery exists.
