import fs from 'node:fs';
import path from 'node:path';
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
