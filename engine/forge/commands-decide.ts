import path from 'node:path';
import { mappedRoot, openDaylight, type DaylightContext } from '../mission/context.ts';
import { defaultOut } from '../paths.ts';
import { ApplyFailed, applyCandidate } from './apply.ts';
import { confirmDigest } from './confirm.ts';
import { CandidateRefused, decideCandidate, type CandidateOperation } from './decide.ts';
import { DecisionRefused } from './policy.ts';

/**
 * `daylight forge approve|reject|override|apply`. WS8 wires the dispatch; nothing here edits
 * `cli.ts` or `mission/commands.ts`.
 *
 * Same contract as the gate commands: `--out`, `--format json`, exit 0 when the act was
 * recorded, 2 for bad arguments or a missing `--confirm` (the digest is printed so a person
 * can read it and type the code), 1 for a refusal or failure.
 *
 *   forge approve  <candidate> --actor human:<name> --rationale '<why>' --confirm <digest8> [--subject '<title>'] [--acknowledge-possible-secret]
 *   forge override <candidate> --actor human:<name> --rationale '<why>' --confirm <digest8> [--subject '<title>'] [--acknowledge-possible-secret]
 *   forge reject   <candidate> --actor human:<name> --rationale '<why>' --confirm <digest8>
 *   forge apply    <candidate> [repo] --actor human:<name> --confirm <digest8>
 */

class Usage extends Error {}

interface Parsed {
  positionals: string[];
  flags: Map<string, string>;
}

function parse(argv: string[]): Parsed {
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

const need = (p: Parsed, k: string): string => {
  const v = p.flags.get(k);
  if (v === undefined) throw new Usage(`--${k} is required`);
  return v;
};
const json = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
const say = (line: string) => process.stdout.write(`${line}\n`);

const OPS: Record<string, CandidateOperation> = {
  approve: 'approve-candidate', reject: 'reject-candidate', override: 'override-candidate',
};

function repoFor(d: DaylightContext, named: string | undefined): string {
  const root = named ? path.resolve(named) : mappedRoot(d.out);
  if (!root) throw new Usage(`${d.out} holds no map; name the repository`);
  return root;
}

/** Without `--confirm`: show what would be confirmed and stop. */
function preview(digest: string, lines: string[], asJson: boolean): number {
  if (asJson) json({ confirm: 'required', digest, lines });
  else {
    for (const l of lines) say(l);
    say(`digest ${digest}`);
  }
  console.error('usage: re-run with --confirm <the first eight hex characters of the digest>');
  return 2;
}

function forge(sub: string | undefined, p: Parsed, d: DaylightContext, asJson: boolean): number {
  const [candidateId, repo] = p.positionals;
  if (!sub || !(sub in OPS || sub === 'apply')) throw new Usage('forge needs one of: approve, reject, override, apply');
  if (!candidateId) throw new Usage(`forge ${sub} needs a <candidate-id>`);
  const actor = need(p, 'actor');
  const confirm = p.flags.get('confirm');
  const c = d.store.candidate(candidateId);
  if (!c) throw new CandidateRefused(`unknown candidate ${candidateId}`);
  const ctx = { store: d.store, artifacts: d.artifacts, events: d.events, repoRoot: repoFor(d, repo) };

  if (sub === 'apply') {
    if (confirm === undefined) {
      const v = confirmDigest(ctx, 'apply', candidateId);
      return preview(v.digest, v.lines, asJson);
    }
    const r = applyCandidate(ctx, { candidateId, actor, confirm });
    if (asJson) json(r);
    else say(`applied ${candidateId} as ${r.commit} on ${r.ref} (${r.application.id}); merge it yourself`);
    return 0;
  }
  const operation = OPS[sub];
  if (confirm === undefined) {
    const v = confirmDigest(ctx, operation, candidateId);
    return preview(v.digest, v.lines, asJson);
  }
  const decision = decideCandidate(ctx, {
    candidateId, operation, actor, rationale: need(p, 'rationale'), confirm, subject: p.flags.get('subject'),
    acknowledgePossibleSecret: p.flags.get('acknowledge-possible-secret') === 'true',
  });
  if (asJson) json(decision);
  else say(`${decision.kind} ${candidateId} by ${decision.actor} (${decision.id})${decision.kind === 'override' ? ' — OVERRIDE of the gates' : ''}`);
  return 0;
}

/** `argv` is everything after `forge`: the subcommand, then its arguments. */
export async function runDecideCommand(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const p = parse(argv.slice(sub ? 1 : 0));
  const asJson = p.flags.get('format') === 'json';
  const explicitOut = p.flags.get('out');
  try {
    const out = explicitOut ? path.resolve(explicitOut) : defaultOut(p.positionals[1] ?? process.cwd());
    const d = openDaylight(out);
    try {
      return forge(sub, p, d, asJson);
    } finally {
      d.close();
    }
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    const refused = err instanceof CandidateRefused || err instanceof DecisionRefused;
    if (asJson) json({ error: message, refused, failed: err instanceof ApplyFailed });
    console.error(`error: ${message}`);
    return 1;
  }
}
