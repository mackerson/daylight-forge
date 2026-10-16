import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The execution boundary for experiments.
 *
 * A git worktree is a copy of the code, not a sandbox: a test in it can read the home
 * directory, open a socket and write anywhere the user can. So a run is wrapped in
 * bubblewrap — fresh namespaces for everything, the worktree bound read-only at `/work`,
 * a private `/tmp`, no network — and `prlimit` puts ceilings on CPU time, file size and open
 * files. Memory is deliberately *not* bounded by address space: V8 reserves large virtual
 * ranges at start-up and an `--as` limit kills a healthy node before it runs a line. The
 * wall-clock timeout in the runner and the CPU ceiling here are what bound a runaway, and
 * every result says so in its limitations. Where a systemd user manager is reachable the whole
 * launch also runs in a transient scope with `MemoryMax` and `TasksMax` — a cgroup bounds the
 * resident memory and the process count that per-process rlimits cannot (`RLIMIT_CPU` resets
 * in every forked child). The private `/tmp` is RAM-backed, so it has a size of its own.
 *
 * Fail closed. Without `bwrap` and `prlimit` on this machine there is no profile, and the
 * runner records the experiment as `invalid: sandbox unavailable` rather than running the
 * test in the open. Nothing here builds a shell string; every argument is one argv element.
 */

export interface SandboxProfile {
  name: 'bwrap';
  available: boolean;
  why?: string;
  /** Absolute paths resolved at detection; an injected profile without them gets the defaults. */
  bwrap?: string;
  prlimit?: string;
  /** `systemd-run`, absolute, when a user scope was shown to work at detection. */
  scope?: string;
}

/**
 * Where the sandbox's own tools are looked up, and the PATH the launcher runs with. Never
 * the user's PATH: `~/.local/bin` and friends precede `/usr/bin` on most desktops, and a
 * same-uid shim named `bwrap` there would be a sandbox that is not one.
 */
export const SYSTEM_PATH = '/usr/bin:/bin';
const SYSTEM_BIN = '/usr/bin/';

export interface SandboxLimits {
  cpuSeconds: number;
  fileSizeBytes: number;
  openFiles: number;
  /** Size of the private /tmp. */
  tmpBytes?: number;
  /** cgroup ceilings, applied only under a systemd user scope. */
  memoryBytes?: number;
  tasks?: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  cpuSeconds: 60,
  fileSizeBytes: 64 * 1024 * 1024,
  openFiles: 1024,
  tmpBytes: 256 * 1024 * 1024,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  tasks: 256,
};

/** Said on every result that ran without a user scope. */
export const NO_SCOPE_LIMITATION =
  'no memory or process-count ceiling: no systemd user scope was available to put the run in';

/** The variables systemd-run needs to reach the user manager. Neither is a credential. */
export function scopeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

/** Where the worktree appears inside the sandbox. Commands run with this as cwd. */
export const WORK = '/work';

export const SANDBOX_LIMITATIONS = [
  'memory is bounded by the wall-clock timeout and the CPU ceiling, not by address space',
  'the worktree is mounted read-only; the test may write only to a private /tmp',
  'no network inside the sandbox',
];

/** `name` as installed by the system — resolved under /usr/bin, root-owned, not group/world-writable. */
function systemBinary(name: string): string | null {
  for (const dir of SYSTEM_PATH.split(':')) {
    let real: string;
    try {
      real = fs.realpathSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!real.startsWith(SYSTEM_BIN)) continue;
    const st = fs.statSync(real);
    if (st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0) return real;
  }
  return null;
}

export function detectSandbox(): SandboxProfile {
  const bwrap = systemBinary('bwrap');
  const prlimit = systemBinary('prlimit');
  const missing = [bwrap ? null : 'bwrap', prlimit ? null : 'prlimit'].filter(Boolean);
  if (!bwrap || !prlimit) {
    return {
      name: 'bwrap',
      available: false,
      why: `${missing.join(' and ')} not installed under ${SYSTEM_BIN} (root-owned); install bubblewrap and util-linux`,
    };
  }
  return { name: 'bwrap', available: true, bwrap, prlimit, ...(userScope() ? { scope: userScope()! } : {}) };
}

