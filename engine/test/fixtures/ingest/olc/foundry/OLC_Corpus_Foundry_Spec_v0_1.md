# OLC Corpus Foundry
## An autonomous, local-first educational content production and validation system

**Implementation specification — Working Draft v0.1**  
**Date:** 20 October 2026  
**Status:** Proposed standalone peer specification, intended for Daylight implementation  
**Companion:** *Open Learning Commons integrated specification v0.7*, 19 October 2026  
**Scope:** Factory and production pipeline, not a learner-facing OLC feature

> **Daylight builds the factory. The factory runs local agents. OLC communities own the resulting educational source.**

## 0. Executive decision

Build **Corpus Foundry** as an independently executable, reproducible production system that continuously turns eligible source corpora, public knowledge, and competency-driven requests into structured educational artifacts. It orchestrates inexpensive local models, stronger model critics, deterministic validators, and human review; stores drafts and failures outside published curriculum; and promotes eligible results into community-owned, Git-friendly OLC source repositories.

Foundry and OLC are **peer implementations with shared versioned contracts**. The learner must never depend on Foundry, its database, agents, model endpoints, or uptime. Foundry must be able to produce a complete OLC-compatible source pack using pinned schemas and the public pack CLI, even when the original OLC project's services are unavailable.

The existing OLC M0/M1 learner vertical-slice scope **does not change**. Foundry may run ahead, staging candidate material while OLC matures; only compatible, validated, rights-cleared content is promoted to a canonical pack source tree. Neither sheer artifact volume nor model-review agreement constitutes curriculum quality.

### How this reconciles with OLC v0.7

OLC v0.7 already specifies AI-produced starter content, Daylight factory lanes, deterministically verifiable item families, provenance, Git source packs, a future human Contributor Workbench, and compiled immutable ZIP releases. Foundry makes the **previously underspecified factory and staging subsystem** an independent project. The main v0.7 spec should receive a short *interface note* pointing at this peer specification rather than absorbing its operational internals.

Interpret references to “Daylight generates the initial corpus” as: Daylight may bootstrap content directly for OLC M1, and Daylight develops Foundry as the independent repeatable producer for subsequent/parallel generation. Daylight's coding agent does not become a necessary runtime dependency of Foundry.

## 1. Mission, values, and explicit non-goals

Foundry exists to help communities create **correct, comprehensible, accessible, culturally adaptable and redistributable educational materials** at an otherwise impractical scale. It produces coherent *book pages with activities* and reusable instructional structures, not a warehouse of disconnected quizzes. Source rights, editorial decisions and actual learner learning remain different questions.

**Non-goals:**
- No learner account, private learner telemetry, runtime inference dependency, LMS, or hidden online tutor.
- No central approval authority, required cloud provider, required public registry, or mandatory proprietary model.
- No automatic human-review designation from machine critique.
- No direct write access by generation agents to released pack branches or review decisions.
- No blanket assertion that all processed wiki facts or ML benchmark answer keys are true or suitable for teaching.
- No claim that a dataset's benchmark difficulty equals learner grade, mastery, prerequisite order, or reading level.
- No automatic ingestion of entire protected/unclear-rights datasets into redistributable packs.

## 2. Products and ownership boundaries

| Component | Responsibilities | Owns persistent truth |
| --- | --- | --- |
| **OLC core** | Competency/page/item/media/provenance schemas; pack CLI; learner app and local evidence; Contributor Workbench | Canonical content types and pack interoperability rules |
| **Corpus Foundry** | Production campaigns, scheduling, adapters, source snapshots, agent attempts, validation, QA, candidate staging, promotion bundles | Work history, candidate registry, pipeline execution and receipts |
| **Community pack repository** | Editable lessons, items, graph mappings, media references, review decisions, governance and change history | Accepted public educational source and its revisions |
| **Compiled OLC pack** | Reproducible, complete offline distribution | Immutable release manifest and installed asset closure |
| **Human reviewers and publishers** | Contextual educational, semantic, cultural and rights decisions; release policies | Actual editorial events and publisher authority |

Foundry is an independent tool **for making OLC packs**, not an additional dependency **for reading OLC packs**. A community can ignore Foundry and author source by hand or through the Contributor Workbench.

Suggested separate repository: `olc-corpus-foundry`. The codebase may use Rust for trusted validators and artifact handling, and another language for inference adapters/orchestration, as long as boundary formats are declared and tested. Avoid prematurely standardizing an internal language choice as a community mandate.

