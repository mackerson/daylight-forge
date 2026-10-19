/**
 * Per-project policy (P2-R6) and the protected sets (P2-R4). Run: node engine/test/project-policy.ts
 *
 * The no-policy rows are the oracle: every path forge-policy.ts checks gets the same answer
 * with no policy, with a null one and with `languages: ["node"]`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPolicy, pathViolations } from '../forge/policy.ts';
import {
  authorLimits, loadProjectPolicy, MAX_AUTHOR_TIMEOUT_SECONDS, MAX_AUTHOR_TURNS, MAX_POLICY_BYTES, parseProjectPolicy,
  POLICY_FILE, PROTECTED_SETS, protectedBy, ProjectPolicyError, type ProjectPolicy,
} from '../forge/project-policy.ts';
import type { CandidateFile } from '../mission/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-policy-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const file = (p: string, extra: Partial<CandidateFile> = {}): CandidateFile => ({
  path: p, change: 'modified', insertions: 1, deletions: 0, mode: 'file', previousMode: 'file', ...extra,
});
const policy = (doc: Record<string, unknown>): ProjectPolicy => parseProjectPolicy(JSON.stringify({ schema: 'daylight.policy/v1', ...doc }));
const refusal = (raw: string | Buffer): string | null => {
  try {
    parseProjectPolicy(raw);
    return null;
  } catch (err) {
    return err instanceof ProjectPolicyError ? err.message : `other: ${(err as Error).message}`;
  }
};
const isProtected = (p: string, pol?: ProjectPolicy | null) => pathViolations(file(p), { policy: pol }).includes('protected-path');

// Every path forge-policy.ts lists, plus Rust shapes the node set must leave alone.
const ORACLE_PATHS = [
  'src/a.ts', 'README.md', 'package.json', 'packages/x/package.json', 'pnpm-lock.yaml', 'sub/yarn.lock', 'Cargo.lock',
  'node_modules/x/index.js', 'src/node_modules/x.js', '.gitignore', 'src/.gitignore', '.gitattributes', '.gitmodules',
  '.git/hooks/post-checkout', '.github/workflows/ci.yml', 'daylight.invariants.json', 'scripts/build.sh', 'src/scripts/ok.ts',
  '.daylight-gates/x_1/a.test.ts', 'docs/SPEC.md', '../escape.ts', '/etc/passwd', 'src/./a.ts', 'src//a.ts', 'src\\a.ts',
  'lib/outside.ts', 'Cargo.toml', 'crates/x/Cargo.toml', 'build.rs', '.cargo/config.toml', 'rust-toolchain.toml',
];
const CTX = { specPath: 'docs/SPEC.md', scope: { paths: ['src', 'README.md', 'docs', 'packages', 'sub', 'scripts', 'crates', '.cargo'] } };

section('no policy file: today\'s behaviour exactly');
{
  const repo = path.join(tmp, 'none');
  fs.mkdirSync(repo);
  check('an absent file loads as null', loadProjectPolicy(repo) === null);
  const node = policy({ languages: ['node'] });
  const same = ORACLE_PATHS.filter((p) => {
    const base = pathViolations(file(p), CTX).join();
    return base === pathViolations(file(p), { ...CTX, policy: null }).join()
      && base === pathViolations(file(p), { ...CTX, policy: node }).join();
  });
  check('every oracle path gets the same rules with no policy, a null policy and languages ["node"]',
    same.length === ORACLE_PATHS.length, ORACLE_PATHS.filter((p) => !same.includes(p)).join(','));
  check('a file with only the schema is the node set', JSON.stringify(policy({}).languages) === '["node"]');
  check('without a policy, Cargo.toml is not protected (the node set is unchanged)', !isProtected('Cargo.toml') && !isProtected('build.rs'));
  const v = checkPolicy([file('package.json')]);
  check('without a policy a violation carries no why, as before', JSON.stringify(v) === '[{"rule":"protected-path","path":"package.json"}]', JSON.stringify(v));
}

section('the rust set (P2-R4)');
{
  const rust = policy({ languages: ['rust'] });
  for (const p of ['Cargo.toml', 'crates/x/Cargo.toml', 'Cargo.lock', 'crates/x/Cargo.lock', '.cargo/config.toml',
    'crates/x/.cargo/config.toml', 'rust-toolchain.toml', 'rust-toolchain', 'build.rs', 'crates/x/build.rs', 'a/b/c/build.rs']) {
    check(`${p} is protected`, isProtected(p, rust));
  }
  check('src/main.rs and src/build/mod.rs are not', !isProtected('src/main.rs', rust) && !isProtected('src/build/mod.rs', rust));
  check('a rust-only project keeps the always set (.github, lockfiles, invariants, scripts/)',
    ['.github/workflows/ci.yml', 'pnpm-lock.yaml', 'daylight.invariants.json', 'scripts/release.sh'].every((p) => isProtected(p, rust)));
  check('a rust-only project does not protect package.json', !isProtected('package.json', rust));
  const both = policy({ languages: ['rust', 'node'] });
  check('rust and node together protect both', isProtected('package.json', both) && isProtected('crates/x/Cargo.toml', both));
  const v = checkPolicy([file('crates/x/Cargo.toml')], { policy: rust });
  check('under a policy the violation says which set matched', v[0]?.rule === 'protected-path' && v[0]?.why === 'protected by the rust set', JSON.stringify(v));
  check('the protected sets are data: rust names Cargo.toml and build.rs',
    PROTECTED_SETS.rust.some((r) => r.values.includes('Cargo.toml')) && PROTECTED_SETS.rust.some((r) => r.values.includes('build.rs')));
}

section('project globs add, never remove');
{
  const custom = policy({ protectedPaths: ['custom/glob/**', 'config/*.toml', '**/secrets.json'] });
  check('custom/glob/** protects everything below it', isProtected('custom/glob/a', custom) && isProtected('custom/glob/a/b/c.ts', custom));
  check('* stays inside one component', isProtected('config/app.toml', custom) && !isProtected('config/sub/app.toml', custom));
  check('**/x matches at the root and at depth', isProtected('secrets.json', custom) && isProtected('a/b/secrets.json', custom));
  check('a path the globs do not name is untouched', !isProtected('custom/other.ts', custom) && !isProtected('src/a.ts', custom));
  check('the glob match is labelled project', protectedBy('custom/glob/x', custom).includes('project'));
  check('the node set still applies beside the globs', isProtected('package.json', custom) && isProtected('node_modules/x', custom));
  check('there is no syntax to remove a protected path', refusal(JSON.stringify({ schema: 'daylight.policy/v1', unprotectedPaths: ['package.json'] })) !== null
    && refusal(JSON.stringify({ schema: 'daylight.policy/v1', protectedPaths: ['!package.json'] })) !== null);
  for (const [bad, label] of [['/abs/**', 'a leading slash'], ['a/../b', '..'], ['a//b', 'an empty component'], ['a/**b', '** inside a component'],
    ['a/?.ts', '?'], ['a\\b', 'a backslash'], ['', 'an empty glob']] as const) {
    check(`a glob with ${label} is refused`, refusal(JSON.stringify({ schema: 'daylight.policy/v1', protectedPaths: [bad] })) !== null);
  }
}

