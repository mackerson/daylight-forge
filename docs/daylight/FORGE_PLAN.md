# Daylight Software Forge — P1 plan

Status: plan of record for P1, 2026-10-16. This is the durable record for the P1 case study: what
is decided, what is open, and where each decision came from.

Lineage: `docs/DAYLIGHT_SPEC_v0.1.md` (product spec) and `docs/daylight/PLAN.md` (the P0
coordination plan, ADR-1 to ADR-7, now a frozen P0 record). ADR numbering continues at ADR-8.
This is a new document, not an edit of the P0 plan (R8.3).

Precedence: the director rulings of 2026-10-16 (R1–R9) override the reconciled plan. Where they
conflict, this document says "RULINGS wins" in one line.

## 1. Purpose and scope

P1 Forge turns Daylight from a system that reviews code into one that writes code under evidence:
"protected specification → scoped author workspace → independent test → approved merge" (spec §2,
§7). It delivers four things:

1. **Implement-mission runner.** A human authorises write and locks gates. An author edits a
   detached workspace under bubblewrap. The diff becomes a candidate that is evaluated against
   the locked gates. A human approves, and Daylight applies it as a new ref with trailers.
2. **Ledger.** Per-turn tokens and per-attempt cost by actor, model, mission and work item.
   Unknown is never summed as zero or estimated. Every application gets a case-study line.
3. **Transcript ingester.** Imports Claude Code sessions as `work` missions, storing digests and
   counts, never text.
4. **UI.** Candidate review, ledger and work-item screens, plus a derived `needs` strip.

Spec intake (spec → proposed work items → human approval) is in scope; it produces the
acceptance criteria.

Deferred (PLAN §5): egress proxy, Docker/VM profile, repair loops, rebase onto a moved HEAD,
`--onto-current` and merge automation, CI/PR gates, model routing, codex/grok/opencode authors,
signed decisions, seeded-mutation gate scoring, a `requirements` table, live console streaming,
ledger M7. Gate dependency snapshots are P2 (ADR-28). Author exec is decided: (a), the nested `run` tool (ADR-35).

## 2. How we got here

Sources are working papers outside the repository, cited, not reproduced.

- **Proposals A and B**: two independent plans written from the code at `daylight` @ 13a5775.
- **Security review**: 22 findings (5 High, 9 Medium, 8 Low), e.g. symlink write-out (H1) and
  host git hooks from `git worktree add` (H3).
- **Ledger review**: 32 findings (6 High, 12 Medium, 14 Low), e.g. orphaned attempts (H1).
- **Reconciled plan**: resolved 16 conflicts, VERIFIED audit findings outranking either proposal,
  and defined WS0–WS9.
- **WS0**: 30 of 30 findings fixed, five deviations declared. The independent review found 26
  CLOSED, 3 PARTIAL and 1 REGRESSION, and asked for three fixes. Two landed (fec9b36 sweep trust
  boundary, 1ed128f smudge/process filters), as did 878cf7e, which amended ADR-6 by director
  ruling. WS0 is merged into `daylight` at 0334326 (35 Opus-attributed commits, 1,343 tests
  passing). The third fix, legacy event-id dedupe, did not land (§7).
- **Rulings R1–R9**: made with the owner. They withdraw P0 compatibility, rename the product,
  answer Q1–Q5, make write mode first-class, insert WS-R before WS1, and record what is still
  open (R9).
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

ADR-1, ADR-2, ADR-5 and ADR-7 also stand. ADR-6 stands as amended in WS0 (878cf7e, director
ruling): a blind reviewer sees no agent claim but its own, plus human and static claims.

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

WS-R changes only names and the default out location; the test count must not drop. It adds an
invariant (no old-name identifiers outside CHANGELOG/history docs) and a static test that every
tool in the fixture reviewer prompt is in the adapter allowlist (R8.5).

Frozen P0 records keep the old names verbatim, each with a one-line banner saying the CLI is now
`daylight`: TODO.md, `docs/daylight/{BASELINE,MEASURED,ACCEPTANCE,PLAN}.md`,
`docs/DAYLIGHT_SPEC_v0.1.md` and `.codemap/*`. WS-R picks the unnamed replacements (IPC
channel prefix, invariants file, progress-envelope prefix).

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
- **Consequences.** The author sees no git metadata and never writes to the real `.git`. Whether
  code runs in the workspace only through the author's nested `run` tool, on an explicit exec
  grant (ADR-35, decided (a)).
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
  the P0 telemetry test asserts that events carry `1` (`engine/test/telemetry.ts:145` at 0334326).
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

