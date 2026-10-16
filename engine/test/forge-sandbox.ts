/**
 * The Forge's bwrap profiles, the exec sandbox and the author launch. Run: node engine/test/forge-sandbox.ts
 *
 * The argv cases run everywhere. The live cases run the real `bwrap` on this machine with
 * mock agents only (never a provider binary); where bwrap is missing they are skipped and
 * said to be, and the fail-closed cases still run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectSandbox, nodeBinary, sandboxArgv, type SandboxProfile } from '../experiment/sandbox.ts';
import { authorFor, authorLauncher, authorServer, authorTools, AUTHOR_FILE_TOOLS, reviewLauncher, RUN_TOOL } from '../forge/authors.ts';
import { captureCandidate } from '../forge/diff.ts';
import {
  execLaunch, execRefusal, MCP_CONFIG, NET_FILES, MCP_SHIM, MCP_SOCKET, mcpRuntimeDir, newMcpToken, profileLaunch,
  registerRunTool, runExec, SandboxRefused, type Mount, type ProfileOptions,
} from '../forge/sandbox.ts';
import { createWorkspace } from '../forge/workspace.ts';
import { ArtifactStore } from '../mission/artifacts.ts';
import type { Attempt, AttemptSandbox } from '../mission/types.ts';
import { run as runAgent } from '../swarm/adapters.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-forge-sandbox-')));
process.on('exit', () => {
  try {
    execFileSync('chmod', ['-R', 'u+rwx', tmp], { stdio: 'ignore' });
  } catch {
    // Best effort; the remove below reports nothing either way.
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const throws = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};

// ---- fixtures ------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@daylight',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@daylight',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const git = (args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(['init', '-q']);
fs.writeFileSync(path.join(repo, 'src', 'add.js'), 'module.exports = (a, b) => a + b;\n');
git(['add', '.']);
git(['commit', '-q', '-m', 'fixture']);
const commit = git(['rev-parse', 'HEAD']);
const out = path.join(tmp, 'out');
fs.mkdirSync(out);
fs.writeFileSync(path.join(out, 'daylight.db'), 'the ledger');
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');

const AVAILABLE: SandboxProfile = { name: 'bwrap', available: true, bwrap: '/usr/bin/bwrap', prlimit: '/usr/bin/prlimit' };
const UNAVAILABLE: SandboxProfile = { name: 'bwrap', available: false, why: 'forced off by the test' };

const grant: AttemptSandbox = { profile: 'author', network: 'none', write: true, exec: false, authorizeDecisionId: 'd_'.padEnd(34, 'a') };
const attemptOf = (sandbox: Partial<AttemptSandbox> = {}): Pick<Attempt, 'id' | 'missionId' | 'projectId' | 'sandbox'> => ({
  id: 'a_'.padEnd(34, '1'), missionId: 'm_'.padEnd(34, '2'), projectId: 'git:aaaaaaaaaaaa', sandbox: { ...grant, ...sandbox },
});
const authorization = { decisionId: grant.authorizeDecisionId!, missionId: attemptOf().missionId };

/** A mock agent: reads the probe plan from its prompt, prints what happened. */
const mock = path.join(tmp, 'mock-author.cjs');
fs.writeFileSync(mock, `'use strict';
const fs = require('node:fs');
const net = require('node:net');
const plan = JSON.parse(process.argv[3]);
const res = { writes: {}, reads: {}, lists: {}, env: Object.keys(process.env).sort(), cwd: process.cwd() };
for (const [p, body] of plan.writes || []) {
  try { if (p.startsWith('/work/')) fs.mkdirSync(require('node:path').dirname(p), { recursive: true }); fs.writeFileSync(p, body); res.writes[p] = 'ok'; }
  catch (e) { res.writes[p] = e.code; }
}
for (const p of plan.reads || []) { try { res.reads[p] = fs.readFileSync(p, 'utf8'); } catch (e) { res.reads[p] = e.code; } }
for (const p of plan.lists || []) { try { res.lists[p] = fs.readdirSync(p); } catch (e) { res.lists[p] = e.code; } }
const finish = () => process.stdout.write(JSON.stringify(res));
if (plan.connect) {
  const s = net.connect(plan.connect, '127.0.0.1');
  let over = false;
  const end = (v) => { if (over) return; over = true; res.connect = v; s.destroy(); finish(); process.exit(0); };
  s.on('connect', () => end('connected'));
  s.on('error', (e) => end(e.code));
  setTimeout(() => end('timeout'), 3000).unref();
} else finish();
`);

