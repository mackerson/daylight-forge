import type { DaylightContext } from '../mission/context.ts';
import type { CorpusDoc, CorpusManifest, CorpusRevision, ResolvedDependency, ResolvedPrecedence, SectionIndex } from '../mission/types.ts';

/**
 * A specification corpus (spec ingestion §2): a manifest read from git at a commit, its documents
 * registered as artifacts of one `corpus` mission, and a deterministic section index. WS-R14.
 */

export const CORPUS_FILE = 'daylight.corpus.json';
export const MAX_CORPUS_DOC_BYTES = 2 * 1024 * 1024;
export const MAX_CORPUS_BYTES = 8 * 1024 * 1024;
export const MAX_CORPUS_DOCS = 64;
export const MAX_SECTIONS = 8_000;
export const MAX_SENTENCES = 40_000;

export class CorpusRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusRefused';
  }
}

export interface CorpusManifestRefusal { path: string; rule: string; detail: string }

export function parseCorpusManifest(_raw: Buffer | string): CorpusManifest | CorpusManifestRefusal[] {
  throw new Error('not implemented');
}

export function corpusDigestOf(_docs: CorpusDoc[], _p: ResolvedPrecedence[], _d: ResolvedDependency[]): string {
  throw new Error('not implemented');
}

export function registerCorpus(_ctx: DaylightContext, _repo: string, _manifest: string, _o: { rev?: string; projects?: Record<string, string> } = {}): CorpusRevision {
  throw new Error('not implemented');
}

export function corpusOf(_ctx: DaylightContext, _corpusId: string, _revisionId?: string): CorpusRevision & { bytesOf(key: string): Buffer; index: SectionIndex } {
  throw new Error('not implemented');
}

export function readCorpusDoc(_ctx: DaylightContext, _revisionId: string, _key: string): Buffer {
  throw new Error('not implemented');
}
