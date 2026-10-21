import fs from 'node:fs';
import path from 'node:path';
import type { IrAttrs, IrKind, IrSource } from '../../mission/types.ts';

/**
 * The mock IR of a benchmark corpus (spec ingestion §11.1–11.2): what a perfect extractor would
 * propose, as fixture data. Project-agnostic: a record names its document by key and its quote by
 * byte offset, never by a section id (section ids are the sectioner's to mint), so the scripted
 * extractor finds the section at run time and a fixture survives sectioner changes.
 *
 * Two provenances, stated per record: `hand` records were written and checked by a person against
 * the text (P2-R50 Q9); `mechanical` records are produced by `mechanicalRecords` from the rule in
 * the file's header, and a test regenerates them and compares, so the file never drifts from the
 * rule that claims to have produced it; `generated` records are written by a synthetic corpus's own
 * generator beside the text they quote (complete by construction).
 */

export interface OverlaySpan { docKey: string; at: number; quote: string }
export interface OverlayRecord extends OverlaySpan {
  key: string; check: 'hand' | 'mechanical' | 'generated'; kind: IrKind; source: IrSource; statement: string; confidence: number; attrs: IrAttrs;
  other?: OverlaySpan;
}
export interface MechanicalRule {
  /** Case-insensitive cue regex; a line is a unit when it matches. */
  cues: string;
  /** Lines matching this (case-insensitive) make a record a `constraint` rather than a `requirement`. */
  negative: string;
  /** Headings (case-insensitive) whose subtree is skipped: informative material is not normative. */
  skipHeadings: string;
}
export interface OverlayFile { kind: 'daylight-ir-overlay'; v: 1; corpus: string; mechanical: MechanicalRule; records: OverlayRecord[] }

export const MAX_QUOTE_BYTES = 2048;

export function readOverlay(file: string): OverlayFile {
  const o = JSON.parse(fs.readFileSync(file, 'utf8')) as OverlayFile;
  if (o.kind !== 'daylight-ir-overlay' || o.v !== 1 || !Array.isArray(o.records)) throw new Error(`${path.basename(file)} is not an IR overlay`);
  return o;
}

/** Problems with a record against the documents: its bytes are not at its offset, or it is too long. */
export function overlayProblems(docs: ReadonlyMap<string, Buffer>, records: readonly OverlayRecord[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const at = (r: string, s: OverlaySpan) => {
    const b = docs.get(s.docKey);
    if (!b) return out.push(`${r}: no document ${s.docKey}`);
    const q = Buffer.from(s.quote, 'utf8');
    if (q.length === 0 || q.length > MAX_QUOTE_BYTES) out.push(`${r}: quote is ${q.length} bytes`);
    if (!b.subarray(s.at, s.at + q.length).equals(q)) out.push(`${r}: quote is not at byte ${s.at} of ${s.docKey}`);
    return 0;
  };
  for (const r of records) {
    if (seen.has(r.key)) out.push(`${r.key}: duplicate key`);
    seen.add(r.key);
    at(r.key, r);
    if (r.other) at(`${r.key}.other`, r.other);
  }
  return out;
}

interface Line { start: number; text: string; no: number }

function linesOf(buf: Buffer): Line[] {
  const out: Line[] = [];
  let start = 0;
  let no = 1;
  while (start <= buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    out.push({ start, text: buf.subarray(start, end).toString('utf8'), no });
    start = end + 1;
    no++;
    if (end === buf.length) break;
  }
  return out;
}

/**
 * One record per cue-bearing body line not already overlapped by a hand record, in document order.
 * A line is body text when it is outside a fence, not a heading, not a table separator, not an
 * image and not blank; its quote is the line minus indentation, list marker and trailing spaces,
 * cut at the last sentence end under the quote cap. Deterministic: same documents and hand
 * records, same output.
 */
export function mechanicalRecords(docs: ReadonlyMap<string, Buffer>, hand: readonly OverlayRecord[], rule: MechanicalRule): OverlayRecord[] {
  const cue = new RegExp(rule.cues, 'i');
  const neg = new RegExp(rule.negative, 'i');
  const skip = new RegExp(rule.skipHeadings, 'i');
  const taken = new Map<string, Array<[number, number]>>();
  const take = (s: OverlaySpan) => {
    const l = taken.get(s.docKey) ?? [];
    l.push([s.at, s.at + Buffer.byteLength(s.quote, 'utf8')]);
    taken.set(s.docKey, l);
  };
  for (const r of hand) {
    take(r);
    if (r.other) take(r.other);
  }
  const out: OverlayRecord[] = [];
  for (const docKey of [...docs.keys()].sort()) {
    const buf = docs.get(docKey)!;
    let fence: string | null = null;
    let skipLevel = 0;
    for (const line of linesOf(buf)) {
      const t = line.text;
      const f = /^\s*(`{3,}|~{3,})/.exec(t);
      if (f) {
        if (fence === null) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        continue;
      }
      if (fence !== null) continue;
      const h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) {
        const level = h[1].length;
        if (skipLevel && level <= skipLevel) skipLevel = 0;
        if (!skipLevel && skip.test(h[2])) skipLevel = level;
        continue;
      }
      if (skipLevel || !t.trim() || /^\s*\|?\s*:?-{3,}/.test(t) || /^\s*!\[/.test(t) || !cue.test(t)) continue;
      const lead = /^(\s*(?:[-*+]\s+|\d+\.\s+|>\s*)?)/.exec(t)![1];
      let quote = t.slice(lead.length).replace(/\s+$/, '');
      if (!quote) continue;
      while (Buffer.byteLength(quote, 'utf8') > MAX_QUOTE_BYTES) {
        const cut = quote.slice(0, quote.length - 1).search(/[.!?](?=[^.!?]*$)/);
        quote = cut > 0 ? quote.slice(0, cut + 1) : quote.slice(0, 1024);
      }
      const at = line.start + Buffer.byteLength(lead, 'utf8');
      const end = at + Buffer.byteLength(quote, 'utf8');
      if ((taken.get(docKey) ?? []).some(([a, b]) => a < end && b > at)) continue;
      const statement = quote.replace(/\s+/g, ' ').slice(0, 160);
      out.push({ key: `m:${docKey}:${line.no}`, check: 'mechanical', docKey, at, quote, kind: neg.test(quote) ? 'constraint' : 'requirement', source: 'extracted',
        statement, confidence: 0.6, attrs: {} });
    }
  }
  return out;
}

/** The committed form: a header, then one record per line, so a diff names the record that changed. */
export function formatOverlay(o: OverlayFile): string {
  const head = JSON.stringify({ kind: o.kind, v: o.v, corpus: o.corpus, mechanical: o.mechanical }, null, 1).replace(/\n}$/, '');
  return `${head},\n "records": [\n${o.records.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n ]\n}\n`;
}

/** Hand (or generated) records plus the mechanical records their rule yields over `docs`. */
export function buildOverlay(corpus: string, docs: ReadonlyMap<string, Buffer>, written: readonly OverlayRecord[], rule: MechanicalRule): OverlayFile {
  return { kind: 'daylight-ir-overlay', v: 1, corpus, mechanical: rule, records: [...written, ...mechanicalRecords(docs, written, rule)] };
}

/** The documents a fixture names, by key, as bytes. */
export function readDocs(root: string, docs: Record<string, string>): Map<string, Buffer> {
  return new Map(Object.entries(docs).map(([k, p]) => [k, fs.readFileSync(path.join(root, p))]));
}
