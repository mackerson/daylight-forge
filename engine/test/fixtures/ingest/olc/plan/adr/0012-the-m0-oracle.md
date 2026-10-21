# ADR 0012: The M0 oracle

Status: Accepted. Date: 2026-10-19.

## Decision
M0 is done when, on a clean machine with no network:

1. `olc validate examples/olc-pack-example` passes.
2. `olc pack build examples/olc-pack-example --profile starter --offline` produces a release
   whose digest equals `tests/release.digest` in that pack.
3. `olc pack verify` rejects every fixture under `tests/fixtures/hostile/` (tampered byte,
   traversal, bomb, symlink, duplicate, cycle, dangling dep, missing validation field,
   policy below reference minimum) with a typed error naming the member.
4. `olc pack install` then `olc pack rollback` leave the cache and the learner DB consistent.
5. A copy of the pack repo under a new namespace builds and installs without the `olc` repo
   present (only the `olc` binary).
6. `report.create` offline → `report.export` yields a bundle containing only public
   identifiers; `advisory.apply` retracts a revision and `mastery_estimates` recompute.

The gate (`cargo xtask ci` step 5) runs 1 and 2 on every integration. 3–6 are
`cargo test --workspace` tests under `olc-pack` and `olc-learner`.

## Why
Unattended velocity comes from cheap, unforgiving, mechanical checks. Everything in M0 that
is not one of these six becomes a ticket under M1.
