/**
 * Shared set-up for the WS-R6 campaign tests (forge-campaign-integrate-*, -run-*, -review-*).
 * Not a test itself: it builds temp repositories, campaign and ticket missions, candidates, and
 * the stand-ins for WS-R5's derived-decision writer until R5's bodies land.
 *
 * `rawDecision` writes a decision row the way R5's `recordDerivedDecision` will (P2-R19), through
 * the store's own connection, so it runs inside the caller's transaction. It is a test double:
 * nothing in engine/ calls it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { identifyProject } from '../mission/project.ts';
import { newId, type CreateDecisionInput, type MissionStore } from '../mission/store.ts';
import type {
  AuthorizeCampaignScope, Candidate, CandidateFile, CampaignEnvelope, CampaignTicket, Decision, EnvelopeRequest, Integration, Mission, PlanFileV1,
} from '../mission/types.ts';
import { DIFF_FLAGS } from '../forge/diff.ts';
import type { IntegrateDeps } from '../forge/integrate.ts';
import type { CampaignHost } from '../forge/director.ts';

export const ACTOR = `human:${os.userInfo().username}`;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export function tempDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  process.on('exit', () => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

export function git(repo: string, args: string[], o: { input?: string | Buffer; env?: Record<string, string> } = {}): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args], {
    encoding: 'utf8', input: o.input, env: { ...GIT_ENV, ...o.env }, maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** A repository with one commit holding `files`, on `main`. */
export function makeRepo(dir: string, files: Record<string, string>): { repo: string; base: string } {
  const repo = path.join(dir, 'repo');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@daylight.invalid', 'commit', '-q', '-m', 'fixture']);
  return { repo, base: git(repo, ['rev-parse', 'HEAD']) };
}

/** A commit on `parent` with `changes` applied (null deletes), by plumbing: HEAD, index and worktree untouched. */
export function commitOn(repo: string, parent: string, changes: Record<string, string | null>, message = 'change'): string {
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-fixture-index-')), 'index');
  const env = { GIT_INDEX_FILE: index };
  try {
    git(repo, ['read-tree', parent], { env });
    for (const [rel, text] of Object.entries(changes)) {
      if (text === null) git(repo, ['update-index', '--force-remove', rel], { env });
      else {
        const sha = git(repo, ['hash-object', '-w', '--stdin'], { input: text });
        git(repo, ['update-index', '--add', '--cacheinfo', `100644,${sha},${rel}`], { env });
      }
    }
    const tree = git(repo, ['write-tree'], { env });
    return git(repo, ['commit-tree', tree, '-p', parent, '-m', message], {
      env: { GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@daylight.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@daylight.invalid' },
    });
  } finally {
    fs.rmSync(path.dirname(index), { recursive: true, force: true });
  }
}

/** `a → b` with capture's flags: the bytes a candidate's diff artifact holds. */
export function diffOf(repo: string, a: string, b: string): Buffer {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'diff', ...DIFF_FLAGS, a, b, '--'], { env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 });
}

export function filesOf(changes: Record<string, string | null>): CandidateFile[] {
  return Object.entries(changes).map(([p, t]) => ({
    path: p, change: t === null ? 'deleted' : 'modified', insertions: 1, deletions: 1, mode: 'file',
  }));
}

/** HEAD, the index bytes, the porcelain status and every ref but `refs/heads/daylight/**`. */
export function repoState(repo: string): string {
  return JSON.stringify({
    head: git(repo, ['rev-parse', 'HEAD']), sym: git(repo, ['symbolic-ref', 'HEAD']),
    index: fs.readFileSync(path.join(repo, '.git', 'index')).toString('hex'),
    status: git(repo, ['status', '--porcelain', '--untracked-files=all']),
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter((l) => !l.startsWith('refs/heads/daylight/')),
  });
}

export function openCtx(dir: string, repo: string): DaylightContext {
  const ctx = openDaylight(path.join(dir, 'out'));
  ctx.store.ensureProject(identifyProject(repo));
  return ctx;
}

