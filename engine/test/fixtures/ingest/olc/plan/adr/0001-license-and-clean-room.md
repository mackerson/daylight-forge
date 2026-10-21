# ADR 0001: Licenses and the content clean room

Status: Accepted (owner, spec v0.6 D7, carried into v0.8 §5). Date: 2026-10-19.

## Decision
- Code: MPL-2.0.
- Human-authored curriculum text and human recordings: CC BY-SA 4.0.
- Factory-generated text, items, synthetic audio and generated SVG: CC0 1.0. The copyright
  status of generated work is unsettled; a BY-SA claim on it is weak and would taint the
  share-alike chain for communities.
- Per-asset licenses are recorded in `media/assets.lock.json`; a repo `LICENSE` never
  applies to an imported asset.
- No proprietary curriculum, textbook or assessment bank is read as source for any item.
  Open references used for grounding are pinned by digest (ADR 0010).

## Consequences
Every `ContentRevision` carries a `license` field; `olc validate` fails a pack whose
dependency closure has an incompatible pair. The license split by producer is a field on the
receipt, not a guess at review time.
