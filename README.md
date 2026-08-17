# visual-desloppify

**A map of a codebase that a person and a swarm of agents can read at the same time.**

It parses everything, draws the shape in 3D, finds the duplication and the dead ends
deterministically, and then lets LLM agents decorate that map with claims — each one carrying
the evidence it was made from, and the name of whoever made it.

![The tree view of a 10,000-file monorepo](docs/tree.png)

---

## Why

Agents now change a codebase faster than anyone can re-read it.

That is not a code-quality problem, it is a **read-back latency** problem. Several agents work
against a shared environment and coordinate through it, so everything depends on how quickly
each of them — and you — can see the shape the code is *now*. When that loop is slow, they
drift: two of them solve the same problem twice, a third builds on something that has already
been replaced, and nobody notices until it is expensive.

So the job is to shorten the loop between *the codebase changed* and *everyone can see the new
shape*. That means one artifact both a person and a machine can read, which is why this is
simultaneously a 3D map and an MCP server.

The design principle underneath it all: **get all the data, then focus it down.** Every
reduction is recorded and reversible, because a summary you cannot expand is just a claim you
have to take on faith.

---

## What you get

**A map you can fly through.** Directories, files, and — on demand — the symbols inside them.
Camera distance is the zoom control for detail: pull back and the leaves collapse into their
directories. Anything too tangled to read, you can drag apart by hand.

![The same monorepo as a dependency graph](docs/graph.png)

Dependencies route *along* the tree to the lowest common ancestor rather than cutting straight
across it, so edges that travel together merge into visible ropes. That is what turns "this
limb's dependencies all leave the subtree" from a number in a report into something you notice
without being told to look for it.

**Six deterministic detectors.** None of them needs a model to *find* anything:

| | finds |
| --- | --- |
| D1 | structures that are the same but for a few fields |
| D2 | duplicate function names across files |
| D3 | the same signature written under four different names |
| D4 | copy-pasted bodies, *after* renaming — it compares shape, not text |
| D5 | two modules described as doing the same job in different words |
| D6 | two files that are the same thing written twice, sharing no copied code |

**A swarm that leaves evidence.** Agents answer the highest-uncertainty questions first, and
every claim goes through one boundary that rejects anything unevidenced. Work is leased so two
agents do not duplicate it, and the run stops when nothing left is worth paying to answer.

**Invariants as a build gate.** Claims about *your* architecture — "the event bus is
storage-only", "nothing under `scene/` calls a randomness source" — written as prose plus a
query, living in the repo they constrain. `vds check` exits non-zero when one goes red.

---

## Why you can believe the output

This is the part that matters, because a map you cannot trust is worse than no map.

**Evidence is required at ingest, not at review.** An agent claim without a file and a line is
rejected at the boundary. Ruling something *out* costs more evidence than asserting it —
finding one place a thing is true is easier than checking everywhere it could have been.

**Disagreement is preserved, never averaged.** When two agents reach opposite conclusions the
map records both, marks the belief CONTRADICTED, and routes it to the top of the queue. The
arbitration screen shows what each side actually read and — the part that matters — whether
they read *the same thing*. Same evidence and opposite conclusions is a judgement call someone
has to make. Different evidence usually means neither looked hard enough.

**It says when it does not know.** On a 10,498-file monorepo it reported 10,485 dead-code
candidates and then immediately capped every one of them to medium confidence:

> only 1% of files are reachable from 41 entrypoint(s), which usually means entrypoints are
> missing rather than that the rest is dead

Zero high-confidence claims out of ten thousand candidates. A tool that would rather say
"I probably cannot see your entrypoints" than hand you a confident list of things to delete.

**It is measured, not asserted.** Similarity thresholds are calibrated against a repository
whose history contains a known deduplication — found before, quiet after. When the measurement
said a threshold could not reach a duplication a human sees at a glance, that got written down
as a limitation rather than tuned away.

---

## What it has found

On a 10,498-file / 245,214-symbol / 2M-line monorepo, in about a minute:

- **6,519** copy-pasted function bodies, and **317** file pairs that are the same thing written
  twice under different names
- **2,476** duplication families — grouped so one adjudication settles a family rather than
  each pair
- **21** import cycles and **103** subtrees whose dependencies mostly leave the subtree

On its own source it reports **0** copy-pasted bodies and **0** parallel implementations, with
all 6 invariants green — because every finding it made about itself was fixed. Three of those
were found by the tool and are worth naming: an assertion helper copy-pasted into fifteen test
files, two store methods that were the same 116 tokens, and a nested function matching its own
parent (which turned out to be a defect in the detector, not the code).

---

## Getting started

Needs Node 24+ and pnpm.

```bash
pnpm install

pnpm map <path-to-repo>     # parse, detect, write the map. No agents, nothing spent.
pnpm gui                    # fly through it
```

That is the whole read-only path. Everything below costs money or changes files.

```bash
pnpm agent <repo> --tools claude --batch 5 --max-cost 2.00
```

Sends the highest-uncertainty questions to an agent, which answers through the MCP server.
`--max-cost` is a hard ceiling. `--dry-run` shows what would be asked and spawns nothing.

