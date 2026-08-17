# TODO

Everything outstanding, in the order I would do it. Rationale for the phase ordering lives in
[DESIGN.md](DESIGN.md); this is the working list.

**Status:** P0–P13 built, and the backlog is empty but for one item that cannot be built —
it has to be *encountered*. This repo maps itself clean: 0 duplication families with a body
match, 0 D4 pairs, 0 D6 pairs. Invariants 6/6 green, target passing. Suite is **442 assertions
across 19 files** (`pnpm test:all`).

### The one thing left

**A genuine cross-model disagreement (P13).** The mechanism has run end to end in anger — two
agents disagreed, the arbitration screen surfaced it, and it produced a real fix — but that
contradiction turned out to be false (`sameConcept` vs `same_concept`). Forcing a *substantive*
disagreement between two different models means paying for repeated runs and hoping one occurs.
That is your budget and your call, so it is not being manufactured.

### Decisions you may still want to make

These are done, but each stops short of a choice that is yours:

| Built | Where it stops |
| --- | --- |
| Polyglot seam | Dispatch, coexistence, per-provider caching and an opt-in loader all work, and a non-TypeScript provider is driven end to end in the tests. Adding a *real* second grammar means either a tree-sitter dependency or becoming a consumer of desloppify's output. |
| Packaging | `pnpm package` builds a portable directory that runs standalone. A `.deb`/`.dmg`/AppImage needs `electron-builder`; a build anyone should trust needs signing. |
| D5 embeddings | The lexical scorer runs always and locally. The embedding backend needs an endpoint you point it at, and refuses a remote host until you say so twice. |

--- | --- |
| Naming a parallel implementation (D5 vs a file-level name detector) | Calibration proved D1–D4 structurally cannot reach it. Two mechanisms, very different costs — DESIGN open problem 6. |
| Packaging | Needs `electron-builder`. New dependency, and the build produces something you would sign and hand out. |
| Replay scrubber | Deferred pending evidence anyone wants it. Still no evidence. |
| Polyglot: tree-sitter provider **or** consume desloppify's findings | Two different products. The second makes us a consumer of theirs. |

| Genuinely large | Size |
| --- | --- |
| Stable node identity across renames | DESIGN open problem 1. Touches identity everywhere; the longer it waits the worse it gets. |
| Symbol-level depth in the tree | ~10× the nodes; needs the expand-on-demand path first. |
| D5 embeddings | A model dependency and the hardest findings to evidence. |
| A genuine cross-model disagreement (P13) | Cannot be built, only encountered. |

---

## P10 — Guard

*Make the invariants fail a build instead of being documentation with extra steps.*

- [x] `vds check <repo>` — invariants + target together, exit non-zero on any red invariant
      or target violation. Composes the existing paths; no new analysis.
- [x] `--warn-only`, documented as the way to adopt.
- [x] `--format json`, plus a `PASS/WARN/FAIL:` summary line CI can annotate with.
- [x] `.github/workflows/check.yml` — typecheck, `pnpm test:all`, then `check --warn-only`,
      uploading the map as an artifact.
- [x] Documented in DESIGN.md: adding an already-red invariant **should** break the branch
      that adds it. The alternative is a permanently red main everyone learns to ignore.
- [x] `check` reads the cached `graph.json` when present and otherwise extracts through the
      parse cache, so CI is seconds rather than a second full parse.
- [x] **Test:** `engine/test/check.ts` — 12 assertions on exit codes, built against a
      throwaway repo it deliberately breaks. Exit code is the only part CI reads.

**Gate:** ✅ a deliberately-broken invariant exits 1; `--warn-only` exits 0 and still reports;
a target violation fails on its own with no invariants present.

---

## P11 — Adjudicate the taxonomy

*P8 produces dead-code candidates and nothing routes them to anyone. Wire the loop.*

- [x] `structure.json` findings feed the frontier: dead candidates, cycles, limbs, god nodes.
      Threaded through every caller (MCP, driver, focus-stack heat), not just one.
- [x] Tier *multiplies* the score rather than merely sorting, so a confident candidate in a
      depended-on file outranks a low-tier guess at a leaf.
- [x] Each question states its traps — the dead-code one names dynamic import, registries,
      DI, decorators, framework conventions, reflection, test-only use and public API.
