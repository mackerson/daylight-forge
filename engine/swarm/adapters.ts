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
  /** Kill the run if reported spend passes this. See the caveat in `run()`. */
  maxCost?: number;
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
  /** Spend the CLI reported, when it reports any. */
  cost: number;
  turns: number;
  /** True when we killed it for passing the cost ceiling. */
  overBudget: boolean;
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

/**
 * codex works headlessly against our MCP server. It did not used to, and the reason was
 * ours.
 *
 * Every call came back `user cancelled MCP tool call` — with no user, and with no approval
 * prompt reachable in `exec`. It read as a codex limitation and was documented as one. It
 * was not: our tools carried no MCP `annotations`, so a non-interactive host had nothing to
 * decide from and defaulted to refusing. Declaring `readOnlyHint` on the reads and
 * `destructiveHint: false` on the writes is enough — codex then completes both, under its
 * default approval policy, inside the `read-only` sandbox, with no `--dangerously-*` flag.
 *
 * Verified end to end: `get_overview` returns, and a `submit_claim` lands in the store with
 * `source_tool = codex`. Setting `approval_policy = "never"` was tried and is *not* needed,
 * so it is not set — it would also stop codex asking about shell commands, which is a
 * weakening we get nothing for.
 *
 * The lesson generalises past codex: a host can only be as permissive as our metadata lets
 * it be, and "the other tool is broken" was a claim we had not evidenced.
 */
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

/** Flags verified against the installed binary; only the MCP registration is untested. */
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

/**
 * Flags verified against the installed binary. Its JSON reports per-message `cost`, which
 * `readSpend` accumulates rather than maxing — the opposite of claude's running total.
 */
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

/**
 * Spend as each CLI reports it.
 *
 * Adapter-specific by necessity: cost never crosses the MCP boundary, it is only ever in the
 * CLI's own output. Tolerant by design — an adapter that reports nothing yields zero rather
 * than breaking the run, and the between-runs ceiling still applies.
 */
export function readSpend(text: string): { cost: number; turns: number } {
  let cost = 0;
  let turns = 0;
  const take = (re: RegExp, onto: (n: number) => void) => {
    for (const m of text.matchAll(re)) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) onto(v);
    }
  };
  // claude
  take(/"total_cost_usd"\s*:\s*([0-9.]+)/g, (v) => (cost = Math.max(cost, v)));
  take(/"num_turns"\s*:\s*([0-9]+)/g, (v) => (turns = Math.max(turns, v)));
  // codex / generic: a cumulative usd figure under any of the usual names
  take(/"(?:cost_usd|total_cost|usd)"\s*:\s*([0-9.]+)/g, (v) => (cost = Math.max(cost, v)));
  // opencode reports per-message cost, so those accumulate rather than take a max
  let summed = 0;
  take(/"cost"\s*:\s*([0-9.]+)/g, (v) => (summed += v));
  if (summed > cost) cost = summed;
  return { cost, turns };
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
    let overBudget = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs ?? 300_000);

    child.stdout.on('data', (d) => {
      stdout += d;
      // Mid-run enforcement only works when the CLI reports cost as it goes. When it only
      // reports at the end, the between-runs ceiling in the driver is what actually holds.
      if (options.maxCost && !overBudget && readSpend(stdout).cost > options.maxCost) {
        overBudget = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      }
    });
    child.stderr.on('data', (d) => (stderr += d));

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const spend = readSpend(stdout);
      resolve({
        tool: adapter.name,
        ok: exitCode === 0 && !timedOut && !overBudget,
        exitCode, signal,
        stdout, stderr,
        durationMs: Date.now() - started,
        timedOut, overBudget,
        ...spend,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        tool: adapter.name, ok: false, exitCode: null, signal: null,
        stdout, stderr: String(err), durationMs: Date.now() - started,
        timedOut, overBudget, cost: 0, turns: 0,
      });
    });
  });
}

/** The MCP config claude/codex accept, pointing at our stdio server. */
export function mcpConfig(
  serverCmd: string[], dir: string, agentTool: string, model?: string, session?: string,
) {
  return {
    mcpServers: {
      vds: {
        command: serverCmd[0],
        args: serverCmd.slice(1),
        // The model matters for provenance: two runs of the same CLI on different models
        // are independent sources for the belief calculus, and must be distinguishable.
        env: {
          VDS_DIR: dir, VDS_AGENT: agentTool,
          ...(model ? { VDS_MODEL: model } : {}),
          ...(session ? { VDS_SESSION: session } : {}),
        },
      },
    },
  };
}
