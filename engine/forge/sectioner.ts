import { createHash } from 'node:crypto';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import type { DaylightContext } from '../mission/context.ts';
import type {
  CorpusDoc, CorpusManifest, CorpusRevision, CrossRef, ExtractWindow, NormativeSentence, Section, SectionerConfig, SectionIndex, Task, XrefLink,
} from '../mission/types.ts';
import { MAX_WINDOW_BYTES, WINDOW_TARGET_BYTES } from '../mission/types.ts';
import { slugOf } from './proposal.ts';

/**
 * The hierarchical sectioner (spec ingestion §3): pure, no LLM, no file, no store, except
 * `windowOfTask`, which reads one artifact.
 *
 * A document becomes a tree of sections with stable ids (`<docKey>:<heading slug path>`) and
 * UTF-8 byte spans; each section body becomes units (list items, table rows, standalone lines,
 * prose sentences), scored by a documented heuristic whose every word list and pattern is data
 * (`SectionerConfig`, P2-R52): nothing here names a project. A unit at or above
 * `config.threshold` is normative and must be mapped by a record or listed as unmapped.
 *
 * The heuristic: the largest matching cue weight, a rule-list base for list items and table rows
 * of a section whose title is a rule section or that follow a scored lead ending `:`, a
 * lead-continuation base for the one line right after such a lead, then +0.2 for a leading bold
 * sentence, capped at 1. Informative sections (inherited) score ×0.4, withdrawn ones 0; an
 * open-decision section keeps its score and every unit gains the hedge `open-decision`.
 *
 * Same bytes and same config give the same ids, spans and digests, byte for byte.
 */

export { MAX_WINDOW_BYTES, WINDOW_TARGET_BYTES };
export const SECTIONER_VERSION = 'daylight-sectioner/2';
const BUILTIN_XREF_KINDS = ['section', 'decision', 'errata', 'correction', 'ticket', 'milestone', 'enumerated', 'figure', 'doc-version'];
/** Linked text a window may carry beside its own bodies (§3.5). */
export const MAX_LINKED_BYTES = 12 * 1024;

/** RFC-2119 modals, generic imperatives and keywords; `§n` and `ADR n` labels; no project vocabulary. */
export const DEFAULT_SECTIONER_CONFIG: SectionerConfig = Object.freeze({
  v: 1,
  threshold: 0.5,
  labels: [
    { id: 'numbered', heading: '^(\\d+(?:\\.\\d+)*[A-Z]?)\\.?(?:\\s|$)', label: '§$1' },
    { id: 'adr', heading: '^ADR[- ]?0*(\\d{1,4})\\b', label: 'ADR $1' },
  ],
  xrefs: [
    { id: 'section', pattern: '§§?\\s?(\\d+(?:\\.\\d+)*[A-Z]?)', kind: 'section', label: '§$1', scope: 'domain' },
    { id: 'adr', pattern: '\\bADRs?[- ]?0*(\\d{1,4})\\b', kind: 'decision', label: 'ADR $1', scope: 'domain' },
  ],
  cues: [
    { id: 'must', pattern: 'must|shall|never|required|refuses?|refused|forbids?|forbidden', weight: 0.9, type: 'normative' },
    { id: 'only', pattern: 'only|cannot|can ?not|may not|always|no\\s+\\p{L}{3,}', weight: 0.7, type: 'normative' },
    { id: 'should', pattern: 'should', weight: 0.45, type: 'normative' },
    { id: 'hedge', pattern: 'where possible|if possible|as appropriate|ideally|typically|to be decided|tbd|unclear', weight: 0, type: 'hedge' },
  ],
  imperatives: ['define', 'build', 'verify', 'refuse', 'reject', 'record', 'ensure', 'provide', 'keep', 'use', 'validate', 'store', 'emit',
    'display', 'expose', 'support', 'implement', 'check', 'return', 'include', 'track', 'preserve', 'prevent', 'avoid', 'require', 'allow',
    'create', 'install', 'publish', 'sign', 'compute', 'render', 'log', 'report', 'treat', 'test'],
  ruleSections: ['rule', 'test', 'requirement', 'boundar', 'invariant', 'acceptance', 'constraint'],
  informative: ['informative', 'non-normative', 'illustrative', 'example', 'history'],
  openDecision: ['open decision', 'open design decision', 'open question', 'future adr', 'owner decision'],
  tags: [],
  milestone: null,
}) as SectionerConfig;

/** One document as the sectioner reads it. */
export interface SectionerDoc { key: string; bytes: Buffer; role?: CorpusDoc['role']; title?: string }

const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const round = (x: number) => Math.round(x * 1e6) / 1e6;

// ---- configuration ---------------------------------------------------------------------