const optsFor = (kind: 'review' | 'author', extra: Partial<ProfileOptions> = {}): ProfileOptions => ({
  kind, root: kind === 'review' ? repo : path.join(tmp, 'tree'), network: kind === 'review' ? 'shared' : 'none',
  agent: { bin: nodeBinary(), argv: [mock, MCP_CONFIG, '{}'], mounts: [mock] },
  out, home, ...(kind === 'author' ? { authorization } : {}), ...extra,
});
fs.mkdirSync(path.join(tmp, 'tree'));

// ---- argv and mounts -----------------------------------------------------------------

/** The resolver and CA files `shared` adds, for comparing mount lists across network modes. */
const NET = new Set(NET_FILES);
const srcs = (ms: Mount[]) => ms.filter((m) => m.src && (m.kind === 'ro' || m.kind === 'rw')).map((m) => m.src!);
const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const notMounted = (label: string, ms: Mount[], extra: string[] = []) => {
  const s = srcs(ms);
  check(`${label}: <out> is not mounted, nor anything containing it`, s.every((p) => !under(p, out) && !under(out, p)), s.join(' '));
  check(`${label}: $HOME is not mounted, nor anything containing it`, s.every((p) => !under(home, p) && !under(p, path.join(home, '.ssh'))), s.join(' '));
  check(`${label}: no /run, /var or /sys from the host`, s.every((p) => !/^\/(run|var|sys)(\/|$)/.test(p)), s.join(' '));
  check(`${label}: no sibling git dir and no real .git`, s.every((p) => !p.endsWith('/git') && !p.includes('/.git')), s.join(' '));
  for (const e of extra) check(`${label}: ${e} is not mounted`, s.every((p) => !under(p, e)), s.join(' '));
};

section('the review profile');
{
  const sock = path.join(tmp, 'rt', 'mcp.sock');
  fs.mkdirSync(path.dirname(sock));
  const srv = net.createServer().listen(sock);
  await new Promise((r) => srv.once('listening', r));
  const l = profileLaunch(AVAILABLE, optsFor('review', { mcp: { socket: sock, token: newMcpToken() } }));
  const a = l.argv;
  check('starts with prlimit, then bwrap', a[0] === 'prlimit' && a[a.indexOf('--') + 1] === 'bwrap' && l.bin === '/usr/bin/prlimit');
  check('every namespace is unshared and user namespaces are sealed', ['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--clearenv'].every((f) => a.includes(f)));
  check('network is shared, with only the resolver and CA files', a.includes('--share-net')
    && srcs(l.mounts).filter((p) => p.startsWith('/etc/')).every((p) => /^\/etc\/(resolv\.conf|hosts|nsswitch\.conf|ssl|ca-certificates|ld\.so\.cache)$/.test(p)));
  const work = l.mounts.filter((m) => m.dest === '/work' || m.dest.startsWith('/work/'));
  check('the repo is bound read-only at /work and nothing writable under it',
    work.length === 2 && work[0].kind === 'ro' && work[0].src === repo && work[1].kind === 'tmpfs' && work[1].dest === '/work/.git');
  check('its .git is hidden by an empty tmpfs remounted read-only', a.join(' ').includes('--tmpfs /work/.git --remount-ro /work/.git'));
  check('no read-write bind at all', !l.mounts.some((m) => m.kind === 'rw') && !a.includes('--bind'));
  const socks = l.mounts.filter((m) => m.dest.startsWith('/run'));
  check('exactly one socket, the attempt\'s, at /run/daylight/mcp.sock, read-only',
    socks.filter((m) => m.kind === 'ro').length === 1 && socks.find((m) => m.kind === 'ro')?.src === sock && socks.find((m) => m.kind === 'ro')?.dest === MCP_SOCKET);
  check('the MCP config and shim come from memory, not a host path',
    l.mounts.filter((m) => m.kind === 'data').map((m) => m.dest).join(',') === `${MCP_CONFIG},${MCP_SHIM}` && l.feeds.length === 2);
  check('the token is in the fed config only, never in argv', !a.some((x) => /[0-9a-f]{64}/.test(x)) && /DAYLIGHT_MCP_TOKEN/.test(l.feeds[0].toString()));
  check('the root is remounted read-only before the agent starts', a.join(' ').includes('--remount-ro / --chdir /work --'));
  check('the agent runs our node with its script', a.slice(a.lastIndexOf('--') + 1).join(' ') === `${nodeBinary()} ${mock} ${MCP_CONFIG} {}`);
  notMounted('review', l.mounts, [path.join(tmp, 'tree')]);
  check('a review root that contains <out> is refused', !!throws(() => profileLaunch(AVAILABLE, optsFor('review', { root: tmp }))));
  check('a review with exec is refused', !!throws(() => profileLaunch(AVAILABLE, optsFor('review', { exec: true }))));
  check('a review with a write authorization is refused', !!throws(() => profileLaunch(AVAILABLE, optsFor('review', { authorization }))));
  check('a second socket path that is not a socket is refused',
    !!throws(() => profileLaunch(AVAILABLE, optsFor('review', { mcp: { socket: path.join(out, 'daylight.db'), token: newMcpToken() } }))));
  srv.close();
}

