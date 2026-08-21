/**
 * Candidates: what the static tools flagged, framed as questions.
 *
 * A candidate is machine-found suspicion. It is never a verdict, and the shapes here are
 * built so that it cannot accidentally become one — there is a `question` and a `measure`
 * and no field anywhere that says whether the thing is bad.
 *
 * This module is runtime-free on purpose. `frontier.ts` needs the same subject keys and it
 * imports the claim store, which pulls in node:sqlite; the renderer needs them too and must
 * not follow that import. The same split the focus, claim and structure shapes already
 * needed. `frontier.ts` is the consumer that turns these into agent work; this file is the
 * single place that decides what a candidate's subject is called, so the verdict an agent
 * writes and the row a human clicks are keyed the same way.
 */
import type { DuplicationReport } from './duplication.ts';
import type { StructureReport } from './structure-types.ts';

export type CandidateKind =
  | 'duplication' | 'unreachable' | 'overlap' | 'divergence' | 'tangle' | 'hub';

/** The verdict predicate each kind expects back. Agents are told these by name. */
export const PREDICATE: Record<CandidateKind, string> = {
  duplication: 'duplication_verdict',
  unreachable: 'liveness_verdict',
  overlap: 'limb_verdict',
  divergence: 'divergence_verdict',
  tangle: 'cycle_verdict',
  hub: 'god_verdict',
};

/**
 * Subject keys.
 *
 * A family, a file and a symbol are already ids and are their own subject. A cycle and a
 * limb are not — they are a set and a directory — so they get a prefixed synthetic id, and
 * it has to be spelled the same way everywhere or a verdict lands on a subject nothing ever
 * asks about again.
 */
export const cycleSubject = (members: string[]): string => `cycle:${members[0]}`;
export const limbSubject = (dir: string): string => `limb:${dir}`;

const fileOf = (id: string): string => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);
const dirOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
};

export interface Candidate {
  /** Stable across re-maps, so a selection survives a rebuild. */
  id: string;
  kind: CandidateKind;
  /**
   * The claim-store subjects this row covers.
   *
   * Usually one. A group — "nothing imports these nine files" — carries all of them, so
   * sending the row to explore asks about every member rather than only the first.
   */
  subjects: string[];
  predicate: string;
  /** What it is about, in path terms. */
  where: string;
  /** The question, and only ever a question. */
  question: string;
  /** What the tool actually measured. A number, not an opinion. */
  measure: string;
  /** Why the tool thinks so — the trail, so the suspicion is checkable. */
  evidence: string[];
  /** Files implicated, for lighting them up on the map. */
  files: string[];
  /** How much of this an agent could plausibly settle. The list sorts by it. */
  weight: number;
}

const TIER_WEIGHT: Record<string, number> = { high: 1, medium: 0.7, low: 0.25 };

/**
 * Every candidate the static pass produced, ranked by how much an agent could resolve.
 *
 * Dead files are grouped by directory. The detector emits one candidate per file and there
 * are routinely over a hundred of them; a hundred rows that all say "nothing imports this"
 * is not a hundred questions, it is one question about a directory, and asking it that way
 * is both cheaper and the way a human already thinks about it.
 */
