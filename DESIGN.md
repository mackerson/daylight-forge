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

### Stigmergy, and why the form has to be visible

Agent swarms coordinate **stigmergically**: they do not talk to each other, they modify a
shared environment and read back what others left. The codebase is that environment. So is
our claim store — an agent deposits an evidenced claim and the next one reads the
accumulated state, exactly like a pheromone trail.

Stigmergy is only as good as the read-back loop, and that is where drift comes from at speed
or scale. Each agent acts on a stale picture of the whole, makes a locally sensible edit, and
the sum of locally sensible edits is globally shapeless. Add more agents, or let them edit
faster, and drift accelerates — not because any one of them is wrong, but because none of
them can see the form. That is the actual failure this tool addresses: **shorten the loop
between "the codebase changed" and "everyone can see the new shape."** The 50,000ft view is
the stigmergic signal made legible.

Two consequences fall straight out of that framing:

- **Contradictions are the highest-value signal**, not an inconvenience. In a stigmergic
  system, conflicting deposits mark precisely where the shared picture has diverged. That is
  why they are preserved and surfaced rather than auto-resolved.
- **The map is the medium, so it must be cheap to read.** A map that takes an hour to
  interpret does not shorten anyone's loop. Hence focusing, and hence the insistence that a
  small true map beats a complete one.

## Related work

Prior art is dense here, and most of it is good. Worth being specific so we do not
re-derive things:

