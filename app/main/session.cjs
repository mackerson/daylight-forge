const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/**
 * Which repository an output directory belongs to, and where a repository's output goes.
 *
 * Lifted out of main.cjs so these rules can be tested. An output directory belongs to one
 * repository — `claims.db` in it addresses files by repo-relative path with no repo in the
 * subject — and until now the shell's half of that invariant was asserted only indirectly,
 * through the CLI contract it reads. The shell's half is where it was actually broken.
 */

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
  for (const name of ['view.json', 'graph.json']) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (raw && typeof raw.root === 'string') return raw.root;
    } catch {
      // Absent or unreadable is not evidence of ownership in either direction.
    }
  }
  return null;
}

/**
 * A stable per-repo output directory.
 *
 * Basename first so it is recognisable in a file manager, plus a hash of the full path so two
 * checkouts of the same project — `~/work/api` and `~/scratch/api` — do not collide and
 * inherit each other's claims. Both halves read the resolved path: hashing one form while
 * slugging another gave one checkout two directories depending on how it was named.
 */
function derivedDirFor(repo, base) {
  const abs = path.resolve(repo);
  const slug = path.basename(abs).replace(/[^\w.-]+/g, '-').slice(0, 40) || 'repo';
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  return path.join(base, `${slug}-${hash}`);
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

module.exports = { sameRepo, repoOfDir, derivedDirFor, dirForRepo, ownershipConflict };
