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
import { authorFor, authorLauncher, authorServer, authorTools, AUTHOR_FILE_TOOLS, REQUEST_DEPENDENCY, reviewLauncher, RUN_TOOL } from '../forge/authors.ts';
import { captureCandidate } from '../forge/diff.ts';
import {
  execLaunch, execRefusal, MCP_CONFIG, MCP_HANDSHAKE, NET_FILES, MCP_SHIM, MCP_SOCKET, mcpRuntimeDir, newMcpToken, profileLaunch,
  registerRunTool, runExec, SandboxRefused, type Mount, type ProfileOptions,
} from '../forge/sandbox.ts';
import { createWorkspace, WORKSPACE_PREFIX } from '../forge/workspace.ts';
import { ArtifactStore } from '../mission/artifacts.ts';
import type { Attempt, AttemptSandbox } from '../mission/types.ts';
import type { Graph } from '../graph/types.ts';
import { evaluate, type Invariant } from '../invariants/engine.ts';
import { createServer, listenAttemptSocket } from '../mcp/server.ts';
import { MissionStore } from '../mission/store.ts';
import type { ProjectIdentity } from '../mission/types.ts';
import { ClaimStore } from '../store/claims.ts';
import { run as runAgent } from '../swarm/adapters.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-test-forge-sb-')));
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
const PROJECT: ProjectIdentity = { id: 'git:aaaaaaaaaaaa', root: repo, name: 'fixture' };
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
  const inRepoOut = path.join(repo, 'out');
  fs.mkdirSync(inRepoOut, { recursive: true });
  check('the default layout, <out> inside the repo, is refused for review',
    /<out>/.test(throws(() => profileLaunch(AVAILABLE, optsFor('review', { out: inRepoOut }))) ?? ''));
  fs.rmSync(inRepoOut, { recursive: true });
  const noOut = (kind: 'review' | 'author') => ({ ...optsFor(kind), out: undefined }) as unknown as ProfileOptions;
  check('a review launch without <out> is refused, not assumed safe', /<out>/.test(throws(() => profileLaunch(AVAILABLE, noOut('review'))) ?? ''));
  check('an author launch without <out> is refused', /<out>/.test(throws(() => profileLaunch(AVAILABLE, noOut('author'))) ?? ''));
  check('an exec launch without <out> is refused', /<out>/.test(throws(() => execLaunch(AVAILABLE, attemptOf({ exec: true }),
    { tree: path.join(tmp, 'tree'), command: ['node', '-v'] } as never)) ?? ''));
  check('the launchers refuse to be built without <out>',
    /<out>/.test(throws(() => reviewLauncher({ attempt: attemptOf({ profile: 'review', write: false, exec: false, authorizeDecisionId: null }), repo, profile: AVAILABLE } as never)) ?? '')
    && /<out>/.test(throws(() => authorLauncher({ attempt: attemptOf(), workspace: { tree: path.join(tmp, 'tree') }, profile: AVAILABLE } as never)) ?? ''));
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
  const notes = path.join(home, 'notes.txt');
  fs.writeFileSync(notes, 'x');
  const withMount = (p: string, homeAllow?: string[]) => throws(() => profileLaunch(AVAILABLE, optsFor('author', {
    agent: { bin: nodeBinary(), argv: [], mounts: [p] }, ...(homeAllow ? { homeAllow } : {}),
  })));
  check('any path under $HOME is refused by default', /home directory/.test(withMount(notes) ?? ''), String(withMount(notes)));
  check('and admitted only when allowlisted', withMount(notes, [notes]) === null, String(withMount(notes, [notes])));
  for (const rel of ['.netrc', '.npmrc', '.git-credentials', '.config/gh', '.ssh', '.aws', '.config/daylight']) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, 'secret');
    check(`~/${rel} is refused even when allowlisted`, /is under ~\//.test(withMount(p, [p]) ?? ''), String(withMount(p, [p])));
  }
  for (const [label, entry] of [
    ['$HOME itself', home], ['a parent of $HOME', path.dirname(home)], ['/', '/'], ['a path outside $HOME', tmp + '/elsewhere'],
    ['a glob', path.join(home, '*')], ['a relative path', 'notes.txt'], ['$HOME spelled with ..', path.join(home, 'proj', '..')],
  ] as const) {
    check(`a homeAllow entry that is ${label} is refused as input`,
      /homeAllow/.test(withMount(notes, [entry]) ?? ''), String(withMount(notes, [entry])));
  }
  const homeRepo = path.join(home, 'proj');
  fs.mkdirSync(homeRepo, { recursive: true });
  check('a review root under $HOME is the explicitly named root, so admitted',
    !throws(() => profileLaunch(AVAILABLE, optsFor('review', { root: homeRepo }))));
  check('but a root that is a credential store is not',
    !!throws(() => profileLaunch(AVAILABLE, optsFor('review', { root: path.join(home, '.config', 'gh') }))));
  check('a bad environment name is refused', !!throws(() => profileLaunch(AVAILABLE, optsFor('author', { env: { 'A=B': 'x' } }))));
}

