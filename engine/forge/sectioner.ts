import type { DaylightContext } from '../mission/context.ts';
import type {
  CorpusDoc, CorpusManifest, CorpusRevision, CrossRef, ExtractWindow, NormativeSentence, Section, SectionerConfig, SectionIndex, Task,
} from '../mission/types.ts';
import { MAX_WINDOW_BYTES, WINDOW_TARGET_BYTES } from '../mission/types.ts';

/** The hierarchical sectioner (spec ingestion §3): pure, no LLM, configuration as data (P2-R52). WS-R14. */

export { MAX_WINDOW_BYTES, WINDOW_TARGET_BYTES };
export const SECTIONER_VERSION = 'daylight-sectioner/2';

/** RFC-2119 modals, generic imperatives and keywords; `§n` and `ADR n` labels; no project vocabulary. */
export const DEFAULT_SECTIONER_CONFIG: SectionerConfig = {
  v: 1, threshold: 0.5, labels: [], xrefs: [], cues: [], imperatives: [], ruleSections: [], informative: [], openDecision: [], tags: [], milestone: null,
};

/** One document as the sectioner reads it. */
export interface SectionerDoc { key: string; bytes: Buffer; role?: CorpusDoc['role']; title?: string }

export function effectiveConfig(_m: CorpusManifest, _sidecar?: Partial<SectionerConfig>): { config: SectionerConfig; configDigest: string } {
  throw new Error('not implemented');
}

export function sectionDocument(_docKey: string, _bytes: Buffer, _config: SectionerConfig): Section[] {
  throw new Error('not implemented');
}

export function unitsOf(_doc: SectionerDoc, _sections: Section[], _config: SectionerConfig): NormativeSentence[] {
  throw new Error('not implemented');
}

export function crossRefsOf(_doc: SectionerDoc, _sections: Section[], _config: SectionerConfig): CrossRef[] {
  throw new Error('not implemented');
}

export function resolveRefs(_refs: CrossRef[], _all: Section[], _docs: CorpusDoc[], _config: SectionerConfig): CrossRef[] {
  throw new Error('not implemented');
}

export function buildSectionIndex(_rev: Pick<CorpusRevision, 'docs' | 'corpusDigest'>, _bytesOf: (key: string) => Buffer, _config: SectionerConfig): SectionIndex {
  throw new Error('not implemented');
}

export function sectionSetDigestOf(_index: SectionIndex): string {
  throw new Error('not implemented');
}

export function labelOf(_title: string, _doc: Pick<CorpusDoc, 'key' | 'role'> & { title?: string }, _config: SectionerConfig): string | null {
  throw new Error('not implemented');
}

export function windowsOf(_index: SectionIndex, _bytesOf: (k: string) => Buffer, _o?: { target?: number }): ExtractWindow[] {
  throw new Error('not implemented');
}

export function windowOfTask(_ctx: DaylightContext, _task: Task): ExtractWindow {
  throw new Error('not implemented');
}
