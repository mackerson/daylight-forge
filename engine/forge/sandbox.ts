import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DEFAULT_LIMITS, detectSandbox, nodeBind, nodeBinary, sandboxBinaries, scopeEnv, SYSTEM_PATH, WORK,
  type SandboxLimits, type SandboxProfile,
} from '../experiment/sandbox.ts';
import type { ArtifactStore } from '../mission/artifacts.ts';
import { redact } from '../mission/redact.ts';
import type { ArtifactRef, Attempt, NetworkMode } from '../mission/types.ts';
import { cargoMounts, CargoRefused, isCargoTree, readSnapshot, snapshotRefusal } from './cargo.ts';

/**
 * The Forge's bubblewrap profiles (F-1 as amended by R9.1, R11.1, R11.2).
 *
 * - `review`: the repository read-only at `/work` with its `.git` hidden, network `shared`
 *   (a real reviewer calls its model), nothing writable but a private `/tmp`.
 * - `author`: the detached workspace tree read-write at `/work`, network `none` or `shared`
 *   as the provider needs, and only with the authorization an `authorize-mission` decision
 *   gave the attempt row. Exec is never a shell here: it is the MCP tool `run`, whose command
 *   the host runs in a second sandbox over the same tree with no network (`execArgv`).
 *
 * Both get exactly one host socket, `/run/daylight/mcp.sock`, for the attempt's MCP server on
 * the host, and a stdio↔socket shim fed in from memory that the agent's MCP config launches.
 * Never mounted: `<out>`, the home directory and its credential stores, the real checkout
 * (author), any `.git` or the sibling git dir, `/run` beyond that one socket, `/var`, `/sys`,
 * display or session sockets. The root is remounted read-only once everything is in place.
 *
 * Fail closed: without bwrap and prlimit there is no launch. Nothing here builds a shell
 * string; every argument is one argv element.
 */

export const MCP_SOCKET = '/run/daylight/mcp.sock';
export const MCP_CONFIG = '/etc/daylight/mcp.json';
export const MCP_SHIM = '/etc/daylight/mcp-shim.cjs';
/** The server key in the agent's MCP config; tool names are `mcp__daylight__<tool>`. */
export const MCP_SERVER_KEY = 'daylight';
/** First line a shim sends: `DAYLIGHT-MCP <token>\n`. */
export const MCP_HANDSHAKE = 'DAYLIGHT-MCP';

/** What `shared` needs to resolve names and verify TLS, read-only, where present. */
export const NET_FILES = ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl', '/etc/ca-certificates'];

/** Under the home directory, never bound however a caller names them. */
const SENSITIVE_HOME = [
  '.ssh', '.gnupg', '.aws', '.claude', '.netrc', '.npmrc', '.git-credentials', '.config/gh',
  '.config/daylight', '.local/share/daylight',
];

/** Where Daylight keeps its own data under `$HOME`: the default `<out>` lives in the first. */
const DAYLIGHT_HOME_DIRS = ['.local/share/daylight', '.config/daylight'];

export class SandboxRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxRefused';
  }
}

export type ForgeProfileKind = 'review' | 'author';

export interface Mount {
  kind: 'ro' | 'rw' | 'data' | 'tmpfs' | 'dir' | 'symlink' | 'proc' | 'dev';
  /** Host path for `ro`/`rw`, symlink target for `symlink`; absent otherwise. */
  src?: string;
  dest: string;
}

/** The agent process: its binary, its arguments, and whatever else it must read, at their own paths. */
export interface AgentCommand {
  bin: string;
  argv: string[];
  /** Host paths bound read-only at the same path: a mock script, a provider's install tree. */
  mounts?: string[];
}

/** One attempt's MCP endpoint: the host socket and the token the host server will check. */
export interface McpEndpoint {
  socket: string;
  token: string;
}

