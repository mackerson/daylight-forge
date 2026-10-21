# Harbor Ledger delivery plan (ground truth)

Test data: the plan a person wrote from the Harbor Ledger Standard. Never part of the corpus.

## Lanes

| Lane | Name | Owns |
| --- | --- | --- |
| K | Ledger | `lib/ledger/` |
| V | Port services | `svc/berth/`, `svc/tariff/` |
| Q | Audit | `svc/audit/` |

## Wave W1

| ID | Task | Depends on | Paths | Done when |
| -- | ---- | ---------- | ----- | --------- |
| W1.K1 | Ledger record format (Clause 2.1, Clause 2.2, Clause 2.3) | — | `lib/ledger/src/record.rs` | The clauses' requirements have passing tests |
| W1.K2 | Append-only ledger store (Clause 3.1, Clause 3.2) | K1 | `lib/ledger/src/store.rs`, `lib/ledger/tests/store.rs` | The clauses' requirements have passing tests |
| W1.V1 | Berth registry (Clause 4.1, Clause 4.2) | K1 | `svc/berth/src/registry.rs` | The clauses' requirements have passing tests |
| W1.V2 | Berth allocation (Clause 5.1, Clause 5.2, Clause 5.3) | K2, V1 | `svc/berth/src/allocate.rs`, `svc/berth/tests/allocate.rs` | The clauses' requirements have passing tests |
| W1.V3 | Tariff table loader (Clause 6.1) | K1 | `svc/tariff/src/table.rs` | The clauses' requirements have passing tests |
| W1.Q1 | Audit event capture (Clause 7.1) | K2 | `svc/audit/src/events.rs` | The clauses' requirements have passing tests |

## Wave W2

| ID | Task | Depends on | Paths | Done when |
| -- | ---- | ---------- | ----- | --------- |
| W2.K3 | Ledger compaction (Clause 3.3) | W1.K2 | `lib/ledger/src/compact.rs` | The clauses' requirements have passing tests |
| W2.K4 | Ledger verification (Clause 9.1, Clause 9.2) | K3 | `lib/ledger/src/verify.rs`, `lib/ledger/tests/verify.rs` | The clauses' requirements have passing tests |
| W2.V4 | Rate calculation (Clause 6.2) | W1.V3, W1.V2 | `svc/tariff/src/rate.rs`, `svc/tariff/tests/rate.rs` | The clauses' requirements have passing tests |
| W2.V5 | Invoicing (Clause 6.3) | V4 | `svc/tariff/src/invoice.rs` | The clauses' requirements have passing tests |
| W2.Q2 | Audit export (Clause 7.2) | W1.Q1 | `svc/audit/src/export.rs` | The clauses' requirements have passing tests |
| W2.Q3 | Audit retention (Clause 8.1, Clause 8.2) | Q2 | `svc/audit/src/retention.rs`, `svc/audit/tests/retention.rs` | The clauses' requirements have passing tests |
