import type { DaylightContext } from '../mission/context.ts';
import { digestOf } from '../mission/artifacts.ts';
import type {
  AuthorityChain, CorpusRevision, IrRecord, IrSpanRef, PlanFile, SectionIndex, SpanRef, TraceEdge, TraceJoin, TraceMatrix, TraceNode, TraceNodeType,
  TraceReport, WorkPacket,
} from '../mission/types.ts';
import { TRACE_JOINS } from '../mission/types.ts';
import { campaignLockOf, holdoutPaths } from './campaign-gates.ts';
import { authorityChainOf } from './authority.ts';

/**
 * Traceability, forward and backward (spec ingestion §10). WS-R16.
 *
 * Read-only joins over rows other modules write; nothing here decides or repairs anything. Every
 * edge names the join it used (`TRACE_JOINS`):
 *
 *   passage → unit          (revisionId, docKey) + byte overlap with the section index's sentences
 *   passage/unit → IR       ir_spans overlap at that revision, roles primary and other
 *   IR → element            blueprint_derivations on an approved blueprint
 *   element → packet        packets(blueprint_id, component_id) whose body cites the record
 *   packet / IR → ticket    ticket_trace(packet_id) / ticket_trace(ir_id, role)
 *   ticket → missions       campaign_tickets.work_item_id; every ticket mission on that work item
 *   mission → evidence      candidates.mission_id; gate_evaluations by candidate or integration; lock obligations
 *   candidate → landing     integrations(candidate_id).integrated_commit; applications
 *   ticket → revision       the plan's derivation.corpusDigest → corpus_revisions → ir_spans at that revision
 *
 * What a report never carries: corpus text (the markdown renderer asks its caller for excerpts,
 * and `safeExcerpt` withholds holdout and secret-shaped ones), extractor or reviewer statements
 * (P2-R40), and any label naming a holdout basename of any campaign of the project — such a label
 * is replaced and counted as a gap, never printed (P2-R53). Quote digests are re-hashed from the
 * stored document bytes on every trace.
 */

export { TRACE_JOINS };

const WITHHELD = '[withheld: names a holdout path]';

class Graph {
  readonly nodes = new Map<string, TraceNode>();
  readonly edges: TraceEdge[] = [];
  readonly gaps: TraceReport['gaps'] = [];
  readonly verified = { quotesRehashed: 0, mismatches: [] as string[] };
  private readonly edgeKeys = new Set<string>();
  private readonly holdouts: readonly string[];
  constructor(holdouts: readonly string[]) {
    this.holdouts = holdouts;
  }

  node(n: TraceNode): TraceNode {
    const have = this.nodes.get(n.id);
    if (have) return have;
    const hidden = this.holdouts.some((b) => n.label.includes(b));
    if (hidden) this.gap(n.id, n.type, 'label withheld: it names a holdout path');
    const out = { ...n, label: hidden ? WITHHELD : n.label };
    this.nodes.set(n.id, out);
    return out;
  }

  edge(from: string, to: string, via: TraceJoin): void {
    const k = `${from}\u0000${to}\u0000${via}`;
    if (this.edgeKeys.has(k)) return;
    this.edgeKeys.add(k);
    this.edges.push({ from, to, via });
  }

  gap(at: string, missing: TraceNodeType, why: string): void {
    if (!this.gaps.some((g) => g.at === at && g.missing === missing && g.why === why)) this.gaps.push({ at, missing, why });
  }

  report(direction: TraceReport['direction'], root: TraceNode): TraceReport {
    return { kind: 'daylight-trace', v: 1, direction, root, nodes: [...this.nodes.values()], edges: this.edges, gaps: this.gaps, verified: this.verified };
  }
}

/** Holdout basenames of every campaign of the project: any label naming one is withheld. */
function projectHoldouts(ctx: DaylightContext, projectId: string): string[] {
  const out = new Set<string>();
  for (const m of ctx.store.missions(projectId)) {
    if (m.kind !== 'campaign') continue;
    for (const p of holdoutPaths(ctx, m.id)) {
      const base = p.split('/').pop();
      if (base) out.add(base);
    }
  }
  return [...out].sort();
}

function indexOf(ctx: DaylightContext, rev: CorpusRevision): SectionIndex {
  return JSON.parse(ctx.artifacts.text(rev.sectionIndex, 64 * 1024 * 1024)) as SectionIndex;
}

