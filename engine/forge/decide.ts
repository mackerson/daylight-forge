import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import type { Candidate, CandidateDecisionScope, Decision, Mission, PolicyRule } from '../mission/types.ts';
import type { ConfirmDigest } from './confirm.ts';
import { verdictRows, type GateContext } from './gate.ts';
import { assertHumanDecision, confirmCodeOf } from './policy.ts';
import { candidateVerdict } from './verdict.ts';

/**
 * `forge approve|reject|override` (PLAN F-4.9, resolution 13, RULINGS R10.4, R14 D-9).
 *
 * Every candidate decision goes through WS1's one guard (`assertHumanDecision`) against a
 * digest over the operation, the candidate id, its diff digest and the gate-set digest it was
 * built against, so a code confirmed for one candidate, one diff or one gate set confirms
 * nothing else. An approve is admitted only when the verdict, recomputed here from rows (never
 * read off the candidate), is `accepted-by-gates`; an override needs a rationale and still
 * cannot cure the flags no human may wave through. A reject needs only a reason.
 */

export class CandidateRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateRefused';
  }
}

export type DecideContext = Pick<GateContext, 'store' | 'artifacts' | 'events' | 'repoRoot' | 'env'>;

export type CandidateOperation = CandidateDecisionScope['operation'];

/**
 * Rules no decision can override. A secret in the diff, an edit to a protected path, a gate
 * test or the spec, a path that escapes, and a symlink or gitlink each defeat the gates or the
 * host rather than fail them, so passing or overriding gates says nothing about them.
 */
export const UNCURABLE_RULES: readonly PolicyRule[] = [
  'secret-in-diff', 'protected-path', 'gate-path', 'spec-path', 'path-escape', 'symlink', 'gitlink',
];

export function uncurable(c: Pick<Candidate, 'policyViolations' | 'secretHits'>): string[] {
  const out = c.policyViolations
    .filter((v) => UNCURABLE_RULES.includes(v.rule))
    .map((v) => (v.path === null ? v.rule : `${v.rule}: ${v.path}`));
  if (c.secretHits > 0 && !c.policyViolations.some((v) => v.rule === 'secret-in-diff')) {
    out.push(`secret-in-diff: ${c.secretHits} hit(s)`);
  }
  return out;
}

const OPERATIONS: readonly CandidateOperation[] = ['approve-candidate', 'reject-candidate', 'override-candidate'];

/**
 * What a person confirms for a candidate act: `--confirm` is `confirmCodeOf(digest)`. `apply`
 * also names the approving decision and the ref it will create.
 */
export function candidateConfirm(
  ctx: Pick<DecideContext, 'store'>, operation: CandidateOperation | 'apply', candidateId: string,
  extra: { decisionId?: string; ref?: string } = {},
): ConfirmDigest {
  const c = ctx.store.candidate(candidateId);
  if (!c) throw new CandidateRefused(`unknown candidate ${candidateId}`);
  const id = {
    operation, candidateId: c.id, missionId: c.missionId, diffDigest: c.diffArtifact.digest,
    gateSetDigest: c.gateSetDigest, baseCommit: c.baseCommit,
    ...(operation === 'apply' ? { decisionId: extra.decisionId ?? null, ref: extra.ref ?? null } : {}),
  };
  const digest = digestOf(canonicalJson(id));
  const lines = [
    `${operation} candidate ${c.id} on mission ${c.missionId}`,
    `diff ${c.diffArtifact.digest} (${c.files.length} file(s)) on base ${c.baseCommit}`,
    `gates ${c.gateSetDigest}`,
    `verdict as recorded: ${c.verdict}`,
    ...(operation === 'apply' ? [`decision ${extra.decisionId ?? 'none'}`, `creates ${extra.ref ?? 'no ref'}`] : []),
  ];
  return { digest, digest8: confirmCodeOf(digest), lines };
}

/** The latest approve, reject or override of this candidate, or null. Later decisions replace earlier ones. */
export function candidateDecisionOf(ctx: Pick<DecideContext, 'store'>, c: Pick<Candidate, 'id' | 'missionId'>): Decision | null {
  const ds = ctx.store.decisions(c.missionId).filter((d) =>
    d.scope.candidateId === c.id && OPERATIONS.includes(d.scope.operation as CandidateOperation));
  return ds.at(-1) ?? null;
}

