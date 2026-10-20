/**
 * The static half of WS-R6's invariants: each is registered, green on what the code does, and
 * red on the breach it guards. Run: node engine/test/forge-campaign-integrate-invariants.ts
 *
 * The row halves are in forge-campaign-integrate-ref.ts (integrationRefusals, CAS, hooks, HEAD),
 * forge-campaign-run-director.ts (spend, holdouts in briefs and events) and
 * forge-campaign-integrate-verdict.ts (campaign-verdict-is-pure, with its own red test).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Graph } from '../graph/types.ts';
import { evaluate, type Invariant } from '../invariants/engine.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const invariants = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'daylight.invariants.json'), 'utf8')) as Invariant[];
const calls = (cs: Array<[string, string]>) => ({ nodes: [], edges: [], literals: [], calls: cs.map(([file, callee]) => ({ file, callee, line: 1 })) }) as unknown as Graph;
const status = (id: string, g: Graph) => {
  const inv = invariants.find((i) => i.id === id);
  return inv ? evaluate(g, inv).status : 'missing';
};

section('director-spawns-nothing');
check('green: the director calls gitIn and runImplement', status('director-spawns-nothing', calls([['engine/forge/director.ts', 'gitIn'], ['engine/forge/director.ts', 'runImplement']])) === 'green');
for (const [file, callee] of [['engine/forge/director.ts', 'execFileSync'], ['engine/forge/wave.ts', 'child_process.spawn'], ['engine/forge/campaign-gates.ts', 'spawnSync'],
  ['engine/forge/commands-campaign-run.ts', 'execSync']]) {
  check(`red: ${file} calling ${callee}`, status('director-spawns-nothing', calls([[file, callee]])) === 'red');
}
check('integrate.ts and apply.ts are where git runs, and are not in its scope', status('director-spawns-nothing', calls([['engine/forge/integrate.ts', 'spawnSync']])) === 'green');

section('integrate-calls-cas-ref (a call count; the CAS itself is forge-campaign-integrate-ref.ts)');
const cas = (n: number) => calls(Array.from({ length: n }, () => ['engine/forge/integrate.ts', 'casRef'] as [string, string]));
check('green with the landing, its undo and the resume undo', status('integrate-calls-cas-ref', cas(3)) === 'green');
check('red when a compare-and-swap is dropped', status('integrate-calls-cas-ref', cas(2)) === 'red');

section('director-asks-spend-refusal (a call count; the cap itself is forge-campaign-run-director.ts)');
const spend = (n: number) => calls(Array.from({ length: n }, () => ['engine/forge/director.ts', 'campaignSpendRefusal'] as [string, string]));
check('green with the launch, review and dry-run checks', status('director-asks-spend-refusal', spend(3)) === 'green');
check('red when one path stops asking', status('director-asks-spend-refusal', spend(2)) === 'red');

section('director-redacts-brief-text (a call count; holdout secrecy is forge-campaign-run-director.ts)');
const red = (n: number) => calls(Array.from({ length: n }, () => ['engine/forge/director.ts', 'redact'] as [string, string]));
check('green with every brief text redacted', status('director-redacts-brief-text', red(3)) === 'green');
check('red when one is not', status('director-redacts-brief-text', red(2)) === 'red');

section('campaign-verdict-is-pure is registered (its red test is in forge-campaign-integrate-verdict.ts)');
check('registered', invariants.some((i) => i.id === 'campaign-verdict-is-pure'));

done();
