# ADR 0006: Synthetic media is first-class, labeled, build-time only

Status: Accepted (spec v0.6 D6, v0.8 §8, §21). Engine choice: owner-pending.
Date: 2026-10-19.

## Decision
- Starter narration and illustrations may be synthesized at build time. Each synthesized
  blob is pinned by digest in `assets.lock.json` with `synthetic = true`, the engine, voice
  and input text digest recorded.
- The build consumes the pinned blob, never the synthesizer, so builds stay deterministic
  across engine updates.
- `olc-media` is the only crate that may call a synthesis engine; it is a build-time
  dependency of `olc-pack` only and never of `olc-learner`, `olc-render` or any app.
- Phoneme-contrast items (`strand_risk = phoneme-contrast`) never surface on synthetic audio
  (ADR 0004).
- Human recordings replace synthetic ones as new media revisions; the old blob stays
  resolvable for old attempts.

## Owner decision pending
Which engines. The adapter trait ships with a `NullEngine` that fails loudly; the first real
adapter is M1.M1.

## Amendment 1 (2026-10-19, director): engines are external processes

`cargo xtask layers` showed that "no crate reaching `olc-media`" is unenforceable: the book
app needs the engine, the engine needs `olc-pack`, and `pack.build` needs media. The rule
that matters is that **no synthesis engine links into the workspace**. `olc-media` defines a
process contract (`<engine> --text-file <path> --voice <id> --out <path>`, exit code, stderr
JSON) and an adapter that invokes it, pins the output blob by digest, and records engine
id + version in the lockfile. The learner device has no engine binary and `media.synthesize`
is a build-time command. The xtask ban on model/network/synthesis crates below L5 now has no
exemption.
