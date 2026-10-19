import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import type { MissionStore } from '../mission/store.ts';
import type { Candidate, Decision, DecisionOperation } from '../mission/types.ts';
import { confirmCodeOf } from './policy.ts';

/**
 * What a human confirms: the digest `--confirm <digest8>` must match, and the lines a CLI
 * prompt or the GUI's native dialog shows beside it. Read-only.
 *
 * One definition per act, so the CLI, the GUI and the guard agree on what was confirmed:
 * - `authorize-mission` (mission id, plus the permissions and budget asked for): the mission's
 *   identity and the grant, so a code confirmed for one grant does not authorise another.
 * - `adhoc-mission` (the objective text, since the mission does not exist yet, plus the
 *   project), so one objective confirmed in one repository is not a code for another.
 * - `lock-gates` (mission id, plus the experiment ids to lock): `store.gateSet`'s digest, the
 *   same computation `lockGates` records, so any subset is confirmable.
 * - `approve-work-item` / `reject-work-item` (work item id): the item's content digest.
 * - `approve-candidate` / `reject-candidate` / `override-candidate` (candidate id): a digest
 *   over the operation, candidate id, mission, diff digest, gate-set digest and base, so a code
 *   confirmed for one candidate, diff, gate set or act confirms nothing else (two candidates
 *   with byte-identical diffs still get different codes).
 * - `apply` (candidate id): the same, plus the approving decision it will apply and the ref
 *   it will create.
 */
export type ConfirmOperation = DecisionOperation | 'apply';

/** The branch `apply` creates for a mission. Never overwritten. */
export const applyRefFor = (missionId: string) => `refs/heads/daylight/${missionId}`;

const CANDIDATE_OPERATIONS = ['approve-candidate', 'reject-candidate', 'override-candidate'];

/** The latest approve, reject or override of this candidate, or null. Later decisions replace earlier ones. */
export function candidateDecisionOf(
  ctx: { store: Pick<MissionStore, 'decisions'> }, c: Pick<Candidate, 'id' | 'missionId'>,
): Decision | null {
  return ctx.store.decisions(c.missionId)
    .filter((d) => d.scope.candidateId === c.id && CANDIDATE_OPERATIONS.includes(String(d.scope.operation)))
    .at(-1) ?? null;
}

export interface ConfirmDigest {
  digest: string;
  digest8: string;
  lines: string[];
}

type Store = Pick<MissionStore, 'mission' | 'gateSet' | 'workItem' | 'candidate' | 'decisions'> & Partial<Pick<MissionStore, 'campaignGateSet'>>;

export interface ConfirmOptions {
  /** `lock-gates`, `lock-campaign-gates`: exactly the experiments the lock will name. Required. */
  experimentIds?: readonly string[];
  /** `lock-campaign-gates`: whether the lock ratchets (P2-R17). Required. */
  ratchet?: boolean;
  /** `authorize-mission`: what will be granted. Required. */
  permissions?: { write: boolean; execute: boolean };
  /** `authorize-mission`: the budget that will be set, or null to leave it. Required. */
  maxUsd?: number | null;
  /** `adhoc-mission`: the project the mission will belong to. Required. */
  projectId?: string;
}