- [x] `liveness_verdict`, `cycle_verdict`, `limb_verdict`, `god_verdict` — all boolean, all
      in the polarity table, so none of them routes around the evidence economics.
- [x] Findings panel has a Structure tab: reachability, tiered dead candidates with their
      caveat, cycles, limbs, most-depended-upon, and any adjudicated verdict.
- [x] `patterns` now feed the clustering prompt as shared-role hints, which is what they
      were always documented to be.
- [x] `propose_invariant` leads somewhere: `vds adopt` reviews proposals, refuses any that
      is already red, and writes the rest to the repo's invariant file. Deliberately a
      human-run step — an agent does not get to add to your build gate unattended.
- [x] **Test:** `engine/test/frontier.ts` — 12 assertions covering routing, ranking, the
      boolean requirement per predicate, and that an arbitrated finding leaves the queue.

**Gate:** ✅ closed live — an agent's proposed invariant (*"nothing under `engine/scene/`
calls a randomness source"*) was adopted after verification and is now in the build gate,
6/6 green.

Fixed along the way: `evaluate()` had no default case, so an unrecognised predicate returned
`undefined` and crashed every caller — including `check`. Malformed invariants are expected
input when agents can propose them, so it now fails loudly and says which types are valid.
The MCP tool also accepts a stringified predicate, which is what agents actually send.

---

## P12 — Team layer

*The map is one person's local artifact until the confirmed layer is committed.*

- [x] `.codemap/` is the committed layer — `knowledge.json` and `ARCHITECTURE.md`. The
      derivable graph, the parse cache and agent transcripts stay in the gitignored `./out`.
- [x] Committed: claims with provenance, clusters, elisions, defences. `--confirmed-only`
      narrows to human knowledge. Machine-local session ids are stripped; the tool and model
      that made a claim are kept, because that is what corroboration counts.
- [x] Deterministic: ordered keys, content-sorted records, no run timestamps. Verified byte
      identical across consecutive exports — a file that churns is a file nobody commits.
- [x] Merge is a union of append-only facts keyed by content, so re-import is a no-op and
      genuine divergence surfaces as CONTRADICTED rather than one side silently winning.
- [x] `observedHash` travels with the claim, so knowledge confirmed on another checkout goes
      STALE on yours when the file differs.
- [x] `ARCHITECTURE.md` — subsystem table with purposes, an L3 Mermaid diagram, invariant
      status, and what was elided to get there. Renders in a PR with nothing installed.
- [x] **Test:** `engine/test/share.ts` — 18 assertions on determinism, round-trip losslessness,
      re-import as a no-op, divergence surfacing, and imported claims crossing the same
      evidence boundary as any other.

**Gate:** ✅ a second store imports the first's knowledge, sees the clusters, does not double
on re-import, and surfaces disagreement when the two diverge.

Fixed along the way: `at` was stamped at insert, so a shared fact looked newer on every
machine it reached and the round-trip was not lossless. Assertion time now travels with the
claim, because it belongs to whoever made it.

---

## P13 — Finish the swarm

*Two adapters unusable, and the multi-model gate never actually demonstrated.*

- [x] `codex`: **investigated and closed as blocked.** Verified two independent ways — a
      per-invocation `-c mcp_servers.*` override, and a persistent `codex mcp add`
      registration in an isolated `CODEX_HOME` (your real `~/.codex` was never touched). In
      both, codex discovers the tools and answers every call `user cancelled MCP tool call`.
      No `approval_policy` value reaches it. The only bypass also removes the read-only
      sandbox, so the adapter stays as it is and this is documented rather than weakened.
- [x] `grok`: adapter flags verified against the installed binary — it runs headlessly and
      returns JSON. MCP registration remains untested because it would mutate your config.
- [x] `opencode`: same, verified running. Its JSON reports *per-message* `cost`, the opposite
      of claude's running total, which `readSpend` now handles.
- [x] Budget ceilings: `--max-cost` kills a run whose reported spend passes the cap and
      refuses to launch the next adapter once the run has spent it. Enforced between
      launches as well as during one, because most CLIs only report cost when they finish.
