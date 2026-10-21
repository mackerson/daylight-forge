import type {
  Assumption, CampaignRunResult, CampaignSpend, CampaignStatusReport, CampaignTicket, ForgeAssumptionRow, ForgeCampaignList,
  ForgeCampaignShow, Mission, Need, StatusBucket, StatusTable, TicketStatus,
} from '../types.ts';
import { SAMPLE_MARK } from './forge-implement.sample.ts';

/**
 * SAMPLE DATA — two campaigns in the shape WS-R8's `campaign list|show|status`, `assumption
 * list` and `campaign run --dry-run` print as JSON (refine-interfaces v2 §1.4, §1.5).
 * Hand-written and SYNTHETIC: no model produced any of it. Loaded only under
 * `DAYLIGHT_MISSION_SAMPLE=1`; every screen that shows it says "sample".
 *
 * The open campaign (`SAMPLE_CAMPAIGN`) is halted for unknown spend, its loop gone: one ticket
 * in every status, lanes API, UI and FIX, an open blocking owner decision and a pending default,
 * a proposed fix ticket, and spend with a figure missing, a scanned one and a reservation. Its
 * lock holds two holdouts, counted; `SAMPLE_HOLDOUT_ID` is never placed in any field, so a
 * test can show that no screen or fixture names it.
 */

const PROJECT = 'git:5a5a5a5a5a5a';
const T0 = 1792500000000;
const HOUR = 3_600_000;
const hex = (seed: string) => seed.repeat(32).slice(0, 32);
const id = (p: string, seed: string) => `${p}_${hex(seed)}`;
const sha = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const commit = (seed: string) => seed.repeat(40).slice(0, 40);

export const SAMPLE_HOLDOUT_ID = id('x', '9e');
/**
 * A holdout test's basename, planted in the one sample field no campaign screen draws (the
 * campaign mission's scope, below), so the DOM checks' "no holdout on the page" can go red if a
 * screen starts drawing it. The engine withholds such basenames (P2-R37); this guards the screens.
 */
export const SAMPLE_HOLDOUT_BASENAME = 'holdout_9e9e9e9e_sentinel.rs';
export const CAMPAIGN_RUNNING = id('m', 'c1');
export const SAMPLE_CAMPAIGN = id('m', 'c2');
export const BASE = commit('b0');
export const TIP = commit('7e');
export const HALT_DECISION = id('d', 'h1');
export const AUTH_DECISION = id('d', 'a1');
export const U_OPEN = id('u', 'a7');
export const U_PENDING = id('u', 'b7');
export const FORGED_CANDIDATE = id('c', 'f9');
const REF = `refs/heads/daylight/campaign/${SAMPLE_CAMPAIGN}`;

const mission = (mid: string, objective: string, state: Mission['state']): Mission => ({
  id: mid, projectId: PROJECT, kind: 'campaign', objective, baseRevision: BASE, scope: { paths: ['src/'] },
  permissions: { read: true, write: false, execute: false, deploy: false }, budget: { maxUsd: 40 },
  requirementIds: [], acceptanceGateIds: [], state, taskIds: [], createdAt: T0, updatedAt: T0 + 30 * HOUR,
});

const buckets = (o: Partial<Record<StatusBucket, number>>): Record<StatusBucket, number> =>
  ({ done: 0, 'in-progress': 0, blocked: 0, requests: 0, queued: 0, superseded: 0, ...o });
const names = (o: Partial<Record<StatusBucket, string[]>>): Record<StatusBucket, string[]> =>
  ({ done: [], 'in-progress': [], blocked: [], requests: [], queued: [], superseded: [], ...o });

// ---- tickets: one in every TicketStatus -----------------------------------------------------

interface T { ticketId: string; lane: string; origin: CampaignTicket['origin']; dependsOn: string[]; blocksOn: string[]; status: TicketStatus;
  title: string; reason?: string; attempts: number; missionSeed?: string; commitSeed?: string; workItemStatus: ForgeCampaignShow['tickets'][number]['status'] }
