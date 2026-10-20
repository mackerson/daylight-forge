# Project policy

`<repo>/daylight.policy.json` tells the Forge what an author may not touch in this repository,
which gate harness the project uses, and how long an author may run. It is optional, and it can
only tighten (RULINGS P2-R32): **every built-in set below applies to every repository, with or
without a policy**, and nothing in the file removes a protected path. Without it every
built-in set still applies (P2-R32 supersedes P2-R6's "absent file = today's Node defaults")
and an author gets 60 turns and a 10-minute timeout.

The host reads it from the repository's working tree at `forge run` (RULINGS P2-R6). An agent
never reads or writes it, and the file is itself a protected path, at any depth, with or
without a policy.

## The file

```json
{
  "schema": "daylight.policy/v1",
  "languages": ["rust", "node"],
  "protectedPaths": ["custom/glob/**"],
  "gate": { "harness": "cargo", "command": ["cargo", "test", "--test", "{test}"] },
  "author": { "maxTurns": 300, "timeoutSeconds": 3600 }
}
```

| Key | Meaning |
| --- | --- |
| `schema` | Required, exactly `daylight.policy/v1`. |
| `languages` | `node`, `rust` or both. Default `["node"]`; an empty list is refused. It only chooses which sets the author's prompt lists first (the prompt lists every set, since every set is enforced) and, when `gate.harness` is absent, the default gate harness. It never unprotects anything: a `["rust"]` project still has `package.json` and `node_modules` protected. |
| `protectedPaths` | Repo-relative globs the project adds. `**` is any number of whole components, `*` any run inside one. No leading slash, no `.` or `..` component, no other glob syntax, at most 64 entries. Globs only add: there is no way to unprotect anything. A path is matched exactly, so write `dir/**` to protect a directory. |
| `gate.harness` | `cargo` or `node`. The harness `daylight gate add` registers when `--harness` is not given, and a plan gate's when the plan names none (read at the plan commit); the flag or the plan's own `harness` wins. Without it, `languages` decides (P2-R32, P2-R37): `["rust"]` is `cargo`; `["node"]`, both, or no `languages` (or no policy) is `node`. |
| `gate.command` | Optional argv template, `{test}` standing for the test path. Not a shell string. |
| `author.maxTurns` | The author's turn cap. A positive integer, lowered to 1000 if above. |
| `author.timeoutSeconds` | The author's wall-clock cap. A positive integer, lowered to 21600 (6 h) if above. `forge run --timeout` overrides it, and is lowered to the same maximum. |

The file is refused, with one line naming it, when it is over 64 KB, is not JSON, is a symlink,
or has any key this version does not know, at any level. A refused policy refuses the run: a
policy that was half-read would protect less than its author meant. The `attempt.started`
event records the effective `maxTurns` and `timeoutMs`, where each came from (`flag`, `policy`
or `default`), what was lowered to its maximum (`clamped`: the policy's fields, or
`--timeout` for the flag), and the policy's digest.

## The built-in sets

The sets are data (`PROTECTED_SETS` in `engine/forge/project-policy.ts`). The capture check
and the author's prompt are both built from that data, and `engine/test/project-policy.ts`
checks that every name in it appears on this page.

All three apply in every repository, whatever `languages` says; the names only group them.
A rust rule never matches in a Node repository, nor the reverse, so applying them all costs a
project nothing it uses.

**always**:

- lockfiles at any depth: `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`,
  `yarn.lock`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`,
  `Gemfile.lock`, `composer.lock`, `go.sum`, `flake.lock`;
- any path with a component starting `.git` (`.git/`, `.github/`, `.gitignore`,
  `.gitattributes`, `.gitmodules`);
- `scripts` at the root;
- `daylight.invariants.json` and `daylight.policy.json`, at any depth, and the invariants
  loader's other two locations, `.daylight/invariants.json` and `.codemap/invariants.def.json`;
- package-manager configuration and install-time code at any depth: `.npmrc`, `.pnpmfile.cjs`,
  `.pnpmfile.mjs`, `pnpm-workspace.yaml`, `.yarnrc.yml`, `.yarnrc`, `bunfig.toml`, and anything
  under `.yarn/releases` or `.yarn/plugins` (the code `yarnPath` and yarn's plugins run);
- hook code a person's next commit would run: anything under `.husky`, and
  `.pre-commit-config.yaml`, `lefthook.yml`, `.lefthook.yml`, `lefthook.yaml`, `.lefthook.yaml`,
  `lefthook-local.yml`, `lefthook-local.yaml`, `.lefthook-local.yml` and `.lefthook-local.yaml`
  at any depth.

The last three groups were added by P2-R32 and widened at the P2 merge. They change behaviour for a repository without a
policy, by tightening only: an author that edits one of them now produces an uncurable
`protected-path` violation where it did not before.

**node**:

- `package.json` at any depth;
- anything under a `node_modules` directory.

**rust** (RULINGS P2-R4):

- every `Cargo.toml`, the workspace manifest and every crate's own. Per-crate manifests are
  protected because a member's `[dependencies]` and `build =` fetch and run code exactly as the
  root's do;
- every `Cargo.lock`;
- anything under a `.cargo` directory, at any depth (cargo reads config from every parent);
- `rust-toolchain.toml`, and the older `rust-toolchain`;
- `build.rs` beside a `Cargo.toml` (a crate root, the only place cargo runs it from), and any
  build script a `Cargo.toml` names with `build = "<path>"` (P2-R41). `crates/pack/src/build.rs`
  or `src/build/mod.rs` is an ordinary module an author may edit. The check reads the crate
  roots from the tree it judges against: plan validation from the plan commit, candidate capture
  from the base commit plus any manifest the candidate adds. A check that has no tree to hand
  (the fix lane and follow-up scope checks), or a manifest whose `build` key it cannot read (a
  multi-line string, an inline `package = { … }`, a path outside the repository), protects every
  `build.rs` instead.

Independently of the policy, the gate directory `.daylight-gates/`, the registered spec, paths
outside the mission's scope, symlinks, gitlinks and new executables are refused as before
(ADR-21). Every one of these violations is uncurable: no approve or override waves it through,
and the cure is a new candidate.

Under a policy, a `protected-path` violation also says which set matched, for example
`protected by the rust set` or `protected by the project set` for a glob. Without one the
violation row is unchanged.

## Asking for a dependency

An author cannot add a crate or a package: every manifest and lockfile is protected. When it
needs one it calls the MCP tool `request_dependency` (authors only; reviewers and decomposers
never have it):

```json
{ "ecosystem": "cargo", "name": "serde_json", "version": "1", "reason": "parse the config file" }
```

- `ecosystem` is `cargo` or `npm`. `name` must match the ecosystem's grammar (a crate name of
  at most 64 characters; a lower-case, optionally scoped npm name), at most 128 characters.
  `version` is an optional registry requirement (`1`, `^0.4`, `>=0.4, <0.6`): no URL, path or
  git source, no whitespace except after a `,`, and no part starting `-`. `reason` is at most 1 KB, without control characters, and is redacted.
- Each accepted call is one line in `<out>/dependency-requests/<attempt>.jsonl`, at most 20
  per attempt. It is data: nothing installs, fetches or runs it. The host re-checks every line
  when it reads it, and takes the mission and attempt from which outbox it is, never from the
  line. Lines that are not valid requests are skipped and counted: `deps requests` ends with
  `skipped: N`, and each need says so when N is not zero.
- Each open request is a `request-dependency` need on the mission (derived, never stored), one
  per mission and dependency however often it was asked for.

A person then:

1. reads the requests: `daylight deps requests [--mission <m>] [--format json]`;
2. adds the dependency to the manifest themselves, or decides not to;
3. for a crate, refreshes the snapshot: `daylight deps snapshot <repo>`;
4. records the decision: `daylight deps resolve <request-id> --rationale '<why>' --confirm <c>`.
   Run it once without `--confirm` to see what you are confirming. Like every Forge decision it
   is refused under `CLAUDECODE` or `DAYLIGHT_SESSION` and recorded as `human:<OS user>`. It
   edits no manifest and runs no snapshot; it prints what to run next. A person who will not
   add it runs the same command with `--declined`, recorded as a `reject` decision rather than
   an `approve`; the confirm code differs, so one cannot stand in for the other;
5. re-runs the author: `daylight forge run <m> <repo> --tools <author>`.

An author's edit of a protected manifest is never curable by resolving a request: the request
is how the dependency gets added, by a person, outside the candidate.
