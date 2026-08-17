/**
 * Render settings and frame statistics. Run: node engine/test/render-settings.ts
 *
 * These decide whether the map draws everything or hides most of it, so the values that
 * arrive from disk or from IPC are the ones worth being careful about — a bad number here
 * does not throw, it stalls the render loop or blanks the scene.
 *
 * The default matters more than usual. It was a hard-coded 2500 that silently overrode the
 * user's own choice: on a 14,651-node monorepo the "all levels" button was inert and nothing
 * said so. Measured on the integrated GPU of the machine that reported it, all 14,651 nodes
 * ran at 92fps — so the constant was not conservative, it was wrong, and it was wrong because
 * it was a guess about somebody else's computer.
 */
import {
  DEFAULT_SETTINGS, limitAfterSlowdown, normaliseSettings, SLOW_FRAME_MS, summarise,
} from '../render/settings.ts';
import { harness } from './harness.ts';

const { check, done } = harness();

console.log('\ndefaults');
{
  check('the default is to draw everything and measure', DEFAULT_SETTINGS.allLevelsLimit === 0);
  check('the meter is off until asked for', DEFAULT_SETTINGS.showFps === false);
  check('the slow-frame threshold is above a 60fps budget, not at it',
    SLOW_FRAME_MS > 16.7, String(SLOW_FRAME_MS));
}

console.log('\nvalues from disk');
{
  check('nothing at all yields the defaults',
    JSON.stringify(normaliseSettings(undefined)) === JSON.stringify(DEFAULT_SETTINGS));
  check('so does an empty object',
    JSON.stringify(normaliseSettings({})) === JSON.stringify(DEFAULT_SETTINGS));
  check('a stored value is kept', normaliseSettings({ allLevelsLimit: 4000 }).allLevelsLimit === 4000);
  check('zero is kept, because it means "never fall back"',
    normaliseSettings({ allLevelsLimit: 0 }).allLevelsLimit === 0);

  check('a negative limit cannot hide the whole map',
    normaliseSettings({ allLevelsLimit: -5 }).allLevelsLimit === 0);
  check('a fractional limit is rounded rather than compared against fractionally',
    normaliseSettings({ allLevelsLimit: 12.7 }).allLevelsLimit === 13);
  check('a string is refused in favour of the default',
    normaliseSettings({ allLevelsLimit: '4000' as never }).allLevelsLimit
      === DEFAULT_SETTINGS.allLevelsLimit);
  check('NaN is refused', normaliseSettings({ allLevelsLimit: NaN }).allLevelsLimit
    === DEFAULT_SETTINGS.allLevelsLimit);
  check('Infinity is refused', normaliseSettings({ allLevelsLimit: Infinity }).allLevelsLimit
    === DEFAULT_SETTINGS.allLevelsLimit);
  check('a non-boolean showFps is refused',
    normaliseSettings({ showFps: 'yes' as never }).showFps === false);

  check('a label budget of zero is allowed — labels off is a real choice',
    normaliseSettings({ labelBudget: 0 }).labelBudget === 0);
  check('an absurd label budget is clamped rather than trusted',
    normaliseSettings({ labelBudget: 1e9 }).labelBudget <= 5000);
  check('unknown keys are dropped rather than carried into the render loop',
    !('nonsense' in normaliseSettings({ nonsense: true } as never)));
}

console.log('\nwhat a machine learns about itself');
{
  const learned = limitAfterSlowdown(14651);
  check('the remembered limit is below where it struggled', learned < 14651, String(learned));
  check('and well below, not just under it — sitting on the boundary flips back and forth',
    learned < 14651 * 0.75, String(learned));
  check('a tiny scene still leaves something visible', limitAfterSlowdown(10) >= 500);
  check('it round-trips through normalisation',
    normaliseSettings({ allLevelsLimit: learned }).allLevelsLimit === learned);
}

console.log('\nframe statistics');
{
  check('no samples is not a division by zero',
    JSON.stringify(summarise([])) ===
      JSON.stringify({ fps: 0, meanMs: 0, p95Ms: 0, worstMs: 0, samples: 0 }));

  const steady = new Array(100).fill(10);
  const s = summarise(steady);
  check('a steady 10ms reads as 100fps', Math.round(s.fps) === 100);
  check('mean is the mean', s.meanMs === 10);
  check('every sample is counted', s.samples === 100);

  /**
   * The case the mean hides, and the reason p95 is reported next to it: ninety-five frames
   * at 8ms and five at 60 averages under 11ms — a number that reads as comfortable and feels
   * like a stutter every twentieth frame.
   */
  const spiky = [...new Array(95).fill(8), ...new Array(5).fill(60)];
  const sp = summarise(spiky);
  check('a spiky run still averages under the budget', sp.meanMs < 16.7, sp.meanMs.toFixed(1));
  check('but p95 shows the stutter the mean hid', sp.p95Ms >= 16.7, String(sp.p95Ms));
  check('and the worst frame is reported too', sp.worstMs === 60);
  check('so a spiky run trips the slow threshold that a mean would not',
    sp.p95Ms > SLOW_FRAME_MS && sp.meanMs < SLOW_FRAME_MS);

  check('summarising does not disturb the caller\'s samples',
    (() => { const src = [30, 10, 20]; summarise(src); return src.join(',') === '30,10,20'; })());
  check('a single sample is summarisable', summarise([20]).p95Ms === 20);
}

done();
