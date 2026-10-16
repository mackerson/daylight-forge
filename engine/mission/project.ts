import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProjectIdentity, Revision } from './types.ts';

/**
 * Project and revision identity, measured from the repository rather than assumed.
 *
 * Every git call here is bounded and allowed to fail: a directory that is not a repository is
 * a legitimate project, it just cannot be reproduced by anyone else and the revision says so.
 */

const git = (root: string, args: string[]): string | null => {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

/**
 * `git:<first-commit>` where there is history, else `path:<hash of the absolute root>`.
 *
 * A repository can have several root commits (a merged-in unrelated history); the smallest
 * is taken so two clones agree. Twelve hex characters: enough that a collision is not a
 * thing anyone will see, short enough to read in a table.
 */
export function identifyProject(root: string): ProjectIdentity {
  const abs = path.resolve(root);
  // In a shallow clone the parentless commit is the graft boundary, so two clones of one
  // project would get two ids, and missions recorded under one would be orphaned by the next.
  if (git(abs, ['rev-parse', '--is-shallow-repository']) === 'true') {
    throw new Error(
      `${abs} is a shallow clone, so its first commit — the project's identity — is not ` +
        'knowable here. Run `git fetch --unshallow` and try again.',
    );
  }
  const roots = git(abs, ['rev-list', '--max-parents=0', 'HEAD']);
  const first = roots
    ? roots.split('\n').map((s) => s.trim()).filter(Boolean).sort()[0]
    : undefined;
  const id = first
    ? `git:${first.slice(0, 12)}`
    : `path:${createHash('sha256').update(abs).digest('hex').slice(0, 12)}`;
  return { id, root: abs, name: path.basename(abs) || 'repo' };
}

export function currentRevision(root: string): Revision {
  const abs = path.resolve(root);
  const commit = git(abs, ['rev-parse', 'HEAD']);
  if (!commit) return { commit: null, dirty: false, label: 'unversioned' };
  const status = git(abs, ['status', '--porcelain', '--untracked-files=no']);
  // A status that failed or timed out says nothing about the tree, and reading it as clean
  // would let an unreproducible revision through as a commit. `+unknown` is refused wherever
  // a bare commit is required, and counts as dirty for anyone asking.
  if (status === null) return { commit, dirty: true, label: `${commit}+unknown` };
  const dirty = status.length > 0;
  return { commit, dirty, label: dirty ? `${commit}+dirty` : commit };
}

/** The twelve characters a table shows, for a label `currentRevision` produced. */
export function shortRevision(label: string): string {
  if (label === 'unversioned') return label;
  const [sha, suffix] = label.split('+');
  return suffix ? `${sha.slice(0, 12)}+${suffix}` : sha.slice(0, 12);
}
