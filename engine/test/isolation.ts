/**
 * An output directory belongs to one repository. Run: node engine/test/isolation.ts
 *
 * `claims.db` addresses files by repo-relative path, with no repo in the subject. So pointing
 * one output directory at a second project does not merely mix up two maps — it re-indexes
 * one codebase's confirmed knowledge onto another's identically-named files.
 *
 * This was found by doing it. A *human* claim about repo A's `src/Store.ts` migrated onto
 * repo B's `src/Cache.ts` — two unrelated projects — and presented there as reviewed
 * knowledge about a codebase nobody had opened. Fabricated provenance is the single failure
 * this design exists to prevent, so it gets the most direct test in the suite.
 *
 * The visible half of the same bug is milder and is what got it reported: choose a new repo
 * in the GUI and nothing changes, because the output directory still holds the old one's map.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaimStore } from '../store/claims.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-isolation-'));
const CLI = path.join(import.meta.dirname, '..', 'cli.ts');

/** Two unrelated projects that happen to contain a structurally identical class. */
const BODY = `  load(id: string) {
    const rows = this.db.all('select * from t where id = ?', id);
    const out = [];
    for (const r of rows) { if (r.ok) { out.push(r.v); } }
    return out.filter((x) => x != null);
  }
  save(id: string, v: string) {
    const found = this.db.get('select 1 from t where id = ?', id);
    if (found) { return false; }
    this.db.run('insert into t values (?, ?)', id, v);
    return true;
  }`;

const makeRepo = (name: string, cls: string) => {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, main: 'src/index.ts' }));
  fs.writeFileSync(path.join(root, 'src', `${cls}.ts`),
    `export class ${cls} {\n  db: any;\n${BODY}\n}\n`);
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), `import './${cls}.ts';\n`);
  return root;
};

const repoA = makeRepo('repoA', 'Store');
const repoB = makeRepo('repoB', 'Cache');

