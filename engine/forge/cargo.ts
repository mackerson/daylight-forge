import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM_PATH, type SandboxBind } from '../experiment/sandbox.ts';

/**
 * Cargo inside the sandbox (P2-R2, R3, R5): a per-project crate snapshot and two build caches.
 *
 * The sandbox has no network, so the crates a Rust repository depends on are fetched once, on
 * the host, by a person: `daylight deps snapshot <repo>` runs `cargo fetch --locked` with
 * `CARGO_HOME` at `<out>/cargo/snapshot/` and records a digest of what landed, beside the
 * repository's `Cargo.lock` digest, in `<out>/cargo/snapshot.json`. Gates and the author's `run`
 * tool mount that directory read-only at `/cargo-home` with `CARGO_NET_OFFLINE=true`. A tree
 * whose `Cargo.lock` is not the one recorded is refused with one line naming the command to
 * refresh it, rather than left to fail somewhere inside cargo.
 *
 * Builds go to `<out>/cargo/target/author/` or `<out>/cargo/target/gate/`, each mounted
 * read-write at `/cargo-target` into its own profile only: a gate never sees what an author
 * built and an author never sees the gates' artifacts. Both live outside the repository and
 * outside the sandbox's size-capped `/tmp`. The toolchain is the system `/usr/bin/cargo`,
 * already inside the read-only `/usr` bind.
 *
 * Only the two subdirectories are ever bound, never `<out>` itself. Callers still pass every
 * bind through `mountRefusal` (forge/sandbox.ts) with the bind named in `outAllow`.
 */

export type CargoProfile = 'author' | 'gate';

export const CARGO_HOME_MOUNT = '/cargo-home';
export const CARGO_TARGET_MOUNT = '/cargo-target';
const CARGO = '/usr/bin/cargo';
const FETCH_TIMEOUT_MS = 15 * 60_000;

export class CargoRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CargoRefused';
  }
}

export interface SnapshotRecord {
  /** 2: the digest covers the whole snapshot root (P2-R29). A version-1 record reads as none. */
  version: 2;
  /** The repository the snapshot was fetched for, as given to `deps snapshot`. */
  repo: string;
  /** `sha256:` over the sorted listing of every entry under the snapshot root but cargo's lock files. */
  digest: string;
  files: number;
  bytes: number;
  /** `sha256:` of the repository's `Cargo.lock` at the time of the fetch. */
  lockDigest: string;
  createdAt: string;
}

export const cargoRoot = (out: string): string => path.join(out, 'cargo');
export const snapshotDir = (out: string): string => path.join(out, 'cargo', 'snapshot');
export const snapshotFile = (out: string): string => path.join(out, 'cargo', 'snapshot.json');
export const targetDir = (out: string, kind: CargoProfile): string => path.join(out, 'cargo', 'target', kind);

/**
 * One gate build cache (P2-R28): `base`, written only by baseline runs, or one candidate's,
 * named by the first 16 hex characters of its diff digest and seeded from `base`.
 */
export const gateCacheDir = (out: string, key: string): string => path.join(targetDir(out, 'gate'), key);
const GATE_CACHE_KEY = /^(base|[0-9a-f]{16})$/;

/**
 * One mission's author build cache (review L4): every author of that mission builds here, and no
 * author of any other mission sees it. Cargo trusts the fingerprints and artifacts it finds in a
 * target directory, so a cache shared across missions would run one author's code in another's.
 */
export const authorCacheDir = (out: string, missionId: string): string => path.join(targetDir(out, 'author'), missionId);
const MISSION_KEY = /^[A-Za-z0-9_-]{1,80}$/;

/** The cache key of a candidate's gate runs: its diff digest, shortened. */
export const gateCacheKey = (diffDigest: string): string => diffDigest.replace(/^sha256:/, '').slice(0, 16);

/**
 * A candidate's gate cache, created as a copy of `base` (reflinked where the filesystem can, a
 * plain copy otherwise) so it starts from the base's dependency builds and nothing any other
 * candidate built. `base` itself is never handed to a candidate.
 */
