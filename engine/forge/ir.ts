import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { OutboxToolSpec } from '../mcp/outbox-server.ts';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import { redact } from '../mission/redact.ts';
import type { IrAttrs, IrProposal, IrProposalContext, IrProposalField, IrRecord } from '../mission/types.ts';
import { IR_KINDS, IR_TRANSITIONS } from '../mission/types.ts';
import { textRefusal } from './proposal.ts';

/**
 * Spec IR records and the `propose_ir_record` boundary (spec ingestion §4). Pure.
 *
 * A proposal crosses MCP as data and is checked twice, by the server and again on the host, by
 * this one validator: unknown keys refused, first refusal only, a field and a fixed reason,
 * never the text. The host never trusts an offset an agent could send: an extractor quotes, and
 * `resolveQuote` finds those exact bytes in the section body. A quote that occurs more than once
 * needs `occurrence`; one that does not occur is refused. Nothing here approves anything.
 */

export { IR_TRANSITIONS };
export const MAX_IR_PROPOSAL_BYTES = 12 * 1024;
export const MAX_IR_PROPOSALS_PER_ATTEMPT = 200;
export const IR_PROPOSALS_DIR = 'ir-proposals';
export const MAX_IR_STATEMENT_BYTES = 4 * 1024;
export const MAX_IR_QUOTE_BYTES = 2 * 1024;
const MAX_BASIS = 8;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
type Refusal = { field: IrProposalField; refused: string };
const refuse = (field: IrProposalField, refused: string): Refusal => ({ field, refused });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const oneLine = (v: unknown, max: number) => textRefusal(v, max, false);

/** Every start of `quote` in `text`, as character indexes. */
function indexesOf(text: string, quote: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) out.push(i);
  return out;
}

/**
 * Where `quote` sits in a section body, in document bytes: the `occurrence`-th match (1-based), or
 * the only one. Null when the quote is absent, occurs more than once with no occurrence given, or
 * the occurrence is past the last match.
 */
export function resolveQuote(body: { start: number; text: string }, quote: string, occurrence?: number): { start: number; end: number } | null {
  if (!quote) return null;
  const at = indexesOf(body.text, quote);
  if (!at.length) return null;
  if (occurrence === undefined && at.length > 1) return null;
  const i = at[(occurrence ?? 1) - 1];
  if (i === undefined) return null;
  const start = body.start + Buffer.byteLength(body.text.slice(0, i), 'utf8');
  return { start, end: start + Buffer.byteLength(quote, 'utf8') };
}

function attrsRefusal(a: unknown, ctx?: IrProposalContext): string | null {
  if (a === undefined) return null;
  if (!isObj(a)) return 'not an object';
  const known = new Set(['tags', 'milestone', 'subject', 'polarity', 'numbers', 'interfaceName', 'dependency', 'deferral', 'decision', 'ticketRefs']);
  if (Object.keys(a).some((k) => !known.has(k))) return 'unknown attribute';
  if (a.tags !== undefined) {
    if (!Array.isArray(a.tags) || a.tags.length > 8 || a.tags.some((t) => oneLine(t, 32))) return 'tags: at most 8 words of 32 bytes';
    const vocab = ctx?.config.tags ?? [];
    if (vocab.length && a.tags.some((t) => !vocab.includes(t as string))) return 'tags: not in the configured vocabulary';
  }
  if (a.milestone !== undefined) {
    if (oneLine(a.milestone, 16)) return 'milestone: one word of at most 16 bytes';
    const re = ctx?.config.milestone;
    if (re && !new RegExp(re, 'u').test(a.milestone as string)) return 'milestone: not in the configured scheme';
  }
  if (a.subject !== undefined && oneLine(a.subject, 80)) return 'subject: one line of at most 80 bytes';
  if (a.polarity !== undefined && a.polarity !== 'positive' && a.polarity !== 'negative') return 'polarity: positive or negative';
  if (a.numbers !== undefined && (!Array.isArray(a.numbers) || a.numbers.length > 16 || a.numbers.some((n) => !isObj(n)
    || typeof n.value !== 'number' || !Number.isFinite(n.value) || Object.keys(n).some((k) => k !== 'value' && k !== 'unit')
    || (n.unit !== undefined && oneLine(n.unit, 16))))) return 'numbers: at most 16 { value, unit? }';
  if (a.interfaceName !== undefined && oneLine(a.interfaceName, 120)) return 'interfaceName: one line of at most 120 bytes';
  if (a.dependency !== undefined && (!isObj(a.dependency) || Object.keys(a.dependency).some((k) => k !== 'from' && k !== 'to')
    || oneLine(a.dependency.from, 120) || oneLine(a.dependency.to, 120))) return 'dependency: { from, to }';
  if (a.deferral !== undefined && (!isObj(a.deferral) || Object.keys(a.deferral).some((k) => k !== 'to') || oneLine(a.deferral.to, 120))) return 'deferral: { to }';
  if (a.decision !== undefined && (!isObj(a.decision) || Object.keys(a.decision).some((k) => k !== 'ref' && k !== 'status') || oneLine(a.decision.ref, 64)
    || !['proposed', 'accepted', 'superseded'].includes(a.decision.status as string))) return 'decision: { ref, status }';
  if (a.ticketRefs !== undefined && (!Array.isArray(a.ticketRefs) || a.ticketRefs.length > 16
    || a.ticketRefs.some((t) => typeof t !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(t)))) return 'ticketRefs: at most 16 ids';
  return null;
}