/** Run the CLI, returning its exit code and combined output rather than throwing. */
const run = (args: string[]): { code: number; out: string } => {
  try {
    const out = execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const shared = path.join(tmp, 'shared-out');

console.log('\nthe guard');
{
  const first = run(['map', repoA, '--out', shared, '--top', '0']);
  check('mapping a repo into a fresh directory works', first.code === 0, first.out.slice(-300));

  const again = run(['map', repoA, '--out', shared, '--top', '0']);
  check('re-mapping the same repo is fine', again.code === 0, again.out.slice(-300));

  const other = run(['map', repoB, '--out', shared, '--top', '0']);
  check('mapping a different repo into it is refused', other.code === 2, `exit ${other.code}`);
  check('and the refusal names both repositories',
    other.out.includes(repoA) && other.out.includes(repoB), other.out.slice(-400));
  check('and says why it matters, not just that it refused',
    /human-confirmed claim about one project/.test(other.out));
  check('and points at the fix', /separate --out per repository/.test(other.out));

  check('the refusal happens before anything is overwritten',
    (JSON.parse(fs.readFileSync(path.join(shared, 'graph.json'), 'utf8')) as { root: string })
      .root === repoA);

  const forced = run(['map', repoB, '--out', shared, '--top', '0', '--force']);
  check('--force is honoured, for the same repo at a new path', forced.code === 0);
  check('and warns that the existing claims now mean something else',
    /means? something else/.test(forced.out), forced.out.slice(-300));
}

/**
 * The map says which repository it came from, in the small file.
 *
 * The Electron shell reads this back: `pnpm gui` opens on the default output directory with
 * no repo selected, and rather than showing a map while insisting no repo is chosen — which
 * left Map, Run agents and Watch all dead — it adopts the repo the map names. That only works
 * because `view.json` carries `root`, and `view.json` is the small one; `graph.json` is
 * hundreds of megabytes on a large repo and must not be parsed to answer this.
 *
 * Asserted here because the shell cannot be reached from this suite, so the contract it
 * depends on is the thing to pin.
 */
console.log('\nthe map names its own repository');
{
  const dir = path.join(tmp, 'names-itself');
  run(['map', repoA, '--out', dir, '--top', '0']);

  const view = JSON.parse(fs.readFileSync(path.join(dir, 'view.json'), 'utf8'));
  check('view.json carries the repo root', view.root === repoA, String(view.root));
  check('and it is the small file, not the exhaustive one',
    fs.statSync(path.join(dir, 'view.json')).size <
      fs.statSync(path.join(dir, 'graph.json')).size);

  const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
  check('graph.json agrees, as the fallback', graph.root === repoA);

  // Adopting a root that is no longer on disk would hand every agent a cwd that is not there,
  // so the shell stats it first. Same check, asserted against the same field.
  check('a root that still exists is a directory', fs.statSync(view.root).isDirectory());
  check('a root that has moved does not', !fs.existsSync(path.join(tmp, 'repoA-moved')));
}

console.log('\nclaims do not cross repositories');
{
  // The failure exactly as it happened: repo A mapped, a human confirms something, then the
  // same output directory is pointed at an unrelated project.
  const out = path.join(tmp, 'migration-out');
  run(['map', repoA, '--out', out, '--top', '0']);

  const store = new ClaimStore(path.join(out, 'claims.db'));
  store.submit({
    subject: 'src/Store.ts',
    predicate: 'purpose',
    value: 'the credential store for repo A',
    source: { kind: 'human' },
    confidence: 1,
    evidence: [{ file: 'src/Store.ts', line: 1, note: 'reviewed by a person' }],
    at: 1000,
  });
  store.close();

  const crossed = run(['map', repoB, '--out', out, '--top', '0', '--force']);
  check('forcing past the guard still does not move the claim',
    crossed.code === 0 && !/Followed \d+ move/.test(crossed.out),
    crossed.out.slice(-400));
  check('and says it declined to match files across two codebases',
    /not this repo/.test(crossed.out), crossed.out.slice(-400));

  const after = new ClaimStore(path.join(out, 'claims.db'));
  const onCache = after.claimsFor('src/Cache.ts', 'purpose');
  const onStore = after.claimsFor('src/Store.ts', 'purpose');
  check('the human claim did NOT land on the other repo\'s file',
    onCache.length === 0, JSON.stringify(onCache.map((c) => c.value)));
  check('it stayed where it was made', onStore.length === 1);
  check('and it is still attributed to the human who made it',
    onStore[0]?.source.kind === 'human' && onStore[0]?.at === 1000);
  after.close();
}

console.log('\nrenames still work within one repository');
{
  // The guard must not break the thing it sits next to.
  const out = path.join(tmp, 'rename-out');
  const repo = makeRepo('repoC', 'Original');
  run(['map', repo, '--out', out, '--top', '0']);

  const store = new ClaimStore(path.join(out, 'claims.db'));
  store.submit({
    subject: 'src/Original.ts', predicate: 'purpose', value: 'does the thing',
    source: { kind: 'human' }, confidence: 1,
    evidence: [{ file: 'src/Original.ts', line: 1 }], at: 2000,
  });
  store.close();

  fs.renameSync(path.join(repo, 'src', 'Original.ts'), path.join(repo, 'src', 'Renamed.ts'));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), "import './Renamed.ts';\n");
  const moved = run(['map', repo, '--out', out, '--top', '0']);

  check('a rename inside one repo is still followed',
    /Followed 1 move/.test(moved.out), moved.out.slice(-300));

  const after = new ClaimStore(path.join(out, 'claims.db'));
  check('and the claim goes with it',
    after.claimsFor('src/Renamed.ts', 'purpose').length === 1);
  check('keeping the time it was asserted',
    after.claimsFor('src/Renamed.ts', 'purpose')[0]?.at === 2000);
  after.close();
}

console.log('\nfingerprints say which repo they describe');
{
  const out = path.join(tmp, 'prints-out');
  run(['map', repoA, '--out', out, '--top', '0']);
  const raw = JSON.parse(fs.readFileSync(path.join(out, 'fingerprints.json'), 'utf8')) as
    { root?: string; prints?: unknown[] };
  check('the file records the repo it came from', raw.root === repoA, JSON.stringify(raw.root));
  check('alongside the fingerprints themselves', Array.isArray(raw.prints) && raw.prints.length > 0);

  // A file from before this was recorded cannot be attributed, so it is not trusted.
  fs.writeFileSync(path.join(out, 'fingerprints.json'), JSON.stringify([{ file: 'x', sig: [], names: [] }]));
  const legacy = run(['map', repoA, '--out', out, '--top', '0']);
  check('an unattributable fingerprint file is ignored rather than guessed at',
    legacy.code === 0 && !/Followed/.test(legacy.out), legacy.out.slice(-200));
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
