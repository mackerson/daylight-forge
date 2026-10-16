const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  dirForRepo, forgetCachedJson, ownershipConflict, readJsonIn, readJsonRaw, repoOfDir, sameRepo,
} = require('./session.cjs');

/**
 * The shell's half of one-directory-one-repository. Run: node app/main/session.test.cjs
 *
 * An output directory belongs to one repository — `claims.db` in it addresses files by
 * repo-relative path with no repo in the subject — and the engine's half of that is pinned in
 * `engine/test/isolation.ts`. The shell's half was asserted there too for about an hour, which
 * put an `engine/` file importing `app/main/`: the exact edge
 * `engine-depends-on-nothing-above-it` forbids, caught by this repo's own gate. The engine
 * ships standalone, so a test of the shell belongs to the shell.
 *
 * Which is also why the assertions below are eight local lines rather than
 * `engine/test/harness.ts`. Importing that helper is the forbidden edge wearing a smaller hat.
 * If you are here to remove the duplication, the answer is no.
 */
let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-session-'));
/** A directory that holds a map of `root`, without paying to make a real one. */
const mapped = (name, root) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'view.json'), JSON.stringify({ root, fileEdges: [] }));
  return dir;
};

const repoA = path.join(tmp, 'repoA');
const repoB = path.join(tmp, 'repoB');
fs.mkdirSync(repoA, { recursive: true });
fs.mkdirSync(repoB, { recursive: true });

console.log('\na directory says which repository it belongs to');
{
  const dirA = mapped('holds-a', repoA);
  check('a directory holding a map names its repository', repoOfDir(dirA) === repoA,
    String(repoOfDir(dirA)));
  check('an empty directory names none', repoOfDir(path.join(tmp, 'nothing-here')) === null);
  check('repos compare by resolved path', sameRepo(repoA, `${repoA}/`) && !sameRepo(repoA, repoB));
}

console.log('\na hand-picked directory follows only the repo it was picked for');
{
  const base = path.join(tmp, 'maps');
  const dirA = mapped('chosen-a', repoA);

  check('a repo with no directory of its own gets a derived one',
    dirForRepo(repoA, { chosen: new Map(), base }).startsWith(path.join(base, 'repoA-')));
  check('two checkouts of one name do not collide',
    dirForRepo(path.join(tmp, 'x', 'repoA'), { chosen: new Map(), base }) !==
      dirForRepo(path.join(tmp, 'y', 'repoA'), { chosen: new Map(), base }));
  check('and a trailing slash is not a second checkout',
    dirForRepo(`${repoA}/`, { chosen: new Map(), base }) ===
      dirForRepo(repoA, { chosen: new Map(), base }));

  // The reported bug: pick a directory for one repo, then choose another repo.
  const chosen = new Map([[repoA, dirA]]);
  check('a hand-picked directory follows the repo it was picked for',
    dirForRepo(repoA, { chosen, base }) === dirA);
  check('and does NOT follow the next repo chosen',
    dirForRepo(repoB, { chosen, base }) !== dirA, dirForRepo(repoB, { chosen, base }));
  check('which is what makes choosing a new repo visibly change the map',
    repoOfDir(dirForRepo(repoB, { chosen, base })) !== repoA);
}

console.log('\nand a directory belonging to someone else is refused');
{
  const dirA = mapped('refuse-a', repoA);
  const clash = ownershipConflict(repoB, dirA);
  check('pointing repo B at repo A\'s directory is a conflict', clash !== null);
  check('and the conflict names what the directory already holds', clash?.holds === repoA);
  check('the same repo at the same path is not', ownershipConflict(repoA, dirA) === null);
  check('nor is the same repo named with a trailing slash',
    ownershipConflict(`${repoA}/`, dirA) === null);
  check('an empty directory belongs to nobody yet',
    ownershipConflict(repoB, path.join(tmp, 'refuse-empty')) === null);
  check('and with no repo chosen there is nothing to conflict with',
    ownershipConflict(null, dirA) === null);
}

/**
 * `daylight:load` reads five JSON files out of the output directory and is called on mount, on
 * every action, on every finished job and on every derive — which fires whenever `claims.db`
 * moves. A running swarm had the process that draws the window re-parsing all of them twice a
 * second. Cached by mtime, which only helps if a rewritten file is still re-read: serving the
 * previous parse would show the previous map, which is the bug next door.
 */
console.log('\nthe output directory is re-read when it changes, and not otherwise');
{
  const dir = path.join(tmp, 'cache-dir');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'findings.json');
  // Two writes inside one millisecond are indistinguishable by mtime, and the point here is
  // the behaviour on either side of a change, not the resolution of the clock.
  let stamp = Date.now();
  const write = (body) => {
    fs.writeFileSync(file, body);
    stamp += 5000;
    fs.utimesSync(file, new Date(stamp), new Date(stamp));
  };

  check('a file that is not there gives the fallback',
    readJsonIn(dir, 'absent.json', 'none') === 'none');

  write(JSON.stringify({ families: ['first'] }));
  const first = readJsonIn(dir, 'findings.json', null);
  check('a file that is there parses', first?.families?.[0] === 'first');
  check('and unchanged bytes come back without a second parse',
    readJsonIn(dir, 'findings.json', null) === first);

  write(JSON.stringify({ families: ['second'] }));
  check('a rewritten file is re-read, so a remap is not hidden behind the cache',
    readJsonIn(dir, 'findings.json', null)?.families?.[0] === 'second');

  const second = readJsonIn(dir, 'findings.json', null);
  forgetCachedJson();
  check('and forgetting the directory drops what was held for it',
    readJsonIn(dir, 'findings.json', null) !== second);

  write('{ not json');
  check('an unparseable file gives the fallback rather than throwing',
    readJsonIn(dir, 'findings.json', 'fallback') === 'fallback');

  // graph.json is hundreds of megabytes; holding it resident would trade one problem for a
  // worse one, so that read is deliberately not cached.
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ root: '/somewhere' }));
  check('the uncached read hands back a fresh parse every time',
    readJsonRaw(dir, 'graph.json') !== readJsonRaw(dir, 'graph.json'));
  check('and still reads what is there',
    readJsonRaw(dir, 'graph.json', {})?.root === '/somewhere');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
