import path from 'node:path';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import type { DaylightContext } from '../mission/context.ts';
import { redact } from '../mission/redact.ts';
import type {
  CorpusRevision, CoverageReport, CrossRef, IrKind, IrRecord, IrStatus, NormativeSentence, SectionerConfig, SectionIndex, SeededDefect,
  SeededDefectResult, SpanRef,
} from '../mission/types.ts';
import { IR_KINDS } from '../mission/types.ts';
import { holdoutPaths } from './campaign-gates.ts';
import { corpusOf } from './corpus.ts';
import { disagreementsOf } from './extract.ts';
import { buildSectionIndex, configForDomain, fencesOf, scoredUnitsOf, windowOfTask, windowsOf } from './sectioner.ts';

/**
 * Coverage and omission (spec ingestion §5): every normative unit is mapped by a record with a
 * span at the revision, or listed as unmapped; nothing in between. Then deterministic detectors,
 * each a documented heuristic over the units and records, never an extractor's say-so:
 *
 * - `hedge`: a normative unit with a configured hedge cue (inherited from a lead ending `:`);
 * - `open-decision`: a normative unit in an open-decision section (inherited);
 * - `modal-polarity`: two normative units sharing ≥ 3 content tokens (or one `attrs.subject`) with
 *   opposite polarity (`must`/`always` against `never`/`must not`/`no X`); confidence = Jaccard;
 * - `numeric`: two units sharing ≥ 3 content tokens with the same unit and a different number;
 * - precedence: a contradiction between ordered documents is resolved by the order (with its
 *   basis), between unordered ones it is `unordered`, across domains it is `none`, marked when a
 *   declared dependency covers the pair (O-a);
 * - `dangling`: every unresolved reference; `unsupported`: inferred records with no basis and no
 *   decided assumption; `stale`: records with no span at the revision (P2-R53).
 *
 * Excerpts (markdown only) are ≤ 160 characters of corpus text, control and bidi characters
 * stripped, withheld (never masked) on a `redact()` hit or a holdout basename; statements written by
 * extractors or reviewers never appear (P2-R40). Seeded-defect mode inserts fixture sentences into
 * an in-memory copy of the documents and reports whether the detectors find them; the engine never
 * seeds a registered corpus.
 */

/** A normative unit with its text, as the detectors read it. */
export type DetectorUnit = NormativeSentence & { text: string };
type Contradiction = CoverageReport['contradictions'][number];

const MAX_EXCERPT = 160;
const MIN_SHARED = 3;
const MIN_JACCARD = 0.3;
const STOP = new Set(('the and for with that this are from into each every all any not but its their they them will shall must should may can '
  + 'never always only cannot does has have had was were been being than then also such which when where what who whom whose how about over '
  + 'under more most less least very just own same other another one two both either neither nor per via without within').split(' '));
const NEGATIVE = /(?<![\p{L}])(?:must\s+not|shall\s+not|never|cannot|can\s?not|may\s+not|forbid(?:s|den)?|refuses?|no\s+(?!longer\b)\p{L}{3,})(?![\p{L}])/iu;
const POSITIVE = /(?<![\p{L}])(?:must|shall|required|always)(?![\p{L}])/iu;
const NUMBER = /(?<![\p{L}\p{N}.])(\d+(?:\.\d+)?)\s?(KiB|MiB|GiB|KB|MB|GB|ms|seconds?|minutes?|hours?|days?|weeks?|%|bytes?|px|items?|pages?|words?|checks?|attempts?|retries|levels?)(?![\p{L}])/gu;

export const polarityOf = (text: string): 'positive' | 'negative' | null => (NEGATIVE.test(text) ? 'negative' : POSITIVE.test(text) ? 'positive' : null);

