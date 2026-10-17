import type { IngestSourcesPayload, LedgerJson, LedgerJsonRow, LedgerRow } from '../types.ts';
import { IMPL_M, SAMPLE_MARK } from './forge-implement.sample.ts';

/**
 * SAMPLE DATA — `report --project --format json` and `ingest list --format json` in the shapes
 * WS5 and WS6 are specified to print. SYNTHETIC; loaded only under `DAYLIGHT_MISSION_SAMPLE=1`.
 *
 * The rows are chosen to exercise the money rules: one fully known, one with some unknown and
 * some scanned spend, one where nothing is known, ingested work, and a human with decisions and
 * no dollars at all.
 */
const PROJECT = 'git:b57b1c8c436a';
const T0 = 1791100000000;
const sha = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const WORK_M = `m_${'6e'.repeat(16)}`;

/**
 * A row as `report --format json` prints it (`ledgerJson`): figures nobody reported are null.
 * `providerCost` and `ingested` are the engine's per-row facts the plain `LedgerRow` lacks.
 */
const row = (key: string, over: Partial<LedgerRow>, facts: { providerCost?: number; ingested?: number } = {}): LedgerJsonRow => {
  const r: LedgerRow = {
    key, attempts: 0, usdKnown: 0, usdUnknownCount: 0, usdScanned: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownCount: 0 },
    candidates: { accepted: 0, rejected: 0, applied: 0, overridden: 0 }, decisions: 0, gateSetDigests: [],
    ...over,
  };
  const missing = r.tokens.unknownCount;
  const field = (n: number) => (r.attempts === 0 || missing >= r.attempts ? null : n);
  const providerCost = facts.providerCost ?? 0;
  return {
    ...r,
    usdKnown: providerCost === 0 ? null : r.usdKnown,
    tokens: { input: field(r.tokens.input), output: field(r.tokens.output), cacheRead: field(r.tokens.cacheRead), cacheWrite: field(r.tokens.cacheWrite), unknownCount: missing },
    tokensUnknownByField: { input: missing, output: missing, cacheRead: missing, cacheWrite: missing },
    tokensKnown: r.attempts > 0 && missing === 0,
    costKnown: r.attempts > 0 && providerCost === r.attempts,
    ...(facts.ingested ? { outside: "outside Daylight's controls" } : {}),
  };
};

const BY_ACTOR: LedgerJsonRow[] = [
  row('agent:mock:author', {
    attempts: 3, usdKnown: 0.05, usdUnknownCount: 1, usdScanned: 0.31,
    tokens: { input: 12_400, output: 1_830, cacheRead: 0, cacheWrite: 0, unknownCount: 2 },
    candidates: { accepted: 1, rejected: 2, applied: 0, overridden: 0 }, gateSetDigests: [sha('9a')],
  }, { providerCost: 1 }),
  row('agent:claude:sonnet', {
    attempts: 2, usdKnown: 0.82,
    tokens: { input: 40_210, output: 3_120, cacheRead: 18_000, cacheWrite: 2_400, unknownCount: 0 },
  }, { providerCost: 2 }),
  row('agent:mock:review', { attempts: 1, usdUnknownCount: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownCount: 1 } }),
  row('ingest:claude-code', {
    attempts: 4, usdUnknownCount: 4,
    tokens: { input: 88_000, output: 9_400, cacheRead: 120_000, cacheWrite: 6_000, unknownCount: 0 },
  }, { ingested: 4 }),
  row('human:miz', { decisions: 4 }),
];

export const FORGE_LEDGER: LedgerJson & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  kind: 'daylight-ledger',
  schemaVersion: 2,
  projectId: PROJECT,
  rows: BY_ACTOR,
  decisions: [
    { actor: 'human:miz', kind: 'approve', operation: 'authorize-mission', count: 1 },
    { actor: 'human:miz', kind: 'approve', operation: 'lock-gates', count: 1 },
    { actor: 'human:miz', kind: 'approve', operation: 'approve-work-item', count: 1 },
    { actor: 'human:miz', kind: 'reject', operation: 'reject-work-item', count: 1 },
  ],
  workItems: [
    { id: `w_${'c7'.repeat(16)}`, missionId: IMPL_M, title: 'Expired sessions are not served', status: 'approved' },
  ],
  applications: [],
  revisions: [{ revision: 'b57b1c8c436af52c5bdae26744dbcc4e5ddc6913', missions: 3, attempts: 10 }],
};

/** By model, for the group chips. The ingested rows have a model; their cost is still unknown. */
export const FORGE_LEDGER_BY_MODEL: LedgerJsonRow[] = [
  row('mock-author-1', { attempts: 3, usdKnown: 0.05, usdUnknownCount: 1, usdScanned: 0.31, tokens: { input: 12_400, output: 1_830, cacheRead: 0, cacheWrite: 0, unknownCount: 2 } }, { providerCost: 1 }),
  row('claude-sonnet-4-5', { attempts: 6, usdKnown: 0.82, usdUnknownCount: 4, tokens: { input: 128_210, output: 12_520, cacheRead: 138_000, cacheWrite: 8_400, unknownCount: 0 } }, { providerCost: 2, ingested: 4 }),
  row('unknown', { attempts: 1, usdUnknownCount: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownCount: 1 } }),
];

export const FORGE_INGEST: IngestSourcesPayload & { _sample: typeof SAMPLE_MARK } = {
  _sample: SAMPLE_MARK,
  sources: [
    { sessionId: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9', agentId: '', projectId: PROJECT, pathDigest: sha('p1'), prefixDigest: sha('q1'), bytesSeen: 1_482_113, linesSeen: 2_311, missionId: WORK_M, attemptId: `a_${'61'.repeat(16)}`, ingestedAt: T0 + 200_000 },
    { sessionId: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9', agentId: 'agent-7f3a', projectId: PROJECT, pathDigest: sha('p2'), prefixDigest: sha('q2'), bytesSeen: 311_920, linesSeen: 402, missionId: WORK_M, attemptId: `a_${'62'.repeat(16)}`, ingestedAt: T0 + 200_100 },
    { sessionId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', agentId: '', projectId: PROJECT, pathDigest: sha('p3'), prefixDigest: sha('q3'), bytesSeen: 88_004, linesSeen: 97, missionId: WORK_M, attemptId: `a_${'63'.repeat(16)}`, ingestedAt: T0 + 300_000 },
  ],
  skipped: { 'other-project': 3, 'unknown-record-type': 12, 'malformed-line': 1 },
};
