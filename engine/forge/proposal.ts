import path from 'node:path';

/**
 * A work-item proposal as it crosses the MCP boundary, and the rules it must meet.
 *
 * Pure: no file, no git, no database. The MCP server runs these on the way in and the host
 * runs them again on the way out of the outbox (the outbox is same-uid writable, Sec H5), so
 * the two sides cannot disagree about what a valid proposal is.
 *
 * A refusal names the field and a fixed reason. It never echoes the text it refused: the text
 * came from an agent reading an untrusted spec, and an error message is one more place for it
 * to land.
 */

export const MAX_ANCHOR_CHARS = 200;
export const MAX_TITLE_CHARS = 120;
export const MAX_STATEMENT_BYTES = 4 * 1024;
export const MAX_EXAMPLES = 10;
export const MAX_EXAMPLE_BYTES = 1024;
export const MAX_TOUCHES = 20;
export const MAX_TOUCH_CHARS = 400;
/** One outbox line, and one tool call's arguments, serialised. */
export const MAX_PROPOSAL_BYTES = 16 * 1024;
/** Proposals one decompose attempt may file. */
export const MAX_PROPOSALS_PER_ATTEMPT = 50;

export interface Proposal {
  anchor: string;
  title: string;
  statement: string;
  examples: string[];
  negativeExamples: string[];
  /** Repo-relative POSIX paths the item expects to change. Advisory; never a grant. */
  touches: string[];
}

export type ProposalField =
  | 'payload' | 'anchor' | 'title' | 'statement' | 'examples' | 'negativeExamples' | 'touches' | 'count';

export interface ProposalRefusal {
  refused: string;
  field: ProposalField;
}

/** What the host checks a proposal against; the server may not have it to hand. */
export interface ProposalContext {
  /** The registered spec's bytes, for resolving the anchor. */
  spec?: Buffer | string;
  /** `git ls-tree -r` at the spec commit, for checking `touches`. */
  tree?: ReadonlySet<string>;
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

// C0 except tab, newline and carriage return, DEL, C1; and the bidi controls that reorder what
// a reader sees (the "trojan source" set). A title is one line; a statement may wrap but may
// not hide text.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * Why `p` is not a path inside the repository, or null. Refused: empty, absolute, a drive
 * letter, `~`, a backslash, NUL, any `.`, `..` or empty segment. Nothing is resolved against
 * the filesystem: a path is admitted by its spelling, and then only if git has it.
 */
export function repoPathRefusal(p: string): string | null {
  if (typeof p !== 'string' || !p) return 'empty path';
  if (p.length > MAX_TOUCH_CHARS) return 'path too long';
  if (p.includes('\0')) return 'NUL in path';
  if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return 'absolute path; paths are repo-relative';
  if (p.includes('\\')) return 'backslash in path';
  if (p.startsWith('~')) return 'home-relative path';
  if (CONTROL.test(p) || BIDI.test(p) || LINE_BREAK.test(p)) return 'control character in path';
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'path leaves or re-enters the repository';
  return null;
}

// ---- anchors -------------------------------------------------------------------

const ANCHOR_SLUG = /^#[\p{Ll}\p{Lo}\p{Nd}_-]+(?:\/[\p{Ll}\p{Lo}\p{Nd}_-]+)*$/u;
const ANCHOR_LINES = /^L([1-9]\d{0,6})-([1-9]\d{0,6})$/;

/** A heading's slug as GitHub spells it: lower case, punctuation dropped, spaces to `-`. */
export function slugOf(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

export interface SpecHeading {
  level: number;
  slug: string;
  line: number;
}

/** ATX headings outside fenced code, with duplicate slugs suffixed `-1`, `-2` as GitHub does. */
export function headingsOf(spec: string): SpecHeading[] {
  const out: SpecHeading[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  spec.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0].repeat(f[1].length);
      else if (f[1].startsWith(fence)) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!h) return;
    const base = slugOf(h[2]);
    if (!base) return;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ level: h[1].length, slug: n ? `${base}-${n}` : base, line: i + 1 });
  });
  return out;
}

/** Every `#a/b` anchor the spec offers, outermost first; what a decomposer is told it may cite. */
export function anchorsOf(spec: string): string[] {
  const out: string[] = [];
  const stack: SpecHeading[] = [];
  for (const h of headingsOf(spec)) {
    while (stack.length && stack.at(-1)!.level >= h.level) stack.pop();
    stack.push(h);
    out.push(`#${stack.map((s) => s.slug).join('/')}`);
  }
  return out;
}

/**
 * Why the anchor is malformed, or, given the spec, does not resolve in it. `#a/b` is section
 * `b` nested inside section `a` (any depth below it); a bare `#b` is any heading `b`.
 * `L<a>-<b>` is a line range inside the spec.
 */
