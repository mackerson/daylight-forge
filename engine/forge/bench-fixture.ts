import fs from 'node:fs';
import path from 'node:path';
import type { BlueprintV1, IrKind, PlanFile, WorkPacket } from '../mission/types.ts';
import { ASSIGNABLE } from './blueprint.ts';
import { PACKETS_KIND } from './packets.ts';
import { overlayProblems, readDocs, readOverlay, type OverlayFile, type OverlayRecord } from './bench-overlay.ts';
import { parseGroundTruth, type GtPlan } from './bench-score.ts';

/**
 * A benchmark corpus fixture (spec ingestion §11.1): `bench.json` names the documents by key, the
 * repositories they are committed into, and the answer files under `expected/` — which are never
 * part of the corpus. Everything here is project-agnostic: OLC and Harbor Ledger are two such
 * directories, and nothing in code names either.
 *
 * Templates (`blueprint.json`, `packets.json`) cite records by overlay key and resolve to ir ids
 * against a real store at run time, so a fixture survives id or section-id changes.
 */

export interface BenchSpec {
  kind: 'daylight-ingest-bench'; v: 1; name: string; title: string;
  /** Document key → its file, relative to bench.json (another fixture directory's documents are referenced, never copied). */
  docs: Record<string, string>;
  /** Repositories to commit: `alias` null is the manifest's own repo; `files` maps a repo path (a trailing `/` copies a directory) to a fixture path. */
  repos: Array<{ alias: string | null; files: Record<string, string> }>;
  /** The manifest's path in the repo, and the same file in the fixture (read by the precedence check). */
  manifest: { repo: string; file: string };
  expected: { groundTruth: string; overlay: string; blueprint: string; packets: string; seeds: string; invariants: string; review: string | null };
  /** Strings no corpus document may contain (a ground-truth table row): the leakage guard. */
  groundTruthRows: string[];
  revise: { doc: string; find: string; replace: string; staleKeys: string[]; staleTickets: string[] };
  holdout: { path: string; key: string };
  landing: { ticket: string };
}
export interface PacketTemplate {
  ticketId: string; componentId: string; milestone: string; title: string; objective: string; prerequisites: string[]; scope: string[];
  requirements: string[]; obligations: Array<{ id: string; keys: string[]; statement: string }>;
  interfaces: Array<{ interfaceId: string; role: 'provides' | 'consumes'; keys: string[] }>;
}
export interface BlueprintTemplate extends BlueprintTemplateRules { kind: 'daylight-blueprint-template'; v: 1; rest: string; body: BlueprintV1 }
export interface ReviewScript {
  /** Each finding says how the scripted person disposes of it; the store's finding is found by `findingKey`, never by order (P2-R61). */
  findings: Array<{ kind: string; severity: 'high' | 'medium' | 'low'; title: string; statement: string; irKey?: string; docKey?: string; quote?: string;
    disposition: 'accept' | 'dismiss' }>;
  reject: string[];
  corrections: Array<{ kind: string; source: 'extracted'; statement: string; confidence: number; docKey: string; quote: string }>;
}
export interface BenchFixture {
  dir: string; bench: BenchSpec; docs: Map<string, Buffer>; overlay: OverlayFile; gt: GtPlan; blueprint: BlueprintTemplate; packets: PacketTemplate[];
  invariants: string[]; review: ReviewScript | null; seedsFile: string;
}

export type PacketBody = Omit<WorkPacket, 'id' | 'packetDigest' | 'status'>;

/** Ground truth from a committed JSON (`ground-truth.json`) or a markdown plan (parsed from its tables). */
export function readGroundTruth(file: string): GtPlan {
  const text = fs.readFileSync(file, 'utf8');
  if (!file.endsWith('.json')) return parseGroundTruth(text);
  const j = JSON.parse(text) as GtPlan & { kind?: string };
  if (j.kind !== 'daylight-ground-truth' || !Array.isArray(j.tickets)) throw new Error(`${path.basename(file)} is not a ground-truth file`);
  return { source: j.source, lanes: j.lanes ?? [], tickets: j.tickets };
}

export function loadFixture(dir: string): BenchFixture {
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  const bench = read('bench.json') as BenchSpec;
  if (bench.kind !== 'daylight-ingest-bench' || bench.v !== 1) throw new Error(`${dir} has no bench.json`);
  const e = bench.expected;
  return {
    dir, bench, docs: readDocs(dir, bench.docs), overlay: readOverlay(path.join(dir, e.overlay)), gt: readGroundTruth(path.join(dir, e.groundTruth)),
    blueprint: read(e.blueprint) as BlueprintTemplate, packets: (read(e.packets) as { packets: PacketTemplate[] }).packets,
    invariants: read(e.invariants) as string[], review: e.review ? (read(e.review) as ReviewScript) : null, seedsFile: path.join(dir, e.seeds),
  };
}

