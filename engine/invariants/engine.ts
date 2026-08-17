import type { Graph, GraphNode } from '../graph/types.ts';

/**
 * Invariants — the load-bearing facts that make a focused map true.
 *
 * The prior manual artifact wrote them in prose and then wrote the obligation nobody
 * honors: "If a code change breaks one, the diagrams above are wrong and this page must
 * be updated." An invariant is a query against L0, so we can honor it on every pass.
 *
 * Each invariant carries its prose form AND its compiled form. The prose is what the
 * human reads; the compiled form is what actually runs. If they drift apart the
 * invariant is worse than useless, so they live in the same object.
 */

export interface Selector {
  /** Regex over the repo-relative file path. */
  file?: string;
  /** Regex over the symbol name. */
  name?: string;
  kind?: GraphNode['kind'][];
}

export type Predicate =
  /** No node matches the selector. */
  | { type: 'absent'; select: Selector }
  /** Count of matching nodes falls within [min, max]. */
  | { type: 'count'; select: Selector; min?: number; max?: number }
  /**
   * A string literal appears in at most `maxFiles` files / `maxSites` call sites,
   * counting only calls whose callee matches `callee`.
   */
  | {
      type: 'literal-fanin';
      value: string;
      callee?: string;
      within?: Selector;
      maxFiles?: number;
      maxSites?: number;
      minSites?: number;
    }
  /** No `calls` edge from a node matching `from` to one matching `to`. */
  | { type: 'forbidden-call'; from: Selector; to: Selector; member?: string }
  /** No call with a callee/member matching the pattern occurs inside `within`. */
  | { type: 'forbidden-callee'; within: Selector; callee: string }
  /** At least `min` calls matching the pattern occur inside `within`. */
  | { type: 'required-callee'; within: Selector; callee: string; min: number }
  /** Inside one file, every call matching `before` precedes the first matching `after`. */
  | { type: 'ordering'; file: string; before: string; after: string };

export interface Invariant {
  id: string;
  /** The human-readable claim, quoted from the architecture doc where possible. */
  prose: string;
  predicate: Predicate;
  /** Why this is load-bearing — what breaks if it stops being true. */
  rationale?: string;
}

export interface Violation {
  where: string;
  detail: string;
  line?: number;
}

export interface InvariantResult {
  id: string;
  prose: string;
  status: 'green' | 'red';
  /** One-line summary of what the query actually measured. */
  measured: string;
  violations: Violation[];
}

const rx = (pattern: string | undefined) => (pattern ? new RegExp(pattern) : undefined);

function matches(node: GraphNode, sel: Selector): boolean {
  if (sel.kind && !sel.kind.includes(node.kind)) return false;
  const f = rx(sel.file);
  if (f && !f.test(node.file)) return false;
  const n = rx(sel.name);
  if (n && !n.test(node.name)) return false;
  return true;
}

const fileMatches = (file: string, sel: Selector | undefined): boolean => {
  if (!sel?.file) return true;
  return new RegExp(sel.file).test(file);
};