export interface ProfileOptions {
  kind: ForgeProfileKind;
  /** `review`: the repository root. `author`: the workspace tree. */
  root: string;
  network: NetworkMode;
  /** Recorded and offered as the `run` tool; mounts are the same either way. Author only. */
  exec?: boolean;
  /** Required for `author`: the decision that granted write, and its mission. */
  authorization?: { decisionId: string; missionId: string };
  agent: AgentCommand;
  env?: Record<string, string>;
  mcp?: McpEndpoint;
  /**
   * The attempt's `<out>`. Required: never mounted, and a root containing it is refused. There
   * is no default; a launch that does not say where `<out>` is cannot be shown to avoid it.
   */
  out: string;
  /** Defaults to the real one; a test may name another. */
  home?: string;
  /**
   * Agent mounts under `$HOME` that may be bound (a provider's install tree). Anything else
   * under `$HOME` is refused, and the credential stores are refused even when listed here.
   */
  homeAllow?: string[];
  limits?: SandboxLimits;
}

export interface SandboxLaunch {
  /** The absolute launcher to spawn. */
  bin: string;
  /** `argv[0]` is the launcher's name, as in the P0 runner; spawn with `argv.slice(1)`. */
  argv: string[];
  /** The launcher's own environment. The sandbox's is set by `--setenv` after `--clearenv`. */
  env: Record<string, string>;
  /** Written to fds 3, 4, … of the launcher, in order, and closed. */
  feeds: Buffer[];
  mounts: Mount[];
}