/** Where a fixture file lands: the repo alias and repo path a `repos` entry gives it, or null. */
export function repoPathOf(bench: BenchSpec, fixturePath: string): { alias: string | null; path: string } | null {
  const norm = path.posix.normalize(fixturePath);
  for (const r of bench.repos) {
    for (const [to, from] of Object.entries(r.files)) {
      const f = path.posix.normalize(from);
      if (from.endsWith('/') && norm.startsWith(f.endsWith('/') ? f : `${f}/`)) return { alias: r.alias, path: `${to}${norm.slice((f.endsWith('/') ? f : `${f}/`).length)}` };
      if (f === norm) return { alias: r.alias, path: to };
    }
  }
  return null;
}

/** Problems with the fixture itself: quotes not at their offsets, answer rows inside a corpus document, unknown keys in templates. */
export function fixtureProblems(f: BenchFixture): string[] {
  const out = overlayProblems(f.docs, f.overlay.records);
  for (const [k, b] of f.docs) for (const row of f.bench.groundTruthRows) if (b.includes(row)) out.push(`leak: ${k} contains the ground-truth row ${row}`);
  const keys = new Set(f.overlay.records.map((r) => r.key));
  const cite = (where: string, k: string) => keys.has(k) || out.push(`${where}: no overlay record ${k}`);
  for (const p of f.packets) {
    for (const k of p.requirements) cite(`packet ${p.ticketId}`, k);
    for (const o of p.obligations) for (const k of o.keys) cite(`packet ${p.ticketId} ${o.id}`, k);
    for (const i of p.interfaces) for (const k of i.keys) cite(`packet ${p.ticketId} ${i.interfaceId}`, k);
  }
  const walk = (v: unknown, where: string): void => {
    if (typeof v === 'string' && v.startsWith('ir:')) cite(where, v.slice(3));
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  walk(f.blueprint.body, 'blueprint');
  for (const k of [f.bench.holdout.key, ...f.bench.revise.staleKeys]) cite('bench.json', k);
  for (const [k, p] of Object.entries(f.bench.docs)) if (!repoPathOf(f.bench, p)) out.push(`bench.json: document ${k} is in no repository`);
  const doc = f.docs.get(f.bench.revise.doc);
  if (!doc || doc.toString('utf8').split(f.bench.revise.find).length !== 2) out.push('bench.json revise.find must occur exactly once in its document');
  return out;
}

// ---- milestones and scope ---------------------------------------------------------------------

/**
 * The milestone a record really belongs to: its own `attrs.milestone`, unless an errata deferral's
 * other passage overlaps its quote, which moves it to the deferral's target (E9, Amendment A3).
 */
export function effectiveMilestones(records: readonly OverlayRecord[]): Map<string, string | undefined> {
  const len = (q: string) => Buffer.byteLength(q, 'utf8');
  const moves = records.filter((r) => r.kind === 'deferral' && r.attrs.deferral?.to && r.other)
    .map((r) => ({ doc: r.other!.docKey, a: r.other!.at, b: r.other!.at + len(r.other!.quote), to: r.attrs.deferral!.to }));
  return new Map(records.map((r) => {
    const mv = r.kind === 'deferral' ? undefined : moves.find((m) => m.doc === r.docKey && m.a < r.at + len(r.quote) && r.at < m.b);
    return [r.key, mv ? mv.to : r.attrs.milestone];
  }));
}

/**
 * Scope leakage (check 7): a packet may cite a record only when the record's effective milestone is
 * unset, or in scope and not later than the packet's own. Returns `<ticket> cites <key> (<milestone>)`.
 */
export function scopeLeaks(packets: ReadonlyArray<Pick<PacketTemplate, 'ticketId' | 'milestone' | 'requirements' | 'obligations' | 'interfaces'>>,
  records: readonly OverlayRecord[], scope: readonly string[]): string[] {
  const eff = effectiveMilestones(records);
  const order = (m: string) => scope.indexOf(m);
  const out: string[] = [];
  for (const p of packets) {
    const cited = new Set([...p.requirements, ...p.obligations.flatMap((o) => o.keys), ...p.interfaces.flatMap((i) => i.keys)]);
    for (const k of cited) {
      const m = eff.get(k);
      if (m === undefined) continue;
      if (order(m) < 0 || order(m) > order(p.milestone)) out.push(`${p.ticketId} cites ${k} (${m})`);
    }
  }
  return out.sort();
}

/**
 * Invariants (check 8, fixture level): each tag in the project's list has a spanned record carrying
 * it, one such record sits on a boundary, and one reaches a packet obligation or is deferred.
 */
export function invariantPlacement(f: Pick<BenchFixture, 'overlay' | 'blueprint' | 'packets' | 'invariants'>): Array<{ tag: string; records: number; onBoundary: boolean; obligation: boolean; ok: boolean }> {
  const onBoundary = new Set(f.blueprint.body.boundaries.flatMap((b) => b.invariants).map((s) => s.replace(/^ir:/, '')));
  const obligated = new Set(f.packets.flatMap((p) => p.obligations.flatMap((o) => o.keys)));
  const deferred = new Set(f.blueprint.body.deferred.map((d) => d.irId.replace(/^ir:/, '')));
  return f.invariants.map((tag) => {
    const recs = f.overlay.records.filter((r) => r.attrs.tags?.includes(tag));
    const b = recs.some((r) => onBoundary.has(r.key));
    const o = recs.some((r) => obligated.has(r.key) || deferred.has(r.key));
    return { tag, records: recs.length, onBoundary: b, obligation: o, ok: recs.length > 0 && b && o };
  });
}

/** Ticket ids the corpus names (check 13): in-scope ones must be packets; others are expected out of scope. */
export function ticketRefResolution(records: readonly OverlayRecord[], packetIds: ReadonlySet<string>, scope: readonly string[]): { inScope: string[]; resolved: string[]; unresolved: string[]; outOfScope: string[] } {
  const refs = [...new Set(records.flatMap((r) => r.attrs.ticketRefs ?? []))].sort();
  const inScope = refs.filter((r) => scope.includes(r.split('.')[0]));
  return { inScope, resolved: inScope.filter((r) => packetIds.has(r)), unresolved: inScope.filter((r) => !packetIds.has(r)), outOfScope: refs.filter((r) => !inScope.includes(r)) };
}

/** Kahn layers of a component graph, each layer sorted; null on a cycle. */
export function kahnLayers(deps: ReadonlyMap<string, readonly string[]>): string[][] | null {
  const left = new Map([...deps].map(([k, v]) => [k, new Set(v.filter((d) => deps.has(d)))]));
  const out: string[][] = [];
  while (left.size) {
    const layer = [...left].filter(([, v]) => v.size === 0).map(([k]) => k).sort();
    if (!layer.length) return null;
    out.push(layer);
    for (const k of layer) left.delete(k);
    for (const v of left.values()) for (const k of layer) v.delete(k);
  }
  return out;
}

// ---- resolution against a store ----------------------------------------------------------------

/** Replace every `ir:<key>` string with its ir id; an unknown key throws (a fixture bug, not a benchmark result). */
export function resolveKeys<T>(v: T, irOf: (key: string) => string | null): T {
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string' && x.startsWith('ir:')) {
      const id = irOf(x.slice(3));
      if (!id) throw new Error(`fixture cites ${x.slice(3)}, which has no record in the store`);
      return id;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v) as T;
}

