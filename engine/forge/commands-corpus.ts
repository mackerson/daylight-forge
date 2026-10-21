import type { OutboxRunner } from '../mission/orchestrate.ts';

/** `daylight corpus register|show|sections|extract|coverage|ir` (spec ingestion §5). WS-R14. */

export const CORPUS_SUBCOMMANDS = ['register', 'show', 'sections', 'extract', 'coverage', 'ir'] as const;

export async function runCorpusCommand(_argv: string[], _env: NodeJS.ProcessEnv, _deps?: { runner?: OutboxRunner }): Promise<number> {
  throw new Error('not implemented');
}
