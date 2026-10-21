# ADR 0003: Identity and serialization

Status: Accepted. Date: 2026-10-19.

## Decision
- Publisher namespace: reverse-domain (`org.example`). Object path within: dotted, lowercase,
  `[a-z0-9-]` segments (`olc.math.quantity.count-to-10`).
- Five identities, five newtypes in `olc-schema`, no `From` impls between them:
  `CompetencyId`, `ObjectId`, `RevisionDigest`, `BlobDigest`, `ReleaseDigest`.
- Canonical serialization: RFC 8785 JSON. On-disk authoring format is TOML; it is parsed to
  the model and canonicalized before hashing, so TOML formatting never changes a digest.
- Digest algorithm: SHA-256, rendered `sha256:<hex>`.
- The release digest is SHA-256 of the canonical manifest, which lists every member except
  itself (ADR 0008).

## Consequences
`ObjectId` + `RevisionDigest` is the only valid reference from an attempt event to content.
A Git commit is context, never identity.