- **Decision.** No state-machine change. `engine/test/orchestrate.ts` keeps asserting `running` (lines 131, 259, 402 at 0334326).
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
- **Consequences.** Tests pinning old names, paths or v1 may change; preserved-guarantee tests
  may not.
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
- **Consequences.** The move does **not** close H5 (R3 correction). Reviewers run unsandboxed
  today with `cwd: root` (`engine/mission/orchestrate.ts:452` at 0334326); the move only removes
  the relative `out/claims.db` hop. R9.1 rules that WS2's sandbox gains a `review` profile alongside `author`
  and `gate`: repo ro-bind, no `<out>`, network `shared`, no write. WS8 runs review attempts under
  it when bwrap is present. Whether real `claude`/`codex` work under that profile needs one
  authorised live spike. Until then the ledger records H5 as open.
- **Status.** Decided for the location and the `review` profile. H5 itself is Open (§10).

### ADR-28 — Gates are zero-dependency or vendored (Q1)

- **Decision.** Option (a). Install snapshots are P2.
- **Consequences.** Gates needing `node_modules` must vendor them in P1.
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
  is `Daylight mock adapter (test double) <mock@daylight.invalid>`; unmapped tools get
  `<agent@daylight.invalid>`. Trailers are written with
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
  - From the WS0 review (§3, §7), not R5: WS1 adds the row-side reaper for pending rows that
    survive a `/tmp` wipe, and WS5's brief must state that `adapters.ts:420` and `capture.ts:173` key on `cost.reported`, so
    all three rename together, with a `runMission` over-budget test.
  - The node binary stays bound at its own host path (WS0 deviation 3 stands). PLAN F-1's
    `/opt/node/bin/node` is withdrawn.
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
  `forge-author-no-exec` invariant in WS2. R7 put exec to the owner on 2026-10-16 (R9.2):
  - **(a)** exec allowed inside the author bwrap: rw detached tree, network `none`, prlimit,
    gate tests never mounted. Exec is an explicit, recorded profile flag.
  - **(b)** write only; the gates execute (PLAN as written).
- **Decision.** (a), by the owner on 2026-10-16 (R17.1), as refined by R11.1: exec is the MCP
  `run` tool, never a shell beside the agent. Its argv runs in a nested bwrap over the same
  detached tree with `--unshare-net` (in fact `--unshare-all`), prlimit, no MCP socket and the
  gate tests never mounted. It is permitted only when the mission's `authorize` decision carried
  `execute: true` explicitly (default false); `--execute` without `--write` is refused; the
  attempt row and the candidate profile record `exec`, and the store refuses an exec attempt
  whose grant did not carry it.
- **Consequences.** `forge-author-no-exec` does not ship. R15.5's refuse-until-decided is lifted.
  The e2e proves the nested sandbox has no TCP and no gate paths, and that a write-only grant has
  no `run` tool.
- **Status.** Decided (a), 2026-10-16.

### ADR-36 — Plan as data (P2, WS-R5)

- **Context.** P2's building pass runs many tickets from one plan. A spec decomposed by agents
  (WS7) needs a person to approve each work item; a campaign of hundreds of tickets cannot.
- **Decision.**
  - A campaign's plan is JSON (`daylight.plan.json`, `kind: daylight-plan`, version 1), read from
    git objects at a named commit, never the working tree. JSON, not TOML: no parser dependency,
    and it is canonicalised for digests already.
  - It is validated like a proposal: caps, id grammars, refusals that name a JSON path and never
    echo the refused text; scopes inside their lane, not protected, existing at the commit; an
    acyclic DAG; gate and acceptance paths that are regular files there. The project policy is
    read from its blob at the plan commit (P2-R20).
  - A campaign is a mission of kind `campaign` (decisions need a mission). Its tickets are
    `campaign_tickets` rows bound to work items; its ticket missions name it as `parentId`, which
    the store now validates.
  - `campaign import` is not a decision. `approve-plan` is: one guarded human act whose digest
    lists every plan ticket's work item at its content digest, approving them all at once.
  - Holdouts never sit in the plan, which authors can read.
