# Errata and resolutions for spec v0.8

This file wins over `open_learning_commons_spec_v0_8.md` where they conflict. Each entry
names the conflict, the resolution, and the ADR or ticket that carries it. Agents without
image input: every entry about a plate is also in `docs/design/plates/plates.toml` under
`known_contradictions`, so you do not need the PNG.

## E1 — Plate E offers "Rectangle" as a distractor to "Identify the Square" (corrected 2026-10-19)

Original reading (withdrawn): that because a square is a rectangle (spec §11.5, §26), a
rectangle cannot be a wrong answer to "which shape is a square," and the plate E item must
fail validation. That reading was false. Every square is a rectangle, but a *non-square*
rectangle does not satisfy the predicate "is a square," so offering it as an incorrect
choice is valid. The plate's activity is mathematically sound and is **not** a contradiction.

The inclusive-category trap runs in the **reverse** direction: a single-select "which shape
is a rectangle?" that offers both a square and a non-square rectangle cannot mark the square
wrong, because two choices satisfy the predicate.

Resolution (ADR 0005, amended): answer validity is decided by the prompt predicate applied
to each presented object's declared geometry, never by label overlap. Items declare
`categories`, `select` and `solver.predicate`. Fixtures:

- `examples/olc-pack-example/items/fixtures/square-is-a-rectangle.toml` — now "Which shape
  is a rectangle?" with the square marked wrong — must **fail** `olc validate` for two
  satisfying choices under `select = "single"`.
- `crates/items/tests/fixtures/valid/which-shape-is-a-square.toml` — plate E as an item —
  must **pass**.
- `crates/items/tests/fixtures/valid/select-all-rectangles.toml` must **pass**.

The plate and its PNG are unchanged; the sidecar entry is corrected. Ticket M0.I2/M0.I3.

## E2 — Plate H shows "LOCKED" badges with padlock glyphs

Conflict: commitments 2 and 16, principle 5, §16: no gating, no punitive framing, badges
never gate content.

Resolution: badge display states are `earned | in-progress | not-yet-explored`. No lock
glyph anywhere in the learner surface. `olc-render` has a test that greps the built assets
for lock iconography class names. Ticket M1.R4.

## E3 — The first polished chapter is named two ways

Conflict: §7 says number sense to ten; §11.8, §27 M1 and the plates say geometry/square.

Resolution: owner decision pending (ADR 0011, Proposed). Director recommendation: counting
is the chapter; shapes are its illustrated vocabulary. Until decided, M0 is unaffected (it
uses a fixture page with one `count-tap` and one `tap-match`). M1.C1 waits on this.

## E4 — Surfacing policy is narrative only

Conflict: §24 says eligibility is "risk and actual proof type, not a single tier rank" but
no data structure carries it; v0.6's `surfacing-policy.json` was dropped.

Resolution: ADR 0004 restores the file keyed by `(strand_risk, proof_kind, editorial_state)`
with reference minimums the installer enforces. Ticket M0.P2.

## E5 — The Workbench "may reuse the renderer"

Conflict: only possible if the renderer is a package, and §5's workspace list has no such
crate.

Resolution: `olc-render` is a library crate from M0 (ADR 0013). `apps/olc-book` is a thin
Tauri host. Tickets M0.S4 (schema), M1.R1 (renderer).

## E6 — World Search has no home in the workspace

Resolution: `olc-index` at L2 (ADR 0002 table). Ticket M1.X1.

## E7 — Bindings are "packaged separately" without a mechanism

Resolution: `type = "binding"` packs (ADR 0015). Ticket M1.B1.

## E8 — The generator contract (§10) is item-shaped while §11.3 says pages are the unit

Resolution: `gen.page` is the primary generation command and `olc-page` carries page-level
validators (ADR 0013). `gen.items` refills an existing page's item set. Ticket M0.S4, M1.G1.

## E9 — M0 includes "an accessible responsive two-region book shell"

Resolution: the shell moves to M1.R1. M0 keeps the page/block schema and renders the fixture
pack through a headless HTML snapshot test (`olc-page`), so the oracle (ADR 0012) stays a
list of commands with fixtures. The shell is M1's first ticket, not M0's last.

## E10 — Header says v0.8 and v0.7

Resolution: the document is v0.8. Cosmetic; fix on the next spec revision.

## E11 — Plate A shows a notification bell

Resolution: nothing in the spec produces notifications and §10/§2 forbid urgency mechanics.
No bell in the learner surface. Sidecar marks it. Ticket M1.R1 acceptance.

## E12 — Plate A's hero chapter is Earth-science prose

Resolution: informative only. That content class is `narrative` and would need
`editorial_state ≥ sample` to make authoritative claims (ADR 0004). The first real chapter
is `objective` strand (ADR 0011). Sidecar marks it.

## E13 — Plate F has an "Ask & Explore" free-text question box

Conflict: §11.4 says no model-generated answer is required and AGENTS.md forbids a
learner-runtime model. A chat box is the one UI element that implies otherwise.

Resolution: omitted through M2. World Search returns source passages, terms, figures and
activities only. Sidecar marks it. Ticket M1.X1 acceptance.

## E14 — Plate I shows a "5 Day Streak" with a flame

Conflict: principle 2 ("no punitive streaks"), v0.5 §10 ("no streak pressure").

Resolution: no streak counters anywhere in the learner surface. `olc-render` test greps for
streak/flame class names alongside the lock test (E2). Ticket M1.R4.

## E15 — Plate I shows a location on the profile card

Conflict: §6 private by default; there is no location field in the profile schema.

Resolution: omitted. The profile schema has `display_name`, `tagline` (optional,
self-written), `presentation_prefs`, `languages`. Ticket M0.L1.

## E16 — Plate J offers "Reports — coverage or progress for students or class"

Conflict: §11.7 says printable exports must not reveal another profile's records; cross-
profile evidence views are M3 behind permissions (§15).

Resolution: no Reports tab through M2. A learner may print their *own* graph in M2
(M2.X3). "Export to Class Folder" becomes "Export to Folder." Sidecar marks it.