const TICKETS: T[] = [
  { ticketId: 'API.1', lane: 'API', origin: 'plan', dependsOn: [], blocksOn: [], status: 'landed', title: 'Parse the request envelope', attempts: 1, missionSeed: 'a1', commitSeed: '11', workItemStatus: 'approved' },
  { ticketId: 'API.2', lane: 'API', origin: 'plan', dependsOn: ['API.1'], blocksOn: [], status: 'blocked', title: 'Validate the header block', attempts: 1, missionSeed: 'a2',
    reason: 'mission closed inconclusive at preflight: the author sandbox was unavailable; a person releases it with campaign retry', workItemStatus: 'approved' },
  { ticketId: 'API.3', lane: 'API', origin: 'plan', dependsOn: ['API.1'], blocksOn: [], status: 'running', title: 'Stream large bodies', attempts: 2, missionSeed: 'a3', workItemStatus: 'approved' },
  { ticketId: 'API.4', lane: 'API', origin: 'plan', dependsOn: ['API.1'], blocksOn: [], status: 'integrating', title: 'Return typed errors', attempts: 1, missionSeed: 'a4', workItemStatus: 'approved' },
  { ticketId: 'API.5', lane: 'API', origin: 'plan', dependsOn: ['API.3', 'API.4'], blocksOn: [], status: 'waiting', title: 'Retry with backoff', attempts: 0, workItemStatus: 'approved' },
  { ticketId: 'UI.1', lane: 'UI', origin: 'plan', dependsOn: [], blocksOn: [], status: 'regressed' as TicketStatus, title: 'Status page skeleton', attempts: 1, missionSeed: 'b1', commitSeed: '22',
    reason: `its gate fails on the tip ${commit('7e').slice(0, 12)}: ui-status-renders`, workItemStatus: 'approved' },
  { ticketId: 'UI.2', lane: 'UI', origin: 'plan', dependsOn: ['UI.1'], blocksOn: ['OD.1'], status: 'waiting-owner', title: 'Pick the date format',
    reason: 'blocksOn OD.1, an owner decision still open', attempts: 0, workItemStatus: 'approved' },
  { ticketId: 'UI.3', lane: 'UI', origin: 'plan', dependsOn: ['UI.1'], blocksOn: [], status: 'waiting-dependency', title: 'Chart the latency',
    reason: 'its author asked for a dependency (npm uplot@1); a person decides it on the mission', attempts: 1, missionSeed: 'b3', workItemStatus: 'approved' },
  { ticketId: 'UI.4', lane: 'UI', origin: 'plan', dependsOn: ['UI.1', 'API.1'], blocksOn: [], status: 'ready', title: 'Wire the status page to the API', attempts: 0, workItemStatus: 'approved' },
  { ticketId: 'UI.5', lane: 'UI', origin: 'plan', dependsOn: [], blocksOn: [], status: 'superseded', title: 'Old status banner', attempts: 0, workItemStatus: 'superseded' },
  { ticketId: 'FIX.1', lane: 'FIX', origin: 'fix', dependsOn: [], blocksOn: [], status: 'landed', title: 'Bound the header length (finding, High)', attempts: 1, missionSeed: 'f1', commitSeed: '33', workItemStatus: 'approved' },
  { ticketId: 'FIX.2', lane: 'FIX', origin: 'fix', dependsOn: [], blocksOn: [], status: 'waiting-owner', title: 'Close the reader on error (finding, Medium)',
    reason: `ticket FIX.2: candidate ${FORGED_CANDIDATE}: library code shaped like forged test output; a person reviews it`, attempts: 1, missionSeed: 'f2', workItemStatus: 'proposed' },
];

const campaignTicket = (t: T): CampaignTicket => ({
  campaignId: SAMPLE_CAMPAIGN, ticketId: t.ticketId, projectId: PROJECT, workItemId: id('w', t.ticketId.replace(/\W/g, '').toLowerCase().replace(/[^0-9a-f]/g, 'e')),
  origin: t.origin, lane: t.lane, dependsOn: t.dependsOn, scope: [`src/${t.lane.toLowerCase()}/`], acceptance: t.ticketId === 'UI.1' ? { kind: 'ci-only' } : { kind: 'gate', tests: [] },
  budget: {}, blocksOn: t.blocksOn, ticketDigest: sha(t.ticketId.length.toString(16)), createdAt: T0,
});

