import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Graph, GraphNode } from '../graph/types.ts';
import type { CallSite, ImportBinding } from './parser.ts';
import { aliasesFromTsconfig, Resolver } from './resolve.ts';
import { TypeScriptParser } from './ts-parser.ts';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'release',
  '.next', '.vite', '.turbo', '.cache', 'vendor', '__snapshots__',
]);

export interface ExtractOptions {
  root: string;
  /** Skip vendored bundles. On by default; they are not authored code. */
  includeVendored?: boolean;
  /** Skip `.d.ts` — ambient declarations inflate D1 with types nobody wrote by hand. */
  includeDeclarations?: boolean;
  /** Skip test files, which legitimately duplicate shapes and names. */
  includeTests?: boolean;
}

const TEST_RE = /(^|[./-])(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__)\//;

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

export function extract(options: ExtractOptions): Graph {
  const { root, includeDeclarations = false, includeTests = false, includeVendored = false } = options;
  const parser = new TypeScriptParser();

  const allFiles = walk(root);
  const sourceFiles = allFiles.filter((f) => {
    const ext = f.slice(f.lastIndexOf('.'));
    if (!parser.extensions.includes(ext)) return false;
    if (!includeDeclarations && f.endsWith('.d.ts')) return false;
    if (!includeTests && TEST_RE.test(f)) return false;
    return true;
  });

  const aliases = readAliases(root, allFiles);
  const resolver = new Resolver(sourceFiles, aliases);

  const graph: Graph = {
    root,
    nodes: [],
    edges: [],
    shapes: [],
    functions: [],
    calls: [],
    literals: [],
    diagnostics: [],
    stats: {
      files: 0, symbols: 0, imports: 0, unresolvedImports: 0, externalImports: 0,
      assetImports: 0, calls: 0, resolvedCalls: 0, literals: 0, vendoredSkipped: 0,
    },
  };

  // Heritage targets are local names; index symbols by name to resolve what we can.
  const symbolsByName = new Map<string, string[]>();
  const pendingHeritage: Array<{ from: string; to: string; kind: 'extends' | 'implements' }> = [];
  const perFileCalls = new Map<string, CallSite[]>();
  const perFileBindings = new Map<string, ImportBinding[]>();

  for (const rel of sourceFiles) {
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

    let parsed;
    try {
      parsed = parser.parse(rel, source, contentHash);
    } catch (err) {
      graph.diagnostics.push({ file: rel, message: `parse failed: ${(err as Error).message}` });
      continue;
    }

    for (const node of parsed.nodes) {
      graph.nodes.push(node);
      graph.stats.symbols++;
      const list = symbolsByName.get(node.name);
      if (list) list.push(node.id);
      else symbolsByName.set(node.name, [node.id]);
      graph.edges.push({ from: rel, to: node.id, kind: 'contains' });
    }

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
      if (target) {
        graph.edges.push({ from: rel, to: target, kind: 'imports', spec });
      } else if (spec.startsWith('.')) {
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

  for (const h of pendingHeritage) {
    const candidates = symbolsByName.get(h.to);
    // Only link when the name is unambiguous — a guess here would be a fabricated edge.
    if (candidates?.length === 1) {
      graph.edges.push({ from: h.from, to: candidates[0], kind: h.kind });
    }
  }

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
