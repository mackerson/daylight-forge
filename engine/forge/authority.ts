import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import type { DaylightContext } from '../mission/context.ts';
import type {
  AuthorityChain, Blueprint, CarryStatus, CorpusDiff, CorpusRevision, IrRecord, IrSpanRef, IrSpanRow, Mission, Need, PacketRow, PlanFile, Section,
  SectionIndex, WorkPacket,
} from '../mission/types.ts';
import { registerCorpus } from './corpus.ts';
import { isPlanRefusals, parsePlan } from './plan.ts';

/**
 * The authority chain and derived invalidation (spec ingestion §9; P2-R53). WS-R15.
 *
 * Every link carries the digest of the one before it: corpus → section index → approved IR
 * (`irSetDigest`) → blueprint → packets (`packetSetDigest`) → plan digest → envelope. A person
 * approves at each human link; nothing here approves anything.
 *
 * **Staleness is derived, never written.** A record is stale at a revision when it has no
 * `ir_spans` row there for a role it has; a revision adds rows (`carryForward`) and changes none.
 * Blueprints, packets and tickets citing a stale record are stale by reading, not by a status.
 *
 * The low-level readers the other ingest modules share live here (a revision's index and bytes,
 * quote search, a packet's body, a campaign's plan file), so this file imports none of them.
 */

type PacketBody = Omit<WorkPacket, 'id' | 'packetDigest' | 'status'>;

// ---- shared readers ----------------------------------------------------------------------

export interface RevisionMaterial {
  rev: CorpusRevision;
  index: SectionIndex;
  sections: ReadonlyMap<string, Section>;
  /** A document's bytes at this revision, re-verified against the digest the revision recorded. */
  bytesOf(key: string): Buffer;
  hasDoc(key: string): boolean;
}

/** A revision's section index and documents, read from their artifacts and re-verified. */
export function revisionMaterial(ctx: DaylightContext, revisionId: string): RevisionMaterial {
  const rev = ctx.store.corpusRevision(revisionId);
  if (!rev) throw new Error(`unknown corpus revision ${revisionId}`);
  const index = JSON.parse(ctx.artifacts.get(rev.sectionIndex).toString('utf8')) as SectionIndex;
  if (!index || index.v !== 2 || !Array.isArray(index.docs) || !Array.isArray(index.sentences)) {
    throw new Error(`corpus revision ${rev.id}: its section index is not a version-2 index`);
  }
  const docs = new Map(rev.docs.map((d) => [d.key, d]));
  const cache = new Map<string, Buffer>();
  const sections = new Map(index.docs.flatMap((d) => d.sections.map((s) => [s.id, s] as const)));
  return {
    rev, index, sections,
    hasDoc: (key) => docs.has(key),
    bytesOf: (key) => {
      const hit = cache.get(key);
      if (hit) return hit;
      const doc = docs.get(key);
      if (!doc) throw new Error(`corpus revision ${rev.id} has no document ${key}`);
      const bytes = ctx.artifacts.get(doc.artifact);
      if (digestOf(bytes) !== doc.digest) throw new Error(`corpus revision ${rev.id}: document ${key} does not match its recorded digest`);
      cache.set(key, bytes);
      return bytes;
    },
  };
}

/** The digest a span row records for its quote: over the quote's UTF-8 bytes. */
export const quoteDigestOf = (quote: string): string => digestOf(Buffer.from(quote, 'utf8'));

