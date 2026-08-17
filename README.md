# visual-desloppify

> Get all the data, then focus it down.

Static extraction plus an agent swarm that focuses a codebase down to a small map that is actually
true — and keeps checking it stays true. See [DESIGN.md](DESIGN.md) for the architecture and the
decisions behind it.

Outstanding work is sequenced in [TODO.md](TODO.md).

**Status: P0–P9 built.** P6 live map, P8 structural findings and P9 target/plan passed their
gates; P7's convergence gate needs agent spend and has not been run. Original status below.

**Status: P0–P5 built.** Extraction, invariants, the claim store + MCP server, the focus stack, the
agent adapters, and the Electron/three.js viewer. P1, P2 and P5 passed their gate tests; P3 and P4
did not fully — see DESIGN.md → "What the runs actually showed". P6 not started.

## Run it

Requires Node ≥22.18 (native TypeScript type-stripping; there is no build step).

```bash
pnpm install
pnpm gui                 # the app: pick a repo, map it, run agents, arbitrate
```

Or headless:

```bash
pnpm map <repo>          # extract + invariants + focus in one parse → ./out
pnpm view                # just the festooned tree (reads ./out)
```

Then let agents decorate and focus the map:

```bash
pnpm agent <repo> --tools claude              # answer frontier questions
pnpm agent <repo> --tools claude --mode focus # propose clusters / elisions / defences
pnpm focus <repo>                             # rebuild the stack with what they found
```

Everything defaults to `./out`; pass `--out <dir>` to put it elsewhere (then `VDS_DIR=<dir> pnpm view`).

**Invariants belong to the repo being analysed**, not to this tool — they are claims about a specific
architecture, so a fixed built-in set would mark every other codebase stale against facts that were
never about it. Put them in `vds.invariants.json` at the repo root (or pass `--invariants-file`). With
none defined, L3 reports `UNPROVEN` rather than failing. The worked example from the calibration
fixture is in `fixtures/enclave.invariants.json`:

```bash
pnpm invariants <enclave> --invariants-file fixtures/enclave.invariants.json
```

**Vendored bundles are skipped** (>200KB, or smaller but minified) and the count is reported. Letting
one in wrecks every downstream number — a single copy of three.js contributed ~7900 symbols to a
24-file repo and buried the real findings.

