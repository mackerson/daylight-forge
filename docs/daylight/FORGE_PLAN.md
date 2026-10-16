# Daylight Software Forge — P1 plan

Status: plan of record for P1, 2026-10-16. This is the durable record for the P1 case study: what
is decided, what is open, and where each decision came from.

Lineage: `docs/DAYLIGHT_SPEC_v0.1.md` (product spec) and `docs/daylight/PLAN.md` (the P0
coordination plan, ADR-1 to ADR-7, now a frozen P0 record). ADR numbering continues at ADR-8.
This is a new document, not an edit of the P0 plan (R8.3).

Precedence: the director rulings of 2026-10-16 (R1–R8) override the reconciled plan. Where they
conflict, this document says "RULINGS wins" in one line.

## 1. Purpose and scope

P1 Forge turns Daylight from a system that reviews code into one that writes code under evidence:
"protected specification → scoped author workspace → independent test → approved merge" (spec §2,
§7). It delivers four things:

1. **Implement-mission runner.** A human authorises write for one mission and locks acceptance
   gates. An author agent edits a detached workspace inside a bubblewrap profile. Daylight captures
   the diff as a content-addressed candidate and evaluates it against the locked gates in the gate
   sandbox. A human approves, and Daylight applies it as a new git ref with Daylight trailers.
2. **Ledger.** Per-turn tokens and per-attempt cost by actor, model, mission and work item.
   Unknown is never summed as zero or estimated. Every application gets a case-study line.
3. **Transcript ingester.** Imports Claude Code sessions as `work` missions, storing digests and
   counts, never text.
4. **UI.** Candidate review, ledger and work-item screens, plus a derived `needs` strip.

Spec intake (spec → proposed work items → human approval) is in scope because it produces the
acceptance criteria that implement missions run against.

Deferred (PLAN §5): egress proxy, Docker/VM profile, repair loops, rebase onto a moved HEAD,
`--onto-current` and merge automation, CI/PR gates, model routing, codex/grok/opencode authors,
signed decisions, seeded-mutation gate scoring, a `requirements` table, live console streaming,
ledger M7. Gate dependency snapshots are P2 (ADR-28). Author exec is open, not deferred (ADR-35).

## 2. How we got here

The sources are working papers outside the repository. They are cited here, not reproduced.

- **Proposals A and B**: two independent planners worked against `daylight` @ 13a5775, from the
  code. They disagreed on the author workspace, network policy, gate visibility, apply mechanics
  and the schema table set.
- **Security review**: 22 findings (5 High, 9 Medium, 8 Low). VERIFIED highs included host writes
  through committed symlinks (H1), a TOCTOU on the registered test (H2) and host git hooks firing
  from `git worktree add` (H3).
- **Ledger review**: 32 findings (6 High, 12 Medium, 14 Low). They included orphaned `running`
  attempts (H1), double `cost.reported` (H5) and disputed missions reading "0 need you" (H6).
- **Reconciled plan**: resolved 16 conflicts. A finding an audit had VERIFIED outranked either
  proposal. The plan defined WS0 (P0 hardening) and WS1–WS9.
- **WS0 report**: 30 of 30 findings fixed. `pnpm test:all` went from 1,197 to 1,332 passing. Five
  deviations from the plan were declared.
- **WS0 review**: 26 CLOSED, 3 PARTIAL (Sec H3, Ledger M4, M9), 1 REGRESSION (Sec M8 sweep). It
  recommends merge after three fixes: the sweep trust boundary, neutralising smudge/process
  filters, and legacy event-id dedupe.
- **Rulings R1–R8**: made with the owner. They withdraw P0 compatibility, rename the product,
  answer owner questions Q1–Q5, make write mode first-class, and insert WS-R before WS1.
- **WS-R inventory**: 604 old-name occurrences in 86 files. It raised five questions; R8 answers
  them.

## 3. Preserved from P0, and deliberately broken

Owner (verbatim): "I'm fine with schema v2, I'm fine with throwing away all prior project analysis
work. Breaking changes are the order of the day - what visual-deslopify was is going to become the
Daylight Software Forge, and it's time to get that right."

**Preserved (R1).** These must still hold at P1 acceptance:

- the deterministic graph;
- the static detectors;
- claim provenance;
- invariants;
- read-only *review* permissions (ADR-34);
- the sandbox boundary: ADR-3 bubblewrap + prlimit, fail closed, and ADR-4 protected acceptance as
  hardened by WS0.