- [x] Cost parsing generalised: claude totals, generic `cost_usd`, and opencode's additive
      per-message costs, tolerant of adapters that report nothing.
- [x] `--concurrency` caps how many agents run at once; sequential by default.
- [x] **Test:** `engine/test/budget.ts` — 8 assertions on spend parsing, including that
      cumulative totals do not compound, per-message costs do, and unparsable output yields
      zero rather than silently defeating the ceiling.
- [ ] **Still open, and now attempted: two *different models* disagreeing on substance.**
      Ran it live — five runs, `claude` on `haiku` and `sonnet`, $3.13. No substantive
      disagreement occurred, and none was manufactured. What the attempt did establish:
      - **Assignments were not binding, and that is now fixed.** Handed a `god_verdict`
        question, agents answered with a `purpose` claim about the same file — a different,
        easier question — and the prompt never said otherwise. The scheduler's ranking, its
        leases and its convergence signal all assume the assigned question is the one
        answered, so all three were advisory. The prompt now names the expected predicate and
        says stopping early is not the same as answering something else.
        **Test:** `engine/test/frontier.ts`, +6.
      - **Narrative predicates cannot produce this gate.** Agents overwhelmingly write
        `purpose`, which corroborates rather than contradicts by design — correctly. The gate
        needs a *verdict* question, and those are a small share of the frontier on a
        well-explored repo.
      - **Verdict questions are expensive.** Two runs burned 20 turns and timed out at 300s
        without submitting: reading a large file and forming an architectural judgement does
        not fit the explore-mode budget. Worth its own item if this is retried.
      - **`--max-cost` overshoots on `claude`**, by design and now measured: a $0.80 cap
        stopped a run that had already spent $1.11, because the CLI only reports cost when it
        finishes. Documented behaviour, first time quantified.

**Gate:** ⚠️ mechanism demonstrated live end to end; a genuine cross-model disagreement has
been *attempted* and did not occur. Whether two models differ on a given question is not
something the harness can force, and forcing it is the one thing that would make the gate
worthless. Left open deliberately.

Also fixed here: the MCP server threw an unexplained error when `graph.json` was missing, so
every tool showed as "unavailable" with no reason — indistinguishable from the host refusing
them, which cost an evening of misdiagnosis with codex. It now says what is wrong, and
accepts the directory as an argument for hosts that do not pass environment through.

---

## Backlog

Ordered loosely by value, not scheduled.

### Extraction
- [x] **Stable identity across renames and moves.** Not a content-addressed node id — content
      changes constantly, so that trades a rare failure for a continuous one, and it would
      rewrite identity everywhere to fix a problem that only exists at the claim layer. The
      graph keeps path identity; `map` compares this run's fingerprints against last run's and
      detects moves the way git does. A file's fingerprint is the elementwise minimum of its
      functions' body signatures — which *is* the MinHash of their union, so it falls out of
      what D4 already computes — plus the set of names it declares. Both must agree: structure
      alone matches a file that was rewritten wholesale, names alone match any two siblings.
      Matches migrate claims, evidence paths, defences and cluster membership in place,
      keeping the original assertion time and source, because a move is not new knowledge and
      must not look like it. Splits and merges are reported as ambiguous and left alone —
      guessing would attach a human's confirmed knowledge to a file they never examined.
      **Test:** `engine/test/identity.ts` (33), leaning on what must be *refused*.
- [x] **The polyglot seam is real and tested. A second grammar still needs your call on a
      dependency.** The schema was always language-neutral, but `extract()` constructed a
      `TypeScriptParser` directly, so the interface had one implementation and was therefore a
      guess about what a second would need. Files now dispatch to whichever provider claims
      their extension, several coexist, and the parse cache is keyed per provider so two
      cannot hand each other's records back. `engine/test/registry.ts` drives a deliberately
      non-TypeScript provider through to edges, cross-language imports and detector findings.
      Writing it immediately found two places the "language-neutral" schema was not:
      `GraphNode.endLine` and `LiteralRecord.callee` were required, which only a full-fidelity
      AST can supply. Both are optional now.
      `VDS_PARSERS` loads additional providers. **Loading one runs its code** — it is a plugin
      surface by construction, so it is opt-in, it names what it loaded, a failure is reported
      rather than swallowed, and a provider may not take over an extension another already
      claims. What remains is picking the grammar: tree-sitter is a dependency, and consuming
      desloppify's 29 languages makes us a consumer of their tool. **Both are your call.**
      **Test:** `engine/test/registry.ts` (20).
