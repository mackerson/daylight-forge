import { spawnSync } from 'node:child_process';
import { digestOf } from '../mission/artifacts.ts';
import type { DaylightContext } from '../mission/context.ts';
import type { CreateDecisionInput, MissionStore } from '../mission/store.ts';
import { campaignActorOf, isHumanActor } from '../mission/types.ts';
import type {
  AdoptTipScope, Application, CampaignEnvelope, Candidate, Decision, EnvelopeRequest, Integration, IntegrateCandidateScope, IntegrationMethod,
  Mission,
} from '../mission/types.ts';
import { HARDENED_GIT_CONFIG, hardenedGitEnv } from '../experiment/runner.ts';
import { gitIn, parseRaw, rediff, scratchFor, type Scratch } from './apply.ts';
import { envelopeRefusal } from './campaign.ts';
import { applyRefFor, confirmDigest } from './confirm.ts';
import { forgeryHold } from './forgery.ts';
import { assertHumanDecision } from './policy.ts';
import { commitMessage } from './trailers.ts';
import { EMPTY_TREE } from './workspace.ts';

/**
 * The campaign integration ref and the rebase that feeds it (§3.4, §4.3, §4.4; ADR-38).
 *
 * A campaign lands every accepted ticket on `refs/heads/daylight/campaign/<id>`, never on a
 * branch a person works on. The ref moves only by compare-and-swap (`update-ref <ref> <new>
 * <old>`), and every move is explained by an `integrated` row naming the derived decision that
 * landed it, or by a person's `adopt-integration-tip`. HEAD, the index and the working tree are
 * never read or written, and no hook runs: every command is plumbing, the untrusted diff is
 * applied and merged only inside a scratch bare repository with an empty config (`scratchFor`,
 * ADR-17), and the result is rebuilt in the real object store object by object, each checked to
 * be the one the scratch verified.
 *
 * A candidate built on the current tip is applied (`method = 'apply'`, and its integrated diff
 * must be exactly its own). One built on an older tip is merged with `git merge-tree
 * --write-tree --merge-base=<its base>` (`three-way`); a conflict writes nothing to the real
 * repository and becomes the candidate's `rebase-conflict`.
 */

export class IntegrationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationRefused';
  }
}

/** The ref a campaign lands on. Only this module moves it. */
export const integrationRefFor = (campaignId: string): string => `refs/heads/daylight/campaign/${campaignId}`;

const ZERO = '0'.repeat(40);
const MAX_BLOB = 32 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const text = (b: Buffer) => b.toString('utf8').trim();