function seedGateCache(out: string, key: string): void {
  const dst = gateCacheDir(out, key);
  if (fs.lstatSync(dst, { throwIfNoEntry: false })) return;
  const base = gateCacheDir(out, 'base');
  const bst = fs.lstatSync(base, { throwIfNoEntry: false });
  const parentBad = realDirUnder(out, targetDir(out, 'gate'), true);
  if (parentBad) throw new CargoRefused(`refusing the gate build cache: ${parentBad}`);
  if (!bst?.isDirectory() || bst.isSymbolicLink()) return;
  try {
    execFileSync('/usr/bin/cp', ['-a', '--reflink=auto', '--', base, dst], { stdio: 'ignore', timeout: 600_000, env: { PATH: SYSTEM_PATH } });
  } catch {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(base, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  }
}

/** Remove one candidate's gate cache; `base` is never removed this way. */
export function removeGateCache(outIn: string, key: string): void {
  const out = requireAbsoluteOut(outIn);
  if (key === 'base' || !GATE_CACHE_KEY.test(key)) return;
  fs.rmSync(gateCacheDir(out, key), { recursive: true, force: true });
}

const sha256 = (b: Buffer | string): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir}${path.sep}`);

/** The command a person runs to make or refresh a snapshot, for every refusal to name. */
export const snapshotCommand = (repo: string, out: string): string => `daylight deps snapshot ${repo} --out ${out}`;

/** Does this tree build with cargo? A `Cargo.toml` file at its root, not a link to one. */
export function isCargoTree(tree: string): boolean {
  return fs.lstatSync(path.join(tree, 'Cargo.toml'), { throwIfNoEntry: false })?.isFile() === true;
}

/** `sha256:` of `<tree>/Cargo.lock`, or null when there is none. */
export function lockDigestOf(tree: string): string | null {
  const st = fs.lstatSync(path.join(tree, 'Cargo.lock'), { throwIfNoEntry: false });
  return st?.isFile() ? sha256(fs.readFileSync(path.join(tree, 'Cargo.lock'))) : null;
}

/** Cargo's own lock files at the snapshot root: rewritten by any cargo that opens it, never read as data. */
const SNAPSHOT_LOCKS = new Set(['.package-cache', '.package-cache-mutate']);

/**
 * The digest of a snapshot: one line per entry under its root — relative path, size and sha256
 * for a file, the target for a symlink — sorted by path, hashed. Everything cargo could read
 * from `CARGO_HOME` is in it, configuration included; only cargo's two lock files are not.
 */
export function snapshotDigest(dir: string): { digest: string; files: number; bytes: number } {
  const lines: string[] = [];
  let files = 0;
  let bytes = 0;
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs)) {
      if (!rel && SNAPSHOT_LOCKS.has(name)) continue;
      const r = path.posix.join(rel, name);
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) walk(r);
      else if (st.isSymbolicLink()) lines.push(`${r}\tlink\t${fs.readlinkSync(path.join(dir, r))}`);
      else if (st.isFile()) {
        files++;
        bytes += st.size;
        lines.push(`${r}\t${st.size}\t${sha256(fs.readFileSync(path.join(dir, r)))}`);
      }
    }
  };
  walk('');
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { digest: sha256(lines.join('\n')), files, bytes };
}

// ---- cargo configuration ------------------------------------------------------------------

/**
 * The cargo configuration keys a repository's `.cargo/config.toml` may carry (P2-R29): build
 * flags, profiles, aliases and display settings. Everything else is refused, which covers what
 * the review named — registries, sources, `[net]`, `[http]`, credentials, `build.rustc*`,
 * `build.target-dir`, `[target.*].runner`/`linker`, `[env]`, `[unstable]`, `[patch]` — and
 * whatever cargo adds next.
 */
const TOLERATED_TOP = new Set(['profile', 'alias', 'term', 'cargo-new', 'doc', 'future-incompat-report']);
const TOLERATED_BUILD = new Set(['rustflags', 'rustdocflags', 'jobs', 'incremental', 'target']);
const TOLERATED_TARGET = new Set(['rustflags', 'rustdocflags']);

function toleratedKey(k: string[]): boolean {
  if (!k.length) return true;
  if (TOLERATED_TOP.has(k[0])) return true;
  if (k[0] === 'build') return k.length === 1 || (k.length === 2 && TOLERATED_BUILD.has(k[1]));
  if (k[0] === 'target') return k.length <= 2 || (k.length === 3 && TOLERATED_TARGET.has(k[2]));
  return false;
}

/** A dotted TOML key, bare or quoted, as its parts; null when it is not one this reader knows. */
function keyParts(raw: string): string[] | null {
  const parts: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let i = 0;
  while (i < raw.length) {
    re.lastIndex = i;
    const m = re.exec(raw);
    if (!m) return null;
    parts.push(m[1] ?? m[2] ?? m[3]);
    i = re.lastIndex;
    if (m[4] === '') break;
  }
  return parts.length ? parts : null;
}

/** `text` with a trailing `# comment` removed, quotes respected. */
function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/**
 * `depth` after the brackets of one line of an array, counting only those outside strings: a
 * `"…"` basic string (with `\\` escapes) or a `'…'` literal string, and stopping at a `#`
 * comment. Null when a string does not close on its line: arrays here hold one-line strings.
 */