function quoteRefusal(q: unknown): string | null {
  if (typeof q !== 'string') return 'not a string';
  if (Buffer.byteLength(q, 'utf8') > MAX_IR_QUOTE_BYTES) return `over ${MAX_IR_QUOTE_BYTES} bytes`;
  if (CONTROL.test(q)) return 'control character';
  // A quote is stored verbatim, so one that would need masking is refused rather than masked.
  if (q && redact(q).redactions > 0) return 'secret-shaped text';
  return null;
}

/**
 * The proposal, normalised, or its first refusal. With a context (the host, and the server when it
 * has the window): the section must be one of the window's (its own or linked), and each quote must
 * occur in that section's body exactly once, or at the `occurrence` given.
 */
export function validateIrProposal(raw: unknown, ctx?: IrProposalContext): IrProposal | { field: IrProposalField; refused: string } {
  if (!isObj(raw)) return refuse('payload', 'not an object');
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    return refuse('payload', 'not serialisable');
  }
  if (size > MAX_IR_PROPOSAL_BYTES) return refuse('payload', `over ${MAX_IR_PROPOSAL_BYTES} bytes`);
  const known = new Set(['kind', 'source', 'statement', 'confidence', 'attrs', 'section', 'quote', 'occurrence', 'other', 'basisSections']);
  if (Object.keys(raw).some((k) => !known.has(k))) return refuse('payload', 'unknown field');
  if (!(IR_KINDS as readonly unknown[]).includes(raw.kind)) return refuse('kind', 'not an IR kind');
  if (raw.source !== 'extracted' && raw.source !== 'inferred') return refuse('source', 'extracted or inferred');
  const sWhy = textRefusal(raw.statement, MAX_IR_STATEMENT_BYTES, true);
  if (sWhy) return refuse('statement', sWhy);
  if (typeof raw.confidence !== 'number' || !(raw.confidence >= 0 && raw.confidence <= 1)) return refuse('confidence', 'a number from 0 to 1');
  const aWhy = attrsRefusal(raw.attrs, ctx);
  if (aWhy) return refuse('attrs', aWhy);
  const inWindow = (id: string) => !ctx || ctx.window.sectionIds.includes(id) || ctx.window.linked.includes(id);
  if (typeof raw.section !== 'string' || !raw.section || raw.section.length > 400) return refuse('section', 'a section id');
  if (!inWindow(raw.section)) return refuse('section', 'not a section of this window');
  const qWhy = quoteRefusal(raw.quote);
  if (qWhy) return refuse('quote', qWhy);
  if (raw.quote === '' && raw.source !== 'inferred') return refuse('quote', 'an extracted record quotes the text');
  if (raw.occurrence !== undefined && (!Number.isInteger(raw.occurrence) || (raw.occurrence as number) < 1)) return refuse('occurrence', 'an integer from 1');
  const placed = (section: string, quote: string, occurrence: unknown, other: boolean): Refusal | null => {
    if (!ctx || !quote) return null;
    const n = indexesOf(ctx.bodyOf(section).text, quote).length;
    if (n === 0) return refuse(other ? 'other' : 'quote', 'does not occur in the section');
    if (n > 1 && occurrence === undefined) return refuse(other ? 'other' : 'occurrence', 'the quote occurs more than once; say which occurrence');
    if (occurrence !== undefined && (occurrence as number) > n) return refuse(other ? 'other' : 'occurrence', 'past the last occurrence');
    return null;
  };
  const here = placed(raw.section, raw.quote as string, raw.occurrence, false);
  if (here) return here;
  let other: IrProposal['other'];
  if (raw.other !== undefined) {
    const o = raw.other;
    if (!isObj(o) || Object.keys(o).some((k) => !['section', 'quote', 'occurrence'].includes(k))) return refuse('other', 'a { section, quote, occurrence? }');
    if (typeof o.section !== 'string' || !inWindow(o.section)) return refuse('other', 'not a section of this window');
    if (quoteRefusal(o.quote) || !o.quote) return refuse('other', 'a verbatim quote');
    if (o.occurrence !== undefined && (!Number.isInteger(o.occurrence) || (o.occurrence as number) < 1)) return refuse('other', 'occurrence is an integer from 1');
    const there = placed(o.section, o.quote as string, o.occurrence, true);
    if (there) return there;
    other = { section: o.section, quote: o.quote as string, ...(o.occurrence !== undefined ? { occurrence: o.occurrence as number } : {}) };
  }
  const basis = raw.basisSections ?? [];
  if (!Array.isArray(basis) || basis.length > MAX_BASIS || basis.some((b) => typeof b !== 'string' || !inWindow(b))) {
    return refuse('basisSections', `at most ${MAX_BASIS} section ids of this window`);
  }
  return {
    kind: raw.kind as IrProposal['kind'], source: raw.source, statement: raw.statement as string, confidence: raw.confidence,
    ...(raw.attrs !== undefined ? { attrs: raw.attrs as IrAttrs } : {}), section: raw.section, quote: raw.quote as string,
    ...(raw.occurrence !== undefined ? { occurrence: raw.occurrence as number } : {}), ...(other ? { other } : {}),
    ...(basis.length ? { basisSections: [...new Set(basis as string[])] } : {}),
  };
}