export function evaluate(graph: Graph, inv: Invariant): InvariantResult {
  const p = inv.predicate;
  const base = { id: inv.id, prose: inv.prose };

  // An unrecognised predicate must fail loudly rather than returning undefined. Invariants
  // can be hand-written or agent-proposed, so a malformed one is expected input — and the
  // old behaviour crashed every caller with `Cannot read properties of undefined`.
  const KNOWN = [
    'absent', 'count', 'literal-fanin', 'forbidden-call',
    'forbidden-callee', 'required-callee', 'ordering',
  ];
  if (!p || typeof p !== 'object' || !KNOWN.includes((p as { type?: string }).type ?? '')) {
    return {
      ...base,
      status: 'red',
      measured: `unknown predicate type '${(p as { type?: string })?.type ?? typeof p}' — expected one of ${KNOWN.join(', ')}`,
      violations: [{ where: inv.id, detail: 'the invariant itself is malformed, not the code' }],
    };
  }

  switch (p.type) {
    case 'absent': {
      const hits = graph.nodes.filter((n) => matches(n, p.select));
      return {
        ...base,
        status: hits.length === 0 ? 'green' : 'red',
        measured: `${hits.length} node(s) matched a selector that must match none`,
        violations: hits.slice(0, 10).map((n) => ({
          where: n.id,
          detail: `${n.kind} ${n.name} exists`,
          line: n.line,
        })),
      };
    }

    case 'count': {
      const hits = graph.nodes.filter((n) => matches(n, p.select));
      const tooFew = p.min !== undefined && hits.length < p.min;
      const tooMany = p.max !== undefined && hits.length > p.max;
      return {
        ...base,
        status: tooFew || tooMany ? 'red' : 'green',
        measured: `${hits.length} matched (expected ${p.min ?? 0}..${p.max ?? '∞'})`,
        violations:
          tooFew || tooMany
            ? hits.slice(0, 10).map((n) => ({ where: n.id, detail: `${n.kind} ${n.name}`, line: n.line }))
            : [],
      };
    }

    case 'literal-fanin': {
      const calleeRe = rx(p.callee);
      const uses = graph.literals.filter(
        (l) =>
          l.value === p.value &&
          // A literal need not be an argument to anything — a provider for a language
          // without that notion still reports it. Requiring a callee here would silently
          // drop those, so an invariant asking about one only matches literals that have one.
          (!calleeRe || (l.callee !== undefined && calleeRe.test(l.callee))) &&
          fileMatches(l.file, p.within),
      );
      const files = new Set(uses.map((u) => u.file));
      const overFiles = p.maxFiles !== undefined && files.size > p.maxFiles;
      const overSites = p.maxSites !== undefined && uses.length > p.maxSites;
      const underSites = p.minSites !== undefined && uses.length < p.minSites;
      return {
        ...base,
        status: overFiles || overSites || underSites ? 'red' : 'green',
        measured:
          `'${p.value}' used at ${uses.length} site(s) in ${files.size} file(s)` +
          ` (max ${p.maxFiles ?? '∞'} files / ${p.maxSites ?? '∞'} sites)`,
        violations:
          overFiles || overSites || underSites
            ? uses.slice(0, 10).map((u) => ({ where: u.file, detail: `${u.callee}('${u.value}')`, line: u.line }))
            : [],
      };
    }

    case 'forbidden-call': {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const memberRe = rx(p.member);
      const bad = graph.edges.filter((e) => {
        if (e.kind !== 'calls') return false;
        if (memberRe && !(e.member && memberRe.test(e.member))) return false;
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (!from || !to) return false;
        return matches(from, p.from) && matches(to, p.to);
      });
      return {
        ...base,
        status: bad.length === 0 ? 'green' : 'red',
        measured: `${bad.length} forbidden call edge(s)`,
        violations: bad.slice(0, 10).map((e) => ({
          where: e.from,
          detail: `calls ${e.to}${e.member ? `.${e.member}` : ''}`,
          line: e.line,
        })),
      };
    }

    case 'forbidden-callee': {
      const re = new RegExp(p.callee);
      const bad = graph.calls.filter((c) => fileMatches(c.file, p.within) && re.test(c.callee));
      return {
        ...base,
        status: bad.length === 0 ? 'green' : 'red',
        measured: `${bad.length} call(s) to a forbidden callee`,
        violations: bad.slice(0, 10).map((c) => ({ where: c.file, detail: c.callee, line: c.line })),
      };
    }

    case 'required-callee': {
      const re = new RegExp(p.callee);
      const hits = graph.calls.filter((c) => fileMatches(c.file, p.within) && re.test(c.callee));
      return {
        ...base,
        status: hits.length >= p.min ? 'green' : 'red',
        measured: `${hits.length} call(s) found (need >= ${p.min})`,
        violations:
          hits.length >= p.min
            ? []
            : [{ where: p.within.file ?? '(anywhere)', detail: `expected /${p.callee}/, found ${hits.length}` }],
      };
    }

    case 'ordering': {
      const fileRe = new RegExp(p.file);
      const beforeRe = new RegExp(p.before);
      const afterRe = new RegExp(p.after);
      const inFile = graph.calls.filter((c) => fileRe.test(c.file));
      const befores = inFile.filter((c) => beforeRe.test(c.callee));
      const afters = inFile.filter((c) => afterRe.test(c.callee));

      if (!befores.length || !afters.length) {
        return {
          ...base,
          status: 'red',
          measured: `ordering unverifiable: ${befores.length} before-call(s), ${afters.length} after-call(s)`,
          violations: [{ where: p.file, detail: 'one side of the ordering was not found' }],
        };
      }

      const firstAfter = Math.min(...afters.map((c) => c.line));
      const late = befores.filter((c) => c.line > firstAfter);
      return {
        ...base,
        status: late.length === 0 ? 'green' : 'red',
        measured: `${befores.length} before-call(s), first after-call at line ${firstAfter}, ${late.length} late`,
        violations: late.slice(0, 10).map((c) => ({ where: c.file, detail: `${c.callee} runs late`, line: c.line })),
      };
    }
  }
}

export function evaluateAll(graph: Graph, invariants: Invariant[]): InvariantResult[] {
  return invariants.map((inv) => evaluate(graph, inv));
}