- **Consequences.** Plan revisions keep unchanged tickets' work items and supersede changed ones at
  the next `approve-plan`; any revision invalidates the campaign authorization. docs/daylight/CAMPAIGN.md.
- **Status.** Decided (P2-R15, P2-R16, P2-R20).

### ADR-37 — Campaign authorization and derived decisions (P2, WS-R5)

- **Context.** ADR-9 and ADR-34 need a `human:` decision for every write. A campaign runs
  unattended, so the per-ticket grant must come from one human decision without weakening R7.
- **Decision.**
  - `authorize-campaign` is a guarded human decision recording an envelope: plan and gate-set
    digests, the tickets, rosters, spend caps, author bounds within `authorLimits` at the plan
    commit, attempts, concurrency, execute, auto-apply, the fix lane (High findings, at most 5 a
    wave), the committer identity and `notAfter`.
  - Inside it, the director process records **derived decisions** as `campaign:<m_id>`:
    `authorize-mission` on a ticket mission, `integrate-candidate`, `admit-work-item`,
    `halt-campaign`. Each names the human grant as `derivedFrom`. The derived `authorize-mission`
    is an ordinary grant on the ticket mission, so R7 holds literally.
  - `recordDecision` refuses every campaign actor (P2-R19). `recordDerivedDecision` is the one
    writer and re-checks the envelope against rows (current authorization, window, not halted,
    plan and lock current, ticket covered, execute and budget within it, one mission a ticket).
    Only the store, `forge/campaign.ts` and `forge/integrate.ts` may call it: the
    `derived-writer-callers` invariant, a `forbidden-callee` over a negative-lookahead file regex
    (the `forbidden-call` form named in the design sees no edge for a method reached through
    `ctx.store`, so it would be green with any caller).
  - Grants, `attemptRefusal`, `startAttempt` and `unauthorizedWriteAttempts` resolve a derived
    grant's parent; a forged one is refused and reported. `startAttempt` re-checks the envelope,
    so nothing starts after `notAfter` or a halt.
  - Every campaign command that writes a row or moves a ref is refused under `CLAUDECODE` and
    `DAYLIGHT_SESSION`, at the CLI (P2-R9, P2-R24). The store never reads the environment. This is
    ADR-20's heuristic: a session importing the engine from `node -e` is outside the threat
    model, like raw SQL.
  - Campaign missions are never exported or imported (P2-R14). A preflight-refused ticket is
    released only by a guarded `campaign retry` (P2-R25, P2-R27).
- **Consequences.** What stays a human act is listed in docs/daylight/CAMPAIGN.md. The final
  merge of the integration ref into `main` is plain git, by a person (ADR-17).
- **Status.** Decided (P2-R9, R10, R12, R14, R19, R22–R27).

### ADR-38 — Integration ref, rebase by plumbing, repair loops (P2, WS-R6)

- **Context.** A campaign lands hundreds of tickets with no per-ticket human act. P1's apply
  writes one branch per mission from a human approval and refuses a base that is not HEAD's.
- **Decision.**
  - Accepted campaign candidates land on `refs/heads/daylight/campaign/<id>`, moved only by
    compare-and-swap; each landing also writes the per-mission ref, create-only. Nothing outside
    `refs/heads/daylight/**` moves; HEAD, the index and the working tree are never touched; no
    hook runs. A person merges the integration ref.
  - A candidate on the tip is applied with its own digest; one on an older tip is merged with
    `git merge-tree --write-tree --merge-base` in a scratch bare repository, and a conflict is the
    verdict `rebase-conflict`. The commit is rebuilt in the real store object by object, as ADR-17.
  - Checks run on the integrated tree (`gate_evaluations.target = 'integrated'`, naming the
    integration). `campaignVerdict` is pure over rows; `stale-base` never fires in a campaign.
  - The landing's rows (derived `integrate-candidate`, application, integration) are one
    transaction R6 owns, calling R5's envelope check inside it (P2-R22).
  - Failures are repaired with the failure fenced into the next brief, holdouts counted only,
    up to the ticket's attempts. Every attempt, wave reviewers included, reserves its ceiling on
    the attempt row before launch; unknown cost halts as the attempt ends, before its candidate can
    land; a ticket that used its own budget is blocked, never the campaign (P2-R35).
  - Only a candidate `accepted-by-gates` on the integration's own tree lands, whoever calls; an
    accepted candidate met during a halt stays accepted and is integrated again after a person
    resumes or adopts the tip (P2-R35).
  - Every state is derived from rows; a crash resumes by the table in docs/daylight/CAMPAIGN.md.
