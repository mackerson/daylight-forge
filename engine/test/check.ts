/**
 * P10 — the build gate. Run: node engine/test/check.ts
 *
 * These assert exit codes rather than output, because an exit code is the only part CI
 * actually reads and the only part that turns detection into prevention.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness } from './harness.ts';

const { check, done } = harness();

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'engine', 'cli.ts');

function run(argv: string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...argv], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

// A tiny repo we can deliberately break, so the gate is tested on a failure it caused.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-check-'));
fs.mkdirSync(path.join(tmp, 'src'));
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'fx', main: 'src/index.ts' }));
fs.writeFileSync(path.join(tmp, 'src/index.ts'), "import { helper } from './helper.ts';\nexport const go = () => helper();\n");
fs.writeFileSync(path.join(tmp, 'src/helper.ts'), 'export const helper = () => 1;\n');

const out = path.join(tmp, 'out');
run(['map', tmp, '--out', out, '--top', '0'], tmp);

console.log('\ncheck gate');
{
  // No invariants and no target: nothing to fail, so it must pass rather than error.
  const clean = run(['check', tmp, '--out', out], tmp);
  check('passes when nothing is declared', clean.code === 0, `exit ${clean.code}`);
  check('says so rather than pretending to have checked',
    /none defined/.test(clean.out) && /none declared/.test(clean.out));

  const invPath = path.join(tmp, 'daylight.invariants.json');
  fs.writeFileSync(invPath, JSON.stringify([{
    id: 'helper-exists',
    prose: 'the helper module is reachable',
    predicate: { type: 'count', select: { kind: ['file'], name: '^helper\\.ts$' }, min: 1, max: 1 },
  }]));
  const green = run(['check', tmp, '--out', out], tmp);
  check('passes a satisfied invariant', green.code === 0, `exit ${green.code}`);

  fs.writeFileSync(invPath, JSON.stringify([{
    id: 'no-helper',
    prose: 'there is deliberately no helper module',
    predicate: { type: 'absent', select: { kind: ['file'], name: '^helper\\.ts$' } },
  }]));
  const red = run(['check', tmp, '--out', out], tmp);
  check('fails a violated invariant', red.code === 1, `exit ${red.code}`);
  check('names the violation', /RED\s+no-helper/.test(red.out));
  check('ends on a line CI can annotate', /^FAIL: 1 red invariant/m.test(red.out));

  const warn = run(['check', tmp, '--out', out, '--warn-only'], tmp);
  check('warn-only reports without failing the build', warn.code === 0, `exit ${warn.code}`);
  check('warn-only still says what is wrong', /^WARN: 1 red invariant/m.test(warn.out));

  const json = run(['check', tmp, '--out', out, '--format', 'json'], tmp);
  let parsed: any = null;
  try { parsed = JSON.parse(json.out); } catch { /* left null */ }
  check('emits machine-readable output', !!parsed && parsed.ok === false);
  check('json carries the failing results', parsed?.invariants?.red === 1);

  // A target violation must fail the gate on its own, with no invariants involved.
  fs.rmSync(invPath);
  fs.writeFileSync(path.join(tmp, 'daylight.target.json'), JSON.stringify({
    layers: [
      { name: 'entry', include: ['src/index.ts'], mayDependOn: [] },
      { name: 'lib', include: ['src/helper.ts'], mayDependOn: [] },
    ],
  }));
  const target = run(['check', tmp, '--out', out], tmp);
  check('fails a target violation with no invariants present', target.code === 1, `exit ${target.code}`);
  check('reports the violation count', /1 target violation/.test(target.out));
}

fs.rmSync(tmp, { recursive: true, force: true });
done();