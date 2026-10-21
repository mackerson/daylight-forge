/**
 * The renderer bundle carries no engine runtime (P2-R64): build it into a throwaway directory and
 * count the eighteen engine markers and the sample holdout id in its scripts; each must be zero.
 * The sample holdout basename sentinel is fixture data and must be in the bundle, which shows the
 * count reads the real bundle (a check that cannot fail would say nothing).
 * Run: node engine/test/bundle-markers.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SAMPLE_HOLDOUT_BASENAME, SAMPLE_HOLDOUT_ID } from '../../app/renderer/lib/fixtures/forge-campaign.sample.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MARKERS = [
  'node:sqlite', 'DatabaseSync', 'node:fs', 'node:child_process', 'child_process', 'execFileSync', 'spawnSync', 'node:path', 'node:os', 'node:crypto',
  'createHash', 'assertHumanDecision', 'recordDecision', 'confirmDigest', 'createWorkspace', 'processAlive', 'gitIn', 'holdoutPaths',
];
const count = (text: string, m: string) => text.split(m).length - 1;

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-bundle-'));
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));
execFileSync(path.join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const assets = path.join(outDir, 'assets');
const scripts = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
const bundle = scripts.map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');

section('the renderer bundle');
check('vite built at least one script', scripts.length > 0 && bundle.length > 0, outDir);
check('eighteen markers, as in w3-markers.sh', MARKERS.length === 18 && new Set(MARKERS).size === 18);
for (const m of MARKERS) check(`no ${m}`, count(bundle, m) === 0, String(count(bundle, m)));
check('no sample holdout id', SAMPLE_HOLDOUT_ID.startsWith('x_') && count(bundle, SAMPLE_HOLDOUT_ID) === 0);
check('the basename sentinel is there: the count reads the real bundle', count(bundle, SAMPLE_HOLDOUT_BASENAME) >= 1);
check('the markers are findable where they live (engine source)', count(fs.readFileSync(path.join(ROOT, 'engine', 'forge', 'confirm.ts'), 'utf8'), 'confirmDigest') > 0);

done();
