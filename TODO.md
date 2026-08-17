# TODO

Everything outstanding, in the order I would do it. Rationale for the phase ordering lives in
[DESIGN.md](DESIGN.md); this is the working list.

Status as of the last session: **P0–P9 built**, all gates passed except the two noted under
P13. This repo maps itself clean — 0 duplication pairs, invariants 5/5 green, target passing.

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
- [ ] **Still open:** two *different models* disagreeing on substance, live. The path itself
      has now run end to end in anger — two agents disagreed, the arbitration screen surfaced
      it, and it produced a real fix — but that contradiction turned out to be *false*
      (`sameConcept` vs `same_concept`). Forcing a substantive disagreement means paying for
      repeated runs and hoping, so it is left for a session where a real one occurs.

**Gate:** ⚠️ mechanism demonstrated live end to end; a genuine cross-model disagreement has
not yet occurred, and will not be manufactured.

Also fixed here: the MCP server threw an unexplained error when `graph.json` was missing, so
every tool showed as "unavailable" with no reason — indistinguishable from the host refusing
them, which cost an evening of misdiagnosis with codex. It now says what is wrong, and
accepts the directory as an argument for hosts that do not pass environment through.

---

## Backlog

Ordered loosely by value, not scheduled.

### Extraction
- [ ] **Stable node identity across renames and moves.** `path#Name` is fragile and breaks
      claim survival across exactly the refactors this tool recommends. Expensive to retrofit;
      the longer it waits the worse it gets. (DESIGN open problem 1.)
- [ ] Polyglot. Either a tree-sitter provider behind the existing `Parser` interface, or
      consume desloppify's 29-language findings instead of re-deriving them.
- [ ] Symbol-level depth in the tree, expand-on-demand (~10× the nodes, so it needs the
      expansion path first).
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
- [ ] **D5** — near-duplicate module purpose via embeddings. Deferred deliberately.
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
- [ ] **Naming a parallel implementation.** Calibration proved D1–D4 cannot reach
      `ChatRepository`/`ChannelRepository` at any threshold, and that each individual refusal
      is correct — the duplication is semantic, not syntactic. Two candidate mechanisms with
      very different costs, written up as DESIGN open problem 6. **Needs a decision, not code.**
- [ ] Wrap `knip` / `dependency-cruiser` as optional providers to cross-check our native
      reachability.

### Agents and claims
- [ ] Legacy verdict claims collected before the boolean rule are rejected on re-merge and
      need re-collecting, not coercing.
- [x] `get_focus_state` now emits, so no read tool is invisible in the live feed.
- [x] Two clusters sharing a name now resolve to neither, rather than an elision silently
      landing in whichever was registered last.
- [x] Frontier convergence: `converged()` reports when nothing scores above a floor, and the
      driver says so — "further runs would be paying to answer questions nobody needs
      answered". A floor rather than an empty queue, because the tail is always populated.

### Interface
- [x] Scene refits when the panel resizes, so dragging the splitter no longer silently
      zooms — which in graph mode would also have changed which level you were looking at.
- [ ] Replay scrubber over `events.jsonl`. Deferred pending evidence anyone wants it.
- [x] Findings adjudicates in place: a verdict pill on a family or a dead candidate is now
      the button that opens arbitration, so acting on a disagreement starts where the
      evidence is rather than after finding the same subject again in Review.
- [ ] Invariant authoring UI. They are hand-written JSON today.

### Operations
- [ ] Packaging. `pnpm gui` needs the repo checked out; there is no distributable build.
- [x] `engine/test/extract.ts` (38) and `engine/test/structure.ts` (15) close the gap.
      Both shipped bugs have a named regression case: the tsconfig `/*` that disabled every
      path alias, and the missing `NewExpression` that hid every instantiation.
      Suite is now 142 assertions across 8 files, all run by `pnpm test:all`.
- [ ] `--include-tests` is off by default, so test files never appear in any map.

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
