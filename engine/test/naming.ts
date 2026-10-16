/**
 * No pre-rename identifiers. Run: node engine/test/naming.ts
 *
 * The product was renamed to Daylight Software Forge with no compatibility layer (R2, R3), so
 * the old CLI name, env prefix and package name must not survive anywhere a reader or a
 * program would take them as current. The frozen P0 records keep them verbatim by ruling
 * (R8.3), each under a banner, and are the only exemptions.
 *
 * The pattern is spelled with character classes so this file does not match itself. Bare
 * "desloppify" is the upstream third-party tool and is not an old name of ours.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Graph } from '../graph/types.ts';
import { evaluate, type Invariant } from '../invariants/engine.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const REPO = path.resolve(import.meta.dirname, '..', '..');

const OLD = new RegExp(`(?<![A-Za-z])[vV][dD][sS](?![a-z])|(?<=[a-z])V[dD][sS](?![a-z])|visual-${'desloppify'}`, 'g');

/** Frozen records (R8.3), plus generated files whose bytes are not identifiers. */
const EXEMPT = new Set([
  'TODO.md',
  'docs/daylight/BASELINE.md',
  'docs/daylight/MEASURED.md',
  'docs/daylight/ACCEPTANCE.md',
  'docs/daylight/PLAN.md',
  'docs/daylight/FORGE_PLAN.md',
  'docs/DAYLIGHT_SPEC_v0.1.md',
  'pnpm-lock.yaml',
]);
const exempt = (file: string) => EXEMPT.has(file) || file.startsWith('.codemap/');
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf)$/i;

const tracked = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);

section('old names in tracked files');
check('the repository lists its files', tracked.length > 50, String(tracked.length));

const hits: string[] = [];
for (const file of tracked) {
  if (exempt(file) || BINARY.test(file)) continue;
  const abs = path.join(REPO, file);
  if (!fs.existsSync(abs)) continue;
  // latin1, not utf8: a few sources carry literal NUL bytes, and nothing here may be skipped
  // for looking binary.
  const lines = fs.readFileSync(abs).toString('latin1').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(OLD)) hits.push(`${file}:${i + 1}: ${m[0]}`);
  });
  if (OLD.test(file)) hits.push(`${file}: (file name)`);
  OLD.lastIndex = 0;
}
check('no old CLI name, env prefix or package name outside the frozen records',
  hits.length === 0, `${hits.length} hit(s):\n    ${hits.slice(0, 20).join('\n    ')}`);

section('daylight check carries the graph half of the rule');
{
  const all = JSON.parse(fs.readFileSync(path.join(REPO, 'daylight.invariants.json'), 'utf8')) as Invariant[];
  const inv = all.find((i) => i.id === 'no-pre-rename-identifiers');
  check('this repo declares the invariant', !!inv);
  const statusFor = (name: string) => inv
    ? evaluate({ nodes: [{ id: `a.ts#${name}`, kind: 'variable', name, file: 'a.ts', line: 1 }] } as unknown as Graph, inv).status
    : 'missing';
  const OLD_NAMES = ['v' + 'ds', 'v' + 'dsScene', 'V' + 'DS_DIR', 'V' + 'dsEvent', 'events' + 'V' + 'ds', 'x.v' + 'ds.ts'];
  for (const name of OLD_NAMES) check(`a symbol named ${name} is red`, statusFor(name) === 'red', statusFor(name));
  for (const name of ['daylight', 'DAYLIGHT_DIR', 'advdsx', 'desloppify']) {
    check(`a symbol named ${name} is green`, statusFor(name) === 'green', statusFor(name));
  }
}

section('the exemptions are the frozen records, and they say so');
for (const file of [...EXEMPT].filter((f) => f.endsWith('.md'))) {
  const abs = path.join(REPO, file);
  if (!fs.existsSync(abs)) continue;
  const first = fs.readFileSync(abs, 'utf8').split('\n')[0];
  // FORGE_PLAN.md is exempt for its history sections but is a live document, not a record.
  if (file === 'docs/daylight/FORGE_PLAN.md') continue;
  check(`${file} carries the P0-record banner`, first.startsWith('> **P0 record, kept verbatim.**'), first);
}

done();