## 3. Contract-first compatibility

Implement a small, public, versioned integration surface:

1. **Read** version-pinned OLC competency graph and authored page/item schema definitions.
2. **Target** competencies by ID **and revision**, with declared prerequisite relationships and specific evidence goals.
3. **Emit** ordinary source-pack files and media manifests conforming to the pinned OLC release of the schemas.
4. **Validate** with the *actual* OLC pack CLI/library and required independent subject validators, not simulated success from agents.
5. **Promote** through a portable promotion bundle and/or ordinary Git PR/merge request. No Foundry-only metadata may be required to build or edit the accepted public source.
6. **Round-trip** corrections and retractions by immutable content revision, without altering historical published evidence.

The OLC specifications control identity: competency ID, logical content object ID, immutable content revision/digest, media blob hash, and release digest. Foundry additionally assigns **campaign**, **job**, **attempt**, **candidate** and **validation-receipt** IDs. Never conflate a candidate ID or model run ID with a published content object revision.

If the OLC schema is not yet final, stage candidate artifacts in a versioned **Foundry intermediate representation** (FIR), with explicit schema revision and migration procedures. Publishing always requires revalidation against a concrete OLC pack schema version; a model cannot silently choose a new schema.

## 4. The production hierarchy

- **Campaign:** a durable goal, such as “generate and validate the foundational counting and geometry chapter” or “adapt 100 GSM8K training records.” Has targets, rights policy, quotas, budget and stop conditions.
- **Job:** a long-running, resumable structured assignment to an agent or group of agents. May run many substeps and checkpoints. Explicitly records dependencies and resource requirements.
- **Work unit:** a bounded, versioned output contract, typically one page candidate, concept explanation, structured quantitative situation, asset, or exercise family. It declares competency revision, locale, difficulty, item type, source snapshots and checks.
- **Attempt:** one execution of a work unit by a model/harness, with immutable inputs, model identity, parameterization, prompt revision and output artifacts.
- **Candidate:** a selected concrete content revision, distinct from attempts and reviews. May be revised, repaired, rejected or promoted.
- **Receipt:** signed or otherwise provenance-bound executable test report or review event; its declared author and evidence class must be verifiable from infrastructure, not agent-written YAML.

**Rule:** Long agent jobs are welcome. Their *durable checkpoints and publication candidates* are small, independently testable, immutable artifacts. Retries should not create false duplicates or mutate already reviewed bytes.

### Example campaign (illustrative, not a final wire schema)

```yaml
schema: foundry.campaign/v0-proposal
id: campaigns/math-word-problems-pilot
purpose: "Make a reviewed, OLC-compatible reasoning chapter"
source:
  adapter: gsm8k
  revision: "<pinned upstream commit>"
  split: train
  sample_count: 100
  rights_policy: redistributable-olc
curriculum:
  graph_revision: "<pinned competency graph revision>"
  target_competencies:
    - olc.math.fractions.half-of-quantity
  locale: en-US
outputs:
  - typed-situation
  - book-page
  - activity-family
  - educator-note
quality:
  mechanical: required
  semantic: strong-model-review
  editorial: policy-dependent
  audit_sample: true
resources:
  execution: idle-only
  priority: background
  generation_model_class: efficient-local
  criticism_model_class: strong
publish:
  destination: "olc-pack-example"
  mode: promotion-bundle
  auto_merge: false
```

The `sample_count` above refers to upstream **training records**; protect test/holdout splits when they are still intended for independent model evaluation.

## 5. Source import and transformation adapters

Adapters ingest from eligible upstream sources without becoming trusted instruction channels. Each import records exact source identifier, revision/time, original bytes/digest, relevant license/terms, attribution, derivation path and redistribution decision. A source ineligible for release may still be usable as a private build-time reference *only if its terms actually permit that use*; it must never be copied into a public pack as a side effect.

Initial adapters:

- **OLC-native**: existing competencies/pages/items, coverage gaps, revision history and defect reports.
- **GSM8K**: original problem, `main` and `socratic` traces, arithmetic annotations, split and license; recover typed quantity graphs and flag ambiguity.
- **CLEVR / deterministic visual sources**: pinned scene descriptions, render programs, exact object relationships and question programs; transform into accessible figures/manipulatives.
- **Wikimedia**: pinned Wikipedia article/revision, Wikidata entities/revisions and Wikimedia Commons file revisions, attribution, source citations, per-media rights and transformation lineage.
- **Generator-first**: programmatic arithmetic, geometry, logical and pattern families from independently checked rules.

