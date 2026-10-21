# Spec ingestion

A specification corpus becomes a plan in human-approved steps. Agents propose at every step;
every proposal is a line in an outbox the host re-validates; every `approved` is a person's
decision naming content digests (ADR-14, ADR-42, ADR-43). Staleness is derived, never written
(P2-R53).

```
corpus → section index → IR (proposed) → blind IR review → approve-ir [person]
  → blueprint → approve-blueprint [person] → packets → plan v2 emitted under <out>
  → a person commits it → campaign import (descent checked) → approve-plan [person]
  → campaign lock (+ obligations) → campaign authorize [person]
```

The corpus, sectioner, extraction and coverage sections are WS-R14's; traceability and the
benchmark are WS-R16's. This page holds WS-R15's half: review, approval, blueprint, packets, the
version-2 plan, author context, obligations, and the authority chain.

## Independent IR review

```
daylight corpus review <corpus> <repo> --tools a,b [--blueprint bp_…] [--timeout s]
```

An `audit` mission under the corpus runs one blind reviewer per (window, tool) over the windows
extraction ran over, at least two distinct tools (`mock,mock:b` counts as two). Each reviewer sees
the window's text and the records spanned in it (never how many extractors observed one) and, with
`--blueprint`, the elements deriving from them. Its one tool, `report_ir_finding`, files:
`omission`, `contradiction`, `invented-requirement`, `wrong-dependency`, `infeasible-boundary`,
`wrong-kind`, `wrong-span`, `ambiguity`. A quote must occur exactly once in the section it names; a
secret-shaped quote is refused, never masked. Findings are recorded `open`. Two reviewers saying the
same thing (kind, record or span, title) are listed in each other's `corroboratedBy`: shown, never
decisive.

## approve-ir

```
daylight corpus approve-ir <corpus> (--set <file.json> | --approve ir_…,… --reject … --accept rf_… --dismiss rf_… | --section <id> [--kind k])
        --rationale '…' --confirm <digest8>
```

One guarded human decision (ADR-20). The scope names every record it approves or rejects at
`<id>:<contentDigest>`, every superseded record and its replacement, every finding it accepts or
dismisses, the corrections it adds, and the digest of the approved set after the act
(`irSetDigest`, over the approved records current at the revision). Without `--confirm` it prints
that, with per-section counts (approve, reject, single-extractor, statement-differs) and never a
statement.

Refused whole, every reason at once, ids only:

- a record that is not `proposed` here (an approved record is carried, never re-approved);
- an extracted record with no span at the current revision;
- an inferred record with neither basis sections nor a confirmed interpretation; the refusal opens
  the interpretation (`OIR.…`), a person decides it with `assumption decide`, then approves;
- an approved record with an accepted finding, or an open one the act does not dispose;
- accepting a finding against an approved record without rejecting or superseding it;
- a supersede whose new record the act does not approve; a set at another revision.

There is no flag that selects by agreement; any flag but those above is refused.

**Interpretations.** An approved `ambiguity` or `contradiction`, or an accepted
`invented-requirement`, `ambiguity` or `contradiction` finding on a record still standing, opens
one `ir-interpretation` assumption on the corpus: `open`, blocking, owner decision
`OIR.<ten hex of the id>`, no default. It never picks a reading. Rejecting or superseding the record
later overturns its open interpretation under that act's decision. Interpretations are written
after the decision commits; every `approve-ir` first writes any an earlier act left unwritten
(`repairInterpretations`, idempotent).

## Blueprint

```
daylight corpus blueprint import <corpus> --file <host path>
daylight corpus blueprint propose <corpus> <repo> --tools a
daylight corpus blueprint validate|show <bp> [--invariant-tags a,b]
daylight corpus approve-blueprint <bp> [--invariant-tags a,b] --rationale '…' --confirm <digest8>
```

A `daylight-blueprint` version 1: boundaries (in-repo, separate-repo, external; the records they
rest on and the invariants they carry), components (a plan lane each; whole sections and named
records; owned prefixes; dependencies; interfaces provided and consumed), interfaces, the build
order, constraints, deferred and out-of-scope records, and the ticket id template. Checked all at
once:

| rule | what it refuses |
|---|---|
| `unassigned`, `duplicate-assignment` | an approved, current, in-scope requirement, invariant, constraint, interface, acceptance condition or dependency placed by no element, or by two |
| `ir-not-approved`, `ir-stale`, `ir-overridden` | a cited record not approved, with no span now, or overridden and placed without its overrider |
| `owns-outside-boundary`, `owns-overlap`, `external-owns`, `bounds-empty` | ownership outside its boundary or shared without both saying so; an external boundary owning anything; an in-repo boundary resting on nothing |
| `unknown-component`, `cycle`, `order` | an unknown boundary, component or interface; a dependency cycle; an order that is not the Kahn layers |
| `interface-owner`, `interface-unreachable`, `boundary-crossing` | an interface its owner does not provide; consumed without depending on its owner; a dependency across boundaries not through a crossing interface |
| `invariant-unplaced` | a tag from `--invariant-tags` (a project input; there is no built-in list) carried by approved records none of which sits on a boundary or is deferred |
| `ticket-template`, `digest` | a template that does not yield plan ticket ids; a revision the corpus never had, or an IR set that is not the current one |

