# Harbor Ledger: the fixture contract

Harbor Ledger is a made-up port-logistics standard: the second, synthetic corpus of the ingestion benchmark (spec ingestion §11.1, P2-R53 D-e).
Every file in this directory is the output of `buildHarborCorpus()` in `engine/test/lib/synthetic-corpus.ts`; the benchmark regenerates it and compares bytes.

1. **Determinism.** No PRNG, clock or environment: fixed templates and counts. Two runs are byte-identical.
2. **Counts.** Nine clauses (Clause 1–9) with 2–4 sub-clauses each; six amendments (A1–A6); three decision records (DR-01..03); Annex B = 420 rows of
   `| HL-T-nnn | <berth class> | <vessel band> | <rate> | <unit> |`, one section body over 40 KiB (the window split path).
3. **Repository tree.** `lib/ledger/`, `svc/berth/`, `svc/tariff/`, `svc/audit/`, each with `src/` and `tests/`, plus `harbor.toml` at the root. Lanes: `K` → `lib/ledger/`;
   `V` → `svc/berth/` + `svc/tariff/`; `Q` → `svc/audit/`.
4. **Precedence basis.** Clause 1.2: "Where this standard and an amendment disagree, the amendment governs." Decisions are unordered against amendments.
5. **Amendment → clause.** Each amendment opens `Resolution: Clause <m>`. A3 moves Clause 7.2 (audit export) from wave W1 to W2: the scope check's target.
6. **Requirement ids.** `HL-REQ-nnn` is an `enumerated` cross-reference resolving to the list item that defines it in its clause.
7. **Ticket ↔ clause map** (what the IR overlay and the packets encode; `expected/plan.md` is the ground truth, never in the corpus):

| Ticket | Lane | Clauses | Depends on |
| --- | --- | --- | --- |
| W1.K1 | K | Clause 2.1, Clause 2.2, Clause 2.3; DR-01 | — |
| W1.K2 | K | Clause 3.1, Clause 3.2 | K1 |
| W1.V1 | V | Clause 4.1, Clause 4.2 | K1 |
| W1.V2 | V | Clause 5.1, Clause 5.2, Clause 5.3; DR-02 | K2, V1 |
| W1.V3 | V | Clause 6.1 | K1 |
| W1.Q1 | Q | Clause 7.1 | K2 |
| W2.K3 | K | Clause 3.3 | W1.K2 |
| W2.K4 | K | Clause 9.1, Clause 9.2 | K3 |
| W2.V4 | V | Clause 6.2; DR-03 | W1.V3, W1.V2 |
| W2.V5 | V | Clause 6.3 | V4 |
| W2.Q2 | Q | Clause 7.2 | W1.Q1 |
| W2.Q3 | Q | Clause 8.1, Clause 8.2 | Q2 |

Invariant tags: `safety`, `auditability`. Seeds: one of each of the six kinds (`expected/seeds.json`). The IR overlay is complete (`check: "generated"`),
written by the generator beside the text it quotes; the mechanical rule in its header finds nothing left over.
