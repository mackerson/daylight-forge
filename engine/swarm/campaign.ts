import fs from 'node:fs';
import path from 'node:path';
import type { Graph } from '../graph/types.ts';
import { ClaimStore } from '../store/claims.ts';
import { drive, type DriveOptions, type DriveReport } from './driver.ts';
import { converged, frontier } from './frontier.ts';
import { record, runRecordFrom } from './ledger.ts';
import { progress, seriesOf } from './progress.ts';
import type { CampaignEntry, CampaignLimits, CampaignSample, StopReason } from './progress.ts';

export type { CampaignEntry } from './progress.ts';

/**
 * A campaign: rounds of agents until the map stops being worth another one.
 *
 * `drive` answers one batch and returns. Everything above it — deciding whether to pay for
 * another round — was left to a person watching a toast, which is the wrong place for it:
 * the frontier already knows when it has converged, and a run that has settled nothing twice
 * running is not going to settle anything on the third try either.
 *
 * Four stops, all known before the first round: the frontier converges, the budget runs out,
 * the round cap is hit, or nothing moves. Each is checked after every round and named in the
 * result, so "why did it stop" is never a question anyone has to reconstruct from a log.
 *
 * Each round is a full run in its own right — leased, recorded to the ledger, and visible in
 * the Runs screen — because a campaign that hid its rounds would make the one question worth
 * asking about a swarm, *was that worth paying for*, unanswerable per round.
 */

const FILE = 'campaigns.jsonl';

export const DEFAULT_LIMITS: CampaignLimits = {
  rounds: 12,
  maxCost: 0,
  stallRounds: 2,
  floor: 0.05,
};

export interface CampaignOptions extends Omit<DriveOptions, 'session' | 'mode' | 'maxCost'> {
  limits: CampaignLimits;
  /** Ties every round's events, leases and ledger entries back to one campaign. */
  id?: string;
  /**
   * Run after each round, before the next one is decided.
   *
   * The campaign does not re-derive the focus stack itself: emitting artifacts belongs to the
   * caller that owns the output directory, and reaching up into it from here would put the
   * CLI's job inside the scheduler.
   */
  afterRound?: (sample: CampaignSample, report: DriveReport) => void;
}

export interface CampaignReport {
  id: string;
  /** One per round, plus a round 0 taken before anything ran. */
  samples: CampaignSample[];
  rounds: DriveReport[];
  stopped: StopReason;
  spent: number;
  costKnown: boolean;
  notes: string[];
}

interface Snapshot {
  open: number;
  tail: number;
  topScore: number;
  converged: boolean;
  subjects: Set<string>;
}

/**
 * The frontier as it stands, split at the floor.
 *
 * Above the floor is what a campaign is racing to empty. Below it is the tail every frontier
 * has — real uncertainty nobody should pay to resolve — and counting it as open work makes a
 * campaign look stalled while it is working.
 */
function snapshot(graph: Graph, dir: string, floor: number): Snapshot {
  const read = (name: string): Record<string, unknown> => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const store = new ClaimStore(path.join(dir, 'claims.db'));
  const items = frontier(graph, store, read('findings.json'), read('structure.json'));
  store.close();

  const above = items.filter((i) => i.score >= floor);
  return {
    open: above.length,
    tail: items.length - above.length,
    topScore: items[0]?.score ?? 0,
    converged: converged(items, floor),
    subjects: new Set(above.map((i) => i.subject)),
  };
}

export function recordSample(
  dir: string,
  id: string,
  sample: CampaignSample,
  limits: CampaignLimits,
): void {
  fs.mkdirSync(dir, { recursive: true });
  const entry: CampaignEntry = { ...sample, campaign: id, limits };
  fs.appendFileSync(path.join(dir, FILE), `${JSON.stringify(entry)}\n`);
}

/**
 * The samples of one campaign, oldest first.
 *
 * Without an id, the most recent campaign in the file — which is what a window reopening
 * mid-run wants, and what makes the burndown survive a restart rather than starting blank
 * halfway through something that is still going.
 */
export function series(dir: string, id?: string): CampaignEntry[] {
  const file = path.join(dir, FILE);
  if (!fs.existsSync(file)) return [];
  const all: CampaignEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line) as CampaignEntry);
    } catch {
      // A corrupt line loses one sample, not the series.
    }
  }
  return seriesOf(all, id);
}

export async function campaign(options: CampaignOptions): Promise<CampaignReport> {
  const { dir, limits } = options;
  const id = options.id ?? `daylight-campaign-${Date.now()}`;
  const notes: string[] = [];

  // Read once and reuse: every snapshot needs it, and on a large repo this is the exhaustive
  // record. `drive` re-reads it per round on its own, which is a separate cost and a
  // separate problem.
  const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8')) as Graph;

  const started = snapshot(graph, dir, limits.floor);
  const startSubjects = started.subjects;

  const sampleFrom = (
    round: number,
    now: Snapshot,
    spent: number,
    costKnown: boolean,
    delta: number,
    stalled: number,
  ): CampaignSample => ({
    round,
    at: new Date().toISOString(),
    open: now.open,
    tail: now.tail,
    // Counted against where the campaign started rather than against the previous round: what
    // a reader wants to know is whether the work is being created faster than it is answered.
    discovered: [...now.subjects].filter((s) => !startSubjects.has(s)).length,
    settled: [...startSubjects].filter((s) => !now.subjects.has(s)).length,
    topScore: now.topScore,
    converged: now.converged,
    spent,
    costKnown,
    delta,
    stalled,
  });

  const samples: CampaignSample[] = [sampleFrom(0, started, 0, true, 0, 0)];
  recordSample(dir, id, samples[0], limits);

  const rounds: DriveReport[] = [];
  let spent = 0;
  let costKnown = true;
  let stalled = 0;

  // Already converged before the first round is a legitimate outcome, not an edge case: it
  // is what a second campaign on an unchanged repo should do, and paying for a round to
  // discover it would be the tool failing its own argument.
  let stop = progress(samples, limits).fired;

  while (!stop) {
    const round = samples.length;
    const report = await drive({
      ...options,
      session: `${id}-r${round}`,
      mode: 'explore',
      maxCost: limits.maxCost > 0 ? Math.max(0, limits.maxCost - spent) : undefined,
    });
    rounds.push(report);

    const entry = runRecordFrom(report, {
      session: `${id}-r${round}`,
      mode: 'explore',
      spread: !!options.spread,
    });
    record(dir, entry);

    spent += entry.cost;
    if (!entry.costKnown) costKnown = false;
    const delta = report.claimsAfter - report.claimsBefore;
    stalled = delta > 0 ? 0 : stalled + 1;

    /**
     * A roster with nothing runnable in it produces free, empty rounds forever.
     *
     * Waiting for the stall counter to notice would burn the cap doing nothing and report
     * "nothing moved" — true, and the least useful true thing available. The reason is that
     * no agent could be launched, so say that.
     */
    if (report.results.length === 0 && report.unavailable.length > 0) {
      notes.push(`no runnable agent: ${report.unavailable.join(', ')}`);
      stalled = limits.stallRounds;
    }
    for (const stopped of report.budgetStops) notes.push(stopped);

    const sample = sampleFrom(round, snapshot(graph, dir, limits.floor), spent, costKnown, delta, stalled);
    samples.push(sample);
    recordSample(dir, id, sample, limits);
    options.afterRound?.(sample, report);

    stop = progress(samples, limits).fired;
  }

  return { id, samples, rounds, stopped: stop, spent, costKnown, notes };
}