export const ENVELOPE: Omit<CampaignEnvelope, 'notAfter'> = {
  planDigest: `sha256:${'a'.repeat(64)}`, gateSetDigest: `sha256:${'b'.repeat(64)}`, policyDigest: null, ticketIds: [],
  roster: ['mock'], reviewRoster: [], maxUsdTotal: 10, maxUsdPerMission: 2, maxTurns: 60, timeoutSeconds: 600,
  maxAttemptsPerTicket: 3, concurrency: 2, waveSize: 4, execute: false, autoApply: 'integration-ref',
  fixLane: { enabled: false, maxTicketsPerWave: 0, maxUsdPerTicket: 0 },
  identity: { name: 'Daylight campaign', email: 'campaign@daylight.invalid' },
};

/** A human `authorize-campaign` decision on the campaign: the envelope the director runs under. */
export function authorizeCampaign(ctx: DaylightContext, campaign: Mission, env: Partial<CampaignEnvelope> = {}): Decision {
  const scope: AuthorizeCampaignScope = { operation: 'authorize-campaign', ...ENVELOPE, notAfter: Date.now() + 3_600_000, ...env };
  return ctx.store.recordDecision({
    missionId: campaign.id, projectId: campaign.projectId, revision: campaign.baseRevision, actor: ACTOR, kind: 'approve', rationale: 'fixture',
    scope: scope as unknown as Record<string, unknown>, artifactIds: [],
  });
}

/** A campaign mission at `base` and a human `authorize-campaign` decision on it. */
export function makeCampaign(ctx: DaylightContext, repo: string, base: string, env: Partial<CampaignEnvelope> = {}, paths = ['daylight.plan.json']): { campaign: Mission; auth: Decision } {
  const projectId = identifyProject(repo).id;
  ctx.store.ensureProject(identifyProject(repo));
  const campaign = ctx.store.createMission({
    projectId, kind: 'campaign', objective: 'campaign fixture', baseRevision: base, scope: { paths },
  });
  return { campaign, auth: authorizeCampaign(ctx, campaign, env) };
}

/** A work item on the campaign, approved by a person (R5's approve-plan stands in for this). */
export function makeWorkItem(ctx: DaylightContext, campaign: Mission, ticketId: string, o: { approve?: boolean; title?: string; statement?: string } = {}): string {
  const spec = ctx.artifacts.put(`plan ${campaign.id}`, { kind: 'spec', projectId: campaign.projectId, label: 'plan' });
  const w = ctx.store.createWorkItem({
    projectId: campaign.projectId, missionId: campaign.id, specArtifact: spec, specRevision: campaign.baseRevision, anchor: `ticket:${ticketId}`,
    title: o.title ?? `Ticket ${ticketId}`, statement: o.statement ?? `do ${ticketId}`, examples: [], negativeExamples: [], proposedBy: 'plan',
  });
  if (o.approve !== false) approveWorkItem(ctx, campaign, w.id);
  return w.id;
}

export function approveWorkItem(ctx: DaylightContext, campaign: Mission, workItemId: string): void {
  const w = ctx.store.workItem(workItemId)!;
  ctx.store.decideWorkItem(w.id, 'proposed', 'approved', {
    missionId: campaign.id, projectId: campaign.projectId, revision: campaign.baseRevision, actor: ACTOR, kind: 'approve', rationale: 'fixture',
    scope: { operation: 'approve-work-item', workItemId: w.id, contentDigest: w.contentDigest }, artifactIds: [],
  });
}

/** An approved work item on the campaign and its implement mission, authorized by a person (the surgical path). */
export function makeTicketMission(ctx: DaylightContext, campaign: Mission, ticketId: string, base: string, scope?: string[]): Mission {
  const w = { id: makeWorkItem(ctx, campaign, ticketId) };
  const m = ctx.store.createMission({
    projectId: campaign.projectId, kind: 'implement', objective: `ticket ${ticketId}`, baseRevision: base, parentId: campaign.id,
    workItemId: w.id, scope: { paths: scope ?? [] },
  });
  return ctx.store.authorizeMission({ missionId: m.id, actor: ACTOR, rationale: 'fixture', permissions: { write: true, execute: false }, maxUsd: 2 }).mission;
}

