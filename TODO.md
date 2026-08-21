# TODO

Everything outstanding, in the order I would do it. Rationale for the phase ordering lives in
[DESIGN.md](DESIGN.md); this is the working list.

**Status:** P0–P14 built, **every gate closed**, backlog empty. This repo maps itself clean:
0 D4 pairs, 0 D6 pairs. Invariants 6/6 green, target passing. Suite is **605 assertions across
23 files** (`pnpm test:all`).

P14 closed the last gate that could only be *encountered* rather than built — and found that
the reason it had never been encountered was a bug in this tool, not a property of models.

The last gate closed by running it rather than reasoning about it, and running it found three
bugs that reading never would have — including one that had made the contradiction queue, the
screen this design calls its highest-value surface, unreachable for verdicts since the boolean
rule landed. See P13.

### Fixed since
- [x] **`pnpm gui` showed you a map while insisting no repo was selected.** The window opens
      on the default `./out`, which usually holds a perfectly good map — but `state.repo` was
      null until someone used the file picker, and Map, Run agents, Rebuild and Watch are all
      gated on it. So the whole action bar was dead in front of a map that had loaded fine,
      and the only way out was to go and choose the repo it was already displaying.

      It never needed asking. An output directory belongs to exactly one repository — an
      invariant the tool enforces at `map` time and refuses to violate — and the map records
      which one. The shell now reads it back from `view.json` on startup and whenever the
      output directory changes. `view.json` specifically: it is the small file, and
      `graph.json` is hundreds of megabytes on a large repo.

      A root that is no longer on disk is *not* adopted, because that hands every agent a cwd
      that is not there and fails several steps later as something unrecognisable. That case
      says so in a banner naming the path, rather than leaving a dead button with no reason —
      which was the original bug wearing a different hat.
      **Test:** `engine/test/isolation.ts` +5, pinning the `view.json` contract the shell
      depends on, since the shell itself cannot be reached from the suite.

- [x] **Switching repos showed the previous repo's map**, because picking a repo left the
      output directory pointing at the old one. The visible half of a much worse bug: claims
      address files by repo-relative path with no repo in them, so one output directory across
      two projects re-indexes one codebase's confirmed knowledge onto the other's
      identically-named files — and the rename detector migrates them there on purpose. A
      human claim about repo A's `src/Store.ts` landed on repo B's `src/Cache.ts`.
      Fingerprints now record their repo, `map` refuses a directory holding another repo's
      graph (`--force` for the same repo moved), and the GUI derives a per-repo directory
      unless you chose one. **Test:** `engine/test/isolation.ts` (20).

- [x] **Nodes can be dragged.** A deterministic layout is what makes the map memorable, but
      it cannot help in a region dense enough that nodes overlap — which is exactly where you
      are trying to follow an edge. A drag that starts on a node moves it; one that starts on
      empty space still orbits; `ctrl` forces orbit for the case where the dense region leaves
      no empty space to start from. Positions persist per repo, keyed by node id, so a re-map
      keeps every override still pointing at something real and forgets the rest.
      **Test:** `engine/test/scene.ts` +13, plus `VDS_SHOT_DRAG` which drives a real pointer
      drag headlessly — raycasting against a camera-derived plane is not something reading the
      code can verify.
- [x] **Frame meter and per-machine render settings**, and the measurement that answered
      whether LOD was needed at all. It was not: 14,651 nodes at 92–107fps on an *integrated*
      GPU. The default is now to draw everything and let the machine object.
- [x] **The discrete GPU was idle.** `pnpm gui:dgpu` gets the 4080 — 143fps against 93 — via
      XWayland and ANGLE-over-GL. Native Wayland cannot, because the compositor's buffers
      cannot be imported by NVIDIA. The meter says when a card is sitting idle.

### Still needing a decision from you

All built and working; each stops at a choice that costs something outside this repo:

