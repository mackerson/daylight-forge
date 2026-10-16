import type { Belief, Claim, ClaimStatus, Evidence } from '../store/types.ts';
import { canonicalise, type ClaimStore } from '../store/claims.ts';
import type { MissionScope } from './types.ts';

/**
 * What the reviewers disagreed about, and what only one of them looked at.
 *
 * Deterministic on purpose. The claim store already decides CONTRADICTED by its own rules;
 * this only narrows that to the mission's scope and lays each side out so a person can see
 * who said what on which lines. No model is asked to reconcile anything here — a dispute is
 * the *input* to an experiment, not something prose gets to settle.
 */

export interface DisputeSide {
  /** `kind:tool:model`, the key the belief calculus counts independence by. */
  source: string;
  value: unknown;
  confidence: number;
  evidence: Evidence[];
  claimId: number;
  sessionId?: string;
  at: number;
}

export interface Dispute {
  subject: string;
  predicate: string;
  belief: Belief;
  sides: DisputeSide[];
  /** True when every side cites at least one identical file:line — a judgement call. */
  sameEvidence: boolean;
}

export interface Comparison {
  disputes: Dispute[];
  /** INFERRED from a single source: nobody has checked it. */
  unverified: Belief[];
  /** CORROBORATED or CONFIRMED in scope — listed so "nothing in dispute" is not mistaken for "nothing examined". */
  settled: Belief[];
}

/** A subject is in scope when it is a scoped path, or a symbol inside one. */
export function inScope(subject: string, scope: MissionScope): boolean {
  const paths = scope.paths ?? [];
  const symbols = scope.symbols ?? [];
  if (!paths.length && !symbols.length) return true;
  if (symbols.includes(subject)) return true;
  const file = subject.includes('#') ? subject.slice(0, subject.indexOf('#')) : subject;
  return paths.some((p) => file === p || file.startsWith(`${p}/`));
}

/**
 * The claims a mission's comparison, inspection and export are about: agent claims made in
 * this mission's own sessions, and human and static claims, which are facts about the
 * repository rather than about who reviewed it. Another mission's reviewer on the same
 * subject neither corroborates nor contradicts this one's.
 */
export function missionClaims(missionId: string): (c: Claim) => boolean {
  const prefix = `${missionId}:`;
  return (c) => c.source.kind !== 'agent' || (c.source.sessionId ?? '').startsWith(prefix);
}

/** Said in a comparison record, so a reader knows which claims it was drawn from. */
export const MISSION_CLAIM_FILTER = 'agent claims from this mission\'s sessions, plus human and static claims';

export const sourceKey = (c: Claim): string =>
  `${c.source.kind}:${c.source.tool ?? ''}:${c.source.model ?? ''}`;

const spanKey = (e: Evidence) => (e.file ? `${e.file}:${e.line ?? ''}` : null);

function sidesOf(belief: Belief): DisputeSide[] {
  // Every non-human claim is a side of its own, so no citation is lost to grouping; the
  // arbitration screen collapses agreeing sides when it draws them.
  return belief.claims
    .filter((c) => c.source.kind !== 'human')
    .map((c) => ({
      source: sourceKey(c),
      value: canonicalise(c.predicate, c.value).compare,
      confidence: c.confidence,
      evidence: c.evidence,
      claimId: c.id,
      sessionId: c.source.sessionId,
      at: c.at,
    }));
}

function shareASpan(sides: DisputeSide[]): boolean {
  if (sides.length < 2) return false;
  const spans = sides.map((s) => new Set(s.evidence.map(spanKey).filter(Boolean) as string[]));
  const [first, ...rest] = spans;
  return [...first].some((k) => rest.every((s) => s.has(k)));
}

export function compare(claims: ClaimStore, scope: MissionScope, admit?: (c: Claim) => boolean): Comparison {
  const disputes: Dispute[] = [];
  const unverified: Belief[] = [];
  const settled: Belief[] = [];
  const seen = new Set<string>();

  for (const { subject, predicate } of claims.allSubjects()) {
    if (!inScope(subject, scope)) continue;
    const canonical = canonicalise(predicate, undefined).predicate;
    const key = `${subject}\u0000${canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const belief = claims.belief(subject, predicate, undefined, admit);
    const status: ClaimStatus = belief.status;
    if (status === 'CONTRADICTED') {
      const sides = sidesOf(belief);
      disputes.push({ subject, predicate: canonical, belief, sides, sameEvidence: shareASpan(sides) });
    } else if (status === 'INFERRED') {
      unverified.push(belief);
    } else if (status === 'CORROBORATED' || status === 'CONFIRMED') {
      settled.push(belief);
    }
  }

  const bySubject = (a: { subject: string }, b: { subject: string }) => a.subject.localeCompare(b.subject);
  disputes.sort(bySubject);
  unverified.sort(bySubject);
  settled.sort(bySubject);
  return { disputes, unverified, settled };
}