ADR-1, ADR-2, ADR-5, ADR-6 and ADR-7 also stand.

**Broken (R1, R2):**

- Names, paths, schemas and export formats may change. The P0 constraint "preserve … CLI behavior"
  is withdrawn.
- No v1 compatibility: no migration code, no `.v1.bak`, no dual-read of v1 exports. A v1
  `daylight.db` or v1 export is refused with one line saying to delete it and re-map.
- Existing `out/`, map directories and `daylight.db` files are disposable. Nobody deletes the
  owner's map directories; after the config-dir rename they are simply no longer found.

## 4. The rename (R3, R8)

WS-R lands before any other P1 code, so this document uses the new names throughout.

| Thing | New name |
|---|---|
| Product / package | Daylight Software Forge / `daylight-forge` |
| CLI binary | `daylight` (old binary removed, not aliased) |
| Env prefix | `DAYLIGHT_`, no fallback (e.g. `DAYLIGHT_MOCK_ADAPTER`, `DAYLIGHT_SESSION`, `DAYLIGHT_BLIND_PREFIX`) |
| Config dir | `~/.config/daylight` |
| Default `<out>` | `${XDG_DATA_HOME:-~/.local/share}/daylight/<projectId-sanitized>/<checkout-hash8>/`; `--out` stays an explicit override |
| projectId in dir names | `git-<hex>`; rows keep `git:<hex>` |
| 10k bench map | not moved, not read; the bench takes its path from `DAYLIGHT_BENCH_10K` |
| MCP server key | renamed in the same commit as the fixture reviewer prompt and the adapter allowlist; the fixture's pinned commit is re-recorded |

WS-R changes only names and the default out location. The test count stays the same or goes up.
It adds two checks:

- an invariant that no old-name identifiers remain outside CHANGELOG and history docs;
- a static test that every tool named in the fixture reviewer prompt is in the adapter allowlist
  (R8.5).

Frozen P0 records keep the old names verbatim, each with a one-line banner saying the CLI is now
`daylight`: TODO.md, `docs/daylight/{BASELINE,MEASURED,ACCEPTANCE,PLAN}.md`,
`docs/DAYLIGHT_SPEC_v0.1.md` and `.codemap/*`. R8 does not name the new IPC channel prefix,
invariants file name or progress-envelope prefix. WS-R picks them, and this document refers to
them generically.

## 5. Decisions (ADR-8 onward)

ADR-8 to ADR-23 map one to one onto reconciled-plan resolutions 1–16. ADR-24 onward record the
rulings.

### ADR-8 — Detached author workspace, not a git worktree (resolution 1)

- **Context.** Sec H3 VERIFIED that `git worktree add` fires `post-checkout` on the host, and a
  worktree's `.git` links back into the real repository.
- **Decision.** `createWorkspace(repo, commit) → {tree, gitDir, dispose}`:
  - a sibling `git init --bare` with `objects/info/alternates` pointing at the real objects;
  - the tree is materialised with `read-tree` + `checkout-index` into a temp index, not
    `git archive`, because `export-ignore` would make the author and gate trees differ;
  - the `ls-tree -r` count must equal the files on disk;
  - every git call uses the hardened environment (`GIT_CONFIG_GLOBAL=/dev/null`,
    `GIT_CONFIG_NOSYSTEM=1`, `core.hooksPath=/dev/null`, `core.fsmonitor=false`).
- **Consequences.** The author sees no git metadata and never writes to the real `.git`. Code
  never runs in the workspace.
- **Status.** Decided.

### ADR-9 — Authorize and gate lock are separate human acts (resolution 2)

- **Decision.**
  - `mission authorize` (scope `{permissions, maxUsd}`) is the only thing that turns `write` on.
  - `gate lock` (scope `{gateSetDigest, experimentIds, harnessDigests, vacuousOverrides}`) is
    required before `forge run`. Its digest is stamped on the attempt and the candidate.
  - Work-item approval gates mission creation, not permissions.
- **Consequences.** Implement missions start `draft`, `write:false`. "May it write" and "what
  counts as done" are distinct, named acts in the ledger.
- **Status.** Decided.

### ADR-10 — Author network is a profile parameter (resolution 3)

- **Context.** Bubblewrap cannot filter egress.
- **Decision.** `network: 'none' | 'shared'`. Mock defaults to `none`. One test runs mock `shared`
  to show the filesystem boundary is independent of the network namespace. Real providers need
  `shared`. `redact` scans every diff, and any hit is an uncurable `secret-in-diff` violation.
