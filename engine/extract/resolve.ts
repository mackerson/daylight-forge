import path from 'node:path';
import ts from 'typescript';

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export interface PathAlias {
  /** e.g. `@/` from a `@/*` tsconfig path. */
  prefix: string;
  /** Candidate roots, repo-relative, e.g. `src/`. */
  targets: string[];
}

/**
 * Resolves an import specifier to a repo-relative file, or null when it's external.
 *
 * Deliberately syntactic: no type information, no node_modules walking. It resolves
 * what a bundler would resolve for first-party code and calls everything else external,
 * which is the right trade at L0 — see DESIGN.md, "tree-sitter skeleton".
 */
export class Resolver {
  /** Repo-relative paths of every file we know about, for existence checks. */
  private readonly known: Set<string>;
  private readonly aliases: PathAlias[];

  constructor(files: Iterable<string>, aliases: PathAlias[] = []) {
    this.known = new Set(files);
    this.aliases = aliases;
  }

  /** Returns the resolved repo-relative path, or null if external/unresolvable. */
  resolve(spec: string, fromFile: string): string | null {
    if (spec.startsWith('.')) {
      const base = path.posix.join(path.posix.dirname(fromFile), spec);
      return this.tryCandidates(base);
    }

    for (const alias of this.aliases) {
      if (!spec.startsWith(alias.prefix)) continue;
      const rest = spec.slice(alias.prefix.length);
      for (const target of alias.targets) {
        const hit = this.tryCandidates(path.posix.join(target, rest));
        if (hit) return hit;
      }
    }

    return null;
  }

  private tryCandidates(base: string): string | null {
    const normalized = base.replace(/\\/g, '/').replace(/^\.\//, '');

    if (this.known.has(normalized)) return normalized;

    // ESM-style `./foo.js` frequently means `./foo.ts` in a TS source tree.
    const stripped = normalized.replace(/\.(js|mjs|cjs|jsx)$/, '');
    for (const candidate of [normalized, stripped]) {
      for (const ext of EXTENSIONS) {
        const withExt = candidate + ext;
        if (this.known.has(withExt)) return withExt;
      }
      for (const ext of EXTENSIONS) {
        const asIndex = path.posix.join(candidate, `index${ext}`);
        if (this.known.has(asIndex)) return asIndex;
      }
    }

    return null;
  }
}

/**
 * Reads `compilerOptions.paths` out of a tsconfig.
 *
 * Uses TypeScript's own JSONC parser rather than stripping comments by regex. The
 * hand-rolled version treated the `/*` inside a path pattern like `"@/*"` as a block-comment
 * opener and ate the rest of the block, so path aliases silently never resolved — which made
 * 127 live React components look like dead code on the calibration fixture.
 */
export function aliasesFromTsconfig(raw: string): PathAlias[] {
  const { config: parsed, error } = ts.parseConfigFileTextToJson('tsconfig.json', raw);
  if (error || !parsed) return [];

  const opts = parsed?.compilerOptions;
  if (!opts?.paths) return [];

  const baseUrl: string = (opts.baseUrl ?? '.').replace(/^\.\/?/, '');
  const aliases: PathAlias[] = [];

  for (const [pattern, targetList] of Object.entries<string[]>(opts.paths)) {
    if (!pattern.endsWith('*') || !Array.isArray(targetList)) continue;
    const prefix = pattern.slice(0, -1);
    const targets = targetList
      .filter((t) => typeof t === 'string' && t.endsWith('*'))
      .map((t) => {
        const cleaned = t.slice(0, -1).replace(/^\.\//, '');
        return baseUrl ? `${baseUrl}/${cleaned}`.replace(/\/+/g, '/') : cleaned;
      })
      .map((t) => t.replace(/\/$/, ''));
    if (targets.length) aliases.push({ prefix, targets });
  }

  return aliases;
}
