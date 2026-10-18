<h1 align="center">Daylight Software Forge</h1>

<p align="center">
  <b>A local-first workbench for verifying and building software with AI agents.</b><br>
  Agents review code and write changes; tests, sandboxes and digests decide what counts;<br>
  a person makes every call that matters, and every call is on the record.
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Node%20%E2%89%A522.18-3178c6?style=flat-square&logo=typescript">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-bubblewrap%20sandboxes-2f7bf5?style=flat-square&logo=linux">
  <img alt="License: MIT OR Apache-2.0" src="https://img.shields.io/badge/license-MIT%20%2F%20Apache--2.0-3a3a3a?style=flat-square">
  <img alt="Status: P1, mocks only" src="https://img.shields.io/badge/status-P1%2C%20mocks%20only-d69e2e?style=flat-square">
</p>

<p align="center">
  <a href="#why-daylight">Why Daylight</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="#the-walkthrough">Walkthrough</a> ·
  <a href="#how-verification-works">Verification</a> ·
  <a href="#security-posture">Security</a> ·
  <a href="#license">License</a>
</p>

<br>

<table>
  <tr>
    <td width="25%" valign="top">
      <h3>🧪 Evidence over agreement</h3>
      Two agents agreeing is corroboration, not proof. A registered test, run in a sandbox, settles the question.
    </td>
    <td width="25%" valign="top">
      <h3>🔒 Protected gates</h3>
      Gates and holdouts are locked by a person before any author runs. Holdout content never reaches the author.
    </td>
    <td width="25%" valign="top">
      <h3>🧾 Digests on every verdict</h3>
      A verdict is a pure function of the gate results, the diff digest and policy. The same inputs give the same answer.
    </td>
    <td width="25%" valign="top">
      <h3>🙋 A human decides</h3>
      Authorize, lock, approve and apply are human acts with a confirm code, refused inside an agent session.
    </td>
  </tr>
</table>

<br>

## Why Daylight

Agents can now change a codebase faster than anyone can re-read it. The usual answer is to have
another agent check, and to take the two agreeing as a pass. Daylight does not. It treats every
agent claim as a hypothesis, keeps disagreement on the record instead of averaging it away, and
only counts what a test run under a sandbox actually showed.

It started as a map of a codebase (parse everything, find duplication and dead ends
deterministically, let agents attach evidenced claims) and P1 turned it into a forge: protected
specification, then a scoped author workspace, then an independent test, then an approved merge.
Everything lives on your machine, in SQLite files outside the repository.

![The tree view of a 10,000-file monorepo](docs/tree.png)

## What it does

- **Review missions.** A mission is a question about one revision. Independent reviewers, blind
  to each other, file claims with file-and-line evidence. Where they contradict, the dispute
  becomes an experiment: a registered test run twice inside bubblewrap.
- **Implement missions.** Created from an approved work item (or a recorded ad hoc decision) as a
  draft with write off. Only the human act `mission authorize --write` turns write on, and
  `--execute` additionally grants exec.
- **Gates and holdouts.** Both must fail at the base revision before a person locks them. A gate
  that already passes is vacuous and refuses the lock unless accepted by name.
- **Approve and apply.** Only a candidate the gates accepted can be approved, with the verdict
  recomputed at decision time. Apply builds and verifies the commit in a scratch repo, then
  writes a new ref `refs/heads/daylight/<missionId>`. HEAD, the index and the working tree are
  never touched, and no hook runs.
- **Ledger.** Tokens per turn and cost per attempt, by actor, model, mission and work item. Cost
  is `provider`, `stdout-scan` or `none`, and unknown is never printed as `$0.00`. There is no
  price table, and commit trailers carry ids only.
- **Ingester.** Imports Claude Code sessions as `work` missions, storing digests, counts and
  vetted paths, never transcript text. Ingested work is labelled as outside Daylight's controls.
- **Mission Control.** The Electron app: the 3D map, plus screens for work items, implement
  detail, gate sets, candidate review, the ledger and ingest, with a derived "needs you" strip.

![The same monorepo as a dependency graph](docs/graph.png)

## Get started

Linux only for anything that runs agent or test code. You need Node ≥ 22.18 (the `engines`
field; DEMO.md asks for Node 24, which acceptance ran on), pnpm, git, and `bwrap` (bubblewrap) and `prlimit`
(util-linux). Without bubblewrap, `forge run`, `spec decompose` and every experiment fail closed;
nothing runs in the open.

```bash
git clone git@github.com:mackerson/daylight-forge.git daylight
cd daylight
pnpm install
pnpm ui:build
TMPDIR=/tmp pnpm typecheck && TMPDIR=/tmp pnpm test:all   # a short TMPDIR: socket paths must fit in 108 bytes

pnpm gui                     # build the UI and open the app
pnpm view                    # open the app against an already-built UI
```

`daylight` is not linked onto your PATH. From the checkout, `pnpm daylight <command>` works; from
another directory, define `daylight() { node <checkout>/engine/cli.ts "$@"; }`. Every subcommand
honours `--help`, and `node engine/cli.ts help` lists them all.

> [!TIP]
> Keep `<out>` under your home directory (the default is under `${XDG_DATA_HOME:-~/.local/share}/daylight/`).
> An `<out>` under `/tmp` works on a desktop session but is refused over ssh, in CI or under
> `env -i`, because each agent's MCP socket needs a private runtime directory.

## The walkthrough

Nothing here spends money. Every reviewer, decomposer and author is a mock, and the fixture's
defect is **planted** and says so everywhere it appears.