const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir}${path.sep}`);

const resolved = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Why `src` may not be bound, or null. Refused: the root itself, any ancestor of the home
 * directory or of `<out>` (which would bring them in), anything under `<out>`, and the home
 * directory's credential stores (always), and anything else under the home directory that
 * `allow` does not name.
 *
 * `outAllow` names exact directories strictly inside `<out>` that may be bound anyway: the
 * crate snapshot and one build cache (forge/cargo.ts). Only those paths themselves, never
 * `<out>` or a parent; and the Daylight data directory that holds `<out>` is passed over only
 * for them, every other credential store still refuses.
 */
export function mountRefusal(src: string, o: { home: string; out: string; allow?: string[]; outAllow?: string[] }): string | null {
  const p = resolved(src);
  const home = resolved(o.home);
  const out = resolved(requireOut(o.out));
  const outAllowed = p !== out && within(p, out) && (o.outAllow ?? []).some((a) => resolved(a) === p);
  if (p === '/') return 'the root filesystem';
  if (within(home, p)) return `${p} contains the home directory`;
  if (outAllowed && within(home, out)) return `${p} is under an <out> that is the home directory or contains it`;
  for (const rel of SENSITIVE_HOME) {
    const dir = path.join(home, rel);
    // Only Daylight's own directories are passed over for an <out> inside them; an <out> under
    // ~/.ssh or any other credential store never makes a bind there acceptable.
    if (within(p, dir) && !(outAllowed && DAYLIGHT_HOME_DIRS.includes(rel) && within(out, dir))) return `${p} is under ~/${rel}`;
  }
  if (within(p, out) && !outAllowed) return `${p} is under <out>`;
  if (within(out, p)) return `${p} contains <out>`;
  // Deny by default under $HOME: dotfiles there hold credentials nobody listed in advance.
  if (within(p, home) && !(o.allow ?? []).some((a) => within(p, resolved(a)))) {
    return `${p} is under the home directory and not allowlisted`;
  }
  return null;
}

/**
 * Every `homeAllow` entry must name one thing strictly inside `$HOME`: an absolute path with
 * no glob characters whose resolved form is a descendant of `$HOME`. `$HOME` itself, a parent,
 * `/`, an outside path or a glob would be a blanket allow, so each is refused as input.
 */
export function checkHomeAllow(entries: unknown, home: string): void {
  if (entries === undefined) return;
  if (!Array.isArray(entries)) throw new SandboxRefused('homeAllow must be an array of paths');
  const h = resolved(home);
  for (const e of entries) {
    if (typeof e !== 'string' || !path.isAbsolute(e) || /[*?[\]{}]/.test(e)) {
      throw new SandboxRefused(`homeAllow entry ${String(e)} must be an absolute path without glob characters`);
    }
    const r = resolved(e);
    if (r === h || !r.startsWith(`${h}${path.sep}`)) {
      throw new SandboxRefused(`homeAllow entry ${e} must be strictly inside the home directory`);
    }
  }
}

/** `<out>`, or a refusal: every launch must say where it is so it can be kept out (F1). */
export function requireOut(out: unknown): string {
  if (typeof out !== 'string' || !out.trim() || !path.isAbsolute(out)) {
    throw new SandboxRefused('every sandbox launch must name its <out> as an absolute path; without it <out> cannot be kept out of the mounts');
  }
  return out;
}

/** prlimit, under a systemd user scope when one was found, then `bwrap`. As P0's runner. */
function launcherPrefix(profile: SandboxProfile, limits: SandboxLimits): string[] {
  const scope = profile.scope
    ? [
        'systemd-run', '--user', '--scope', '--quiet', '--collect',
        '-p', `MemoryMax=${limits.memoryBytes}`, '-p', 'MemorySwapMax=0', '-p', `TasksMax=${limits.tasks}`,
        '--',
      ]
    : [];
  return [
    ...scope,
    scope.length ? (profile.prlimit ?? '/usr/bin/prlimit') : 'prlimit',
    `--cpu=${limits.cpuSeconds}`, `--fsize=${limits.fileSizeBytes}`, `--nofile=${limits.openFiles}`,
    '--', 'bwrap',
  ];
}

class ArgvBuilder {
  readonly argv: string[];
  readonly mounts: Mount[] = [];
  readonly feeds: Buffer[] = [];

  constructor(prefix: string[]) {
    this.argv = [...prefix];
  }

  ro(src: string, dest: string, optional = false): void {
    if (optional && !fs.existsSync(src)) return;
    this.argv.push('--ro-bind', src, dest);
    this.mounts.push({ kind: 'ro', src, dest });
  }

  /** The only read-write bind. Callers prove the write grant first. */
  rw(src: string, dest: string): void {
    this.argv.push('--bind', src, dest);
    this.mounts.push({ kind: 'rw', src, dest });
  }

  data(bytes: Buffer, dest: string): void {
    const fd = 3 + this.feeds.length;
    this.feeds.push(bytes);
    this.argv.push('--ro-bind-data', String(fd), dest);
    this.mounts.push({ kind: 'data', dest });
  }

  raw(kind: Mount['kind'], args: string[], dest: string, src?: string): void {
    this.argv.push(...args);
    this.mounts.push({ kind, dest, ...(src !== undefined ? { src } : {}) });
  }
}

/** Namespaces, environment and the system mounts every Forge sandbox shares with P0's. */
function baseSandbox(
  profile: SandboxProfile, limits: SandboxLimits, env: Record<string, string>,
): ArgvBuilder {
  const b = new ArgvBuilder(launcherPrefix(profile, limits));
  const bin = nodeBinary();
  const bind = nodeBind(bin);
  b.argv.push(
    '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session',
    '--clearenv',
    '--setenv', 'PATH', bind ? `${path.dirname(bin)}:/usr/bin:/bin` : '/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp',
  );
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new SandboxRefused(`${k} is not an environment variable name`);
    b.argv.push('--setenv', k, v);
  }
  b.ro('/usr', '/usr');
  b.raw('symlink', ['--symlink', 'usr/lib', '/lib'], '/lib', 'usr/lib');
  b.raw('symlink', ['--symlink', 'usr/lib64', '/lib64'], '/lib64', 'usr/lib64');
  b.raw('symlink', ['--symlink', 'usr/bin', '/bin'], '/bin', 'usr/bin');
  b.raw('symlink', ['--symlink', 'usr/bin', '/sbin'], '/sbin', 'usr/bin');
  b.ro('/etc/ld.so.cache', '/etc/ld.so.cache', true);
  if (bind) b.ro(bind, bind);
  b.raw('proc', ['--proc', '/proc'], '/proc');
  b.raw('dev', ['--dev', '/dev'], '/dev');
  b.raw('tmpfs', ['--size', String(limits.tmpBytes), '--tmpfs', '/tmp'], '/tmp');
  return b;
}

/** The node shim the agent's MCP config launches: stdio in, the attempt's socket out. */
export const MCP_SHIM_SOURCE = `'use strict';
const net = require('node:net');
const sock = process.argv[2];
const token = process.env.DAYLIGHT_MCP_TOKEN || '';
const c = net.connect(sock, () => {
  c.write(${JSON.stringify(MCP_HANDSHAKE)} + ' ' + token + '\\n');
  process.stdin.pipe(c);
  c.pipe(process.stdout);
});
c.on('error', (e) => { process.stderr.write('daylight mcp shim: ' + e.code + '\\n'); process.exit(1); });
c.on('close', () => process.exit(0));
`;

/** The MCP config the agent is pointed at (`--mcp-config ${MCP_CONFIG}`), inside the sandbox. */
export function mcpConfigFor(token: string): { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } {
  return {
    mcpServers: {
      [MCP_SERVER_KEY]: { command: nodeBinary(), args: [MCP_SHIM, MCP_SOCKET], env: { DAYLIGHT_MCP_TOKEN: token } },
    },
  };
}

/**
 * The launch for one agent under a Forge profile. Throws `SandboxRefused` for anything the
 * profile does not allow; never returns a weaker sandbox than asked for.
 */
export function profileLaunch(profile: SandboxProfile, o: ProfileOptions): SandboxLaunch {
  if (!profile.available) throw new SandboxRefused(`sandbox unavailable: ${profile.why ?? 'no profile'}`);
  if (o.kind !== 'review' && o.kind !== 'author') throw new SandboxRefused(`unknown profile ${String(o.kind)}`);
  if (o.network !== 'none' && o.network !== 'shared') throw new SandboxRefused(`unknown network ${String(o.network)}`);
  requireOut(o.out);
  const home = o.home ?? os.homedir();
  checkHomeAllow(o.homeAllow, home);
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  const root = resolved(o.root);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new SandboxRefused(`${root} is not a directory`);
  // The root is named explicitly by the caller, so it is its own allowlist entry.
  const rootWhy = mountRefusal(root, { home, out: o.out, allow: [root] });
  if (rootWhy) throw new SandboxRefused(`refusing to mount ${o.kind} root: ${rootWhy}`);

  if (o.kind === 'review') {
    if (o.exec) throw new SandboxRefused('a review attempt has no exec');
    if (o.authorization) throw new SandboxRefused('a review attempt is never granted write');
  } else {
    const a = o.authorization;
    if (!a || !a.decisionId || !a.missionId) {
      throw new SandboxRefused('an author attempt writes its tree only with the authorize decision that granted it');
    }
    // A detached workspace has no git metadata. One that does is a checkout, not a workspace.
    if (fs.existsSync(path.join(root, '.git'))) throw new SandboxRefused(`${root} has a .git; the author is given a detached workspace, never a checkout`);
  }

  const b = baseSandbox(profile, limits, o.env ?? {});
  if (o.network === 'shared') {
    b.argv.push('--share-net');
    for (const f of NET_FILES) b.ro(f, f, true);
  }

  if (o.kind === 'review') {
    b.ro(root, WORK);
    const dotGit = path.join(root, '.git');
    const st = fs.lstatSync(dotGit, { throwIfNoEntry: false });
    if (st?.isDirectory()) {
      b.raw('tmpfs', ['--tmpfs', `${WORK}/.git`, '--remount-ro', `${WORK}/.git`], `${WORK}/.git`);
    } else if (st) {
      b.data(Buffer.alloc(0), `${WORK}/.git`);
    }
  } else {
    b.rw(root, WORK);
  }

  const agentPaths = [o.agent.bin, ...(o.agent.mounts ?? [])].filter((p) => {
    const r = resolved(p);
    return !within(r, '/usr') && r !== nodeBinary();
  });
  for (const p of [...new Set(agentPaths)]) {
    if (!path.isAbsolute(p)) throw new SandboxRefused(`agent path ${p} is not absolute`);
    const why = mountRefusal(p, { home, out: o.out, allow: o.homeAllow });
    if (why) throw new SandboxRefused(`refusing to mount agent path: ${why}`);
    if (within(resolved(p), root)) continue;
    b.ro(p, p);
  }

  if (o.mcp) {
    const sock = o.mcp.socket;
    if (!path.isAbsolute(sock) || !fs.lstatSync(sock, { throwIfNoEntry: false })?.isSocket()) {
      throw new SandboxRefused(`${sock} is not a socket`);
    }
    const why = mountRefusal(path.dirname(sock), { home, out: o.out }) ?? (within(resolved(sock), resolved(home)) ? 'it is under the home directory' : null);
    if (why) throw new SandboxRefused(`refusing to mount the MCP socket: ${why}`);
    if (o.mcp.token.length < 32) throw new SandboxRefused('an MCP token must be at least 32 characters of randomness');
    b.raw('dir', ['--dir', path.posix.dirname(MCP_SOCKET)], path.posix.dirname(MCP_SOCKET));
    b.ro(sock, MCP_SOCKET);
    b.data(Buffer.from(JSON.stringify(mcpConfigFor(o.mcp.token))), MCP_CONFIG);
    b.data(Buffer.from(MCP_SHIM_SOURCE), MCP_SHIM);
  }

  b.argv.push('--remount-ro', '/', '--chdir', WORK, '--', o.agent.bin, ...o.agent.argv);
  const bins = sandboxBinaries(profile);
  return { bin: bins.scope ?? bins.prlimit, argv: b.argv, env: { PATH: SYSTEM_PATH, ...scopeEnv() }, feeds: b.feeds, mounts: b.mounts };
}

export function profileArgv(profile: SandboxProfile, o: ProfileOptions): string[] {
  return profileLaunch(profile, o).argv;
}

// ---- the attempt's MCP runtime directory ----------------------------------------------

/** 256 bits, hex. Handed to the sandbox in its MCP config; the store keeps only its digest. */
export const newMcpToken = (): string => randomBytes(32).toString('hex');

/**
 * A 0700 directory for one attempt's socket: under `$XDG_RUNTIME_DIR` when that is a private
 * directory of this uid, else the system temp dir. Never under `<out>` or the home directory.
 */
export function mcpRuntimeDir(o: { out?: string; home?: string; env?: NodeJS.ProcessEnv } = {}): { dir: string; socket: string; dispose(): void } {
  const env = o.env ?? process.env;
  const home = resolved(o.home ?? os.homedir());
  const candidates = [env.XDG_RUNTIME_DIR, os.tmpdir()].filter((d): d is string => !!d && path.isAbsolute(d));
  for (const parent of candidates) {
    const st = fs.statSync(parent, { throwIfNoEntry: false });
    if (!st?.isDirectory()) continue;
    if (parent === env.XDG_RUNTIME_DIR && (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)) continue;
    const real = resolved(parent);
    if (within(real, home)) continue;
    if (o.out && (within(real, resolved(o.out)) || within(resolved(o.out), real))) continue;
    const dir = fs.mkdtempSync(path.join(real, 'daylight-mcp-'));
    fs.chmodSync(dir, 0o700);
    const socket = path.join(dir, 'mcp.sock');
    // sun_path is 108 bytes with its terminator.
    if (Buffer.byteLength(socket) > 107) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    return { dir, socket, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }
  throw new SandboxRefused('no private runtime directory outside the home directory and <out> for the MCP socket');
}

// ---- exec: a second sandbox, never a shell beside the agent ----------------------------

/** Why this attempt may not exec, or null. Exec is reachable only from its own row's stamp. */
export function execRefusal(attempt: Pick<Attempt, 'id' | 'sandbox'>): string | null {
  const s = attempt.sandbox;
  if (!s || s.exec !== true) return `attempt ${attempt.id} was not granted exec`;
  if (s.profile !== 'author' || !s.write || !s.authorizeDecisionId) {
    return `attempt ${attempt.id} has exec without an authorized author write grant`;
  }
  return null;
}

const MAX_EXEC_ARGS = 64;
const MAX_EXEC_ARG = 4096;

/**
 * Refused by name (review I3). bwrap's no_new_privs already makes setuid inert; naming them keeps
 * an author from spending its turns on them and the transcript from reading as if it could.
 */
const PRIVILEGE_BINARIES = new Set(['sudo', 'su', 'doas', 'pkexec', 'mount', 'chroot', 'nsenter', 'unshare', 'setpriv']);

/** `node` (ours) or a system binary by absolute path; no shell string, ever. */
export function checkExecCommand(command: unknown): { ok: true; argv: string[] } | { ok: false; why: string } {
  if (!Array.isArray(command) || !command.length) return { ok: false, why: 'the command is a non-empty argv array' };
  if (command.length > MAX_EXEC_ARGS) return { ok: false, why: `at most ${MAX_EXEC_ARGS} arguments` };
  for (const a of command) {
    if (typeof a !== 'string' || a.length > MAX_EXEC_ARG || a.includes('\0')) return { ok: false, why: 'every argument is a string without NUL' };
  }
  const head = command[0] as string;
  if (head === 'node') return { ok: true, argv: [nodeBinary(), ...command.slice(1)] };
  if (/^\/usr\/bin\/[A-Za-z0-9._+-]+$/.test(head)) {
    const base = head.slice('/usr/bin/'.length);
    if (PRIVILEGE_BINARIES.has(base)) return { ok: false, why: `\`${base}\` changes privileges or namespaces and is never run` };
    return { ok: true, argv: command as string[] };
  }
  return { ok: false, why: `\`${head}\` is neither \`node\` nor a binary under /usr/bin` };
}