function arrayDepth(line: string, depth: number): number | null {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (line.startsWith(c.repeat(3), i)) return null;
      q = c;
    } else if (c === '#') break;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return q ? null : depth;
}

/**
 * The `key = value` pairs of one inline table's body, split on the commas outside strings and
 * arrays (`features = ["a", "b"]` is one pair). Null when a string or an array does not close.
 */
function splitInline(body: string): string[] | null {
  const pairs: string[] = [];
  let q: string | null = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ',' && depth === 0) {
      pairs.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (q || depth !== 0) return null;
  pairs.push(body.slice(start));
  return pairs;
}

/**
 * Every key a cargo config file sets, as dotted paths, or why it cannot be read. A small reader,
 * not a TOML parser: tables, dotted keys and one level of inline table. Multi-line strings and
 * arrays are skipped over by bracket depth; anything it does not understand is a refusal.
 */
export function cargoConfigKeys(text: string): { keys: string[][] } | { error: string } {
  const keys: string[][] = [];
  let prefix: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = stripComment(lines[n]).trim();
    if (!line) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      const k = keyParts(header[1]);
      if (!k) return { error: `line ${n + 1}: unreadable table header` };
      prefix = k;
      keys.push(k);
      continue;
    }
    const eq = line.indexOf('=');
    const k = eq > 0 ? keyParts(line.slice(0, eq)) : null;
    if (!k) return { error: `line ${n + 1}: not a key = value line` };
    const value = line.slice(eq + 1).trim();
    const full = [...prefix, ...k];
    keys.push(full);
    if (value.startsWith('{')) {
      if (!value.endsWith('}') || value.slice(1, -1).includes('{')) return { error: `line ${n + 1}: nested or multi-line inline tables are not read` };
      const pairs = splitInline(value.slice(1, -1));
      if (!pairs) return { error: `line ${n + 1}: unreadable inline table` };
      for (const pair of pairs) {
        if (!pair.trim()) continue;
        const e = pair.indexOf('=');
        const sub = e > 0 ? keyParts(pair.slice(0, e)) : null;
        if (!sub) return { error: `line ${n + 1}: unreadable inline table` };
        keys.push([...full, ...sub]);
      }
    } else if (value.startsWith('"""') || value.startsWith("'''")) {
      const fence = value.slice(0, 3);
      if (value.length < 6 || !value.endsWith(fence)) {
        while (++n < lines.length && !lines[n].includes(fence));
      }
    } else if (value.startsWith('[')) {
      const start = n + 1;
      let depth = arrayDepth(value, 0);
      while (depth !== null && depth > 0 && ++n < lines.length) depth = arrayDepth(lines[n], depth);
      if (depth === null) return { error: `line ${n + 1}: unreadable string in an array` };
      if (depth !== 0) return { error: `line ${start}: an array that never closes` };
    }
  }
  return { keys };
}

