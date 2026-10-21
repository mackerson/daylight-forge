/**
 * The Forge policy rules. Run: node engine/test/forge-policy.ts
 *
 * Table-driven: each row is a path a candidate diff touches and the rules it must break.
 * The decision guard is the one function every human Forge act passes through, so its
 * refusals are listed one by one.
 */
import {
  assertHumanDecision, checkPolicy, confirmCodeOf, DecisionRefused, forgeryShapes, guardCheck, isTestPath, MAX_DIFF_BYTES, MAX_DIFF_FILES,
  pathViolations, rustTestLines,
} from '../forge/policy.ts';
import { digestOf } from '../mission/artifacts.ts';
import type { CandidateFile, PolicyRule } from '../mission/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const file = (p: string, extra: Partial<CandidateFile> = {}): CandidateFile => ({
  path: p, change: 'modified', insertions: 1, deletions: 0, mode: 'file', previousMode: 'file', ...extra,
});

section('paths');
const ROWS: Array<[string, Partial<CandidateFile>, PolicyRule[]]> = [
  ['src/a.ts', {}, []],
  ['README.md', {}, []],
  ['package.json', {}, ['protected-path']],
  ['packages/x/package.json', {}, ['protected-path']],
  ['pnpm-lock.yaml', {}, ['protected-path']],
  ['sub/yarn.lock', {}, ['protected-path']],
  ['Cargo.lock', {}, ['protected-path']],
  ['node_modules/x/index.js', {}, ['protected-path']],
  ['src/node_modules/x.js', {}, ['protected-path']],
  ['.gitignore', {}, ['protected-path']],
  ['src/.gitignore', { change: 'added', previousMode: undefined }, ['protected-path']],
  ['.gitattributes', {}, ['protected-path']],
  ['.gitmodules', {}, ['protected-path']],
  ['.git/hooks/post-checkout', {}, ['protected-path']],
  ['.github/workflows/ci.yml', {}, ['protected-path']],
  ['daylight.invariants.json', {}, ['protected-path']],
  ['scripts/build.sh', {}, ['protected-path']],
  ['src/scripts/ok.ts', {}, []],
  ['.daylight-gates/x_1/a.test.ts', {}, ['gate-path']],
  ['docs/SPEC.md', {}, ['spec-path']],
  ['../escape.ts', {}, ['path-escape']],
  ['/etc/passwd', {}, ['path-escape']],
  ['src/./a.ts', {}, ['path-escape']],
  ['src//a.ts', {}, ['path-escape']],
  ['src\\a.ts', {}, ['path-escape', 'outside-scope']],
  ['src/link', { mode: 'symlink' }, ['symlink']],
  ['src/was-link', { mode: 'file', previousMode: 'symlink' }, ['symlink']],
  ['vendor/sub', { mode: 'gitlink' }, ['gitlink']],
  ['src/run.sh', { mode: 'executable' }, ['exec-mode']],
  ['src/new.sh', { mode: 'executable', change: 'added', previousMode: undefined }, ['exec-mode']],
  ['src/tool.sh', { mode: 'executable', previousMode: 'executable' }, []],
  ['src/was-exec.sh', { mode: 'file', previousMode: 'executable' }, []],
  ['src/gone.sh', { mode: 'executable', change: 'deleted' }, []],
  ['lib/outside.ts', {}, ['outside-scope']],
];
const ctx = { specPath: './docs/SPEC.md', scope: { paths: ['src/', 'README.md', 'docs', 'packages', 'sub', 'scripts', 'vendor', '.daylight-gates', 'node_modules', '.git', '.github', '.gitignore', '.gitattributes', '.gitmodules', 'daylight.invariants.json', 'package.json', 'pnpm-lock.yaml', 'Cargo.lock', '../escape.ts', '/etc/passwd'] } };
for (const [p, extra, want] of ROWS) {
  const got = pathViolations(file(p, extra), ctx);
  check(`${p}${extra.mode ? ` (${extra.mode})` : ''} → ${want.join(', ') || 'clean'}`,
    got.join() === want.join(), got.join() || 'clean');
}
check('no scope admits every path', pathViolations(file('lib/outside.ts')).length === 0);