Later adapters may support ARC, language corpora, audio, coding problems, interactive fiction and scientific datasets **only after asset-level rights and pedagogical fit reviews**.

### Wiki-specific policy

A wiki article is a **source to evaluate**, not a lesson and not a primary authority for every claim. The transform should identify teachable concepts, build claim-level provenance, and distinguish sourced facts, uncertainty, interpretive commentary and unsourced assertions. Model-generated citations are not evidence until resolved to real pinned material and checked for claim support. Keep the rights of adapted CC BY-SA prose and independently licensed images separate. A transformation should create page narratives, interactive explanations and project ideas only when they suit a defined competency or exploratory goal.

All imported document text is **untrusted data**, including instructions embedded inside a wiki page, README, citation, HTML, PDF, or dataset sample. It must not gain authority to change system prompts, tool privileges, validation policy or output destination.

## 6. The pipeline and state machine

A campaign passes through an auditable sequence, with branching and returns for repair:

1. **Plan:** calculate underserved competency/representation combinations; select legal/appropriate source and output goals; estimate resource budget.
2. **Acquire:** pin source revision, rights metadata and references; put raw content into an immutable source snapshot.
3. **Extract/structure:** build typed facts, quantities, scene graphs, concepts, citations, assumptions and proposed learning goals; flag ambiguity.
4. **Author:** generate coherent page, activity families, hints, correction feedback, educator lens, accessible figure descriptions, media and print adaptations as applicable.
5. **Mechanical validation:** verify schema, references, exact arithmetic, deterministic scene labels, geometry and parameters, uniqueness, bounds, asset availability, license manifests, accessibility invariants and OLC pack compatibility.
6. **Semantic and adversarial QA:** stronger-model/source-grounded critics check fidelity, misleading claims, alternative correct answers, level appropriateness, learning objective fit, contradictory explanations and poor scaffolding.
7. **Disposition:** accept as candidate, repair, reject, or quarantine; record every finding and validator version.
8. **Policy evaluation:** determine auto-publish eligibility or required human review based on risks and verified evidence, not model voting or a single generic score.
9. **Promotion:** emit Git-friendly source and a machine-readable promotion manifest, with exact revisions, provenance and rights; produce PR/offline bundle, not an unreviewed direct commit to canonical branch.
10. **Release/build:** canonical pack repository remains publisher-of-record; OLC pack CLI compiles and verifies an immutable offline ZIP.
11. **Correction loop:** failed audits, human edits and source retractions produce new revisions and regression fixtures; propagate invalidation to affected candidates and dependent chapters.

### Publication trust axes (separate fields, never one opaque score)

- **Mechanical:** precise tests that executed, with validator code version and concrete output hashes.
- **Semantic:** source alignment, unresolved ambiguities, reviewer critique and whether material claims have corroborating references.
- **Pedagogical:** objective alignment, accessibility, coherence, misconceptions and empirical observations where available.
- **Rights:** original and derivative source licenses, attribution, allowed distribution, media and notices.
- **Editorial:** none, sample-audited, individually human-reviewed, correction requested, rejected; evidence stored per *exact revision*.
- **Publisher authenticity:** community release key/signature, a fact about approval of release identity, not evidence of truth.

Low-risk mathematically proven exercises may be published under an **accurate automated-validation label** where the edition's policy allows. High-risk health/safety, ambiguous lexical/phonological, historical or contested source material requires appropriate further scrutiny. Sample review does **not** convert all items in the batch to individual human-reviewed status.

## 7. Model orchestration and hardware constraints

Support configurable local providers behind a generic inference interface, without model-specific requirements. Useful adapters include OpenAI-compatible local endpoints and direct server integrations where needed. Remote models are **optional reviewer backends**, never necessary for Foundry to function.

The planner may give inexpensive producers **long, structured, checkpointed** jobs while reserving strong models for critiques, repairs or high-uncertainty work. External validators and reference solvers run as isolated deterministic tools, not as another LLM asserting agreement.

**Idle-first operations:**

