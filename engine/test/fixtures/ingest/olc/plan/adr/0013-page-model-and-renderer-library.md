# ADR 0013: The page is the authored unit; the renderer is a library

Status: Accepted (spec v0.8 §4, §11.3). Date: 2026-10-19.

## Decision
- `olc-page` owns the semantic page/block model (ten block kinds, spec §11.3) and page-level
  validators: every `activity` resolves to an item set with a solver; every `figure` has alt
  text and a credit; every `related` target resolves in the pack or is marked absent; every
  `term` is indexable; print profile declared.
- The generator contract produces pages with embedded activities (`gen.page`), never bare
  item banks; `gen.items` exists for refilling an existing page's item set.
- `olc-render` is a web package built into a library crate, consumed by `apps/olc-book`
  (learner) and later by the Contributor Workbench (previews). It never contains engine
  logic and only renders revisions whose `allowed` bit is set.
- Print is a renderer of the same page model, not a screenshot.

## Why
The Workbench "may reuse the renderer" only if the renderer is a package from day one.
