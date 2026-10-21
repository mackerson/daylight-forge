# Specification ingestion

A plan used to have to fit one prompt: one Markdown spec of at most 64 KiB (`spec decompose`).
Ingestion reads a whole specification **corpus** instead: a primary spec, its errata, its
decision records, related documents, and other products' specs it depends on. It turns them into
**Spec IR** records a person approves, and from those a blueprint, work packets and a version-2
plan.

This page covers the WS-R14 half: the corpus, the sectioner, IR extraction and coverage. Review,
`approve-ir`, blueprints, packets, plan v2 and the authority chain are WS-R15's; traceability and
the benchmark are WS-R16's. Decisions: ADR-41 to ADR-44 in [FORGE_PLAN](FORGE_PLAN.md).

```
manifest → corpus revision (corpusDigest) → section index (sectionSetDigest, configDigest)
  → windows × ≥ 2 blind extractors → IR records, proposed → coverage (derived)
  → [WS-R15] review → approve-ir (human) → blueprint → packets → plan v2 → campaign
```

Every agent arrow is a proposal in an outbox, re-validated on the host. Nothing here approves
anything, and nothing is written into the repository (P2-R13).

## The corpus

A corpus is described by a manifest, `daylight.corpus.json`, committed in the repository and read
from git's object store at a commit, never from the working tree.

```json
{ "kind": "daylight-corpus", "version": 1, "title": "Widget service v2",
  "docs": [
    { "key": "spec", "path": "docs/spec.md", "role": "primary", "domain": "widgets" },
    { "key": "errata", "path": "docs/errata.md", "role": "errata", "domain": "widgets" },
    { "key": "adr", "dir": "docs/adr", "role": "decision", "domain": "widgets" },
    { "key": "billing", "path": "spec/billing.md", "role": "primary", "domain": "billing", "project": "billing" } ],
  "precedence": [
    { "over": "errata", "under": "spec", "basis": { "doc": "spec", "quote": "the errata governs" } },
    { "over": "role:decision@widgets", "under": "spec" } ],
  "dependencies": [
    { "from": "billing", "on": "widgets", "kinds": ["interface"], "basis": { "doc": "billing", "quote": "Widget ids are defined by the widget service" } } ],
  "excluded": [ { "path": "plan/ground-truth.md", "reason": "not a specification" } ],
  "sectioner": { "$ref": "sectioner.json" } }
```

- **Documents.** `path` names one Markdown file; `dir` names every `*.md` directly under a
  directory, keyed `<key>-<leading digits or slug>` (`adr-0004`). Each is a regular blob at the
  commit, UTF-8, no NUL, at most 2 MiB; the corpus is at most 64 documents and 8 MiB. **A document
  with a CR byte is refused**, so a byte offset in an artifact and in the text are the same thing.
- **Roles and domains.** `primary`, `errata`, `decision`, `related`. A domain is one product's
  documents and needs a primary.
- **Precedence** orders documents of one domain: an endpoint is a document key or
  `role:<role>@<domain>`. It never crosses domains and must be acyclic. Its `basis` is the sentence
  that says so, which must occur exactly once in the named document; it is recorded as a span.
  Authority documents (primary, errata, decision) with no order between them are recorded as
  **unordered**: a conflict between them stays open for a person (P2-R51).
- **Dependencies** say one domain's records cite another's (`from` cites `on`) and never override
  them (O-a). A contradiction across domains is always open, marked `declaredDependency`.
