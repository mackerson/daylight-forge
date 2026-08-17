/**
 * Optional third-party reachability providers. Run: node engine/test/providers.ts
 *
 * The value of a second opinion is entirely in what happens when it *disagrees*, so the
 * cases that matter here are the three-way split and the refusals — not the happy path.
 *
 * The security properties are the other half. A provider is used only if the analysed repo
 * already has it installed; nothing is ever fetched, and a repo without one is a normal
 * answer rather than an error. Fake binaries stand in for the real tools below, which is
 * also the honest way to test "we run whatever is at that path": that is exactly what it does.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crossCheck, runProvider } from '../detect/providers.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-prov-'));
const binDir = path.join(repo, 'node_modules', '.bin');

/** A stand-in for an installed provider: prints what we hand it, exits how we say. */
const fakeBinary = (name: string, stdout: string, code = 0) => {
  fs.mkdirSync(binDir, { recursive: true });
  const p = path.join(binDir, name);
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`);
  fs.chmodSync(p, 0o755);
};

console.log('\nnothing installed');
{
  const r = runProvider(repo, 'knip');
  check('reports unavailable rather than failing', r.available === false && !r.unused.length);
  check('and says nothing was installed to find out',
    /nothing was installed/.test(r.note ?? ''), r.note);
  check('an unavailable provider produces no cross-check', crossCheck(['a.ts'], r) === null);
}

console.log('\nknip');
{
  fakeBinary('knip', JSON.stringify({
    files: ['src/orphan.ts', './src/also-orphan.ts'],
    issues: [{ file: 'src/partial.ts', exports: [] }],
  }));
  const r = runProvider(repo, 'knip');
  check('is used when the repo already has it', r.available === true, JSON.stringify(r));
  check('finds the unused files', r.unused.includes('src/orphan.ts'), JSON.stringify(r.unused));
  check('normalises a leading ./ so paths compare against ours',
    r.unused.includes('src/also-orphan.ts'));
  check('the result is sorted, so a diff of two runs is empty',
    JSON.stringify(r.unused) === JSON.stringify([...r.unused].sort()));

  // Both tools exit non-zero when they find something; that is a result, not a failure.
  fakeBinary('knip', JSON.stringify({ files: ['src/orphan.ts'] }), 1);
  check('a non-zero exit is a finding, not an error',
    runProvider(repo, 'knip').unused.length === 1);
}

console.log('\ndependency-cruiser');
{
  fakeBinary('depcruise', JSON.stringify({
    modules: [
      { source: 'src/lonely.ts', orphan: true },
      { source: 'src/used.ts', orphan: false },
      { source: 'src/no-flag.ts' },
    ],
  }));
  const r = runProvider(repo, 'dependency-cruiser');
  check('reads its own shape', r.unused.length === 1 && r.unused[0] === 'src/lonely.ts',
    JSON.stringify(r));
  check('a module it does not call an orphan is not reported',
    !r.unused.includes('src/used.ts') && !r.unused.includes('src/no-flag.ts'));
}

console.log('\nhostile output');
{
  // Provider output is untrusted input: it is another program's stdout, shaped by a config
  // file in the analysed repo. It must never crash the map or smuggle in a path.
  fakeBinary('knip', 'not json at all');
  const bad = runProvider(repo, 'knip');
  check('unparseable output is reported, not thrown',
    bad.available && !bad.unused.length && /did not parse/.test(bad.note ?? ''), bad.note);
  check('and a noted result yields no cross-check', crossCheck(['a.ts'], bad) === null);

  fakeBinary('knip', JSON.stringify({ files: ['../../etc/passwd', '/etc/shadow', 'src/ok.ts'] }));
  const escape = runProvider(repo, 'knip');
  check('an absolute path is not harvested',
    !escape.unused.some((f) => f.startsWith('/')), JSON.stringify(escape.unused));
  check('a traversal path is not harvested',
    !escape.unused.some((f) => f.includes('..')), JSON.stringify(escape.unused));
  check('the ordinary path still comes through', escape.unused.includes('src/ok.ts'));

  fakeBinary('knip', JSON.stringify({ files: [] }));
  check('an empty result is empty, not an error', runProvider(repo, 'knip').unused.length === 0);

  // A deeply nested structure must terminate rather than recurse forever.
  let nested: unknown = ['src/deep.ts'];
  for (let i = 0; i < 200; i++) nested = { level: nested };
  fakeBinary('knip', JSON.stringify({ files: nested }));
  check('a pathological structure terminates', Array.isArray(runProvider(repo, 'knip').unused));
}

console.log('\ncross-check');
{
  const result = {
    provider: 'knip' as const,
    available: true,
    unused: ['src/both.ts', 'src/theirs.ts'],
  };
  const c = crossCheck(['src/both.ts', 'src/ours.ts'], result)!;
  check('agreement is its own bucket', JSON.stringify(c.agreed) === JSON.stringify(['src/both.ts']));
  check('what only we flag is separate', JSON.stringify(c.weOnly) === JSON.stringify(['src/ours.ts']));
  check('so is what only they flag',
    JSON.stringify(c.theyOnly) === JSON.stringify(['src/theirs.ts']));
  // The point of three buckets rather than a merged verdict: the two disagreements mean
  // different things about our analysis and want different responses.
  check('disagreement is preserved rather than resolved',
    c.weOnly.length > 0 && c.theyOnly.length > 0);
  check('no double-counting', c.agreed.length + c.weOnly.length === 2);
}

fs.rmSync(repo, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
