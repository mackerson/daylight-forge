# ADR 0002: Layering

Status: Accepted. Date: 2026-10-19.

## Decision
The workspace is a strict layer stack (table in `AGENTS.md`). `cargo xtask layers` enforces
downward-only dependencies from `cargo metadata`, the `//! LAYER: Ln` marker in each crate
root, a banned-prefix list for UI toolkits below L5, and the rule that no library below L5
depends on a model or network client. `SAME_LAYER_ALLOWED` is empty. `DEV_ALLOWED` is empty.

## Why
KitKraft's velocity came in part from agents being unable to take a shortcut across layers;
the check runs in seconds and fails before `cargo build` does.

## Consequences
A new crate needs a `LAYER_TABLE` entry and a row in `AGENTS.md`. Moving a crate needs an
amendment here.

## Amendment 1 (2026-10-19, director): `olc-items` is L1

`olc-page` validators resolve activities to item sets and need the solvers, so `olc-items`
sits below `olc-page`. It depends on `olc-schema` only.
