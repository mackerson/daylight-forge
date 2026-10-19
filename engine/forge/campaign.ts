import type { DaylightContext } from '../mission/context.ts';
import { NotImplemented } from '../mission/store.ts';
import type { MissionStore } from '../mission/store.ts';
import type { EnvelopeRequest, Mission } from '../mission/types.ts';

/**
 * Campaigns: a plan imported as data, approved once, and run by the director process under one
 * human `authorize-campaign` decision (docs/daylight/CAMPAIGN.md, ADR-36, ADR-37).
 */

export type { EnvelopeRequest };

/**
 * Why this mission's `authorize-mission` grant does not let it run, or null. What preflight asks
 * in place of `isHumanActor(authorize.actor)`: a human grant, or a derived one inside its
 * campaign's envelope.
 */
export function authorizeGrantRefusal(ctx: DaylightContext, mission: Mission): string | null {
  void ctx; void mission;
  throw new NotImplemented('authorizeGrantRefusal');
}

/**
 * Why `request` falls outside the envelope of the human `authorize-campaign` decision
 * `parentDecisionId`, or null. Reads rows only; `recordDerivedDecision` and R6's
 * `landIntegration` call it inside their transaction.
 */
export function envelopeRefusal(store: MissionStore, parentDecisionId: string, request: EnvelopeRequest): string | null {
  void store; void parentDecisionId; void request;
  throw new NotImplemented('envelopeRefusal');
}
