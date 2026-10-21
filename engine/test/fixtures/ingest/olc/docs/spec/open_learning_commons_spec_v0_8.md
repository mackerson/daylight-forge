# Open Learning Commons
## A federated educational commons, an offline learning book, and a human-editable body of knowledge

**Version:** v0.8  
**Status:** integrated draft with interface plates and binding model

**Integrated project and implementation specification — Working Draft v0.7**  
**Date:** 19 October 2026  
**Status:** Proposed, implementation-directed, not a ratified standard.  
**Sources:** Consolidates v0.5's human and community commitments, v0.6's implementation discipline, and the October 19 owner review. This document stands on its own; prior drafts are historical inputs, not required normative dependencies.

> **An education anyone can receive, understand, improve, and give away.** The software is one reader of an openly maintained body of educational knowledge. A community can translate, author, review, build, and distribute its own complete offline edition without asking a central organization for permission.

> **First prove one excellent learning experience.** The initial version is an end-to-end, AI-produced, mechanically validated educational slice. Humans enter the review and contribution loop as the next expansion, not as the bottleneck that prevents the first useful release.

### What v0.8 deliberately changes

This revision locks in five ideas that emerged from the interface work:

1. **The magical book thesis is now explicit.** Open Learning Commons should feel like somebody took all the libraries in history and smashed them into a magical book that helps you explore the world.
2. **Bindings are first-class.** Visual presentation is not a loose theming afterthought. A *binding* is a coherent, swappable visual and cultural presentation layer applied to the same semantic book.
3. **The unfolding book is preserved intact in the first slice.** The learner does not begin inside a dashboard or quiz bank. The book remains the primary surface, with search, badges, index, activities, notes, graph, and print as different doors into the same body of knowledge.
4. **Illustrative content is intentionally replaceable.** Placeholder art, diagrams, and generated media are acceptable in the first release *because they are clearly replaceable community artifacts*, not sacred originals.
5. **Community art is part of the commons.** Learners, educators, translators, illustrators, and subject communities should be able to replace, improve, localize, and contribute images, diagrams, covers, specimen drawings, maps, and other cultural teaching artifacts.


1. **A complete vertical slice takes priority over infrastructure breadth.** M0/M1 produce an installable, offline, engaging pathway from first encounter through adaptive practice, feedback, a local achievement, and later review. The first slice must actually teach and adapt, not merely demonstrate packaging.
2. **AI-produced curriculum is explicitly the initial corpus.** Daylight generates lessons, questions, artwork, and provisional narration within bounded, verifiable content domains. Automated proof is strongest for arithmetic, quantities, coordinate geometry, deterministic illustrations, classification with explicit rules, and similar objective tasks. Vocabulary receives additional semantic safeguards.
3. **No blanket human-review gate for low-risk, demonstrably correct exercises.** Automated checking permits publication and *local provisional mastery* where the correctness of the particular item can be established. High-risk, ambiguous, and linguistically delicate content remain more restricted. Review status is stated accurately; no algorithmic result is presented as human-reviewed.
4. **The learning app stays light.** It teaches, records evidence, displays local badges, reports problems privately, and consumes packs. Its primary job is not to be a Git client, publishing station, provenance auditor, credential authority, or translation dashboard.
5. **The separate Contributor Workbench is the human editing door.** A friendly desktop application opens language-pack Git repositories, displays content with context, supports translation, recording, rewriting, review and replacement, validates the proposed changes, and prepares a pull/merge request or offline contribution bundle. A contributor need not learn Git or TOML.
6. **The human core returns.** Adults and children are equal learners. Co-learning, teacher's-edition annotations, the unfolding book, cross-disciplinary application, and learner-owned merit badges shape the data model from day one even where their full interfaces follow later.
7. **Federation remains an executable promise.** Community-owned repositories are the editable sources; immutable offline packs are the distribution artifacts. Wikimedia Commons and Lingua Libre are major upstream references, not runtime services or compulsory hosts.
8. **Provenance is automatic and proportionate.** Factory-generated receipts, stable revisions, source rights, tests, and optional reviewer decisions travel with published content. The ordinary learner is not asked to audit the machine before answering how many circles are on a page.

9. **The owner's book sketches are normative design inputs.** An illustrated, freely navigable book spread—with section dividers, bookmarks, full-page reading, index, world search, badges, print/export and profile graph—anchors the first complete learning slice. The layout evokes paper without enforcing two physical pages.

---

# Part I — Purpose and human commitments

## 1. Mission

Open Learning Commons (OLC) is an open-source, community-maintained project for foundational human education. It includes an openly specified educational corpus, an offline reference learner application, publishing/build tools, and—after the first learning slice—a separate community contributor application.

The long-term aim is for any person to acquire the foundational abilities needed to understand, sustain, participate in, and improve human society, then enter specialized disciplines through further study. Coverage ultimately includes literacy and grammar; communication and storytelling; mathematics; reasoning and inquiry; health and biology; ecology; chemistry; physics; engineering; computing and information; creativity; and practical cooperation and societal maintenance.

History is not a stand-alone chronological syllabus. Historical actors, discoveries, failures, and tools appear when they illuminate concepts. Practical learning culminates in explaining, making, repairing, comparing, and maintaining systems, including Open Source Ecology–inspired projects. Passing a lesson is never authorization to undertake hazardous work.

The organizing structure is a **graph of assessable competencies**, not grades or a compulsory sequence. The learning experience is an **unfolding book** with optional practice, discovery, workshops, personal notes and badges. The corpus is maintained by **independent language and subject communities**, not by one central application vendor.

### Measures of success

- Learners independently demonstrate, retain, and transfer useful knowledge.
- A person, including a pre-reader, can begin without internet, an account, or another service.
- An experienced adult reaches the boundary of *available* content without being treated like a child, and can revisit that same content to teach someone else.
- A contributor can correct one item, record one word, or translate one page without learning software development.
- An independent community can publish and maintain an edition without original-project infrastructure.
- The public corpus remains attributable, repairable, exportable and useful long after its original generators or maintainers disappear.

## 2. Non-negotiable educational principles

1. **Every participant is a learner.** Age and presentation preference do not determine difficulty. An educator also learns; a subject expert may be a novice in another domain.
2. **Errors are informative, never punitive.** Wrong answers are corrected honestly and gently. No lost lives, negative grades, forfeited badges, punitive streaks or shame.
3. **Mastery means evidence.** Independent answers across varied items, delayed retrieval and transfer matter more than seat time, speed or content consumption.
4. **No single global level.** Competence in reading, arithmetic, biology or another language can differ. Unassessed is not failed.
5. **A graph is not a gate maze.** Hard prerequisites have reasons; learners can preview, branch, skip, return and follow curiosity. Literacy is not a universal prerequisite for visual mathematics.
6. **Concrete and abstract reinforce one another.** Pictures, sound, quantities, physical objects, stories, models, and symbols are alternatives and companions.
7. **Learning is individual and can be shared.** Two people can explore a page or project together, while independently earned evidence stays attributed to the correct person.
8. **The book teaches, not only tests.** An engaging question may lead to explanation, a story, a worked example, a project or a surprising tangent.
9. **The teacher's edition is a lens, not a separate knowledge hierarchy.** Worked solutions, misconceptions, conversation prompts and extensions attach to the same concepts and item revisions.
10. **Accessibility is structural.** Pre-readers, adult beginners, differing motor and sensory abilities, multiple scripts and oral-first learning must be representable without attributing interface difficulty to intelligence.
11. **Language communities lead their own education.** UI localization, instructional adaptation, audio and original content are different kinds of work. English is not the canonical source language.
12. **Truth matters.** Multiple creative solutions may be valid; objectively incorrect arithmetic is still corrected. Uncertainty and editorial status must not be concealed.
13. **Physical-world capability is the destination.** Screen exercises lead toward observation, inquiry, craft, health, environmental care, repair, collaboration and systems thinking.
14. **Local first, private by default.** No required login, cloud inference, remote profile, analytics, or online audio playback. Learner history is not part of the public commons.
15. **Achievements belong to learners.** A merit badge is earned and stored locally. Making it verifiable, signing it, exporting it, and publishing it are optional separate actions.
16. **Communities can fork and survive.** Editable source repositories and offline packages work independently of a central index, publisher, database, object store or company.
17. **Provenance follows public knowledge.** Content can be traced to its original and revised sources, tools, models, human actions and review decisions without turning the learner application into an auditing console.
18. **Human participation is an opportunity, not a publication bottleneck.** Verifiably correct, low-risk AI-produced materials can ship at an honest automated-validation state. Humans can review, correct, replace and promote them later.

## 3. The social model