const sectionsOf = (ix: SectionIndex, docKey: string) => ix.docs.find((d) => d.key === docKey)?.sections ?? [];

/** A passage node is identified by revision, document and bytes, never by its text. */
export const spanNodeId = (revisionId: string, docKey: string, start: number, end: number): string => `span:${revisionId}:${docKey}:${start}-${end}`;

const SPAN_NODE = /^span:(cr_[0-9a-f]+):([a-z][a-z0-9-]*):(\d+)-(\d+)$/;

/** The revision and span a span node id names (the round trip of `spanNodeId`), or null. */
export function spanOfNodeId(nodeId: string): { revisionId: string; docKey: string; start: number; end: number } | null {
  const m = SPAN_NODE.exec(nodeId);
  return m ? { revisionId: m[1], docKey: m[2], start: Number(m[3]), end: Number(m[4]) } : null;
}

/** Re-hash a span's bytes from the revision's document artifact; a mismatch is recorded by record id. */
function rehash(ctx: DaylightContext, g: Graph, rev: CorpusRevision, irId: string, s: Pick<IrSpanRef, 'docKey' | 'start' | 'end' | 'quoteDigest'>): void {
  const doc = rev.docs.find((d) => d.key === s.docKey);
  let bytes: Buffer | null = null;
  try {
    bytes = doc && ctx.artifacts.has(doc.artifact) ? ctx.artifacts.get(doc.artifact) : null;
  } catch {
    bytes = null;   // a document artifact corrupt on disk verifies nothing: the record is a mismatch
  }
  g.verified.quotesRehashed++;
  if (!bytes || s.end > bytes.length || digestOf(bytes.subarray(s.start, s.end)) !== s.quoteDigest) {
    if (!g.verified.mismatches.includes(irId)) g.verified.mismatches.push(irId);
  }
}

function sectionNode(g: Graph, ix: SectionIndex, docKey: string, sectionId: string): TraceNode | null {
  const s = sectionsOf(ix, docKey).find((x) => x.id === sectionId);
  return s ? g.node({ type: 'section', id: s.id, label: `${docKey} ${s.label ?? s.title}`.trim(), digest: s.bodyDigest }) : null;
}

const irLabel = (r: IrRecord): string => `${r.kind}${r.span ? ` · ${r.span.docKey}` : ''}`;

/** Stale = an extracted record with no span at its corpus's current revision (derived, P2-R53). */
const isStale = (ctx: DaylightContext, r: IrRecord): boolean => r.source === 'extracted' && !ctx.store.irRecord(r.id)?.span;

function irNode(ctx: DaylightContext, g: Graph, r: IrRecord): TraceNode {
  return g.node({ type: 'ir', id: r.id, label: irLabel(ctx.store.irRecord(r.id) ?? r), status: r.status, stale: isStale(ctx, r), digest: r.contentDigest });
}

const elementType = (role: string): TraceNodeType => (role === 'bounds' || role === 'invariant' ? 'boundary' : role === 'interface' ? 'interface' : 'component');

const cites = (p: Pick<WorkPacket, 'requirementIds' | 'acceptanceObligations' | 'interfaceContracts' | 'artifacts'>, irId: string): boolean =>
  (p.requirementIds ?? []).includes(irId) || (p.acceptanceObligations ?? []).some((o) => o.irIds.includes(irId))
  || (p.interfaceContracts ?? []).some((c) => c.irIds.includes(irId)) || (p.artifacts ?? []).some((a) => a.irIds.includes(irId));

function packetBody(ctx: DaylightContext, digest: string): WorkPacket | null {
  try {
    return JSON.parse(ctx.artifacts.text(digest)) as WorkPacket;
  } catch {
    return null;
  }
}

