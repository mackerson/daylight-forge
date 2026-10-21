# AGENTS.md

Operating manual for every agent (and human) working in this repo. Read it in full before your
first edit. `CLAUDE.md` points here. Nothing elsewhere overrides it.

## What this is

Open Learning Commons (OLC): a federated, offline, competency-driven learning book, the pack
tools that build and verify its content, and (later) a contributor workbench. Rust core,
Tauri shell, deterministic `.zip` release packs, community-owned Git source repositories.

The spec is `docs/spec/open_learning_commons_spec_v0_8.md`. Where the spec and an ADR
disagree, the ADR wins; where the spec and `docs/spec/errata-v0_8.md` disagree, the errata
wins. Older drafts in `docs/spec/` are history, not authority.

## Start every session

1. Read `plan/STATUS.md` (where we are), then `plan/execution-plan.md` (what is next and who
   owns it).
2. Read `docs/architecture.md` if you will touch more than one crate.
3. Check `docs/gaps.md` before claiming something works.
4. If your ticket touches the book UI, read `docs/design/plates/README.md` and the sidecar
   `plates.toml`. **Do not rely on seeing the PNGs.** Every normative fact in a plate is
   transcribed in the sidecar; the PNGs are informative and contain known errors
   (`known_contradictions` per plate).
5. Pick up the first unblocked ticket you own. Don't stop to ask unless the decision is listed
   as the owner's ("Owner decisions" below). Otherwise decide, record why in the commit
   message or an ADR, and keep going.

## Layers

The workspace is a strict layer stack. A crate may depend only on crates in a lower layer.
`cargo xtask layers` enforces this from each crate's `Cargo.toml` and its `//! LAYER: Ln`
marker in `src/lib.rs` (or `src/main.rs`), and from the graph `cargo metadata` resolves.

| Layer | Crate              | Package        | Purpose |
| ----- | ------------------ | -------------- | ------- |
| L0    | `crates/schema`    | `olc-schema`   | The five identity newtypes (ADR 0003), record shapes, primitive schemas, page/block schema, canonical JSON (RFC 8785), SHA-256 |
| L0    | `crates/zip`       | `olc-zip`      | Deterministic ZIP write; hostile ZIP read (traversal, bombs, symlinks, dupes, bad Unicode) |
| L1    | `crates/store`     | `olc-store`    | Content-addressed blob store, lockfile, release cache |
| L1    | `crates/graph`     | `olc-graph`    | Competency graph load, acyclicity, resolution, coverage |
| L1    | `crates/items`     | `olc-items`    | The six primitives: parse, solve, score, mechanical validators, regression fixtures |
| L2    | `crates/page`      | `olc-page`     | Semantic page/block model, page-level validators, print profiles |
| L2    | `crates/index`     | `olc-index`    | Local search index over terms, passages, figures, media (World Search) |
| L2    | `crates/media`     | `olc-media`    | Build-time synthesis adapters, audio/transcript alignment checks (never used at learner runtime) |
| L3    | `crates/pack`      | `olc-pack`     | Build, verify, install, rollback, advisories, surfacing-policy enforcement |
| L3    | `crates/learner`   | `olc-learner`  | Profiles, evidence events, mastery recompute, scheduler, badge earning, bookmarks, report queue |
| L4    | `crates/engine`    | `olc-engine`   | `CommandSpec` catalog; sessions; every user-visible action is one command |
| L5    | `crates/render`    | `olc-render`   | Web renderer package for the book (shared by the learner app and the future workbench); engine only |
| L5    | `crates/mcp`       | `olc-mcp`      | MCP server over the catalog |
| APP   | `apps/olc`         | `olc`          | The `olc` binary: CLI over the catalog; `olc ui` and `olc mcp` launch front ends |
| APP   | `apps/olc-book`    | `olc-book`     | Tauri shell hosting `olc-render` |
| TOOL  | `xtask`            | `xtask`        | `cargo xtask ci`, `cargo xtask layers`, `cargo xtask dist` |

Rules:

- Depend downward only. Same-layer edges are illegal unless listed in `SAME_LAYER_ALLOWED` in
  `xtask/src/main.rs` with a reason in `plan/adr/0002-layering.md`. Today: none.
- Nothing depends on an APP or TOOL package, dev-dependencies included.
- Nothing below L5 depends on a UI toolkit (banned by prefix: `tauri`, `wry`, `tao`, `egui`,
  `iced`, `slint`, `dioxus`, `leptos`).