/**
 * The exec sandbox: the same tree read-write at `/work`, `--unshare-all` with no
 * `--share-net` under any option, prlimit, no MCP socket, nothing fed in. Gate tests are
 * never in the tree (the workspace refuses a holdout at base). A tree with a `Cargo.toml` at
 * its root also gets the author's cargo binds (forge/cargo.ts): the crate snapshot read-only
 * and the author build cache, never the gates'. Nothing else is mounted.
 */
export function execLaunch(
  profile: SandboxProfile,
  attempt: Pick<Attempt, 'id' | 'missionId' | 'sandbox'>,
  o: { tree: string; command: string[]; limits?: SandboxLimits; home?: string; out: string },
): SandboxLaunch {
  try {
    return execLaunchUnchecked(profile, attempt, o);
  } catch (err) {
    if (err instanceof SandboxRefused) throw new SandboxRefused(hostless(o.tree, o.out, o.home ?? os.homedir())(err.message));
    throw err;
  }
}

/**
 * `msg` with every host path the `run` tool's caller could learn from it spelled as a
 * placeholder: `<out>`, the snapshot's `<repo>`, the tree as `/work`, the home as `~` (review L1,
 * L2). The author reads every exec refusal; the operator reads the same line.
 */
export function hostless(tree: string, out: string, home: string): (msg: string) => string {
  let repo: string | undefined;
  try {
    repo = readSnapshot(out)?.repo;
  } catch {
    // No readable record: nothing more to spell.
  }
  // Any of these may be missing when the refusal is that it is missing.
  const spelled = ([[out, '<out>'], [tree, '/work'], [repo, '<repo>'], [home, '~']] as Array<[unknown, string]>)
    .filter((e): e is [string, string] => typeof e[0] === 'string' && e[0].length > 1)
    .flatMap(([p, to]) => [[p, to], [resolved(p), to]])
    .filter(([p]) => p.length > 1).sort((a, b) => b[0].length - a[0].length);
  return (msg: string) => spelled.reduce((m, [p, to]) => m.split(p).join(to), msg);
}

