import fs from 'node:fs';
import path from 'node:path';
import { mappedRoot, openDaylight, type DaylightContext } from '../mission/context.ts';
import { defaultOut } from '../paths.ts';
import type { ExpectedObservation } from '../mission/types.ts';
import { confirmDigest } from './confirm.ts';
import { DecisionRefused } from './policy.ts';
import {
  baseline, evaluate, GateRefused, listGates, lock, registerGate, type GateContext,
} from './gate.ts';

/**
 * `daylight gate add|baseline|lock|list|evaluate`. WS8 wires the dispatch; nothing here
 * edits `cli.ts` or `mission/commands.ts`.
 *
 * Same contract as the mission commands: `--out` (default: the repository's data dir),
 * `--format json` for one JSON document on stdout, exit 0 when the command ran (a falsified
 * baseline or a rejected candidate is data), 2 for bad arguments, 1 for a refusal or failure.
 *
 *   gate add <mission> --role gate|holdout --test <file> --expect-exit <n> --expect-stdout <s>…
 *            [--name <basename>] [--command node,--test,{test}]
 *   gate baseline <mission> [repo] [--only x_…,x_…] [--runs n] [--timeout s]
 *   gate lock <mission> --actor human:<name> --rationale '<why>' --confirm <digest8>
 *            [--accept-vacuous x_…,…] [--only x_…,…]
 *   gate list <mission>
 *   gate evaluate <candidate> [repo] [--runs n] [--timeout s]
 */

class Usage extends Error {}

interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
}

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let value: string;
    if (eq >= 0) value = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i];
    else value = 'true';
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { positionals, flags };
}

const last = (p: Parsed, k: string): string | undefined => p.flags.get(k)?.at(-1);
const all = (p: Parsed, k: string): string[] => p.flags.get(k) ?? [];
const need = (p: Parsed, k: string): string => {
  const v = last(p, k);
  if (v === undefined) throw new Usage(`--${k} is required`);
  return v;
};
const list = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Usage(`not a number: ${s}`);
  return n;
};

const json = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
const say = (line: string) => process.stdout.write(`${line}\n`);

/** The repository gates run against: the one named, else the one `<out>` is a map of. */
function repoFor(d: DaylightContext, named: string | undefined): string {
  const root = named ? path.resolve(named) : mappedRoot(d.out);
  if (!root) throw new Usage(`${d.out} holds no map; name the repository`);
  return root;
}

function gateContext(d: DaylightContext, repoRoot: string, p: Parsed): GateContext {
  const timeout = num(last(p, 'timeout'));
  return {
    store: d.store, artifacts: d.artifacts, events: d.events, repoRoot,
    runs: num(last(p, 'runs')), timeoutMs: timeout !== undefined ? timeout * 1000 : undefined,
  };
}