function succeeds(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/** What `ref` names in `repo`, or null when it does not exist. */
export function refTarget(repo: string, ref: string): string | null {
  try {
    return text(gitIn({ repo }, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) || null;
  } catch {
    return null;
  }
}

export function integrationTip(repo: string, campaignId: string): string | null {
  return refTarget(repo, integrationRefFor(campaignId));
}

/**
 * The integration ref, created at `base` if it does not exist yet (`update-ref <ref> <base> ""`,
 * which refuses an existing ref). An existing ref is left exactly where it is.
 */
export function ensureIntegrationRef(repo: string, campaignId: string, base: string): string {
  const ref = integrationRefFor(campaignId);
  const have = refTarget(repo, ref);
  if (have) return have;
  if (!SHA.test(base) || !succeeds(() => gitIn({ repo }, ['cat-file', '-e', `${base}^{commit}`]))) {
    throw new IntegrationRefused(`campaign base ${base} is not a commit of ${repo}`);
  }
  if (!succeeds(() => gitIn({ repo }, ['update-ref', '-m', `daylight campaign ${campaignId}`, ref, base, '']))) {
    const now = refTarget(repo, ref);
    if (now) return now;
    throw new IntegrationRefused(`${ref} could not be created`);
  }
  return base;
}

/** Compare-and-swap: move `ref` from `from` to `to`, or report that it was not at `from`. */
export function casRef(repo: string, ref: string, to: string, from: string, why: string): boolean {
  return succeeds(() => gitIn({ repo }, ['update-ref', '-m', why, ref, to, from]));
}

// ---- building the integrated commit --------------------------------------------------------

export interface BuildInput {
  /** The integration tip the diff goes onto. */
  onto: string;
  /** The commit the candidate was captured against. */
  base: string;
  diff: Buffer;
  diffDigest: string;
  message: string;
  identity: { name: string; email: string };
  /** Seconds since the epoch, for both author and committer: the commit is reproducible from its inputs. */
  when: number;
}

export type BuildResult =
  | { commit: string; tree: string; method: IntegrationMethod; diffDigest: string }
  | { conflict: string[] };

/** `git merge-tree` in the scratch, with no attribute source: no merge driver a tree names can run. */
function mergeTree(s: Scratch, base: string, onto: string, theirs: string): { tree: string } | { conflict: string[] } {
  const r = spawnSync('git', [
    ...HARDENED_GIT_CONFIG, '-c', 'core.autocrlf=false', `--attr-source=${EMPTY_TREE}`, `--git-dir=${s.gitDir}`,
    'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', `--merge-base=${base}`, onto, theirs,
  ], { env: hardenedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) {
    throw new IntegrationRefused(`git merge-tree failed: ${String(r.stderr ?? '').trim().split('\n')[0] || `exit ${String(r.status)}`}`);
  }
  const parts = r.stdout.toString('utf8').split('\0');
  const tree = parts[0];
  if (!SHA.test(tree)) throw new IntegrationRefused('git merge-tree printed no tree');
  if (r.status === 0) return { tree };
  return { conflict: [...new Set(parts.slice(1).filter(Boolean))].sort() };
}

/**
 * Put a candidate's diff onto `onto` and commit the result, without a ref (§3.4 steps 2–5).
 *
 * Built and verified in the scratch first, so a diff that does not apply or merge, a mode
 * other than a plain or executable file, or a blob over the cap leaves nothing in the real
 * object store. Then rebuilt there from exactly its blobs on a private index, and each object
 * checked against the scratch's.
 */
export function buildIntegrated(repo: string, i: BuildInput): BuildResult {
  for (const [what, sha] of [['onto', i.onto], ['base', i.base]] as const) {
    if (!SHA.test(sha)) throw new IntegrationRefused(`${what} ${sha} is not a full commit id`);
  }
  if (digestOf(i.diff) !== i.diffDigest) throw new IntegrationRefused(`the diff's bytes do not digest to ${i.diffDigest}`);
  const s = scratchFor(repo);
  try {
    const onScratch = { env: { GIT_INDEX_FILE: s.index } };
    const onReal = { env: { GIT_INDEX_FILE: s.realIndex } };
    const commitEnv = {
      GIT_AUTHOR_NAME: i.identity.name, GIT_AUTHOR_EMAIL: i.identity.email, GIT_AUTHOR_DATE: `@${i.when} +0000`,
      GIT_COMMITTER_NAME: i.identity.name, GIT_COMMITTER_EMAIL: i.identity.email, GIT_COMMITTER_DATE: `@${i.when} +0000`,
    };
    gitIn({ gitDir: s.gitDir }, ['read-tree', i.base], onScratch);
    if (i.diff.length) {
      try {
        gitIn({ gitDir: s.gitDir }, ['apply', '--cached', '--binary', '-'], { ...onScratch, input: i.diff });
      } catch (err) {
        const stderr = String((err as { stderr?: Buffer }).stderr ?? '').trim().split('\n')[0];
        throw new IntegrationRefused(`the diff does not apply to its own base ${i.base.slice(0, 12)}: ${stderr || 'git apply refused it'}`);
      }
    }
    const own = text(gitIn({ gitDir: s.gitDir }, ['write-tree'], onScratch));
    let tree = own;
    let method: IntegrationMethod = 'apply';
    if (i.onto !== i.base) {
      method = 'three-way';
      const theirs = text(gitIn({ gitDir: s.gitDir }, ['commit-tree', '--no-gpg-sign', own, '-p', i.base, '-m', 'candidate'], { env: commitEnv }));
      const merged = mergeTree(s, i.base, i.onto, theirs);
      if ('conflict' in merged) return merged;
      tree = merged.tree;
    }
    const entries = parseRaw(gitIn({ gitDir: s.gitDir }, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', i.onto, tree]).toString('utf8'));
    for (const e of entries) {
      if (e.status === 'D') continue;
      if (e.newMode !== '100644' && e.newMode !== '100755') throw new IntegrationRefused(`${e.path} would be mode ${e.newMode}; only files are integrated`);
      const size = Number(text(gitIn({ gitDir: s.gitDir }, ['cat-file', '-s', e.newSha])));
      if (!(size <= MAX_BLOB)) throw new IntegrationRefused(`${e.path} would be ${size} bytes; integration takes files up to ${MAX_BLOB}`);
    }
    const commitArgs = (t: string) => ['commit-tree', '--no-gpg-sign', t, '-p', i.onto, '-F', '-'];
    const scratchCommit = text(gitIn({ gitDir: s.gitDir }, commitArgs(tree), { input: i.message, env: commitEnv }));
    const integrated = digestOf(rediff(s, i.onto, scratchCommit));
    if (method === 'apply' && integrated !== i.diffDigest) {
      throw new IntegrationRefused(`the diff commits onto its own base as ${integrated}, not its digest ${i.diffDigest}; nothing was written`);
    }

    const info: string[] = [];
    for (const e of entries) {
      if (e.status === 'D') {
        info.push(`0 ${ZERO}\t${e.path}`);
        continue;
      }
      const blob = gitIn({ gitDir: s.gitDir }, ['cat-file', 'blob', e.newSha]);
      const sha = text(gitIn({ repo }, ['hash-object', '-w', '--no-filters', '--stdin'], { input: blob }));
      if (sha !== e.newSha) throw new IntegrationRefused(`${e.path} hashed to ${sha} in the repository, not ${e.newSha}`);
      info.push(`${e.newMode} ${sha}\t${e.path}`);
    }
    gitIn({ repo }, ['read-tree', i.onto], onReal);
    if (info.length) gitIn({ repo }, ['update-index', '-z', '--index-info'], { ...onReal, input: `${info.join('\0')}\0` });
    const realTree = text(gitIn({ repo }, ['write-tree'], onReal));
    if (realTree !== tree) throw new IntegrationRefused(`the repository built tree ${realTree}, not the ${tree} the scratch verified`);
    const commit = text(gitIn({ repo }, commitArgs(realTree), { input: i.message, env: commitEnv }));
    if (commit !== scratchCommit) throw new IntegrationRefused(`the repository built commit ${commit}, not the verified ${scratchCommit}`);
    return { commit, tree, method, diffDigest: integrated };
  } finally {
    s.dispose();
  }
}

/** `onto → commit` re-diffed with capture's flags, from a scratch with an empty config. */
export function integratedDigestOf(repo: string, onto: string, commit: string): string {
  const s = scratchFor(repo);
  try {
    return digestOf(rediff(s, onto, commit));
  } finally {
    s.dispose();
  }
}

// ---- the campaign's grant --------------------------------------------------------------------

/**
 * The campaign's latest human `authorize-campaign` decision, or null. Read from rows; whether
 * it still covers anything is `envelopeRefusal`'s question (WS-R5).
 */
export function authorizationOf(store: Pick<MissionStore, 'decisions'>, campaignId: string): Decision | null {
  return store.decisions(campaignId)
    .filter((d) => d.kind === 'approve' && d.scope.operation === 'authorize-campaign' && isHumanActor(d.actor))
    .at(-1) ?? null;
}

export const envelopeOf = (d: Decision): CampaignEnvelope => d.scope as unknown as CampaignEnvelope;

/**
 * The two WS-R5 functions a landing calls inside its transaction (P2-R22). Injected so a test
 * can stand in for them; the defaults are R5's.
 */
export interface IntegrateDeps {
  envelopeRefusal: (store: MissionStore, parentDecisionId: string, request: EnvelopeRequest) => string | null;
  recordDerivedDecision: (store: MissionStore, parentDecisionId: string, input: CreateDecisionInput) => Decision;
}

export const R5_INTEGRATE_DEPS: IntegrateDeps = {
  envelopeRefusal: (store, parent, request) => envelopeRefusal(store, parent, request),
  recordDerivedDecision: (store, parent, input) => store.recordDerivedDecision(parent, input),
};

// ---- integrating one candidate -----------------------------------------------------------------

export type IntegrateContext = Pick<DaylightContext, 'store' | 'events' | 'artifacts'> & { repoRoot: string; now?: () => number };

/** Where a test stops the process, to resume from what the rows and refs say (§4.4). */
export type IntegrationStep = 'recorded' | 'built' | 'mission-ref' | 'cas' | 'landed';

export interface IntegrateOptions {
  ticketId: string;
  deps?: IntegrateDeps;
  /** Tests only: throw right after this step, leaving rows and refs as a crash would. */
  crashAfter?: IntegrationStep;
}

export class InjectedCrash extends Error {
  constructor(step: IntegrationStep) {
    super(`injected crash after ${step}`);
    this.name = 'InjectedCrash';
  }
}

const crash = (o: IntegrateOptions, step: IntegrationStep) => {
  if (o.crashAfter === step) throw new InjectedCrash(step);
};

function campaignOfMission(store: MissionStore, m: Mission): Mission {
  const campaign = m.parentId ? store.mission(m.parentId) : null;
  if (!campaign || campaign.kind !== 'campaign') throw new IntegrationRefused(`mission ${m.id} is not a ticket mission of a campaign`);
  return campaign;
}

function emit(ctx: IntegrateContext, m: Pick<Mission, 'id' | 'projectId'>, category: 'process' | 'approval' | 'lifecycle', name: string,
  payload: Record<string, unknown>): void {
  ctx.events.append({ projectId: m.projectId, missionId: m.id, actorId: 'daylight', category, name, payload });
}

/**
 * Record an integration of `candidateId` onto the current tip and build its commit (§3.4).
 * The row is `conflict` when the diff does not merge, `rejected` when the candidate is already
 * settled without gates (no diff, a policy violation), `evaluating` with its commit otherwise.
 * Nothing moves a ref here.
 */
export function prepareIntegration(ctx: IntegrateContext, candidateId: string, o: IntegrateOptions): Integration {
  const c = ctx.store.candidate(candidateId);
  if (!c) throw new IntegrationRefused(`unknown candidate ${candidateId}`);
  const m = ctx.store.mission(c.missionId)!;
  const campaign = campaignOfMission(ctx.store, m);
  const auth = authorizationOf(ctx.store, campaign.id);
  if (!auth) throw new IntegrationRefused(`campaign ${campaign.id} has no human authorize-campaign decision`);
  const tip = integrationTip(ctx.repoRoot, campaign.id);
  if (!tip) throw new IntegrationRefused(`campaign ${campaign.id} has no integration ref yet`);
  let i = ctx.store.recordIntegration({
    campaignId: campaign.id, missionId: m.id, candidateId: c.id, ref: integrationRefFor(campaign.id), onto: tip, candidateBase: c.baseCommit,
  });
  emit(ctx, campaign, 'process', 'campaign.integration.started', { integrationId: i.id, candidateId: c.id, onto: tip, method: null });
  crash(o, 'recorded');
  if (!c.files.length || c.policyViolations.length || c.secretHits > 0) {
    return ctx.store.updateIntegration(i.id, 'pending', { state: 'rejected' });
  }
  const diff = ctx.artifacts.get(c.diffArtifact);
  const attempt = ctx.store.attempt(c.attemptId);
  const work = m.workItemId ? ctx.store.workItem(m.workItemId) : null;
  let message: string;
  try {
    message = commitMessage({
    title: work?.title ?? m.objective, fallbackTitle: `Daylight ticket ${o.ticketId}`, files: c.files, missionId: m.id, attemptId: c.attemptId,
    runnerId: attempt?.runnerId ?? 'unknown',
    campaign: {
      campaignId: campaign.id, ticketId: o.ticketId, integrationId: i.id, onto: tip, method: tip === c.baseCommit ? 'apply' : 'three-way',
      authorizationId: auth.id, authorizedBy: auth.actor,
    },
    });
  } catch (err) {
    ctx.store.updateIntegration(i.id, 'pending', { state: 'rejected' });
    throw new IntegrationRefused(`the commit message cannot be written: ${(err as Error).message}`);
  }
  const env = envelopeOf(auth);
  let built: BuildResult;
  try {
    built = buildIntegrated(ctx.repoRoot, {
      onto: tip, base: c.baseCommit, diff, diffDigest: c.diffArtifact.digest, message,
      identity: env.identity, when: Math.floor((ctx.now?.() ?? Date.now()) / 1000),
    });
  } catch (err) {
    ctx.store.updateIntegration(i.id, 'pending', { state: 'rejected' });
    emit(ctx, campaign, 'process', 'campaign.integration.refused', { integrationId: i.id, candidateId: c.id, onto: tip });
    throw err;
  }
  if ('conflict' in built) {
    i = ctx.store.updateIntegration(i.id, 'pending', { state: 'conflict', conflictPaths: built.conflict });
    emit(ctx, campaign, 'process', 'campaign.integration.conflict', {
      integrationId: i.id, candidateId: c.id, onto: tip, method: 'three-way', conflictPaths: { count: built.conflict.length, paths: built.conflict },
    });
    return i;
  }
  i = ctx.store.updateIntegration(i.id, 'pending', {
    state: 'evaluating', method: built.method, integratedCommit: built.commit, integratedTree: built.tree, integratedDiffDigest: built.diffDigest,
  });
  crash(o, 'built');
  return i;
}

/**
 * Why this integration's candidate may not land, or null (P2-R35): it must be `accepted-by-gates`
 * on this integration's tree (the verdict names the integrated digest), against the campaign's
 * current gate lock. Whatever the caller: the director, a resume, or a test.
 */
export function landingRefusal(store: MissionStore, i: Integration): string | null {
  const c = store.candidate(i.candidateId);
  if (!c) return `candidate ${i.candidateId} does not exist`;
  if (c.verdict !== 'accepted-by-gates' || !i.integratedDiffDigest || !c.verdictReasons.some((r) => r.includes(i.integratedDiffDigest!))) {
    return `candidate ${c.id} is ${c.verdict} on integration ${i.id}'s tree, not accepted-by-gates there; it is not landed`;
  }
  const lock = store.campaignLockDecision(i.campaignId);
  if (!lock || lock.scope.gateSetDigest !== c.gateSetDigest) {
    return `candidate ${c.id} was judged against gate set ${c.gateSetDigest}, not the campaign's current lock; it is not landed`;
  }
  return null;
}

/**
 * The landing transaction (P2-R22): inside one `BEGIN IMMEDIATE`, R5's envelope check, the
 * derived `integrate-candidate` decision on the ticket mission, the application row (`appliedBy
 * = campaign:<id>`, base = the tip) and the integration's move to `integrated`. All or nothing.
 */
export function landIntegration(ctx: IntegrateContext, integrationId: string, o: IntegrateOptions): { decision: Decision; application: Application } {
  const deps = o.deps ?? R5_INTEGRATE_DEPS;
  return ctx.store.tx(() => {
    const i = ctx.store.integration(integrationId);
    if (!i || i.state !== 'evaluating' || !i.integratedCommit || !i.integratedTree || !i.integratedDiffDigest) {
      throw new IntegrationRefused(`integration ${integrationId} is not being landed`);
    }
    const refused = landingRefusal(ctx.store, i);
    if (refused) throw new IntegrationRefused(refused);
    const c = ctx.store.candidate(i.candidateId)!;
    const held = forgeryHold(ctx, c);
    if (held) throw new IntegrationRefused(`${held.why}; it is not landed`);
    const m = ctx.store.mission(i.missionId)!;
    const auth = authorizationOf(ctx.store, i.campaignId);
    if (!auth) throw new IntegrationRefused(`campaign ${i.campaignId} has no human authorize-campaign decision`);
    const at = ctx.now?.() ?? Date.now();
    const why = deps.envelopeRefusal(ctx.store, auth.id, { missionId: m.id, operation: 'integrate-candidate', ticketId: o.ticketId, at });
    if (why) throw new IntegrationRefused(`the campaign's envelope refuses this landing: ${why}`);
    const scope: IntegrateCandidateScope = {
      operation: 'integrate-candidate', derivedFrom: auth.id, candidateId: c.id, diffDigest: c.diffArtifact.digest,
      gateSetDigest: c.gateSetDigest, baseCommit: c.baseCommit, integrationId: i.id, onto: i.onto, integratedCommit: i.integratedCommit,
      integratedDiffDigest: i.integratedDiffDigest,
    };
    const decision = deps.recordDerivedDecision(ctx.store, auth.id, {
      missionId: m.id, projectId: m.projectId, revision: i.onto, actor: campaignActorOf(i.campaignId), kind: 'approve',
      rationale: `ticket ${o.ticketId}: accepted by the campaign's gates on the integrated tree`,
      scope: scope as unknown as Record<string, unknown>, artifactIds: [],
    });
    const application = ctx.store.recordApplication({
      candidateId: c.id, decisionId: decision.id, baseCommit: i.onto, commit: i.integratedCommit, tree: i.integratedTree,
      ref: applyRefFor(m.id), appliedBy: campaignActorOf(i.campaignId),
    });
    ctx.store.updateIntegration(i.id, 'evaluating', { state: 'integrated', decisionId: decision.id, applicationId: application.id });
    return { decision, application };
  });
}

export type LandResult =
  | { landed: Integration; decision: Decision; application: Application }
  | { refused: string; integration: Integration };

/**
 * Land an accepted integration (§4.3): the per-mission ref, created only; the integration ref,
 * moved only from the tip the diff was put onto; then the landing transaction. A ref that moved
 * underneath, or a store refusal, undoes what this call did to refs and leaves the row
 * `abandoned` for the director to requeue.
 */
export function landCandidate(ctx: IntegrateContext, integrationId: string, o: IntegrateOptions): LandResult {
  const i = ctx.store.integration(integrationId);
  if (!i || i.state !== 'evaluating' || !i.integratedCommit) throw new IntegrationRefused(`integration ${integrationId} is not ready to land`);
  const repo = ctx.repoRoot;
  const commit = i.integratedCommit;
  const missionRef = applyRefFor(i.missionId);
  const campaign = ctx.store.mission(i.campaignId)!;
  const abandon = (why: string): LandResult => {
    const after = ctx.store.updateIntegration(i.id, 'evaluating', { state: 'abandoned' });
    emit(ctx, campaign, 'process', 'campaign.integration.refused', { integrationId: i.id, candidateId: i.candidateId, onto: i.onto, method: i.method });
    return { refused: why, integration: after };
  };
  const unaccepted = landingRefusal(ctx.store, i);
  if (unaccepted) return abandon(unaccepted);
  const madeMissionRef = succeeds(() => gitIn({ repo }, ['update-ref', '-m', `daylight campaign ${i.campaignId} ${i.id}`, missionRef, commit, '']));
  if (!madeMissionRef && refTarget(repo, missionRef) !== commit) return abandon(`${missionRef} already exists; it is never overwritten`);
  crash(o, 'mission-ref');
  if (!casRef(repo, i.ref, commit, i.onto, `daylight campaign ${i.campaignId} lands ${i.id}`)) {
    succeeds(() => gitIn({ repo }, ['update-ref', '-d', missionRef, commit]));
    return abandon(`${i.ref} is no longer at ${i.onto.slice(0, 12)}; the candidate is integrated again onto the new tip`);
  }
  crash(o, 'cas');
  let landed: { decision: Decision; application: Application };
  try {
    landed = landIntegration(ctx, i.id, o);
  } catch (err) {
    // The rows refused: put the refs back exactly as they were, by compare-and-swap.
    casRef(repo, i.ref, i.onto, commit, `daylight campaign ${i.campaignId} undoes ${i.id}`);
    succeeds(() => gitIn({ repo }, ['update-ref', '-d', missionRef, commit]));
    return abandon((err as Error).message);
  }
  crash(o, 'landed');
  return finishLanding(ctx, i.id, landed);
}

/** After the transaction: the ticket mission closes as succeeded (ADR-23), and the landing is announced. */
function finishLanding(ctx: IntegrateContext, integrationId: string, landed: { decision: Decision; application: Application }): LandResult {
  const i = ctx.store.integration(integrationId)!;
  const m = ctx.store.mission(i.missionId)!;
  const campaign = ctx.store.mission(i.campaignId)!;
  if (m.state !== 'closed') ctx.store.closeMission(m.id, 'succeeded', `landed on ${i.ref} as ${i.integratedCommit}`);
  emit(ctx, campaign, 'approval', 'campaign.candidate.integrated', {
    decisionId: landed.decision.id, derivedFrom: landed.decision.scope.derivedFrom, integrationId: i.id, commit: i.integratedCommit, ref: i.ref,
  });
  return { landed: i, ...landed };
}

// ---- resume ------------------------------------------------------------------------------------

export interface ReconcileResult {
  /** Candidates whose integration was abandoned and that go back on the queue. */
  requeue: string[];
  /** Integrations this pass finished landing. */
  landed: string[];
  /** Per-mission refs removed because they named an unrecorded commit. */
  deletedRefs: string[];
  /** The ref is somewhere no row or adoption explains: the director halts `integration-moved`. */
  moved: { expected: string; actual: string | null } | null;
}

/** Where the integration ref should be: the latest landing, else the latest adoption, else the campaign base. */
export function expectedTip(store: MissionStore, campaignId: string): string {
  const campaign = store.mission(campaignId)!;
  // Landings are serial, so creation order is landing order; a landing's time is its decision's,
  // which no later repair of the row moves (L5).
  const landed = store.integrations(campaignId, { state: 'integrated' }).at(-1);
  const adopted = store.decisions(campaignId).filter((d) => d.scope.operation === 'adopt-integration-tip' && isHumanActor(d.actor)).at(-1);
  const candidates: Array<{ at: number; commit: string }> = [];
  const landedAt = landed?.decisionId ? store.decision(landed.decisionId)?.at : undefined;
  if (landed?.integratedCommit) candidates.push({ at: landedAt ?? landed.updatedAt, commit: landed.integratedCommit });
  if (adopted && typeof adopted.scope.to === 'string') candidates.push({ at: adopted.at, commit: adopted.scope.to });
  return candidates.sort((a, b) => a.at - b.at).at(-1)?.commit ?? campaign.baseRevision;
}

/**
 * Bring rows and refs back into agreement after a crash, by the table in §4.4. Idempotent: a
 * second pass over what the first left finds nothing to do.
 */
export function reconcileIntegrations(ctx: IntegrateContext, campaignId: string, o: { ticketOf: (missionId: string) => string; deps?: IntegrateDeps }): ReconcileResult {
  const out: ReconcileResult = { requeue: [], landed: [], deletedRefs: [], moved: null };
  const repo = ctx.repoRoot;
  const ref = integrationRefFor(campaignId);
  const tip = refTarget(repo, ref);
  for (const i of ctx.store.integrations(campaignId)) {
    if (i.state === 'pending') {
      // Nothing of a pending integration reached a ref; it is integrated again from the current tip.
      ctx.store.updateIntegration(i.id, 'pending', { state: 'abandoned' });
      out.requeue.push(i.candidateId);
      continue;
    }
    if (i.state === 'evaluating') {
      const commit = i.integratedCommit;
      if (commit && tip === commit && integratedDigestOf(repo, i.onto, commit) === i.integratedDiffDigest) {
        // Crashed between the compare-and-swap and the transaction: the ref already says it landed.
        const missionRef = applyRefFor(i.missionId);
        if (!refTarget(repo, missionRef)) succeeds(() => gitIn({ repo }, ['update-ref', missionRef, commit, '']));
        try {
          const landed = landIntegration(ctx, i.id, { ticketId: o.ticketOf(i.missionId), deps: o.deps });
          finishLanding(ctx, i.id, landed);
          out.landed.push(i.id);
        } catch {
          casRef(repo, ref, i.onto, commit, `daylight campaign ${campaignId} undoes ${i.id}`);
          succeeds(() => gitIn({ repo }, ['update-ref', '-d', missionRef, commit]));
          ctx.store.updateIntegration(i.id, 'evaluating', { state: 'abandoned' });
          out.requeue.push(i.candidateId);
        }
        continue;
      }
      ctx.store.updateIntegration(i.id, 'evaluating', { state: 'abandoned' });
      out.requeue.push(i.candidateId);
      continue;
    }
    if (i.state === 'integrated' && !i.applicationId && i.decisionId && i.integratedCommit && i.integratedTree) {
      // Not reachable through landIntegration's one transaction; repaired for a hand-written row.
      const now = refTarget(repo, ref);
      if (now && succeeds(() => gitIn({ repo }, ['merge-base', '--is-ancestor', i.integratedCommit!, now]))) {
        const app = ctx.store.application(i.candidateId) ?? ctx.store.recordApplication({
          candidateId: i.candidateId, decisionId: i.decisionId, baseCommit: i.onto, commit: i.integratedCommit, tree: i.integratedTree,
          ref: applyRefFor(i.missionId), appliedBy: campaignActorOf(campaignId),
        });
        ctx.store.updateIntegration(i.id, 'integrated', { applicationId: app.id });
        out.landed.push(i.id);
      }
    }
    if (i.state === 'integrated' && ctx.store.mission(i.missionId)?.state !== 'closed' && ctx.store.application(i.candidateId)) {
      // Crashed after the transaction, before the ticket mission was closed.
      ctx.store.closeMission(i.missionId, 'succeeded', `landed on ${i.ref} as ${i.integratedCommit}`);
    }
  }
  // A per-mission ref with no application names a commit nothing recorded: it goes.
  const children = ctx.store.missions(ctx.store.mission(campaignId)!.projectId).filter((m) => m.parentId === campaignId);
  for (const m of children) {
    const missionRef = applyRefFor(m.id);
    const at = refTarget(repo, missionRef);
    if (!at || ctx.store.applications(m.id).some((p) => p.commit === at)) continue;
    if (succeeds(() => gitIn({ repo }, ['update-ref', '-d', missionRef, at]))) out.deletedRefs.push(missionRef);
  }
  const requeued = new Set(out.requeue);
  out.requeue = [...requeued].filter((id) => !ctx.store.integrationFor(id));
  const want = expectedTip(ctx.store, campaignId);
  const actual = refTarget(repo, ref);
  if (actual !== want) out.moved = { expected: want, actual };
  return out;
}

// ---- the invariant -----------------------------------------------------------------------------

/**
 * `integration-ref-explained`, from rows and the repository: every integrated row's commit has
 * the tip it was put onto as its parent, diffs from it to the recorded digest and is reachable
 * from the ref; every first-parent commit from the campaign base to the tip is a landing or
 * inside a person's adoption; the ref is where the rows say. One line per breach.
 */
export function integrationRefusals(ctx: Pick<IntegrateContext, 'store' | 'repoRoot'>, campaignId: string): string[] {
  const out = [...ctx.store.integrationRowRefusals(campaignId)];
  const repo = ctx.repoRoot;
  const campaign = ctx.store.mission(campaignId);
  if (!campaign) return [`unknown campaign ${campaignId}`];
  const ref = integrationRefFor(campaignId);
  const tip = refTarget(repo, ref);
  const landed = ctx.store.integrations(campaignId, { state: 'integrated' });
  if (!tip) {
    if (landed.length) out.push(`${ref} does not exist, yet ${landed.length} integration(s) landed on it`);
    return out;
  }
  const s = scratchFor(repo);
  try {
    for (const i of landed) {
      const commit = i.integratedCommit!;
      let parent = 'none';
      try {
        parent = text(gitIn({ gitDir: s.gitDir }, ['rev-parse', '--verify', '--quiet', `${commit}^1`]));
      } catch {
        // No parent is itself the breach below.
      }
      if (parent !== i.onto) out.push(`${i.id}: commit ${commit}'s parent is ${parent}, not the tip it was put onto ${i.onto}`);
      const digest = digestOf(rediff(s, i.onto, commit));
      if (digest !== i.integratedDiffDigest) out.push(`${i.id}: commit ${commit} diffs to ${digest}, not ${String(i.integratedDiffDigest)}`);
      if (!succeeds(() => gitIn({ repo }, ['merge-base', '--is-ancestor', commit, tip]))) out.push(`${i.id}: commit ${commit} is not on ${ref}`);
    }
    const explained = new Set(landed.map((i) => i.integratedCommit!));
    for (const d of ctx.store.decisions(campaignId).filter((x) => x.scope.operation === 'adopt-integration-tip' && isHumanActor(x.actor))) {
      const from = String(d.scope.from);
      const to = String(d.scope.to);
      try {
        for (const c of text(gitIn({ repo }, ['rev-list', '--first-parent', `${from}..${to}`])).split('\n').filter(Boolean)) explained.add(c);
      } catch {
        out.push(`${d.id}: adoption ${from.slice(0, 12)}..${to.slice(0, 12)} names commits that are not in the repository`);
      }
    }
    let chain: string[] = [];
    try {
      chain = text(gitIn({ repo }, ['rev-list', '--first-parent', `${campaign.baseRevision}..${tip}`])).split('\n').filter(Boolean);
    } catch {
      out.push(`${ref} does not descend from the campaign base ${campaign.baseRevision}`);
    }
    for (const c of chain) if (!explained.has(c)) out.push(`${ref}: commit ${c} is neither a landing nor adopted by a person`);
    const want = expectedTip(ctx.store, campaignId);
    if (tip !== want) out.push(`${ref} is at ${tip}, not ${want}, where the rows say`);
  } finally {
    s.dispose();
  }
  return out;
}

// ---- adopting a moved tip ----------------------------------------------------------------------

export interface AdoptTipInput {
  campaignId: string;
  /** The `integration-moved` halt (or any unanswered halt) this answers. */
  haltDecisionId: string;
  actor: string;
  rationale: string;
  confirm: string | undefined;
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * A commit to put the ref at, for a ref deleted or rewound outside the director (wave2 L4).
   * It must be, or descend from, the commit the rows explain; the ref is moved there by
   * compare-and-swap (created if it is missing). Without it, the ref is adopted where it is.
   */
  to?: string;
}

/**
 * What `campaign adopt-tip` would record now: the ref, where the rows put it, and where it is
 * (or `to`, a commit a person names to restore it to).
 */
export function adoptScopeOf(ctx: Pick<IntegrateContext, 'store' | 'repoRoot'>, campaignId: string, haltDecisionId: string, to?: string): AdoptTipScope {
  const ref = integrationRefFor(campaignId);
  let at: string | null;
  if (to !== undefined) {
    if (!/^[0-9a-f]{7,64}$/.test(to)) throw new IntegrationRefused(`--to names a commit by its hex id, not ${JSON.stringify(to)}`);
    at = refTarget(ctx.repoRoot, to);
    if (!at) throw new IntegrationRefused(`${to} is not a commit of ${ctx.repoRoot}`);
  } else {
    at = refTarget(ctx.repoRoot, ref);
    if (!at) throw new IntegrationRefused(`${ref} does not exist; there is nothing to adopt where it is, so name the commit to restore it to with --to`);
  }
  return { operation: 'adopt-integration-tip', ref, from: expectedTip(ctx.store, campaignId), to: at, haltDecisionId };
}

/**
 * `campaign adopt-tip` (§4.4): a person accepts commits that reached the integration ref outside
 * the director, so the rows explain them again and the halt they caused is answered. A guarded
 * human act. Refused unless the move only added commits on top of what the rows explain: a ref
 * rewritten under a landing is never adopted, because that would drop a landing silently.
 */
export function adoptIntegrationTip(ctx: IntegrateContext & { env?: Readonly<Record<string, string | undefined>> }, input: AdoptTipInput): Decision {
  const campaign = ctx.store.mission(input.campaignId);
  if (!campaign || campaign.kind !== 'campaign') throw new IntegrationRefused(`${input.campaignId} is not a campaign`);
  const scope = adoptScopeOf(ctx, campaign.id, input.haltDecisionId, input.to);
  const digest = confirmDigest(ctx, 'adopt-integration-tip', campaign.id, { adopt: { ref: scope.ref, from: scope.from, to: scope.to, haltDecisionId: scope.haltDecisionId } });
  assertHumanDecision(input.env ?? ctx.env ?? process.env, input.actor, input.confirm, digest.digest);
  if (!input.rationale?.trim()) throw new IntegrationRefused('an adoption needs a rationale');
  const ds = ctx.store.decisions(campaign.id);
  const halt = ds.find((d) => d.id === input.haltDecisionId && d.scope.operation === 'halt-campaign');
  const answered = ds.some((d) => (d.scope.operation === 'resume-campaign' || d.scope.operation === 'adopt-integration-tip') && d.scope.haltDecisionId === input.haltDecisionId);
  if (!halt || answered) throw new IntegrationRefused(`decision ${input.haltDecisionId} is not an unanswered halt of campaign ${campaign.id}`);
  const at = refTarget(ctx.repoRoot, scope.ref);
  if (scope.to === scope.from && at === scope.to) throw new IntegrationRefused(`${scope.ref} is where the rows put it; there is nothing to adopt`);
  if (!succeeds(() => gitIn({ repo: ctx.repoRoot }, ['merge-base', '--is-ancestor', scope.from, scope.to]))) {
    throw new IntegrationRefused(`${scope.ref} at ${scope.to} does not descend from ${scope.from}, the last commit the rows explain; a landing would be lost, so it is not adopted`);
  }
  // Restoring to a named commit moves the ref first, by compare-and-swap from where it is now.
  if (at !== scope.to && !casRef(ctx.repoRoot, scope.ref, scope.to, at ?? '', `daylight campaign ${campaign.id} restored by ${input.actor}`)) {
    throw new IntegrationRefused(`${scope.ref} moved while it was being adopted; nothing was recorded`);
  }
  const d = ctx.store.recordDecision({
    missionId: campaign.id, projectId: campaign.projectId, revision: scope.to, actor: input.actor, kind: 'approve', rationale: input.rationale.trim(),
    scope: scope as unknown as Record<string, unknown>, artifactIds: [],
  });
  emit(ctx, campaign, 'lifecycle', 'campaign.resumed', {
    decisionId: d.id, integrationRef: scope.ref, tip: scope.to, adoptedFrom: scope.from, haltDecisionId: halt.id, ...(at !== scope.to ? { restoredFrom: at } : {}),
  });
  return d;
}
