/**
 * The `adapters` subcommand must not run provider binaries unless asked. Run: node engine/test/adapters.ts
 *
 * Asking a CLI what models it has means executing it, and `--help` used to do exactly that.
 * Stub binaries stand in for every provider; each records that it ran. PATH holds only the
 * stubs and `which`, so a real provider on this machine cannot be reached by accident.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE, run as runAgent } from '../swarm/adapters.ts';
import { harness } from './harness.ts';

const { check, done, section } = harness();

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-adapters-'));
const bin = path.join(scratch, 'bin');
const log = path.join(scratch, 'calls.log');
const out = path.join(scratch, 'out');
fs.mkdirSync(bin);
for (const name of ['claude', 'codex', 'grok', 'opencode']) {
  const p = path.join(bin, name);
  fs.writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> '${log}'\n`);
  fs.chmodSync(p, 0o755);
}
const which = ['/usr/bin/which', '/bin/which'].find((p) => fs.existsSync(p));
if (which) fs.symlinkSync(which, path.join(bin, 'which'));

const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
const run = (args: string[]) => {
  fs.rmSync(log, { force: true });
  return spawnSync(process.execPath, [CLI, 'adapters', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin },
  });
};

section('--help');
{
  const r = run(['--help']);
  check('exits 0', r.status === 0, `${r.status} ${r.stderr}`);
  check('prints usage', /usage:/.test(r.stdout) && /--probe/.test(r.stdout), r.stdout);
  check('spawns no provider binary', calls() === '', calls());
}

section('without --probe');
{
  const r = run(['--out', out, '--format', 'json']);
  check('exits 0', r.status === 0, `${r.status} ${r.stderr}`);
  const status = JSON.parse(r.stdout || '[]') as { name: string; installed: boolean; probed: boolean }[];
  check('lists every adapter', ['claude', 'codex', 'grok', 'opencode'].every((n) => status.some((a) => a.name === n)),
    r.stdout);
  check('the stubs are found on PATH', !!which && status.every((a) => a.installed), r.stdout);
  check('and marked as not probed', status.every((a) => a.probed === false), r.stdout);
  check('spawns no provider binary', calls() === '', calls());

  const text = run(['--out', out]);
  check('the text form says how to probe', /--probe/.test(text.stdout), text.stdout);
  check('the text form spawns no provider binary either', calls() === '', calls());
}

section('with --probe');
{
  const r = run(['--out', out, '--format', 'json', '--probe']);
  check('exits 0', r.status === 0, `${r.status} ${r.stderr}`);
  const status = JSON.parse(r.stdout || '[]') as { probed: boolean }[];
  check('marks adapters as probed', status.length > 0 && status.every((a) => a.probed === true), r.stdout);
  check('runs the installed binaries to ask them', /claude/.test(calls()), calls());
}

section('the launch hook');
{
  const probe = path.join(scratch, 'probe.cjs');
  fs.writeFileSync(probe, `
const fs = require('node:fs');
let fed = '';
try { fed = fs.readFileSync(3, 'utf8'); } catch {}
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort(), fed }));
`);
  const adapter = { name: 'mock', bin: '/agent/bin', perInvocationMcp: true, argv: () => ['--agent-flag'] };
  const base = { prompt: 'p', cwd: scratch, mcpConfigPath: '/dev/null', session: 's', timeoutMs: 10_000 };
  const hooked = await runAgent(adapter, {
    ...base,
    launch: (b, argv) => ({ bin: process.execPath, argv: ['launcher', probe, b, ...argv], env: { ONLY: '1' }, feeds: [Buffer.from('fed bytes')] }),
  });
  const seen = JSON.parse(hooked.stdout || '{}') as { argv?: string[]; env?: string[]; fed?: string };
  check('the hook decides what is spawned, handed the adapter\'s bin and argv',
    JSON.stringify(seen.argv) === JSON.stringify(['/agent/bin', '--agent-flag']), hooked.stdout + hooked.stderr);
  check('the launched process gets only the environment the hook names',
    JSON.stringify(seen.env?.filter((k) => k !== 'NODE_UNIQUE_ID')) === JSON.stringify(['ONLY']), JSON.stringify(seen.env));
  check('feeds reach the launched process on fd 3', seen.fed === 'fed bytes', String(seen.fed));
  check('the run still reports its exit', hooked.ok && hooked.exitCode === 0);
}
{
  const argvFor = (allowedTools?: string[]) =>
    CLAUDE.argv({ prompt: '', cwd: '/', mcpConfigPath: '/dev/null', session: 's', allowedTools });
  const allow = (a: string[]) => a[a.indexOf('--allowedTools') + 1];
  check('the tool allowlist is a parameter of the run', allow(argvFor(['Read', 'Edit', 'mcp__daylight__run'])) === 'Read Edit mcp__daylight__run');
  check('without one, claude keeps the read-only reviewer list',
    allow(argvFor()).startsWith('Read Grep Glob mcp__daylight__get_overview') && !/\bEdit\b|\bWrite\b|\bBash\b/.test(allow(argvFor())));
}

fs.rmSync(scratch, { recursive: true, force: true });
done();