/** A finished author attempt on `m` whose candidate is `diff` against `base`. */
export function makeCandidate(ctx: DaylightContext, m: Mission, base: string, diff: Buffer, files: CandidateFile[], gateSetDigest = `sha256:${'c'.repeat(64)}`): Candidate {
  const t = ctx.store.createTask({ missionId: m.id, role: 'author', objective: 'author', runnerHint: `mock:${ctx.store.tasks(m.id).length}` });
  const authorize = ctx.store.authorizeDecision(m.id)!;
  const a = ctx.store.startAttempt({
    taskId: t.id, runnerId: 'agent:mock:default', sandbox: { profile: 'author', network: 'none', write: true, exec: false, authorizeDecisionId: authorize.id },
  });
  ctx.store.finishAttempt(a.id, { state: 'completed', costUsd: 0.01, costSource: 'provider' });
  const diffArtifact = ctx.artifacts.put(diff, { kind: 'diff', projectId: m.projectId, revision: base, label: 'candidate diff' });
  const summaryArtifact = ctx.artifacts.put('{}', { kind: 'summary', projectId: m.projectId, revision: base, label: 'summary' });
  return ctx.store.createCandidate({
    missionId: m.id, attemptId: a.id, projectId: m.projectId, baseCommit: base, diffArtifact, summaryArtifact, files,
    policyViolations: [], secretHits: 0, gateSetDigest, profile: { name: 'author', network: 'none', write: true, exec: false },
    attemptState: 'completed',
  });
}

/** WS-R5's writer, stood in for: a decision row with any actor, inside the caller's transaction. */
export function rawDecision(store: MissionStore, input: CreateDecisionInput): Decision {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const d: Decision = { ...input, id: newId('decision'), at: Date.now() };
  db.prepare(
    `INSERT INTO decisions (id, mission_id, project_id, revision, actor, kind, subject, predicate, value, rationale, scope, artifact_ids, at)
     VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?)`,
  ).run(d.id, d.missionId, d.projectId, d.revision, d.actor, d.kind, d.rationale, JSON.stringify(d.scope), JSON.stringify(d.artifactIds), d.at);
  return d;
}

/** Stand-ins for `envelopeRefusal` and `recordDerivedDecision`; `refuse` makes the envelope say no. */
export function fakeDeps(o: { refuse?: string; seen?: EnvelopeRequest[] } = {}): IntegrateDeps {
  return {
    envelopeRefusal: (_store, _parent, request) => {
      o.seen?.push(request);
      return o.refuse ?? null;
    },
    recordDerivedDecision: (store, parent, input) => rawDecision(store, { ...input, scope: { ...input.scope, derivedFrom: parent } }),
  };
}

/** A plan ticket row as R5 will store it. */
export function ticketRow(campaign: Mission, workItemId: string, t: { id: string; lane: string; dependsOn?: string[]; scope: string[]; acceptance?: CampaignTicket['acceptance']; budget?: CampaignTicket['budget']; origin?: CampaignTicket['origin']; blocksOn?: string[] }): CampaignTicket {
  return {
    campaignId: campaign.id, ticketId: t.id, projectId: campaign.projectId, workItemId, origin: t.origin ?? 'plan', lane: t.lane, dependsOn: t.dependsOn ?? [],
    scope: t.scope, acceptance: t.acceptance ?? { kind: 'ci-only' }, budget: t.budget ?? {}, blocksOn: t.blocksOn ?? [], ticketDigest: `sha256:${'d'.repeat(64)}`,
    createdAt: Date.now(),
  };
}

/**
 * WS-R5's side of the director, stood in for with human acts and raw rows: ticket missions are
 * created and authorized by a person (the surgical path, §2.3), halts and admissions written as
 * R5's derived decisions will be.
 */