- **Consequences.** Static: `campaign-verdict-is-pure`, `director-spawns-nothing`, and three call
  counts named for what they check (`integrate-calls-cas-ref`, `director-asks-spend-refusal`,
  `director-redacts-brief-text`); the guarantees themselves are behavioural tests, with
  `integrationRefusals` and `applicationRefusals` as the row halves. A ref moved by hand halts the
  campaign until a person adopts the tip.
- **Status.** Decided (P2-R11, P2-R17, P2-R18, P2-R22, P2-R23, P2-R35).

### ADR-39 — Wave review and the fix lane (P2, WS-R6)

- **Context.** Gates say a ticket does what its tests say; nobody reads the code that landed. A
  review per ticket would cost as much as the authoring.
- **Decision.**
  - Every `waveSize` landings, blind reviewers under the `review` profile read a materialised tree
    of the wave's last commit and file findings through one MCP tool, `report_finding`, that reads
    nothing back. Findings are re-validated and redacted on the host.
  - Each finding becomes a proposed fix ticket; only a High one is admitted by the envelope, at
    most five a wave (P2-R10). Lower severities wait for a person. A review reserves its budget
    and is checked against the cap and any halt before it starts (P2-R35); fix tickets are filed
    by WS-R5 (P2-R36).
  - A finding never touches a verdict or a landed commit (ADR-19).
- **Consequences.** A reviewer's text becomes an author's brief, fenced, redacted and capped, and
  the result must pass the same gates: the same posture as spec → author. `reviewRoster: []`
  turns it off without touching anything else.
- **Status.** Decided (P2-R10).

### ADR-42 — Independent IR review; agreement is not approval (P2, WS-R15)

- **Context.** Extracted IR records are an agent's reading of a specification. Several agents
  reading the same window will often agree, and agreement is tempting to treat as truth. ADR-14
  already says proposals are data and a person approves; spec ingestion must not reopen that by
  counting.
- **Decision.**
  - Review is blind: an `audit` mission under the corpus, one reviewer per (window, tool), at
    least two tools, one append-only tool (`report_ir_finding`) that reads nothing back, and a
    prompt that never says how many extractors observed a record. Findings are re-validated on
    the host and recorded `open`; `corroboratedBy` is shown and decides nothing.
  - `approve-ir` is the only way a record or a finding moves: one guarded human decision keyed
    `<id>:<contentDigest>`, naming the approved set's digest after it, refused whole (ids only,
    never text) on any rule in docs/daylight/INGEST.md. There is no agreement-count selector, in
    the API or on the CLI.
  - Approving an ambiguity or contradiction, or accepting a finding that changes what a standing
    requirement says, opens an `ir-interpretation` assumption (`OIR.*`, open, blocking, no
    default): Daylight never picks a reading (P2-R12). One decision on it unblocks the record and
    every plan ticket that blocks on it (`assumptionByOwnerDecision`).
- **Consequences.** Live extractors rarely agree byte for byte, so most records are
  single-extractor and a person's sweep (`--section`) is informed by counts, not by a vote.
- **Status.** Decided (P2-R12, P2-R50, P2-R53). Numbered after WS-R14's ADR-41 regardless of merge
  order; the interface plan's ADR-42 (the IR boundary) is folded into WS-R14's ADR-41.

### ADR-43 — Blueprint, packets, one plan type, and the authority chain (P2, WS-R15)

- **Context.** A plan derived from a specification must say where each ticket came from, survive
  a person editing it, and stop being trusted when the specification changes — without Daylight
  writing into the target repository or rewriting history.