/**
 * Why a `Cargo.toml` may not be snapshotted, or null: a `[patch]` or `[replace]` table, in any
 * spelling cargo honours (`[patch.crates-io]`, `["patch".crates-io]`, `patch.crates-io.x = …`),
 * or a manifest the key reader cannot read. A dependency that happens to be named `patch` is a
 * key under `[dependencies]` and is not one of them.
 */
export function manifestRefusal(text: string): string | null {
  const r = cargoConfigKeys(text);
  if ('error' in r) return `${r.error}; a manifest that cannot be read is not snapshotted`;
  const table = r.keys.find((k) => k[0] === 'patch' || k[0] === 'replace')?.[0];
  if (table) return `has a [${table}]; patched crates are not snapshotted`;
  // `<…dependencies>.<name>.registry[-index]`, in any dependency table, target-specific included.
  const alt = r.keys.find((k) => k.length >= 3 && (k.at(-1) === 'registry' || k.at(-1) === 'registry-index') && /dependencies$/.test(k.at(-3)!));
  return alt ? `names a registry for ${alt.at(-2)} (${alt.slice(-3).join('.')}); only crates.io is snapshotted` : null;
}

/**
 * Why `<dir>/.cargo/config.toml` (or the legacy `.cargo/config`) may not be used, or null: a
 * link anywhere on the way, a file this reader cannot read, or any key outside the tolerated set.
 * Cargo reads this file inside the sandbox too (cwd `/work`), so the gate preflight asks the same
 * question of every tree under test, and `deps snapshot` of the repository.
 */
export function cargoConfigRefusal(dir: string): string | null {
  const dotCargo = path.join(dir, '.cargo');
  const st = fs.lstatSync(dotCargo, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isDirectory()) return '.cargo is not a plain directory; cargo configuration is never read through a link';
  for (const name of fs.readdirSync(dotCargo)) {
    if (name !== 'config' && name !== 'config.toml' && !/^credentials/.test(name)) continue;
    if (/^credentials/.test(name)) return `.cargo/${name}: a credentials file is never used`;
    const f = path.join(dotCargo, name);
    const fst = fs.lstatSync(f);
    if (!fst.isFile()) return `.cargo/${name} is not a plain file`;
    const r = cargoConfigKeys(fs.readFileSync(f, 'utf8'));
    if ('error' in r) return `.cargo/${name}: ${r.error}; cargo configuration that cannot be read is refused`;
    const bad = r.keys.filter((k) => !toleratedKey(k)).map((k) => k.join('.'));
    if (bad.length) {
      return `.cargo/${name} sets ${[...new Set(bad)].slice(0, 5).join(', ')}; only build flags, profiles, aliases and display settings are allowed (docs/daylight/CARGO.md)`;
    }
  }
  return null;
}

/**
 * Why the snapshot root may not be used as `CARGO_HOME`, or null: a `config*` or `credentials*`
 * entry there is configuration cargo would read inside the sandbox, which no fetch puts there.
 */
export function snapshotRootRefusal(dir: string): string | null {
  const found = fs.readdirSync(dir).filter((n) => /^(config|credentials)/.test(n));
  return found.length ? `the crate snapshot holds ${found.join(', ')}, configuration cargo would read; it is never used` : null;
}

/** The recorded snapshot, or null when none was made or the record cannot be read. */
export function readSnapshot(out: string): SnapshotRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(snapshotFile(out), 'utf8')) as SnapshotRecord;
    if (r.version !== 2 || typeof r.digest !== 'string' || typeof r.lockDigest !== 'string') return null;
    return r;
  } catch {
    return null;
  }
}

