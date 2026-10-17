# Daylight Software Forge — P1 completion report

Status: written 2026-10-16 at `daylight` @ 15efdfc (the WS9 merge), before the P1 acceptance run
finished. Sections 4 and 8 were then filled from `ACCEPTANCE-P1.md`, the engine and CLI phase of
acceptance (logs in `acc/`). The UI halves of acceptance wait for an unlocked desktop. The owner's
decisions of the same day (R17: author exec allowed as option (a), trailer attribution kept) are
recorded here. The exec flip and the acceptance fixes merged as **28b6835**, the final P1 commit
on `daylight`, on 2026-10-17. The GitHub repository is being renamed from its pre-rename name to
`mackerson/daylight-forge` on 2026-10-16. The local directory name is unchanged.

This is the completion record for the P1 case study. Every number in it comes from a named
source: git on `daylight`, the decision record `docs/daylight/FORGE_PLAN.md` (ADR-8 to ADR-35),
`docs/daylight/DEMO.md`, the frozen P0 records `BASELINE.md` and `MEASURED.md`, and the build's
working papers. The working papers are not in the repository. They are the director's rulings
(`RULINGS.md`, R1–R17), the reconciled plan (`PLAN.md`), `interfaces-reconciled.md`,
`TRACKED.md`, `BUILD-LEDGER.md`, and every writer report and reviewer review. A figure with no
source is marked as such.

Two conventions:

- A **test count** is the sum of every `N passed, M failed` line printed by `pnpm test:all`, the
  method the project's `tally.sh` uses. It counts assertions, not test files.
- **Severities** are the reviewer's own (High, Medium, Low, Info). Writers' self-assessments are
  not counted.

---

## 1. What P1 delivers, and what it does not

### Delivered

P1 turns Daylight from a tool that reviews code into one that writes code under evidence:
protected specification, then a scoped author workspace, then an independent test, then an
approved merge (FORGE_PLAN §1).

- **Implement missions.** An implement mission comes from an approved work item, or from a
  recorded human `adhoc-mission` decision (R10.1). It starts as a `draft` with write off. Only
  the guarded human act `mission authorize` turns write on (ADR-9, ADR-34). The store refuses any
  write attempt that lacks a matching authorize decision.
- **Sandboxed authors.** `forge run` gives the author a detached workspace, with no git worktree
  and no host hook (ADR-8). The author runs in the bubblewrap `author` profile: write on the tree,
  network `none`, exec only on an explicit grant (from 28b6835), environment cleared, and `<out>`
  and `$HOME` never mounted. It reaches
  MCP through one token-checked socket per attempt (R11.2). The result is a candidate with a
  redacted diff. The author's narrative is labelled unverified and never feeds the verdict
  (ADR-19).
- **Gates and holdouts.** Both must be `falsified` at the base before a human locks them, and a
  vacuous gate is refused unless explicitly accepted (ADR-18). The lock refuses a gate set that
  moved after confirmation. The verdict is a pure function of the gate rows, the diff digest and
  policy (`verdict-is-pure`). Holdout content never reaches the author or the renderer process.
- **Approve and apply.** Only an `accepted-by-gates` candidate can be approved, with the verdict
  recomputed at decision time. Every policy violation is uncurable (R15.4). Apply builds and
  verifies the commit in a scratch repo by plumbing, then writes a create-only ref
  `refs/heads/daylight/<missionId>`. HEAD, the index and the working tree are never touched, and
  no hook runs (ADR-17). An implement mission cannot close as succeeded without an application
  (ADR-23).
- **Ledger.** Usage is recorded per turn and deduplicated. `cost_source` is `provider`,
  `stdout-scan` or `none`, and only `provider` counts as known (R10.2). `report --project` never
  prints unknown as `$0.00`. Trailers carry ids only (ADR-29). No price table is allowed
  (invariant).
- **Ingester.** Claude Code sessions become `work` missions that store digests, counts and vetted
  paths, never text (ADR-15). Ingested attempts are labelled "outside Daylight's controls"
  (R12.1).
- **Work items.** Blind mock decomposers propose work items through MCP. The proposals are
  redacted, consumed once and never turned into gates automatically.
- **UI.** The Forge screens are work items, implement detail, gate set, candidate review, ledger
  and ingest. They also carry a derived `needs` strip (ADR-13). Every decision goes through main:
  OS-user actor, confirm preview, native dialog (R14 S-8).

Two cross-cutting changes underpin all of this:

- **WS-R rename.** The product became Daylight Software Forge, with CLI `daylight` and the
  `DAYLIGHT_` env prefix. The default `<out>` now lives outside the repository, under the XDG
  data home (ADR-26, ADR-27).
- **WS1 schema v2.** There is no migration code. A v1, unversioned, other-DDL or non-SQLite
  database is refused with one line and left byte-for-byte as found (ADR-22, ADR-25).

### Deliberately not delivered

- **No live provider run.** Every author, reviewer and decomposer in P1 is a mock
  (`DAYLIGHT_MOCK_ADAPTER`, `mock:<x>`). `claude`, `codex`, `grok` and `opencode` are
  `unavailable` for implement (ADR-31, R15.1). A real-provider review runs only when the operator
  passes `--unsandboxed-review`, and then exactly as P0 did, with a warning (§9, H5). The live
  author run and its spend-capped credential are not authorised (R9.4).
- **Author exec: decided (R17.1), in effect since 28b6835.** Through 15efdfc, `exec:true` was
  refused (R15.5). The owner chose (a). Exec is now the nested, no-network `run` MCP tool, allowed
  only when the mission's `authorize` decision grants it. Gate tests are never mounted. Every
  `run` call is recorded as `attempt.exec` events plus artifacts, and exec is counted from those
  events. No column was added, so v2 databases stay readable. The acceptance run (§4) predates
  the flip.
- **No gate dependencies.** Gates must be zero-dependency or vendored. Install snapshots are P2
  (R4 Q1a, ADR-28).
- The rest of the deferred list is in §10.

---

## 2. Changed files, by workstream

Source: `git log --first-parent -m --shortstat 13a5775..15efdfc`. Each row is the merge commit's
change against the previous `daylight` tip. Every workstream merge has exactly its merged head's
tree (checked with `git log --format=%T`), so the counts measured at those heads (§3) hold for
the merge. The exception is 4bfdbe5, the plan, whose branch started from an older tip.

