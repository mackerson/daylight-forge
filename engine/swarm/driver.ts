import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaimStore } from '../store/claims.ts';
import {
  ADAPTERS, available, mcpConfig, parseSpec, run, sourceDiversity, specKey,
  type Adapter, type AgentResult, type AgentSpec,
} from './adapters.ts';
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
  /** Roster entries, each `tool` or `tool:model`. The same tool may appear twice. */
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
  /**
   * Split the frontier between the agents instead of giving all of them the same items.
   *
   * The default is the opposite, and deliberately: handing every agent the same questions is
   * what produces a second independent answer on one subject, which is the only way a belief
   * reaches CORROBORATED or a disagreement is ever discovered. Spreading covers more ground
   * per dollar and corroborates nothing, so it is a choice with a real cost either way.
   */
  spread?: boolean;
  /**
   * Restrict the run to these subjects.
   *
   * Absent means the frontier decides, which is the right default: it ranks by uncertainty
   * x centrality and knows things a person scrolling a list does not. This exists for the
   * other direction — you looked at the map, or at the candidate list, and you want *those*
   * answered rather than whatever scored highest. Ranking still applies within the set, so a
   * scoped run is the same scheduler on a smaller pool, not a different one.
   *
   * A subject named here that the frontier has nothing to ask about is simply absent from
   * the result; a scope that matches nothing produces an empty run rather than a full one.
   */
  only?: string[];
  /**
   * Live per-source spend, as each CLI reports it.
   *
   * Per *source*, not per run: three agents in one job used to be one undifferentiated
   * number, and the app took the maximum of whatever `total_cost_usd` values it happened to
   * see — which reads a $1.01 and a $1.75 running together as a $1.75 run.
   */
  onProgress?: (p: { source: string; cost: number; turns: number }) => void;
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

5. Answer the questions you were ASSIGNED, in order. They were chosen by a scheduler that
   ranked them by uncertainty and centrality, and they are leased to you so no other agent
   duplicates the work. Wandering off to describe whatever looks interesting silently wastes
   both. If an assigned question is unanswerable from the evidence, say so with a low-
   confidence claim or skip it explicitly — do not quietly substitute a different one.
6. A question that names a verdict predicate wants THAT predicate, as a boolean, with the
   reasoning in evidence. "Is this a god node that should be split?" is answered with
   god_verdict true or false — not with a purpose claim about the same file.

Start with get_overview, then pull get_slice for what you were assigned. get_open_questions
shows the wider frontier; it is context, not a menu to pick from instead.
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

/**
 * The predicate a question is actually asking for.
 *
 * Stated explicitly because leaving it implicit did not work: agents were handed a
 * `god_verdict` question and answered with a `purpose` claim about the same file, which is
 * a different question that happens to be easier. The scheduler's ranking, its leases and
 * its convergence signal all assume the assigned question is the one that gets answered.
 */
function verdictFor(item: FrontierItem): string | null {
  switch (item.kind) {
    case 'dead': return 'liveness_verdict';
    case 'cycle': return 'cycle_verdict';
    case 'limb': return 'limb_verdict';
    case 'god': return 'god_verdict';
    case 'divergence': return 'divergence_verdict';
    case 'family': return 'duplication_verdict';
    default: return null;
  }
}

export function buildPrompt(items: FrontierItem[]): string {
  const lines = [SYSTEM_RULES, '', 'Your assigned frontier items:', ''];
  items.forEach((item, i) => {
    lines.push(`${i + 1}. [${item.kind}] ${item.subject}`);
    lines.push(`   ${item.question}`);
    lines.push(`   (why now: ${item.why}; score ${item.score.toFixed(3)})`);
    lines.push('');
  });
  const verdicts = [...new Set(items.map(verdictFor).filter(Boolean))];
  lines.push(
    'Work through them IN ORDER, and answer each one as asked. Submit a claim (or a ' +
      'cluster/elision/defence) for each you can evidence. Stop when you run out of things ' +
      'you can actually verify — but stopping early is different from answering a question ' +
      'you were not asked.',
  );
  if (verdicts.length) {
    lines.push('');
    lines.push(
      `Predicates these questions expect: ${verdicts.join(', ')}. Each takes a boolean, with ` +
        'your reasoning in the evidence.',
    );
  }
  return lines.join('\n');
}
/** One roster entry that is actually going to run, with everything resolved for it. */
export interface LaunchPlan {
  spec: AgentSpec;
  adapter: Adapter;
  /** Its own MCP config, so its own tool and model reach the claim store. */
  mcpConfigPath: string;
  session: string;
  /** The items this agent was handed. Identical across agents unless `spread` is set. */
  items: FrontierItem[];
  prompt: string;
}