/** Content tokens: lower case, ≥ 3 letters, stop words and plurals folded away. */
export function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/\p{L}[\p{L}\p{N}'-]{2,}/gu)) {
    let w = m[0].replace(/'s$/, '');
    if (STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}

const spanOf = (u: Pick<NormativeSentence, 'docKey' | 'sectionId' | 'start' | 'end'>): SpanRef => ({ docKey: u.docKey, sectionId: u.sectionId, start: u.start, end: u.end });
const overlaps = (a: SpanRef, b: SpanRef) => a.docKey === b.docKey && a.start < b.end && b.start < a.end;
const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** Pairs of units sharing ≥ 3 content tokens, through an inverted index; with their Jaccard. */
function similarPairs(units: DetectorUnit[]): Array<{ a: DetectorUnit; b: DetectorUnit; jaccard: number }> {
  const toks = units.map((u) => tokensOf(u.text));
  const index = new Map<string, number[]>();
  toks.forEach((t, i) => t.forEach((w) => index.set(w, [...(index.get(w) ?? []), i])));
  const shared = new Map<string, number>();
  for (const list of index.values()) {
    if (list.length > 200) continue;  // a word in this many units says nothing about any pair
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const k = `${list[x]},${list[y]}`;
      shared.set(k, (shared.get(k) ?? 0) + 1);
    }
  }
  const out: Array<{ a: DetectorUnit; b: DetectorUnit; jaccard: number }> = [];
  for (const [k, n] of shared) {
    if (n < MIN_SHARED) continue;
    const [i, j] = k.split(',').map(Number);
    const jaccard = n / (toks[i].size + toks[j].size - n);
    if (jaccard >= MIN_JACCARD) out.push({ a: units[i], b: units[j], jaccard });
  }
  return out.sort((p, q) => p.a.id.localeCompare(q.a.id) || p.b.id.localeCompare(q.b.id));
}

const blankResolution = (a: SpanRef, b: SpanRef): Pick<Contradiction, 'crossDocument' | 'crossDomain' | 'declaredDependency' | 'resolution'> =>
  ({ crossDocument: a.docKey !== b.docKey, crossDomain: false, declaredDependency: false, resolution: { by: 'none' } });

/** Opposite polarity over similar units, and opposite `attrs.polarity` over records with one subject. */
export function detectModalConflicts(units: DetectorUnit[], records: IrRecord[]): CoverageReport['contradictions'] {
  const out: CoverageReport['contradictions'] = [];
  for (const { a, b, jaccard } of similarPairs(units)) {
    const pa = polarityOf(a.text);
    const pb = polarityOf(b.text);
    if (!pa || !pb || pa === pb) continue;
    out.push({ a: spanOf(a), b: spanOf(b), ...blankResolution(spanOf(a), spanOf(b)), irIds: [], confidence: round(jaccard), detector: 'modal-polarity' });
  }
  const live = records.filter((r) => r.span && r.attrs.subject && r.attrs.polarity && r.status !== 'rejected' && r.status !== 'superseded');
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const [x, y] = [live[i], live[j]];
    if (x.attrs.subject!.toLowerCase() !== y.attrs.subject!.toLowerCase() || x.attrs.polarity === y.attrs.polarity) continue;
    out.push({ a: spanOf(x.span!), b: spanOf(y.span!), ...blankResolution(x.span!, y.span!), irIds: [x.id, y.id].sort(), confidence: 1, detector: 'modal-polarity' });
  }
  return out;
}