/** `<out>` resolved, refused when it is not absolute: every cargo path is under it. */
function requireAbsoluteOut(out: string): string {
  if (typeof out !== 'string' || !path.isAbsolute(out)) throw new CargoRefused(`<out> must be an absolute path, got ${String(out)}`);
  return path.resolve(out);
}

/**
 * Every component from `<out>` down to `p` is a real directory (created when `create`), never a
 * symlink: a link anywhere on the path would make the bind something other than what it names.
 */
function realDirUnder(out: string, p: string, create: boolean): string | null {
  const rel = path.relative(out, p);
  let cur = out;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    let st = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (!st && create) {
      fs.mkdirSync(cur, { mode: 0o700 });
      st = fs.lstatSync(cur);
    }
    if (!st) return `${cur} does not exist`;
    if (st.isSymbolicLink()) return `${cur} is a symlink`;
    if (!st.isDirectory()) return `${cur} is not a directory`;
  }
  const real = fs.realpathSync(p);
  if (real !== path.join(fs.realpathSync(out), rel)) return `${p} resolves to ${real}`;
  return null;
}

/** The two spellings of crates.io a dependency's `source` takes; anything else is another registry. */
const CRATES_IO_SOURCES = new Set(['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/']);

/** Why a dependency or lock `source` is refused, or null for crates.io. */
function sourceRefusal(source: string): string | null {
  if (CRATES_IO_SOURCES.has(source)) return null;
  const shown = source.slice(0, 120);
  return source.startsWith('git+') ? `from git (${shown}); git dependencies are not snapshotted` : `from ${shown}; only crates.io is snapshotted`;
}

/**
 * Refuse a workspace whose crates do not all come from inside it or from crates.io: a member or
 * path dependency outside the repository, any other source (git, an alternate registry, a
 * `registry-index` URL) in a manifest or anywhere in the lock, a `[patch]`. None of those could
 * build in `/work` anyway, and `cargo fetch` would contact whatever a manifest names before
 * `--locked` failed (review M3); this names them before anything is fetched.
 * `cargo metadata --no-deps` runs from `/`, offline, reading manifests only.
 */