/** Approved blueprints' derivations of one record as element nodes, and the packets of each component citing it. */
function deriveElements(ctx: DaylightContext, g: Graph, irId: string, withPackets: boolean): void {
  const rows = ctx.store.derivationsOfIr(irId);
  let approved = 0;
  for (const d of rows) {
    const bp = ctx.store.blueprint(d.blueprintId);
    if (!bp || bp.status !== 'approved') continue;
    approved++;
    if (d.role === 'deferred' || d.role === 'out-of-scope') {
      const to = bp.body.deferred.find((x) => x.irId === irId)?.to;
      g.gap(irId, 'component', d.role === 'deferred' ? `deferred${to ? ` to ${to}` : ''} by blueprint ${bp.id}` : `out of scope in blueprint ${bp.id}`);
      continue;
    }
    const type = elementType(d.role);
    const el = g.node({ type, id: `${bp.id}:${d.elementId}`, label: `${type} ${d.elementId}`, digest: bp.blueprintDigest });
    g.edge(irId, el.id, 'derivation');
    if (!withPackets || type !== 'component') continue;
    for (const p of ctx.store.packets(bp.id)) {
      if (p.componentId !== d.elementId || p.status === 'superseded') continue;
      const body = packetBody(ctx, p.bodyArtifact.digest);
      if (body && !cites(body, irId)) continue;
      g.edge(el.id, g.node({ type: 'packet', id: p.id, label: `packet ${p.ticketId}`, status: p.status, digest: p.packetDigest }).id, 'packet-component');
    }
  }
  if (!approved) g.gap(irId, 'component', rows.length ? 'no approved blueprint derives from this record' : 'no blueprint derives from this record');
}

/** Ticket → work item → every ticket mission on it → candidates → gate rows and landings. */
function forwardFromTicket(ctx: DaylightContext, g: Graph, campaignId: string, ticketId: string, ticketNode: string): void {
  const t = ctx.store.campaignTicket(campaignId, ticketId);
  if (!t) {
    g.gap(ticketNode, 'work-item', 'the ticket is not imported into the campaign');
    return;
  }
  const w = ctx.store.workItem(t.workItemId);
  const wn = g.node({ type: 'work-item', id: t.workItemId, label: `work item for ${ticketId}`, status: w?.status, digest: w?.contentDigest });
  g.edge(ticketNode, wn.id, 'ticket-work-item');
  const missions = ctx.store.missions(t.projectId).filter((m) => m.parentId === campaignId && m.workItemId === t.workItemId);
  if (!missions.length) g.gap(wn.id, 'mission', 'no ticket mission has started');
  const consumer = ctx.store.workItemConsumer(t.workItemId);
  const lock = campaignLockOf(ctx, campaignId);
  const bound = (experimentId: string) => (lock?.scope.obligations?.[experimentId] ?? []).some((o) => o.startsWith(`${ticketId}:`));
  for (const m of missions) {
    const mn = g.node({ type: 'mission', id: m.id, label: `${m.kind}${m.id === consumer ? ' (consumer)' : ' (released)'}`, status: m.state });
    g.edge(wn.id, mn.id, 'consumed-by');
    const candidates = ctx.store.candidates(m.id);
    if (!candidates.length) g.gap(mn.id, 'candidate', 'no candidate yet');
    for (const c of candidates) {
      const cn = g.node({ type: 'candidate', id: c.id, label: `candidate ${c.id}`, status: c.verdict, digest: c.diffArtifact.digest });
      g.edge(mn.id, cn.id, 'candidate-mission');
      for (const e of ctx.store.gateEvaluations({ candidateId: c.id })) {
        if (e.integrationId) continue;
        g.edge(cn.id, g.node({ type: 'gate-evaluation', id: e.id, label: `${e.target} ${e.experimentId}`, status: e.conclusion }).id,
          bound(e.experimentId) ? 'obligation-gate' : 'evaluation');
      }
      const landings = ctx.store.integrations(campaignId, { missionId: m.id }).filter((i) => i.candidateId === c.id && i.state !== 'abandoned');
      if (!landings.length) g.gap(cn.id, 'integration', 'not landed');
      for (const i of landings) {
        const inode = g.node({ type: 'integration', id: i.id, label: i.integratedCommit ? `landed ${i.integratedCommit.slice(0, 12)}` : `integration ${i.state}`,
          status: i.state, digest: i.integratedDiffDigest ?? undefined });
        g.edge(cn.id, inode.id, 'landing');
        for (const e of ctx.store.gateEvaluations({ integrationId: i.id })) {
          g.edge(inode.id, g.node({ type: 'gate-evaluation', id: e.id, label: `${e.target} ${e.experimentId}`, status: e.conclusion }).id,
            bound(e.experimentId) ? 'obligation-gate' : 'evaluation');
        }
      }
      const a = ctx.store.application(c.id);
      if (a) g.edge(cn.id, g.node({ type: 'application', id: a.id, label: `applied ${a.commit.slice(0, 12)}` }).id, 'application');
    }
  }
}