/** Similar units (or records with one subject) naming the same unit with a different number. */
export function detectNumericConflicts(units: DetectorUnit[], records: IrRecord[]): CoverageReport['contradictions'] {
  const numbersOf = (t: string) => [...t.matchAll(NUMBER)].map((m) => ({ value: Number(m[1]), unit: m[2].toLowerCase().replace(/s$/, '') }));
  const out: CoverageReport['contradictions'] = [];
  const clash = (p: Array<{ value: number; unit?: string }>, q: Array<{ value: number; unit?: string }>) =>
    p.some((x) => q.some((y) => (x.unit ?? '') === (y.unit ?? '') && x.value !== y.value)) && !p.some((x) => q.some((y) => (x.unit ?? '') === (y.unit ?? '') && x.value === y.value));
  for (const { a, b, jaccard } of similarPairs(units)) {
    if (!clash(numbersOf(a.text), numbersOf(b.text))) continue;
    out.push({ a: spanOf(a), b: spanOf(b), ...blankResolution(spanOf(a), spanOf(b)), irIds: [], confidence: round(jaccard), detector: 'numeric' });
  }
  const live = records.filter((r) => r.span && r.attrs.subject && r.attrs.numbers?.length && r.status !== 'rejected' && r.status !== 'superseded');
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const [x, y] = [live[i], live[j]];
    if (x.attrs.subject!.toLowerCase() !== y.attrs.subject!.toLowerCase() || !clash(x.attrs.numbers!, y.attrs.numbers!)) continue;
    out.push({ a: spanOf(x.span!), b: spanOf(y.span!), ...blankResolution(x.span!, y.span!), irIds: [x.id, y.id].sort(), confidence: 1, detector: 'numeric' });
  }
  return out;
}

/** Normative units carrying a hedge cue, and those of open-decision sections. */
export function detectHedges(index: SectionIndex, _config: SectionerConfig): CoverageReport['ambiguities'] {
  const out: CoverageReport['ambiguities'] = [];
  for (const u of index.sentences) {
    const hedges = u.hedges.filter((h) => h !== 'open-decision');
    if (hedges.length) out.push({ at: spanOf(u), detector: 'hedge', irIds: [], confidence: 0.5 });
    if (u.hedges.includes('open-decision')) out.push({ at: spanOf(u), detector: 'open-decision', irIds: [], confidence: 0.5 });
  }
  return out;
}

/** Fill in how a contradiction between two documents is settled, from the revision's precedence and dependencies. */
export function resolveContradiction(c: Contradiction, rev: Pick<CorpusRevision, 'docs' | 'precedence' | 'dependencies' | 'unordered'>): Contradiction {
  const da = rev.docs.find((d) => d.key === c.a.docKey);
  const db = rev.docs.find((d) => d.key === c.b.docKey);
  if (!da || !db) return c;
  const crossDomain = da.domain !== db.domain;
  const declaredDependency = crossDomain && rev.dependencies.some((d) => (d.from === da.domain && d.on === db.domain) || (d.from === db.domain && d.on === da.domain));
  const members = (end: string) => {
    const r = /^role:([a-z]+)@([a-z0-9-]+)$/.exec(end);
    return r ? rev.docs.filter((d) => d.role === r[1] && d.domain === r[2]).map((d) => d.key) : [end];
  };
  let resolution: Contradiction['resolution'] = { by: 'none' };
  if (!crossDomain && da.key !== db.key) {
    const p = rev.precedence.find((x) => (members(x.over).includes(da.key) && members(x.under).includes(db.key))
      || (members(x.over).includes(db.key) && members(x.under).includes(da.key)));
    if (p) {
      const over = members(p.over).includes(da.key) ? da.key : db.key;
      resolution = { by: 'precedence', over, basis: p.basis ? spanOf(p.basis) : null };
    } else if (rev.unordered.some(([x, y]) => (x === da.key && y === db.key) || (x === db.key && y === da.key))) resolution = { by: 'unordered' };
  }
  return { ...c, crossDocument: da.key !== db.key, crossDomain, declaredDependency, resolution };
}

