import path from 'node:path';
import fs from 'node:fs';
import { BENCH_MODES, liveRefusal, renderBenchText, runBenchmark, type BenchMode } from '../forge/ingest-bench.ts';

/**
 * `daylight ingest bench --mode mock|live-extract|live-full --fixture <dir> --extractor <script> [--format json] [--keep]`:
 * the ingestion benchmark (spec ingestion §11, WS-R16, P2-R57).
 *
 * Everything project-specific is an input: `--fixture` is a directory with `bench.json` (manifest,
 * ground truth, IR overlay, seeds and templates it names), and in mock mode `--extractor` is the
 * script the mock extractor and reviewer run as: a child process under the review sandbox, as
 * `DAYLIGHT_MOCK_ADAPTER` names one, never imported (P2-R61). The person's steps are the bench's
 * `bench:<step>` actors on a store marked as a bench store. Nothing here knows a project or a test file. A live mode is refused with one line: never from an agent
 * session, and nowhere until a live-spend grant exists (P2-R7). Exit 0 nothing failed, 1 a check
 * failed, 2 bad arguments or a refusal.
 */
export async function runIngestBench(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const flags = new Map<string, string>();
  const usage = (why: string) => {
    console.error(`usage: ingest bench --mode ${BENCH_MODES.join('|')} --fixture <dir> --extractor <script> [--format json] [--keep] (${why})`);
    return 2;
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (!key || !['mode', 'fixture', 'extractor', 'format', 'keep'].includes(key) || flags.has(key)) return usage(`unexpected ${argv[i]}`);
    if (key === 'keep') flags.set(key, 'true');
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return usage(`--${key} needs a value`);
    else flags.set(key, argv[++i]);
  }
  const mode = (flags.get('mode') ?? 'mock') as BenchMode;
  const format = flags.get('format') ?? 'text';
  if (!(BENCH_MODES as readonly string[]).includes(mode)) return usage(`unknown mode ${mode}`);
  if (format !== 'json' && format !== 'text') return usage('--format is json or text');
  const refusal = liveRefusal(mode, env);
  if (refusal) {
    console.error(`refused: ${refusal}`);
    if (format === 'json') process.stdout.write(`${JSON.stringify({ error: refusal, refused: true })}\n`);
    return 2;
  }
  const fixture = flags.get('fixture');
  const extractor = flags.get('extractor');
  if (!fixture) return usage('--fixture is required');
  if (!extractor) return usage('mock mode needs --extractor <script>');
  try {
    // The script is never imported: it runs as the mock agent, a child process under the review sandbox (P2-R61).
    if (!fs.existsSync(extractor)) return usage(`no extractor script at ${extractor}`);
    const report = await runBenchmark(path.resolve(fixture), { mode, extractor: path.resolve(extractor), env, keep: flags.get('keep') === 'true' });
    process.stdout.write(format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderBenchText(report));
    return report.summary.fail ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (format === 'json') process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    console.error(`error: ${message}`);
    return 1;
  }
}
