/**
 * The author's workspace and sandbox. Run: node engine/test/forge-workspace.ts
 *
 * The workspace half needs only git. The sandbox half runs the real `bwrap` on this machine,
 * with mock agents only; where bwrap is missing those cases are skipped and said to be, and
 * the fail-closed cases run everywhere.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore, digestOf } from '../mission/artifacts.ts';
import { captureCandidate } from '../forge/diff.ts';
import {
  applyDiff, createWorkspace, sweepWorkspaces, WORKSPACE_PREFIX, WorkspaceRefused,
} from '../forge/workspace.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-test-forge-ws-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@daylight',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@daylight',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const repo = path.join(tmp, 'repo');
const markers = path.join(tmp, 'markers');
fs.mkdirSync(markers);
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const git = (args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(['init', '-q']);
fs.writeFileSync(path.join(repo, 'src', 'add.js'), 'module.exports = (a, b) => a + b;\n');
fs.writeFileSync(path.join(repo, 'src', 'smudged.txt'), 'plain\n');
fs.writeFileSync(path.join(repo, 'ignored-by-archive.txt'), 'present\n');
fs.writeFileSync(path.join(repo, 'crlf.txt'), 'one\ntwo\n');
fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}\n');
fs.writeFileSync(path.join(repo, '.gitattributes'),
  'ignored-by-archive.txt export-ignore\nsrc/smudged.txt filter=evil\ncrlf.txt eol=crlf\n');
fs.writeFileSync(path.join(repo, 'secret-holdout.js'), 'holdout\n');
git(['config', 'filter.evil.smudge', `touch ${markers}/smudged; cat`]);
git(['config', 'filter.evil.clean', `touch ${markers}/cleaned; cat`]);
fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${markers}/post-checkout\n`, { mode: 0o755 });
fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\ntouch ${markers}/post-index-change\n`, { mode: 0o755 });
git(['add', '.']);
fs.rmSync(path.join(markers, 'cleaned'), { force: true });
git(['commit', '-q', '-m', 'fixture']);
const commit = git(['rev-parse', 'HEAD']);
// The holdout is in a later commit: the base the author gets must not hold it.
const base = commit;
const before = { status: git(['status', '--porcelain']), head: git(['rev-parse', 'HEAD']), objects: git(['count-objects', '-v']) };
const realUnchanged = () =>
  git(['status', '--porcelain']) === before.status && git(['rev-parse', 'HEAD']) === before.head
  && git(['count-objects', '-v']) === before.objects;

const write = (ws: { tree: string }, rel: string, content: string, mode?: number) => {
  fs.mkdirSync(path.dirname(path.join(ws.tree, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws.tree, rel), content, mode !== undefined ? { mode } : undefined);
};

// ---- materialise -------------------------------------------------------------

section('materialising a detached workspace');
{
  const ws = createWorkspace(repo, base);
  check('the tree is materialised at the full base commit', ws.commit === commit, ws.commit);
  check('the scratch directory is private', (fs.statSync(ws.base).mode & 0o077) === 0);
  check('it carries the prefix the experiment sweep ignores', path.basename(ws.base).startsWith(WORKSPACE_PREFIX));
  check('the sibling git dir is beside the tree, not under it', !ws.gitDir.startsWith(`${ws.tree}${path.sep}`) && path.dirname(ws.gitDir) === path.dirname(ws.tree));
  check('the tree has no .git of its own', !fs.existsSync(path.join(ws.tree, '.git')));
  check('an export-ignore file is present (a checkout, not an archive)', fs.existsSync(path.join(ws.tree, 'ignored-by-archive.txt')));
  check('every index entry is a file on disk', ws.files === 7, String(ws.files));
  check('the repository\'s smudge filter did not run', !fs.existsSync(path.join(markers, 'smudged')));
  check('no hook ran on the host', !fs.existsSync(path.join(markers, 'post-checkout')) && !fs.existsSync(path.join(markers, 'post-index-change')));
  check('committed attributes do not convert line endings', fs.readFileSync(path.join(ws.tree, 'crlf.txt'), 'utf8') === 'one\ntwo\n');
  check('the real checkout is untouched: status, HEAD and object count', realUnchanged());
  ws.dispose();
  check('dispose removes the workspace', !fs.existsSync(ws.base));
}

{
  let why = '';
  try {
    createWorkspace(repo, commit, { hidden: ['secret-holdout.js'] });
  } catch (err) {
    why = err instanceof WorkspaceRefused ? err.message : `wrong error: ${String(err)}`;
  }
  check('a locked holdout present at the base is refused, by count', /^1 holdout file present at base;/.test(why), why);
  check('and the refusal names no holdout path or basename (P2-R45 D7)', !why.includes('secret-holdout'), why);
  const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(WORKSPACE_PREFIX))
    .filter((n) => { try { return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), n, 'owner.json'), 'utf8')).pid === process.pid; } catch { return false; } });
  check('and leaves no workspace behind', left.length === 0, left.join(','));
  let bad = '';
  try {
    createWorkspace(repo, 'deadbeef'.repeat(5));
  } catch (err) {
    bad = (err as Error).message;
  }
  check('a commit that does not resolve is refused', /not a commit/.test(bad), bad);
  let opt = '';
  try {
    createWorkspace(repo, '--output=/tmp/x');
  } catch (err) {
    opt = (err as Error).message;
  }
  check('a revision shaped like an option is refused, not parsed as one', /not a commit/.test(opt), opt);
}

// ---- capture ------------------------------------------------------------------

section('capturing a candidate');
const artifacts = new ArtifactStore(path.join(tmp, 'out'));
{
  const ws = createWorkspace(repo, base);
  const empty = captureCandidate(ws);
  check('an untouched tree is no-diff', 'verdict' in empty && empty.verdict === 'no-diff' && empty.files.length === 0,
    JSON.stringify('verdict' in empty ? empty.verdict : empty));
  write(ws, 'src/add.js', 'module.exports = (a, b) => b + a;\n');
  write(ws, 'src/new.js', 'export const n = 1;\n');
  const d = captureCandidate(ws, {}, { artifacts, projectId: 'p' });
  if (!('verdict' in d)) throw new Error(d.refused);
  check('a write inside the tree lands in the diff',
    d.files.map((f) => `${f.change}:${f.path}`).join(',') === 'modified:src/add.js,added:src/new.js', JSON.stringify(d.files));
  check('a clean diff waits for the gates', d.verdict === 'pending' && d.policyViolations.length === 0, JSON.stringify(d.policyViolations));
  check('the digest is sha256 of the stored bytes', d.diffDigest === digestOf(d.diff) && /^sha256:[0-9a-f]{64}$/.test(d.diffDigest));
  check('the diff artifact holds exactly those bytes', d.diffArtifact?.digest === d.diffDigest && artifacts.get(d.diffArtifact!).equals(d.diff));
  check('numstat counts are carried per file', d.summary.insertions === 2 && d.summary.deletions === 1, JSON.stringify(d.summary));
  const again = captureCandidate(ws);
  check('capturing the same tree twice yields the same digest', 'diffDigest' in again && again.diffDigest === d.diffDigest);
  check('the real checkout is still untouched', realUnchanged());

  const forged = createWorkspace(repo, base);
  try {
    write(forged, 'src/add.js', "module.exports = (a, b) => a + b;\nprocess.stdout.write('TAP version 13\\nok 1\\n# fail 0\\n');\nprocess.exit(0);\n");
    write(forged, 'src/add.test.js', "process.stdout.write('# fail 0\\n');\nprocess.exit(0);\n");
    const f = captureCandidate(forged);
    if (!('verdict' in f)) throw new Error(f.refused);
    const v = f.policyViolations.filter((x) => x.rule === 'gate-forgery-shape');
    check('capture flags library code shaped like test output: gate-forgery-shape, a policy violation (P2-R43)',
      f.verdict === 'policy-violation' && v.length === 1 && v[0].path === 'src/add.js' && /heuristic/.test(v[0].why ?? '') && /process\.exit\(0\)/.test(v[0].why ?? ''),
      JSON.stringify(f.policyViolations));
    check('the same lines in a test file are not flagged', !v.some((x) => x.path === 'src/add.test.js'));
    check('the file flag carries the rule', f.flags.find((x) => x.path === 'src/add.js')?.rules.includes('gate-forgery-shape') === true);
  } finally {
    forged.dispose();
  }

  const fresh = createWorkspace(repo, base);
  const applied = applyDiff(fresh, d.diff, d.diffDigest);
  check('the diff applies to a fresh workspace of the same base', 'ok' in applied, JSON.stringify(applied));
  check('and reproduces the author\'s file', fs.readFileSync(path.join(fresh.tree, 'src', 'add.js'), 'utf8').includes('b + a'));
  const re = captureCandidate(fresh);
  check('and the same digest', 'diffDigest' in re && re.diffDigest === d.diffDigest);
  const elsewhere = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  const cwd = process.cwd();
  process.chdir(elsewhere);
  const third = createWorkspace(repo, base);
  const fromElsewhere = applyDiff(third, d.diff, d.diffDigest);
  process.chdir(cwd);
  check('applying from another cwd writes into the workspace, never the cwd',
    'ok' in fromElsewhere && fs.readdirSync(elsewhere).length === 0 && fs.existsSync(path.join(third.tree, 'src', 'new.js')),
    fs.readdirSync(elsewhere).join(','));
  third.dispose();
  const fourth = createWorkspace(repo, base);
  const wrong = applyDiff(fourth, d.diff, `sha256:${'0'.repeat(64)}`);
  fourth.dispose();
  check('a diff whose bytes are not the digest is invalid', 'invalid' in wrong);
  fresh.dispose();
  ws.dispose();
}

{
  const ws = createWorkspace(repo, base);
  write(ws, 'package.json', '{"name":"fixture","scripts":{"postinstall":"curl x"}}\n');
  write(ws, '.gitignore', 'hidden.js\n');
  write(ws, 'hidden.js', 'not hidden from the diff\n');
  write(ws, '.daylight-gates/x_1/gate.js', 'tampered\n');
  write(ws, 'scripts/build.sh', 'echo\n');
  write(ws, 'src/run.sh', '#!/bin/sh\n', 0o755);
  fs.symlinkSync('/etc/passwd', path.join(ws.tree, 'src', 'link'));
  write(ws, 'src/fine.js', 'ok\n');
  const d = captureCandidate(ws, { specPath: 'src/add.js' });
  if (!('verdict' in d)) throw new Error(d.refused);
  const flag = (p: string) => d.flags.find((f) => f.path === p);
  check('a protected path modification is a violation', d.verdict === 'policy-violation');
  check('package.json is flagged protected', flag('package.json')?.protected === true && flag('package.json')!.rules.includes('protected-path'));
  check('a written .gitignore is flagged protected', flag('.gitignore')?.protected === true);
  check('a file the .gitignore names still lands in the diff', !!flag('hidden.js'));
  check('a gate path is flagged protected', flag('.daylight-gates/x_1/gate.js')?.rules.includes('gate-path') === true);
  check('scripts/ is flagged protected', flag('scripts/build.sh')?.protected === true);
  check('a new executable is an exec-mode violation', flag('src/run.sh')?.rules.includes('exec-mode') === true);
  check('a symlink is a symlink violation', flag('src/link')?.rules.includes('symlink') === true);
  check('an ordinary file is not flagged', flag('src/fine.js')?.protected === false && flag('src/fine.js')!.rules.length === 0);
  check('every flag is also in the violation list',
    d.flags.every((f) => f.rules.every((r) => d.policyViolations.some((v) => v.rule === r && v.path === f.path))));
  ws.dispose();
}

{
  const ws = createWorkspace(repo, base);
  write(ws, 'src/config.js', 'export const key = "sk-live0123456789abcdefSENTINEL";\n');
  const d = captureCandidate(ws, {}, { artifacts, projectId: 'p' });
  if (!('verdict' in d)) throw new Error(d.refused);
  check('a secret in the diff is a secret-in-diff violation on its file',
    d.policyViolations.some((v) => v.rule === 'secret-in-diff' && v.path === 'src/config.js') && d.secretHits === 1);
  check('the flag is on the file', d.flags[0]?.rules.includes('secret-in-diff') === true && d.flags[0].secretHits === 1);
  const stored = artifacts.get(d.diffArtifact!).toString('utf8');
  check('only the redacted copy is stored', !stored.includes('SENTINEL') && stored.includes('[REDACTED]'));
  check('and the digest is of the redacted copy', d.diffDigest === digestOf(Buffer.from(stored)));
  ws.dispose();
}

{
  const ws = createWorkspace(repo, base);
  for (let i = 0; i < 201; i++) write(ws, `src/many/f${i}.js`, `${i}\n`);
  const many = captureCandidate(ws);
  check('more than 200 files is too-many-files', 'verdict' in many && many.policyViolations.some((v) => v.rule === 'too-many-files'));
  ws.dispose();
  const big = createWorkspace(repo, base);
  write(big, 'src/big.txt', `${'x'.repeat(1024)}\n`.repeat(1100));
  const large = captureCandidate(big);
  check('more than 1 MiB of diff is too-large', 'verdict' in large && large.policyViolations.some((v) => v.rule === 'too-large'));
  big.dispose();
  const del = createWorkspace(repo, base);
  fs.rmSync(path.join(del.tree, 'src', 'add.js'));
  const gone = captureCandidate(del);
  check('a deletion is captured as one', 'verdict' in gone && gone.files[0]?.change === 'deleted' && gone.verdict === 'pending');
  del.dispose();
}

// ---- disposal and the sweep -----------------------------------------------------

section('disposal and the sweep');
{
  const ws = createWorkspace(repo, base);
  fs.mkdirSync(path.join(ws.tree, 'locked'));
  fs.writeFileSync(path.join(ws.tree, 'locked', 'f'), 'x');
  fs.chmodSync(path.join(ws.tree, 'locked'), 0o000);
  ws.dispose();
  check('dispose removes a tree the author chmod-ed shut', !fs.existsSync(ws.base));

  const sweepDir = fs.mkdtempSync(path.join(tmp, 'sweep-'));
  const plant = (name: string, owner: unknown, mode = 0o700) => {
    const d = path.join(sweepDir, `${WORKSPACE_PREFIX}${name}`);
    fs.mkdirSync(d, { mode });
    fs.chmodSync(d, mode);
    fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify(owner));
    return d;
  };
  const dead = plant('dead', { pid: 2 ** 22 - 1, repoRoot: repo, commit, startedAt: 1 });
  const live = plant('live', { pid: process.pid, repoRoot: repo, commit, startedAt: 1 });
  const open = plant('open', { pid: 2 ** 22 - 1, repoRoot: repo, commit, startedAt: 1 }, 0o755);
  const junk = plant('junk', 'not an owner');
  const target = fs.mkdtempSync(path.join(tmp, 'precious-'));
  fs.symlinkSync(target, path.join(sweepDir, `${WORKSPACE_PREFIX}link`));
  const swept = sweepWorkspaces(sweepDir);
  check('a dead runner\'s workspace is swept', swept === 1 && !fs.existsSync(dead), String(swept));
  check('a live runner\'s workspace survives', fs.existsSync(live));
  check('a directory others can read survives', fs.existsSync(open));
  check('a directory without a valid owner survives', fs.existsSync(junk));
  check('a planted link and what it points at survive', fs.existsSync(target) && fs.lstatSync(path.join(sweepDir, `${WORKSPACE_PREFIX}link`)).isSymbolicLink());
}

section('nothing left behind');
{
  const mine = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(WORKSPACE_PREFIX)).filter((n) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), n, 'owner.json'), 'utf8')).pid === process.pid;
    } catch {
      return false;
    }
  });
  check('every workspace this run made was disposed', mine.length === 0, mine.join(','));
}

done();