function execLaunchUnchecked(
  profile: SandboxProfile,
  attempt: Pick<Attempt, 'id' | 'missionId' | 'sandbox'>,
  o: { tree: string; command: string[]; limits?: SandboxLimits; home?: string; out: string },
): SandboxLaunch {
  if (!profile.available) throw new SandboxRefused(`sandbox unavailable: ${profile.why ?? 'no profile'}`);
  const why = execRefusal(attempt);
  if (why) throw new SandboxRefused(why);
  const cmd = checkExecCommand(o.command);
  if (!cmd.ok) throw new SandboxRefused(cmd.why);
  const tree = resolved(o.tree);
  if (!fs.statSync(tree, { throwIfNoEntry: false })?.isDirectory()) throw new SandboxRefused(`${tree} is not a directory`);
  // lstat, so a planted symlink named .git is caught as well as a directory.
  if (fs.lstatSync(path.join(tree, '.git'), { throwIfNoEntry: false })) throw new SandboxRefused('/work has a .git; exec runs over a detached workspace only');
  const treeWhy = mountRefusal(tree, { home: o.home ?? os.homedir(), out: o.out, allow: [tree] });
  if (treeWhy) throw new SandboxRefused(`refusing to mount the exec tree: ${treeWhy}`);
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  const cargo = isCargoTree(tree) ? authorCargo(tree, o.out, o.home ?? os.homedir(), attempt.missionId) : null;
  const b = baseSandbox(profile, limits, cargo?.env ?? {});
  b.rw(tree, WORK);
  for (const m of cargo?.binds ?? []) {
    if (m.kind === 'rw') b.rw(m.src, m.dest);
    else b.ro(m.src, m.dest);
  }
  b.argv.push('--remount-ro', '/', '--chdir', WORK, '--', ...cmd.argv);
  const bins = sandboxBinaries(profile);
  return { bin: bins.scope ?? bins.prlimit, argv: b.argv, env: { PATH: SYSTEM_PATH, ...scopeEnv() }, feeds: [], mounts: b.mounts };
}

