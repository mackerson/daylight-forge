# Cargo in the Forge sandbox

This page covers how a Rust repository's gates and author builds run inside bubblewrap with no
network. It implements rulings P2-R2, P2-R3, P2-R5, P2-R28, P2-R29 and P2-R30. The code is in
`engine/forge/cargo.ts`, the cargo branch of `checkAllowlist` in `engine/experiment/sandbox.ts`,
`engine/experiment/runner.ts` (`noCargoTestsReported`) and `engine/forge/gate.ts`. The test is
`engine/test/forge-cargo.ts`.

## The crate snapshot

```
daylight deps snapshot <repo> [--out <dir>]   # on the host, with network; a person runs it
daylight deps status   <repo> [--out <dir>]   # recorded digest, verified; Cargo.lock match; cache sizes
```

`deps snapshot` is refused under `CLAUDECODE` or `DAYLIGHT_SESSION`, in one line, before anything
is read: a fetch on the host with network is a person's act (P2-R41). `deps status` and
`deps requests` run in an agent session.

`deps snapshot` checks the repository first. It refuses the repository, before anything is
fetched, when any of these holds:

- `<repo>/.cargo/config.toml` (or the legacy `.cargo/config`) sets a key outside the tolerated set
  (below), is a symlink, or cannot be read;
- a `.cargo/credentials*` file exists;
- a manifest has a `[patch]`;
- a workspace member or a path dependency is outside the repository;
- any dependency comes from git.

`cargo metadata --no-deps --offline` from `/` reads the manifests for these checks.

If the checks pass, it runs `/usr/bin/cargo fetch --locked --manifest-path <repo>/Cargo.toml`
with `cwd: '/'`. Cargo finds its configuration by walking up from the working directory, so
neither the repository's `.cargo/config.toml` nor any ancestor's (for example
`~/.cargo/config.toml` for a repository under `$HOME`) is read. The fetch gets a minimal
environment:

- `PATH=/usr/bin:/bin`;
- `HOME` and `CARGO_HOME` pointed at a fresh staging directory;
- any proxy or CA-bundle variables.

No registry tokens and no SSH agent are passed.

When the fetch finishes, the staging directory becomes `<out>/cargo/snapshot/`, and the command
writes `<out>/cargo/snapshot.json` (record version 2) with these fields:

- `digest`: sha256 over a sorted listing of every entry under the snapshot root (relative path,
  size and sha256 for a file, the target for a symlink). Only cargo's two lock files,
  `.package-cache` and `.package-cache-mutate`, are left out. Anything cargo could read from
  `CARGO_HOME`, configuration included, is covered.
- `lockDigest`: sha256 of `<repo>/Cargo.lock`.
- `createdAt`, `files`, `bytes`, `repo`.

A refresh replaces the snapshot only once the new one is complete. It also removes every gate
build cache, because those were built against the old crates. A repository with no committed
`Cargo.lock` is refused. Build scripts (`build.rs`) are tolerated: they run only inside the
sandbox.

### Tolerated cargo configuration keys

| Tolerated | Example |
| --- | --- |
| `build.rustflags`, `build.rustdocflags`, `build.jobs`, `build.incremental`, `build.target` | `[build] rustflags = [...]` |
| `target.<triple or cfg>.rustflags`, `target.<…>.rustdocflags` | `[target.'cfg(unix)'] rustflags = [...]` |
| `[profile.*]`, `[alias]`, `[term]`, `[cargo-new]`, `[doc]`, `[future-incompat-report]` | |

Every other key is refused. That includes `[registries]`, `[registry]`, `[source]`, `[net]`,
`[http]`, `[credential-alias]`, `build.rustc`, `build.rustc-wrapper`,
`build.rustc-workspace-wrapper`, `build.target-dir`, `target.*.runner`, `target.*.linker`,
`[env]`, `[unstable]` and `[patch]`, and anything cargo adds later. The reader understands
tables, dotted keys and one level of inline table. A file it cannot read is refused.

### Using the snapshot

Inside the sandbox the snapshot is bound read-only at `/cargo-home`, with
`CARGO_HOME=/cargo-home` and `CARGO_NET_OFFLINE=true`. `HOME` stays `/tmp`. The toolchain is the
system `/usr/bin/cargo`, already inside the read-only `/usr` bind; rustup is not used.

**Verified before every use.** Before every gate run and every launch of the author's `run`
tool, `cargoMounts` checks three things and refuses with one line naming the command when any
fails:

- no `config*` or `credentials*` entry exists at the snapshot root;
- the whole snapshot still hashes to the recorded digest;
- `<out>` is not inside the repository.

`deps status` makes the same check.

A run over a tree whose `Cargo.lock` is not the recorded one is refused with one line naming the
command. This applies to:

