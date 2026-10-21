# ADR 0007: One monorepo plus exactly one example pack repo

Status: Accepted (spec v0.6 D2, v0.8 §5). Date: 2026-10-19.

## Decision
`olc` (this repo) holds the Rust workspace, apps, xtask, docs and plan. The example language
pack lives in `examples/olc-pack-example/` until M0.P5, when it is extracted to its own
repository `olc-pack-example` under a different namespace (`org.example`). From then on the
gate clones it read-only to run the oracle. No other repo exists until a community asks.

## Why
The federation oracle ("a fork builds without the reference repo") needs a second repo to
prove itself against, and no more than one.
