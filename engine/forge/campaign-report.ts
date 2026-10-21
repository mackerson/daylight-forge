import fs from 'node:fs';
import { processAlive } from '../experiment/runner.ts';
import type { DaylightContext } from '../mission/context.ts';
import { runClaimFile } from '../mission/orchestrate.ts';
import { STATUS_BUCKET_OF, STATUS_BUCKETS } from '../mission/types.ts';
import type {
  DiffStat, ForgeCampaignList, RunClaim, SpendLine, StatusBucket, StatusTable, StatusTableRow, TicketStatus, WaveReport,
} from '../mission/types.ts';

/**
 * The wave report, the campaign list and the STATUS table (WS-R8, docs/daylight/REFINE.md).
 * Everything here is derived on read from rows and refs and never stored; holdouts are counts.
 */

export const REPORT_VERSION = 1 as const;

export type ReportScope = WaveReport['scope'];

const zeroBuckets = (): Record<StatusBucket, number> => Object.fromEntries(STATUS_BUCKETS.map((b) => [b, 0])) as Record<StatusBucket, number>;

/** kitkraft's STATUS table over ticket states: one row per lane, sorted by lane id. */
export function statusTable(states: Iterable<{ ticket: { ticketId: string; lane: string }; status: TicketStatus | 'regressed' }>): StatusTable {
  const rows = new Map<string, StatusTableRow>();
  const totals = zeroBuckets();
  for (const s of states) {
    const bucket = STATUS_BUCKET_OF[s.status];
    const row = rows.get(s.ticket.lane) ?? {
      lane: s.ticket.lane, total: 0, byBucket: zeroBuckets(),
      tickets: Object.fromEntries(STATUS_BUCKETS.map((b) => [b, [] as string[]])) as Record<StatusBucket, string[]>,
    };
    row.total++;
    row.byBucket[bucket]++;
    row.tickets[bucket].push(s.ticket.ticketId);
    totals[bucket]++;
    rows.set(s.ticket.lane, row);
  }
  return { rows: [...rows.values()].sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)), totals };
}

/**
 * The campaign's run claim, read and never written or signalled beyond `kill(pid, 0)`. A reused
 * pid reads as a claim; the UI words it as one.
 */
export function runClaimOf(out: string, campaignId: string): RunClaim | null {
  let text: string;
  try {
    text = fs.readFileSync(runClaimFile(out, campaignId), 'utf8').trim();
  } catch {
    return null;
  }
  const pid = /^\d{1,10}$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { pid: 0, alive: false };
  return { pid, alive: processAlive(pid) };
}

export function buildWaveReport(_ctx: DaylightContext, _campaignId: string, _repo: string, _o: { scope?: ReportScope } = {}): WaveReport {
  throw new Error('not implemented');
}

export function renderWaveReport(_r: WaveReport): string {
  throw new Error('not implemented');
}

export function spendWords(_l: SpendLine): string {
  throw new Error('not implemented');
}

export function spendLineOf(_ctx: Pick<DaylightContext, 'store'>, _key: string, _missionIds: readonly string[]): SpendLine {
  throw new Error('not implemented');
}

export function diffStat(_repo: string, _from: string, _to: string): DiffStat {
  throw new Error('not implemented');
}

export function campaignList(_ctx: DaylightContext): ForgeCampaignList {
  throw new Error('not implemented');
}

export function reportFileName(_scope: ReportScope, _tip: string): string {
  throw new Error('not implemented');
}
