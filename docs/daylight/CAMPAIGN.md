# Campaigns

A campaign builds many tickets from one plan. A person approves the plan once, authorizes an
envelope once, and the director process (`campaign run`, WS-R6) acts inside that envelope with no
further human act per ticket. Every director act is a **derived decision** recorded as
`campaign:<m_id>` that names the human grant it derives from (ADR-36, ADR-37).

This page covers the WS-R5 half: the plan file, `approve-plan`, `authorize`, assumptions,
`retry`, and which commands an agent session may run. The integration ref, gates, the run loop,
wave review and `status` are WS-R6's, in [Running campaigns](CAMPAIGN-RUN.md).

A campaign is a mission of kind `campaign`. Its ticket missions are implement missions whose
`parentId` is the campaign. It never holds write, execute or deploy.

## The plan file

The plan is JSON, by default `daylight.plan.json` at the repository root, at any repo-relative
path. It is read from git's object store at a named commit (`--rev`, default `HEAD`), never from
the working tree. An uncommitted edit is not the plan.

```json
{
  "kind": "daylight-plan", "version": 1, "title": "Widen the decimal API",
  "derivedStatus": true, "statusPath": "docs/STATUS.md",
  "defaults": { "budget": { "maxUsd": 2 }, "acceptance": { "kind": "ci-only" } },
  "campaignGates": [
    { "id": "core-regress", "role": "regression", "harness": "cargo", "crate": "crates/core",
      "path": "crates/core/tests/regress.rs", "expect": { "exitCode": 0 } }
  ],
  "lanes": [
    { "id": "CORE", "title": "Core crate", "owns": ["crates/core/src", "crates/core/tests"] },
    { "id": "APP", "title": "App crate", "owns": ["crates/app/src"], "maxParallel": 1 }
  ],
  "ownerDecisions": [
    { "id": "O1", "question": "Is a negative input an error or a panic?", "blocking": true },
    { "id": "O2", "question": "Which integer width?", "blocking": false, "default": "u64" }
  ],
  "tickets": [
    { "id": "C1", "lane": "CORE", "title": "Add signed decimal",
      "statement": ["decimal_i64 formats a signed integer.", "It never allocates twice."],
      "examples": ["decimal_i64(-7) == \"-7\""], "scope": ["crates/core/src/lib.rs"],
      "budget": { "maxUsd": 1.5 } },
    { "id": "C2", "lane": "CORE", "title": "Reject negatives on request", "statement": "A checked variant.",
      "dependsOn": ["C1"], "blocksOn": ["O1"], "scope": ["crates/core/src/"] },
    { "id": "A1", "lane": "APP", "title": "Print a signed value", "statement": "main prints -7.",
      "dependsOn": ["C1"], "scope": ["crates/app/src/main.rs"],
      "acceptance": { "kind": "gate", "tests": [
        { "path": "crates/app/tests/app_gate.rs", "harness": "cargo", "crate": "crates/app", "expect": { "exitCode": 0 } } ] } }
  ]
}
```