- **Consequences.** A real author can reach the network and can read its own credential (ADR-30).
- **Status.** Decided. The resolution's "no exec tool either way" is reopened by R7 (ADR-35).

### ADR-11 — Schema v2 table set (resolution 4)

- **Decision.**
  - `candidates`, with its own verdict lifecycle (B);
  - per-turn `attempt_usage`, `UNIQUE (attempt_id, request_id)`, for `message.id` dedupe (A);
  - one `work_items` table with B's columns;
  - `experiments.role` and `experiments.locked_by`;
  - `gate_evaluations` with `target` and `diff_digest`;
  - `applications` and `ingest_sources`.

  `requirements` is deferred.
- **Consequences.** Attempts stay P0-shaped and carry the totals. DDL in §6.
- **Status.** Decided.

### ADR-12 — Version constants split; v1 refused (resolution 5, amended by R2)

- **Context.** One constant fed the event stamp, the export header and the DB, and
  `telemetry.ts:141` asserts that events carry `1`.
- **Decision.** Separate DB, event and export versions (§6). The plan's v1 dual-read is dropped:
  a v1 export is refused. RULINGS wins.
- **Consequences.** P0 recordings no longer replay.
- **Status.** Decided.

### ADR-13 — Derived `needs`, no new state (resolution 6)

- **Decision.** `needs[]` is never persisted. Kinds are `blocked`, `dispute`, `spec-ambiguity`,
  `gate-lock`, `gate-vacuous`, `candidate-decision` and `apply`. The strip reads "N running · M
  need you" from it.
- **Consequences.** Fixes ledger H6/L10 without touching `MISSION_TRANSITIONS`.
- **Status.** Decided.

### ADR-14 — Spec intake by MCP proposal and human approval (resolution 7)

- **Decision.** `spec register` and `spec decompose`. Planners call `propose_work_item`.
  Proposals are blind by prefix and treated as data. Different statements for one anchor raise a
  `spec-ambiguity` need.
- **Consequences.** No approval, gate or mission exists without a human command. A's automatic
  `materialise` was rejected because the acceptance criterion must stay human-authored.
- **Status.** Decided.

### ADR-15 — Transcripts: never store text (resolution 8)

- **Decision.**
  - Ids are `ev_cc_<sha256(sessionId, message.id|line hash)>`.
  - Ingest is incremental by line count; a rewritten file re-ingests as a no-op.
  - Other-project sessions are skipped and counted when scanning, and refused with `--session`.
  - Subagents become child attempts.
  - `costUsd null`, `costSource 'none'`, never estimated.
- **Consequences.** No transcript, `tool_result` or thinking text reaches an artifact. The F-10
  limits go to WS6.
- **Status.** Decided.

### ADR-16 — Disputes do not change mission state (resolution 9)

- **Decision.** No state-machine change. `orchestrate.ts:131,226` keep asserting `running`.
- **Consequences.** H6 is a projection bug, fixed by ADR-13.
- **Status.** Decided.

### ADR-17 — Apply by plumbing, then verify (resolution 10)

- **Decision.**
  1. Write the commit with `read-tree`, `apply --cached`, `write-tree`, `commit-tree`, `update-ref`
     to `refs/heads/daylight/<m8>/<c8>`.
  2. Recompute the base→commit diff.
  3. On a digest mismatch, `update-ref -d` and emit `forge.apply.refused`.

  There is no `--onto-current`; a human merges.
- **Consequences.** No hooks run. HEAD, the index and the working tree are never touched.
- **Status.** Decided.

### ADR-18 — Gate role required (resolution 11)

- **Decision.** `--role gate|holdout`, with no default. Both roles must be `falsified` at base and
  `supported` for a verdict. The author prompt carries gate text only.
- **Consequences.** The author sees the public criterion. Holdouts stay hidden.
- **Status.** Decided.

### ADR-19 — Attempt outcome is not a verdict input (resolution 12)

- **Decision.** Attempt state is recorded on the candidate and shown at approve time. It never
  changes the verdict.
- **Consequences.** A killed author's diff that passes everything is still evidence. The human
  decides.
- **Status.** Decided.

### ADR-20 — Self-approval guard (resolution 13)

