/**
 * `--help` and `-h` on every subcommand print its usage and exit 0, before anything else
 * happens. Run: node engine/test/cli-help.ts
 *
 * Acceptance F1: `agent --help` and `run --help` ran the real command and spawned the provider
 * roster; `export --help` overwrote a repository's tracked `.codemap/` files. So every command
 * in the dispatch table is run with each help form, with stand-in provider binaries first on
 * PATH that leave a marker if spawned, against a repository with tracked `.codemap/` files,
 * and nothing may be spawned, written or created.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMANDS } from '../cli-usage.ts';
import { ASSUMPTION_SUBCOMMANDS, CAMPAIGN_SUBCOMMANDS } from '../forge/commands-campaign.ts';
import { CAMPAIGN_REPORT_SUBCOMMANDS } from '../forge/commands-campaign-report.ts';
import { CAMPAIGN_RUN_SUBCOMMANDS } from '../forge/commands-campaign-run.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const ENGINE = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ENGINE, 'cli.ts');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-cli-help-')));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const repo = path.join(tmp, 'repo');
const data = path.join(tmp, 'data');
const bin = path.join(tmp, 'bin');
const marker = path.join(tmp, 'provider-spawned');
fs.mkdirSync(path.join(repo, '.codemap'), { recursive: true });
fs.mkdirSync(path.join(repo, 'src'));
fs.mkdirSync(data);
fs.mkdirSync(bin);
fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, '.codemap', 'knowledge.json'), '{ "tracked": true }\n');
fs.writeFileSync(path.join(repo, '.codemap', 'ARCHITECTURE.md'), '# tracked\n');
for (const name of ['claude', 'codex', 'grok', 'opencode']) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o755 });
}
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', env: gitEnv }).trim();
git(['init', '-q', '-b', 'main']);
git(['add', '-A']);
git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@daylight.invalid', 'commit', '-q', '-m', 'fixture']);

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
delete env.CLAUDECODE;
delete env.DAYLIGHT_SESSION;
delete env.DAYLIGHT_MOCK_ADAPTER;
delete env.DAYLIGHT_PARSERS;
env.PATH = `${bin}:${env.PATH ?? ''}`;
env.XDG_DATA_HOME = data;

const cli = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env, timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};

/** Every tracked file's bytes and mtime, every untracked path, and what sits in XDG_DATA_HOME. */
const snapshot = () => JSON.stringify({
  tracked: git(['ls-files']).split('\n').map((f) => {
    const p = path.join(repo, f);
    return [f, fs.statSync(p).mtimeMs, fs.readFileSync(p, 'utf8')];
  }),
  status: git(['status', '--porcelain', '--untracked-files=all', '--ignored']),
  data: fs.readdirSync(data, { recursive: true }),
});

section('the dispatch table is the list this test walks');
{
  const source = fs.readFileSync(CLI, 'utf8');
  const dispatch = source.slice(source.indexOf('switch (args.command) {'));
  const cases = [...dispatch.matchAll(/^ {2}case '([a-z-]+)':/gm)].map((m) => m[1]);
  check('every case in cli.ts is in COMMANDS, and every command has a case',
    cases.length > 20 && JSON.stringify([...cases].sort()) === JSON.stringify([...COMMANDS].sort()), `${cases.join(',')} vs ${COMMANDS.join(',')}`);
}

section('control: the snapshot sees what export writes');
{
  const before = snapshot();
  fs.mkdirSync(path.join(tmp, 'control-out'));
  const r = cli(['export', repo, '--out', path.join(tmp, 'control-out')]);
  check('export without --help writes the tracked .codemap files, and the snapshot notices', r.code === 0 && snapshot() !== before, r.err.slice(-300));
  git(['checkout', '--', '.codemap']);
  fs.rmSync(path.join(tmp, 'control-out'), { recursive: true, force: true });
}

section('--help and -h on every command: usage, exit 0, nothing spawned or written');
const before = snapshot();
for (const command of COMMANDS) {
  // Bare, after a target path, and after a subcommand (the mission and Forge families).
  const forms = [[command, '--help'], [command, repo, '-h'], [command, 'list', '--out', path.join(tmp, 'never'), '--help']];
  const bad: string[] = [];
  for (const form of forms) {
    const r = cli(form);
    if (r.code !== 0 || !/usage/i.test(r.out) || !r.out.includes(command)) bad.push(`${form.join(' ')} → ${r.code} ${r.out.slice(0, 120)} ${r.err.slice(-200)}`);
  }
  check(`${command}: every help form prints its usage and exits 0`, bad.length === 0, bad.join(' | '));
}
check('no provider binary was spawned', !fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').slice(0, 300) : '');
const after = snapshot();
check('no tracked file changed (bytes and mtime), nothing new in the repo or XDG_DATA_HOME', after === before, after.slice(0, 600));
check('the --out a help form named was never created', !fs.existsSync(path.join(tmp, 'never')));

section('--help on every campaign and assumption subcommand: usage, exit 0, nothing written');
{
  const before = snapshot();
  const never = path.join(tmp, 'never-campaign');
  const forms = [
    ...[...CAMPAIGN_SUBCOMMANDS, ...CAMPAIGN_RUN_SUBCOMMANDS, ...CAMPAIGN_REPORT_SUBCOMMANDS].map((sub) => ['campaign', sub, 'm_00000000000000000000000000000000', repo, '--out', never, '--help']),
    ['campaign', 'gate', 'register', 'm_00000000000000000000000000000000', '--out', never, '-h'],
    ['campaign', 'run', 'm_00000000000000000000000000000000', repo, '--dry-run', '--out', never, '--help'],
    ...ASSUMPTION_SUBCOMMANDS.map((sub) => ['assumption', sub, 'u_00000000000000000000000000000000', '--out', never, '--help']),
  ];
  for (const form of forms) {
    const r = cli(form);
    check(`${form.slice(0, 3).join(' ')} --help prints the campaign usage and exits 0`, r.code === 0 && /usage/i.test(r.out) && r.out.includes(form[0]),
      `${r.code} ${r.out.slice(0, 120)} ${r.err.slice(-200)}`);
  }
  check('no campaign help form created its --out or changed the repo', !fs.existsSync(never) && snapshot() === before);
}

section('help itself, and a leading --help');
for (const form of [['help'], ['--help'], ['-h']]) {
  const r = cli(form);
  check(`${form.join(' ')} prints the full usage and exits 0`, r.code === 0 && r.out.includes('usage:') && r.out.includes('forge'), `${r.code} ${r.err.slice(-200)}`);
}
check('an unknown command still exits 1', cli(['no-such-command']).code === 1);

done();