section('the author profile');
{
  const l = profileLaunch(AVAILABLE, optsFor('author'));
  const work = l.mounts.filter((m) => m.dest === '/work' || m.dest.startsWith('/work/'));
  check('the workspace tree is bound read-write at /work, and only it',
    work.length === 1 && work[0].kind === 'rw' && work[0].src === path.join(tmp, 'tree') && l.mounts.filter((m) => m.kind === 'rw').length === 1);
  check('network none: no --share-net and no resolver files', !l.argv.includes('--share-net') && !srcs(l.mounts).some((p) => p === '/etc/resolv.conf'));
  check('the real checkout is not mounted', !srcs(l.mounts).some((p) => under(p, repo)));
  check('no socket without an MCP endpoint', !l.mounts.some((m) => m.dest.startsWith('/run')));
  notMounted('author', l.mounts, [repo]);
  const shared = profileLaunch(AVAILABLE, optsFor('author', { network: 'shared', exec: true }));
  check('author exec with network shared is allowed at the agent level (R-1)', shared.argv.includes('--share-net'));
  check('and its mounts are those of exec off', JSON.stringify(shared.mounts.filter((m) => !NET.has(m.src ?? ''))) === JSON.stringify(l.mounts));
  check('an author without an authorization gets no launch', /authorize decision/.test(throws(() => profileLaunch(AVAILABLE, optsFor('author', { authorization: undefined }))) ?? ''));
  check('an author root that is a checkout (has .git) is refused', !!throws(() => profileLaunch(AVAILABLE, optsFor('author', { root: repo }))));
  check('an agent mount under ~/.ssh is refused',
    !!throws(() => profileLaunch(AVAILABLE, optsFor('author', { agent: { bin: nodeBinary(), argv: [], mounts: [path.join(home, '.ssh', 'id_ed25519')] } }))));
  check('an agent mount containing $HOME is refused',
    !!throws(() => profileLaunch(AVAILABLE, optsFor('author', { agent: { bin: nodeBinary(), argv: [], mounts: [path.dirname(home)] } }))));
  check('an agent mount under <out> is refused',
    !!throws(() => profileLaunch(AVAILABLE, optsFor('author', { agent: { bin: nodeBinary(), argv: [], mounts: [path.join(out, 'daylight.db')] } }))));
  check('a bad environment name is refused', !!throws(() => profileLaunch(AVAILABLE, optsFor('author', { env: { 'A=B': 'x' } }))));
}

