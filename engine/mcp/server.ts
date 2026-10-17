import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildStack } from '../focus/stack.ts';
import type { Graph } from '../graph/types.ts';
import { ClaimStore, EvidenceRequired, type Source } from '../store/claims.ts';
import type { Claim } from '../store/types.ts';
import { frontier } from '../swarm/frontier.ts';
import { defaultOut } from '../paths.ts';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import { isEntityId } from '../mission/types.ts';
import {
  isRefusal, MAX_ANCHOR_CHARS, MAX_EXAMPLE_BYTES, MAX_EXAMPLES, MAX_PROPOSAL_BYTES, MAX_PROPOSALS_PER_ATTEMPT,
  MAX_STATEMENT_BYTES, MAX_TITLE_CHARS, MAX_TOUCH_CHARS, MAX_TOUCHES, outboxFile, redactProposal, validateProposal,
  type OutboxLine, type ProposalContext,
} from '../forge/proposal.ts';

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
  /**
   * Blind review: set to the mission id. Every agent claim but the caller's own is withheld
   * from every read — the other reviewers in this mission, and any other mission's reviewers
   * on the same subjects — so a reviewer forms its own answer rather than inheriting one.
   * Human and static claims still show; they are not what independence protects against.
   */
  blindPrefix?: string;
}

/**
 * Which claims a blind reviewer may see.
 *
 * Exported because the rule is the whole of ADR-6 and is easier to test as a function than
 * through a stdio transport. `undefined` prefix means not blind: everything is visible.
 */
export function visibleToReviewer<T extends { source: Source }>(
  claims: T[], blindPrefix: string | undefined, ownSession: string,
): T[] {
  if (!blindPrefix) return claims;
  // Another mission's reviewer is no less someone else's answer than this mission's: an
  // earlier review of the same subject, shown to a blind reviewer, is the anchoring blind
  // review exists to prevent.
  return claims.filter((c) => c.source.kind !== 'agent' || c.source.sessionId === ownSession);
}

/**
 * The claim store as a blind reviewer is allowed to read it.
 *
 * Filtering only the claims a tool returns was not enough: the overview's counts, the focus
 * state's clusters and defences (names, purposes, reasons written by the other reviewer),
 * the frontier's scores and the belief a contradiction reports were all derived from every
 * claim. Every read is narrowed here instead, so a tool cannot forget to. Writes and the
 * claim rows themselves are the base store's; the narrowing is in what is derived from them.
 */
export class BlindReviewStore extends ClaimStore {
  private readonly seen: (source: Source) => boolean;
  private readonly blindPrefix: string;

  constructor(dbPath: string, blindPrefix: string, ownSession: string) {
    super(dbPath);
    this.blindPrefix = blindPrefix;
    this.seen = (source) => visibleToReviewer([{ source }], blindPrefix, ownSession).length === 1;
  }

  override belief(subject: string, predicate: string, currentHash?: string, admit?: (c: Claim) => boolean) {
    return super.belief(subject, predicate, currentHash, (c) => this.seen(c.source) && (admit?.(c) ?? true));
  }

  override clusters(level?: number) {
    return super.clusters(level).filter((c) => this.seen(c.source));
  }

  override elisions(level?: number) {
    return super.elisions(level).filter((e) => this.seen(e.source));
  }

  override defences() {
    return super.defences().filter((d) => this.seen(d.source));
  }

  override legacyVerdicts() {
    return super.legacyVerdicts().filter((v) => this.seen(v.source));
  }

  /**
   * The other reviewers' leases do not steer this one: independence means the same subjects.
   * Leases from outside this mission still do — they are concurrent work, not answers.
   */
  override leasedElsewhere(session: string): Set<string> {
    return new Set(
      this.activeLeases()
        .filter((l) => l.session !== session && !l.session.startsWith(this.blindPrefix))
        .map((l) => l.subject),
    );
  }

  override stats() {
    const base = super.stats();
    const subjects = new Set<string>();
    let claims = 0;
    for (const { subject, predicate } of this.allSubjects()) {
      const n = this.claimsFor(subject, predicate).filter((c) => this.seen(c.source)).length;
      claims += n;
      if (n) subjects.add(subject);
    }
    return {
      ...base, claims, subjects: subjects.size,
      clusters: this.clusters().length, elisions: this.elisions().length, defences: this.defences().length,
    };
  }
}