/** One record: elements, packets, tickets and all a ticket reaches; its findings and assumption beside. */
function forwardFromIr(ctx: DaylightContext, g: Graph, r: IrRecord): void {
  deriveElements(ctx, g, r.id, true);
  const rows = ctx.store.ticketsTracing(r.id);
  if (!rows.length) g.gap(r.id, 'ticket', 'no imported ticket traces this record');
  for (const row of rows) {
    const tn = g.node({ type: 'ticket', id: `${row.campaignId}:${row.ticketId}`, label: `ticket ${row.ticketId}${row.handEdited ? ' (hand-edited)' : ''}` });
    if (row.packetId && g.nodes.has(row.packetId)) g.edge(row.packetId, tn.id, 'packet-ticket');
    else g.edge(r.id, tn.id, 'ticket-trace');
    forwardFromTicket(ctx, g, row.campaignId, row.ticketId, tn.id);
  }
  if (r.assumptionId) {
    const a = ctx.store.assumption(r.assumptionId);
    if (a) g.edge(r.id, g.node({ type: 'assumption', id: a.id, label: `assumption ${a.ownerDecisionId ?? a.id}`, status: a.status }).id, 'assumption');
  }
  for (const f of ctx.store.irFindings(r.corpusId, { irId: r.id })) {
    g.edge(r.id, g.node({ type: 'finding', id: f.id, label: `${f.kind} (${f.severity})`, status: f.disposition }).id, 'finding');
  }
}

/**
 * Forward: a passage (a section, a label or a byte range of one document at a revision, current by
 * default), or one record → records → blueprint elements → packets → tickets → work items →
 * missions → candidates → gate rows and landed commits.
 */
export function traceForward(ctx: DaylightContext, from: { corpusId: string; docKey: string; sectionId?: string; label?: string; range?: [number, number];
  revisionId?: string } | { irId: string }): TraceReport {
  if ('irId' in from) {
    const r = ctx.store.irRecord(from.irId);
    if (!r) throw new Error(`unknown IR record ${from.irId}`);
    const g = new Graph(projectHoldouts(ctx, r.projectId));
    const root = irNode(ctx, g, r);
    const rev = ctx.store.currentCorpusRevision(r.corpusId);
    for (const s of [r.span, r.other]) if (s && rev) rehash(ctx, g, rev, r.id, s);
    forwardFromIr(ctx, g, r);
    return g.report('forward', root);
  }
  const corpus = ctx.store.mission(from.corpusId);
  if (!corpus || corpus.kind !== 'corpus') throw new Error(`${from.corpusId} is not a corpus mission`);
  const rev = from.revisionId ? ctx.store.corpusRevision(from.revisionId) : ctx.store.currentCorpusRevision(from.corpusId);
  if (!rev || rev.corpusId !== from.corpusId) throw new Error(`no revision ${from.revisionId ?? '(current)'} of corpus ${from.corpusId}`);
  const doc = rev.docs.find((d) => d.key === from.docKey);
  if (!doc) throw new Error(`corpus ${from.corpusId} has no document ${from.docKey} at ${rev.id}`);
  const ix = indexOf(ctx, rev);
  const g = new Graph(projectHoldouts(ctx, corpus.projectId));
  const docNode = g.node({ type: 'document', id: `doc:${rev.id}:${from.docKey}`, label: `${from.docKey} @ ${doc.commit.slice(0, 12)}`, digest: doc.digest });
  let start: number;
  let end: number;
  let root: TraceNode;
  if (from.sectionId !== undefined || from.label !== undefined) {
    const matches = sectionsOf(ix, from.docKey).filter((s) => (from.sectionId !== undefined ? s.id === from.sectionId : s.label === from.label));
    if (matches.length !== 1) throw new Error(matches.length ? `that label names ${matches.length} sections; pass --section` : 'no such section in that document');
    [start, end] = [matches[0].start, matches[0].end];
    root = sectionNode(g, ix, from.docKey, matches[0].id)!;
  } else if (from.range) {
    [start, end] = from.range;
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= doc.bytes)) throw new Error('a range is two byte offsets 0 ≤ a < b ≤ the document size');
    root = g.node({ type: 'unit', id: spanNodeId(rev.id, from.docKey, start, end), label: `${from.docKey} bytes ${start}-${end}` });
  } else throw new Error('a passage is a section, a label or a byte range');
  g.edge(docNode.id, root.id, 'span-overlap');
  const units = ix.sentences.filter((u) => u.docKey === from.docKey && u.start < end && u.end > start);
  for (const u of units) {
    const un = g.node({ type: 'unit', id: u.id, label: `normative unit ${u.id.split('#').pop()} (score ${u.score})` });
    if (un.id !== root.id) g.edge(root.id, un.id, 'span-overlap');
  }
  const spans = ctx.store.irSpansAt(rev.id, from.docKey, start, end);
  if (!spans.length) g.gap(root.id, 'ir', 'no record spans this passage');
  for (const s of spans) {
    const r = ctx.store.irRecord(s.irId, rev.id);
    if (!r) continue;
    rehash(ctx, g, rev, r.id, s);
    const unit = units.find((u) => u.start < s.end && u.end > s.start);
    g.edge(unit ? unit.id : root.id, irNode(ctx, g, r).id, 'ir-span');
    forwardFromIr(ctx, g, r);
  }
  return g.report('forward', root);
}

