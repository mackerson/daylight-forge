import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import type { MissionStore } from '../mission/store.ts';
import type { DecisionOperation } from '../mission/types.ts';
import { confirmCodeOf } from './policy.ts';

/**
 * What a human confirms: the digest `--confirm <digest8>` must match, and the lines a CLI
 * prompt or the GUI's native dialog shows beside it. Read-only.
 *
 * One definition per act, so the CLI, the GUI and the guard agree on what was confirmed:
 * - `authorize-mission` (mission id): the mission's identity — id, project, kind, objective,
 *   base revision, work item. The permissions asked for are shown, and recorded in the
 *   decision, but are an input to the act rather than part of what is identified.
 * - `adhoc-mission` (the objective text, since the mission does not exist yet).
 * - `lock-gates` (mission id, plus the experiment ids to lock): `store.gateSet`'s digest, the
 *   same computation `lockGates` records, so any subset is confirmable.
 * - `approve-work-item` / `reject-work-item` (work item id): the item's content digest.
 * - `approve-candidate` / `reject-candidate` / `override-candidate` / `apply` (candidate id):
 *   the diff's digest, the bytes that will be committed.
 */
export type ConfirmOperation = DecisionOperation | 'apply';

export interface ConfirmDigest {
  digest: string;
  digest8: string;
  lines: string[];
}

type Store = Pick<MissionStore, 'mission' | 'gateSet' | 'workItem' | 'candidate'>;

export interface ConfirmOptions {
  /** `lock-gates`: exactly the experiments the lock will name. Required. */
  experimentIds?: readonly string[];
}

export function confirmDigest(
  ctx: { store: Store }, operation: ConfirmOperation, subjectId: string, opts: ConfirmOptions = {},
): ConfirmDigest {
  const out = (digest: string, lines: string[]): ConfirmDigest => ({ digest, digest8: confirmCodeOf(digest), lines });
  switch (operation) {
    case 'authorize-mission': {
      const m = ctx.store.mission(subjectId);
      if (!m) throw new Error(`unknown mission ${subjectId}`);
      const id = { operation, missionId: m.id, projectId: m.projectId, kind: m.kind, objective: m.objective, baseRevision: m.baseRevision, workItemId: m.workItemId ?? null };
      return out(digestOf(canonicalJson(id)), [
        `authorize ${m.kind} mission ${m.id}`, `project ${m.projectId} at ${m.baseRevision}`,
        `objective: ${m.objective}`, `work item: ${m.workItemId ?? 'none (ad hoc)'}`,
      ]);
    }
    case 'adhoc-mission':
      return out(digestOf(canonicalJson({ operation, objective: subjectId })), [
        'start an implement mission with no work item', `objective: ${subjectId}`,
      ]);
    case 'lock-gates': {
      if (!opts.experimentIds) throw new Error('lock-gates confirms a chosen set; pass the experiment ids the lock will name');
      const { experiments, gateSetDigest } = ctx.store.gateSet(subjectId, opts.experimentIds);
      return out(gateSetDigest, [
        `lock ${experiments.length} gate(s) on mission ${subjectId}`,
        ...experiments.map((x) => `${x.role} ${x.id} harness ${x.harnessDigest}`),
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
      return out(c.diffArtifact.digest, [
        `${operation} candidate ${c.id} on mission ${c.missionId}`, `verdict ${c.verdict}`,
        `base ${c.baseCommit}`, `${c.files.length} file(s), gates ${c.gateSetDigest}`,
      ]);
    }
    default:
      throw new Error(`no confirm digest is defined for ${String(operation)}`);
  }
}
