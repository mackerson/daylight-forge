import fs from 'node:fs';
import path from 'node:path';
import { ClaimStore } from '../store/claims.ts';
import { ArtifactStore } from './artifacts.ts';
import { EventLog } from './events.ts';
import { identifyProject } from './project.ts';
import { MissionStore } from './store.ts';
import type { ProjectIdentity } from './types.ts';

/**
 * Everything a mission command needs, opened once per output directory.
 *
 * Four stores share one directory and every command opens the same four, so the opening
 * lives here rather than in each `run*` function — and so does the one question every one
 * of them asks first: *which repository is this directory a map of?*
 */
export interface DaylightContext {
  out: string;
  store: MissionStore;
  events: EventLog;
  artifacts: ArtifactStore;
  claims: ClaimStore;
  close(): void;
}

export function openDaylight(out: string, now?: () => number): DaylightContext {
  fs.mkdirSync(out, { recursive: true });
  const store = new MissionStore(out, now);
  const events = new EventLog(out, now);
  const artifacts = new ArtifactStore(out);
  const claims = new ClaimStore(path.join(out, 'claims.db'), now);
  return {
    out, store, events, artifacts, claims,
    close() {
      store.close();
      events.close();
      claims.close();
    },
  };
}

/**
 * The repository an output directory holds a map of, from the small file.
 *
 * `view.json` is written by `map` and carries `root`; `graph.json` is the fallback and is
 * hundreds of megabytes on a large repo. No map means no project — a mission cannot be
 * created against a directory that has not been mapped, because its reviewers would have
 * nothing to read through the MCP server.
 */
export function mappedRoot(out: string): string | null {
  for (const name of ['view.json', 'graph.json']) {
    const file = path.join(out, name);
    if (!fs.existsSync(file)) continue;
    try {
      const root = (JSON.parse(fs.readFileSync(file, 'utf8')) as { root?: unknown }).root;
      if (typeof root === 'string' && root) return root;
    } catch {
      // A torn file answers nothing; the next candidate might.
    }
  }
  return null;
}

/** The project the output directory is about, or null when it holds no map. */
export function mappedProject(out: string): ProjectIdentity | null {
  const root = mappedRoot(out);
  return root ? identifyProject(root) : null;
}

/**
 * Refuse a repository the output directory does not belong to.
 *
 * The same rule `map` enforces, applied here because a mission writes claims into this
 * directory's store by repo-relative path: a mission on the wrong repo would file one
 * project's reviews as the other's.
 */
export function requireMappedRepo(out: string, repo: string): { root: string; project: ProjectIdentity } {
  const root = mappedRoot(out);
  if (!root) {
    throw new Error(`${out} holds no map — run \`daylight map ${repo} --out ${out}\` first`);
  }
  if (path.resolve(root) !== path.resolve(repo)) {
    throw new Error(
      `${out} holds a map of ${root}, not ${repo}. An output directory belongs to one ` +
        'repository; use a separate --out for this one.',
    );
  }
  return { root: path.resolve(root), project: identifyProject(root) };
}
