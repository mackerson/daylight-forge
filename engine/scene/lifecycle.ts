/**
 * What a change to the scene's inputs actually requires.
 *
 * Pure, and free of three.js and the DOM, so the engine's test runner can check it under
 * plain Node. This is the decision the one big effect used to make implicitly — and made
 * wrong: its dependency list mixed the lens in with the layout, so switching from structure
 * to belief tore the WebGL context down and built the whole scene again to change some
 * colours. Three classes of input, three costs:
 *
 *  - rebuild:  a new renderer. Only when the repository changes, or on mount.
 *  - relayout: the layout is recomputed and meshes, ropes and labels rebuilt on the same
 *              renderer. Anything that moves a node or changes which nodes exist.
 *  - recolor:  instance colours are rewritten in place. The lens and what it reads from.
 *
 * Identity comparison throughout. The shell hands the scene fresh objects when it reloads,
 * and a reload is a legitimate reason to relayout; a cheaper diff would be a second opinion
 * about whether the map changed, and the map is the engine's to decide.
 */

export type SceneMode = 'graph' | 'tree';
export type SceneLod = 'auto' | 'all';

export interface SceneInputs {
  repo: string | null;
  stack: unknown;
  fileEdges: unknown;
  mode: SceneMode;
  lod: SceneLod;
  expanded: unknown;
  symbols: unknown;
  moved: unknown;
  allLevelsLimit: number;
  channel: string;
  flagged: unknown;
  defended: unknown;
}

export type UpdatePlan = 'rebuild' | 'relayout' | 'recolor' | 'none';

export const REBUILD_INPUTS: readonly (keyof SceneInputs)[] = ['repo'];
export const RELAYOUT_INPUTS: readonly (keyof SceneInputs)[] = [
  'stack', 'fileEdges', 'mode', 'lod', 'expanded', 'symbols', 'moved', 'allLevelsLimit',
];
export const RECOLOR_INPUTS: readonly (keyof SceneInputs)[] = ['channel', 'flagged', 'defended'];

const changed = (
  prev: SceneInputs, next: SceneInputs, keys: readonly (keyof SceneInputs)[],
): boolean => keys.some((k) => prev[k] !== next[k]);

/** The most expensive thing any changed input demands; `rebuild` with no previous inputs. */
export function planUpdate(prev: SceneInputs | null, next: SceneInputs): UpdatePlan {
  if (!prev) return 'rebuild';
  if (changed(prev, next, REBUILD_INPUTS)) return 'rebuild';
  if (changed(prev, next, RELAYOUT_INPUTS)) return 'relayout';
  if (changed(prev, next, RECOLOR_INPUTS)) return 'recolor';
  return 'none';
}