/**
 * The author profile's cargo binds for `tree`, each through `mountRefusal`, or a refusal: no
 * snapshot, or a `Cargo.lock` that is not the one the snapshot was fetched for.
 */
function authorCargo(tree: string, out: string, home: string, mission: string): ReturnType<typeof cargoMounts> {
  // Every refusal here reaches the author through execLaunch, which spells host paths away.
  const why = snapshotRefusal(tree, out, readSnapshot(out)?.repo ?? '<repo>');
  if (why) throw new SandboxRefused(why);
  let m: ReturnType<typeof cargoMounts>;
  try {
    m = cargoMounts('author', out, { mission });
  } catch (err) {
    if (err instanceof CargoRefused) throw new SandboxRefused(err.message);
    throw err;
  }
  for (const bind of m.binds) {
    const refused = mountRefusal(bind.src, { home, out, allow: [bind.src], outAllow: [bind.src] });
    if (refused) throw new SandboxRefused(`refusing to mount the cargo ${bind.dest}: ${refused}`);
  }
  return m;
}

export function execArgv(
  profile: SandboxProfile, attempt: Pick<Attempt, 'id' | 'missionId' | 'sandbox'>, o: { tree: string; command: string[]; out: string; limits?: SandboxLimits },
): string[] {
  return execLaunch(profile, attempt, o).argv;
}