Open Learning Commons is a *project people contribute to*, not a subscription learning platform. The project publishes formats, reference code, starter material, templates, validators and governance examples. Language communities own their educational editions and publishing decisions. The default learner never needs to know Git exists; the default contributor never needs a paid account.

There is no mandatory central approval. A project-operated pack directory or reference review badge may help people discover trusted editions but must not become the sole authority. Trust claims should be explicit and community-scoped. A cryptographic signature proves control of a key, not the quality of a lesson.

One person might translate the navigation, another record pronunciations, another review geometry illustrations, and a parent might flag a questionable explanation during a lesson. Each is a meaningful contribution. Public editorial histories must never include private learner evidence without a separate explicit, authorized act.

---

# Part II — Products, boundaries and architecture

## 4. Three products, one open format

| Component | Primary person | Responsibility | Required for ordinary offline learning? |
| --- | --- | --- | --- |
| **Learner** (reference app) | Anyone studying, alone or with someone | Read/play the book, conduct exercises, adapt, keep personal data and local badges, report problems | **Yes** (or another conforming reader) |
| **Pack tools** (CLI/library) | Publishers, Daylight, power contributors | Validate and compile Git-friendly source into pinned, portable offline releases; install/verify; create provenance receipts | **Only at build time** |
| **Contributor Workbench** (later separate desktop application) | Speakers, educators, authors, reviewers, maintainers | Browse contextual source, edit/translate/record/review, preview, validate and submit changes to community Git repositories | **No** |

A future contributor editor may reuse the Learner renderer and assessment previews. It does not need a second educational engine. Both applications share schemas and pack-reading code, but they have separate workflows and permissions.

**Boundary:** The learner may include a tiny `Report a problem` or `Suggest improvement` affordance that records the content revision and an optional note. It does not expose Git authoring, approval, forensic logs, issue triage, model evaluations, or a full editorial dashboard. The Workbench imports those reports and performs the heavy work.

## 5. Baseline technical decisions

These are implementation defaults for Daylight rather than immutable community mandates:

| Decision | v0.7 baseline | Reason |
| --- | --- | --- |
| Trusted pack pipeline | Rust library and CLI | Deterministic inputs, well-bounded parsing, safe offline installation |
| Learner desktop reference | Tauri + web-based UI | Local app distribution while reusing the educational renderer |
| Learner data | SQLite, local device | Portable, durable, private attempts and achievements |
| Source-of-truth curriculum | Human-readable files in Git repositories | Fork, review, reproduce and distribute without hosted dependency |
| Source metadata | TOML or other schema-validated representation as fixed by ADR | Readable authoring; Workbench shields nontechnical contributors |
| Canonical digests | SHA-256 over specified canonical records/bytes | Stable references and historical interpretation |
| Compiled release | Deterministic ZIP with manifest and complete required offline asset closure | Ordinary portable artifact, USB-friendly |
| Starter media | Small, redistributable, pinned media in Git | Clone/source installer works without Git LFS or remote fetch |
| Large media | Community-chosen archival and content-addressed storage; Wikimedia imports where suitable | No required R2/B2 or any central provider |
| Runtime AI | Not required; prohibited from core assessment correctness | Offline, predictable cost, reproducible exercises |
| Pack operations | CLI first; optional generated MCP adapter | Avoid duplicating logic; Daylight can invoke CLI immediately |
| Contributor workflows | Separate Tauri desktop Workbench, backed by local repositories | Accessible Git-mediated community participation without hosting a platform |

Start with one implementation monorepo and an independent `olc-pack-example` repository. A future independent community pack must be able to fork and diverge without editing the application. Code and protocols should not assume GitHub; GitHub/GitLab/Forgejo/Codeberg adapters and portable patch submission may arrive incrementally.

A proposed Rust workspace has `olc-schema`, `olc-store`, `olc-graph`, `olc-items`, `olc-pack`, `olc-learner`, `olc-engine`, `olc-cli`, with optional `olc-mcp`, `olc-media` and a Workbench application added as warranted. Dependencies form an enforced directed acyclic layering. Use checked arithmetic, bounded parsing, safe archive extraction, versioned migrations, descriptive errors and regression tests for untrusted input.

## 6. Keep public content, private learning and editorial tooling separate

**Public material:** competency definitions, approved/released content revisions, language files, media manifests, licenses, model-generation receipts, review decisions, release attestations and published corrections. Lives in community-controlled Git and media archives; ships as bounded metadata in packs.

**Private learner material:** profiles, attempts, assistance received, competency evidence and derived state, notebooks, questions, private projects, badges and guardian relationship grants. Lives in local SQLite and optional learner-controlled exports. It is never submitted automatically with reports or contributions.

**Contributor working material:** local Git checkout, draft edits, translation candidates, recording previews, unpublished reviewer comments, private token/key storage, upstream/downstream merge requests and optional offline patch bundles. Lives in the Workbench's own workspace and the contributor's selected repositories; no mandated central service.

**Installed pack material:** immutable versioned manifests, exercise definitions, approved local audio/media and minimal public provenance. A local content-addressed cache may deduplicate media; full factory logs and cross-model debates do not need to ship to every learner.

The learning UI must work with a pack after all other computers and hosted services have been switched off.

---

# Part III — First complete slice and AI content model

## 7. The first educational slice

**The initial target is not an entire curriculum. It is one polished, complete learning pathway.** The reference demonstration is *number sense to ten* for a pre-reader, with an age-neutral presentation option for adults.

A learner enters through the persistent unfolding book, can navigate by section divider, bookmark, index or world search, and can start with shapes and quantity, encounter an illustrated lesson, answer embedded varied questions, receive a clear explanation of a mistake, advance when evidence accumulates, come back for review, and earn a local merit badge. A parent can replay the lesson and see an optional brief explanation of what it teaches. A learner can flag a bad item. The pack, learner history, correction and new release all function offline.

**M1 scope (approximately 12–20 narrowly defined nodes, finalized as source data):** shape/visual discrimination; same/different; small subitizing; one-to-one correspondence; stable count sequence to ten; cardinality; matching counts to numerals; more/fewer/equal; composing small groups; simple visual patterns; and transfer between pictures, objects, and symbols. Some nodes may be combined or split based on genuinely distinct evidence, not an arbitrary node target.

The initial corpus should include enough parameter variety to avoid memorization, with a proposed planning target of at least twelve independently constructed items or item seeds for each active node, multiple representations for important nodes, and non-identical delayed checks. Those numbers are provisional capacity targets, not a psychometric claim or a reason to delay a useful smaller end-to-end demo.

**Required experience:**

1. Open an installed application with no network and choose or create a local profile.
2. Encounter an illustrated, non-textual introduction, with optional narration and touch/mouse/keyboard-equivalent controls.
3. Complete a few adaptive probes; correct answers increase challenge, uncertain answers produce varied clarifications, and skipped items cause no penalty.
4. Read or hear at least one short unfolding-book page with a worked visual demonstration, not just a sequence of quizzes.
5. Demonstrate a meaningful cluster of count-to-ten competencies through independent varied responses; receive a local **Number Explorer**-type badge without a signing key or account.
6. Return in a later session for a spaced check. If understanding has weakened, further practice appears without taking away earned badges.
7. Use a simple `Something's wrong` control to flag an exact item revision; keep the report private until an authorized export.
8. Install a corrected pack offline; preserve old evidence records, account for invalidated items during mastery recomputation, and continue learning.

**Adult path:** An adult may select an age-neutral visual style and answer skip-ahead probes. Because M1 only ships a narrow foundation, reaching its ceiling is reported as *end of available material*, not “all of mathematics mastered.” A future larger corpus should allow a genuine rapid diagnosis of advanced boundaries. An adult can open the same node with a concise teacher-note view.

## 8. AI generation: the first corpus, not a hidden tutor

Daylight is the initial content producer. It generates structured lesson text, bounded question specifications, deterministic artwork descriptions, candidate hints, explanations, and build-time synthetic narration. No learner-runtime LLM is necessary for any exercise. The generation toolchain writes ordinary community-editable source into the example pack repository.

**Generate a family of questions, not a fixed list of plausible-looking answers.** The item schema declares the mathematical or logical model from which the answer is computed. A deterministic solver/verifier establishes the answer and validates every rendered option. The learner may see many surface realizations, but the mathematical truth is not supplied solely by an LLM's confidence.

Prioritize the following in order of evidence strength:

