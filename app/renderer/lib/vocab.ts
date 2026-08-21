/**
 * The words the interface uses, and where they meet the words the store uses.
 *
 * The design renames one thing and one thing only: a belief the sources disagree about is
 * *contested*, not CONTRADICTED. That is not cosmetic — "contradicted" reads as a fault in
 * the data, and the whole argument of the tool is that two sources disagreeing is the most
 * valuable state it can reach. But the store is right to keep its own name: `ClaimStatus`
 * is written to disk, exported over MCP, and shared between machines, so renaming it would
 * be a data migration in service of a caption.
 *
 * So the mapping lives here, at the render boundary, and nowhere else. Panels ask for a
 * `state`; only this file knows a `ClaimStatus`.
 */
import type { Claim, ClaimStatus, Source } from './types.ts';

export type Tone = 'ok' | 'accent' | 'warn' | 'bad' | 'dim';

export interface BeliefState {
  /** What the interface calls it. */
  name: string;
  tone: Tone;
  /** Why a belief is here, in the terms of the ladder rather than the schema. */
  why: string;
  /** Position on the ladder, for sorting. Contested sorts first: it is the queue. */
  rank: number;
}

const STATES: Record<ClaimStatus, BeliefState> = {
  CONTRADICTED: {
    name: 'contested', tone: 'bad', rank: 0,
    why: 'sources disagree — your call',
  },
  INFERRED: {
    name: 'inferred', tone: 'warn', rank: 1,
    why: 'one source only — cheap to corroborate',
  },
  STALE: {
    name: 'stale', tone: 'warn', rank: 2,
    why: 'the file changed under the claim',
  },
  CORROBORATED: {
    name: 'corroborated', tone: 'ok', rank: 3,
    why: 'independent sources agree',
  },
  CONFIRMED: {
    name: 'confirmed', tone: 'accent', rank: 4,
    why: 'you signed off',
  },
  UNKNOWN: {
    name: 'unexamined', tone: 'dim', rank: 5,
    why: 'nothing has been claimed here yet',
  },
};

export const state = (s: ClaimStatus): BeliefState => STATES[s] ?? STATES.UNKNOWN;

/** The ladder, in the order the triage screen lays it out. */
export const LADDER: ClaimStatus[] = ['INFERRED', 'CORROBORATED', 'CONFIRMED', 'CONTRADICTED'];

/**
 * A source as the store counts it.
 *
 * `tool:model` rather than `tool`, because that pair is the provenance key: two claude runs
 * on different models corroborate each other and two on the same model do not. Anything
 * that shows "who said this" has to show the pair or it is showing a smaller number than
 * the belief calculus used.
 */
export const sourceKey = (s: Source): string =>
  s.kind === 'human' ? 'you' : `${s.tool ?? s.kind}:${s.model ?? 'default'}`;

/** Stable per-source hue, so a tool keeps its colour across every screen and the map. */
export function sourceColor(name: string): string {
  if (name === 'you') return '#6098d6';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return `hsl(${(h >>> 0) % 360} 48% 62%)`;
}

/** `path/to/file.ts#Symbol` → `path/to/file.ts`. Ids carry both; most rows want one. */
export const fileOf = (id: string): string =>
  id.includes('#') ? id.slice(0, id.indexOf('#')) : id;

/** The last two path segments, for a row that has no room for an absolute path. */
export const shorten = (p: string): string => {
  const parts = p.split('/');
  return parts.length <= 3 ? p : `…/${parts.slice(-2).join('/')}`;
};

/**
 * How much it would cost to move this belief one rung.
 *
 * Used to sort the inferred pile "cheapest to settle at the top". A belief with one claim
 * needs one more source to reach corroborated; one already carrying several needs a human.
 * Fewer claims is cheaper, and a shallower evidence trail is cheaper to re-walk.
 */
export const settleCost = (claims: Claim[]): number =>
  claims.length + claims.reduce((n, c) => n + c.evidence.length, 0) / 10;

/**
 * The belief as a question, short enough for a headline.
 *
 * `frontier.ts` writes these too, at length and with the traps spelled out, because it is
 * briefing an agent that cannot ask a follow-up. A human looking at the answer needs the
 * opposite: the shortest phrasing that still names the choice being made.
 */
export function questionFor(predicate: string, subject: string): string {
  const short = subject.includes('#') ? subject.slice(subject.indexOf('#') + 1) : shorten(subject);
  switch (predicate) {
    case 'duplication_verdict':
      return `Is ${short} one concept, or more than one written more than once?`;
    case 'god_verdict':
      return `Is ${short} one thing many modules legitimately need, or several things in one file?`;
    case 'liveness_verdict':
      return `Is ${short} actually unreachable, or reached in a way the static pass cannot see?`;
    case 'limb_verdict':
      return `Is ${short} a module with a shared purpose, or just a folder?`;
    case 'cycle_verdict':
      return `Is this cycle real and worth breaking, or harmless?`;
    case 'divergence_verdict':
      return `Should ${short} move to where its neighbours are, or is the coupling the problem?`;
    case 'purpose':
      return `What is ${short} for?`;
    case 'canonical_of':
      return `Which declaration of ${short} is the canonical one?`;
    default:
      return `${predicate} — ${short}`;
  }
}

/** USD, rendered the one way. A cost nobody can compare is a cost nobody reads. */
export const money = (n: number): string => `$${n.toFixed(2)}`;