/** The revision a campaign's current plan was derived from (`derivation.corpusDigest`), or null for a v1 plan. */
function derivedRevision(ctx: DaylightContext, campaignId: string): CorpusRevision | null {
  const at = ctx.store.currentPlan(campaignId);
  if (!at) return null;
  try {
    const d = (JSON.parse(ctx.artifacts.text(at.planArtifact)) as PlanFile).derivation;
    return d ? ctx.store.corpusRevisionByDigest(d.corpusId, d.corpusDigest) : null;
  } catch {
    return null;
  }
}

/** Ticket → packets → records → their quoted spans at the plan's revision, digests re-hashed. */
function backwardFromTicket(ctx: DaylightContext, g: Graph, campaignId: string, ticketId: string, ticketNode: string): void {
  const rows = ctx.store.ticketTrace(campaignId, ticketId);
  if (!rows.length) {
    g.gap(ticketNode, 'ir', 'untraced: the ticket came from a plan without a derivation, or was hand-written');
    return;
  }
  const planRev = derivedRevision(ctx, campaignId);
  for (const row of rows) {
    let from = ticketNode;
    const p = row.packetId ? ctx.store.packet(row.packetId) : null;
    if (p) {
      g.edge(ticketNode, g.node({ type: 'packet', id: p.id, label: `packet ${p.ticketId}`, status: p.status, digest: p.packetDigest }).id, 'packet-ticket');
      from = p.id;
    }
    const current = ctx.store.irRecord(row.irId);
    if (!current) continue;
    const rev = planRev && planRev.corpusId === current.corpusId ? planRev : ctx.store.currentCorpusRevision(current.corpusId);
    if (!rev) continue;
    if (!planRev) g.gap(row.irId, 'unit', 'the plan names no derivation revision; spans are read at the corpus\'s current revision');
    const r = ctx.store.irRecord(row.irId, rev.id)!;
    g.edge(from, g.node({ type: 'ir', id: r.id, label: irLabel(current), status: r.status, stale: isStale(ctx, r), digest: r.contentDigest }).id, 'ticket-trace');
    deriveElements(ctx, g, r.id, false);
    const ix = indexOf(ctx, rev);
    const spans = [r.span, r.other].filter((s): s is IrSpanRef => s !== null);
    if (!spans.length) g.gap(r.id, 'unit', r.source === 'inferred' ? 'an inferred record has no passage' : `no span at ${rev.id}: the record is stale there`);
    for (const s of spans) {
      rehash(ctx, g, rev, r.id, s);
      const commit = rev.docs.find((d) => d.key === s.docKey)?.commit ?? '';
      const sec = sectionsOf(ix, s.docKey).find((x) => x.id === s.sectionId);
      const un = g.node({ type: 'unit', id: spanNodeId(rev.id, s.docKey, s.start, s.end),
        label: `${s.docKey} ${sec?.label ?? s.sectionId} bytes ${s.start}-${s.end} @ ${commit.slice(0, 12)}`, digest: s.quoteDigest });
      g.edge(r.id, un.id, 'ir-span');
      const sn = sectionNode(g, ix, s.docKey, s.sectionId);
      if (sn) g.edge(un.id, sn.id, 'span-overlap');
    }
  }
}