| Content class | Machine-verifiable method | Initial publishing policy |
| --- | --- | --- |
| Bounded number sense, arithmetic, numeral matching | Executable reference solver, property tests, random and boundary cases | Suitable for automated publication after complete checks |
| Introductory geometry and spatial relations | Canonical vector geometry, geometric predicates, generated test coordinates, transform invariants | Suitable where semantic truth is derived from the scene model |
| Visual matching, grouping, ordering and patterns | Declarative scene graph and explicit generative rule; independently computed labels | Suitable after accessibility/ambiguity checks |
| Measurement and unit conversion | Dimensional checks, exact rational arithmetic when possible, numerical tolerance policy | Suitable after domain and presentation checks |
| Controlled vocabulary and word-to-image links | Versioned lexical sense/source, unambiguous curated referent sets, independent semantic review or restricted usage | Not automatically “proved” by spellchecking or model agreement |
| Freeform reading comprehension, cultural narratives, health, science explanations | No general sound automatic proof of meaning, pedagogy, safety or cultural fitness | Draftable by AI; human-reviewed before authoritative high-confidence claims or high-risk use |

**Geometry and visuals:** Prefer programmatic SVG and a typed scene description with ground-truth labels. A prompt-generated picture with an LLM-assigned answer is not automatically verifiable merely because two models agree. Test distractors, ambiguous overlaps, occlusion, color-only distinctions, object spacing and input hitboxes. Render visuals in a way that remains comprehensible without color vision or high precision motor control.

**Vocabulary:** A word can have multiple senses, translations and contextual meanings. Each vocabulary assessment must identify the lexical sense and locale and distinguish a lexical-source citation from proof of an item's unique correct answer. Use human contribution and review particularly early for phonics, regional vocabulary and speech-dependent contrast. Keep any synthetic narration tagged, with pronunciation-critical instruction blocked until suitable human validation.

**AI authoring transparency:** An item is labeled as AI-generated even when its arithmetic is mechanically established. Algorithmically established correctness is narrower than curricular validity, pedagogical quality, language appropriateness, or accessibility. A source file and its compiled record must not imply those dimensions were human-reviewed.

## 9. Interaction primitives

The initial six potential primitives are:

| Primitive | Learner action | Scoring baseline |
| --- | --- | --- |
| `tap-match` | Select a matching object, shape, word or quantity | Explicit correct target(s), independently checked |
| `order-sequence` | Arrange a few items in a defined order | Canonical order, explicit partial credit if useful |
| `count-tap` | Count/select K objects or choose the matching numeral | Executable quantity model |
| `listen-pick` | Listen and choose among visual or textual options | Transcript/audio/meaning aligned; strict language checks |
| `type-answer` | Enter a number, word or short answer | Normalized accepted set or symbolic solver |
| `choose-explanation` | Choose the best explanation among alternatives | Subject/semantic review; not assumed proven by structure alone |

M1 need only implement the primitives its real slice uses well: likely `tap-match`, `count-tap` and `order-sequence`; `listen-pick` is included only where the audio is fit for purpose. The schemas reserve all six, but an unfinished renderer is never advertised as supported. Add new primitives only when a concrete learning objective cannot be taught reasonably with the current set.

**Do not constrain the future curriculum to machine-gradable multiple choice.** The graph and evidence system must be capable of representing open responses, explanations, physical demonstrations, experiments, story compositions and educator attestations. Those classes may ship later and need not be automatically scored.

## 10. Content-generator contract

A generation request specifies **one bounded work unit**: `(competency revision, item primitive, locale/variety, difficulty or representation constraints, item-count/seed, provenance context)`.

The output is declarative source with:

- Stable item identity, target competency, difficulty parameters and locale.
- Scene/exercise inputs and any deterministic parameter generator or finite valid parameter set.
- Machine-computable solution specification, answer set and distractor rules.
- Required media references, accessibility alternatives and input options.
- Helpful feedback for correct, incorrect, partial and skipped interactions.
- Tags for suspected misconceptions, assisted completion and alternate representations.
- Model and run receipts recorded automatically by Daylight; additional source and rights lineage where applicable.
- Public validation state and optional human review state, never a self-declared upgrade.

**Three separate validation questions:**

1. **Is the artifact well-formed and safe to install?** Schema, asset presence, dependency closure, license metadata, bounded rendering and malicious-input checks.
2. **Is the answer provably right for this generated instance?** Independent executable solver, parameter-space tests, distractor checks, and repeatability. For bounded families, exhaustively check the parameter space where practical; otherwise document tested bounds and uncovered cases.
3. **Does it actually teach the intended competency fairly and clearly?** Distinct question needing editorial and empirical learning evidence. Automatic checks can flag risks, not prove all pedagogy.

**Independence:** The authoring model must not be the only judge of its own answers. Use code-derived ground truth and validators as the strongest evidence. Independent model critique can be an advisory signal for semantic content but is not mathematical proof or a substitute for human review. Validation receipts are written by the validator, not authored as unchecked claims in a generated file.

A regression corpus should contain incorrect keys, multiple-valid-answer distractors, misleading count illustrations, ambiguous vocabulary senses, inaccessible color-only questions and valid alternate solutions. Every discovered defect adds a fixture.

---
# Part IV — The learner experience

## 11. The unfolding book — normative learner interaction contract

**Design source:** Two photographed hand-drawn sheets titled “OLC Design notes,” dated 19 October 2026. These sketches are design artifacts for the reference implementation. The labels transcribed below are owner intent; proposed mechanics and data shapes beyond the labels are implementation interpretations to validate with the owner.

**Non-negotiable:** The book is the application's primary interface and organizing metaphor, not a selectable theme or a preliminary landing page for a quiz dashboard. M1 must demonstrate the complete foundational interaction grammar of the book with a deliberately small amount of curriculum. Reduce content breadth, not the ambition of the book interaction.

### 11.1 Source-derived design vocabulary

The drawings show or explicitly annotate:

- A persistent open **book spread** occupying most of the screen, with the “separation of pages implied but not enforced”; “paper bookmorphism” is a tactile orientation cue, not a rigid physical-book simulator.
- **Section dividers** on the book's outside edge. Font and color remain open design questions.
- **Bookmarks** emerging from the lower edge, representing saved return points.
- A **menu** including search and export, with additional full-screen menus, activities and utilities.
- A **Select learner** panel.
- A **Geometry** spread with an illustrated plate of shapes on one side and section prose on the other, annotated “illustrated manuscript vibes.”
- A **full-page zoom / reading mode** that can focus on a term or passage.
- A **Badges** view with icons arranged as a visual collection and potential subject or subject-family navigation.
- An **Activity** view (example: “Square”) containing visual answer choices.
- An **Index / Appendix** search view with picture, video, sound and “related” references.
- **World Search:** “lets the learner self answer & assist”; “explore related subjects”; “maximum utopian scholastic.”
- **Export & Print:** print any content; print exercises and forms; support educators providing materials to a student or class.
- A **Learner profile** with graph view, configurable/cozy presentation features, and jump points for exploration and improvement.

Do not infer specific typography, colors, exact gestures, button placement, page-turn animations or badge scarcity mechanics from these sketches. Preserve them as design decisions still to be explored.

### 11.2 The primary composition

### 11.2A Bindings: the same book in different cultural forms

A **binding** is a presentation package that changes the visual character of the book without changing the underlying educational meaning or learner record. A binding may influence page texture, ornaments, tab styling, iconography, illustration framing, cover treatment, page transitions, and typographic defaults. It must **not** change the semantic structure of content, mastery logic, accessibility guarantees, or data formats.

Illustrative examples include:

- **Sketchbook**
- **Magical book**
- **NASA specification book**
- **Three-ring binder notebook**
- **Graph page**
- **Naturalist journal**

Bindings are important for three reasons:

1. They preserve accessibility by separating semantic content from decorative presentation.
2. They create room for communities to contribute culturally meaningful visual forms.
3. They let the first release ship a single default binding while keeping the architecture open to later contributions.

Normative requirements:

- Every binding must render the same semantic page and activity model.
- Every binding must be able to degrade to a low-ornament, high-accessibility presentation.
- No learning capability may depend on a particular binding.
- Bindings are versioned assets that can be packaged, reviewed, and distributed separately from curriculum packs.


On sufficiently wide screens, the reference interface defaults to one framed, two-region **spread**. A soft gutter, paper surfaces and marginal ornaments may imply two pages, but no educational content or interaction may depend on content being partitioned into exactly two fixed-size pages. A semantic spread may contain narrative, media, diagrams and interactive blocks with responsive rearrangement.

- **Book body:** meaningful pages, illustrations, terms, activities and related discoveries. No essential navigation is trapped inside decorative paper texture.
- **Book edges:** subject section tabs provide broad navigation; bookmarks return to user-saved places. The edge apparatus remains legible and operable at common window sizes.
- **Book utilities:** a stable entry to profile selection, search/index, badges, printable exports, settings, and the optional educator lens. Utilities may use overlays or a dedicated reading surface but must return the learner to the same book position.
- **Reading mode:** one region or passage can expand into a distraction-reduced full-width view with reflowable typography, adjustable text scale, and audio controls where content offers narration.
- **Narrow screens:** reflow into a single continuous region. The page relationship remains discoverable, but the interface does not shrink a desktop spread until it becomes unreadable.