| Field | Rule |
| --- | --- |
| `kind`, `version` | Exactly `daylight-plan` and `1`. |
| ticket `id` | `^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$`, at most 32 characters, unique. `FIX.` and `FU.` are reserved for generated tickets. |
| lane `id` | `^[A-Z][A-Z0-9]{0,7}$`, unique. `FIX` is reserved for the fix lane. |
| owner decision `id` | `^O[A-Z0-9.]{1,31}$`. A non-blocking one needs a non-empty `default`. |
| campaign gate `id` | `^[a-z][a-z0-9-]{0,31}$`; `role` is `regression`. |
| `title` | One line, at most 120 characters. |
| `statement` | A string, or a list of lines joined by newlines; at most 4 KiB joined. |
| `examples`, `negativeExamples` | At most 10, each at most 1 KiB. |
| `scope` | Repo-relative prefixes inside the ticket's lane `owns`, each a file or directory at the plan commit, or ending in `/` for a directory that does not exist yet. Never a protected path, a gate path, the plan file or `statusPath`. |
| `owns` | Lanes' prefixes are pairwise disjoint, except a prefix both lanes list in `shared`. |
| `dependsOn` | Existing tickets, no self edge, no cycle (a cycle is reported as its id path). |
| `blocksOn` | Declared owner decisions. |
| `acceptance` | `ci-only` (default), `gate` (tests that are regular files at the plan commit, bound to the ticket) or `writer-authored` (`testPaths` inside the ticket's scope; for cargo, under `<crate>/tests/`). |
| `harness`, `crate` | `node` or `cargo`; a crate only with cargo, and a directory with a `Cargo.toml` at the plan commit. There is no argv harness (P2-R16). |
| `budget` | `maxUsd`, `maxTurns`, `timeoutSeconds`, `maxAttempts` (1–10). Each only lowers the envelope's cap. |
| Caps | At most 2 MiB, 2,000 tickets, 64 lanes, 64 owner decisions, 16 campaign gates. Unknown keys are refused. |

The project policy (`daylight.policy.json`) is read from its blob at the plan commit too; one that
does not parse refuses the plan (P2-R20). Holdouts are never in the plan: the plan sits in the tree
authors read. A person registers them out of band (`campaign gate register --role holdout`, R6).

Validation is pure and reports every refusal at once, each with a JSON path, a rule and a fixed
reason. It never echoes the text it refused: a plan is something a person approves, but it may
have been written by an agent.

```
daylight campaign validate daylight.plan.json <repo> [--rev HEAD] [--format json]   # writes nothing
daylight campaign import <repo> --file daylight.plan.json [--rev HEAD] [--campaign <m>]
daylight campaign show <campaign> [--format json]   # DAG, lanes, a waves preview, owner decisions, needs
```

`import` is not a decision. It creates the campaign (a read-only `draft` whose scope is
`[planPath, statusPath]`, so no ticket author may edit the plan), files the plan as an artifact,
one **proposed** work item and one ticket row per ticket, and one `open` assumption per owner
decision. A work item's id is derived from the campaign, the ticket and its content, so importing
the same plan twice changes nothing.

A **revision** is `campaign import … --campaign <m>` at a later commit. Unchanged tickets keep their
work item; a changed ticket gets a new one, and the next `approve-plan` supersedes the old. A
revision that changes or drops a ticket whose mission is still open is refused. Any plan change
invalidates the authorization, which names the plan digest.

## approve-plan

```
daylight campaign approve-plan <campaign> --rationale '…' --confirm <digest8>
```

The one approval of a plan. It goes through the same guard as every other Forge decision (ADR-20):
refused under `CLAUDECODE` or `DAYLIGHT_SESSION`, refused for anyone but the OS user, refused
without the first eight hex of the digest being confirmed. Without `--confirm` it prints what it
would approve and the digest, and exits 2.

The digest covers the campaign, the plan digest and revision, and every plan ticket's work item at
its content digest. One decision then moves every proposed plan work item to `approved`,
supersedes what the plan dropped or changed, moves the plan's non-blocking owner defaults to
`pending`, and readies the campaign, in one transaction.

## authorize-campaign

```
daylight campaign authorize <campaign> --expected-gate-set <digest> --roster mock \
  --max-usd-total 40 --max-usd-per-mission 2 --max-turns 60 --timeout 600 --max-attempts 3 \
  --concurrency 6 [--wave-size 12] [--execute] --auto-apply integration-ref|none \
  [--review-roster mock,mock:b] [--fix-lane 5:1.5|off] [--tickets C1,A1] [--not-after 72h] \
  [--identity 'Name <email>'] --rationale '…' --confirm <digest8>
```

Guarded like `approve-plan`. The confirm digest covers every field of the envelope, so a code read
for one envelope authorizes no other. Refused unless:

- the latest `approve-plan` names the plan as last imported;
- the latest `lock-campaign-gates` decision names exactly `--expected-gate-set` (WS-R6 records it);
- every ticket in `--tickets` (default: every approved plan ticket) is an approved plan ticket;
- `max-usd-per-mission ≤ max-usd-total`, the fix lane's per-ticket cap ≤ the per-mission cap, and
  at most 5 fix tickets a wave (P2-R10);
- `--max-turns` and `--timeout` are within `authorLimits` of the policy at the plan commit
  (P2-R20; 60 turns and 600 s without one);
- `--not-after` is `<n>h` or `<n>d`, at most 30 days. It is stored as epoch milliseconds rounded
  up to the hour, so the preview you read and the act you confirm agree.

The committer identity defaults to the OS user at `daylight.invalid`. It is recorded and labelled
asserted.

What it grants: within `notAfter`, while the plan and gate lock it names are current and the
campaign is not halted, the director process may create one implement mission per authorized
ticket with a **derived `authorize-mission`** (write; execute only if `--execute`; budget the lesser
of the ticket's and `--max-usd-per-mission`), admit High fix tickets within the fix lane, integrate
under WS-R6's rules, and halt. It never grants a person's act, a write to `main`, HEAD, the index or
the worktree, deploy, or a ticket outside the envelope.

A derived decision is an ordinary `authorize-mission` decision on the ticket mission, so R7 ("no
write without an authorize decision referencing its mission") holds literally. `recordDecision`
refuses every `campaign:` actor; only `recordDerivedDecision` writes one, after re-checking the
envelope against rows, and only `mission/store.ts`, `forge/campaign.ts` and `forge/integrate.ts`
may call it (the `derived-writer-callers` invariant). The check sees direct calls, `.bind`,
`.call`, `.apply` and a literal bracket key. It cannot see a computed key
(`store['recordDerived' + 'Decision']`) or a method reference taken without a call: a known limit,
outside ADR-37's threat model like raw SQL. Only `engine/test/forge-campaign-*.ts` is exempt, and
`tests-are-never-imported` keeps product code from calling into `engine/test/`. A forged derived grant is refused by
`startAttempt` and reported by `unauthorizedWriteAttempts` and `derivationRefusals`. An attempt
under a derived grant is refused once the authorization has expired or the campaign is halted.

A wave-review finding becomes a **proposed** fix ticket (`FIX.<wave>.<n>`, `fileFixTicket`), checked
and redacted like a proposal. The store admits it only inside the fix lane: the lane on, under the
per-wave cap, a scope no built-in set, policy glob, plan or status path protects, at
`fixLane.maxUsdPerTicket`; `derivationRefusals` reports any admission outside it. A fix or
follow-up ticket a person approves with `work-item approve` is admitted too. A derived
`integrate-candidate` needs `--auto-apply integration-ref` and names a real candidate at its diff.

A person may still `mission authorize` a campaign's ticket mission by hand.

## Assumptions

What a campaign proceeds on while a question waits for its owner. The director process writes
them; authors have no assumption tool (P2-R12).

- **Plan defaults.** One `open` row per `ownerDecisions` entry at import. `approve-plan` moves the
  non-blocking ones with a default to `pending`: a person approved that default with the plan.
  Blocking ones stay `open`, and every ticket whose `blocksOn` names one waits (`waiting-owner`).
- **Operator rows.** `assumption record` by a person. With a default it is `pending`; without, `open`.
- A row nobody human recorded is never `pending`. A database CHECK enforces it.

```
daylight assumption list <campaign> [--status open|pending|confirmed|overturned]
daylight assumption record <campaign> --question '…' --default '…' [--ticket T] --rationale '…' --confirm <digest8>
daylight assumption confirm  <u> --rationale '…' --confirm <digest8>                # pending → confirmed
daylight assumption decide   <u> --value '…' --rationale '…' --confirm <digest8>    # open → confirmed
daylight assumption overturn <u> --value '…' --follow-up '<statement>' [--lane L] [--scope a,b] --rationale '…' --confirm <digest8>
```

Every one is guarded. The digest covers the row's id, question, default, status and the value
decided. An overturn records the decision and creates exactly one **proposed** follow-up work item
and ticket (`FU.<n>`, origin `follow-up`, depending on the tickets the assumption held). A person
approves it with `work-item approve`. The fix lane's auto-admission is for High findings only.
Nothing that landed is reverted.

Needs: `assumption-pending` for each pending row, `owner-decision` for each open row, naming the
tickets it holds.

## retry

A ticket mission refused at preflight (a stale snapshot, an invalid policy, no sandbox) is closed
`inconclusive` by the director and never redispatched (P2-R23). Its work item stays consumed. To
build the ticket again:

```
daylight campaign retry <campaign> <ticket> --rationale '…' --confirm <digest8>
```

Guarded. Refused unless the ticket's mission is closed `inconclusive` or `cancelled`, ran no
attempt, applied nothing, and was refused at preflight. The `retry-ticket` decision names the
released mission and clears the work item's consumer. A new mission may then build it: the
one-mission-per-work-item checks exempt a mission a retry released (P2-R25, P2-R27).

## Which commands run in an agent session

A Claude session plans, briefs and reads a campaign. It never approves, authorizes, imports or
runs one (P2-R9). Under `CLAUDECODE` or `DAYLIGHT_SESSION`:

| Allowed (writes nothing) | Refused before anything is opened |
| --- | --- |
| `campaign show`, `campaign validate`, `campaign status` without `--write`, `campaign gate list`, `campaign run --dry-run`, `assumption list` | every other `campaign` subcommand (`import`, `approve-plan`, `authorize`, `retry`, and WS-R6's `run`, `baseline`, `lock`, `gate register`, `status --write`, `halt`, `resume`, `adopt-tip`), and `assumption record|confirm|decide|overturn` |

The check is at the CLI. The store never reads the environment. Like the decision guard, it is a
heuristic, not authentication: a session that imports the engine functions from `node -e` is
outside the threat model, like raw SQL against the database (ADR-37).

Campaign missions are never exported or imported, in either direction (P2-R14). A derived grant
never travels without the campaign it derives from.
