# ADR 0009: A validator is never the generator

Status: Accepted (spec v0.8 §10, §26). Date: 2026-10-19.

## Decision
- Mechanical validators are code in `olc-items` / `olc-page` and produce `ValidationReport`
  records signed by tool version, not by an agent's say-so.
- Model-assisted checks record their own `GenerationRun`. `olc validate` refuses a report
  whose `model_id` and `prompt_template` digest both equal those of the generating run.
- Proof outranks critique: `proof_kind = model-critique-only` cannot reach the `objective`
  strand's surfacing requirement and is never eligible to count as mastery evidence in any
  strand (ADR 0004). Critique does not substitute for a mechanical proof.
- Review agents write `request_changes` or `reject`; `approve` is a human act.

## Why
This is the content equivalent of KitKraft's clean room: a rule the Reviewer can enforce from
the receipt without reading the pedagogy.
