import type { SpendLine, WaveReport } from '../types.ts';
import { SAMPLE_MARK } from './forge-implement.sample.ts';
import {
  BASE, CAMPAIGN_NEEDS, FORGE_CAMPAIGN_STATUS, FORGED_CANDIDATE, SAMPLE_CAMPAIGN, TIP, U_OPEN, U_PENDING,
} from './forge-campaign.sample.ts';

/**
 * SAMPLE DATA — wave 2 of the sample campaign, in the shape `campaign report --format json`
 * prints (`WaveReport`, refine-interfaces v2 §1.3, §8). Hand-written and SYNTHETIC.
 *
 * Three landings (one with a binary file, one whose acceptance is vacuous), a corroborated High
 * finding whose fix landed, a High still unfixed and a Medium proposed; holdouts as counts only;
 * three blocked tickets (budget exhausted, preflight-closed for retry, waiting on a dependency);
 * and one ticket that landed after a candidate tripped the `stdout-fd-write` forgery shape.
 */

const hex = (seed: string) => seed.repeat(32).slice(0, 32);
const id = (p: string, seed: string) => `${p}_${hex(seed)}`;
const commit = (seed: string) => seed.repeat(40).slice(0, 40);
const WAVE1_END = commit('91');

const line = (key: string, o: Partial<SpendLine> = {}): SpendLine => ({
  key, attempts: 1, spentUsd: 0.5, knownUsd: 0.5, scannedUsd: 0, scannedCount: 0, unknownCount: 0, runningCount: 0, reservationCount: 0, ...o,
});

