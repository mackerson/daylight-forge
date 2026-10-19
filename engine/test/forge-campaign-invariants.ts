/**
 * The WS-R5 entries in daylight.invariants.json go red on a violation. Run: node engine/test/forge-campaign-invariants.ts
 *
 * Each entry is read from the repository's own file and run by `daylight check` against a small
 * repository laid out like engine/, first satisfied and then broken. derived-writer-callers gets
 * the fourth-caller test P2-R26 asks for; it also shows why the entry is a forbidden-callee: the
 * forbidden-call form the design named is green with a fourth caller, because the graph has no
 * call edge for a method reached through `ctx.store`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'engine', 'cli.ts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-campaign-inv-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

interface Inv { id: string; prose: string; predicate: Record<string, unknown> }
const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'daylight.invariants.json'), 'utf8')) as Inv[];
const entry = (id: string): Inv => {
  const e = all.find((x) => x.id === id);
  if (!e) throw new Error(`daylight.invariants.json has no ${id}`);
  return e;
};

/** `daylight check` over `files` with exactly `invariants`; the exit code and output. */
function checkRepo(name: string, files: Record<string, string>, invariants: Inv[]): { code: number; out: string } {
  const root = path.join(tmp, name);
  for (const [rel, text] of Object.entries({ 'package.json': '{"name":"fx","type":"module"}\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  fs.writeFileSync(path.join(root, 'daylight.invariants.json'), JSON.stringify(invariants));
  const out = path.join(root, 'out');
  const run = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };
  run(['map', root, '--out', out, '--top', '0']);
  return run(['check', root, '--out', out]);
}

const STORE = `export class MissionStore {
  recordDerivedDecision(parent: string): string { return parent; }
  approvePlan(): string { return this.recordDerivedDecision('d'); }
}
`;
const CONTEXT = `import { MissionStore } from './store.ts';
export interface DaylightContext { store: MissionStore }
`;
const CALLER = `import type { DaylightContext } from '../mission/context.ts';
export function derive(ctx: DaylightContext): string { return ctx.store.recordDerivedDecision('d'); }
`;
const WRITERS = {
  'engine/mission/store.ts': STORE, 'engine/mission/context.ts': CONTEXT,
  'engine/forge/campaign.ts': CALLER, 'engine/forge/integrate.ts': CALLER,
};

section('derived-writer-callers (P2-R26)');
{
  const inv = entry('derived-writer-callers');
  const green = checkRepo('writers', WRITERS, [inv]);
  check('the store, campaign.ts and integrate.ts may call recordDerivedDecision', green.code === 0, green.out);
  const red = checkRepo('fourth', { ...WRITERS, 'engine/forge/x.ts': CALLER }, [inv]);
  check('a fourth caller, engine/forge/x.ts, turns it red', red.code === 1 && /RED\s+derived-writer-callers/.test(red.out) && red.out.includes('engine/forge/x.ts'), red.out);
  const aside = checkRepo('aside', { ...WRITERS, 'engine/forge/campaign-other.ts': CALLER }, [inv]);
  check('a file whose name only starts like an allowed one is still a fourth caller', aside.code === 1, aside.out);
  const design: Inv = { ...inv, id: 'as-designed', predicate: { type: 'forbidden-call', from: inv.predicate.within as object, to: { name: '^recordDerivedDecision$' } } };
  const vacuous = checkRepo('designed', { ...WRITERS, 'engine/forge/x.ts': CALLER }, [design]);
  check('the forbidden-call form the design named does not see the fourth caller (why this is a forbidden-callee)', vacuous.code === 0, vacuous.out);
}

section('no-derived-human-ops');
{
  const inv = entry('no-derived-human-ops');
  const asks = (n: number) => `import { isCampaignActor } from './types.ts';\nexport const f = (a: string) => [${Array.from({ length: n }, () => 'isCampaignActor(a)').join(', ')}];\n`;
  const types = { 'engine/mission/types.ts': 'export const isCampaignActor = (a: string) => a.startsWith("campaign:");\n' };
  check('green while the store asks', checkRepo('asks', { ...types, 'engine/mission/store.ts': asks(4) }, [inv]).code === 0);
  check('red when the store stops asking', checkRepo('stops', { ...types, 'engine/mission/store.ts': asks(1) }, [inv]).code === 1);
}

section('campaign-cli-refuses-agent-sessions and campaign-decisions-pass-the-guard');
{
  const cliInv = entry('campaign-cli-refuses-agent-sessions');
  const refuse = 'export const sessionRefusal = (e: Record<string, string>) => e.CLAUDECODE ?? null;\nexport const run = (e: Record<string, string>) => sessionRefusal(e);\n';
  check('green while the campaign CLI calls sessionRefusal', checkRepo('cli-ok', { 'engine/forge/commands-campaign.ts': refuse }, [cliInv]).code === 0);
  check('red when it does not', checkRepo('cli-bad', { 'engine/forge/commands-campaign.ts': 'export const run = () => 0;\n' }, [cliInv]).code === 1);
  const guardInv = entry('campaign-decisions-pass-the-guard');
  const guard = (n: number) => `import { assertHumanDecision } from './policy.ts';\n${Array.from({ length: n }, (_, i) => `export const a${i} = () => assertHumanDecision();`).join('\n')}\n`;
  const policy = { 'engine/forge/policy.ts': 'export const assertHumanDecision = () => undefined;\n' };
  check('green with every act guarded', checkRepo('guard-ok', { ...policy, 'engine/forge/campaign.ts': guard(4), 'engine/forge/assumptions.ts': guard(2) }, [guardInv]).code === 0);
  check('red when an act stops calling the guard', checkRepo('guard-bad', { ...policy, 'engine/forge/campaign.ts': guard(3), 'engine/forge/assumptions.ts': guard(2) }, [guardInv]).code === 1);
}

done();