```bash
pnpm check <repo>           # invariants + target architecture; exit 1 on red. For CI.
pnpm export <repo>          # the committed layer: knowledge + ARCHITECTURE.md
```

**On a laptop with a discrete GPU, use `pnpm gui:dgpu`.** Under Wayland, Chromium renders on
the integrated chip and says nothing about it — 93fps against 143 on the same machine. The
frame meter (the `fps` chip) names whichever GPU actually rendered.

Other useful bits: `pnpm package` builds a portable directory that runs without a checkout;
`pnpm bench` measures frame time headlessly; `pnpm test:all` runs 540 assertions across 23
files.

---

## How it is put together

```
engine/     headless. parse -> detect -> focus -> claims. no DOM, no Electron.
  extract/    TypeScript compiler API behind a Parser interface, content-addressed cache
  detect/     D1-D6, dead code, cycles, limbs, god nodes, communities
  focus/      the L0 -> L3 stack: every elision recorded and reversible
  store/      SQLite claim store — provenance, evidence, contradiction
  mcp/        the boundary every agent writes through
  swarm/      frontier scheduling, leasing, budget ceilings
app/main/     Electron shell. spawns the engine, never analyses anything itself
app/renderer/ React + three.js. geometry only; all reasoning lives in engine/
```

The engine depends on nothing above it, and that is enforced by one of its own invariants.

**Read-only by design.** It generates task packets; it never executes them. The one exception
is writing an invariant into the repo you asked it to, which is a fixed filename, merged rather
than overwritten, and refuses to touch a file it cannot parse.

---

## What it does not do

- **TypeScript and JavaScript only.** The schema is language-neutral and the provider seam is
  real — a second parser is driven end to end in the tests — but adding a real second grammar
  means a dependency decision that has not been made.
- **No type information.** Resolution is syntactic, so an unreferenced export is a *candidate*,
  not a verdict, and the tool says so every time.
- **Stable identity is best-effort.** Claims follow a renamed file by fingerprint matching. A
  file that is split in two is reported as ambiguous and left alone, because guessing would
  attach someone's confirmed knowledge to a file they never looked at.
- **Nothing is auto-resolved.** Contradictions wait for a human. That is the point of them.

Longer rationale, the phase-by-phase history, and every open problem: [DESIGN.md](DESIGN.md).
The working list: [TODO.md](TODO.md).

---

## Reference

| Command | Does |
| --- | --- |
| `pnpm map <repo>` | extract + detect + invariants + focus in one parse. The usual entry point. |
| `pnpm extract <repo>` | L0 graph and findings only |
| `pnpm invariants <repo>` | compile the repo's invariants to L0 queries and run them |
| `pnpm focus <repo>` | rebuild the L1→L2→L3 stack from the claim store |
| `pnpm check <repo>` | invariants + target architecture; exit 1 on red. `--warn-only` to adopt. |
| `pnpm agent <repo>` | drive an agent CLI against the frontier |
| `pnpm plan <repo>` | diff the declared target architecture; writes task packets |
| `pnpm export <repo>` | write the committed layer: `knowledge.json` + `ARCHITECTURE.md` |
| `pnpm import <repo>` | merge someone else's exported knowledge |
| `pnpm adopt <repo>` | review agent-proposed invariants and write the accepted ones |
| `pnpm gui` | build the UI and launch the app |
| `pnpm gui:dgpu` | same, forced onto a discrete GPU (see above) |
| `pnpm gui:dev` | Vite dev server; run `VITE_DEV_SERVER_URL=http://127.0.0.1:5273 pnpm view` beside it |
| `pnpm view` | Electron against an already-built UI |
| `pnpm shot` | render headlessly to a PNG instead of opening a window |
| `pnpm bench` | measure frame time headlessly and print one line |
| `pnpm package` | build a portable directory that runs without a checkout |
| `pnpm calibrate <spec>` | sweep similarity thresholds against labelled fixture points |
| `pnpm test:all` | 540 assertions across 23 files |
| `pnpm typecheck` | `tsc --noEmit` over engine and renderer |

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out <dir>` | `./out` | output directory. One per repository — it refuses to mix two. |
| `--invariants-file <f>` | `<repo>/vds.invariants.json` | where the repo's invariants live |
| `--include-tests` | off | put test files in the map. They are always read for reachability regardless. |
| `--force` | off | overwrite an output directory belonging to a different repo |
| `--max-cost <usd>` | — | hard ceiling on agent spend for the run |
| `--tools <list>` | `claude` | which agent CLIs to drive |
| `--batch <n>` | `5` | frontier questions per agent |
| `--dry-run` | off | show what would be asked; spawn nothing |
| `--depth <n>` | `3` | grouping depth for the Mermaid render |
| `--top <n>` | `15` | rows per console table |

**Invariants belong to the repo being analysed**, not to this tool — they are claims about one
specific architecture, so a built-in set would mark every other codebase stale against facts
that were never about it. A repo with none defined reports `UNPROVEN` rather than failing.

**Vendored bundles are skipped** (over 200KB, or smaller but minified) and counted. Letting one
through wrecks every downstream number: a single committed copy of three.js once contributed
~7,900 symbols to a 24-file repo and buried the real findings.