export const FORGE_WAVE_REPORT: WaveReport & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  kind: 'daylight-wave-report', version: 1,
  campaignId: SAMPLE_CAMPAIGN, projectId: FORGE_CAMPAIGN_STATUS.projectId, title: 'Status API and page (sample)', planRevision: BASE,
  scope: { kind: 'wave', seq: 2 },
  range: { from: WAVE1_END, to: TIP },
  integration: FORGE_CAMPAIGN_STATUS.integration,
  authorization: FORGE_CAMPAIGN_STATUS.authorization,
  run: { pid: 48211, alive: false },
  landed: [
    {
      ticketId: 'API.1', lane: 'API', origin: 'plan', title: 'Parse the request envelope', missionId: id('m', 'a1'), integrationId: id('i', '1a'),
      candidateId: id('c', '1a'), decisionId: id('d', '1a'), onto: WAVE1_END, commit: commit('11'), method: 'apply', attempts: 1,
      acceptance: 'gate', acceptanceVacuous: false, diff: { files: 3, insertions: 142, deletions: 9, binary: 0 },
    },
    {
      ticketId: 'UI.1', lane: 'UI', origin: 'plan', title: 'Status page skeleton', missionId: id('m', 'b1'), integrationId: id('i', '1b'),
      candidateId: id('c', '1b'), decisionId: id('d', '1b'), onto: commit('11'), commit: commit('22'), method: 'three-way', attempts: 1,
      acceptance: 'ci-only', acceptanceVacuous: true, diff: { files: 4, insertions: 88, deletions: 0, binary: 1 },
    },
    {
      ticketId: 'FIX.1', lane: 'FIX', origin: 'fix', title: 'Bound the header length (finding, High)', missionId: id('m', 'f1'), integrationId: id('i', '1f'),
      candidateId: id('c', '1f'), decisionId: id('d', '1f'), onto: commit('22'), commit: commit('33'), method: 'apply', attempts: 2,
      acceptance: 'gate', acceptanceVacuous: false, diff: { files: 1, insertions: 12, deletions: 3, binary: 0 },
    },
  ],
  diff: { files: 8, insertions: 242, deletions: 12, binary: 1 },
  assumptions: {
    open: [{ id: U_OPEN, status: 'open', ownerDecisionId: 'OD.1', ticketId: 'UI.2', question: 'Which date format does the status page show?', default: '',
      blocking: true, source: 'plan-default', heldTickets: ['UI.2'], landedOnIt: [] }],
    pending: [{ id: U_PENDING, status: 'pending', ownerDecisionId: 'OD.2', question: 'Do retries reuse the request id?',
      default: 'yes: the same id, so the server can de-duplicate', blocking: false, source: 'plan-default', heldTickets: [], landedOnIt: ['API.1'] }],
    confirmed: 1, overturned: 0,
  },
  review: [{ seq: 2, reviewMissionId: id('m', 'r2'), state: 'done', reviewers: 2, findings: { low: 0, medium: 1, high: 2 } }],
  findings: [
    { id: id('g', '01'), waveSeq: 2, severity: 'high', path: 'src/api/header.ts', title: 'Header length is unbounded',
      statement: 'A header line longer than the buffer is read without a limit.\n<b>not markup</b> `code` stays text.', corroboratedBy: ['mock:reviewer-2'],
      fixTicketId: 'FIX.1', fixStatus: 'landed', fixAdmission: 'derived' },
    { id: id('g', '02'), waveSeq: 2, severity: 'high', path: 'src/ui/status.tsx', title: 'Error text is drawn unescaped',
      statement: 'The page interpolates an error message into the DOM.', corroboratedBy: [], fixTicketId: null, fixStatus: 'none', fixAdmission: 'none' },
    { id: id('g', '03'), waveSeq: 2, severity: 'medium', path: 'src/fix/reader.rs', title: 'Reader not closed on error',
      statement: 'An early return skips the close.', corroboratedBy: [], fixTicketId: 'FIX.2', fixStatus: 'waiting-owner', fixAdmission: 'none' },
  ],
  fixLane: { filed: 2, admittedDerived: 1, approvedByPerson: 0, landed: 1, waiting: 1, rejected: 0 },
  spend: {
    campaign: FORGE_CAMPAIGN_STATUS.spend,
    scope: line('scope', { attempts: 5, spentUsd: 2.9, knownUsd: 2.4, scannedUsd: 0.5, scannedCount: 1 }),
    tickets: [
      line('API.1'), line('API.2', { spentUsd: 0, knownUsd: 0 }), line('API.3', { attempts: 2, spentUsd: 0.4, knownUsd: 0.4, unknownCount: 1, runningCount: 1 }),
      line('API.4'), line('UI.1', { spentUsd: 1.0, knownUsd: 0.5, scannedUsd: 0.5, scannedCount: 1 }), line('UI.3'),
      line('FIX.1', { attempts: 2, spentUsd: 1.4, knownUsd: 0.9, reservationCount: 1 }), line('FIX.2'),
    ],
    lanes: [
      line('API', { attempts: 5, spentUsd: 1.9, knownUsd: 1.9, unknownCount: 1, runningCount: 1 }),
      line('FIX', { attempts: 3, spentUsd: 1.9, knownUsd: 1.4, reservationCount: 1 }),
      line('UI', { attempts: 2, spentUsd: 1.5, knownUsd: 1.0, scannedUsd: 0.5, scannedCount: 1 }),
    ],
    waves: [line('wave:1', { attempts: 1, spentUsd: 0.5, knownUsd: 0.5 }), line('wave:2', { attempts: 4, spentUsd: 2.4, knownUsd: 1.9, scannedUsd: 0.5, scannedCount: 1, reservationCount: 1 })],
    reviews: [line('review:1', { spentUsd: 0.6, knownUsd: 0.6 }), line('review:2', { spentUsd: 1.52, knownUsd: 1.3 })],
  },
  needs: CAMPAIGN_NEEDS,
  blocked: [
    { ticketId: 'API.2', lane: 'API', status: 'blocked', reason: 'mission closed inconclusive at preflight: the author sandbox was unavailable', missionId: id('m', 'a2'), need: 'blocked', act: 'retry' },
    { ticketId: 'API.5', lane: 'API', status: 'blocked', reason: 'budget exhausted: spent $2.00 of $2.00 for this ticket mission', missionId: id('m', 'a5'), need: 'blocked', act: 'read' },
    { ticketId: 'UI.3', lane: 'UI', status: 'waiting-dependency', reason: 'its author asked for a dependency (npm uplot@1)', missionId: id('m', 'b3'), need: 'request-dependency', act: 'resolve-dependency' },
  ],
  holdouts: { locked: 2, atTip: { pending: 0, supported: 2, falsified: 0, inconclusive: 0, invalid: 0, 'not-run': 0 } },
  forgeryShapes: {
    candidates: 1,
    byClass: { 'stdout-fd-write': 1, 'test-summary-literal': 0, 'process-exit': 0, unclassified: 0 },
    items: [{ ticketId: 'FIX.1', missionId: id('m', 'f1'), candidateId: FORGED_CANDIDATE, attemptId: id('a', 'f1'),
      paths: ['src/fix/reader.rs'], classes: ['stdout-fd-write'], ticketLanded: true }],
    heuristic: true,
  },
  status: FORGE_CAMPAIGN_STATUS.table,
};
