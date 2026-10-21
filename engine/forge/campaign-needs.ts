import type { DaylightContext } from '../mission/context.ts';
import type { CampaignEnvelope, Mission, Need } from '../mission/types.ts';
import { assumptionNeeds } from './assumptions.ts';
import { campaignRunNeeds } from './director.ts';
import { integrationRefFor, refTarget } from './integrate.ts';

/**
 * What a person has to do for a campaign to move (§2.4), derived from rows on every read: approve
 * the plan as imported, authorize (again) when there is no authorization in force, resume a halt,
 * and answer its assumptions. Generated tickets still proposed are `work-item-undecided`.
 */
export function campaignNeeds(ctx: DaylightContext, campaign: Mission): Need[] {
  const out: Need[] = [];
  const plan = ctx.store.currentPlan(campaign.id);
  const approved = ctx.store.latestDecision(campaign.id, 'approve-plan');
  const planApproved = !!plan && approved?.scope.planDigest === plan.planDigest;
  if (plan && !planApproved) {
    out.push({ kind: 'plan-approval', ref: campaign.id, why: `campaign ${campaign.id}'s plan at ${plan.commit.slice(0, 12)} is not approved; a person runs \`daylight campaign approve-plan\`` });
  }
  const halts = ctx.store.campaignHalts(campaign.id);
  const root = ctx.store.project(campaign.projectId)?.root;
  for (const h of halts) {
    // An integration-moved halt is answered by adopt-tip, which adopts the ref where it is now.
    const at = h.scope.reason === 'integration-moved' && root ? refTarget(root, integrationRefFor(campaign.id)) : null;
    out.push({
      kind: 'campaign-halted', ref: h.id, why: `campaign ${campaign.id} is halted (${String(h.scope.reason)}); a person reads why and resumes it`,
      ...(at ? { commit: at } : {}),
    });
  }
  if (planApproved) {
    const auth = ctx.store.campaignAuthorization(campaign.id);
    const why = !auth ? 'has no authorization'
      : (auth.scope as unknown as CampaignEnvelope).planDigest !== plan!.planDigest ? 'is authorized for an earlier plan'
        : ctx.store.latestDecision(campaign.id, 'lock-campaign-gates')?.scope.gateSetDigest !== auth.scope.gateSetDigest ? 'is authorized for an earlier gate lock'
          : (auth.scope as unknown as CampaignEnvelope).notAfter < ctx.store.clock() ? 'has an expired authorization' : null;
    if (why) out.push({ kind: 'campaign-authorize', ref: campaign.id, why: `campaign ${campaign.id} ${why}; a person runs \`daylight campaign authorize\`` });
  }
  for (const t of ctx.store.campaignTickets(campaign.id)) {
    if (t.origin === 'plan') continue;
    if (ctx.store.workItem(t.workItemId)?.status === 'proposed') {
      out.push({ kind: 'work-item-undecided', ref: t.workItemId, why: `${t.origin} ticket ${t.ticketId} is proposed; a person approves or rejects it` });
    }
  }
  return [...out, ...assumptionNeeds(ctx, campaign), ...campaignRunNeeds(ctx, campaign)];
}

/** True when a campaign's director owns its children's candidate and apply needs. */
export function directorApplies(ctx: DaylightContext, campaign: Mission): boolean {
  const auth = ctx.store.campaignAuthorization(campaign.id);
  return (auth?.scope as Partial<CampaignEnvelope> | undefined)?.autoApply === 'integration-ref';
}
