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

- [ ] Split output as the design specified: committed `.codemap/{graph,confirmed,target,
      findings}.json` versus gitignored `.codemap/.cache/`. Today everything lands in a
      gitignored `./out`.
- [ ] Decide what is committed. Confirmed claims and human arbitration, certainly. Agent
      claims — probably, with provenance. Raw traces — no.
- [ ] Deterministic serialisation: stable key order, no timestamps in committed files, or
      every run produces a diff and nobody will keep it.
- [ ] Merge semantics for two people confirming different things about one subject. The
      claim store already models disagreement; the file format needs to survive a git merge.
- [ ] `contentHash` staleness across machines — a claim confirmed on someone else's checkout
      must go STALE on yours if the file differs.
- [ ] Human-readable committed summary (Mermaid L3 + invariant status) so a PR reviewer sees
      the architecture change without running anything.

**Gate:** two clones converge on the same map; a cluster confirmed in one appears in the other.

---

## P13 — Finish the swarm

*Two adapters unusable, and the multi-model gate never actually demonstrated.*

- [ ] `codex`: MCP tool calls are auto-denied headlessly (`user cancelled MCP tool call`).
      `approval_policy="never"` and `"on-failure"` both fail; the only bypass also removes the
      read-only sandbox, which we will not do. Re-check against a current codex, or drive it
      through `codex app-server` instead of `exec`.
- [ ] `grok`: MCP configuration mechanism still unverified. `grok mcp add` exists; nothing has
      confirmed the server is reachable from a headless run.
- [ ] `opencode`: same — `opencode mcp add` is printed as a hint and never tested. Its
      `serve` HTTP API may be a better control channel than spawning.
- [ ] Budget ceilings. Spend is displayed but never enforced; the design promises a per-run
      cost cap and the driver has none. A run has already burned $2.11 and died at a timeout.
- [ ] Cost parsing is claude-specific (`total_cost_usd`, `num_turns`). Generalise per adapter.
- [ ] Demonstrate the actual P4 gate: two *different models* disagreeing live, arbitration
      resolving it. Both prior attempts agreed, so the CONTRADICTED path is only unit-tested.
- [ ] Concurrency policy: leases partition work, but nothing caps how many agents run at once.

**Gate:** two different models disagree on a real claim and arbitration resolves it.

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
- [ ] Watch mode: `derive` re-runs on claim changes, but a code change still needs a manual
      Map. The parse cache makes this cheap now.
- [ ] `vite.config.ts` is owned by no layer in our own target.

### Findings
- [ ] **D4** — copy-paste bodies via token MinHash/winnowing. Specified in the taxonomy, never
      built. `jscpd` is the obvious wrap.
- [ ] **D5** — near-duplicate module purpose via embeddings. Deferred deliberately.
- [ ] Community detection (Louvain/Leiden) for collapse candidates. Specified, never built.
- [ ] Tree divergence — authored directory tree versus actual dependency tree. Listed in the
      taxonomy; the data exists in the two spine modes but nothing computes the gap.
- [ ] God nodes use fan-in only; the design says fan-in × *churn*, which needs git history.
- [ ] Calibrate similarity thresholds against the fixture rather than the current guesses.
      (DESIGN open problem 2.)
- [ ] Wrap `knip` / `dependency-cruiser` as optional providers to cross-check our native
      reachability.

### Agents and claims
- [ ] Legacy verdict claims collected before the boolean rule are rejected on re-merge and
      need re-collecting, not coercing.
- [ ] `get_focus_state` emits no event, so it is invisible in the live feed unlike every other
      read tool.
- [ ] Elision `into` resolves by cluster *name*; two clusters sharing a name would collide.
- [ ] Frontier convergence signal — stop when the top score falls below a floor. Designed,
      not implemented; runs currently stop on batch size or timeout.

### Interface
- [ ] Scene framing does not refit when the panel is resized; `0` recentres manually.
- [ ] Replay scrubber over `events.jsonl`. Deferred pending evidence anyone wants it.
- [ ] Findings panel has no adjudication affordance — Review has one, Findings does not.
- [ ] Invariant authoring UI. They are hand-written JSON today.

### Operations
- [ ] Packaging. `pnpm gui` needs the repo checked out; there is no distributable build.
- [ ] Test coverage is thin outside the store and scene: no direct tests for `extract`,
      `resolve`, or the invariant engine, all of which have already shipped real bugs.
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
