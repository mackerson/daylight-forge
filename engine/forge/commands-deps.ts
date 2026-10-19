import path from 'node:path';
import { defaultOut } from '../paths.ts';
import { CargoRefused, createSnapshot, snapshotStatus } from './cargo.ts';

/**
 * `daylight deps snapshot|status`: the crate snapshot a Rust repository's gates and author
 * builds run offline against (forge/cargo.ts, docs/daylight/CARGO.md).
 *
 * Same contract as the other Forge commands: `--out` (default: the repository's data dir),
 * `--format json` for one JSON document on stdout, exit 0 when the command ran (a lock that no
 * longer matches is data), 2 for bad arguments, 1 for a refusal or a failure.
 *
 *   deps snapshot <repo> [--out <dir>]   # cargo fetch --locked, on the host, with network
 *   deps status   <repo> [--out <dir>]   # recorded digest, lock match, cache sizes
 */

class Usage extends Error {}

const json = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
const say = (line: string) => process.stdout.write(`${line}\n`);

function parse(argv: string[]): { positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags.set(a.slice(2), argv[++i]);
    else flags.set(a.slice(2), 'true');
  }
  return { positionals, flags };
}

const mib = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;

/** `argv` is everything after `deps`: the subcommand, then its arguments. */
export function runDepsCommand(argv: string[]): number {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const p = parse(argv.slice(sub ? 1 : 0));
  const asJson = p.flags.get('format') === 'json';
  try {
    const [repoArg] = p.positionals;
    if (sub !== 'snapshot' && sub !== 'status') throw new Usage('deps needs one of: snapshot, status');
    if (!repoArg) throw new Usage(`deps ${sub} needs a <repo>`);
    const repo = path.resolve(repoArg);
    const explicit = p.flags.get('out');
    if (explicit === 'true') throw new Usage('--out needs a directory');
    const out = explicit ? path.resolve(explicit) : defaultOut(repo);
    if (sub === 'snapshot') {
      const r = createSnapshot(repo, out);
      if (asJson) json(r);
      else {
        say(`snapshot ${r.digest} (${r.files} files, ${mib(r.bytes)})`);
        say(`for Cargo.lock ${r.lockDigest}`);
        say(`in ${path.join(out, 'cargo', 'snapshot')}`);
      }
      return 0;
    }
    const s = snapshotStatus(repo, out, { verify: true });
    if (asJson) json(s);
    else {
      say(s.recorded ? `snapshot ${s.recorded.digest} (${s.recorded.files} files, ${mib(s.recorded.bytes)}, ${s.recorded.createdAt})` : 'snapshot none');
      say(`snapshot on disk ${s.intact === null ? 'not checked' : s.intact ? 'matches its digest' : 'no longer matches its digest'}`);
      say(`Cargo.lock ${s.lockDigest ?? 'missing'} ${s.lockMatches ? 'matches' : 'does not match'} the snapshot`);
      say(`cache author ${mib(s.caches.author)} · gate ${mib(s.caches.gate)}`);
      if (s.refusal) say(`refused: ${s.refusal}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) json({ error: message, refused: err instanceof CargoRefused });
    console.error(`error: ${message}`);
    return 1;
  }
}