section('the whole diff');
{
  check('an empty diff is refused', checkPolicy([]).map((v) => v.rule).join() === 'empty-diff');
  const many = Array.from({ length: MAX_DIFF_FILES + 1 }, (_, i) => file(`src/f${i}.ts`));
  check(`more than ${MAX_DIFF_FILES} files is refused`, checkPolicy(many).some((v) => v.rule === 'too-many-files' && v.path === null));
  check(`exactly ${MAX_DIFF_FILES} is not`, !checkPolicy(many.slice(1)).some((v) => v.rule === 'too-many-files'));
  check('more than 1 MiB of diff is refused', checkPolicy([file('src/a.ts')], { diffBytes: MAX_DIFF_BYTES + 1 }).some((v) => v.rule === 'too-large'));
  const v = checkPolicy([file('package.json'), file('.github/x', { mode: 'symlink' }), file('src/a.ts')]);
  check('violations come path by path, sorted, every rule listed',
    JSON.stringify(v) === JSON.stringify([
      { rule: 'protected-path', path: '.github/x' }, { rule: 'symlink', path: '.github/x' },
      { rule: 'protected-path', path: 'package.json' },
    ]), JSON.stringify(v));
  check('a clean diff has no violations', checkPolicy([file('src/a.ts')]).length === 0);
}

section('the human decision guard');
{
  const digest = digestOf('the thing decided');
  const code = confirmCodeOf(digest);
  const refused = (env: Record<string, string | undefined>, actor: string, confirm: string | undefined) => {
    try {
      assertHumanDecision(env, actor, confirm, digest);
      return null;
    } catch (err) {
      return err as Error;
    }
  };
  check('the confirm code is the first eight hex of the digest', code === digest.slice(7, 15));
  check('a human in their own shell with the right code passes', refused({}, 'human:miz', code) === null);
  check('the code is case-insensitive', refused({}, 'human:miz', code.toUpperCase()) === null);
  check('refused under DAYLIGHT_SESSION', refused({ DAYLIGHT_SESSION: 'm_x:a_y' }, 'human:miz', code) instanceof DecisionRefused);
  check('refused under CLAUDECODE', /CLAUDECODE/.test(refused({ CLAUDECODE: '1' }, 'human:miz', code)?.message ?? ''));
  check('an empty variable does not count as set', refused({ CLAUDECODE: '' }, 'human:miz', code) === null);
  check('an agent actor is refused', !!refused({}, 'agent:claude:opus', code));
  check('a bare human is refused', !!refused({}, 'human', code));
  check('a missing confirm is refused', !!refused({}, 'human:miz', undefined));
  const wrong = refused({}, 'human:miz', '00000000');
  check('a wrong confirm is refused', !!wrong);
  check('and the refusal does not print the right code', !!wrong && !wrong.message.includes(code));
  check('guardCheck says nothing for a decision that would pass', guardCheck({}, 'human:miz', code, digest) === null);
  check('guardCheck returns the reason instead of throwing', /CLAUDECODE/.test(guardCheck({ CLAUDECODE: '1' }, 'human:miz', code, digest) ?? ''));
  check('guardCheck and the assert agree on every refusal', [
    [{ DAYLIGHT_SESSION: 's' }, 'human:miz', code], [{}, 'agent:x:y', code], [{}, 'human:miz', 'ffffffff'], [{}, 'human:miz', undefined],
  ].every(([env, actor, c]) => guardCheck(env as Record<string, string>, actor as string, c as string | undefined, digest)
    === refused(env as Record<string, string>, actor as string, c as string | undefined)?.message));
  check('guardCheck on a non-digest returns a reason', guardCheck({}, 'human:miz', 'x', 'nope') !== null);
  check('a non-digest is refused', (() => {
    try {
      assertHumanDecision({}, 'human:miz', 'abcd1234', 'not-a-digest');
      return false;
    } catch (err) {
      return err instanceof DecisionRefused;
    }
  })());
}