async function gate(sub: string | undefined, p: Parsed, out: () => string, asJson: boolean): Promise<number> {
  const withCtx = async <T>(fn: (d: DaylightContext) => Promise<T> | T): Promise<T> => {
    const d = openDaylight(out());
    try {
      return await fn(d);
    } finally {
      d.close();
    }
  };
  switch (sub) {
    case 'add': {
      const [missionId] = p.positionals;
      if (!missionId) throw new Usage('gate add needs a <mission-id>');
      const role = last(p, 'role');
      if (role !== 'gate' && role !== 'holdout') throw new Usage('--role gate|holdout is required and has no default');
      const testFile = need(p, 'test');
      const exit = num(last(p, 'expect-exit'));
      const prediction: ExpectedObservation = {
        ...(exit !== undefined ? { exitCode: exit } : {}),
        ...(all(p, 'expect-stdout').length ? { stdoutIncludes: all(p, 'expect-stdout') } : {}),
      };
      const x = await withCtx((d) => registerGate(gateContext(d, '', p), {
        missionId, role, prediction, testSource: fs.readFileSync(testFile, 'utf8'),
        basename: last(p, 'name') ?? path.basename(testFile),
        ...(last(p, 'command') ? { command: list(last(p, 'command')) } : {}),
      }));
      if (asJson) json(x);
      else say(`registered ${x.role} ${x.id} at ${x.testArtifact.path} (${x.harnessDigest})`);
      return 0;
    }
    case 'baseline': {
      const [missionId, repo] = p.positionals;
      if (!missionId) throw new Usage('gate baseline needs a <mission-id> [repo]');
      const only = list(last(p, 'only'));
      const rows = await withCtx((d) => baseline(gateContext(d, repoFor(d, repo), p), missionId, only.length ? { experimentIds: only } : {}));
      if (asJson) json(rows);
      else for (const g of rows) say(`${g.experimentId}: ${g.conclusion} on the base${g.conclusion === 'falsified' ? '' : g.conclusion === 'supported' ? ' (vacuous: it already passes)' : ' (never lockable)'}`);
      return 0;
    }
    case 'lock': {
      const [missionId] = p.positionals;
      if (!missionId) throw new Usage('gate lock needs a <mission-id>');
      const only = list(last(p, 'only'));
      const confirm = last(p, 'confirm');
      return await withCtx((d) => {
        const ctx = gateContext(d, '', p);
        const ids = only.length ? only : listGates(ctx, missionId).gates.map((g) => g.experimentId);
        if (confirm === undefined) {
          // The digest is shown, not the code: the person types the code from what they read.
          const preview = confirmDigest(ctx, 'lock-gates', missionId, { experimentIds: ids });
          if (asJson) json({ confirm: 'required', digest: preview.digest, lines: preview.lines });
          else {
            for (const l of preview.lines) say(l);
            say(`gate set ${preview.digest}`);
          }
          console.error('usage: re-run with --confirm <the first eight hex characters of the gate-set digest>');
          return 2;
        }
        const decision = lock(ctx, {
          missionId, actor: need(p, 'actor'), rationale: need(p, 'rationale'), confirm,
          acceptVacuous: list(last(p, 'accept-vacuous')), experimentIds: only.length ? only : undefined,
        });
        if (asJson) json(decision);
        else say(`locked ${String(decision.scope.gateSetDigest)} by ${decision.actor} (${decision.id})`);
        return 0;
      });
    }
    case 'list': {
      const [missionId] = p.positionals;
      if (!missionId) throw new Usage('gate list needs a <mission-id>');
      const l = await withCtx((d) => listGates(gateContext(d, '', p), missionId));
      if (asJson) json(l);
      else {
        say(l.lock ? `locked: ${l.lock.gateSetDigest}` : 'not locked');
        for (const g of l.gates) {
          say(`${g.role.padEnd(7)} ${g.experimentId} ${g.testPath ?? '(path withheld)'} baseline=${g.baseline ?? 'none'}${g.lockedBy ? ' locked' : ''}${g.vacuousOverride ? ' vacuous-accepted' : ''}`);
        }
      }
      return 0;
    }
    case 'evaluate': {
      const [candidateId, repo] = p.positionals;
      if (!candidateId) throw new Usage('gate evaluate needs a <candidate-id> [repo]');
      const c = await withCtx((d) => evaluate(gateContext(d, repoFor(d, repo), p), candidateId));
      if (asJson) json(c);
      else {
        say(`candidate ${c.id}: ${c.verdict}`);
        for (const r of c.verdictReasons) say(`  ${r}`);
      }
      return 0;
    }
    default:
      throw new Usage('gate needs one of: add, baseline, lock, list, evaluate');
  }
}

/** `argv` is everything after `gate`: the subcommand, then its arguments. */
export async function runGateCommand(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const p = parse(argv.slice(sub ? 1 : 0));
  const explicitOut = last(p, 'out');
  const asJson = last(p, 'format') === 'json';
  const repoArg = sub === 'baseline' || sub === 'evaluate' ? p.positionals[1] : undefined;
  let resolved: string | undefined;
  const out = () => (resolved ??= explicitOut ? path.resolve(explicitOut) : defaultOut(repoArg ?? process.cwd()));
  try {
    return await gate(sub, p, out, asJson);
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) json({ error: message, refused: err instanceof GateRefused || err instanceof DecisionRefused });
    console.error(`error: ${message}`);
    return 1;
  }
}
