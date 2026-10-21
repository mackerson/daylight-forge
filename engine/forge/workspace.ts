import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digestOf } from '../mission/artifacts.ts';
import { HARDENED_GIT_CONFIG, hardenedGitEnv, processAlive } from '../experiment/runner.ts';

/**
 * The author's detached workspace (PLAN resolution 1, F-2).
 *
 * A `git worktree add` runs `post-checkout` on the host and an `add -A` in it writes the
 * agent's blobs into the real object store (Sec H3). So the tree is materialised from a
 * sibling bare git dir whose only link to the repository is `objects/info/alternates`: a
 * temp index is filled by `read-tree`, written out by `checkout-index`, and later read back
 * by `add -A` into that same sibling. The real `.git` is only ever read.
 *
 * The sibling is made with `--template=` and a null global and system config, so it has no
 * hooks and no filter drivers, and every call reads attributes from the empty tree, so no
 * committed `.gitattributes` can smudge, convert line endings or expand idents on the way
 * out or back in. `export-ignore` is an archive attribute and means nothing to a checkout:
 * the author sees exactly the files the gates will (the reason `git archive` was rejected).
 *
 * The tree is the only thing a sandbox ever binds. The sibling git dir sits beside it, never
 * under it, and is never mounted.
 */

/** Scratch directories this module owns. WS0's experiment sweep ignores the prefix. */
export const WORKSPACE_PREFIX = 'daylight-forge-';
const OWNER_FILE = 'owner.json';
const GIT_TIMEOUT_MS = 120_000;
/** Enough for any diff the caps let through, with room for the refusal to be about the cap. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** The well-known empty tree: attributes are read from here, so none apply. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class WorkspaceRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRefused';
  }
}

export interface Workspace {
  /** The 0700 scratch directory holding `tree/`, `git/` and `owner.json`. */
  base: string;
  /** The materialised files. The only path a sandbox binds. */
  tree: string;
  /** The sibling bare git dir. Never mounted. */
  gitDir: string;
  /** The full commit sha the tree was materialised from. */
  commit: string;
  /** The repository the objects come from, resolved. */
  repo: string;
  /** Index entries written to disk (gitlinks excluded: a checkout writes no file for them). */
  files: number;
  dispose(): void;
}

interface WorkspaceOwner { pid: number; repoRoot: string; commit: string; startedAt: number }

/**
 * Git against the sibling, hardened as the runner runs it (no hooks, fsmonitor, ssh command,
 * user or system config, caller GIT_* variables), with CRLF conversion and attributes off.
 */
export function siblingGit(
  ws: Pick<Workspace, 'gitDir' | 'tree'>, args: string[], o: { input?: Buffer } = {},
): Buffer {
  return execFileSync('git', [
    ...HARDENED_GIT_CONFIG, '-c', 'core.autocrlf=false', '-c', 'core.symlinks=true',
    '-c', 'core.fileMode=true', '-c', 'core.excludesFile=/dev/null',
    `--attr-source=${EMPTY_TREE}`, ...args,
  ], {
    env: {
      ...hardenedGitEnv(),
      GIT_DIR: ws.gitDir, GIT_WORK_TREE: ws.tree, GIT_INDEX_FILE: path.join(ws.gitDir, 'index'),
      GIT_ATTR_NOSYSTEM: '1',
    },
    // From the top of the tree: `apply` and pathspecs are relative to the cwd, and a cwd
    // outside the work tree makes `apply` skip every path without saying so.
    cwd: ws.tree,
    stdio: [o.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    input: o.input,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

const repoGit = (repo: string, args: string[]): string =>
  execFileSync('git', [...HARDENED_GIT_CONFIG, '-C', repo, ...args], {
    encoding: 'utf8', env: hardenedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS,
  }).trim();

const stderrOf = (err: unknown): string => {
  const e = err as { stderr?: Buffer | string; message?: string };
  const s = e.stderr ? String(e.stderr) : (e.message ?? String(err));
  return s.split('\n').find((l) => l.trim())?.slice(0, 300) ?? 'git failed';
};

const normalise = (p: string) => path.posix.normalize(p.trim()).replace(/^(\.\/)+/, '').replace(/\/+$/, '');

/**
 * Every non-directory entry under `root`, by lstat. A symlink is counted as itself and never
 * followed: the tree is the author's, and on the host nothing reads through its links.
 */
export function walkTree(root: string): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        stack.push(p);
        continue;
      }
      entries++;
      if (d.isFile()) bytes += fs.lstatSync(p).size;
    }
  }
  return { entries, bytes };
}

/**
 * Remove a scratch directory without git and without following a link. A sandboxed author
 * can `chmod 000` a directory in its tree, which would make a plain recursive remove fail,
 * so directories (by lstat, never through a link) get their owner bits back first.
 */
export function removeScratch(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // Fall through: restore permissions and retry.
  }
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(d);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      continue;
    }
    for (const name of fs.readdirSync(d)) stack.push(path.join(d, name));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Materialise `commit` of `repo` into a fresh detached workspace.
 *
 * Refused (nothing left behind): a commit that does not resolve, a tree whose files on disk do
 * not number its index entries, and any `hidden` path (a locked holdout) present at the base.
 */