- [x] Symbol-level depth in the tree, expand-on-demand. **alt**-click a file and it opens to
      show what it declares; alt-click again and it shuts. On the modifier rather than a plain
      click because selecting a file is the common act, and relaying out the tree under the
      cursor every time you inspect something would be hostile.
      The load-bearing property is that opening a file **moves nothing else**: a file keeps
      its spread whether open or shut, so its parent's disc does not resize and no sibling
      subtree shifts. A deterministic layout only buys spatial memory if the tree stays put,
      and rearranging it when you ask about one file trades that away for tidier packing.
      Symbols may crowd a neighbour with several files open, which is much the cheaper
      failure. Symbols render smaller and in one colour across every channel — they carry no
      belief or heat of their own, and painting them "unknown" would read as a finding rather
      than as a level of detail. **Test:** `engine/test/scene.ts`, +12.
- [x] Watch mode: a **Watch** toggle re-maps on code change, debounced 1.2s because editors
      write in bursts. Only changed files re-parse, so the loop the product exists to shorten
      now closes without anyone pressing a button.
- [x] `vite.config.ts` belongs to the renderer, which owns its own build config. The target
      is now `strict` and every file is claimed.

### Findings
- [x] **D4** — copy-paste bodies via token-shingle MinHash. Built natively rather than
      wrapping `jscpd`: we already parse every file, and a signature computed during that
      parse rides the existing content-addressed cache instead of adding a second full pass
      and a dependency. Identifiers and literals are erased, so a copy survives a rename —
      which is the case D2 and D3 structurally cannot see. Candidate pairs come from LSH
      banding, not an N² sweep. Clean on this repo; on the fixture it found 21 pairs,
      including `getNewestMtime` copied verbatim between two build scripts and five
      `add*Node` handlers in one file that want to be one parameterised function.
      A D4 link alone forms a family — it is the only detector that read the code rather
      than its label. **Test:** `engine/test/duplication.ts` (19).
- [x] **D5** — near-duplicate purpose. The only detector that reads what a module is *for*
      rather than what it looks like, and so the only one that can see two subsystems doing
      the same job under entirely different vocabulary. Its input is the `purpose` claims the
      swarm has already written, which means it finds nothing on an unexplored map — the one
      detector whose silence means "nobody has looked yet" rather than "there is nothing
      here". A pair is only reported if the two files are **not already connected**: same
      directory, or an import either way, means they are one subsystem and describe themselves
      alike for a reason another detector already covers properly.
      Two scorers. TF-IDF cosine always runs, no dependency and nothing leaves the machine.
      Embeddings run only if `VDS_EMBED_URL` names an endpoint, loopback-only unless
      `VDS_EMBED_ALLOW_REMOTE=1` — a second deliberate act, because sending module purposes to
      a remote host means sending a description of your architecture over a network. It says
      what it is sending and where before it sends anything.
      Found a real defect here on the first run: two clusters whose purposes differ by one
      word (`exists` vs `is wired`), which should be one cluster.
      **Test:** `engine/test/purpose.ts` (40), including a real loopback endpoint.
- [x] Community detection via label propagation — deterministic by hash tie-break, because a
      map that reshuffles every run cannot be navigated from memory. Reports cohesive groups
      *filed across several directories*; a cohesive group inside one directory is a tidy
      module and says nothing. On this repo it independently rediscovered the engine/renderer
      split we had declared by hand. **Test:** `engine/test/communities.ts` (9).
- [x] Tree divergence — per-file gap between where a file is filed and where it is wired,
      with the directory it actually belongs to. Distinct from a weird limb, which is a whole
      subtree. Found `App.tsx`: filed in `lib`, 78% wired to `lib/panels`.
- [x] God nodes rank by fan-in × churn where git history exists, degrading to fan-in where it
      does not rather than pretending. Puts `claims.ts` (10 × 5) above `graph/types.ts`
      (15 × 1), which is right — types barely change, so depending on them costs nothing.
