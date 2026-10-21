import type { DaylightContext } from '../mission/context.ts';
import type { FocusItem, RefineDiff, RefineMapRef, RefineReport } from '../mission/types.ts';

/**
 * `campaign refine` (WS-R8, P2-R40): the map of the integration tip and its base, materialised
 * through `createWorkspace` with holdouts hidden, never the checkout; their findings compared;
 * the campaign's rows ranked by `FOCUS_RULES`. Writes under `<out>` only.
 */

/** Part of the map cache key, with the revision and the parser set. */
export const MAP_FORMAT = 1;

/** A refine that cannot run. Its message never names a path from the refused tree (P2-R45 D7). */
export class RefineRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefineRefused';
  }
}

export function refineMapDir(_out: string, _campaignId: string, _rev: string): string {
  throw new Error('not implemented');
}

export function mapRevision(_ctx: Pick<DaylightContext, 'out' | 'store'>, _o: { repo: string; rev: string; campaignId: string }): RefineMapRef {
  throw new Error('not implemented');
}

export function refineReport(_ctx: DaylightContext, _campaignId: string, _repo: string, _o: { rev?: string; rowsOnly?: boolean } = {}): RefineReport {
  throw new Error('not implemented');
}

export function readRefine(_out: string, _campaignId: string, _repo: string): RefineReport | null {
  throw new Error('not implemented');
}

export function findingsDiff<T extends { key: string; touched: boolean }>(_base: readonly T[], _rev: readonly T[]): RefineDiff<T> {
  throw new Error('not implemented');
}

export function focusFacts(_ctx: DaylightContext, _campaignId: string, _repo: string): FocusItem[] {
  throw new Error('not implemented');
}
