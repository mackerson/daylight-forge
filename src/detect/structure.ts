import fs from 'node:fs';
import path from 'node:path';
import type { Graph } from '../graph/types.ts';

/**
 * Structural findings: what the shape of the graph says, as opposed to what the text
 * of the code says (that is D1–D3).
 *
 * Every dead-code claim here is a *candidate* with a confidence tier and a stated reason
 * for the tier. Static reachability is wrong in exactly the ways this codebase cares
 * about — dynamic dispatch, DI, file-based routing, decorators, plugin registries,
 * string-keyed lookups — so the detector proposes and an agent or human adjudicates. A
 * confident dead-code report is worse than none, because it gets acted on.
 */

export type Tier = 'high' | 'medium' | 'low';

export interface DeadCandidate {
  kind: 'file' | 'symbol';
  id: string;
  tier: Tier;
  /** Why this tier and not a higher one — the caveat travels with the finding. */
  why: string;
}

export interface Cycle {
  members: string[];
  /** Total edge weight inside the cycle: how tangled, not just how large. */
  internalEdges: number;
}

export interface Limb {
  dir: string;
  files: number;
  inside: number;
  outside: number;
  /** Fraction of this subtree's edges that leave it. Cohesion is a lie above ~0.8. */
  leakage: number;
}

export interface GodNode {
  id: string;
  fanIn: number;
  fanOut: number;
  symbols: number;
}

export interface StructureReport {
  entrypoints: string[];
  /** Set when reachability is too low to trust — see the coverage guard. */
  warning?: string;
  dead: DeadCandidate[];
  cycles: Cycle[];
  limbs: Limb[];
  gods: GodNode[];
  orphans: string[][];
  stats: { reachable: number; unreachable: number; files: number };
}

const fileOf = (id: string) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);

/**
 * Entrypoints are declared, not guessed where possible: package.json is the only place a
 * project actually states what is reachable from outside. The conventional fallbacks exist
 * so a repo without a manifest still gets an answer, and they are reported so a wrong
 * guess is visible rather than silently shaping every downstream finding.
 */
export function findEntrypoints(graph: Graph, files: Set<string>): string[] {
  const found = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate) return;
    const clean = candidate.replace(/^\.\//, '');
    for (const ext of ['', '.ts', '.tsx', '.js', '.mjs', '.cjs']) {
      if (files.has(clean + ext)) found.add(clean + ext);
    }
    // dist/foo.js usually means src/foo.ts in a TS project.
    const fromDist = clean.replace(/^dist\//, 'src/').replace(/\.js$/, '');
    for (const ext of ['.ts', '.tsx']) if (files.has(fromDist + ext)) found.add(fromDist + ext);
  };

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(graph.root, 'package.json'), 'utf8'));
    add(pkg.main);
    add(pkg.module);
    add(pkg.browser);
    for (const v of Object.values(pkg.bin ?? {})) add(v as string);
    const walkExports = (node: unknown): void => {
      if (typeof node === 'string') return add(node);
      if (node && typeof node === 'object') for (const v of Object.values(node)) walkExports(v);
    };
    walkExports(pkg.exports);
    for (const script of Object.values<string>(pkg.scripts ?? {})) {
      for (const m of script.matchAll(/(?:^|\s)([\w./-]+\.(?:ts|tsx|js|mjs|cjs))/g)) add(m[1]);
    }
  } catch {
    // No manifest is normal for a sub-package or a bare checkout.
  }

  // HTML entrypoints. A bundled app enters through a <script src> in an html file, not
  // through package.json, so without this every renderer file looks unreachable — which
  // is exactly how a live app produces a page of confident dead-code findings.
  for (const f of files) {
    if (!f.endsWith('.html')) continue;
    try {
      const html = fs.readFileSync(path.join(graph.root, f), 'utf8');
      for (const m of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)) {
        const src = m[1].replace(/^\.\//, '');
        add(src);
        add(path.posix.join(path.posix.dirname(f), src));
      }
    } catch {
      // Unreadable html just contributes no entrypoints.
    }
  }

  // Conventional roots and config files that a bundler or runtime loads by name.
  for (const f of files) {
    const base = f.split('/').pop() ?? '';
    if (/^(index|main|cli|app|server|preload)\.[cm]?[jt]sx?$/.test(base) && f.split('/').length <= 3) {
      found.add(f);
    }
    if (/\.config\.[cm]?[jt]s$/.test(base)) found.add(f);
  }

  return [...found].sort();
}