let scopeProbe: string | null | undefined;

/**
 * `systemd-run` if a transient user scope can actually be created here, else null. Probed
 * once per process: a CI runner or a container has the binary and no user manager, and a
 * launcher that fails at run time is a failed experiment, not a sandbox.
 */
function userScope(): string | null {
  if (scopeProbe !== undefined) return scopeProbe;
  const bin = systemBinary('systemd-run');
  scopeProbe = null;
  if (!bin) return scopeProbe;
  try {
    execFileSync(bin, ['--user', '--scope', '--quiet', '--collect', '-p', 'TasksMax=8', '--', '/usr/bin/true'], {
      stdio: 'ignore', timeout: 10_000, env: { PATH: SYSTEM_PATH, ...scopeEnv() },
    });
    scopeProbe = bin;
  } catch {
    // No user manager reachable; the run goes ahead without cgroup ceilings and says so.
  }
  return scopeProbe;
}

/** The binaries a profile launches, absolute. */
export function sandboxBinaries(profile: SandboxProfile): { prlimit: string; bwrap: string; scope?: string } {
  return {
    prlimit: profile.prlimit ?? '/usr/bin/prlimit', bwrap: profile.bwrap ?? '/usr/bin/bwrap',
    ...(profile.scope ? { scope: profile.scope } : {}),
  };
}

/**
 * The node that is running us, resolved through any version-manager symlink.
 *
 * Inside the sandbox `/usr/bin/node` may be a different major version from the one the
 * tests were written against — on the dev machine it is. Running the experiment on the
 * same binary as the harness is the only way "it passed here" means anything.
 */
export function nodeBinary(): string {
  return fs.realpathSync(process.execPath);
}

/**
 * The directory to bind so this node works inside the sandbox, or null when it is already
 * under `/usr`. The installation root (parent of `bin/`), so a version manager's `lib/`
 * sits beside the binary the way node expects.
 */
export function nodeBind(bin: string): string | null {
  if (bin.startsWith('/usr/')) return null;
  return path.dirname(path.dirname(bin));
}

const REFUSED_FLAGS = new Set([
  '-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader',
  '--experimental-loader',
]);

/**
 * The flags a command may carry, and for those that take one, which values. Everything else
 * is refused: node grows flags that load code by name every release (`--env-file` reads
 * NODE_OPTIONS from a committed file, reporters and config files are modules), and a
 * blocklist only ever names the ones somebody already noticed.
 */
const ALLOWED_FLAGS: Record<string, ((value: string) => boolean) | null> = {
  '--test': null,
  '--enable-source-maps': null,
  '--experimental-strip-types': null,
  '--test-reporter': (v) => v === 'spec' || v === 'tap' || v === 'dot',
  '--test-name-pattern': (v) => v.length > 0,
};

/**
 * Is this a command the runner will execute at all?
 *
 * Only `node`, only on files inside the worktree, with only the flags above. Flags that
 * evaluate or preload code from an argument would let a command smuggle in a test that was
 * never registered. A `--flag=value` is judged by name and value; a bare non-flag argument
 * is treated as a path and must resolve inside the worktree, whether or not it exists yet.
 */
export function checkAllowlist(
  command: string[], worktree: string,
): { ok: true } | { ok: false; why: string } {
  if (!command.length) return { ok: false, why: 'empty command' };
  if (command[0] !== 'node') {
    return { ok: false, why: `only \`node\` is allowed; got \`${command[0]}\`` };
  }
  const root = path.resolve(worktree);
  for (const arg of command.slice(1)) {
    if (arg.startsWith('-')) {
      const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (REFUSED_FLAGS.has(name) || name.startsWith('--inspect')) {
        return {
          ok: false,
          why: `\`${name}\` evaluates or preloads code from outside the registered test`,
        };
      }
      if (!(name in ALLOWED_FLAGS)) {
        return { ok: false, why: `\`${name}\` is not one of the flags an experiment may use: ${Object.keys(ALLOWED_FLAGS).join(', ')}` };
      }
      const takesValue = ALLOWED_FLAGS[name];
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
      if (takesValue ? value === null || !takesValue(value) : value !== null) {
        return { ok: false, why: `\`${arg}\` is not an allowed use of \`${name}\`` };
      }
      continue;
    }
    const abs = path.resolve(root, arg);
    if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
      return { ok: false, why: `\`${arg}\` resolves outside the worktree` };
    }
  }
  return { ok: true };
}