export function loadGraph(dir: string): Graph {
  const file = path.join(dir, 'graph.json');
  if (!fs.existsSync(file)) {
    // Dying here makes every tool "unavailable" with no reason given, which is
    // indistinguishable from the host refusing them — a full evening was spent on that
    // ambiguity with codex. Say what is wrong, on stderr, where the host will log it.
    throw new Error(
      `no graph.json in ${dir}. Set DAYLIGHT_DIR to a directory produced by \`daylight map\`, ` +
        'or run map first. The MCP server has nothing to serve without it.',
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Graph;
}

/**
 * Tool annotations, as MCP defines them.
 *
 * Not decoration: a host decides whether a call needs a human to approve it from these.
 * Every read tool is `readOnlyHint`, and every write tool appends to a local claim store —
 * nothing is overwritten and nothing leaves the machine, which is `destructiveHint: false`
 * and `openWorldHint: false`. Stating that is the honest description of what these do, and
 * it is what lets a non-interactive host run them without being handed a blanket bypass.
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const APPEND_ONLY = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
} as const;

/**
 * Undo HTML escaping in agent-written prose.
 *
 * Measured, not anticipated: on one focus run `claude/opus` submitted
 * `Client Boundary &amp; Bootstrap` while `claude/sonnet` submitted
 * `Render & Input Pipeline`. Same character, two encodings, decided per model — so the text
 * rendered wrong in the UI, and worse, two cluster names that should compare equal did not.
 *
 * That second half is the reason this lives at the boundary rather than in the renderer. The
 * store already canonicalises predicates because "CONTRADICTED between two claims that agreed
 * but spelled a JSON key differently" is a failure it refuses to have; escaping is the same
 * failure for prose, and any future attempt to notice that three agents named one subsystem
 * three ways has to compare strings that are actually comparable.
 *
 * Deliberately narrow: the five entities a model over-escapes, and numeric references. It is
 * applied once, so text that genuinely means to say `&amp;` loses that — a trade taken
 * knowingly, because prose about HTML entities is far rarer here than a model escaping an
 * ampersand in a subsystem name.
 */
const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
};

// Overloaded so a string in is a `string` out rather than the literal type it was called
// with — otherwise every comparison against the decoded form looks impossible to the checker.
export function unescapeText(value: string): string;
export function unescapeText<T>(value: T): T;
export function unescapeText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d{1,6});/g, (m, code) => {
      const n = Number(code);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    });
}