| Order | Merge | Workstream | Files | Insertions | Deletions | Main new or changed surface |
|---|---|---|---|---|---|---|
| 1 | 0334326 | WS0 P0 hardening | 30 | 1,970 | 172 | `experiment/{runner,sandbox}.ts`, `mission/*` (store, orchestrate, export, events, project), `swarm/{capture,normalize,adapters}.ts`, `mcp/server.ts`; new `mission-words.test.mjs` |
| 2 | 4bfdbe5 | FORGE_PLAN (ADR-8..35) | 1 | 607 | 0 | `docs/daylight/FORGE_PLAN.md` |
| 3 | 26a0f05 | WS-R rename | 94 | 948 | 502 | 88 modified, 4 added (`engine/paths.ts`, `test/{mcp-names,out-default,naming}.ts`), 2 renamed (`daylight.{invariants,target}.json`) |
| 4 | 44471bf | Lows sweep | 18 | 386 | 41 | `cli.ts`, `swarm/{adapters,capture,types}.ts`, `experiment/runner.ts`, `test/harness.ts`, `app/main/main.cjs`, `Explore.tsx`; new `test/adapters.ts` |
| 5 | 9caf046 | WS1 contracts + schema v2 | 20 | 3,552 | 177 | new `forge/{policy,confirm}.ts`, `app/main/daylight-db.cjs` (+test), `test/forge-{schema,policy}.ts`; `mission/{types,db,store,export,project,events}.ts` |
| 6 | 4cbd1ab | WS6 transcript ingester | 17 | 1,524 | 1 | new `ingest/{claude-code,commands,cursor}.ts`, `test/ingest.ts`, 9 synthetic transcript fixture files; `mission/redact.ts` (+shapes) |
| 7 | 8d28636 | WS3 gates + verdict | 10 | 1,955 | 70 | new `forge/{gate,verdict,commands-gate}.ts`, `test/forge-gate.ts`, a temporary `forge/_stubs/workspace.ts`; `experiment/{runner,types}.ts` |
| 8 | 0e91a5e | WS7 spec intake + work items | 13 | 2,075 | 10 | new `forge/{spec,decompose,proposal,work-items,commands-work-item}.ts`, `test/spec.ts`; `mcp/server.ts`, `mission/{db,store}.ts` |
| 9 | ec7821a | WS2 workspace, sandbox profiles, MCP socket | 11 | 2,427 | 9 | new `forge/{workspace,sandbox,authors,diff}.ts`, `test/forge-{workspace,sandbox}.ts`; `mcp/server.ts`, `swarm/adapters.ts` |
| 10 | 4c454fe | WS5 ledger + usage | 11 | 1,603 | 45 | new `mission/{ledger,commands-report}.ts`, `swarm/usage.ts`, `test/ledger.ts`; `swarm/{capture,normalize,adapters}.ts`, `mission/redact.ts` |
| 11 | f51e08e | WS4 approve + apply + trailers | 14 | 1,445 | 19 | new `forge/{decide,apply,trailers,commands-decide}.ts`, `test/forge-apply.ts`; `forge/confirm.ts`, `mission/{db,store,types,export}.ts` |
| 12 | 8b625a1 | Redaction shapes, two tiers | 5 | 762 | 36 | `mission/redact.ts`, `forge/diff.ts`, new `test/redact.ts`, one invariant |
| 13 | 594f163 | WS8 orchestration + CLI + e2e | 25 | 2,390 | 310 | new `forge/{orchestrate,commands}.ts`, `mission/needs.ts`, `test/forge-e2e.ts`; `_stubs/` deleted; `cli.ts`, `mission/*`, `app/main/{main,daylight-db}.cjs`, DEMO.md |
| 14 | 15efdfc | WS9 Mission Control screens | 21 | 3,362 | 49 | new `app/main/forge.cjs` (+test), 8 new screens, `forge-words.{ts,test.mjs}`, 3 synthetic `forge-*.sample.ts`; `App.tsx`, `MissionDetail.tsx`, `types.ts`, `main.cjs`, `preload.cjs` |
| 15 | 28b6835 | Exec decision (R17), `--help` handling, acceptance fixes | 24 | 636 | 155 | exec as the nested `run` tool on an explicit grant, recorded as `attempt.exec`; `--help` honoured on every subcommand; holdout paths withheld from replay and gate list; work-item preview; DEMO.md made to run as written |

Net, `git diff --stat 13a5775..28b6835`: **178 files changed, 25,288 insertions, 1,242
deletions.** The rows above add up to 25,642 insertions. That is more than the net figure because
later merges rewrite lines added by earlier ones.

---

## 3. Tests run and results

### 3.1 Test-count ladder

Every figure is a full `pnpm test:all` measured at the branch head that the merge took. Because
each merge tree equals its head's tree (§2), each figure is also the count for that merge. All
runs ended with 0 failed.

| After | Assertions | Files | Δ | Source |
|---|---|---|---|---|
| P0, 13a5775 | 1,197 | 35 | — | `ws0-baseline.log` |
| WS0, 0334326 | 1,343 | 36 | +146 | ws0-review §9 at 878cf7e (`rv2-testall.log`) |
| FORGE_PLAN, 4bfdbe5 | 1,343 | 36 | 0 | ws-r-review §6, baseline row at 4bfdbe5 |
| WS-R, 26a0f05 | 1,407 | 39 | +64 | ws-r-review §6 at 3cb1f39 |
| Lows, 44471bf | 1,442 | 40 | +35 | lows-review "Measured" at ff945c6 |
| WS1, 9caf046 | 1,794 | 43 | +352 | ws1-review fix verification at f169a57 |
| WS6, 4cbd1ab | 1,894 | 44 | +100 | ws6-review fix verification at baaf1f8 |
| WS3, 8d28636 | 2,043 | 45 | +149 | ws3-review fix verification at 63cd72e |
| WS7, 0e91a5e | 2,210 | 46 | +167 | `ws7-final.log` from the WS7 worktree, last written 20:08, summed with `tally.sh`. No report or review states this post-rebase figure in prose. The reviewer's last count was 1,961/44 at 63c2800, before the rebase. |
| WS2, ec7821a | 2,442 | 48 | +232 | ws2-report "Second update" at 65a472e (writer). The reviewer's last count was 2,119/46 at b58fe72, before the final rebase. |
| WS5, 4c454fe | 2,545 | 49 | +103 | ws5-report "Measured" at f7ed74d (writer); matches `ws8-baseline.log` |
| WS4, f51e08e | 2,669 | 50 | +124 | ws4-review fix verification at b5e5c8a |
| Redaction, 8b625a1 | 2,794 | 51 | +125 | redact-review fix verification at 59d74f6 |
| WS8, 594f163 | 2,898 | 52 | +104 | ws8-review fix verification at e4c571f |
| WS9, 15efdfc | 3,032 | 54 | +134 | ws9-review delta verification at ce04b81 |
| Exec flip + acceptance fixes, 28b6835 | **3,104** | **55** | +72 | coordinator's post-merge report (typecheck, build, check clean); not re-run here |

From P0 to 28b6835: **+1,907 assertions, +20 files**. The count was at or above the WS-R
baseline (1,407) at every step after WS-R, which is the FORGE_PLAN §9 requirement.

At the WS9 merge, the ws9-review delta section reports:

- `pnpm typecheck`: clean (engine and renderer).
- `node engine/cli.ts check . --warn-only`: 17 green, 0 red, 0 target violations. One advisory,
  "Place 6 file(s)", unchanged since WS1.
- `vite build`: OK, 1,002,037 bytes. The bundle is byte-identical to the worktree's build. Each of
  11 engine runtime markers (for example `node:sqlite`, `child_process`, `assertHumanDecision`)
  appears 0 times, and so does the holdout sentinel.

The invariant count in `check` grew from 6 green at P0 to 17 at WS8, one or two per workstream.

Flakes:

- The one `forge-gate.ts` flake was traced to same-millisecond lock ordering and fixed
  (cea8692).
- WS8 and acceptance each ran `test:all` three times with no flake.
- `test:all` needs a short TMPDIR: a deep one exceeds the 108-byte Unix socket path in
  `forge-sandbox.ts`.

### 3.2 Review loop

Each workstream had an Opus writer and an independent Fable reviewer, who was given the code,
PLAN and RULINGS and treated the writer's claims as hypotheses. Each fix round was then
re-verified by the same reviewer. "Fixed" below means fixed and re-verified by the reviewer
against code and probes. "Mutations" means the reviewer removed a protection in a scratch copy and
counted the tests that went red.