- No synthesis engine, model client or network client links into any crate below L5 (banned
  by prefix in xtask). Synthesis is an external process `olc-media` invokes under
  `olc pack build` (ADR 0006); the learner device never has an engine to call.
- Library crates use `thiserror`; `anyhow`/`eyre` are for `apps/` and `xtask/` only.
- No `build.rs`. No `#[path]`/`include!` that leaves the package directory.
- A new crate needs an entry in `LAYER_TABLE` (xtask) and in the table above. Moving a crate
  between layers needs an ADR.

## Everything is a command

Every user-visible action is exactly one `CommandSpec` in `olc_engine::catalog()`:

| Field         | Meaning |
| ------------- | ------- |
| `id`          | Stable dotted id: `pack.build`, `report.export`. CLI spells it `olc pack build` |
| `label`       | Human label for menus and the command palette |
| `summary`     | One line for `olc help` and MCP tool listings |
| `args_schema` | JSON Schema for the arguments object |
| `writes`      | Can write a file or learner data with some arguments |
| `status`      | `Implemented`, `Deferred { reason, milestone }`, or `Planned` |

Execution takes JSON arguments and returns a JSON result. **`execute` never opens a dialog,
prompts, or blocks on input.** Front ends collect arguments first, then call the same command.
If an action cannot be expressed as a command with JSON arguments, it is not designed yet.

Results carry evidence: `limitations[]`, `coverage`, and for anything read from a pack the
revision digest it came from. Unknown is reported as unknown, never as absent.

A new command lands with its CLI form, its MCP reachability, and a test that calls it through
`execute` with JSON.

## The content rules (OLC's clean room)

These are enforced syntactically where possible so the Reviewer checks receipts, not pedagogy.

- **A validator is never the generator** (spec §10; ADR 0009). The model + prompt template
  that produced a revision may not validate it. `olc validate` refuses a `ValidationReport`
  whose `run.model_id` and `run.prompt_template` both match the generating run.
- **Proof before prose.** An item's answer comes from an executable solver or a typed scene
  graph, never from the authoring model's confidence. Items whose `proof_kind` is
  `model-critique-only` or `none` cannot reach `machine-validated` (ADR 0004).
- **Grounding declared.** Every generated explanation names what it is grounded on:
  `derivation`, `reference { digest }`, or `unsourced`. `unsourced` caps editorial eligibility
  (ADR 0010).
- **Tiers are never upgraded by code.** `editorial_state` changes only through a
  `ReviewDecision` recorded by a human act. A review *agent* writes `request_changes` or
  `reject`; it never writes `approve` (spec §24, §26).
- **Surfacing is data.** `governance/surfacing-policy.json` in the pack, keyed by
  `(strand_risk, proof_kind, editorial_state)`, decides what a learner can see. The installer
  enforces it; the renderer never re-decides (ADR 0004).
- **Evidence eligibility is a separate decision.** The same file's `evidence` block decides
  whether a correct response may count toward mastery. `editorial_state = none` is not a
  blanket bar: an `objective` item proven by `executable-solver` or a faithful `scene-graph`
  can establish provisional local mastery and a local, unsigned badge before any human
  review (spec §13, §24; ADR 0004). Higher-risk strands keep their review gates. A solver
  pass never changes `editorial_state`.
- **Inclusive categories, decided by predicate.** A square is a rectangle. Shape and
  classification items declare `categories` (`exclusive` | `inclusive`), `select`
  (`single` | `multiple`) and the predicate the prompt asks (`solver.predicate`). The
  validator applies that predicate to each choice's declared geometry and rejects a choice
  whose `correct` flag disagrees with the result. Label overlap is never the test: a
  non-square rectangle is a valid wrong answer to "which shape is a square"; a square is
  not a valid wrong answer to a single-select "which shape is a rectangle" (ADR 0005,
  errata E1). Fixtures: `examples/olc-pack-example/items/fixtures/square-is-a-rectangle.toml`
  must fail; `crates/items/tests/fixtures/valid/which-shape-is-a-square.toml` must pass.
- **No gates, no locks.** Nothing in the learner surface is "locked." Unexplored is a state;
  a padlock is a bug (errata E2).
- **Synthetic is labeled.** Build-time synthesized audio and images carry `synthetic = true`
  in `assets.lock.json` and in the About panel; phoneme-contrast items never surface on
  synthetic audio (ADR 0006).