section('the policy file itself');
{
  const any = [undefined, null, policy({ languages: ['rust'] }), policy({ protectedPaths: ['x/**'] })];
  check(`${POLICY_FILE} is protected with or without a policy`, any.every((p) => isProtected(POLICY_FILE, p)));
  check('and at depth, like the invariants file', isProtected(`sub/${POLICY_FILE}`));
}

section('refusals: one line, typed');
{
  const unknown = refusal(JSON.stringify({ schema: 'daylight.policy/v1', languages: ['rust'], extra: 1 }));
  check('an unknown top-level key is refused', !!unknown && /unknown key "extra"/.test(unknown), String(unknown));
  check('an unknown key in author is refused', /unknown key "maxCost" in author/.test(refusal(JSON.stringify({ schema: 'daylight.policy/v1', author: { maxCost: 1 } })) ?? ''));
  check('an unknown key in gate is refused', !!refusal(JSON.stringify({ schema: 'daylight.policy/v1', gate: { harness: 'cargo', shell: 'sh' } })));
  check('non-JSON is refused', refusal('{ schema: ') === `${POLICY_FILE}: not JSON`);
  check('a missing or wrong schema is refused', !!refusal('{}') && !!refusal(JSON.stringify({ schema: 'daylight.policy/v2' })));
  check('an unknown language is refused', !!refusal(JSON.stringify({ schema: 'daylight.policy/v1', languages: ['cobol'] })));
  check('an empty languages list is refused', !!refusal(JSON.stringify({ schema: 'daylight.policy/v1', languages: [] })));
  check('an unknown gate harness is refused', !!refusal(JSON.stringify({ schema: 'daylight.policy/v1', gate: { harness: 'make' } })));
  const big = Buffer.from(JSON.stringify({ schema: 'daylight.policy/v1', protectedPaths: ['a/**'], pad: 'x'.repeat(MAX_POLICY_BYTES) }));
  check('a file over 64 KB is refused before it is parsed', refusal(big) === `${POLICY_FILE}: over ${MAX_POLICY_BYTES} bytes`, String(refusal(big)));
  const repo = path.join(tmp, 'big');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, POLICY_FILE), big);
  let loaded = '';
  try {
    loadProjectPolicy(repo);
  } catch (err) {
    loaded = err instanceof ProjectPolicyError ? err.message : 'other';
  }
  check('loadProjectPolicy refuses the oversize file too', /over 65536 bytes/.test(loaded), loaded);
  check('every refusal is one line', [unknown, refusal('nope'), refusal(big)].every((m) => !!m && !m.includes('\n')));
  const linked = path.join(tmp, 'linked');
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(tmp, 'elsewhere.json'), JSON.stringify({ schema: 'daylight.policy/v1' }));
  fs.symlinkSync(path.join(tmp, 'elsewhere.json'), path.join(linked, POLICY_FILE));
  let symlink = '';
  try {
    loadProjectPolicy(linked);
  } catch (err) {
    symlink = (err as Error).message;
  }
  check('a symlinked policy file is not followed', /not a regular file/.test(symlink), symlink);
  const good = path.join(tmp, 'good');
  fs.mkdirSync(good);
  fs.writeFileSync(path.join(good, POLICY_FILE), JSON.stringify({
    schema: 'daylight.policy/v1', languages: ['rust', 'node'], protectedPaths: ['custom/glob/**'],
    gate: { harness: 'cargo', command: ['cargo', 'test', '{test}'] }, author: { maxTurns: 300, timeoutSeconds: 3600 },
  }));
  const p = loadProjectPolicy(good);
  check('the documented example loads', !!p && p.languages.join() === 'rust,node' && p.gate?.harness === 'cargo'
    && p.gate.command?.join(' ') === 'cargo test {test}' && p.author.maxTurns === 300 && /^sha256:[0-9a-f]{64}$/.test(p.digest), JSON.stringify(p));
}