| WS | Found (H/M/L/Info) | Fixed and re-verified | Left open at merge | Mutations by the reviewer |
|---|---|---|---|---|
| WS0 | 30 audit findings in scope, first verdict: 26 closed, 3 partial, 1 regression. Plus R1 (Medium) and Lows R3–R6 | Sec M8 regression (fec9b36), Sec H3 smudge filters (1ed128f), Ledger M4 blind half (878cf7e, ADR-6 amended by ruling) | R1 legacy event-id dedupe (Medium), accepted under R2, still not landed at HEAD (`legacyRunEventId` absent). Ledger M9 partial until WS1's column. Back-link Low (fixed later in the lows sweep) | None. The writer reports each regression test was seen failing first |
| FORGE_PLAN | 2/4/4/0 | Required edits visible in the merged doc (ADR-6 amendment §3, WS0 status §2, ADR-8 caveat, planted fixture §9, R1–R9) | No re-review file exists; the BUILD-LEDGER says "fixed" | n/a |
| WS-R | 0/0/4/3 | Merged as is; L1–L4 fixed later in the lows sweep | — | MCP name drift broken three ways, each red |
| Lows | 0/0/3/5 | Merged as is | F1 (signal-killed tests leak a tmp dir), F2 (launcher sign-in hint), F3 (shallow-clone flag order) | None. The writer reports its tests failing before the fixes (e.g. 7 of 13) |
| WS1 | 1/4/9/3 | H1, M1–M4, L1–L5, L7, L8, L9, plus R-8, R-12, D-7 (L6 by rebase) | New L10 (an honest export of a later-revoked mission is refused); I4, I5 | None. Probes `p1`–`p4` |
| WS6 | 0/1/8/5 | M-1, L-1, L-2, L-3, L-4, L-6, each with a test that goes red when removed. L-5 and L-8 documented | L-7 (ownership, integrator) | 12 code and 2 invariant mutations. All red except M9 (0 red), M2c and M7 (unit test only) and INV2 (aliased write, invariant green). Each fixed test was re-mutated red |
| WS3 | 0/0/5/6 | L-1, L-2; L-3 as an interim (the store-side refusal landed in WS8) | L-4, L-5 documented | 8 mutations, all red; rerun after fixes, all red |
| WS7 | 0/2/6/1 | F1 (raw secret in outbox), F2 (DDL changed under v2, now a schema digest), F5, F7 | F3, F4, F6, F8 accepted as Low | 14 mutations, 13 red (M7 green, which was F5). Fix round N1–N6 red; N2/N3 alone green, as redundant layers |
| WS2 | 0/2/2/0 | F1 (`<out>` required everywhere), F3 (deny-by-default under `$HOME`), F4 (1 MiB frame cap) | F2 (redaction shapes) went to the redaction workstream and closed there. F3b residual: the writer reports fixing it in 65a472e; not re-reviewed | Authorization refusal removed: 1 red. `protected-path` removed: 16 + 3 red. R7 invariant red in three forms; misses `--bind` in a bare array literal (disclosed) |
| WS5 | 0/3/5/1 | F1 (glued keys; reopened for WS6's shapes, closed at 366480f), F2, F3, F7, F8 | F4 (no count of malformed usage lines), F5 (id-less turns) open Low; F6 ownership | 12 mutations, 11 red; M11 (unused price table) 0 red, which was F3. After the fix, the invariant goes red on named tables; a bare literal stays silent (accepted) |
| WS4 | 0/1/7/9 | M-1 (every policy rule uncurable), L-1 (no objects left on a failed apply), L-3 (three missing tests), I-6 | L-2, L-4, L-5, L-6, L-7 (director or WS8 hand-offs) | 17 mutations, 13 red. Round two: m07, m11, m15, m18, m20 red; m19, m21, m22 green (explained as redundant or Info) |
| Redaction | 1/2/8/4 | H1 (`redis://:pass@`), M1 (colon-form generic names), L1, L6 | M2 moved to TRACKED and closed downstream (WS8 ba49d9c records `possibleSecretHits`; WS9 D6 checkbox). L2–L5, L7, L8 open | 8 mutations, all red. Each fix reverted in scratch, red |
| WS8 | 2/2/6/0 | H1 (holdout content via `events` and `artifact`), H2 (review sandbox failed open), M1 (P0 `mission decide` unguarded), L1–L4 | M2 (delta list) went to WS9 and closed there. L5 (`/work/.git` writes vanish unflagged) open, WS2's. L6 partly | 3 mutants (H1, H2, M1 checks), all detected |
| WS9 | 0/2/6/4, plus L7 in the delta pass | M1 (closed upstream by WS8), M2, L1, L3, L5; L6 satisfied by WS8's full-set default | L2 (`$0.00 today` P0 strip), L4 (two "need you" counts; did not reproduce on e2e data), L7 cosmetic. Pixels not checked in the delta pass (desktop locked; DOM only) | Not run by the reviewer. The writer's mutation (4 checks failed) is reported unverified |

Totals across the P1 workstreams, excluding WS0 whose audit findings came from the P0 reviews:
**6 High, 23 Medium, 73 Low** found. Every High was fixed and re-verified before its merge.

BUILD-LEDGER.md first said "every High/Medium finding was fixed and re-verified before merge".
It has since been corrected (§11). The claim is true for every High. Four Mediums instead closed
in a later workstream, by design:

- WS2 F2 closed in the redaction workstream.
- Redaction M2 closed in WS8 and WS9.
- WS8 M2 closed in WS9.
- WS9 M1 closed in WS8.

One Medium, WS0 R1, was accepted under R2 and never fixed.

---

## 4. P1 acceptance checklist

Source: `ACCEPTANCE-P1.md` (engine and CLI phase, 2026-10-16 22:28–23:00), with logs in `acc/`.
How it was run:

- private TMPDIR and XDG data home;
- mocks only, with stub `claude`, `codex`, `grok` and `opencode` first on PATH, each logging every
  spawn and exiting 99;
- no `--probe`, no GUI, no live run;
- `CLAUDECODE` and `DAYLIGHT_SESSION` unset so human decisions could be taken (the `CLAUDECODE=1`
  refusal was exercised separately), so every decision is recorded as the OS user.

HEAD moved during the run. Steps 1–3b ran on 594f163 (WS8). Steps 4 (security) and 5 (timings)
ran on 15efdfc (WS9). The acceptance file reports that `engine/` is byte-identical between the
two, so the engine and CLI results hold for both.

**Tally, as the acceptance file states it: 32 items. 29 PASS, 2 PARTIAL (criteria 5 and 7),
1 PASS by inspection (R15.3), 0 FAIL.** The UI halves of criteria 2 and 6 are deferred to the
unlocked-desktop phase, not failed.

| # | Criterion (FORGE_PLAN §9) | Status | Note from the acceptance file |
|---|---|---|---|
| 1 | Spec intake: two blind decomposers, one `spec-ambiguity`, approve one, neither proposal visible to the other | PASS | Ambiguity needs two different mock scripts; one script for both decomposers yields identical proposals and no ambiguity |
| 2 | Authorize: draft write:false → `mission.authorized`, write:true on mission, attempt row and UI | PASS (CLI); UI deferred | DB `sandbox_write=1` with `authorize_decision_id` |
| 3 | Gates: gate + holdout falsified at base; vacuous third refused at lock; lock with rationale and digest | PASS | Lock digest equals preview digest; locked with `--only` |
| 4 | Run: mock author in bwrap, workspace created and removed, checkout untouched, redacted diff, narrative unverified | PASS | Author env was PATH, HOME, PWD only; no workspace or socket dir left behind |
| 5 | Verdicts: accepted; no-diff; policy violation for `.daylight-gates/**`; `secret-in-diff` via `/proc/self/environ` | PARTIAL | The first three hold. The environ variant cannot yield `secret-in-diff`, because the sandbox env is scrubbed (a good property). It was proven instead with a literal `sk-ant-…` token, which is uncurable. The criterion should be reworded |
| 6 | Approve only the accepted candidate (CLI, GUI); override needs rationale; ref with trailers, no dollars or tokens; HEAD and tree unchanged; close refused before apply, allowed after | PASS (CLI); GUI deferred | Trailers observed: `Daylight-Mission`, `Daylight-Attempt` and the mock's `Co-Authored-By`; 0 cost or token matches. This is the id-only set, not ADR-29's full list (§7) |
| 7 | Report: `≥ $X (N unknown)`, token unknown counts, case-study line | PARTIAL | `unknown` columns and counts shown. The `≥` floor and the case-study line cannot be observed with all-unknown mocks; `ledger.ts` in `test:all` is their proof |
| 8 | Ingest: synthetic transcript → `work` mission, deduplicated turns, child attempts, cost unknown, no transcript text stored | PASS | 1 of 3 sessions ingested (1 foreign, 1 unresolvable, by design); sentinel text 0 hits in `<out>` and the DB |
| 9 | Export → import replays byte-equal; v1 export and v1 db refused in one line | PASS | `mission replay --format json` byte-equal (48,736 B) across dirs and runs |

Repository-wide checks, all PASS:

- typecheck clean;
- `test:all` green, 2,898 at 594f163, at or above the WS-R baseline of 1,407;
- R1 preserved guarantees (P0 checklist 12/12);
- the R7 invariant: 4 write attempts, each with an authorize decision, 0 exec;
- the WS-R identifier invariant and the MCP-names consistency test.

The remaining rows are hard constraints and testable rulings, all PASS except R15.3, which passed
by inspection: `detectSandbox` does not consult PATH, so bwrap could not be hidden.

Security spot checks (acceptance §4):

- 0 stub spawns across every Forge path, apart from one deliberate `--unsandboxed-review` spawn.
- The planted key had 0 raw hits in `<out>`, the DB, events, inspect, candidate, report, replay
  and exports.
- The holdout body appears only in the artifact store and in export files, which a byte-equal
  replay needs.

Findings from acceptance F1–F3 are in §9. The doc deviations are in §5.

---

## 5. Demo launch instructions

**Acceptance found six deviations between DEMO.md and the code** (ACCEPTANCE-P1 §2). All six are
**fixed in 28b6835** (8d24fb5, 08d29fa), where DEMO.md was rewritten to run as written and its
replay claim corrected. They are recorded here as found:

- **D1.** `daylight` is not on PATH: `bin` is declared but not linked. Use `pnpm daylight` or
  `node engine/cli.ts`.
- **D2.** `--out /tmp/forge-out` is refused when `<out>` lies inside the temp dir and
  `XDG_RUNTIME_DIR` is unset or not private (ssh, CI, `env -i`). The message gives no remedy, and
  `spec decompose` exits 0 with the mission `blocked`.
- **D3.** "Run once without `--confirm`" previews for authorize, gate lock and the forge decisions,
  but `work-item approve` and `reject` refuse instead. Use `daylight confirm` there.
- **D5.** A vacuous gate needs `--only <ids>` or `--accept-vacuous <id>` at lock. DEMO.md names
  neither.
- **D6.** The Forge section has no export, import or replay commands, and P0's `demo replay
  --recording` refuses a Forge recording. The working path is `mission export`, then `map` the
  same repo into the fresh dir, then `mission import`, then `mission replay`.
- **D8.** "~1,440 assertions" is stale: 2,898 were measured at 594f163.

The operator guide is `docs/daylight/DEMO.md`. Its Forge section is the P1 mock walkthrough, and
WS8's reviewer exercised it command by command (ws8-review §8).

**The live run is not authorised.** Real providers are `unavailable` for implement until the owner
authorises one live run with a dedicated, spend-capped credential (R4 Q4/Q5, R9.4). Nothing below
spends money.

Prerequisites: Node 24+, pnpm, git, `bwrap` and `prlimit`. The author, decomposer and gate
sandboxes are not optional: `forge run`, `spec decompose` and the e2e fail without bwrap (R15.3,
fail closed).

```bash
pnpm install && pnpm ui:build
pnpm typecheck && pnpm test:all        # use a short TMPDIR: the MCP socket path must fit 108 bytes

O='--out /tmp/forge-out'
daylight map <repo> $O
daylight spec register <repo> --file docs/spec.md $O
DAYLIGHT_MOCK_ADAPTER=<decomposer.cjs> daylight spec decompose m_S <repo> --tools mock $O
daylight work-item list $O
daylight work-item approve w_… --rationale '…' --confirm <c> $O
daylight mission create <repo> --kind implement --work-item w_… $O
daylight mission authorize m_I --write --rationale '…' --confirm <c> $O
daylight gate add m_I --role gate    --test add.test.js  --expect-exit 0 --expect-stdout '# fail 0' $O
daylight gate add m_I --role holdout --test hold.test.js --expect-exit 0 --expect-stdout '# fail 0' $O
daylight gate baseline m_I <repo> $O
daylight gate lock m_I --rationale '…' --confirm <c> $O
DAYLIGHT_MOCK_ADAPTER=<author.cjs> daylight forge run m_I <repo> --tools mock $O
daylight forge candidate c_… $O
daylight forge approve c_… --rationale '…' --confirm <c> $O
daylight forge apply c_… <repo> --confirm <c> $O
daylight mission close m_I --outcome succeeded --reason '…' $O
daylight report --project --group model $O
```

Every decision needs `--confirm <digest8>`. Run the command once without it (or `daylight confirm
<operation> <subject>`) to see what is being confirmed. Decisions are refused under `CLAUDECODE`
or `DAYLIGHT_SESSION` and recorded as `human:<OS user>`; naming another actor is refused.

To view it, run `DAYLIGHT_DIR=/tmp/forge-out pnpm view`. `DAYLIGHT_MISSION_SAMPLE=1` shows the
synthetic sample screens, which are labelled SAMPLE DATA. Refusals worth showing are listed in
DEMO.md:

- an author that edits `package.json`;
- a low-tier possible secret, which needs `--acknowledge-possible-secret`;
- `--unsandboxed-review` and `--no-review-sandbox`.

---

## 6. Fixture provenance

**No recording of a real reviewer or a real author exists in P1.** No provider binary was run as
an agent at any point in the build. Every agent output in tests, probes, the e2e and the UI sample
comes from a mock, a stub or a hand-written fixture. `fixtures/daylight-demo/recordings/` does not
exist. The P0 statement in DEMO.md ("There is no recorded two-reviewer run yet") still holds.

- **Planted-defect fixture, re-pinned by WS-R.** `fixtures/daylight-demo` is a planted
  repository: `DEFECT.md` names the defect, and the "PLANTED — this defect was placed
  deliberately…" sentence travels into missions and reports. WS-R renamed the MCP server key in
  the fixture's reviewer prompt, which changed the materialised commit. It was re-recorded from
  `materialiseFixture`'s output, not hand-computed: `EXPECTED_FIXTURE_COMMIT` changed from
  `38fa20074d8003c2860e3e0f605dd562d827eb5e` to `b57b1c8c436af52c5bdae26744dbcc4e5ddc6913`, and
  the project id is now `git:b57b1c8c436a` (ws-r-report "Re-recorded fixtures"). The reviewer
  confirmed it: fixed author and date, `node --test` shows `pass 4, fail 1` (the planted red test
  is still red), and `engine/test/fixture.ts` passes. Old local recordings no longer import (R2).
- **Synthetic transcript fixtures (WS6).** There are nine files under
  `fixtures/claude-code-transcripts/`, with placeholder session ids (`11111111-…`, `22222222-…`,
  `33333333-…`) and two subagent files with `meta.json`. They were written by hand to the Claude
  Code JSONL shape. WS6's reviewer states that all transcript content it used was synthetic and
  that no real transcript was opened. Its hostile probe was also synthetic, with planted
  `sk-ant`, `AKIA`, PEM, JWT and 17 MB lines. The parser has not been run against a real
  transcript.
- **Renderer sample fixtures (WS9).** `app/renderer/lib/fixtures/forge-{implement,ledger,work-items}.sample.ts`
  are each headed "SAMPLE DATA … SYNTHETIC" and export `_sample: 'SYNTHETIC'`, which a test
  checks. Credentials appear as `{present, envName, label}` only.
- **Mock adapters.** The author, reviewer and decomposer are scripts named by
  `DAYLIGHT_MOCK_ADAPTER`. Each is labelled `mock` in its artifacts, and an applied commit
  credits `Daylight mock adapter (test double) <mock@daylight.invalid>`. A mock's $0.05 cost
  is a test constant, not a price (R10.3).
- **Stub provider binaries.** The stand-in `claude`, `codex`, `grok` and `opencode` used by the
  e2e, probes and acceptance write a marker and exit 99. They prove that the real binaries are
  refused.

---

## 7. Limitations

- **Every result is from mocks.** Nothing shows that real `claude` or `codex` work under the
  `review` or `author` profile, over the per-attempt MCP socket, or with the stream parser. WS5 F5
  (one usage row per turn when a provider line has no `message.id`) can only be resolved with a
  live fixture.
- **The GUI's real-provider review is P0's unsandboxed path behind a flag.** With bwrap present, a
  real-provider review is refused unless `--unsandboxed-review` is passed (§9, H5).
- **The shipped code diverges from Decided ADRs in three places, all reviewer-flagged:**
  - The ADR-29 trailer set is reduced to ids (§4).
  - The ADR-17 ref shape (WS4 L-6) and the `forge.apply.failed` event name (WS4 L-7) await a
    director ruling.
  - ADR-20's guard list was widened by R14 D-9 to every `DecisionOperation` and, after WS8 M1, to
    P0 `mission decide`.
- **Invariant queries that nothing calls.** `applicationRefusals()` (WS4) and
  `unauthorizedWriteAttempts()` (WS1) are each called only from tests at HEAD (checked with grep).
  `closeMission(succeeded)` trusts any `applications` row (WS4 L-4).
- **Schema compatibility uses a recorded label.** WS7 added a `SCHEMA_DIGEST` to `daylight_meta`
  instead of bumping `DAYLIGHT_DB_VERSION`. It is a label of the DDL that created the file, not a
  hash of `sqlite_master`, so a same-uid edit to the file still opens. The shell's mirror
  (`app/main/daylight-db.cjs`) checks the version only, not the digest (ws7-review notes).
- **The verdict is not bound into the confirm code.** A code shown while a candidate was
  `rejected-by-gates` still approves once re-evaluation makes it accepted. The approve recomputes
  the verdict, but the preview the human read is stale (WS4 L-2, director question).
- **Holdout ids in early events.** Holdout ids, though not content, remain in registration,
  baseline and lock events inside `<out>`. `<out>` is never mounted for an author (ws3-review
  L-2 residual).
- **Pixels.** WS9's delta pass verified the DOM only, because the desktop session was locked.
  Layout and colour of the post-WS8 screens have not been viewed (ws9-review "Still needs a visual
  check").
- **Environment workarounds during the build:**
  - Offline `pnpm install` leaves `node_modules/electron/dist` absent, which several writers
    copied from the main checkout.
  - The lows-sweep writer's first `pnpm exec electron` in a fresh clone ran Electron's lazy
    installer. That downloaded the pinned v43.4.0 binary and checked it against the package's
    checksums. The download was not intended, and the writer flagged it (lows-report §3).
- **Process slip.** The WS-R writer ran `adapters --help`, which then ignored `--help` and probed
  the real `claude`, `grok` and `opencode` binaries with list and help calls, against the rules.
  The lows sweep fixed `adapters` (411f44a). Acceptance F1 shows the same bug in other P0
  subcommands (§9).

---

## 8. Baseline vs measured timings

Source: `ACCEPTANCE-P1.md` §5 (`acc/step5.out`), run on 15efdfc. It ran the same operations as
`engine/bench/daylight.ts` but not the bench itself, which writes `docs/`. Machine: Ryzen 9
7845HX, Node 24.18.0, kernel 7.2.9, bubblewrap 0.13.0. P0 figures are from MEASURED.md
(2026-10-12). The figures below are as the acceptance file states them.

| Operation | P0 (MEASURED.md) | P1 (acceptance) |
|---|---|---|
| this repo, cold `map` | 0.75 s / 267 MB (152 files) | 1.26 s / 387 MB (207 files) |
| this repo, warm `map` | 0.39 s | 0.69 s / 304 MB |
| this repo, `derive` | 0.29 s | 0.47 s / 222 MB |
| fixture (6 files), cold / warm `map`, `derive` | 0.26 / 0.25 / 0.24 s, 155 MB | 0.37 / 0.37 / 0.37 s, 176–181 MB |
| `demo prepare` | 0.53 s / 160 MB | 0.74 s / 179 MB |
| `mission run`, two mock reviewers + compare, `--no-review-sandbox` (P0 method) | 0.35 s / 159 MB | 0.48 s / 179 MB |
| `mission run`, two MCP mock reviewers under the `review` profile (P1 default) | — | 0.53 s / 186 MB |
| `experiment run` (bwrap, 2 runs) | 0.44 s / 160 MB | 0.58 s / 178 MB |
| `forge run` (mock author, author profile, gate + holdout) | — | 0.88 s |
| `engine/test/forge-e2e.ts` alone | — | 38.1 s / 128 MB, 95 passed |
| `pnpm test:all` | 1,197 assertions | 2,898 assertions; 138.0 / 138.3 / 139.0 s over three runs, 0 flakes |
| `pnpm typecheck` | — | 3.8 s |

The acceptance file does not explain the slower `map`. The repo grew from 152 to 207 files, and
this is a single sample, so the regression stays unexplained until re-measured. Renderer frame rows were not measured, since that is the UI phase. The P0 renderer
figures (MEASURED.md) remain the latest.

Nobody in the build read the private 10k map directory (R8.4).

---

## 9. Unresolved risks

- **Found by acceptance, High (F1): P0 subcommands ignored `--help`. Fixed in 28b6835**
  (13cb4a0, verified: 120 help forms, 0 spawns). Before the fix:
  - `agent --help` and `run --help` ran the real command and spawned the `claude` stub 3 times;
    real binaries would have spent money.
  - `export --help` overwrote the tracked `.codemap/knowledge.json` and `ARCHITECTURE.md`.
  - Eleven more subcommands did their real work on `--help`.
- **Found by acceptance, Medium (F2): DEMO.md's out path failed on non-desktop sessions. Fixed in
  28b6835**, with the doc rewrite (§5, D2).
- **Found by acceptance, Low (F3): holdout test path in `mission replay` and `gate list`. Fixed in
  28b6835** (f35c7b0). Export files still carry holdout bodies by design, for byte-equal replay,
  so a recording discloses its holdouts.
- **Found by acceptance, Low (F4, F5).**
  - F4: `work-item approve` and `reject` now preview without `--confirm`. Fixed in 28b6835
    (08d29fa).
  - F5: each `test:all` leaves about 10 non-empty temp dirs (about 20 MB). Still open.
- **Found by acceptance, Info (F9).** The WS2 (65a472e) and WS5 (f7ed74d) merges each carry one
  commit their reviewer did not verify; the merges themselves are clean.

- **Sec H5, reviewer reach. Open.** The P0 path runs reviewers unsandboxed with `cwd` at the
  repository root, where they can read `<out>` (the ledger and claims db). P1's state:
  - Reviews run under the bwrap `review` profile by default when bwrap is present: repo
    read-only, no `<out>`, one MCP socket.
  - When the profile cannot be built, the review is refused rather than run open (WS8 H2 fix).
  - Real providers are refused under the profile until the live spike.
  - **The only way to run a real reviewer today is `--unsandboxed-review`, which is explicitly
    unsandboxed.** It runs exactly as P0 did, prints a stderr warning naming Sec H5 and `<out>`,
    and stamps each attempt profile `none`, reason `unsandboxed-review`. The GUI offers it as a
    toggle that is off by default and never persisted (ws9-review D7).
  - Moving `<out>` outside the repository does not close H5 (R3 correction, ADR-27). H5 closes
    only after an authorised spike shows real providers work under the `review` profile.
- **Author credential exposure.** Under ADR-30 the sandbox cannot hide its own credential from the
  model, so the spend cap on a dedicated credential is the control. No such credential exists yet.
  A real author also needs network `shared` (ADR-10). Bubblewrap cannot filter egress; the
  egress proxy is deferred.
- **Redaction misses, by design.** At 59d74f6, 367 of the reviewer's 395-case corpus are hit and
  27 missed; one more is caught at the wrong tier (redact-review "Corpus").
  - 6 misses are adversarial obfuscation: a zero-width space inside `PRIVATE`, a lowercase PEM
    header, a headerless PEM body. The accepted threat model is that an agent intent on
    exfiltration can base64 a secret anyway.
  - 13 are out of scope and documented in the `redact.ts` header: `user:pass@` without a
    `://`, `--password value`, Go `:=` and others.
  - 8 are open Lows: 5 glue residues (L2), 2 `bearer` case misses (L3), 1 `_authtoken` (L5).
  - The low tier (generic `password:`, `*KEY*=`) masks logs but stores a diff as written. It is
    then a curable `possible-secret` warning that a human must acknowledge (R16). On the 78-case
    benign corpus it raises 12 low-tier false positives and 0 high-tier ones.
- **Open TRACKED.md residuals** (as far as this writer could check against the reviews):
  - ws0 R1 legacy event-id dedupe (accepted under R2);
  - the no-`work` scratch-dir row conclusion (owner's call, lows-report §5);
  - Sec L2 and Ledger L6 (no review closes them);
  - lows L1 (signal-killed tests leak a dir) and L2 (sign-in hint);
  - ws1 L10 (revoked-write export refused);
  - WS2's array-literal `--bind` gap;
  - WS8 L5 (`/work/.git` writes unflagged);
  - WS5 F4 and F5;
  - redaction L2–L5, L7 and L8;
  - WS9 L2 (literal `$0.00 today`);
  - no GUI `--raise-budget`;
  - `commitExists` not moved into `project.ts`.
- **Same-uid races accepted:**
  - path-based `lstat`/`unlink` in the capture spill sweep (lows-review F5);
  - the check-then-open window on parent components without `openat2(RESOLVE_BENEATH)` (ws0-review
    H1 residual);
  - the confirm-then-lock window, now refused at the store (WS8 93337e6).
- **Self-approval guard is a heuristic.** The guard refuses under `CLAUDECODE` and
  `DAYLIGHT_SESSION` and requires a confirm code. An agent that can compute the digest can
  compute the code. ADR-20 says this is a heuristic, not authentication, and signing is deferred.
- **Author exec is new.** R17.1's `run` tool is in effect from 28b6835 and was reviewed by a
  Fable exec-flip reviewer (§11). It has not been through an acceptance run of its own, and
  nothing real has executed under it: every author is still a mock.

---

## 10. P2 deferrals and open owner decisions

### Decided by the owner on 2026-10-16 (R17, verbatim "a, keep")

- **R9.2 → (a), ADR-35.** Author exec is allowed as the nested, no-network MCP `run` tool
  (R11.1). It is permitted only when the mission's `authorize` decision grants it, and it is
  stamped on the attempt. The nested sandbox is always `--unshare-net`, and gate tests are never
  mounted. R15.5's refuse-until-decided is lifted. **In effect since 28b6835**, where every
  `run` call is recorded as `attempt.exec` events plus artifacts.
- **R9.3 → keep.** Opus-written commits keep their `Claude Opus 5.5` trailer, and merges carry
  Fable 5.1. No history is rewritten.
- **R17.3.** The owner asked to spin down in-flight development, get current work pushed and
  rename the repository. No new workstreams start after the exec flip. The GitHub repository is
  being renamed from its pre-rename name to `mackerson/daylight-forge`; the local
  directory name is unchanged. This report was written and committed locally. It was not pushed
  by its writer.

### Still open

| Item | Question | Current behaviour |
|---|---|---|
| R9.4 / Q5, ADR-31 | One authorised live author run: target repository and cap to be chosen | not authorised; real providers `unavailable` for implement. Closing Sec H5 depends on this spike (§9) |
| R9.4 / Q4a, ADR-30 | Its dedicated, spend-capped credential: provisioning, label and cap | not provisioned |

### Deferred to P2 or later (FORGE_PLAN §1)

- egress proxy
- Docker/VM profile
- repair loops
- rebase onto a moved HEAD
- `--onto-current` and merge automation
- CI/PR gates
- model routing
- codex/grok/opencode authors
- signed decisions
- seeded-mutation gate scoring
- a `requirements` table
- live console streaming
- ledger M7
- gate dependency install snapshots (Q1 was ruled (a) for P1, zero-dep or vendored gates; ADR-28)

Smaller points the reviews raised for a director ruling are recorded in §7 and §3.2, not as owner
decisions:

- WS4 L-2: bind the verdict into the confirm digest.
- WS4 L-6: the ref shape.
- WS4 L-7: the `forge.apply.failed` event name.
- WS-R's naming-invariant fork.
- WS9 L4: the two "need you" counts.

---

## 11. Build ledger: who built what

**Method.** Token figures are the per-agent totals that the Claude Code harness reports in task
notifications. They are cumulative per agent and include resumed runs. **No price is applied
anywhere and no dollar figure is given**, by ruling (R4 Q3a) and by the WS5 invariant
`money-code-has-no-price-table`. The director (Fable 5.1, the coordinating session) wrote no code
and made the rulings. Its own tokens are not in the table. This report's writer could not see
its own harness total, so that row reads "not recorded" and is left out of the sums.

| Role | Model | Agent | Tokens | Outcome |
|---|---|---|---|---|
| writer | Opus 5.5 | WS0 P0 hardening (30 findings + 3 re-review fixes) | 529,825 | merged 0334326 |
| reviewer | Fable 5.1 | WS0 review + fix verification | 275,337 | 26 closed/3 partial/1 regression → all fixed |
| scout | Opus 5.5 | rename inventory (read-only) | 137,181 | ws-r-inventory.md |
| writer | Opus 5.5 | WS-R rename | 265,926 | merged 26a0f05 |
| reviewer | Fable 5.1 | WS-R review | 182,230 | 0H/0M/4L |
| writer | Opus 5.5 | FORGE_PLAN.md (ADR-8..35) | 206,496 | merged 4bfdbe5 |
| reviewer | Fable 5.1 | FORGE_PLAN review | 159,514 | 2H/4M/4L → fixed |
| writer | Opus 5.5 | WS1 contracts + schema v2 (+16 review fixes) | 507,850 | merged 9caf046 |
| reviewer | Fable 5.1 | WS1 review + verification | 349,867 | 1H/4M/9L → fixed |
| writer | Opus 5.5 | lows sweep (8 fixes) | 210,293 | merged 44471bf |
| reviewer | Fable 5.1 | lows review | 160,796 | 0H/0M/3L |
| planner | Opus 5.5 | WS2+WS3 interface proposals | 224,658 | design docs |
| planner | Opus 5.5 | WS5+WS7 interface proposals | 165,958 | design docs |
| planner | Opus 5.5 | WS6+WS9 interface proposals | 163,890 | design docs |
| reconciler | Fable 5.1 | six-proposal reconciliation | 267,044 | 32 mismatches, 8 holes resolved pre-code |
| writer | Opus 5.5 | WS2 workspace + sandbox + MCP socket | 363,234 | merged ec7821a |
| reviewer | Fable 5.1 | WS2 adversarial review | 294,759 | 0H/2M/2L → fixed |
| writer | Opus 5.5 | WS3 gates + verdict | 367,167 | merged 8d28636 |
| reviewer | Fable 5.1 | WS3 review | 253,382 | 0H/0M/5L → fixed |
| writer | Opus 5.5 | WS5 ledger + usage | 429,282 | merged 4c454fe |
| reviewer | Fable 5.1 | WS5 review | 222,403 | 0H/3M/5L → fixed |
| writer | Opus 5.5 | WS6 transcript ingester | 282,737 | merged 4cbd1ab |
| reviewer | Fable 5.1 | WS6 review | 212,301 | 0H/1M/8L → fixed |
| writer | Opus 5.5 | WS7 spec intake + work items | 338,496 | merged 0e91a5e |
| reviewer | Fable 5.1 | WS7 review | 239,724 | 0H/2M/6L → fixed |
| writer | Opus 5.5 | WS9 UI (two passes) | 513,733 | merged 15efdfc |
| reviewer | Fable 5.1 | WS9 review + delta verification | 382,563 | 0H/2M/6L → fixed |
| writer | Opus 5.5 | WS4 approve + apply + trailers | 365,523 | merged f51e08e |
| reviewer | Fable 5.1 | WS4 adversarial review | 247,534 | 0H/1M/7L → fixed |
| writer | Opus 5.5 | redaction shapes, two tiers | 269,947 | merged 8b625a1 |
| reviewer | Fable 5.1 | redaction review (395-string corpus) | 205,953 | 1H/2M/8L → fixed |
| planner | Opus 5.5 | WS8 interface proposal | 182,114 | design doc |
| writer | Opus 5.5 | WS8 orchestration + CLI + e2e | 582,949 | merged 594f163 |
| reviewer | Fable 5.1 | WS8 review + verification | 334,368 | 2H/2M/6L → fixed |
| reviewer | Fable 5.1 | P1 acceptance, engine and CLI phase | 302,583 | ACCEPTANCE-P1.md: 29 PASS, 2 PARTIAL, 0 FAIL; F1 High |
| writer | Opus 5.5 | exec flip (R17) + acceptance fixes | 297,617 | merged 28b6835 |
| reviewer | Fable 5.1 | exec flip review | 296,784 | merged 28b6835 |
| writer | Opus 5.5 | this completion report | not recorded | docs/daylight/FORGE_REPORT.md |

Subtotals through 28b6835, re-summed from the table by this writer, excluding the unrecorded
report row:

- Opus 5.5 writers, planners and scout: **20 agents, 6,404,876 tokens**
- Fable 5.1 reviewers, reconciler and acceptance: **17 agents, 4,387,142 tokens**
- **Total: 10,792,018 tokens**

The table's Outcome column is the ledger's own shorthand. The ledger's corrected statement, quoted
exactly:

> Every merged branch was written by an Opus agent and independently reviewed by a Fable agent.
> Every High finding was fixed and re-verified before its branch merged. Mediums were fixed before
> merge OR explicitly tracked and closed by a later workstream (four cases: e.g. ws9-review M1 closed
> by WS8, ws2-review F2 closed by the redaction workstream), with one exception never fixed: ws0-review
> R1 (legacy nested-payload event ids double-ingest once), accepted under RULINGS R2 because v1 data
> is disposable.

§3.2 gives the itemised record. Acceptance also found that the WS2 and WS5 merges each carry one
commit after the head their reviewer verified (§9, F9).

**Writer and reviewer separation.** Every merged branch was written by an Opus agent in its own
worktree. A different agent, on Fable, reviewed it with the code, PLAN and RULINGS, and treated
the writer's report as hypotheses (R6). Reviewers worked read-only and mutated only scratch copies. The roles split by model: 20 Opus agents (plus this report) produced code, plans
and inventories, and 17 Fable agents reviewed, reconciled and ran acceptance. R6 provides a third Fable as tie-breaker for
writer/reviewer disagreements. No tie-break agent appears in the ledger.

**Interfaces before code.** Before wave 1, three Opus planners wrote six interface proposals, and
one Fable reconciler compared them with WS1's contract and code. It found 32 mismatches and 8
holes, which were resolved before any wave-1 code (`interfaces-reconciled.md`; R14 rules on the
director items D-1 to D-9).

**Rate-limit interruption.** On 2026-10-16 a rate limit interrupted six reviews. They were resumed
from their transcripts and the ledger records no work lost. The ledger does not say which six
reviews were interrupted, and this report does not guess.

**The director's role.** The director wrote no code. It issued R1–R16 (R13 deliberately skipped) and recorded the owner's R17,
set the integration order, wrote briefs, merged in order, and kept TRACKED.md. Every merge commit
carries its Fable 5.1 trailer. Owner questions it could not rule on were recorded as open (R9),
not answered, until the owner decided two of them (R17).

---

## 12. Rulings index

R1–R9 predate FORGE_PLAN.md and map onto its ADRs. R10–R17 came after the plan document merged
(4bfdbe5), so they have no ADR of their own. For those, the ADR column names the decision each one
refines.

| Ruling | One line | ADR |
|---|---|---|
| R1 | Breaking changes allowed; graph, detectors, provenance, invariants, read-only review and the sandbox boundary preserved | ADR-24 |
| R2 | No v1 compatibility: no migration, v1 db or export refused in one line; old dirs abandoned, not deleted | ADR-25, ADR-12, ADR-22 |
| R3 | Rename to Daylight Software Forge in a serial WS-R; default `<out>` outside the repo; H5 not closed by the move | ADR-26, ADR-27 |
| R4 | Q1 zero-dep gates (snapshots P2); Q2 `<out>` outside the repo; Q3 ledger only, id-only trailers; Q4 dedicated capped credential; Q5 hold | ADR-28, ADR-27, ADR-29, ADR-30, ADR-31 |
| R5 | WS0 deviations stand until their v2 columns land; node bound at its own path | ADR-32 |
| R6 | Integration order WS0 → WS-R → WS1 → fan-out → WS4 → WS8 → WS9 → acceptance → one live run; Opus writes, Fable reviews | ADR-33 |
| R7 | Write is a first-class, explicit, recorded mode; invariant is "no write without an authorize decision" | ADR-34 |
| R8 | WS-R details: out-dir key, `git-<hex>` dir names, frozen P0 records with banners, 10k bench via env, MCP key rename + consistency test | ADR-26, ADR-27 |
| R9 | Open items: H5 reviewer reach, author exec, trailer attribution, live run + credential | ADR-27 (H5), ADR-35, §10 of FORGE_PLAN, ADR-30/31 |
| R10 | Work item or recorded ad hoc decision; three-valued `cost_source`; mock stream shape; one decision guard in WS1 | refines ADR-14, ADR-11, ADR-32, ADR-20 |
| R11 | Exec only as a nested no-network `run` tool; one per-attempt MCP socket; WS2 owns the adapter hook and sandbox modules | refines ADR-35, ADR-10, ADR-8 |
| R12 | Attempt `origin`; ingested = outside Daylight's controls; `ingest_sources` keyed on session + agent; ingest CLI; `guardCheck` | refines ADR-15, ADR-34 |
| R13 | Not issued: skipped so it is not confused with PLAN resolution 13, the decision guard | (ADR-20 is resolution 13) |
| R14 | Rulings on the reconciliation: socket listener in WS2, orchestrate edits deferred to WS8, D-7 git hardening in WS1, guard on every DecisionOperation, actor from main | refines ADR-20, ADR-8, ADR-33 |
| R15 | WS8: mocks only; two new need kinds; e2e fails without bwrap; every policy violation uncurable; `exec:true` refused | refines ADR-31, ADR-13, ADR-21, ADR-35 |
| R16 | Secret shapes in two tiers: high = masked and uncurable `secret-in-diff`; low = masked in logs, curable acknowledged `possible-secret` in diffs | refines ADR-10, ADR-21 |
| R17 | Owner decisions: R9.2 → (a), exec only as the nested no-network `run` tool when the authorize decision grants it (in effect, 28b6835); R9.3 → keep Opus trailers on Opus commits, Fable on merges; spin down, push, rename the repo | settles ADR-35; R9.3 (FORGE_PLAN §10.3) |