Visual requirements: warm, calm, tactile, “illustrated manuscript” and “utopian scholastic” are aesthetic directions. Readability, contrast, alternative text, keyboard control, focus order, pointer sizes, and avoidance of gratuitous animation are functional requirements. No page-turn animation is required for M1.

### 11.3 Semantic page and block grammar

**Page, not question, is the primary authored experience.** Every page has a stable object ID, content revision, locale, competency links, section and topic ancestry, index terms, and optional educator notes. It is authored with semantic blocks and layout hints, not fixed screen coordinates. Renderers choose two-page spread, focused reading, and print arrangements from the same structure.

Required block kinds in the initial schema (not all need rich renderers in M1):

| Kind | Meaning | Minimum rendering commitment |
| --- | --- | --- |
| `prose` | Paragraph, short explanation, narrated text, or story | Accessible, scalable text; optional linked narration |
| `figure` | Image, geometry plate, diagram or illustration | Alt text and inspect/zoom action; captions and credits |
| `term` | Named idea with definition and related context | Indexable, deep-linkable, expandable in reading view |
| `activity` | A learner action or assessment placed within the page | Embedded first; may expand to a focused activity surface; stable item/revision linkage |
| `manipulative` | Exploratory interaction without necessarily scoring mastery | Reversible, keyboard-operable when possible; safe fallback description |
| `related` | Explicit conceptual cross-links | Opens another page, preserves return path |
| `media-reference` | Picture, audio, video or other appendix source | Stable media identity, license and fully offline availability when required |
| `educator-note` | Optional explanation, misconception, prompt or extension | Hidden by default; revealable as a lens on the same content |
| `project` | Observation or real-world making prompt | Does not automatically claim independent mastery from viewing |
| `printable` | Optional print-specific instructions or alternate task | Renderable without cloud services |

M1 must actually render `prose`, `figure`, `term`, `activity`, `related` and a compact `educator-note`. The schema supports the other kinds from the first version to prevent early content generation from baking in a test-only model. Blocks and media have semantic IDs for localization, review, attribution and correction. A source pack may supply alternate blocks for different accessibility needs or languages without changing the conceptual page identity.

**Example conceptual page (illustrative, not yet a ratified schema):**

```json
{
  "schema": "olc.page/v1-draft",
  "id": "org.example.geometry.shapes.first-look",
  "revision": "sha256:<canonical-revision-digest>",
  "section": "geometry",
  "competencies": ["olc.geometry.shapes.identify-square"],
  "title_key": "geometry.shapes.first-look.title",
  "blocks": [
    { "id": "shape-plate", "kind": "figure", "asset": "media:sha256:<image-digest>", "alt_key": "geometry.shape-plate.alt" },
    { "id": "introduction", "kind": "prose", "text_key": "geometry.shapes.first-look.intro" },
    { "id": "square", "kind": "term", "term_id": "olc.geometry.terms.square" },
    { "id": "find-a-square", "kind": "activity", "item_set": "org.example.items.shapes.square" },
    { "id": "branch", "kind": "related", "targets": ["olc.geometry.shapes.rectangle", "olc.math.measure.length"] }
  ],
  "educator_notes": ["org.example.educator.shapes.first-look"],
  "print_profile": "page-plus-activity"
}
```

The first pass of the content generator must produce **coherent pages with embedded activities**, not disconnected question banks pretending to be pages. The deterministic scorer remains bound to its item/rubric revision; page authorship does not loosen answer checking.

### 11.4 Navigation: multiple doors into the same knowledge

A learner can reach content through **section tabs**, **bookmarks**, **table of contents**, **index**, **world search**, **related links**, **badge views**, and **profile/competency graph jump points**. These are alternative projections of the *same underlying indexed content and competency graph*, not disconnected screens with separate navigation state.

- **Section tabs:** named, visibly distinctive subject regions or families. Tabs express organization, not global grade levels. A user can open an advanced subject to browse even if mastery prerequisites have not been demonstrated.
- **Bookmarks:** saved positions and optionally named investigations. A bookmark records stable content identity, selected block/anchor and an available revision fallback; it is private profile data, not public educational content.
- **Index and appendix:** alphabetic and topical term lookup; figures, sound and video references; related topics. Index entries resolve to local downloaded material and disclose gaps honestly.
- **World Search:** learner-initiated, entirely local search across installed content. It prioritizes direct links to passages, definitions, figures and cited assets so the learner can *answer their own question* and browse related subjects. Search may later have an optional local AI synthesis layer, but no model-generated answer or network request is required, and source passages remain accessible.
- **Badges:** a personal visual collection, potentially organized by subject family. Selecting a badge shows criteria, what it represents, and pathways into associated competencies, pages, projects and optional next discoveries. Earn/display/share remain distinct operations.
- **Learner graph:** a personal projection of competency evidence with visible unobserved regions and actionable jump points for exploration or improvement. It is not a public scoreboard, age rank or diagnostic label.

Each navigation entry preserves a **return trail** to the original reading position. There must be a reliable Back/Return action that does not depend on simulated paper physics. Searching or previewing an advanced concept never fabricates mastery evidence.

### 11.5 Embedded activities and focused activity mode

The sketch's “Square” activity may be rendered inline with a prompt and several visual candidates, or temporarily expanded to a focus surface. Both use the same declarative item and scoring engine. A focused activity **returns to its originating passage** without discarding the reader's place.

Inline completion produces gentle feedback within the book. Correct responses may reveal a next passage, a deeper question or a subject branch. Incorrect responses may lead to a hint, an alternate illustration, a demonstration, or a later review; there is no punitive error screen. The learner may continue reading without completing the question when no safety-relevant dependency prevents it.

Answers are never inferred from decorative artwork alone: the item definition declares the exact expected relationship, answer key, alternatives, scoring and accessible text. For shape recognition, validation must account for ambiguous drawings (e.g., a square is also a rectangle mathematically) rather than assuming only the generator's chosen label is ever valid.

### 11.6 Learner identity, educator lens and co-learning

The **Select learner** surface is part of the sketch and must appear in M1. Switching active profiles swaps private reading position, bookmarks, progress, badges, and graph state; the book itself and installed content packs remain shared. It may be visually gentle rather than a login/account flow. At minimum, one adult and one child profile can exist on one offline device without mixing learning records. More complex guardian authorization for inspecting another person's records is a separate later feature; M1 does not expose cross-profile evidence simply because users share the device.

A small **educator lens** is available on the same spread: learning objective, worked explanation or proof, common misconception and one conversation prompt. This is about *the lesson*, not a permit to inspect a learner's private progress. Personal teaching annotations and authorized cross-profile evidence viewing remain separate features.

An adult and child may read the same spread or follow related pages at different depths, changing profiles between independent assessment attempts. The reference app does not need synchronized multiplayer before it supports shared discovery.

### 11.7 Print and export are native views of content

The sketch explicitly requires exporting and printing content, exercises and forms so a teacher can equip a student or class. Treat printing as another renderer of the shared page and item sources, **not** as a screenshot feature. A printable artifact contains legible instructions, media credit/license information where required, writing space when appropriate, and optionally a separate answer key/teacher's edition. An interactive drag task requires a defined printable adaptation rather than a misleading static screenshot.

M1: browser/desktop print stylesheet for book pages and supported visual activities, plus a functioning print-to-PDF/OS-print action where the platform supports it. M2: worksheet and exercise set export, teacher's answer key, selectable coverage, and forms. No login or cloud service is needed. Printable exports must not leak another profile's private learning records.

### 11.8 First-slice interaction walkthrough

A successful M1 demonstration uses this path, all offline:

1. **Select learner.** Choose an existing adult or child profile; the book opens at that profile's saved position.
2. **Open the Geometry section.** The section divider leads to an illustrated spread, not a card-grid dashboard.
3. **Discover a concept.** A shape plate and a brief passage introduce or reinforce `square`; a learner can open the term in full-page reading mode and inspect the figure.
4. **Try an embedded challenge.** Select the specified square from several shapes. The exercise uses a solver-validated item with unambiguous options and accessible descriptions.
5. **Receive non-punitive feedback.** A wrong answer explains the distinction and offers a second representation or another activity; nothing closes the book or confiscates progress.
6. **Follow a branch.** Open a related shape or measurement concept. Return to the original passage with one action; save a bookmark.
7. **Use World Search.** Find `square` or `four sides` in the installed pack and open an indexed lesson or related media item; no network is needed.
8. **Earn and inspect a badge.** The relevant local achievement appears in the personal badge collection. Its criteria can lead back to the underlying pages; it is neither signed nor shared automatically.
9. **Use the educator lens.** Reveal the short teaching note on the same concept and print the passage/worksheet from the installed content.
10. **Switch profiles.** The second learner returns to their own saved position and evidence while sharing the same page definitions.