export interface DriveReport {
  assigned: FrontierItem[];
  /** Kept for callers that print one prompt; identical to `plans[0].prompt` when not spread. */
  prompt: string;
  /** Exactly what would be, or was, launched — the dry-run surface. */
  plans: LaunchPlan[];
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
  /** Distinct `tool:model` keys in the roster that actually ran. */
  sourceDiversity: number;
  /**
   * Said out loud when a run cannot corroborate anything, because the failure is silent
   * otherwise: the claims land, the numbers go up, and every belief stays INFERRED.
   */
  diversityWarning?: string;
}

/** A filename-safe form of a provenance key. */
const slug = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '-');

/**
 * Resolve the roster, dropping entries we cannot run and collapsing exact duplicates.
 *
 * Two identical `tool:model` entries are not two sources — the belief calculus keys on the
 * pair, so the second one costs money and moves nothing. Dropped, and said so.
 */
export function planRoster(
  specs: AgentSpec[],
): { runnable: Array<{ spec: AgentSpec; adapter: Adapter }>; unavailable: string[] } {
  const runnable: Array<{ spec: AgentSpec; adapter: Adapter }> = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    const adapter = ADAPTERS[spec.tool];
    if (!adapter) {
      unavailable.push(`${spec.tool} (no adapter)`);
      continue;
    }
    if (!available(adapter)) {
      unavailable.push(`${specKey(spec)} (not installed)`);
      continue;
    }
    const key = specKey(spec);
    if (seen.has(key)) {
      unavailable.push(`${key} (duplicate roster entry — same source, would corroborate nothing)`);
      continue;
    }
    seen.add(key);
    runnable.push({ spec, adapter });
  }
  return { runnable, unavailable };
}

