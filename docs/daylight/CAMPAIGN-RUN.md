# Running campaigns

How a campaign runs once its plan is approved and it is authorized (WS-R6). The plan file,
`approve-plan`, `authorize-campaign`, assumptions and `retry` are in docs/daylight/CAMPAIGN.md.

## Campaign gates and the lock

A campaign is judged by its own gates, registered on the campaign mission, never on a ticket
mission:

| Role | Where it comes from | At the campaign base | Required of |
|---|---|---|---|
| `regression` | `plan.campaignGates`, an ordinary R2 gate (`node` or `cargo`) | must pass | every ticket |
| `gate` | a ticket's `acceptance: { kind: 'gate' }` tests, read at the plan commit | must fail (or be accepted as vacuous by name) | that ticket |
| `holdout` | `campaign gate register --role holdout --file <host path> [--ticket T]`, never the plan | must fail (or vacuous) | its ticket; an unbound one only through the ratchet |
| `acceptance` | a `writer-authored` ticket's own tests, from its candidate | not baselined, never locked | its own candidate only |

```
daylight campaign gate register <c> --role holdout --file <host path> [--ticket T] --expect-exit 0 --expect-stdout '# fail 0'
daylight campaign gate list <c>
daylight campaign baseline <c> <repo>
daylight campaign lock <c> --ratchet|--no-ratchet --rationale '…' [--accept-vacuous x_…] --confirm <digest8>
```

`baseline` registers the plan's regression gates and ticket gates idempotently (same subject,
bytes and expectation: not registered twice) and runs every gate at the campaign base, twice.
`lock` is a guarded human act. Its digest covers each gate's harness digest, its role, the
ticket it is bound to, and the ratchet flag; a binding lives in the gate's subject
(`ticket:<id>`) and never changes after registration. Re-binding a holdout is a new gate and a
new lock, and a new lock invalidates the authorization, which names its digest
(`campaign authorize --expected-gate-set`).

With `--ratchet`, a gate or holdout that passed when the current tip landed becomes required of
every later ticket, and a public one appears in later authors' briefs. Without it, nothing
becomes required that the lock did not bind (P2-R17).

## Running a campaign

```
daylight campaign run <c> <repo> [--concurrency N] [--max-waves K] [--dry-run]
```

Started by a person from a terminal: under `CLAUDECODE` or `DAYLIGHT_SESSION` it is refused
unless `--dry-run` (P2-R9, P2-R24). A dry run writes no row, no event and no ref; it prints each
ticket's status and what the first pass would dispatch with each reservation. In a person's
shell any spelling (`--dry-run`, `--dry-run=true`, `--dry-run=1`) is a dry run.

A real run is refused, before anything starts, when the authorization is missing, expired or
halted, when the lock it names is stale (recomputed against the gates as they are now), when
WS-R5 says the plan or policy it names moved, or when `--concurrency` is above the envelope's.
Exit 0 when quiescent (every ticket landed, blocked, or waiting on a person), 1 on a refusal or
a halt.

Each pass derives every ticket's status from rows (never stored): `superseded`, `waiting-owner`,
`waiting` (a dependency has not landed), `ready`, `running`, `integrating`, `waiting-dependency`
(its author asked for a dependency; the ticket is parked and the loop goes on), `landed`
(integrated and reachable from the integration ref), `blocked`. Ready tickets are dispatched in
plan order, round-robin across lanes, within the concurrency and each lane's `maxParallel`
(the FIX lane: one at a time). A plan ticket runs when the authorization names it; a generated one
(a fix or a follow-up) when WS-R5 says its work item was admitted, by the envelope or by a person.
Every attempt starts from the current integration tip, not the ticket mission's first base,
which keeps conflicts small. If WS-R5 refuses a ticket's grant, that ticket is blocked for the
run and the others go on.