This can be completed with **one carefully polished chapter and a narrow, mechanically verifiable item bank**. The depth of book navigation is proved before scaling to thousands of pages.

### 11.9 Ownership of decisions and UI testing

Sketch-specified elements—spread, implied gutter, tabs, bookmarks, subject prose with illustration, zoom, badges, activities, index/appendix, world search, print, learner profile and graph—are accepted design inputs. The designer and implementation team must preserve their meaning. Fonts, palette, ornament density, transitions, exact badge layout, search ranking and information hierarchy within menus remain design explorations.

Daylight must not treat the drawings as pixel-perfect targets. Tests should verify state and interaction behavior: book position survives a focused activity; search results deep-link and return; every visible activity has its origin and rubric; page content renders without horizontal overflow or unreadable type at supported sizes; keyboard and touch affordances work; print has an appropriate form; a profile switch never reuses another learner's evidence.

## 12. Rapid discovery and lifelong learning

First contact uses pictures and interaction, not literacy, self-reported grade or an IQ-style global score. Quantity and visual structure can be sampled independently from sound and language. A few confident answers move quickly to harder available probes; an incorrect or skipped answer changes the next question rather than freezing the learner on a level.

The output is a provisional map of *observed, uncertain and unassessed* competencies. Continue updating that map from ordinary study. Never treat failure to understand the interface as proof of inability in the subject.

**Adult friendliness:** The visual theme is separate from difficulty. A returning adult can jump forward and back, take rapid boundary checks, see what remains unassessed and use the same material with a child. M1's first-pack ceiling must be disclosed. The long-term model supports sparse sampling across broad domains and questions as difficult as the available corpus can provide.

**Co-learning:** Two learners may examine the same page, teach each other, undertake a project and share discussion prompts. The first release can support informal co-learning and profile switching rather than an elaborate synchronized session. Once explicit shared sessions exist, assisted/collaborative work and independent performance must be recorded distinctly; do not award independent mastery simply because two people solved something together.

## 13. Evidence, mastery and retention

Every competency carries a derived and revisable understanding state:

`Unobserved → Exploring → Demonstrated → Retained → Transferable`

Track uncertainty, review readiness and assistance separately. These are educationally useful descriptors, **not clinical or psychometric diagnoses**. The initial thresholds are hypotheses that need evaluation with learners.

Initial learning rules:

- Two independent correct demonstrations on meaningfully varied items can establish *provisional demonstrated ability*. Being fast is not a prerequisite. Two questions with the same answer generated from merely cosmetic differences should not count as independent evidence.
- A correct later-session response strengthens *retained*. An unfamiliar representation or real-world application strengthens *transferable*.
- Wrong, partial, guessed, helped and skipped responses have different meanings. All can inform the next teaching step; none subtract earned achievements or force punitive repeats.
- Mistakes reopen related practice and can lower current confidence. Earlier success remains part of the historical record even when a different current estimate is appropriate.
- The scheduler balances due review, the currently interesting subject, accessible frontier items and active projects. Avoid endless repetition, streak coercion, hard timers or fixed age sequences.

**Automated-review policy for the first corpus:** Low-risk, solver-verified items may establish provisional local competency and trigger local badges without a human review prerequisite. Their content metadata remains `AI-generated; deterministically validated; not yet human-reviewed`. For evidence that depends on human interpretation, health/safety, phonological distinctions or another restricted domain, the publication and mastery policy may require qualified review or prohibit automatic assessment.

The content trust level and mastery state are separate: *the learner answered correctly* and *the content was independently reviewed by a human* are different claims. Neither a local mastery estimate nor a local badge is an external qualification.

Persist append-only attempt events containing: local profile ID, competence ID, item/revision and rubric revision, pack digest, presentation variant, response type, correctness and method, assistance, time/sequence, and relevant validation/review status. Derived mastery can be recomputed after an algorithm change or an item retraction without rewriting past attempts. Keep detailed interaction data local.

## 14. Feedback, correction and correction return

A response is either explained, developed or productively revisited. On error, show a grounded hint such as why two collections differ, rather than displaying a punitive score. Change representation if the same misunderstanding continues. The learner may postpone the activity.

Every surfaced item has a small `Something's wrong` affordance. For a pre-reader it is a comprehensible one-tap symbol. The local report stores pack digest, item and revision, optional reason/note, language, and time, but **not** the learner's answers, profile, age, identity, notebook or inferred ability. Reports remain on the machine unless an adult or authorized learner exports/sends them.

The reviewer can correct, replace, dispute or retract the identified revision. A correction produces a new immutable revision; it does not overwrite the older pack. A portable advisory can mark a flawed item as retracted on an offline device and recompute the mastery estimate with its evidence excluded. An earned badge remains as an historical event; the current competency estimate can accurately show a gap requiring a new demonstration. Explain changes when relevant, without implying the learner did something wrong.

For M1, a **manual USB/export-and-import loop** is sufficient. Real-time issue synchronization and centralized moderation are unnecessary. Child-profile export requires an explicit adult-authorization step before data leaves the device; storing no identity in the report is an additional safeguard, not a substitute.

## 15. The educator lens and learning together

Every lesson, item and project schema can attach `TeachingNote` objects referenced by stable content IDs. These are public instructional notes, not personal learner surveillance. The minimum fields are:

1. Learning objective and what the item actually measures.
2. Worked answer, proof or useful explanation.
3. Common misconceptions or interpretation problems.
4. Questions an adult or fellow learner can ask.
5. Alternative representation and a way to connect it to daily life.
6. Extensions, including optional projects and deeper principles.

For M1, ship at least a *small contextual teaching overlay* that reveals the objective, explanation and a suggested conversation prompt. It can be visible to any user who chooses to inspect the teaching notes; a separate role/permission model is not needed merely to explain a lesson.

Later educator features include authorized views of another learner's competency evidence, scoped guardian or mentor relationships, shared sessions, teaching plans, personal private annotations, and side-by-side learner/educator views. Those features must explicitly enforce permissions before exposing personal progress. Being a pack contributor never grants access to learner data.

The design goal is the parent who rediscovers fractions on Monday and uses that knowledge to teach a child on Tuesday—and the child who eventually comes back and teaches the parent something neither initially understood.

## 16. Merit badges

Merit badges represent durable and meaningful personal accomplishments, not a points economy. A badge has a stable definition revision, image, criteria, a short description of what was learned, and a local `AchievementEarned` record referencing minimal evidence. The badge appears in a learner's private collection with optional personal captions and project artifacts.

Examples include `Number Explorer`, `Sound Detective`, `Pattern Finder`, `Story Weaver`, `Seed Keeper`, `Measurement Keeper`, `Repair Apprentice`, and eventually interdisciplinary capstones. M1 implements **one genuine local badge**; multiple badge families can come later.

**These are independent actions:**

1. **Earn:** automatic local achievement, usable entirely offline and without a key, issuer account or service.
2. **Sign or obtain external attestation:** separately chosen, optionally compatible with Open Badges 3.0 and W3C Verifiable Credentials, including clear issuer/trust meaning.
3. **Export or display:** separately chosen decorative image, personal portfolio artifact, signed file or public website display. No publication is implied by signing, and decorative display need not be signed.

Earned badges are never taken away because of a later wrong answer. Local badges may be granted based on honestly labeled, mechanically validated evidence; they must not imply a human-certified qualification. Publicly limited or commemorative editions can exist under community-controlled issuers but may not gate essential education. The default is no public identity or child disclosure.

## 17. Long-term knowledge and project scope

The eventual corpus covers:

| Domain | Essential threads |
| --- | --- |
| Literacy and communication | Phonological awareness, reading, vocabulary, grammar, writing, conversation, storytelling, explanation |
| Mathematics | Quantity, operations, measurement, geometry, fractions, algebra, probability, statistics, modeling |
| Inquiry and reasoning | Logic, pattern, inference, evidence, uncertainty, experiments, source evaluation |
| Health and biology | Bodies, organisms, growth, cells, hygiene, nutrition, sleep, safety, health literacy |
| Ecology and agriculture | Water, soil, food webs, ecosystems, planting, conservation, stewardship |
| Chemistry and materials | Mixtures, reactions, phases, atoms, materials, conservation, hazards |
| Physics and engineering | Motion, forces, energy, fluids, heat, electricity, mechanisms, reliability and repair |
| Human society | Cooperation, conflict, sanitation, shelter, food systems, civic processes, economic reasoning |
| Information and creative practice | Computing, media literacy, data, diagrams, design, art, narrative and making |

