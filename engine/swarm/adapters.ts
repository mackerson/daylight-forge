import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { normalize, providerOf } from './normalize.ts';
import type { AdapterStatus, AgentSpec, Probe } from './types.ts';

export type { AdapterStatus, AgentSpec, Probe } from './types.ts';

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
  /**
   * Called whenever the CLI's reported spend or turn count moves.
   *
   * The harness buffers each agent's stdout rather than forwarding it, which is right — the
   * streams of three concurrent agents interleaved into one pipe are unreadable. But it
   * meant nothing downstream ever saw a cost until the whole run ended, so the app's live
   * spend meter watched for JSON that by construction never reached it. This is the seam
   * that carries the number out without the noise.
   */
  onProgress?: (spend: { cost: number; turns: number }) => void;
  /**
   * Called with every chunk of the child's output, as it arrives.
   *
   * The buffered `stdout`/`stderr` on the result stay — they are what every existing caller
   * reads — but a buffer only exists once the run is over, and a mission wants to show an
   * agent's console while it is still running and keep the whole stream as an artifact
   * afterwards without this module deciding where artifacts live. The seam carries bytes
   * out; what to do with them is the caller's.
   */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /**
   * How the agent is launched inside a sandbox profile (R11.3). Given the adapter's binary and
   * argv, returns what to actually spawn: the launcher, its argv, its whole environment and the
   * bytes to feed its fds 3 and up. Without it the agent runs as P0 reviewers always have.
   */
  launch?: Launcher;
  /**
   * The built-in and MCP tools this role may use, for adapters that take an allowlist (D-2).
   * Absent: the read-only reviewer list.
   */
  allowedTools?: string[];
}

export interface Launch {
  bin: string;
  /** `argv[0]` is the process name; the rest are its arguments. */
  argv: string[];
  env: Record<string, string>;
  feeds?: Buffer[];
}

export type Launcher = (bin: string, argv: string[]) => Launch;

export interface AgentResult {
  tool: string;
  /** The model this run was pinned to, if any. Half of the provenance key. */
  model?: string;
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
  /**
   * Ask the installed binary what it can do, for adapters that have a way to answer.
   *
   * Model ids are not ours to remember. They change under us, they differ per account, and
   * a list compiled from memory is exactly the kind of unevidenced claim this tool rejects
   * everywhere else. Where the CLI can be asked, ask it; where it cannot, say so rather
   * than filling the gap in.
   */
  probe?(): Probe;
}

/**
 * Run a CLI's own introspection subcommand. Never allowed to break the caller.
 *
 * Both streams, whatever the exit code. grok exits zero, prints its model list on stdout and
 * says "You are not authenticated" on stderr — read only one of them and the launcher offers
 * a tool that is going to fail several minutes into a paid run.
 */
