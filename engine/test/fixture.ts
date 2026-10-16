/**
 * The demo fixture. Run: node engine/test/fixture.ts
 *
 * The demo is only honest if the thing it demonstrates on is pinned: the same tree, the same
 * commit, the same one planted defect, labelled as planted everywhere a person could read it.
 * These assert each of those, and that the fixture is a repository this tool can actually map
 * without the map being swamped by anything other than the disagreement it exists to stage.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXPECTED_FIXTURE_COMMIT, FIXTURE_DIR, materialiseFixture } from '../demo/fixture.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-fixture-'));
const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'engine', 'cli.ts');
const TSC = path.join(REPO, 'node_modules', '.bin', 'tsc');

const PLANTED =
  'PLANTED — this defect was placed deliberately for the Daylight demonstration and is not ' +
  'an independently discovered production defect';

/** Run a command, returning exit code and combined output rather than throwing. */
const run = (bin: string, args: string[], cwd?: string): { code: number; out: string } => {
  try {
    const out = execFileSync(bin, args, { encoding: 'utf8', stdio: 'pipe', cwd });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

section('materialising is deterministic');
const a = materialiseFixture(path.join(tmp, 'a'));
const b = materialiseFixture(path.join(tmp, 'b'));
{
  check('two materialisations land on the same commit', a.commit === b.commit, `${a.commit} vs ${b.commit}`);
  // A change to any fixture byte legitimately changes this; update EXPECTED_FIXTURE_COMMIT
  // in the same commit as the fixture change so the pin names the tree it was made for.
  check('and it is the pinned one', a.commit === EXPECTED_FIXTURE_COMMIT, a.commit);
  check('the project identity agrees across checkouts', a.projectId === b.projectId && a.projectId === `git:${a.commit.slice(0, 12)}`);
  check('while the roots differ', a.root !== b.root);
  check('the revision is clean, so it is reproducible', a.revision.label === a.commit && !a.revision.dirty);
  check('the working tree is on main', run('git', ['-C', a.root, 'branch', '--show-current']).out.trim() === 'main');

  let refused = false;
  try { materialiseFixture(path.join(tmp, 'a')); } catch { refused = true; }
  check('a non-empty destination is refused rather than overwritten', refused);
}

section('the fixture is labelled as planted');
{
  // Prose is wrapped at 95 columns; the sentence is the words, not the line breaks.
  const unwrap = (text: string) => text.replace(/\s+/g, ' ');
  const defect = fs.readFileSync(path.join(FIXTURE_DIR, 'DEFECT.md'), 'utf8');
  const readme = fs.readFileSync(path.join(FIXTURE_DIR, 'README.md'), 'utf8');
  check('DEFECT.md carries the planted sentence verbatim', unwrap(defect).includes(PLANTED));
  const firstParagraph = readme.split('\n\n').find((p) => !p.startsWith('#')) ?? '';
  check('README.md says PLANTED in its first paragraph', firstParagraph.includes('PLANTED'), firstParagraph.slice(0, 80));
  check('DEFECT.md names the file', defect.includes('src/session-cache.ts'));
  check('DEFECT.md names the test that exposes it', defect.includes('an expired session is not served'));
  // Asking whether there is a defect is the question; naming the mechanism would be the answer.
  const prompt = fs.readFileSync(path.join(FIXTURE_DIR, 'review-prompts', 'reviewer.md'), 'utf8');
  check('the review prompt asks for a bug_verdict on the module', prompt.includes('bug_verdict') && prompt.includes('src/session-cache.ts'));
  check('and does not give the answer away', !/expir|refresh|slid|ttl|unreachable/i.test(prompt) && !prompt.includes('DEFECT.md'));
  check('the materialised copy carries the label too',
    unwrap(fs.readFileSync(path.join(a.root, 'DEFECT.md'), 'utf8')).includes(PLANTED));
}

section('the planted test is red, and only it');
{
  // TAP rather than the default reporter: machine-readable, and stable across node versions.
  const tests = run('node', ['--test', '--test-reporter=tap'], a.root);
  check('node --test exits non-zero at the planted commit', tests.code !== 0, `exit ${tests.code}`);
  check('the red test is the expiry one', /^not ok .*an expired session is not served/m.test(tests.out), tests.out.slice(-600));
  check('exactly one test fails', /^# fail 1$/m.test(tests.out), tests.out.match(/^# fail \d+/m)?.[0] ?? 'no tally');
  check('the rest are green', /^# pass 4$/m.test(tests.out), tests.out.match(/^# pass \d+/m)?.[0] ?? 'no tally');
}

section('the fixture typechecks and maps');
{
  const tsc = run(TSC, ['--noEmit', '-p', a.root]);
  check('tsc --noEmit passes on the materialised repo', tsc.code === 0, tsc.out.slice(0, 400));

  const out = path.join(tmp, 'out');
  const map = run('node', [CLI, 'map', a.root, '--out', out, '--top', '0']);
  check('vds map succeeds', map.code === 0, map.out.slice(-400));
  const graph = JSON.parse(fs.readFileSync(path.join(out, 'graph.json'), 'utf8')) as {
    root: string; nodes: Array<{ id: string; kind: string }>;
  };
  check('graph.json names the fixture root', graph.root === a.root);
  check('and lists the module under review', graph.nodes.some((n) => n.id === 'src/session-cache.ts'));
  check('all six source files are mapped', graph.nodes.filter((n) => n.kind === 'file').length === 6,
    String(graph.nodes.filter((n) => n.kind === 'file').length));

  // The demo has one disagreement to stage. A fixture that trips the duplication detectors
  // would surround it with noise that is not the point.
  const findings = JSON.parse(fs.readFileSync(path.join(out, 'findings.json'), 'utf8')) as {
    families: unknown[]; d4: unknown[]; d6: unknown[];
  };
  check('no duplication families', findings.families.length === 0, String(findings.families.length));
  check('no copy-pasted bodies', findings.d4.length === 0);
  check('no parallel implementations', findings.d6.length === 0);
  const structure = JSON.parse(fs.readFileSync(path.join(out, 'structure.json'), 'utf8')) as {
    cycles: unknown[]; gods: unknown[]; dead: Array<{ tier: string }>;
  };
  check('no cycles and no god nodes', structure.cycles.length === 0 && structure.gods.length === 0);
  check('no high-confidence dead code — unused exports of a library are low-tier candidates',
    structure.dead.every((d) => d.tier === 'low'), structure.dead.map((d) => d.tier).join(','));
}

done();