- [x] Calibrate similarity thresholds against the fixture. `engine/tools/calibrate.ts` sweeps
      every threshold across all three fixture points and scores each setting on what it finds
      versus how much it reports. The map does get quieter as the codebase is remediated —
      17.8 → 14.4 families per 100 files — which raw counts would have shown backwards, since
      HEAD is a bigger repo. Thresholds are staying put, but now by decision: the quieter
      setting the sweep nominates also discards the whole 0.6–0.8 band that D1 exists for, and
      one labelled pair cannot tell quieter from blinder. `minTypedScore` turned out to be a
      knob that does not turn. **Test:** `engine/test/calibrate.ts` (16), which caught the
      scorer counting one symbol as both halves of a pair.
- [x] **D6 — parallel implementations.** The detector calibration asked for. D1–D4 all work at
      the symbol level and all correctly refuse the fixture's headline duplication; the signal
      was at the file level, in *which* names two files share rather than how many. Each shared
      name is weighted by how rare it is, so `delete` in seventeen files counts for nothing and
      `getParticipants` in two counts for a great deal. Two scores, qualifying on either — a
      weighted Jaccard for near-identical surfaces, and shared-rare-name mass for the case
      where one side grew, which is what `ChatRepository` did and what sank its overlap to
      0.24. The rare-mass score is expressed in units of the rarest name a codebase can have,
      so it means the same thing in a repo of any size.
      On the fixture the two known pairs rank first (6.7) and second (5.0) at pre-collapse
      against a next-best of 3.7, and both are gone at HEAD. Silent on this repo.
      **Test:** `engine/test/parallel.ts` (24), including twelve repositories sharing CRUD
      producing zero pairs, and a class not pairing with its own subclass.
- [x] `knip` and `dependency-cruiser` cross-check our reachability when the analysed repo
      already has them. **Nothing is ever installed** — a provider is used only if it resolves
      from that repo's own `node_modules/.bin`, never through `npx`, which would fetch and
      execute a package from the network on a repo we were only asked to read. Absent is the
      normal answer and reports as such. Their output is untrusted input: bounded, parsed
      defensively, and only able to name files we already found — a provider can corroborate
      or dispute a node, never introduce one. Results stay in three buckets rather than one
      merged verdict, because the two disagreements mean different things: what only we flag
      is our syntactic resolution being over-eager, what only they flag is a caller we
      resolved and they did not. **Test:** `engine/test/providers.ts` (22), including
      traversal and absolute paths in provider output, and a pathological nesting depth.

### Agents and claims
- [x] Legacy verdict claims are re-collected rather than coerced. Guessing the polarity of
      `duplicates: "false — these are NOT duplicates"` would fabricate a verdict nobody gave,
      which is the exact failure the boolean rule exists to prevent. So they are made visible
      instead: `import` reports them apart from malformed input, and the frontier asks each
      subject again — carrying the original claim's evidence, so the second answer costs far
      less than the first because the search has already been done.
      **Tests:** `engine/test/share.ts` +8, `engine/test/frontier.ts` +6.
- [x] `get_focus_state` now emits, so no read tool is invisible in the live feed.
- [x] Two clusters sharing a name now resolve to neither, rather than an elision silently
      landing in whichever was registered last.
- [x] Frontier convergence: `converged()` reports when nothing scores above a floor, and the
      driver says so — "further runs would be paying to answer questions nobody needs
      answered". A floor rather than an empty queue, because the tail is always populated.

### Interface
- [x] Scene refits when the panel resizes, so dragging the splitter no longer silently
      zooms — which in graph mode would also have changed which level you were looking at.
- [x] Replay scrubber over `events.jsonl`. The map already shows the swarm working — markers
      moving, nodes pulsing — but only while it happens, which is exactly when nobody is
      watching. Play, step, scrub, and speed from 1× to 600× or one-event-per-tick; real gaps
      are divided by the speed so the run's rhythm survives while the dead air compresses,
      clamped so a four-minute pause does not stall the bar.
      Live and replayed events go through **one bus**, so the scene cannot tell which it is
      drawing — a replay rendered by a second code path drifts, and then it stops being a
      picture of what happened. Scrubbing backwards resets and refeeds rather than undoing,
      because undo needs every consumer to be correct in reverse as well as forwards. Entering
      replay withholds the live feed and says so; blending the two would draw a state the run
      never passed through. Timing and the bus live in `engine/replay/`, since neither touches
      the screen. **Test:** `engine/test/replay.ts` (31), against the real `events.jsonl` shape.