export function confirmDigest(
  ctx: { store: Store }, operation: ConfirmOperation, subjectId: string, opts: ConfirmOptions = {},
): ConfirmDigest {
  const out = (digest: string, lines: string[]): ConfirmDigest => ({ digest, digest8: confirmCodeOf(digest), lines });
  switch (operation) {
    case 'authorize-mission': {
      const m = ctx.store.mission(subjectId);
      if (!m) throw new Error(`unknown mission ${subjectId}`);
      if (!opts.permissions || opts.maxUsd === undefined) {
        throw new Error('authorize-mission confirms a grant; pass the permissions and maxUsd it will record');
      }
      const permissions = { write: !!opts.permissions.write, execute: !!opts.permissions.execute };
      const id = {
        operation, missionId: m.id, projectId: m.projectId, kind: m.kind, objective: m.objective,
        baseRevision: m.baseRevision, workItemId: m.workItemId ?? null, permissions, maxUsd: opts.maxUsd,
      };
      return out(digestOf(canonicalJson(id)), [
        `authorize ${m.kind} mission ${m.id}`, `project ${m.projectId} at ${m.baseRevision}`,
        `objective: ${m.objective}`, `work item: ${m.workItemId ?? 'none (ad hoc)'}`,
        `grant: write ${permissions.write ? 'yes' : 'no'}, execute ${permissions.execute ? 'yes' : 'no'}, `
          + `budget ${opts.maxUsd === null ? 'unchanged' : `$${opts.maxUsd}`}`,
      ]);
    }
    case 'adhoc-mission':
      if (!opts.projectId) throw new Error('adhoc-mission confirms a mission in one project; pass its projectId');
      return out(digestOf(canonicalJson({ operation, projectId: opts.projectId, objective: subjectId })), [
        `start an implement mission with no work item in ${opts.projectId}`, `objective: ${subjectId}`,
      ]);
    case 'lock-gates': {
      if (!opts.experimentIds) throw new Error('lock-gates confirms a chosen set; pass the experiment ids the lock will name');
      const { experiments, gateSetDigest } = ctx.store.gateSet(subjectId, opts.experimentIds);
      return out(gateSetDigest, [
        `lock ${experiments.length} gate(s) on mission ${subjectId}`,
        ...experiments.map((x) => `${x.role} ${x.id} harness ${x.harnessDigest}`),
      ]);
    }
    case 'lock-campaign-gates': {
      if (!opts.experimentIds || opts.ratchet === undefined || !ctx.store.campaignGateSet) {
        throw new Error('lock-campaign-gates confirms a chosen set and a ratchet flag; pass the experiment ids and ratchet');
      }
      // The gate-set digest, which covers bindings, roles and the ratchet flag: what the lock records.
      const { experiments, bindings, gateSetDigest } = ctx.store.campaignGateSet(subjectId, opts.experimentIds, opts.ratchet);
      const holdouts = experiments.filter((x) => x.role === 'holdout').length;
      return out(gateSetDigest, [
        `lock ${experiments.length} campaign gate(s) on campaign ${subjectId}, ratchet ${opts.ratchet ? 'on' : 'off'}`,
        ...experiments.filter((x) => x.role !== 'holdout')
          .map((x) => `${x.role} ${x.id} ${bindings[x.id] ? `ticket ${bindings[x.id]}` : 'every ticket'} harness ${x.harnessDigest}`),
        ...(holdouts ? [`${holdouts} holdout(s), counted, not named`] : []),
      ]);
    }
    case 'approve-work-item':
    case 'reject-work-item': {
      const w = ctx.store.workItem(subjectId);
      if (!w) throw new Error(`unknown work item ${subjectId}`);
      return out(w.contentDigest, [`${operation === 'approve-work-item' ? 'approve' : 'reject'} work item ${w.id}: ${w.title}`, `anchor ${w.anchor}`]);
    }
    case 'approve-candidate':
    case 'reject-candidate':
    case 'override-candidate':
    case 'apply': {
      const c = ctx.store.candidate(subjectId);
      if (!c) throw new Error(`unknown candidate ${subjectId}`);
      const applying = operation === 'apply'
        ? { decisionId: candidateDecisionOf(ctx, c)?.id ?? null, ref: applyRefFor(c.missionId) }
        : null;
      const id = {
        operation, candidateId: c.id, missionId: c.missionId, diffDigest: c.diffArtifact.digest,
        gateSetDigest: c.gateSetDigest, baseCommit: c.baseCommit, ...applying,
      };
      return out(digestOf(canonicalJson(id)), [
        `${operation} candidate ${c.id} on mission ${c.missionId}`,
        `diff ${c.diffArtifact.digest} (${c.files.length} file(s)) on base ${c.baseCommit}`,
        `gates ${c.gateSetDigest}`, `verdict as recorded: ${c.verdict}`,
        ...(applying ? [`decision ${applying.decisionId ?? 'none'}`, `creates ${applying.ref}`] : []),
      ]);
    }
    default:
      throw new Error(`no confirm digest is defined for ${String(operation)}`);
  }
}