/** Every byte offset at which `needle` occurs in `hay`, overlapping occurrences included. */
export function occurrencesIn(hay: Buffer, needle: Buffer): number[] {
  const out: number[] = [];
  if (!needle.length) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** The deepest section of `docKey` whose extent holds `[start, end)`, or null. */
export function sectionAt(index: SectionIndex, docKey: string, start: number, end: number): Section | null {
  const doc = index.docs.find((d) => d.key === docKey);
  let best: Section | null = null;
  for (const s of doc?.sections ?? []) if (s.start <= start && end <= s.end && (!best || s.level > best.level)) best = s;
  return best;
}

/** A packet's body, read from its artifact. */
export function packetBodyOf(ctx: DaylightContext, row: PacketRow): PacketBody {
  return JSON.parse(ctx.artifacts.get(row.bodyArtifact).toString('utf8')) as PacketBody;
}

/** Every IR id a packet body cites. */
export function packetIrIds(p: Pick<PacketBody, 'requirementIds' | 'interfaceContracts' | 'artifacts' | 'acceptanceObligations'>): string[] {
  return [...new Set([
    ...p.requirementIds, ...p.interfaceContracts.flatMap((c) => c.irIds), ...p.artifacts.flatMap((a) => a.irIds),
    ...p.acceptanceObligations.flatMap((o) => o.irIds),
  ])];
}

/** `sha256` over the sorted `<ticketId>:<packetDigest>` lines (§8.1). */
export const packetSetDigestOf = (pairs: ReadonlyArray<{ ticketId: string; packetDigest: string }>): string =>
  digestOf(pairs.map((p) => `${p.ticketId}:${p.packetDigest}`).sort().join('\n'));

/** The plan a campaign was last imported at, from its artifact; null when it has none or it no longer parses. */
export function planFileOf(ctx: Pick<DaylightContext, 'store' | 'artifacts'>, campaignId: string): { plan: PlanFile; planDigest: string } | null {
  const at = ctx.store.currentPlan(campaignId);
  const ref = at ? ctx.store.artifact(at.planArtifact) : null;
  if (!at || !ref) return null;
  const parsed = parsePlan(ctx.artifacts.get(ref));
  return isPlanRefusals(parsed) ? null : { plan: parsed, planDigest: at.planDigest };
}

/** Every IR id a plan ticket cites, by role, for `ticket_trace`. */
export function ticketIrRefs(t: PlanFile['tickets'][number]): Array<{ irId: string; role: 'requirement' | 'obligation' | 'interface' | 'artifact'; detail: string | null }> {
  return [
    ...(t.requirementIds ?? []).map((irId) => ({ irId, role: 'requirement' as const, detail: null })),
    ...(t.acceptanceObligations ?? []).flatMap((o) => o.irIds.map((irId) => ({ irId, role: 'obligation' as const, detail: o.id }))),
    ...(t.interfaceContracts ?? []).flatMap((c) => c.irIds.map((irId) => ({ irId, role: 'interface' as const, detail: `${c.interfaceId}:${c.role}` }))),
    ...(t.artifacts ?? []).flatMap((a) => a.irIds.map((irId) => ({ irId, role: 'artifact' as const, detail: a.path }))),
  ];
}

// ---- staleness ---------------------------------------------------------------------------

/**
 * No `ir_spans` row at the revision (default: its corpus's current one) for a role the record has.
 * An inferred record rests on sections, not a quote, and has no span to lose: never stale here.
 */
export function isIrStale(ctx: DaylightContext, irId: string, revisionId?: string): boolean {
  const r = ctx.store.irRecord(irId, revisionId);
  if (!r) throw new Error(`unknown IR record ${irId}`);
  return recordStale(ctx, r, revisionId);
}

/** Section ids of a revision's index; indexes are immutable artifacts, so this is cached by their digest. */
const sectionIdsCache = new Map<string, Set<string>>();
function sectionIdsAt(ctx: DaylightContext, revisionId: string): Set<string> {
  const rev = ctx.store.corpusRevision(revisionId);
  if (!rev) return new Set();
  const hit = sectionIdsCache.get(rev.sectionIndex.digest);
  if (hit) return hit;
  const ids = new Set(revisionMaterial(ctx, revisionId).sections.keys());
  sectionIdsCache.set(rev.sectionIndex.digest, ids);
  return ids;
}

/**
 * An extracted record is stale where it lacks a span for a role it has. An inferred record has no
 * span: its staleness follows its basis sections, stale only when every one of them is gone from
 * the revision's index (one with no basis rests on a decided interpretation and does not go stale).
 */
function recordStale(ctx: DaylightContext, r: IrRecord, revisionId?: string): boolean {
  if (r.source === 'inferred' && r.span === null && !ctx.store.irSpans(r.id).length) {
    if (!r.basisSections.length) return false;
    const rev = revisionId ?? ctx.store.currentCorpusRevision(r.corpusId)?.id;
    if (!rev) return false;
    const ids = sectionIdsAt(ctx, rev);
    return r.basisSections.every((s) => !ids.has(s));
  }
  if (r.span === null) return true;
  return r.other === null && ctx.store.irSpans(r.id).some((s) => s.role === 'other');
}

/** Whether an approved record enters the IR set at a revision (§6.2): it has a span there. WS-R14's `coverageOf` uses the same rule. */
export const inIrSet = (r: Pick<IrRecord, 'span' | 'other'>): boolean => r.span !== null || r.other !== null;

/**
 * `sha256` over the sorted `<id>:<contentDigest>` lines of the corpus's approved records with a
 * span at the revision (§6.2), or null when there are none: the value `coverageOf` reports.
 * Offsets and section ids never enter it, so a rename or a move does not change it; a record
 * losing its span does. Inferred records (no span) are not in it.
 */
export function irSetDigestAt(ctx: DaylightContext, corpusId: string, revisionId?: string): string | null {
  const rev = revisionId ?? ctx.store.currentCorpusRevision(corpusId)?.id;
  if (!rev) return null;
  const lines = ctx.store.irRecords(corpusId, { status: 'approved', revisionId: rev }).filter(inIrSet).map((r) => `${r.id}:${r.contentDigest}`).sort();
  return lines.length ? digestOf(lines.join('\n')) : null;
}

/** IR ids a blueprint body names anywhere. */
export function blueprintIrIds(b: Blueprint['body']): string[] {
  return [...new Set([
    ...b.boundaries.flatMap((x) => [...x.bounds, ...x.invariants]), ...b.components.flatMap((c) => c.requirements),
    ...b.interfaces.flatMap((i) => i.irIds), ...b.constraints.flatMap((c) => c.irIds), ...b.deferred.map((d) => d.irId),
    ...b.outOfScope.map((o) => o.irId),
  ])];
}

function staleAt(ctx: DaylightContext, ids: Iterable<string>, revisionId?: string): string[] {
  return [...new Set(ids)].filter((id) => ctx.store.irRecord(id) !== null && isIrStale(ctx, id, revisionId)).sort();
}

function blueprintStale(ctx: DaylightContext, b: Blueprint, revisionId?: string): boolean {
  if (b.status !== 'proposed' && b.status !== 'approved') return false;
  if (b.body.irSetDigest !== irSetDigestAt(ctx, b.corpusId, revisionId)) return true;
  const ids = b.status === 'approved' ? ctx.store.derivations(b.id).map((d) => d.irId) : blueprintIrIds(b.body);
  return staleAt(ctx, ids, revisionId).length > 0;
}

/** Proposed or approved blueprints whose IR set moved, or that cite a stale record. */
export function staleBlueprints(ctx: DaylightContext, corpusId: string): Set<string> {
  return new Set(ctx.store.blueprints(corpusId).filter((b) => blueprintStale(ctx, b)).map((b) => b.id));
}

function packetsStale(ctx: DaylightContext, b: Blueprint, revisionId?: string): string[] {
  const all = ctx.store.packets(b.id).filter((p) => p.status !== 'superseded');
  if (blueprintStale(ctx, b, revisionId)) return all.map((p) => p.id);
  return all.filter((p) => staleAt(ctx, packetIrIds(packetBodyOf(ctx, p)), revisionId).length).map((p) => p.id);
}

/** Every live packet of a stale blueprint, and every packet citing a stale record. */
export function stalePackets(ctx: DaylightContext, blueprintId: string): Set<string> {
  const b = ctx.store.blueprint(blueprintId);
  if (!b) throw new Error(`unknown blueprint ${blueprintId}`);
  return new Set(packetsStale(ctx, b));
}

/** Ticket id → the stale IR ids it traces to (`ticket_trace`). The director derives `TicketStatus 'stale'` from this. */
export function staleTickets(ctx: DaylightContext, campaignId: string): Map<string, string[]> {
  const byTicket = new Map<string, Set<string>>();
  for (const t of ctx.store.ticketTrace(campaignId)) (byTicket.get(t.ticketId) ?? byTicket.set(t.ticketId, new Set()).get(t.ticketId)!).add(t.irId);
  const out = new Map<string, string[]>();
  for (const [ticketId, ids] of byTicket) {
    const stale = staleAt(ctx, ids);
    if (stale.length) out.set(ticketId, stale);
  }
  return out;
}

function ticketState(ctx: DaylightContext, campaignId: string, workItemId: string): 'unconsumed' | 'in-flight' | 'landed' {
  const by = ctx.store.workItemConsumer(workItemId);
  if (!by) return 'unconsumed';
  return ctx.store.integrations(campaignId, { state: 'integrated', missionId: by }).length ? 'landed' : 'in-flight';
}

/** Lock obligations (`<ticketId>:<obId>`) whose IR records are stale, per locked experiment. */
function staleGates(ctx: DaylightContext, campaignId: string, staleIds: ReadonlySet<string>): CorpusDiff['invalidated']['gates'] {
  const lock = ctx.store.campaignLockDecision(campaignId);
  const obligations = (lock?.scope.obligations ?? {}) as Record<string, string[]>;
  const plan = planFileOf(ctx, campaignId)?.plan;
  if (!plan || !Object.keys(obligations).length) return [];
  const irsOf = new Map<string, string[]>(plan.tickets.flatMap((t) => (t.acceptanceObligations ?? []).map((o) => [`${t.id}:${o.id}`, o.irIds] as const)));
  return Object.entries(obligations).map(([experimentId, obs]) => ({
    campaignId, experimentId, obligations: obs.filter((ob) => (irsOf.get(ob) ?? []).some((id) => staleIds.has(id))).sort(),
  })).filter((g) => g.obligations.length).sort((a, b) => (a.experimentId < b.experimentId ? -1 : 1));
}

// ---- carrying records to a new revision --------------------------------------------------

type Role = 'primary' | 'other';
type Reason = CorpusDiff['records'][number]['reason'];
interface RoleOutcome { role: Role; status: CarryStatus; row: IrSpanRow | null; reason: Reason }

const unitsOf = (m: RevisionMaterial, sectionId: string): string => {
  const s = m.sections.get(sectionId);
  if (!s) return '';
  const bytes = m.bytesOf(s.docKey);
  return m.index.sentences.filter((u) => u.sectionId === sectionId).map((u) => bytes.subarray(u.start, u.end).toString('utf8')).sort().join('\n');
};

/** Sections whose text an overriding record's span sits in, at `from`, changed or vanished at `to`. */
function overriderChanged(ctx: DaylightContext, r: IrRecord, from: RevisionMaterial, to: RevisionMaterial): boolean {
  for (const l of ctx.store.irLinks(r.id)) {
    if (l.kind !== 'overrides' || l.toIr !== r.id) continue;
    const o = ctx.store.irRecord(l.fromIr, from.rev.id)?.span;
    if (!o) continue;
    const was = from.sections.get(o.sectionId);
    const now = to.sections.get(o.sectionId);
    if (!was || !now || was.bodyDigest !== now.bodyDigest) return true;
  }
  return false;
}

/**
 * Where one role of a record lands at `to` (§9): the quote at the same bytes in the same section →
 * `carried` (or `review` when that section gained or lost a scored unit, or an overriding section
 * changed); else the quote occurring exactly once anywhere in the same document → `moved` to the
 * section holding it (`section-changed` when that is another section: a split keeps its record);
 * else `stale`, with no row.
 */
function classify(ctx: DaylightContext, r: IrRecord, span: IrSpanRef, role: Role, from: RevisionMaterial, to: RevisionMaterial): RoleOutcome {
  const stale = (reason: Reason): RoleOutcome => ({ role, status: 'stale', row: null, reason });
  if (!to.hasDoc(span.docKey)) return stale('quote-missing');
  const bytes = to.bytesOf(span.docKey);
  const quote = Buffer.from(span.quote, 'utf8');
  const row = (start: number, sectionId: string, carry: IrSpanRow['carry']): IrSpanRow => ({
    irId: r.id, revisionId: to.rev.id, role, docKey: span.docKey, sectionId, start, end: start + quote.length, quoteDigest: span.quoteDigest, carry,
  });
  const configChanged = from.rev.configDigest !== to.rev.configDigest;
  const same = to.sections.get(span.sectionId);
  if (same && span.end <= bytes.length && bytes.subarray(span.start, span.end).equals(quote) && same.start <= span.start && span.end <= same.end) {
    if (overriderChanged(ctx, r, from, to)) return { role, status: 'review', row: row(span.start, span.sectionId, 'review'), reason: 'overriding-doc-changed' };
    if (unitsOf(from, span.sectionId) !== unitsOf(to, span.sectionId)) {
      return { role, status: 'review', row: row(span.start, span.sectionId, 'review'), reason: 'section-changed' };
    }
    return { role, status: 'carried', row: row(span.start, span.sectionId, 'carried'), reason: configChanged ? 'config-changed' : null };
  }
  const at = occurrencesIn(bytes, quote);
  if (at.length > 1) return stale('quote-ambiguous');
  if (at.length === 0) return stale(same ? 'quote-missing' : 'section-removed');
  const holder = sectionAt(to.index, span.docKey, at[0], at[0] + quote.length);
  if (!holder) return stale('section-removed');
  if (overriderChanged(ctx, r, from, to)) return { role, status: 'review', row: row(at[0], holder.id, 'review'), reason: 'overriding-doc-changed' };
  return { role, status: 'moved', row: row(at[0], holder.id, 'moved'), reason: holder.id !== span.sectionId ? 'section-changed' : configChanged ? 'config-changed' : null };
}

const RANK: Record<CarryStatus, number> = { carried: 0, moved: 1, review: 2, stale: 3 };

/** Each role a record had at `from`, classified at `to`. */
function outcomeOf(ctx: DaylightContext, r: IrRecord, from: RevisionMaterial, to: RevisionMaterial): RoleOutcome[] {
  return ([['primary', r.span], ['other', r.other]] as const).filter(([, s]) => s !== null)
    .map(([role, s]) => classify(ctx, r, s!, role, from, to));
}

/**
 * Add the span rows a new revision earns (§9) and nothing else: at most one row per role per
 * record, for records neither rejected nor superseded that had that role at `from`. No existing
 * row of any table changes. Returns what each record became (its worst role).
 */
export function carryForward(ctx: DaylightContext, corpusId: string, fromRevision: string, toRevision: string): CorpusDiff['records'] {
  const from = revisionMaterial(ctx, fromRevision);
  const to = revisionMaterial(ctx, toRevision);
  if (from.rev.corpusId !== corpusId || to.rev.corpusId !== corpusId) throw new Error(`both revisions must belong to corpus ${corpusId}`);
  const out: CorpusDiff['records'] = [];
  ctx.store.tx(() => {
    for (const r of ctx.store.irRecords(corpusId, { revisionId: from.rev.id })) {
      if (r.status === 'rejected' || r.status === 'superseded') continue;
      const roles = outcomeOf(ctx, r, from, to);
      if (!roles.length) continue;
      for (const o of roles) if (o.row) ctx.store.insertIrSpan(o.row);
      out.push(summarise(r.id, roles));
    }
  });
  return out;
}

function summarise(irId: string, roles: RoleOutcome[]): CorpusDiff['records'][number] {
  const worst = [...roles].sort((a, b) => RANK[b.status] - RANK[a.status])[0];
  const primary = roles.find((o) => o.role === 'primary')?.row ?? null;
  return {
    irId, status: worst.status, reason: worst.reason,
    to: worst.status === 'stale' || !primary ? null : {
      revisionId: primary.revisionId, docKey: primary.docKey, sectionId: primary.sectionId, start: primary.start, end: primary.end, quote: '',
      quoteDigest: primary.quoteDigest,
    },
  };
}

// ---- diff, revise --------------------------------------------------------------------------

/**
 * What changed between two revisions of a corpus, and what that invalidates, from rows: a record
 * with rows at `to` is what its rows say; one without is stale, with the reason the carry rule
 * gives. Read-only. (`to.quote` is left empty: the diff names spans, it does not repeat text.)
 */
export function diffCorpus(ctx: DaylightContext, corpusId: string, fromRevision: string, toRevision: string): CorpusDiff {
  const corpus = ctx.store.mission(corpusId);
  if (!corpus || corpus.kind !== 'corpus') throw new Error(`${corpusId} is not a corpus mission`);
  const from = revisionMaterial(ctx, fromRevision);
  const to = revisionMaterial(ctx, toRevision);
  if (from.rev.corpusId !== corpusId || to.rev.corpusId !== corpusId) throw new Error(`both revisions must belong to corpus ${corpusId}`);

  const fromDocs = new Map(from.rev.docs.map((d) => [d.key, d.digest]));
  const toDocs = new Map(to.rev.docs.map((d) => [d.key, d.digest]));
  const docs = [...new Set([...fromDocs.keys(), ...toDocs.keys()])].sort()
    .map((key) => ({ key, from: fromDocs.get(key) ?? null, to: toDocs.get(key) ?? null }));

  let added = [...to.sections.keys()].filter((id) => !from.sections.has(id)).sort();
  let removed = [...from.sections.keys()].filter((id) => !to.sections.has(id)).sort();
  const changed = [...to.sections.keys()].filter((id) => from.sections.has(id) && from.sections.get(id)!.bodyDigest !== to.sections.get(id)!.bodyDigest).sort();
  const renamed: Array<{ from: string; to: string }> = [];
  for (const r of removed) {
    const digest = from.sections.get(r)!.bodyDigest;
    const hits = added.filter((a) => to.sections.get(a)!.bodyDigest === digest);
    const back = removed.filter((x) => from.sections.get(x)!.bodyDigest === digest);
    if (hits.length === 1 && back.length === 1) renamed.push({ from: r, to: hits[0] });
  }
  added = added.filter((a) => !renamed.some((x) => x.to === a));
  removed = removed.filter((r) => !renamed.some((x) => x.from === r));

  const records: CorpusDiff['records'] = [];
  for (const r of ctx.store.irRecords(corpusId, { revisionId: from.rev.id })) {
    if (r.status === 'rejected' || r.status === 'superseded') continue;
    const rows = ctx.store.irSpans(r.id).filter((s) => s.revisionId === to.rev.id);
    const roles = outcomeOf(ctx, r, from, to).map((o): RoleOutcome => {
      const have = rows.find((s) => s.role === o.role);
      if (!have) return { ...o, status: 'stale', row: null, reason: o.status === 'stale' ? o.reason : null };
      const status: CarryStatus = have.carry === 'proposed' ? 'carried' : have.carry;
      return { ...o, status, row: have, reason: status === o.status ? o.reason : null };
    });
    if (roles.length) records.push(summarise(r.id, roles));
  }

  const staleIds = new Set(records.filter((x) => x.status === 'stale').map((x) => x.irId));
  const blueprints = ctx.store.blueprints(corpusId);
  const tickets = new Map<string, CorpusDiff['invalidated']['tickets'][number]>();
  for (const id of staleIds) {
    for (const t of ctx.store.ticketsTracing(id)) {
      const key = `${t.campaignId}\u0000${t.ticketId}`;
      const row = ctx.store.campaignTicket(t.campaignId, t.ticketId);
      if (!row) continue;
      const entry = tickets.get(key)
        ?? { campaignId: t.campaignId, ticketId: t.ticketId, workItemId: row.workItemId, state: ticketState(ctx, t.campaignId, row.workItemId), irIds: [] };
      if (!entry.irIds.includes(id)) entry.irIds.push(id);
      tickets.set(key, entry);
    }
  }
  const campaigns = [...new Set([...tickets.values()].map((t) => t.campaignId))].sort();
  return {
    kind: 'daylight-corpus-diff', corpusId, from: from.rev.id, to: to.rev.id, docs,
    sections: { added, removed, changed, renamed },
    records: records.sort((a, b) => (a.irId < b.irId ? -1 : 1)),
    invalidated: {
      blueprints: blueprints.filter((b) => blueprintStale(ctx, b, to.rev.id)).map((b) => b.id).sort(),
      packets: blueprints.flatMap((b) => packetsStale(ctx, b, to.rev.id)).sort(),
      assumptions: ctx.store.assumptions(corpusId).filter((a) => a.irId && staleIds.has(a.irId)).map((a) => a.id).sort(),
      tickets: [...tickets.values()].map((t) => ({ ...t, irIds: t.irIds.sort() }))
        .sort((a, b) => (a.campaignId + a.ticketId < b.campaignId + b.ticketId ? -1 : 1)),
      gates: campaigns.flatMap((c) => staleGates(ctx, c, staleIds)),
    },
  };
}

/**
 * `corpus revise`: register the corpus again at `rev` (each project at its own), as the next
 * revision of the same corpus mission, then carry every record forward (`carryForward`) and
 * report the diff. Nothing existing is rewritten; recovery is a person's (§9).
 *
 * The revision itself is built by WS-R14's `registerCorpus` given the corpus id (the one build of
 * manifest, documents and index, so there are not two).
 */
export function reviseCorpus(ctx: DaylightContext, repo: string, corpusId: string, o: { rev?: string; projects?: Record<string, string>; manifest?: string }):
  { revision: CorpusRevision; diff: CorpusDiff } {
  const corpus = ctx.store.mission(corpusId);
  if (!corpus || corpus.kind !== 'corpus') throw new Error(`${corpusId} is not a corpus mission`);
  const before = ctx.store.currentCorpusRevision(corpusId);
  if (!before) throw new Error(`corpus ${corpusId} has no revision to revise`);
  const options: { rev?: string; projects?: Record<string, string>; corpusId: string } = { rev: o.rev, projects: o.projects, corpusId };
  const revision = registerCorpus(ctx, repo, o.manifest ?? before.manifestPath, options);
  if (revision.corpusId !== corpusId) throw new Error(`corpus revise registered ${revision.corpusId}, not a revision of ${corpusId}`);
  if (revision.id === before.id) return { revision, diff: diffCorpus(ctx, corpusId, before.id, before.id) };
  carryForward(ctx, corpusId, before.id, revision.id);
  const diff = diffCorpus(ctx, corpusId, before.id, revision.id);
  ctx.events.append({
    projectId: corpus.projectId, missionId: corpus.id, actorId: 'daylight', category: 'lifecycle', name: 'corpus.revised',
    payload: {
      from: before.id, to: revision.id, corpusDigest: revision.corpusDigest,
      records: Object.fromEntries((['carried', 'moved', 'review', 'stale'] as const).map((s) => [s, diff.records.filter((r) => r.status === s).length])),
      blueprints: diff.invalidated.blueprints.length, packets: diff.invalidated.packets.length, tickets: diff.invalidated.tickets.length,
      gates: diff.invalidated.gates.length, assumptions: diff.invalidated.assumptions.length,
    },
  });
  return { revision, diff };
}

// ---- the chain -----------------------------------------------------------------------------

/**
 * The campaign's authority chain, every link re-derived from rows and artifacts, with the links
 * that do not hold. A version-1 plan has no chain (empty digests, no breaks): untraced, not broken.
 */
export function authorityChainOf(ctx: DaylightContext, campaignId: string, o: { acceptIrDrift?: string | null; ticketIds?: readonly string[] } = {}): AuthorityChain {
  const chain: AuthorityChain = {
    corpusDigest: '', sectionSetDigest: '', configDigest: '', irVersions: [], irSetDigest: null, blueprintId: null, blueprintDigest: null,
    packetSetDigest: null, planDigest: null, approvePlanDecisionId: null, authorizeDecisionId: null, lockDecisionId: null, breaks: [],
  };
  const c = ctx.store.mission(campaignId);
  if (!c || c.kind !== 'campaign') throw new Error(`${campaignId} is not a campaign mission`);
  const at = planFileOf(ctx, campaignId);
  const br = (link: AuthorityChain['breaks'][number]['link'], why: string) => chain.breaks.push({ link, why });
  if (!at) return chain;
  chain.planDigest = at.planDigest;
  const approve = ctx.store.latestDecision(campaignId, 'approve-plan');
  chain.approvePlanDecisionId = approve?.scope.planDigest === at.planDigest ? approve.id : null;
  const auth = ctx.store.campaignAuthorization(campaignId);
  chain.authorizeDecisionId = auth?.id ?? null;
  chain.lockDecisionId = ctx.store.campaignLockDecision(campaignId)?.id ?? null;
  const d = at.plan.derivation;
  if (!d) return chain;

  chain.corpusDigest = d.corpusDigest;
  chain.irSetDigest = d.irSetDigest;
  chain.blueprintId = d.blueprintId;
  chain.blueprintDigest = d.blueprintDigest;
  chain.packetSetDigest = d.packetSetDigest;

  const corpus = ctx.store.mission(d.corpusId);
  const rev = corpus?.kind === 'corpus' && corpus.projectId === c.projectId ? ctx.store.corpusRevisionByDigest(d.corpusId, d.corpusDigest) : null;
  if (!rev) br('corpus', `no revision of corpus ${d.corpusId} has digest ${d.corpusDigest}`);
  else {
    chain.sectionSetDigest = rev.sectionSetDigest;
    chain.configDigest = rev.configDigest;
    try {
      revisionMaterial(ctx, rev.id);
    } catch (err) {
      br('sections', (err as Error).message);
    }
  }
  const cited = [...new Set(at.plan.tickets.flatMap((t) => ticketIrRefs(t).map((x) => x.irId)))];
  chain.irVersions = [...new Set(cited.map((id) => ctx.store.irRecord(id)?.irVersion).filter((v): v is string => !!v))].sort();
  const irApproved = corpus ? ctx.store.decisions(corpus.id).some((x) => x.scope.operation === 'approve-ir' && x.scope.irSetDigest === d.irSetDigest) : false;
  if (!irApproved) br('ir', `no approve-ir decision on corpus ${d.corpusId} names IR set ${d.irSetDigest}`);
  // P2-R59: the specification must still be the one the plan was derived from, or a person accepts the drift by its digest.
  const envScope = (auth?.scope ?? {}) as { acceptIrDrift?: unknown; ticketIds?: unknown };
  const accept = o.acceptIrDrift !== undefined ? o.acceptIrDrift : typeof envScope.acceptIrDrift === 'string' ? envScope.acceptIrDrift : null;
  const tickets = new Set(o.ticketIds ?? (Array.isArray(envScope.ticketIds) ? envScope.ticketIds as string[] : at.plan.tickets.map((t) => t.id)));
  const current = (corpus ? irSetDigestAt(ctx, corpus.id) : null) ?? digestOf('');
  const staleCited = corpus ? staleAt(ctx, cited.filter((id) => ctx.store.irRecord(id)?.corpusId === corpus.id)) : [];
  const bpStale = corpus ? staleBlueprints(ctx, corpus.id).has(d.blueprintId) : false;
  const staleTix = [...staleTickets(ctx, campaignId).keys()].filter((t) => tickets.has(t)).sort();
  if ((current !== d.irSetDigest || staleCited.length || bpStale || staleTix.length) && accept !== current) {
    br('ir', `the specification moved under this plan: the approved IR set is ${current}, the plan was derived from ${d.irSetDigest}`
      + (staleCited.length ? `; stale records ${staleCited.join(', ')}` : '') + (bpStale ? `; blueprint ${d.blueprintId} is stale` : '')
      + (staleTix.length ? `; stale tickets ${staleTix.join(', ')}` : '')
      + `; re-derive the plan, or a person proceeds with \`campaign authorize --accept-ir-drift ${current}\``);
  }

  const bp = ctx.store.blueprint(d.blueprintId);
  if (!bp || bp.corpusId !== d.corpusId) br('blueprint', `blueprint ${d.blueprintId} is not a blueprint of corpus ${d.corpusId}`);
  else {
    const bpDecision = bp.decisionId ? ctx.store.decision(bp.decisionId) : null;
    if (bp.status !== 'approved') br('blueprint', `blueprint ${bp.id} is ${bp.status}, not approved`);
    else if (bp.blueprintDigest !== d.blueprintDigest || digestOf(canonicalJson(bp.body)) !== bp.blueprintDigest) {
      br('blueprint', `blueprint ${bp.id}'s body does not hash to the digest the plan names`);
    } else if (bpDecision?.scope.operation !== 'approve-blueprint' || bpDecision.scope.blueprintDigest !== d.blueprintDigest) {
      br('blueprint', `blueprint ${bp.id}'s approval does not name digest ${d.blueprintDigest}`);
    } else if (bp.body.irSetDigest !== d.irSetDigest) br('ir', `blueprint ${bp.id} was drawn over IR set ${bp.body.irSetDigest}, not ${d.irSetDigest}`);
  }

  const pairs: Array<{ ticketId: string; packetDigest: string }> = [];
  for (const t of at.plan.tickets) {
    if (!t.packetId) continue;
    const p = ctx.store.packet(t.packetId);
    if (!p || p.blueprintId !== d.blueprintId || p.ticketId !== t.id) {
      br('packets', `ticket ${t.id} names packet ${t.packetId}, which is not this blueprint's packet for it`);
      continue;
    }
    pairs.push({ ticketId: t.id, packetDigest: p.packetDigest });
  }
  if (packetSetDigestOf(pairs) !== d.packetSetDigest) br('packets', 'the packets the tickets name do not hash to the plan\'s packet set digest');
  const named = new Map(at.plan.tickets.map((t) => [t.id, t.packetId ?? null]));
  for (const row of ctx.store.ticketTrace(campaignId)) {
    if (named.get(row.ticketId) !== row.packetId) {
      br('packets', `ticket ${row.ticketId}'s trace names packet ${row.packetId ?? 'none'}, not the one its plan ticket names`);
      break;
    }
  }

  if (!chain.approvePlanDecisionId && approve) br('plan', `the approved plan ${String(approve.scope.planDigest)} is not the current plan ${at.planDigest}`);
  if (auth) {
    const env = auth.scope as { planDigest?: unknown; gateSetDigest?: unknown };
    const lock = ctx.store.campaignLockDecision(campaignId);
    if (env.planDigest !== at.planDigest) br('envelope', `authorization ${auth.id} names plan ${String(env.planDigest)}, not ${at.planDigest}`);
    else if (!lock || lock.scope.gateSetDigest !== env.gateSetDigest) br('envelope', `authorization ${auth.id}'s gate set is not the current lock`);
  }
  return chain;
}

// ---- needs ---------------------------------------------------------------------------------

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What a person must do about a corpus or a traced campaign, derived on every read (§9). */
export function ingestNeeds(ctx: DaylightContext, m: Mission): Need[] {
  const out: Need[] = [];
  if (m.kind === 'corpus') {
    const records = ctx.store.irRecords(m.id);
    const proposed = records.filter((r) => r.status === 'proposed');
    if (proposed.length) out.push({ kind: 'ir-undecided', ref: m.id, why: `${count(proposed.length, 'IR record')} of corpus ${m.id} wait for \`corpus approve-ir\`` });
    const open = ctx.store.irFindings(m.id, { disposition: 'open' });
    if (open.length) out.push({ kind: 'ir-finding-open', ref: m.id, why: `${count(open.length, 'review finding')} on corpus ${m.id} wait to be accepted or dismissed` });
    for (const b of ctx.store.blueprints(m.id)) {
      if (b.status === 'proposed') out.push({ kind: 'blueprint-undecided', ref: b.id, why: `blueprint ${b.id} waits for \`corpus approve-blueprint\`` });
    }
    const current = ctx.store.currentCorpusRevision(m.id);
    for (const r of records) {
      if (r.status !== 'approved') continue;
      if (recordStale(ctx, r)) out.push({ kind: 'spec-stale', ref: r.id, why: `approved record ${r.id} has no span at the current revision; supersede it with \`corpus approve-ir\`` });
      else if (current && ctx.store.irSpans(r.id).some((s) => s.revisionId === current.id && s.carry === 'review')) {
        out.push({ kind: 'spec-review', ref: r.id, why: `approved record ${r.id} sits in a section that changed; a person reads it again` });
      }
    }
    for (const a of ctx.store.assumptions(m.id)) {
      if (a.source !== 'ir-interpretation') continue;
      if (a.status === 'open') out.push({ kind: 'ir-interpretation', ref: a.id, why: `interpretation ${a.ownerDecisionId ?? a.id} of record ${a.irId} waits for its owner (\`assumption decide\`)` });
      if (a.irId && ctx.store.irRecord(a.irId) && isIrStale(ctx, a.irId)) out.push({ kind: 'spec-stale', ref: a.id, why: `interpretation ${a.id} is of record ${a.irId}, which is stale` });
    }
    return out;
  }
  if (m.kind === 'campaign') {
    const stale = staleTickets(ctx, m.id);
    for (const [ticketId, ids] of stale) {
      const t = ctx.store.campaignTicket(m.id, ticketId);
      if (t && ticketState(ctx, m.id, t.workItemId) === 'landed') {
        out.push({ kind: 'evidence-stale', ref: ticketId, why: `landed ticket ${ticketId} implements ${count(ids.length, 'record')} that changed in the specification` });
      }
    }
    const staleIds = new Set([...stale.values()].flat());
    for (const g of staleGates(ctx, m.id, staleIds)) {
      out.push({ kind: 'gate-stale', ref: g.experimentId, why: `gate ${g.experimentId} discharges ${g.obligations.join(', ')}, whose records changed` });
    }
  }
  return out;
}
