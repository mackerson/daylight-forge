/**
 * Lenses and filters.
 *
 * A lens is a mode: it decides what question the map is answering, and only one is on at a
 * time. Filters stack inside the active lens and narrow *which nodes exist*, which is why
 * they are applied here to the focus stack rather than dimmed in the renderer — a node that
 * has been filtered out should not be in the layout at all, or "31 of 112 shown" is a
 * caption over a picture of 112 things.
 */
import type { Channel } from '../panels/Scene.tsx';
import type { FocusNode, FocusStack } from '../types.ts';

export interface Lens {
  id: Channel;
  name: string;
  /** The question the lens answers. Shown under the name, because that is what picks it. */
  question: string;
}

/**
 * The rail, in order.
 *
 * Five of these come straight from the design. The sixth does not, and is here because
 * removing it would have deleted a working feature to match a drawing: the map can colour
 * by uncertainty x centrality, which is what tells you where there is nothing to read yet.
 * The design bans the word "frontier" from the interface, not the idea, so it is named for
 * what a person would call it.
 */
export const LENSES: Lens[] = [
  { id: 'structure', name: 'Structure', question: 'How is it actually organised?' },
  { id: 'belief', name: 'Belief', question: 'What do we hold true, and how firmly?' },
  { id: 'candidates', name: 'Candidates', question: 'What did the static tools flag?' },
  { id: 'agent', name: 'Authorship', question: 'Which source said what?' },
  { id: 'change', name: 'Change', question: 'What has moved under our beliefs?' },
  { id: 'frontier', name: 'Unexamined', question: 'What has nobody looked at yet?' },
];

/**
 * Filters themselves live in the engine — they take a focus stack and return a smaller one,
 * which is a stack operation. What belongs here is what they are *called*.
 */
export type { Filter, Filtered } from '../../../../engine/focus/filter.ts';
export { applyFilters, availableFilters, filterKey } from '../../../../engine/focus/filter.ts';

import type { Filter } from '../../../../engine/focus/filter.ts';

/**
 * A filter set's name, derived from what it narrows to.
 *
 * The alternative is asking for one, and a modal asking for a name is a modal most people
 * cancel — so the set gets called what it does. Two sets that narrow identically get the
 * same name, which is correct: they are the same view.
 */
export const filterSetName = (filters: Filter[]): string =>
  filters.map(filterLabel).join(' · ') || 'everything';

export const filterLabel = (f: Filter): string => {
  switch (f.kind) {
    case 'contested': return 'contested';
    case 'unexamined': return 'never examined';
    case 'flagged': return 'flagged by a tool';
    case 'source': return `touched by ${f.value}`;
    case 'path': return f.value;
  }
};
