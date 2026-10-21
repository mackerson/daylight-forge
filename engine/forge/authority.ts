import type { DaylightContext } from '../mission/context.ts';
import type { AuthorityChain, CorpusDiff, CorpusRevision, Mission, Need } from '../mission/types.ts';

/** The authority chain and derived invalidation (spec ingestion §9; P2-R53). WS-R15. */

export function authorityChainOf(_ctx: DaylightContext, _campaignId: string): AuthorityChain {
  throw new Error('not implemented');
}

export function diffCorpus(_ctx: DaylightContext, _corpusId: string, _fromRevision: string, _toRevision: string): CorpusDiff {
  throw new Error('not implemented');
}

export function reviseCorpus(_ctx: DaylightContext, _repo: string, _corpusId: string, _o: { rev?: string; projects?: Record<string, string>; manifest?: string }):
  { revision: CorpusRevision; diff: CorpusDiff } {
  throw new Error('not implemented');
}

export function isIrStale(_ctx: DaylightContext, _irId: string, _revisionId?: string): boolean {
  throw new Error('not implemented');
}

export function staleBlueprints(_ctx: DaylightContext, _corpusId: string): Set<string> {
  throw new Error('not implemented');
}

export function stalePackets(_ctx: DaylightContext, _blueprintId: string): Set<string> {
  throw new Error('not implemented');
}

export function staleTickets(_ctx: DaylightContext, _campaignId: string): Map<string, string[]> {
  throw new Error('not implemented');
}

export function ingestNeeds(_ctx: DaylightContext, _m: Mission): Need[] {
  throw new Error('not implemented');
}