| Script | Does |
| --- | --- |
| `pnpm map <repo>` | extract + invariants + focus, single parse — the usual entry point |
| `pnpm extract <repo>` | L0 graph + D1–D3 findings + L1 mermaid only |
| `pnpm invariants <repo>` | compile invariants to L0 queries and run them |
| `pnpm focus <repo>` | rebuild the L1→L2→L3 stack from the claim store |
| `pnpm agent <repo>` | drive an agent CLI; `--tools`, `--mode`, `--batch`, `--model`, `--timeout`, `--dry-run` |
| `pnpm gui` | build the UI and launch the full app |
| `pnpm gui:dev` | Vite dev server; run `VITE_DEV_SERVER_URL=http://127.0.0.1:5273 pnpm view` beside it |
| `pnpm view` | Electron app against an already-built UI |
| `pnpm shot` | render headlessly to `./out/view.png` instead of opening a window |
| `pnpm plan <repo>` | diff the declared target architecture; writes `plan.json` + task packets |
| `pnpm test` | smoke + scene-layout tests against `./out` |
| `pnpm smoke ./out` | claim semantics + MCP boundary tests — costs no agent turns |
| `pnpm typecheck` | `tsc --noEmit` |

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out <dir>` | `<path>/.codemap` | output directory |
| `--depth <n>` | `3` | L1 grouping depth for the Mermaid render |
| `--commit <sha>` | — | record the commit the tree came from |
| `--include-tests` | off | include test files (they duplicate shapes legitimately) |
| `--top <n>` | `15` | rows per console table |

Outputs `graph.json` (L0), `findings.json` (D1–D3, patterns, families) and `map.mmd` (L1 Mermaid).

## What P0 does

**Extract (L0).** Files, symbols, imports, heritage, structure shapes and callable signatures.
Resolution is syntactic: relative specifiers plus `tsconfig` path aliases, everything else marked
external. Asset imports (css, images, fonts) are counted and skipped rather than counted as failures.
Heritage edges are only drawn when the target name is unambiguous — a guess there would be a
fabricated edge, which the design forbids.

**Detect duplication (D1–D3).** All deterministic; no LLM finds anything here.

- **D1 — structure shape.** Jaccard over `(fieldName, type)` sets across interfaces, type aliases and
  classes. Candidates come from an inverted index on field name, so there is no N² matrix.
- **D2 — duplicate function names**, across at least two files.
- **D3 — duplicate signatures**, name-agnostic, informative types only. Without inference an
  un-annotated function is `(any) => any`; that is absence of information, not evidence, so it's
  dropped.

**Families.** Detector links clustered so we adjudicate once per family rather than once per pair. A
link qualifies only if D1 is present, or D2 **and** D3 both are — see DESIGN.md for why unioning on
any single weak link welds the codebase into one blob.

**Patterns.** Oversized D2/D3 groups (`getById` across 19 repositories) are the repository pattern,
not copy-paste. Reclassified as patterns and kept — they are evidence of a shared *role*, and become
input to L2 clustering.

## Parser note

P0 parses with the **TypeScript compiler API**, not tree-sitter, behind the `Parser` interface in
`src/extract/parser.ts`. For a TS/TSX-only milestone it is strictly better: exact JSX handling, no
native or WASM grammar build, and it parses broken files fine. tree-sitter's value is polyglot, which
is explicitly deferred. Swapping it in is a provider add, not a rewrite.

## P0 results on the calibration fixture

Fixture: `enclave` (Electron, ~400 source files, ~127k LOC), three labelled points. Full context in
DESIGN.md → Calibration fixture.

| Fixture | files | symbols | edges | D1 | D2 | D3 | patterns | families |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pre-collapse `2a1645e` | 326 | 6718 | 8346 | 75 | 80 | 73 | 21 | 47 |
| pre-remediation `e946f57` | 395 | 8695 | 10657 | 79 | 85 | 90 | 29 | 47 |
| HEAD `27baaf2` | 404 | 8812 | 10778 | 79 | 85 | 90 | 29 | 47 |

Runs in ~0.3s per fixture. Import resolution 100%, zero diagnostics.

**D1 reproduced the manual swarm's headline finding** on pre-collapse — "several data structures that
were all the same but for a few fields":

```
1.00  row-types.ts#ChannelParticipantRow   ≈  row-types.ts#ChatParticipantRow
1.00  ipc/chatHelpers.ts#PendingApprovalInfo ≈ services/ChatService.ts#CapturedApproval
1.00  repositories/EventRepository.ts#EventTableRow ≈ repositories/row-types.ts#EventRow
1.00  services/BackupService.ts#Snapshot   ≈  shared/types.ts#BackupSnapshot
1.00  sync/DiscoveryService.ts#DiscoveredDevice ≈ shared/ipc-types.ts#SyncDiscoveredDevice
      … plus five renderer-local *NodeData types each duplicating shared/types.ts
0.67  row-types.ts#ChannelRow              ≈  row-types.ts#ChatRow
```

### Two corrections P0 forced on the design

1. **Family clustering.** Unioning on any detector link took transitive closure through common
   signatures and welded 107 unrelated symbols into one "family". Qualification is now D1-alone or
   D2+D3-together. An over-merged family is worse than no family — it hides the real one inside it.
2. **The negative-control criterion.** "Detectors go quiet at HEAD" was wrong. Aggregate counts don't
   move because the tree *grew* 326 → 404 files, and HEAD is only clean of what was actually
   remediated. Of three chat/channel pairs surviving at HEAD, two are documented as deliberate
   ("compat surface", "intentional UX skins") and one — `ChatParticipantRow`, byte-identical to
   `ChannelParticipantRow` and referenced only by its own declaration — is dead residual left behind
   when the `chat_*` tables went away. **It survived both manual sweeps.** The criterion is now
   per-finding triage to documented-deliberate or genuine-residual, never merely unexplained.

## Layout

Three runtimes, not three features — each with its own tsconfig, so the boundaries are
checked rather than merely intended. Declared in `vds.target.json` and verified by
`pnpm plan .`.

```
engine/          headless analysis · Node, type-stripped, no DOM, no bundler
  cli.ts           entry point; runs standalone
  graph/           L0 schema — language-neutral on purpose
  extract/         walk, parse (TS compiler API), resolve, parse cache
  detect/          D1–D3 duplication, structural findings
  focus/           the L1→L2→L3 stack  (types.ts is import-free, shared with the renderer)
  invariants/      compile prose invariants to L0 queries
  plan/            target architecture diff and task packets
  scene/           layout geometry — pure maths, so it belongs here not in the renderer
  store/           claim store  (types.ts is import-free, shared with the renderer)
  swarm/           adapters, driver, frontier
  mcp/             the MCP server agents write through