- An operator specifies quiet/active/paused state, GPU memory reservation, maximum utilization or power threshold, concurrency, priority, maximum outstanding work and optional time-of-day windows.
- Pause safely at checkpoints and persist leases; **never** interrupt interactive sessions merely to increase Foundry throughput.
- Use explicit job leases/heartbeats, crash recovery, retries with exponential backoff, attempt limits, timeout limits, and dead-letter/quarantine queues.
- Respect resource budgets and thermal/power limits; fail closed on missing monitoring rather than spinning at full load.
- The agent can emit progress and candidate blobs, but only the supervisor owns scheduling, environment credentials and irreversible promotion actions.
- A job must have termination and budget rules. “Run indefinitely” means **continuously accept new bounded work**, not allow individual loops to continue without limits.
- Maintain separate resource queues for CPU-bound deterministic checks, GPU generation, GPU adversarial review, human review and optional image/audio synthesis.

A model's strength classification is a *configuration*, not a guarantee. Track quality against calibrated known-bad examples and human audit results, per model and domain.

## 8. Storage, staging, and source promotion

**Suggested durable local staging:** SQLite WAL for queue, task state, lineage and small indexed metadata; filesystem content-addressed store (CAS) for immutable source snapshots, prompts, intermediate representations, generated assets, reports and candidates. Both must survive restart, support backup/restore and avoid partial records via atomic commit patterns. Ordinary filesystem and local SQLite are first-class deployment targets.

Suggested workspace:

```text
olc-foundry/
├── config/
│   ├── models.toml
│   ├── resources.toml
│   └── policy.toml
├── adapters/
├── schemas/
├── work/
│   ├── queue.sqlite
│   ├── attempts/
│   ├── candidates/
│   ├── quarantine/
│   └── reviews/
├── store/objects/            # Content addressed immutable blobs
├── reports/
│   ├── coverage/
│   ├── qa/
│   └── provenance/
└── exports/promotion-bundles/
```

In production, indexes reference hashed blobs rather than duplicating arbitrary file paths. The initial on-disk layout above is illustrative, not normative; use content-addressed identity and journaled state as the actual contract.

**Promotion bundle:** a signed or checksum-manifested portable directory/archive containing canonical source files, expected target pack schema version, source/base revision assumptions, related media, required license/attribution files, validator receipts and a summary of editorial/policy state. Promotion must be idempotent and reject unexpected base changes. The published repository should not depend on Foundry's SQLite file, model endpoints, task scheduler or mutable paths.

**Keep out of canonical Git:** raw logs at scale, transient failed generations, expensive model transcript archives, unaccepted candidates, scheduler databases, scratch media and duplicate intermediate artifacts. Retain these locally or in separately governed archival storage as warranted. Keep **enough** released provenance, exact revisions, validator receipts and notices in Git to support audit, correction and rebuilding independently.

## 9. Coverage-driven curriculum generation

Production is driven primarily by OLC's **curated competency graph** and editorially selected chapter goals, not by the arbitrary distribution of articles in Wikipedia or questions in an ML dataset. Prefer a coherent chapter containing visual introduction, prose, worked examples, manipulatives/activities, varied assessment, corrective feedback, educator note, related links and printable options.

Report:
- Competency coverage (including missing prerequisites and unassessed areas).
- Count of *distinct mathematical/logical/problem structures*, not just parameter variations or prompt paraphrases.
- Representation diversity (picture, quantity, symbol, language, manipulative, real-world application).
- Chapters complete enough to teach, versus pools of unattached question seeds.
- Duplicate/near-duplicate rate; answer-key validity; alternate-answer detection; human audit defect rates.
- Rights/review/completeness state by locale and subject.

Generation quota policy must cap repetitive easy work. A fresh new relation or an accessible explanation for a missing competency can outrank a hundred more cosmetic variations of an already saturated item family.

**Evidence warning:** Generating more parameter variations does not automatically generate independent demonstrations of mastery. Foundry annotates family/structure/representation differences, allowing the learner engine to avoid counting near-duplicates as independent evidence.

## 10. Quality assurance strategy

**Mechanical checks (hard gates when applicable):** exact rational calculations, symbolic equivalence, dimensional consistency, geometric predicates, programmatically rendered visual scenes, generated parameter boundaries, answer uniqueness, distractor soundness, schema validity, asset closure, build reproducibility, prohibited unsafe assets and rights metadata completeness.

**Source-grounded semantic checks:** Every material claim extracted from source should be verifiable against identified source passages or declared uncertainty; valid reference existence is not sufficient to establish semantic support. Stronger model reviewers should use different prompts/strategies, counterexample search and challenge-and-repair loops; they still do **not** constitute formal proof.