- **Private stays private.** No learner attempt, profile, note, recording or relationship
  enters a `Report`, a contribution, a pack or public provenance. A test scans every exported
  artifact for the learner DB's identifiers (spec §6, §14).
- **No learner-runtime model.** No crate below L5 links a model, network or synthesis
  client. `media.synthesize` runs an external process under `olc pack build` only.

## Never panic

Packs come from USB sticks. Treat every input byte as hostile.

- No `unwrap`, `expect`, `panic!`, `unreachable!`, `todo!`, `unimplemented!`, or `unsafe`
  outside tests. `[workspace.lints]` denies them.
- No slice indexing (`buf[i]`, `buf[a..b]`): use `get()` and return an error.
- Checked arithmetic on every size and offset from input. Cap allocations by the bytes
  actually remaining. `clippy::arithmetic_side_effects` is denied workspace-wide; a test
  module that needs plain `+` puts `#[allow(clippy::arithmetic_side_effects)]` on `mod tests`.
- Bound recursion depth (nested blocks, graph walks) and iteration counts.
- Errors are typed (`thiserror`) and carry the byte offset or the record path where parsing
  failed.
- **Every crash fix ships with a regression test** that feeds the minimized input.

## Testing and the CI gate

`cargo xtask ci` is the gate. It runs, in order:

1. `cargo xtask layers`
2. `cargo fmt --all -- --check`
3. `cargo clippy --workspace --all-targets -- -D warnings`
4. `cargo test --workspace`
5. `olc validate examples/olc-pack-example` and
   `olc pack build examples/olc-pack-example --profile starter --offline` whose release digest
   must equal `examples/olc-pack-example/tests/release.digest` (the M0 oracle, ADR 0012)

Steps 5 are skipped with one printed line until ticket M0.P4 lands. Nothing is committed
unless the gate passes. A pre-commit hook in `.githooks/` runs steps 1 and 2; enable it once
per clone with `git config core.hooksPath .githooks`. There is no remote CI yet; the local
gate is the CI.

## Lanes, worktrees, and who pushes

- One agent, one lane, one worktree (`git worktree add ../olc-<lane> -b lane/<lane>`).
- A lane edits only the paths its ticket lists. Cross-lane needs go to `plan/STATUS.md` under
  "Requests"; keep going on your own lane.
- Only the director merges to `main` and pushes, after `cargo xtask ci` is green on the
  integration. Lanes never push, never force-push, never rebase `main`.
- Content lanes (M1+) own a `(primitive, node-set, locale)` triple under
  `examples/olc-pack-example/items/` and `lessons/`; they never touch `graph/` or
  `governance/`.

## Roles

| Role      | Does | Model |
| --------- | ---- | ----- |
| Writer    | owns one ticket: code, tests, docs, the gate, the commit, the hand-off block | Opus |
| Validator | `olc validate`: mechanical checks; model-assisted checks run with a model+template different from the writer's | commands; Haiku/Sonnet |
| Reviewer  | reviews each writer branch: layer rules, content rules above, scope, receipts complete; never approves content | Fable |
| Triage    | sorts validator output, reports and fixtures into classes; never sets a state, never commits | Haiku |
| Director  | integrates, runs the gate, pushes `main`, writes the pause note | — |
| Owner     | everything under "Owner decisions"; `approve` decisions in strands they are qualified for | Michael |

## Reporting (the hand-off block)

Every ticket hand-off ends with this block, ≤ 40 lines, and it is also written as a
`GenerationRun` receipt to `provenance/runs/` when the ticket produced content:

```
ticket: M0.S2
lane: S
branch: lane/S
commit: <sha>
gate: green | red (<step>)
done: <one line per acceptance criterion, each "met" or "not met: why">
touched: <paths>
decisions: <anything you decided that the ticket did not specify, with the ADR or commit>
requests: <cross-lane needs filed in STATUS.md, or none>
limitations: <what this does not do yet>
```

## Owner decisions

Stop and leave a note in `plan/STATUS.md` "Owner next actions" for any of these:

- The first language and variety of the seed (`en-US` provisional, ADR 0011).
- Surfacing-policy minimums for a strand not named in ADR 0004.
- Any `approve` ReviewDecision (agents never approve content).
- Pre-reader report iconography (needs the illustrator).
- Default synthesis engines (ADR 0006 pins by digest; the choice is the owner's).
- License or governance text.
- Anything that changes `graph/` in the example pack (the graph is owner-authored, ADR 0011).
- Changing a plate's `normative` list in `docs/design/plates/plates.toml`.