- **Decision.**
  - `authorize`, `gate lock`, `forge approve/override/apply` and `work-item approve` are refused
    when `DAYLIGHT_SESSION` or `CLAUDECODE` is set.
  - They require `--confirm <digest8>`, which the GUI supplies after a native dialog.
  - There is no TTY rule, because `main.cjs` shells out without one.
- **Consequences.** This is a heuristic, not authentication. Signing is deferred.
- **Status.** Decided.

### ADR-21 — Protected paths and caps (resolution 14)

- **Decision.** A diff may not touch any of these (the union of A, B and the plan):
  - `package.json`, lockfiles, `node_modules`, `.git*`, `.github/` and the invariants file;
  - `.daylight-gates/**`, the spec path, anything outside scope, `.gitattributes`, `.gitmodules`,
    `scripts` and a modified `.gitignore`.

  Escaping symlinks, exec-mode changes and empty diffs are refused. Caps are 1 MB and 200 files.
  Gate tests default to `.daylight-gates/<x_id>/<basename>`.
- **Consequences.** Each item closes a concrete bypass.
- **Status.** Decided.

### ADR-22 — No migration (resolution 15, replaced by R2)

- **Context.** The plan had auto-migration with a backup. RULINGS wins.
- **Decision.** `DB_VERSION = 2`. A v1 db is refused with the one-line delete-and-re-map message.
- **Consequences.** WS1 drops its "v1 db → v2, backup present" and "v1 export imports" tests and
  adds refusal tests.
- **Status.** Decided.

### ADR-23 — Implement missions succeed only with an application (resolution 16)

- **Decision.** `MissionStore.closeMission(succeeded)` on an implement mission is refused without
  an `applications` row.
- **Consequences.** "Exit 0 is not success" stays literal.
- **Status.** Decided.

### ADR-24 — Breaking changes allowed (R1)

- **Decision.** As in §3.
- **Consequences.** Tests that pin old names, paths or v1 compatibility may change. Tests of the
  preserved guarantees may not.
- **Status.** Decided.

### ADR-25 — No v1 compatibility (R2)

- **Decision.** As in §3, ADR-12 and ADR-22.
- **Consequences.** Old data is abandoned in place, not deleted.
- **Status.** Decided.

### ADR-26 — Rename in a serial workstream (R3, R8.2–R8.5)

- **Decision.** As in §4: one writer, one reviewer, before WS1.
- **Consequences.** Downstream work uses the new names from day one.
- **Status.** Decided.

### ADR-27 — Default `<out>` outside the repository (R3, Q2, R8.1)

- **Context.** Sec H5: `<out>` inside the repo was readable by host-run reviewers.
- **Decision.** The default is the XDG path in §4. Two checkouts of one project never share a
  claims db. `guardOutputDirectory` is unchanged. The reviewer mount is the repo only.
- **Consequences.** R3 says this closes H5 for the default layout. The WS-R inventory disputes it:
  reviewer file tools accept absolute paths, which it marks unverified for Claude Code. R8 does
  not address the dispute.
- **Status.** Decided for the location. Open for whether H5 is closed (§10).

### ADR-28 — Gates are zero-dependency or vendored (Q1)

- **Decision.** Option (a). Install snapshots are P2.
- **Consequences.** A repo whose gates need `node_modules` must vendor them, or it cannot be gated
  in P1.
- **Status.** Decided.

### ADR-29 — No dollars or tokens in git history (Q3)

- **Context.** The plan's trailers included `Daylight-Cost` and `Daylight-Tokens`.
- **Decision.** Option (a): ledger only. Trailers carry mission and attempt ids, never dollars or
  tokens. RULINGS wins. The applied-commit message:

  ```
  <subject: work item title, editable at approve>

  <files/insertions/deletions from CandidateSummary; never the narrative>

  Daylight-Project: git:<root12>
  Daylight-Base: <sha>
  Daylight-Work-Item: w_… | none
  Daylight-Mission: m_…
  Daylight-Attempt: a_… (agent:<tool>:<model asked>; model reported <m>|unknown)
  Daylight-Candidate: c_… sha256:<diffDigest>
  Daylight-Gates: sha256:<gateSetDigest> x_1=supported x_2=supported holdout=1/1 | overridden
  Daylight-Decision: d_… approve-candidate|override-candidate by human:<name>
  Co-Authored-By: <display per tool table> <address per tool table>
  ```

  Author and committer are the approving human's git identity, labelled asserted. The mock author
  is `Daylight mock adapter (test double) <mock@daylight.invalid>`. Trailers are written with
  `git interpret-trailers`, and a test parses them back.
