# Architecture

Read this if you touch more than one crate. The layer table and its rules are in
`AGENTS.md`; this file says what flows between the layers and why.

## The three artifacts

```
 source repo (Git, TOML, small media)       release pack (.zip, deterministic)        learner device
 ┌──────────────────────────┐   olc pack    ┌──────────────────────────────┐  olc pack  ┌───────────────────────┐
 │ graph/  lessons/  items/ │ ──build────▶ │ manifest.json                │ ──install─▶│ content cache (CAS)   │
 │ media/  provenance/      │              │ pages/ items/ media/ by digest│            │ learner.sqlite (private)│
 │ governance/  prompts/    │ ◀──report──  │ surfacing-policy.json        │ ◀─advisory─│ report queue           │
 └──────────────────────────┘   bundle     │ provenance (public-safe)     │            └───────────────────────┘
                                           └──────────────────────────────┘
```

- **Source** is human- and agent-editable. Identity is by ID + canonical digest, not by path.
- **Pack** is immutable. Its release digest is SHA-256 of the canonical manifest, which lists
  every other member by path, size and digest (never itself; ADR 0008).
- **Device** holds installed packs in a content-addressed cache and *all* learner data in a
  separate SQLite file. Nothing crosses from the right column to the left except a `Report`
  (public identifiers + optional text) or a contribution the learner explicitly authors.

## Identity (ADR 0003)

Five newtypes in `olc-schema`, deliberately not interconvertible:

| Type | Example | What it names |
| --- | --- | --- |
| `CompetencyId` | `olc.math.quantity.count-to-10` | an assessable capability |
| `ObjectId` | `org.example.items.count-tap.0417` | a logical thing with a history |
| `RevisionDigest` | `sha256:…` over canonical JSON | one immutable definition of an object |
| `BlobDigest` | `sha256:…` over bytes | one set of bytes |
| `ReleaseDigest` | `sha256:…` over the canonical manifest | one immutable distribution snapshot |

Publisher namespace is reverse-domain; the path within is dotted. Canonical form is RFC 8785
JSON; TOML on disk is parsed to the same model before hashing.

## Content model (spec §7, §9–§11, ADR 0005, ADR 0013)

```
CompetencyNode ──prereq──▶ CompetencyNode
      ▲
      │ competencies[]
    Page ── blocks[] ──▶ prose | figure | term | activity | manipulative | related | media-reference | educator-note | project | printable
                              │                  │
                              ▼                  ▼
                        MediaAsset(blob)     ItemSet ──▶ Item { primitive, params | generator, solver, accepted, distractors, proof_kind }
```

- The **page** is the authored unit; the generator contract produces pages with embedded
  activities, not item banks (spec §11.3).
- An **item** declares its `proof_kind`: `executable-solver`, `scene-graph`,
  `lexical-source`, `model-critique-only`, `none`. The solver is code in `olc-items`, not
  text in the item.
- Every object has a `ContentRevision` with `validation` (what checks passed, by which tool
  versions) and `editorial_state` (`none` | `sample` | `full`), kept apart (ADR 0004).

## Surfacing (ADR 0004)

`governance/surfacing-policy.json` maps `(strand_risk, proof_kind, editorial_state)` → `allow
| deny`. The pack builder embeds it; `olc pack verify` refuses a policy that lowers a
reference minimum for `health-safety` or `phoneme-contrast`; the installer materializes an
`allowed` bit per revision at install time. The renderer reads the bit; it never evaluates
the policy. Adult views also get the plain-language state string for the About panel.

The same file's `evidence` block is a second, independent decision: whether a correct
response on the revision may count toward a mastery transition. The installer materializes
it as a separate `evidence_eligible` bit. Surfacing never implies eligibility, and
`editorial_state` is not a blanket prerequisite for it (ADR 0004 "Surfacing versus
evidence").

## Evidence and mastery (spec §13, ADR 0004)

`attempt_events` is append-only and records the exact item, rubric, page, graph and release
digests. `mastery_estimates` is derived and recomputed on demand — after an advisory
retracts an item, after a scheduler change, after a profile import. Whether an attempt may
count toward a transition is read from the revision's `evidence_eligible` bit, never from
`editorial_state` directly. An `objective` item proven by `executable-solver` or a faithful
`scene-graph` is eligible at `editorial_state = none`, so a learner can reach provisional
local mastery and a local, unsigned badge from AI-generated, mechanically validated content
before any human review (spec §13, §24; ADR 0004). Higher-risk strands require
`editorial_state ≥ sample` (or `full`) before their attempts count. Retraction recomputes
mastery from the remaining eligible evidence; raw attempts and earned badge records stay.

## Commands (ADR 0014)

`olc-engine` owns the catalog. CLI, MCP and the Tauri shell are three doors over the same
`execute(id, args_json) -> result_json`. Front-end launchers (`olc ui`, `olc mcp`) and
setup (`olc install`) are plain subcommands, not catalog commands, so an MCP client cannot
rewrite its own registration.

Planned catalog for M0/M1 (status in `olc help`):

```
repo.init        graph.check      gen.items        gen.page        validate
media.audit      media.synthesize pack.build       pack.verify     pack.install
pack.rollback    advisory.apply   report.create    report.export   report.sync
profile.list     profile.create   book.open        book.search     item.attempt
badge.list       doctor
```

## Renderer as a library (ADR 0013)

`olc-render` is a web package (TypeScript, built into the crate as static assets) that
renders the page/block model, activities, the index and the About panel. `apps/olc-book`
(Tauri) hosts it for learners; the future Contributor Workbench hosts the same package for
previews. The renderer talks to the engine only through the catalog and only reads
`allowed` revisions.

Bindings (ADR 0015) are packs of type `binding`: tokens, ornaments, frames, iconography, and
no content. The renderer loads one binding at a time and must pass the low-ornament degrade
test with every binding installed.

## What is deliberately not here

- No network client below L5. `report.sync` and future index fetches live in `apps/olc`.
- No model, network or synthesis client linked anywhere below L5. Synthesis is an external
  process (ADR 0006); the factory tooling lives outside the workspace.
- No RDF store. PROV-O is an export mapping from ordinary tables.
- No permission model between profiles until M3 (ADR 0011); M1 is "one device, N profiles,
  no cross-reading."
