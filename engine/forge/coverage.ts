import type { DaylightContext } from '../mission/context.ts';
import type {
  CoverageReport, IrRecord, NormativeSentence, SectionerConfig, SectionIndex, SeededDefect, SpanRef,
} from '../mission/types.ts';

/** Coverage and omission report, deterministic detectors, seeded-defect mode (spec ingestion §5). WS-R14. */

/** A normative unit with its text, as the detectors read it. */
export type DetectorUnit = NormativeSentence & { text: string };

export function coverageOf(_ctx: DaylightContext, _corpusId: string, _o?: { revisionId?: string; seeds?: SeededDefect[] }): CoverageReport {
  throw new Error('not implemented');
}

export function renderCoverageMarkdown(_r: CoverageReport, _excerpt: (s: SpanRef) => string | null): string {
  throw new Error('not implemented');
}

export function safeExcerpt(_ctx: DaylightContext, _s: SpanRef, _o: { holdoutBasenames: ReadonlySet<string>; max?: number }): string | null {
  throw new Error('not implemented');
}

export function detectHedges(_index: SectionIndex, _config: SectionerConfig): CoverageReport['ambiguities'] {
  throw new Error('not implemented');
}

export function detectModalConflicts(_units: DetectorUnit[], _records: IrRecord[]): CoverageReport['contradictions'] {
  throw new Error('not implemented');
}

export function detectNumericConflicts(_units: DetectorUnit[], _records: IrRecord[]): CoverageReport['contradictions'] {
  throw new Error('not implemented');
}

export function applySeeds(_docs: Map<string, Buffer>, _index: SectionIndex, _seeds: SeededDefect[]): { docs: Map<string, Buffer>; at: Map<string, SpanRef> } {
  throw new Error('not implemented');
}