section('the launcher refuses rows that do not grant it');
{
  const ws = { tree: path.join(tmp, 'tree') };
  check('authorLauncher needs an author row with write and its decision',
    !!throws(() => authorLauncher({ attempt: attemptOf({ write: false, exec: false }), workspace: ws, profile: AVAILABLE, out }))
    && !!throws(() => authorLauncher({ attempt: attemptOf({ authorizeDecisionId: null }), workspace: ws, profile: AVAILABLE, out }))
    && !!throws(() => authorLauncher({ attempt: attemptOf({ profile: 'review' }), workspace: ws, profile: AVAILABLE, out })));
  const launch = authorLauncher({ attempt: attemptOf({ network: 'shared' }), workspace: ws, profile: AVAILABLE, out });
  check('it takes the network from the row', launch(nodeBinary(), []).argv.includes('--share-net'));
  check('reviewLauncher refuses a row with write or exec',
    !!throws(() => reviewLauncher({ attempt: attemptOf({ profile: 'review' }), repo, profile: AVAILABLE, out })));
  check('reviewLauncher takes a read-only review row', !throws(() => reviewLauncher({
    attempt: attemptOf({ profile: 'review', write: false, exec: false, authorizeDecisionId: null, network: 'shared' }), repo, profile: AVAILABLE, out,
  })(nodeBinary(), [])));
}