/** Shared by approve, override and apply: the bytes, the lock and the flags, or why not. */
export function candidateStanding(ctx: DecideContext, c: Candidate): string[] {
  const why: string[] = [];
  try {
    ctx.artifacts.get(c.diffArtifact);
  } catch (err) {
    why.push(`the diff artifact does not verify: ${(err as Error).message}`);
  }
  why.push(...uncurable(c).map((u) => `uncurable: ${u}`));
  const lock = ctx.store.lockDecision(c.missionId);
  if (!lock) why.push(`mission ${c.missionId} has no gate lock`);
  else if (lock.scope.gateSetDigest !== c.gateSetDigest) {
    why.push(`the candidate was built against gate set ${c.gateSetDigest}, but the lock is ${String(lock.scope.gateSetDigest)}`);
  }
  if (!c.files.length) why.push('the candidate changes no file');
  return why;
}

export function requireImplement(ctx: Pick<DecideContext, 'store'>, c: Candidate): Mission {
  const m = ctx.store.mission(c.missionId);
  if (!m) throw new CandidateRefused(`candidate ${c.id} names unknown mission ${c.missionId}`);
  if (m.kind !== 'implement') throw new CandidateRefused(`mission ${m.id} is ${m.kind}, not implement`);
  if (m.state === 'closed') throw new CandidateRefused(`mission ${m.id} is closed`);
  return m;
}

export interface DecideInput {
  candidateId: string;
  operation: CandidateOperation;
  actor: string;
  rationale: string;
  /** `--confirm <digest8>` of `candidateConfirm(operation, candidateId)`. */
  confirm: string | undefined;
  /** Commit subject to use instead of the work item title (approve and override only). */
  subject?: string;
}

const KIND = { 'approve-candidate': 'approve', 'reject-candidate': 'reject', 'override-candidate': 'override' } as const;

export function decideCandidate(ctx: DecideContext, input: DecideInput): Decision {
  if (!OPERATIONS.includes(input.operation)) throw new CandidateRefused(`not a candidate operation: ${String(input.operation)}`);
  const c = ctx.store.candidate(input.candidateId);
  if (!c) throw new CandidateRefused(`unknown candidate ${input.candidateId}`);
  const preview = candidateConfirm(ctx, input.operation, c.id);
  assertHumanDecision(ctx.env ?? process.env, input.actor, input.confirm, preview.digest);
  const m = requireImplement(ctx, c);
  if (!input.rationale?.trim()) throw new CandidateRefused(`${input.operation} needs a rationale`);
  if (ctx.store.application(c.id)) throw new CandidateRefused(`candidate ${c.id} is already applied`);
  const prior = candidateDecisionOf(ctx, c);
  if (prior && prior.scope.operation === input.operation) {
    throw new CandidateRefused(`candidate ${c.id} already has ${input.operation} decision ${prior.id}`);
  }

  if (input.operation !== 'reject-candidate') {
    const why = candidateStanding(ctx, c);
    if (why.length) throw new CandidateRefused(`${input.operation} refused:\n  ${why.join('\n  ')}`);
    const v = candidateVerdict(verdictRows(ctx, c));
    if (input.operation === 'approve-candidate' && v.verdict !== 'accepted-by-gates') {
      throw new CandidateRefused(`approve refused: the verdict on ${c.diffArtifact.digest} is ${v.verdict}, not accepted-by-gates:\n  ${v.reasons.join('\n  ')}`);
    }
    if (input.operation === 'override-candidate' && v.verdict === 'accepted-by-gates') {
      throw new CandidateRefused(`candidate ${c.id} is accepted by gates; approve it instead of overriding`);
    }
  }

  const scope: CandidateDecisionScope & { commitSubject?: string } = {
    operation: input.operation, candidateId: c.id, diffDigest: c.diffArtifact.digest,
    gateSetDigest: c.gateSetDigest, baseCommit: c.baseCommit,
    ...(input.subject !== undefined && input.operation !== 'reject-candidate' ? { commitSubject: input.subject } : {}),
  };
  const d = ctx.store.recordDecision({
    missionId: m.id, projectId: m.projectId, revision: c.baseCommit, actor: input.actor, kind: KIND[input.operation],
    rationale: input.rationale.trim(), scope: { ...scope }, artifactIds: [c.diffArtifact.id],
  });
  ctx.events?.append({
    projectId: m.projectId, missionId: m.id, category: 'approval', name: 'approval.decided',
    payload: {
      decisionId: d.id, operation: input.operation, kind: d.kind, candidateId: c.id,
      diffDigest: c.diffArtifact.digest, gateSetDigest: c.gateSetDigest, ...(d.kind === 'override' ? { overridden: true } : {}),
    },
  });
  return d;
}
