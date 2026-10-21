import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DaylightContext } from '../../mission/context.ts';
import type { OutboxRun, OutboxRunner } from '../../mission/orchestrate.ts';
import type { ExtractWindow, IrKind, IrProposal, ReportedIrFinding, Section, SectionIndex } from '../../mission/types.ts';
import { OUTBOX_TOOLS } from '../../forge/outbox.ts';
import { corpusOf } from '../../forge/corpus.ts';
import { windowOfTask } from '../../forge/sectioner.ts';
import type { OverlayRecord } from '../../forge/bench-overlay.ts';

/**
 * Scripted extractors and reviewers for the ingestion benchmark (spec ingestion §11.2). WS-R16.
 *
 * They stand in for the agent, not for the boundary: each task gets a real attempt row and the
 * role's real MCP server (`outbox.serve(attempt)`), connected in-process, and every proposal is a
 * real `tools/call` — so the server's validator, redaction and count cap, the outbox file and the
 * host's re-validation all run exactly as for a live agent. Only the choice of what to propose is
 * scripted: the fixture records whose quote lies inside the task's window.
 *
 * Variants, by the task's runner hint (`mock`, `mock:b`, `mock:p`) or one for all:
 *   exact       every fixture record in the window, verbatim
 *   drop5       ~5% of records dropped and 3 kinds changed (deterministic by key): a second, imperfect extractor
 *   paraphrase  every statement deterministically reworded: live-shaped, so records almost never merge
 *               and `statement-differs` is the normal disagreement
 */

export interface IrFixture { records: OverlayRecord[] }
export type ExtractVariant = 'exact' | 'drop5' | 'paraphrase';

const DEFAULT_VARIANTS: Record<string, ExtractVariant> = { mock: 'exact', 'mock:b': 'drop5', 'mock:p': 'paraphrase' };
const h = (s: string) => createHash('sha256').update(s).digest();