/**
 * The command as it runs inside the sandbox: our own node, paths under `/work`.
 *
 * Assumes `checkAllowlist` passed, so every non-flag argument resolves inside `worktree`.
 */
export function sandboxCommand(command: string[], worktree: string): string[] {
  const root = path.resolve(worktree);
  return [
    nodeBinary(),
    ...command.slice(1).map((arg) => {
      if (arg.startsWith('-')) return arg;
      const abs = path.resolve(root, arg);
      if (abs === root) return WORK;
      return path.posix.join(WORK, path.relative(root, abs).split(path.sep).join('/'));
    }),
  ];
}

export function sandboxArgv(
  profile: SandboxProfile,
  opts: {
    worktree: string;
    command: string[];
    limits?: SandboxLimits;
    env?: Record<string, string>;
    /**
     * Files laid over the worktree from file descriptors the runner feeds, so their bytes
     * come from the runner's memory rather than from a directory the same uid can rewrite.
     * `path` is worktree-relative and must already exist there as a mount point.
     */
    files?: Array<{ fd: number; path: string }>;
    /** bwrap writes JSON status here, including the child's pid once it has started it. */
    statusFd?: number;
  },
): string[] {
  if (!profile.available) {
    throw new Error(`sandbox unavailable: ${profile.why ?? 'no profile'}`);
  }
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const bin = nodeBinary();
  const bind = nodeBind(bin);
  const scope = profile.scope
    ? [
        'systemd-run', '--user', '--scope', '--quiet', '--collect',
        '-p', `MemoryMax=${limits.memoryBytes}`, '-p', 'MemorySwapMax=0', '-p', `TasksMax=${limits.tasks}`,
        '--',
      ]
    : [];
  const argv = [
    ...scope,
    // Under a scope, systemd-run resolves this one, so it is named by the path detection found.
    scope.length ? (profile.prlimit ?? '/usr/bin/prlimit') : 'prlimit',
    `--cpu=${limits.cpuSeconds}`,
    `--fsize=${limits.fileSizeBytes}`,
    `--nofile=${limits.openFiles}`,
    '--',
    'bwrap',
    '--unshare-all',
    // Explicit so --disable-userns has a namespace to seal; nested user namespaces are kernel
    // attack surface a test has no use for.
    '--unshare-user',
    '--disable-userns',
    '--die-with-parent',
    '--new-session',
    ...(opts.statusFd !== undefined ? ['--json-status-fd', String(opts.statusFd)] : []),
    '--clearenv',
    '--setenv', 'PATH', bind ? `${path.dirname(bin)}:/usr/bin:/bin` : '/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp',
  ];
  for (const [k, v] of Object.entries(opts.env ?? {})) argv.push('--setenv', k, v);
  argv.push(
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/bin', '/sbin',
  );
  if (fs.existsSync('/etc/ld.so.cache')) {
    argv.push('--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache');
  }
  if (bind) argv.push('--ro-bind', bind, bind);
  argv.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--size', String(limits.tmpBytes), '--tmpfs', '/tmp',
    '--ro-bind', path.resolve(opts.worktree), WORK,
  );
  for (const f of opts.files ?? []) argv.push('--ro-bind-data', String(f.fd), path.posix.join(WORK, f.path));
  argv.push(
    '--chdir', WORK,
    '--',
    ...sandboxCommand(opts.command, opts.worktree),
  );
  return argv;
}
