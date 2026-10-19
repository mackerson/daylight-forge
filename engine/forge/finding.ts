import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../mission/artifacts.ts';
import { redact } from '../mission/redact.ts';
import { FINDING_SEVERITIES, type FindingSeverity } from '../mission/types.ts';
import { repoPathRefusal } from './proposal.ts';

/**
 * A wave reviewer's finding as it crosses the MCP boundary (§6.2), and the rules it must meet.
 * Mirrors `proposal.ts`: pure, run by the wave-review server on the way in and by the host again
 * on the way out of the outbox (same-uid writable, Sec H5). A refusal names the field and a fixed
 * reason, never the text: the text is a reviewer's, about code an author wrote.
 *
 * A finding is a claim. It never touches a verdict or a landed commit (ADR-19); at most it
 * becomes new work that passes the same gates.
 */

export const MAX_FINDING_TITLE_CHARS = 120;
export const MAX_FINDING_STATEMENT_BYTES = 4 * 1024;
export const MAX_FINDING_BYTES = 8 * 1024;
export const MAX_FINDINGS_PER_ATTEMPT = 20;
export const FINDINGS_DIR = 'findings';

export interface ReportedFinding {
  path: string;
  severity: FindingSeverity;
  title: string;
  statement: string;
}

export type FindingField = 'payload' | 'path' | 'severity' | 'title' | 'statement' | 'count';
export interface FindingRefusal { field: FindingField; refused: string }
export const isFindingRefusal = (v: ReportedFinding | FindingRefusal): v is FindingRefusal => 'refused' in v;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** `paths`: the files the wave changed. A finding is about one of them or about nothing. */
export function validateFinding(raw: unknown, ctx: { paths: ReadonlySet<string> }): ReportedFinding | FindingRefusal {
  const no = (field: FindingField, refused: string): FindingRefusal => ({ field, refused });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('payload', 'not an object');
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => !['path', 'severity', 'title', 'statement'].includes(k));
  if (extra !== undefined) return no('payload', 'unknown field');
  if (typeof r.path !== 'string') return no('path', 'not a string');
  const bad = repoPathRefusal(r.path);
  if (bad) return no('path', bad);
  if (!ctx.paths.has(r.path)) return no('path', 'not a file this wave changed');
  if (typeof r.severity !== 'string' || !(FINDING_SEVERITIES as readonly string[]).includes(r.severity)) return no('severity', `not one of ${FINDING_SEVERITIES.join(', ')}`);
  if (typeof r.title !== 'string' || !r.title.trim()) return no('title', 'empty');
  if ([...r.title].length > MAX_FINDING_TITLE_CHARS) return no('title', `over ${MAX_FINDING_TITLE_CHARS} characters`);
  if (CONTROL.test(r.title) || LINE_BREAK.test(r.title) || BIDI.test(r.title)) return no('title', 'not one plain line');
  if (typeof r.statement !== 'string' || !r.statement.trim()) return no('statement', 'empty');
  if (Buffer.byteLength(r.statement, 'utf8') > MAX_FINDING_STATEMENT_BYTES) return no('statement', `over ${MAX_FINDING_STATEMENT_BYTES} bytes`);
  if (CONTROL.test(r.statement) || BIDI.test(r.statement)) return no('statement', 'control character');
  return { path: r.path, severity: r.severity as FindingSeverity, title: r.title.trim(), statement: r.statement.trim() };
}

/** Masked before it is stored anywhere: the outbox line sits on disk until someone deletes it. */
export function redactFinding(f: ReportedFinding): ReportedFinding {
  return { ...f, title: redact(f.title).text, statement: redact(f.statement).text };
}

export interface FindingOutboxLine { v: 1; at: number; finding: ReportedFinding }

export const findingOutboxFile = (out: string, attemptId: string): string => path.join(out, FINDINGS_DIR, `${attemptId}.jsonl`);

/** A deterministic `f_` id: the same finding from the same attempt is one row. */
export function findingIdOf(attemptId: string, f: Pick<ReportedFinding, 'path' | 'title' | 'severity' | 'statement'>): string {
  return `f_${createHash('sha256').update(canonicalJson([attemptId, f.path, f.title, f.severity, f.statement])).digest('hex').slice(0, 32)}`;
}
