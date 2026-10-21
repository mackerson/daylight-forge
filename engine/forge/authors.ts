import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectSandbox, nodeBinary, type SandboxProfile } from '../experiment/sandbox.ts';
import type { ArtifactStore } from '../mission/artifacts.ts';
import type { Attempt } from '../mission/types.ts';
import type { Adapter, AgentRun, Launcher } from '../swarm/adapters.ts';
import {
  execRefusal, MCP_CONFIG, MCP_SERVER_KEY, profileLaunch, registerRunTool, requireOut, SandboxRefused,
  type ExecResult, type McpEndpoint,
} from './sandbox.ts';
import type { Workspace } from './workspace.ts';
import { registerRequestDependencyTool, REQUEST_DEPENDENCY_TOOL } from './dependency-requests.ts';

/**
 * Who may author, and how an author is launched inside the `author` profile.
 *
 * Only the mock author is available. Real providers are `unavailable` for implement until the
 * owner authorises one live run (R4 Q5, R9.4); their argv is defined here so that run changes
 * one status, not the launch. The tool allowlist is a parameter (D-2): authors get the file
 * tools, the MCP `request_dependency` tool (P2-R4) and, only when their attempt row holds exec,
 * the MCP `run` tool. Never `Bash`.
 */

export const AUTHOR_FILE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit'] as const;
export const RUN_TOOL = `mcp__${MCP_SERVER_KEY}__run`;
export const REQUEST_DEPENDENCY = `mcp__${MCP_SERVER_KEY}__${REQUEST_DEPENDENCY_TOOL}`;

/** The allowlist for an author attempt. `exec` comes from the attempt row, never a request. */
export function authorTools(attempt: Pick<Attempt, 'id' | 'sandbox'>): string[] {
  return execRefusal(attempt) === null
    ? [...AUTHOR_FILE_TOOLS, REQUEST_DEPENDENCY, RUN_TOOL]
    : [...AUTHOR_FILE_TOOLS, REQUEST_DEPENDENCY];
}

export type AuthorAvailability =
  | { status: 'available'; adapter: Adapter; mounts: string[] }
  | { status: 'unavailable'; why: string };

/** What a real claude author would run. Defined, never launched until Q5 is answered. */
export function claudeAuthorArgv(run: Pick<AgentRun, 'prompt' | 'model' | 'maxTurns'> & { allowedTools: string[] }): string[] {
  return [
    '-p', run.prompt,
    '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--mcp-config', MCP_CONFIG, '--strict-mcp-config',
    '--allowedTools', run.allowedTools.join(' '),
    ...(run.model ? ['--model', run.model] : []),
    ...(run.maxTurns ? ['--max-turns', String(run.maxTurns)] : []),
  ];
}

const NOT_AUTHORISED =
  'not authorised for implement: real providers stay unavailable until the owner authorises one live author run (R4 Q5)';

/**
 * The author for a roster entry's tool. `mock` is the script `DAYLIGHT_MOCK_ADAPTER` names,
 * run with our node and handed the in-sandbox MCP config path and the prompt.
 */
export function authorFor(tool: string, env: NodeJS.ProcessEnv = process.env): AuthorAvailability {
  if (tool === 'mock') {
    const script = env.DAYLIGHT_MOCK_ADAPTER;
    if (!script || !fs.existsSync(script)) return { status: 'unavailable', why: 'DAYLIGHT_MOCK_ADAPTER names no script' };
    const real = fs.realpathSync(script);
    return {
      status: 'available',
      mounts: [real],
      adapter: { name: 'mock', bin: nodeBinary(), perInvocationMcp: true, argv: (run) => [real, run.mcpConfigPath, run.prompt] },
    };
  }
  if (tool === 'claude') return { status: 'unavailable', why: `claude: ${NOT_AUTHORISED}` };
  return { status: 'unavailable', why: `${tool}: ${NOT_AUTHORISED}` };
}

export interface AuthorLaunchInput {
  /** The attempt row as the store recorded it: its sandbox stamp is the only source of grants. */
  attempt: Pick<Attempt, 'id' | 'missionId' | 'sandbox'>;
  workspace: Pick<Workspace, 'tree'>;
  /** Host paths the agent must read, bound read-only at their own paths. */
  mounts?: string[];
  /** Of `mounts`, those under $HOME the caller allows (deny by default; credential stores never). */
  homeAllow?: string[];
  mcp?: McpEndpoint;
  env?: Record<string, string>;
  /** Required: the attempt's <out>, which every launch keeps out of its mounts. */
  out: string;
  profile?: SandboxProfile;
}

/**
 * The adapter hook (R11.3) for an author attempt: launches whatever the adapter runs inside
 * the `author` profile over the workspace tree, with the network and exec flag the attempt
 * row carries and the authorization it names. A row without a write grant gets no launch.
 */
export function authorLauncher(input: AuthorLaunchInput): Launcher {
  const s = input.attempt.sandbox;
  if (!s || s.profile !== 'author' || !s.write || !s.authorizeDecisionId) {
    throw new SandboxRefused(`attempt ${input.attempt.id} is not an authorized author attempt`);
  }
  const out = requireOut(input.out);
  const profile = input.profile ?? detectSandbox();
  const authorization = { decisionId: s.authorizeDecisionId, missionId: input.attempt.missionId };
  return (bin, argv) => profileLaunch(profile, {
    kind: 'author', root: input.workspace.tree, network: s.network, exec: s.exec, authorization,
    agent: { bin, argv, mounts: input.mounts }, env: input.env, mcp: input.mcp, out, homeAllow: input.homeAllow,
  });
}

/** The hook for a review attempt: the repository read-only, network as the row says. */
export function reviewLauncher(input: {
  attempt: Pick<Attempt, 'id' | 'sandbox'>; repo: string; mounts?: string[]; homeAllow?: string[]; mcp?: McpEndpoint;
  env?: Record<string, string>; out: string; profile?: SandboxProfile;
}): Launcher {
  const s = input.attempt.sandbox;
  if (!s || s.profile !== 'review' || s.write || s.exec) {
    throw new SandboxRefused(`attempt ${input.attempt.id} is not a read-only review attempt`);
  }
  const out = requireOut(input.out);
  const profile = input.profile ?? detectSandbox();
  return (bin, argv) => profileLaunch(profile, {
    kind: 'review', root: input.repo, network: s.network,
    agent: { bin, argv, mounts: input.mounts }, env: input.env, mcp: input.mcp, out, homeAllow: input.homeAllow,
  });
}

/**
 * The MCP server an author attempt reaches through its socket: `request_dependency` always,
 * and `run` only when the attempt row holds exec.
 */
export function authorServer(ctx: {
  attempt: Pick<Attempt, 'id' | 'missionId' | 'sandbox' | 'projectId'>; tree: string; out: string; profile?: SandboxProfile;
  artifacts?: ArtifactStore; onRun?: (r: ExecResult, command: string[]) => void;
}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_KEY, version: '0.1.0' });
  registerRequestDependencyTool(server, { attempt: ctx.attempt, out: requireOut(ctx.out) });
  if (execRefusal(ctx.attempt) === null) registerRunTool(server, ctx);
  return server;
}
