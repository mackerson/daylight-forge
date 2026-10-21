# OLC benchmark: the answer files

Never part of the corpus. The documents are WS-R14's verbatim fixture (`../olc/`, see its NOTICE);
the manifest, sectioner sidecar and seven seeds are WS-R14's (`../olc-config/`), referenced from
`bench.json`, never copied. This directory holds only what the benchmark adds. The manifest
excludes `plan/execution-plan.md`.

| file | what it is | provenance |
| --- | --- | --- |
| `ground-truth.json` | the 28 M0 build tickets | parsed from `plan/execution-plan.md`'s tables (sha256 in the file) by `parseGroundTruth`, hand-checked row by row; two corrections listed in the file |
| `ir.overlay.json` | the mock IR | 181 records `check: "hand"`, each read against its passage; the rest `check: "mechanical"`, regenerated from the rule in the header and compared in the test |
| `packets.json` | one packet per ground-truth ticket | by construction: ids, scope and prerequisites copied from the ground truth; requirement and obligation records chosen by hand |
| `blueprint.json` | components = lanes, five boundaries | by construction; boundaries from AGENTS.md's layer table, Corpus Foundry external |
| `review.json` | the scripted reviewer's four findings and their dispositions | §11.2 |
| `invariants.json` | the project's invariant tags | offline, privacy, accessibility, federation |
| `bench.json` | document keys, repositories, answer files, the revise / holdout / landing probes | paths relative to this file |