Spend is reserved before every launch, wave reviewers included: the attempt's ceiling,
`min(the mission's remaining budget, the campaign's remaining cap)`, is handed to the runner and
stored on `attempts.max_cost_usd` (P2-R18, P2-R35). A launch that would pass the cap waits for a
running attempt to free its reservation; with nothing running, the campaign halts `spend-cap`.
An attempt that completes with its cost unknown halts the campaign `spend-unknown` as it ends
(P2-R11): an unknown is never charged at the cap and never summed as zero, and that attempt's
candidate never lands, before or after a person resumes. A resume answers the halt for the
unknowns it saw; only a later one halts again. An attempt that ends unfinished (cancelled,
crashed, killed with the director) and reported nothing is charged at its reservation
(`cost_source = 'reservation'`, P2-R44): counted against the cap and listed apart, not against
the ticket's own budget, so a crash neither hides spend nor wedges the campaign.
Spend past the cap halts `spend-breach`. Every pass re-checks both before anything is
integrated, so a resume never lands the candidate whose spend halted the campaign while that
spend still breaks the rule; raising the cap takes a new authorization. A ticket that has used its own budget
(`min(ticket.maxUsd, maxUsdPerMission)`) is blocked with a need; that never halts the campaign.

While a campaign is halted or stopped nothing is dispatched, integrated or reviewed. A candidate
already accepted when a halt arrives stays accepted; its integration is abandoned, and once a
person resumes the campaign (or adopts a moved tip) it is integrated again onto the tip and
re-evaluated there, without a new attempt.

A run whose environment cannot run an author (a roster entry with no author, or no sandbox) is
refused before anything is dispatched, in one line, and closes no ticket. A ready ticket whose
mission is refused at its own preflight (a stale crate snapshot, an invalid policy, a grant
without write) is closed `inconclusive` with the refusal as its reason, once, and
raises a `blocked` need: it is never redispatched (P2-R23). A person retries it with
`campaign retry`.

## Integration

Every accepted candidate lands on `refs/heads/daylight/campaign/<id>`, created at the campaign
base on the first run. Nothing else is written: not `main`, not HEAD, not the index or the
working tree, and no hook runs. A person merges the integration ref themselves (`campaign
status` prints the `git merge --ff-only` it would take).

Rebase by plumbing, in a scratch bare repository with an empty config and the real object store
as an alternate:

- a candidate built on the current tip is applied (`apply`): its integrated diff must be its
  own diff, byte for byte;
- one built on an older tip is committed on its own base and merged with `git merge-tree
  --write-tree --merge-base=<its base> <tip> <it>` (`three-way`), with no attribute source, so no
  merge driver a tree names can run;
- a conflict writes nothing to the real repository and becomes the candidate's
  `rebase-conflict`, with the conflicted paths.

The result is checked (files only, no symlink or gitlink, a size cap), committed with the
campaign trailers (`Daylight-Campaign`, `Daylight-Ticket`, `Daylight-Integration: i_… onto
<tip12> (apply|three-way)`, `Daylight-Decision`; ids only, no dollars), and rebuilt in the real
object store blob by blob, each object checked to be the one the scratch verified. The commit's
identity is the envelope's, labelled asserted.

Every required check then runs on a fresh tree of the integrated commit, holdouts' paths
refused in it, and is recorded as an `integrated` evaluation naming the integration, its commit
and the tip → commit digest: exactly what would land. The verdict is `campaignVerdict`, a pure
function of rows: no-diff, policy-violation, rebase-conflict, gates-invalid, gates-inconclusive,
accepted-by-gates, rejected-by-gates. There is no `stale-base`: a moved tip is integrated, not
refused. Holdouts are counted, never named.

An accepted candidate lands in this order: the per-mission ref
`refs/heads/daylight/<mission>` (create-only); the integration ref, moved by compare-and-swap
from the tip the candidate was put onto; then one `BEGIN IMMEDIATE` holding WS-R5's envelope
check, the derived `integrate-candidate` decision on the ticket mission, the application
(`appliedBy = campaign:<id>`, base = the tip) and the integration's move to `integrated`
(P2-R22). Nothing lands that is not `accepted-by-gates` on that integration's own tree against
the current lock, whoever calls (P2-R35). A ref that moved underneath refuses the landing and the
candidate is integrated again onto the new tip; a store refusal puts both refs back by
compare-and-swap. A diff that cannot be integrated at all (a mode, a size, a digest, git itself)
becomes the candidate's `gates-invalid` verdict and blocks the ticket. The ticket mission
then closes `succeeded` (ADR-23) and its dependents become ready.

## Repair