section('the launcher refuses rows that do not grant it');
{
  const ws = { tree: path.join(tmp, 'tree') };
  check('authorLauncher needs an author row with write and its decision',
    !!throws(() => authorLauncher({ attempt: attemptOf({ write: false, exec: false }), workspace: ws, profile: AVAILABLE }))
    && !!throws(() => authorLauncher({ attempt: attemptOf({ authorizeDecisionId: null }), workspace: ws, profile: AVAILABLE }))
    && !!throws(() => authorLauncher({ attempt: attemptOf({ profile: 'review' }), workspace: ws, profile: AVAILABLE })));
  const launch = authorLauncher({ attempt: attemptOf({ network: 'shared' }), workspace: ws, profile: AVAILABLE, out });
  check('it takes the network from the row', launch(nodeBinary(), []).argv.includes('--share-net'));
  check('reviewLauncher refuses a row with write or exec',
    !!throws(() => reviewLauncher({ attempt: attemptOf({ profile: 'review' }), repo, profile: AVAILABLE })));
  check('reviewLauncher takes a read-only review row', !throws(() => reviewLauncher({
    attempt: attemptOf({ profile: 'review', write: false, exec: false, authorizeDecisionId: null, network: 'shared' }), repo, profile: AVAILABLE, out,
  })(nodeBinary(), [])));
}

