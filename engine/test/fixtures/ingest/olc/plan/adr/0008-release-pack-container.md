# ADR 0008: Release pack is a deterministic .zip with a non-self-referential manifest

Status: Accepted (spec v0.8 §22). Date: 2026-10-19.

## Decision
- Container: `.zip`, no custom extension. `manifest.json` at the root.
- Members sorted by path (bytewise), fixed timestamps (the release's declared instant), no
  extra fields, deflate at a fixed level or store; rebuild yields identical bytes.
- The canonical manifest lists every member except itself: path, size, SHA-256. The
  **release digest** is SHA-256 over the canonical (RFC 8785) manifest bytes. The ZIP file's
  own checksum is a transport detail.
- Detached signatures (optional) sign the release digest.
- `olc-zip` reader rejects: path traversal, absolute paths, symlinks, duplicate names,
  non-NFC or control characters in paths, nested archives, executable payloads, declared
  sizes above the manifest, decompression beyond declared size, and total allocation above
  a budget.

## Consequences
`examples/olc-pack-example/tests/release.digest` holds the expected digest and is the M0
oracle (ADR 0012).
