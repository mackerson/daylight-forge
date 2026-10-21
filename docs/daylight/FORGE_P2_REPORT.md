# Daylight Software Forge — P2 completion report

Status: written 2026-10-21 at `forge-p2` @ 31f277b (the WS-R18 merge), on branch
`ws/r19-docs`, before `forge-p2` merges into `main`. The owner ruled that merge on 2026-10-21
(P2-R68): `forge-p2` merges into `main` with `--no-ff` once these documents land, `main` is pushed,
and the worktrees are deleted afterwards. Nothing in this report was pushed by its writer.

This is the completion record for P2. Every number in it comes from a named source: git on
`forge-p2` (c950b66..31f277b), the decision record `docs/daylight/FORGE_PLAN.md` (ADR-36 to
ADR-44), and the build's working papers. The working papers are not in the repository. They are
the director's rulings (`RULINGS.md`, P2-R1–P2-R68), `TRACKED.md`, `BUILD-LEDGER-P2.md`, the
interface documents (`director-interfaces.md` v3, `refine-interfaces.md` v2,
`ingest-interfaces.md` v3), every reviewer review (`r1`, `r2`, `r4`, `r5`, `r6`, `r8`, `r9`,
`r14`, `r15`, `r16`, `wave2-review.md`, `p2-security-review.md`, `final-review.md`), the OLC
design-run papers (`olc-prep.md`, `dry-run.md`, `findings.md`), and the gate logs under the
director's scratchpad (`p2/*.log`, `w4i/*.log`). A figure with no source is marked as such.

Three conventions, the first two carried over from the P1 report:

- A **test count** is the sum of every `N passed, M failed` line printed by `pnpm test:all`. It
  counts assertions, not test files. **Files** is the number of such lines. `test:all` has 88
  steps; the first is `map`, which prints no such line, so 87 test files report. Reviewers who
  counted steps wrote "88 files" for the same run.
- **Severities** are the reviewer's own (High, Medium, Low, Info). Writers' self-assessments are
  not counted, except in the OLC design-run row of §3.2, which says so.
- **Mocks only.** No model provider ran as an agent at any point in P2 (P2-R7). Every author,
  reviewer, decomposer, extractor and architect in tests, probes, the e2e runs, the design run
  and the benchmark is a mock or a scripted stand-in.

---

## 1. What P2 delivers, and what it does not

### Delivered

P1 built one change under evidence. P2 builds a plan of many changes the same way, on Rust as
well as TypeScript, and turns a specification into that plan. The director staged it as three
workflows on one building pass, design, prototype and refine (RULINGS context, P2-R39), plus
spec ingestion as wave 4 (P2-R46).

**Rust across the board (wave 1).**

- **Map.** `.rs` files are parsed by tree-sitter compiled to WebAssembly. The runtime and grammar
  `.wasm` files are vendored with pinned versions and sha256 digests, checked on every load, and
  no native addon is installed (P2-R1, WS-R1). Module paths resolve from the file layout and each
  `Cargo.toml`. A module's link back to its parent is not a cycle (P2-R31).
- **Cargo in the sandbox.** `deps snapshot` fetches crates on the host into a per-project snapshot.
  The sandbox mounts it read-only as `CARGO_HOME`, with cargo forced offline (P2-R2). The
  snapshot's identity covers the whole root and is verified before every gate run and exec launch.
  Only crates.io sources are admitted (P2-R29, P2-R42 M3). Build caches live outside the repo, and
  every gate run gets its own throwaway cache (P2-R3, P2-R28, P2-R42 H1). The toolchain is the
  system `/usr/bin/cargo`, with no rustup (P2-R5, P2-R8).
- **Cargo gates.** A `cargo` gate harness counts a result only when exactly one
  `Running tests/daylight_<x_id>.rs` line shows. A resource kill reads as `invalid`, never as a
  failing gate (P2-R30). `gate try` baselines a test with no store at all, and it is allowed in an
  agent session (P2-R41 F6).
- **Per-project policy.** `daylight.policy.json` picks the default gate harness and can only
  tighten. Every built-in protected set applies whatever the file says. The rust set protects
  `Cargo.toml`, `Cargo.lock`, `.cargo/`, `rust-toolchain.toml` and a crate-root `build.rs`
  (P2-R4, P2-R32, P2-R41 F1). An author that needs a crate raises a `request-dependency` need,
  and a person resolves it (P2-R4).

**DESIGN: the plan as data (wave 2, WS-R5; ADR-36, ADR-37).**

- A plan file (`daylight.plan.json`) is read from git's object store at a named commit, never
  from the working tree.
- The campaign commands work on it in turn: `campaign validate`, `import`, `approve-plan`,
  campaign gates and `lock`, and `authorize`.
- One human `authorize-campaign` decision sets an envelope: tickets, spend cap, turns, timeout,
  expiry, auto-apply, the fix lane and the review roster.
- Every director act is a derived decision by `campaign:<m_id>` that names that grant. Only
  `recordDerivedDecision` can write one (P2-R19, P2-R26).
- Owner decisions and assumptions are first-class. Read-only commands and `--dry-run` run in an
  agent session. Commands that write a row or move a ref do not (P2-R9, P2-R24, P2-R41 F2).
- The OLC design run exercised this stage on a real target (§5).

**PROTOTYPE: the unattended loop (wave 2, WS-R6; ADR-38, ADR-39).**

- `campaign run` dispatches ready tickets in plan order. It starts every attempt from the current
  integration tip.
- Accepted candidates land on `refs/heads/daylight/campaign/<id>` by compare-and-swap, with a
  derived `integrate-candidate` decision. A candidate that does not apply is rebased by plumbing,
  and a conflict or a failing gate goes to a repair attempt.
- Spend is reserved on `attempts.max_cost_usd` before every launch, wave reviewers included
  (P2-R18, P2-R35). An unknown cost halts the campaign, and its candidate never lands (P2-R11). A
  crashed attempt is charged at its reservation (P2-R44).
- `halt`, `resume`, `adopt-tip` and `retry` are human acts.
- Blind wave reviewers file findings through MCP. High findings become at most five fix tickets
  per wave inside the cap (P2-R10).
- A candidate whose diff carries a test-output forgery shape is parked for a person
  (`gate-forgery-shape`, P2-R49).

**REFINE: reading what the loop did (wave 3, WS-R8 and WS-R9; ADR-40).**

- `campaign report` builds a wave report, derived on read and never auto-written.
- `campaign list` shows the campaigns.
- `campaign refine` builds the focus map of a tip.
- The Mission Control campaign screens carry the wave report and a read-only Refine view of the
  tip's map.
- Every GUI campaign act goes through `daylight confirm` and a native dialog (P2-R40, P2-R45).
- Spend wording lives in one pure module that both the engine and the renderer import (P2-R60).

**INGEST: from a specification to a plan (wave 4, WS-R14, R15 and R16; ADR-41 to ADR-44).**

- `corpus register` makes a content-addressed corpus (P2-R63).
- A deterministic sectioner reads its configuration as data (P2-R53 D-e, P2-R54).
- Blind extraction needs at least two extractors and produces the spec IR. A coverage report
  follows, with seeded-defect detectors.
- An independent IR review comes next. `approve-ir` is a person's act: agreement is not approval
  (ADR-42).
- The rest of the pipeline runs `blueprint` → `approve-blueprint` → work packets → a version-2
  plan. The plan descends from the packet digests, and `campaign import` verifies that descent
  (P2-R50 F1).
- An authority chain is checked at every authorizing act. A revision that moves a quoted passage
  breaks it until a person accepts the drift by digest or re-emits (P2-R59).
- `trace` reads the links both ways, passage to landing and back (ADR-44).
- `ingest bench` scores the pipeline on two corpora and names the checks that mock mode cannot
  fail (P2-R57, P2-R61).

The integrated guarantees are in the final review's table (§4).

### Deliberately not delivered

- **Live anything.** No model provider ran as an agent. The benchmark's `live-extract` and
  `live-full` modes are refused with one line until the owner grants live spend (P2-R7, P2-R53
  O-c). Real providers stay `unavailable` for implement, as in P1 (ADR-31). The OLC live build
  also waits for the owner's revised specification (P2-R48).
- **rustup.** On hold (P2-R8). The sandbox uses the system `/usr/bin/cargo` (pacman rust 1.99),
  and `rust-toolchain.toml` is inert. WS-R2b, rustup with a root-owned `RUSTUP_HOME` bound
  read-only, is queued until a target pins a channel the system lacks.
- **Closing the forged-pass channel.** Candidate code can still forge a gate pass in-process by
  exiting early or by writing the harness's summary to the real stdout (wave-2 H1, security M1,
  final H2). The owner's ruling was "record the issues and continue" (P2-R43). The director added
  a heuristic that parks a candidate whose diff carries a forgery shape (P2-R49). A candidate
  that spells around the heuristic still lands on the integration ref unread (final-review H2,
  probe `p1b-evade.ts`). The integration ref is therefore untrusted until refine and a person's
  merge to `main`.

