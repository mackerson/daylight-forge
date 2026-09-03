/**
 * Filtering a focus stack.
 *
 * This is a focus-stack operation, not an interface one: it takes a stack and returns a
 * smaller stack, and the renderer is one caller. It lived in the renderer until a test for
 * it had to import upward across the engine boundary and the repo's own invariant refused —
 * which was the right answer. The wording each filter is shown under is still the
 * interface's business and stays there.
 *
 * A filtered node is removed rather than dimmed, because the count printed beside the map
 * has to be a count of what is drawn.
 */
import type { FocusNode, FocusStack } from './types.ts';

export type Filter =
  | { kind: 'contested' }
  | { kind: 'unexamined' }
  | { kind: 'flagged' }
  | { kind: 'source'; value: string }
  | { kind: 'path'; value: string };

export const filterKey = (f: Filter): string =>
  'value' in f ? `${f.kind}:${f.value}` : f.kind;

function matches(node: FocusNode, f: Filter, flagged: ReadonlySet<string>): boolean {
  switch (f.kind) {
    case 'contested':
      return node.belief?.status === 'CONTRADICTED';
    case 'unexamined':
      return !node.belief || node.belief.known === 0;
    case 'flagged':
      return node.members.some((m) => flagged.has(m));
    case 'source':
      return !!node.belief?.agents.includes(f.value);
    case 'path':
      return node.id === f.value || node.members.some((m) => m === f.value || m.startsWith(`${f.value}/`));
  }
}

export interface Filtered {
  stack: FocusStack | null;
  shown: number;
  total: number;
  /** The files still on the map, so "explore these N" can scope a run to exactly them. */
  files: string[];
  /**
   * True when the filters matched nothing and were therefore not applied.
   *
   * An empty map is indistinguishable from a broken one, so the filters stay visible and
   * the bar says why nothing narrowed rather than showing a blank canvas.
   */
  empty: boolean;
}

/** Apply the active filters to the stack. Filters are AND — each one narrows further. */
export function applyFilters(
  stack: FocusStack | null,
  filters: Filter[],
  flagged: ReadonlySet<string>,
): Filtered {
  const total = stack ? stack.levels.reduce((n, l) => n + l.nodes.length, 0) : 0;
  if (!stack || !filters.length) {
    return {
      stack,
      shown: total,
      total,
      files: stack ? [...new Set(stack.levels.flatMap((l) => l.nodes.flatMap((n) => n.members)))] : [],
      empty: false,
    };
  }

  const levels = stack.levels.map((level) => {
    const nodes = level.nodes.filter((n) => filters.every((f) => matches(n, f, flagged)));
    const keep = new Set(nodes.map((n) => n.id));
    return {
      ...level,
      nodes,
      // An edge to a node that is no longer here is a rope tied to nothing.
      edges: level.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
  });

  const shown = levels.reduce((n, l) => n + l.nodes.length, 0);
  if (shown === 0) return { stack, shown: total, total, files: [], empty: true };

  return {
    stack: { ...stack, levels: levels as FocusStack['levels'] },
    shown,
    total,
    files: [...new Set(levels.flatMap((l) => l.nodes.flatMap((n) => n.members)))],
    empty: false,
  };
}

/**
 * Filters worth offering, derived from what is actually in this map.
 *
 * A menu of filters that match nothing is a menu of dead ends, so every option here is one
 * that would leave at least one node standing.
 */
export function availableFilters(
  stack: FocusStack | null,
  flagged: ReadonlySet<string>,
): Filter[] {
  if (!stack) return [];
  const nodes = stack.levels.flatMap((l) => l.nodes);
  const out: Filter[] = [];

  const has = (f: Filter) => nodes.some((n) => matches(n, f, flagged));
  for (const f of [{ kind: 'contested' }, { kind: 'unexamined' }, { kind: 'flagged' }] as Filter[]) {
    if (has(f)) out.push(f);
  }

  for (const s of [...new Set(nodes.flatMap((n) => n.belief?.agents ?? []))].sort()) {
    out.push({ kind: 'source', value: s });
  }

  // Top-level directories, from the shallowest level — the subtrees a person names.
  const shallow = stack.levels[stack.levels.length - 1] ?? stack.levels[0];
  for (const n of shallow?.nodes ?? []) {
    if (n.origin === 'path' || n.origin === 'cluster') out.push({ kind: 'path', value: n.id });
  }

  return out;
}