export function createWorkspace(
  repo: string, commit: string, o: { hidden?: string[]; tmp?: string } = {},
): Workspace {
  const repoRoot = fs.realpathSync(repo);
  let common: string;
  try {
    common = repoGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch (err) {
    throw new WorkspaceRefused(`${repoRoot} is not a git repository: ${stderrOf(err)}`);
  }
  const objects = path.join(common, 'objects');
  if (!fs.statSync(objects, { throwIfNoEntry: false })?.isDirectory()) {
    throw new WorkspaceRefused(`${repoRoot} has no object store at ${objects}`);
  }

  const base = fs.mkdtempSync(path.join(o.tmp ?? os.tmpdir(), WORKSPACE_PREFIX));
  fs.chmodSync(base, 0o700);
  const ws = { base, tree: path.join(base, 'tree'), gitDir: path.join(base, 'git') };
  const dispose = () => removeScratch(base);
  try {
    fs.writeFileSync(path.join(base, OWNER_FILE), JSON.stringify({
      pid: process.pid, repoRoot, commit, startedAt: Date.now(),
    } satisfies WorkspaceOwner));
    fs.mkdirSync(ws.tree, { mode: 0o700 });
    execFileSync('git', [...HARDENED_GIT_CONFIG, 'init', '--bare', '--quiet', '--template=', ws.gitDir], {
      env: hardenedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS,
    });
    fs.mkdirSync(path.join(ws.gitDir, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(ws.gitDir, 'objects', 'info', 'alternates'), `${objects}\n`);

    let sha: string;
    try {
      sha = siblingGit(ws, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`]).toString('utf8').trim();
    } catch (err) {
      throw new WorkspaceRefused(`${commit} is not a commit of ${repoRoot}: ${stderrOf(err)}`);
    }
    siblingGit(ws, ['read-tree', sha]);

    const index = siblingGit(ws, ['ls-files', '-s', '-z']).toString('utf8').split('\0').filter(Boolean)
      .map((line) => ({ mode: line.slice(0, 6), path: line.slice(line.indexOf('\t') + 1) }));
    const hidden = (o.hidden ?? []).map(normalise).filter(Boolean);
    const exposed = index.filter((e) => hidden.some((h) => e.path === h || e.path.startsWith(`${h}/`)));
    if (exposed.length) {
      // Counts only (P2-R45 D7): this text reaches events, CLI JSON and the GUI's job output.
      throw new WorkspaceRefused(
        `${exposed.length} holdout file${exposed.length === 1 ? '' : 's'} present at base; ` +
        'the author would read them, so no workspace is made',
      );
    }

    siblingGit(ws, ['checkout-index', '--all', '--force', '--index']);
    const expected = index.filter((e) => e.mode !== '160000').length;
    const onDisk = walkTree(ws.tree).entries;
    if (onDisk !== expected) {
      throw new WorkspaceRefused(`the checkout wrote ${onDisk} files for ${expected} index entries; the tree is not the commit`);
    }
    return { ...ws, commit: sha, repo: repoRoot, files: expected, dispose };
  } catch (err) {
    dispose();
    if (err instanceof WorkspaceRefused) throw err;
    throw new WorkspaceRefused(`materialising ${commit}: ${stderrOf(err)}`);
  }
}

/**
 * Apply a recorded diff to a fresh workspace, both tree and temp index, after checking the
 * bytes are the ones the digest names. `git apply` refuses paths outside the tree and paths
 * through a symlink, which is the behaviour wanted; no `--unsafe-paths`.
 */
export function applyDiff(ws: Workspace, diff: Buffer, digest: string): { ok: true } | { invalid: string } {
  const actual = digestOf(diff);
  if (actual !== digest) return { invalid: `the diff's bytes digest to ${actual}, not ${digest}` };
  if (!diff.length) return { ok: true };
  try {
    siblingGit(ws, ['apply', '--index', '--whitespace=nowarn', '-'], { input: diff });
    return { ok: true };
  } catch (err) {
    return { invalid: `the diff does not apply to ${ws.commit.slice(0, 12)}: ${stderrOf(err)}` };
  }
}

/**
 * Remove workspaces whose runner died before disposing of them. Git-free: a dead workspace is
 * just files. Only a real directory this uid made with mode 0700, carrying an `owner.json`
 * whose process is gone, is removed; anything else under the prefix is left exactly as found.
 */
export function sweepWorkspaces(tmp: string = os.tmpdir()): number {
  const uid = process.getuid?.();
  let swept = 0;
  for (const name of fs.readdirSync(tmp).filter((n) => n.startsWith(WORKSPACE_PREFIX))) {
    const dir = path.join(tmp, name);
    let owner: WorkspaceOwner;
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) continue;
      const file = path.join(dir, OWNER_FILE);
      if (!fs.lstatSync(file).isFile()) continue;
      owner = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkspaceOwner;
    } catch {
      continue;
    }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || processAlive(owner.pid)) continue;
    removeScratch(dir);
    swept++;
  }
  return swept;
}
