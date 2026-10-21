/**
 * The child process `daylight ingest bench` runs (engine/ingest/bench.ts): one benchmark, report on
 * stdout. Not a test file; argv is <corpus> <mode> <json|text> [keep]. The mode was already gated.
 */
import { BENCH_FIXTURES, BenchRefused, renderBenchText, runBenchmark } from './lib/ingest-bench.ts';
import type { BenchMode } from '../ingest/bench.ts';

const [corpus, mode, format, keep] = process.argv.slice(2);
try {
  const report = await runBenchmark(BENCH_FIXTURES[corpus] ?? corpus, { mode: mode as BenchMode, env: process.env, keep: keep === 'keep' });
  process.stdout.write(format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderBenchText(report));
  process.exit(report.summary.fail ? 1 : 0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (format === 'json') process.stdout.write(`${JSON.stringify({ error: message, refused: err instanceof BenchRefused })}\n`);
  console.error(`${err instanceof BenchRefused ? 'refused' : 'error'}: ${message}`);
  process.exit(err instanceof BenchRefused ? 2 : 1);
}
