import type { OutboxRunner } from '../../mission/orchestrate.ts';
import type { IrProposal, ReportedIrFinding } from '../../mission/types.ts';

/** Scripted extractors and reviewers for the ingestion benchmark (spec ingestion §11.2). WS-R16 owns and may widen these types. */

export interface IrFixture { records: Array<IrProposal & { docKey: string }> }

export function scriptedExtractor(_fixture: IrFixture, _o: { variant: 'exact' | 'drop5' | 'paraphrase' }): OutboxRunner {
  throw new Error('not implemented');
}

export function scriptedReviewer(_findings: ReportedIrFinding[]): OutboxRunner {
  throw new Error('not implemented');
}