const CONFIG_KEYS = new Set(['v', 'threshold', 'labels', 'xrefs', 'cues', 'imperatives', 'ruleSections', 'informative', 'openDecision', 'tags', 'milestone',
  'domains', 'xrefKinds']);

const compiles = (p: unknown, flags: string): boolean => {
  if (typeof p !== 'string' || p.length > 400) return false;
  try {
    new RegExp(p, flags);
    return true;
  } catch {
    return false;
  }
};
const words = (v: unknown, max: number): boolean =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 64);

/** Why a configuration is not one this sectioner can run, or null. Patterns are compiled; nothing is echoed. */
export function configRefusal(c: SectionerConfig): string | null {
  for (const k of Object.keys(c)) if (!CONFIG_KEYS.has(k)) return 'unknown sectioner key';
  if (c.v !== 1) return 'sectioner config version must be 1';
  if (typeof c.threshold !== 'number' || !(c.threshold > 0 && c.threshold <= 1)) return 'threshold must be in (0, 1]';
  if (!Array.isArray(c.labels) || c.labels.length > 64 || !c.labels.every((l) => l && typeof l.id === 'string' && compiles(l.heading, 'u')
    && typeof l.label === 'string' && (l.docTitle === undefined || compiles(l.docTitle, 'u')))) return 'labels: each needs an id, a heading pattern and a label';
  if (c.xrefKinds !== undefined && !words(c.xrefKinds, 16)) return 'xrefKinds must be a list of names';
  const kinds = new Set([...BUILTIN_XREF_KINDS, ...(c.xrefKinds ?? [])]);
  if (!Array.isArray(c.xrefs) || c.xrefs.length > 64 || !c.xrefs.every((x) => x && typeof x.id === 'string' && compiles(x.pattern, 'gu') && kinds.has(x.kind)
    && ['doc', 'domain', 'any'].includes(x.scope))) return 'xrefs: each needs an id, a pattern, a known kind (built-in or in xrefKinds) and a scope';
  if (!Array.isArray(c.cues) || c.cues.length > 64 || !c.cues.every((q) => q && typeof q.id === 'string' && compiles(q.pattern, 'iu')
    && typeof q.weight === 'number' && q.weight >= 0 && q.weight <= 1 && (q.type === 'normative' || q.type === 'hedge'))) {
    return 'cues: each needs an id, a pattern, a weight in [0, 1] and a type';
  }
  for (const k of ['imperatives', 'ruleSections', 'informative', 'openDecision', 'tags'] as const) if (!words(c[k], 256)) return `${k} must be a list of words`;
  if (c.milestone !== null && !compiles(c.milestone, 'u')) return 'milestone must be a pattern or null';
  for (const [d, o] of Object.entries(c.domains ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(d) || !o || typeof o !== 'object') return 'domains: keys are domain names';
    if (o.milestone !== undefined && o.milestone !== null && !compiles(o.milestone, 'u')) return 'a domain milestone must be a pattern or null';
    if (o.tags !== undefined && !words(o.tags, 256)) return 'domain tags must be a list of words';
  }
  return null;
}

/**
 * The manifest's sectioner (inline, or its `$ref` sidecar's bytes parsed by the caller) merged over
 * the defaults, key by key (a list given replaces the default list), and its digest.
 */
export function effectiveConfig(m: CorpusManifest, sidecar?: Partial<SectionerConfig>): { config: SectionerConfig; configDigest: string } {
  const inline = m.sectioner && !('$ref' in m.sectioner) ? m.sectioner as Partial<SectionerConfig> : {};
  const config = { ...structuredClone(DEFAULT_SECTIONER_CONFIG), ...inline, ...(sidecar ?? {}) } as SectionerConfig;
  const why = configRefusal(config);
  if (why) throw new Error(`sectioner config refused: ${why}`);
  return { config, configDigest: digestOf(canonicalJson(config)) };
}

/** The config with a domain's milestone and tag vocabulary in force (P2-R54). */
export function configForDomain(c: SectionerConfig, domain: string): SectionerConfig {
  const d = c.domains?.[domain];
  if (!d) return c;
  return { ...c, milestone: d.milestone !== undefined ? d.milestone : c.milestone, tags: d.tags ?? c.tags };
}

// ---- lines -----------------------------------------------------------------------------

interface Line { text: string; start: number; end: number /* bytes, excluding the newline */; next: number /* byte after the newline */ }