Historic examples serve these competencies rather than constituting a separate comprehensive history curriculum.

Open Source Ecology and the Global Village Construction Set provide a motivating collection of applied projects. Example progression: `count containers → measure volume → reason about gravity and pressure → build a supervised water-flow demonstration → understand seals and efficiency → compare pump designs → reason about maintenance and water access`. The graph connects concept → component → subsystem → machine → system → design tradeoff → community consequence. Practical work may require adult supervision, domain expertise and separate safety permissions; passing OLC exercises is never a certification to use dangerous machinery.

---

# Part V — Community packs and languages

## 18. Communities own their source repositories

A language pack is an **ordinary Git repository of educational source**, human-editable files, small starter audio, revisions and licenses. A community may use GitHub, Forgejo, GitLab, Codeberg, a self-hosted server, local Git, exported source archives or offline patches. Git is an editorial storage and collaboration mechanism, not a learner runtime requirement.

The reference project maintains a published manifest/schema, template, validator, pack builder and interoperability examples. It is not the exclusive pack registry, translation source, credential issuer or editorial approver.

A minimal community repository can look like:

```text
olc-pack-es-MX/
├── pack.toml
├── README.md
├── CONTRIBUTING.md
├── LICENSES/
├── graph/                      # language-specific additions or mappings
├── ui/                         # interface localization
├── lessons/                    # instructional pages and teaching notes
├── items/                      # structured assessment source
├── literacy/                   # independent phonology and orthography pathways
├── originals/                  # new stories, projects, examples
├── educator/                   # public pedagogical annotations
├── translations/               # source-revision relationships, terminology
├── audio/
│   ├── index.toml
│   └── starter/                # small, redistributable offline essentials
├── media/
│   ├── sources.toml
│   └── assets.lock.json
├── provenance/
│   ├── runs/
│   └── decisions/
├── governance/
│   ├── review-policy.toml
│   └── maintainers.toml
└── tests/
```

A developer can use the files directly. An ordinary speaker or teacher uses the Workbench to edit them without dealing with TOML, JSON or pull-request mechanics.

## 19. A source-pack manifest

Proposed source manifest (the final schema must make the types and versioning precise):

```toml
schema = "olc.pack-source/v1"
id = "org.example.es-mx"
name = "Aprendizajes iniciales — Español de México"
version = "0.1.0"
type = "complete-starter"

[languages]
ui = ["es-MX"]
instruction = ["es-MX"]
assessment = ["es-MX"]
literacy = ["es-MX"]

[implements]
graphs = ["olc.foundations@1"]

[content]
ui = "./ui"
lessons = "./lessons"
items = "./items"
literacy = "./literacy"
originals = "./originals"
educator = "./educator"

[media]
lockfile = "./media/assets.lock.json"
index = "./audio/index.toml"

[governance]
review_policy = "./governance/review-policy.toml"
review_decisions = "./provenance/decisions"

[build.starter]
entry_points = ["org.example.intro", "olc.math.quantity.count-to-10"]
require_offline_closure = true

[licenses]
assets = "per-asset"
```

The manifest also needs a machine-readable **coverage statement**. It separately reports UI completeness, instructional coverage, item/assessment coverage, audio availability, original content, accessibility alternatives and editorial/validation state per locale/strand. A pack called `ui-only` must not be described as a complete education.

Pack types include `ui-only`, `curriculum-only`, `audio-overlay`, `assessment-overlay`, `complete-starter` and `mixed`, with truthful per-type coverage requirements. Language-specific competency nodes need not cite an English source. Existing shared conceptual competency IDs may be reused across language packs where the assessed capability is actually equivalent; distinct phonological or grammatical competencies remain distinct.

## 20. Language is not a translation toggle

Model `uiLocale`, instructional languages, assessment language, learning-language targets and media/voice languages separately. Use BCP 47 where suitable, plus declared script, variety, orthography, direction and community-preferred name. Handle pluralization, Unicode normalization, right-to-left text, fonts, phoneme systems, typography, captions, speech, multiple voices and oral/signed learning as explicit needs, not deviations from English.

Four separate contribution tracks:

| Track | Examples | Human judgment |
| --- | --- | --- |
| UI | Navigation, buttons, errors, accessibility labels | Can people operate it naturally? |
| Lesson | Explanations, instructions, examples, educator annotations | Is the meaning preserved or adapted appropriately? |
| Audio / signed media | Spoken words, letter sounds, narration, pronunciation, signed video | Is this exact variety and sound pedagogically suitable? |
| Original content | Stories, community knowledge, local projects, new competencies | Does it teach accurately and respect the community? |

Relationship metadata distinguishes `translation`, `adaptation`, `inspired_by` and `original`. Revision changes mark dependents `needs-revalidation` rather than overwriting translations or human work. A machine draft must be marked as such; **a person becomes translator or reviewer of record only by a recorded human act**. Communities decide whether and when to promote AI drafts to reviewed editions.

M1 needs one localized seed, provisionally `en-US` for implementation convenience, *not* a globally canonical language. M2/M3 must demonstrate an independently maintained additional language with its own literacy pathway and human recording.

## 21. Wikimedia-first reuse and media storage

### 21.1 Replaceable media as a community strength

The project should embrace a simple truth: a generated placeholder image that teaches the right idea and can later be replaced by a community drawing, photograph, or better diagram is a *feature*, not a weakness. The first slice may rely heavily on generated illustrations and diagrams where this accelerates useful educational coverage. However, those assets should be treated as replaceable educational artifacts.

This means:

- generated media should be packaged with clear provenance and replaceability;
- communities should be able to swap in local, culturally relevant, or higher-quality media without rewriting the surrounding lesson;
- the same page should support multiple media revisions over time; and
- the contribution workflow should make image and diagram replacement easy for non-programmers via Contributor Workbench.

### 21.2 Community image and diagram contributions

Open Learning Commons should invite contributions such as:

- child or learner artwork illustrating concepts;
- locally meaningful diagrams, field sketches, and specimen drawings;
- educator-improved charts or print materials;
- culturally specific decorative page assets and covers;
- accessible replacements with stronger contrast, cleaner labels, or simplified composition; and
- photographs, maps, or illustrations contributed by community members under compatible licenses.

The specification should prefer media blocks that can be replaced independently of text blocks, while preserving attribution, review state, and pack compatibility.


Wikimedia Commons, Wikidata and Lingua Libre are preferred upstream references for freely reusable visuals, context and pronunciation recordings when content fits their scope and the relevant licenses permit reuse. OLC should not hotlink lesson media during learning or assume that Commons is an unrestricted CDN or a place to upload unrelated project artifacts.

The reusable import sequence is: discover → inspect rights and suitability → identify the exact Commons/file revision → retrieve bytes with API etiquette → compute digest → pin original and derivative hashes → record credit and modifications → bundle required assets in a complete offline pack → permit corrected or withdrawn replacement revisions later.

Keep small essential starter files in Git. Store large audio masters and intermediate media in a community-controlled archive, local filesystem or object storage of that community's choice. Approved public renditions are content-addressed by hash, with optional independent mirrors. Runtime only consumes installed pack assets.

Candidate defaults: FLAC for legally preservable masters; Ogg Opus for small spoken renditions, with codec compatibility and perceptual quality tests where speech distinctions matter. Build-time synthetic narration can bootstrap low-risk lessons; its engine, voice, text, final file hash and synthetic status appear in provenance. **Synthetic speech is not automatically sufficient for phonics**, isolated sound production, stress distinctions, rhymes or other pronunciation-critical assessments; those require suitable human validation before authoritative use.

Consent, rights and licensing are recorded per asset. Child-source voice collection is out of scope of initial public contribution workflows. A public recording's license must not be misrepresented as a license for unrelated voice cloning or AI model training. Openly distributed copies may remain in the world after an author requests withdrawal; disclosure and lawful takedown/correction policies must reflect that reality.

## 22. Compiled pack format and integrity

A release pack is a **deterministic `.zip`** with `manifest.json` at its root and the full transitive closure of materials necessary for its advertised offline pathways. It is not necessary to introduce a special file extension. The archive is a transport artifact; readers install and index its contents locally. Build/release signatures are optional and must be separate from learner badge signing.

### Identity classes

- **Competency ID:** the general assessable capability.
- **Content object ID:** the logical item, lesson, note or media slot.
- **Revision ID/digest:** one immutable definition, answer key and rubric.
- **Blob SHA-256:** one set of bytes, regardless of repository host.
- **Release digest:** identity of one immutable manifest-defined distribution snapshot.