- **Decision.**
  - A blueprint (boundaries, components, interfaces, order) is data checked all at once against
    the approved IR and approved by a person over the current IR set; derivation rows record which
    element rests on which record.
  - A packet's digest is the digest of the plan ticket it becomes, with no plan defaults; its id
    follows from it. Packets are emitted as a version-2 plan under `<out>`, never the repository;
    a person commits it and `campaign import` checks descent, flagging `hand_edited` tickets and
    refusing a re-pointed packet or a packet set that does not hash (P2-R50 F1).
  - One `PlanFile` with `version: 1 | 2`; the trace fields enter `ticketDigestOf` only when
    present, so every version-1 digest is unchanged (P2-R53 D-b).
  - Acceptance obligations bind to locked gates inside the gate-set digest; `authorize` refuses an
    obligation no locked gate discharges unless a person names it (P2-R50 F3).
  - Staleness is derived from `ir_spans` at the current revision; a revision adds span rows and
    rewrites none (P2-R53). The chain corpus → sections → IR → blueprint → packets → plan →
    envelope is re-derived on every director pass and a broken link fails closed.
  - Authors see exact quotes (`SPEC-CONTEXT`), digest-checked, holdout basenames withheld and
    counted, never the whole specification; in-repo corpus documents are protected paths.
- **Consequences.** Recovery from a revised specification is a person's: supersede in
  `approve-ir`, approve a new blueprint, emit, commit, import, approve the plan.
  `TicketStatus 'stale'` and its bucket land with WS-R16's merge; until then `staleTickets` is read
  by needs only.
- **Status.** Decided (P2-R13, P2-R50, P2-R53). Covers the interface plan's ADR-43 and ADR-44.

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
- `Decision.scope.operation` names the act (authorize, lock, work-item and candidate decisions).
- Events stay at `schemaVersion 1`; payloads carry ids and digests, never prose.

**Verdict** (pure over rows). `accepted-by-gates` requires all of the following:

- the policy check is clean;
- the diff is non-empty;
- the base equals the mission base;
- the lock digest is current;
- every locked gate and holdout is `supported` on this `diffDigest` at the locked `harnessDigest`;
- every baseline is `falsified` or overridden.

Otherwise: any `invalid` → `gates-invalid`; timeout or flaky → `gates-inconclusive`; else
`rejected-by-gates`. A test proves the verdict ignores exit code, attempt state, narrative and
reviewer claims.

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
| WS0 | P0 hardening | runner, sandbox, events, capture/normalize, adapters, store, orchestrate, export, project, MCP server, App.tsx | — | merged at 0334326; legacy event-id dedupe outstanding (tracked below) |
| WS-R | Rename | identifiers, env, config dir, default `<out>`, banners, MCP key, consistency test | WS0 | serial; names and out location only |
| WS1 | Contracts + schema v2 | `mission/types.ts`, `db.ts`, `store.ts`, `export.ts` (v2 only), `forge/policy.ts` | WS-R | no migration; v1 refused; row-side reaper; `closeMission` rule |
| WS2 | Workspace + author sandbox | `forge/workspace.ts`, `sandbox.ts`, `authors.ts`, `diff.ts` | WS1 | adds the `review` profile (ADR-27); author exec behind a profile flag (ADR-35); escape tests; both network modes |
| WS3 | Gates | additive `target` in `experiment/runner.ts`, `forge/gate.ts`, `forge/verdict.ts` | WS1, WS0 | registers only via `registerExperiment` |
| WS4 | Approve + apply + attribution | `forge/decide.ts`, `apply.ts`, `trailers.ts` | WS1, WS3 | trailers per ADR-29 |
| WS5 | Ledger + usage | `mission/ledger.ts`, `report.ts`, usage into `attempt_usage` | WS1, WS0 | three-way `cost.reported` rename (ADR-32) |
| WS6 | Transcript ingester | `ingest/claude-code.ts`, `ingest/commands.ts`, `redact` shapes, synthetic fixtures | WS1, WS5 | parser built against fixtures |
| WS7 | Spec intake + work items | `forge/spec.ts`, `decompose.ts`, `propose_work_item` | WS1, WS0 | blind-filtered |
| WS8 | Orchestration + CLI + needs | `forge/orchestrate.ts`, `commands.ts`, `mission/needs.ts`, ACCEPTANCE P1 section, `test:all` | WS2–WS7 | `forge-e2e.ts` covers the full loop; review attempts run under the `review` profile when bwrap is present |
| WS9 | UI | new IPC handlers, `CandidateReview.tsx`, `Ledger.tsx`, `WorkItems.tsx`, implement branch, needs strip | WS1; WS8 JSON | built against fixture JSON |

**Final order (R6):**

1. WS0 re-review → fixes → merge into `daylight` (local, reversible).
2. WS-R.
3. WS1.
4. WS2 ∥ WS3 ∥ WS5 ∥ WS7, with WS6 and WS9 building on fixtures.
5. WS4 → WS8 → WS9 merge → acceptance.
6. One authorised live author run (needs Q5 and a Q4 credential).