- **Consequences.** Cost is visible only through `daylight report --project`.
- **Status.** Decided.

### ADR-30 — Dedicated spend-capped credential per live author run (Q4)

- **Decision.** Option (a). An author attempt never uses the developer's login.
- **Consequences.** The sandbox cannot hide the credential from the model, so its cap is the
  control.
- **Status.** Decided as policy. Provisioning is open (§10).

### ADR-31 — Real authors unavailable until one authorised run (Q5)

- **Decision.** Hold. `claude` stays `unavailable` for implement until the owner authorises one
  live run, the last step of the integration order.
- **Consequences.** All P1 acceptance is on mocks.
- **Status.** Open, awaiting the owner.

### ADR-32 — WS0 deviations stand until their columns land (R5)

- **Decision.** Three WS0 deviations stay:
  - the claim file `<out>/mission-run.<id>.pid`;
  - the capture-side `cost.reported → provider.cost` rename;
  - the expectation-stored `testPath`.

  WS1 adds the v2 columns regardless (`pid`/`heartbeat_at`, `started_at`, `attempt_usage`). WS5
  and WS8 move logic onto them. No workaround is removed before its replacement is in and tested.
- **Consequences.**
  - Two liveness sources coexist for a while, which the WS0 review warned against.
  - WS1 adds the row-side reaper for pending rows that survive a `/tmp` wipe.
  - WS5's brief must state that `adapters.ts:420` and `capture.ts:173` key on `cost.reported`, so
    all three rename together, with a `runMission` over-budget test.
- **Status.** Decided.

### ADR-33 — Integration order (R6)

- **Decision.** As in §7. This replaces the plan's "WS0 ∥ WS1" with WS0 → WS-R → WS1. RULINGS
  wins.
- **Status.** Decided.

### ADR-34 — Write is a first-class, explicit mode (R7)

- **Context.** Owner (verbatim): "writing software is the goal, read only goes out the window when
  objectives touch that, write modes are explicit".
- **Decision.**
  - Review missions stay read-only. Implement missions write to their detached workspace.
  - Read-only is the default for every attempt, never the product's ceiling.
  - Write comes only from a `mission authorize` decision. It is stamped on the attempt row and in
    the event log, and shown in the UI.
  - No adapter, config default, env var or agent request can enable write implicitly.
- **Consequences.** No "author cannot write" invariants or tests may be added. The invariant to add
  is: no attempt has write without an `authorize` decision referencing its mission.
- **Status.** Decided.

### ADR-35 — Exec inside the author sandbox

- **Context.** The plan and proposal B had authors write text and never execute it, with a
  `forge-author-no-exec` invariant in WS2. R7 puts exec to the owner as a separate question.
- **Decision.** None yet. WS2 builds the sandbox so a profile flag can enable exec without
  restructuring.
- **Consequences.** Whether `forge-author-no-exec` ships depends on the answer.
- **Status.** Open, awaiting the owner (§10).

## 6. Schema v2 and versioning constants

The constants and DDL below are verbatim from the reconciled plan (F-6), with one change required
by R2. The plan's header ("one transaction, additive; `daylight.db.v1.bak` written first") no
longer applies: v1 is refused, and nothing is backed up. The DDL states the v2 delta over the P0
tables, and on a fresh v2 db the `UPDATE … cost_source` line has nothing to backfill.

```ts
export const DAYLIGHT_DB_VERSION = 2; export const EVENT_SCHEMA_VERSION = 1; export const EXPORT_SCHEMA_VERSION = 2;
/** @deprecated */ export const DAYLIGHT_SCHEMA_VERSION = DAYLIGHT_DB_VERSION;   // DaylightEvent.schemaVersion: typeof EVENT_SCHEMA_VERSION
```

A DB or export at version 1 is refused. R2 rules on data, not source aliases, so the plan's
deprecated alias stands unless WS1 removes it.

