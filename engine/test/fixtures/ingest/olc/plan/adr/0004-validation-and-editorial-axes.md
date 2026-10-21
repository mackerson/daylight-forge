# ADR 0004: Two axes, not one tier — validation state, editorial state, and surfacing policy

Status: Accepted. Supersedes spec v0.6 D4 (single tier ladder). Implements v0.8 §13, §24.
Date: 2026-10-19. Amended 2026-10-19 (pre-kickoff correction C2: evidence eligibility is
risk- and proof-specific, not a blanket editorial prerequisite).

## Decision
Every `ContentRevision` carries two independent fields:

- `validation`: `{ proof_kind, checks_passed[], tool_versions, report: RevisionDigest }`.
  `proof_kind` ∈ `executable-solver | scene-graph | lexical-source | model-critique-only | none`.
- `editorial_state` ∈ `none | sample | full`, changed only by a `ReviewDecision` with scope
  `sample` or `full` recorded by a human act. Side states `disputed` and `retracted` are
  set by advisories or decisions.

Surfacing is data: `governance/surfacing-policy.json` maps
`(strand_risk, proof_kind, editorial_state) -> allow | deny`.

Reference minimums that a publisher may raise but not lower:

| strand_risk | requirement to surface |
| --- | --- |
| `health-safety` (health, safety, consent, physical-machine) | `editorial_state = full` |
| `phoneme-contrast` | `editorial_state = full` **and** no synthetic audio |
| `lexical` (vocabulary, word–image) | `proof_kind ∈ {lexical-source}` with `editorial_state ≥ sample`, or `full` |
| `objective` (number, geometry, patterns, measurement) | `proof_kind ∈ {executable-solver, scene-graph}` |
| `narrative` (stories, explanations, cultural) | `editorial_state ≥ sample` for authoritative claims; may surface at `none` when the page marks it `provisional` |

## Surfacing versus evidence

Two separate decisions, both carried as data in `governance/surfacing-policy.json`:

- **Eligible to surface** (`rules`, the table above): may a learner see this revision?
- **Eligible to count as evidence** (`evidence`): may an independent, unassisted correct
  response on this revision contribute to a mastery transition?

Surfacing never implies evidence eligibility, and `editorial_state` is **not** a blanket
prerequisite for evidence. Spec §13 ("Automated-review policy for the first corpus") and §24
("First slice policy") are authoritative: low-risk, solver-verified items may establish
provisional local mastery and trigger local badges without a human review prerequisite.

A revision with `editorial_state = none` is evidence-eligible when **all** of these hold:

1. Its `strand_risk` is `objective`: low-risk and approved for objective, mechanically
   verified assessment. `health-safety`, `phoneme-contrast`, `lexical` and `narrative` never
   qualify at `none`; naming any additional low-risk strand is an owner decision (AGENTS.md
   "Owner decisions"), not a publisher override.
2. It passed the applicable independent mechanical validators (`validation.checks_passed`).
3. Its `proof_kind` is `executable-solver` or `scene-graph`. `proof_kind` is computed by
   `olc validate` from the solver that proved the *presented* item (M0.I1), never read from
   the file. `scene-graph` is written only when the scene-fidelity check passes, i.e. the
   rendered scene corresponds to the machine-validated description; a generated image that
   is merely tagged `scene-graph` gets `none`. A proof of a disconnected answer key proves
   nothing about the item.
4. It is not in side state `disputed` or `retracted`.

`model-critique-only` and `none` are never evidence-eligible in any strand; critique does not
substitute for proof (ADR 0009).

The learner-side rules of spec §13 apply on top: the response is independent and unassisted,
and the varied-item and retention rules hold (cosmetic variants of one item count once).
What the learner reaches is **provisional local mastery** and **local, unsigned** merit
badges. That is not a claim of human-reviewed curriculum, external accreditation, permanent
retention or certification, and the About panel still reads "AI-generated, mechanically
validated, not yet human-reviewed."

For every other strand, evidence eligibility requires at least what surfacing requires
**and** `editorial_state ≥ sample` (`health-safety` and `phoneme-contrast`: `full`, and
`phoneme-contrast` additionally no synthetic audio). A solver pass never changes
`editorial_state`; tiers are not upgraded by code.

Retraction: when an advisory retracts a revision, `olc-learner` recomputes mastery from the
remaining eligible evidence. Raw attempt events and previously earned local badge records are
preserved (spec §13, §16).

## Why
A single rank collapsed "a solver proved this" and "a person read this" into one number.
v0.8 §24 is right that they are different claims; this ADR makes them two fields and one
policy file so the installer, not the UI, enforces them.

## Consequences
- `olc pack build` refuses a revision missing either field.
- `olc pack verify` refuses a policy that lowers a reference minimum.
- The installer writes two bits per revision from two separate evaluations: `allowed`
  (from `rules`) and `evidence_eligible` (from `evidence`). `olc-render` reads `allowed`;
  `olc-learner` reads `evidence_eligible` and never consults `editorial_state` directly.
- M0.P2 tests the two decisions separately; M0.L3 tests mastery against the bit.
- Adult/educator views show the plain-language state ("AI-written; arithmetic checked by a
  solver; not yet read by a person"). Child views show nothing.