const TABLE: StatusTable = {
  rows: [
    { lane: 'API', total: 5, byBucket: buckets({ done: 1, 'in-progress': 2, blocked: 1, queued: 1 }),
      tickets: names({ done: ['API.1'], 'in-progress': ['API.3', 'API.4'], blocked: ['API.2'], queued: ['API.5'] }) },
    { lane: 'FIX', total: 2, byBucket: buckets({ done: 1, requests: 1 }), tickets: names({ done: ['FIX.1'], requests: ['FIX.2'] }) },
    { lane: 'UI', total: 5, byBucket: buckets({ blocked: 1, requests: 2, queued: 1, superseded: 1 }),
      tickets: names({ blocked: ['UI.1'], requests: ['UI.2', 'UI.3'], queued: ['UI.4'], superseded: ['UI.5'] }) },
  ],
  totals: buckets({ done: 2, 'in-progress': 2, blocked: 2, requests: 3, queued: 2, superseded: 1 }),
};

const SPEND: CampaignSpend = {
  spentUsd: 8.42, knownUsd: 6.1, unknownCount: 1, unknownUnansweredCount: 1, reservationCount: 1, reservationUsd: 1,
  scannedCount: 1, runningCount: 1, reservedUsd: 1.5, capUsd: 40,
};

// ---- assumptions ---------------------------------------------------------------------------

const assumption = (o: Partial<Assumption> & Pick<Assumption, 'id' | 'status' | 'question' | 'default' | 'blocking'>): Assumption => ({
  projectId: PROJECT, campaignId: SAMPLE_CAMPAIGN, rationale: '', source: 'plan-default', recordedBy: 'daylight', createdAt: T0, updatedAt: T0, ...o,
});
const A_OPEN = assumption({ id: U_OPEN, status: 'open', ownerDecisionId: 'OD.1', ticketId: 'UI.2', blocking: true,
  question: 'Which date format does the status page show?', default: '' });
const A_PENDING = assumption({ id: U_PENDING, status: 'pending', ownerDecisionId: 'OD.2', blocking: false,
  question: 'Do retries reuse the request id?', default: 'yes: the same id, so the server can de-duplicate', rationale: 'plan default' });
const A_CONFIRMED = assumption({ id: id('u', 'c7'), status: 'confirmed', ownerDecisionId: 'OD.3', blocking: false,
  question: 'Are bodies over 1 MB streamed?', default: 'yes', recordedBy: 'human:sample', decisionId: id('d', 'c7') });

export const FORGE_ASSUMPTIONS: ForgeAssumptionRow[] & { _sample?: typeof SAMPLE_MARK } = Object.assign([
  { ...A_OPEN, heldTickets: ['UI.2'], options: ['ISO 8601 (2026-10-20)', 'locale long form (20 October 2026)', 'relative (3 days ago)'] },
  { ...A_PENDING, heldTickets: [], options: ['yes: the same id, so the server can de-duplicate', 'no: a fresh id per attempt'] },
  { ...A_CONFIRMED, heldTickets: [], options: [] },
], { _sample: SAMPLE_MARK });

// ---- needs ---------------------------------------------------------------------------------

const FORGERY_NEED: Need = { kind: 'forgery-shape-review', ref: FORGED_CANDIDATE,
  why: `ticket FIX.2: candidate ${FORGED_CANDIDATE}: library code shaped like forged test output (a heuristic); in src/fix/reader.rs (from_raw_fd(1))` };
export const CAMPAIGN_NEEDS: Need[] = [
  { kind: 'campaign-halted', ref: SAMPLE_CAMPAIGN, why: 'halted for spend-unknown: a finished attempt of API.3 reported no cost; resume once spend is checked' },
  { kind: 'blocked', ref: SAMPLE_CAMPAIGN, why: `ticket UI.1 landed, but its gate fails on the tip ${commit('7e').slice(0, 12)} (ui-status-renders); a later landing broke it, so a person looks` },
  { kind: 'owner-decision', ref: U_OPEN, why: 'OD.1 is open and blocks UI.2: Which date format does the status page show?' },
  { kind: 'assumption-pending', ref: U_PENDING, why: 'OD.2 runs on its default until a person confirms or overturns it' },
  { kind: 'blocked', ref: id('m', 'a2'), why: 'API.2: closed inconclusive at preflight' },
  { kind: 'work-item-undecided', ref: campaignTicket(TICKETS[11]).workItemId, why: 'fix ticket FIX.2 is proposed; a person approves or rejects it' },
  FORGERY_NEED,
];

