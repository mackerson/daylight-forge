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
  version: 1;
  /** The repository the snapshot was fetched for, as given to `deps snapshot`. */
  repo: string;
  /** `sha256:` over the sorted listing of every file under `registry/` and `git/`. */
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

/**
 * The digest of a snapshot: one line per entry under `registry/` and `git/` — relative path,
 * size and sha256 for a file, the target for a symlink — sorted by path, hashed. Cargo's own
 * lock files and last-use database sit beside those two and are not part of what was fetched.
 */
export function snapshotDigest(dir: string): { digest: string; files: number; bytes: number } {
  const lines: string[] = [];
  let files = 0;
  let bytes = 0;
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs)) {
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
  for (const top of ['registry', 'git']) {
    if (fs.lstatSync(path.join(dir, top), { throwIfNoEntry: false })?.isDirectory()) walk(top);
  }
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { digest: sha256(lines.join('\n')), files, bytes };
}

/** The recorded snapshot, or null when none was made or the record cannot be read. */
export function readSnapshot(out: string): SnapshotRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(snapshotFile(out), 'utf8')) as SnapshotRecord;
    if (r.version !== 1 || typeof r.digest !== 'string' || typeof r.lockDigest !== 'string') return null;
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

/**
 * `deps snapshot`: `cargo fetch --locked` on the host into a fresh `CARGO_HOME`, then the digest.
 *
 * This is the one place cargo touches the network, and it is a person's command. The fetch runs
 * in the repository (so its `.cargo/config.toml` source replacements apply) with a minimal
 * environment: no registry tokens, no SSH agent, `HOME` pointed at the new snapshot so nothing
 * under the real home directory is read. The previous snapshot is replaced only once the new
 * one is complete.
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
  const bad = realDirUnder(out, cargoDir, true);
  if (bad) throw new CargoRefused(`refusing ${cargoDir}: ${bad}`);
  const staging = fs.mkdtempSync(path.join(cargoDir, 'snapshot.new-'));
  const env = o.env ?? process.env;
  const fetchEnv: Record<string, string> = { PATH: SYSTEM_PATH, HOME: staging, CARGO_HOME: staging };
  // A proxy or a CA bundle is how this machine reaches the registry at all; neither is a credential.
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (env[k]) fetchEnv[k] = env[k]!;
  }
  try {
    try {
      execFileSync(o.cargo ?? CARGO, ['fetch', '--locked', '--manifest-path', path.join(root, 'Cargo.toml')], {
        cwd: root, env: fetchEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: FETCH_TIMEOUT_MS,
      });
    } catch (err) {
      const e = err as { stderr?: Buffer; message: string };
      const why = (e.stderr?.toString('utf8') || e.message).trim().split('\n').filter(Boolean).at(-1) ?? 'cargo fetch failed';
      throw new CargoRefused(`cargo fetch --locked failed in ${root}: ${why.slice(0, 400)}`);
    }
    // The lock cargo fetched against must still be the one recorded: a concurrent edit would
    // otherwise pair a snapshot with a Cargo.lock it was not made from.
    if (lockDigestOf(root) !== lockDigest) throw new CargoRefused(`${root}/Cargo.lock changed during the fetch; run it again`);
    const d = snapshotDigest(staging);
    const record: SnapshotRecord = {
      version: 1, repo: root, digest: d.digest, files: d.files, bytes: d.bytes, lockDigest,
      createdAt: (o.now ?? (() => new Date()))().toISOString(),
    };
    const dir = snapshotDir(out);
    fs.rmSync(snapshotFile(out), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
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
  if (o.verify && recorded && fs.lstatSync(snapshotDir(out), { throwIfNoEntry: false })?.isDirectory()) {
    intact = snapshotDigest(snapshotDir(out)).digest === recorded.digest;
  }
  let refusal = snapshotRefusal(root, out, root);
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
export function cargoMounts(kind: CargoProfile, outIn: string): { binds: SandboxBind[]; env: Record<string, string> } {
  if (kind !== 'author' && kind !== 'gate') throw new CargoRefused(`unknown cargo profile ${String(kind)}`);
  const out = requireAbsoluteOut(outIn);
  if (!fs.lstatSync(out, { throwIfNoEntry: false })?.isDirectory()) throw new CargoRefused(`${out} is not a directory`);
  const home = snapshotDir(out);
  const missing = realDirUnder(out, home, false);
  if (missing || !readSnapshot(out)) {
    throw new CargoRefused(`no crate snapshot in ${out}${missing ? ` (${missing})` : ''}: run \`${snapshotCommand('<repo>', out)}\``);
  }
  const target = targetDir(out, kind);
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
 * Remove the author build cache and nothing else. Called whenever a candidate has a policy
 * violation: whatever that attempt's builds left there is not carried into the next author's.
 * A link in its place is removed as a link, never followed.
 */
export function wipeAuthorCache(outIn: string): boolean {
  const out = requireAbsoluteOut(outIn);
  const target = targetDir(out, 'author');
  const parent = path.dirname(target);
  const pst = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!pst || pst.isSymbolicLink() || !pst.isDirectory()) return false;
  if (!fs.lstatSync(target, { throwIfNoEntry: false })) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}