/** Insert each seed's text after its section's body, in an in-memory copy; where each landed. */
export function applySeeds(docs: Map<string, Buffer>, index: SectionIndex, seeds: SeededDefect[]): { docs: Map<string, Buffer>; at: Map<string, SpanRef> } {
  const sections = new Map(index.docs.flatMap((d) => d.sections).map((s) => [s.id, s]));
  const out = new Map(docs);
  const at = new Map<string, SpanRef>();
  const byDoc = new Map<string, Array<{ seed: SeededDefect; offset: number }>>();
  for (const seed of seeds) {
    const s = sections.get(seed.afterSectionId);
    if (!s || s.docKey !== seed.docKey || !docs.has(seed.docKey)) throw new Error(`seed ${seed.id}: no section ${seed.afterSectionId} in ${seed.docKey}`);
    byDoc.set(seed.docKey, [...(byDoc.get(seed.docKey) ?? []), { seed, offset: s.bodyEnd }]);
  }
  for (const [key, list] of byDoc) {
    let bytes = docs.get(key)!;
    let shift = 0;
    const spans: Array<[string, SpanRef]> = [];
    for (const { seed, offset } of [...list].sort((a, b) => a.offset - b.offset || a.seed.id.localeCompare(b.seed.id))) {
      const ins = Buffer.from(`\n${seed.text}\n\n`, 'utf8');
      const where = offset + shift;
      bytes = Buffer.concat([bytes.subarray(0, where), ins, bytes.subarray(where)]);
      spans.push([seed.id, { docKey: key, sectionId: seed.afterSectionId, start: where + 1, end: where + 1 + Buffer.byteLength(seed.text, 'utf8') }]);
      shift += ins.length;
    }
    out.set(key, bytes);
    for (const [id, s] of spans) at.set(id, s);
  }
  return { docs: out, at };
}

/** Units with their text, from an index and the bytes it was built from. */
function detectorUnits(index: SectionIndex, bytesOf: (k: string) => Buffer, config: SectionerConfig, domainOf: (k: string) => string): DetectorUnit[] {
  const out: DetectorUnit[] = [];
  for (const d of index.docs) {
    const c = configForDomain(config, domainOf(d.key));
    out.push(...scoredUnitsOf({ key: d.key, bytes: bytesOf(d.key) }, d.sections, c).filter((u) => u.score >= c.threshold));
  }
  return out;
}

const STRIP = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/**
 * At most `max` characters of the corpus text a span covers, cleaned; null (withheld) when the text
 * has anything `redact()` would mask or names a holdout basename. `o.revisionId` names the revision;
 * without it the latest revision of any corpus holding the document is read, and an ambiguous key is
 * withheld.
 */