```bash
pnpm demo:prepare --out ~/daylight-demo-out --dest ~/daylight-demo-repo --format json   # prints missionId, experimentId
pnpm daylight experiment run <experimentId> ~/daylight-demo-repo --out ~/daylight-demo-out
DAYLIGHT_DIR=~/daylight-demo-out pnpm view
```

The experiment runs the fixture's red test twice in a sandbox with no network and a read-only
tree, and reports `supported after 2 run(s)`. The Forge path, with mock scripts named by
`DAYLIGHT_MOCK_ADAPTER`, is:

```
map → spec register → spec decompose → work-item approve → mission create --kind implement
    → mission authorize --write → gate add / baseline / lock → forge run → forge candidate
    → forge approve → forge apply → mission close → report --project → mission export / import / replay
```

`engine/test/forge-e2e.ts` runs that whole path on every `pnpm test:all`. The commands, flags,
failure states you can show on purpose, and the five-minute version by screen are in
[docs/daylight/DEMO.md](docs/daylight/DEMO.md).

## How verification works

- **Evidence, not agreement.** A claim without a file and a line is rejected at the boundary.
  Two reviewers that agree corroborate; both can be wrong, and the experiment is what decides.
  The author's own narrative is labelled *author-claimed, unverified* and never feeds the verdict.
- **Protected gates.** Gates and holdouts are registered, shown to fail at the base, and locked
  against a digest of the gate set. The lock refuses a set that moved after the preview. Holdout
  content never reaches the author or the renderer process.
- **Digests.** The verdict is computed from the gate rows, the diff digest and policy alone, and
  is recomputed when a person approves. A mission exports to one file that replays byte-equal on
  another machine.
- **Human decisions through the authenticity guard.** Every decision needs `--confirm <digest8>`:
  run it once without to see exactly what you are confirming. Decisions are refused under
  `CLAUDECODE` or `DAYLIGHT_SESSION` and recorded as `human:<OS user>`. This is a heuristic, not
  authentication: an agent that can compute the digest can compute the code. Signed decisions are
  deferred.

## Security posture

- **Sandbox profiles.** Reviews run under the bwrap `review` profile: repository read-only, no
  `<out>`, one token-checked MCP socket per attempt. Authors run under the `author` profile in a
  detached workspace: write on that tree only, network none, environment cleared, `<out>` and
  `$HOME` never mounted. Experiments and gates run under `prlimit` and `bwrap --unshare-all`.
- **Read-only by default.** Review never writes. Write and exec are explicit, recorded grants on
  an authorize decision; exec is a nested, no-network `run` tool that never sees the gate tests,
  and every call is logged as an `attempt.exec` event.
- **Fail closed.** No bubblewrap, no sandboxed run. A review profile that cannot be built refuses
  the review rather than running it open. Every policy violation, such as an author editing
  `package.json` or the gate directory, is uncurable.
- **No secrets stored.** A credential is recorded as present, its env var name and a label, never
  its value. Transcripts are stored as digests and counts.
- **Redaction tiers.** Logs, artifacts and diffs pass through redaction. High-confidence token
  shapes are masked and make a diff an uncurable `secret-in-diff`. Generic shapes are masked in
  logs and raise a `possible-secret` warning a person must acknowledge. It catches accidents, not
  deliberate obfuscation.

> [!IMPORTANT]
> **Status: P1 complete, with mocks.** Every author, reviewer and decomposer in P1 is a mock; **no
> live provider run has happened yet**. Real providers are `unavailable` for implement until the
> owner authorises one live author run with a dedicated, spend-capped credential, and neither the
> run nor the credential exists. Author exec is in effect since 28b6835 but has not had an
> acceptance run of its own, and nothing real has executed under it. A real-provider review runs
> only with `--unsandboxed-review`, which is P0's unsandboxed path and warns that the reviewer can
> read `<out>` (Sec H5, open). The UI half of acceptance and a visual check of the newest screens
> are still pending. Deferred to P2: egress proxy, Docker/VM profile, repair loops, CI/PR gates,
> model routing, non-Claude authors, signed decisions and gate dependency installs. The full
> record is [docs/daylight/FORGE_REPORT.md](docs/daylight/FORGE_REPORT.md).

## Who built it

A human directed the build and made the owner decisions. A coordinating Fable 5.1 session issued
the rulings and wrote no code. Every merged branch was written by an Opus 5.5 agent and reviewed
adversarially by a separate Fable 5.1 agent working from the code and the rulings: 20 Opus agents
(6,404,876 tokens) and 17 Fable agents (4,387,142 tokens), **10,792,018 tokens** in all, not
counting the coordinating session or the report writer. No dollar figure is given, by ruling. The
itemised ledger is [FORGE_REPORT §11](docs/daylight/FORGE_REPORT.md#11-build-ledger-who-built-what).

The design record is [docs/daylight/FORGE_PLAN.md](docs/daylight/FORGE_PLAN.md) (ADR-8 to
ADR-35). The map's own design history is in [DESIGN.md](DESIGN.md).

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option. Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in this work, as defined in the Apache-2.0 license, shall be dual
licensed as above, without any additional terms or conditions.

<br>

<p align="center">
  <img alt="NOW! That's what I call SLOP!" src="resources/slop.png" width="160">
</p>

<p align="center">
  <sub>
    <b>Full disclosure:</b> a human directed this project, set the goals, made the calls that
    mattered and checked the results; an AI director ran the agent swarm and issued the working
    rulings under those calls. AI agents wrote the code, and other AI agents reviewed it adversarially.
    No human has reviewed the code line by line. The tests, the digests on every verdict, the
    sandbox boundaries and the ledger are how we keep each other honest. Read accordingly.
  </sub>
</p>
