import path from 'node:path';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { defaultOut } from '../paths.ts';
import { actorFor, Usage as ForgeUsage } from './commands.ts';
import {
  dependencyRequests, DependencyRequestRefused, findDependencyRequest, resolveConfirm, resolveDependencyRequest,
} from './dependency-requests.ts';
import { DecisionRefused } from './policy.ts';

/**
 * `daylight deps requests|resolve` (RULINGS P2-R4). The `deps` noun is shared with WS-R2's
 * `snapshot` and `status`; the director wires both under one dispatcher, so nothing here edits
 * `cli.ts`.
 *
 *   deps requests [--mission <m>] [--format json]
 *   deps resolve  <request-id> [--declined] --rationale '<why>' --confirm <digest8>
 *
 * Same contract as the other Forge commands: `--out` (default: this directory's data dir),
 * `--format json`, exit 0 when it ran, 2 for bad arguments or a missing `--confirm` (the digest
 * is printed so a person can read it), 1 for a refusal or failure. `resolve` records a human
 * decision and nothing else: it edits no manifest and runs no snapshot, and says what to run.
 */

export const DEPS_REQUESTS_SUBCOMMANDS = ['requests', 'resolve'] as const;

class Usage extends Error {}

export interface Parsed {
  positionals: string[];
  flags: Map<string, string>;
}

/** The `deps` noun's argv: `--k v`, `--k=v`, a bare `--k` as `'true'`, the rest positional. Shared with commands-deps.ts. */
export function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (eq >= 0) flags.set(key, a.slice(eq + 1));
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags.set(key, argv[++i]);
    else flags.set(key, 'true');
  }
  return { positionals, flags };
}

const json = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
const say = (line: string) => process.stdout.write(`${line}\n`);

function requests(p: Parsed, d: DaylightContext, asJson: boolean): number {
  const missionId = p.flags.get('mission');
  if (missionId === 'true') throw new Usage('--mission needs a mission id');
  if (missionId && !d.store.mission(missionId)) throw new DependencyRequestRefused(`unknown mission ${missionId}`);
  const { requests: rows, skipped } = dependencyRequests(d, { missionId });
  if (asJson) {
    json({ requests: rows, skipped });
    return 0;
  }
  if (!rows.length) say('no dependency requests');
  for (const r of rows) {
    say(`${r.id}  ${r.status.padEnd(8)}  ${r.ecosystem} ${r.name}${r.version ? ` ${r.version}` : ''}  mission ${r.missionId}  (${r.attemptIds.length} attempt(s))`);
    // The reason is the author's text: checked, capped and masked, but still a claim.
    say(`  reason (from the author, unverified): ${r.reason.replace(/\s+/g, ' ')}`);
    if (r.decisionId) say(`  resolved by decision ${r.decisionId}`);
  }
  // Lines that were not valid requests: a tampered or torn outbox shows here, never silently.
  say(`skipped: ${skipped} malformed outbox line(s)`);
  return 0;
}

function resolve(p: Parsed, d: DaylightContext, asJson: boolean, env: NodeJS.ProcessEnv): number {
  const requestId = p.positionals[0];
  if (!requestId) throw new Usage('deps resolve needs a <request-id>');
  const confirm = p.flags.get('confirm');
  const declined = p.flags.get('declined') === 'true';
  if (confirm === undefined) {
    const c = resolveConfirm(findDependencyRequest(d, requestId), { declined });
    if (asJson) json({ confirm: 'required', digest: c.digest, lines: c.lines });
    else {
      for (const l of c.lines) say(l);
      say(`digest ${c.digest}`);
    }
    console.error('usage: re-run with --confirm <the first eight hex characters of the digest>');
    return 2;
  }
  const actor = actorFor(p.flags.get('actor'));
  const r = resolveDependencyRequest(d, { requestId, actor, rationale: p.flags.get('rationale'), confirm, env, declined });
  if (asJson) json(r);
  else {
    say(`${declined ? 'declined' : 'resolved'} ${r.request.id} (${r.request.ecosystem} ${r.request.name}) by ${actor} (${r.decision.id})`);
    say('nothing was installed and no manifest was changed');
    say(`next: ${r.next}`);
  }
  return 0;
}

/** `argv` is everything after `deps`: `requests` or `resolve`, then its arguments. */
export async function runDepsRequestsCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const p = parse(argv.slice(sub ? 1 : 0));
  const asJson = p.flags.get('format') === 'json';
  try {
    if (sub !== 'requests' && sub !== 'resolve') throw new Usage(`deps needs one of: ${DEPS_REQUESTS_SUBCOMMANDS.join(', ')}`);
    const explicitOut = p.flags.get('out');
    const out = explicitOut && explicitOut !== 'true' ? path.resolve(explicitOut) : defaultOut(process.cwd());
    const d = openDaylight(out);
    try {
      return sub === 'requests' ? requests(p, d, asJson) : resolve(p, d, asJson, env);
    } finally {
      d.close();
    }
  } catch (err) {
    if (err instanceof Usage || err instanceof ForgeUsage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    const refused = err instanceof DependencyRequestRefused || err instanceof DecisionRefused;
    if (asJson) json({ error: message, refused });
    console.error(`error: ${message}`);
    return 1;
  }
}
