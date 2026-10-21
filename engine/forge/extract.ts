import type { DaylightContext } from '../mission/context.ts';
import type { OutboxRunner } from '../mission/orchestrate.ts';
import type { ExtractWindow, IrDisagreement, IrRecord, SectionerConfig } from '../mission/types.ts';
import type { OutboxRefusal } from './outbox.ts';

/** Blind extraction: windows × ≥ 2 extractors → proposed IR records, re-validated on the host (spec ingestion §4.2–4.3). WS-R14. */

export const EXTRACT_PROMPT_DIGEST: string = 'sha256:' + '0'.repeat(64);

export function buildExtractPrompt(_window: ExtractWindow, _texts: { primary: string; linked: string }, _ctx: { config: SectionerConfig; precedence: string[] }): string {
  throw new Error('not implemented');
}

export function extract(_ctx: DaylightContext, _corpusId: string, _repo: string, _tools: string[], _o: { runner: OutboxRunner; windows?: string[] }):
  Promise<{ proposed: IrRecord[]; refused: OutboxRefusal[]; irVersion: string }> {
  throw new Error('not implemented');
}

export function ingestIrProposals(_ctx: DaylightContext, _corpusId: string): { created: IrRecord[]; observed: number; refused: OutboxRefusal[] } {
  throw new Error('not implemented');
}

export function irVersionOf(_i: { corpusDigest: string; sectionSetDigest: string; configDigest: string; roster: string[]; promptDigest: string }): string {
  throw new Error('not implemented');
}

export function disagreementsOf(_ctx: DaylightContext, _corpusId: string, _revisionId?: string): IrDisagreement[] {
  throw new Error('not implemented');
}
