/**
 * The default output directory. Run: node engine/test/out-default.ts
 *
 * Without `--out`, output goes to `${XDG_DATA_HOME:-~/.local/share}/daylight/<project>/<checkout>`:
 * outside the repository, one directory per checkout, with the project id's colon made safe
 * for a path. `--out` still wins. These run the real CLI against a throwaway data home.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identifyProject } from '../mission/project.ts';
import { checkoutHash, dataHome, defaultOut, outFor, projectDirName } from '../paths.ts';
import { EXPECTED_FIXTURE_COMMIT } from '../demo/fixture.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-out-default-'));
const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'engine', 'cli.ts');
const xdg = path.join(tmp, 'xdg');
const ENV = { ...process.env, XDG_DATA_HOME: xdg };
const GIT_ENV = {
  ...ENV,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

const cli = (args: string[], cwd = tmp): { code: number; out: string } => {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', cwd, env: ENV });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};
const git = (repo: string, args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
git(repo, ['init', '-q']);
fs.writeFileSync(path.join(repo, 'a.ts'), "import { b } from './b.ts';\nexport const a = b + 1;\n");
fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
git(repo, ['add', '.']);
git(repo, ['commit', '-q', '-m', 'first']);
fs.writeFileSync(path.join(repo, 'c.ts'), 'export const c = 3;\n');
git(repo, ['add', '.']);
git(repo, ['commit', '-q', '-m', 'second']);
const first = git(repo, ['rev-list', '--max-parents=0', 'HEAD']);

section('the data home');
check('XDG_DATA_HOME is honoured when absolute', dataHome({ XDG_DATA_HOME: '/x/y' }) === '/x/y');
check('unset falls back to ~/.local/share', dataHome({}) === path.join(os.homedir(), '.local', 'share'));
check('empty falls back too', dataHome({ XDG_DATA_HOME: '' }) === path.join(os.homedir(), '.local', 'share'));
check('a relative XDG_DATA_HOME is ignored, as the spec says',
  dataHome({ XDG_DATA_HOME: 'rel/dir' }) === path.join(os.homedir(), '.local', 'share'));

section('the directory name');
check('git:<hex> becomes git-<hex>', projectDirName('git:38fa20074d80') === 'git-38fa20074d80');
check('path:<hex> becomes path-<hex>', projectDirName('path:0123456789ab') === 'path-0123456789ab');
check('the checkout hash is eight hex characters', /^[0-9a-f]{8}$/.test(checkoutHash(repo)));
const expected = path.join(xdg, 'daylight', `git-${first.slice(0, 12)}`, checkoutHash(repo));
check('defaultOut is <data home>/daylight/<project>/<checkout>', defaultOut(repo, ENV) === expected, defaultOut(repo, ENV));
check('the stored id keeps its colon', identifyProject(repo).id === `git:${first.slice(0, 12)}`);
check('the same checkout always gets the same directory', defaultOut(repo, ENV) === defaultOut(path.join(repo, '.'), ENV));
check('the default is never inside the repository', path.relative(repo, defaultOut(repo, ENV)).startsWith('..'));

const clone = path.join(tmp, 'clone');
execFileSync('git', ['clone', '-q', repo, clone], { stdio: 'ignore' });
const cloneOut = defaultOut(clone, ENV);
check('a second checkout of the same project shares the project directory',
  path.dirname(cloneOut) === path.dirname(expected), cloneOut);
check('but not the out dir, so the two never share a claims db', cloneOut !== expected);

section('the CLI without --out');
const mapped = cli(['map', repo, '--top', '0']);
check('map succeeds', mapped.code === 0, mapped.out.slice(-400));
check('and writes its graph to the default', fs.existsSync(path.join(expected, 'graph.json')));
check('and nothing into the repository', !fs.existsSync(path.join(repo, 'out')) && git(repo, ['status', '--porcelain']) === '');
check('nor into the working directory', !fs.existsSync(path.join(tmp, 'out')));

const created = cli(['mission', 'create', repo, '--objective', 'what is a for?', '--format', 'json']);
check('mission create resolves the out of the repo it names', created.code === 0, created.out.slice(-400));
const listed = cli(['mission', 'list', '--format', 'json'], repo);
check('mission list, from inside the checkout, finds the same store',
  listed.code === 0 && (JSON.parse(listed.out) as { missions: unknown[] }).missions.length === 1, listed.out.slice(-400));

const explicit = path.join(tmp, 'explicit-out');
const overridden = cli(['map', repo, '--out', explicit, '--top', '0']);
check('--out still overrides the default', overridden.code === 0 && fs.existsSync(path.join(explicit, 'graph.json')));

const shallow = path.join(tmp, 'shallow');
execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, shallow], { stdio: 'ignore' });
const refused = cli(['map', shallow, '--top', '0']);
check('a shallow clone has no knowable project, so the default is refused rather than guessed',
  refused.code !== 0 && /shallow/.test(refused.out), refused.out.slice(-300));
check('and --out works there', cli(['map', shallow, '--out', path.join(tmp, 'shallow-out'), '--top', '0']).code === 0);
check('help needs no project at all', cli(['help'], shallow).code === 0);
for (const argv of [['mission', 'bogus'], ['mission', 'inspect'], ['experiment'], ['report'], ['artifact']]) {
  const r = cli(argv, shallow);
  check(`a usage error is reported as one before the default out is asked for (${argv.join(' ')})`,
    r.code === 2 && /usage:/.test(r.out) && !/shallow/.test(r.out), r.out.slice(-300));
}
const shallowList = cli(['mission', 'list'], shallow);
check('a command that needs the default out there is still refused, by design',
  shallowList.code !== 0 && /shallow/.test(shallowList.out), shallowList.out.slice(-300));

section('the demo without --out');
const demo = cli(['demo', 'prepare', '--format', 'json']);
check('demo prepare succeeds', demo.code === 0, demo.out.slice(-400));
const prepared = demo.code === 0 ? JSON.parse(demo.out) as { root: string; out: string } : { root: '', out: '' };
check('the fixture repo goes under the data home', prepared.root === path.join(xdg, 'daylight', 'daylight-demo-repo'), prepared.root);
check('and its out is the pinned project\'s, for that checkout',
  prepared.out === outFor(`git:${EXPECTED_FIXTURE_COMMIT.slice(0, 12)}`, prepared.root, ENV), prepared.out);
check('which is what defaultOut computes from the repo itself', prepared.out === defaultOut(prepared.root, ENV));

section('campaign commands take the default out from their repo argument, not the cwd (P2-R37)');
{
  const planRepo = path.join(tmp, 'plan-repo');
  fs.mkdirSync(planRepo);
  git(planRepo, ['init', '-q']);
  fs.writeFileSync(path.join(planRepo, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(planRepo, 'daylight.plan.json'), JSON.stringify({
    kind: 'daylight-plan', version: 1, title: 'out default', campaignGates: [],
    lanes: [{ id: 'L', title: 'lane', owns: ['a.ts'] }],
    tickets: [{ id: 'T1', lane: 'L', title: 'one', statement: 'one ticket', scope: ['a.ts'] }],
  }));
  git(planRepo, ['add', '.']);
  git(planRepo, ['commit', '-q', '-m', 'plan']);
  const elsewhere = path.join(tmp, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const human = { ...ENV, CLAUDECODE: '', DAYLIGHT_SESSION: '' };
  const run = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', cwd: elsewhere, env: human }) };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };
  const repoOut = defaultOut(planRepo, ENV);
  check('map without --out, from another directory', run(['map', planRepo, '--top', '0']).code === 0);
  const imported = run(['campaign', 'import', planRepo, '--file', 'daylight.plan.json', '--format', 'json']);
  const id = imported.code === 0 ? (JSON.parse(imported.out) as { campaign: { id: string } }).campaign.id : '';
  check('campaign import without --out writes under the repo\'s default out', !!id && fs.existsSync(path.join(repoOut, 'daylight.db')), imported.out.slice(-300));
  check('and nothing under the cwd\'s', !fs.existsSync(path.join(defaultOut(elsewhere, ENV), 'daylight.db')));
  check('campaign validate names its repo second and opens no store', run(['campaign', 'validate', 'daylight.plan.json', planRepo]).code === 0);
  const explicit = path.join(tmp, 'campaign-explicit-out');
  const mapped = run(['map', planRepo, '--out', explicit, '--top', '0']);
  check('map with --out', mapped.code === 0, mapped.out.slice(-400));
  const there = run(['campaign', 'import', planRepo, '--file', 'daylight.plan.json', '--out', explicit, '--format', 'json']);
  const thereId = there.code === 0 ? (JSON.parse(there.out) as { campaign: { id: string } }).campaign.id : '';
  check('an explicit --out wins over the repo argument', !!thereId && thereId !== id
    && run(['campaign', 'show', thereId, '--out', explicit]).code === 0 && run(['campaign', 'show', thereId, '--out', repoOut]).code !== 0, there.out.slice(-300));
}

section('the test harness\'s own data home');
{
  const script = path.join(tmp, 'harness-leak.ts');
  const harnessUrl = new URL('./harness.ts', import.meta.url).href;
  fs.writeFileSync(script, `import fs from 'node:fs';
import { harness } from '${harnessUrl}';
const h = harness();
fs.writeFileSync(process.env.XDG_DATA_HOME + '/written', '');
console.log(process.env.XDG_DATA_HOME);
if (process.argv[2] === 'throw') throw new Error('boom');
h.check('x', process.argv[2] !== 'fail');
h.done();
`);
  for (const how of ['pass', 'fail', 'throw']) {
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [script, how], { encoding: 'utf8', stdio: 'pipe', env: ENV });
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? '';
    }
    const dir = stdout.split('\n')[0].trim();
    check(`is removed when a test file exits (${how})`,
      dir.startsWith(path.join(os.tmpdir(), 'daylight-xdg-')) && !fs.existsSync(dir), dir);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