| Built | Where it stops |
| --- | --- |
| Polyglot seam | Dispatch, coexistence, per-provider caching and an opt-in loader all work, with a non-TypeScript provider driven end to end in the tests. A *real* second grammar means a tree-sitter dependency, or becoming a consumer of desloppify's output. |
| Packaging | `pnpm package` builds a portable directory that runs standalone, verified outside the repo. A `.deb`/`.dmg`/AppImage needs `electron-builder`; a build anyone should trust needs signing. |
| D5 embeddings | The lexical scorer runs always and locally. The embedding backend needs an endpoint you point it at, and refuses a remote host until you say so twice. |

--- | --- |
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
- [x] **Two different models disagreeing on substance — happened, live.** On
      `engine/store/claims.ts`, asked whether 11 dependents mean cohesion or a missing split:
      **sonnet said split (true, 0.95), haiku said the fan-in is appropriate (false, 0.92)**,
      both heavily evidenced, both reached independently through the ordinary frontier flow.
      Nobody was told what to conclude.
      It is a *good* disagreement: they reason on different axes. Sonnet looks at what the
      file **exports** — a class, a pure `canonicalise`, an error type — and calls that three
      concepts. Haiku looks at what the **data** is — one SQLite ledger, five tables, one
      responsibility — and calls that one thing. The arbitration screen characterised it
      correctly without being asked to: *"No shared evidence. The sides looked at different
      places, so neither is necessarily wrong — this is more likely an incomplete search than
      a real disagreement."*
      Getting there needed two bugs fixed, both found only by running it:
      - **No verdict claim could be submitted at all.** An agent assigned a `god_verdict`
        question answered it fifteen times and was rejected fifteen times — the boundary
        demanded a boolean and the agent sent `"true"`, a boolean that had been through a JSON
        boundary. The rule stays (prose carrying a verdict is still rejected, which is what it
        is for) but a bare `"true"`/`"false"` is now accepted. **The contradiction queue — the
        screen this design calls its highest-value surface — had been unreachable for verdicts
        since the boolean rule landed.** That, not model agreement, is why this had never been
        seen.
      - **Two concurrent agents crashed on `database is locked`**, in a product whose premise
        is a swarm with leasing. SQLite defaulted to one writer and no waiting. WAL plus a busy
        timeout; writes still serialise, they queue instead of failing.
      - Assignments were also not binding — agents answered an easier question than the one
        they were given, making the ranking, the leases and the convergence signal advisory.
      **Tests:** `engine/test/smoke.ts` +14, `engine/test/frontier.ts` +6.
      Cost of the whole exercise: **$5.62** across nine runs on `haiku` and `sonnet`.

**Gate:** ✅ closed live. Two different models reached opposite, evidenced verdicts on the same
subject, the contradiction was routed to the top of the frontier at score 1.304, and the
arbitration screen named which *kind* of disagreement it was. Nothing was manufactured — the
question came from the scheduler and each model read the code and formed its own view.

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

---

## P14 — Launching and watching a swarm

*The product could drive four agent CLIs and had only ever driven one, because the launch
surface hardcoded it and the claim store could not tell them apart anyway.*

- [x] **Every claim recorded the same source.** `drive()` wrote one MCP config per run with
      `VDS_AGENT` hardcoded to the literal `'multi'`, and pointed every adapter at it. So
      `source_tool` was `multi` for 100% of claims in a live store — and since
      `ClaimStore.belief` counts independent sources as `kind:tool:model`, an entire swarm
      collapsed into one source. Nothing could reach CORROBORATED, no two agents could ever
      be seen to disagree, and `frontier` kept residual uncertainty on every belief forever.
      It failed silently and expensively: claims landed, counters went up, the panel filled
      with activity, and none of it could be checked. One config per roster entry now, with
      that entry's own tool, model and session.
      **Test:** `engine/test/provenance.ts` (23).

- [x] **The roster is a list of `tool:model` pairs, not a set of tools.** The pair is the
      provenance key, so claude-on-sonnet and claude-on-opus are two sources and two runs of
      one model are one. `--tools claude:sonnet,claude:opus,codex`. Duplicate entries are
      dropped and named as duplicates — a second identical entry costs a full agent run and
      moves no belief.

