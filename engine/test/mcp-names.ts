/**
 * MCP naming consistency. Run: node engine/test/mcp-names.ts
 *
 * The server key in `mcpConfig`, the `mcp__<key>__<tool>` allowlist claude runs under, the
 * tools the server registers and the tool names the prompts tell a reviewer to call must all
 * agree. When they drift a real reviewer gets zero tools and submits nothing, and the mock
 * adapters never notice, so this checks the names statically instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE, mcpConfig } from '../swarm/adapters.ts';
import { buildFocusPrompt, SYSTEM_RULES } from '../swarm/driver.ts';
import { FIXTURE_DIR } from '../demo/fixture.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const REPO = path.resolve(import.meta.dirname, '..', '..');

const registered = new Set(
  [...fs.readFileSync(path.join(REPO, 'engine', 'mcp', 'server.ts'), 'utf8')
    .matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]),
);
const [key] = Object.keys(mcpConfig(['node', 'server.ts'], '/tmp/out', 'mock').mcpServers);
const argv = CLAUDE.argv({ prompt: '', cwd: '/', mcpConfigPath: '/dev/null', session: 's' });
const allowArg = argv[argv.indexOf('--allowedTools') + 1] ?? '';
const allowed = [...allowArg.matchAll(/mcp__([a-z0-9]+)__([a-z_]+)/g)];
const allowedTools = new Set(allowed.map((m) => m[2]));

section('the allowlist and the server agree');
check('the server registers tools', registered.size > 0, String(registered.size));
check('the config names exactly one server, "daylight"', key === 'daylight', String(key));
check('every allowlisted MCP tool is under that server key',
  allowed.length > 0 && allowed.every((m) => m[1] === key), allowed.map((m) => m[1]).join(','));
check('every allowlisted tool is one the server registers',
  [...allowedTools].every((t) => registered.has(t)), [...allowedTools].filter((t) => !registered.has(t)).join(','));
check('every registered tool is allowlisted',
  [...registered].every((t) => allowedTools.has(t)), [...registered].filter((t) => !allowedTools.has(t)).join(','));

const prompts: Array<[string, string]> = [
  ['the fixture reviewer prompt', fs.readFileSync(path.join(FIXTURE_DIR, 'review-prompts', 'reviewer.md'), 'utf8')],
  ['the explore prompt', SYSTEM_RULES],
  ['the focus prompt', buildFocusPrompt([])],
];
const TOOLISH = /\b(?:get|submit|propose|flag|defend)_[a-z_]+\b/g;

for (const [label, text] of prompts) {
  section(label);
  const named = text.match(/"([a-z0-9-]+)" MCP server/)?.[1];
  check('names the configured MCP server', named === key, String(named));
  const tools = new Set([
    ...(text.match(TOOLISH) ?? []),
    ...[...registered].filter((t) => new RegExp(`\\b${t}\\b`).test(text)),
  ]);
  check('mentions at least one tool', tools.size > 0);
  const missing = [...tools].filter((t) => !allowedTools.has(t));
  check('every tool it names is allowlisted', missing.length === 0, missing.join(','));
}

done();