function linesOf(bytes: Buffer): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (;;) {
    let nl = bytes.indexOf(0x0a, start);
    if (nl < 0) nl = bytes.length;
    out.push({ text: bytes.subarray(start, nl).toString('utf8'), start, end: nl, next: Math.min(nl + 1, bytes.length) });
    if (nl >= bytes.length) break;
    start = nl + 1;
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

/** Fenced code blocks of a document, as byte spans (opening fence line to closing fence line): never units. */
export function fencesOf(bytes: Buffer): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let open: { mark: string; start: number } | null = null;
  for (const l of linesOf(bytes)) {
    const f = FENCE.exec(l.text);
    if (!f) continue;
    if (open === null) open = { mark: f[1][0].repeat(f[1].length), start: l.start };
    else if (f[1].startsWith(open.mark)) {
      out.push({ start: open.start, end: l.end });
      open = null;
    }
  }
  if (open) out.push({ start: open.start, end: bytes.length });
  return out;
}

// ---- sections --------------------------------------------------------------------------

function sectionIdOf(docKey: string, anchorPath: string): string {
  const full = `${docKey}:${anchorPath}`;
  return full.length > 200 ? `${full.slice(0, 160)}~${sha256hex(full).slice(0, 12)}` : full;
}

const hasWord = (text: string, list: readonly string[]) => {
  const t = text.toLowerCase();
  return list.some((w) => t.includes(w.toLowerCase()));
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstLineSays = (line: string, list: readonly string[]) =>
  list.some((w) => new RegExp(`^\\W*(?:this\\s+\\w+\\s+is\\s+)?${escapeRe(w)}\\b`, 'iu').test(line.trim()));

/** The label the first matching rule gives a heading, or null. */
export function labelOf(title: string, doc: { key: string; role?: CorpusDoc['role']; title?: string }, config: SectionerConfig): string | null {
  for (const rule of config.labels) {
    if (rule.roles && (!doc.role || !rule.roles.includes(doc.role))) continue;
    if (rule.docTitle !== undefined && !new RegExp(rule.docTitle, 'u').test(doc.title ?? '')) continue;
    const m = new RegExp(rule.heading, 'u').exec(title.trim());
    if (m) return rule.label.replace(/\$(\d)/g, (_s, n: string) => m[Number(n)] ?? '');
  }
  return null;
}

/**
 * The document's section tree: a synthetic root (level 0, the text before the first heading), then
 * every ATX heading outside fences in order. A document with no ATX heading is the root alone.
 */
export function sectionDocument(docKey: string, bytes: Buffer, config: SectionerConfig, doc: { role?: CorpusDoc['role'] } = {}): Section[] {
  const lines = linesOf(bytes);
  const heads: Array<{ level: number; title: string; start: number; bodyStart: number; slug: string }> = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (const l of lines) {
    const f = FENCE.exec(l.text);
    if (f) {
      if (fence === null) fence = f[1][0].repeat(f[1].length);
      else if (f[1].startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = ATX.exec(l.text);
    if (!h) continue;
    const base = slugOf(h[2]);
    if (!base) continue;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    heads.push({ level: h[1].length, title: h[2].trim(), start: l.start, bodyStart: l.next, slug: n ? `${base}-${n}` : base });
  }
  const docTitle = heads.find((h) => h.level === 1)?.title ?? docKey;
  const firstLine = (s: number, e: number) => bytes.subarray(s, e).toString('utf8').split('\n').find((x) => x.trim()) ?? '';
  const flags = (title: string, s: number, e: number) => {
    const first = firstLine(s, e);
    return {
      informative: hasWord(title, config.informative) || firstLineSays(first, config.informative),
      withdrawn: /\bwithdrawn\b/i.test(title) || /^\W*withdrawn\b/i.test(first.trim()),
      openDecision: hasWord(title, config.openDecision) || firstLineSays(first, config.openDecision),
    };
  };
  const rootBodyEnd = heads[0]?.start ?? bytes.length;
  const root: Section = {
    id: sectionIdOf(docKey, ''), docKey, label: null, title: docTitle, level: 0, parentId: null, start: 0, end: bytes.length, bodyStart: 0,
    bodyEnd: rootBodyEnd, bodyDigest: digestOf(bytes.subarray(0, rootBodyEnd)), informative: false, withdrawn: false, openDecision: false,
  };
  const out: Section[] = [root];
  const stack: Array<{ level: number; slug: string; section: Section }> = [];
  heads.forEach((h, i) => {
    while (stack.length && stack.at(-1)!.level >= h.level) stack.pop();
    const parent = stack.at(-1)?.section ?? root;
    const anchor = [...stack.map((s) => s.slug), h.slug].join('/');
    const bodyEnd = Math.max(h.bodyStart, heads[i + 1]?.start ?? bytes.length);
    const end = heads.slice(i + 1).find((x) => x.level <= h.level)?.start ?? bytes.length;
    const own = flags(h.title, h.bodyStart, bodyEnd);
    const s: Section = {
      id: sectionIdOf(docKey, anchor), docKey, label: labelOf(h.title, { key: docKey, role: doc.role, title: docTitle }, config), title: h.title,
      level: h.level, parentId: parent.id, start: h.start, end, bodyStart: h.bodyStart, bodyEnd, bodyDigest: digestOf(bytes.subarray(h.bodyStart, bodyEnd)),
      informative: own.informative || parent.informative, withdrawn: own.withdrawn || parent.withdrawn, openDecision: own.openDecision || parent.openDecision,
    };
    out.push(s);
    stack.push({ level: h.level, slug: h.slug, section: s });
  });
  return out;
}

// ---- units -----------------------------------------------------------------------------

/** One unit of a section body, before scoring. `text` is the unit's own bytes, decoded. */
export interface RawUnit { start: number; end: number; text: string; kind: 'item' | 'row' | 'line' | 'sentence'; block: number; lastInBlock: boolean }

const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const SENTENCE_END = /[.!?](?=\s+[\p{Lu}`*(])/gu;
const ABBREV = /(?:\be\.g|\bi\.e|\betc|\bvs)\.$/i;

/** A trimmed span of `text` (which starts at byte `base`) from char `a` to char `b`. */
function trimmedSpan(text: string, base: number, a: number, b: number): { start: number; end: number; text: string } | null {
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  if (a >= b) return null;
  return { start: base + byteLen(text.slice(0, a)), end: base + byteLen(text.slice(0, b)), text: text.slice(a, b) };
}

/** Every unit of the body span `[start, end)` of `bytes`: fences and their contents excluded. */
export function rawUnitsOf(bytes: Buffer, start: number, end: number): RawUnit[] {
  const lines = linesOf(bytes.subarray(start, end)).map((l) => ({ ...l, start: l.start + start, end: l.end + start, next: l.next + start }));
  const out: RawUnit[] = [];
  let fence: string | null = null;
  let block: Line[] = [];
  let blockNo = 0;
  const flush = () => {
    if (!block.length) return;
    const units = unitsOfBlock(block, blockNo++);
    if (units.length) units[units.length - 1].lastInBlock = true;
    out.push(...units);
    block = [];
  };
  for (const l of lines) {
    const f = FENCE.exec(l.text);
    if (f || fence !== null) {
      flush();
      if (f) {
        if (fence === null) fence = f[1][0].repeat(f[1].length);
        else if (f[1].startsWith(fence)) fence = null;
      }
      continue;
    }
    if (!l.text.trim()) {
      flush();
      continue;
    }
    block.push(l);
  }
  flush();
  return out;
}

function unitsOfBlock(lines: Line[], blockNo: number): RawUnit[] {
  const out: RawUnit[] = [];
  const unit = (s: number, e: number, text: string, kind: RawUnit['kind']) => out.push({ start: s, end: e, text, kind, block: blockNo, lastInBlock: false });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (TABLE_ROW.test(l.text)) {
      // A header row (the one above the separator) and the separator are not units.
      const header = i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].text);
      if (!header && !TABLE_SEP.test(l.text)) {
        const t = trimmedSpan(l.text, l.start, 0, l.text.length);
        if (t) unit(t.start, t.end, t.text, 'row');
      }
      i++;
      continue;
    }
    if (LIST_ITEM.test(l.text)) {
      let j = i + 1;
      while (j < lines.length && !LIST_ITEM.test(lines[j].text) && !TABLE_ROW.test(lines[j].text)) j++;
      const s = l.start + byteLen(l.text) - byteLen(l.text.trimStart());
      const last = lines[j - 1];
      unit(s, last.start + byteLen(last.text.trimEnd()), lines.slice(i, j).map((x) => x.text).join('\n').trim(), 'item');
      i = j;
      continue;
    }
    let j = i;
    while (j < lines.length && !LIST_ITEM.test(lines[j].text) && !TABLE_ROW.test(lines[j].text)) j++;
    const para = lines.slice(i, j);
    const text = para.map((x) => x.text).join('\n');
    const cuts = [0];
    for (const m of text.matchAll(SENTENCE_END)) {
      const at = m.index + 1;
      if (ABBREV.test(text.slice(Math.max(0, at - 5), at))) continue;
      cuts.push(at);
    }
    cuts.push(text.length);
    const spans = cuts.slice(0, -1).map((a, k) => trimmedSpan(text, para[0].start, a, cuts[k + 1])).filter((x): x is NonNullable<typeof x> => x !== null);
    const kind = para.length === 1 && spans.length === 1 ? 'line' : 'sentence';
    for (const sp of spans) unit(sp.start, sp.end, sp.text, kind);
    i = j;
  }
  return out;
}

interface Compiled { normative: Array<{ id: string; re: RegExp; weight: number }>; hedges: Array<{ id: string; re: RegExp }>; imperatives: Set<string> }
const compiledCache = new WeakMap<SectionerConfig, Compiled>();
function compiled(config: SectionerConfig): Compiled {
  let c = compiledCache.get(config);
  if (!c) {
    const re = (p: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${p})(?![\\p{L}\\p{N}_])`, 'iu');
    c = {
      normative: config.cues.filter((q) => q.type === 'normative').map((q) => ({ id: q.id, re: re(q.pattern), weight: q.weight })),
      hedges: config.cues.filter((q) => q.type === 'hedge').map((q) => ({ id: q.id, re: re(q.pattern) })),
      imperatives: new Set(config.imperatives.map((w) => w.toLowerCase())),
    };
    compiledCache.set(config, c);
  }
  return c;
}

const BOLD_SENTENCE = /^\*\*([^*\n]+?[.!?])\*\*\s*/;
const UNIVERSAL = /^(?:every|each|all)\s+\p{L}/iu;

/** The score of one unit's text, with the cue ids that set it and its hedges (§3.3). */
export function scoreUnit(text: string, config: SectionerConfig, o: { ruleBase: boolean; leadContinuation: boolean }): { score: number; cues: string[]; hedges: string[] } {
  const c = compiled(config);
  const core = text.replace(LIST_ITEM, '').replace(/^\s*>\s*/, '');
  const bold = BOLD_SENTENCE.exec(core);
  // Unit-initial cues are read at the unit's start and, after a leading bold sentence, at the rest's.
  const heads = bold ? [bold[1], core.slice(bold[0].length)] : [core];
  let score = 0;
  const cues: string[] = [];
  const take = (id: string, w: number) => {
    if (w <= 0) return;
    cues.push(id);
    score = Math.max(score, w);
  };
  for (const q of c.normative) if (q.re.test(text)) take(q.id, q.weight);
  if (heads.some((h) => UNIVERSAL.test(h))) take('universal', /\b(?:can|may)\b/i.test(text) ? 0.45 : 0.5);
  if (heads.some((h) => {
    const w = /^[`*_"'(]*([A-Za-z]+)/.exec(h)?.[1]?.toLowerCase();
    return w !== undefined && c.imperatives.has(w);
  })) take('imperative', 0.5);
  if (o.ruleBase) take('rule-list', 0.5);
  if (o.leadContinuation) take('lead-continuation', 0.5);
  if (score > 0 && bold) {
    cues.push('bold');
    score = Math.min(1, score + 0.2);
  }
  const hedges = c.hedges.filter((q) => q.re.test(text)).map((q) => q.id);
  return { score: round(score), cues, hedges };
}

/** A unit as the detectors read it: scored, with its text. */
export type ScoredUnit = NormativeSentence & { text: string };

/** Every unit of every section of a document, scored; ids `<sectionId>#s<k>` count all of a section's units. */
export function scoredUnitsOf(doc: SectionerDoc, sections: Section[], config: SectionerConfig): ScoredUnit[] {
  const out: ScoredUnit[] = [];
  for (const s of sections) {
    const units = rawUnitsOf(doc.bytes, s.bodyStart, s.bodyEnd);
    const ruleSection = s.level > 0 && hasWord(s.title, config.ruleSections);
    // The last unit of the previous block, when it ends with `:` — a lead for the block after it.
    let lead: { block: number; scored: boolean; hedges: string[] } | null = null;
    units.forEach((u, k) => {
      const fromLead = lead !== null && u.block === lead.block + 1 ? lead : null;
      const firstOfBlock = k === 0 || units[k - 1].block !== u.block;
      const listish = u.kind === 'item' || u.kind === 'row';
      const r = scoreUnit(u.text, config, {
        ruleBase: listish && (ruleSection || (fromLead?.scored ?? false)),
        leadContinuation: u.kind === 'line' && firstOfBlock && u.lastInBlock && (fromLead?.scored ?? false),
      });
      let score = r.score;
      const hedges = [...r.hedges, ...(fromLead?.hedges ?? [])];
      if (s.withdrawn) score = 0;
      else if (s.informative) score = round(score * 0.4);
      if (s.openDecision) hedges.push('open-decision');
      out.push({ id: `${s.id}#s${k + 1}`, sectionId: s.id, docKey: doc.key, start: u.start, end: u.end, score, cues: r.cues, hedges: [...new Set(hedges)], text: u.text });
      if (u.lastInBlock) lead = /:\)?\s*$/.test(u.text) ? { block: u.block, scored: score >= config.threshold, hedges: r.hedges } : null;
    });
  }
  return out;
}

/** The normative units of a document: score ≥ `config.threshold`. */
export function unitsOf(doc: SectionerDoc, sections: Section[], config: SectionerConfig): NormativeSentence[] {
  return scoredUnitsOf(doc, sections, config).filter((u) => u.score >= config.threshold).map(({ text: _t, ...u }) => u);
}

// ---- cross-references ------------------------------------------------------------------

const LINK_WORDS: Array<[RegExp, XrefLink]> = [
  [/\bsupersed(?:es|ed by)\b/gi, 'supersedes'], [/\bimplements\b/gi, 'implements'], [/\bamends\b/gi, 'amends'], [/\bresolution:/gi, 'resolves'],
];

/** The link a reference makes, from the last link word before it on its line, else `cites`. */
function linkOf(prefix: string): XrefLink {
  let best: { at: number; link: XrefLink } | null = null;
  for (const [re, link] of LINK_WORDS) for (const m of prefix.matchAll(re)) if (!best || m.index > best.at) best = { at: m.index, link };
  return best?.link ?? 'cites';
}

const expand = (template: string | undefined, groups: readonly (string | undefined)[]): string =>
  (template ?? groups[0] ?? '').replace(/\$(\d)/g, (_s, n: string) => groups[Number(n)] ?? '');
const VERSION_BEFORE = /\b(v\d+\.\d+)\s*$/;

/**
 * Cross-references in a document's bodies, fences excluded, unresolved: `target` is the label
 * sought. `§a–b` expands to each whole section; a reference right after a version token (`v0.7 §5`)
 * carries that version, which `resolveRefs` checks.
 */
export function crossRefsOf(doc: SectionerDoc, sections: Section[], config: SectionerConfig): CrossRef[] {
  const out: CrossRef[] = [];
  const fences = fencesOf(doc.bytes);
  const inFence = (b: number) => fences.some((f) => b >= f.start && b < f.end);
  for (const s of sections) {
    const body = doc.bytes.subarray(s.bodyStart, s.bodyEnd).toString('utf8');
    const taken: Array<[number, number]> = [];
    for (const x of config.xrefs) {
      for (const m of body.matchAll(new RegExp(x.pattern, 'gu'))) {
        const a = m.index;
        const b = a + m[0].length;
        if (!m[0] || taken.some(([p, q]) => a < q && b > p)) continue;
        const startByte = s.bodyStart + byteLen(body.slice(0, a));
        if (inFence(startByte)) continue;
        taken.push([a, b]);
        const prefix = body.slice(body.lastIndexOf('\n', a - 1) + 1, a);
        const version = x.kind !== 'doc-version' ? VERSION_BEFORE.exec(prefix)?.[1] : undefined;
        const ref = (label: string, end: number): CrossRef => ({
          fromSection: s.id, start: startByte, end: s.bodyStart + byteLen(body.slice(0, end)), raw: body.slice(a, end).slice(0, 64), kind: x.kind,
          link: linkOf(prefix), target: version ? `${version}|${label}` : label, resolved: false, ...(version ? { reason: 'other-version' as const } : {}),
        });
        const range = x.kind === 'section' && /^\d+$/.test(m[1] ?? '') ? /^\s?[–-]\s?§?(\d+)\b/.exec(body.slice(b)) : null;
        if (range && Number(range[1]) > Number(m[1]) && Number(range[1]) - Number(m[1]) <= 50) {
          const end = b + range[0].length;
          taken.push([b, end]);
          for (let n = Number(m[1]); n <= Number(range[1]); n++) out.push(ref(expand(x.label, [m[0], String(n)]), end));
          continue;
        }
        out.push(ref(expand(x.label, [...m]), b));
      }
    }
  }
  return out.sort((p, q) => p.start - q.start || p.end - q.end || (p.target ?? '').localeCompare(q.target ?? ''));
}

/**
 * Each reference resolved to a section id by its label: in the citing document first, then a
 * primary of its domain, then the rest of the domain (scope `doc` stays in the document; `any`
 * searches every domain). Found only in another domain → `other-domain`; a version the domain does
 * not carry as a label → `other-version`; nowhere → `no-such-label`; two equally near → `ambiguous`.
 */
export function resolveRefs(refs: CrossRef[], all: Section[], docs: CorpusDoc[], config: SectionerConfig): CrossRef[] {
  const docOf = new Map(docs.map((d) => [d.key, d]));
  const sectionOf = new Map(all.map((s) => [s.id, s]));
  const byLabel = new Map<string, Section[]>();
  for (const s of all) if (s.label) byLabel.set(s.label, [...(byLabel.get(s.label) ?? []), s]);
  const scopeOf = new Map(config.xrefs.map((x) => [x.kind, x.scope]));
  const unresolved = (r: CrossRef, reason: NonNullable<CrossRef['reason']>): CrossRef => ({ ...r, target: null, resolved: false, reason });
  return refs.map((r0) => {
    const { reason: carried, ...r } = r0;
    const from = sectionOf.get(r.fromSection);
    const fromDoc = from ? docOf.get(from.docKey) : undefined;
    if (!from || !fromDoc || r.target === null) return unresolved(r, 'no-such-label');
    const inDomain = (label: string) => (byLabel.get(label) ?? []).some((s) => docOf.get(s.docKey)?.domain === fromDoc.domain);
    let label = r.target;
    if (carried === 'other-version') {
      const version = label.slice(0, label.indexOf('|'));
      if (!inDomain(version)) return unresolved(r, 'other-version');
      label = label.slice(version.length + 1);
    }
    const scope = scopeOf.get(r.kind) ?? 'domain';
    const candidates = byLabel.get(label) ?? [];
    const inScope = candidates.filter((s) => scope === 'any' || (scope === 'doc' ? s.docKey === from.docKey : docOf.get(s.docKey)?.domain === fromDoc.domain));
    for (const tier of [inScope.filter((s) => s.docKey === from.docKey), inScope.filter((s) => docOf.get(s.docKey)?.role === 'primary'), inScope]) {
      if (tier.length === 1) return { ...r, target: tier[0].id, resolved: true };
      if (tier.length > 1) return unresolved(r, 'ambiguous');
    }
    if (r.kind === 'doc-version') return unresolved(r, 'other-version');
    return unresolved(r, candidates.length ? 'other-domain' : 'no-such-label');
  });
}

// ---- the index -------------------------------------------------------------------------

/** The whole corpus sectioned: documents in key order, normative units, resolved references. */
export function buildSectionIndex(rev: Pick<CorpusRevision, 'docs' | 'corpusDigest'>, bytesOf: (key: string) => Buffer, config: SectionerConfig): SectionIndex {
  const docs = [...rev.docs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const sectioned = docs.map((d) => {
    const bytes = bytesOf(d.key);
    const c = configForDomain(config, d.domain);
    return { d, bytes, c, sections: sectionDocument(d.key, bytes, c, { role: d.role }) };
  });
  const all = sectioned.flatMap((x) => x.sections);
  return {
    v: 2, sectionerVersion: SECTIONER_VERSION, configDigest: digestOf(canonicalJson(config)), corpusDigest: rev.corpusDigest,
    docs: sectioned.map(({ d, sections }) => ({ key: d.key, digest: d.digest, sections })),
    sentences: sectioned.flatMap(({ d, bytes, c, sections }) => unitsOf({ key: d.key, bytes, role: d.role }, sections, c)),
    refs: resolveRefs(sectioned.flatMap(({ d, bytes, c, sections }) => crossRefsOf({ key: d.key, bytes, role: d.role }, sections, c)), all, docs, config),
  };
}

export function sectionSetDigestOf(index: SectionIndex): string {
  return digestOf(canonicalJson(index));
}

// ---- windows ---------------------------------------------------------------------------

/** Split points for an over-size body: blank lines, else unit starts (a paragraph over the cap), else the cap. */
export function splitBody(bytes: Buffer, start: number, end: number, max: number): Array<{ start: number; end: number; splitParagraph: boolean }> {
  const text = bytes.subarray(start, end);
  const blanks: number[] = [];
  for (let i = text.indexOf('\n\n'); i >= 0; i = text.indexOf('\n\n', i + 1)) blanks.push(start + i + 2);
  const units = rawUnitsOf(bytes, start, end).map((u) => u.start);
  const out: Array<{ start: number; end: number; splitParagraph: boolean }> = [];
  let s = start;
  while (end - s > max) {
    const limit = s + max;
    let cut = [...blanks].reverse().find((c) => c > s && c <= limit);
    let splitParagraph = false;
    if (cut === undefined) {
      cut = [...units].reverse().find((u) => u > s && u <= limit) ?? limit;
      splitParagraph = true;
    }
    out.push({ start: s, end: cut, splitParagraph });
    s = cut;
  }
  out.push({ start: s, end, splitParagraph: false });
  return out;
}

/**
 * Greedy packing in document order, one document per window: bodies join a window while it stays
 * within the target; a body over `MAX_WINDOW_BYTES` gets windows of its own, split at blank lines
 * (or units). Every body lands in exactly one window (checked). `linked` holds resolved reference
 * targets outside the window, other documents first, ≤ 12 KiB of body.
 */
export function windowsOf(index: SectionIndex, bytesOf: (k: string) => Buffer, o: { target?: number } = {}): ExtractWindow[] {
  const target = Math.min(o.target ?? WINDOW_TARGET_BYTES, MAX_WINDOW_BYTES);
  const all = index.docs.flatMap((d) => d.sections);
  const byId = new Map(all.map((s) => [s.id, s]));
  const refsFrom = new Map<string, string[]>();
  for (const r of index.refs) if (r.resolved && r.target) refsFrom.set(r.fromSection, [...(refsFrom.get(r.fromSection) ?? []), r.target]);
  const out: ExtractWindow[] = [];
  let seq = 0;
  const emit = (docKey: string, sectionIds: string[], parts: ExtractWindow['parts'], bytes: number) => {
    const own = new Set(sectionIds);
    const targets = [...new Set(sectionIds.flatMap((id) => refsFrom.get(id) ?? []))].filter((id) => !own.has(id) && byId.has(id));
    targets.sort((a, b) => Number(byId.get(a)!.docKey === docKey) - Number(byId.get(b)!.docKey === docKey));
    const linked: string[] = [];
    let linkedBytes = 0;
    for (const id of targets) {
      const s = byId.get(id)!;
      const n = s.bodyEnd - s.bodyStart;
      if (linkedBytes + n > MAX_LINKED_BYTES) continue;
      linked.push(id);
      linkedBytes += n;
    }
    const ancestors: ExtractWindow['ancestors'] = [];
    for (const id of sectionIds) {
      for (let p = byId.get(id)?.parentId ?? null; p; p = byId.get(p)?.parentId ?? null) {
        if (own.has(p) || ancestors.some((x) => x.id === p)) continue;
        ancestors.push({ id: p, title: byId.get(p)!.title });
      }
    }
    const body = { docKey, sectionIds, ...(parts ? { parts } : {}) };
    out.push({ id: `win${++seq}:${sha256hex(canonicalJson(body)).slice(0, 12)}`, ...body, bytes, linked, ancestors });
  };
  for (const d of index.docs) {
    const bytes = bytesOf(d.key);
    let cur: string[] = [];
    let curBytes = 0;
    const flush = () => {
      if (cur.length) emit(d.key, cur, undefined, curBytes);
      cur = [];
      curBytes = 0;
    };
    for (const s of d.sections) {
      const n = s.bodyEnd - s.bodyStart;
      if (n > MAX_WINDOW_BYTES) {
        flush();
        for (const p of splitBody(bytes, s.bodyStart, s.bodyEnd, MAX_WINDOW_BYTES)) emit(d.key, [s.id], [{ sectionId: s.id, start: p.start, end: p.end }], p.end - p.start);
        continue;
      }
      if (cur.length && curBytes + n > target) flush();
      cur.push(s.id);
      curBytes += n;
    }
    flush();
  }
  for (const s of all) {
    const holding = out.filter((w) => w.sectionIds.includes(s.id));
    const whole = holding.filter((w) => !w.parts);
    const parts = holding.flatMap((w) => w.parts ?? []).filter((p) => p.sectionId === s.id).sort((a, b) => a.start - b.start);
    const tiled = parts.length > 0 && parts[0].start === s.bodyStart && parts.at(-1)!.end === s.bodyEnd && parts.every((p, i) => i === 0 || parts[i - 1].end === p.start);
    if (!((whole.length === 1 && parts.length === 0) || (whole.length === 0 && tiled))) throw new Error(`section ${s.id} is not in exactly one window`);
  }
  return out;
}

/** The digest suffix a window id carries: what it holds, so a rewritten window is not taken for the original. */
export const windowDigestOf = (w: Pick<ExtractWindow, 'docKey' | 'sectionIds' | 'parts'>): string =>
  sha256hex(canonicalJson({ docKey: w.docKey, sectionIds: w.sectionIds, ...(w.parts ? { parts: w.parts } : {}) })).slice(0, 12);

/** The window a task is bound to by its `inputs[0]` (an `extract-window` report artifact), re-read and digest-checked. */
export function windowOfTask(ctx: DaylightContext, task: Task): ExtractWindow {
  const ref = task.inputs[0];
  if (!ref || ref.kind !== 'report' || ref.label !== 'extract-window') throw new Error(`task ${task.id} names no extract window as its first input`);
  const recorded = ctx.store.artifact(ref.id);
  if (!recorded || recorded.digest !== ref.digest || recorded.projectId !== task.projectId) throw new Error(`task ${task.id}'s window artifact is not recorded`);
  const w = JSON.parse(ctx.artifacts.get(recorded).toString('utf8')) as ExtractWindow;
  if (typeof w.id !== 'string' || !w.id.endsWith(`:${windowDigestOf(w)}`)) throw new Error(`task ${task.id}'s window does not match its id`);
  return w;
}