- [x] Findings adjudicates in place: a verdict pill on a family or a dead candidate is now
      the button that opens arbitration, so acting on a disagreement starts where the
      evidence is rather than after finding the same subject again in Review.
- [x] Invariant authoring UI. Six predicate shapes as a form, each with a sentence saying
      what it is for, and a **Check against the map** button that evaluates the candidate
      without saving it. The preview is the point: the design says an already-red invariant
      *should* break the branch that adds it, and without a way to look first that rule
      punishes you for finding out. Red is still savable, and the form says why you might.
      The vocabulary lives in `engine/invariants/shapes.ts` rather than the renderer, because
      it *is* the predicate language stated in the terms a person writes it in — an agent
      proposing an invariant should be offered the same shapes. Writing is the only change
      this tool makes to a codebase it analyses, so `engine/invariants/save.ts` owns every
      rule about it: fixed filename, merge not overwrite, and a refusal to touch an existing
      file that does not parse, since that may be someone's unfinished work.
      **Test:** `engine/test/shapes.ts` (39), plus a live round-trip — preview red, save
      narrower, gate picks it up.

### Operations
- [x] **`pnpm package` builds a portable directory. An installer is still your call.** It
      uses only what is already installed: Electron ships its own Node and the main process
      already falls back to it, so the target machine needs nothing preinstalled. 347MB, one
      second, launches with `./vds`. Verified by running the built directory outside the repo
      — it came up and drew the map, 62 nodes with the agent-named clusters and the claim
      store loaded.
      That run is what caught the bug: the manifest declared `commonjs` because the entry is
      `main.cjs`, and `.cjs` is CommonJS whatever a manifest says — so the entry loaded, the
      window opened, and every engine operation failed, since the engine is ESM and the app
      had said otherwise. The manifest is a function with a test now.
      A `.deb`, `.dmg` or AppImage needs `electron-builder`, and a build anyone should trust
      needs signing. **Both are decisions with consequences outside this repo.**
      **Test:** `engine/test/package.ts` (13), including that the runtime dependency list
      matches what the engine actually imports.
- [x] `engine/test/extract.ts` (38) and `engine/test/structure.ts` (15) close the gap.
      Both shipped bugs have a named regression case: the tsconfig `/*` that disabled every
      path alias, and the missing `NewExpression` that hid every instantiation.
      Suite is now **269 assertions across 12 files**, all run by `pnpm test:all`:
      `extract` (38), `structure` (23), `duplication` (19), `calibrate` (16), `shapes` (39),
      `providers` (22), `communities` (9), `smoke` (28), `scene` (11), `frontier` (18),
      `share` (26), `budget` (8), `check` (12).
- [x] `--include-tests` is still off by default — tests double the node count and duplicate
      each other by nature — but excluding them from the *map* no longer excludes them from
      *reachability*. It did, and the tool was confidently wrong because of it: on the fixture
      all 11 high-tier dead candidates were live code whose only visible callers sat in files
      the walk had refused to open. Tests are now parsed for their imports alone, kept in
      `graph.testImports` rather than `graph.edges` so a test edge cannot satisfy a
      forbidden-call invariant or draw a line in the tree. A file the tests reach is still
      reported — "exists only to be tested" is a real finding — but at `low` tier saying so.
      Symbol-level test usage still needs the flag, and the candidate now says that too.
      **Test:** `engine/test/structure.ts`, +9.

---

## Known limitations (documented, not bugs)

- **Read-only by design.** Task packets are generated; nothing executes them.
- **TS/JS only.** The schema is language-neutral; the only parser is not.
- **Syntactic resolution.** No type information, so an unreferenced export is a candidate
  rather than a verdict, and `low` tier means exactly that.
- **`grok`/`opencode` need a one-time `mcp add`** you run yourself. The harness will not
  mutate your agent config.
- **Invariants belong to the analysed repo.** A repo with none reports `UNPROVEN` rather than
  failing, which is correct and not a gap.
