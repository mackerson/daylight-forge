/**
 * Threshold calibration — the scoring, without the I/O.
 *
 * Split from the CLI so the parts with judgement in them can be tested. The runner reads a
 * spec and prints a table; everything that decides what "better" means lives here.
 *
 * Every similarity threshold in D1–D4 started as a guess, and a guess that is never measured
 * is indistinguishable from a tuned value right up until it hides something. This measures
 * them against a fixture whose history contains a *known* deduplication: a point before the
 * work, where the detectors must find the pair, and a point after it, where that pair no
 * longer exists and the map should have gone quieter.
 *
 * Recall alone would be satisfied by returning everything, so each setting is scored on both:
 * did it find what we know is there, and how much did it report in total. The cheapest
 * setting that still finds every known pair wins, because precision matters more than recall
 * here — a noisy map is ignored, and an ignored map is worth nothing.
 *
 * Usage:
 *   node engine/tools/calibrate.ts <spec.json>
 *
 * The spec names directories, so the fixture is never checked out or mutated — extract the
 * commits you want with `git archive` first. See `calibration.example.json`.
 */
import { detectDuplication, type DuplicationOptions } from '../detect/duplication.ts';
import type { Graph } from '../graph/types.ts';

export interface Point {
  name: string;
  repo: string;
  /** Pairs that must appear, as `substringA~substringB`. */
  mustFind?: string[];
  /** Pairs that must not — usually because the refactor removed one side. */
  mustNotFind?: string[];
}

export interface Spec {
  points: Point[];
  sweep?: Partial<Record<keyof DuplicationOptions, number[]>>;
}

export const DEFAULT_SWEEP: Partial<Record<keyof DuplicationOptions, number[]>> = {
  minNameScore: [0.4, 0.5, 0.6, 0.7, 0.8],
  minTypedScore: [0.0, 0.1, 0.2, 0.3],
  minBodyScore: [0.7, 0.8, 0.85, 0.9, 1.0],
};

/** Every combination of the swept axes, in a stable order. */
export function grid(sweep: Partial<Record<string, number[]>>): DuplicationOptions[] {
  const keys = Object.keys(sweep).sort();
  let out: DuplicationOptions[] = [{}];
  for (const k of keys) {
    const next: DuplicationOptions[] = [];
    for (const base of out) for (const v of sweep[k]!) next.push({ ...base, [k]: v });
    out = next;
  }
  return out;
}

/**
 * Families, not raw detector links.
 *
 * The first version of this scored every pair any detector touched, and reported that all 100
 * swept settings found the known duplication — true, and useless. D2 links `ChatRepository` to
 * `ChannelRepository` by method name, and no swept threshold touches D2, so the measurement
 * could not move. Families are what qualification filters and what a human is actually shown,
 * so families are what get measured.
 */
export function reported(graph: Graph, opts: DuplicationOptions): string[][] {
  return detectDuplication(graph, opts).families.map((f) => f.members);
}

/**
 * A known pair is found when one family contains both sides of it — as two *different*
 * members. The first version checked the two substrings independently, so a single symbol
 * whose name contained both scored as a found pair and the setting looked better than it was.
 */
export function matches(families: string[][], spec: string): boolean {
  const [a, b] = spec.split('~');
  return families.some((members) =>
    members.some((x, i) => x.includes(a) && members.some((y, j) => j !== i && y.includes(b))),
  );
}
