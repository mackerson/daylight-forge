import type { ArtifactStore } from '../mission/artifacts.ts';
import type { DaylightContext } from '../mission/context.ts';
import type { MissionStore } from '../mission/store.ts';
import type { Candidate, Decision } from '../mission/types.ts';
import { confirmDigest } from './confirm.ts';
import { assertHumanDecision, forgeryWhy } from './policy.ts';

/**
 * Test-output forgery shapes on a candidate (P2-R43, P2-R49): a curable warning in the
 * `possible-secret` tier. A candidate with one never lands on its own; a person reads the diff
 * and acknowledges the shapes, or rejects them, through one guarded decision per candidate diff.
 */

export const FORGERY_OPERATION = 'acknowledge-forgery-shape' as const;

export class ForgeryReviewRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeryReviewRefused';
  }
}

export interface ForgeryHit {
  path: string;
  shapes: string[];
}

/**
 * The shapes capture recorded in the candidate's summary flags. An unreadable summary is one hit
 * on the whole diff: what cannot be read cannot be cleared (fail closed).
 */
export function forgeryShapesOf(artifacts: Pick<ArtifactStore, 'text'>, c: Pick<Candidate, 'summaryArtifact'>): ForgeryHit[] {
  let summary: { flags?: Array<{ path?: unknown; forgeryShapes?: unknown }> };
  try {
    summary = JSON.parse(artifacts.text(c.summaryArtifact)) as typeof summary;
  } catch {
    return [{ path: '(the whole diff)', shapes: ['an unreadable candidate summary'] }];
  }
  const out: ForgeryHit[] = [];
  for (const f of Array.isArray(summary.flags) ? summary.flags : []) {
    const shapes = Array.isArray(f.forgeryShapes) ? f.forgeryShapes.filter((s): s is string => typeof s === 'string') : [];
    if (shapes.length) out.push({ path: typeof f.path === 'string' ? f.path : '(unknown path)', shapes });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The latest person's review of this candidate's exact diff, or null. */
export function forgeryReviewOf(store: Pick<MissionStore, 'decisions'>, c: Pick<Candidate, 'id' | 'missionId' | 'diffArtifact'>): Decision | null {
  return store.decisions(c.missionId)
    .filter((d) => d.scope.operation === FORGERY_OPERATION && d.scope.candidateId === c.id && d.scope.diffDigest === c.diffArtifact.digest)
    .at(-1) ?? null;
}

/**
 * Why this candidate may not land yet, or null: it has shapes and no person acknowledged them
 * (`waiting`), or a person rejected them (`rejected`).
 */
export function forgeryHold(
  ctx: { store: Pick<MissionStore, 'decisions'>; artifacts: Pick<ArtifactStore, 'text'> }, c: Candidate,
): { state: 'waiting' | 'rejected'; why: string } | null {
  const hits = forgeryShapesOf(ctx.artifacts, c);
  if (!hits.length) return null;
  const review = forgeryReviewOf(ctx.store, c);
  if (review?.kind === 'approve') return null;
  const where = hits.map((h) => `${h.path} (${h.shapes.join(', ')})`).join('; ');
  if (review) return { state: 'rejected', why: `a person rejected the forgery shapes of candidate ${c.id} in decision ${review.id}: ${where}` };
  return {
    state: 'waiting',
    why: `candidate ${c.id}: ${forgeryWhy(hits.flatMap((h) => h.shapes))}; in ${where}. A person reads the diff and runs \`daylight forge acknowledge-forgery ${c.id}\` (or with --declined)`,
  };
}

export interface ForgeryReviewInput {
  candidateId: string;
  actor: string;
  rationale: string;
  confirm: string | undefined;
  /** Reject the shapes instead of acknowledging them; a different confirm code. */
  declined?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}

/** `forge acknowledge-forgery`: a person's guarded decision on one candidate's forgery shapes. */
export function reviewForgeryShape(
  ctx: Pick<DaylightContext, 'store' | 'artifacts'> & { events?: DaylightContext['events'] }, input: ForgeryReviewInput,
): Decision {
  const c = ctx.store.candidate(input.candidateId);
  if (!c) throw new ForgeryReviewRefused(`unknown candidate ${input.candidateId}`);
  const declined = input.declined === true;
  const preview = confirmDigest(ctx, FORGERY_OPERATION, c.id, { declined });
  assertHumanDecision(input.env ?? process.env, input.actor, input.confirm, preview.digest);
  if (!input.rationale?.trim()) throw new ForgeryReviewRefused(`${FORGERY_OPERATION} needs a rationale`);
  const hits = forgeryShapesOf(ctx.artifacts, c);
  if (!hits.length) throw new ForgeryReviewRefused(`candidate ${c.id} has no forgery shape to review`);
  const prior = forgeryReviewOf(ctx.store, c);
  if (prior) throw new ForgeryReviewRefused(`candidate ${c.id}'s forgery shapes were already reviewed in decision ${prior.id}`);
  const m = ctx.store.mission(c.missionId)!;
  const d = ctx.store.recordDecision({
    missionId: m.id, projectId: m.projectId, revision: c.baseCommit, actor: input.actor, kind: declined ? 'reject' : 'approve',
    rationale: input.rationale.trim(), artifactIds: [c.diffArtifact.id],
    scope: {
      operation: FORGERY_OPERATION, candidateId: c.id, diffDigest: c.diffArtifact.digest, declined,
      paths: hits.map((h) => h.path), shapes: [...new Set(hits.flatMap((h) => h.shapes))],
    },
  });
  ctx.events?.append({
    projectId: m.projectId, missionId: m.id, category: 'approval', name: 'approval.decided',
    payload: { decisionId: d.id, operation: FORGERY_OPERATION, kind: d.kind, candidateId: c.id, diffDigest: c.diffArtifact.digest },
  });
  return d;
}
