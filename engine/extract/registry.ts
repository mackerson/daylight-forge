import { TypeScriptParser } from './ts-parser.ts';
import type { Parser } from './parser.ts';

/**
 * Which language providers are in play.
 *
 * The graph schema has always been language-neutral — nodes, edges, shapes, functions, calls,
 * literals describe any language — but the extractor constructed a `TypeScriptParser` directly,
 * so the seam existed on paper and had never carried weight. An interface with one
 * implementation is a guess about what a second one would need.
 *
 * This makes the seam real: providers are looked up by file extension, several can coexist,
 * and the parse cache is keyed per provider so two of them never hand each other's records
 * back. `engine/test/registry.ts` drives a second, deliberately non-TypeScript provider all
 * the way through to edges and detector findings, which is the only way to know the seam fits.
 *
 * **Loading a provider runs its code.** `DAYLIGHT_PARSERS` takes a comma-separated list of module
 * paths, and importing a module executes it — so this is a code-execution surface by
 * construction, in the same way a plugin system is. It is opt-in, it names what it loaded,
 * and a provider that fails to load is reported rather than swallowed. Do not point it at
 * anything you have not read.
 */

export interface RegistryResult {
  parsers: Parser[];
  /** Providers that were asked for and could not be loaded, with the reason. */
  failures: Array<{ spec: string; reason: string }>;
}

export function builtinParsers(): Parser[] {
  return [new TypeScriptParser()];
}

/**
 * Providers opted into for this process.
 *
 * Process-wide rather than threaded through every call, because that is what it is: a
 * configuration the user set once, on the command line, for the whole run. `extract()` still
 * takes an explicit `parsers` option, which is how the tests drive the seam without touching
 * this — global state that cannot be bypassed is the version of this worth avoiding.
 */
let extra: Parser[] = [];

export function activeParsers(): Parser[] {
  return [...builtinParsers(), ...extra];
}

export function registerParsers(parsers: Parser[]): void {
  extra = parsers.filter((p) => !claimedExtensions(builtinParsers()).has(p.extensions[0]));
}

/**
 * Pick the provider for a path, or none.
 *
 * First match wins, and the built-in is first, so an added provider cannot quietly take over
 * `.ts` and change what every existing claim was made about.
 */
export function parserFor(parsers: Parser[], relPath: string): Parser | undefined {
  const dot = relPath.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = relPath.slice(dot);
  return parsers.find((p) => p.extensions.includes(ext));
}

/** Every extension any loaded provider claims. */
export function claimedExtensions(parsers: Parser[]): Set<string> {
  const out = new Set<string>();
  for (const p of parsers) for (const e of p.extensions) out.add(e);
  return out;
}

function isParser(value: unknown): value is Parser {
  const p = value as Parser | undefined;
  return (
    !!p &&
    typeof p.name === 'string' &&
    Array.isArray(p.extensions) &&
    p.extensions.every((e) => typeof e === 'string' && e.startsWith('.')) &&
    typeof p.parse === 'function'
  );
}

/**
 * Load the providers named in `DAYLIGHT_PARSERS`, on top of the built-ins.
 *
 * A module may default-export a parser, export `parser`, or export a `createParser()`. All
 * three are checked because a provider written by someone else should not have to guess our
 * preference, and the shape is validated before it is trusted with a file.
 */
export async function loadParsers(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegistryResult> {
  const parsers = builtinParsers();
  const loaded: Parser[] = [];
  const failures: RegistryResult['failures'] = [];

  const specs = (env.DAYLIGHT_PARSERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const spec of specs) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      const candidate =
        typeof mod.createParser === 'function'
          ? (mod.createParser as () => unknown)()
          : (mod.parser ?? mod.default);

      if (!isParser(candidate)) {
        failures.push({ spec, reason: 'does not export a parser with name, extensions and parse' });
        continue;
      }
      const taken = claimedExtensions(parsers);
      const overlap = candidate.extensions.filter((e) => taken.has(e));
      if (overlap.length) {
        // Silently letting a provider shadow another changes what every existing claim about
        // those files was made about, without anything in the map saying so.
        failures.push({
          spec,
          reason: `claims ${overlap.join(', ')}, already handled by another provider`,
        });
        continue;
      }
      parsers.push(candidate);
      loaded.push(candidate);
      console.log(`loaded parser '${candidate.name}' from ${spec} for ${candidate.extensions.join(', ')}`);
    } catch (err) {
      failures.push({ spec, reason: (err as Error).message });
    }
  }

  registerParsers(loaded);
  return { parsers, failures };
}
