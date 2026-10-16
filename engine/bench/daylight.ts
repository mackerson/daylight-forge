/**
 * Measure the P0 build on this machine and write docs/daylight/MEASURED.md.
 * Run: node engine/bench/daylight.ts [--skip-renderer]
 *
 * Everything in the document is measured here, in this process or a child of it; nothing is
 * copied from the spec or recalled. The renderer numbers come from the same headless bench the
 * baseline used (`DAYLIGHT_BENCH=6` and the `BENCH {…}` line the renderer prints), so the two
 * documents compare like for like. A number that could not be measured is written as such,
 * not left blank and not estimated.
 *
 * Peak memory is read from `/proc/<pid>/status` `VmHWM`, sampled every 100 ms while the child
 * runs — `/usr/bin/time` is not installed here, and `VmHWM` is the kernel's own high-water
 * mark, so the sampling interval only affects whether the very last reading was caught.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materialiseFixture } from '../demo/fixture.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'engine', 'cli.ts');
const MAIN = path.join(ROOT, 'app', 'main', 'main.cjs');
const DOC = path.join(ROOT, 'docs', 'daylight', 'MEASURED.md');
// The 10k-file map is private; its location is the operator's, never a literal here.
const TENK = process.env.DAYLIGHT_BENCH_10K;
const skipRenderer = process.argv.includes('--skip-renderer');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-bench-'));
const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const seconds = (ns: bigint) => (Number(ns) / 1e9).toFixed(2);

/** Wall time of a CLI call, plus the child's peak RSS in MB. */
function timed(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ s: string; peakMb: number; code: number }> {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    let peakKb = 0;
    const sample = () => {
      try {
        const m = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/VmHWM:\s+(\d+) kB/);
        if (m) peakKb = Math.max(peakKb, Number(m[1]));
      } catch {
        // The process has gone; the last sample stands.
      }
    };
    const timer = setInterval(sample, 100);
    child.on('close', (code) => {
      sample();
      clearInterval(timer);
      if (code !== 0) console.error(stderr.slice(-400));
      resolve({ s: seconds(process.hrtime.bigint() - started), peakMb: Math.round(peakKb / 1024), code: code ?? 1 });
    });
  });
}

interface Bench {
  gpu: string; mode: string; nodes: number; visible: number; ropes: number;
  fps: number; meanMs: number; p95Ms: number; worstMs: number; draws: number; tris: number;
}

/** One headless renderer run; the renderer prints its stats as a `BENCH {…}` console line. */
function renderBench(dir: string, env: NodeJS.ProcessEnv, extraArgs: string[] = []): Bench | null {
  const r = spawnSync('pnpm', ['exec', 'electron', MAIN, ...extraArgs], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
    // The renderer samples for `DAYLIGHT_BENCH` seconds after the map loads, so the capture that
    // ends the run has to wait longer than that or the BENCH line is never printed.
    env: {
      ...process.env, DAYLIGHT_DIR: dir, DAYLIGHT_BENCH: '6', DAYLIGHT_SHOT: path.join(tmp, 'bench.png'),
      DAYLIGHT_SHOT_DELAY: '17000', ...env,
    },
  });
  const m = `${r.stdout}\n${r.stderr}`.match(/BENCH (\{.*\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Bench;
  } catch {
    return null;
  }
}

function shotAssert(dir: string, expr: string, env: NodeJS.ProcessEnv = {}, extraArgs: string[] = []): string | null {
  const r = spawnSync('pnpm', ['exec', 'electron', MAIN, ...extraArgs], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env, DAYLIGHT_DIR: dir, DAYLIGHT_SHOT: path.join(tmp, 'shot.png'), DAYLIGHT_SHOT_DELAY: '6000',
      DAYLIGHT_SHOT_ASSERT: expr, ...env,
    },
  });
  return `${r.stdout}\n${r.stderr}`.match(/^DOM: (.*)$/m)?.[1] ?? null;
}

const HEADLESS = ['--headless=new', '--use-angle=swiftshader'];

