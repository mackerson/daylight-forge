import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { identifyProject } from './mission/project.ts';

/**
 * Where output goes when no `--out` is given.
 *
 * Outside the repository, so a reviewer that can read the repo does not find the claims
 * database beside it by relative path, and the map never shows up in the tree it maps.
 * Keyed by project and then by checkout: two checkouts of one project are two claim stores,
 * because a repo-relative path in one need not mean the same file in the other — the same
 * reason `guardOutputDirectory` refuses an out dir that holds another root's map.
 *
 * `app/main/session.cjs` computes the same directory for the GUI; the shared vector in
 * engine/test/out-default.ts holds the two to one answer.
 */

/** `$XDG_DATA_HOME`, or `~/.local/share` when it is unset, empty or relative (XDG spec). */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'share');
}

/** `git:38fa…` → `git-38fa…`: the id stored in rows keeps its colon, the directory does not. */
export function projectDirName(projectId: string): string {
  return projectId.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** The first eight hex characters of sha256 of the checkout's absolute path. */
export function checkoutHash(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 8);
}

/** `<data home>/daylight/<project id, sanitised>/<checkout hash>` for an already-known id. */
export function outFor(projectId: string, root: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataHome(env), 'daylight', projectDirName(projectId), checkoutHash(root));
}

/** The default `<out>` for the repository at `root`. */
export function defaultOut(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return outFor(identifyProject(root).id, root, env);
}
