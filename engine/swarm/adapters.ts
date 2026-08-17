import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Agent CLI adapters — the control plane.
 *
 * Flags here were verified against the installed binaries, not recalled. Two facts
 * shape the design:
 *
 *  - Only `claude` (--mcp-config) and `codex` (-c overrides) can point at an MCP server
 *    per invocation. `grok` and `opencode` register servers persistently via their own
 *    `mcp add` subcommand, which mutates the user's config. We never do that silently;
 *    `registrationHint()` prints the command for the user to run.
 *  - Every adapter runs read-only. The harness never passes --dangerously-*,
 *    --always-approve or --auto. Repo access is read; graph access is via MCP only.
 */

export interface AgentRun {
  prompt: string;
  /** Repo root the agent may read. */
  cwd: string;
  /** Path to an MCP config JSON, for adapters that take one per invocation. */
  mcpConfigPath: string;
  session: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
}

export interface AgentResult {
  tool: string;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface Adapter {
  name: string;
  bin: string;
  /** True when this adapter can be pointed at our MCP server without touching user config. */
  perInvocationMcp: boolean;
  argv(run: AgentRun): string[];
  registrationHint?(mcpConfigPath: string, serverCmd: string[]): string;
}

export const CLAUDE: Adapter = {
  name: 'claude',
  bin: 'claude',
  perInvocationMcp: true,
  argv: (run) => [
    '-p', run.prompt,
    // Streaming, not buffered. `json` withholds everything until the process exits, so a
    // ten-minute run shows no output at all and reads as a hang — and cost only lands at
    // the end, which is exactly when it is too late to react to.
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--mcp-config', run.mcpConfigPath,
    '--strict-mcp-config',
    // Read-only allow-list. Anything else fails closed in non-interactive mode.
    '--allowedTools',
    'Read Grep Glob mcp__vds__get_overview mcp__vds__get_slice mcp__vds__get_open_questions ' +
      'mcp__vds__get_focus_state mcp__vds__submit_claim mcp__vds__flag_contradiction ' +
      'mcp__vds__propose_cluster mcp__vds__propose_elision mcp__vds__defend_node ' +
      'mcp__vds__propose_invariant',
    ...(run.model ? ['--model', run.model] : []),
    ...(run.maxTurns ? ['--max-turns', String(run.maxTurns)] : []),
  ],
};

export const CODEX: Adapter = {
  name: 'codex',
  bin: 'codex',
  perInvocationMcp: true,
  argv: (run) => {
    // codex takes MCP servers as dotted TOML config overrides rather than a config file.
    const cfg = JSON.parse(fs.readFileSync(run.mcpConfigPath, 'utf8'));
    const vds = cfg.mcpServers.vds;
    return [
      'exec', run.prompt,
      '--json',
      '-s', 'read-only',
      '-C', run.cwd,
      '--skip-git-repo-check',
      '-c', `mcp_servers.vds.command=${JSON.stringify(vds.command)}`,
      '-c', `mcp_servers.vds.args=${JSON.stringify(vds.args)}`,
      // TOML inline table, not JSON — codex parses these values as TOML.
      '-c',
      `mcp_servers.vds.env={${Object.entries(vds.env as Record<string, string>)
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join(', ')}}`,
      ...(run.model ? ['-m', run.model] : []),
    ];
  },
};

export const GROK: Adapter = {
  name: 'grok',
  bin: 'grok',
  perInvocationMcp: false,
  argv: (run) => [
    '-p', run.prompt,
    // Streaming, not buffered. `json` withholds everything until the process exits, so a
    // ten-minute run shows no output at all and reads as a hang — and cost only lands at
    // the end, which is exactly when it is too late to react to.
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--cwd', run.cwd,
    // Allow-list of built-in tools; omit every write tool.
    '--tools', 'read,grep,glob,ls',
    ...(run.model ? ['--model', run.model] : []),
    ...(run.maxTurns ? ['--max-turns', String(run.maxTurns)] : []),
  ],
  registrationHint: (_cfg, cmd) =>
    `grok mcp add vds -- ${cmd.join(' ')}`,
};

export const OPENCODE: Adapter = {
  name: 'opencode',
  bin: 'opencode',
  perInvocationMcp: false,
  argv: (run) => [
    'run', run.prompt,
    '--format', 'json',
    '--dir', run.cwd,
    ...(run.model ? ['--model', run.model] : []),
  ],
  registrationHint: (_cfg, cmd) => `opencode mcp add vds -- ${cmd.join(' ')}`,
};

export const ADAPTERS: Record<string, Adapter> = {
  claude: CLAUDE,
  codex: CODEX,
  grok: GROK,
  opencode: OPENCODE,
};

export function available(adapter: Adapter): boolean {
  try {
    // No shell: the binary name is ours, but keeping the shell out avoids the whole class.
    execFileSync('which', [adapter.bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function run(adapter: Adapter, options: AgentRun): Promise<AgentResult> {
  const started = Date.now();
  const argv = adapter.argv(options);

  return new Promise((resolve) => {
    const child = spawn(adapter.bin, argv, {
      cwd: options.cwd,
      env: { ...process.env, VDS_SESSION: options.session },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs ?? 300_000);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        tool: adapter.name,
        ok: exitCode === 0 && !timedOut,
        exitCode, signal,
        stdout, stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        tool: adapter.name, ok: false, exitCode: null, signal: null,
        stdout, stderr: String(err), durationMs: Date.now() - started, timedOut,
      });
    });
  });
}

/** The MCP config claude/codex accept, pointing at our stdio server. */
export function mcpConfig(serverCmd: string[], dir: string, agentTool: string, model?: string) {
  return {
    mcpServers: {
      vds: {
        command: serverCmd[0],
        args: serverCmd.slice(1),
        // The model matters for provenance: two runs of the same CLI on different models
        // are independent sources for the belief calculus, and must be distinguishable.
        env: { VDS_DIR: dir, VDS_AGENT: agentTool, ...(model ? { VDS_MODEL: model } : {}) },
      },
    },
  };
}
