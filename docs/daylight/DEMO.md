# Daylight P0 — operator guide

How to set up a clean machine, run the guided demonstration, show the failure states on
purpose, and say honestly what is recorded and what is not.

## What is and is not recorded

**There is no recorded two-reviewer run yet.** Every reviewer in the automated tests is a mock,
labelled `mock` in every artifact it produces. A recording of real models reviewing the fixture
can only come from an authorised live run (below), because it spends money through the
operator's `claude` and `codex` accounts. Until that run has been made, `pnpm demo:replay` has
nothing to play, and the Mission Control screen says so rather than animating anything
synthetic. The sample data behind `DAYLIGHT_MISSION_SAMPLE=1` exists for screenshots and is
labelled **SAMPLE DATA** on screen; it is never offered as a recording.

The fixture repository is **planted**. `fixtures/daylight-demo/DEFECT.md` names the file, the
lines, the mechanism and the fix. The sentence "PLANTED — this defect was placed deliberately
for the Daylight demonstration and is not an independently discovered production defect"
travels verbatim into the mission objective, the experiment hypothesis, the report and the
screens.

## Cold start

Needs Node 24+, pnpm, git, and for experiments `bwrap` (bubblewrap) and `prlimit`
(util-linux). Without the last two every experiment concludes `invalid: sandbox unavailable`;
nothing runs in the open.

```bash
pnpm install
pnpm ui:build
pnpm typecheck && pnpm test:all        # ~1,200 assertions; includes the acceptance checklist
```

## The guided demo, in order

1. **Prepare.** Materialises the fixture as a git repository at the pinned commit
   `b57b1c8c436a`, maps it, creates an *explore* mission scoped to `src/session-cache.ts`,
   and registers the fixture's own red test as the experiment (prediction: exit 1).
   ```bash
   pnpm demo:prepare --out /tmp/daylight-demo-out --dest /tmp/daylight-demo-repo --format json
   ```
   Without `--out` and `--dest`, both go under `${XDG_DATA_HOME:-~/.local/share}/daylight/`
   and the JSON names the `out` it used; the explicit paths here just keep the commands
   below copyable. Note the `missionId` and `experimentId` it prints. Or press **fixture (PLANTED defect)**
   on the Mission Control screen, which runs the same command.

2. **Open the app on that directory.**
   ```bash
   DAYLIGHT_DIR=/tmp/daylight-demo-out pnpm view          # or pnpm gui to rebuild first
   ```
   The last stage in the strip is **mission control**. Open the mission. The top bar shows
   project id, revision, state (`ready`), and the PLANTED objective.

3. **Review.** Two independent reviewers, blind to each other. Either:
   - *Live* (spends money, see below): roster `claude:sonnet,codex`, ceiling `$2`, press
     **run reviews**; or from a terminal
     ```bash
     pnpm daylight mission run <missionId> /tmp/daylight-demo-repo --out /tmp/daylight-demo-out --tools claude:sonnet,codex --max-cost 2
     ```
   - *Replay* a recording made from a previous live run (**replay recording**, or
     `pnpm demo:replay --out /tmp/daylight-fresh-out --recording <file.json>`).

   Each reviewer is a task; each run is an attempt with its exit code, duration, cost (or
   "cost unknown"), its console and its event stream. Reviews finishing does **not** close the
   mission: it stays `running`.

4. **Dispute.** The compare step is deterministic: it reads the claim store and lists every
   subject in scope where the sources contradict. Open the dispute: each side's source, value,
   confidence and cited lines, readable in place.

5. **Experiment.** Press **run** on the registered experiment (or
   `pnpm daylight experiment run <experimentId> /tmp/daylight-demo-repo --out /tmp/daylight-demo-out`).
   A detached worktree at the pinned commit is created, the registered test is copied in from
   the artifact store (a different file already there is refused), and `node --test` runs twice
   under `prlimit … bwrap --unshare-all …` with no network and the worktree read-only. The
   evidence pane shows conclusion, hypothesis, prediction, revision, harness digest, the exact
   argv, and each run's observed exit code with links to its stdout and stderr artifacts.