**Status (verified at `daylight` 0334326).** WS0 is merged. One review item is outstanding and is
tracked here: ws0-review R1, legacy event-id dedupe (Medium). An `<out>` dir that predates WS0 can
double-ingest events with nested payloads once. The WS0 writer accepted this under R2, which makes
such dirs disposable. The review suggests WS1 or a standalone ~5-line `events.ts` patch as owner.
WS-R is inventoried and its questions are answered. No feature workstream has started.

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

The `--out`, `--format json` and exit-code contracts are unchanged. Human decisions go through
a native main-process dialog naming digest, gates and ref; main supplies `--confirm`. The
renderer never names a path, actor or ref.

## 8. Live model spend

Live model spend requires explicit owner authorisation (ADR-7). Every test and acceptance step
uses mock adapters (`DAYLIGHT_MOCK_ADAPTER`, `mock:<x>`), labelled `mock` in every artifact. No
writer, reviewer or integrator starts a live run on their own judgement.

## 9. Acceptance criteria (mocks only)

The fixture is the planted repository `fixtures/daylight-demo`: its defect was placed
deliberately, as `DEFECT.md` and `docs/daylight/DEMO.md` say. On it, a human can do each of the
following.

1. **Spec intake.** `daylight spec register`, then two blind mock decomposers. See one
   `spec-ambiguity` need. Approve one work item. Neither proposal was visible to the other.
2. **Authorize.** Create an implement mission (`draft`, `write:false`) and `authorize` it. See
   `mission.authorized`, with `write:true` on the mission, the attempt row and the UI.
3. **Gates.** Register a gate and a holdout and baseline both `falsified`. A vacuous third gate is
   refused at lock. Lock with a rationale and the digest.
4. **Run.** `forge run` the mock author in bwrap: workspace created and removed, real checkout
   untouched, candidate summary, redacted diff, narrative labelled unverified.
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

PLAN's "every P0 assertion intact" now covers only the preserved guarantees. RULINGS wins.

## 10. Open questions

Items 1–4 are R9's open items, recorded so that no writer invents an answer.

1. **Sec H5: reviewer reach (R9.1, ADR-27).** Reviewers are not sandboxed today. The ruling is
   that WS2 adds a `review` profile and WS8 runs review attempts under it when bwrap is present.
   One authorised live spike must still confirm that real `claude`/`codex` work under that
   profile; this is owner Q5 territory. Until then H5 is **Open** and the ledger says so.
2. **Author exec inside the author sandbox (R9.2, ADR-35).** Put to the owner on 2026-10-16. The
   options are:
   - **(a)** allow exec inside the author bwrap: rw detached tree, network `none`, prlimit, gate
     tests never mounted. Exec is an explicit, recorded profile flag. The director recommends
     this option. That is a recommendation, not a decision.
   - **(b)** write only, and the gates execute (PLAN as written).

   **Decided (a)** by the owner on 2026-10-16 (R17.1): exec is the nested no-network `run` tool
   on an explicit `--execute` grant. See ADR-35.
3. **Commit trailer attribution (R9.3).** This covers Opus-written commits: WS0's 35 unpushed commits
   (the merge 0334326 carries Fable 5.1) and this document's own commits. The options are:
   - keep `Claude Opus 5.5`, the honest record. The director recommends this.
   - rewrite the trailers to Fable 5.1, per the owner's global rule. This rewrites history.

   **Decided: keep** by the owner on 2026-10-16 (R17.2): Opus-written commits keep their
   Claude Opus 5.5 trailer; merges carry Fable 5.1. It is separate from the
   `Co-Authored-By` line that Daylight writes on applied candidates.
4. **The live author run (Q5) and its credential (Q4a) (R9.4, ADR-30, ADR-31).** Neither is
   authorised, so the status is **Open**. The target repository, the credential's provisioning
   and its cap are not chosen.
Not open, recorded for the case study:

- **Ledger M4 blind half (= Sec L6): closed.** It was ruled by the director and merged in WS0
  (878cf7e): ADR-6 is amended in `docs/daylight/PLAN.md` and asserted at
  `engine/test/orchestrate.ts:182`.
- **Legacy event-id dedupe (ws0-review R1): tracked, not landed** (§7).