/**
 * Where a record nothing names explicitly goes, by the section it sits in (its nearest heading's
 * title, by prefix): to a component and the packet that covers it, to a constraint on components,
 * deferred to a milestone, or out of scope. Rules are the blueprint author's, as data; first match.
 */
export interface PlacementRule {
  doc: string; under: '*' | string[]; as: 'component' | 'constraint' | 'deferred' | 'outOfScope';
  component?: string; ticket?: string; appliesTo?: string[]; to?: string; reason?: string;
}
export interface BlueprintTemplateRules { place?: PlacementRule[] }
/** An approved record of the store, located: what the blueprint must place. */
export interface StoredRecord { id: string; kind: IrKind; docKey: string | null; at: number | null; milestone?: string }

/** The title of the nearest ATX heading at or before `at`, outside fences; null before the first. */
export function headingTitleAt(doc: Buffer, at: number): string | null {
  let title: string | null = null;
  let pos = 0;
  let fence = false;
  for (const line of doc.toString('utf8').split('\n')) {
    if (pos > at) break;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*)$/.exec(line);
    if (m) title = m[1].trim();
    pos += Buffer.byteLength(line, 'utf8') + 1;
  }
  return title;
}

const ruleMatches = (r: PlacementRule, docKey: string, title: string | null) =>
  r.doc === docKey && (r.under === '*' || (title !== null && r.under.some((p) => title.startsWith(p))));

/**
 * The blueprint body for a store, placing every approved assignable record exactly once (R15's
 * rule): template keys resolved; then each record nothing names goes to `deferred` when its
 * effective milestone is outside scope, else by the first placement rule its section matches,
 * else to `outOfScope` with the template's `rest` reason. Records placed on a component are
 * returned by ticket, for the packet that must cover them.
 */
