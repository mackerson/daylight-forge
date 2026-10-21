import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import type { MissionStore } from '../mission/store.ts';
import type { CampaignEnvelope, Candidate, Decision, DecisionOperation, RetryTicketScope } from '../mission/types.ts';
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
export type ConfirmOperation = DecisionOperation | 'apply' | 'record-assumption';

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

type Store = Pick<MissionStore, 'mission' | 'gateSet' | 'workItem' | 'candidate' | 'decisions' | 'currentPlan' | 'planApprovalSet'
  | 'campaignTickets' | 'assumptions' | 'assumption' | 'ticketTrace'>;

export interface ConfirmOptions {
  /** `lock-gates`: exactly the experiments the lock will name. Required. */
  experimentIds?: readonly string[];
  /** `lock-campaign-gates`: whether the lock ratchets (P2-R17), with `experimentIds`. Required. */
  ratchet?: boolean;
  /** `lock-campaign-gates`: gates accepted although they pass at base (`--accept-vacuous`); part of what is confirmed. */
  acceptVacuous?: readonly string[];
  /** `lock-campaign-gates`: acceptance obligations each gate discharges (experiment → `<ticket>:ob<n>`); inside the gate-set digest. */
  obligations?: Record<string, string[]>;
  /** `adopt-integration-tip`: the move being adopted and the halt it answers. Required. */
  adopt?: { ref: string; from: string; to: string; haltDecisionId: string };
  /** `authorize-mission`: what will be granted. Required. */
  permissions?: { write: boolean; execute: boolean };
  /** `authorize-mission`: the budget that will be set, or null to leave it. Required. */
  maxUsd?: number | null;
  /** `adhoc-mission`: the project the mission will belong to. Required. */
  projectId?: string;
  /** `authorize-campaign`: the envelope that will be recorded, `operation` aside. Required. */
  envelope?: CampaignEnvelope;
  /** `retry-ticket`: the scope that will be recorded. Required. */
  retry?: RetryTicketScope;
  /** `resume-campaign`: the halt being resumed. Required. */
  haltDecisionId?: string;
  /** `decide-assumption` / `overturn-assumption`: the value decided; overturn's follow-up statement. */
  value?: string;
  followUp?: string;
  /** `overturn-assumption`: the follow-up's lane and scope, as given (absent: the held ticket's). */
  followUpLane?: string;
  followUpScope?: readonly string[];
  /** `acknowledge-forgery-shape`: reject the shapes instead of acknowledging them. */
  declined?: boolean;
  /** `record-assumption`: the row that will be recorded (the subject is the campaign). */
  assumption?: { question: string; default: string; ticketId?: string };
}