6. **Decide.** The decide form takes a value and a rationale and records who decided. It writes
   a human claim (the belief becomes `CONFIRMED`, as it always has for a human) and a
   `Decision` linked to the experiment's result digests. The mission still does not close;
   **close** is a separate, explicit action with an outcome and a reason.

7. **Report and replay.**
   ```bash
   pnpm daylight report <missionId> --out /tmp/daylight-demo-out --file report.md
   pnpm daylight mission export <missionId> --out /tmp/daylight-demo-out --file recording.json
   pnpm demo:replay --out /tmp/daylight-elsewhere-out --recording recording.json --format json
   ```
   The replay reproduces the mission with the same ids, events, artifacts and decision on a
   fresh directory; `inspect` on both agrees byte for byte (except per-directory sequence
   numbers and claim row ids, which are not identity).

## Making the recording (needs authorisation; spends money)

```bash
pnpm demo:prepare --out /tmp/daylight-rec-out --dest /tmp/daylight-rec-repo --format json
pnpm daylight mission run <missionId> /tmp/daylight-rec-repo --out /tmp/daylight-rec-out --tools claude:sonnet,codex --max-cost 2
pnpm daylight experiment run <experimentId> /tmp/daylight-rec-repo --out /tmp/daylight-rec-out
pnpm daylight mission decide <missionId> --out /tmp/daylight-rec-out --subject src/session-cache.ts --predicate bug_verdict --value true --rationale 'The registered test fails at this revision.' --experiment <experimentId>
pnpm daylight mission export <missionId> --out /tmp/daylight-rec-out --file fixtures/daylight-demo/recordings/<date>-sonnet-codex.json
```

A recording is a real run: whatever the models actually said is what replays, including
agreement. If both reviewers agree, the demo still shows two independent, source-linked
reviews and an experiment that settles the question; it does not show a dispute, and the
narrative must say so. The two models may also both be wrong; the experiment is what decides.

## The five-minute version, by screen

1. *Map* — "This is the repository as the static tools see it. Nothing here cost anything."
2. *Mission Control → mission* — "A mission is a question about one revision. Two reviewers,
   different vendors, each read-only, each unable to see the other's answer until both have
   filed. Agreement would corroborate; it is not proof."
3. *Dispute* — "They disagree about whether `get` can serve an expired session. Both cite the
   same lines. That is a judgement call — or it is a testable claim."
4. *Experiment* — "So we test it. The test is registered before it runs and injected into a
   sandbox with no network and a read-only tree. Two runs, exit 1 both times: the hypothesis
   is supported. Here is the command, the revision, the logs."
5. *Decide* — "A person records the decision and why. The mission is still open; closing it is
   its own act. Everything you saw replays on another laptop from one file."

## Failure states you can show without a crash

| State | How to produce it |
| --- | --- |
| Sandbox unavailable | `PATH=/nonexistent pnpm daylight experiment run …` on a machine where that hides `bwrap`; or run on a machine without bubblewrap. Conclusion `invalid`, limitation "sandbox unavailable", nothing spawned. |
| Timed-out reviewer | `pnpm daylight mission run <id> <repo> --out … --tools mock:slow --timeout 2` with `DAYLIGHT_MOCK_ADAPTER` pointing at a script that sleeps (see `engine/test/acceptance.ts`). Mission `blocked`, attempt `timed out`. |
| Failed reviewer | Same with a script that exits 1. Mission `blocked — exit 1`; its stderr is kept, redacted. |
| Budget exhausted | `--max-cost 0.005` with two reviewers that report `$0.01`: the second is not launched; the mission is `blocked` with the spend named. |
| Dirty revision refused | Edit a file in the fixture repo and run the experiment: refused as `invalid`, "not reproducible", because `baseRevision` carries `+dirty`. |
| Tampered test | Propose an experiment whose `--test-path` names a file that already exists with other content: `invalid`, nothing runs. |
| Timed-out experiment | A test that sleeps past `--timeout`: `inconclusive`, status `timeout`, the process is gone. |
| Wrong project | `daylight mission import --file recording.json --out <another repo's out>`: refused, naming both projects. |

## Packaging

`pnpm package` builds a portable directory including the fixture; `./daylight` launches it. Verified
headless on this machine: the packaged app with `DAYLIGHT_DIR` pointing at a prepared directory
renders the mission on the Mission Control stage.
