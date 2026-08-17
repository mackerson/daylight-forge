import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildStack } from '../focus/stack.ts';
import type { Graph } from '../graph/types.ts';
import { ClaimStore, EvidenceRequired, type Source } from '../store/claims.ts';
import { frontier } from '../swarm/frontier.ts';

/**
 * The MCP data plane. One server, stdio, spawned per agent session.
 *
 * The only write path out of an agent is a tool here. Agents never write files and
 * never touch the graph directly. Every write tool enforces evidence at the boundary.
 */

const EvidenceSchema = z
  .array(
    z.object({
      file: z.string().describe('repo-relative path'),
      line: z.number().optional(),
      endLine: z.number().optional(),
      note: z.string().optional().describe('only when a span genuinely cannot express it'),
    }),
  )
  .min(1)
  .describe('REQUIRED. Cite what you actually read. Claims without evidence are rejected.');

export interface ServerOptions {
  /** Directory holding graph.json and claims.db. */
  dir: string;
  session: string;
  /** Which CLI is on the other end, recorded as claim provenance. */
  agentTool: string;
  model?: string;
}

export function loadGraph(dir: string): Graph {
  return JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8')) as Graph;
}

export function createServer(opts: ServerOptions) {
  const graph = loadGraph(opts.dir);
  const store = new ClaimStore(path.join(opts.dir, 'claims.db'));
  const source: Source = {
    kind: 'agent',
    tool: opts.agentTool,
    model: opts.model,
    sessionId: opts.session,
  };

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const findings = JSON.parse(
    fs.existsSync(path.join(opts.dir, 'findings.json'))
      ? fs.readFileSync(path.join(opts.dir, 'findings.json'), 'utf8')
      : '{"families":[],"d1":[],"d2":[],"d3":[],"patterns":[]}',
  );

  const server = new McpServer({ name: 'visual-desloppify', version: '0.1.0' });

  /**
   * Every tool call is appended to events.jsonl.
   *
   * The GUI tails this rather than parsing each CLI's own output format: the four
   * adapters stream differently (and two cannot be pointed at us per-invocation at
   * all), but they all come through this boundary. One log, every agent.
   */
  const eventLog = path.join(opts.dir, 'events.jsonl');
  const emit = (tool: string, detail: Record<string, unknown>) => {
    try {
      fs.appendFileSync(
        eventLog,
        JSON.stringify({
          at: Date.now(),
          session: opts.session,
          agent: opts.agentTool,
          model: opts.model ?? null,
          tool,
          ...detail,
        }) + '\n',
      );
    } catch {
      // A failed event write must never break the agent's actual work.
    }
  };

  const ok = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  });
  const fail = (message: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  });

  // ---- read ------------------------------------------------------------------

  server.registerTool(
    'get_overview',
    {
      description:
        'Top-level shape of the codebase: counts, directory groups, and how much is still ' +
        'unresolved. Start here to orient before pulling slices.',
      inputSchema: {},
    },
    async () => {
      emit('get_overview', {});
      const stack = buildStack(graph, store, undefined);
      return ok({
        root: graph.root,
        commit: graph.commit,
        l0: stack.l0,
        groups: stack.levels[0].nodes.map((n) => ({
          id: n.id, files: n.fileCount, symbols: n.symbolCount,
        })),
        duplicationFamilies: findings.families?.length ?? 0,
        claims: store.stats(),
      });
    },
  );

  server.registerTool(
    'get_slice',
    {
      description:
        'The n-hop neighbourhood around a node, with current claims. This is the ' +
        'context-budget primitive — pull a slice instead of reading the whole repo.',
      inputSchema: {
        node: z.string().describe('file path or `file#Symbol`'),
        hops: z.number().min(1).max(3).default(1),
      },
    },
    async ({ node, hops }) => {
      emit('get_slice', { node, hops });
      if (!nodesById.has(node)) return fail(`unknown node: ${node}`);
      const seen = new Set([node]);
      let edge_ = [...graph.edges];
      let frontierSet = new Set([node]);

      for (let h = 0; h < hops; h++) {
        const next = new Set<string>();
        for (const e of edge_) {
          if (frontierSet.has(e.from) && !seen.has(e.to)) next.add(e.to);
          if (frontierSet.has(e.to) && !seen.has(e.from)) next.add(e.from);
        }
        for (const n of next) seen.add(n);
        frontierSet = next;
      }

      const edges = edge_.filter((e) => seen.has(e.from) && seen.has(e.to));
      return ok({
        center: node,
        nodes: [...seen].map((id) => nodesById.get(id) ?? { id, kind: 'external' }),
        edges,
        beliefs: [...seen].flatMap((id) =>
          store.claimsFor(id).map((c) => ({ subject: id, predicate: c.predicate, value: c.value })),
        ),
      });
    },
  );

  server.registerTool(
    'get_open_questions',
    {
      description:
        'Your assigned frontier: the highest-value unresolved things, scored by ' +
        'uncertainty x centrality. Work these rather than picking your own targets.',
      inputSchema: { limit: z.number().min(1).max(50).default(10) },
    },
    async ({ limit }) => {
      emit('get_open_questions', { limit });
      return ok(frontier(graph, store, findings).slice(0, limit));
    },
  );

  server.registerTool(
    'get_focus_state',
    {
      description:
        'Current focus stack: what is collapsed where, on whose authority, and which ' +
        'invariants are green, red or unproven.',
      inputSchema: {},
    },
    async () => {
      const stack = buildStack(graph, store, undefined);
      return ok({
        l3Status: stack.l3Status,
        levels: stack.levels.map((l) => ({
          level: l.level, name: l.name, nodes: l.nodes.length, edges: l.edges.length,
          elided: l.elided,
        })),
        clusters: store.clusters().map((c) => ({
          id: c.id, name: c.name, purpose: c.purpose, members: c.members.length,
        })),
        defences: store.defences(),
      });
    },
  );

  // ---- write -----------------------------------------------------------------

  server.registerTool(
    'submit_claim',
    {
      description:
        'Assert a predicate about a node or edge. Evidence is REQUIRED and is checked ' +
        'here: cite the file and line you actually read. Unevidenced claims are rejected. ' +
        'Ruling something OUT (a verdict with value false) needs at least two pieces of ' +
        'evidence including one with a line number — asserting a thing means finding one ' +
        'place it is true, ruling it out means checking the places it could have been.',
      inputSchema: {
        subject: z.string(),
        predicate: z.string().describe("e.g. 'is_dead', 'purpose', 'duplicates', 'canonical_of'"),
        value: z.any(),
        confidence: z.number().min(0).max(1),
        evidence: EvidenceSchema,
      },
    },
    async (a) => {
      try {
        const claim = store.submit({
          subject: a.subject, predicate: a.predicate, value: a.value,
          confidence: a.confidence, evidence: a.evidence, source,
          observedHash: nodesById.get(a.subject)?.contentHash,
        });
        emit('submit_claim', {
          ok: true, subject: a.subject, predicate: a.predicate,
          confidence: a.confidence, evidence: a.evidence.length,
        });
        return ok({ accepted: true, id: claim.id });
      } catch (err) {
        if (err instanceof EvidenceRequired) {
          emit('submit_claim', { ok: false, subject: a.subject, predicate: a.predicate, error: err.message });
          return fail(err.message);
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'flag_contradiction',
    {
      description:
        'Dispute an existing claim with counter-evidence. Disagreement is preserved, ' +
        'never auto-resolved — it becomes a human review item.',
      inputSchema: {
        subject: z.string(),
        predicate: z.string(),
        value: z.any().describe('what you believe instead'),
        confidence: z.number().min(0).max(1),
        evidence: EvidenceSchema,
      },
    },
    async (a) => {
      try {
        store.submit({
          subject: a.subject, predicate: a.predicate, value: a.value,
          confidence: a.confidence, evidence: a.evidence, source,
        });
        emit('flag_contradiction', { ok: true, subject: a.subject, predicate: a.predicate });
        return ok({ accepted: true, belief: store.belief(a.subject, a.predicate) });
      } catch (err) {
        if (err instanceof EvidenceRequired) {
          emit('flag_contradiction', { ok: false, subject: a.subject, error: err.message });
          return fail(err.message);
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'propose_cluster',
    {
      description:
        'Group members into a subsystem with a NAME and a PURPOSE. The purpose is an ' +
        'intent claim and needs evidence like any other. Promotes L1 to L2.',
      inputSchema: {
        name: z.string(),
        purpose: z.string().describe('what this subsystem is FOR, not what files it holds'),
        members: z.array(z.string()).min(2),
        evidence: EvidenceSchema,
      },
    },
    async (a) => {
      if (!a.evidence?.length) return fail('a cluster purpose needs evidence');
      const id = store.putCluster({
        level: 2, name: a.name, purpose: a.purpose, members: a.members,
        source, evidence: a.evidence,
      });
      emit('propose_cluster', { ok: true, name: a.name, members: a.members.length, id });
      return ok({ accepted: true, id });
    },
  );

  server.registerTool(
    'propose_elision',
    {
      description:
        'Argue a set of nodes should collapse at a given altitude. Recorded, reversible ' +
        'and attributable — never a silent drop.',
      inputSchema: {
        members: z.array(z.string()).min(1),
        into: z.string().describe('the surviving node these collapse into'),
        reason: z.string(),
        level: z.number().min(2).max(3).default(3),
      },
    },
    async (a) => {
      const id = store.putElision({
        level: a.level, members: a.members, into: a.into, reason: a.reason, source,
      });
      emit('propose_elision', { ok: true, into: a.into, members: a.members.length, id });
      return ok({ accepted: true, id });
    },
  );

  server.registerTool(
    'defend_node',
    {
      description:
        'Argue something must SURVIVE focusing because it is load-bearing. The ' +
        'counterweight to elision — over-collapse and under-collapse are both failures.',
      inputSchema: { node: z.string(), reason: z.string() },
    },
    async (a) => {
      const id = store.putDefence({ node: a.node, reason: a.reason, source });
      emit('defend_node', { ok: true, node: a.node, id });
      return ok({ accepted: true, id });
    },
  );

  server.registerTool(
    'propose_invariant',
    {
      description:
        'State a load-bearing fact in prose plus a compiled graph query, with evidence ' +
        'that it currently holds. Invariants are what make a focused map checkable.',
      inputSchema: {
        id: z.string(),
        prose: z.string(),
        predicate: z.any().describe('an engine Predicate object'),
        evidence: EvidenceSchema,
      },
    },
    async (a) => {
      try {
        store.submit({
          subject: `invariant:${a.id}`, predicate: 'invariant',
          value: { prose: a.prose, predicate: a.predicate },
          confidence: 0.7, evidence: a.evidence, source,
        });
        return ok({ accepted: true, id: a.id });
      } catch (err) {
        if (err instanceof EvidenceRequired) return fail(err.message);
        throw err;
      }
    },
  );

  return { server, store };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const dir = process.env.VDS_DIR ?? process.cwd();
  const { server } = createServer({
    dir,
    session: process.env.VDS_SESSION ?? 'local',
    agentTool: process.env.VDS_AGENT ?? 'unknown',
    model: process.env.VDS_MODEL,
  });
  await server.connect(new StdioServerTransport());
}
