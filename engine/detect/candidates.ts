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
  | 'duplication' | 'unreachable' | 'unused-export' | 'overlap' | 'divergence' | 'tangle' | 'hub';

/** The verdict predicate each kind expects back. Agents are told these by name. */
export const PREDICATE: Record<CandidateKind, string> = {
  duplication: 'duplication_verdict',
  unreachable: 'liveness_verdict',
  // The same predicate: the question "is this reached" is the same question whether it is
  // asked about a file or about one export. Only the framing and the blast radius differ.
  'unused-export': 'liveness_verdict',
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
  /**
   * Whether the tool pointed at the file or at something inside it.
   *
   * Load-bearing for the map. A file nothing imports and a file with one unused export are
   * not the same finding, and colouring both identically is what made the candidates lens
   * light up two thirds of this repo — at which point the lens answers nothing.
   */
  scope: 'file' | 'symbol';
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
      scope: 'file',
      weight: fam.members.length * (fam.topScore ?? 0.5),
    });
  }

  /**
   * Dead things, grouped by directory — but never mixing the two kinds of dead.
   *
   * `structure.dead` reports files nothing imports and exported symbols nothing imports in
   * one list, distinguished only by `kind`. On this repo that is 1 file and 174 symbols, and
   * grouping them together produced a row reading "nothing imports these 30 · 9 files, 0
   * importers" about a directory whose files are all imported — the symbols were unused, not
   * the files. A tool that exists to stop people over-claiming cannot ship that sentence.
   *
   * They are also different questions. A file nothing reaches is probably deletable. An
   * export nothing reaches is often deliberate — it is API surface, or a type consumed
   * structurally — so it asks whether the export should exist, not whether the file should.
   */
  const deadFiles = (structure?.dead ?? []).filter((d) => d.kind === 'file');
  const deadSymbols = (structure?.dead ?? []).filter((d) => d.kind !== 'file');

  const group = (list: StructureReport['dead']) => {
    const byDir = new Map<string, StructureReport['dead']>();
    for (const d of list) {
      const dir = dirOf(fileOf(d.id));
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(d);
    }
    return byDir;
  };
  const worstTier = (dead: StructureReport['dead']) =>
    dead.some((d) => d.tier === 'high') ? 'high'
      : dead.some((d) => d.tier === 'medium') ? 'medium' : 'low';
  // The caveats are the point: a file "unreachable" because the pass cannot see a dynamic
  // import is a different claim from one nothing mentions anywhere. Keep them distinct.
  const whysOf = (dead: StructureReport['dead']) => [...new Set(dead.map((d) => d.why))];

  for (const [dir, dead] of group(deadFiles)) {
    const files = [...new Set(dead.map((d) => fileOf(d.id)))];
    out.push({
      id: `unreachable:${dir}`,
      kind: 'unreachable',
      subjects: dead.map((d) => d.id),
      predicate: PREDICATE.unreachable,
      where: files.length === 1 ? files[0] : `${dir}/*`,
      question: files.length === 1
        ? 'Nothing imports this file. Dead, or reached in a way the static pass cannot see?'
        : `Nothing imports these ${files.length} files. Dead, or an entry point the static pass cannot see?`,
      measure: `${files.length} file${files.length === 1 ? '' : 's'}, 0 importers`,
      evidence: whysOf(dead),
      files,
      scope: 'file',
      weight: dead.length * (TIER_WEIGHT[worstTier(dead)] ?? 0.25),
    });
  }

  for (const [dir, dead] of group(deadSymbols)) {
    const files = [...new Set(dead.map((d) => fileOf(d.id)))];
    out.push({
      id: `unused-export:${dir}`,
      kind: 'unused-export',
      subjects: dead.map((d) => d.id),
      predicate: PREDICATE['unused-export'],
      where: `${dir}/*`,
      question: dead.length === 1
        ? 'One export nothing imports. Dead, or surface someone is meant to use?'
        : `${dead.length} exports nothing imports. Dead, or surface someone is meant to use?`,
      measure: `${dead.length} export${dead.length === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'}`,
      evidence: [
        ...whysOf(dead),
        `the files themselves are imported — this is about what they expose: ${dead.slice(0, 4).map((d) => d.id.split('#')[1] ?? d.id).join(', ')}`,
      ],
      files,
      // Symbol-scoped, so it does not colour the map: two thirds of a repo lit amber because
      // its type modules export types is a lens that has stopped distinguishing anything.
      scope: 'symbol',
      weight: dead.length * (TIER_WEIGHT[worstTier(dead)] ?? 0.25) * 0.4,
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
      scope: 'file',
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
      scope: 'file',
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
      scope: 'file',
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
      scope: 'file',
      weight: (god.pain ?? god.fanIn) / 20,
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * Every file a candidate points *at* — the map's "what did the tools flag" colouring.
 *
 * Symbol-scoped candidates are excluded on purpose. They are real findings and they belong
 * in the list, but a file is not suspicious because one of its exports is unused, and
 * colouring it as though it were is how the lens came to light two thirds of this repo.
 */
export const flaggedFiles = (list: Candidate[]): Set<string> =>
  new Set(list.filter((c) => c.scope === 'file').flatMap((c) => c.files));