---

## 2. Changed files, by wave

Source: `git log --first-parent -m --shortstat c950b66..31f277b`. Each row is the change against
the previous `forge-p2` tip. Merges are listed one per row. The integrator's direct commits are
grouped by range, with each group's figures taken from `git diff --shortstat` over that range.

| Wave | Merge or range | What | Files | Ins. | Del. |
|---|---|---|---|---|---|
| 1 | 5f58b37 | WS-R1 Rust map provider (web-tree-sitter, vendored grammar) | 34 | 1,623 | 35 |
| 1 | 1826013 | WS-R4 project policy and the request-dependency need | 19 | 1,504 | 43 |
| 1 | a16a87f | WS-R2 cargo in the sandbox, snapshot, cargo gate harness | 24 | 2,297 | 95 |
| 1 | a16a87f..dbc4156 | wiring: one `deps` dispatcher, `GateHarness` once, harness default, protected-set follow-ups (7 commits) | 7 | 117 | 39 |
| 2 | 7a10baa | WS-R5 step 0: campaign interface stub (P2-R26) | 6 | 239 | 10 |
| 2 | b0ed4c8 | WS-R5 plan as data, campaign authorization, assumptions, derived decisions | 24 | 4,696 | 68 |
| 2 | 1dda558 | WS-R6 integration ref, campaign gates, director loop, wave review, status | 34 | 5,646 | 65 |
| 2 | 1dda558..d5abd9e | seam wiring, ADR-38/39, first campaign e2e, `--help` tests (5 commits) | 19 | 526 | 152 |
| 2 | be93bf6 | WS-R7 plan gate expectations, holdout basenames withheld, harness from `languages`, lefthook | 17 | 212 | 45 |
| fixes | ebbc043 | WS-R10 OLC design-run findings F1–F6 (P2-R41) | 21 | 756 | 77 |
| fixes | f76166e | WS-R11 security-review fixes H1, M2, M3, L1–L5, Info (P2-R42) | 18 | 877 | 320 |
| fixes | f76166e..611aee6 | previews exit 2 again (P2-R45 D1) | 6 | 27 | 27 |
| 3 | 5f6362a | WS-R8 step 0: refine types stub | 7 | 410 | 1 |
| fixes | 8a73d75 | WS-R12 wave-2 review fixes (P2-R44) | 16 | 754 | 104 |
| fixes | 1ec6eeb | WS-R13 leaks and the forgery-shape warning (P2-R43, P2-R45 D7, P2-R49) | 20 | 732 | 22 |
| 4 | 7f3f776 | WS-R14 step 0: ingest types, DDL, store CRUD, outbox server, generalised runMission | 29 | 1,845 | 27 |
| 3 | f89c578 | WS-R8 refine engine: report, list, refine, confirm coverage | 29 | 2,351 | 91 |
| 3 | 9713c88 | WS-R9 refine UI: campaign screens, Refine view, read-only scene | 29 | 3,631 | 62 |
| 3 | 9713c88..eac4c0b | spend words in one pure module, bare flags, holdout-basename warning (4 commits) | 12 | 197 | 104 |
| 4 | eb78ce5 | WS-R14 corpus, sectioner, IR, extraction, coverage | 46 | 5,809 | 105 |
| 4 | 0f9c7d4 | WS-R15 IR review, approve-ir, blueprint, packets, plan v2, authority chain | 23 | 4,548 | 154 |
| 4 | cd4f1f7 | WS-R16 trace, ingestion benchmark, OLC ground truth, Harbor Ledger | 68 | 8,588 | 127 |
| 4 | cd4f1f7..df45d3d | wave-4 wiring (P2-R56, R58, R62, R64), corpus revise e2e (13 commits) | 26 | 466 | 81 |
| close | d7d6c62 | WS-R17 lock `--obligations`, trace CLI, flake fix, scoped regression re-check (P2-R55), lefthook forms | 22 | 257 | 48 |
| close | 31f277b | WS-R18 `campaign lock --accept-vacuous` confirms (final-review H1) | 2 | 69 | 3 |

Net, `git diff --shortstat c950b66..31f277b`: **262 files changed, 46,781 insertions, 509
deletions**. Of the 262 files, 193 are added and 69 modified (`git diff --name-status`). The
per-commit rows of `--first-parent -m --shortstat` add up to 48,185 insertions and 1,913
deletions. That is more than the net figure because later commits rewrite lines added by earlier
ones.

History, also from git on the branch:

- **Commits.** 325 commits in c950b66..31f277b, 27 of them merges.
- **First-parent line.** 20 of the 27 merges are on `forge-p2`'s first-parent line. The other
  seven were made on workstream branches: `forge-p2` into WS-R8 twice, WS-R8 into WS-R9, and
  WS-R14 and WS-R15 into WS-R16, twice each.
- **Trailers.**
  - 300 commits carry `Co-Authored-By: Claude Opus 5.5`: the 298 non-merge commits plus 2 merges.
  - 20 merges carry `Claude Fable 5.1`. These are the 20 first-parent merges.
  - The other 5 merges carry no trailer.

Ten merges have exactly their branch head's tree (`git rev-parse <merge>^{tree}` against
`<merge>^2^{tree}`). They are R1, both R5 merges, R7, R10, the R8 step 0, the R14 step 0, R8,
R17 and R18. The other ten were merged onto a tip that had moved since the branch was cut, so
their trees differ from the head. Of the ten heads, two are also the head their reviewer last
verified: R1's (8972a3b, "reviewed + re-verified" in TRACKED.md) and R8's (a2cea8b, r8-review). §3.1 says which counts were measured at the merge itself.

---

## 3. Tests run and results

### 3.1 Test-count ladder

Every figure is a full `pnpm test:all`. All of them ended 0 failed. "Not recorded" means that no
log, review or tracking note gives a count for that merge's tree. The nearest branch-head count
is named instead, and that figure is not the merge's count.

| After | Assertions | Files | Δ | Source |
|---|---|---|---|---|
| P1 end, main c950b66 | 3,104 | 55 | — | `baseline.log` (scratchpad, 2026-10-19 17:02); equals the P1 report's final figure |
| R1, 5f58b37 | 3,257 | 57 | +153 | `p2/forge-p2-r1-testall.log`; TRACKED.md "3257/0 (57 files)" |
| R4, 1826013 | not recorded | | | branch head 1716ccc: 3,241, 56 suites (r4-review fix verification) |
| R2, a16a87f | not recorded | | | branch 019ac91: 3,264, 57 files (r2-review fix verification) |
| wave 1 end, dbc4156 | 3,574 | 59 | +317 over R1 | TRACKED.md "Gate 3574/0 (59 files)" |
| R5 stub, 7a10baa | not recorded | | | |
| R5, b0ed4c8 | not recorded | | | branch 3dcd3aa (before its fix round): 3,848, 63 suites (r5-review §1) |
| R6, 1dda558 | not recorded | | | branch, before its fix round: 3,805, 65 files (`rv-r6-testall.log`) |
| wave-2 seam and e2e, d5abd9e | not recorded | | | |
| R7, be93bf6 | 4,308 | 70 | +734 over dbc4156 | `p2/forge-p2-be93bf6-testall.log`; TRACKED.md "4308/0 (70 files)" |
| R10, ebbc043 | 4,408 | 70 | +100 | `r10gate.log`, written 20:29, 7 min after the merge; the log names no commit, so it is attributed by time |
| R11, f76166e | 4,461 | 70 | +53 | `r11gate.log`, written 20:36, after the merge (20:29) and before 611aee6; attributed by time |
| 611aee6 | 4,461 | 70 | 0 | `final.log`, written 20:44, after 611aee6 (20:37); attributed by time |
| R8 stub, 5f6362a | not recorded | | | |
| R12, 8a73d75 | 4,524 | 70 | +63 | `p2/r12-gate.log` (21:22; merge 21:14) |
| R13, 1ec6eeb | 4,604 | 70 | +80 | `p2/r13-gate.log` (21:31; merge 21:23) |
| R14 stub, 7f3f776 | not recorded | | | |
| R8, f89c578 | 4,841 | 73 | +237 | r8-review fix verification at a2cea8b, which is the merge's tree; `p2/w3-r8-testall.log` gives the same figure. The reviewer counted 74 steps |
| R9, 9713c88 | not recorded | | | branch 4689ef6 on the R8 merge: 5,006 (r9-review fix verification) |
| wave 3 end, eac4c0b | 5,101 | 75 | +260 over f89c578 | `p2/w3-final-testall.log` (23:42; eac4c0b 23:32) |
| R14, eb78ce5 | 5,379 | 79 | +278 | `w4i/gate-m14.test.log` |
| R15, 0f9c7d4 | 5,600 | 83 | +221 | `w4i/gate-m15.test.log` |
| R16, cd4f1f7 | 5,794 | 85 | +194 | `w4i/gate-m16.test.log` |
| wave 4 end, df45d3d | 5,878 | 87 | +84 | final-review §1, two runs identical; `w4i/gate-final2.test.log` |
| R17, d7d6c62 | 5,920 | 87 | +42 | `p2/forge-p2-d7d6c62-testall.log` |
| **R18, 31f277b** | **5,927** | **87** | +7 | `p2/forge-p2-31f277b-testall.log` |