- **Other repositories.** A document with `project: <alias>` is read from the repository bound
  with `--project <alias>=<repo>[@rev]`, at its own commit (`@` splits only when the suffix is a
  revision and the prefix a directory). Every alias must be bound and every bound alias used. A
  bound repository is resolved by its git identity (`identifyProject`), not required to be mapped:
  an output directory maps one repository, so the contract's `requireMappedRepo` cannot hold for a
  second one (an accepted deviation; binding is a person's act, refused in agent sessions). Only
  documents in the corpus's own repository are protected from authors.
- A leading UTF-8 BOM is kept in the registered bytes and skipped by the sectioner.
- **Excluded** paths are recorded, not read.

`corpus register` refuses the whole manifest, before any row is written, for every rule it breaks;
a refusal names a JSON path and a rule, never the manifest's text. It creates one mission of kind
`corpus` (never executes, no parent; its only child is an IR review audit), revision `seq 1`, one
`spec` artifact per document, the section index and the effective sectioner config as artifacts,
and a `corpus.registered` event. `corpusOf` re-reads and re-verifies every document and the index
on each use. Corpus missions are never exported or imported.

**Revisions.** Given a corpus id (as WS-R15's `corpus revise` does), registration adds the next
revision (`seq + 1`) to that corpus mission instead of creating one, or returns the current one
when the documents are unchanged. A manifest is incompatible with the corpus, and refused, when a
document key present in both changes its role or domain, or a domain of the current revision is
left without a primary document. A change to the sectioner config alone is refused there (the
corpus digest, which names a revision, is the documents').


## The sectioner

Pure and deterministic: the same bytes and config give the same section ids, byte spans and
digests. No LLM.

- **Sections.** Every ATX heading outside fenced code, with GitHub's slugs and duplicate suffixes.
  A section's id is `<docKey>:<slug path>` (`spec:part-ii/6-keep-public-content-separate`); its
  `start`/`end` run from its heading to the next heading of the same or a higher level; its body
  is the text between its heading and the first heading after it. A synthetic level-0 root holds
  what comes before the first heading. Ids survive edits inside bodies.
- **Flags**, inherited by every descendant: `informative` (title or first line says
  informative/example/history…), `withdrawn`, `openDecision` (open decision, open question…).
- **Labels** (`§11.2A`, `ADR 4`, `E9`, `Clause 7`) come from `labels` rules on heading text.
- **Units.** List items, table rows (not the header), standalone lines and prose sentences, with
  fenced blocks excluded (and listed by `corpus show`).
- **Scores.** The largest matching cue weight (defaults: `must|shall|never|required|refuse|forbid`
  0.9, `only|cannot|may not|always|no <noun>` 0.7, `should` 0.45); a unit-initial
  `Every|Each|All` + noun 0.5 (0.45 with `can`/`may`); a unit-initial imperative verb 0.5; the
  **rule-list** base 0.5 for list items and table rows of a section whose title is a rule section,
  or after a scored lead ending `:`; the **lead-continuation** base 0.5 for the one line right
  after such a lead; then +0.2 for a leading bold sentence (`**X.**`), capped at 1. Informative
  ×0.4, withdrawn 0. A lead's hedges flow to the list under it. A unit scoring at or above
  `threshold` (default 0.5) is **normative**: it must be mapped by a record or listed unmapped.
- **Cross-references** come from `xrefs` patterns (`§a–b` expands to each section). They resolve
  by label in the citing document, then the domain's primary, then the domain (`doc`, `domain` or
  `any` scope). Found only in another domain → `other-domain`; a reference after a version token
  the domain does not carry (`v0.7 §5`) → `other-version`; nowhere → `no-such-label`; two at the
  same distance → `ambiguous`. The link (`supersedes`, `implements`, `amends`, `resolves`) is read
  from the clause before it.

### Configuration is data

Every word list and pattern above is `SectionerConfig` data (P2-R52): Daylight's code names no
project. The defaults are RFC-2119 modals, generic imperatives and keywords, and `§n`/`ADR n`
labels. A manifest's `sectioner` (inline, or a repo-relative JSON `$ref` read at the same commit)
is merged over them key by key; a list given replaces the default list. `domains` overrides the
milestone scheme and tag vocabulary per domain (P2-R54). Patterns are compiled at registration and
refused if they do not compile; a non-built-in reference kind must be listed in `xrefKinds`. The
config's digest enters the section-set digest and the IR version: a config change is a new index.

The OLC fixture's config (`engine/test/fixtures/ingest/olc-config/sectioner.olc.json`) adds errata
`E<n>`, plate, ticket and Foundry `F<n>` labels and references, the `defaults` hedge, and per-domain
milestones `^M\d+$` (OLC) and `^F\d+$` (Foundry).

### Windows

Section bodies are packed greedily in document order, one document per window, up to 16 KiB; a
body over 40 KiB gets windows of its own, split at blank lines (or, for one paragraph, at unit
starts). Every body lands in exactly one window (checked). A window also carries **linked**
sections (resolved reference targets elsewhere, other documents first, ≤ 12 KiB) and its ancestors'
titles. Measured: OLC spec v0.8 (89 KB) packs into 6 windows.

## Spec IR and extraction

```
daylight corpus extract <corpus> <repo> --tools a,b [--windows win1,…] [--force] [--timeout s]
```

A (window, tool) already extracted is skipped and counted (`N extracted, M skipped`); `--force`
re-extracts it under a fresh task with the same window and tool, so the IR version is unchanged and
a re-read of the same words is another observation. The counts are this run's.

At least two distinct extractors (`mock,mock:b` counts as two). One task per (window, tool),
role `extract`, bound to its window by `inputs[0]` (the window JSON as a `report` artifact), run
through `runMission` sandboxed under the `review` profile over the attempt's socket. Each attempt
holds one tool, `propose_ir_record`, and nothing that reads back: blind by construction.

A proposal names a `kind` (requirement, invariant, constraint, interface, acceptance-condition,
decision, dependency, non-goal, deferral, open-question, ambiguity, contradiction), a `source`
(`extracted`: the text says it; `inferred`: the reader concluded it, with `basisSections`), a
statement, a confidence, attributes (tags and milestone checked against the domain's config), a
`section` of the window, and a **verbatim `quote`** from that section (with `occurrence` when the
words occur more than once there). An ambiguity or contradiction quotes its second passage in
`other`.

- **Quotes, not offsets.** One validator runs in the server and again on the host. The host finds
  the quote's exact bytes in the section body and computes the span itself; a quote that is absent
  is refused (`quote`), one that occurs twice without an occurrence is refused (`occurrence`). An
  offset an agent sends is an unknown key, refused. A quote with secret-shaped text is refused
  (stored verbatim, it cannot be masked); statements are redacted.
- **The outbox.** Lines land in `<out>/ir-proposals/<attempt>.jsonl`. Ingest re-validates every
  line, refuses an outbox naming no attempt of the corpus, a link, an envelope with extra keys and
  over-cap lines, and leaves a torn last line for the next read. At most 200 per attempt.
- **Records.** Ids are attempt-independent: the same reading of the same words from two
  extractors is one record with two observations; a proposal whose content digest matches a record
  with an overlapping span at this revision is another observation of it. The content digest
  (kind, source, document, quotes, statement, attributes) excludes section ids, offsets and basis,
  so a moved passage keeps its approval. Every record is `proposed`; only `approve-ir` (WS-R15)
  moves one. Its span is stored per revision in `ir_spans`; **a record with no span at the
  current revision is stale**, derived, never written (P2-R53).
- **Disagreement is data**, derived on read: `single-extractor`, `kind-differs`,
  `source-differs`, `statement-differs`, `attrs-differ`. Agreement never approves (ADR-14).
- `irVersion` digests the corpus, section set, config, roster and the prompt template.

## Coverage and the detectors

```
daylight corpus coverage <corpus> [--revision cr_…] [--format json|md] [--write]
```

Every normative unit is **mapped** (a live record's span at the revision overlaps it) or listed
**unmapped**; `mapped + unmapped = normative` is asserted. Sections with normative units and no
record are listed with why (`no-attempt`, `attempt-failed`, `no-records`). Then deterministic,
documented detectors:

| detector | what it finds |
|---|---|
| `hedge` | a normative unit with a configured hedge cue (OLC: "implementation defaults") |
| `open-decision` | a normative unit in an open-decision section |
| `modal-polarity` | two normative units sharing ≥ 3 content tokens (Jaccard ≥ 0.3) with opposite polarity (`must`/`always` against `never`/`must not`/`no X`); records with one `attrs.subject` and opposite `attrs.polarity` |
| `numeric` | two similar units naming the same unit with different numbers |
| precedence | a contradiction between ordered documents is resolved (`over`, with its basis); unordered → left open; across domains → open, `declaredDependency` when a dependency covers it |
| `dangling` | every unresolved reference |
| `unsupported` / `stale` | inferred records with no basis and no decided assumption / records with no span at the revision |

Excerpts appear in the markdown only: at most 160 characters of corpus text, control and bidi
characters stripped, **withheld (never masked)** on a `redact()` hit or any holdout basename of any
campaign of the project, and counted. Statements written by extractors never appear (P2-R40); `ir
list` shows ids and spans, not statements.

**Seeded-defect mode** (`coverageOf(…, { seeds })`, tests only; the CLI has no flag) inserts each
seed's sentences after a named section in an in-memory copy, sections it again and runs the same
detectors; the registered corpus is never touched. The OLC fixture's seven seeds
(`olc-config/seeds.json`) cover every seed kind and are all detected; the unseeded corpus has no
detected contradiction.

## Commands and agent sessions

```
daylight corpus register <repo> --manifest daylight.corpus.json [--rev HEAD] [--project alias=<repo>[@rev]]… [--format json]
daylight corpus show|sections <corpus> [--revision cr_…] [--doc K] [--format json]
daylight corpus extract <corpus> <repo> --tools a,b [--windows …] [--force] [--timeout s]
daylight corpus coverage <corpus> [--revision cr_…] [--format json|md] [--write]   # --write → <out>/corpus/<id>/coverage.{json,md}
daylight corpus ir list <corpus> [--status s] [--kind k] [--section id] [--stale] [--format json]
```

Under `CLAUDECODE` or `DAYLIGHT_SESSION`, `register` is refused and `extract` is refused unless
every tool is a mock (P2-R50 Q5); `coverage --write` is refused (P2-R40). `show`, `sections`,
`coverage` and `ir list` run anywhere (P2-R24).

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

## Traceability (WS-R16)

`engine/forge/trace.ts` answers two questions from rows other modules write, and decides nothing:

- **Forward**, from a passage (a section, a label, or a byte range of one document at a corpus
  revision) or one record: the records spanning it → the approved blueprint's elements deriving
  from them → the packets of those components that cite them → the tickets traced to them → each
  ticket's work item and every ticket mission on it → candidates → gate rows and landings.
- **Backward**, from a landed commit, an integration, a candidate or a ticket: the ticket → its
  packet → the records it cites → their quoted passages: document, byte range, the revision's
  commit. Every quote digest is re-hashed from the stored document bytes on every trace; a
  mismatch is reported by record id.

Each edge names the join it used (`TRACE_JOINS`): `ir_spans` overlap for passage → record,
`blueprint_derivations` on an approved blueprint, `packets(blueprint_id, component_id)` and the
packet body for element → packet, `ticket_trace` for packet/record → ticket,
`campaign_tickets.work_item_id`, `candidates.mission_id`, `gate_evaluations` (an evaluation of a
gate bound to the ticket's obligation in the lock is joined as `obligation-gate`), and
`integrations.integrated_commit`.

```
daylight trace passage <corpus> --doc K (--section <id> | --label §11.3 | --range a-b) [--revision cr_…] [--format json]
daylight trace requirement <ir_…> [--format json]
daylight trace ticket <campaign> <ticketId> [--format json]
daylight trace landing <commit | i_… | c_…> [--campaign m_…] [--format json]
daylight trace matrix <campaign> [--format json|md] [--write]
```

All of it is read-only and runs in an agent session; only `matrix --write` (which writes
`<out>/campaigns/<id>/trace-matrix.{json,md}`) is refused there.

What a trace never shows: corpus text in JSON (passages are ids: revision, document, bytes);
extractor or reviewer statements (P2-R40); any label naming a holdout basename of any campaign
of the project (replaced, and counted as a gap). The markdown renderer asks `safeExcerpt` for
each excerpt; a withheld one is counted, never printed.

What a trace says instead of guessing, as `gaps`:

- a commit on `main` reaches an integration only when the human merge fast-forwarded; after a
  squash or rebase merge there is no row, and `trace landing` says so;
- a ticket from a version-1 plan, or a hand-written one, is **untraced** (and listed as such in
  the matrix);
- a plan without `derivation` names no revision, so spans are read at the corpus's current
  revision, and the report says that it did;
- a record with no span at the current revision is **stale** (derived, never stored, P2-R53);
  a record an errata deferred shows the deferral, not a component.

`trace matrix` needs the authority chain (`authorityChainOf`, WS-R15).

## The ingestion benchmark (WS-R16)

`daylight ingest bench --mode mock|live-extract|live-full --fixture <dir> --extractor <script> [--format json]`,
and `engine/test/forge-ingest-benchmark.ts` in `test:all` (mock mode, both corpora; it also runs
the CLI and requires the same report). The benchmark is product code (`engine/forge/ingest-bench.ts`,
P2-R57) and knows no project: the corpus is `--fixture`, and in mock mode the scripted agents
*and the scripted person* (every human act: approve-ir, approve-blueprint, approve-plan, the gate
lock, the landing) are the `--extractor` module, as `DAYLIGHT_MOCK_ADAPTER` names a mock agent.
The benchmark itself makes no human decision; without a person those stages are blocked. The tests
pass `engine/test/ingest-bench-agents.ts`. The store is a throwaway under the work directory.

**Corpora.** Two fixtures under `engine/test/fixtures/ingest/`, each described by a `bench.json`
(document keys, the repositories to commit, the answer files; paths relative to it). Answers are
never in a corpus directory:

- OLC: the documents are WS-R14's verbatim copy in `olc/` with its `NOTICE` (P2-R52); the
  manifest, sectioner sidecar and seven seeds are WS-R14's `olc-config/`, referenced, not copied;
  the benchmark's own files are in `olc-expected/`. Ground truth = the 28 M0 build
  tickets of `execution-plan.md`'s tables (P2-R50 Q15), committed as `ground-truth.json` with
  the source's digest; an IR overlay of 181 hand-checked records (P2-R50 Q9) plus one mechanical
  record per remaining normative unit of the sectioner, each record marked `hand` or `mechanical`;
  the mechanical part is regenerated from the registered index and compared on every run.
- `harbor/` (answers under `harbor/expected/`): Harbor Ledger, a synthetic port-logistics standard with a different label scheme
  and a > 40 KiB section body, generated by `engine/test/lib/synthetic-corpus.ts` against its
  `expected/README.md` contract; regenerated and compared byte for byte in the test.

**Checks are data** (`CHECKS` in `engine/forge/ingest-bench.ts`), the sixteen of
ingest-interfaces v3 §11.3 plus fixture integrity, each with its bar and its falsifiability per
mode. The report lists, by name, the checks mock mode cannot fail.

What mock mode **proves**:

- the fixture is sound: every quote sits at its byte offset, the mechanical records are exactly
  what their rule yields over the current sectioner, no ground-truth row appears in a corpus
  document (so a sectioner change that moves units fails check 0 or 1 until the overlay is
  regenerated: falsifiable, sectioner against overlay);
- the scorer measures what it claims (mutation tests: remove a ticket and recall drops by one;
  rewire an edge and precision drops; rename a ticket and only id exactness drops; drop a seed's
  detection and the seed is missed);
- scope is enforced: an M0 packet citing the book shell E9 moved to M1, or Harbor's audit export
  planned in W1 after Amendment A3 moved it to W2, is a leak;
- each fixture invariant has records, sits on a boundary and reaches an obligation; the component
  DAG is acyclic and its `order` is its Kahn layers; precedence bases occur exactly once and
  precedence never crosses a domain;
- once WS-R14/R15 are merged: the pipeline (register → scripted extractors through the real
  outbox servers → review → approve-ir → coverage with seeds → blueprint and packets from the
  fixture files → plan, campaign, lock → a landing) holds together; coverage arithmetic;
  every seed found by the deterministic detectors; the backward/forward trace round trip with
  digests verified; a one-sentence revision staling exactly its records and tickets with no
  existing row changed; a holdout basename kept out of packet context and excerpts.

What mock mode **does not prove**, and says so:

- ticket recall, id exactness, dependency recall and precision, path coverage, boundaries and
  ticket-ref resolution are **by construction**: the packets and blueprint were written from the
  answer, so these test only the scorer and the import path;
- nothing about extraction quality: the scripted extractor proposes the fixture's own records.
  Live-extract measures that (unmapped normative ≤ 5 %, seeded contradictions 100 %, P2-R53
  O-c); live-full adds the architect and packetizer (recall ≥ 26/28, edge precision ≥ 0.90);
- the OLC seeds are WS-R14's (written beside the detectors they exercise); someone other than the
  detectors' author should review them before merge. Harbor's six are generated with the corpus.

**Live modes are refused** with one line: never from an agent session, and nowhere until a
live-spend grant exists (P2-R7). Until WS-R14/R15 merge, their stages report `blocked` (the
step-0 stubs say `not implemented`) and so do the checks reading them; the test fails on any
`fail` or any stage that `failed`, so after the merge the same run is the integration test.
