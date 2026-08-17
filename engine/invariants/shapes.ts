import type { NodeKind } from '../graph/types.ts';
import type { Predicate } from './engine.ts';

/**
 * The authoring vocabulary for invariants.
 *
 * Lives beside the predicate language rather than in the renderer, because it *is* the
 * predicate language stated in the terms a person writes it in. The GUI form is one consumer;
 * an agent proposing an invariant is another, and both should be offered the same shapes with
 * the same descriptions rather than each inventing their own.
 *
 * Every shape's `build` returns a `Predicate`, so a form that cannot produce a valid predicate
 * fails to compile rather than at the boundary.
 */

export interface Shape {
  type: string;
  summary: string;
  /** Fields the form collects, in order. */
  fields: Array<{ key: string; label: string; hint: string; kind?: 'number' }>;
  build(v: Record<string, string>): Predicate;
}

/** Every kind the graph actually carries. Offering one it does not have would match nothing. */
export const KINDS: NodeKind[] = [
  'file', 'function', 'method', 'class', 'interface', 'typeAlias', 'enum', 'variable',
];

/**
 * A kind the graph does not have matches nothing, silently — which reads as a green
 * invariant and is the worst failure this form could have. Unknown kinds are dropped here,
 * so an all-unknown list becomes "no kind filter" rather than "matches nothing".
 */
const selector = (name: string, kinds: string) => {
  const kind = kinds
    .split(',')
    .map((k) => k.trim())
    .filter((k): k is NodeKind => (KINDS as string[]).includes(k));
  return {
    ...(kind.length ? { kind } : {}),
    ...(name.trim() ? { name: name.trim() } : {}),
  };
};

export const SHAPES: Shape[] = [
  {
    type: 'absent',
    summary: 'Nothing matching this exists.',
    fields: [
      { key: 'name', label: 'name matches', hint: 'regex, e.g. ^Legacy' },
      { key: 'kind', label: 'kinds', hint: `comma-separated: ${KINDS.join(', ')}` },
    ],
    build: (v) => ({ type: 'absent', select: selector(v.name, v.kind) }),
  },
  {
    type: 'count',
    summary: 'How many of these there are stays within a range.',
    fields: [
      { key: 'name', label: 'name matches', hint: 'regex' },
      { key: 'kind', label: 'kinds', hint: 'comma-separated' },
      { key: 'min', label: 'at least', hint: 'blank for no floor', kind: 'number' },
      { key: 'max', label: 'at most', hint: 'blank for no ceiling', kind: 'number' },
    ],
    build: (v) => ({
      type: 'count',
      select: selector(v.name, v.kind),
      ...(v.min ? { min: Number(v.min) } : {}),
      ...(v.max ? { max: Number(v.max) } : {}),
    }),
  },
  {
    type: 'forbidden-call',
    summary: 'These files never reach those files. The layering claim.',
    fields: [
      { key: 'from', label: 'from files matching', hint: 'regex over the path' },
      { key: 'to', label: 'must not reach', hint: 'regex over the path' },
      { key: 'member', label: 'only via member', hint: 'optional — leave blank for any' },
    ],
    build: (v) => ({
      type: 'forbidden-call',
      from: { file: v.from.trim() },
      to: { file: v.to.trim() },
      ...(v.member.trim() ? { member: v.member.trim() } : {}),
    }),
  },
  {
    type: 'forbidden-callee',
    summary: 'Nothing in here calls that. "No randomness in the scene code."',
    fields: [
      { key: 'within', label: 'within files matching', hint: 'regex over the path' },
      { key: 'callee', label: 'never calls', hint: 'regex over the callee name' },
    ],
    build: (v) => ({
      type: 'forbidden-callee',
      within: { file: v.within.trim() },
      callee: v.callee.trim(),
    }),
  },
  {
    type: 'required-callee',
    summary: 'Something in here does call that. The positive form.',
    fields: [
      { key: 'within', label: 'within files matching', hint: 'regex over the path' },
      { key: 'callee', label: 'must call', hint: 'regex over the callee name' },
      { key: 'min', label: 'at least', hint: 'how many call sites', kind: 'number' },
    ],
    build: (v) => ({
      type: 'required-callee',
      within: { file: v.within.trim() },
      callee: v.callee.trim(),
      min: Number(v.min || 1),
    }),
  },
  {
    type: 'literal-fanin',
    summary: 'A magic string is not spread across the codebase.',
    fields: [
      { key: 'value', label: 'the literal', hint: 'exact string, e.g. a table or channel name' },
      { key: 'maxFiles', label: 'in at most', hint: 'files', kind: 'number' },
    ],
    build: (v) => ({
      type: 'literal-fanin',
      value: v.value,
      maxFiles: Number(v.maxFiles || 1),
    }),
  },
];