- [x] **A run that cannot corroborate says so before it spends anything.** `sourceDiversity`
      is computed at plan time and surfaced in the launcher, the CLI and the ledger.

- [x] **codex works.** It had been documented for months as unable to reach an MCP server
      headlessly — every call returned `user cancelled MCP tool call`, with no user and no
      approval prompt reachable in `exec`. The cause was ours: our tools carried no MCP
      `annotations`, so a non-interactive host had nothing to decide from and defaulted to
      refusing. Declaring `readOnlyHint` on the reads and `destructiveHint: false` on the
      writes is enough. Verified end to end — reads return and a `submit_claim` lands with
      `source_tool = codex` — under codex's *default* approval policy, inside its `read-only`
      sandbox, with no `--dangerously-*` flag. `approval_policy = "never"` was tried and is
      not needed, so it is not set.

      Worth stating plainly, because it is the same mistake this tool exists to catch:
      *"the other tool is broken" was a claim we had not evidenced.*

- [x] **A launch panel instead of two buttons.** Roster rows with per-row model, mode, batch,
      concurrency, cost ceiling, dry run. Adapter availability is measured rather than
      assumed — `vds adapters` spawns each binary and asks it what models it has
      (`grok models`, `opencode models`, and claude's own `--help`), and reports the ones
      that cannot be asked as unknown rather than filling the gap in. An unauthenticated
      binary is caught here rather than several minutes into a paid run.

- [x] **`--max-cost` and `--concurrency` reach the GUI.** Both were parsed by the CLI and
      dropped by the IPC handler, so the one control that stops a run costing more than you
      meant was unreachable from the only surface that launches runs.

- [x] **`--spread`.** Split the frontier across the roster instead of asking everyone the
      same questions. Off by default and labelled with what it costs: it covers more ground
      per dollar and corroborates nothing.

- [x] **The live spend meter was watching for output that never arrived.** The engine buffers
      each agent's stdout rather than forwarding it — correct, three interleaved streams are
      unreadable — so the app scraped `total_cost_usd` from a pipe that by construction never
      carried it. And had it carried it, the app took the *maximum*, which reads two agents
      spending \$1.01 and \$1.75 concurrently as a \$1.75 run. There is now a per-source
      progress channel, and the app sums it.

- [x] **A run ledger that survives the app.** A finished run used to report itself in a toast
      that vanished on the next one. `runs.jsonl` records what each run cost and what it
      bought, so *was the third source worth it* is answerable after the fact. `costKnown` is
      false when any CLI reported no spend at all — codex reports tokens and no price, which
      makes a total a floor and makes a ceiling unenforceable against it.

- [x] **A Quality panel, and `vds quality`.** The signals all existed on four different
      screens, and every one of them goes up when work happens rather than when the work was
      good. This is one surface that leads with **what is wrong with this map**: named
      weaknesses, sorted by how badly each undermines acting on it, each with the fix where
      there is an honest one. The headline number is not how many claims there are but how
      many anything ever checked — and "checked twice" is reported separately from "agreed
      twice", because a discovered disagreement is not a success.
      **Test:** `engine/test/quality.ts` (28).

**Gate:** ✅ **closed live, and it is the P13 gate too.** A three-source run
(`claude:sonnet`, `claude:opus`, `codex`) on this repo produced a genuine cross-model
disagreement on `engine/store/claims.ts` / `god_verdict` — the one thing DESIGN said could
not be built, only encountered. codex says it *is* a god node that should be split;
claude/sonnet and claude/opus say it is not; a later run added claude/haiku, which sides with
codex. The store recorded it CONTRADICTED rather than taking the 2–1 majority.

The split is not by vendor. haiku and codex count *responsibilities* — five tables, a lease
API, a migration path, an explicit `---- focus operations (P3)` divider. sonnet and opus
count *ownership* — one class, one `DatabaseSync` handle, one schema, and a `migrateSubject`
that has to rewrite four tables together and therefore cannot live anywhere else. opus filed
its verdict at 0.72 and named the strongest point against itself in its own evidence.

Both sides cite the same lines: 150, 388, 504, 584. Per the design, same evidence and
opposite conclusions is a judgement call a person has to make — which is exactly what the
arbitration screen is for, and the first time it has had a real one to show.

**This had never happened before, and the reason was not that models agree.** It was that
every agent was recorded as the same source, so the store had nothing to compare.

---

## Driven end to end on a second repo

*A Next.js incremental game, 23 files, 471 symbols, a store the tool had never seen.*

Worth recording because it is the first time the whole loop ran on something unfamiliar, and
because two of the three things it found were bugs in **this** tool rather than in the game.

**The honesty machinery held.** 3 of 23 files reachable from 3 entrypoints — Next.js reaches
`app/layout.tsx` and `app/page.tsx` by convention, not by import, which is exactly the trap the
dead-code question names. All 20 candidates were capped to medium, zero high, with the
reachability caveat attached. Three agents then read one of them and ruled it *alive* at
0.97–0.99, corroborated three ways.

**Corroboration works now, and the number says so.** From an empty store: 18 claims, 6 beliefs,
**6 of 6 checked by more than one source** — 5 CORROBORATED, 1 CONTRADICTED. Before the
provenance fix that figure could not have exceeded zero on any repo, ever.

**The god-node disagreement reproduces.** codex called `src/lib/game/store.ts` a god node at
0.90; claude/sonnet and claude/opus said it was not, at 0.75 and 0.78. The same split, on the
same predicate, on an unrelated codebase — which makes it a systematic difference in how these
models judge cohesion rather than a one-off about `claims.ts`.

### Found, and fixed

- [x] **Agent prose arrived HTML-escaped from some models and not others.** In one focus run
      `claude/opus` submitted `Client Boundary &amp; Bootstrap` while `claude/sonnet` submitted
      `Render & Input Pipeline`. It rendered wrong, and worse, two names that should compare
      equal did not — the same failure the store already refuses to have for predicates.
      Normalised at the MCP boundary, where agent text arrives. Ingest-time only, so claims
      written before it keep the escaped form; the store is append-only and that is the point.
      **Test:** `engine/test/provenance.ts` +8.

- [x] **A dry run leased fifteen minutes of the best questions** for an agent it was never
      going to spawn, and so did a run whose entire roster turned out to be uninstalled.

### Found, and needs a decision

- [ ] **Nothing reconciles clusters proposed by different sources.** Three agents produced 17
      clusters describing roughly five subsystems. Eight cross-source pairs overlap at Jaccard
      0.50–0.80:

      | overlap | | |
      | --- | --- | --- |
      | 0.80 | `Render & Input Pipeline` (sonnet) | `Photography Surface` (opus) |
      | 0.80 | `Meta-Progression & Session-Boundary UI` (sonnet) | `Between-Runs Layer` (opus) |
      | 0.75 | `Persistent Progression UI` (codex) | `Between-Runs Layer` (opus) |
      | 0.67 | `Balance & Cast Ledger` (opus) | `Sim Core` (sonnet) |
      | 0.67 | `Web Application Entry` (codex) | `App Entry` (sonnet) |

      The result inverts the stack: **L3 came out with 11 nodes against L2's 8**, when L3 is
      supposed to be the collapsed architecture level. Focus was built for one focusing agent
      and now has three, and more sources currently make the top of the map *worse*.

      This is D5's own question — "two modules described as doing the same job in different
      words" — asked about clusters instead of modules, and D5 does not run over them. The
      decision is what to do once they are detected, and the options are not equivalent:
      merge them automatically (fast, and averages away exactly the disagreement this design
      preserves everywhere else); route the overlap to arbitration as a cluster-level
      contradiction (consistent with the rest of the product, more human work); or run each
      source's focus as a separate candidate stack and let a person pick one (honest, but
      abandons the idea of a single shared map).

      Until it is decided, **run Focus with one source and Explore with several.** Explore
      corroborates because the questions are fixed and the answers are comparable. Focus
      proposes, and three proposals are three maps.