**Pedagogical checks:** distinguish testing from teaching. A valid item can be incomprehensible, age-inappropriate, inaccessible or dull. Reviewers examine the concept explanation, helpfulness of hints, misleading simplifications, sensitivity to language/locale and whether the exercise demonstrates its mapped competency. Evaluate full chapter coherence, not only isolated items.

**Calibration and audit:** maintain an adversarial corpus with deliberately wrong keys, subtle semantic shifts, contradictory wiki citations, ambiguous visuals, color-only distinctions, fake source URLs, ungrounded explanations, misleading units and valid alternate solutions. Track detection rates by pipeline version. Humans periodically inspect confident auto-accepted samples *as well as* flagged material; discovered defects reopen batch/template audits and generate regression fixtures.

**Editorial boundaries:** human editorial status is bestowed only by human action scoped to the exact artifact revision; batch spot checks remain batch spot checks. The same model cannot write its own verification receipt or silently change an earlier reviewer decision.

## 11. Security, privacy, and safeguards

Source text, generated content, prompts from external corpora and archives are untrusted inputs. Enforce:

- Network and filesystem access allowed by narrowly defined worker role; retrieval tools separated from generation agents; no arbitrary shell execution from imported articles.
- Sandbox executable exercise references or code-generation tasks; never run untrusted code in the learner process.
- Safe archive unpacking and bounded file sizes/parse depth; protect against zip bombs, path traversal, executable assets and malicious embedded instructions.
- Provenance of source bytes, adapted text and derivative image/audio rights; no accidental transfer of sensitive human or child data into public source.
- Human authorization for publication into a community repo; restricted auto-promotion requires explicit edition policy and still passes canonical pack validation.
- Local-first operation without usage telemetry; opt-in, separately governed external APIs and model providers.

## 12. Interfaces / operator experience

**CLI first; optional desktop dashboard later.** Minimum commands and APIs (names indicative):

- `foundry source import`, `source inspect`
- `foundry campaign create`, `campaign start`, `campaign pause`, `campaign resume`, `campaign status`
- `foundry worker serve`, `worker inspect`
- `foundry validate <candidate>`, `candidate inspect`, `candidate diff`, `candidate quarantine`
- `foundry review queue`, `review record` (human-authenticated action)
- `foundry promote <candidate-or-bundle>`, `export-bundle`
- `foundry report coverage`, `report qa`, `report provenance`

Expose machine-readable JSON status/event streams for Daylight and third-party harnesses. A GUI, if added, must use the same command catalog and cannot become a mandatory service for building source packs. The later OLC Contributor Workbench **consumes promotion bundles/PRs and the pack preview**, rather than re-implementing the agent scheduler.

## 13. Independent milestones for Foundry

### F0 — Contract and durable staging

- Versioned FIR candidate, job and receipt schemas with schema-validating fixture tests.
- Pinned OLC schema and CLI build handshake; one authored page + item can round-trip from FIR → pack source → deterministic offline OLC ZIP.
- SQLite queue with crash/restart recovery and immutable CAS, stable IDs and bounded retries.
- Local configurable model endpoint interface, safe artifact capture and versioned prompt templates.
- Manual campaign for one competency and one output family; no autonomy or massive dataset harvesting required.

### F1 — Continuous autonomous local pilot

- Idle-aware supervisor runs local worker jobs with resource caps, pause/resume and checkpoint recovery.
- 100-record **training-only** GSM8K pilot plus a basic visual/quantity generator relevant to OLC M1.
- Independent arithmetic/source consistency checks; original traces and derivatives retained under pinned revisions.
- Stronger-model review lane; quarantines and candidate promotion bundles.
- At least one coherent OLC chapter candidate, not just standalone question records.
- End-to-end defect injection catches deliberate wrong keys and fabricated provenance.

### F2 — Dataset adapters and human editorial loop

- CLEVR or analogous programmatically verified visual-scene adapter.
- First pinned Wikimedia article/Commons adaptation with per-claim grounding and per-asset rights.
- Reviewer worklist, model calibration, human audit sampling and batch defect response.
- Produce PR or offline bundle readable by OLC Contributor Workbench; propagate human corrections to regression fixtures.
- Full provenance and licensing round-trip, including corrected and retracted revisions.

### F3 — Production-scale coverage planning

