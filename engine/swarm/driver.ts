import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaimStore } from '../store/claims.ts';
import { ADAPTERS, available, mcpConfig, run, type Adapter, type AgentResult } from './adapters.ts';
import { converged, frontier, type FrontierItem } from './frontier.ts';
import { buildStack } from '../focus/stack.ts';
import type { Graph } from '../graph/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(HERE, '../mcp/server.ts');

/** Command that starts our stdio MCP server. */
export const serverCommand = (): string[] => [process.execPath, SERVER_ENTRY];

export type DriveMode = 'explore' | 'focus';

export interface DriveOptions {
  dir: string;
  repo: string;
  tools: string[];
  /** How many frontier items to hand each agent. */
  batch?: number;
  timeoutMs?: number;
  model?: string;
  dryRun?: boolean;
  mode?: DriveMode;
  /** Ties every event this run emits back to the job that started it. */
  session?: string;
  /** Refuse to start another agent once the run has spent this much. */
  maxCost?: number;
  /** How many agents may run at once. Sequential by default. */
  concurrency?: number;
}

const SYSTEM_RULES = `
You are mapping a codebase for a static-analysis harness. You are READ-ONLY: never edit,
create or delete any file, and never run commands that mutate state.

Your output is not a message to a human. The ONLY thing that counts is the tool calls you
make against the "vds" MCP server. Text you print is discarded.

Hard rules:
1. EVERY claim needs evidence: the file, and the line number where you can give one. A claim
   without evidence is rejected at the boundary, so an unevidenced answer is a wasted turn.
2. Never assert something you did not read. If you cannot verify it, say so by giving lower
   confidence, or skip it. Do not guess to fill the batch.
3. A "purpose" is what a module is FOR, in one sentence of intent. It is not a list of the
   files or functions it contains.
4. If you find that an existing claim is wrong, use flag_contradiction with counter-evidence
   rather than silently submitting a competing claim.

Start with get_overview, then get_open_questions, then pull get_slice for what you work on.
`.trim();

const FOCUS_RULES = `
You are focusing a codebase map. You are READ-ONLY: never edit, create or delete any file.

Your output is not a message to a human. The ONLY thing that counts is the tool calls you
make against the "vds" MCP server. Text you print is discarded.

The job is NOT to describe everything. It is to make the map SMALLER and TRUER. An
exhaustive map asserts that every file matters equally, which is false. Intent is only
visible at the right altitude.

Do this:
1. get_overview and get_focus_state to see the current L1 path groups.
2. propose_cluster for each real subsystem. A cluster needs a NAME and a PURPOSE — what it
   is FOR, in one sentence of intent. Directory names are filing decisions, not intent; if
   your cluster is just a folder renamed, you have not done the work. Cite evidence.
3. propose_elision where an L2 cluster should collapse further at L3 (target ~8-12 nodes
   for the architecture level). Give the reason.
4. defend_node for anything that MUST survive collapsing because it is load-bearing —
   a capability root, a trust boundary, a single-consumer invariant. Over-collapse and
   under-collapse are both failures, so argue this side too.

Rules:
- Evidence is REQUIRED on clusters. Unevidenced calls are rejected at the boundary.
- Never invent a subsystem you did not read. Pull get_slice for the groups you cluster.
- Prefer fewer nodes. Constants and file counts belong nowhere near a cluster name.
`.trim();

export function buildFocusPrompt(
  groups: Array<{ id: string; files: number }>,
  patterns: Array<{ key: string; members: string[] }> = [],
): string {
  const lines = [FOCUS_RULES, '', 'Current L1 path groups (these are what you are focusing):', ''];
  for (const g of groups) lines.push(`  ${g.id}  (${g.files} files)`);

  if (patterns.length) {
    // Oversized detector groups are evidence of a shared *role* rather than copy-paste —
    // which is precisely a hint about what belongs together. They were computed and
    // documented as input to clustering, and nothing consumed them until now.
    lines.push('', 'Shared roles detected across files (a hint at what belongs together —');
    lines.push('these repeat because they play the same part, not because anyone copy-pasted):');
    lines.push('');
    for (const p of patterns.slice(0, 12)) {
      const where = [...new Set(p.members.map((m) => m.split('#')[0]))];
      lines.push(`  ${p.key} — ${p.members.length} across ${where.length} file(s)`);
    }
  }

  lines.push('');
  lines.push(
    'Propose the L2 subsystems and the L3 elisions. Aim for an architecture level a person ' +
      'could hold in their head — roughly 8-12 nodes — without eliding anything load-bearing.',
  );
  return lines.join('\n');
}

export function buildPrompt(items: FrontierItem[]): string {
  const lines = [SYSTEM_RULES, '', 'Your assigned frontier items:', ''];
  items.forEach((item, i) => {
    lines.push(`${i + 1}. [${item.kind}] ${item.subject}`);
    lines.push(`   ${item.question}`);
    lines.push(`   (why now: ${item.why}; score ${item.score.toFixed(3)})`);
    lines.push('');
  });
  lines.push(
    'Work through them in order. Submit a claim (or a cluster/elision/defence) for each one ' +
      'you can evidence. Stop when you run out of things you can actually verify.',
  );
  return lines.join('\n');
}