export function candidates(
  findings: DuplicationReport | null,
  structure: StructureReport | null,
): Candidate[] {
  const out: Candidate[] = [];

  for (const fam of findings?.families ?? []) {
    const files = [...new Set(fam.members.map(fileOf))];
    out.push({
      id: `duplication:${fam.id}`,
      kind: 'duplication',
      subjects: [fam.id],
      predicate: PREDICATE.duplication,
      where: files.length === 1 ? files[0] : files.slice(0, 2).join(' ↔ '),
      question: `Are these ${fam.members.length} declarations the same concept, or ${fam.members.length} of them?`,
      measure: fam.topScore !== undefined
        ? `${fam.topScore.toFixed(2)} similarity`
        : `${fam.detectors.join('+')}`,
      evidence: [...fam.evidence, `members: ${fam.members.join(', ')}`],
      files,
      weight: fam.members.length * (fam.topScore ?? 0.5),
    });
  }

  // Dead files, one row per directory.
  const byDir = new Map<string, StructureReport['dead']>();
  for (const d of structure?.dead ?? []) {
    const dir = dirOf(fileOf(d.id));
    const list = byDir.get(dir) ?? [];
    list.push(d);
    byDir.set(dir, list);
  }
  for (const [dir, dead] of byDir) {
    const tier = dead.some((d) => d.tier === 'high') ? 'high'
      : dead.some((d) => d.tier === 'medium') ? 'medium' : 'low';
    const files = [...new Set(dead.map((d) => fileOf(d.id)))];
    // The caveats are the point: a file "unreachable" because the pass cannot see a dynamic
    // import is a different claim from one nothing mentions anywhere. Keep them distinct.
    const whys = [...new Set(dead.map((d) => d.why))];
    out.push({
      id: `unreachable:${dir}`,
      kind: 'unreachable',
      subjects: dead.map((d) => d.id),
      predicate: PREDICATE.unreachable,
      where: `${dir}/*`,
      question: dead.length === 1
        ? 'Nothing imports this. Dead, or reached in a way the static pass cannot see?'
        : `Nothing imports these ${dead.length}. Dead, or an entry point the static pass cannot see?`,
      measure: `${files.length} file${files.length === 1 ? '' : 's'}, 0 importers`,
      evidence: whys,
      files,
      weight: dead.length * (TIER_WEIGHT[tier] ?? 0.25),
    });
  }

  for (const limb of structure?.limbs ?? []) {
    out.push({
      id: `overlap:${limb.dir}`,
      kind: 'overlap',
      subjects: [limbSubject(limb.dir)],
      predicate: PREDICATE.overlap,
      where: `${limb.dir}/*`,
      question: 'Almost everything here connects outward. A module, or just a folder?',
      measure: `${Math.round(limb.leakage * 100)}% of edges leave`,
      evidence: [
        `${limb.files} files · ${limb.inside} edges inside · ${limb.outside} leaving`,
        'a utils or types directory legitimately leaks — that is what makes this a question',
      ],
      files: [],
      weight: limb.leakage * limb.files,
    });
  }

  for (const d of structure?.divergences ?? []) {
    out.push({
      id: `divergence:${d.file}`,
      kind: 'divergence',
      subjects: [d.file],
      predicate: PREDICATE.divergence,
      where: `${d.file} → ${d.pull}`,
      question: 'Filed in one place and wired to another. Which of the two is the mistake?',
      measure: `${Math.round(d.share * 100)}% of neighbours in ${d.pull}`,
      evidence: [`lives in ${d.home}`, `${d.neighbours} neighbours, most of them elsewhere`],
      files: [d.file],
      weight: d.share * d.neighbours,
    });
  }

  for (const cyc of structure?.cycles ?? []) {
    out.push({
      id: `tangle:${cyc.members[0]}`,
      kind: 'tangle',
      subjects: [cycleSubject(cyc.members)],
      predicate: PREDICATE.tangle,
      where: cyc.members.slice(0, 2).join(' ↔ '),
      question: `These ${cyc.members.length} import each other in a loop. Which edge is the wrong one?`,
      measure: `${cyc.internalEdges} edges inside the cycle`,
      evidence: [cyc.members.join(', ')],
      files: cyc.members,
      weight: cyc.internalEdges,
    });
  }

  for (const god of structure?.gods ?? []) {
    out.push({
      id: `hub:${god.id}`,
      kind: 'hub',
      subjects: [god.id],
      predicate: PREDICATE.hub,
      where: god.id,
      question: 'One thing many modules legitimately need, or several things in one file?',
      measure: `${god.fanIn} dependents${god.churn ? ` · ${god.churn} commits` : ''}`,
      evidence: [
        `${god.fanOut} outgoing · ${god.symbols} exported symbols`,
        god.pain ? `fan-in x churn = ${god.pain}, which is what hurts day to day` : 'no git history to weigh churn',
      ],
      files: [god.id],
      weight: (god.pain ?? god.fanIn) / 20,
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/** Every file any candidate points at — the map's "what did the tools flag" colouring. */
export const flaggedFiles = (list: Candidate[]): Set<string> =>
  new Set(list.flatMap((c) => c.files));
