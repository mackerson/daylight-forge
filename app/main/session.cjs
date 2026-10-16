const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

/**
 * What the Electron shell reads out of an output directory: which repository it belongs to,
 * where a repository's output goes, and the cached JSON in between.
 *
 * Lifted out of main.cjs so these rules can be tested. An output directory belongs to one
 * repository — `claims.db` in it addresses files by repo-relative path with no repo in the
 * subject — and until now the shell's half of that invariant was asserted only indirectly,
 * through the CLI contract it reads. The shell's half is where it was actually broken.
 */

/**
 * JSON out of an output directory, re-parsed only when the file changes.
 *
 * `daylight:load` reads five of these, and it is called on mount, on every action, on every
 * finished job and on every derive — and derive fires whenever `claims.db` moves, so a
 * running swarm had the process that draws the window re-parsing the whole output directory
 * every couple of seconds to hand back bytes it had already seen. Keyed by mtime, which is
 * the same fix already made for `symbols.json` and for the `graph.json`→`view.json` split.
 */
const cache = new Map();

function readJsonIn(dir, name, fallback = null) {
  const file = path.join(dir, name);
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return fallback;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;
  let value = fallback;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Cached as the fallback anyway: a file we cannot parse does not become parseable by
    // being read again a second later, and some of these are hundreds of megabytes.
  }
  cache.set(file, { mtime, value });
  return value;
}

/**
 * The same, uncached, for `graph.json` — the exhaustive record, 322MB on a ten-thousand-file
 * repo. Holding that resident to save a read nobody makes twice trades one problem for a
 * worse one.
 */
function readJsonRaw(dir, name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * The same, for a `.jsonl` ledger: one object per line, oldest first.
 *
 * A corrupt line loses one entry rather than the file — these are appended to while a run is
 * in flight, so a half-written last line is an ordinary thing to read, not a failure.
 */
function readJsonlIn(dir, name) {
  const text = readTextIn(dir, name);
  if (text === null) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Appended to live; a torn final line is expected, not exceptional.
    }
  }
  return out;
}

/** Raw text, cached by mtime the same way the parsed reads are. */
function readTextIn(dir, name) {
  const file = path.join(dir, name);
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;
  let value = null;
  try {
    value = fs.readFileSync(file, 'utf8');
  } catch {
    // Unreadable is the same as absent for everything that calls this.
  }
  cache.set(file, { mtime, value });
  return value;
}

/** Drop everything read out of a directory; the shell calls this when the directory moves. */
function forgetCachedJson() {
  cache.clear();
}

/** Paths compare resolved: `~/api` and `~/api/` are one repository, not two. */
function sameRepo(a, b) {
  return !!a && !!b && path.resolve(a) === path.resolve(b);
}

/**
 * The repository a map was made from, or null if the directory holds no map.
 *
 * `view.json` first because it carries `root` and is under a megabyte, where `graph.json` is
 * hundreds on a large repo and must not be parsed to answer a question this small.
 */
function repoOfDir(dir) {
  const view = readJsonIn(dir, 'view.json');
  if (view && typeof view.root === 'string') return view.root;
  const graph = readJsonRaw(dir, 'graph.json');
  return graph && typeof graph.root === 'string' ? graph.root : null;
}

/** `$XDG_DATA_HOME`, or `~/.local/share` when it is unset, empty or relative. */
function dataHome(env = process.env) {
  const xdg = env.XDG_DATA_HOME;
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'share');
}

const git = (root, args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

/**
 * The project id, computed as engine/mission/project.ts `identifyProject` computes it.
 *
 * A twin rather than an import: the shell is CommonJS and shells out to the engine instead of
 * loading its TypeScript. `session.test.cjs` maps a repo through the real CLI and checks the
 * two land on the same directory, so a drift fails the suite.
 */
function projectIdOf(repo) {
  const abs = path.resolve(repo);
  if (git(abs, ['rev-parse', '--is-shallow-repository']) === 'true') {
    throw new Error(`${abs} is a shallow clone, so its project id is not knowable here. ` +
      'Run `git fetch --unshallow`, or choose an output directory by hand.');
  }
  const roots = git(abs, ['rev-list', '--max-parents=0', 'HEAD']);
  const first = roots ? roots.split('\n').map((s) => s.trim()).filter(Boolean).sort()[0] : undefined;
  return first
    ? `git:${first.slice(0, 12)}`
    : `path:${createHash('sha256').update(abs).digest('hex').slice(0, 12)}`;
}

/**
 * A stable per-repo output directory: `<base>/<project id, sanitised>/<checkout hash>`, the
 * same directory the CLI defaults to when `base` is `<data home>/daylight`.
 *
 * Keyed by checkout as well as project so two checkouts of the same project — `~/work/api`
 * and `~/scratch/api` — do not collide and inherit each other's claims.
 */
function derivedDirFor(repo, base) {
  const abs = path.resolve(repo);
  const project = projectIdOf(abs).replace(/[^A-Za-z0-9._-]/g, '-');
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  return path.join(base, project, hash);
}

/**
 * Where this repository's output goes.
 *
 * A directory chosen by hand is remembered against the repository it was chosen for and
 * follows only that one. It used to be a single latch — press `out …` once and every
 * repository picked afterwards inherited that directory, forever. The mild half of that is
 * what got it reported: choose a new repo and nothing on screen changes, because the map
 * still comes from the old one's directory.
 */
function dirForRepo(repo, { chosen, base }) {
  return chosen.get(path.resolve(repo)) ?? derivedDirFor(repo, base);
}

/**
 * Why this repository may not use this directory, or null if it may.
 *
 * A directory holding no map is nobody's yet, so it is not refused. Neither is the same
 * repository at a new path — that is the legitimate case, and the paths inside a map made
 * there still mean what they said.
 */
function ownershipConflict(repo, dir) {
  const holds = repoOfDir(dir);
  if (!repo || !holds || sameRepo(holds, repo)) return null;
  return { dir, holds, repo };
}

module.exports = {
  sameRepo, repoOfDir, dataHome, projectIdOf, derivedDirFor, dirForRepo, ownershipConflict,
  readJsonIn, readJsonRaw, readJsonlIn, forgetCachedJson,
};