This report's writer re-ran `TMPDIR=/tmp bld pnpm test:all` once on `ws/r19-docs`, which is
31f277b plus these documents. It gave **5,927 passed, 0 failed, 87 files**, exit 0
(`p2/r19-docs-testall.log`). `pnpm typecheck` was clean, and `check . --warn-only` reported 30
green and 0 red.

From P1's end to 31f277b the suite grew by **+2,823 assertions and +32 files**. `engine/test/`
outside `fixtures/` now holds 93 files: 84 at the top level and 9 helpers in `lib/` (`git ls-files`
at 31f277b).

At the final review (df45d3d, §1 of `final-review.md`):

- `pnpm typecheck`: exit 0 (engine and renderer).
- `daylight check`: 30 green, 0 red, 0 target violations. It exits 1 on the pre-existing
  `[place] 19 file(s)` item, which is the same on `main` (final-review I5). That item is the
  unplaced files under `fixtures/`.
- `ui:build` plus `engine/test/bundle-markers.ts`: 24 passed. The 18 engine runtime markers and
  the holdout sentinel are absent from the bundle (P2-R64). That test now runs in `test:all`.
- `ingest bench --mode mock` through the CLI under `CLAUDECODE=1`, both corpora, twice each:
  - OLC: **17 pass, 0 fail, 0 blocked**, with 9 checks labelled by construction.
  - Harbor: **17/17**, with 8 by construction. Its coverage check is falsifiable.
  - Two runs of each corpus are equal after normalisation. The `w4i/bench-olc.json` and
    `w4i/bench-harbor.json` reports state the same results.

`check` grew from 17 invariants at the end of P1 to **30** (`daylight.invariants.json` at
31f277b; final-review §1).

Flakes:

- During wave-4 integration, `forge-ingest-corpus.ts` failed one check once (65/1). It did not
  reproduce in either final-review run, which gave 66/0 both times (final-review §1).
- R18 saw one failure of `forge-campaign-run-director.ts` ("next run dispatches it and it lands")
  under load. It passed four reruns. The hunt is queued (P2-R67).
- R17's merge title includes a flake fix. The report's sources do not say which flake it fixed.
- `test:all` still needs a short TMPDIR (108-byte socket path). It now also needs
  `/usr/bin/cargo`: `forge-cargo.ts` fails, and does not skip, without it. It also needs one fetch
  from crates.io, unless `DAYLIGHT_OFFLINE=1` skips the network cases (CARGO.md; r2-review L5).

### 3.2 Review loop

P1's loop held, with three changes:

1. **Opus reviewers during the Fable budget hold.** While the owner held new Fable agents
   (P2-R33), three reviews were done by Opus agents: the R4 fix verification and the R5 and R6
   first passes. The Fable wave-2 review, on the integrated code, covered R5, R6 and R7 after the
   hold lifted (P2-R39).
2. **Whole-branch passes.** Two whole-branch passes replaced per-branch review for the later
   fix-only branches: a full security review at be93bf6, and the final review at df45d3d.
3. **No branch review for the fix-only branches.** WS-R7, R10, R11, R12, R13, R17 and R18 had no
   review of their own. R7 is inside the wave-2 and security scopes (both at be93bf6). R10 to R13
   are inside the final review's scope (df45d3d). R17 and R18 merged after the final review.
   Their closure of final-review H1, M1 and M2 is the director's record (P2-R67); no reviewer
   re-ran it.

"Fixed and re-verified" below means the reviewer re-probed the fix against code. "Fixed" alone
means fixed on the branch, with the evidence named. "Mutations" means the reviewer removed a
protection in a scratch copy and counted the tests that went red.