`approve-blueprint` is refused unless the blueprint is proposed, drawn over the current approved
IR set and breaks no rule; it supersedes the corpus's previous blueprint and writes the derivation
(which element rests on which record, in which role) in its transaction.

## Work packets and the version-2 plan

```
daylight corpus packets import <bp> --file <host path>     # { kind: daylight-packets, version: 1, packets: [...] }
daylight corpus packets propose <bp> <repo> --tools a
daylight corpus packets emit <bp>
daylight corpus packets list <bp>
daylight corpus packets context <campaign> <ticket>        # counts only
```

A packet is one ticket of one component: `requirementIds`, `interfaceContracts`, `artifacts`,
`acceptanceObligations` (each citing acceptance-condition, requirement or invariant records),
prerequisites and integration dependencies along the component order, and `blocksOn` naming
recorded interpretations. Its digest is the digest of the plan ticket it becomes,
`ticketDigestOf(packetToPlanTicket(p, { context: true }), undefined)`; its id is `pk_` over
(blueprint, ticket, digest). A set is refused when an assigned requirement is in no packet of its
component.

`emit` writes `<out>/corpus/<corpus>/plan.<set8>.json`, never the repository (P2-R13): version 2,
lanes from components, every `OIR.*` the tickets block on declared as a blocking owner decision,
each ticket naming its packet, and a `derivation` with the corpus, IR set, blueprint and packet-set
digests. It must parse and validate at the corpus commit.

**One plan type.** `PlanFile.version` is 1 or 2. A version-1 file is read exactly as before, and a
version-2 key on it is refused. The trace fields enter `ticketDigestOf` only when present, so every
version-1 ticket digests as it did.

**Commit, import.** A person copies the emitted file into the repository and commits it;
`campaign import` runs as before and, for a plan with a `derivation`, also refuses (rule
`derivation`) a corpus, blueprint, IR set, cited record, packet or packet-set digest that does not
hold; flags a ticket whose digest is no longer its packet's as `hand_edited` (imported, shown);
writes `ticket_trace` in the import transaction; and creates no plan-default assumption for an
`OIR.*` id that resolves to its interpretation, so one decision unblocks the record and the ticket.

## Author context and obligations

A traced ticket's author sees the passages it implements fenced as `SPEC-CONTEXT` after the work:
each cited record's quote, re-read at the plan's revision and checked against its digest (a
mismatch refuses the run), at most 16 KiB, never the whole specification. A quote containing the
basename of any of the campaign's holdouts, or looking like a secret, is withheld and counted; the
author is told only how many.

Obligations bind at `campaign lock`: experiment → `<ticket>:ob<n>`, inside the gate-set digest; a
gate discharges only its own ticket's obligations, a regression gate or holdout any. `campaign
authorize` refuses a ticket set with an obligation no locked gate discharges unless each is named
in `--unbound-obligations T:ob1,…`, which the envelope records (P2-R50 F3). A writer-authored test
never discharges one.

## Authority and invalidation

```
daylight corpus revise <corpus> <repo> [--rev HEAD] [--project alias=<repo>[@rev]]… [--manifest …]
daylight corpus diff <corpus> --from cr_… --to cr_…
```

`revise` adds the next revision and, for each record neither rejected nor superseded, at most one
span row per role at the new revision:

| at the new revision | status | row |
|---|---|---|
| the quote at the same bytes in the same section | `carried` | added |
| … but the section gained or lost a scored unit, or an overriding record's section changed | `review` | added (need `spec-review`) |
| the quote occurring exactly once anywhere in the same document | `moved` (`section-changed` when the section differs: a split or renamed section keeps its record) | added |
| anything else (missing, ambiguous, section removed) | `stale` | none |

No existing row of any table changes. Everything downstream is stale by reading: a blueprint whose
IR set moved or that cites a stale record, its packets, the tickets tracing to stale records (the
director derives `TicketStatus 'stale'`), gates whose obligations cite them (`gate-stale`), a
landed ticket's evidence (`evidence-stale`), interpretations of them (`spec-stale`). Recovery is a
person's: extract the changed sections, `approve-ir` with `supersede`, approve a new blueprint,
emit, commit, import, `approve-plan`.

**The chain.** `authorityChainOf` re-derives corpus → section index → IR set → blueprint → packets →
plan digest → envelope from rows and artifacts. `campaign authorize` refuses a broken chain, and
`campaignAuthorizationRefusal` re-checks it on every director pass: a packet re-pointed in the rows
while the plan digest stays put stops the campaign. The `ir` link also breaks when the specification
moved under the plan (P2-R59): the current approved IR set is not the derivation's, or a cited record,
the blueprint or an authorized ticket is stale; the refusal names them. A person may proceed with
`campaign authorize --accept-ir-drift <current digest>`, recorded in the envelope and its confirm
digest; any further drift breaks the link again. A traced ticket's own title, statement lines and
examples that name a holdout basename are withheld from the author too, and counted.

## Agent sessions

Read-only forms run anywhere: `corpus diff`, `blueprint validate|show`, `packets list|context`,
and a guarded act's preview (no `--confirm`). `review` and the `propose` forms run in an agent
session only when every tool is a mock (P2-R50 Q5). Everything else writes rows or files and is a
person's, from their own shell.
