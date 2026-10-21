import type { Candidate, CandidateDecisionScope, Decision, Mission, PolicyRule } from '../mission/types.ts';
import { candidateDecisionOf, confirmDigest } from './confirm.ts';
import { forgeryShapesOf } from './forgery.ts';
import { verdictRows, type GateContext } from './gate.ts';
import { assertHumanDecision } from './policy.ts';
import { candidateVerdict } from './verdict.ts';

/**
 * `forge approve|reject|override` (PLAN F-4.9, resolution 13, RULINGS R10.4, R14 D-9).
 *
 * Every candidate decision goes through WS1's one guard (`assertHumanDecision`) against the
 * one digest `confirmDigest` defines for it (candidate id, diff digest and gate-set digest),
 * so the CLI, the GUI and `guardCheck` agree on a single code. An approve is admitted only when the verdict, recomputed here from rows (never
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
 * Rules no decision can override: all of them (RULINGS R15.4). A violation is cured by a new
 * candidate from the author, never by a human waving it through or by patching in place. The
 * record type makes a rule added to `PolicyRule` without a line here a type error.
 */
const EVERY_RULE: Record<PolicyRule, true> = {
  'protected-path': true, 'gate-path': true, 'spec-path': true, 'outside-scope': true, 'path-escape': true,
  symlink: true, gitlink: true, 'exec-mode': true, 'empty-diff': true, 'too-many-files': true, 'too-large': true,
  'secret-in-diff': true,
};
export const UNCURABLE_RULES: readonly PolicyRule[] = Object.keys(EVERY_RULE) as PolicyRule[];

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
  /** `--confirm <digest8>` of `confirmDigest(operation, candidateId)`. */
  confirm: string | undefined;
  /** Commit subject to use instead of the work item title (approve and override only). */
  subject?: string;
  /** `--acknowledge-possible-secret`: required to approve or override a candidate with a possible secret (R16). */
  acknowledgePossibleSecret?: boolean;
  /** `--acknowledge-forgery-shape`: required to approve or override a candidate with test-output forgery shapes (P2-R49). */
  acknowledgeForgeryShape?: boolean;
}

/**
 * Low-tier secret hits (RULINGS R16): a curable warning, not a violation. Read from the
 * candidate's `possibleSecretHits`, the field WS4 expects capture to record; until capture
 * records the low tier the count is 0 for every stored row (TRACKED for WS2/WS1).
 */
export function possibleSecretsOf(c: Candidate): number {
  const n = (c as Candidate & { possibleSecretHits?: unknown }).possibleSecretHits;
  return typeof n === 'number' && n > 0 ? n : 0;
}

const KIND = { 'approve-candidate': 'approve', 'reject-candidate': 'reject', 'override-candidate': 'override' } as const;

export function decideCandidate(ctx: DecideContext, input: DecideInput): Decision {
  if (!OPERATIONS.includes(input.operation)) throw new CandidateRefused(`not a candidate operation: ${String(input.operation)}`);
  const c = ctx.store.candidate(input.candidateId);
  if (!c) throw new CandidateRefused(`unknown candidate ${input.candidateId}`);
  const preview = confirmDigest(ctx, input.operation, c.id);
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
  const possible = input.operation === 'reject-candidate' ? 0 : possibleSecretsOf(c);
  if (possible && !input.acknowledgePossibleSecret) {
    throw new CandidateRefused(`candidate ${c.id} has ${possible} possible secret(s); read the diff, then re-run with --acknowledge-possible-secret`);
  }
  const forged = input.operation === 'reject-candidate' ? [] : forgeryShapesOf(ctx.artifacts, c);
  if (forged.length && !input.acknowledgeForgeryShape) {
    throw new CandidateRefused(`candidate ${c.id} has test-output forgery shapes in ${forged.map((h) => h.path).join(', ')}; read the diff, then re-run with --acknowledge-forgery-shape`);
  }

  const scope: CandidateDecisionScope & { commitSubject?: string; acknowledgedPossibleSecrets?: number; acknowledgedForgeryShapes?: string[] } = {
    operation: input.operation, candidateId: c.id, diffDigest: c.diffArtifact.digest,
    gateSetDigest: c.gateSetDigest, baseCommit: c.baseCommit,
    ...(input.subject !== undefined && input.operation !== 'reject-candidate' ? { commitSubject: input.subject } : {}),
    ...(possible ? { acknowledgedPossibleSecrets: possible } : {}),
    ...(forged.length ? { acknowledgedForgeryShapes: forged.map((h) => h.path) } : {}),
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
