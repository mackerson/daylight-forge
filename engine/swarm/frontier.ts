import type { Graph } from '../graph/types.ts';
import type { ClaimStore } from '../store/claims.ts';
// A cycle and a limb have no natural id, so their subject is synthesised. Both this file
// and the Detect screen have to spell it the same way or a verdict lands on a subject
// nothing ever asks about again — so neither of them spells it, and this does.
import { cycleSubject, limbSubject } from '../detect/candidates.ts';

/**
 * The frontier scheduler.
 *
 *   score = uncertainty x centrality
 *
 * Resolving a hub changes more downstream beliefs than resolving a leaf, and a
 * contradiction is worth more than a blank. The queue drains when the top score falls
 * below a floor — that is the natural "the map has converged" signal, rather than an
 * arbitrary iteration count.
 */

export interface FrontierItem {
  subject: string;
  kind:
    | 'file' | 'family' | 'contradiction' | 'dead' | 'cycle' | 'limb' | 'god' | 'divergence'
    | 'legacy';
  question: string;
  score: number;
  uncertainty: number;
  centrality: number;
  why: string;
}

/** Fan-in weighted centrality, normalised to 0..1. Cheap and honest at L0 scale. */
export function centrality(graph: Graph): Map<string, number> {
  const fanIn = new Map<string, number>();
  const fileOf = (id: string) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);

  for (const e of graph.edges) {
    if (e.external || e.kind === 'contains') continue;
    const to = fileOf(e.to);
    fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
  }

  const max = Math.max(1, ...fanIn.values());
  const out = new Map<string, number>();
  for (const [id, n] of fanIn) out.set(id, n / max);
  return out;
}

export interface Findings {
  families?: Array<{ id: string; members: string[]; detectors: string[]; topScore?: number }>;
}

/** The structural half of the taxonomy, as written by `detectStructure`. */
export interface Structure {
  dead?: Array<{ kind: string; id: string; tier: string; why: string }>;
  cycles?: Array<{ members: string[]; internalEdges: number }>;
  limbs?: Array<{ dir: string; files: number; leakage: number }>;
  gods?: Array<{ id: string; fanIn: number; fanOut: number; symbols: number; pain?: number }>;
  divergences?: Array<{ file: string; home: string; pull: string; share: number }>;
  warning?: string;
}

/**
 * The traps, stated in the question itself.
 *
 * Static reachability is wrong in specific, well-known ways, and an agent that is not told
 * which ways will confidently confirm a false positive. Naming them is the difference
 * between "is this dead?" and a question that can actually be answered.
 */
const DEAD_TRAPS =
  'Before agreeing, rule out every way this could be reached without an import: dynamic ' +
  'import or require, a plugin or route registry keyed by string, dependency injection, ' +
  'decorators, a framework convention (file-based routing, lifecycle hooks), reflection, ' +
  'a build or config file naming it, test-only use, and public API surface consumers ' +
  'depend on. Ruling it out needs more evidence than confirming it.';