/**
 * Backward: a landed commit, an integration, a candidate or a ticket → ticket → packet → records →
 * the quoted passages (document, bytes, revision commit). A commit reaches an integration row only
 * when the human merge fast-forwarded; a squash or rebase merge has none, and the report says so.
 */
export function traceBackward(ctx: DaylightContext, from: { commit: string; campaignId?: string } | { integrationId: string } | { candidateId: string }
  | { campaignId: string; ticketId: string }): TraceReport {
  if ('ticketId' in from) {
    const c = ctx.store.mission(from.campaignId);
    if (!c || c.kind !== 'campaign') throw new Error(`${from.campaignId} is not a campaign`);
    if (!ctx.store.campaignTicket(c.id, from.ticketId) && !ctx.store.ticketTrace(c.id, from.ticketId).length) {
      throw new Error(`campaign ${c.id} has no ticket ${from.ticketId}`);
    }
    const g = new Graph(projectHoldouts(ctx, c.projectId));
    const root = g.node({ type: 'ticket', id: `${c.id}:${from.ticketId}`, label: `ticket ${from.ticketId}` });
    backwardFromTicket(ctx, g, c.id, from.ticketId, root.id);
    return g.report('backward', root);
  }
  let g: Graph;
  let root: TraceNode;
  let candidateId: string;
  let landedBy: string | null = null;
  if ('commit' in from) {
    if (!/^[0-9a-f]{7,64}$/.test(from.commit)) throw new Error('a commit is a hex object id of at least 7 characters');
    const campaigns = (from.campaignId ? [ctx.store.mission(from.campaignId)] : ctx.store.missions()).filter((m) => m?.kind === 'campaign');
    if (from.campaignId && !campaigns.length) throw new Error(`${from.campaignId} is not a campaign`);
    const hits = campaigns.flatMap((c) => ctx.store.integrations(c!.id, { state: 'integrated' }))
      .filter((i) => i.integratedCommit !== null && i.integratedCommit.startsWith(from.commit));
    // A commit may be any campaign's: every project those campaigns belong to withholds its holdouts.
    g = new Graph([...new Set(campaigns.flatMap((c) => projectHoldouts(ctx, c!.projectId)))]);
    root = g.node({ type: 'integration', id: `commit:${from.commit}`, label: `commit ${from.commit.slice(0, 12)}` });
    if (hits.length !== 1) {
      g.gap(root.id, 'integration', hits.length ? `${hits.length} landings share this commit prefix; name the integration`
        : 'no integration landed this commit: a squash or rebase merge leaves no row, so a commit on main is traceable only when the merge fast-forwarded');
      return g.report('backward', root);
    }
    const i = hits[0];
    g.edge(root.id, g.node({ type: 'integration', id: i.id, label: `landed ${i.integratedCommit!.slice(0, 12)}`, status: i.state }).id, 'landing');
    candidateId = i.candidateId;
    landedBy = i.id;
  } else if ('integrationId' in from) {
    const i = ctx.store.integration(from.integrationId);
    if (!i) throw new Error(`unknown integration ${from.integrationId}`);
    g = new Graph(projectHoldouts(ctx, i.projectId));
    root = g.node({ type: 'integration', id: i.id, label: i.integratedCommit ? `landed ${i.integratedCommit.slice(0, 12)}` : `integration ${i.state}`, status: i.state });
    if (i.state !== 'integrated') g.gap(i.id, 'integration', `the integration is ${i.state}, not landed`);
    candidateId = i.candidateId;
    landedBy = i.id;
  } else {
    const c = ctx.store.candidate(from.candidateId);
    if (!c) throw new Error(`unknown candidate ${from.candidateId}`);
    g = new Graph(projectHoldouts(ctx, c.projectId));
    root = g.node({ type: 'candidate', id: c.id, label: `candidate ${c.id}`, status: c.verdict, digest: c.diffArtifact.digest });
    candidateId = c.id;
  }
  const c = ctx.store.candidate(candidateId);
  if (!c) throw new Error(`unknown candidate ${candidateId}`);
  g.node({ type: 'candidate', id: c.id, label: `candidate ${c.id}`, status: c.verdict, digest: c.diffArtifact.digest });
  if (landedBy) g.edge(landedBy, c.id, 'landing');
  for (const e of ctx.store.gateEvaluations({ candidateId: c.id })) {
    g.edge(c.id, g.node({ type: 'gate-evaluation', id: e.id, label: `${e.target} ${e.experimentId}`, status: e.conclusion }).id, 'evaluation');
  }
  const m = ctx.store.mission(c.missionId)!;
  g.edge(c.id, g.node({ type: 'mission', id: m.id, label: m.kind, status: m.state }).id, 'candidate-mission');
  if (!m.workItemId || !m.parentId) {
    g.gap(m.id, 'ticket', 'the mission is not a campaign ticket mission');
    return g.report('backward', root);
  }
  g.edge(m.id, g.node({ type: 'work-item', id: m.workItemId, label: 'work item' }).id, 'consumed-by');
  const t = ctx.store.campaignTicketByWorkItem(m.workItemId);
  if (!t) {
    g.gap(m.workItemId, 'ticket', 'no campaign ticket names this work item');
    return g.report('backward', root);
  }
  const tn = g.node({ type: 'ticket', id: `${t.campaignId}:${t.ticketId}`, label: `ticket ${t.ticketId}` });
  g.edge(m.workItemId, tn.id, 'ticket-work-item');
  backwardFromTicket(ctx, g, t.campaignId, t.ticketId, tn.id);
  return g.report('backward', root);
}