section('gate-forgery-shape (P2-R43): a heuristic over the added lines of non-test code');
{
  /** `body` as a whole new file at `p`: every line added. */
  const shapes = (p: string, body: string) => forgeryShapes(p, body, body.split('\n').map((_, i) => i + 1));
  const RUST: Array<[string, string]> = [
    ['File::from_raw_fd(1)', 'pub fn f() { let _ = unsafe { std::fs::File::from_raw_fd(1) }; }'],
    ['from_raw_fd(1)', 'pub fn f() { let _ = unsafe { Stdout::from_raw_fd( 1 ) }; }'],
    ['libc::write(1', 'pub fn f() { unsafe { libc::write(1, b"x".as_ptr() as _, 1) }; }'],
    ['std::process::exit(', 'pub fn f() { std::process::exit(0) }'],
    ['test result: ok.', 'pub fn f() { println!("test result: ok. 1 passed"); }'],
    ['running 0 tests', 'pub fn f() { println!("running 0 tests"); }'],
  ];
  const JS: Array<[string, string, string]> = [
    ['process.exit(0) at module scope', 'src/a.js', 'module.exports = 1;\nprocess.exit(0);'],
    ['process.exit(0) in a module-scope block', 'src/a.ts', 'export const x = 1;\nif (globalThis.done) {\n  process.exit(0);\n}'],
    ['process.stdout.write # pass', 'src/a.mjs', "export function f() { process.stdout.write('# pass 3\\n'); }"],
    ['process.stdout.write # fail 0', 'src/a.ts', 'export function f() { process.stdout.write("# fail 0\\n"); }'],
    ['process.stdout.write ok 1', 'src/a.cjs', 'exports.f = () => process.stdout.write(`ok 1 - adds`);'],
    ['fs.writeSync(1,', 'lib/a.js', "exports.f = () => fs.writeSync(1, 'x');"],
    ['TAP version', 'src/a.tsx', "export const header = 'TAP version 13';"],
  ];
  for (const [name, body] of RUST) {
    check(`${name} in a library file is a violation`, shapes('crates/core/src/lib.rs', body).length === 1, JSON.stringify(shapes('crates/core/src/lib.rs', body)));
    check(`${name} in a test file is not`, shapes('crates/core/tests/it.rs', body).length === 0);
  }
  for (const [name, p, body] of JS) {
    check(`${name} in a library file is a violation`, shapes(p, body).length === 1, JSON.stringify(shapes(p, body)));
    for (const t of ['tests/a.js', 'src/__tests__/a.ts', 'src/a.test.ts']) {
      check(`${name} in ${t} is not`, shapes(t, body).length === 0);
    }
  }
  check('process.exit(0) inside a function body is not', shapes('src/cli.js', 'function main() {\n  process.exit(0);\n}\nconst stop = () => process.exit(0);\nclass A { m() { process.exit(0); } }').length === 0);
  check('process.exit(1) at module scope is not', shapes('src/cli.js', 'process.exit(1);').length === 0);
  const cfgTest = [
    'pub fn add(a: u64, b: u64) -> u64 { a + b }', '',
    '#[cfg(test)]', 'mod tests {', '    #[test]', '    fn adds() {', '        let s = "}";',
    '        println!("test result: ok.");', '        std::process::exit(0);', '    }', '}',
    'pub fn after() { println!("running 0 tests"); }',
  ].join('\n');
  check('inside a #[cfg(test)] block of a library file it is not; after the block it is',
    JSON.stringify(shapes('crates/core/src/lib.rs', cfgTest)) === '["running 0 tests"]', JSON.stringify(shapes('crates/core/src/lib.rs', cfgTest)));
  check('the #[cfg(test)] lines are the attribute through the closing brace, a "}" in a string skipped',
    [...rustTestLines(cfgTest)].join(',') === '3,4,5,6,7,8,9,10,11', [...rustTestLines(cfgTest)].join(','));
  check('a #[cfg(test)] use; does not swallow the next item',
    shapes('src/lib.rs', '#[cfg(test)]\nuse std::fs;\npub fn f() { std::process::exit(0) }').length === 1);
  check('only the added lines count', forgeryShapes('src/lib.rs', 'pub fn f() { std::process::exit(0) }\npub fn g() {}', [2]).length === 0);
  // A binary's entry point ends the program with std::process::exit; that alone is allowed there.
  check('std::process::exit in src/main.rs of a bin crate is allowed', shapes('src/main.rs', 'fn main() { std::process::exit(2) }').length === 0);
  check('and in src/bin/tool.rs', shapes('crates/x/src/bin/tool.rs', 'fn main() { std::process::exit(2) }').length === 0);
  check('but not a raw fd write or a summary line there',
    shapes('src/main.rs', 'fn main() { println!("test result: ok."); let _ = unsafe { File::from_raw_fd(1) }; }').length === 2);
  check('a file of another language is not scanned', shapes('docs/a.md', 'TAP version 13\ntest result: ok.').length === 0);
  check('test paths: tests/, __tests__/, *.test.*', isTestPath('tests/a.rs') && isTestPath('a/tests/b.js') && isTestPath('x/__tests__/y.ts')
    && isTestPath('src/a.test.mjs') && !isTestPath('src/tests.rs') && !isTestPath('src/attest/a.js'));
}

done();