export function resolveBlueprint(t: BlueprintTemplate, o: { overlay: readonly OverlayRecord[]; stored: readonly StoredRecord[]; irOf: (key: string) => string | null;
  docs: ReadonlyMap<string, Buffer>; corpusDigest: string; irSetDigest: string }): { body: BlueprintV1; byTicket: Map<string, string[]> } {
  const body = resolveKeys(structuredClone(t.body), o.irOf);
  const named = new Set([...body.components.flatMap((c) => c.requirements), ...body.interfaces.flatMap((i) => i.irIds),
    ...body.constraints.flatMap((c) => c.irIds), ...body.deferred.map((d) => d.irId), ...body.outOfScope.map((x) => x.irId)]);
  const eff = effectiveMilestones(o.overlay);
  const keyOf = new Map(o.overlay.map((r) => [o.irOf(r.key), r.key]));
  const byTicket = new Map<string, string[]>();
  const ruleConstraints = new Map<number, string[]>();
  const rules = t.place ?? [];
  for (const r of [...o.stored].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (named.has(r.id) || !ASSIGNABLE.includes(r.kind)) continue;
    named.add(r.id);
    const key = keyOf.get(r.id);
    const m = key !== undefined ? eff.get(key) : r.milestone;
    if (m !== undefined && !body.scope.milestones.includes(m)) {
      body.deferred.push({ irId: r.id, to: m });
      continue;
    }
    const doc = r.docKey !== null ? o.docs.get(r.docKey) : undefined;
    const title = doc && r.at !== null ? headingTitleAt(doc, r.at) : null;
    const k = r.docKey === null ? -1 : rules.findIndex((x) => ruleMatches(x, r.docKey!, title));
    const rule = rules[k];
    if (!rule || rule.as === 'outOfScope') body.outOfScope.push({ irId: r.id, reason: rule?.reason ?? t.rest });
    else if (rule.as === 'deferred') body.deferred.push({ irId: r.id, to: rule.to ?? 'later' });
    else if (rule.as === 'constraint') ruleConstraints.set(k, [...(ruleConstraints.get(k) ?? []), r.id]);
    else {
      const c = body.components.find((x) => x.id === rule.component);
      if (!c || !rule.ticket) throw new Error(`placement rule ${k} names no component or ticket`);
      c.requirements.push(r.id);
      byTicket.set(rule.ticket, [...(byTicket.get(rule.ticket) ?? []), r.id]);
    }
  }
  for (const [k, ids] of [...ruleConstraints].sort(([a], [b]) => a - b)) {
    body.constraints.push({ irIds: ids, appliesTo: rules[k].appliesTo ?? body.components.map((c) => c.id) });
  }
  return { body: { ...body, corpusDigest: o.corpusDigest, irSetDigest: o.irSetDigest }, byTicket };
}

/** The packets for a store: template keys resolved, plus the records the blueprint placed on each ticket by rule. */
export function resolvePackets(packets: readonly PacketTemplate[], irOf: (key: string) => string | null, blueprintId: string,
  byTicket: ReadonlyMap<string, readonly string[]> = new Map()): PacketBody[] {
  const id = (k: string) => resolveKeys(`ir:${k}`, irOf);
  return packets.map((p) => ({
    blueprintId, componentId: p.componentId, ticketId: p.ticketId, milestone: p.milestone, title: p.title, objective: p.objective,
    prerequisites: p.prerequisites, scope: p.scope, requirementIds: [...p.requirements.map(id), ...(byTicket.get(p.ticketId) ?? [])],
    interfaceContracts: p.interfaces.map((i) => ({ interfaceId: i.interfaceId, role: i.role, irIds: i.keys.map(id) })),
    artifacts: [], acceptanceObligations: p.obligations.map((ob) => ({ id: ob.id, irIds: ob.keys.map(id), statement: ob.statement })),
    integrationDeps: [], blocksOn: [], examples: [], negativeExamples: [],
  }));
}

/** The packets file R15's `importPackets` reads. */
export const packetsFileOf = (bodies: readonly PacketBody[]) => ({ kind: PACKETS_KIND, version: 1 as const, packets: bodies });

/** A version-1 plan carrying the packets' tickets (lanes from the blueprint): what an emitter would produce, for scorer tests. */
export function planOfPackets(packets: ReadonlyArray<Pick<PacketTemplate, 'ticketId' | 'componentId' | 'title' | 'objective' | 'prerequisites' | 'scope'>>,
  components: ReadonlyArray<{ id: string; title: string; owns: string[]; shared?: string[] }>, title: string): PlanFile {
  return {
    kind: 'daylight-plan', version: 1, title, campaignGates: [],
    lanes: components.map((c) => ({ id: c.id, title: c.title, owns: [...c.owns, ...(c.shared ?? [])] })),
    tickets: packets.map((p) => ({ id: p.ticketId, lane: p.componentId, title: p.title, statement: p.objective, scope: p.scope, dependsOn: p.prerequisites })),
  };
}