section('exec is off by default and reachable only from the row');
{
  check('an author without exec gets the file tools and request_dependency only, never Bash',
    JSON.stringify(authorTools(attemptOf())) === JSON.stringify([...AUTHOR_FILE_TOOLS, REQUEST_DEPENDENCY]) && !authorTools(attemptOf({ exec: true })).includes('Bash'));
  check('an author whose row holds exec also gets the run tool', authorTools(attemptOf({ exec: true })).includes(RUN_TOOL));
  check('exec is refused for a row without it', execRefusal(attemptOf()) !== null);
  check('exec is refused for a row with exec but no write grant',
    execRefusal(attemptOf({ exec: true, write: false })) !== null && execRefusal(attemptOf({ exec: true, authorizeDecisionId: null })) !== null);
  check('registering run on a row without exec is refused',
    !!throws(() => registerRunTool(new McpServer({ name: 't', version: '0' }), { attempt: attemptOf(), tree: path.join(tmp, 'tree'), out })));
  const tools = (s: McpServer) => Object.keys((s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {});
  check('the author MCP server has no run tool by default', JSON.stringify(tools(authorServer({ attempt: attemptOf(), tree: path.join(tmp, 'tree'), out }))) === '["request_dependency"]');
  check('and has it when the row holds exec', tools(authorServer({ attempt: attemptOf({ exec: true }), tree: path.join(tmp, 'tree'), out })).includes('run'));
  check('the exec launch is refused without exec on the row',
    !!throws(() => execLaunch(AVAILABLE, attemptOf(), { tree: path.join(tmp, 'tree'), out, command: ['node', '-v'] })));
  const e = execLaunch(AVAILABLE, attemptOf({ exec: true, network: 'shared' }), { tree: path.join(tmp, 'tree'), command: ['node', 'x.js'], home, out } as never);
  check('the exec sandbox never shares the network, whatever the agent has', !e.argv.includes('--share-net') && e.argv.includes('--unshare-all'));
  check('the exec sandbox mounts the tree and nothing else from outside the system set',
    e.mounts.filter((m) => m.kind === 'rw').length === 1 && !e.mounts.some((m) => m.kind === 'data' || m.dest.startsWith('/run')));
  notMounted('exec', e.mounts, [repo]);
  check('a shell string is not a command', !!throws(() => execLaunch(AVAILABLE, attemptOf({ exec: true }), { tree: path.join(tmp, 'tree'), out, command: ['sh -c id'] })));
  check('a binary outside /usr/bin is refused', !!throws(() => execLaunch(AVAILABLE, attemptOf({ exec: true }), { tree: path.join(tmp, 'tree'), out, command: [mock] })));
}

section('exec refusals name no host path (review L1, probe F)');
{
  const planted = path.join(tmp, 'tree-planted-git');
  fs.mkdirSync(path.join(planted, '.git'), { recursive: true });
  const launch = () => execLaunch(AVAILABLE, attemptOf({ exec: true }), { tree: planted, out, home, command: ['/usr/bin/true'] });
  const dirWhy = throws(launch) ?? '';
  check('a planted /work/.git directory is refused as /work, naming no host path',
    /^\/work has a \.git/.test(dirWhy) && !dirWhy.includes(tmp) && !dirWhy.includes(planted), dirWhy);
  fs.rmSync(path.join(planted, '.git'), { recursive: true });
  fs.symlinkSync('/nonexistent-target', path.join(planted, '.git'));
  const linkWhy = throws(launch) ?? '';
  check('so is a dangling symlink named .git (lstat, not exists)', /^\/work has a \.git/.test(linkWhy), linkWhy);
  fs.rmSync(path.join(planted, '.git'));
  const server = new McpServer({ name: 't', version: '0' });
  registerRunTool(server, { attempt: attemptOf({ exec: true }), tree: planted, out, profile: AVAILABLE });
  fs.mkdirSync(path.join(planted, '.git'));
  const handler = (server as unknown as { _registeredTools: Record<string, { handler?: (a: unknown) => Promise<{ content: Array<{ text: string }> }>; callback?: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.run;
  const reply = await (handler.handler ?? handler.callback)!({ argv: ['/usr/bin/true'] });
  const text = reply.content[0].text;
  check('the run tool\'s error reply names no host path either', /\/work has a \.git/.test(text) && !text.includes(tmp), text);
}

section('fail closed');
{
  check('no bwrap: the review profile throws', throws(() => profileLaunch(UNAVAILABLE, optsFor('review')))?.includes('sandbox unavailable') === true);
  check('no bwrap: the author profile throws', throws(() => profileLaunch(UNAVAILABLE, optsFor('author')))?.includes('sandbox unavailable') === true);
  check('no bwrap: exec throws', !!throws(() => execLaunch(UNAVAILABLE, attemptOf({ exec: true }), { tree: path.join(tmp, 'tree'), out, command: ['node', '-v'] })));
  const mockAuthor = authorFor('mock', { DAYLIGHT_MOCK_ADAPTER: mock });
  let refused = 'ran';
  try {
    if (mockAuthor.status !== 'available') throw new Error(mockAuthor.why);
    await runAgent(mockAuthor.adapter, {
      prompt: '{}', cwd: '/', mcpConfigPath: MCP_CONFIG, session: 's',
      launch: authorLauncher({ attempt: attemptOf(), workspace: { tree: path.join(tmp, 'tree') }, profile: UNAVAILABLE, out }),
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

section('the R7 invariant: one place emits a read-write mount');
{
  const invariants = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'daylight.invariants.json'), 'utf8')) as Invariant[];
  const inv = invariants.find((i) => i.id === 'forge-rw-bind-needs-authorization');
  check('it is registered beside the P0 invariants', !!inv);
  const graphWith = (files: string[]) => ({ nodes: [], edges: [], calls: [], literals: files.map((file) => ({ value: '--bind', file, line: 1, callee: 'push' })) }) as unknown as Graph;
  if (inv) {
    check('green with the bind in forge/sandbox.ts alone', evaluate(graphWith(['engine/forge/sandbox.ts']), inv).status === 'green');
    check('red when a second engine file emits --bind', evaluate(graphWith(['engine/forge/sandbox.ts', 'engine/swarm/adapters.ts']), inv).status === 'red');
    check('red when no file does (the guard cannot vanish quietly)', evaluate(graphWith([]), inv).status === 'red');
    check('tests asserting on the flag do not count', evaluate(graphWith(['engine/forge/sandbox.ts', 'engine/test/forge-sandbox.ts']), inv).status === 'green');
  }
}

section('the system mounts are P0\'s');
{
  const p0 = sandboxArgv(AVAILABLE, { worktree: path.join(tmp, 'tree'), command: ['node', 'x.js'] });
  const mine = execLaunch(AVAILABLE, attemptOf({ exec: true }), { tree: path.join(tmp, 'tree'), out, command: ['node', 'x.js'] }).argv;
  const upToTmp = (a: string[]) => a.slice(0, a.indexOf('/tmp', a.indexOf('--tmpfs')) + 1);
  check('the exec sandbox shares P0\'s namespaces, limits and system mounts verbatim',
    JSON.stringify(upToTmp(p0)) === JSON.stringify(upToTmp(mine)), `${upToTmp(p0).join(' ')}\n${upToTmp(mine).join(' ')}`);
}

// ---- the real sandbox -------------------------------------------------------------

// ---- the attempt socket: host side ---------------------------------------------------

const store = new MissionStore(path.join(tmp, 'store'));
store.ensureProject(PROJECT);
const reviewMission = store.createMission({ projectId: PROJECT.id, kind: 'verify', objective: 'review it', baseRevision: commit });
const reviewTask = store.createTask({ missionId: reviewMission.id, role: 'review', objective: 'review it' });
const reviewToken = newMcpToken();
const reviewAttempt = store.startAttempt({
  taskId: reviewTask.id, runnerId: 'agent:mock:review', sessionId: 'sess-review',
  sandbox: { profile: 'review', network: 'shared' }, mcpToken: reviewToken,
});
const otherTask = store.createTask({ missionId: reviewMission.id, role: 'review', objective: 'another reviewer' });
const otherToken = newMcpToken();
const otherAttempt = store.startAttempt({ taskId: otherTask.id, runnerId: 'agent:mock:other', sandbox: { profile: 'review' }, mcpToken: otherToken });

const implement = store.createMission({
  projectId: PROJECT.id, kind: 'implement', objective: 'change it', baseRevision: commit, adhoc: { actor: 'human:miz', rationale: 'test' },
});
const { decision: authorize } = store.authorizeMission({
  missionId: implement.id, actor: 'human:miz', rationale: 'go', permissions: { write: true, execute: true }, maxUsd: null,
});
const authorTask = store.createTask({ missionId: implement.id, role: 'author', objective: 'write it' });
const authorToken = newMcpToken();
const execAttempt = store.startAttempt({
  taskId: authorTask.id, runnerId: 'agent:mock:author', mcpToken: authorToken,
  sandbox: { profile: 'author', network: 'shared', write: true, exec: true, authorizeDecisionId: authorize.id },
});

const toyServer = () => {
  const s = new McpServer({ name: 'daylight', version: '0' });
  s.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }));
  return s;
};

/** Connect as a shim would, optionally handshake, send one JSON-RPC request, report what came back. */
function hostClient(socket: string, handshake: string | null): Promise<{ closed: boolean; reply: string }> {
  return new Promise((resolve) => {
    const c = net.connect(socket);
    let reply = '';
    const finish = (closed: boolean) => {
      c.destroy();
      resolve({ closed, reply });
    };
    c.on('connect', () => {
      if (handshake !== null) c.write(handshake);
      c.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
    });
    c.on('data', (d) => {
      reply += String(d);
      if (reply.includes('\n')) finish(false);
    });
    c.on('close', () => finish(true));
    c.on('error', () => finish(true));
    setTimeout(() => finish(false), 3000).unref();
  });
}

section('the attempt socket refuses every token but its attempt\'s');
{
  const rt = mcpRuntimeDir({ out, home });
  const refusals: string[] = [];
  const sock = await listenAttemptSocket({
    socketPath: rt.socket, attemptId: reviewAttempt.id, resolve: (t) => store.attemptByMcpToken(t),
    serve: toyServer, onRefused: (why) => refusals.push(why), handshakeTimeoutMs: 500,
  });
  check('the socket is the owner\'s only', (fs.statSync(rt.socket).mode & 0o077) === 0);
  const good = await hostClient(rt.socket, `${MCP_HANDSHAKE} ${reviewToken}\n`);
  check('its own token is served MCP', /"result"/.test(good.reply) && /protocolVersion/.test(good.reply), good.reply);
  const wrong = await hostClient(rt.socket, `${MCP_HANDSHAKE} ${newMcpToken()}\n`);
  check('a token that matches no attempt is refused before any MCP', wrong.closed && wrong.reply === '', wrong.reply);
  const other = await hostClient(rt.socket, `${MCP_HANDSHAKE} ${otherToken}\n`);
  check('another live attempt\'s token is refused', other.closed && other.reply === '', other.reply);
  const none = await hostClient(rt.socket, null);
  check('a connection that skips the handshake is refused', none.closed && none.reply === '', none.reply);
  const bare = await hostClient(rt.socket, `${reviewToken}\n`);
  check('a bare token without the handshake word is refused', bare.closed && bare.reply === '');
  check('each refusal says why, without the token',
    refusals.length === 4 && refusals.every((r) => !r.includes(reviewToken) && !r.includes(otherToken)), JSON.stringify(refusals));
  check('only the one good connection was accepted', sock.accepted() === 1);
  check('a second listener on the same path is refused', !!(await listenAttemptSocket({
    socketPath: rt.socket, attemptId: reviewAttempt.id, resolve: () => null, serve: toyServer,
  }).then(() => null, (e: Error) => e.message)));
  store.finishAttempt(otherAttempt.id, { state: 'completed', costUsd: null });
  const late = await hostClient(rt.socket, `${MCP_HANDSHAKE} ${otherToken}\n`);
  check('a finished attempt\'s token finds nothing', late.closed);
  check('the store keeps only the token\'s digest',
    store.attempt(reviewAttempt.id)!.mcpTokenDigest?.startsWith('sha256:') === true && !JSON.stringify(store.attempt(reviewAttempt.id)).includes(reviewToken));
  const before = refusals.length;
  const flood = await new Promise<{ closed: boolean; reply: string }>((resolve) => {
    const c = net.connect(rt.socket);
    let reply = '';
    c.on('connect', () => {
      c.write(`${MCP_HANDSHAKE} ${reviewToken}\n`);
      c.write(Buffer.alloc(1024 * 1024 + 64, 0x61));
    });
    c.on('data', (d) => { reply += String(d); });
    c.on('close', () => resolve({ closed: true, reply }));
    c.on('error', () => {});
    setTimeout(() => { c.destroy(); resolve({ closed: false, reply }); }, 3000).unref();
  });
  check('after a good handshake, a frame over 1 MiB without a newline drops the connection',
    flood.closed && refusals.length === before + 1 && /frame/.test(refusals.at(-1) ?? ''), JSON.stringify(refusals.slice(before)));
  const afterFlood = await hostClient(rt.socket, `${MCP_HANDSHAKE} ${reviewToken}\n`);
  check('and the socket still serves an ordinary connection', /"result"/.test(afterFlood.reply));
  await sock.close();
  check('closing removes the socket', !fs.existsSync(rt.socket));
  rt.dispose();
}

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
  const r = await runExec(execRow, { tree: ws.tree, out, command: ['node', 'probe.js'], profile: live, artifacts, timeoutMs: 20_000 });
  check('the command ran', r.exitCode === 0, `${r.exitCode} ${r.stderr}`);
  check('even for an agent with network shared, exec cannot open a TCP connection to 127.0.0.1', /connect:(ECONNREFUSED|ENETUNREACH|EACCES|EPERM)/.test(r.stdout) && !r.stdout.includes('connected'), r.stdout);
  check('exec writes land in the tree, and so in the diff', (() => {
    const d = captureCandidate(ws);
    return 'files' in d && d.files.some((f) => f.path === 'exec-wrote.txt');
  })());
  check('its output is captured as artifacts', r.artifacts.length === 2 && artifacts.get(r.artifacts[0]).toString().includes('connect:'));
  const refused = await runExec(attemptOf(), { tree: ws.tree, out, command: ['node', 'probe.js'], profile: live }).then(() => 'ran', (e: Error) => e.message);
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

/** A mock agent that speaks MCP through the shim its config names, and prints the replies. */
const mcpMock = path.join(tmp, 'mock-mcp.cjs');
fs.writeFileSync(mcpMock, `'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).mcpServers.daylight;
const plan = JSON.parse(process.argv[3]);
const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const replies = {};
let buf = '';
const send = (m) => child.stdin.write(JSON.stringify(m) + '\\n');
const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ...plan.calls.map((c, i) => ({ jsonrpc: '2.0', id: 3 + i, method: 'tools/call', params: c })),
];
const want = msgs.filter((m) => m.id !== undefined).length;
let next = 0;
const pump = () => { while (next < msgs.length) { const m = msgs[next++]; send(m); if (m.id !== undefined) break; } };
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const m = JSON.parse(line);
    if (m.id !== undefined) { replies[m.id] = m; pump(); }
    if (Object.keys(replies).length === want) { process.stdout.write(JSON.stringify(replies)); process.exit(0); }
  }
});
child.on('exit', (code) => { process.stdout.write(JSON.stringify({ shimExit: code, replies })); process.exit(0); });
pump();
setTimeout(() => { process.stdout.write(JSON.stringify({ timeout: true, replies })); process.exit(0); }, 15000).unref();
`);

async function viaSocket(o: {
  attempt: Attempt; token: string; serve: () => McpServer; plan: unknown; launcher: (mcp: { socket: string; token: string }) => ReturnType<typeof authorLauncher>; tree: string;
}) {
  const rt = mcpRuntimeDir({ out, home });
  const refused: string[] = [];
  const sock = await listenAttemptSocket({
    socketPath: rt.socket, attemptId: o.attempt.id, resolve: (t) => store.attemptByMcpToken(t), serve: o.serve, onRefused: (w) => refused.push(w),
  });
  const r = await runAgent({ name: 'mock', bin: nodeBinary(), perInvocationMcp: true, argv: (run) => [mcpMock, run.mcpConfigPath, run.prompt] }, {
    prompt: JSON.stringify(o.plan), cwd: o.tree, mcpConfigPath: MCP_CONFIG, session: 's', timeoutMs: 30_000,
    launch: o.launcher({ socket: rt.socket, token: o.token }),
  });
  await sock.close();
  rt.dispose();
  let replies: Record<string, any> = {};
  try {
    replies = JSON.parse(r.stdout);
  } catch {
    replies = { raw: r.stdout, stderr: r.stderr };
  }
  return { replies, refused, accepted: sock.accepted(), r };
}

section('a mock reviewer under the review profile cannot write');
{
  const r = await runAgent(authorAdapter, {
    prompt: JSON.stringify({
      writes: [['/work/src/add.js', 'x'], ['/work/.git/x', 'x'], ['/work/new.txt', 'x'], ['/x', 'x'], ['/tmp/ok', 'x']],
      reads: [path.join(out, 'daylight.db'), '/work/src/add.js'], lists: ['/work/.git'],
    }),
    cwd: repo, mcpConfigPath: MCP_CONFIG, session: 's', timeoutMs: 20_000,
    launch: reviewLauncher({ attempt: reviewAttempt, repo, mounts: authorMounts, out, profile: live }),
  });
  const res = JSON.parse(r.stdout || '{}') as Record<string, Record<string, unknown>>;
  check('/work is read-only', res.writes?.['/work/src/add.js'] === 'EROFS' && res.writes?.['/work/new.txt'] === 'EROFS', JSON.stringify(res.writes));
  check('the repo\'s .git is an empty read-only directory', JSON.stringify(res.lists?.['/work/.git']) === '[]' && res.writes?.['/work/.git/x'] === 'EROFS');
  check('the root is read-only and only /tmp is writable', res.writes?.['/x'] === 'EROFS' && res.writes?.['/tmp/ok'] === 'ok');
  check('the repo is readable', String(res.reads?.['/work/src/add.js']).includes('a + b'));
  check('<out> is absent', res.reads?.[path.join(out, 'daylight.db')] === 'ENOENT');
  check('the real checkout is untouched', git(['status', '--porcelain']) === '');
}

section('a mock reviewer under the review profile reaches its MCP server only through the socket');
{
  const reviewOut = path.join(tmp, 'review-out');
  execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'cli.ts'), 'map', repo, '--out', reviewOut, '--top', '0'], { stdio: 'ignore' });
  const claimSession = reviewAttempt.sessionId!;
  const { replies, accepted, r } = await viaSocket({
    attempt: reviewAttempt, token: reviewToken, tree: repo,
    serve: () => createServer({ dir: reviewOut, session: claimSession, agentTool: 'mock' }).server,
    plan: { calls: [{ name: 'submit_claim', arguments: {
      subject: 'src/add.js', predicate: 'purpose', value: 'adds two numbers', confidence: 0.8,
      evidence: [{ file: 'src/add.js', line: 1 }],
    } }] },
    launcher: (mcp) => reviewLauncher({ attempt: reviewAttempt, repo, mounts: [mcpMock], mcp, out: reviewOut, profile: live }),
  });
  check('the reviewer\'s connection was accepted', accepted === 1, JSON.stringify(replies).slice(0, 300) + r.stderr.slice(0, 300));
  check('it listed the review tools', JSON.stringify(replies['2'] ?? {}).includes('submit_claim'));
  check('its claim was accepted over the socket', JSON.stringify(replies['3'] ?? {}).includes('accepted'), JSON.stringify(replies['3']));
  const claims = new ClaimStore(path.join(reviewOut, 'claims.db'));
  const mine = claims.claimsFor('src/add.js', 'purpose');
  check('and landed in <out>\'s claim store, which the sandbox never saw', mine.some((c) => c.source.kind === 'agent' && c.source.sessionId === claimSession));
}

