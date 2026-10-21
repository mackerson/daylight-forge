# ADR 0011: The first graph is owner-authored; the first chapter is counting with shapes as vocabulary

Status: Proposed — owner confirmation needed on the chapter (errata E3). Date: 2026-10-19.

## Decision
- The nucleus competency graph (`examples/olc-pack-example/graph/`) is written by the owner
  in TOML before any content generation: roughly 12–20 nodes (spec v0.8 §7), hard
  prerequisites, one language (`en-US` provisional).
- Generation lanes receive a competency revision and its solver; they never add nodes.
- Director's recommendation for the single polished M1 chapter: **number sense to ten**,
  with shapes appearing as the illustrated vocabulary of counting items (count the squares,
  order the groups, match the numeral). Rationale: counting has `executable-solver` proofs
  with no category ambiguity; shape identification carries the inclusive-category trap
  (ADR 0005) and should be a second chapter once the fixture is green.

## Why
The graph is the one artifact the validators cannot check. Generating graph and content from
the same machine yields a corpus with nothing to be wrong against.