function workspaceRefusal(root: string, realRoot: string, cargo: string): void {
  let meta: { packages: Array<{ name: string; manifest_path: string; dependencies: Array<{ name: string; source: string | null; path?: string }> }> };
  try {
    meta = JSON.parse(execFileSync(cargo, ['metadata', '--no-deps', '--offline', '--format-version', '1', '--manifest-path', path.join(root, 'Cargo.toml')], {
      cwd: '/', env: { PATH: SYSTEM_PATH, HOME: '/nonexistent', CARGO_HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8'));
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    const why = (e.stderr?.toString('utf8') || e.message).trim().split('\n').filter(Boolean).at(-1) ?? 'cargo metadata failed';
    throw new CargoRefused(`cargo metadata could not read ${root}: ${why.slice(0, 400)}`);
  }
  const inside = (p: string) => {
    let real = path.resolve(p);
    try {
      real = fs.realpathSync(real);
    } catch {
      // Not there: judged by its spelling.
    }
    return within(real, realRoot);
  };
  const manifest = (file: string) => {
    const why = manifestRefusal(fs.readFileSync(file, 'utf8'));
    if (why) throw new CargoRefused(`${path.relative(root, file)} ${why}`);
  };
  // The root may be a virtual manifest, which is no package but is where cargo reads [patch].
  manifest(path.join(root, 'Cargo.toml'));
  for (const pkg of meta.packages) {
    if (!inside(pkg.manifest_path)) throw new CargoRefused(`workspace member ${pkg.name} is outside ${root} (${pkg.manifest_path}); a snapshot covers one repository`);
    manifest(pkg.manifest_path);
    for (const d of pkg.dependencies) {
      if (d.path && !inside(d.path)) throw new CargoRefused(`${pkg.name} depends on ${d.name} at ${d.path}, outside ${root}; path dependencies must be inside the repository`);
      const why = d.source ? sourceRefusal(d.source) : null;
      if (why) throw new CargoRefused(`${pkg.name} depends on ${d.name} ${why}`);
    }
  }
  // Every URL in the lock, not only `source = "…"` lines as cargo writes them: a hand-edited lock
  // may spell a source any way TOML allows. Escapes are refused because cargo never writes one.
  const lock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  if (/\\[uU]/.test(lock)) throw new CargoRefused('Cargo.lock has a unicode escape, which cargo never writes; it is not snapshotted');
  for (const m of lock.matchAll(/(["'])([^"'\n]*:\/\/[^"'\n]*)\1/g)) {
    const why = sourceRefusal(m[2]);
    if (why) throw new CargoRefused(`Cargo.lock has a dependency ${why}`);
  }
}

/**
 * `deps snapshot`: `cargo fetch --locked` on the host into a fresh `CARGO_HOME`, then the digest.
 *
 * This is the one place cargo touches the network, and it is a person's command (P2-R29). It
 * runs from `/` with `--manifest-path`, so neither the repository's `.cargo/config.toml` nor any
 * ancestor's is read, with a minimal environment: no registry tokens, no SSH agent, `HOME` and
 * `CARGO_HOME` pointed at the new snapshot. Before anything is fetched the repository is refused
 * if its own cargo config sets anything outside the tolerated keys (it would apply inside the
 * sandbox), if a manifest has a `[patch]`, or if a workspace member or a path dependency lives
 * outside it or any dependency comes from git. Build scripts are not refused. The previous
 * snapshot is replaced only once the new one is complete.
 */
export function createSnapshot(
  repo: string, outIn: string, o: { cargo?: string; now?: () => Date; env?: NodeJS.ProcessEnv } = {},
): SnapshotRecord {
  const out = requireAbsoluteOut(outIn);
  const root = path.resolve(repo);
  if (!isCargoTree(root)) throw new CargoRefused(`${root} has no Cargo.toml at its root; a crate snapshot is for a cargo workspace`);
  const lockDigest = lockDigestOf(root);
  if (!lockDigest) {
    throw new CargoRefused(`${root} has no Cargo.lock; run \`cargo generate-lockfile\` there and commit it, then \`${snapshotCommand(root, out)}\``);
  }
  const realRoot = fs.realpathSync(root);
  fs.mkdirSync(out, { recursive: true });
  const cargoDir = cargoRoot(out);
  if (within(path.resolve(cargoDir), realRoot) || within(fs.realpathSync(out), realRoot)) {
    throw new CargoRefused(`${cargoDir} is inside ${root}; the crate snapshot and build caches live outside the repository (use another --out)`);
  }
  const config = cargoConfigRefusal(root);
  if (config) throw new CargoRefused(`${root}/${config}`);
  const env = o.env ?? process.env;
  workspaceRefusal(root, realRoot, o.cargo ?? CARGO);
  const bad = realDirUnder(out, cargoDir, true);
  if (bad) throw new CargoRefused(`refusing ${cargoDir}: ${bad}`);
  const staging = fs.mkdtempSync(path.join(cargoDir, 'snapshot.new-'));
  const fetchEnv: Record<string, string> = { PATH: SYSTEM_PATH, HOME: staging, CARGO_HOME: staging };
  // A proxy or a CA bundle is how this machine reaches the registry at all; neither is a credential.
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (env[k]) fetchEnv[k] = env[k]!;
  }
  try {
    try {
      execFileSync(o.cargo ?? CARGO, ['fetch', '--locked', '--manifest-path', path.join(root, 'Cargo.toml')], {
        cwd: '/', env: fetchEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: FETCH_TIMEOUT_MS,
      });
    } catch (err) {
      const e = err as { stderr?: Buffer; message: string };
      const why = (e.stderr?.toString('utf8') || e.message).trim().split('\n').filter(Boolean).at(-1) ?? 'cargo fetch failed';
      throw new CargoRefused(`cargo fetch --locked failed in ${root}: ${why.slice(0, 400)}`);
    }
    // The lock cargo fetched against must still be the one recorded: a concurrent edit would
    // otherwise pair a snapshot with a Cargo.lock it was not made from.
    if (lockDigestOf(root) !== lockDigest) throw new CargoRefused(`${root}/Cargo.lock changed during the fetch; run it again`);
    const planted = snapshotRootRefusal(staging);
    if (planted) throw new CargoRefused(planted);
    const d = snapshotDigest(staging);
    const record: SnapshotRecord = {
      version: 2, repo: root, digest: d.digest, files: d.files, bytes: d.bytes, lockDigest,
      createdAt: (o.now ?? (() => new Date()))().toISOString(),
    };
    const dir = snapshotDir(out);
    fs.rmSync(snapshotFile(out), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    // Every gate cache was built against the old snapshot; the next baseline starts clean.
    fs.rmSync(targetDir(out, 'gate'), { recursive: true, force: true });
    const tmp = `${snapshotFile(out)}.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, snapshotFile(out));
    return record;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Bytes under `dir`, not following links; 0 when it is not there. */
export function treeBytes(dir: string): number {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.isFile() ? st.size : 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) n += treeBytes(path.join(dir, name));
  return n;
}

export interface SnapshotStatus {
  repo: string;
  out: string;
  recorded: SnapshotRecord | null;
  /** `sha256:` of the repository's `Cargo.lock` now, or null when it has none. */
  lockDigest: string | null;
  lockMatches: boolean;
  /** Whether the snapshot on disk still hashes to the recorded digest; null when not checked. */
  intact: boolean | null;
  caches: { author: number; gate: number };
  /** One line saying what to run, or null when a cargo run may go ahead. */
  refusal: string | null;
}

/**
 * Why a cargo run over `tree` may not go ahead, or null. Names `repo` in the command to run.
 * A tree without a `Cargo.lock` is refused too: offline, cargo would have to resolve one.
 */
export function snapshotRefusal(tree: string, out: string, repo: string): string | null {
  const recorded = readSnapshot(out);
  const cmd = snapshotCommand(repo, out);
  if (!recorded) return `no crate snapshot in ${out}: run \`${cmd}\``;
  const st = fs.lstatSync(snapshotDir(out), { throwIfNoEntry: false });
  if (!st?.isDirectory() || st.isSymbolicLink()) return `the crate snapshot directory is missing: run \`${cmd}\``;
  const lock = lockDigestOf(tree);
  if (!lock) return `no Cargo.lock in the tree; the snapshot was made from one: run \`${cmd}\` on a repository that commits its Cargo.lock`;
  if (lock !== recorded.lockDigest) {
    return `Cargo.lock (${lock.slice(0, 19)}…) does not match the crate snapshot (${recorded.lockDigest.slice(0, 19)}…): run \`${cmd}\``;
  }
  return null;
}

/** `deps status`: what is recorded, whether the lock still matches, and how big the caches are. */
export function snapshotStatus(repo: string, out: string, o: { verify?: boolean } = {}): SnapshotStatus {
  const root = path.resolve(repo);
  const recorded = readSnapshot(out);
  const lockDigest = lockDigestOf(root);
  let intact: boolean | null = null;
  let planted: string | null = null;
  if (o.verify && recorded && fs.lstatSync(snapshotDir(out), { throwIfNoEntry: false })?.isDirectory()) {
    intact = snapshotDigest(snapshotDir(out)).digest === recorded.digest;
    planted = snapshotRootRefusal(snapshotDir(out));
  }
  let refusal = snapshotRefusal(root, out, root);
  if (!refusal && planted) refusal = `${planted}: run \`${snapshotCommand(root, out)}\``;
  if (!refusal && intact === false) {
    refusal = `the crate snapshot no longer hashes to its recorded digest: run \`${snapshotCommand(root, out)}\``;
  }
  return {
    repo: root, out, recorded, lockDigest, lockMatches: !!recorded && lockDigest === recorded.lockDigest, intact,
    caches: { author: treeBytes(targetDir(out, 'author')), gate: treeBytes(targetDir(out, 'gate')) }, refusal,
  };
}

/**
 * The binds and environment one profile's cargo runs with: the snapshot read-only at
 * `/cargo-home`, that profile's own build cache read-write at `/cargo-target` (created on
 * demand), offline. The gate profile also builds non-incrementally: what it compiles is judged,
 * and incremental state is one more thing carried from one candidate's build into the next.
 */
export function cargoMounts(
  kind: CargoProfile, outIn: string, o: { gateCache?: string; mission?: string } = {},
): { binds: SandboxBind[]; env: Record<string, string> } {
  if (kind !== 'author' && kind !== 'gate') throw new CargoRefused(`unknown cargo profile ${String(kind)}`);
  const key = o.gateCache ?? 'base';
  if (kind === 'gate' && !GATE_CACHE_KEY.test(key)) throw new CargoRefused(`${key} is not a gate cache name`);
  if (kind === 'author' && !MISSION_KEY.test(o.mission ?? '')) throw new CargoRefused('the author build cache is per mission; no mission id was given');
  const out = requireAbsoluteOut(outIn);
  if (!fs.lstatSync(out, { throwIfNoEntry: false })?.isDirectory()) throw new CargoRefused(`${out} is not a directory`);
  const home = snapshotDir(out);
  const missing = realDirUnder(out, home, false);
  const recorded = readSnapshot(out);
  if (missing || !recorded) {
    throw new CargoRefused(`no crate snapshot in ${out}${missing ? ` (${missing})` : ''}: run \`${snapshotCommand('<repo>', out)}\``);
  }
  let repoReal: string | null = null;
  try {
    repoReal = fs.realpathSync(recorded.repo);
  } catch {
    // The repository moved; <out> cannot be inside a directory that is not there.
  }
  if (repoReal && within(fs.realpathSync(out), repoReal)) {
    throw new CargoRefused(`${out} is inside ${recorded.repo}; the crate snapshot and build caches live outside the repository (use another --out)`);
  }
  // Verified in full on every launch (P2-R29): the directory is writable by this uid on the host.
  const planted = snapshotRootRefusal(home);
  if (planted) throw new CargoRefused(`${planted}: run \`${snapshotCommand(recorded.repo, out)}\``);
  if (snapshotDigest(home).digest !== recorded.digest) {
    throw new CargoRefused(`the crate snapshot no longer hashes to its recorded digest: run \`${snapshotCommand(recorded.repo, out)}\``);
  }
  if (kind === 'gate' && key !== 'base') seedGateCache(out, key);
  const target = kind === 'gate' ? gateCacheDir(out, key) : authorCacheDir(out, o.mission!);
  const bad = realDirUnder(out, target, true);
  if (bad) throw new CargoRefused(`refusing the ${kind} build cache: ${bad}`);
  return {
    binds: [
      { kind: 'ro', src: fs.realpathSync(home), dest: CARGO_HOME_MOUNT },
      { kind: 'rw', src: fs.realpathSync(target), dest: CARGO_TARGET_MOUNT },
    ],
    env: {
      CARGO_HOME: CARGO_HOME_MOUNT, CARGO_TARGET_DIR: CARGO_TARGET_MOUNT, CARGO_NET_OFFLINE: 'true',
      ...(kind === 'gate' ? { CARGO_INCREMENTAL: '0' } : {}),
    },
  };
}

/**
 * Remove one mission's author build cache and nothing else. Called whenever a candidate of that
 * mission has a policy violation: whatever that attempt's builds left there is not carried into
 * the mission's next author. A link in its place is removed as a link, never followed.
 */
export function wipeAuthorCache(outIn: string, missionId: string): boolean {
  const out = requireAbsoluteOut(outIn);
  if (!MISSION_KEY.test(missionId)) return false;
  const target = authorCacheDir(out, missionId);
  for (const dir of [path.dirname(path.dirname(target)), path.dirname(target)]) {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  if (!fs.lstatSync(target, { throwIfNoEntry: false })) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}
