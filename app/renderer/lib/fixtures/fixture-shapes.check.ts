/**
 * The sample fixtures against the engine's own JSON types, checked by `tsc -p app/renderer`
 * (so `pnpm typecheck` fails when they drift; review H1). Each `_sample` value, with its
 * `_sample` mark taken off, must be assignable to the engine type and the engine type to it:
 * a field the engine adds and the fixture lacks, or one the fixture invents, is a type error
 * here. Types only: nothing in this file runs or reaches the bundle.
 */
import type { FocusStack } from '../../../../engine/focus/types.ts';
import type {
  CampaignRunResult, CampaignStatusReport, ForgeAssumptionRow, ForgeCampaignList, ForgeCampaignShow, RefineReport, WaveReport,
} from '../../../../engine/mission/types.ts';
import type { ForgeRefineMap } from '../types.ts';
import type {
  FORGE_ASSUMPTIONS, FORGE_CAMPAIGN_LIST, FORGE_CAMPAIGN_SHOW, FORGE_CAMPAIGN_STATUS, FORGE_DRY_RUN,
} from './forge-campaign.sample.ts';
import type { FORGE_WAVE_REPORT } from './forge-campaign-report.sample.ts';
import type { FORGE_REFINE, FORGE_REFINE_MAP } from './forge-campaign-refine.sample.ts';

type Unmarked<T> = Omit<T, '_sample'>;
/** True only when each is assignable to the other, with the extra `_sample` key removed. */
type Same<A, B> = [Unmarked<A>] extends [B] ? ([B] extends [Unmarked<A>] ? true : false) : false;
/** Excess keys a structural check would let through: keys the fixture has and the engine does not. */
type NoExtra<A, B> = Exclude<keyof Unmarked<A>, keyof B> extends never ? true : false;
type Ok<T extends true> = T;

export type FixtureShapes = [
  Ok<Same<typeof FORGE_CAMPAIGN_LIST, ForgeCampaignList>>, Ok<NoExtra<typeof FORGE_CAMPAIGN_LIST, ForgeCampaignList>>,
  Ok<Same<typeof FORGE_CAMPAIGN_SHOW, ForgeCampaignShow>>, Ok<NoExtra<typeof FORGE_CAMPAIGN_SHOW, ForgeCampaignShow>>,
  Ok<Same<typeof FORGE_CAMPAIGN_STATUS, CampaignStatusReport>>, Ok<NoExtra<typeof FORGE_CAMPAIGN_STATUS, CampaignStatusReport>>,
  Ok<Same<typeof FORGE_DRY_RUN, CampaignRunResult>>, Ok<NoExtra<typeof FORGE_DRY_RUN, CampaignRunResult>>,
  Ok<[typeof FORGE_ASSUMPTIONS[number]] extends [ForgeAssumptionRow] ? true : false>,
  Ok<Same<typeof FORGE_WAVE_REPORT, WaveReport>>, Ok<NoExtra<typeof FORGE_WAVE_REPORT, WaveReport>>,
  Ok<Same<typeof FORGE_REFINE, RefineReport>>, Ok<NoExtra<typeof FORGE_REFINE, RefineReport>>,
  Ok<Same<typeof FORGE_REFINE_MAP, ForgeRefineMap>>, Ok<NoExtra<typeof FORGE_REFINE_MAP, ForgeRefineMap>>,
  Ok<[NonNullable<typeof FORGE_REFINE_MAP['stack']>] extends [FocusStack] ? true : false>,
];