const EXEC_STREAM_CAP = 1024 * 1024;
/** What the agent reads back; the whole (capped, redacted) stream is the artifact. */
const EXEC_REPLY_CAP = 32 * 1024;

export interface ExecResult {
  exitCode: number | null;
  durationMs: number;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  artifacts: ArtifactRef[];
}

/** Spawn a launch, feed its fds, wait with an enforced wall clock, capture both streams. */
export function spawnLaunch(
  launch: SandboxLaunch, timeoutMs: number,
): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; truncated: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(launch.bin, launch.argv.slice(1), {
      argv0: launch.argv[0], cwd: '/', env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', ...launch.feeds.map(() => 'pipe' as const)],
    });
    launch.feeds.forEach((bytes, i) => {
      const pipe = child.stdio[3 + i] as NodeJS.WritableStream & { on(e: 'error', f: () => void): void };
      pipe.on('error', () => {});
      pipe.end(bytes);
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const take = (which: 'out' | 'err') => (d: Buffer) => {
      const cur = which === 'out' ? stdout : stderr;
      if (cur.length >= EXEC_STREAM_CAP) {
        truncated = true;
        return;
      }
      const next = (cur + d.toString('utf8')).slice(0, EXEC_STREAM_CAP);
      if (next.length === EXEC_STREAM_CAP) truncated = true;
      if (which === 'out') stdout = next;
      else stderr = next;
    };
    child.stdout!.on('data', take('out'));
    child.stderr!.on('data', take('err'));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, truncated, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, truncated, stdout, stderr });
    });
  });
}