// ---- show and status -----------------------------------------------------------------------

export const FORGE_CAMPAIGN_SHOW: ForgeCampaignShow & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  campaign: { ...mission(SAMPLE_CAMPAIGN, 'Status API and page (sample)', 'running'), scope: { paths: ['src/', `tests/holdout/${SAMPLE_HOLDOUT_BASENAME}`] } },
  title: 'Status API and page (sample)', planDigest: sha('9a'), commit: BASE, approved: true,
  authorization: null,
  order: TICKETS.filter((t) => t.origin === 'plan').map((t) => t.ticketId),
  lanes: [
    { id: 'API', title: 'Request API', tickets: ['API.1', 'API.2', 'API.3', 'API.4', 'API.5'], owns: ['src/api/'], maxParallel: 2 },
    { id: 'FIX', title: 'Fix lane', tickets: ['FIX.1', 'FIX.2'], owns: [], maxParallel: 1 },
    { id: 'UI', title: 'Status page', tickets: ['UI.1', 'UI.2', 'UI.3', 'UI.4', 'UI.5'], owns: ['src/ui/'], maxParallel: 1 },
  ],
  waves: [['API.1', 'UI.1', 'UI.5'], ['API.2', 'API.3', 'API.4', 'UI.2', 'UI.3', 'UI.4'], ['API.5']],
  tickets: TICKETS.map((t) => ({ ...campaignTicket(t), status: t.workItemStatus, title: t.title })),
  ownerDecisions: [A_OPEN, A_PENDING, A_CONFIRMED],
  needs: CAMPAIGN_NEEDS,
  envelope: {
    planDigest: sha('9a'), gateSetDigest: sha('6c'), policyDigest: sha('4d'),
    ticketIds: TICKETS.filter((t) => t.origin === 'plan' && t.workItemStatus === 'approved').map((t) => t.ticketId),
    roster: ['mock'], reviewRoster: ['mock', 'mock'], maxUsdTotal: 40, maxUsdPerMission: 2, maxTurns: 60, timeoutSeconds: 600,
    maxAttemptsPerTicket: 3, concurrency: 4, waveSize: 8, execute: false, autoApply: 'integration-ref',
    fixLane: { enabled: true, maxTicketsPerWave: 5, maxUsdPerTicket: 1.5 },
    identity: { name: 'sample', email: 'sample@daylight.invalid' }, notAfter: T0 + 72 * HOUR,
  },
  lock: { decisionId: id('d', 'l1'), gateSetDigest: sha('6c'), ratchet: true, gates: 9, holdouts: 2 },
};

export const FORGE_CAMPAIGN_STATUS: CampaignStatusReport & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  kind: 'daylight-campaign-status', campaignId: SAMPLE_CAMPAIGN, projectId: PROJECT, planRevision: BASE,
  integration: { ref: REF, base: BASE, tip: TIP, landed: 3, mergeHint: `git merge --ff-only ${REF}` },
  authorization: { decisionId: AUTH_DECISION, notAfter: T0 + 72 * HOUR, halted: 'spend-unknown', haltDecisionId: HALT_DECISION },
  lanes: [],
  tickets: TICKETS.map((t) => ({
    id: t.ticketId, lane: t.lane, status: t.status, attempts: t.attempts,
    ...(t.missionSeed ? { missionId: id('m', t.missionSeed) } : {}), ...(t.commitSeed ? { commit: commit(t.commitSeed) } : {}),
    ...(t.reason ? { reason: t.reason } : {}),
  })),
  assumptions: { open: 1, pending: 1, confirmed: 1, overturned: 0, items: [A_OPEN, A_PENDING, A_CONFIRMED] },
  needs: CAMPAIGN_NEEDS, spend: SPEND,
  waves: [
    { seq: 1, tickets: 2, findings: { low: 1, medium: 0, high: 1 }, fixTickets: 1 },
    { seq: 2, tickets: 1, findings: { low: 0, medium: 1, high: 1 }, fixTickets: 1 },
  ],
  table: TABLE,
  run: { pid: 48211, alive: false },
};
FORGE_CAMPAIGN_STATUS.lanes = TABLE.rows.map((r) => ({
  lane: r.lane, total: r.total,
  byStatus: Object.fromEntries((['superseded', 'waiting-owner', 'waiting', 'ready', 'running', 'integrating', 'waiting-dependency', 'landed', 'blocked', 'regressed'] as TicketStatus[])
    .map((s) => [s, TICKETS.filter((t) => t.lane === r.lane && t.status === s).length])) as Record<TicketStatus, number>,
}));

