import { z } from 'zod';
import type { OutboxToolSpec } from '../mcp/outbox-server.ts';
import type { IrProposal, IrProposalContext, IrProposalField, IrRecord } from '../mission/types.ts';
import { IR_KINDS, IR_TRANSITIONS } from '../mission/types.ts';

/** Spec IR records and the `propose_ir_record` boundary (spec ingestion §4). Pure. WS-R14. */

export { IR_TRANSITIONS };
export const MAX_IR_PROPOSAL_BYTES = 12 * 1024;
export const MAX_IR_PROPOSALS_PER_ATTEMPT = 200;
export const IR_PROPOSALS_DIR = 'ir-proposals';
export const MAX_IR_STATEMENT_BYTES = 4 * 1024;
export const MAX_IR_QUOTE_BYTES = 2 * 1024;

export function validateIrProposal(_raw: unknown, _ctx?: IrProposalContext): IrProposal | { field: IrProposalField; refused: string } {
  throw new Error('not implemented');
}

export function redactIrProposal(_p: IrProposal): IrProposal {
  throw new Error('not implemented');
}

export function resolveQuote(_body: { start: number; text: string }, _quote: string, _occurrence?: number): { start: number; end: number } | null {
  throw new Error('not implemented');
}

export function irIdOf(_corpusId: string, _p: Pick<IrProposal, 'kind' | 'source' | 'section' | 'quote' | 'occurrence' | 'statement'>): string {
  throw new Error('not implemented');
}

export function irContentDigestOf(_r: Pick<IrRecord, 'kind' | 'source' | 'statement' | 'attrs' | 'basisSections'>
  & { docKey: string | null; quote: string; otherQuote: string | null }): string {
  throw new Error('not implemented');
}

export const isIrRefusal = (v: IrProposal | { field: string; refused: string }): v is { field: IrProposalField; refused: string } => 'refused' in v;

export const IR_OUTBOX_SPEC: OutboxToolSpec<IrProposal> = {
  tool: 'propose_ir_record',
  description: 'Propose ONE Spec IR record read from the window you were given. It is recorded for a person to approve or reject.',
  inputSchema: {
    kind: z.enum(IR_KINDS), source: z.enum(['extracted', 'inferred']), statement: z.string().max(MAX_IR_STATEMENT_BYTES),
    confidence: z.number(), attrs: z.record(z.string(), z.unknown()).optional(), section: z.string().max(400),
    quote: z.string().max(MAX_IR_QUOTE_BYTES), occurrence: z.number().int().optional(),
    other: z.object({ section: z.string().max(400), quote: z.string().max(MAX_IR_QUOTE_BYTES), occurrence: z.number().int().optional() }).optional(),
    basisSections: z.array(z.string().max(400)).max(8).optional(),
  },
  dirName: IR_PROPOSALS_DIR, maxPerAttempt: MAX_IR_PROPOSALS_PER_ATTEMPT, maxLineBytes: MAX_IR_PROPOSAL_BYTES + 512,
  validate: (raw) => validateIrProposal(raw),
  redact: (p) => redactIrProposal(p),
  eventDetail: (p) => ({ kind: p.kind, source: p.source, section: p.section }),
};