/**
 * Run one command for an attempt that holds exec, in the exec sandbox. Both streams are
 * redacted, kept whole (to the cap) as `log` artifacts when a store is given, and returned
 * shortened for the agent.
 */
export async function runExec(
  attempt: Pick<Attempt, 'id' | 'missionId' | 'sandbox' | 'projectId'>,
  o: { tree: string; command: string[]; out: string; timeoutMs?: number; profile?: SandboxProfile; artifacts?: ArtifactStore; limits?: SandboxLimits },
): Promise<ExecResult> {
  const launch = execLaunch(o.profile ?? detectSandbox(), attempt, o);
  const t0 = Date.now();
  const run = await spawnLaunch(launch, Math.min(o.timeoutMs ?? 60_000, 600_000));
  const durationMs = Date.now() - t0;
  const out = redact(run.stdout).text;
  const err = redact(run.stderr).text;
  const artifacts: ArtifactRef[] = [];
  if (o.artifacts) {
    artifacts.push(o.artifacts.put(out, { kind: 'log', projectId: attempt.projectId, label: `exec stdout (${attempt.id})` }));
    artifacts.push(o.artifacts.put(err, { kind: 'log', projectId: attempt.projectId, label: `exec stderr (${attempt.id})` }));
  }
  return {
    exitCode: run.exitCode, durationMs, signal: run.signal, timedOut: run.timedOut,
    truncated: run.truncated || out.length > EXEC_REPLY_CAP || err.length > EXEC_REPLY_CAP,
    stdout: out.slice(0, EXEC_REPLY_CAP), stderr: err.slice(0, EXEC_REPLY_CAP), artifacts,
  };
}

/**
 * Offer `run` on an attempt's MCP server. Refused, at registration, unless the attempt's own
 * row says exec; a server without it simply has no such tool.
 */
export function registerRunTool(
  server: McpServer,
  ctx: {
    attempt: Pick<Attempt, 'id' | 'missionId' | 'sandbox' | 'projectId'>; tree: string; out: string;
    profile?: SandboxProfile; artifacts?: ArtifactStore; onRun?: (r: ExecResult, command: string[]) => void;
  },
): void {
  const why = execRefusal(ctx.attempt);
  if (why) throw new SandboxRefused(why);
  requireOut(ctx.out);
  server.registerTool(
    'run',
    {
      description:
        'Run one command over your workspace in a separate sandbox with no network. argv is an ' +
        'array (no shell): `node` or a binary under /usr/bin first. The tree is mounted at /work and ' +
        'writable; gate tests are not in it. Output is captured and returned.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        argv: z.array(z.string()).min(1).max(MAX_EXEC_ARGS),
        timeoutSeconds: z.number().min(1).max(600).optional(),
      },
    },
    async ({ argv, timeoutSeconds }) => {
      const checked = checkExecCommand(argv);
      if (!checked.ok) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: checked.why }) }], isError: true };
      try {
        const r = await runExec(ctx.attempt, {
          tree: ctx.tree, out: ctx.out, command: argv, timeoutMs: (timeoutSeconds ?? 60) * 1000, profile: ctx.profile, artifacts: ctx.artifacts,
        });
        ctx.onRun?.(r, argv);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, truncated: r.truncated,
              stdout: r.stdout, stderr: r.stderr, artifacts: r.artifacts.map((a) => a.digest),
            }),
          }],
        };
      } catch (err) {
        const text = hostless(ctx.tree, ctx.out, os.homedir())((err as Error).message);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: text }) }], isError: true };
      }
    },
  );
}