export function safeExcerpt(ctx: DaylightContext, s: SpanRef, o: { holdoutBasenames: ReadonlySet<string>; max?: number; revisionId?: string }): string | null {
  let rev = o.revisionId ? ctx.store.corpusRevision(o.revisionId) : null;
  if (!o.revisionId) {
    const holding = ctx.store.missions().filter((m) => m.kind === 'corpus').map((m) => ctx.store.currentCorpusRevision(m.id))
      .filter((r): r is CorpusRevision => !!r && r.docs.some((d) => d.key === s.docKey));
    if (holding.length !== 1) return null;
    rev = holding[0];
  }
  const doc = rev?.docs.find((d) => d.key === s.docKey);
  if (!rev || !doc) return null;
  let bytes: Buffer;
  try {
    bytes = ctx.artifacts.get(doc.artifact);
  } catch {
    return null;
  }
  const raw = bytes.subarray(Math.max(0, s.start), Math.min(bytes.length, s.end)).toString('utf8');
  if (redact(raw).redactions > 0) return null;
  if ([...o.holdoutBasenames].some((b) => b && raw.includes(b))) return null;
  const clean = raw.replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
  const max = o.max ?? MAX_EXCERPT;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Every holdout basename of every campaign of the project: what an excerpt may never carry. */
export function holdoutBasenamesOf(ctx: DaylightContext, projectId: string): Set<string> {
  const out = new Set<string>();
  for (const m of ctx.store.missions(projectId).filter((x) => x.kind === 'campaign')) {
    for (const p of holdoutPaths(ctx, m.id)) out.add(path.posix.basename(p));
  }
  return out;
}

/**
 * Units split two ways, computed from opposite sides so the check between them means something:
 * `mapped` from the spans (every unit some span overlaps), `unmapped` from the units (no span
 * overlaps them).
 */
export function partitionUnits<U extends Pick<NormativeSentence, 'id' | 'docKey' | 'start' | 'end'>>(units: U[], spans: SpanRef[]): { mapped: U[]; unmapped: U[] } {
  const hit = new Set<string>();
  for (const s of spans) for (const u of units) if (u.docKey === s.docKey && u.start < s.end && s.start < u.end) hit.add(u.id);
  return {
    mapped: units.filter((u) => hit.has(u.id)),
    unmapped: units.filter((u) => !spans.some((s) => u.docKey === s.docKey && u.start < s.end && s.start < u.end)),
  };
}

/** Every normative unit is in exactly one of mapped and unmapped; anything else is a bug, thrown. */
export function assertPartition(units: Array<Pick<NormativeSentence, 'id'>>, p: { mapped: Array<Pick<NormativeSentence, 'id'>>; unmapped: Array<Pick<NormativeSentence, 'id'>> }): void {
  const seen = new Map<string, number>();
  for (const u of [...p.mapped, ...p.unmapped]) seen.set(u.id, (seen.get(u.id) ?? 0) + 1);
  const bad = units.filter((u) => seen.get(u.id) !== 1);
  if (bad.length || seen.size !== units.length) throw new Error(`coverage arithmetic does not hold: ${bad.length} unit(s) not in exactly one of mapped and unmapped`);
}

export function coverageOf(ctx: DaylightContext, corpusId: string, o: { revisionId?: string; seeds?: SeededDefect[] } = {}): CoverageReport {
  const c = corpusOf(ctx, corpusId, o.revisionId);
  const domainOf = (k: string) => c.docs.find((d) => d.key === k)?.domain ?? '';
  const units = detectorUnits(c.index, c.bytesOf, c.config, domainOf);
  const records = ctx.store.irRecords(corpusId, { revisionId: c.id });
  const live = records.filter((r) => r.status !== 'rejected' && r.status !== 'superseded');
  const spansOf = (r: IrRecord) => [r.span, r.other].filter((s): s is NonNullable<typeof s> => !!s).map(spanOf);
  const covered = (u: DetectorUnit, rs: IrRecord[]) => rs.some((r) => spansOf(r).some((s) => overlaps(s, spanOf(u))));
  const approved = live.filter((r) => r.status === 'approved');
  const labelOf = new Map(c.index.docs.flatMap((d) => d.sections).map((s) => [s.id, s.label]));
  const parts = partitionUnits(units, live.flatMap(spansOf));
  assertPartition(units, parts);
  const unmapped = parts.unmapped.map((u) => ({ sentenceId: u.id, sectionId: u.sectionId, label: labelOf.get(u.sectionId) ?? null, start: u.start, end: u.end, score: u.score }));
  const mapped = parts.mapped.length;

  // Why a section with normative units has no record: no window, no attempt, every attempt failed, or none recorded.
  const windows = windowsOf(c.index, c.bytesOf);
  const attemptsOf = new Map<string, string[]>();
  for (const t of ctx.store.tasks(corpusId).filter((x) => x.role === 'extract')) {
    try {
      const w = windowOfTask(ctx, t);
      attemptsOf.set(w.id, [...(attemptsOf.get(w.id) ?? []), ...ctx.store.attempts(t.id).map((a) => a.state)]);
    } catch {
      // A task whose window cannot be read covers nothing.
    }
  }
  const unprocessedSections: CoverageReport['unprocessedSections'] = [];
  for (const sid of [...new Set(units.map((u) => u.sectionId))]) {
    if (live.some((r) => spansOf(r).some((s) => s.sectionId === sid))) continue;
    const w = windows.find((x) => x.sectionIds.includes(sid));
    const states = w ? attemptsOf.get(w.id) ?? [] : [];
    const reason = !w ? 'no-window' : !states.length ? 'no-attempt' : states.every((s) => s === 'failed' || s === 'cancelled') ? 'attempt-failed' : 'no-records';
    unprocessedSections.push({ sectionId: sid, label: labelOf.get(sid) ?? null, reason });
  }

  const disagreements = disagreementsOf(ctx, corpusId, c.id);
  const ambiguities: CoverageReport['ambiguities'] = [
    ...detectHedges(c.index, c.config),
    ...live.filter((r) => r.kind === 'ambiguity' && r.span).map((r) => ({ at: spanOf(r.span!), detector: 'extractor' as const, irIds: [r.id], confidence: r.confidence })),
    ...disagreements.filter((d) => d.kind !== 'single-extractor').map((d) => ({
      at: { docKey: d.sectionId.slice(0, d.sectionId.indexOf(':')), sectionId: d.sectionId, start: d.start, end: d.end }, detector: 'disagreement' as const,
      irIds: d.irIds, confidence: 0.5,
    })),
  ];
  const contradictions = [
    ...live.filter((r) => r.kind === 'contradiction' && r.span && r.other).map((r): Contradiction => ({
      a: spanOf(r.span!), b: spanOf(r.other!), ...blankResolution(spanOf(r.span!), spanOf(r.other!)), irIds: [r.id], confidence: r.confidence, detector: 'extractor',
    })),
    ...detectModalConflicts(units, live), ...detectNumericConflicts(units, live),
  ].map((x) => resolveContradiction(x, c));
  const isStale = (r: IrRecord) => r.source === 'extracted' && !r.span && r.status !== 'rejected' && r.status !== 'superseded';
  const unsupported = live.filter((r) => r.source === 'inferred' && !r.basisSections.length && !r.assumptionId).map((r) => ({ irId: r.id, kind: r.kind }));
  const stale = records.filter(isStale).map((r) => ({ irId: r.id, status: r.status }));
  const danglingRefs = c.index.refs.filter((r) => !r.resolved).map(({ fromSection, start, end, raw, kind, reason }) => ({ fromSection, start, end, raw, kind, reason }));

  const holdouts = holdoutBasenamesOf(ctx, c.projectId);
  const excerptSpans: SpanRef[] = [...unmapped.map((u) => ({ docKey: u.sectionId.slice(0, u.sectionId.indexOf(':')), sectionId: u.sectionId, start: u.start, end: u.end })),
    ...ambiguities.map((a) => a.at), ...contradictions.flatMap((x) => [x.a, x.b])];
  const withheldExcerpts = excerptSpans.filter((s) => safeExcerpt(ctx, s, { holdoutBasenames: holdouts, revisionId: c.id }) === null).length;
  const records0 = Object.fromEntries(IR_KINDS.map((k) => [k, 0])) as Record<IrKind, number>;
  for (const r of records) records0[r.kind]++;
  const byStatus: Record<IrStatus, number> = { proposed: 0, approved: 0, rejected: 0, superseded: 0 };
  for (const r of records) byStatus[r.status]++;
  // currentIrSetDigest's formula (§6.2): sorted "<id>:<contentDigest>" of approved records with a span at the revision.
  const setLines = approved.filter((r) => r.span || r.other).map((r) => `${r.id}:${r.contentDigest}`).sort();
  const report: CoverageReport = {
    kind: 'daylight-coverage', v: 1, corpusId, revisionId: c.id, corpusDigest: c.corpusDigest,
    irVersions: [...new Set(records.map((r) => r.irVersion))].sort(), irSetDigest: setLines.length ? digestOf(setLines.join('\n')) : null,
    totals: {
      documents: c.docs.length, sections: c.index.docs.reduce((n, d) => n + d.sections.length, 0), windows: windows.length, normative: units.length, mapped,
      mappedApproved: units.filter((u) => covered(u, approved)).length, unprocessed: unprocessedSections.length, records: records0, byStatus,
      stale: stale.length, inferred: records.filter((r) => r.source === 'inferred').length, unsupported: unsupported.length, withheldExcerpts,
    },
    documents: c.docs.map((d) => {
      const mine = units.filter((u) => u.docKey === d.key);
      return { key: d.key, role: d.role, domain: d.domain, sections: c.index.docs.find((x) => x.key === d.key)?.sections.length ?? 0,
        normative: mine.length, mapped: mine.filter((u) => covered(u, live)).length };
    }),
    unprocessedSections, unmapped, ambiguities, contradictions, unsupported, stale, danglingRefs, disagreements,
  };
  if (o.seeds?.length) report.seeded = seededResults(c, o.seeds);
  return report;
}

/** Seeds applied to an in-memory copy, sectioned again, run through the same detectors; extractors are never told. */
function seededResults(c: ReturnType<typeof corpusOf>, seeds: SeededDefect[]): SeededDefectResult[] {
  const original = new Map(c.docs.map((d) => [d.key, c.bytesOf(d.key)]));
  const { docs, at } = applySeeds(original, c.index, seeds);
  const seededDocs = c.docs.map((d) => ({ ...d, digest: digestOf(docs.get(d.key)!) }));
  const index = buildSectionIndex({ docs: seededDocs, corpusDigest: digestOf(canonicalJson(seededDocs.map((d) => d.digest))) }, (k) => docs.get(k)!, c.config);
  const domainOf = (k: string) => c.docs.find((d) => d.key === k)?.domain ?? '';
  const units = detectorUnits(index, (k) => docs.get(k)!, c.config, domainOf);
  const hedges = detectHedges(index, c.config);
  const contradictions = [...detectModalConflicts(units, []), ...detectNumericConflicts(units, [])].map((x) => resolveContradiction(x, c));
  const dangling: CrossRef[] = index.refs.filter((r) => !r.resolved);
  return seeds.map((seed) => {
    const span = at.get(seed.id)!;
    const touches = (s: SpanRef) => overlaps(s, span);
    const by: string[] = [];
    if (hedges.some((h) => h.detector === 'hedge' && touches(h.at))) by.push('hedge');
    const mine = contradictions.filter((x) => touches(x.a) || touches(x.b));
    if (mine.some((x) => x.detector === 'modal-polarity')) by.push('modal-polarity');
    if (mine.some((x) => x.detector === 'numeric')) by.push('numeric');
    if (mine.some((x) => x.crossDocument && x.resolution.by !== 'none')) by.push('precedence');
    if (dangling.some((r) => r.start >= span.start && r.end <= span.end && c.docs.some((d) => d.key === span.docKey) && r.fromSection.startsWith(`${span.docKey}:`))) by.push('dangling');
    return { id: seed.id, kind: seed.kind, insertedAt: span, detected: seed.expect.every((e) => by.includes(e)), by };
  });
}

/**
 * The report as markdown for a person: counts, then each finding with an excerpt of corpus text
 * (or "withheld"). Never a statement an extractor or reviewer wrote.
 */
export function renderCoverageMarkdown(r: CoverageReport, excerpt: (s: SpanRef) => string | null): string {
  const ex = (s: SpanRef) => {
    const t = excerpt(s);
    return t === null ? '_(excerpt withheld)_' : `“${t.replace(/[|`]/g, ' ')}”`;
  };
  const docOf = (sectionId: string) => sectionId.slice(0, sectionId.indexOf(':'));
  const t = r.totals;
  const lines = [
    `# Coverage — corpus ${r.corpusId}`, '',
    `Revision ${r.revisionId} · corpus ${r.corpusDigest.slice(0, 19)} · IR set ${r.irSetDigest ? r.irSetDigest.slice(0, 19) : '(none approved)'}`, '',
    '| documents | sections | windows | normative | mapped | mapped (approved) | unmapped | unprocessed sections | stale | unsupported | excerpts withheld |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    `| ${t.documents} | ${t.sections} | ${t.windows} | ${t.normative} | ${t.mapped} | ${t.mappedApproved} | ${r.unmapped.length} | ${t.unprocessed} | ${t.stale} | ${t.unsupported} | ${t.withheldExcerpts} |`,
    '', '## Documents', '', '| key | role | domain | sections | normative | mapped |', '| --- | --- | --- | --- | --- | --- |',
    ...r.documents.map((d) => `| ${d.key} | ${d.role} | ${d.domain} | ${d.sections} | ${d.normative} | ${d.mapped} |`),
    '', `## Unmapped normative units (${r.unmapped.length})`, '',
    ...r.unmapped.map((u) => `- \`${u.sentenceId}\` ${u.label ?? ''} (${u.score}) ${ex({ docKey: docOf(u.sectionId), sectionId: u.sectionId, start: u.start, end: u.end })}`),
    '', `## Unprocessed sections (${r.unprocessedSections.length})`, '',
    ...r.unprocessedSections.map((s) => `- \`${s.sectionId}\` ${s.label ?? ''} — ${s.reason}`),
    '', `## Ambiguities (${r.ambiguities.length})`, '',
    ...r.ambiguities.map((a) => `- ${a.detector} \`${a.at.sectionId}\` ${ex(a.at)}`),
    '', `## Contradictions (${r.contradictions.length})`, '',
    ...r.contradictions.map((x) => {
      const how = x.resolution.by === 'precedence' ? `resolved by precedence: ${x.resolution.over} governs` : x.resolution.by === 'unordered' ? 'unordered: open'
        : `open${x.crossDomain ? ` (cross-domain${x.declaredDependency ? ', declared dependency' : ''})` : ''}`;
      return `- ${x.detector} (${x.confidence}) \`${x.a.sectionId}\` ${ex(x.a)} ⟷ \`${x.b.sectionId}\` ${ex(x.b)} — ${how}`;
    }),
    '', `## Dangling references (${r.danglingRefs.length})`, '',
    // The reference's own text is corpus text too: the same withhold rule as every excerpt.
    ...r.danglingRefs.map((d) => `- \`${d.fromSection}\` ${d.kind} ${ex({ docKey: docOf(d.fromSection), sectionId: d.fromSection, start: d.start, end: d.end })} — ${d.reason ?? 'unresolved'}`),
    '', `## Disagreements between extractors (${r.disagreements.length})`, '',
    ...r.disagreements.map((d) => `- ${d.kind} \`${d.sectionId}\` ${d.irIds.length} record(s), ${d.extractors.length} extractor(s)`),
    '', `## Unsupported inferences (${r.unsupported.length}) and stale records (${r.stale.length})`, '',
    ...r.unsupported.map((u) => `- unsupported ${u.kind} \`${u.irId}\``), ...r.stale.map((s) => `- stale ${s.status} \`${s.irId}\``),
  ];
  if (r.seeded) {
    lines.push('', `## Seeded defects (${r.seeded.filter((s) => s.detected).length}/${r.seeded.length} detected)`, '',
      ...r.seeded.map((s) => `- ${s.id} ${s.kind}: ${s.detected ? 'detected' : 'MISSED'} by ${s.by.join(', ') || 'nothing'}`));
  }
  return `${lines.join('\n')}\n`;
}

/** Fenced code blocks a document holds: the sectioner never reads them; listed so a person knows. */
export function fencedBlocksOf(c: { docs: Array<{ key: string }>; bytesOf(key: string): Buffer }): Array<{ docKey: string; start: number; end: number }> {
  return c.docs.flatMap((d) => fencesOf(c.bytesOf(d.key)).map((f) => ({ docKey: d.key, ...f })));
}