- Curriculum-aware production scheduling by graph coverage, representation variety, rights readiness, review burden and chapter coherence.
- Multiple local worker model pools, model performance/quality routing, stronger critic allocation and bounded cost/power budgets.
- Additional domains/adapters and community-owned campaign policy packs.
- Incremental schema migrations and external pack compatibility fixtures across releases.

Foundry milestones are **not** prerequisites for OLC M0/M1. OLC can ship a handcrafted/Daylight-bootstrap slice while Foundry develops; Foundry can precompute and stage source before OLC is fully feature-complete.

## 14. Acceptance tests for F0/F1

1. Cold-clone Foundry and referenced public OLC tools; execute without proprietary hosted infrastructure.
2. A long job checkpoints multiple independently testable outputs and resumes after process termination with no missing/duplicated candidate identity.
3. A poisoned upstream document cannot change worker permissions, mark content approved, redirect promotion, or alter tool configuration.
4. A source import records exact version, digest, license, rights/attribution notices, original text/asset lineage and dataset split.
5. An intentionally erroneous arithmetic answer fails against an executable independent reference evaluator even when producer and critic agree.
6. A candidate with unsupported provenance, license or missing media is quarantined and cannot produce a valid promotional bundle.
7. Correct low-risk content can be labeled mechanically validated but remains correctly marked not human-reviewed.
8. Human reviewers can record an immutable review of a specific candidate revision, without implicitly approving its siblings.
9. A corrected item gets a new immutable revision and leaves the old version traceable; downstream deps are flagged for revalidation.
10. A coherent book page and exercises produce a working offline OLC pack through the real published pack toolchain.
11. A promotion bundle can be imported in a clean environment with no Foundry database or generation model present.
12. Factory output can be paused for interactive GPU use and resumes safely; bounded leases, budgets and retry limits hold.
13. Coverage reporting can distinguish 100 numerical permutations from 10 materially independent exercise structures.
14. All required third-party rights and attribution remain present after building and installing the offline pack.

## 15. Initial Daylight work order

**Deliver this spec as a second implementation brief, in parallel with OLC v0.7.** Start only with schema/interface coordination, not a shared agent runtime. Suggested tickets:

1. **ADR: peer-project boundary** — name, repository, versioned dependencies, ownership of candidate identities and pack compatibility.
2. **FIR + fixture pack** — one candidate -> exported source -> valid offline compiled OLC pack with provenance.
3. **Queue/CAS** — transactional persistence, workers, retries and crash recovery.
4. **Local inference driver** — endpoint adapters, model parameter receipts, capped work units and checkpoint files.
5. **Deterministic validator runner** — independent solution checking, source/asset manifest checks and refusal tests.
6. **GSM8K adapter pilot** — 100 training records, source digests, quantity/solution model, ambiguities and quarantine report.
7. **Review lane** — strong-model critique reports, calibrated defects and manual adjudication events.
8. **Promotion bundle** — signed/checksummed payload, canonical source files, expected base revision, rights and provenance; integrate with OLC CLI.
9. **Idle scheduler** — resource policies, pausing, heartbeat/leases, backpressure and observability.
10. **Curriculum planner** — coverage-first job selection and chapter-completeness reporting, once data proves the earlier interfaces work.

**Daylight completion standard:** every ticket has a concrete fixture, an executable acceptance test, a documented compatibility interface, and a clean-environment run. The first valuable outcome is **one genuinely usable chapter with traceable validated content** created using the autonomous path—not a dashboard reporting millions of generated tokens.

## 16. Open decisions requiring future ADRs

- Whether the Foundry intermediate representation is a named public standard or an explicitly internal versioned contract.
- Whether OLC source pack schemas are pinned through a Rust crate, language-neutral JSON Schema, or both; avoid requiring Foundry to import learner internals.
- Precise capability boundaries for the autonomous promotion lane versus human-authorized Git publication.
- Standard representation and proof rules for mathematical situation graphs, semantic claim citation graphs and visual scene programs.
- Model-provider resource probes and safeguards for multiple local backends; resource budgets should be defined by operator preference.
- Retention and GC of failed attempts, immutable source snapshots and large media intermediates, without breaking audit records.
- Attribution and share-alike compatibility checks for mixed-license adapted lesson bundles.
- First community policy profile for mathematics, language, media and historical/cultural content.

---

**Design principle:** *Generate freely; validate independently; promote deliberately; publish openly; learn privately.*

**Boundary sentence:** *A learner opening an offline book must never need to know how many agents, GPUs, retries, audits, or source transformations were required to create its pages.*