| Review | Found (H/M/L/Info) | Fixed and re-verified | Left open | Mutations by the reviewer |
|---|---|---|---|---|
| WS-R1 (Fable) | 2/2/4/3 | H2 (tree-sitter-rust package removed; provenance recorded), M1, M2, L1–L4, I1, at 0fe4bf7. P2-R31 heritage exemption, then MERGEABLE. H1 was the main checkout's `node_modules`, which the writer's install had broken: an environment fix outside the branch | I2 (`mod` nodes are kind `variable`; documented) | 7, with 1 at zero red (m1, the load-time digest check, which became L4). Fix round: 9, all red |
| WS-R2 (Fable) | 4/4/8/4, plus 1 Medium in the fix round | H1–H4, M1, M3, L1–L3, L6, L8. M2 by docs. The fix-round Medium (quote-aware bracket counting, 0388e14) was spot-checked by the wave-2 review, §5 | L4 (the gate sandbox's root tmpfs is writable; documented), L5 (test:all needs crates.io; documented). L7 was deferred to merge; R7's title names the dedupe | 6, all red. Fix round: 11, all red |
| WS-R4 (Fable; fix verification by Opus) | 0/4/5/2, plus one required unrated item (`confirm resolve-dependency-request`). Fix round: +1 Low, +5 Info | R1 item, M1–M4, L1–L4 (re-verified by Opus). L5 at merge (9cdec22). Fix-round Low I1 landed as 47d0c35, not re-verified | I2 (`.yarnrc`, `.yarn/releases`, `bunfig.toml` and others; d3e7fe6 protects some), I3 (outbox read O_NOFOLLOW unpinned) | 16, with 3 at zero red (m6a, m6b, m16). Fix round: 17, 1 at zero red (m16b) |
| WS-R5 (Opus, first pass) | 0/6/9/6 | Fix round 9146c66 merged (TRACKED.md). No reviewer re-verification. The Fable wave-2 review then re-probed the integrated guarantees | L2–L9 were "recommended, not blocking"; no source records which of them closed (L7 was still open at the design run, F7) | One mutation per guard probe. Zero-red guards are reported as M6 and L8 (M3, M11b, M11c, M14, M20 real gaps; M5, M8c, M13, M19 redundant) |
| WS-R6 (Opus, first pass) | 1/7/8/7 | Fix round eb0d8e7 merged. The wave-2 review verified reservations on every author and reviewer row (H1) | items 8–12 (M7, L1, L2, L4, L6) were "after or at merge"; no source records their closure | 7, with 1 at zero red (M2, a doubled guard) |
| Wave 2 integrated (Fable, be93bf6) | 3/3/7/12 | H2, H3, M1–M3, L1–L5, L7 in WS-R12 (P2-R44). The final review re-pointed p1, p3, p4, p5, p8, p10 and p18b at the integrated tree. Its guarantees table reports p3, p5, p8, p10 and p18b as KEPT | **H1, forged pass: owner-accepted residual (P2-R43)**, with the P2-R49 heuristic. L6: tolerated `rustflags` may name a linker. At 31f277b this writer found no `link-arg` or `-C linker` check in `engine/forge/cargo.ts` (grep) | 17 on the e2e: 7 red, 10 green. The 5 green ones the seam depends on became M2 |
| Security (Fable, be93bf6) | 1/3/6/8 | H1, M2, M3, L1–L5, Info (sudo-class binaries, title characters) in WS-R11 (P2-R42). L6 by H1's single placement. H1 is pinned by `forge-cargo.ts` "cache isolation … (P2-R42 H1, probe C)". The final review has no separate re-run of probe C | **M1 = wave-2 H1** (owner, P2-R43). I1: node is bound at its host path, so `/home/<user>` exists inside the sandbox. I5: the gate root tmpfs is writable | None by the reviewer. The proposed DP matcher was mutation-tested in probe B2 |
| OLC design run (Opus writer's own findings) | 0/3/3/3 | F1–F6 in WS-R10 (P2-R41) | F7–F9 Info (for example, the 191 MB gate base cache is copied per candidate where there is no reflink) | n/a |
| WS-R8 (Fable) | 0/3/6/6 | M1, M2 (with the residue accepted: P2-R60 warning, eac4c0b), M3, L1–L4, L6, I1 | L5 named in the merge note | 15, with 4 green (m1a by design; m3, m13, m14 test gaps). Fix round: 20, 18 red |
| WS-R9 (Fable) | 1/3/8/6 | H1, M1–M3, L1–L4. L5, L7 and L8 were closed by the re-run with no change | L6 (fixture fields against the engine) is not itemised in the verification | Read-only: 7/7 red. Holdout: 2 red. Spend: 3 red |
| WS-R14 (Fable) | 0/4/8/12. Fix round: +1 Medium (F-1), +1 Low (F-2), +1 Info | M-1, L-1–L-4, L-6–L-8. M-3 partial by design, then swapped at integration (0988ef5). M-2, M-4 and L-5 were ruled (P2-R58). F-1 and F-2 were fixed on the branch (4f94df3, fc12e87; P2-R63) but not re-verified by this reviewer. The final review's mutation 15 (corpus digest includes the commit) is red | none | 15, with 4 at zero red (L-1, L-6, L-7 ×2). Fix round: all originals red, and the new ones red except two inherent cases |
| WS-R15 (Fable) | 1/4/5/11 | H1 (P2-R59), M1, M4, L1–L5. M2 and M3 at merge (81567f9, aab647a) | the unreachable stale terms and the M10 break, Info only | 10, with 2 at zero red (M2a, M10). Fix round: 14, with 3 at zero red (M10, N3, N3b; unreachable as the sole trigger) |
| WS-R16 (Fable) | **6**/8/4/6. Verdict NOT MERGEABLE | Fixed on the branch before merge, after the R14 and R15 tips were merged in (P2-R61): e40afc5 (H1, H1b), 3f43dbb (H2), 10136cc (H3), 63f096d (H4), 18d8945 (impersonation), b7f8935 (mediums), ba0eecf (lows), 4ab8122. Not re-verified by this reviewer. Evidence: the integrator's gate 5,794/0, the final review's benchmark 17/17 on both corpora, and its mutations 7 and 14 (bench-actor guards) red | none recorded | 16, with T1, T2 and B2–B6 at zero red. b7f8935's subject names the bar and label mediums ("falsify every bar"). Nobody re-ran this mutation set |
| Final (Fable, df45d3d) | 2/2/3/6 | H1 in WS-R18 (31f277b). M1 and M2 in WS-R17 (d7d6c62). Both are recorded closed by P2-R67, with no reviewer re-run | **H2, forged pass (= wave-2 H1, accepted)**. L1: a minified file outside vendor paths is mapped whole. L2: the mission-level lock digest omits `--accept-vacuous`. L3: OLC's bars are named in `ingest-bench.ts` strings | 18, all red |

Totals across the thirteen reviewer rows (the design-run row is excluded as the writer's own):
**21 High, 55 Medium, 83 Low** found.

- **WS-R16's Highs.** Six of the 21 Highs are WS-R16's: one impersonation finding and five merge
  defects (H1, H1b, H2, H3, H4).
- **The forged-pass channel.** It was found three times: wave-2 H1 (High), security M1 (Medium)
  and final H2 (High). It was **not fixed**. The owner accepted it as a residual (P2-R43, §7).
- **WS-R1's environment High.** WS-R1 H1 was an environment defect in the main checkout, fixed
  outside the branch.
- **Every other High** was fixed before its branch merged. The exceptions are the whole-branch
  reviews' Highs (wave-2 H2 and H3, security H1, final H1), which were fixed in later fix
  branches. All of them landed before `forge-p2` merges to `main`. Most of these were re-verified by a reviewer. The exceptions are
  WS-R16's six and final-review H1, which are evidenced by later gates and probes, as the table
  says.

---

## 4. Acceptance: the final review

Source: `final-review.md` (Fable, 2026-10-21, at df45d3d), read-only, scratch copy, real bwrap
0.13, cargo 1.99 and node 24.18. **Verdict: MERGEABLE AFTER FIXES.** Required: H1 (fixed in
WS-R18). Then M1 and M2 (fixed in WS-R17). L1–L3 were optional.

### 4.1 Preserved guarantees on the integrated whole

| Guarantee | Verdict | Evidence (final-review §3, abridged) |
|---|---|---|
| R7: no write without an authorize decision; derived grants; bench stores | KEPT | forged campaign-actor grants caught by `derivationRefusals`; only `recordDerivedDecision` writes a campaign actor (mutations 1–2 red); bench actors only on a bench store (mutations 7, 14 red) |
| ADR-20: decisions refused under CLAUDECODE/DAYLIGHT_SESSION; GUI confirm = act preview | KEPT | 43 writing invocations × 2 variables all refused, rows/events/refs unchanged; 22 read-only forms ran; `daylight confirm` equals the act's preview for all 10 campaign/assumption operations and for `approve-ir` on the real OLC corpus |
| ADR-17: HEAD/index/worktree untouched, no hooks | KEPT | `p8` (14 hooks, fsmonitor, linked worktree, dirty tree): only `refs/heads/daylight/**` added; `forge-ingest-revise.ts` asserts repo state after each of 14 acts |
| ADR-19: verdicts pure | KEPT | `campaign-verdict.ts` imports types only; both purity invariants green; mutation 3 red |
| ADR-29 / P2-R44: no dollars in git; unknown never $0.00; reservation charges | KEPT | trailers ids only; SIGKILL mid-attempt → next run lands, orphan charged at reservation; unknown cost halts and the candidate never lands |
| Holdout secrecy end to end | KEPT | sentinel and basename in none of 20 CLI surfaces, no event payload, none of 4 prompts; report `holdouts` counts only |
| Sandbox fail-closed: authors, node gates, cargo gates, reviewers, exec | KEPT | no sandbox → run refused in one line, no mission, no need |
| Spend caps and halts (P2-R35/R44) | KEPT | one-cent breach halts with the candidate pending; resume does not land it while spend still breaks the rule; exact cap → `completed` |
| Spec authority (P2-R59) | KEPT | revise → chain `ir` break → authorize refused naming `--accept-ir-drift` → ticket `stale` → override with the exact digest recorded → re-emit clears it; mutation 10 red |
| Content-addressed corpus identity (P2-R63) | KEPT | same documents in another repository at another commit → same digest; mutation 15 red |
| Abstract capacity (P2-R52) | KEPT, with L3 | no project names in engine or app outside tests and fixtures, except L3's bar strings |
| Forged pass (P2-R43/R49) | WEAKENED by design | H2: `p1-trojan.ts` is caught and parked; `p1b-evade.ts` (indirect `process.exit`) lands |

### 4.2 The OLC DESIGN run on the integrated branch

Source: final-review §5 (`pd-olc.sh`), on a copy of the design run's repository.

| Step | Result |
|---|---|
| `map` (CLAUDECODE=1) | exit 0 after `--force` (the be93bf6 `<out>` is refused by `SCHEMA_DIGEST`, I3): 16 files, 29 symbols |
| `deps status` | snapshot `sha256:1fd9bff9…`, 777 files, 9.5 MiB, matches; `Cargo.lock` matches |
| `deps snapshot` under CLAUDECODE | refused in one line (P2-R41 F5) |
| `campaign validate daylight.plan.json` (f26267f) | valid, 0 refusals, digest `sha256:559f90ca…14a2`, equal to dry-run.md run 4 |
| `gate try --harness cargo` M0.S1 (CLAUDECODE=1) | ran in bwrap with the snapshot; the gate fails to compile against the base (E0432): a failing gate, as wanted; 6.8 s wall; nothing written |
| `gate try` xtask `ci_test.rs` | compiled xtask + 3 crates in 4.05 s, one `Running tests/daylight_x_….rs` line |
| `corpus register` | refused under CLAUDECODE; from a shell: 20 documents (OLC v0.8, errata, 15 ADRs, AGENTS, architecture, Foundry) |
| `corpus extract --tools mock,mock:b` (CLAUDECODE=1) | 52 attempts, 563 records, 1,126 observations, 0 refused, 6.3 s |
| `corpus coverage` | 20 docs, 201 sections, 26 windows, 490 normative, 490 mapped, 0 unmapped |
| `confirm approve-ir` vs the act's preview | equal; the act refused in a session; from a shell recorded `human:miz` approving 5 records |
| both repositories afterwards | `git status --porcelain` empty, HEAD unchanged |

`campaign import` and every act after it remain the owner's (P2-R9). No OLC campaign has been
imported, approved, authorized or run, on mocks or otherwise.

### 4.3 What the reviewer says P2 proves, and does not

Quoted from final-review §7:

> **What P2 proves.** On mocks, the integrated branch keeps every guarantee P1 had and the ones P2
> added: a campaign lands only `accepted-by-gates` candidates on
> `refs/heads/daylight/campaign/<id>` by compare-and-swap, under derived grants that trace to one
> human `authorize-campaign`, with HEAD/index/worktree/hooks untouched across a full run and
> across a corpus revision; every decision is refused in an agent session and every GUI/CLI
> confirm code is the act's own; holdouts are counts everywhere a session or the renderer can
> read; spend is reserved, capped, halted on unknown and charged at reservation after a crash; a
> specification corpus is content-addressed, sectioned deterministically, extracted blind,
> approved by a person, and a revision that moves a quoted passage breaks the authority chain
> until a person accepts the drift or re-emits; the real OLC corpus and plan go through map,
> validate, cargo `gate try`, register, extract and coverage from an agent session with the
> repository untouched. **What it does not prove:** live extraction or planning fidelity (the
> benchmark's recall, precision, scope and coverage on OLC are by construction, the report says
> so, and the mock extractor is the answer key); live authors (P2-R7: no model has run); the
> forged-pass residual (H2: a candidate that spells `process.exit` indirectly lands on the
> integration ref unread); `--accept-vacuous` (H1) and `trace` (M1) which no test exercises
> through the CLI; and `check` is green only with the pre-existing placement item.

Since that review, `--accept-vacuous` (R18) and `trace` (R17) are fixed and have tests. No
reviewer has re-run them.

---

## 5. OLC readiness and blockers

The OLC M0 build is the first real target. Its DESIGN stage ran on mocks on 2026-10-20 at
be93bf6 (`dry-run.md`). The final review repeated it on the integrated branch (§4.2).

**What the design run established** (`dry-run.md`):

- `map`: 16 files.
- `deps snapshot`: 18 registry crates, 777 files, 9.5 MiB.
- The plan: 28 build tickets across nine waves (wave 0 to wave 8). It validates at f26267f.
  M0.P5 is held by the blocking owner decision OM0.P5.
- One real cargo gate per ticket, plus four `cargo xtask ci` regression gates (P2-R16). M0.S1's
  gate is `falsified` at base. The ci gates are `supported`.
- Every guarded act was refused in the agent session, as designed.

**Daylight-side findings F1–F6** were ruled in P2-R41 and fixed in WS-R10 (ebbc043).

**OLC-side blockers for the owner** (`findings.md`, severities the design-run writer's own):

| # | Severity | Blocker | Owner action |
|---|---|---|---|
| B1 | High | `sha2`, `toml`, `unicode-normalization`, `rusqlite` (optionally `proptest`, `flate2`) are absent from the manifests and `Cargo.lock`; S1, Z1, G1, L1 would park in `waiting-dependency` | pre-add the crates and re-run `deps snapshot` |
| B2 | Medium | STATUS.md and the execution-plan ticket table disagree on dependencies | decide which is truth |
| B3 | Medium | P4's `build.rs` module path; fixed on the Daylight side by F1 (crate-root `build.rs` only), or rename to `build/mod.rs` (the plan at f26267f already does) | confirm |
| B4 | Medium | P5 (federation extraction) cannot be a campaign ticket | decide OM0.P5 (added to the plan as a blocking owner decision) |
| B5 | Low | the scaffold has no git history | give the repository a history (olc-prep.md §0) |
| B6 | Low | AGENTS.md's process text contradicts the campaign model | adopt the replacement text in olc-prep.md §2 |
| B7 | Low | gates fix public API names | read every gate before `lock` |

**Before the first real OLC campaign** (final-review §7):

- merge with fix 1 at least, which is now done (R18);
- delete and re-map the design-run `<out>` (I3);
- decide whether the first wave runs `--auto-apply integration-ref` knowing H2, or `none` with a
  person applying;
- pre-add the B1 crates and re-snapshot;
- read every gate before `lock`;
- keep `--review-roster` non-empty;
- treat the integration ref as untrusted until refine (P2-R43).

The proposed wave-1 envelope is in `findings.md`. It covers M0.S1, M0.E2, M0.Z1 and M0.G1 on the
`mock` roster. The owner fills in its spend figures.

**Not ready for a live run.** Live spend is unauthorised (P2-R7). The owner will revise the OLC
specification before the real build (P2-R48). The corpus revision path (`corpus revise`, P2-R59,
P2-R63) is the route for that revision, and it is tested end to end on mocks
(`forge-ingest-revise.ts`).

---

## 6. Fixture provenance

**No recording of a real agent exists in P2.** No provider binary ran as an agent at any point in
the build. Every agent output in the tests, probes, the e2e runs, the design run and the
benchmark comes from a mock, a scripted stand-in or a hand-written fixture.

- **OLC documents.** `engine/test/fixtures/ingest/olc/` holds 20 documents and a `NOTICE` (21
  files added). They are byte-identical copies of the owner's sources: spec v0.8, errata, the 15
  ADRs, AGENTS.md and architecture.md from the OLC scaffold (MPL-2.0), plus the Corpus Foundry
  v0.1 draft. The total is 170,237 bytes (r16-review §2; `du -sb` agrees).
  - The NOTICE names the source and says what was left out on purpose: the execution plan,
    STATUS, corrections, plates and older spec versions (answer leakage).
  - The copy was authorised by the owner, lean, with a NOTICE (P2-R52, P2-R53 O-b).
  - Data and config live beside the documents, never in code: `olc-config/` holds the manifest,
    the sectioner sidecar and seven seeds, and `olc-expected/` holds the benchmark's answers.
  - Answers include `ground-truth.json`: the 28 M0 build tickets parsed from
    `execution-plan.md`'s lane tables, committed with the source's digest. The plan file itself is
    not copied.
  - Answers also include an IR overlay of 563 records: 181 written by hand from a list the R16
    writer made, and 382 generated mechanically, one per remaining sectioner unit (r16-review
    §3b). "Hand-checked" means a person, here the writer agent, wrote the list. Nobody checked it
    independently.
- **Harbor Ledger, synthetic.** `engine/test/fixtures/ingest/harbor/` (25 files) is a port-logistics
  standard generated by `engine/test/lib/synthetic-corpus.ts`, with no PRNG or clock. It has its
  own label scheme, a section body over 40 KiB, its own seeds and its own ground truth. It is
  regenerated and compared byte for byte in the test (P2-R52, P2-R53 D-e). The fixture is 82,681
  bytes on disk at 31f277b (`du -sb`); r16-review measured 82,529 bytes before R16's fix round.
- **Mock extractors and the scripted person.** The benchmark's extractor is a script generated
  from the fixture (`engine/test/lib/bench-extractor.ts`). It runs as a child process like
  `DAYLIGHT_MOCK_ADAPTER`, and its attempts are recorded `mock` (P2-R61). The person's steps are
  `bench:<step>` actors, accepted only on a store marked `daylight_meta.bench = 1`. Export,
  import, `campaign run` and `forge apply` refuse that store. The benchmark never writes a
  `human:` row (P2-R61; final-review I6).
- **Rust fixtures.** `fixtures/rust-workspace/` (map provider) and `fixtures/cargo-workspace/`
  (cargo sandbox and gate harness) are small hand-written workspaces.
  `fixtures/cargo-workspace/Cargo.lock` pins crates.io versions. `forge-cargo.ts` fetches `itoa
  1.0.11` from crates.io once per run, unless `DAYLIGHT_OFFLINE=1`.
- **Renderer samples.** `app/renderer/lib/fixtures/forge-campaign{,-report,-refine}.sample.ts`
  are new synthetic samples. `fixture-shapes.check.ts` pins them to the engine's types in both
  directions (r9-review H1 fix).
- **Mock authors and reviewers in the campaign tests** are scripts named by
  `DAYLIGHT_MOCK_ADAPTER`, with rosters `mock`, `mock:a`, `mock:b`, labelled `mock` in every
  artifact, as in P1.
- **The OLC design run** ran against a copy of the owner's scaffold (`olc-repo-scaffold.zip`,
  2026-10-19) in the director's scratchpad, given a local history. It did not run against the
  owner's repository (`dry-run.md` Setup).

---

## 7. Limitations

- **Everything is mocks.** Nothing shows that a real model authors, reviews, extracts or plans
  under these profiles, sockets and prompts. On OLC, nine of the benchmark's checks are true by
  construction in mock mode. They are recall, id exactness, dependency recall and precision,
  paths, scope, boundaries, ticket refs and coverage. Harbor has the same set minus coverage,
  eight in all. The mock extractor is the answer key (final-review §1 and §7; `bench-olc.json`
  `nonFalsifiable`). Only `live-full` measures planning, and it is refused.
- **The forged-pass residual.** Code under test can exit or print the harness summary itself.
  A gate then reads as passed while the assertions never ran. This holds for node and cargo
  harnesses alike (wave-2 H1; security M1).
  - The P2-R49 heuristic is a line regex. It parks the obvious spellings of a raw stdout write, a
    libtest or TAP summary literal, or `process.exit` in library code. An indirect spelling still
    lands (final-review H2, `p1b-evade.ts`).
  - With `--auto-apply integration-ref`, the wave reviewer is the only reader of code before
    refine.
- **The system cargo.** `/usr/bin/cargo` from pacman, version 1.99. `rust-toolchain.toml` is
  ignored, and a target that pins another channel cannot be built faithfully (P2-R5, P2-R8).
- **Two one-off flakes**, both described in §3.1 and neither reproduced.
- **The self-approval guard is still a heuristic** (ADR-20, as in P1). The guard refuses under
  `CLAUDECODE` and `DAYLIGHT_SESSION`, and every act needs a confirm code. An agent that can
  compute the digest can compute the code. The benchmark's `bench:` actors are a separate,
  store-marked path, not an exception to the guard (P2-R61).
- **Defence in depth that is not wired.** The gate sandbox's root tmpfs is writable (r2 L4,
  security I5). Node is bound at its host path (security I1). Tolerated `rustflags` arrays are not
  inspected for a linker (wave-2 L6).
- **Benchmark caveats.**
  - The hand-written overlay was not checked independently (§6).
  - The OLC seeds were written by WS-R14 beside the detectors they exercise. INGEST.md asks that
    someone else review them.
  - The live-mode bars are OLC's numbers, written into the product file (final-review L3).
- **Smaller open items from the final review.** L1: a minified bundle outside vendor paths is
  mapped whole (19,100 symbols in the probe). L2: the mission-level `lock-gates` digest does not
  cover `--accept-vacuous`, while the campaign lock's does.
- **Read-only previews still create files.** A read-only command on an empty `<out>` creates
  `daylight.db` and `claims.db` (r5 L7, design-run F7). No rows are written. Not fixed.
- **Environment workarounds during the build.**
  - Offline `pnpm install` lacked `web-tree-sitter` in the store, so reviewers copied a
    worktree's `node_modules` (r5-review). As in P1, `node_modules/electron/dist` was copied from
    the main checkout.
  - The WS-R1 writer's install broke the main checkout's `node_modules` (r1-review H1). It was
    reinstalled from main's lockfile.

---

## 8. Timings, where measured

No systematic P0, P1 and P2 timing run was made in P2. The P1 timings (FORGE_REPORT §8) remain
the latest for `map`, `derive` and the P0 paths. Machine, where named: bwrap 0.13, cargo 1.99,
node 24.18 (final review).

| Operation | Figure | Source |
|---|---|---|
| `pnpm test:all` (88 steps, 5,878 assertions) | 12.5 min | final-review §1, run 1 at df45d3d. The test logs record no wall time. P1's figure was 138 s for 2,898 assertions (FORGE_REPORT §8) |
| `pnpm test:all` (5,927 assertions) under `bld` | 12 min 4 s (11:37:26–11:49:30) | this writer's run at ws/r19-docs; the start and end times were recorded around the command |
| OLC `map` (16 files, warm) | 415 ms | dry-run.md §1 |
| OLC `deps snapshot` (18 crates, 9.5 MiB) | 1.6 s | dry-run.md §2 |
| OLC `deps status` (full re-hash) | 0.4 s | dry-run.md §3 |
| snapshot re-hash before each launch | ≤ 0.5 s at 20k files (ruling); 0.4 s for 464 MB hot | P2-R29; p2-security-review I4 |
| cargo gate M0.S1, baseline, 2 runs | 2.84 s (2.54 s cold, 0.08 s warm) | dry-run.md §9 |
| cargo gate M0.E2, 2 runs | 1.64 s | dry-run.md §9 |
| ci-layers / ci-fmt | 0.80–0.88 s / 0.78–0.81 s | dry-run.md §9 |
| ci-clippy / ci-test | 3.57 s cold, 0.99 s warm / 4.62 s cold, 1.65 s warm | dry-run.md §9 |
| `gate try` M0.S1 in bwrap (CLAUDECODE=1) | 6.8 s wall | final-review §5 |
| `gate try` xtask `ci_test.rs` | 4.05 s | final-review §5 |
| `corpus extract`, 52 attempts, 563 records (mock) | 6.3 s | final-review §5 |
| `ingest bench --mode mock`, OLC / Harbor | about 14 s / about 2 s | WS-R16 writer's hand-off, as relayed in the R19 brief. This writer could not read a file that states it, so re-measured once below |
| the same, one run each at ws/r19-docs (tree equal to 31f277b's engine) | 13.6 s / 2.3 s wall, 17/17 both | measured by this report's writer with the DEMO.md command, `TMPDIR=/tmp` |
| gate base cache after the design run's baselines | 191 MB | dry-run.md §9 |
| `forge-cargo.ts` alone | 13.2 s (115 checks); 17.4 s (159) after R2's fixes | r2-review §1 and fix verification |

The jump in `test:all` from 138 s to 12.5 min is not broken down in any source. The cargo gate,
campaign and ingest suites are the new heavy files, but no per-file timing was recorded.

---

## 9. Unresolved risks

- **The forged-pass channel lands unread (High, accepted).** See §7. The control is procedural.
  The integration ref is untrusted until refine, a person merges to `main`, and the owner chooses
  `--auto-apply none` or `integration-ref` per wave (P2-R43; final-review §7).
- **Spend control is untested against a real provider.** The reservation is handed to the
  adapter as a soft ceiling. The reservation plus the halt rule is the control (P2-R18), and only
  mocks have reported costs. The first live run will be the first real test of `cost_source`
  from a provider in a campaign.
- **No live credential exists.** As in P1, ADR-30 and ADR-31 hold: the spend-capped dedicated
  credential has not been provisioned. Bubblewrap cannot filter egress, and the egress proxy is
  still deferred.
- **Benchmark by construction.** A green mock benchmark says the pipeline holds together and the
  scorer scores. It says nothing about whether a model can extract or plan the OLC corpus. The
  live thresholds are the owner's defaults, overturnable (P2-R53 O-c), and have never been
  exercised.
- **Cargo supply chain at snapshot time.** `deps snapshot` admits crates.io sources only and
  verifies the snapshot before every run (P2-R29, P2-R42 M3). The crates themselves, and their
  build scripts, run inside the gate and exec sandboxes, no-network. A malicious crate that the
  owner pre-adds (B1) runs there like any dependency.
- **Same-uid and heuristic limits carried from P1.** These are unchanged: the confirm guard (§7),
  same-uid races, and redaction misses (FORGE_REPORT §9).
- **`mission/store.ts` size.** The file was kept under the map's 200,000-character vendored
  threshold by trimming comments (b05b7c6). P2-R62 then changed vendored classification to need a
  path pattern or 1 MiB. Splitting the file is queued (P2-R62, P2-R66).
- **R17 and R18 were not reviewed independently.** They merged after the final review. Their
  closure of H1, M1 and M2 rests on their own tests and the director's record (P2-R67).

---

## 10. Deferrals and open owner decisions

### Decided by the owner during P2

| Ruling | Decision |
|---|---|
| P2-R1–R4 | Rust map by vendored wasm; per-project crate snapshot; split build caches; manifests protected, dependencies by request |
| P2-R8 | rustup on hold; pacman rust stays |
| P2-R9 | `campaign run` refused in agent sessions; a person launches it |
| P2-R10 | High wave-review findings become fix tickets, at most 5 per wave, inside the cap |
| P2-R33, R39 | Fable budget hold, then lifted, with the next work named |
| P2-R43 | the forged pass: record the issues and continue; autoApply default unchanged |
| P2-R46, R48 | spec ingestion adopted as wave 4; OLC spec v0.8 is current and will be revised before the real build |
| P2-R51, R52 | ADR and errata precedence is unordered; OLC documents may be copied into lean fixtures with a NOTICE, and Daylight stays project-agnostic |
| P2-R68 | merge `forge-p2` into `main` (no-ff) after these docs land, push `origin main`, then delete the worktrees |

### Still open

| Item | Question | Current behaviour |
|---|---|---|
| OLC B1–B7 (§5) | crates to pre-add, dependency truth, OM0.P5, history, AGENTS.md, gate review | no OLC campaign imported |
| ADR-30 / ADR-31 | one authorised live author run: target, dedicated spend-capped credential, cap | not authorised; real providers `unavailable` for implement |
| P2-R53 O-c | live-extract thresholds (unmapped normative ≤ 5 %, seeded contradictions 100 %) and live-full (recall ≥ 26/28, DAG edge precision ≥ 90 %); the owner confirms before any live run | owner defaults taken by the director, overturnable; live modes refused |
| P2-R43 / final H2 | `--auto-apply` per wave on a real target | default unchanged (`integration-ref`) |
| P2-R44 | ratchet default | unchanged; the owner may revisit |
| P2-R8 | rustup (WS-R2b) | on hold |

### Queued by the director (not owner decisions)

- **P2-R66.** Protect the lefthook `.lefthook/` script directory. Refuse lefthook
  `extends`/`remotes` that point outside the repo. Split `mission/store.ts` (also P2-R62).
- **P2-R67.**
  - Final-review L1: minified files outside vendor paths.
  - Final-review L2: `--accept-vacuous` in the mission-level lock digest.
  - Final-review L3: OLC's bars belong in `bench.json`.
  - The `forge-campaign-run-director` load flake.
- **Open from reviews and not ruled.**
  - Wave-2 L6: a linker in tolerated `rustflags`.
  - Security I1: node bound at `/opt/daylight/node`.
  - r2 L4 and security I5: the gate root tmpfs.
  - r5 L7 and F7: read-only previews create database files.
- **Deferred since P1 and still deferred.** Egress proxy, Docker/VM profile, signed decisions,
  non-Claude authors, model routing, CI/PR gates, seeded-mutation gate scoring, live console
  streaming. P2 delivered three of the items P1 had deferred: repair loops, crate snapshots for
  cargo gates, and rebasing a candidate by plumbing onto the moving integration tip (ADR-38). The
  last covers part of P1's "rebase onto a moved HEAD". Nothing in P2 moves HEAD or merges to a
  user branch.

---

## 11. Build ledger: who built what

**Method.** Token figures are the per-agent totals that the Claude Code harness reports. They are
cumulative per agent and include resumed rounds. They were recorded by the director in
`BUILD-LEDGER-P2.md`. **No price is applied anywhere and no dollar figure is given**, by rule. The
director (Fable 5.1, the coordinating session) wrote no code and made the rulings. Its own tokens
are not in the table. This report's writer could not see its own harness total, so that row reads
"not recorded" and is left out of the sums. The table is the ledger's, verbatim.

| Role | Model | Agent | Tokens | Outcome |
|---|---|---|---|---|
| planner | Opus 5.5 | director-loop interface proposal (v1–v3) | 472,736 | director-interfaces.md |
| reconciler | Fable 5.1 | director-loop reconcile (3 passes) | 283,807 | READY FOR WRITERS |
| writer | Opus 5.5 | WS-R1 Rust map provider (+2 fix rounds) | 268,556 | merged 5f58b37 |
| reviewer | Fable 5.1 | WS-R1 review + re-verification | 226,963 | MERGEABLE |
| writer | Opus 5.5 | WS-R2 cargo sandbox + gate harness (+2 fix rounds) | 402,428 | merged a16a87f |
| reviewer | Fable 5.1 | WS-R2 review + re-verification | 331,580 | MERGEABLE AFTER FIXES → fixed |
| writer | Opus 5.5 | WS-R4 project policy (+fix round) | 296,783 | merged 1826013 |
| reviewer | Fable 5.1 | WS-R4 review | 186,102 | MERGEABLE AFTER FIXES |
| reviewer | Opus 5.5 | WS-R4 fix verification (Fable hold) | 121,400 | MERGEABLE |
| integrator | Opus 5.5 | wave 1 (R4, R2, wiring, follow-ups) | 144,540 | dbc4156 |
| writer | Opus 5.5 | WS-R5 plan/campaign auth/assumptions (+fix round) | 562,827 | merged b0ed4c8 |
| reviewer | Opus 5.5 | WS-R5 first pass (Fable hold) | 314,288 | MERGEABLE AFTER FIXES |
| writer | Opus 5.5 | WS-R6 integration/scheduler/repair/wave review (+fix round) | 725,875 | merged 1dda558 |
| reviewer | Opus 5.5 | WS-R6 first pass (Fable hold) | 377,456 | MERGEABLE AFTER FIXES |
| integrator | Opus 5.5 | wave 2 (R5, R6, seam, campaign e2e) | 236,355 | d5abd9e |
| writer | Opus 5.5 | WS-R7 follow-ups | 207,047 | merged be93bf6 |
| reviewer | Fable 5.1 | wave-2 adversarial pass | 503,103 | H2, H3 → fixed |
| reviewer | Fable 5.1 | P2 security review (full diff) | 349,051 | H1 → fixed |
| writer | Opus 5.5 | OLC design-stage preparation + dry run | 306,682 | olc-work/daylight |
| planner | Opus 5.5 | refine interfaces (v1–v2) | 404,846 | refine-interfaces.md |
| reconciler | Fable 5.1 | refine reconcile (2 passes) | 283,807 | READY FOR WRITERS |
| writer | Opus 5.5 | WS-R10 real-repo fixes | 298,790 | merged ebbc043 |
| writer | Opus 5.5 | WS-R11 security fixes | 307,744 | merged f76166e |
| integrator | Opus 5.5 | R10 + R11 | 82,103 | 611aee6 |
| writer | Opus 5.5 | WS-R12 director fixes | 397,341 | merged 8a73d75 |
| writer | Opus 5.5 | WS-R13 leaks + forgery warning | 278,749 | merged 1ec6eeb |
| integrator | Opus 5.5 | R12 + R13 | 84,776 | 1ec6eeb |
| writer | Opus 5.5 | WS-R8 refine engine (+fix round) | 542,361 | merged f89c578 |
| reviewer | Fable 5.1 | WS-R8 review + re-verification | 389,494 | MERGEABLE AFTER FIXES → fixed |
| writer | Opus 5.5 | WS-R9 Mission Control screens (+fix round) | 494,911 | merged 9713c88 |
| reviewer | Fable 5.1 | WS-R9 review + re-verification | 406,561 | MERGEABLE |
| integrator | Opus 5.5 | wave 3 (R8, R9, spend-words) | 163,864 | eac4c0b |
| planner | Opus 5.5 | ingest interfaces (v1–v3) | 465,332 | ingest-interfaces.md |
| reconciler | Fable 5.1 | ingest reconcile (2 passes) | 270,755 | READY FOR WRITERS |
| writer | Opus 5.5 | WS-R14 corpus/sectioner/IR/coverage (+2 fix rounds) | 594,135 | merged eb78ce5 |
| reviewer | Fable 5.1 | WS-R14 review + re-verification | 418,850 | MERGEABLE AFTER FIXES → fixed |
| writer | Opus 5.5 | WS-R15 review/blueprint/packets/authority (+fix round) | 609,409 | merged 0f9c7d4 |
| reviewer | Fable 5.1 | WS-R15 review + re-verification | 377,608 | MERGEABLE |
| writer | Opus 5.5 | WS-R16 trace + benchmark (+2 fix rounds) | 952,920 | merged cd4f1f7 |
| reviewer | Fable 5.1 | WS-R16 review | 417,835 | NOT MERGEABLE → fixed on merged code |
| integrator | Opus 5.5 | wave 4 (R14, R15, R16, wiring, revise e2e) | 310,544 | df45d3d |
| writer | Opus 5.5 | WS-R17 leftovers + scoped regression | 220,228 | merged d7d6c62 |
| reviewer | Fable 5.1 | final adversarial pass (whole branch) | 520,774 | MERGEABLE AFTER FIXES |
| writer | Opus 5.5 | WS-R18 vacuous-lock fix | 99,736 | merged 31f277b |
| writer | Opus 5.5 | this completion report and the docs refresh (WS-R19) | not recorded | docs/daylight/FORGE_P2_REPORT.md |

Subtotals through 31f277b, re-summed from the table by this writer and equal to the ledger's own
figures (P2-R68), excluding the unrecorded report row:

- Opus 5.5 writers, planners, integrators and stand-in reviewers: **30 agents, 10,744,762
  tokens**. That is 18 writers, 3 planners, 6 integrators and 3 reviewers.
- Fable 5.1 reviewers and reconcilers: **14 agents, 4,966,290 tokens**. That is 11 reviewers and
  3 reconcilers.
- **Total: 44 agents, 15,711,052 tokens.**

The Outcome column is the ledger's own shorthand. Two entries need a gloss from §3.2:

- WS-R16's "fixed on merged code" means fixed on the R16 branch after it had merged the R14 and
  R15 tips (P2-R61), before cd4f1f7. The R16 reviewer did not re-verify those fixes.
- The wave-2 row's "H2, H3 → fixed" leaves out H1, the forged pass. That finding was accepted,
  not fixed (P2-R43).

**Writer and reviewer separation.** Every merged branch was written by an Opus agent in its own
worktree. Each branch's review was done by a different agent.

- Fable reviewed WS-R1, R2, R4, R8, R9, R14, R15 and R16.
- During the Fable hold (P2-R33), Opus agents reviewed R4's fixes and gave R5 and R6 their first
  pass. These were separate agents from those branches' writers. The integrated code was then
  reviewed by Fable: the wave-2 pass and the security pass at be93bf6, and the final pass at
  df45d3d.
- Reviewers worked read-only and mutated only scratch copies.
- Integrators were Opus agents. Their direct commits on `forge-p2` carry Opus trailers. The
  director's merges carry Fable 5.1 trailers (§2).
- No tie-break agent appears in the ledger.

**Interfaces before code.** Each multi-writer wave had an Opus planner proposal and a Fable
reconcile, ruled READY FOR WRITERS before any writer branched: `director-interfaces.md` v3
(waves 1–2), `refine-interfaces.md` v2 (wave 3) and `ingest-interfaces.md` v3 (wave 4). Each
seam then landed first as a step-0 stub on `forge-p2`: 7a10baa, 5f6362a and 7f3f776 (P2-R26,
P2-R47, P2-R53 D-f).

**The director's role.** The director wrote no code. It did the following:

- issued P2-R5–R7, R11–R32, R34–R38, R40–R42, R44–R45, R47, R49–R50 and R53–R67, and recorded the
  owner's rulings (§10);
- set the merge order;
- wrote the briefs;
- merged in order;
- kept TRACKED.md and the ledger.

---

## 12. Rulings index

ADR-36 to ADR-44 were written during P2. Each one names the rulings it rests on (`Status` line).
Rulings with no ADR settle a workstream's design documents (CARGO.md, POLICY.md) or a review
finding. **(owner)** marks the owner's own rulings. P2-R1–R4 are owner-decided, by the file's
heading.

| Ruling | One line | Settles |
|---|---|---|
| P2-R1 (owner) | Rust map parser: vendored, pinned web-tree-sitter + tree-sitter-rust wasm, digest asserted; no native bindings | WS-R1; README "Languages the map reads" |
| P2-R2 (owner) | Crate source = per-project snapshot, mounted ro as CARGO_HOME, cargo offline; refresh only by `deps snapshot` | CARGO.md ("install snapshots, brought forward from P2") |
| P2-R3 (owner) | Split persistent build caches outside the repo; author cache wiped on a violation; gate never mounts it | CARGO.md |
| P2-R4 (owner) | Manifests, lockfiles, `.cargo/`, `rust-toolchain.toml`, `build.rs` protected; dependencies by request | POLICY.md; amended by R41 F1 |
| P2-R5 | System `/usr/bin/cargo` in the sandbox; no rustup | CARGO.md |
| P2-R6 | Policy at `<repo>/daylight.policy.json`, itself protected; absent = Node defaults | POLICY.md; superseded in part by R32 |
| P2-R7 | Live model spend not authorised; every test on mocks | FORGE_PLAN §8; ADR-44 |
| P2-R8 (owner) | rustup on hold; WS-R2b shape recorded | §10 |
| P2-R9 (owner) | `campaign run` refused in agent sessions | ADR-37 |
| P2-R10 (owner) | High wave findings → fix tickets, ≤ 5 per wave, inside the cap | ADR-39 |
| P2-R11 | Unknown cost halts; never charged at cap, never summed as zero | ADR-38 |
| P2-R12 | Authors cannot raise assumptions through MCP | ADR-42 (cited) |
| P2-R13 | The director never writes STATUS, gaps or plans into the repo | ADR-43 |
| P2-R14 | Export/import of campaign children refused | ADR-37 |
| P2-R15 | DB stays v2; `SCHEMA_DIGEST` refuses P1 files; noun `campaign` kept | ADR-36 |
| P2-R16 | Regression gates are ordinary R2 gates; no arbitrary-argv harness | ADR-36 |
| P2-R17 | Ratchet is explicit in the lock scope | ADR-38 |
| P2-R18 | Spend reservations on `attempts.max_cost_usd` | ADR-38 |
| P2-R19 | `recordDecision` refuses `campaign:` actors; only `recordDerivedDecision` writes them | ADR-37 |
| P2-R20 | Envelope `maxTurns` from policy; `GateHarness` declared once; plan validation reads policy at the plan commit | ADR-36 |
| P2-R21 | `TicketStatus waiting-dependency` | CAMPAIGN-RUN.md |
| P2-R22 | `integrate-candidate` transaction owned by WS-R6 | ADR-38 |
| P2-R23 | A ticket refused at preflight closes inconclusive with a `blocked` need, never redispatched | ADR-38 |
| P2-R24 | `--dry-run` and read-only campaign commands allowed in agent sessions | ADR-37 |
| P2-R25 | `campaign retry` releases the work item; the read-only set named | ADR-37 |
| P2-R26 | R5 interface stub lands first; `recordDerivedDecision` guarded by a `forbidden-call` invariant | ADR-37; step-0 pattern |
| P2-R27 | A retried work item may be built by a new mission | ADR-37 |
| P2-R28 | Gate build cache per candidate, reflink-seeded from `gate/base/` | r2-review H2; CARGO.md |
| P2-R29 | Snapshot identity over the whole root; config/credentials refused; host fetch from `/` | r2-review H3, H4 |
| P2-R30 | Cargo result read only with exactly one `Running …` line; limits; resource kill = invalid | r2-review H1, M1 |
| P2-R31 | Rust heritage back to the parent is module structure, not a cycle | r1-review M2 |
| P2-R32 | Every built-in protected set applies always; policy only tightens; install and hook paths added | r4-review M1–M4; POLICY.md |
| P2-R33 (owner) | Fable budget hold until 05:00; Opus verifies meanwhile | §3.2 |
| P2-R34 | CLI ownership of run/baseline/lock/halt/resume/adopt-tip is WS-R6; fix-lane envelope in the store | r5-review M1, M4 |
| P2-R35 | Every director attempt reserved and cap-checked; unknown checked before landing; `landIntegration` refuses non-accepted | r6-review H1, M1–M4; ADR-38 |
| P2-R36 | R5/R6 seams: `fileFixTicket`, `admission()`, `.admitted`, refusals block a ticket | r6-review M5–M7; ADR-39 |
| P2-R37 | Plan gate stdout marker; holdout basenames withheld from every event; `--out` from the repo; `languages` picks harness | WS-R7 |
| P2-R38 | `--out` rules for id-only subcommands; `gate add` may print a holdout path to its operator; lefthook variants queued | WS-R7 |
| P2-R39 (owner) | Fable hold lifted; wave-2 adversarial + security review; OLC design run; refine planner | §3.2 |
| P2-R40 | refine-interfaces O1–O10 defaults; confirm covers every campaign operation | ADR-40 |
| P2-R41 | OLC design-run findings F1–F6 ruled (crate-root `build.rs`, previews in sessions, new-file scopes, nested cargo output invalid, `deps snapshot` refused in sessions, `gate try`) | WS-R10; CARGO.md, POLICY.md |
| P2-R42 | Security fixes: per-run gate caches, DP glob matcher, crates.io-only snapshot, L1–L5, Info; M1 to the owner | p2-security-review; WS-R11 |
| P2-R43 (owner) | Forged pass: record and continue; autoApply default unchanged; a forgery-shape tightening added | wave-2 H1, security M1 |
| P2-R44 | Crash charged at reservation; retry honoured; no-sandbox refuses the run; resume never lands the halting candidate; Lows | wave2-review; WS-R12 |
| P2-R45 | Previews exit 2; GUI confirms through `daylight confirm`; `identity` never a renderer field; Refine read-only; holdout counts in refusals | refine-interfaces-review; ADR-40 |
| P2-R46 (owner) | Spec ingestion adopted as wave 4, parallel to OLC wave 1; benchmark ground truth = OLC M0 | ADR-41 |
| P2-R47 | refine-interfaces v2 ready; forgery-shape is focus tier 2; `regressed` → `blocked` | ADR-40 |
| P2-R48 (owner) | OLC spec v0.8 is current; the owner will revise it before the real build | §5 |
| P2-R49 | `gate-forgery-shape` is a curable acknowledged warning that parks the candidate | POLICY.md "Test-output forgery shapes"; amends R43 |
| P2-R50 | Ingest defaults: emitted packets become the plan only when committed and imported by descent; unbound obligations fail closed; Q5, Q7–Q9, Q14–Q15 | ADR-41 |
| P2-R51 (owner) | ADR vs errata precedence unordered; Corpus Foundry v0.1 arrived | ADR-41 |
| P2-R52 (owner) | OLC documents may be copied into lean fixtures with a NOTICE; nothing OLC-specific in code; a second synthetic corpus | ADR-41, ADR-44; §6 |
| P2-R53 | Ingest-review rulings: derived staleness, one `PlanFile`, generic outbox server, `blocksOn`, constants as data, three bench modes; owner defaults O-a–O-c | ADR-42, ADR-43 |
| P2-R54 | Milestone label schemes are per-domain config | ADR-41 |
| P2-R55 | Regression re-check once per wave, scoped by default | WS-R17 |
| P2-R56 | Wave-4 merge rules: approve calls only from the review commands; integrator wiring list | ADR-43; wave-4 integration |
| P2-R57 | `ingest bench` is product code; corpus and answers are `--fixture` data; mock extractor by script | ADR-44 |
| P2-R58 | One staleness definition (R15's `isIrStale`/`irSetDigestAt`) | r14-review M-2, M-3; ADR-43 |
| P2-R59 | Spec authority consulted at every authorizing act; `--accept-ir-drift`; store guards; holdout names out of packet text | r15-review H1, M1, L4; ADR-43 |
| P2-R60 | Spend wording in one pure module; plan-text holdout warning; bare flags recorded apart | wave-3 integration; r8-review M2 residue, I1 |
| P2-R61 | The benchmark never impersonates a person: bench-marked store, `bench:` actors, child-process extractor, stable finding keys | r16-review (b), (c), H2 |
| P2-R62 | `looksVendored` needs a path pattern or ≥ 1 MiB; split store.ts queued | wave-4 integration |
| P2-R63 | Corpus identity content-addressed; revision key (corpusDigest, configDigest) | r14-review F-1, F-2 |
| P2-R64 | Bundle-marker test in `test:all`; report `holdouts` pinned as counts | r8-review note b |
| P2-R65 | `ingest-approvals-callers` exempts `ingest-bench.ts`; R16's frozen-file additions accepted | wave-4 integration |
| P2-R66 | Queued: lefthook script dir, lefthook extends/remotes, split store.ts | §10 |
| P2-R67 | Close-out: final H1 fixed by R18, M1/M2 by R17; L1–L3 and H2 open; load flake to hunt | final-review |
| P2-R68 (owner) | Merge `forge-p2` into `main` (no-ff) after WS-R19's docs, push, delete worktrees; P2 ledger totals | §10, §11 |