**Precisely avoid self-referential hashes.** The canonical release manifest lists payload members *other than itself* with sorted paths, byte sizes and SHA-256 digests. The release identity is SHA-256 of those canonical manifest bytes. The raw ZIP file may have its own separate transport checksum. Optional detached signatures cover the defined release identity, not a mutable field inside the signed payload. Builds pin source revisions and media blobs; the ZIP writer sorts members, fixes metadata and produces identical bytes on repeat builds when input and toolchain are fixed.

The verifier must reject path traversal, symlinks, unexpectedly executable payloads, nested unsupported archives, decompression bombs, malformed Unicode paths, duplicate names, over-budget allocations, missing dependency closure, unsupported schema versions and broken hashes. Install atomically, support rollback, and retain or reconstruct historical release references needed to interpret saved learning events. The same verifier handles USB, LAN, local file and HTTPS downloads; no vendor SDK is required.

**Signature versus review:** A valid signed pack proves a publisher key approved the release hash; it does not prove each fact is true. A community can operate its own trust policy and signing keys, and a user can install an independently published unindexed pack with an appropriate trust explanation. The root project has no compulsory signing authority.

---

# Part VI — Human contribution without platform dependence

## 23. Contributor Workbench: a separate desktop application

OLC's learner app is optimized for reading, exploring, practicing and developing understanding. It is not a repository manager. The **Contributor Workbench** is a separate optional desktop application, consuming the same public pack schema and preview renderer and operating on Git-backed source repositories through a human interface. Its presence is never required to use, install or share an offline learning pack.

The Workbench shall enable a contributor to:

1. **Open** an existing edition or create one from a starter template, with friendly language names and coverage information.
2. **Browse** by page, competency, subject, term, assessment, audio cue or translation status using the same book preview as learners.
3. **Propose** a correction, translated passage, new voice recording, visual replacement, alternate example, original story or teaching note without editing TOML or operating Git.
4. **Preview** the affected page, activity, print layout and accessibility description in the target language and edition.
5. **Check** mechanical correctness, broken references, required coverage, copyright/license metadata and missing assets; display informative errors and fixes.
6. **Review** a proposed change in its teaching context, including previous revision, authorship/generation provenance, source material and the specific automated checks that passed.
7. **Submit** a change to the community repository as an ordinary pull/merge request through a supported forge integration, or export a portable proposal bundle for an offline/low-connectivity reviewer to import.
8. **Promote or reject** content according to the edition's documented review policy, generating portable review decisions and immutable content revisions.

The Workbench should provide **two interfaces**: a plain contribution mode for ordinary volunteers and a more detailed maintainer mode for repository and release work. Both work with local repositories. No central OLC account, official directory or mandatory online host is assumed. Forge authentication is required only when voluntarily submitting to that forge. For offline communities, import/export bundles remain a complete contribution channel.

The first Workbench milestone must demonstrate a human correcting a factory-generated exercise, inspecting the correction in the book, validating it, and producing a PR or offline bundle. A second demonstration must replace synthetic narration with a consented, reviewed human recording without invalidating historical references to the prior bytes.

## 24. Review, labeling and provenance responsibilities

Separate four different claims:

- **Mechanical validity:** Which objective programmatic checks passed, with their tool and rule versions?
- **Editorial state:** Was the entire revision reviewed by a person, a representative sample checked, or no human review performed? Batch spot-checking is not equivalent to an individual item's approval.
- **Publisher authenticity:** Which community/release key, if any, signed the distribution? A signature does not certify its scientific truth.
- **Learning evidence:** What did this learner demonstrate independently? This is a private local inference, not an editorial review or external educational qualification.

The generation factory, pack validator, contribution Workbench and learner app consume shared identifiers but have distinct responsibilities. Factory/validator receipts are generated by executing infrastructure, not trusted solely because an agent wrote a plausible JSON record. Material edits create new content revisions with source, derivation, rights and credited human contributions. A reviewer can see and correct the lineage without being made to audit every prior model token. The learner sees useful content and, in an optional “About this page” panel, plain-language provenance; the book never requires a provenance ritual before learning can happen.

**First slice policy:** Objective, low-risk, programmatically proven numerical/visual items may appear and contribute provisional mastery even when not yet human-reviewed. Labels do not falsely claim human verification. Ambiguous vocabulary, cultural content, high-stakes health or safety claims, and pronunciation-critical exercises demand higher scrutiny before authoritative use. Publication and evidence eligibility are determined by risk and actual proof type, not just a single tier rank.

An immutable review event records the actor or durable reviewer pseudonym, reviewer qualifications or scope where relevant, the exact revision, decision, evidence considered, and date. Trust in a reviewer is established by communities, not a single mandatory central credential authority. Editors may file corrections or retractions; users may receive signed advisories offline alongside releases, without changing old attempt events. Child learning data must never be included in public editorial history or review PRs.

## 25. Community governance and language sovereignty

The reference organization maintains interoperability specifications, validation tools, examples, documentation and its own optional example editions. Independent language communities maintain their own source repositories, review policies, release keys, mirrors and editorial authority. Some material will be translated; other material will be authored originally in its target language. No locale is merely an adaptation of English.

Four contribution categories are tracked separately: **UI**, **instructional pages and assessments**, **audio or signed media**, and **original content**. Linguistically specific literacy pathways are authored in the relevant language instead of translating English phonics mechanically. A localized curriculum pack describes what it actually covers, what has been human-reviewed, which sounds and accessibility alternatives it contains, and what is missing. A `ui-only` pack may not claim to contain a complete educational edition.

Published source history and release manifests should remain easy to mirror and inspect. Any compatible third-party reader or publisher may implement the declared standards. The root project may recommend or list editions but may not make that listing necessary for functionality. The community's practical measure of success is its ability to teach, repair, distribute and preserve its own knowledge independently.

# Part VII — Daylight implementation plan and acceptance

## 26. Build strategy and interfaces

Daylight may generate and review code at high velocity; durable correctness comes from **small, explicit gates**. Keep one initial monorepo for the Rust core, CLI, Tauri reference reader, schema and examples; keep one independent example language repo to test federation. Agents own bounded implementation tickets and machine-readable validation targets. Graph prerequisites and competency definitions begin with a curated nucleus so automated content generation has an external target against which to prove itself.

A single command catalog backs CLI and UI behavior; MCP bindings may be generated from that catalog when helpful for agent orchestration but must not block the first functioning book. Language-pack creation, build and validation are executable without the Workbench. The Workbench adds human usability to those same stable commands after the slice works.

Factory content lanes generate pages containing a coherent visual/textual explanation plus one or more independently checkable items. A mathematics lane receives a competency and expected answer generator/solver, not a broad instruction to produce plausible quiz text. Generation artifacts record prompts, producer/model metadata, grounding references, validators, output revisions and review status. Review agents do not upgrade content to *human-reviewed*.

For M0/M1, prefer items with executable proofs and strict validity constraints: count K visible objects, compare sets, compose quantities, recognize shapes from unambiguous geometry, order measurable quantities, match a term to a clearly grounded definition, and perform simple visual transformations. Vocabulary requires dictionary/reference or human adjudication when semantic equivalence cannot be shown mechanically. Generated shape questions should avoid false exclusive categories: a square can be a rectangle; open answers must be rubric-aware.

## 27. Milestones

**M0 — Offline pack oracle and book primitives**

- Define stable competency, page, block, item, media, review/provenance and release identities; canonical serialization, hashing and deterministic release manifests.
- Read/verify/install independently published source packs, including offline closure, hostile-archive checks, and source revision consistency.
- Define semantic page/block schemas, navigation links, profile-local reading position and bookmarks, and an accessible responsive two-region book shell.
- Build the independent sample repository under a new namespace on a clean offline machine; verify reproducible output without project infrastructure.
- Build a tiny fixture pack with one illustrated page, one deterministic shape/count activity, a teacher note and one synthetic narration asset. Display it inside the book.

**M1 — Complete first learning chapter**

- Deliver a polished, fully offline **unfolding book** with section tabs, implied page separation, bookmarks, reader/zoom mode, index and World Search across installed content, related-topic navigation and reliable return history.
- Provide profile selection with separated local learner progress, a graph/development view, a visually meaningful local badge collection, and an optional lesson-level educator lens.
- Present at least one coherent early-geometry or counting chapter with illustrated manuscript-style content, automatically generated and mechanically proven item variations, gentle corrective feedback, adaptive progression and a later-session review.
- Activities are embedded in the page, with an optional focused mode returning to the source passage; a learner can read and follow tangents without being forced to finish every item.
- Support usable page printing, including the illustrated page and a supported exercise; do not export private evidence implicitly.
- A wrong-item report is produced locally without personal progress data, exported by an authorized person, fixed in the source repo, and returned as an immutable corrected pack/advisory.
- One genuine personal merit badge is earned and kept without credential signing or publication. The badge links back to the knowledge it represents.

