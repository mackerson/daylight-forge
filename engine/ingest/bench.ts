import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_SESSION_VARS } from '../forge/policy.ts';

/**
 * `daylight ingest bench <olc|harbor|dir> --mode mock|live-extract|live-full [--format json] [--keep]`:
 * the ingestion benchmark (spec ingestion §11, WS-R16).
 *
 * Only the gate lives here: the mode is checked and a live mode refused with one line — never from
 * an agent session, and nowhere until a live-spend grant exists (P2-R7). The benchmark itself, with
 * its scripted agents and row-level fixtures, is test code (engine/test/lib/ingest-bench.ts) and
 * product code never calls into engine/test (`tests-are-never-imported`), so mock mode runs it as a
 * child process, `engine/test/ingest-bench-main.ts`, which a build without the test tree lacks.
 * Exit codes are the runner's: 0 nothing failed, 1 a check failed, 2 bad arguments or a refusal.
 */

export const BENCH_MODES = ['mock', 'live-extract', 'live-full'] as const;
export type BenchMode = (typeof BENCH_MODES)[number];

/** Why a mode does not run, in one line; null for mock. Today every live mode is refused (P2-R7). */
export function liveRefusal(mode: BenchMode, env: Readonly<Record<string, string | undefined>>): string | null {
  if (mode === 'mock') return null;
  if (AGENT_SESSION_VARS.some((k) => env[k] !== undefined && env[k] !== '')) return `${mode} spends on live models and is never run from an agent session`;
  return `${mode} needs live model spend, which is not authorised (P2-R7): no live-spend grant exists yet`;
}

export const BENCH_MAIN = path.resolve(import.meta.dirname, '..', 'test', 'ingest-bench-main.ts');

export async function runIngestBench(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [corpus, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const key = a.startsWith('--') ? a.slice(2) : null;
    if (!key || !['mode', 'format', 'keep'].includes(key)) {
      console.error(`usage: ingest bench <olc|harbor|dir> --mode ${BENCH_MODES.join('|')} [--format json] [--keep] (unexpected ${a})`);
      return 2;
    }
    flags.set(key, key === 'keep' ? 'true' : rest[++i] ?? '');
  }
  const mode = (flags.get('mode') ?? 'mock') as BenchMode;
  const format = flags.get('format') ?? 'text';
  if (!corpus || corpus.startsWith('--') || !(BENCH_MODES as readonly string[]).includes(mode) || !['json', 'text'].includes(format)) {
    console.error(`usage: ingest bench <olc|harbor|dir> --mode ${BENCH_MODES.join('|')} [--format json] [--keep]`);
    return 2;
  }
  const refusal = liveRefusal(mode, env);
  if (refusal) {
    console.error(`refused: ${refusal}`);
    if (format === 'json') process.stdout.write(`${JSON.stringify({ error: refusal, refused: true })}\n`);
    return 2;
  }
  if (!fs.existsSync(BENCH_MAIN)) {
    console.error('error: the ingestion benchmark ships with the test tree, which this build does not include');
    return 1;
  }
  const r = spawnSync(process.execPath, [BENCH_MAIN, corpus, mode, format, flags.has('keep') ? 'keep' : ''], {
    env: env as NodeJS.ProcessEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(r.stdout ?? '');
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}