export function testHost(ctx: DaylightContext, campaign: Mission, plan: PlanFileV1, tickets: CampaignTicket[], o: { deps?: IntegrateDeps; open?: string[] } = {}): CampaignHost & { tickets(): CampaignTicket[] } {
  const auth = () => ctx.store.decisions(campaign.id).filter((d) => d.scope.operation === 'authorize-campaign').at(-1)!;
  return {
    tickets: () => tickets,
    plan: () => plan,
    openOwnerDecisions: () => new Set(o.open ?? []),
    authorizationRefusal: () => null,
    startTicketMission: (_c, ticketId, base) => {
      const t = tickets.find((x) => x.ticketId === ticketId)!;
      const env = auth().scope as unknown as CampaignEnvelope;
      const m = ctx.store.createMission({
        projectId: campaign.projectId, kind: 'implement', objective: `ticket ${ticketId}`, baseRevision: base, parentId: campaign.id,
        workItemId: t.workItemId, scope: { paths: t.scope },
      });
      const { mission, decision } = ctx.store.authorizeMission({
        missionId: m.id, actor: ACTOR, rationale: 'stand-in for the derived grant', permissions: { write: true, execute: env.execute },
        maxUsd: Math.min(t.budget.maxUsd ?? Infinity, env.maxUsdPerMission),
      });
      ctx.events.append({ projectId: m.projectId, missionId: m.id, actorId: 'daylight', category: 'approval', name: 'campaign.mission.authorized',
        payload: { decisionId: decision.id, derivedFrom: auth().id, ticketId, permissions: mission.permissions, maxUsd: mission.budget.maxUsd ?? null } });
      return mission;
    },
    halt: (_c, reason) => {
      const d = rawDecision(ctx.store, {
        missionId: campaign.id, projectId: campaign.projectId, revision: campaign.baseRevision, actor: `campaign:${campaign.id}`, kind: 'defer',
        rationale: `halted by the director: ${reason}`, scope: { operation: 'halt-campaign', reason, derivedFrom: auth().id }, artifactIds: [],
      });
      ctx.events.append({ projectId: campaign.projectId, missionId: campaign.id, actorId: `campaign:${campaign.id}`, category: 'lifecycle', name: 'campaign.halted',
        payload: { decisionId: d.id, reason } });
      return d;
    },
    fileFixTicket: (_c, { waveSeq, finding }) => {
      const env = auth().scope as unknown as CampaignEnvelope;
      const ticketId = `FIX.${waveSeq}.${tickets.filter((x) => x.ticketId.startsWith(`FIX.${waveSeq}.`)).length + 1}`;
      const workItemId = makeWorkItem(ctx, campaign, ticketId, { approve: false, title: `Fix: ${finding.title}`.slice(0, 120), statement: finding.statement });
      const row = ticketRow(campaign, workItemId, {
        id: ticketId, lane: 'FIX', scope: [finding.path], acceptance: plan.defaults?.acceptance, budget: { maxUsd: env.fixLane.maxUsdPerTicket }, origin: 'fix',
      });
      tickets.push({ ...row, sourceRef: finding.id });
      return ticketId;
    },
    admitIfWithinEnvelope: (_c, workItemId, wave) => {
      const env = auth().scope as unknown as CampaignEnvelope;
      if (wave.severity !== 'high' || !env.fixLane.enabled || wave.admitted >= Math.min(5, env.fixLane.maxTicketsPerWave)) return { admitted: false };
      approveWorkItem(ctx, campaign, workItemId);
      return { admitted: true };
    },
    // R5's admission() counts a derived admission and a person's approval alike (P2-R36).
    admitted: (_c, workItemId) => ctx.store.workItem(workItemId)?.status === 'approved',
    integrate: o.deps ?? fakeDeps(),
  };
}

/**
 * The verdict the director records when every check passed on an integration's tree, and the
 * campaign lock it names: what `landIntegration` requires before anything lands (P2-R35).
 */
export function accept(ctx: DaylightContext, i: Integration): Integration {
  const c = ctx.store.candidate(i.candidateId)!;
  if (!ctx.store.campaignLockDecision(i.campaignId)) {
    const campaign = ctx.store.mission(i.campaignId)!;
    ctx.store.recordDecision({
      missionId: campaign.id, projectId: campaign.projectId, revision: campaign.baseRevision, actor: ACTOR, kind: 'approve', rationale: 'fixture lock',
      scope: { operation: 'lock-campaign-gates', experimentIds: [], harnessDigests: {}, vacuousOverrides: [], bindings: {}, roles: {}, ratchet: false, gateSetDigest: c.gateSetDigest },
      artifactIds: [],
    });
  }
  ctx.store.updateCandidateVerdict(c.id, 'accepted-by-gates', [`all required checks supported on the integrated tree ${i.integratedDiffDigest}`]);
  return i;
}