/** Deal items round-robin so every agent gets a share of the high-scoring head, not a tail. */
function deal<T>(items: T[], ways: number): T[][] {
  const out: T[][] = Array.from({ length: ways }, () => []);
  items.forEach((item, i) => out[i % ways].push(item));
  return out;
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
  const session = options.session ?? `vds-${Date.now()}`;

  const { runnable, unavailable } = planRoster(tools.map((t) => parseSpec(t, model)));

  // The prompt carries frontier items directly, bypassing get_open_questions — so it has
  // to respect and take leases too, or two launches collide before either agent starts.
  const taken = store.leasedElsewhere(session);
  // Spreading needs enough items to give every agent a full batch; corroborating needs one
  // batch that all of them answer.
  const want = options.spread ? batch * Math.max(1, runnable.length) : batch;
  // Scoping filters the ranked list rather than replacing it, so "explore these 31" still
  // asks the most valuable question about them first.
  const scope = options.only?.length ? new Set(options.only) : null;
  const assigned =
    options.mode === 'focus'
      ? []
      : frontier(graph, store, findings, structure)
          .filter((item) => !taken.has(item.subject))
          .filter((item) => !scope || scope.has(item.subject))
          .slice(0, want);
  // Nothing is reserved unless something is actually going to answer it. A dry run held 15
  // minutes of the highest-scoring work for an agent that was never going to be spawned, and
  // so did a run whose entire roster turned out to be uninstalled — both quietly starving the
  // next real run of exactly the questions worth asking.
  const willRun = !dryRun && runnable.length > 0;
  if (assigned.length && willRun) store.lease(assigned.map((a) => a.subject), session);

  const focusPrompt = () => {
    const stack = buildStack(graph, store, undefined);
    return buildFocusPrompt(
      stack.levels[0].nodes.map((n) => ({ id: n.id, files: n.fileCount })),
      (findings as { patterns?: Array<{ key: string; members: string[] }> }).patterns ?? [],
    );
  };

  const shares =
    options.mode === 'focus'
      ? runnable.map(() => [] as FrontierItem[])
      : options.spread
        ? deal(assigned, Math.max(1, runnable.length))
        : runnable.map(() => assigned);

  const cmd = serverCommand();
  const registrationHints: string[] = [];

  /**
   * One MCP config per roster entry, carrying that entry's own tool and model.
   *
   * This used to be a single file written once with the tool hardcoded to "multi", which
   * meant every claim in the store recorded the same source no matter which CLI made it.
   * The belief calculus counts independent sources as `kind:tool:model`, so a whole swarm
   * collapsed into one source: nothing could reach CORROBORATED, nothing could contradict
   * anything, and the frontier never converged. The provenance is the product.
   */
  const plans: LaunchPlan[] = runnable.map(({ spec, adapter }, i) => {
    const key = specKey(spec);
    const agentSession = `${session}:${key}`;
    const cfgPath = path.join(dir, `mcp.${slug(key)}.json`);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(mcpConfig(cmd, dir, spec.tool, spec.model, agentSession), null, 2),
    );
    if (!adapter.perInvocationMcp && adapter.registrationHint) {
      // We never mutate the user's agent config. Surface the command instead.
      registrationHints.push(adapter.registrationHint(cfgPath, cmd));
    }
    return {
      spec,
      adapter,
      mcpConfigPath: cfgPath,
      session: agentSession,
      items: shares[i],
      prompt: options.mode === 'focus' ? focusPrompt() : buildPrompt(shares[i]),
    };
  });

  const diversity = sourceDiversity(plans.map((p) => p.spec));
  const diversityWarning =
    plans.length > 0 && diversity < 2
      ? `roster has ${diversity} independent source (${plans.map((p) => specKey(p.spec)).join(', ')}). ` +
        'Corroboration counts distinct tool:model pairs, so nothing this run claims can rise ' +
        'above INFERRED and no disagreement can be discovered. Add a second tool, or the same ' +
        'tool on a different model.'
      : undefined;

  const results: AgentResult[] = [];
  const budgetStops: string[] = [];

  if (!dryRun && plans.length) {
    let spent = 0;
    const launch = (plan: LaunchPlan) =>
      run(plan.adapter, {
        prompt: plan.prompt,
        cwd: repo,
        mcpConfigPath: plan.mcpConfigPath,
        session: plan.session,
        model: plan.spec.model,
        timeoutMs,
        maxTurns: 40,
        onProgress: (sp) =>
          options.onProgress?.({ source: specKey(plan.spec), cost: sp.cost, turns: sp.turns }),
        maxCost: options.maxCost ? Math.max(0, options.maxCost - spent) : undefined,
      });

    const limit = Math.max(1, options.concurrency ?? 1);
    const queue = [...plans];

    while (queue.length) {
      // The ceiling is enforced *between* launches as well as during one, because most CLIs
      // only report cost when they finish — by which point a mid-run kill is moot.
      if (options.maxCost && spent >= options.maxCost) {
        budgetStops.push(
          `stopped before ${queue.map((p) => specKey(p.spec)).join(', ')}: ` +
            `spent $${spent.toFixed(2)} of $${options.maxCost.toFixed(2)}`,
        );
        break;
      }
      const wave = queue.splice(0, limit);
      const done = await Promise.all(wave.map(launch));
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
    assigned,
    prompt: plans[0]?.prompt ?? '',
    plans,
    results, claimsBefore, claimsAfter,
    statsBefore, statsAfter, unavailable, registrationHints,
    skippedLeased: taken.size,
    budgetStops,
    sourceDiversity: diversity,
    diversityWarning,
    converged: options.mode !== 'focus' && converged(assigned),
  };
}
