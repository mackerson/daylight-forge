# Refine: the wave report, the campaign list and `campaign refine`

The REFINE stage is where a person reads what a campaign did before anything reaches `main`.
The integration ref is untrusted until then (P2-R43): the director lands on
`refs/heads/daylight/campaign/<id>`, and a person merges it. Everything on this page is derived
from rows and refs on read and never stored as a source of truth. Holdouts are counts: no
experiment id, path or basename of a holdout appears in any output here (P2-R37). Free text echoed
from plans, work items, reviewers and close reasons is redacted too: any holdout path, basename or
id in it reads `[holdout]` (the report, the list and refine).

## The wave report

```
daylight campaign report <c> [<repo>] [--wave <n> | --open | --all] [--format json|md] [--write]
```

- **Scope.** `--wave n` is the landings of closed wave n (`fromCommit..toCommit`); `--open` is
  the landings since the last closed wave; `--all` is `base..tip`. The default is the latest
  closed wave, else `--open`.
- **Landed.** Every integrated landing in the range, in row order, with its ticket, lane, commit,
  method, attempts, acceptance kind (vacuous acceptance flagged) and git's own
  `--numstat --no-renames` counts; a binary file counts as a file, never as lines.
- **Assumptions waiting on you.** Open and pending ones, with their defaults, the tickets they
  hold and the landed tickets that proceeded on them (what an overturn would not revert).
- **Review and findings.** Per wave: off, not run, running or done, the reviewers and the counts by
  severity. Findings are most severe first, each with its fix ticket, the fix's status and who
  admitted it (`derived`: the envelope; `person`: an approval). A finding's title is labelled
  reviewer-claimed; its statement is in the JSON only, never in the markdown (P2-R40).
- **Spend.** `campaignSpend` unchanged, and lines per ticket, lane, wave, review and scope over
  attempt rows. Lanes and reviews close: Σ lanes + Σ reviews equals the campaign on spent, known,
  unknown, scanned and running. Scanned dollars and reservation charges (P2-R44) are shown beside
  the known figure, never inside it; unknown spend is a count and reads `unknown` or `≥ $X (N
  unknown)`, never `$0.00`; a line with nothing known keeps the floor (`≥ unknown (…)`). The campaign
  line (and STATUS.md's) leads with `spentUsd`, what counts against the cap, then the breakdown.
- **Blocked.** Every blocked, waiting-dependency or waiting-owner ticket with its reason verbatim
  and the act it needs: `retry` (closed at preflight), `resolve-dependency`, `owner-decision`,
  `approve-work-item`, `authorize` or `read`.
- **Forgery-shaped candidates (heuristic).** Candidates that carried a `gate-forgery-shape`
  warning (P2-R43): a warning that parks the candidate with a `forgery-shape-review` need until a
  person acknowledges or rejects it (P2-R49). Counted by class (`stdout-fd-write`,
  `test-summary-literal`, `process-exit`, else `unclassified`) and listed by ticket, candidate
  and path, from the shape names capture records in the candidate summary; no text of the diff is
  ever read back or shown. `forge candidate --format json` and the `confirm approve-candidate` /
  `override-candidate` preview carry the same per-candidate `forgeryShapes` (counts by class, each
  path's classes).
- **Status.** kitkraft's table: `done`, `in-progress`, `blocked` (with `regressed`), `requests`
  (waiting on a person), and `queued` and `superseded`, counted and never hidden. `campaign
  status` and STATUS.md show the same table.

The same rows print the same bytes: there is no timestamp. `--write` writes
`<out>/campaigns/<c>/reports/{wave-<n>|open-<tip12>|all-<tip12>}.{json,md}` and nothing else;
never the target repository, a commit or a trailer.

## The campaign list

```
daylight campaign list [<repo>] [--format json]
```

One row per campaign, newest first: plan and approval, authorization (its refusal verbatim),
halt (with `authorization.haltDecisionId`, as `campaign status` has it, for resume and
adopt-tip), the six-bucket counts, needs, assumptions, spend, the integration tip, and the run claim.
A run claim is `<out>/mission-run.<id>.pid`: read, checked with `kill(pid, 0)`, never written or
signalled; a dead pid reads as a claim left behind. `runHint` is the command a person runs from
a terminal. When the project root is not on this machine, statuses are not derived and the row
says so.

## `campaign refine`

```
daylight campaign refine <c> [<repo>] [--rev <sha>] [--format json]   # maps base and tip if not cached; writes refine.json
daylight campaign refine <c> [<repo>] --rows-only [--format json]     # no map: the rows' focus tiers only
daylight campaign refine <c> [<repo>] --cached [--format json]        # reads refine.json; stale when the tip moved since, or a map's cache key changed
```

- **The map at a revision.** Each of the base and the revision (default: the integration tip) is
  materialised with `createWorkspace`, the campaign's locked holdouts hidden, never the checkout.
  A committed locked holdout refuses the whole refine with a message that names no path. The tree
  is walked, not listed by git, and mapped with no git run in it (duplication, parallel shapes,
  structure with churn off, invariants from the tree's own `daylight.invariants.json`;
  `detectCommunities` is not run, nothing reads its output for a refine map) and written to `<out>/campaigns/<c>/maps/<sha>/`: `graph.json`
  (stamped with the repository and the sha), `view.json`, `focus.json`, `findings.json`,
  `structure.json`, `invariants.json` and `map.json`. `map.json` is the cache key: the sha, the
  parser set and `MAP_FORMAT`. There is no claims database, no symbol index and no layout file:
  a refine map has no agents, and the Refine view is read-only. `try-invariant <repo> --out
  <map dir>` evaluates a predicate against the tip without re-extracting.
- **Compared.** Duplicated families, dead ends and orphan clusters, and cycles are introduced,
  resolved or persisting between base and revision; `touched` means a member's file is in the
  campaign's diff. Invariants are green, red or absent on each side; a regression is red now and
  not red at the base.
- **Changed.** Each file in `base..rev` with its counts and the landed tickets whose integration
  touched it.
- **Overlays.** Files per overlay for the Refine view: `assumption`, `finding`, `forgery`,
  `blocked`, `untested` and `introduced`.

### Focus rules

`FOCUS_RULES` (`engine/forge/refine-focus.ts`) is data, echoed in every report; `rankFocus` only
filters by each rule's `where` and sorts by tier, then by the rule's `order`. Tiers (P2-R47):

| tier | kind | when | first |
|---|---|---|---|
| 0 | assumption | open or pending | blocking, then open, most held tickets, most landed on it |
| 1 | finding | High, its fix not landed | most corroborated, no fix before a fix in flight |
| 2 | forgery-shape | landed ticket with a forgery-shaped candidate | most such candidates, most lines |
| 3 | blocked-ticket | blocked, waiting on a dependency or the owner | most transitive dependents |
| 4 | untested-diff | landed with `ci-only` acceptance or vacuous acceptance | most lines, most files |
| 5 | introduced | a finding introduced and touched, or an invariant regressed (maps only) | invariant regressions first |

An item that matches no rule is dropped.

## What runs in an agent session

Under `CLAUDECODE` or `DAYLIGHT_SESSION`: `campaign list`, `campaign report` without `--write`,
and `campaign refine` in every form run; refine writes only derived files under `<out>` (the map
directories, the shared parse cache `<out>/.cache` and `refine.json`), no row and no ref
(P2-R40). `campaign report --write` is refused there, like `status --write`. `daylight confirm`
prints the digest of every campaign and assumption act, with `refusal` set in an agent session;
the act itself is refused there (P2-R45). `campaign run` is never started by the GUI (ADR-40).
