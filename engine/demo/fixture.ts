import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentRevision, identifyProject } from '../mission/project.ts';
import type { ProjectIdentity, Revision } from '../mission/types.ts';

/**
 * The demo fixture, made into a repository.
 *
 * `fixtures/daylight-demo/` is a plain tree in this repo: a nested git repository would be a
 * submodule in all but name, and a tree is reviewable in a diff. But a mission is about a
 * *revision*, experiments check out a *commit*, and project identity is a *first commit* —
 * so the demo needs the tree as a repository. This makes one, and makes the same one every
 * time: fixed author, fixed dates, normalised modes, LF line endings, so the commit sha is a
 * property of the fixture's bytes and nothing else. Two machines running the demo are then
 * talking about the same revision, which is the whole point of recording one.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(HERE, '..', '..', 'fixtures', 'daylight-demo');

/**
 * The sha `materialiseFixture` produces from the current fixture tree.
 *
 * Any change to any byte under `fixtures/daylight-demo/` legitimately changes this — update
 * it alongside the change, in the same commit, so the test pins the tree it was made for.
 */
export const EXPECTED_FIXTURE_COMMIT = '38fa20074d8003c2860e3e0f605dd562d827eb5e';

const IDENTITY = { name: 'Daylight Fixture', email: 'fixture@daylight.local' };
const DATE = '2026-10-01T12:00:00Z';

export interface MaterialisedFixture {
  root: string;
  commit: string;
  projectId: string;
  revision: Revision;
  identity: ProjectIdentity;
}

/** Files under `dir`, repo-relative with posix separators, sorted so the walk is stable. */
function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const e of entries) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, next));
    else if (e.isFile()) out.push(next);
  }
  return out;
}

/**
 * Copy the fixture with its bytes normalised: LF endings, 0644 for everything (nothing in
 * the fixture is executable), written in sorted order. Git hashes content and mode, so
 * these are the two things a checkout on another machine could otherwise change.
 */
function copyTree(from: string, to: string): string[] {
  const files = walk(from);
  for (const rel of files) {
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const bytes = fs.readFileSync(path.join(from, rel));
    const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(dest, text, { mode: 0o644 });
  }
  return files;
}

export function materialiseFixture(dest: string): MaterialisedFixture {
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) {
    throw new Error(`refusing to materialise the fixture into a non-empty directory: ${root}`);
  }
  copyTree(FIXTURE_DIR, root);

  const git = (args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email,
        GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
        GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE,
        // A user's global config must not reach into the hash: no signing, no hooks, no
        // autocrlf rewriting the LF we just wrote.
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();

  git(['init', '-q', '-b', 'main']);
  git(['-c', 'core.autocrlf=false', 'add', '-A']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Plant the daylight-demo fixture',
    '-m', 'PLANTED fixture for the Daylight demonstration; see DEFECT.md.']);

  const identity = identifyProject(root);
  const revision = currentRevision(root);
  return {
    root,
    commit: revision.commit ?? '',
    projectId: identity.id,
    revision,
    identity,
  };
}