export interface DriveReport {
  assigned: FrontierItem[];
  prompt: string;
  results: AgentResult[];
  claimsBefore: number;
  claimsAfter: number;
  statsBefore: ReturnType<ClaimStore['stats']>;
  statsAfter: ReturnType<ClaimStore['stats']>;
  unavailable: string[];
  registrationHints: string[];
  /** Frontier items skipped because another live session holds them. */
  skippedLeased: number;
  /** True when nothing left is worth an agent's time. */
  converged: boolean;
  /** Adapters not launched because the run had spent its ceiling. */
  budgetStops: string[];
}

export async function drive(options: DriveOptions): Promise<DriveReport> {
  // Focus runs are long by nature: the agent reads many slices before it can defend a
  // collapse. The first focus run died at 300s mid-flight, so the default is higher here.
  const defaultTimeout = options.mode === 'focus' ? 900_000 : 300_000;
  const { dir, repo, tools, batch = 5, timeoutMs = defaultTimeout, model, dryRun } = options;

  const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8')) as Graph;
  const readJson = (name: string) => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const findings = readJson('findings.json');
  const structure = readJson('structure.json');

  const store = new ClaimStore(path.join(dir, 'claims.db'));
  const statsBefore = store.stats();
  const claimsBefore = statsBefore.claims;
  // The prompt carries frontier items directly, bypassing get_open_questions — so it has
  // to respect and take leases too, or two launches collide before either agent starts.
  const session = options.session ?? `vds-${Date.now()}`;
  const taken = store.leasedElsewhere(session);
  const assigned =
    options.mode === 'focus'
      ? []
      : frontier(graph, store, findings, structure)
          .filter((item) => !taken.has(item.subject))
          .slice(0, batch);
  if (assigned.length) store.lease(assigned.map((a) => a.subject), session);

  let prompt: string;
  if (options.mode === 'focus') {
    const stack = buildStack(graph, store, undefined);
    prompt = buildFocusPrompt(
      stack.levels[0].nodes.map((n) => ({ id: n.id, files: n.fileCount })),
      (findings as { patterns?: Array<{ key: string; members: string[] }> }).patterns ?? [],
    );
  } else {
    prompt = buildPrompt(assigned);
  }

  const cmd = serverCommand();
  const cfgPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(cfgPath, JSON.stringify(mcpConfig(cmd, dir, 'multi', model, options.session), null, 2));

  const results: AgentResult[] = [];
  const unavailable: string[] = [];
  const registrationHints: string[] = [];
  const budgetStops: string[] = [];

  const runnable: Adapter[] = [];
  for (const name of tools) {
    const adapter = ADAPTERS[name];
    if (!adapter) {
      unavailable.push(`${name} (no adapter)`);
      continue;
    }
    if (!available(adapter)) {
      unavailable.push(`${name} (not installed)`);
      continue;
    }
    if (!adapter.perInvocationMcp && adapter.registrationHint) {
      // We never mutate the user's agent config. Surface the command instead.
      registrationHints.push(adapter.registrationHint(cfgPath, cmd));
    }
    runnable.push(adapter);
  }

  if (!dryRun && runnable.length) {
    let spent = 0;
    const launch = (adapter: Adapter) =>
      run(adapter, {
        prompt,
        cwd: repo,
        mcpConfigPath: cfgPath,
        session: options.session
          ? `${options.session}:${adapter.name}`
          : `vds-${adapter.name}-${claimsBefore}`,
        model,
        timeoutMs,
        maxTurns: 40,
        maxCost: options.maxCost ? Math.max(0, options.maxCost - spent) : undefined,
      });

    const limit = Math.max(1, options.concurrency ?? 1);
    const queue = [...runnable];

    while (queue.length) {
      // The ceiling is enforced *between* launches as well as during one, because most CLIs
      // only report cost when they finish — by which point a mid-run kill is moot.
      if (options.maxCost && spent >= options.maxCost) {
        budgetStops.push(
          `stopped before ${queue.map((a) => a.name).join(', ')}: ` +
            `spent $${spent.toFixed(2)} of $${options.maxCost.toFixed(2)}`,
        );
        break;
      }
      const batch = queue.splice(0, limit);
      const done = await Promise.all(batch.map(launch));
      for (const r of done) {
        results.push(r);
        spent += r.cost;
      }
    }
  }

  const statsAfter = store.stats();
  const claimsAfter = statsAfter.claims;
  store.close();

  return {
    assigned, prompt, results, claimsBefore, claimsAfter,
    statsBefore, statsAfter, unavailable, registrationHints,
    skippedLeased: taken.size,
    budgetStops,
    converged: options.mode !== 'focus' && converged(assigned),
  };
}
