# Cargo in the Forge sandbox

How a Rust repository's gates and author builds run inside bubblewrap with no network
(rulings P2-R2, P2-R3, P2-R5). Code: `engine/forge/cargo.ts`, the cargo branch of
`engine/experiment/sandbox.ts` `checkAllowlist`, `engine/forge/gate.ts`. Test:
`engine/test/forge-cargo.ts`.

## The crate snapshot

```
daylight deps snapshot <repo> [--out <dir>]   # on the host, with network; a person runs it
daylight deps status   <repo> [--out <dir>]   # recorded digest, Cargo.lock match, cache sizes
```

`deps snapshot` runs `/usr/bin/cargo fetch --locked` in `<repo>` with `CARGO_HOME` set to a fresh
directory, then moves it to `<out>/cargo/snapshot/` and writes `<out>/cargo/snapshot.json`:

- `digest`: sha256 over a sorted listing of every file under `registry/` and `git/` (relative
  path, size, sha256; a symlink by its target). Cargo's own lock files and last-use database
  beside those two are not part of it.
- `lockDigest`: sha256 of `<repo>/Cargo.lock` at the time of the fetch.
- `createdAt`, `files`, `bytes`, `repo`.

The fetch gets a minimal environment: `PATH=/usr/bin:/bin`, `HOME` and `CARGO_HOME` pointed at
the new snapshot, and any proxy or CA-bundle variables. No registry tokens, no SSH agent, nothing
under the real home directory. The repository's own `.cargo/config.toml` is honoured (source
replacement, vendoring). Refresh means re-running the command; the old snapshot is replaced only
once the new one is complete. A repository with no committed `Cargo.lock` is refused.

Inside the sandbox the snapshot is bound read-only at `/cargo-home` with `CARGO_HOME=/cargo-home`
and `CARGO_NET_OFFLINE=true`. `HOME` stays `/tmp`. The toolchain is the system `/usr/bin/cargo`,
already inside the read-only `/usr` bind; rustup is not used.

A run over a tree whose `Cargo.lock` is not the recorded one is refused with one line naming the
command, for example:

```
Cargo.lock (sha256:0b1c…) does not match the crate snapshot (sha256:9f2e…): run `daylight deps snapshot /src/app --out /…/out`
```

This applies to gate runs (the tree under test), to the author's `run` tool (the workspace), and
to `forge run` itself on a cargo repository when a snapshot is recorded or the mission grants exec.

## Build caches

`<out>/cargo/target/author/` and `<out>/cargo/target/gate/`, created on demand, each bound
read-write at `/cargo-target` (`CARGO_TARGET_DIR`) into its own profile only. A gate never sees the
author cache, and the author's `run` tool never sees the gate cache. Gate runs also set
`CARGO_INCREMENTAL=0`. Both live outside the repository and outside the sandbox's size-capped
`/tmp`. Only these two directories and the snapshot are bound, never `<out>` itself; each bind
passes `mountRefusal` with exactly that directory in `outAllow`.

`forge run` calls `wipeAuthorCache(out)` whenever the candidate it records has any policy
violation, and records a `forge.cargo.author-cache.wiped` event.

The author's `run` tool adds the cargo binds whenever its tree has a `Cargo.toml` at the root.
`/usr/bin/cargo` already passes `checkExecCommand`; the exec sandbox keeps `--unshare-all` with no
network.

## Cargo gates

```
daylight gate add <mission> --role gate|holdout --harness cargo --crate <dir> --test <file.rs> \
  --expect-exit 0 --expect-stdout 'test result: ok.'
```

`--harness` defaults to `node`. It is stored on the experiment row and in the gate's expectation,
so it is covered by the harness digest: changing it is a new harness.

**Where the test goes.** The registered file is one Rust integration test. As for any gate, it is
placed at `.daylight-gates/<x_id>/<basename>`. It is also placed, from the same registered bytes
and under the same rules (no symlink on the path, nothing already there), at
`<crate>/tests/daylight_<x_id>.rs`, where cargo finds it as the integration-test target
`daylight_<x_id>`. `--crate` is the repo-relative directory of the crate that owns it (default `.`,
the root package). Both copies are bound into the sandbox from the runner's memory with
`--ro-bind-data`, and the tree-drift check ignores exactly those two paths. Neither copy is ever
in an author's tree: gates are placed only in fresh gate trees, never in the author workspace.

**Command.** The default is

```
cargo test --offline --workspace --test {test} -- --test-threads=1
```

where `{test}` is the target name `daylight_<x_id>`. A cargo gate's command must keep
`--test {test}`: it runs its own target and nothing else, so the result line counts the gate's
tests only and a failing test elsewhere in the workspace cannot decide it.

**Allowlist.** `cargo test` only, with `--offline`, `--workspace`, `-p`/`--package <name>`,
`--test <name>`, `--lib`, `--locked`, `--frozen`, `--release`, and `--manifest-path` naming a
`Cargo.toml` inside `/work`. After `--`, only `--test-threads=N`. Refused by name: `--config`,
`-Z…`, `--target-dir`, `--artifact-dir`. Anything else, including a bare test-name filter, is
refused.

**Reading the result.** The prediction is the exit code plus the `test result: ok.` marker. Cargo
prints `test result: ok|FAILED. N passed; M failed; …`; N + M is how many tests ran.

| What cargo printed | Run status |
| --- | --- |
| a result line with N + M > 0 | `ran`, matched against the prediction |
| a result line with 0 passed and 0 failed | `invalid`: an empty gate is not evidence |
| no result line, and `error: could not compile … (test "daylight_<x_id>")` | `ran`, a failing gate |
| no result line otherwise (workspace does not build, snapshot incomplete, launch failure) | `invalid` |

The third row is what "the base lacks the function" looks like in Rust: the gate's own test does
not compile against the base. A base that fails to build anywhere else says nothing about the
gate and is `invalid`.

## Limitations

- The gate build cache is shared by every gate run of the project, on the base and on every
  candidate. Cargo's fingerprints, not a fresh build, decide what is reused; a candidate's build
  script runs with that directory writable. The author cache is wiped on a policy violation, the
  gate cache is not.
- The snapshot's digest is checked by `deps status`, not before every run; the snapshot is read-only
  inside the sandbox but a same-uid process on the host can still rewrite it.
- The fetch honours the repository's `.cargo/config.toml` on the host, which can name registries
  and, for a registry that needs one, a credential provider that cargo runs. Read that file before
  snapshotting a repository you do not trust. Private registries and git dependencies that need
  credentials are not supported: none are passed to the fetch.
- A candidate that changes `Cargo.lock` is already a policy violation; one that needs a new crate
  cannot pass its gates until a person applies the change and re-snapshots.
- The sandbox limits are the node ones (60 CPU-seconds per process, 64 MiB per file, 60 s wall
  clock by default). A large workspace needs `--timeout` and possibly higher limits.
- The author brief shows a cargo gate's command with its `--test daylight_<x_id>` target, which does
  not exist in the author's tree.
