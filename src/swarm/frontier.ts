import type { Graph } from '../graph/types.ts';
import type { ClaimStore } from '../store/claims.ts';

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
  kind: 'file' | 'family' | 'contradiction';
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

export function frontier(graph: Graph, store: ClaimStore, findings: Findings = {}): FrontierItem[] {
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
      case 'INFERRED':
        return { u: Math.max(0.1, 1 - b.confidence), why: 'single uncorroborated source' };
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

  return items.sort((a, b) => b.score - a.score);
}
