/**
 * Campaign stops and the burndown arithmetic. Run: node engine/test/campaign.ts
 *
 * A campaign is the loop a person used to be: run a round, look at what moved, decide whether
 * to pay for another. The decision is worth automating only if the stops are honest, so this
 * pins them — every one is bounded, every one is checked after every round, and the bar names
 * whichever is closest rather than inventing a denominator the frontier does not have.
 *
 * The progress module has no node imports on purpose: the engine computes this and the
 * renderer draws it, and a progress bar whose arithmetic lives in the interface is a progress
 * bar that disagrees with the run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { series } from '../swarm/campaign.ts';
import { progress } from '../swarm/progress.ts';
import type { CampaignEntry, CampaignLimits, CampaignSample } from '../swarm/progress.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();

const LIMITS: CampaignLimits = { rounds: 10, maxCost: 4, stallRounds: 2, floor: 0.05 };

const sample = (over: Partial<CampaignSample> = {}): CampaignSample => ({
  round: 0,
  at: '2026-01-01T00:00:00.000Z',
  open: 100,
  tail: 40,
  discovered: 0,
  settled: 0,
  topScore: 1,
  converged: false,
  spent: 0,
  costKnown: true,
  delta: 0,
  stalled: 0,
  ...over,
});

const of = (samples: CampaignSample[], limits = LIMITS) => progress(samples, limits);
const stop = (samples: CampaignSample[], reason: string, limits = LIMITS) =>
  of(samples, limits).stops.find((s) => s.reason === reason);

section('a campaign with no samples has not started');
{
  const p = of([]);
  check('nothing fired', p.fired === null);
  check('and the bar says so rather than showing zero of nothing',
    p.nearest.label === 'not started');
}

section('every stop is bounded and counted after each round');
{
  const p = of([sample(), sample({ round: 3, spent: 1, topScore: 0.5 })]);
  check('all four are in the race', p.stops.length === 4,
    p.stops.map((s) => s.reason).join(','));
  check('rounds counts against the cap', stop(
    [sample(), sample({ round: 3 })], 'rounds')?.fraction === 0.3);
  check('budget counts against the ceiling',
    stop([sample(), sample({ round: 1, spent: 1 })], 'budget')?.fraction === 0.25);
  check('stall counts consecutive rounds that moved nothing',
    stop([sample(), sample({ round: 1, stalled: 1 })], 'stall')?.fraction === 0.5);
}

section('no ceiling drops budget out of the race entirely');
{
  const limits = { ...LIMITS, maxCost: 0 };
  const p = of([sample(), sample({ round: 1, spent: 99 })], limits);
  check('budget is not one of the stops', !p.stops.some((s) => s.reason === 'budget'),
    p.stops.map((s) => s.reason).join(','));
  check('and nothing fires on spend alone', p.fired === null);
}

section('convergence is measured multiplicatively, not linearly');
{
  // Scores are uncertainty x centrality: a fresh frontier's top sits an order of magnitude
  // above the floor, so the first drop is the biggest one there will ever be. Linear would
  // call a campaign nearly done the moment it settled its first hub.
  const fell = (to: number) =>
    stop([sample({ topScore: 1 }), sample({ round: 1, topScore: to })], 'converged')!;
  const once = fell(0.5);
  check('halving the top score is not half the distance', once.fraction < 0.3,
    once.fraction.toFixed(3));
  // Each halving is the same amount of work, so each moves the bar by the same amount —
  // which is the property linear arithmetic does not have.
  check('and every further halving advances it by the same step',
    Math.abs(fell(0.25).fraction - 2 * once.fraction) < 1e-9 &&
      Math.abs(fell(0.125).fraction - 3 * once.fraction) < 1e-9,
    `${once.fraction} ${fell(0.25).fraction} ${fell(0.125).fraction}`);
  check('and it is never counted as exact', !once.exact);
  check('reaching the floor is the whole distance',
    stop([sample({ topScore: 1 }), sample({ round: 1, topScore: 0.05 })], 'converged')!
      .fraction === 1);
  check('so is the frontier saying it converged',
    stop([sample({ topScore: 1 }), sample({ round: 1, topScore: 0.9, converged: true })],
      'converged')!.fraction === 1);
  check('a campaign already at the floor before it started has no distance to cover',
    stop([sample({ topScore: 0.02 }), sample({ round: 1, topScore: 0.02 })], 'converged')!
      .fraction === 1);
}

section('the bar names the stop that is actually going to fire');
{
  const p = of([sample(), sample({ round: 8, spent: 1, topScore: 0.6 })]);
  check('the nearest stop drives the bar', p.nearest.reason === 'rounds', p.nearest.reason);

  // The tie is the point: a campaign one round from its cap and nominally "90% converged" is
  // going to stop on the cap, and saying so is the difference between a bar that predicts the
  // end and a bar that describes a hope.
  const tied = of([sample({ topScore: 0.02 }), sample({ round: 10, topScore: 0.02 })]);
  check('a counted stop beats an estimated one at the same distance',
    tied.nearest.exact && tied.nearest.reason === 'rounds', tied.nearest.reason);
}

section('a fired stop is reported, and reported by name');
{
  check('the round cap fires', of([sample(), sample({ round: 10 })]).fired === 'rounds');
  check('the ceiling fires', of([sample(), sample({ round: 1, spent: 4 })]).fired === 'budget');
  check('the stall fires', of([sample(), sample({ round: 1, stalled: 2 })]).fired === 'stall');
  check('convergence fires',
    of([sample(), sample({ round: 1, converged: true })]).fired === 'converged');
  check('a campaign already converged at round 0 never pays for a round',
    of([sample({ converged: true })]).fired === 'converged');
  check('and an ordinary round in progress fires nothing',
    of([sample(), sample({ round: 2, spent: 1, topScore: 0.7 })]).fired === null);
}

section('an unpriced adapter makes the budget an estimate, not a lie');
{
  const s = stop([sample(), sample({ round: 1, spent: 1, costKnown: false })], 'budget')!;
  check('the fraction still counts what is known', s.fraction === 0.25);
  check('but the stop stops claiming to be exact', !s.exact);
  check('and the label says the total is a floor', s.label.includes('+'), s.label);
}

/**
 * The loop itself, driven through the CLI.
 *
 * `--dry-run` spawns no agent, so every round settles nothing — which is exactly the shape
 * the stall stop exists for, and the cheapest way to prove the loop terminates on its own
 * rather than running to its cap. What it cannot cover is agents actually answering, and
 * pretending otherwise with a mock drive would test the mock.
 */
