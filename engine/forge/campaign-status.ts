import type { DaylightContext } from '../mission/context.ts';
import { FINDING_SEVERITIES } from '../mission/types.ts';
import type { CampaignStatusReport, FindingSeverity, Need, TicketStatus } from '../mission/types.ts';
import { campaignNeeds } from './campaign-needs.ts';
import { campaignRunNeeds, campaignSpend, haltOf, r5Host, ticketStates, type CampaignHost } from './director.ts';
import { authorizationOf, envelopeOf, integrationRefFor, integrationTip } from './integrate.ts';

/**
 * `campaign status` (§7): the campaign as rows and the integration ref say it is, derived on
 * every call and never stored. Written under `<out>` on request, never into the target
 * repository (P2-R13); a person who wants it committed copies it.
 */

const STATUSES: readonly TicketStatus[] = ['superseded', 'waiting-owner', 'waiting', 'ready', 'running', 'integrating', 'waiting-dependency', 'landed', 'blocked'];

/** What `campaign status` reads beyond R6's rows: WS-R5's plan revision, assumptions and needs. */
export type StatusHost = CampaignHost & Partial<{
  planRevision(campaignId: string): string;
  assumptions(campaignId: string): CampaignStatusReport['assumptions']['items'];
  needs(campaignId: string): Need[];
}>;

/** R5's host with the plan revision, assumptions and needs `campaign status` shows. */
export function r5StatusHost(ctx: DaylightContext): StatusHost {
  const campaign = (id: string) => {
    const m = ctx.store.mission(id);
    if (!m || m.kind !== 'campaign') throw new Error(`${id} is not a campaign`);
    return m;
  };
  return {
    ...r5Host(ctx),
    planRevision: (id) => ctx.store.currentPlan(id)?.planRevision ?? campaign(id).baseRevision,
    assumptions: (id) => ctx.store.assumptions(id),
    needs: (id) => campaignNeeds(ctx, campaign(id)),
  };
}