app/
  main/            Electron main + preload · CommonJS
  renderer/        Chromium · React + three.js via Vite
    lib/           panels, App, renderer-only types

fixtures/        calibration invariants and target for the enclave fixture
```

The engine depends on nothing above it; the renderer shares the engine's type vocabulary
rather than redeclaring it. That last part was not a design decision — the tool found the
duplicate declarations on this repo and scored them at 1.00.

## The app

Five panels plus the scene, all driving the same store:

The scene is the primary surface; the info pane sits on the right, drag the splitter to resize
it (double-click resets), and click the active tab again to collapse it entirely.

- **Scene** — two layouts on one selection. **graph** is the festooned focus stack (what depends
  on what); **tree** is a cone hierarchy over the real path tree, files as leaves, with edges
  hierarchically bundled through their common ancestors (where does this live). `VDS_MODE=tree`
  opens straight into the tree, which is also how the headless screenshots are taken.

  **all levels** is the default: every node visible at once, no popping. LOD was never a
  performance mechanism here — measured on the 449-node fixture it saves 0.14ms against a
  16.7ms frame budget, under 1%, because nodes are instanced (one draw call per level
  regardless of count) and the per-frame CPU work is bounded by screen area rather than tree
  size. Switch to **auto detail** to get distance-driven levels back; it engages automatically
  above 2500 nodes, where the numbers start to matter.

  Hover highlights: a node lights up with its label forced visible, its whole subtree's
  dependencies turn amber, and everything else dims. Hovering a rope highlights just that
  connection and names both ends. Tracing an edge by eye stops working the moment two cross,
  so the view does it.

  Camera: drag orbits, right/middle-drag pans, scroll changes altitude (graph) or depth (tree),
  `WASD` pans, `Q`/`E` moves vertically, `shift` accelerates, `0` recentres. WASD moves the orbit
  *target*, never the camera along its view axis — distance is semantic in both layouts, so flying
  forward would silently change which level you are looking at.
- **Map** — the focus stack, how much of it is actually focused, and any elisions that were
  rejected. The coverage meter is deliberately blunt: an unfocused map is path grouping, which
  is how the code is filed, not what it is for.
- **Findings** — duplication families, D1 pairs with both name and typed scores, and patterns.
- **Review** — the arbitration surface. Contradictions first; pick which claim is right and it
  becomes CONFIRMED, outranking every agent. Evidence citations are clickable.
- **Agents** — jobs with live output, and a stream of every MCP tool call as it lands. That
  stream comes from the MCP server's own event log rather than from parsing four different CLI
  output formats — every agent writes through that one boundary, whichever CLI it is.
- **Invariants** — green/red with the violating spans, or an explanation of why an empty state
  is normal here.

The renderer displays agent-authored text, which is untrusted: `contextIsolation` on,
`nodeIntegration` off, a narrow named-operation preload surface, no navigation, no remote content,
and the renderer served from a contained `app://` scheme.

## Known limitations

- **`codex` cannot be driven headlessly against the MCP server.** It discovers the tools and then
  auto-denies every call (`user cancelled MCP tool call`). `approval_policy="never"` and
  `"on-failure"` do not change it; the only bypass also removes the read-only sandbox, so the
  adapter is left as-is rather than weakened.
- **`grok` and `opencode` register MCP servers persistently.** The driver prints the exact
  `mcp add` command for you to run; it will not mutate your agent config itself.
- **L3 has not converged** to the 8–12 nodes a person can hold — currently 21, of which 7 are
  unfocused path residue.
- Verdict claims collected before the boolean-value rule landed are rejected on re-merge by design;
  they need re-collecting rather than coercing.

## Next

**P6 — target architecture and the plan.** Author the target tree, diff current against it, and emit
the ordered refactor plan plus per-step task packets. The fixture gives a direct test: generate the
collapse plan for `2a1645e` and compare it against the real `collapse-plan.md`.