- gate runs (the tree under test);
- the author's `run` tool (the workspace);
- `forge run` itself on a cargo repository, when a snapshot is recorded or the mission grants
  exec.

What the `run` tool tells the author names no host path: `<out>`, `<repo>` and `/work` stand in
for them.

## Build caches

Each cache is bound read-write at `/cargo-target` (`CARGO_TARGET_DIR`) into its own runs only.

| Cache | Path | Written by | Lifetime |
| --- | --- | --- | --- |
| Author | `<out>/cargo/target/author/` | the author's `run` tool | wiped by `forge run` whenever the candidate it records has a policy violation (`forge.cargo.author-cache.wiped` event) |
| Gate base | `<out>/cargo/target/gate/base/` | baseline runs only | removed on snapshot refresh |
| Gate candidate | `<out>/cargo/target/gate/<diffDigest16>/` | one candidate's gate runs | created at the start of `evaluate` as a copy of `gate/base/` (`cp -a --reflink=auto`: metadata-only on btrfs/XFS, a plain copy elsewhere); removed when `evaluate` ends |

Nothing one candidate's build writes is visible to another candidate or to the next baseline.
Gate runs also set `CARGO_INCREMENTAL=0`. A gate never sees the author cache, and the author never
sees a gate cache. Every bind passes `mountRefusal` with exactly that directory in `outAllow`.
`outAllow` passes over only Daylight's own home directories (`~/.local/share/daylight`,
`~/.config/daylight`), never an `<out>` under `~/.ssh` or another credential store, and never an
`<out>` that is `$HOME` itself.

## Cargo gates

```
daylight gate add <mission> --role gate|holdout --harness cargo --crate <dir> --test <file.rs> \
  --expect-exit 0 --expect-stdout 'test result: ok.'
```

`--harness` defaults to the project policy's `gate.harness`, else `cargo` when its `languages` is `["rust"]`, else `node` ([POLICY.md](POLICY.md)). It is stored on the experiment row and in the gate's expectation,
so it is covered by the harness digest: changing it makes a new harness.

### Where the test goes

The registered file is one Rust integration test. It is placed in two places, from the same
registered bytes and under the same rules (no symlink on the path, nothing already there):

- at `.daylight-gates/<x_id>/<basename>`, as for any gate;
- at `<crate>/tests/daylight_<x_id>.rs`, where cargo finds it as the integration-test target
  `daylight_<x_id>`. `--crate` is the repo-relative directory of the crate that owns the test
  (default `.`, the root package).

Both copies are bound into the sandbox from the runner's memory with `--ro-bind-data`, and the
tree-drift check ignores exactly those two paths. Neither copy is ever in an author's tree. The
author brief shows the command with the target replaced by `<the gate's registered test>`.

### Command

The default command is:

```
cargo test --offline --workspace --test {test} -- --test-threads=1
```

`{test}` is the target name `daylight_<x_id>`. The command must carry exactly one `--test`, and it
must be `--test {test}`.

**What a gate covers.** `cargo test --workspace --test <target>` compiles and runs only the package
that owns the target, its dependencies and that one test binary. So a cargo gate judges whether
its crate builds and its test passes. It does not judge whether the rest of the workspace builds:
a candidate that breaks a crate the gate's crate does not depend on can still pass the gate. A
workspace-wide build is not a gate property; write a gate in that crate if it matters.

### Allowlist

`cargo test` only, with these flags:

- `--offline`, `--workspace`, `--lib`, `--locked`, `--frozen`, `--release`;
- `-p`/`--package <name>` and at most one `--test <name>`, where a name matches
  `^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$` and is never option-shaped;
- `--manifest-path`, naming a `Cargo.toml` inside `/work`;
- after `--`, only `--test-threads=N`.

Refused by name: `--config`, `-Z…`, `--target-dir`, `--artifact-dir`. Anything else is refused,
including a bare test-name filter.

**Preflight on the tree under test.** Before cargo runs, the tree's `.cargo/config*` must pass the
same tolerated-key check as the snapshot, because cargo reads it inside the sandbox (cwd `/work`).
Its `Cargo.lock` must also match the snapshot. Either failure is `invalid`, and nothing runs.

### Limits

Unless the caller names its own, a cargo gate gets these defaults:

| Limit | Default |
| --- | --- |
| CPU per process | 900 s |
| File size | 2 GiB |
| Memory (cgroup) | 4 GiB |
| Tasks | 512 |
| Wall clock | 600 s |

`--timeout` reaches gate evaluation from `gate baseline|evaluate`, `forge evaluate` and
`forge run`.

### Reading the result

The prediction is the exit code plus the `test result: ok.` marker.