export function frontier(
  graph: Graph,
  store: ClaimStore,
  findings: Findings = {},
  structure: Structure = {},
): FrontierItem[] {
  const cent = centrality(graph);
  const items: FrontierItem[] = [];

  const uncertaintyOf = (subject: string, predicate: string): { u: number; why: string } => {
    const b = store.belief(subject, predicate);
    switch (b.status) {
      case 'UNKNOWN':
        return { u: 1, why: 'never examined' };
      case 'CONTRADICTED':
        return { u: 1.5, why: 'sources disagree — highest value to resolve' };
      case 'STALE':
        return { u: 0.9, why: 'file changed since the claim was made' };
      case 'INFERRED': {
        // A lone dismissal keeps residual uncertainty. Otherwise "no, nothing here" from one
        // agent retires a question as cheaply as a positive finding, and the frontier drains
        // by attrition rather than by being answered.
        const dismissal = b.value === false;
        const base = Math.max(0.1, 1 - b.confidence);
        return dismissal
          ? { u: Math.max(base, 0.35), why: 'ruled out by a single source — needs corroboration' }
          : { u: base, why: 'single uncorroborated source' };
      }
      case 'CORROBORATED':
        return { u: Math.max(0.05, (1 - b.confidence) * 0.5), why: 'corroborated' };
      case 'CONFIRMED':
        return { u: 0, why: 'human-confirmed' };
    }
  };

  // Duplication families: already-specific questions with a bounded answer.
  for (const fam of findings.families ?? []) {
    const { u, why } = uncertaintyOf(fam.id, 'duplication_verdict');
    if (u === 0) continue;
    const c = Math.max(...fam.members.map((m) => cent.get(m.split('#')[0]) ?? 0), 0.05);
    items.push({
      subject: fam.id,
      kind: 'family',
      question:
        `Are these ${fam.members.length} the same concept? If so which is canonical, and what ` +
        `breaks if they merge? Members: ${fam.members.slice(0, 6).join(', ')}`,
      score: u * c,
      uncertainty: u,
      centrality: c,
      why: `${why}; detectors ${fam.detectors.join('+')}`,
    });
  }

  // Files: the purpose claim is what promotes L1 to L2, so it drives clustering.
  for (const node of graph.nodes) {
    if (node.kind !== 'file') continue;
    const { u, why } = uncertaintyOf(node.id, 'purpose');
    if (u === 0) continue;
    const c = cent.get(node.id) ?? 0;
    if (c === 0 && u < 1) continue;
    items.push({
      subject: node.id,
      kind: 'file',
      question: `What is ${node.id} FOR? One sentence of intent, not a file listing.`,
      score: u * Math.max(c, 0.01),
      uncertainty: u,
      centrality: c,
      why,
    });
  }

  /**
   * Structural findings. These were computed and then read by nobody: the frontier only
   * knew about purposes and duplication families, so the largest finding class — and the
   * one most likely to be wrong — was never adjudicated by anything.
   */
  const TIER_WEIGHT: Record<string, number> = { high: 1, medium: 0.7, low: 0.25 };

  for (const d of structure.dead ?? []) {
    const { u, why } = uncertaintyOf(d.id, 'liveness_verdict');
    if (u === 0) continue;
    const file = d.id.split('#')[0];
    const c = cent.get(file) ?? 0.02;
    items.push({
      subject: d.id,
      kind: 'dead',
      question:
        `Is ${d.id} actually dead? The detector says: ${d.why}. ${DEAD_TRAPS} ` +
        'Answer with liveness_verdict — true if genuinely unreachable, false if it is reached.',
      // A confident candidate in a heavily-depended-on file is worth far more than a
      // low-tier guess at a leaf, so the tier multiplies rather than merely sorts.
      score: u * Math.max(c, 0.02) * (TIER_WEIGHT[d.tier] ?? 0.25) * 2,
      uncertainty: u,
      centrality: c,
      why: `${why}; ${d.tier}-confidence dead candidate`,
    });
  }

  for (const cyc of structure.cycles ?? []) {
    const id = cycleSubject(cyc.members);
    const { u, why } = uncertaintyOf(id, 'cycle_verdict');
    if (u === 0) continue;
    const c = Math.max(...cyc.members.map((m) => cent.get(m) ?? 0), 0.05);
    items.push({
      subject: id,
      kind: 'cycle',
      question:
        `These ${cyc.members.length} files form an import cycle (${cyc.internalEdges} edges ` +
        `inside it): ${cyc.members.slice(0, 6).join(', ')}. Which single edge should be cut, ` +
        'and what breaks if it is? Answer with cycle_verdict — true if the cycle is real and ' +
        'worth breaking, false if it is a type-only or otherwise harmless cycle.',
      score: u * c * 1.5,
      uncertainty: u,
      centrality: c,
      why,
    });
  }

  for (const limb of structure.limbs ?? []) {
    const id = limbSubject(limb.dir);
    const { u, why } = uncertaintyOf(id, 'limb_verdict');
    if (u === 0) continue;
    const c = Math.max(...[...cent].filter(([f]) => f.startsWith(limb.dir + '/')).map(([, v]) => v), 0.05);
    items.push({
      subject: id,
      kind: 'limb',
      question:
        `${(limb.leakage * 100).toFixed(0)}% of ${limb.dir}'s edges leave the subtree ` +
        `(${limb.files} files), so it is a folder rather than a module. Is it a genuine ` +
        'grouping with a shared purpose, or filing? Answer with limb_verdict — true if it ' +
        'should be regrouped, false if the leakage is expected for what it is (a utils or ' +
        'types directory legitimately leaks).',
      score: u * c,
      uncertainty: u,
      centrality: c,
      why,
    });
  }

  for (const god of structure.gods ?? []) {
    const { u, why } = uncertaintyOf(god.id, 'god_verdict');
    if (u === 0) continue;
    const c = cent.get(god.id) ?? 0.5;
    items.push({
      subject: god.id,
      kind: 'god',
      question:
        `${god.id} has ${god.fanIn} dependents. Is it one thing that many modules ` +
        'legitimately need (a logger, a shared type module), or several things that should ' +
        'be split? Answer with god_verdict — true if it should be split, false if the ' +
        'fan-in is appropriate.',
      score: u * c * 0.8,
      uncertainty: u,
      centrality: c,
      why,
    });
  }

  for (const d of structure.divergences ?? []) {
    const { u, why } = uncertaintyOf(d.file, 'divergence_verdict');
    if (u === 0) continue;
    const c = cent.get(d.file) ?? 0.05;
    items.push({
      subject: d.file,
      kind: 'divergence',
      question:
        `${d.file} lives in ${d.home} but ${(d.share * 100).toFixed(0)}% of what it connects ` +
        `to is in ${d.pull}. Should it move there, or is it filed correctly and the coupling ` +
        'is the thing to fix? Answer with divergence_verdict — true if it should move.',
      score: u * c * d.share,
      uncertainty: u,
      centrality: c,
      why,
    });
  }

  for (const b of store.contradictions()) {
    const c = cent.get(b.subject.split('#')[0]) ?? 0.5;
    items.push({
      subject: b.subject,
      kind: 'contradiction',
      question: `Sources disagree on ${b.predicate} for ${b.subject}. Re-derive it from source.`,
      score: 1.5 * Math.max(c, 0.2),
      uncertainty: 1.5,
      centrality: c,
      why: `${b.claims.length} conflicting claims`,
    });
  }

  /**
   * Verdicts collected before the boolean rule.
   *
   * `submit` now rejects them, so importing an older store drops them into `rejected` and the
   * knowledge quietly disappears. Coercing them is not on the table — `duplicates` with the
   * value "false — these are NOT duplicates" is precisely the case the rule exists to stop,
   * and guessing the polarity would fabricate a verdict nobody gave.
   *
   * So the subject goes back on the frontier, carrying the original evidence: the second
   * answer costs far less than the first because the search has already been done.
   */
  for (const legacy of store.legacyVerdicts()) {
    const c = cent.get(legacy.subject.split('#')[0]) ?? 0.5;
    const cited = legacy.evidence
      .map((e) => `${e.file}${e.line ? `:${e.line}` : ''}`)
      .slice(0, 6)
      .join(', ');
    items.push({
      subject: legacy.subject,
      kind: 'legacy',
      question:
        `A previous run answered ${legacy.predicate} for ${legacy.subject} before verdicts had ` +
        `to be boolean, so the answer cannot be read reliably and has not been kept. ` +
        (cited ? `It cited ${cited} — start there. ` : '') +
        `Answer ${legacy.predicate} again with a boolean value and put the reasoning in evidence.`,
      score: 1.2 * Math.max(c, 0.2),
      uncertainty: 1.2,
      centrality: c,
      why: `legacy ${legacy.predicate} from ${legacy.source.tool ?? legacy.source.kind}, value not boolean`,
    });
  }

  return items.sort((a, b) => b.score - a.score);
}

/**
 * Has the map converged?
 *
 * The design called for stopping when the top score falls below a floor — "the natural
 * 'the map has converged' signal, rather than an arbitrary iteration count" — and runs
 * stopped on batch size or timeout instead. A floor rather than an empty queue, because
 * the tail of a frontier is always populated with things nobody should pay to answer.
 */
export function converged(items: FrontierItem[], floor = 0.05): boolean {
  return items.length === 0 || items[0].score < floor;
}