section('exec is off by default and reachable only from the row');
{
  check('an author without exec gets the file tools only, never Bash',
    JSON.stringify(authorTools(attemptOf())) === JSON.stringify([...AUTHOR_FILE_TOOLS]) && !authorTools(attemptOf({ exec: true })).includes('Bash'));
  check('an author whose row holds exec also gets the run tool', authorTools(attemptOf({ exec: true })).includes(RUN_TOOL));
  check('exec is refused for a row without it', execRefusal(attemptOf()) !== null);
  check('exec is refused for a row with exec but no write grant',
    execRefusal(attemptOf({ exec: true, write: false })) !== null && execRefusal(attemptOf({ exec: true, authorizeDecisionId: null })) !== null);
  check('registering run on a row without exec is refused',
    !!throws(() => registerRunTool(new McpServer({ name: 't', version: '0' }), { attempt: attemptOf(), tree: path.join(tmp, 'tree') })));
  const tools = (s: McpServer) => Object.keys((s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {});
  check('the author MCP server has no run tool by default', tools(authorServer({ attempt: attemptOf(), tree: path.join(tmp, 'tree') })).length === 0);
  check('and has it when the row holds exec', tools(authorServer({ attempt: attemptOf({ exec: true }), tree: path.join(tmp, 'tree') })).includes('run'));
  check('the exec launch is refused without exec on the row',
    !!throws(() => execLaunch(AVAILABLE, attemptOf(), { tree: path.join(tmp, 'tree'), command: ['node', '-v'] })));
  const e = execLaunch(AVAILABLE, attemptOf({ exec: true, network: 'shared' }), { tree: path.join(tmp, 'tree'), command: ['node', 'x.js'], home, out } as never);
  check('the exec sandbox never shares the network, whatever the agent has', !e.argv.includes('--share-net') && e.argv.includes('--unshare-all'));
  check('the exec sandbox mounts the tree and nothing else from outside the system set',
    e.mounts.filter((m) => m.kind === 'rw').length === 1 && !e.mounts.some((m) => m.kind === 'data' || m.dest.startsWith('/run')));
  notMounted('exec', e.mounts, [repo]);
  check('a shell string is not a command', !!throws(() => execLaunch(AVAILABLE, attemptOf({ exec: true }), { tree: path.join(tmp, 'tree'), command: ['sh -c id'] })));
  check('a binary outside /usr/bin is refused', !!throws(() => execLaunch(AVAILABLE, attemptOf({ exec: true }), { tree: path.join(tmp, 'tree'), command: [mock] })));
}

section('fail closed');
{
  check('no bwrap: the review profile throws', throws(() => profileLaunch(UNAVAILABLE, optsFor('review')))?.includes('sandbox unavailable') === true);
  check('no bwrap: the author profile throws', throws(() => profileLaunch(UNAVAILABLE, optsFor('author')))?.includes('sandbox unavailable') === true);
  check('no bwrap: exec throws', !!throws(() => execLaunch(UNAVAILABLE, attemptOf({ exec: true }), { tree: path.join(tmp, 'tree'), command: ['node', '-v'] })));
  const mockAuthor = authorFor('mock', { DAYLIGHT_MOCK_ADAPTER: mock });
  let refused = 'ran';
  try {
    if (mockAuthor.status !== 'available') throw new Error(mockAuthor.why);
    await runAgent(mockAuthor.adapter, {
      prompt: '{}', cwd: '/', mcpConfigPath: MCP_CONFIG, session: 's',
      launch: authorLauncher({ attempt: attemptOf(), workspace: { tree: path.join(tmp, 'tree') }, profile: UNAVAILABLE }),
    });
  } catch (err) {
    refused = err instanceof SandboxRefused ? 'refused' : `other: ${(err as Error).message}`;
  }
  check('no bwrap: an author run is refused before anything is spawned', refused === 'refused', refused);
}

section('real providers stay unavailable for implement');
{
  const c = authorFor('claude');
  check('claude is unavailable, and says why', c.status === 'unavailable' && /R4 Q5/.test(c.why));
  check('so are the others', ['codex', 'grok', 'opencode'].every((t) => authorFor(t).status === 'unavailable'));
  check('mock without DAYLIGHT_MOCK_ADAPTER is unavailable', authorFor('mock', {}).status === 'unavailable');
}

section('the system mounts are P0\'s');
{
  const p0 = sandboxArgv(AVAILABLE, { worktree: path.join(tmp, 'tree'), command: ['node', 'x.js'] });
  const mine = execLaunch(AVAILABLE, attemptOf({ exec: true }), { tree: path.join(tmp, 'tree'), command: ['node', 'x.js'] }).argv;
  const upToTmp = (a: string[]) => a.slice(0, a.indexOf('/tmp', a.indexOf('--tmpfs')) + 1);
  check('the exec sandbox shares P0\'s namespaces, limits and system mounts verbatim',
    JSON.stringify(upToTmp(p0)) === JSON.stringify(upToTmp(mine)), `${upToTmp(p0).join(' ')}\n${upToTmp(mine).join(' ')}`);
}

// ---- the real sandbox -------------------------------------------------------------

const live = detectSandbox();
if (!live.available) {
  console.log(`\nskipped: live sandbox cases need bwrap and prlimit (${live.why})`);
  done();
}

const author = authorFor('mock', { DAYLIGHT_MOCK_ADAPTER: mock });
if (author.status !== 'available') throw new Error(author.why);
const { adapter: authorAdapter, mounts: authorMounts } = author;

const listener = net.createServer((s) => s.end());
await new Promise<void>((r) => listener.listen(0, '127.0.0.1', () => r()));
const port = (listener.address() as net.AddressInfo).port;

async function authorRun(network: 'none' | 'shared', plan: Record<string, unknown>) {
  const ws = createWorkspace(repo, commit);
  const r = await runAgent(authorAdapter, {
    prompt: JSON.stringify(plan), cwd: ws.tree, mcpConfigPath: MCP_CONFIG, session: 's', timeoutMs: 20_000,
    launch: authorLauncher({
      attempt: attemptOf({ network }), workspace: ws, mounts: authorMounts, out, profile: live,
      env: { LAUNCH_SET_VAR: 'x' },
    }),
  });
  let res: Record<string, any> = {};
  try {
    res = JSON.parse(r.stdout);
  } catch {
    res = { raw: r.stdout, stderr: r.stderr };
  }
  return { ws, r, res };
}

const probes = {
  writes: [['/work/src/inside.js', 'written by the author\n'], ['/work/../escape.txt', 'x'], [`${repo}/src/add.js`, 'x'], [path.join(out, 'evil'), 'x'], ['/tmp/scratch', 'ok']],
  reads: [path.join(home, '.ssh', 'id_ed25519'), path.join(os.homedir(), '.ssh', 'id_ed25519'), path.join(out, 'daylight.db'), '/proc/self/environ'],
  lists: ['/run', '/run/user', '/var', '/sys', repo],
  connect: port,
};

process.env.DAYLIGHT_FORGE_TEST_HOST_SECRET = 'host-only-value';
const results: Record<string, Awaited<ReturnType<typeof authorRun>>> = {};
for (const network of ['none', 'shared'] as const) {
  section(`a mock author under bwrap, network ${network}`);
  const run = await authorRun(network, { ...probes, reads: [...probes.reads, results.none ? path.join(results.none.ws.gitDir, 'HEAD') : '/nonexistent'] });
  results[network] = run;
  const { res, ws } = run;
  check('the mock ran', run.r.exitCode === 0 && !!res.writes, JSON.stringify(res).slice(0, 400));
  check('a write inside the tree is allowed', res.writes?.['/work/src/inside.js'] === 'ok');
  check('a write above /work is impossible', res.writes?.['/work/../escape.txt'] !== 'ok', res.writes?.['/work/../escape.txt']);
  check('the real checkout cannot be written', res.writes?.[`${repo}/src/add.js`] !== 'ok' && fs.readFileSync(path.join(repo, 'src', 'add.js'), 'utf8').includes('a + b'));
  check('<out> cannot be written', res.writes?.[path.join(out, 'evil')] !== 'ok' && !fs.existsSync(path.join(out, 'evil')));
  check('<out>/daylight.db cannot be read', res.reads?.[path.join(out, 'daylight.db')] === 'ENOENT');
  check('no ~/.ssh is readable', res.reads?.[path.join(home, '.ssh', 'id_ed25519')] === 'ENOENT' && res.reads?.[path.join(os.homedir(), '.ssh', 'id_ed25519')] === 'ENOENT');
  check('/proc/self/environ holds the sandbox\'s environment, not the host\'s',
    typeof res.reads?.['/proc/self/environ'] === 'string' && !res.reads['/proc/self/environ'].includes('host-only-value'));
  check('only the variables the launch set reach the agent',
    JSON.stringify(res.env) === JSON.stringify(['HOME', 'LAUNCH_SET_VAR', 'PATH', 'PWD']), JSON.stringify(res.env));
  check('/run holds nothing from the host', Array.isArray(res.lists?.['/run']) ? res.lists['/run'].length === 0 : res.lists?.['/run'] === 'ENOENT', JSON.stringify(res.lists?.['/run']));
  check('/run/user, /var and /sys are absent', ['/run/user', '/var', '/sys'].every((p) => res.lists?.[p] === 'ENOENT'));
  check('the real checkout is not visible', res.lists?.[repo] === 'ENOENT');
  check('/tmp is the sandbox\'s own and writable', res.writes?.['/tmp/scratch'] === 'ok' && !fs.existsSync('/tmp/scratch'));
  if (network === 'shared') {
    check('the sibling git dir of another workspace is not visible', Object.entries(res.reads ?? {}).some(([k, v]) => k.endsWith('/HEAD') && v === 'ENOENT'));
  }
  const d = captureCandidate(ws);
  check('the write inside the tree lands in the diff', 'files' in d && d.files.length === 1 && d.files[0].path === 'src/inside.js' && d.files[0].change === 'added',
    JSON.stringify('files' in d ? d.files : d));
}
section('the filesystem boundary does not depend on the network namespace (resolution 3)');
{
  const strip = (r: Record<string, any>) => JSON.stringify({ writes: r.writes, reads: { ...r.reads, '/proc/self/environ': undefined }, lists: r.lists, env: r.env });
  const n = results.none.res;
  const s = results.shared.res;
  delete n.reads['/nonexistent'];
  for (const k of Object.keys(s.reads)) if (k.endsWith('/HEAD')) delete s.reads[k];
  check('network none cannot reach a host listener on 127.0.0.1', n.connect !== 'connected', n.connect);
  check('network shared reaches it (the namespace really is shared)', s.connect === 'connected', s.connect);
  check('every filesystem probe has the same outcome under both', strip(n) === strip(s), `${strip(n)}\n${strip(s)}`);
  check('both diffs are the same bytes', (() => {
    const a = captureCandidate(results.none.ws);
    const b = captureCandidate(results.shared.ws);
    return 'diffDigest' in a && 'diffDigest' in b && a.diffDigest === b.diffDigest;
  })());
  check('the real checkout is clean afterwards', git(['status', '--porcelain']) === '' && git(['rev-parse', 'HEAD']) === commit);
  for (const r of Object.values(results)) r.ws.dispose();
}

section('exec runs in a second sandbox with no network');
{
  const ws = createWorkspace(repo, commit);
  fs.writeFileSync(path.join(ws.tree, 'probe.js'), `
const net = require('node:net');
const s = net.connect(${port}, '127.0.0.1');
const end = (v) => { console.log('connect:' + v); require('node:fs').writeFileSync('/work/exec-wrote.txt', 'from exec\\n'); s.destroy(); };
s.on('connect', () => end('connected'));
s.on('error', (e) => end(e.code));
setTimeout(() => end('timeout'), 3000);
`);
  const artifacts = new ArtifactStore(path.join(tmp, 'exec-out'));
  const execRow = attemptOf({ exec: true, network: 'shared' });
  const r = await runExec(execRow, { tree: ws.tree, command: ['node', 'probe.js'], profile: live, artifacts, timeoutMs: 20_000 });
  check('the command ran', r.exitCode === 0, `${r.exitCode} ${r.stderr}`);
  check('even for an agent with network shared, exec cannot open a TCP connection to 127.0.0.1', /connect:(ECONNREFUSED|ENETUNREACH|EACCES|EPERM)/.test(r.stdout) && !r.stdout.includes('connected'), r.stdout);
  check('exec writes land in the tree, and so in the diff', (() => {
    const d = captureCandidate(ws);
    return 'files' in d && d.files.some((f) => f.path === 'exec-wrote.txt');
  })());
  check('its output is captured as artifacts', r.artifacts.length === 2 && artifacts.get(r.artifacts[0]).toString().includes('connect:'));
  const refused = await runExec(attemptOf(), { tree: ws.tree, command: ['node', 'probe.js'], profile: live }).then(() => 'ran', (e: Error) => e.message);
  check('the same call for a row without exec is refused', /not granted exec/.test(refused), refused);
  ws.dispose();
}

section('hooks in the materialised tree never run on the host');
{
  const ws = createWorkspace(repo, commit);
  const marker = path.join(tmp, 'hook-ran');
  const hook = `#!/bin/sh\ntouch ${marker}\n`;
  for (const h of ['pre-commit', 'post-commit', 'post-checkout', 'post-index-change', 'pre-auto-gc', 'reference-transaction']) {
    fs.mkdirSync(path.join(ws.tree, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(ws.tree, '.git', 'hooks', h), hook, { mode: 0o755 });
    fs.mkdirSync(path.join(ws.tree, 'sub', '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(ws.tree, 'sub', '.git', 'hooks', h), hook, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(ws.tree, '.git', 'config'), `[core]\n\tfsmonitor = ${path.join(ws.tree, '.git', 'hooks', 'pre-commit')}\n\thooksPath = .git/hooks\n[filter "x"]\n\tclean = touch ${marker}\n`);
  fs.writeFileSync(path.join(ws.tree, '.gitattributes'), '* filter=x\n');
  fs.writeFileSync(path.join(ws.tree, 'src', 'changed.js'), 'changed\n');
  const d = captureCandidate(ws);
  const fresh = createWorkspace(repo, commit);
  check('the hostile tree is still captured', 'files' in d && d.files.some((f) => f.path === 'src/changed.js'), JSON.stringify('files' in d ? d.files.map((f) => f.path) : d));
  check('no hook, fsmonitor or filter planted in the tree ran on the host', !fs.existsSync(marker));
  check('the planted .gitattributes is flagged', 'flags' in d && d.flags.some((f) => f.path === '.gitattributes' && f.protected));
  if ('diff' in d) {
    const { applyDiff } = await import('../forge/workspace.ts');
    applyDiff(fresh, d.diff, d.diffDigest);
  }
  check('nor when the diff is applied to a fresh workspace', !fs.existsSync(marker));
  check('the real checkout is clean', git(['status', '--porcelain']) === '');
  ws.dispose();
  fresh.dispose();
}

section('the MCP runtime directory');
{
  const rt = mcpRuntimeDir({ out, home });
  check('it is private', (fs.statSync(rt.dir).mode & 0o077) === 0);
  check('it is outside $HOME and <out>', !under(rt.dir, os.homedir()) && !under(rt.dir, out));
  check('the socket path fits sun_path', Buffer.byteLength(rt.socket) <= 107);
  rt.dispose();
  check('it is removed on dispose', !fs.existsSync(rt.dir));
}

listener.close();
done();
