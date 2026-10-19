# Project policy

`<repo>/daylight.policy.json` tells the Forge what an author may not touch in this repository,
which gate harness the project uses, and how long an author may run. It is optional. **Without
it, behaviour is exactly what it was before policies existed**: the `always` and `node` sets
below, a 60-turn author and a 10-minute timeout.

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
| `languages` | Which built-in sets apply besides `always`: `node`, `rust` or both. Default `["node"]`; an empty list is refused. |
| `protectedPaths` | Repo-relative globs the project adds. `**` is any number of whole components, `*` any run inside one. No leading slash, no `.` or `..` component, no other glob syntax, at most 64 entries. Globs only add: there is no way to unprotect anything. A path is matched exactly, so write `dir/**` to protect a directory. |
| `gate.harness` | `cargo` or `node`. Read by nobody yet; the gate is wired to it after the P2 merge. |
| `gate.command` | Optional argv template, `{test}` standing for the test path. Not a shell string. |
| `author.maxTurns` | The author's turn cap. A positive integer, lowered to 1000 if above. |
| `author.timeoutSeconds` | The author's wall-clock cap. A positive integer, lowered to 21600 (6 h) if above. `forge run --timeout` overrides it, and is lowered to the same maximum. |

The file is refused, with one line naming it, when it is over 64 KB, is not JSON, is a symlink,
or has any key this version does not know, at any level. A refused policy refuses the run: a
policy that was half-read would protect less than its author meant. The `attempt.started`
event records the effective `maxTurns` and `timeoutMs`, where each came from (`flag`, `policy`
or `default`), and the policy's digest.

## The built-in sets

The sets are data (`PROTECTED_SETS` in `engine/forge/project-policy.ts`). The capture check
and the author's prompt are both built from that data, and `engine/test/project-policy.ts`
checks that every name in it appears on this page.

**always**, whatever the policy says:

- lockfiles at any depth: `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`,
  `yarn.lock`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`,
  `Gemfile.lock`, `composer.lock`, `go.sum`, `flake.lock`;
- any path with a component starting `.git` (`.git/`, `.github/`, `.gitignore`,
  `.gitattributes`, `.gitmodules`);
- `scripts` at the root;
- `daylight.invariants.json` and `daylight.policy.json`, at any depth.

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
- `build.rs` at any depth.

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
  git source. `reason` is at most 1 KB, without control characters, and is redacted.
- Each accepted call is one line in `<out>/dependency-requests/<attempt>.jsonl`, at most 20
  per attempt. It is data: nothing installs, fetches or runs it. The host re-checks every line
  when it reads it, and takes the mission and attempt from which outbox it is, never from the
  line.
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