| Tool | What it already does |
| --- | --- |
| [desloppify](https://github.com/peteromallet/desloppify) | The direct ancestor: an agent harness on a `scan → score → review → triage → execute → rescan` cycle, mechanical detectors plus LLM review of naming/abstractions/module boundaries, state in `.desloppify/`, 29 languages |
| CodeCharta, CodeScene, Sourcetrail (archived 2021) | The visualisation genre — city metaphor, circular packing, interactive dependency graphs |
| ArchUnit, Sonargraph, NDepend, Structure101 (now in Sonar) | In-repo, CI-enforced architecture rules and drift detection. Our invariants are a lightweight ArchUnit for TypeScript with prose attached |
| Thoughtworks Radar: *architecture drift reduction with LLMs* | Deterministic analysis combined with LLM evaluation for structural **and** semantic violations — named as an industry technique |

**Against desloppify specifically.** It produces a prioritised *queue*; this produces a
*form*. A ranked list of issues, however good, never tells you the shape of the application —
which is the gap that motivated this project. They are complementary rather than competing:
desloppify's findings could feed this frontier, and its 29-language coverage dwarfs our
TS/JS-only extraction. It also *executes* fixes, where we are deliberately read-only.

**One lesson worth stealing.** desloppify's score deliberately widens the gap when an issue
is marked `wontfix`, so the metric resists gaming. We have no equivalent: an agent can clear
frontier items cheaply by ruling things out, and nothing currently costs it anything to do
so. Evidence enforcement and contradiction preservation make a *false* claim expensive, but a
*dismissive* one is still free. Open problem.

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
| Edges to undrawn levels | a spiderweb of connections fanning out past every visible node | nothing — identical partitions render one level, but spine and festoon geometry was still built for all three |
| Unresolved path aliases | 127 live React components reported as unreachable | nothing — a regex comment-stripper ate the `/*` inside `"@/*"` and destroyed the `paths` block, so aliases never resolved and 2773 edges were missing |

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

Six cheap detectors, all built. Five are fully deterministic and need no model at all. D5 is
the exception in two ways: its input is what agents *wrote* rather than what the parser saw,
and it can optionally use an embedding endpoint you have already set up. None of the six needs
an LLM to *find* anything; agents adjudicate.

| # | Detector | Signature | Catches |
| --- | --- | --- | --- |
| D1 | Structure shape | set of `(fieldName, normalizedType)` over interfaces / type aliases / classes / schemas | "same but for a few fields" — the original manual finding |
| D2 | Duplicate function names | exact + case/separator-normalized name index | copy-paste families, and genuine convention collisions |
| D3 | Duplicate signatures | name-agnostic: arity + normalized param types + return type | the same function written four times under four names |
| D4 | Repeated code blocks | token-stream MinHash / winnowing over bodies | copy-paste that drifted enough to hide from D2/D3 |
| D5 | Near-duplicate purpose | TF-IDF cosine over agent-written purposes, optionally embeddings | semantically redundant subsystems with no textual overlap |
| D6 | Parallel implementations | IDF-weighted method-name overlap between *files* | the same thing written twice, where nothing inside either is a copy of anything inside the other |

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
   REDs and an L3 wrongly marked STALE. They now load from `<repo>/daylight.invariants.json`, and a repo
   with none defined reports `UNPROVEN` rather than failing. Invariants describe a specific
   architecture, so they live with the code they constrain.
5. **Vendored bundles were being analysed** (same run). A committed copy of three.js contributed
   ~7900 of 8800 symbols in a 24-file repo, inflating D2 groups 4→20 and inventing 3 patterns. Files
   over 200KB (or smaller but minified) are now skipped and counted. The walk also respects
   `.gitignore` via `git ls-files` where available.

The third is the one worth remembering: it means the contradiction queue, which the design calls the
highest-value screen in the product, was showing noise and hiding signal until it was exercised with
two real models.

10. **Chromium was rendering on the wrong GPU, silently.** On a laptop with an RTX 4080 the
    map ran on the integrated Radeon 610M, because under Wayland the compositor allocates
    buffers on the display GPU and NVIDIA cannot import them — `eglCreateImage` fails and
    Chromium falls back without saying anything. Neither `powerPreference: 'high-performance'`
    nor `prime-run` nor the PRIME environment variables move it, because only ANGLE-over-EGL
    backends are permitted and the choice is made below them.

    What works is XWayland plus ANGLE over desktop GL: `--ozone-platform=x11 --use-angle=gl`
    with `__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia`, which is `pnpm
    gui:dgpu`. 143fps against 93. The meter names the chip that actually rendered and says so
    when a discrete card is sitting idle, because a frame time attributed to the wrong
    hardware is worse than no frame time at all.

9. **LOD was a guess about somebody else's computer.** `LOD_THRESHOLD = 2500` was a constant,
   and above it the "all levels" button was silently inert — on a 14,651-node monorepo the
   interface offered a choice it did not honour and said nothing. Measured properly, with a
   frame meter and a headless benchmark, on the *integrated* GPU of the machine that reported
   the problem:

   | | visible | fps | mean | p95 | draws | tris |
   | --- | --- | --- | --- | --- | --- | --- |
   | LOD on | 701 | 138 | 7.2ms | 14.6ms | 6 | 0.4M |
   | everything | 14,651 | 92–107 | 9.3–10.8ms | 15.2–17.9ms | 26 | 7.6M |

   Twenty times the nodes for about a fifth of the frame time, because nodes are instanced: a
   level costs one draw call whether it holds seven or seven thousand. The constant was not
   conservative, it was wrong, and it was wrong because no one had measured.

   So the default is now to draw everything and let the machine object. A run whose 95th
   percentile stays above 26ms for two seconds sets its own limit, once, records it, and says
   so — rather than a number chosen in advance for hardware nobody had seen. The 95th
   percentile rather than the mean, because ninety-five frames at 8ms and five at 60 averages
   under 11ms: a number that reads as comfortable and feels like a stutter every twentieth
   frame.

   The same measurement found Electron rendering on the integrated Radeon 610M while a mobile
   RTX 4080 sat idle. `powerPreference: 'high-performance'` is now requested and the meter
   names the chip that actually rendered, because a frame time attributed to the wrong
   hardware is worse than no frame time. The driver still ignores the hint on this laptop.

8. **The tree was unusable on a large repo** (reported from use). A containment layout has no
   bounded size — every level must hold everything beneath it — so on a 10k-file monorepo the
   deepest nodes sat 28,000 units from the centre while the camera clamps to a few hundred.
   There was no distance from which the tree could be seen: it rendered as a dot with lines
   going off past the far plane. Three separate causes, none of which showed on a small repo:

   - **Unbounded extent.** The finished layout is now scaled to fit the camera's range, and
     only ever shrunk — a tree that already fitted is left exactly as it was. Depth is
     deliberately not scaled with it, or thirteen levels flatten into seventeen units and a
     tree becomes a disc.
   - **A ring's radius grows with the *sum* of its children**, so hundreds of siblings became
     a wall. Ring and disc packing are both computed and the smaller wins: neither is right
     everywhere, because a disc is sized by its largest occupant and one dominant subtree
     ruins it.
   - **LOD thresholds were `420 - depth * 90`**, which reaches zero at level 5 — so on a
     13-level tree every deeper level shared a threshold, the lookup always matched the fifth,
     and levels 6 to 13 were in the scene but unreachable at any distance. Nine tenths of the
     tree could not be looked at. Thresholds now spread over the depth the repo actually has.

   Two more surfaced alongside it. `graph.json` is 322MB on that repo, and the window was
   parsing it on the process that draws the window on every refresh, then shipping 28MB across
   the IPC boundary — of which 27.5MB was a symbol index shipped whole to answer a question
   about whichever single file you opened, on an estimate ("a few hundred kilobytes") that was
   wrong by two orders of magnitude. The two derivations the interface needs are precomputed
   at map time into `view.json` (888KB), and symbols are fetched per file.

7. **One output directory, two repositories** (reported from use, and the worst of the lot).
   Choosing a new repo in the GUI showed the old repo's map, because picking a repo set the repo
   and left the output directory alone. That is the mild, visible half. The severe half is that
   `claims.db` addresses files by **repo-relative path with no repo in the subject**, so pointing
   one directory at a second project re-indexes the first project's confirmed knowledge onto the
   second's identically-named files — and the rename detector, seeing every file of A vanish and
   every file of B appear, migrates them there deliberately. Reproduced: a *human* claim about
   repo A's `src/Store.ts` landed on repo B's `src/Cache.ts`, two unrelated projects, and
   presented as reviewed knowledge about a codebase nobody had opened.

   Fixed at three depths, because one guard in one place would have been the same mistake again:
   fingerprints record the repo they describe and are ignored across repos; `map` refuses an
   output directory holding a different repo's graph, with `--force` for the one legitimate case
   of the same repo at a new path; and the GUI derives a per-repo output directory unless the
   user has explicitly chosen one, so the common path never reaches the guard at all.

6. **No verdict claim could be submitted at all** (P13, found by running the gate rather than reading
   about it). The boolean rule is right and stays — an agent sending `duplicates` with the value
   "false — these are NOT duplicates" is exactly the failure it prevents. But it also rejected a bare
   `"true"`, which is a boolean that went through a JSON boundary and carries no reasoning to lose.
   Watched live, an agent assigned a `god_verdict` question answered it fifteen times, was rejected
   fifteen times, and burned its whole budget without landing one claim. **The contradiction queue had
   therefore been unreachable for verdicts since the rule landed** — the highest-value screen in the
   product, fed by a path that could not be traversed. That, not model agreement, is why no
   cross-model disagreement had ever been observed. Two more fell out of the same session: two
   concurrent agents crashed on `database is locked` in a design whose premise is a swarm, and
   assigned frontier questions were never made binding, so agents answered easier ones and the
   scheduler's ranking, leases and convergence signal were all advisory.

**Cluster into families, don't report pairs.** A thing that is name-duplicated *and* shape-duplicated
*and* body-duplicated should land in one family, so we run **one adjudication per family** rather than
one per pair — the difference between N² and N agent calls, and between a coherent "here is the
canonical form" answer and a pile of pairwise opinions.

**But union-find over *any* detector link is wrong** — corrected in P0 after it fired. Transitive
closure runs through common signatures: one enclave run welded 107 unrelated symbols into a single
"family" via chains of `(string) => Promise<void>`. A link qualifies only when the evidence is
specific:

- **D1 alone qualifies.** Shape similarity over ≥3 named fields is specific.
- **D4 alone qualifies.** It is the only detector whose evidence came from reading the code
  rather than its label.
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

**D4's power and its failure mode are the same mechanism.** Erasing identifiers and literals is
what lets a body survive being renamed — the whole point, since a copy that kept its name was
already D2's finding. It also makes every declarative table look alike: the first fixture run
matched four sibling menu definitions at 1.00, which share a shape only because they are all
lists of the same kind of entry. A function whose entire body is one literal is *data*, not
logic, and no longer carries a signature. That single rule removed 7 of 28 pairs, all noise.

The signature is computed during the existing parse rather than by a second tool, which is why
D4 costs nothing on a warm cache: an unchanged file's signatures come back with everything else
it already cached. That is also the argument against wrapping `jscpd` — a second full pass over
the tree, and a dependency, to re-derive what our own parser already has in hand.

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

**Frontier leasing.** `get_open_questions` was stateless, so every agent that asked got the
identical top-ranked list and concurrent runs duplicated each other *by construction* — the
scheduler had no notion of who was already working where. Measured on a real two-session run:
19% Jaccard overlap of touched nodes.

An item handed out is now leased to that session, and other sessions are given the next
unleased ones. This is the manual audit's trick — it "partitioned the stale set four ways so
the areas did not overlap" — except recorded in the shared environment instead of in
someone's head, which is the only version that works when agents are launched independently.

Leases **expire rather than being released**. An agent that dies mid-run must not hold work
hostage, and handing the same item out twice occasionally costs far less than a frontier item
nobody can ever be assigned. The driver takes leases too, since it puts frontier items
straight into the prompt and would otherwise collide before either agent starts.

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

**Agents are shown by attention, not position.** An agent has no location, but every
`get_slice` records which node it asked to look at, so a marker sits on a node it genuinely
touched and trails the ones before it. The flight between two such nodes is a visual
transition, not a claim that it passed through anything on the way — and orientation calls
that carry no subject move nothing, because inventing a destination for them would be the
referent rule violated again. Marker colour is the same stable per-agent hue the agent
channel uses, so who-is-where reads the same in both.

**LOD is legibility, not performance — measured.** On the 449-node / 855-rope fixture the
distance-driven LOD renders 7 nodes at 0.14ms/frame; showing all 449 costs 0.28ms. Against a
16.7ms budget that is a saving of under 1% of a frame, because nodes are instanced (one draw
call per level whether it holds 7 or 449) and label layout and picking are bounded by screen
area rather than by tree size. So semantic zoom has to justify itself on *meaning* alone, and
on a small tree it does not: the popping costs more attention than the decluttering returns.
All levels are shown by default; LOD engages above ~2500 nodes, where the cost curve starts to
bite. Label count is hard-capped regardless, since it is the only per-frame cost that scales
with the graph.

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

1. **~~Stable node identity across renames and moves.~~ Solved at the claim layer.** The framing was
   wrong: it read as an identity problem in the graph, and the graph does not need stable identity —
   it is rebuilt from scratch every run and nothing in it survives on purpose. **Claims** need to
   survive, and they are keyed by subject.

   So node ids stay `path#Name`, and `map` matches this run's files against last run's the way git
   detects a rename. A file's fingerprint is the elementwise minimum of its functions' body
   signatures — which is exactly the MinHash of their union, so it costs nothing beyond what D4
   already computes — together with the set of names the file declares. Both signals must agree:
   structure alone matches a file that was rewritten wholesale into the same shape, names alone
   match any two siblings in a conventional codebase.

   A match migrates claims, their evidence paths, defences and cluster membership in place, keeping
   the original assertion time and source — a move is not new knowledge and must not look like it,
   or a two-month-old human confirmation appears to have been made by the migration.

   Splits and merges are reported and left alone. One file resembling two arrivals is a real event
   with no single right answer, and picking one would attach somebody's confirmed knowledge to a
   file they never examined. That is the failure worth avoiding here; missing a rename only costs a
   re-collection.

   A content-addressed node id was the obvious alternative and is worse: content changes constantly,
   so it breaks on every edit, trading a rare failure for a continuous one.
2. **Where similarity thresholds sit.** ~~Every threshold is a guess.~~ **Measured.**
   `engine/tools/calibrate.ts` sweeps them across all three fixture points and scores each setting on
   what it finds versus how much it reports. Three results, one of them uncomfortable:

   **The map does go quiet as the codebase is remediated.** Families per 100 files: 17.8 pre-collapse →
   14.4 pre-remediation → 14.4 at HEAD. Raw counts would have said the opposite — HEAD has 404 files to
   pre-collapse's 326, so a growing codebase has more of everything. Density is the number to read.

   **The thresholds are staying where they are, and now that is a decision rather than an accident.**
   Raising `minNameScore` from 0.6 to 0.8 cuts density by 23% and is what the sweep nominates, because
   the one known pair survives it. But it also discards every D1 pair in the 0.6–0.8 band — 35 at
   pre-collapse, 40 at HEAD — and that band *is* the "same but for a few fields" case this detector was
   built for. With a single labelled pair the sweep cannot tell a quieter map from a blinder one. The
   fix is more labelled pairs, not a different number. Separately, `minTypedScore` made no difference
   at any value from 0.0 to 0.3 on any fixture point: it is a knob that does not turn.

   **The ChatRepository/ChannelRepository duplication was not reachable at any threshold** — which
   was the useful finding, because it was never a tuning problem. It is now found by D6; what
   follows is why none of D1–D4 could get there. D1 cannot fire: both classes expose two
   fields (`db`, `logger`), because a repository's shape lives in SQL strings, not in its types. D4
   cannot fire: the bodies genuinely differ, since `ChatRepository` grew search, tags and branch counts
   that `ChannelRepository` never had. D2 and D3 do link them — via `delete` ×17, `getById` ×15,
   `(string) => void` ×24 — every one of which is oversized and correctly reclassified as a *pattern*,
   which is the same guard that stopped 107 symbols welding into one family in P0. The within-cap links
   (`getParticipants` ×2, `addParticipant` ×2) have no D3 corroboration, so D2-alone does not qualify.

   Every one of those refusals is individually right, and every one is a *symbol-level* judgement.
   The signal was at the **file** level the whole time: not how many names the two files share, but
   *which*. `delete` appears in seventeen files and means nothing; `getParticipants` appears in two.
   D6 weights each shared name by how rare it is and the pair comes out first, by a wide margin,
   at pre-collapse — and is gone at HEAD, where the collapse removed it. The stated goal of this
   open problem is therefore met: the known duplication is surfaced before, and quiet after.
3. **Cross-agent session cost.** Four CLIs × repeated frontier passes gets expensive fast. Budget
   ceilings need to be real, visible, and enforced in the driver.
6. **~~Naming a parallel implementation.~~ Built as D6.** The cheap option won on evidence: a
   file-level detector weighting each shared method name by inverse document frequency finds the
   fixture's known pair first by a wide margin, costs nothing, needs no model, and is gone at HEAD.

   Two failure modes it had to survive, both real and both now regression-tested. Conventions:
   twelve repositories sharing `create`/`delete` must produce zero pairs, or the map is worthless —
   IDF handles that, since a name in every file scores exactly 0. And **inheritance**: a subclass
   sharing its base class's method names is one implementation overridden, not two written twice.
   That guard silently did nothing at first, because the pair key was built with a NUL separator in
   one place and a space in the other. Two invisible characters that disagree look exactly like a
   guard that is working — the same class of bug as the tsconfig `/*`, and the reason the separator
   is now a named constant used everywhere.

   The risk this leaves is the one flagged when it was still a fork: having the cheap detector makes
   it easy never to build D5. D6 finds things that *share vocabulary*. Two subsystems that do the
   same job under entirely different names remain invisible, and no amount of tuning D6 reaches them.

4. **Hand-rolled parsing of other people's formats.** The tsconfig comment-stripper cost 2773
   edges and a page of false dead code before anyone noticed, because the failure was silent and
   the output still looked plausible. We depend on TypeScript already; its JSONC parser was
   always right there. Treat any regex over a real grammar as a bug not yet found.
5. **Dismissal is free.** Evidence enforcement makes a false claim expensive; it does nothing about
   an agent clearing frontier items by ruling them out cheaply. desloppify solves the analogous
   problem by widening its score gap on `wontfix`. We need something equivalent — perhaps a
   negative claim requires strictly more evidence than a positive one, or dismissals decay back onto
   the frontier unless corroborated.
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
| **P6 Live map** ✅ | map re-derives from either input; belief drives node appearance | derive costs no re-parse (17ms / 63ms); one file changed re-parses 1 of 34 | **passed** |
| **P7 Converge the focus** ✅ | clusters/elisions arbitrable and rejection consequential; dismissal costs something | L3 ≤ 12, every node agent-named or confirmed, invariants green | **passed on this repo** — L3 = 11 nodes, 10 named, invariants 5/5 green |
| **P8 The rest of the taxonomy** ✅ | dead candidates with tiers, cycles, limbs, god nodes, orphans | flags `ChatParticipantRow` at HEAD | **passed** — see the corrected gate below |
| **P9 Target + plan** ✅ | target architecture, diff, ordered plan, task packets | run at both fixture points | **passed** — found a real trust-boundary violation |

### P7's result

A single focus run (376s) took this repo's L3 to **11 nodes, 10 of them named**, and the
names are intent rather than directories renamed: *Arbitration Surface*, *Altitude Control*,
*Ground Truth*, *Belief and Provenance*, *Spatial Memory*, *Capability Root*. With five
invariants authored against that architecture, `l3Status` is TRUE.

This was the go/no-go. If agents could not produce a defensible L3 the product was a
dependency visualiser with good provenance; they can, so it is not.

Writing those invariants immediately found an extraction gap: `throw new EvidenceRequired(...)`
was invisible because the parser recorded `CallExpression` but not `NewExpression`, so every
instantiation in every codebase was missing from the graph. The invariant was right and the
extractor was wrong — which is the correct direction for that argument to run.

### Corrected P8 gate

"Reproduce the stale-code audit's CONFIRMED set" was the wrong gate, written before reading
the audit closely. Most of its findings are *semantic bugs* — a cron parser ignoring
day-of-week, a package script with no build step — which no reachability analysis reaches.
The right gate is the dead-residual we independently verified: `ChatParticipantRow` at HEAD,
byte-identical to `ChannelParticipantRow` and referenced only by its own declaration. It is
flagged, at `low` tier, correctly: our call resolution is syntactic, so an unreferenced export
is a candidate rather than a verdict.

### What P9 actually showed

The target diff found one violation, present at *both* fixture points: `src/main/preload.ts`
imports `src/main/types.ts`, which is itself a re-export shim over `src/shared/types.ts`. So
the trust bridge reaches through the capability root to get at shared vocabulary. Small, real,
and precisely remediable — the generated step says "extract the shared part of types.ts out of
main", which is exactly right.

It did **not** flip between pre-collapse and HEAD, and that is the honest result rather than a
failure: the collapse was a *duplication* problem, and layer rules do not detect duplication.
Different finding classes need different mechanisms, which is the whole reason the taxonomy
has more than one entry. Layering is checked by the target, duplication by D1–D3, drift by
invariants, and none substitutes for another.

| **P10 Guard** | invariants and the target run as a check that fails a build | `vds check` exits non-zero on a red invariant; wired to this repo's own CI | next |
| **P11 Adjudicate the taxonomy** | structural findings reach agents instead of sitting in a file | a high-tier dead candidate gets tiered with evidence, and a false one refuted | after |
| **P12 Team layer** | the confirmed map is committed, reviewable in a PR, survives a clone | two clones converge on one map; a cluster you confirmed is there for me | after |
| **P13 Finish the swarm** | remaining adapters usable; budget ceilings enforced | two *different models* disagree live and arbitration resolves it | after |

### Why these four

**P10 is the highest leverage and the smallest.** Invariants are currently only evaluated
when someone opens the GUI, which makes them documentation with extra steps. ArchUnit's
entire value is that it fails the build. `plan` already exits non-zero; this needs a combined
`check` and a workflow file. It is what turns drift *detection* into drift *prevention*.

Caveat worth respecting: a check that fails builds needs its invariants to be right, and ours
are five hand-written assertions on a young codebase. Ship it warn-only first.

**Adding an invariant that is already red should break the branch that adds it.** That is the
correct behaviour, not a papercut: an invariant is a claim the architecture already holds, so
authoring a red one means either the claim is wrong or the code is — and both want fixing on
the branch that raised it, by the person who has the context. The alternative is a permanently
red main that everyone learns to ignore, which is how architecture rules die everywhere else.

**P11 closes a dangling half-feature.** P8 computes dead-code candidates with confidence
tiers and nothing routes them anywhere — the frontier only asks about purposes and
duplication families. "Static proposes, agents adjudicate, human confirms" is unwired for the
largest finding class we produce, which is also the one most likely to be wrong.

**P12 is where stigmergy actually pays.** The map is currently one person's local artifact in
a gitignored `./out`. The design specified a committed confirmed layer plus a local cache and
only the cache was built. Until the confirmed layer exists the shared environment is not
shared, which undercuts the framing this whole thing rests on.

**P13 is the honest debt.** `codex` is blocked by its approval gate, `grok` and `opencode`
need a registration we print but have never verified, and the original P4 gate — two models
genuinely disagreeing — has never been demonstrated live, because the two we ran agreed.
Leasing makes concurrent agents worth having, so this matters more now than when it slipped.

### Why P6 is the live map

Two things turned out to be the same feature: **re-analysing after a code change** and
**showing the swarm's work as it happens**. Both are "re-derive when an input changes, without
rebuilding from scratch" — one input is the code, the other is the claim store. `graph.json` is
the cached parse, so re-deriving after a claim lands costs no re-extraction. That is the whole
trick, and it is what makes a live view affordable.

It also closes a hole in the stigmergy argument. The human is another participant reading the
shared environment, and their read-back loop is currently the *slowest in the system*: agents
update the store in seconds, the human sees it only after pressing Rebuild. The exact failure
this tool exists to fix, reproduced inside the tool.

Belief state finally becomes the primary visual channel the design always called for. Node
appearance switches between four channels rather than overlaying them, because they answer
different questions and showing all at once answers none:

| Channel | Question it answers |
| --- | --- |
| structure | what kind of node is this — agent-named, path group, defended? |
| belief | how much of this is actually known, and is any of it disputed? |
| frontier | where is the swarm heading next? |
| agent | who has been working here? |

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