/**
 * One row per record a campaign's tickets trace, plus every approved invariant of those corpora
 * (so an untraced invariant shows as a gap), with the evidence it reached; tickets with no trace
 * rows (a v1 plan, a hand-written ticket) are listed as untraced. The chain is `authorityChainOf`.
 */
export function traceMatrix(ctx: DaylightContext, campaignId: string): TraceMatrix {
  const c = ctx.store.mission(campaignId);
  if (!c || c.kind !== 'campaign') throw new Error(`${campaignId} is not a campaign`);
  const chain: AuthorityChain = authorityChainOf(ctx, campaignId);
  const trace = ctx.store.ticketTrace(campaignId);
  const untracedTickets = ctx.store.campaignTickets(campaignId).filter((t) => !trace.some((r) => r.ticketId === t.ticketId)).map((t) => t.ticketId);
  const irIds = new Set(trace.map((r) => r.irId));
  const corpora = new Set([...irIds].map((id) => ctx.store.irRecord(id)?.corpusId).filter((x): x is string => !!x));
  for (const corpusId of corpora) for (const r of ctx.store.irRecords(corpusId, { status: 'approved', kind: 'invariant' })) irIds.add(r.id);
  const lock = campaignLockOf(ctx, campaignId);
  const boundTickets = new Set(Object.values(lock?.scope.obligations ?? {}).flat().map((o) => o.split(':')[0]));
  const rows: TraceMatrix['rows'] = [];
  for (const id of [...irIds].sort()) {
    const r = ctx.store.irRecord(id);
    if (!r) continue;
    const mine = trace.filter((x) => x.irId === id);
    const tickets = [...new Set(mine.map((x) => x.ticketId))].sort();
    const components = [...new Set(ctx.store.derivationsOfIr(id).filter((d) => ctx.store.blueprint(d.blueprintId)?.status === 'approved'
      && (d.role === 'requirement' || d.role === 'constraint' || d.role === 'interface')).map((d) => d.elementId))].sort();
    const gaps: string[] = [];
    if (!components.length) gaps.push('no blueprint element');
    if (!tickets.length) gaps.push('no ticket');
    let evidence: TraceMatrix['rows'][number]['evidence'] = 'none';
    if (isStale(ctx, r)) evidence = 'stale';
    else {
      for (const tid of tickets) {
        const t = ctx.store.campaignTicket(campaignId, tid);
        const missions = t ? ctx.store.missions(c.projectId).filter((m) => m.parentId === campaignId && m.workItemId === t.workItemId) : [];
        for (const i of missions.flatMap((m) => ctx.store.integrations(campaignId, { missionId: m.id, state: 'integrated' }))) {
          const evals = ctx.store.gateEvaluations({ integrationId: i.id });
          if (evals.length && evals.every((e) => e.conclusion === 'supported')) evidence = 'landed-gates-pass';
          else if (evidence !== 'landed-gates-pass') evidence = 'landed';
        }
        if (evidence === 'none' && boundTickets.has(tid) && mine.some((x) => x.ticketId === tid && x.role === 'obligation')) evidence = 'gate-bound';
      }
      if (evidence === 'none' && tickets.length) gaps.push('no landing and no gate bound to an obligation');
    }
    const rev = r.span ? ctx.store.corpusRevision(r.span.revisionId) : null;
    const label = rev && r.span ? sectionsOf(indexOf(ctx, rev), r.span.docKey).find((s) => s.id === r.span!.sectionId)?.label ?? null : null;
    rows.push({ irId: id, kind: r.kind, label, tags: r.attrs.tags ?? [], components, tickets, evidence, gaps });
  }
  return { kind: 'daylight-trace-matrix', v: 1, campaignId, chain, untracedTickets, rows };
}