```sql
ALTER TABLE attempts ADD COLUMN input_tokens INTEGER;  ALTER TABLE attempts ADD COLUMN output_tokens INTEGER;
ALTER TABLE attempts ADD COLUMN cache_read_tokens INTEGER;  ALTER TABLE attempts ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE attempts ADD COLUMN usage_source TEXT NOT NULL DEFAULT 'none';  ALTER TABLE attempts ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'none';
ALTER TABLE attempts ADD COLUMN model TEXT;  ALTER TABLE attempts ADD COLUMN parent_attempt_id TEXT;  ALTER TABLE attempts ADD COLUMN gate_set_digest TEXT;
ALTER TABLE attempts ADD COLUMN pid INTEGER;  ALTER TABLE attempts ADD COLUMN heartbeat_at INTEGER;          -- ledger H1
UPDATE attempts SET cost_source='provider' WHERE cost_usd IS NOT NULL;
ALTER TABLE missions ADD COLUMN work_item_id TEXT;
ALTER TABLE experiments ADD COLUMN role TEXT NOT NULL DEFAULT 'probe';  ALTER TABLE experiments ADD COLUMN locked_by TEXT;
ALTER TABLE experiments ADD COLUMN started_at INTEGER;                                                    -- security M8 reaper
CREATE TABLE attempt_usage (attempt_id TEXT NOT NULL REFERENCES attempts(id), seq INTEGER NOT NULL, request_id TEXT, at INTEGER NOT NULL, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, source TEXT NOT NULL,
  PRIMARY KEY (attempt_id, seq), UNIQUE (attempt_id, request_id));
CREATE TABLE work_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, spec_artifact TEXT NOT NULL, spec_revision TEXT NOT NULL, anchor TEXT NOT NULL,
  title TEXT NOT NULL, statement TEXT NOT NULL, examples TEXT NOT NULL, negative_examples TEXT NOT NULL, status TEXT NOT NULL, proposed_by TEXT NOT NULL,
  decision_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE candidates (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), attempt_id TEXT NOT NULL REFERENCES attempts(id),
  project_id TEXT NOT NULL, base_commit TEXT NOT NULL, diff_artifact TEXT NOT NULL, summary_artifact TEXT NOT NULL, narrative_artifact TEXT,
  files TEXT NOT NULL, policy_violations TEXT NOT NULL, secret_hits INTEGER NOT NULL, gate_set_digest TEXT NOT NULL, profile TEXT NOT NULL,
  attempt_state TEXT NOT NULL, attempt_failure TEXT, verdict TEXT NOT NULL, verdict_reasons TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE gate_evaluations (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, experiment_id TEXT NOT NULL REFERENCES experiments(id), candidate_id TEXT,
  target TEXT NOT NULL, diff_digest TEXT, harness_digest TEXT NOT NULL, executions TEXT NOT NULL, conclusion TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE applications (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES candidates(id), decision_id TEXT NOT NULL REFERENCES decisions(id),
  project_id TEXT NOT NULL, base_commit TEXT NOT NULL, commit_sha TEXT NOT NULL, ref TEXT NOT NULL, applied_by TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE ingest_sources (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path_digest TEXT NOT NULL, bytes_seen INTEGER NOT NULL,
  lines_seen INTEGER NOT NULL, mission_id TEXT NOT NULL, attempt_id TEXT NOT NULL, ingested_at INTEGER NOT NULL);
CREATE INDEX candidates_mission ON candidates(mission_id, created_at);  CREATE INDEX gate_evals_candidate ON gate_evaluations(candidate_id);
CREATE INDEX attempts_mission_state ON attempts(mission_id, state);
```

Type additions (F-6, in summary):

- `MissionKind` adds `'work'`, which run refuses.
- `TaskRole` adds `author`, `gate`, `decompose` and `session`.
- `Attempt` gains `tokens`, `usageSource`, `costSource`, `model`, `parentAttemptId` and
  `gateSetDigest`.
- `ExperimentRole` is `probe | gate | holdout`.
- New types: `WorkItem` (`w_`), `Candidate` (`c_`), `GateEvaluation` (`g_`), `Application`
  (`p_`) and `Need`.
- `CandidateVerdict` is one of `pending`, `accepted-by-gates`, `rejected-by-gates`,
  `gates-inconclusive`, `gates-invalid`, `policy-violation`, `no-diff`, `stale-base`.
- `Decision.scope.operation` names the act: `authorize-mission`, `lock-gates`, approve or reject
  of a work item, and approve, reject or override of a candidate.
- Events stay at `schemaVersion 1` and carry ids and digests, never prose.

**Verdict** (pure over rows). `accepted-by-gates` requires all of the following:

- the policy check is clean;
- the diff is non-empty;
- the base equals the mission base;
- the lock digest is current;
- every locked gate and holdout is `supported` on this `diffDigest` at the locked `harnessDigest`;
- every baseline is `falsified` or overridden.

