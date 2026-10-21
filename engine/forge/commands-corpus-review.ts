import type { DaylightContext } from '../mission/context.ts';
import type { OutboxRunner } from '../mission/orchestrate.ts';
import type { ApproveIrSetV1 } from '../mission/types.ts';
import type { ConfirmDigest } from './confirm.ts';

/** `daylight corpus review|approve-ir|approve-blueprint|revise|diff|blueprint|packets`; the one caller file of §9's invariant. WS-R15. */

export const CORPUS_REVIEW_SUBCOMMANDS = ['review', 'approve-ir', 'approve-blueprint', 'revise', 'diff', 'blueprint', 'packets'] as const;

export async function runCorpusReviewCommand(_argv: string[], _env: NodeJS.ProcessEnv, _deps?: { runner?: OutboxRunner }): Promise<number> {
  throw new Error('not implemented');
}

export function confirmIngest(_ctx: DaylightContext, _op: 'approve-ir' | 'approve-blueprint', _subject: string, _o?: { set?: ApproveIrSetV1 }): ConfirmDigest {
  throw new Error('not implemented');
}
