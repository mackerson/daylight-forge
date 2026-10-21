# ADR 0015: Bindings are packs of type `binding`

Status: Accepted (spec v0.8 §11.2A). Date: 2026-10-19.

## Decision
A binding (tokens, ornaments, frames, tab styling, iconography, cover treatment, type
defaults) is a pack with `type = "binding"`, its own `assets.lock.json`, and no content.
The renderer loads one binding at a time. Two tests gate every binding: it renders the
fixture pack's every block kind; it passes the low-ornament, high-accessibility degrade
check. No learning capability may depend on a binding. The default binding ships in
`apps/olc-book`; it is the first community-contributable artifact.
