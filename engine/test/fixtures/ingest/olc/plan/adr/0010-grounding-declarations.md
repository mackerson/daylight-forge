# ADR 0010: Grounding declarations on generated explanations

Status: Accepted (spec v0.6 D9). Date: 2026-10-19.

## Decision
Every generated `prose`, `term`, `educator-note` or `choose-explanation` revision carries
`grounding[]`, each entry one of:
- `derivation { solver, inputs }` — the validator can execute it;
- `reference { source_id, digest, locator }` — a pinned open reference, bytes hashed at
  generation time;
- `unsourced`.

`unsourced` caps `editorial_state` eligibility: it may surface only where ADR 0004 allows
`none`, and a reviewer cannot set `full` on it without first attaching a grounding.

## Consequences
`prompts/` templates must emit the field; `olc validate` fails a generated revision without
it. Reviewers check that the declared reference exists and says what is claimed; they do
not re-derive the pedagogy.