const masked = (s: string) => redact(s).text;

/** The statement and free-text attributes with secret-shaped text masked; quotes are never masked (they were refused instead). */
export function redactIrProposal(p: IrProposal): IrProposal {
  const attrs = p.attrs ? {
    ...p.attrs, ...(p.attrs.subject !== undefined ? { subject: masked(p.attrs.subject) } : {}),
    ...(p.attrs.interfaceName !== undefined ? { interfaceName: masked(p.attrs.interfaceName) } : {}),
  } : undefined;
  return { ...p, statement: masked(p.statement), ...(attrs ? { attrs } : {}) };
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Attempt-independent: the same reading of the same text by two extractors is one record (§4.3). */
export function irIdOf(corpusId: string, p: Pick<IrProposal, 'kind' | 'source' | 'section' | 'quote' | 'occurrence' | 'statement'>): string {
  return `ir_${sha256hex(canonicalJson([corpusId, p.kind, p.source, p.section, p.quote, p.occurrence ?? 1, collapse(p.statement)])).slice(0, 32)}`;
}

/**
 * What an approval names: kind, source, the document and the quoted text, the statement and the
 * attributes. No section id, no offsets and no basis, so a rename or a move never re-approves.
 */
export function irContentDigestOf(r: Pick<IrRecord, 'kind' | 'source' | 'statement' | 'attrs' | 'basisSections'>
  & { docKey: string | null; quote: string; otherQuote: string | null }): string {
  return digestOf(canonicalJson({ kind: r.kind, source: r.source, docKey: r.docKey, quote: r.quote, otherQuote: r.otherQuote, statement: r.statement, attrs: r.attrs ?? {} }));
}

export const isIrRefusal = (v: IrProposal | { field: string; refused: string }): v is { field: IrProposalField; refused: string } => 'refused' in v;

export const IR_OUTBOX_SPEC: OutboxToolSpec<IrProposal> = {
  tool: 'propose_ir_record',
  description:
    'Propose ONE Spec IR record read from the window you were given. It is recorded for a person to approve or reject; nothing is ' +
    'approved by proposing it. `section` is a section id listed in your prompt; `quote` is copied EXACTLY from that section ' +
    '(add `occurrence` when the same words occur more than once there). If you are concluding rather than reading, set `source` ' +
    `to inferred and name the sections it rests on in \`basisSections\`. At most ${MAX_IR_PROPOSALS_PER_ATTEMPT} per session.`,
  inputSchema: {
    kind: z.enum(IR_KINDS), source: z.enum(['extracted', 'inferred']), statement: z.string().max(MAX_IR_STATEMENT_BYTES),
    confidence: z.number(), attrs: z.record(z.string(), z.unknown()).optional(), section: z.string().max(400),
    quote: z.string().max(MAX_IR_QUOTE_BYTES), occurrence: z.number().int().optional(),
    other: z.object({ section: z.string().max(400), quote: z.string().max(MAX_IR_QUOTE_BYTES), occurrence: z.number().int().optional() }).optional(),
    basisSections: z.array(z.string().max(400)).max(MAX_BASIS).optional(),
  },
  dirName: IR_PROPOSALS_DIR, maxPerAttempt: MAX_IR_PROPOSALS_PER_ATTEMPT, maxLineBytes: MAX_IR_PROPOSAL_BYTES + 512,
  validate: (raw) => validateIrProposal(raw),
  redact: (p) => redactIrProposal(p),
  eventDetail: (p) => ({ kind: p.kind, source: p.source, section: p.section.slice(0, 200) }),
};