| What the run showed | Run status |
| --- | --- |
| cargo killed by a signal, or stderr shows a resource kill (`SIGXCPU`, `SIGXFSZ`, `SIGKILL`, `signal: 9/24/25`, `File size limit exceeded`, a failed allocation) | `invalid`: a limit is not a failing gate |
| no binary ran, `error: could not compile … (test "daylight_<x_id>")`, a rustc `error[…]:` diagnostic and a `--> …tests/daylight_<x_id>.rs:L:C` location | `ran`: the gate's own test does not compile against this tree, a failing gate |
| no binary ran, anything else (workspace does not build, snapshot incomplete, linker failure, launch failure) | `invalid` |
| stderr does not show exactly one `Running tests/daylight_<x_id>.rs (` line (two binaries, a `[[test]]` entry giving the name to another file) | `invalid` |
| the placed test ran and printed exactly one `test result: … N passed; M failed` line with N + M > 0 | `ran`, matched against the prediction |
| that line says 0 passed and 0 failed, or no result line at all | `invalid`: an empty or unfinished gate is not evidence |

The second row is what "the base lacks the function" looks like in Rust.

### Gates that run cargo

A regression gate sometimes has to run a cargo subcommand itself, for example to check that
`cargo test --workspace`, `cargo fmt --check` or `cargo clippy` still passes (P2-R16: a cargo
gate's test invokes what it needs). Such a gate is one integration test that spawns cargo.

**Echoing the nested output makes the gate `invalid`, by design.** The result is read only when
stderr shows exactly one `Running tests/daylight_<x_id>.rs (` line and stdout exactly one
`test result:` line (P2-R30). A nested `cargo test` prints its own `Running …` and
`test result: …` lines. If the gate prints them (through `--nocapture`, or by putting the nested
output in a panic message, which libtest prints when the test fails), the outer run shows more
than one of each and cannot be read. A failing step then reads as `invalid` instead of
`falsified`. This stays strict: a reader that guessed which line was the gate's own would also
accept a forged one.

Write the gate so that it captures the nested run and summarises it:

- spawn cargo with `Command::output()`, never inheriting stdout or stderr;
- assert on the exit status, and on failure print a summary: the failing test names and cargo's
  `error` lines, without any `Running` or `test result:` line;
- give the nested run its own target directory under `CARGO_TARGET_DIR`, because the outer
  `cargo test` holds the lock on its own;
- set an environment variable on the nested run and return at once when it is set, because the
  nested `cargo test --workspace` builds and runs the gate's own placed test too;
- pass `--offline`. Inside the sandbox `CARGO_HOME` is the read-only snapshot and there is no
  network.

The worked example is `fixtures/cargo-workspace/gates/workspace_tests.rs`, a regression gate over
`cargo test --workspace`. `engine/test/forge-cargo.ts` baselines it as `supported` at the
fixture's base, `falsified` once a unit test in the workspace fails, and shows that the same gate
reads as `invalid` when it echoes the nested output instead. The core of it:

```rust
let out = Command::new(env!("CARGO"))
    .args(["test", "--offline", "--workspace"])
    .current_dir(root)
    .env(NESTED, "1")
    .env("CARGO_TARGET_DIR", &target)
    .output();
match out {
    Ok(o) if o.status.success() => {}
    Ok(o) => panic!("nested cargo test failed ({}):\n{}", o.status, summary(&o.stdout, &o.stderr)),
    Err(e) => panic!("could not start cargo: {e}"),
}
```

Each `cargo fmt --check` or `cargo clippy` step follows the same pattern, one gate per step, so
that a failure names the step. A tool that is not in the sandbox (`/usr` is the host's, read-only)
fails to start, and the gate reports that as a failure.

## Limitations

- A gate's test calls the candidate's code in its own process. That code can write to the real
  stdout and exit 0 before the harness prints its result, which a node gate is equally exposed
  to. Policy keeps the candidate from changing manifests and cargo configuration (WS-R4); the
  harness checks above do not depend on it.
- Build scripts run inside the sandbox with the candidate's own gate cache writable. They can
  shape that candidate's build, and nothing beyond it.
- The gate sandbox's root tmpfs (`/etc`, `/`) is writable inside the sandbox. This predates
  cargo: the exec sandbox remounts `/` read-only and the gate sandbox does not. It is in-sandbox
  only, but a build script can fill it outside the `/tmp` size cap.
- Private registries and git dependencies are not supported: no credentials are passed to the
  fetch, and git dependencies are refused.
- A candidate that changes `Cargo.lock` is already a policy violation. One that needs a new crate
  cannot pass its gates until a person applies the change and re-snapshots.
- `forge-cargo.ts` fetches `itoa 1.0.11` from crates.io once per run. Set `DAYLIGHT_OFFLINE=1`
  where that is not allowed.