section('author caps clamp');
{
  const high = policy({ author: { maxTurns: 5000, timeoutSeconds: 10 * 24 * 3600 } });
  check('maxTurns above the maximum is lowered to it', high.author.maxTurns === MAX_AUTHOR_TURNS);
  check('timeoutSeconds above six hours is lowered to it', high.author.timeoutSeconds === MAX_AUTHOR_TIMEOUT_SECONDS);
  check('and the policy says which fields were clamped', high.clamped.join() === 'author.maxTurns,author.timeoutSeconds');
  check('zero, negative and fractional values are refused',
    ['0', '-1', '1.5', '"60"'].every((n) => !!refusal(`{"schema":"daylight.policy/v1","author":{"maxTurns":${n}}}`)));
  const defaults = { maxTurns: 60, timeoutMs: 600_000 };
  const none = authorLimits(null, defaults);
  check('no policy: the built-in defaults', none.maxTurns === 60 && none.timeoutMs === 600_000 && none.source.maxTurns === 'default');
  const set = authorLimits(policy({ author: { maxTurns: 300, timeoutSeconds: 3600 } }), defaults);
  check('a policy sets the defaults', set.maxTurns === 300 && set.timeoutMs === 3_600_000 && set.source.timeoutMs === 'policy');
  const flag = authorLimits(policy({ author: { timeoutSeconds: 3600 } }), defaults, 30_000);
  check('a --timeout flag beats the policy', flag.timeoutMs === 30_000 && flag.source.timeoutMs === 'flag');
  check('a flag above six hours is clamped too', authorLimits(null, defaults, 10 * 24 * 3600 * 1000).timeoutMs === MAX_AUTHOR_TIMEOUT_SECONDS * 1000);
}

done();