async function main(): Promise<void> {
  const gitRev = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  const electronVersion = fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'))
    ? (JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')) as { version: string }).version
    : 'unknown';
  const sandbox = (() => {
    try { return execFileSync('bwrap', ['--version'], { encoding: 'utf8' }).trim(); } catch { return 'bwrap absent'; }
  })();

  say('# Measured — Daylight P0 build');
  say();
  say(`Written by \`engine/bench/daylight.ts\` on ${new Date().toISOString()} at \`${gitRev}\`. Every number below`);
  say('was measured on this machine by that script; compare with `docs/daylight/BASELINE.md`.');
  say();
  say('**Machine:** ' + [
    `${os.type()} ${os.release()}`, `${os.cpus()[0]?.model ?? 'cpu'} × ${os.cpus().length}`,
    `${Math.round(os.totalmem() / 2 ** 30)} GB RAM`, `Node ${process.version}`, `Electron ${electronVersion}`, sandbox,
  ].join(', '));
  say();

  // ---- engine timings ----------------------------------------------------------------
  say('## Index timings (engine, CPU)');
  say();
  say('Wall time around `execFileSync` of the CLI, including Node start-up. Peak RSS is the');
  say('child\'s `VmHWM` from `/proc`, sampled at 100 ms.');
  say();
  say('| Repository | Files | Cold `map` | Warm `map` | `derive` | Peak RSS (cold map) |');
  say('| --- | --- | --- | --- | --- | --- |');

  const measureRepo = async (label: string, root: string, outDir: string) => {
    fs.rmSync(path.join(outDir, '.cache'), { recursive: true, force: true });
    const cold = await timed(['map', root, '--out', outDir, '--top', '0']);
    const warm = await timed(['map', root, '--out', outDir, '--top', '0']);
    const derive = await timed(['derive', '--out', outDir]);
    const files = (JSON.parse(fs.readFileSync(path.join(outDir, 'view.json'), 'utf8')) as { stats: { files: number } }).stats.files;
    say(`| ${label} | ${files} | ${cold.s} s | ${warm.s} s | ${derive.s} s | ${cold.peakMb} MB |`);
  };
  await measureRepo('this repo', ROOT, path.join(tmp, 'self-out'));
  const fixture = materialiseFixture(path.join(tmp, 'fixture'));
  await measureRepo('daylight-demo fixture (PLANTED)', fixture.root, path.join(tmp, 'fixture-out'));
  say();

  // ---- mission loop timings ----------------------------------------------------------
  say('## Mission loop (fixture, two mock reviewers, real bwrap sandbox)');
  say();
  const demoOut = path.join(tmp, 'demo-out');
  const demoRepo = path.join(tmp, 'demo-repo');
  const prepare = await timed(['demo', 'prepare', '--out', demoOut, '--dest', demoRepo, '--format', 'json']);
  // The ids are needed for the next steps; read them back from the store via the CLI.
  const list = JSON.parse(execFileSync(process.execPath, [CLI, 'mission', 'list', '--out', demoOut, '--format', 'json'], { encoding: 'utf8' })) as
    { missions: Array<{ id: string }> };
  const missionId = list.missions[0].id;
  const inspect = JSON.parse(execFileSync(process.execPath, [CLI, 'mission', 'inspect', missionId, '--out', demoOut, '--format', 'json'], { encoding: 'utf8' })) as
    { experiments: Array<{ id: string }> };
  const experimentId = inspect.experiments[0].id;

  const mock = path.join(tmp, 'mock.mjs');
  fs.writeFileSync(mock, `
import fs from 'node:fs';
const env = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).mcpServers.daylight.env;
const { ClaimStore } = await import(${JSON.stringify(path.join(ROOT, 'engine', 'store', 'claims.ts'))});
const store = new ClaimStore(env.DAYLIGHT_DIR + '/claims.db');
const yes = env.DAYLIGHT_MODEL === 'yes';
fs.appendFileSync(env.DAYLIGHT_DIR + '/events.jsonl', JSON.stringify({ at: Date.now(), session: env.DAYLIGHT_SESSION, agent: 'mock', model: env.DAYLIGHT_MODEL, tool: 'get_slice', node: 'src/session-cache.ts' }) + '\\n');
store.submit({ subject: 'src/session-cache.ts', predicate: 'bug_verdict', value: yes, confidence: 0.8,
  source: { kind: 'agent', tool: 'mock', model: env.DAYLIGHT_MODEL, sessionId: env.DAYLIGHT_SESSION },
  evidence: [{ file: 'src/session-cache.ts', line: 37, note: 'mock' }, { file: 'src/session-cache.ts', line: 34, note: 'mock' }] });
store.close();
console.log(JSON.stringify({ reviewer: env.DAYLIGHT_MODEL }));
`);
  const run = await timed(['mission', 'run', missionId, demoRepo, '--out', demoOut, '--tools', 'mock:yes,mock:no', '--format', 'json'], { DAYLIGHT_MOCK_ADAPTER: mock });
  const experiment = await timed(['experiment', 'run', experimentId, demoRepo, '--out', demoOut, '--format', 'json']);
  const conclusion = (JSON.parse(execFileSync(process.execPath, [CLI, 'mission', 'inspect', missionId, '--out', demoOut, '--format', 'json'], { encoding: 'utf8' })) as
    { experiments: Array<{ conclusion: string; executions: unknown[] }> }).experiments[0];
  say('| Step | Wall time | Peak RSS | Note |');
  say('| --- | --- | --- | --- |');
  say(`| \`demo prepare\` (materialise + map + mission + experiment) | ${prepare.s} s | ${prepare.peakMb} MB | exit ${prepare.code} |`);
  say(`| \`mission run\` with two mock reviewers + compare | ${run.s} s | ${run.peakMb} MB | mocks, not models; exit ${run.code} |`);
  say(`| \`experiment run\` (bwrap, ${conclusion.executions.length} runs) | ${experiment.s} s | ${experiment.peakMb} MB | concluded \`${conclusion.conclusion}\` |`);
  say();

  // ---- renderer ------------------------------------------------------------------------
  say('## Renderer (headless `DAYLIGHT_BENCH=6`, same method as BASELINE.md)');
  say();
  if (skipRenderer) {
    say('Skipped with `--skip-renderer`.');
  } else {
    const selfOut = path.join(tmp, 'self-out');
    let headless = false;
    let probe = renderBench(selfOut, {});
    if (!probe) {
      headless = true;
      probe = renderBench(selfOut, {}, HEADLESS);
    }
    say(headless
      ? 'Windowed runs produced no frame stats (blank page, no `requestAnimationFrame`), so these ran with'
        + ' `--headless=new --use-angle=swiftshader`: CPU rendering, comparable only with the headless rows of BASELINE.md.'
      : 'Windowed runs, on the GPU named below. The machine is vsync-capped at ~60 Hz (see BASELINE.md A/B); compare p95 with that table.');
    say();
    say(`**GPU:** \`${probe?.gpu ?? 'unavailable'}\``);
    say();
    say('| Map | Mode | Run | Nodes (visible) | Ropes | fps | mean ms | p95 ms | worst ms | draws |');
    say('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const row = (label: string, i: number, b: Bench | null) => say(b
      ? `| ${label} | ${b.mode} | ${i} | ${b.nodes} (${b.visible}) | ${b.ropes} | ${b.fps.toFixed(1)} | ${b.meanMs.toFixed(2)} | ${b.p95Ms.toFixed(1)} | ${b.worstMs.toFixed(1)} | ${b.draws} |`
      : `| ${label} | — | ${i} | not measured | | | | | | |`);
    row('this repo', 1, probe);
    for (let i = 2; i <= 3; i++) row('this repo', i, renderBench(selfOut, {}, headless ? HEADLESS : []));
    if (TENK && fs.existsSync(path.join(TENK, 'view.json'))) {
      row('10k-file map (private, load fixture only)', 1, renderBench(TENK, { DAYLIGHT_MODE: 'tree', DAYLIGHT_SHOT_DELAY: '40000' }, headless ? HEADLESS : []));
    } else {
      say('| 10k-file map | — | — | not measured (set DAYLIGHT_BENCH_10K to its map dir) | | | | | | |');
    }
    say();
    say('### Single renderer across lens changes');
    say();
    const counters = shotAssert(selfOut,
      "(async()=>{window.__daylightScene.setChannel('belief');await new Promise(r=>setTimeout(r,800));"
      + "window.__daylightScene.setChannel('agent');await new Promise(r=>setTimeout(r,800));"
      + 'return JSON.stringify(window.__daylightScene.counters)})()', {}, headless ? HEADLESS : []);
    say(`After two lens switches, \`window.__daylightScene.counters\` = \`${counters ?? 'not measured'}\`.`);
    say('Expected: `renderers` 1, `projections` 1, `recolors` ≥ 2 — the WebGL context is created once per mount.');
  }
  say();
  say('## Not measured');
  say();
  say('- Live model reviewers: no `claude`/`codex` run is made by this script (it would spend money).');
  say('- Incremental edit → visible status: the existing watch path is unchanged by P0 and was not re-timed.');
  say('- Peak RSS of the Electron renderer process: the bench reports frame stats only.');

  fs.mkdirSync(path.dirname(DOC), { recursive: true });
  fs.writeFileSync(DOC, `${lines.join('\n')}\n`);
  console.log(`\nwrote ${path.relative(process.cwd(), DOC)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

await main();
