import type { DaylightContext } from '../mission/context.ts';
import type { SpanRef, TraceMatrix, TraceReport } from '../mission/types.ts';
import { TRACE_JOINS } from '../mission/types.ts';

/** Traceability, forward and backward (spec ingestion §10). WS-R16. */

export { TRACE_JOINS };

export function traceForward(_ctx: DaylightContext, _from: { corpusId: string; docKey: string; sectionId?: string; label?: string; range?: [number, number];
  revisionId?: string } | { irId: string }): TraceReport {
  throw new Error('not implemented');
}

export function traceBackward(_ctx: DaylightContext, _from: { commit: string; campaignId?: string } | { integrationId: string } | { candidateId: string }
  | { campaignId: string; ticketId: string }): TraceReport {
  throw new Error('not implemented');
}

export function traceMatrix(_ctx: DaylightContext, _campaignId: string): TraceMatrix {
  throw new Error('not implemented');
}

export function renderTraceMarkdown(_r: TraceReport | TraceMatrix, _excerpt: (s: SpanRef) => string | null): string {
  throw new Error('not implemented');
}
