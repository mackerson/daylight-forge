# ADR 0005: Six interaction primitives

Status: Accepted (spec v0.8 §9). Date: 2026-10-19. Amended 2026-10-19 (pre-kickoff
correction C1: answer validity is decided by predicate, not label overlap).

## Decision
The item-type surface for M0–M2 is exactly: `tap-match`, `order-sequence`, `count-tap`,
`listen-pick`, `type-answer`, `choose-explanation`. Each has a schema, a solver/scorer, a
mechanical validator set and a print adaptation in `olc-items`. The schema reserves all six;
a renderer that is not finished is not advertised as supported (`status = Deferred`).

M1 implements `tap-match`, `count-tap`, `order-sequence`; `listen-pick` only where audio is
fit for purpose (ADR 0006).

Category semantics are a field: `categories = "exclusive" | "inclusive"`. Answer validity is
decided by the **prompt predicate applied to each presented object**, never by whether the
objects' category labels overlap:

- A shape or classification item declares the predicate its prompt asks
  (`solver.predicate`, e.g. `is-square`, `is-rectangle`), its selection mode
  (`select = "single" | "multiple"`), and for each choice the geometry it actually presents
  (`shape = { kind, sides, equal_sides, right_angles, … }`).
- The solver evaluates the predicate against every choice's declared geometry. A choice
  marked `correct = true` must satisfy it; a choice marked `correct = false` must not. Under
  `select = "single"` exactly one choice may satisfy it; under `select = "multiple"` the
  accepted set is exactly the satisfying choices.
- `categories = "inclusive"` declares that the prompt's category contains other named
  categories (square ⊂ rectangle), so the validator must evaluate geometry. The string
  `rectangle` appearing beside `square` is evidence of nothing, in either direction.

For the square/rectangle pair (errata E1):

- "Which shape is a square?" offering a non-square rectangle is **valid**: that rectangle does
  not satisfy `is-square`, so it is a productive distractor. Plate E is mathematically sound.
  Positive fixture: `crates/items/tests/fixtures/valid/which-shape-is-a-square.toml` must pass.
- "Which shape is a rectangle?" (`select = "single"`) offering both a square and a non-square
  rectangle with only the latter marked correct is **invalid**: two choices satisfy
  `is-rectangle`. Negative fixture:
  `examples/olc-pack-example/items/fixtures/square-is-a-rectangle.toml` must fail with
  `distractor-not-also-correct` naming choice `square` and predicate `is-rectangle`.
- "Select all the rectangles." (`select = "multiple"`) with both marked correct is valid.
  Positive fixture: `crates/items/tests/fixtures/valid/select-all-rectangles.toml` must pass.

The validator for these cases is M0.I2; the fixtures run under M0.I3. Until those land the
expected outcomes above are pinned, not proven.

## Why
"Generate N validated items of primitive P for node C in locale L" is a ticket a lane can own
and a validator can check. Open-ended item types return in M3 with educator attestation.