Any `invalid` gives `gates-invalid`. A timeout or flaky result gives `gates-inconclusive`.
Anything else gives `rejected-by-gates`. A test proves the verdict never reads the exit code,
attempt state, narrative or reviewer claims.

## 7. Workstreams

Roles for every workstream (R6):

| Role | Who | Notes |
|---|---|---|
| Writer | Opus | in its own worktree |
| Reviewer | Fable | given the code, PLAN and RULINGS, not the writer's claims |
| Tie-break | a third Fable | settles writer/reviewer disagreements |
| Integrator | Opus | merges in order and owns the dispatch lines in `mission/commands.ts` |

Each feature workstream adds one test file under `engine/test/` and uses mocks only.

| WS | Name | Owns (summary) | Depends on | Notes |
|---|---|---|---|---|
| WS0 | P0 hardening | runner, sandbox, events, capture/normalize, adapters, store, orchestrate, export, project, MCP server, App.tsx | — | 30/30 reported; review asks for fixes 1–3 before merge |
| WS-R | Rename | identifiers, env, config dir, default `<out>`, banners, MCP key, consistency test | WS0 | serial; names and out location only |
| WS1 | Contracts + schema v2 | `mission/types.ts`, `db.ts`, `store.ts`, `export.ts` (v2 only), `forge/policy.ts` | WS-R | no migration; v1 refused; row-side reaper; `closeMission` rule |
| WS2 | Workspace + author sandbox | `forge/workspace.ts`, `sandbox.ts`, `authors.ts`, `diff.ts` | WS1 | exec behind a profile flag (ADR-35); escape tests; both network modes |
| WS3 | Gates | additive `target` in `experiment/runner.ts`, `forge/gate.ts`, `forge/verdict.ts` | WS1, WS0 | registers only via `registerExperiment` |
| WS4 | Approve + apply + attribution | `forge/decide.ts`, `apply.ts`, `trailers.ts` | WS1, WS3 | trailers per ADR-29 |
| WS5 | Ledger + usage | `mission/ledger.ts`, `report.ts`, usage into `attempt_usage` | WS1, WS0 | three-way `cost.reported` rename (ADR-32) |
| WS6 | Transcript ingester | `ingest/claude-code.ts`, `ingest/commands.ts`, `redact` shapes, synthetic fixtures | WS1, WS5 | parser built against fixtures |
| WS7 | Spec intake + work items | `forge/spec.ts`, `decompose.ts`, `propose_work_item` | WS1, WS0 | blind-filtered |
| WS8 | Orchestration + CLI + needs | `forge/orchestrate.ts`, `commands.ts`, `mission/needs.ts`, ACCEPTANCE P1 section, `test:all` | WS2–WS7 | `forge-e2e.ts` covers the full loop |
| WS9 | UI | new IPC handlers, `CandidateReview.tsx`, `Ledger.tsx`, `WorkItems.tsx`, implement branch, needs strip | WS1; WS8 JSON | built against fixture JSON |

**Final order (R6):**

1. WS0 re-review → fixes → merge into `daylight` (local, reversible).
2. WS-R.
3. WS1.
4. WS2 ∥ WS3 ∥ WS5 ∥ WS7, with WS6 and WS9 building on fixtures.
5. WS4 → WS8 → WS9 merge → acceptance.
6. One authorised live author run (needs Q5 and a Q4 credential).

**Status per the sources.** The WS0 review says merge after fixes 1–3. This document does not
record them as done. WS-R is inventoried and its questions are answered. No feature workstream
has started.

**CLI (F-8, new names).**

- `daylight mission authorize`
- `daylight gate register|baseline|lock|list`
- `daylight forge run|evaluate|candidate|approve|reject|override|apply`
- `daylight work-item list|approve|reject`
- `daylight spec register|decompose`
- `daylight ingest claude-code <repo> [--session]`
- `daylight report --project [--group actor|model|mission|work-item]`
- `mission list|inspect` gain `needs`, `candidates`, `gateEvaluations`, `applications` and
  `usage`.

The `--out`, `--format json` and exit-code contracts are unchanged. For authorize, lock,
approve/override and apply, a native main-process dialog names the digest, gates and ref, and
main supplies `--confirm`. The renderer never names a path, actor or ref.

## 8. Live model spend

