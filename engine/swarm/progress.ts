/**
 * How far a campaign is from stopping, and which stop it will hit first.
 *
 * A burndown over a frontier has no honest fixed denominator: agents discover questions as
 * they answer them, so "N of M settled" is a number that has to be rebased mid-run to stay
 * true. What a campaign actually races is a set of stop conditions, all of them known up
 * front — so the bar reports the nearest one by name, and reaching 100% means the run stops
 * rather than meaning someone's estimate ran out.
 *
 * No node imports: the renderer draws this, and the engine computes it, from one definition.
 * A progress bar whose arithmetic lives in the interface is a progress bar that disagrees
 * with the run.
 */

/** Why a campaign stopped, or would stop. */
export type StopReason = 'converged' | 'budget' | 'rounds' | 'stall';

/** One round of what a campaign knows about itself, sampled after the round finishes. */
export interface CampaignSample {
  /** 1-based. Round 0 is the sample taken before anything ran. */
  round: number;
  at: string;
  /**
   * Frontier items still worth an agent's time — scoring above the convergence floor.
   *
   * Not `quality.frontier.open`, which counts everything with any uncertainty left. The tail
   * of a frontier is always populated with things nobody should pay to answer, and counting
   * them makes a campaign look stalled while it is working.
   */
  open: number;
  /** Items below the floor. Reported so `open` cannot be mistaken for the whole frontier. */
  tail: number;
  /** Above-floor items that were not there when the campaign started. */
  discovered: number;
  /** Above-floor items present at the start that are no longer above it. */
  settled: number;
  /** The frontier's highest score, which is what convergence is measured against. */
  topScore: number;
  converged: boolean;
  /** USD the campaign has spent. A floor, not a figure, when `costKnown` is false. */
  spent: number;
  /**
   * False once any adapter in the roster has reported no price at all.
   *
   * The budget stop is still enforced against what is known, but a bar drawn from an
   * incomplete total is an estimate and has to say so.
   */
  costKnown: boolean;
  /** Claims added this round. Rounds that add nothing are what `stall` counts. */
  delta: number;
  /** Consecutive rounds ending with no delta, this one included. */
  stalled: number;
}

export interface CampaignLimits {
  /**
   * Hard round cap, always set. An unbounded loop over paid agents is not a feature, and
   * convergence is a property of the codebase rather than a promise about wall-clock.
   */
  rounds: number;
  /** USD ceiling. 0 means none, and drops the budget stop from the race entirely. */
  maxCost: number;
  /** Consecutive rounds that may change nothing before the campaign gives up. */
  stallRounds: number;
  /** The score the frontier's top item is racing down to. */
  floor: number;
}

/**
 * A sample as it is stored: one file holds the series for every campaign in a directory.
 *
 * The type and the grouping live here rather than beside the loop, because the renderer draws
 * this and cannot reach the loop — `app/main` shells out to the engine CLI and never imports
 * it. Both sides selecting "the current campaign" by their own rules is how a window comes to
 * chart a different run from the one it is watching.
 */
export interface CampaignEntry extends CampaignSample {
  campaign: string;
  /**
   * The ceilings this campaign was launched with, carried on every row.
   *
   * Four numbers per line is cheap, and the alternative is a window that reopens onto a run
   * in progress knowing the samples but not what they are measured against — which is a
   * burndown that cannot draw its own bar.
   */
  limits: CampaignLimits;
}

/**
 * The samples of one campaign, oldest first.
 *
 * Without an id, the most recent campaign in the file — which is what a window reopening
 * mid-run wants, and what makes a burndown survive a restart rather than starting blank
 * halfway through something that is still going.
 */
export function seriesOf(entries: CampaignEntry[], id?: string): CampaignEntry[] {
  const want = id ?? entries[entries.length - 1]?.campaign;
  return want ? entries.filter((e) => e.campaign === want) : [];
}

export interface StopProgress {
  reason: StopReason;
  /** 0..1. At 1 this stop has fired. */
  fraction: number;
  /** What the bar is measuring, in the fewest words that stay true. */
  label: string;
  /**
   * Whether this is counted or estimated.
   *
   * Rounds and stall are counted. Budget is counted while every adapter reports a price and
   * estimated the moment one does not. Convergence is always an estimate — the frontier can
   * grow, so the top score does not have to fall.
   */
  exact: boolean;
}

export interface Progress {
  /** Every stop in the race, so the ones not driving the bar stay readable. */
  stops: StopProgress[];
  /** The one closest to firing. This is what the bar shows, and it is named. */
  nearest: StopProgress;
  /** Set once one has actually fired. */
  fired: StopReason | null;
}

const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * How far the top score has fallen towards the floor, on a log scale.
 *
 * Linear would report a campaign as nearly done the moment it settled its first hub: scores
 * are uncertainty x centrality, so the top of a fresh frontier sits an order of magnitude
 * above the floor and the first drop is the biggest one there will ever be. The distance
 * that matters is multiplicative — halving the top score is the same amount of work whether
 * it goes 1.2 to 0.6 or 0.2 to 0.1.
 */
function convergence(first: number, now: number, floor: number): number {
  if (now <= floor || now <= 0) return 1;
  // Already at the floor when it started: there was never any distance to cover.
  if (first <= floor) return 1;
  return clamp(Math.log(first / now) / Math.log(first / floor));
}

/**
 * The state of the race, from the samples so far.
 *
 * `samples` is the whole series because two of the stops are only meaningful against where
 * the campaign started — the top score it is falling from, and whether anything has moved.
 */
export function progress(samples: CampaignSample[], limits: CampaignLimits): Progress {
  const last = samples[samples.length - 1];
  const first = samples[0];
  const stops: StopProgress[] = [];

  if (!last) {
    const idle: StopProgress = { reason: 'rounds', fraction: 0, label: 'not started', exact: true };
    return { stops: [idle], nearest: idle, fired: null };
  }

  stops.push({
    reason: 'converged',
    fraction: last.converged ? 1 : convergence(first.topScore, last.topScore, limits.floor),
    label: `top score ${last.topScore.toFixed(2)} of ${limits.floor.toFixed(2)}`,
    exact: false,
  });

  stops.push({
    reason: 'rounds',
    fraction: clamp(last.round / Math.max(1, limits.rounds)),
    label: `round ${last.round} of ${limits.rounds}`,
    exact: true,
  });

  if (limits.maxCost > 0) {
    stops.push({
      reason: 'budget',
      fraction: clamp(last.spent / limits.maxCost),
      label: `$${last.spent.toFixed(2)} of $${limits.maxCost.toFixed(2)}${last.costKnown ? '' : '+'}`,
      exact: last.costKnown,
    });
  }

  stops.push({
    reason: 'stall',
    fraction: clamp(last.stalled / Math.max(1, limits.stallRounds)),
    label: `${last.stalled} of ${limits.stallRounds} rounds with nothing new`,
    exact: true,
  });

  /**
   * Nearest by fraction, and a counted stop beats an estimated one at the same distance.
   *
   * The tie matters more than it looks: a campaign one round from its cap and nominally
   * "90% converged" is going to stop on the cap, and saying so is the difference between a
   * bar that predicts the end and a bar that describes a hope.
   */
  const nearest = [...stops].sort(
    (a, b) => b.fraction - a.fraction || Number(b.exact) - Number(a.exact),
  )[0];

  const fired = stops.find((s) => s.fraction >= 1)?.reason ?? null;
  return { stops, nearest, fired };
}
