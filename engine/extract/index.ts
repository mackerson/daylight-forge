import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Graph, GraphNode } from '../graph/types.ts';
import type { CallSite, ImportBinding, ParsedFile, Parser } from './parser.ts';
import { aliasesFromTsconfig, Resolver } from './resolve.ts';
import { crateFromManifest, isLocalRustSpec, type RustCrate } from './rust-resolve.ts';
import { activeParsers, parserFor } from './registry.ts';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'release',
  '.next', '.vite', '.turbo', '.cache', 'vendor', '__snapshots__',
]);

export interface ExtractOptions {
  /**
   * Language providers to use. Defaults to the built-ins; `loadParsers()` adds any the user
   * has opted into. Passed in rather than resolved here so a test can drive the seam.
   */
  parsers?: Parser[];
  root: string;
  /**
   * Where to keep the parse cache. Parsing is the expensive half and it is per-file and
   * content-addressed, so an unchanged file never needs parsing twice. Resolution stays
   * global and re-runs every time — it is cheap, and a cached edge could otherwise point
   * at a file that has since moved.
   */
  cacheDir?: string;
  /** Skip vendored bundles. On by default; they are not authored code. */
  includeVendored?: boolean;
  /** Skip `.d.ts` — ambient declarations inflate D1 with types nobody wrote by hand. */
  includeDeclarations?: boolean;
  /** Skip test files, which legitimately duplicate shapes and names. */
  includeTests?: boolean;
}

/**
 * Rust integration tests live in a crate's `tests/`, never under `src/`: a `tests/` directory
 * under `src/` is a module tree its parent declares, and dropping it would leave that `mod`
 * unresolved. `#[cfg(test)]` modules are only knowable after parsing, so they stay in the map,
 * reached through their `mod` declaration.
 */
const TEST_RE = /(^|[./-])(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__)\/|^(?!(.*\/)?src\/)(.*\/)?tests\/.+\.rs$/;

/** Bundler-handled non-code imports. Not edges, and not resolution failures either. */
const ASSET_RE = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp[34]|webm|wasm|txt|md|ya?ml|graphql|gql)(\?.*)?$/i;

/**
 * A vendored bundle is not authored code, and letting one in wrecks every downstream
 * number — a single copy of three.js contributed ~8000 symbols to a 25-file repo and
 * buried the real findings. Detected by shape rather than by name so it generalises:
 * bundles are large and have very long lines.
 */
export function looksVendored(source: string): boolean {
  // Size alone is decisive with room to spare: in this repo the largest authored
  // source file is ~17KB and the vendored three.js builds are 650KB and 1.4MB.
  if (source.length > 200_000) return true;
  // Minified bundles can be smaller but give themselves away by line length.
  if (source.length < 50_000) return false;
  const newlines = source.split('\n').length;
  return source.length / Math.max(newlines, 1) > 200;
}

/** Files git already ignores are not ours to analyse. Falls back to a walk. */
function gitTracked(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // Not being a git repo is an expected, handled case — git saying so on stderr is
      // noise printed over every run on a plain directory.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out.split('\n').filter(Boolean);
    return files.length ? files : null;
  } catch {
    return null;
  }
}

export function walk(root: string): string[] {
  const tracked = gitTracked(root);
  if (tracked) {
    return tracked.filter((f) => !f.split('/').some((seg) => IGNORED_DIRS.has(seg))).sort();
  }

  const out: string[] = [];
  const stack = [''];

  while (stack.length) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }

  return out.sort();
}

interface ParseCache {
  version: number;
  parser: string;
  entries: Record<string, ParsedFile>;
}

const CACHE_VERSION = 2;

function loadCache(dir: string | undefined, parserName: string): ParseCache {
  const empty: ParseCache = { version: CACHE_VERSION, parser: parserName, entries: {} };
  if (!dir) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'parse.json'), 'utf8')) as ParseCache;
    // A parser change invalidates everything — cached output is only as good as the code
    // that produced it.
    if (raw.version !== CACHE_VERSION || raw.parser !== parserName) return empty;
    return raw;
  } catch {
    return empty;
  }
}

function saveCache(dir: string | undefined, cache: ParseCache, live: Set<string>): void {
  if (!dir) return;
  // Prune hashes no file currently carries, so the cache tracks the tree rather than growing
  // forever with every past edit.
  for (const key of Object.keys(cache.entries)) if (!live.has(key)) delete cache.entries[key];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'parse.json'), JSON.stringify(cache));
  } catch {
    // A cache we cannot write is a slow run, not a broken one.
  }
}

/**
 * Per file, for every provider (review L5): a generated or vendored file this size is ordinary,
 * and parsing one costs seconds and gigabytes for nothing a map can show.
 */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Why `rel` is skipped for its size, or null. Checked before the file is read. */
function oversize(root: string, rel: string): string | null {
  const size = fs.statSync(path.join(root, rel), { throwIfNoEntry: false })?.size ?? 0;
  return size > MAX_SOURCE_BYTES ? `skipped: ${size} bytes, over the ${MAX_SOURCE_BYTES / 1024 / 1024} MB per-file cap` : null;
}

