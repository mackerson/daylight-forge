import type { PlanFile } from '../../mission/types.ts';

/** The project-agnostic plan scorer (spec ingestion §11.3). WS-R16 owns and may widen these types. */

export interface GtPlan { tickets: Array<{ id: string; lane: string; scope: string[]; dependsOn: string[] }> }
export interface PlanScore { recall: number; idExactness: number; depRecall: number; depPrecision: number; pathCoverage: number }

export function parseGroundTruth(_markdown: string): GtPlan {
  throw new Error('not implemented');
}

export function scorePlan(_gt: GtPlan, _plan: PlanFile, _o: { pathTolerance: 'parent-dir' }): PlanScore {
  throw new Error('not implemented');
}