export function campaignStatus(ctx: DaylightContext, campaignId: string, repo: string, host: StatusHost): CampaignStatusReport {
  const campaign = ctx.store.mission(campaignId);
  if (!campaign || campaign.kind !== 'campaign') throw new Error(`${campaignId} is not a campaign`);
  const auth = authorizationOf(ctx.store, campaignId);
  const states = ticketStates(ctx, campaignId, repo, host);
  const ref = integrationRefFor(campaignId);
  const tip = integrationTip(repo, campaignId) ?? campaign.baseRevision;
  const byLane = new Map<string, Record<TicketStatus, number>>();
  for (const s of states.values()) {
    const row = byLane.get(s.ticket.lane) ?? Object.fromEntries(STATUSES.map((x) => [x, 0])) as Record<TicketStatus, number>;
    row[s.status]++;
    byLane.set(s.ticket.lane, row);
  }
  const items = host.assumptions?.(campaignId) ?? [];
  const count = (st: string) => items.filter((a) => a.status === st).length;
  const findings = ctx.store.findings(campaignId);
  return {
    kind: 'daylight-campaign-status', campaignId, projectId: campaign.projectId, planRevision: host.planRevision?.(campaignId) ?? campaign.baseRevision,
    integration: {
      ref, base: campaign.baseRevision, tip, landed: [...states.values()].filter((s) => s.status === 'landed').length,
      mergeHint: `git merge --ff-only ${ref}`,
    },
    authorization: { decisionId: auth?.id ?? null, notAfter: auth ? envelopeOf(auth).notAfter : null, halted: haltOf(ctx.store, campaignId)?.reason ?? null },
    lanes: [...byLane].sort(([a], [b]) => (a < b ? -1 : 1)).map(([lane, byStatus]) => ({ lane, total: Object.values(byStatus).reduce((n, x) => n + x, 0), byStatus })),
    tickets: [...states.values()].map((s) => ({
      id: s.ticket.ticketId, lane: s.ticket.lane, status: s.status, ...(s.mission ? { missionId: s.mission.id } : {}), attempts: s.attempts,
      ...(s.commit ? { commit: s.commit } : {}), ...(s.reason ? { reason: s.reason } : {}),
    })),
    assumptions: { open: count('open'), pending: count('pending'), confirmed: count('confirmed'), overturned: count('overturned'), items },
    // R5's campaignNeeds already holds the director's (§8.5 step 1); without it, the director's alone.
    needs: host.needs ? host.needs(campaignId) : campaignRunNeeds(ctx, campaign, host),
    spend: campaignSpend(ctx, campaignId),
    waves: ctx.store.waves(campaignId).map((w) => {
      const fs = findings.filter((f) => f.waveSeq === w.seq);
      return {
        seq: w.seq, tickets: w.ticketIds.length,
        findings: Object.fromEntries(FINDING_SEVERITIES.map((sev) => [sev, fs.filter((f) => f.severity === sev).length])) as Record<FindingSeverity, number>,
        // Several findings on one path share one fix ticket (wave2 L5): tickets, not findings.
        fixTickets: new Set(fs.map((f) => f.fixTicketId).filter(Boolean)).size,
      };
    }),
  };
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** STATUS.md in kitkraft's shape: landed per lane, assumptions pending, needs, spend, waves. No timestamp. */
export function renderCampaignStatus(r: CampaignStatusReport): string {
  const notes = [
    r.spend.unknownCount ? `${r.spend.unknownCount} unknown` : '',
    r.spend.reservationCount ? `${money(r.spend.reservationUsd)} charged at reservation for ${r.spend.reservationCount} unfinished attempt(s)` : '',
  ].filter(Boolean);
  const spend = notes.length ? `≥ ${money(r.spend.spentUsd)} (${notes.join('; ')})` : money(r.spend.spentUsd);
  const lines = [
    `# Campaign ${r.campaignId}`, '',
    `Plan ${r.planRevision}. Integration ${r.integration.ref} at ${r.integration.tip.slice(0, 12)} (base ${r.integration.base.slice(0, 12)}), ${r.integration.landed} landed.`,
    `Merge it yourself: \`${r.integration.mergeHint}\``, '',
    r.authorization.decisionId ? `Authorized by ${r.authorization.decisionId}${r.authorization.halted ? `; halted (${r.authorization.halted})` : ''}.` : 'Not authorized.',
    `Spend ${spend} of ${money(r.spend.capUsd)}.`, '',
    '## Lanes', '',
    ...r.lanes.map((l) => `- ${l.lane}: ${l.byStatus.landed}/${l.total} landed${l.byStatus.blocked ? `, ${l.byStatus.blocked} blocked` : ''}${l.byStatus.running ? `, ${l.byStatus.running} running` : ''}`),
    '', '## Tickets', '',
    ...r.tickets.map((t) => `- ${t.id} (${t.lane}) ${t.status}${t.commit ? ` ${t.commit.slice(0, 12)}` : ''}${t.attempts ? `, ${t.attempts} attempt(s)` : ''}${t.reason ? `: ${t.reason}` : ''}`),
    '', '## Assumptions pending the owner', '',
    ...(r.assumptions.items.filter((a) => a.status === 'pending' || a.status === 'open').map((a) => `- ${a.id} ${a.status}: ${a.question}`) ),
    ...(r.assumptions.open + r.assumptions.pending ? [] : ['- none']),
    '', '## Needs', '',
    ...(r.needs.length ? r.needs.map((n) => `- ${n.kind} ${n.ref}: ${n.why}`) : ['- none']),
    '', '## Waves', '',
    ...(r.waves.length ? r.waves.map((w) => `- wave ${w.seq}: ${w.tickets} ticket(s); findings high ${w.findings.high}, medium ${w.findings.medium}, low ${w.findings.low}; ${w.fixTickets} fix ticket(s)`) : ['- none closed']),
    '',
  ];
  return lines.join('\n');
}