export function extract(options: ExtractOptions): Graph {
  const { root, includeDeclarations = false, includeTests = false, includeVendored = false } = options;
  // Several providers may be in play; each file goes to whichever claims its extension.
  const parsers = options.parsers?.length ? options.parsers : activeParsers();
  const cache = loadCache(options.cacheDir, parsers.map((p) => p.name).sort().join('+'));
  const liveHashes = new Set<string>();

  const allFiles = walk(root);
  const parseable = allFiles.filter((f) => {
    if (!parserFor(parsers, f)) return false;
    if (!includeDeclarations && f.endsWith('.d.ts')) return false;
    return true;
  });
  const sourceFiles = includeTests ? parseable : parseable.filter((f) => !TEST_RE.test(f));
  const testFiles = includeTests ? [] : parseable.filter((f) => TEST_RE.test(f));

  const aliases = readAliases(root, allFiles);
  const resolver = new Resolver(sourceFiles, aliases, readCrates(root, allFiles));

  const graph: Graph = {
    root,
    nodes: [],
    edges: [],
    shapes: [],
    functions: [],
    calls: [],
    literals: [],
    testImports: [],
    diagnostics: [],
    stats: {
      files: 0, symbols: 0, imports: 0, unresolvedImports: 0, externalImports: 0,
      assetImports: 0, calls: 0, resolvedCalls: 0, literals: 0, vendoredSkipped: 0,
      parsedFiles: 0, reusedFiles: 0,
    },
  };

  // Heritage targets are local names; index symbols by name to resolve what we can.
  const symbolsByName = new Map<string, string[]>();
  const pendingHeritage: Array<{ from: string; to: string; kind: 'extends' | 'implements' }> = [];
  const perFileCalls = new Map<string, CallSite[]>();
  const perFileBindings = new Map<string, ImportBinding[]>();

  for (const rel of sourceFiles) {
    const over = oversize(root, rel);
    if (over) {
      graph.diagnostics.push({ file: rel, message: over });
      continue;
    }
    let source: string;
    try {
      source = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch (err) {
      graph.diagnostics.push({ file: rel, message: `unreadable: ${(err as Error).message}` });
      continue;
    }

    if (!includeVendored && looksVendored(source)) {
      graph.stats.vendoredSkipped++;
      continue;
    }

    const contentHash = createHash('sha256').update(source).digest('hex').slice(0, 12);
    const fileNode: GraphNode = {
      id: rel,
      kind: 'file',
      name: path.posix.basename(rel),
      file: rel,
      line: 1,
      endLine: source.split('\n').length,
      exported: false,
      contentHash,
    };
    graph.nodes.push(fileNode);
    graph.stats.files++;

    // Cache key includes the path: the same content at a different path produces different
    // node ids, so content alone would hand back records pointing at the wrong file.
    // Keyed by provider as well: two providers producing different records for the same
    // bytes must not hand each other's output back.
    const fileParser = parserFor(parsers, rel)!;
    const cacheKey = `${fileParser.name}:${contentHash}:${rel}`;
    liveHashes.add(cacheKey);

    let parsed: ParsedFile;
    const cached = cache.entries[cacheKey];
    if (cached) {
      parsed = cached;
      graph.stats.reusedFiles++;
    } else {
      try {
        parsed = fileParser.parse(rel, source, contentHash);
        cache.entries[cacheKey] = parsed;
      } catch (err) {
        graph.diagnostics.push({ file: rel, message: `parse failed: ${(err as Error).message}` });
        continue;
      }
      graph.stats.parsedFiles++;
    }

    for (const node of parsed.nodes) {
      graph.nodes.push(node);
      graph.stats.symbols++;
      const list = symbolsByName.get(node.name);
      if (list) list.push(node.id);
      else symbolsByName.set(node.name, [node.id]);
      graph.edges.push({ from: rel, to: node.id, kind: 'contains' });
    }

    for (const message of parsed.diagnostics ?? []) graph.diagnostics.push({ file: rel, message });
    graph.shapes.push(...parsed.shapes);
    graph.functions.push(...parsed.functions);
    graph.literals.push(...parsed.literals);
    // `base` is a resolution detail, not graph data — keep it out of graph.json.
    for (const { base: _base, ...record } of parsed.calls) graph.calls.push(record);
    pendingHeritage.push(...parsed.heritage);
    graph.stats.literals += parsed.literals.length;
    graph.stats.calls += parsed.calls.length;
    perFileCalls.set(rel, parsed.calls);
    perFileBindings.set(rel, parsed.bindings);

    const seen = new Set<string>();
    for (const spec of parsed.imports) {
      if (seen.has(spec)) continue;
      seen.add(spec);
      if (ASSET_RE.test(spec)) {
        graph.stats.assetImports++;
        continue;
      }
      graph.stats.imports++;

      const target = resolver.resolve(spec, rel);
      // `use super::*` inside an inline `mod tests` names this very file: resolved, but no edge.
      if (target === rel && rel.endsWith('.rs')) continue;
      if (target) {
        // A Rust `mod x;` declares a child module: containment in the module tree, not a use.
        const kind = spec.startsWith('mod ') ? 'contains' : 'imports';
        graph.edges.push({ from: rel, to: target, kind, spec });
      } else if (spec.startsWith('.') || isLocalRustSpec(spec)) {
        // A relative specifier we failed to resolve is our bug, not an external package.
        graph.stats.unresolvedImports++;
        graph.diagnostics.push({ file: rel, message: `unresolved relative import: ${spec}` });
      } else {
        graph.stats.externalImports++;
        graph.edges.push({ from: rel, to: spec, kind: 'imports', spec, external: true });
      }
    }
  }

  // Call resolution: a call whose leftmost identifier is an imported binding resolves
  // to that binding's target symbol. Anything else stays unresolved rather than guessed —
  // a fabricated edge is worse than a missing one.
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const [rel, callSites] of perFileCalls) {
    const bindings = perFileBindings.get(rel) ?? [];
    if (!bindings.length) continue;
    const byLocal = new Map(bindings.map((b) => [b.local, b]));

    for (const call of callSites) {
      if (!call.base) continue;
      const binding = byLocal.get(call.base);
      if (!binding) continue;
      const targetFile = resolver.resolve(binding.spec, rel);
      if (!targetFile) continue;

      // `import * as x` / default: the file is the finest resolution we can honestly give.
      const wantSymbol = binding.imported === '*' || binding.imported === 'default'
        ? undefined
        : `${targetFile}#${binding.imported}`;
      const to = wantSymbol && nodeIds.has(wantSymbol) ? wantSymbol : targetFile;

      graph.edges.push({
        from: call.from, to, kind: 'calls', member: call.member, line: call.line,
      });
      graph.stats.resolvedCalls++;
    }
  }

  // Tests, for reachability only.
  //
  // On the fixture, excluding tests reported 11 high-tier dead candidates and every one of
  // them was wrong — BackupService, ChannelDispatcher and ActiveWorkRegistry all have callers,
  // in files the tool had refused to open. Parsing them costs one pass and buys the difference
  // between "nothing uses this" and "only the tests use this", which are different findings.
  for (const rel of testFiles) {
    const over = oversize(root, rel);
    if (over) {
      graph.diagnostics.push({ file: rel, message: over });
      continue;
    }
    let source: string;
    try {
      source = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue; // A test we cannot read is not worth a diagnostic; it is not part of the map.
    }
    if (!includeVendored && looksVendored(source)) continue;

    const contentHash = createHash('sha256').update(source).digest('hex').slice(0, 12);
    // Keyed by provider as well: two providers producing different records for the same
    // bytes must not hand each other's output back.
    const fileParser = parserFor(parsers, rel)!;
    const cacheKey = `${fileParser.name}:${contentHash}:${rel}`;
    liveHashes.add(cacheKey);

    let parsed: ParsedFile;
    const cached = cache.entries[cacheKey];
    if (cached) {
      parsed = cached;
      graph.stats.reusedFiles++;
    } else {
      try {
        parsed = fileParser.parse(rel, source, contentHash);
        cache.entries[cacheKey] = parsed;
      } catch {
        continue;
      }
      graph.stats.parsedFiles++;
    }

    const seen = new Set<string>();
    for (const imp of parsed.imports) {
      // `imports` is a list of specifiers; the resolver turns them into files.
      const to = resolver.resolve(imp, rel);
      if (!to || seen.has(to)) continue;
      seen.add(to);
      graph.testImports.push({ from: rel, to });
    }
  }

  for (const h of pendingHeritage) {
    const candidates = symbolsByName.get(h.to);
    // Only link when the name is unambiguous — a guess here would be a fabricated edge.
    if (candidates?.length === 1) {
      graph.edges.push({ from: h.from, to: candidates[0], kind: h.kind });
    }
  }

  saveCache(options.cacheDir, cache, liveHashes);
  return graph;
}

function readAliases(root: string, allFiles: string[]): ReturnType<typeof aliasesFromTsconfig> {
  const configs = allFiles.filter(
    (f) => /(^|\/)tsconfig(\.[\w-]+)?\.json$/.test(f) && !f.includes('/'),
  );
  const aliases = [];
  for (const cfg of configs) {
    try {
      aliases.push(...aliasesFromTsconfig(fs.readFileSync(path.join(root, cfg), 'utf8')));
    } catch {
      // A missing or malformed tsconfig just means no aliases; not fatal.
    }
  }
  return aliases;
}

/** Every `[package]` in the tree, so `crate::` and cross-crate paths have somewhere to land. */
function readCrates(root: string, allFiles: string[]): RustCrate[] {
  const crates: RustCrate[] = [];
  for (const manifest of allFiles.filter((f) => /(^|\/)Cargo\.toml$/.test(f))) {
    try {
      const crate = crateFromManifest(manifest, fs.readFileSync(path.join(root, manifest), 'utf8'));
      if (crate) crates.push(crate);
    } catch {
      // An unreadable manifest just means that crate's paths stay unresolved.
    }
  }
  return crates;
}
