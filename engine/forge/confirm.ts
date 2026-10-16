import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import type { MissionStore } from '../mission/store.ts';
import { gateSetDigestOf } from '../mission/store.ts';
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
 * - `lock-gates` (mission id): the gate-set digest over its gates and holdouts.
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

type Store = Pick<MissionStore, 'mission' | 'experimentsFor' | 'workItem' | 'candidate'>;

export function confirmDigest(ctx: { store: Store }, operation: ConfirmOperation, subjectId: string): ConfirmDigest {
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
      const m = ctx.store.mission(subjectId);
      if (!m) throw new Error(`unknown mission ${subjectId}`);
      const gates = [...ctx.store.experimentsFor(m.id, 'gate'), ...ctx.store.experimentsFor(m.id, 'holdout')];
      if (!gates.length) throw new Error(`mission ${m.id} has no gates or holdouts to lock`);
      return out(gateSetDigestOf(gates), [
        `lock ${gates.length} gate(s) on mission ${m.id}`,
        ...gates.map((x) => `${x.role} ${x.id} harness ${x.harnessDigest}`).sort(),
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