/** A version-2 plan's descent as a person reads it before approving: traced to packets, edited after emission, and with no packet. */
function traceLine(rows: ReturnType<MissionStore['ticketTrace']>, tickets: number): string[] {
  const traced = new Set(rows.filter((r) => r.packetId).map((r) => r.ticketId));
  if (!traced.size) return [];
  const edited = new Set(rows.filter((r) => r.handEdited).map((r) => r.ticketId));
  return [`traced ${traced.size} ticket(s) to packets; ${edited.size} hand-edited${edited.size ? ` (${[...edited].sort().join(', ')})` : ''}; ${tickets - traced.size} untraced`];
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
      // Read through a cast so `Store` stays as it is (WS-R5 widens it too).
      const store = ctx.store as Partial<Pick<MissionStore, 'campaignGateSet'>>;
      if (!opts.experimentIds || opts.ratchet === undefined || !store.campaignGateSet) {
        throw new Error('lock-campaign-gates confirms a chosen set and a ratchet flag; pass the experiment ids and ratchet');
      }
      // The gate-set digest, which covers bindings, roles and the ratchet flag: what the lock records.
      const set = store.campaignGateSet.call(ctx.store, subjectId, opts.experimentIds, opts.ratchet, opts.obligations ?? {});
      const { experiments, bindings, gateSetDigest } = set;
      const holdouts = experiments.filter((x) => x.role === 'holdout').length;
      // Accepting a vacuous gate is part of the act: a code confirmed without it never confirms a lock with it.
      const vacuous = [...new Set(opts.acceptVacuous ?? [])].sort();
      const hidden = new Set(experiments.filter((x) => x.role === 'holdout').map((x) => x.id));
      const heldObligations = Object.entries(set.obligations).filter(([x]) => hidden.has(x)).reduce((n, [, obs]) => n + obs.length, 0);
      return out(vacuous.length ? digestOf(canonicalJson({ operation, gateSetDigest, acceptVacuous: vacuous })) : gateSetDigest, [
        `lock ${experiments.length} campaign gate(s) on campaign ${subjectId}, ratchet ${opts.ratchet ? 'on' : 'off'}`,
        ...experiments.filter((x) => x.role !== 'holdout')
          .map((x) => `${x.role} ${x.id} ${bindings[x.id] ? `ticket ${bindings[x.id]}` : 'every ticket'} harness ${x.harnessDigest}`),
        ...(holdouts ? [`${holdouts} holdout(s), counted, not named`] : []),
        ...(vacuous.length ? [`accept as vacuous (passes at base): ${vacuous.map((v) => (hidden.has(v) ? 'a holdout' : v)).join(', ')}`] : []),
        ...Object.entries(set.obligations).filter(([x, obs]) => obs.length && !hidden.has(x)).map(([x, obs]) => `${x} discharges ${obs.join(', ')}`),
        ...(heldObligations ? [`${heldObligations} obligation(s) bound to holdouts, counted, not named`] : []),
      ]);
    }
    case 'adopt-integration-tip': {
      const a = opts.adopt;
      if (!a) throw new Error('adopt-integration-tip confirms a move of the integration ref; pass the ref, from, to and the halt');
      return out(digestOf(canonicalJson({ operation, ...a, campaignId: subjectId })), [
        `adopt ${a.ref} at ${a.to} for campaign ${subjectId}`,
        `the rows explain it up to ${a.from}; everything after is recorded as adopted by you, not landed by the director`,
        `answers halt ${a.haltDecisionId}`,
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
    case 'approve-plan': {
      const m = ctx.store.mission(subjectId);
      const plan = m?.kind === 'campaign' ? ctx.store.currentPlan(m.id) : null;
      if (!m || !plan) throw new Error(`${subjectId} is not a campaign with an imported plan`);
      const { workItems, supersedes } = ctx.store.planApprovalSet(m.id);
      const tickets = ctx.store.campaignTickets(m.id, { origin: 'plan' });
      const owners = ctx.store.assumptions(m.id).filter((a) => a.source === 'plan-default');
      const usd = tickets.reduce((n, t) => n + (t.budget.maxUsd ?? 0), 0);
      const id = { operation, campaignId: m.id, projectId: m.projectId, planDigest: plan.planDigest, planRevision: plan.planRevision, workItems, supersedes };
      return out(digestOf(canonicalJson(id)), [
        `approve the plan of campaign ${m.id}: ${plan.path} at ${plan.commit.slice(0, 12)} (${plan.planDigest})`,
        `${tickets.length} ticket(s) in ${new Set(tickets.map((t) => t.lane)).size} lane(s); ${supersedes.length} superseded`,
        `${owners.length} owner decision(s), ${owners.filter((a) => a.blocking).length} blocking`,
        `budget hints: $${Number(usd.toFixed(2))} over the tickets that name one`,
        ...traceLine(ctx.store.ticketTrace(m.id), tickets.length),
      ]);
    }
    case 'authorize-campaign': {
      const m = ctx.store.mission(subjectId);
      if (!m || m.kind !== 'campaign') throw new Error(`${subjectId} is not a campaign`);
      const e = opts.envelope;
      if (!e) throw new Error('authorize-campaign confirms an envelope; pass the envelope it will record');
      return out(digestOf(canonicalJson({ ...e, operation, campaignId: m.id, projectId: m.projectId })), [
        `authorize campaign ${m.id}: ${e.ticketIds.length} ticket(s), plan ${e.planDigest}, gates ${e.gateSetDigest}`,
        `spend: $${e.maxUsdTotal} in all, $${e.maxUsdPerMission} per mission; ${e.maxAttemptsPerTicket} attempt(s) per ticket`,
        `authors ${e.roster.join(', ')}; ${e.maxTurns} turns, ${e.timeoutSeconds}s; concurrency ${e.concurrency}, wave ${e.waveSize}`,
        `execute ${e.execute ? 'yes' : 'no'}; auto-apply ${e.autoApply}; review ${e.reviewRoster.length ? e.reviewRoster.join(', ') : 'off'}`,
        `fix lane ${e.fixLane.enabled ? `${e.fixLane.maxTicketsPerWave} a wave at $${e.fixLane.maxUsdPerTicket}` : 'off'}; committer ${e.identity.name} <${e.identity.email}> (asserted)`,
        `regression check ${e.regressionCheck ?? 'scoped'}; until ${new Date(e.notAfter).toISOString()}`,
      ]);
    }
    case 'retry-ticket': {
      const m = ctx.store.mission(subjectId);
      if (!m || m.kind !== 'campaign') throw new Error(`${subjectId} is not a campaign`);
      const r = opts.retry;
      if (!r) throw new Error('retry-ticket confirms a release; pass the scope it will record');
      return out(digestOf(canonicalJson({ ...r, operation, campaignId: m.id, projectId: m.projectId })), [
        `retry ticket ${r.ticketId} of campaign ${m.id}: release work item ${r.workItemId}`,
        `from mission ${r.closedMissionId}, closed: ${r.reason}`,
      ]);
    }
    case 'resume-campaign': {
      const m = ctx.store.mission(subjectId);
      const halt = m ? ctx.store.decisions(m.id).find((d) => d.id === opts.haltDecisionId && d.scope.operation === 'halt-campaign') : undefined;
      if (!m || !halt) throw new Error(`${String(opts.haltDecisionId)} is not a halt of campaign ${subjectId}`);
      return out(digestOf(canonicalJson({ operation, haltDecisionId: halt.id, reason: halt.scope.reason, campaignId: m.id, projectId: m.projectId })), [
        `resume campaign ${m.id}, halted by ${halt.actor}: ${String(halt.scope.reason)} (${halt.id})`,
      ]);
    }
    case 'acknowledge-forgery-shape': {
      // The candidate ops' identity, plus which way: a code to acknowledge never rejects (P2-R49).
      const c = ctx.store.candidate(subjectId);
      if (!c) throw new Error(`unknown candidate ${subjectId}`);
      const declined = opts.declined === true;
      return out(digestOf(canonicalJson({
        operation, candidateId: c.id, missionId: c.missionId, diffDigest: c.diffArtifact.digest,
        gateSetDigest: c.gateSetDigest, baseCommit: c.baseCommit, declined,
      })), [
        `${declined ? 'reject' : 'acknowledge'} the test-output forgery shapes of candidate ${c.id} on mission ${c.missionId}`,
        `diff ${c.diffArtifact.digest} (${c.files.length} file(s)) on base ${c.baseCommit}`,
        declined ? 'the candidate will not land' : 'the candidate may land once its checks pass',
      ]);
    }
    case 'record-assumption': {
      const m = ctx.store.mission(subjectId);
      const a = opts.assumption;
      if (!m || m.kind !== 'campaign' || !a) throw new Error('record-assumption confirms a row on a campaign; pass the assumption');
      return out(digestOf(canonicalJson({ operation, campaignId: m.id, projectId: m.projectId, question: a.question, default: a.default, ticketId: a.ticketId ?? null })), [
        `record an assumption on campaign ${m.id}${a.ticketId ? ` for ticket ${a.ticketId}` : ''}`,
        `question: ${a.question}`, `proceeds on: ${a.default || '(nothing; it waits for you)'}`,
      ]);
    }
    case 'confirm-assumption':
    case 'decide-assumption':
    case 'overturn-assumption': {
      const a = ctx.store.assumption(subjectId);
      if (!a) throw new Error(`unknown assumption ${subjectId}`);
      const value = operation === 'confirm-assumption' ? a.default : opts.value;
      if (value === undefined) throw new Error(`${operation} confirms a value; pass it`);
      const id = {
        operation, assumptionId: a.id, question: a.question, default: a.default, status: a.status, value, followUp: opts.followUp ?? null,
        ...(opts.followUpLane || opts.followUpScope?.length ? { followUpLane: opts.followUpLane ?? null, followUpScope: [...(opts.followUpScope ?? [])] } : {}),
      };
      return out(digestOf(canonicalJson(id)), [
        `${operation.replace('-assumption', '')} assumption ${a.id} (${a.status}) of campaign ${a.campaignId}`,
        `question: ${a.question}`, `default: ${a.default || '(none)'}`, `value: ${value}`,
        ...(opts.followUp ? [`follow-up: ${opts.followUp}`] : []),
        ...(opts.followUpLane ? [`follow-up lane: ${opts.followUpLane}`] : []),
        ...(opts.followUpScope?.length ? [`follow-up scope: ${opts.followUpScope.join(', ')}`] : []),
      ]);
    }
    default:
      throw new Error(`no confirm digest is defined for ${String(operation)}`);
  }
}