A candidate that is `rejected-by-gates`, `gates-inconclusive`, `rebase-conflict` or a
`policy-violation`, or an attempt that left nothing capturable, is repaired while attempts
remain (`min(ticket.maxAttempts, envelope.maxAttemptsPerTicket)`). The next attempt's prompt
carries a repair brief, fenced as data after the protected list and before the work: which
public checks failed with the tail of their output (redacted, at most 8 KiB each, 24 KiB in all),
how many holdouts failed (a number, never an id, path or output), the conflicted paths, the
violated policy rules, and the author's own prior diff (redacted, at most 64 KiB). Exhausted, the
ticket mission goes `blocked` with a `blocked` need; its dependents stay `waiting` and other
lanes carry on. `gates-inconclusive` is repaired once; a second one blocks, because then the
check is unsure, not the change. A `gates-invalid` or `no-diff` candidate blocks at once: another
attempt would not cure it.

## Wave review and the fix lane

A wave closes every `waveSize` landings, and at quiescence with at least one landing since the
last. With a non-empty `reviewRoster`, its review is an `audit` mission under the campaign: one
blind reviewer per roster entry, under the `review` profile with no network and no write, over a
materialised tree of the wave's last commit (not the checkout). A reviewer's one tool is
`report_finding`, which reads nothing back; findings are re-validated and redacted on the host
(a path the wave changed, a severity, a one-line title, at most 4 KiB of statement), recorded
once each, and marked corroborated when another reviewer filed the same path and title. Review
runs alongside dispatch. It is reserved like an attempt: checked against the cap and any halt
before it starts, its audit mission's budget is `maxUsdPerMission` within what the cap leaves,
and each reviewer records its share on `attempts.max_cost_usd`. A wave whose review never ran or
was cut off by a crash is reviewed by the next run.

Each finding becomes one proposed fix ticket, filed by WS-R5 (`FIX.<wave>.<n>`, lane `FIX`, scope
the finding's path, the plan's default acceptance). WS-R5's envelope admits a High one only, at most
`fixLane.maxTicketsPerWave` (≤ 5) a wave (P2-R10); anything else waits for a person. A finding
never changes a verdict or a landed commit (ADR-19): it only creates work that passes the same
gates, and a reviewer's text reaches the fix author fenced, redacted and capped.

`reviewRoster: []` turns wave review off; waves are still recorded and everything else runs.

## Resume

The director holds no state of its own. A run that was killed is resumed by running it again:

| Found | Ref | Then |
|---|---|---|
| an attempt still `running` | — | cancelled as orphaned, charged at its reservation; counts as a failed attempt |
| a candidate with no integration | — | integrated |
| an integration `pending`, or `evaluating` with the ref at the tip it was put onto | ref = tip | abandoned and integrated again |
| an integration `evaluating` | ref = its commit | its digest re-verified, the landing transaction finished |
| an integration `integrated` with no application | the ref contains its commit | the application recorded |
| a per-mission ref with no application | — | deleted if it names a commit nothing recorded |
| the integration ref somewhere no row explains | — | halted `integration-moved`; a person runs `campaign adopt-tip` |

```
daylight campaign halt <c> --rationale '…'
daylight campaign resume <c> --halt <d> --rationale '…' --confirm <digest8>
daylight campaign adopt-tip <c> <repo> --halt <d> --rationale '…' --confirm <digest8>
```

`adopt-tip` is a guarded human act: it records the ref, the commit the rows explain, the commit
the ref is at, and the halt it answers, so the commits a person pushed are explained again. It
is refused when the move did not only add commits on top of what the rows explain: a ref
rewritten under a landing would drop that landing, so it is never adopted.

## Status

```
daylight campaign status <c> [<repo>] [--write]
```

Derived from rows and the integration ref on every call: tickets by lane and status, the tip and
how many landed, the authorization and any halt, assumptions pending the owner, needs, spend as
`≥ $X (N unknown; $R charged at reservation for K unfinished attempt(s))` when anything is
unknown or charged at a reservation, and each wave's findings. `--write` puts STATUS.md
under `<out>/campaigns/<id>/`; nothing is ever written into the target repository (P2-R13).

## Events

`campaign.started`, `.resumed`, `.finished`, `.integration.*`, `.gate.evaluated`,
`.candidate.integrated`, `.wave.closed`, `.finding.recorded`, `.spend.*` and `.ticket.landed`,
`.blocked` and `.parked` go on the campaign mission; `campaign.ticket.dispatched`,
`campaign.mission.authorized` and `campaign.repair.queued` on the ticket mission (§4.8). A
derived STATUS file is the plan's `statusPath`, protected for authors when `derivedStatus` is set.
