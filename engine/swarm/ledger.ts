import fs from 'node:fs';
import path from 'node:path';
import type { DriveReport } from './driver.ts';
import type { RunRecord } from './types.ts';

export type { RunRecord } from './types.ts';

/**
 * What each run cost and what it bought, kept across sessions.
 *
 * A finished run used to report itself in a toast — `+3 claims` — which vanished on the next
 * one and was gone entirely when the app restarted. That makes the most important question
 * about a swarm unanswerable after the fact: *was that worth paying for*. You cannot tell
 * whether adding a third source earned its money if the only record of the run before it was
 * a notification.
 *
 * Append-only, one JSON object per line, beside the events it produced. Deliberately not in
 * the claim store: this is bookkeeping about runs, not a claim about the codebase, and the
 * store is committed knowledge about a repo rather than a log of what was spent looking.
 */

const FILE = 'runs.jsonl';

/**
 * The ledger entry a drive report earns.
 *
 * Assembled here rather than at the call site, because `agent` writes one of these and so
 * does every round of a campaign — and two hand-built copies of one record is how a run
 * watched live comes to disagree with the same run read back afterwards.
 */
export function runRecordFrom(
  report: DriveReport,
  meta: { session: string; mode: string; spread: boolean; at?: string },
): RunRecord {
  const a = report.statsAfter;
  const b = report.statsBefore;
  // An adapter that finishes reporting no price makes the total a floor rather than a figure.
  const noCost = report.results.some((r) => r.ok && r.cost === 0);
  return {
    at: meta.at ?? new Date().toISOString(),
    session: meta.session,
    mode: meta.mode,
    sources: report.plans.map((p) => `${p.spec.tool}:${p.spec.model ?? 'default'}`),
    diversity: report.sourceDiversity,
    spread: meta.spread,
    assigned: report.assigned.length,
    results: report.results.map((r) => ({
      source: `${r.tool}:${r.model ?? 'default'}`,
      ok: r.ok,
      seconds: Math.round(r.durationMs / 1000),
      cost: r.cost,
      turns: r.turns,
      failure: r.ok
        ? undefined
        : r.timedOut ? 'timed out' : r.overBudget ? 'over budget' : `exit ${r.exitCode}`,
    })),
    costKnown: !noCost,
    cost: report.results.reduce((sum, r) => sum + r.cost, 0),
    delta: {
      claims: a.claims - b.claims,
      clusters: a.clusters - b.clusters,
      elisions: a.elisions - b.elisions,
      defences: a.defences - b.defences,
    },
    converged: report.converged,
    notes: [
      ...(report.diversityWarning ? [report.diversityWarning] : []),
      ...report.budgetStops,
      ...report.unavailable.map((u) => `skipped: ${u}`),
    ],
  };
}

export function record(dir: string, run: RunRecord): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, FILE), `${JSON.stringify(run)}\n`);
}

/** The most recent runs, newest first. Tolerant of a truncated or hand-edited line. */
export function history(dir: string, limit = 25): RunRecord[] {
  const file = path.join(dir, FILE);
  if (!fs.existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RunRecord);
    } catch {
      // A corrupt line loses one run, not the ledger.
    }
  }
  return out.reverse().slice(0, limit);
}