section('a campaign runs rounds, samples each one, and stops itself');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-campaign-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'r', main: 'src/index.ts' }));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), "import './thing.ts';\n");
  fs.writeFileSync(path.join(repo, 'src', 'thing.ts'), 'export const thing = () => 1;\n');
  fs.writeFileSync(path.join(repo, 'vds.target.json'), JSON.stringify({
    layers: [{ name: 'src', include: ['src/**'], mayDependOn: [] }],
  }));

  const out = path.join(tmp, 'out');
  const CLI = path.join(import.meta.dirname, '..', 'cli.ts');
  const run = (args: string[]): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  const first = run(['run', repo, '--out', out, '--rounds', '6', '--dry-run', 'true']);
  check('the command completes', first.code === 0, first.out.slice(-500));

  const samples = series(out) as CampaignEntry[];
  check('a round-0 sample is taken before anything is paid for',
    samples[0]?.round === 0, JSON.stringify(samples[0]?.round));
  check('rounds are numbered in order',
    samples.every((s, i) => s.round === i), samples.map((s) => s.round).join(','));
  check('every sample carries the ceilings it is measured against',
    samples.every((s) => s.limits?.rounds === 6));
  check('all of them belong to one campaign',
    new Set(samples.map((s) => s.campaign)).size === 1);

  const limits = samples[samples.length - 1].limits;
  check('it stopped on the stall rather than running to the cap',
    progress(samples, limits).fired === 'stall' && samples.length - 1 < 6,
    `${progress(samples, limits).fired} after ${samples.length - 1}`);
  check('and stopped as soon as the stall was reached, not later',
    samples.length - 1 === limits.stallRounds, String(samples.length - 1));

  // The plan is the end of the loop, and a campaign that does not reach it has not run the
  // loop end to end — which is the whole reason this command exists rather than a shell alias.
  check('the loop ends at the plan', fs.existsSync(path.join(out, 'plan.json')));
  check('and the map it worked from is there too',
    fs.existsSync(path.join(out, 'graph.json')) && fs.existsSync(path.join(out, 'focus.json')));

  const second = run(['run', repo, '--out', out, '--rounds', '2', '--dry-run', 'true',
    '--skip-map', 'true']);
  const now = series(out) as CampaignEntry[];
  check('a second campaign in the same directory is its own series',
    second.code === 0 && now[0].campaign !== samples[0].campaign && now[0].round === 0,
    second.out.slice(-400));

  /**
   * A repo that has not declared an architecture still finishes.
   *
   * `vds plan` exits non-zero without a target, and inheriting that here would report a
   * campaign that ran and cost money as a failure because of a file nobody wrote.
   */
  fs.rmSync(path.join(repo, 'vds.target.json'));
  const untargeted = run(['run', repo, '--out', path.join(tmp, 'out2'), '--rounds', '2',
    '--dry-run', 'true']);
  check('a repo with no target architecture still completes', untargeted.code === 0,
    untargeted.out.slice(-400));
  check('and says why there is no plan rather than just stopping',
    /no target architecture/.test(untargeted.out), untargeted.out.slice(-300));

  fs.rmSync(tmp, { recursive: true, force: true });
}

done();