/** Close an in-process MCP pair over one attempt's server, call `tool` once per payload, return how many the server accepted. */
async function callAll(run: OutboxRun, attempt: Parameters<OutboxRun['serve']>[0], tool: string, payloads: readonly unknown[]): Promise<number> {
  const server = run.serve(attempt);
  const client = new Client({ name: 'daylight-scripted', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  let accepted = 0;
  try {
    for (const p of payloads) {
      const r = await client.callTool({ name: tool, arguments: p as Record<string, unknown> });
      if (!r.isError) accepted++;
    }
  } finally {
    await client.close();
    await server.close();
  }
  return accepted;
}

/** Sections of a window with their absolute body ranges (a split body's part ranges when it has them). */
function windowRanges(index: SectionIndex, w: ExtractWindow): Array<{ section: Section; start: number; end: number }> {
  const sections = new Map(index.docs.flatMap((d) => d.sections).map((s) => [s.id, s]));
  const out: Array<{ section: Section; start: number; end: number }> = [];
  for (const id of [...w.sectionIds, ...w.linked]) {
    const s = sections.get(id);
    if (!s) continue;
    const parts = w.parts?.filter((p) => p.sectionId === id) ?? [];
    if (parts.length) for (const p of parts) out.push({ section: s, start: p.start, end: p.end });
    else out.push({ section: s, start: s.bodyStart, end: s.bodyEnd });
  }
  return out;
}

const occurrenceIn = (body: Buffer, quote: Buffer, at: number): number | undefined => {
  let n = 0;
  let i = body.indexOf(quote);
  let mine = 0;
  while (i >= 0) {
    n++;
    if (i === at) mine = n;
    i = body.indexOf(quote, i + 1);
  }
  return n > 1 && mine ? mine : undefined;
};

/** The proposal a fixture record makes in a window, or null when its quote is not inside the window's own sections. */
export function proposalIn(r: OverlayRecord, ranges: ReturnType<typeof windowRanges>, docOf: (key: string) => Buffer, primaryDoc: string): IrProposal | null {
  const locate = (docKey: string, at: number, quote: string, own: boolean) => {
    const q = Buffer.from(quote, 'utf8');
    const hit = ranges.find((x) => x.section.docKey === docKey && x.start <= at && at + q.length <= x.end && (!own || docKey === primaryDoc));
    if (!hit) return null;
    const body = docOf(docKey).subarray(hit.section.bodyStart, hit.section.bodyEnd);
    return { section: hit.section.id, occurrence: occurrenceIn(body, q, at - hit.section.bodyStart) };
  };
  const own = locate(r.docKey, r.at, r.quote, true);
  if (!own) return null;
  const p: IrProposal = { kind: r.kind, source: r.source, statement: r.statement, confidence: r.confidence, attrs: r.attrs, section: own.section, quote: r.quote };
  if (own.occurrence) p.occurrence = own.occurrence;
  if (r.other) {
    const o = locate(r.other.docKey, r.other.at, r.other.quote, false);
    if (o) p.other = { section: o.section, quote: r.other.quote, ...(o.occurrence ? { occurrence: o.occurrence } : {}) };
  }
  return p;
}

const KIND_SWAP: Partial<Record<IrKind, IrKind>> = { requirement: 'constraint', constraint: 'requirement', invariant: 'requirement', decision: 'requirement' };

function vary(p: IrProposal, key: string, variant: ExtractVariant, swapped: Set<string>): IrProposal | null {
  if (variant === 'exact') return p;
  if (variant === 'drop5') {
    if (h(`drop:${key}`)[0] < 13) return null;
    const swap = KIND_SWAP[p.kind];
    if (swap && swapped.size < 3 && h(`kind:${key}`)[0] < 32) {
      swapped.add(key);
      return { ...p, kind: swap };
    }
    return p;
  }
  return { ...p, statement: `Restated: ${p.statement.charAt(0).toLowerCase()}${p.statement.slice(1)}` };
}

/**
 * An `OutboxRunner` for role `extract`: per task, the fixture records whose quote lies in the task's
 * window, proposed through the real server. Records quoting a seeded or edited passage simply do
 * not resolve there any more, as with a real extractor.
 */
export function scriptedExtractor(fixture: IrFixture, o: { variant: ExtractVariant | Record<string, ExtractVariant> }): OutboxRunner {
  return async (ctx: DaylightContext, run) => {
    const corpus = corpusOf(ctx, run.missionId);
    const swapped = new Set<string>();
    for (const taskId of run.outbox.taskIds) {
      const task = ctx.store.task(taskId);
      if (!task || task.role !== 'extract') continue;
      const hint = task.runnerHint ?? 'mock';
      const variant = typeof o.variant === 'string' ? o.variant : o.variant[hint] ?? DEFAULT_VARIANTS[hint] ?? 'exact';
      const w = windowOfTask(ctx, task);
      const ranges = windowRanges(corpus.index, w);
      const proposals = fixture.records.flatMap((r) => {
        const p = proposalIn(r, ranges, (k) => corpus.bytesOf(k), w.docKey);
        const v = p ? vary(p, r.key, variant, swapped) : null;
        return v ? [v] : [];
      });
      const attempt = ctx.store.startAttempt({ taskId, runnerId: `agent:${hint}:scripted` });
      await callAll(run.outbox, attempt, OUTBOX_TOOLS.extract, proposals);
      ctx.store.finishAttempt(attempt.id, { state: 'completed', costUsd: null });
    }
  };
}

/**
 * An `OutboxRunner` for role `ir-review`: each finding is reported once, by the first task whose
 * window holds its section, through the real server.
 */
export function scriptedReviewer(findings: ReportedIrFinding[]): OutboxRunner {
  return async (ctx: DaylightContext, run) => {
    const left = [...findings];
    for (const taskId of run.outbox.taskIds) {
      const task = ctx.store.task(taskId);
      if (!task || task.role !== 'ir-review') continue;
      const w = windowOfTask(ctx, task);
      const mine = left.filter((f) => w.sectionIds.includes(f.section));
      for (const f of mine) left.splice(left.indexOf(f), 1);
      const attempt = ctx.store.startAttempt({ taskId, runnerId: `agent:${task.runnerHint ?? 'mock'}:scripted-review` });
      await callAll(run.outbox, attempt, OUTBOX_TOOLS['ir-review'], mine);
      ctx.store.finishAttempt(attempt.id, { state: 'completed', costUsd: null });
    }
  };
}
