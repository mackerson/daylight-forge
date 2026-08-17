/**
 * Threshold calibration runner.
 *
 * Usage:
 *   node engine/tools/calibrate.ts <spec.json>
 *
 * The spec names directories, so the fixture is never checked out or mutated — extract the
 * commits you want with `git archive` first. See `calibration.example.json` beside this file.
 *
 * What it measures and why is documented in calibrate-sweep.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { extract } from '../extract/index.ts';
import type { DuplicationOptions } from '../detect/duplication.ts';
import { DEFAULT_SWEEP, grid, matches, reported, type Point, type Spec } from './calibrate-sweep.ts';

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node engine/tools/calibrate.ts <spec.json>');
  process.exit(2);
}
const spec: Spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

console.log('extracting fixture points (once each — the sweep re-scores, it does not re-parse)');
const graphs = spec.points.map((point) => {
  const repo = path.resolve(path.dirname(specPath), point.repo);
  if (!fs.existsSync(repo)) {
    console.error(`  ${point.name}: ${repo} does not exist — extract it with git archive first`);
    process.exit(2);
  }
  const graph = extract({ root: repo });
  const files = graph.nodes.filter((n) => n.kind === 'file').length;
  console.log(`  ${point.name}: ${files} files`);
  return { point, graph, files };
});

interface Row {
  opts: DuplicationOptions;
  found: number;
  wanted: number;
  violations: string[];
  /** Families reported per 100 files — raw counts are not comparable across fixture points. */
  density: number;
  /** The largest family produced. An over-merged family hides the real one inside it. */
  largest: number;
}

const rows: Row[] = [];
for (const opts of grid(spec.sweep ?? DEFAULT_SWEEP)) {
  let found = 0;
  let wanted = 0;
  let density = 0;
  let largest = 0;
  const violations: string[] = [];

  for (const { point, graph, files } of graphs) {
    const families = reported(graph, opts);
    density += (families.length / files) * 100;
    largest = Math.max(largest, ...families.map((m) => m.length), 0);
    for (const want of point.mustFind ?? []) {
      wanted++;
      if (matches(families, want)) found++;
      else violations.push(`${point.name}: missed ${want}`);
    }
    for (const avoid of point.mustNotFind ?? []) {
      if (matches(families, avoid)) violations.push(`${point.name}: surfaced ${avoid}`);
    }
  }
  rows.push({ opts, found, wanted, violations, density, largest });
}

// Complete first, then quietest. A setting that misses a known pair is not a candidate at
// any noise level, so recall gates and volume only ranks among the survivors.
rows.sort(
  (a, b) =>
    b.found - a.found ||
    a.violations.length - b.violations.length ||
    a.density - b.density,
);

const fmt = (o: DuplicationOptions) =>
  Object.entries(o)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

const complete = rows.filter((r) => r.found === r.wanted && !r.violations.length);
console.log(`\n${rows.length} settings swept · ${complete.length} find every known pair\n`);

console.log('Best (finds everything known, reports least):');
console.log('  families/100 files   largest   setting');
for (const r of complete.slice(0, 8)) {
  console.log(
    `  ${r.density.toFixed(1).padStart(18)}   ${String(r.largest).padStart(7)}   ${fmt(r.opts)}`,
  );
}

if (!complete.length) {
  console.log('  none — the known pairs are not reachable at any swept threshold.');
  console.log('  That is a detector problem, not a threshold problem.');
  for (const r of rows.slice(0, 3)) {
    console.log(`    best effort ${r.found}/${r.wanted}: ${fmt(r.opts)}`);
    for (const v of r.violations.slice(0, 4)) console.log(`      ${v}`);
  }
}

const missing = rows.filter((r) => r.found < r.wanted);
console.log(`\n${missing.length} settings miss at least one known pair.`);

const best = complete[0];
if (best) {
  console.log('\nAt the recommended setting, per fixture point:');
  for (const { point, graph, files } of graphs) {
    const families = reported(graph, best.opts);
    console.log(
      `  ${point.name.padEnd(16)} ${String(families.length).padStart(4)} families over ` +
        `${String(files).padStart(4)} files  ` +
        `(${((families.length / files) * 100).toFixed(1)} per 100)`,
    );
  }
  console.log(
    '\nRaw counts across points are not comparable — a later commit of a growing codebase has\n' +
      'more of everything. Density is the number to read.',
  );
}
process.exit(complete.length ? 0 : 1);
