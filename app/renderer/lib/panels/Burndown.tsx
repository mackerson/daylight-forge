import { useMemo } from 'react';
import { progress, seriesOf } from '../../../../engine/swarm/progress.ts';
import type { CampaignEntry, StopReason } from '../types.ts';
import { money } from '../vocab.ts';

/**
 * The burndown.
 *
 * A frontier has no honest fixed denominator: agents discover questions as they answer them,
 * so "74 of 112 settled" is a number that has to be rebased mid-run to stay true, and a bar
 * drawn from it can reach the end while the run carries on. What a campaign actually races is
 * a set of ceilings chosen before it started — so the bar tracks whichever is nearest, says
 * which one, and reaching the end of it means the run stops.
 *
 * The arithmetic is imported from the engine rather than repeated here. A progress bar that
 * computes its own version of the run's state is a progress bar that will eventually disagree
 * with the run, and the disagreement will be silent.
 */

/** Which stop is driving the bar, in the colour the rest of the app uses for that meaning. */
const TONE: Record<StopReason, string> = {
  converged: 'ok',
  budget: 'warn',
  rounds: 'warn',
  stall: 'bad',
};

const WHY: Record<StopReason, string> = {
  converged: 'nothing left is worth an agent’s time',
  budget: 'the ceiling you set',
  rounds: 'the round cap',
  stall: 'rounds that changed nothing',
};

/**
 * Open frontier over rounds, as an area.
 *
 * Scaled to its own peak rather than to zero, because the shape that matters is whether the
 * line is falling — a chart pinned to zero on a repo with four thousand open questions is a
 * flat line whatever happens. The rounds where the frontier *grew* are marked: work being
 * created faster than it is answered is the one thing a burndown must not hide.
 */
function Sparkline({ samples }: { samples: CampaignEntry[] }) {
  const w = 268;
  const h = 46;
  const max = Math.max(1, ...samples.map((s) => s.open));
  const x = (i: number) => (samples.length < 2 ? w : (i / (samples.length - 1)) * w);
  const y = (v: number) => h - (v / max) * (h - 4) - 2;

  const line = samples.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.open).toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const grew = samples
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => i > 0 && s.open > samples[i - 1].open);

  return (
    <svg className="burn-spark" viewBox={`0 0 ${w} ${h}`} role="img"
      aria-label={`open frontier, ${samples[0].open} down to ${samples[samples.length - 1].open}`}>
      <path d={area} fill="var(--line-3)" />
      <path d={line} fill="none" stroke="var(--ok-mark)" strokeWidth="1.5" />
      {grew.map(({ s, i }) => (
        <circle key={i} cx={x(i)} cy={y(s.open)} r="2.5" fill="var(--warn-mark)" />
      ))}
    </svg>
  );
}

export function Burndown({ entries }: { entries: CampaignEntry[] }) {
  const samples = useMemo(() => seriesOf(entries), [entries]);
  const last = samples[samples.length - 1];
  const limits = last?.limits;
  const p = useMemo(
    () => (limits ? progress(samples, limits) : null),
    [samples, limits],
  );

  if (!last || !limits || !p) {
    return (
      <div>
        <div className="rail-label">burndown</div>
        <p className="dim">
          No campaign has run in this directory yet. A campaign is the loop without you in it:
          rounds of agents until the frontier converges or a ceiling you set stops it.
        </p>
      </div>
    );
  }

  const others = p.stops.filter((s) => s.reason !== p.nearest.reason);
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <div>
      <div className="rail-label">
        burndown · round {last.round} of {limits.rounds}
        {p.fired ? ` · stopped on ${p.fired}` : ''}
      </div>

      <div className="burn-head">
        <span className={`burn-pct ${TONE[p.nearest.reason]}`}>{pct(p.nearest.fraction)}</span>
        <span className="burn-what">
          {p.nearest.reason}
          {p.nearest.exact ? '' : ' (estimate)'}
          <span className="dim"> — {WHY[p.nearest.reason]}</span>
        </span>
      </div>

      <div className="meter" title={p.nearest.label}>
        <div
          className={`meter-fill ${TONE[p.nearest.reason]}`}
          style={{ width: `${Math.min(100, p.nearest.fraction * 100)}%` }}
        />
      </div>

      {/* The stops not driving the bar stay readable: which one is closest changes as a run
          goes, and watching it change is how you learn what your ceilings actually do. */}
      <div className="burn-stops">
        {others.map((s) => (
          <span key={s.reason} title={s.label}>
            {s.reason} {pct(s.fraction)}
          </span>
        ))}
      </div>

      <Sparkline samples={samples} />

      <div className="facts">
        <div className="fact">
          <span className="k">open frontier</span>
          <span className="v">
            {last.open}
            {last.open !== samples[0].open && (
              <span className="dim"> from {samples[0].open}</span>
            )}
          </span>
        </div>
        <div className="fact">
          <span className="k">settled</span>
          <span className="v ok">{last.settled}</span>
        </div>
        <div className="fact">
          <span className="k">discovered</span>
          {/* Not a failure: a swarm that finds new questions is doing the job. It is only a
              surprise if the bar hides it, which is why it has its own row. */}
          <span className={last.discovered ? 'v warn' : 'v'}>{last.discovered}</span>
        </div>
        <div className="fact">
          <span className="k">spent</span>
          <span className="v warn">
            {money(last.spent)}{last.costKnown ? '' : '+'}
            {limits.maxCost > 0 ? ` / ${money(limits.maxCost)}` : ''}
          </span>
        </div>
        {last.tail > 0 && (
          <div className="fact">
            <span className="k">below the floor</span>
            <span className="v dim" title={`scoring under ${limits.floor}, so not worth paying to answer`}>
              {last.tail}
            </span>
          </div>
        )}
      </div>

      {!last.costKnown && (
        <p className="dim">
          One of these CLIs reports no price at all, so the spend above is a floor and the
          ceiling cannot be enforced against it.
        </p>
      )}
    </div>
  );
}
