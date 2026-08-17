import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Optional third-party reachability providers.
 *
 * Our dead-code detection is syntactic and says so, which is honest but not reassuring. An
 * independent tool agreeing is worth more than any amount of caveat text, and an independent
 * tool *disagreeing* is worth more still — that is a finding about our analysis, and it goes
 * to the same arbitration screen as any other disagreement.
 *
 * Three rules, none negotiable:
 *
 *  - **Nothing is installed, ever.** A provider is used only if it is already resolvable from
 *    the analysed repo's `node_modules/.bin`. No `npx`, which would fetch and execute a
 *    package from the network on a repo the user merely asked us to *read*.
 *  - **Absent is a normal answer.** No provider installed is the common case and reports as
 *    "not available", never as an error or a silent zero.
 *  - **Their output is untrusted input.** It is parsed defensively, bounded in size, and only
 *    ever produces file paths that we then match against nodes we found ourselves. A provider
 *    cannot introduce a node, only corroborate or dispute one.
 *
 * These tools do execute the repo's config file, which is a real trust boundary — but it is
 * one the user already crossed by installing them into that repo, and we cross nothing new.
 */

export type ProviderName = 'knip' | 'dependency-cruiser';

export interface ProviderResult {
  provider: ProviderName;
  /** Absent when the tool is not installed in the analysed repo. */
  available: boolean;
  /** Files the provider considers unused. Empty when unavailable. */
  unused: string[];
  /** Why there is no result, when there is none. */
  note?: string;
}

export interface CrossCheck {
  provider: ProviderName;
  /** Both we and they call it dead. The strongest dead-code signal available. */
  agreed: string[];
  /** We call it dead, they do not — worth demoting. */
  weOnly: string[];
  /** They call it dead, we do not — worth investigating; our resolution may be over-eager. */
  theyOnly: string[];
}

const BIN: Record<ProviderName, string> = {
  knip: 'knip',
  'dependency-cruiser': 'depcruise',
};

/** Resolvable from the repo's own node_modules, or not at all. */
function localBinary(repo: string, provider: ProviderName): string | null {
  const bin = path.join(repo, 'node_modules', '.bin', BIN[provider]);
  return fs.existsSync(bin) ? bin : null;
}

function run(bin: string, args: string[], repo: string): { out: string } | { error: string } {
  const r = spawnSync(bin, args, {
    cwd: repo,
    encoding: 'utf8',
    // Their config may import the repo's own code; a hung provider must not hang the map.
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return { error: r.error.message };
  // Both tools exit non-zero when they *find* something, so a non-zero status is not a
  // failure — only unparseable output is.
  if (!r.stdout?.trim()) return { error: r.stderr?.trim().slice(0, 400) || 'no output' };
  return { out: r.stdout };
}

/** Anything shaped like a repo-relative source path, from a structure we do not control. */
function harvestPaths(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 8 || into.size > 20_000) return;
  if (typeof value === 'string') {
    if (/^[\w./@-]+\.[cm]?[jt]sx?$/.test(value)) into.add(value.replace(/^\.\//, ''));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) harvestPaths(v, into, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) harvestPaths(v, into, depth + 1);
  }
}

export function runProvider(repo: string, provider: ProviderName): ProviderResult {
  const bin = localBinary(repo, provider);
  if (!bin) {
    return {
      provider,
      available: false,
      unused: [],
      note: `${BIN[provider]} is not installed in this repo — nothing was installed to find out`,
    };
  }

  const args = provider === 'knip'
    ? ['--reporter', 'json', '--no-exit-code']
    : ['--output-type', 'json', '--no-config', 'src'];

  const r = run(bin, args, repo);
  if ('error' in r) return { provider, available: true, unused: [], note: r.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.out);
  } catch (err) {
    return {
      provider,
      available: true,
      unused: [],
      note: `output did not parse: ${(err as Error).message}`,
    };
  }

  const unused = new Set<string>();
  if (provider === 'knip') {
    // knip's shape has moved between versions, so harvest the `files` section rather than
    // hard-coding a path through it — a schema guess that breaks silently is worse than none.
    const files = (parsed as { files?: unknown }).files;
    harvestPaths(files ?? parsed, unused);
  } else {
    const modules = (parsed as { modules?: Array<{ source?: string; orphan?: boolean }> }).modules;
    for (const m of modules ?? []) {
      if (m.orphan && typeof m.source === 'string') unused.add(m.source.replace(/^\.\//, ''));
    }
  }

  return { provider, available: true, unused: [...unused].sort() };
}

/**
 * Compare a provider against our own dead-code candidates.
 *
 * Deliberately three buckets rather than a merged verdict. Agreement raises confidence,
 * but the two disagreements mean different things and want different responses: what only we
 * flag is probably our syntactic resolution being over-eager, and what only they flag is a
 * caller we resolved and they did not — or one we invented.
 */
export function crossCheck(ours: string[], result: ProviderResult): CrossCheck | null {
  if (!result.available || result.note) return null;
  const we = new Set(ours);
  const they = new Set(result.unused);
  return {
    provider: result.provider,
    agreed: [...we].filter((f) => they.has(f)).sort(),
    weOnly: [...we].filter((f) => !they.has(f)).sort(),
    theyOnly: [...they].filter((f) => !we.has(f)).sort(),
  };
}