Live model spend requires explicit owner authorisation, as under ADR-7. Every test and every
acceptance step uses mock adapters (`DAYLIGHT_MOCK_ADAPTER`, `mock:<x>`), labelled `mock` in every
artifact. The one live author run needs the owner's Q5 yes and a Q4 credential. No writer,
reviewer or integrator starts a live run on their own judgement.

## 9. Acceptance criteria (mocks only)

On the fixture, a human can do each of the following.

1. **Spec intake.** `daylight spec register`, then two blind mock decomposers. See one
   `spec-ambiguity` need. Approve one work item. Neither proposal was visible to the other.
2. **Authorize.** Create an implement mission (`draft`, `write:false`) and `authorize` it. See
   `mission.authorized`, with `write:true` on the mission, the attempt row and the UI.
3. **Gates.** Register a gate and a holdout and baseline both `falsified`. A vacuous third gate is
   refused at lock. Lock with a rationale and the digest.
4. **Run.** `forge run` the mock author in bwrap. The workspace is created and removed and the
   real checkout is untouched. There is a candidate summary and a redacted diff, and the narrative
   is labelled unverified.
5. **Verdicts.** `accepted-by-gates` for a correct diff. `no-diff` for a mock that exits 0
   printing "all tests pass". A policy violation for an edit to `.daylight-gates/**`.
   `secret-in-diff` for a mock that writes `/proc/self/environ`.
6. **Approve and apply.** Approve only the accepted candidate (CLI and GUI). Override demands a
   rationale. Apply creates a ref with ADR-29 trailers and no dollars or tokens, and leaves HEAD
   and the tree unchanged. `closeMission(succeeded)` is refused before apply and allowed after.
7. **Report.** `daylight report --project --group model` prints `≥ $X (N unknown)` totals, token
   columns with `unknownCount`, and the case-study line.
8. **Ingest.** A synthetic transcript becomes a `work` mission, with deduped turns, child attempts,
   `costUsd` unknown and no transcript text in any artifact.
9. **Export.** Export → import into a fresh dir replays byte-equal. A v1 export and a v1
   `daylight.db` are refused with the one-line message.

Repository-wide checks:

- `pnpm typecheck` is clean and `pnpm test:all` is green.
- The test count is at or above the WS-R baseline.
- The R1 preserved-guarantee tests are intact.
- The R7 write/authorize invariant holds, and no "author cannot write" invariant exists.
- The WS-R identifier invariant and the prompt/allowlist consistency test pass.

The plan asked for "every P0 assertion intact". Under R1 that covers the preserved guarantees,
not tests that pin old names, paths or v1 compatibility. RULINGS wins.

## 10. Open questions

1. **Author exec inside the sandbox (ADR-35).** Awaiting the owner. The two options are:
   - **(a)** no exec. Authors write text, code runs only in the no-network gate sandbox, and
     `forge-author-no-exec` ships.
   - **(b)** exec allowed inside the author sandbox through WS2's profile flag.

   The wording actually put to the owner (the director's reply of 2026-10-16) is not among this
   document's sources. This framing is a reading of PLAN, proposal B and R7.
2. **Commit trailer attribution.** The owner asked WS0 for `Co-Authored-By: Claude Fable 5.1`.
   WS0's 33 unpushed commits carry the harness-supplied `Co-Authored-By: Claude Opus 5.5`, which
   matches the model that wrote them. The choice is:
   - keep the Opus trailer;
   - rewrite the 33 commits before merge. That is mechanical, but it rewrites history and needs
     the owner's explicit go-ahead.

   This is separate from the `Co-Authored-By` line Daylight writes on applied candidates.
3. **The live author run (Q5, ADR-31).** It needs the owner's authorisation. The target repository
   is not chosen.
4. **The live credential (Q4, ADR-30).** The policy is decided. Provisioning, the cap amount, and
   which variable the adapter allowlists for it are not.
5. **Is Sec H5 closed? (ADR-27).** R3 says yes for the default layout. The WS-R inventory says
   reviewer tools still reach absolute paths. Unresolved.
6. **Author-profile node binding.** F-1 binds node at `/opt/node/bin/node`. WS0 deviation 3 binds
   it at its own path, to keep `experiment.ts:144` true. R5 does not list this deviation, and WS2
   needs a ruling.
7. **Ledger M4 blind half (= Sec L6).** It is pinned by `engine/test/orchestrate.ts:179`. R1 now
   permits narrowing that test, but nobody has ruled.