/** Every string literal in the codebase, for the "referenced by name" caveat. */
function literalCorpus(graph: Graph): Set<string> {
  const out = new Set<string>();
  for (const l of graph.literals) out.add(l.value);
  return out;
}

export function detectStructure(graph: Graph): StructureReport {
  const files = new Set(graph.nodes.filter((n) => n.kind === 'file').map((n) => n.id));
  // HTML is not parsed into the graph, so offer it to entrypoint discovery separately.
  const htmlFiles = new Set([...files]);
  try {
    const walkHtml = (dir: string, prefix = ''): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walkHtml(path.join(dir, entry.name), rel);
        else if (entry.name.endsWith('.html')) htmlFiles.add(rel);
      }
    };
    walkHtml(graph.root);
  } catch {
    // Best effort.
  }
  const entrypoints = findEntrypoints(graph, htmlFiles).filter((e) => files.has(e));

  // ---- reachability ----------------------------------------------------------
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.external || e.kind === 'contains') continue;
    const from = fileOf(e.from);
    const to = fileOf(e.to);
    if (!files.has(from) || !files.has(to) || from === to) continue;
    (outgoing.get(from) ?? outgoing.set(from, new Set()).get(from)!).add(to);
    (incoming.get(to) ?? incoming.set(to, new Set()).get(to)!).add(from);
  }

  const reachable = new Set<string>(entrypoints);
  const queue = [...entrypoints];
  while (queue.length) {
    for (const next of outgoing.get(queue.pop()!) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  // ---- dead candidates -------------------------------------------------------
  const literals = literalCorpus(graph);
  const dead: DeadCandidate[] = [];

  const namedInAString = (file: string): boolean => {
    const stem = (file.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
    for (const value of literals) if (value.includes(stem)) return true;
    return false;
  };

  for (const file of files) {
    if (reachable.has(file)) continue;
    // A file nobody imports but whose name appears in a string could be loaded by a
    // registry, a route table or a dynamic import. That is exactly how plugin systems
    // work, so it caps the tier rather than clearing the finding.
    const byName = namedInAString(file);
    dead.push({
      kind: 'file',
      id: file,
      tier: byName ? 'medium' : 'high',
      why: byName
        ? 'unreachable from entrypoints, but its name appears in a string literal — may be loaded dynamically'
        : 'unreachable from entrypoints and never named in a string literal',
    });
  }

  // Exported symbols nobody references. Weakest tier by construction: our call resolution
  // is syntactic, so an unreferenced export may simply be a reference we cannot see.
  const referenced = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind === 'imports' || e.kind === 'contains') continue;
    referenced.add(e.to);
  }
  for (const node of graph.nodes) {
    if (node.kind === 'file' || !node.exported) continue;
    if (referenced.has(node.id)) continue;
    if (!reachable.has(node.file)) continue; // already reported as a dead file
    if (literals.has(node.name)) continue;
    dead.push({
      kind: 'symbol',
      id: node.id,
      tier: 'low',
      why: 'exported but no resolved reference — call resolution is syntactic, so verify before acting',
    });
  }

  // ---- cycles (Tarjan over the file graph) -----------------------------------
  const cycles: Cycle[] = [];
  {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let counter = 0;

    const strongconnect = (v: string): void => {
      index.set(v, counter);
      low.set(v, counter);
      counter++;
      stack.push(v);
      onStack.add(v);

      for (const w of outgoing.get(v) ?? []) {
        if (!index.has(w)) {
          strongconnect(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      }

      if (low.get(v) === index.get(v)) {
        const component: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
          if (w === v) break;
        }
        if (component.length > 1) {
          const members = new Set(component);
          let internal = 0;
          for (const m of component) for (const t of outgoing.get(m) ?? []) if (members.has(t)) internal++;
          cycles.push({ members: component.sort(), internalEdges: internal });
        }
      }
    };

    for (const f of files) if (!index.has(f)) strongconnect(f);
    cycles.sort((a, b) => b.members.length - a.members.length);
  }

  // ---- weird limbs -----------------------------------------------------------
  const limbs: Limb[] = [];
  {
    const dirs = new Map<string, string[]>();
    for (const f of files) {
      const parts = f.split('/');
      for (let d = 1; d < parts.length; d++) {
        const dir = parts.slice(0, d).join('/');
        (dirs.get(dir) ?? dirs.set(dir, []).get(dir)!).push(f);
      }
    }

    for (const [dir, members] of dirs) {
      if (members.length < 3) continue;
      const inside = new Set(members);
      let within = 0;
      let leaving = 0;
      for (const m of members) {
        for (const t of outgoing.get(m) ?? []) (inside.has(t) ? within++ : leaving++);
        for (const s of incoming.get(m) ?? []) if (!inside.has(s)) leaving++;
      }
      const total = within + leaving;
      if (total < 6) continue;
      const leakage = leaving / total;
      if (leakage > 0.85) {
        limbs.push({ dir, files: members.length, inside: within, outside: leaving, leakage });
      }
    }
    limbs.sort((a, b) => b.leakage - a.leakage || b.files - a.files);
  }

  // ---- god nodes -------------------------------------------------------------
  const symbolsPerFile = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.kind === 'file') continue;
    symbolsPerFile.set(n.file, (symbolsPerFile.get(n.file) ?? 0) + 1);
  }
  const fanIns = [...files].map((f) => incoming.get(f)?.size ?? 0).sort((a, b) => a - b);
  // Relative, not absolute: "a lot of dependents" only means anything for this codebase.
  const p90 = fanIns[Math.floor(fanIns.length * 0.9)] ?? 0;
  const gods: GodNode[] = [...files]
    .map((f) => ({
      id: f,
      fanIn: incoming.get(f)?.size ?? 0,
      fanOut: outgoing.get(f)?.size ?? 0,
      symbols: symbolsPerFile.get(f) ?? 0,
    }))
    .filter((g) => g.fanIn > Math.max(3, p90))
    .sort((a, b) => b.fanIn - a.fanIn);

  // ---- orphan clusters -------------------------------------------------------
  const orphans: string[][] = [];
  {
    const seen = new Set<string>();
    for (const f of files) {
      if (seen.has(f) || reachable.has(f)) continue;
      const component: string[] = [];
      const q = [f];
      seen.add(f);
      while (q.length) {
        const cur = q.pop()!;
        component.push(cur);
        for (const n of [...(outgoing.get(cur) ?? []), ...(incoming.get(cur) ?? [])]) {
          if (!seen.has(n) && !reachable.has(n)) {
            seen.add(n);
            q.push(n);
          }
        }
      }
      if (component.length > 1) orphans.push(component.sort());
    }
    orphans.sort((a, b) => b.length - a.length);
  }

  /**
   * Coverage guard.
   *
   * If most of the codebase is "unreachable", by far the likeliest explanation is that we
   * do not know all the entrypoints — not that half the app is dead. Reporting 163
   * high-confidence dead files in a shipping application is the failure this whole design
   * is meant to avoid, so low coverage caps the tier and says why.
   */
  const coverage = files.size ? reachable.size / files.size : 1;
  let warning: string | undefined;
  if (coverage < 0.7) {
    warning =
      `only ${(coverage * 100).toFixed(0)}% of files are reachable from ${entrypoints.length} ` +
      'entrypoint(s), which usually means entrypoints are missing rather than that the rest ' +
      'is dead — every candidate has been capped to medium confidence';
    for (const d of dead) if (d.tier === 'high') {
      d.tier = 'medium';
      d.why = `${d.why} (capped: low overall reachability, entrypoints likely incomplete)`;
    }
  }

  return {
    entrypoints,
    warning,
    dead: dead.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.tier] - ({ high: 0, medium: 1, low: 2 })[b.tier]),
    cycles,
    limbs,
    gods,
    orphans,
    stats: { reachable: reachable.size, unreachable: files.size - reachable.size, files: files.size },
  };
}