section('a mock author with exec calls run through the socket');
{
  const ws = createWorkspace(repo, commit);
  fs.writeFileSync(path.join(ws.tree, 'net.js'), `
const s = require('node:net').connect(${port}, '127.0.0.1');
s.on('connect', () => { console.log('reached'); s.destroy(); });
s.on('error', (e) => console.log('blocked:' + e.code));
`);
  const ran: string[][] = [];
  const { replies, accepted } = await viaSocket({
    attempt: execAttempt, token: authorToken, tree: ws.tree,
    serve: () => authorServer({ attempt: execAttempt, tree: ws.tree, out, profile: live, onRun: (_r, c) => ran.push(c) }),
    plan: { calls: [{ name: 'run', arguments: { argv: ['node', 'net.js'] } }] },
    launcher: (mcp) => authorLauncher({ attempt: execAttempt, workspace: ws, mounts: [mcpMock], mcp, out, profile: live }),
  });
  const text = JSON.stringify(replies['3'] ?? {});
  check('the author\'s connection was accepted', accepted === 1, JSON.stringify(replies).slice(0, 400));
  check('run is offered to an author whose row holds exec', JSON.stringify(replies['2'] ?? {}).includes('"run"'));
  check('the host ran the command in the exec sandbox', ran.length === 1 && text.includes('exitCode'), text);
  check('which had no network although the author has network shared', text.includes('blocked:') && !text.includes('reached'), text);
  ws.dispose();
}

section('a mock author presenting another attempt\'s token is refused by the server');
{
  const ws = createWorkspace(repo, commit);
  const { replies, accepted, refused } = await viaSocket({
    attempt: execAttempt, token: reviewToken, tree: ws.tree,
    serve: () => authorServer({ attempt: execAttempt, tree: ws.tree, out, profile: live }),
    plan: { calls: [{ name: 'run', arguments: { argv: ['node', '-v'] } }] },
    launcher: (mcp) => authorLauncher({ attempt: execAttempt, workspace: ws, mounts: [mcpMock], mcp, out, profile: live }),
  });
  check('the connection is dropped before any MCP is served', accepted === 0 && refused.length === 1 && !replies['1'], JSON.stringify(replies).slice(0, 300));
  check('nothing ran', !JSON.stringify(replies).includes('exitCode'));
  ws.dispose();
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

listener.close();
done();
