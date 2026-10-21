import type { FocusCond, FocusItem, FocusRule } from '../mission/types.ts';

/**
 * Refine's focus ranking as data (P2-R40, P2-R47): which rows a person looks at first. The
 * order lives in `FOCUS_RULES`, never in code; `rankFocus` only applies it.
 */
export const FOCUS_RULES: readonly FocusRule[] = [
  { kind: 'assumption', tier: 0, where: [{ fact: 'status', in: ['open', 'pending'] }],
    order: [{ fact: 'blocking', dir: 'desc' }, { fact: 'statusRank', dir: 'asc' /* open 0, pending 1 */ },
      { fact: 'heldTickets', dir: 'desc' }, { fact: 'landedOnIt', dir: 'desc' }, { fact: 'ref', dir: 'asc' }] },
  { kind: 'finding', tier: 1, where: [{ fact: 'severity', in: ['high'] }, { fact: 'fixLanded', in: [false] }],
    order: [{ fact: 'corroborations', dir: 'desc' }, { fact: 'fixRank', dir: 'asc' /* none 0, proposed 1, blocked 2, in flight 3 */ },
      { fact: 'waveSeq', dir: 'asc' }, { fact: 'ref', dir: 'asc' }] },
  { kind: 'forgery-shape', tier: 2, where: [{ fact: 'landed', in: [true] }, { fact: 'forgeryCandidates', gt: 0 }],
    order: [{ fact: 'forgeryCandidates', dir: 'desc' }, { fact: 'linesChanged', dir: 'desc' }, { fact: 'ref', dir: 'asc' }] },
  { kind: 'blocked-ticket', tier: 3, where: [{ fact: 'status', in: ['blocked', 'waiting-dependency', 'waiting-owner'] }],
    order: [{ fact: 'dependents', dir: 'desc' /* transitive dependsOn count */ }, { fact: 'statusRank', dir: 'asc' /* blocked 0, dep 1, owner 2 */ },
      { fact: 'ref', dir: 'asc' }] },
  { kind: 'untested-diff', tier: 4, where: [{ fact: 'landed', in: [true] },
    { anyOf: [{ fact: 'acceptance', in: ['ci-only'] }, { fact: 'acceptanceVacuous', in: [true] }] }],
  order: [{ fact: 'linesChanged', dir: 'desc' }, { fact: 'files', dir: 'desc' }, { fact: 'ref', dir: 'asc' }] },
  { kind: 'introduced', tier: 5, where: [{ fact: 'touched', in: [true] }],
    order: [{ fact: 'invariantRegressed', dir: 'desc' }, { fact: 'members', dir: 'desc' }, { fact: 'ref', dir: 'asc' }] },
];

export function matches(_item: FocusItem, _where: readonly FocusCond[]): boolean {
  throw new Error('not implemented');
}

/** Filter by `where`, sort by tier then `order` lexicographically; booleans sort false < true. Pure. */
export function rankFocus(_items: readonly FocusItem[], _rules: readonly FocusRule[] = FOCUS_RULES): Array<FocusItem & { tier: number }> {
  throw new Error('not implemented');
}