const esc = (s: string) => s.replace(/[|\\`*_[\]<>]/g, (ch) => `\\${ch}`);

const NODE_ORDER: TraceNodeType[] = ['document', 'section', 'unit', 'ir', 'boundary', 'component', 'interface', 'packet', 'ticket', 'work-item', 'mission',
  'candidate', 'gate-evaluation', 'integration', 'application', 'assumption', 'finding'];

/**
 * Markdown for a person. Excerpts come only from `excerpt` (pass `safeExcerpt`, which returns null
 * for a holdout basename or a secret-shaped span); a withheld excerpt is counted, never shown. No
 * record statement is printed (P2-R40).
 */
export function renderTraceMarkdown(r: TraceReport | TraceMatrix, excerpt: (s: SpanRef) => string | null): string {
  const out: string[] = [];
  if (r.kind === 'daylight-trace-matrix') {
    out.push(`# Trace matrix: ${r.campaignId}`, '');
    if (r.chain.breaks.length) out.push(`Authority chain breaks: ${r.chain.breaks.map((b) => `${b.link} (${esc(b.why)})`).join('; ')}`, '');
    out.push('| record | kind | label | tags | components | tickets | evidence | gaps |', '|---|---|---|---|---|---|---|---|');
    for (const row of r.rows) {
      out.push(`| ${row.irId} | ${row.kind} | ${esc(row.label ?? '')} | ${row.tags.join(', ')} | ${row.components.join(', ')} | ${row.tickets.join(', ')} | ${row.evidence} | ${esc(row.gaps.join('; '))} |`);
    }
    if (r.untracedTickets.length) out.push('', `Untraced tickets: ${r.untracedTickets.join(', ')}`);
    return `${out.join('\n')}\n`;
  }
  out.push(`# Trace (${r.direction}) from ${r.root.type} ${esc(r.root.label)}`, '',
    `Quotes re-hashed: ${r.verified.quotesRehashed}; mismatches: ${r.verified.mismatches.length ? r.verified.mismatches.join(', ') : 'none'}`, '');
  let withheld = 0;
  for (const type of NODE_ORDER) {
    const nodes = r.nodes.filter((n) => n.type === type);
    if (!nodes.length) continue;
    out.push(`## ${type}`, '');
    for (const n of nodes) {
      out.push(`- \`${n.id}\` ${esc(n.label)}${n.status ? ` [${n.status}]` : ''}${n.stale ? ' **stale**' : ''}`);
      const s = spanOfNodeId(n.id);
      if (!s) continue;
      const sectionId = r.edges.find((e) => e.from === n.id && e.via === 'span-overlap')?.to ?? '';
      const x = excerpt({ docKey: s.docKey, sectionId, start: s.start, end: s.end });
      if (x === null) withheld++;
      else out.push(`  > ${x.replace(/\n/g, ' ')}`);
    }
    out.push('');
  }
  if (withheld) out.push(`${withheld} passage excerpt(s) withheld.`, '');
  if (r.gaps.length) {
    out.push('## gaps', '');
    for (const gp of r.gaps) out.push(`- \`${gp.at}\` missing ${gp.missing}: ${esc(gp.why)}`);
    out.push('');
  }
  return out.join('\n');
}