function ask(bin: string, args: string[], timeout = 15_000): string {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
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
    run.allowedTools?.join(' ') ??
      'Read Grep Glob mcp__daylight__get_overview mcp__daylight__get_slice mcp__daylight__get_open_questions ' +
      'mcp__daylight__get_focus_state mcp__daylight__submit_claim mcp__daylight__flag_contradiction ' +
      'mcp__daylight__propose_cluster mcp__daylight__propose_elision mcp__daylight__defend_node ' +
      'mcp__daylight__propose_invariant',
    ...(run.model ? ['--model', run.model] : []),
    ...(run.maxTurns ? ['--max-turns', String(run.maxTurns)] : []),
  ],
  probe: () => {
    // claude has no `models` subcommand, but its own --help names the aliases it accepts.
    // Parsed from the binary rather than recalled, so it tracks whatever is installed.
    const help = ask('claude', ['--help']);
    const line = help.match(/--model <model>[\s\S]{0,400}/)?.[0] ?? '';
    const models = [...line.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
    return models.length
      ? { models: [...new Set(models)], source: 'documented' }
      : { models: [], source: 'unknown' };
  },
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
    const server = cfg.mcpServers.daylight;
    return [
      'exec', run.prompt,
      '--json',
      '-s', 'read-only',
      '-C', run.cwd,
      '--skip-git-repo-check',
      '-c', `mcp_servers.daylight.command=${JSON.stringify(server.command)}`,
      '-c', `mcp_servers.daylight.args=${JSON.stringify(server.args)}`,
      // TOML inline table, not JSON — codex parses these values as TOML.
      '-c',
      `mcp_servers.daylight.env={${Object.entries(server.env as Record<string, string>)
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
    `grok mcp add daylight -- ${cmd.join(' ')}`,
  probe: () => {
    const out = ask('grok', ['models']);
    const models = [...out.matchAll(/^\s*[*-]\s+(\S+)/gm)].map((m) => m[1]);
    // Installed is not the same as usable. An unauthenticated binary fails a whole run
    // several minutes in, which is the most expensive place to find out.
    const note = /not authenticated|not logged in/i.test(out)
      ? 'installed but not authenticated — run `grok login`'
      : undefined;
    return { models, source: models.length ? 'listed' : 'unknown', note };
  },
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
  registrationHint: (_cfg, cmd) => `opencode mcp add daylight -- ${cmd.join(' ')}`,
  probe: () => {
    const models = ask('opencode', ['models'])
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[a-z0-9-]+\/\S+$/.test(l));
    return { models, source: models.length ? 'listed' : 'unknown' };
  },
};

export const ADAPTERS: Record<string, Adapter> = {
  claude: CLAUDE,
  codex: CODEX,
  grok: GROK,
  opencode: OPENCODE,
};

/** `claude` or `claude:sonnet`. Split on the first colon only — model ids contain slashes. */
export function parseSpec(entry: string, defaultModel?: string): AgentSpec {
  const at = entry.indexOf(':');
  if (at < 0) return { tool: entry.trim(), model: defaultModel };
  return { tool: entry.slice(0, at).trim(), model: entry.slice(at + 1).trim() || defaultModel };
}

/** How the pair is written wherever one string is needed: a filename, a session, a label. */
export const specKey = (s: AgentSpec): string => `${s.tool}:${s.model ?? 'default'}`;

/**
 * Distinct provenance keys in a roster.
 *
 * A run of one source cannot corroborate anything it claims, however many agents are in it —
 * every belief it produces tops out at INFERRED and the frontier keeps residual uncertainty
 * on all of them forever. Worth saying before the money is spent, not after.
 */
export const sourceDiversity = (roster: AgentSpec[]): number =>
  new Set(roster.map(specKey)).size;

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
 * Survey the installed agent CLIs.
 *
 * The launcher offered `claude` and nothing else because nothing ever asked what was on the
 * machine. Everything here is measured at call time: whether the binary exists, what models
 * it says it has, and whether it is going to refuse the moment it is handed real work.
 */
export function inspect(
  serverCmd: string[],
  cfgPath = '<out>/mcp.json',
  { probe: shouldProbe = false }: { probe?: boolean } = {},
): AdapterStatus[] {
  return Object.values(ADAPTERS).map((adapter) => {
    const installed = available(adapter);
    // Probing executes the provider's own binary. Only on request: a listing must be safe to ask for.
    const probe = shouldProbe && installed && adapter.probe ? adapter.probe() : undefined;
    return {
      name: adapter.name,
      bin: adapter.bin,
      installed,
      perInvocationMcp: adapter.perInvocationMcp,
      models: probe?.models ?? [],
      modelSource: probe?.source ?? 'unknown',
      probed: shouldProbe,
      note: probe?.note,
      registrationHint:
        !adapter.perInvocationMcp && adapter.registrationHint
          ? adapter.registrationHint(cfgPath, serverCmd)
          : undefined,
    };
  });
}

/**
 * Spend as each CLI reports it.
 *
 * Adapter-specific by necessity: cost never crosses the MCP boundary, it is only ever in the
 * CLI's own output. Tolerant by design — an adapter that reports nothing yields zero rather
 * than breaking the run, and the between-runs ceiling still applies.
 */
export function readSpend(text: string): { cost: number; turns: number } {
  return spendOf(spendParts(text));
}

interface SpendParts { total: number; generic: number; summed: number; turns: number }

/** The pieces `readSpend` combines, kept apart so a stream can be folded line by line. */
function spendParts(text: string): SpendParts {
  const parts: SpendParts = { total: 0, generic: 0, summed: 0, turns: 0 };
  const take = (re: RegExp, onto: (n: number) => void) => {
    for (const m of text.matchAll(re)) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) onto(v);
    }
  };
  // claude
  take(/"total_cost_usd"\s*:\s*([0-9.]+)/g, (v) => (parts.total = Math.max(parts.total, v)));
  take(/"num_turns"\s*:\s*([0-9]+)/g, (v) => (parts.turns = Math.max(parts.turns, v)));
  // codex / generic: a cumulative usd figure under any of the usual names
  take(/"(?:cost_usd|total_cost|usd)"\s*:\s*([0-9.]+)/g, (v) => (parts.generic = Math.max(parts.generic, v)));
  // opencode reports per-message cost, so those accumulate rather than take a max
  take(/"cost"\s*:\s*([0-9.]+)/g, (v) => (parts.summed += v));
  return parts;
}

const spendOf = (p: SpendParts) => ({ cost: Math.max(p.total, p.generic, p.summed), turns: p.turns });

/**
 * Process groups of agents this process is running.
 *
 * Each agent is its own group leader, so one signal reaches the agent and everything it
 * started. While any is live, a SIGTERM, SIGINT or SIGHUP to this process is turned into an
 * ordinary exit, and on exit every live group is killed: `daylight:stop-job` signals the CLI only,
 * and an agent left running would keep writing claims for an attempt nobody owns. `exit`
 * listeners elsewhere (the mission runner's) run on that same exit.
 */
const liveGroups = new Set<number>();
const PARENT_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Kill every agent this process started that is still running. Synchronous. */
export function killRunningAgents(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const pid of liveGroups) killGroup(pid, signal);
}

const exitOnSignal = (signal: NodeJS.Signals) => process.exit(128 + (os.constants.signals[signal] ?? 15));
const onExit = () => killRunningAgents('SIGKILL');

function track(pid: number): void {
  if (!liveGroups.size) {
    process.on('exit', onExit);
    for (const s of PARENT_SIGNALS) process.on(s, exitOnSignal);
  }
  liveGroups.add(pid);
}

function untrack(pid: number): void {
  if (!liveGroups.delete(pid) || liveGroups.size) return;
  process.off('exit', onExit);
  for (const s of PARENT_SIGNALS) process.off(s, exitOnSignal);
}

export function run(adapter: Adapter, options: AgentRun): Promise<AgentResult> {
  const started = Date.now();
  const argv = adapter.argv(options);

  // A sandboxed launch takes nothing from this process's environment: the launcher gets the
  // environment the hook names, and the agent only what the sandbox sets.
  const plan = options.launch?.(adapter.bin, argv);
  const feeds = plan?.feeds ?? [];

  return new Promise((resolve) => {
    const child = plan
      ? spawn(plan.bin, plan.argv.slice(1), {
          argv0: plan.argv[0], cwd: '/', env: plan.env,
          stdio: ['ignore', 'pipe', 'pipe', ...feeds.map(() => 'pipe' as const)],
          detached: true,
        })
      : spawn(adapter.bin, argv, {
          cwd: options.cwd,
          env: { ...process.env, DAYLIGHT_SESSION: options.session },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
    feeds.forEach((bytes, i) => {
      const fd = child.stdio[3 + i] as NodeJS.WritableStream & { on(e: 'error', f: () => void): void };
      // A launcher that dies before reading closes the pipe; its exit status says so.
      fd.on('error', () => {});
      fd.end(bytes);
    });
    if (child.pid) track(child.pid);
    const stop = (signal: NodeJS.Signals) => (child.pid ? killGroup(child.pid, signal) : child.kill(signal));

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overBudget = false;

    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), 5_000).unref();
    }, options.timeoutMs ?? 300_000);

    // Spend comes from the provider's own structured result when `normalize` knows its shape:
    // a regex over raw stdout also matches repository text an agent echoes, which could kill a
    // run over a number nobody charged. Only for a provider whose shape is unknown is the
    // regex used, folded one complete line at a time so the scan stays linear.
    const provider = providerOf(adapter.name);
    const structured = provider === 'claude' || provider === 'grok' || provider === 'codex';
    const fromProvider = { cost: 0, turns: 0 };
    const scanned: SpendParts = { total: 0, generic: 0, summed: 0, turns: 0 };
    const spendNow = () => (structured ? { ...fromProvider } : spendOf(scanned));
    const takeLine = (line: string) => {
      if (!line.trim()) return;
      if (structured) {
        for (const ev of normalize(provider, line)) {
          if (ev.name !== 'cost.reported') continue;
          if (typeof ev.payload.costUsd === 'number') fromProvider.cost = ev.payload.costUsd;
          if (typeof ev.payload.turns === 'number') fromProvider.turns = ev.payload.turns;
        }
        return;
      }
      const p = spendParts(line);
      scanned.total = Math.max(scanned.total, p.total);
      scanned.generic = Math.max(scanned.generic, p.generic);
      scanned.summed += p.summed;
      scanned.turns = Math.max(scanned.turns, p.turns);
    };
    let partial = '';

    let reported = { cost: 0, turns: 0 };
    child.stdout!.on('data', (d) => {
      stdout += d;
      options.onOutput?.('stdout', String(d));
      partial += String(d);
      const cut = partial.lastIndexOf('\n');
      if (cut < 0) return;
      for (const line of partial.slice(0, cut).split('\n')) takeLine(line);
      partial = partial.slice(cut + 1);
      const now = spendNow();
      if (now.cost !== reported.cost || now.turns !== reported.turns) {
        reported = now;
        options.onProgress?.(now);
      }
      // Mid-run enforcement only works when the CLI reports cost as it goes. When it only
      // reports at the end, the between-runs ceiling in the driver is what actually holds.
      if (options.maxCost && !overBudget && now.cost > options.maxCost) {
        overBudget = true;
        stop('SIGTERM');
        setTimeout(() => stop('SIGKILL'), 5_000).unref();
      }
    });
    child.stderr!.on('data', (d) => {
      stderr += d;
      options.onOutput?.('stderr', String(d));
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (child.pid) {
        // Whatever the agent left behind in its group goes with it.
        killGroup(child.pid, 'SIGKILL');
        untrack(child.pid);
      }
      takeLine(partial);
      partial = '';
      const spend = spendNow();
      // A CLI that only reports at the end reports here, and nowhere else.
      if (spend.cost !== reported.cost || spend.turns !== reported.turns) {
        options.onProgress?.(spend);
      }
      resolve({
        tool: adapter.name,
        model: options.model,
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
        tool: adapter.name, model: options.model, ok: false, exitCode: null, signal: null,
        stdout, stderr: String(err), durationMs: Date.now() - started,
        timedOut, overBudget, cost: 0, turns: 0,
      });
    });
  });
}

/** The MCP config claude/codex accept, pointing at our stdio server. */
export function mcpConfig(
  serverCmd: string[], dir: string, agentTool: string, model?: string, session?: string,
  /** Anything else the server should see — a mission's blind-review prefix, for one. */
  extraEnv: Record<string, string> = {},
) {
  return {
    mcpServers: {
      daylight: {
        command: serverCmd[0],
        args: serverCmd.slice(1),
        // The model matters for provenance: two runs of the same CLI on different models
        // are independent sources for the belief calculus, and must be distinguishable.
        env: {
          DAYLIGHT_DIR: dir, DAYLIGHT_AGENT: agentTool,
          ...(model ? { DAYLIGHT_MODEL: model } : {}),
          ...(session ? { DAYLIGHT_SESSION: session } : {}),
          ...extraEnv,
        },
      },
    },
  };
}
