/**
 * STUB — WS3 stand-in for WS2's `engine/forge/workspace.ts`. WS8 deletes this file and
 * repoints the one import in `engine/forge/gate.ts` at `../workspace.ts`.
 *
 * Signatures follow ws2-interface.md and interfaces-reconciled.md (`createWorkspace`,
 * `applyDiff`). The behaviour is the minimum gates need to run for real in WS3's tests: a
 * sibling bare git dir borrowing the repository's objects through alternates, a tree checked
 * out from a private index, and a diff applied there and re-derived to the same digest. The
 * real `.git` is only read. No owner marker, sweep or hidden-path handling: those are WS2's.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digestOf } from '../../mission/artifacts.ts';
import { HARDENED_GIT_CONFIG, hardenedGitEnv } from '../../experiment/runner.ts';

export interface Workspace {
  tree: string;
  gitDir: string;
  commit: string;
  files: number;
  dispose(): void;
}

/** The flags a candidate diff is captured with (ws2-interface.md, materialise step 5). */
export const DIFF_FLAGS = ['--binary', '--full-index', '--text', '--no-textconv', '--no-ext-diff', '--no-renames'];

function sibling(ws: { gitDir: string; tree: string }, args: string[], input?: Buffer): Buffer {
  return execFileSync('git', [
    ...HARDENED_GIT_CONFIG, '-c', 'core.autocrlf=false', `--git-dir=${ws.gitDir}`, `--work-tree=${ws.tree}`, ...args,
  ], {
    input, cwd: ws.tree, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...hardenedGitEnv(), GIT_INDEX_FILE: path.join(ws.gitDir, 'index') },
  });
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

export function createWorkspace(repo: string, commit: string, o: { hidden?: string[] } = {}): Workspace {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-forge-'));
  const ws = { gitDir: path.join(base, 'git'), tree: path.join(base, 'tree') };
  const dispose = () => fs.rmSync(base, { recursive: true, force: true });
  try {
    execFileSync('git', [...HARDENED_GIT_CONFIG, 'init', '-q', '--bare', '--template=', ws.gitDir], {
      stdio: 'ignore', env: hardenedGitEnv(), timeout: 60_000,
    });
    const common = execFileSync('git', [...HARDENED_GIT_CONFIG, '-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: hardenedGitEnv(), timeout: 60_000,
    }).trim();
    fs.mkdirSync(path.join(ws.gitDir, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(ws.gitDir, 'objects', 'info', 'alternates'), `${path.join(common, 'objects')}\n`);
    fs.mkdirSync(ws.tree);
    const sha = sibling(ws, ['rev-parse', '--verify', `${commit}^{commit}`]).toString('utf8').trim();
    sibling(ws, ['read-tree', sha]);
    sibling(ws, ['checkout-index', '-a', '-f', '-u']);
    const listed = sibling(ws, ['ls-tree', '-r', '-z', '--name-only', sha]).toString('utf8').split('\0').filter(Boolean);
    const files = countFiles(ws.tree);
    if (listed.length !== files) throw new Error(`materialised ${files} files, but ${sha.slice(0, 12)} has ${listed.length}`);
    for (const h of o.hidden ?? []) {
      if (fs.existsSync(path.join(ws.tree, h))) throw new Error(`${h} exists at ${sha.slice(0, 12)}; a hidden path must not`);
    }
    return { ...ws, commit: sha, files, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

/** The tree's changes against its commit, captured the way a candidate's are. */
export function diffOf(ws: Workspace): Buffer {
  sibling(ws, ['add', '-A']);
  return sibling(ws, ['diff', '--cached', ...DIFF_FLAGS, ws.commit]);
}

export function applyDiff(ws: Workspace, diff: Buffer, digest: string): { ok: true } | { invalid: string } {
  if (digestOf(diff) !== digest) return { invalid: `the diff's bytes hash to ${digestOf(diff)}, not ${digest}` };
  try {
    sibling(ws, ['apply', '--check', '--index', '--binary', '-'], diff);
    sibling(ws, ['apply', '--index', '--binary', '-'], diff);
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '').trim().split('\n')[0];
    return { invalid: `the diff does not apply to ${ws.commit.slice(0, 12)}: ${stderr || 'git apply refused it'}` };
  }
  const again = sibling(ws, ['diff', '--cached', ...DIFF_FLAGS, ws.commit]);
  if (digestOf(again) !== digest) return { invalid: `the applied tree re-derives to ${digestOf(again)}, not ${digest}` };
  return { ok: true };
}