**M2 — First community-editable edition**

- Ship the first Contributor Workbench correction loop: open pack source, preview the lesson in-book, edit, validate, and submit via PR or offline proposal bundle.
- Add community translation, original lesson and audio-replacement workflows, including recorded human review and provenance.
- Extend print/export to exercises, coverage selections, teacher keys and reproducible worksheets and forms.
- Test at least one independent language pack from a community outside the original source repo, with honest coverage and media statements; implement Wikimedia asset import where licensing, API etiquette and attribution permit.

**M3 — Collaborative learning and broad coverage**

- Expand the knowledge graph and content into sustained reading/writing, grammar, scientific inquiry and interdisciplinary foundations.
- Add scoped guardian/mentor access, shared/co-learning sessions and individualized teaching plans while keeping evidence private.
- Evaluate the mastery heuristics, reviewer queue and curriculum effectiveness against learners and educators from different backgrounds and languages.

**M4 — Applied civilization skills and portable credentials**

- Build project pathways from fundamentals into tools, systems, maintenance, design trade-offs and Open Source Ecology-inspired practical work.
- Add optional external attestation/signature, Open Badges/VC-compatible export and learner-controlled public display, without changing local earning semantics.
- Improve federated mirrors, community preservation and long-term standards migrations.

## 28. Normative first-slice tests

The M0/M1 gate is green only when tests demonstrate:

1. Independent offline pack creation, validation, installation and reproducible rebuild without root-project services.
2. Pack rejection for tampering, traversal, decompression abuse, missing assets, invalid licenses, broken references and unsupported versions.
3. A page's content object, embedded item's scoring revision and educator note are independently identifiable and attributable.
4. A wide-window spread and a narrow-window reading surface render the same semantic content in a usable accessible order; the gutter is not a hard layout dependency.
5. Sections, bookmarks, index, World Search, related pages, badges and profile graph lead to real content, with a stable return path.
6. The reader can open a term or figure in zoom/reading mode and return without losing the original position.
7. An activity runs inline or focused; the focused mode returns to its originating passage after completion or dismissal.
8. Wrong answers produce useful explanations and possible future practice, but no punitive loss of badges or time-based reward.
9. Mechanically validated variations have distinct evidence value; duplicates and ambiguous answer keys are detected or refused.
10. AI-generated material carries correct generation provenance and automated validation state; it cannot silently be called human-reviewed.
11. One adult and one child profile can independently navigate the same pack, with separate positions, evidence, bookmarks, graph state and local badges.
12. Selecting a badge opens its definition, evidence summary appropriate for its owner, and related learning pages; no key or account is needed to earn it.
13. Search operates across the installed pack while offline, reports absent material honestly, and produces source-linked results rather than ungrounded answers.
14. A printable page/activity is legible and attributes included source media; printing does not reveal another profile's private learning records.
15. One pre-reader completes a meaningful visual learning encounter without literacy or keyboard requirements; a competent adult can move directly toward the pack's frontier.
16. The learner or authorized adult creates and exports a correction report with only public content identifiers and an optional intentionally supplied explanation.
17. A source revision correction ships as a new release or signed advisory without rewriting old content identities or local attempts.
18. An independent contributor can correct the source pack and make a working offline replacement even if the original service has disappeared.
19. Accessibility checks cover pointer, keyboard, text scaling, alt descriptions, color-contrast, RTL layout fixtures and print behavior.
20. The application never requires network access, cloud AI or a central account for reading, searching, answering, badges or recording mastery.

## 29. Open design decisions

The following are design tasks, not excuses to delay the vertical slice:

- **Book appearance:** precise paper treatment, ornament, typeface families, colors, tab styling, motion and badge iconography. They must serve legibility and the “utopian scholastic” atmosphere.
- **Index/search behavior:** category ranking, synonyms, phonetic/audio search for pre-readers, and multimodal query options beyond the first local text index.
- **Badge cabinet:** whether subject-family icons surround achievements in a radial collection as suggested by the sketch, or another adaptable arrangement. The sketch is a starting hypothesis, not a pixel specification.
- **Profile map:** graph visualization that communicates discoveries and open territory without becoming a discouraging achievement race.
- **Printable adaptations:** the minimum rich-print representation of each interaction primitive and the presentation of teacher keys and worksheets.
- **First-pack scope:** which language variety, exact shapes/counting competencies and illustrations are in the initial curated competency graph.
- **Community stewardship:** reviewer qualifications, contributor license handling, dispute escalation and optional directories maintained by independent organizations.

These choices can be prototyped directly in the reference book. Avoid prematurely standardizing visual styles or tying content packages to one renderer's CSS.

---

**Guiding sentence:** *The application should always know something useful to offer next, while leaving the learner free to discover something else.*

**Community principle:** *Anyone should be able to bring an honest, useful education to their people in their own language, without asking permission.*

**Book principle:** *A learner follows curiosity through an unfolding body of knowledge; tests, badges, search, references and teaching notes are parts of that journey, not competing applications.*

# Part VIII — Design plates and visual references

## 30. Informative interface plates

The following image plates are informative references for implementation and usability review. They do not freeze exact pixel details, but they *do* capture the intended interaction grammar and emotional tone of the application.

### Plate A — Core unfolding book shell
![Plate A — Core unfolding book shell](../design/plates/plate_a_core_book_shell.png)

Shows the main two-page spread, section tabs, bookmarks, top navigation, and embedded activity placement.

### Plate B — Learner selection and entry into the book
![Plate B — Learner selection](../design/plates/plate_b_learner_selection.png)

Shows the inclusive learner model, shared-device profile selection, and book entry flow.

### Plate C — Section spread and explanatory content
![Plate C — Section spread](../design/plates/plate_c_section_spread_geometry.png)

Shows a representative learning spread with explanatory text, examples, discovery notes, and a quick activity.

### Plate D — Full-page reading mode
![Plate D — Reading mode](../design/plates/plate_d_reading_mode.png)

Shows immersive reading, read-aloud, text controls, appearance controls, and contents navigation.

### Plate E — Focused activity mode
![Plate E — Activity mode](../design/plates/plate_e_activity_mode.png)

Shows a contained challenge flow with supportive feedback, hints, and progression indicators.

### Plate F — World search and related pathways
![Plate F — World search](../design/plates/plate_f_world_search.png)

Shows the principle that search is a way to explore the knowledge world, not merely retrieve records.

### Plate G — Index / appendix and media browsing
![Plate G — Index appendix](../design/plates/plate_g_index_appendix.png)

Shows an A–Z/media/topic browsing model that can jump directly back into book pages.

### Plate H — Merit badges and related competencies
![Plate H — Badge collection](../design/plates/plate_h_badges.png)

Shows local earning, display options, and the separation between earning a badge and externally signing or sharing it.

### Plate I — Learner profile and graph
![Plate I — Learner profile](../design/plates/plate_i_profile_graph.png)

Shows the learner graph, progress summary, and improvement frontier framing.

### Plate J — Export and print
![Plate J — Export and print](../design/plates/plate_j_export_print.png)

Shows that printing and export are native views of the same underlying content.

## 31. How to use the plates

These plates are intended to guide the Daylight build in the following ways:

- **Interaction grammar:** which pieces of the interface are primary, persistent, or contextual.
- **Design intent:** a warm, inviting book-like experience rather than a conventional LMS dashboard.
- **Terminology stability:** preserving names like *bindings*, *world search*, *discovery notes*, and *learning graph*.
- **Accessibility review:** each plate should be implemented in a way that preserves semantic content even when ornament, motion, or texture are reduced.
- **Contributor onboarding:** non-technical contributors can point to a plate and discuss how a feature should behave.

## 32. Visual contribution model

The long-term commons should treat visual contributions as first-class educational participation. Examples include:

- a learner replacing a temporary generated sketch with their own drawing;
- a biology community replacing generic diagrams with better specimen plates;
- a local group contributing region-specific photographs or maps;
- a subject enthusiast creating a new binding; and
- an educator improving a printable worksheet or diagram for clarity.

This creates a healthy cycle:

1. placeholder content makes the first version useful;
2. useful software attracts a community;
3. the community replaces weak assets with loved ones;
4. the educational commons becomes richer, more local, and more human over time.

## 33. Open design promise

Open Learning Commons should be architected so that communities can meaningfully replace not only words, but also *the look, feel, and visual substance* of how knowledge is presented. A magical book that helps you explore the world should also be a book that communities can illustrate together.