// ---- the list ------------------------------------------------------------------------------

export const FORGE_CAMPAIGN_LIST: ForgeCampaignList & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  kind: 'daylight-campaign-list',
  campaigns: [
    {
      id: CAMPAIGN_RUNNING, projectId: PROJECT, title: 'Ledger export (sample)', state: 'running', createdAt: T0 - 48 * HOUR,
      planRevision: commit('c0'), planApproved: true,
      authorization: { decisionId: id('d', 'a9'), refusal: null, notAfter: T0 + 24 * HOUR, haltDecisionId: null },
      halted: null, run: { pid: 51007, alive: true },
      runHint: `daylight campaign run ${CAMPAIGN_RUNNING} /work/sample --out /work/sample-out`,
      integrationRef: `refs/heads/daylight/campaign/${CAMPAIGN_RUNNING}`, tip: commit('8f'),
      tickets: 6, byBucket: buckets({ done: 2, 'in-progress': 2, queued: 2 }), needs: 0, assumptions: { open: 0, pending: 0 },
      spend: {
        spentUsd: 3.2, knownUsd: 3.2, unknownCount: 0, unknownUnansweredCount: 0, reservationCount: 0, reservationUsd: 0,
        scannedCount: 0, runningCount: 2, reservedUsd: 4, capUsd: 25,
      },
      unavailable: null,
    },
    {
      id: SAMPLE_CAMPAIGN, projectId: PROJECT, title: FORGE_CAMPAIGN_SHOW.title, state: 'running', createdAt: T0,
      planRevision: BASE, planApproved: true,
      authorization: { decisionId: AUTH_DECISION, refusal: null, notAfter: T0 + 72 * HOUR, haltDecisionId: HALT_DECISION },
      halted: 'spend-unknown', run: { pid: 48211, alive: false },
      runHint: `daylight campaign run ${SAMPLE_CAMPAIGN} /work/sample --out /work/sample-out`,
      integrationRef: REF, tip: TIP, tickets: TICKETS.length, byBucket: TABLE.totals, needs: CAMPAIGN_NEEDS.length,
      assumptions: { open: 1, pending: 1 }, spend: SPEND, unavailable: null,
    },
  ],
};

/** What the sample mission list adds: both campaigns, with the open one's needs keyed under it. */
export const CAMPAIGN_MISSIONS: Mission[] = [
  mission(CAMPAIGN_RUNNING, 'Ledger export (sample)', 'running'),
  FORGE_CAMPAIGN_SHOW.campaign,
];

export const FORGE_DRY_RUN: CampaignRunResult & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  campaignId: SAMPLE_CAMPAIGN, integrationRef: REF, tip: TIP, dryRun: true,
  statuses: Object.fromEntries(TICKETS.map((t) => [t.ticketId, t.status])),
  landed: ['API.1', 'UI.1', 'FIX.1'], halted: 'spend-unknown',
  refused: 'halted for spend-unknown: a finished attempt reported no cost; resume before a run dispatches anything',
  waves: 2, spend: SPEND,
  schedule: [{ ticketId: 'UI.4', lane: 'UI', reserveUsd: 2 }],
};