export function createServer(opts: ServerOptions) {
  const graph = loadGraph(opts.dir);
  const dbPath = path.join(opts.dir, 'claims.db');
  const store = opts.blindPrefix ? new BlindReviewStore(dbPath, opts.blindPrefix, opts.session) : new ClaimStore(dbPath);
  const source: Source = {
    kind: 'agent',
    tool: opts.agentTool,
    model: opts.model,
    sessionId: opts.session,
  };

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const visible = <T extends { source: Source }>(claims: T[]) =>
    visibleToReviewer(claims, opts.blindPrefix, opts.session);
  const readJson = (name: string, fallback: unknown) => {
    const file = path.join(opts.dir, name);
    if (!fs.existsSync(file)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  const findings = readJson('findings.json', { families: [], d1: [], d2: [], d3: [], patterns: [] });
  const structure = readJson('structure.json', {});

  const server = new McpServer({ name: 'daylight', version: '0.1.0' });

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
      annotations: READ_ONLY,
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
      annotations: READ_ONLY,
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
          visible(store.claimsFor(id)).map((c) => ({ subject: id, predicate: c.predicate, value: c.value })),
        ),
      });
    },
  );

  server.registerTool(
    'get_open_questions',
    {
      description:
        'Your assigned frontier: the highest-value unresolved things, scored by ' +
        'uncertainty x centrality. Work these rather than picking your own targets. ' +
        'Items you are given are leased to you, so other agents running at the same time ' +
        'get different work — do not go looking for your own targets, you will duplicate them.',
      annotations: READ_ONLY,
      inputSchema: { limit: z.number().min(1).max(50).default(10) },
    },
    async ({ limit }) => {
      // Skip whatever another live session already holds, then lease what we hand back so
      // the next agent to ask gets different work.
      const taken = store.leasedElsewhere(opts.session);
      const mine = frontier(graph, store, findings, structure)
        .filter((item) => !taken.has(item.subject))
        .slice(0, limit);
      store.lease(mine.map((i) => i.subject), opts.session);
      emit('get_open_questions', { limit, assigned: mine.length, skipped: taken.size });
      return ok(mine);
    },
  );

  server.registerTool(
    'get_focus_state',
    {
      description:
        'Current focus stack: what is collapsed where, on whose authority, and which ' +
        'invariants are green, red or unproven.',
      annotations: READ_ONLY,
      inputSchema: {},
    },
    async () => {
      emit('get_focus_state', {});
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
      annotations: APPEND_ONLY,
      inputSchema: {
        subject: z.string(),
        predicate: z.string().describe(
          "e.g. 'purpose', 'canonical_of', or a verdict: 'god_verdict', 'liveness_verdict', " +
          "'duplication_verdict', 'cycle_verdict', 'limb_verdict', 'divergence_verdict'",
        ),
        value: z.any().describe(
          'For a *_verdict predicate this MUST be a JSON boolean — true or false, not a ' +
          'sentence. Put every word of your reasoning in evidence[].note instead; a verdict ' +
          'whose value is prose cannot be compared against another agent\'s and is rejected. ' +
          'For narrative predicates like purpose, a string is what is wanted.',
        ),
        confidence: z.number().min(0).max(1),
        evidence: EvidenceSchema,
      },
    },
    async (a) => {
      try {
        const claim = store.submit({
          subject: a.subject, predicate: a.predicate,
          // A narrative value is prose and gets the same normalisation as a cluster name.
          // Booleans and everything else pass through untouched.
          value: unescapeText(a.value),
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
      annotations: APPEND_ONLY,
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
        // For a blind reviewer the store derives the belief from what it may see, so neither
        // the other side's text nor a status that only exists because of it comes back.
        const belief = store.belief(a.subject, a.predicate);
        return ok({ accepted: true, belief: { ...belief, claims: visible(belief.claims) } });
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
      annotations: APPEND_ONLY,
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
        level: 2, name: unescapeText(a.name), purpose: unescapeText(a.purpose),
        members: a.members,
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
      annotations: APPEND_ONLY,
      inputSchema: {
        members: z.array(z.string()).min(1),
        into: z.string().describe('the surviving node these collapse into'),
        reason: z.string(),
        level: z.number().min(2).max(3).default(3),
      },
    },
    async (a) => {
      const id = store.putElision({
        level: a.level, members: a.members, into: unescapeText(a.into),
        reason: unescapeText(a.reason), source,
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
      annotations: APPEND_ONLY,
      inputSchema: { node: z.string(), reason: z.string() },
    },
    async (a) => {
      const id = store.putDefence({ node: a.node, reason: unescapeText(a.reason), source });
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
      annotations: APPEND_ONLY,
      inputSchema: {
        id: z.string(),
        prose: z.string(),
        predicate: z
          .any()
          .describe(
            'an engine Predicate object, e.g. ' +
              '{"type":"forbidden-callee","within":{"file":"^src/"},"callee":"^Math\\.random$"}. ' +
              'Valid types: absent, count, literal-fanin, forbidden-call, forbidden-callee, ' +
              'required-callee, ordering.',
          ),
        evidence: EvidenceSchema,
      },
    },
    async (a) => {
      // Agents routinely send nested JSON as a string. Parsing it here beats rejecting a
      // well-reasoned invariant over its envelope.
      let predicate = a.predicate;
      if (typeof predicate === 'string') {
        try {
          predicate = JSON.parse(predicate);
        } catch {
          return fail('predicate must be an object, or a JSON string that parses to one');
        }
      }
      if (!predicate || typeof predicate !== 'object' || !('type' in predicate)) {
        return fail('predicate needs a `type` — see the tool description for the valid set');
      }
      try {
        store.submit({
          subject: `invariant:${a.id}`, predicate: 'invariant',
          value: { prose: a.prose, predicate },
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

// ---- decompose -----------------------------------------------------------------

export interface DecomposeServerOptions {
  /** `<out>`: the outbox goes under it. */
  dir: string;
  /**
   * The calling attempt, as the host resolved it from the attempt's own MCP token (R11.2,
   * R-9) and found to be a decompose attempt. Never taken from the environment or from
   * anything the agent sends.
   */
  attemptId: string;
  agentTool?: string;
  model?: string;
  /** The registered spec and tree, when the host has them, so a bad anchor is refused at once. */
  check?: ProposalContext;
}

/**
 * The MCP server a decompose attempt gets: one tool, `propose_work_item`, and nothing that
 * reads anything back, so a decomposer cannot see the spec's other readings (blind by
 * construction). Each accepted proposal is one line in this attempt's outbox; the host
 * re-checks every line before any row exists, so this is the first gate, not the only one.
 *
 * Input is hostile: every field is size-capped here and again in `validateProposal`, paths
 * must be repo-relative (an absolute path, `..` or `~` is refused, never resolved), and a
 * refusal names the field and a fixed reason, never the text.
 */
export function createDecomposeServer(opts: DecomposeServerOptions) {
  if (!isEntityId('attempt', opts.attemptId)) throw new Error('a decompose server is bound to one attempt id');
  const server = new McpServer({ name: 'daylight', version: '0.1.0' });
  const file = outboxFile(opts.dir, opts.attemptId);
  const eventLog = path.join(opts.dir, 'events.jsonl');
  const emit = (detail: Record<string, unknown>) => {
    try {
      fs.appendFileSync(eventLog, JSON.stringify({
        at: Date.now(), session: opts.attemptId, agent: opts.agentTool ?? 'unknown', model: opts.model ?? null,
        tool: 'propose_work_item', ...detail,
      }) + '\n');
    } catch {
      // A failed event write must never break the agent's actual work.
    }
  };
  const refuse = (field: string, reason: string) => {
    emit({ ok: false, field, reason });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ accepted: false, field, reason }) }],
      isError: true,
    };
  };
  const filed = (): number => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  };
  const text = (max: number) => z.string().max(max);

  server.registerTool(
    'propose_work_item',
    {
      description:
        'Propose ONE work item drawn from the spec you were given. It is recorded for a person to ' +
        'approve or reject; nothing is built or tested until they do. `anchor` is a heading anchor ' +
        'from the list in your prompt (`#section` or `#section/subsection`) or a line range `L<a>-<b>`. ' +
        '`title` is one line. `statement` says what must be true when the item is done. `touches` ' +
        `lists repo-relative files you expect to change. At most ${MAX_PROPOSALS_PER_ATTEMPT} per session.`,
      annotations: APPEND_ONLY,
      inputSchema: {
        anchor: text(MAX_ANCHOR_CHARS),
        title: text(MAX_TITLE_CHARS),
        statement: text(MAX_STATEMENT_BYTES),
        examples: z.array(text(MAX_EXAMPLE_BYTES)).max(MAX_EXAMPLES).optional(),
        negativeExamples: z.array(text(MAX_EXAMPLE_BYTES)).max(MAX_EXAMPLES).optional(),
        touches: z.array(text(MAX_TOUCH_CHARS)).max(MAX_TOUCHES).optional(),
      },
    },
    async (a) => {
      const valid = validateProposal(a, opts.check);
      if (isRefusal(valid)) return refuse(valid.field, valid.refused);
      // Masked before the outbox: the line sits on disk until someone deletes it.
      const checked = redactProposal(valid);
      if (filed() >= MAX_PROPOSALS_PER_ATTEMPT) return refuse('count', `at most ${MAX_PROPOSALS_PER_ATTEMPT} proposals per session`);
      const line: OutboxLine = { v: 1, at: Date.now(), proposal: checked };
      const json = JSON.stringify(line);
      if (Buffer.byteLength(json, 'utf8') > MAX_PROPOSAL_BYTES + 512) return refuse('payload', 'over the size cap');
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        // Never through a link: the outbox is ours to create, in a directory only we write.
        const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
        try {
          fs.writeSync(fd, `${json}\n`);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return refuse('payload', 'the proposal could not be recorded');
      }
      const proposalDigest = digestOf(canonicalJson(checked));
      emit({ ok: true, anchor: checked.anchor, proposalDigest });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ accepted: true, proposalDigest }) }] };
    },
  );
  return { server };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  // Accept the directory as an argument too: some hosts do not pass environment through to
  // stdio servers, and a server that cannot be told where to look is a server that cannot
  // be used from those hosts.
  const fromArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const dir = fromArg ?? process.env.DAYLIGHT_DIR ?? defaultOut(process.cwd());
  const { server } = createServer({
    dir,
    session: process.env.DAYLIGHT_SESSION ?? 'local',
    agentTool: process.env.DAYLIGHT_AGENT ?? 'unknown',
    model: process.env.DAYLIGHT_MODEL,
    blindPrefix: process.env.DAYLIGHT_BLIND_PREFIX,
  });
  await server.connect(new StdioServerTransport());
}
