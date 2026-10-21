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
  with `--project <alias>=<repo>[@rev]`, at its own commit. Every alias must be bound and every
  bound alias used. Only documents in the corpus's own repository are protected from authors.
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