export function anchorRefusal(anchor: string, spec?: string): string | null {
  if (typeof anchor !== 'string' || !anchor) return 'empty anchor';
  if (anchor.length > MAX_ANCHOR_CHARS) return 'anchor too long';
  const lines = ANCHOR_LINES.exec(anchor);
  if (!lines && !ANCHOR_SLUG.test(anchor)) return 'anchor must be #heading-slug[/sub-slug] or L<a>-<b>';
  if (lines && Number(lines[1]) > Number(lines[2])) return 'line range runs backwards';
  if (spec === undefined) return null;
  if (lines) {
    const count = spec.split('\n').length - (spec.endsWith('\n') ? 1 : 0);
    return Number(lines[2]) <= count ? null : 'line range is past the end of the spec';
  }
  const want = anchor.slice(1).split('/');
  const resolves = anchorsOf(spec).some((a) => {
    const have = a.slice(1).split('/');
    // Each wanted slug in order, the last one being the heading itself.
    if (have.at(-1) !== want.at(-1)) return false;
    let i = 0;
    for (const s of have) if (s === want[i]) i++;
    return i === want.length;
  });
  return resolves ? null : 'anchor does not resolve to a heading in the spec';
}

// ---- the proposal --------------------------------------------------------------

const refuse = (field: ProposalField, refused: string): ProposalRefusal => ({ refused, field });

function textRefusal(s: unknown, maxBytes: number, multiline: boolean): string | null {
  if (typeof s !== 'string') return 'not a string';
  if (!s.trim()) return 'empty';
  if (bytes(s) > maxBytes) return `over ${maxBytes} bytes`;
  if (CONTROL.test(s)) return 'control character';
  if (BIDI.test(s)) return 'bidirectional control character';
  if (!multiline && LINE_BREAK.test(s)) return 'must be one line';
  return null;
}

function listRefusal(v: unknown, max: number, maxBytes: number): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return 'not a list';
  if (v.length > max) return `more than ${max} entries`;
  for (const x of v) {
    const why = textRefusal(x, maxBytes, true);
    if (why) return why;
  }
  return null;
}

/**
 * The proposal, normalised, or the first rule it breaks. Unknown keys are refused rather than
 * dropped: provenance (attempt, mission, revision) is the host's to supply, and a proposal that
 * tries to supply it is a proposal that should not be quietly half-accepted.
 */
export function validateProposal(raw: unknown, ctx: ProposalContext = {}): Proposal | ProposalRefusal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('payload', 'not an object');
  let size: number;
  try {
    size = bytes(JSON.stringify(raw));
  } catch {
    return refuse('payload', 'not serialisable');
  }
  if (size > MAX_PROPOSAL_BYTES) return refuse('payload', `over ${MAX_PROPOSAL_BYTES} bytes`);
  const r = raw as Record<string, unknown>;
  const known = new Set(['anchor', 'title', 'statement', 'examples', 'negativeExamples', 'touches']);
  if (Object.keys(r).some((k) => !known.has(k))) return refuse('payload', 'unknown field');

  const spec = ctx.spec === undefined ? undefined : typeof ctx.spec === 'string' ? ctx.spec : ctx.spec.toString('utf8');
  const anchorWhy = typeof r.anchor === 'string' ? anchorRefusal(r.anchor, spec) : 'not a string';
  if (anchorWhy) return refuse('anchor', anchorWhy);
  const titleWhy = textRefusal(r.title, MAX_TITLE_CHARS * 4, false)
    ?? ((r.title as string).length > MAX_TITLE_CHARS ? `over ${MAX_TITLE_CHARS} characters` : null);
  if (titleWhy) return refuse('title', titleWhy);
  const statementWhy = textRefusal(r.statement, MAX_STATEMENT_BYTES, true);
  if (statementWhy) return refuse('statement', statementWhy);
  const examplesWhy = listRefusal(r.examples, MAX_EXAMPLES, MAX_EXAMPLE_BYTES);
  if (examplesWhy) return refuse('examples', examplesWhy);
  const negativeWhy = listRefusal(r.negativeExamples, MAX_EXAMPLES, MAX_EXAMPLE_BYTES);
  if (negativeWhy) return refuse('negativeExamples', negativeWhy);

  const touches = r.touches ?? [];
  if (!Array.isArray(touches)) return refuse('touches', 'not a list');
  if (touches.length > MAX_TOUCHES) return refuse('touches', `more than ${MAX_TOUCHES} entries`);
  for (const t of touches) {
    const why = repoPathRefusal(t as string);
    if (why) return refuse('touches', why);
    if (ctx.tree && !ctx.tree.has(t as string)) return refuse('touches', 'not a file at the spec commit');
  }

  return {
    anchor: r.anchor as string,
    title: (r.title as string).trim(),
    statement: r.statement as string,
    examples: (r.examples as string[] | undefined) ?? [],
    negativeExamples: (r.negativeExamples as string[] | undefined) ?? [],
    touches: [...new Set(touches as string[])],
  };
}

export const isRefusal = (v: Proposal | ProposalRefusal): v is ProposalRefusal => 'refused' in v;

// ---- the outbox ------------------------------------------------------------------

/**
 * Where the MCP server files a decompose attempt's proposals: `<out>/proposals/<attemptId>.jsonl`,
 * one `OutboxLine` per accepted call. Keyed by the attempt the host resolved for the server
 * (R-9), never by a session string the agent could choose.
 */
export const PROPOSALS_DIR = 'proposals';
export const outboxFile = (out: string, attemptId: string): string =>
  path.join(out, PROPOSALS_DIR, `${attemptId}.jsonl`);

export interface OutboxLine {
  v: 1;
  at: number;
  proposal: Proposal;
}
