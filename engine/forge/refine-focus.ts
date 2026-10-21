import type { FactValue, FocusCond, FocusItem, FocusRule } from '../mission/types.ts';

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

const factOf = (item: FocusItem, fact: string): FactValue | undefined => item.facts[fact] ?? (fact === 'ref' ? item.ref : undefined);

/** Whether `item` satisfies every condition (AND); `anyOf` is OR over its members. */
export function matches(item: FocusItem, where: readonly FocusCond[]): boolean {
  return where.every((c) => {
    if ('anyOf' in c) return c.anyOf.some((x) => matches(item, [x]));
    const v = factOf(item, c.fact);
    if ('gt' in c) return typeof v === 'number' && v > c.gt;
    return v !== undefined && c.in.includes(v);
  });
}

/** false < true; numbers by value; strings by code unit; an absent fact before any present one. */
function compare(a: FactValue | undefined, b: FactValue | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Filter by `where`, sort by tier then `order` lexicographically; booleans sort false < true. Pure. */
export function rankFocus(items: readonly FocusItem[], rules: readonly FocusRule[] = FOCUS_RULES): Array<FocusItem & { tier: number }> {
  const ranked: Array<{ item: FocusItem; rule: FocusRule }> = [];
  for (const item of items) {
    const rule = [...rules].sort((a, b) => a.tier - b.tier).find((r) => r.kind === item.kind && matches(item, r.where));
    if (rule) ranked.push({ item, rule });
  }
  ranked.sort((a, b) => {
    if (a.rule.tier !== b.rule.tier) return a.rule.tier - b.rule.tier;
    for (const o of a.rule.order) {
      const d = compare(factOf(a.item, o.fact), factOf(b.item, o.fact));
      if (d) return o.dir === 'asc' ? d : -d;
    }
    return 0;
  });
  return ranked.map(({ item, rule }) => ({ ...item, tier: rule.tier }));
}
