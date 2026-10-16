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
 * every result says so in its limitations.
 *
 * Fail closed. Without `bwrap` and `prlimit` on this machine there is no profile, and the
 * runner records the experiment as `invalid: sandbox unavailable` rather than running the
 * test in the open. Nothing here builds a shell string; every argument is one argv element.
 */

export interface SandboxProfile {
  name: 'bwrap';
  available: boolean;
  why?: string;
}

export interface SandboxLimits {
  cpuSeconds: number;
  fileSizeBytes: number;
  openFiles: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  cpuSeconds: 60,
  fileSizeBytes: 64 * 1024 * 1024,
  openFiles: 1024,
};

/** Where the worktree appears inside the sandbox. Commands run with this as cwd. */
export const WORK = '/work';

export const SANDBOX_LIMITATIONS = [
  'memory is bounded by the wall-clock timeout and the CPU ceiling, not by address space',
  'the worktree is mounted read-only; the test may write only to a private /tmp',
  'no network inside the sandbox',
];

function onPath(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectSandbox(): SandboxProfile {
  const missing = ['bwrap', 'prlimit'].filter((b) => !onPath(b));
  if (missing.length) {
    return {
      name: 'bwrap',
      available: false,
      why: `${missing.join(' and ')} not on PATH; install bubblewrap and util-linux`,
    };
  }
  return { name: 'bwrap', available: true };
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
 * Is this a command the runner will execute at all?
 *
 * Only `node`, only on files inside the worktree. Flags that evaluate or preload code from
 * an argument are refused because they let a command smuggle in a test that was never
 * registered. A `--flag=value` is judged by the flag name; a bare non-flag argument is
 * treated as a path and must resolve inside the worktree, whether or not it exists yet.
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
  },
): string[] {
  if (!profile.available) {
    throw new Error(`sandbox unavailable: ${profile.why ?? 'no profile'}`);
  }
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const bin = nodeBinary();
  const bind = nodeBind(bin);
  const argv = [
    'prlimit',
    `--cpu=${limits.cpuSeconds}`,
    `--fsize=${limits.fileSizeBytes}`,
    `--nofile=${limits.openFiles}`,
    '--',
    'bwrap',
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
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
    '--tmpfs', '/tmp',
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
