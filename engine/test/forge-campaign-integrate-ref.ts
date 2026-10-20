/**
 * The campaign integration ref and rebase by plumbing (§3.4, §4.3, §4.4). Run:
 * node engine/test/forge-campaign-integrate-ref.ts
 *
 * Temp repositories, no sandbox: nothing here runs a gate. The integration ref moves only by
 * compare-and-swap; a candidate on the tip is applied with its own digest, one on an older tip
 * is merged three-way, a conflict writes nothing; no hook or fsmonitor runs; HEAD, the index
 * and the working tree are byte-equal throughout, also after a store refusal undoes a landing;
 * and a crash after each step resumes, by the §4.4 table, to the same landed set with no
 * duplicate application.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { applicationRefusals } from '../forge/apply.ts';
import {
  adoptIntegrationTip, adoptScopeOf, buildIntegrated, ensureIntegrationRef, InjectedCrash, integratedDigestOf, integrationRefFor, integrationRefusals, integrationTip,
  landCandidate, prepareIntegration, reconcileIntegrations, refTarget, type IntegrationStep,
} from '../forge/integrate.ts';
import { applyRefFor, confirmDigest } from '../forge/confirm.ts';
import { digestOf } from '../mission/artifacts.ts';
import type { Candidate, Mission } from '../mission/types.ts';
import { harness } from './harness.ts';
import {
  accept, ACTOR, commitOn, diffOf, fakeDeps, filesOf, git, makeCampaign, makeCandidate, makeRepo, makeTicketMission, openCtx, repoState, tempDir,
} from './forge-campaign-run-fixture.ts';

const { check, section, done } = harness();

const FILES = { 'src/a.js': 'module.exports = 1;\n', 'src/b.js': 'module.exports = 2;\n', 'src/c.js': 'line1\nline2\nline3\n' };

function world() {
  const dir = tempDir('daylight-campaign-integrate-');
  const { repo, base } = makeRepo(dir, FILES);
  const ctx = openCtx(dir, repo);
  const { campaign, auth } = makeCampaign(ctx, repo, base);
  ensureIntegrationRef(repo, campaign.id, base);
  const ictx = { store: ctx.store, events: ctx.events, artifacts: ctx.artifacts, repoRoot: repo };
  /** A ticket mission whose candidate makes `changes` on top of `on`. */
  const ticket = (id: string, on: string, changes: Record<string, string | null>): { m: Mission; c: Candidate } => {
    const m = makeTicketMission(ctx, campaign, id, base);
    const side = commitOn(repo, on, changes);
    const c = makeCandidate(ctx, m, on, diffOf(repo, on, side), filesOf(changes));
    return { m, c };
  };
  return { dir, repo, base, ctx, ictx, campaign, auth, ticket };
}

const objectCount = (repo: string) => git(repo, ['count-objects', '-v']).split('\n').filter((l) => /^(count|in-pack):/.test(l)).join(',');

section('buildIntegrated: apply on the tip, three-way onto a moved tip, a conflict writes nothing');
{
  const w = world();
  const { m: _m, c } = w.ticket('T1', w.base, { 'src/a.js': 'module.exports = 10;\n' });
  void _m;
  const diff = w.ctx.artifacts.get(c.diffArtifact);
  const id = { name: 'X', email: 'x@daylight.invalid' };
  const applied = buildIntegrated(w.repo, { onto: w.base, base: w.base, diff, diffDigest: c.diffArtifact.digest, message: 'm\n', identity: id, when: 1 });
  check('a candidate on the tip is applied, and its integrated digest is its own', 'commit' in applied && applied.method === 'apply' && applied.diffDigest === c.diffArtifact.digest,
    JSON.stringify(applied));
  const again = buildIntegrated(w.repo, { onto: w.base, base: w.base, diff, diffDigest: c.diffArtifact.digest, message: 'm\n', identity: id, when: 1 });
  check('the same inputs build the same commit (reproducible)', 'commit' in applied && 'commit' in again && applied.commit === again.commit);

  const moved = commitOn(w.repo, w.base, { 'src/b.js': 'module.exports = 20;\n' });
  const merged = buildIntegrated(w.repo, { onto: moved, base: w.base, diff, diffDigest: c.diffArtifact.digest, message: 'm\n', identity: id, when: 1 });
  check('a candidate on an older tip is merged three-way onto the new one', 'commit' in merged && merged.method === 'three-way', JSON.stringify(merged));
  if ('commit' in merged) {
    check('the merged commit\'s parent is the tip it was put onto', git(w.repo, ['rev-parse', `${merged.commit}^1`]) === moved);
    check('it carries both changes', git(w.repo, ['show', `${merged.commit}:src/a.js`]) === 'module.exports = 10;' && git(w.repo, ['show', `${merged.commit}:src/b.js`]) === 'module.exports = 20;');
    check('its digest is the tip → commit diff, re-derived from the repository', integratedDigestOf(w.repo, moved, merged.commit) === merged.diffDigest);
  }

  const theirs = commitOn(w.repo, w.base, { 'src/c.js': 'line1\nTHEIRS\nline3\n' });
  const mineSide = commitOn(w.repo, w.base, { 'src/c.js': 'line1\nMINE\nline3\n' });
  const mine = diffOf(w.repo, w.base, mineSide);
  const before = objectCount(w.repo);
  const conflict = buildIntegrated(w.repo, { onto: theirs, base: w.base, diff: mine, diffDigest: digestOf(mine), message: 'm\n', identity: id, when: 1 });
  check('a diff that does not merge reports the conflicted paths', 'conflict' in conflict && conflict.conflict.join(',') === 'src/c.js', JSON.stringify(conflict));
  check('and writes nothing to the real object store', objectCount(w.repo) === before, `${before} vs ${objectCount(w.repo)}`);
  w.ctx.close();
}

section('landing: the ref moves by compare-and-swap; hooks and fsmonitor never run; HEAD, index, worktree untouched');
{
  const w = world();
  const marker = path.join(w.dir, 'hook-ran');
  const hook = `#!/bin/sh\ntouch ${marker}\n`;
  for (const h of ['post-commit', 'reference-transaction', 'post-checkout', 'pre-commit']) {
    fs.writeFileSync(path.join(w.repo, '.git', 'hooks', h), hook, { mode: 0o755 });
  }
  const monitor = path.join(w.dir, 'fsmonitor.sh');
  fs.writeFileSync(monitor, hook, { mode: 0o755 });
  git(w.repo, ['config', 'core.fsmonitor', monitor]);
  // Rewrite the index stat data now so later reads compare bytes, not a stale refresh.
  fs.rmSync(marker, { force: true });
  const state = repoState(w.repo);

  const t1 = w.ticket('T1', w.base, { 'src/a.js': 'module.exports = 10;\n' });
  const t2 = w.ticket('T2', w.base, { 'src/b.js': 'module.exports = 20;\n' });
  const deps = fakeDeps();
  const i1 = prepareIntegration(w.ictx, t1.c.id, { ticketId: 'T1', deps });
  check('integration 1 is evaluating, applied onto the base', i1.state === 'evaluating' && i1.method === 'apply' && i1.onto === w.base, JSON.stringify(i1));
  const l1 = landCandidate(w.ictx, accept(w.ctx, i1).id, { ticketId: 'T1', deps });
  check('it lands: the ref is its commit', 'landed' in l1 && integrationTip(w.repo, w.campaign.id) === i1.integratedCommit, JSON.stringify(l1).slice(0, 300));
  check('its per-mission ref names the same commit', refTarget(w.repo, applyRefFor(t1.m.id)) === i1.integratedCommit);
  if ('landed' in l1) {
    check('the application is the campaign\'s, onto the tip', l1.application.appliedBy === `campaign:${w.campaign.id}` && l1.application.baseCommit === w.base);
    check('the derived decision is on the ticket mission and names its parent grant', l1.decision.missionId === t1.m.id && l1.decision.scope.derivedFrom === w.auth.id);
  }
  check('the ticket mission closed as succeeded (ADR-23)', w.ctx.store.mission(t1.m.id)!.outcome === 'succeeded');

  const i2 = prepareIntegration(w.ictx, t2.c.id, { ticketId: 'T2', deps });
  check('integration 2 is three-way onto the first landing', i2.method === 'three-way' && i2.onto === i1.integratedCommit, JSON.stringify(i2));
  const l2 = landCandidate(w.ictx, accept(w.ctx, i2).id, { ticketId: 'T2', deps });
  check('and lands on top of it', 'landed' in l2 && integrationTip(w.repo, w.campaign.id) === i2.integratedCommit);
  const commitMsg = git(w.repo, ['log', '-1', '--format=%B', i2.integratedCommit!]);
  check('the commit carries the campaign trailers, ids only', /Daylight-Campaign: m_[0-9a-f]{32}/.test(commitMsg) && /Daylight-Ticket: T2/.test(commitMsg)
    && /Daylight-Integration: i_[0-9a-f]{32} onto [0-9a-f]{12} \(three-way\)/.test(commitMsg) && !/\$/.test(commitMsg), commitMsg);

  check('no hook and no fsmonitor ran', !fs.existsSync(marker));
  check('HEAD, the index, the worktree and every other ref are byte-equal', repoState(w.repo) === state);
  check('integrationRefusals is empty', integrationRefusals(w.ictx, w.campaign.id).length === 0, integrationRefusals(w.ictx, w.campaign.id).join('; '));
  check('applicationRefusals is empty', applicationRefusals({ store: w.ctx.store, repoRoot: w.repo }).length === 0,
    applicationRefusals({ store: w.ctx.store, repoRoot: w.repo }).join('; '));

  section('a ref that moved underneath: the CAS is refused, the per-mission ref goes, the row is abandoned');
  const t3 = w.ticket('T3', i2.integratedCommit!, { 'src/c.js': 'x\n' });
  const i3 = prepareIntegration(w.ictx, t3.c.id, { ticketId: 'T3', deps });
  const foreign = commitOn(w.repo, i2.integratedCommit!, { 'README': 'someone else\n' });
  git(w.repo, ['update-ref', integrationRefFor(w.campaign.id), foreign]);
  const l3 = landCandidate(w.ictx, accept(w.ctx, i3).id, { ticketId: 'T3', deps });
  check('refused', 'refused' in l3 && /no longer at/.test(l3.refused), JSON.stringify(l3).slice(0, 200));
  check('the ref was not touched', integrationTip(w.repo, w.campaign.id) === foreign);
  check('the per-mission ref was removed', refTarget(w.repo, applyRefFor(t3.m.id)) === null);
  check('the integration is abandoned, with no decision or application', w.ctx.store.integration(i3.id)!.state === 'abandoned' && !w.ctx.store.application(t3.c.id));
  check('integrationRefusals names the foreign commit', integrationRefusals(w.ictx, w.campaign.id).some((l) => l.includes(foreign)));
  git(w.repo, ['update-ref', integrationRefFor(w.campaign.id), i2.integratedCommit!, foreign]);

  section('the per-mission ref is create-only');
  const i3b = prepareIntegration(w.ictx, t3.c.id, { ticketId: 'T3', deps });
  git(w.repo, ['update-ref', applyRefFor(t3.m.id), foreign]);
  const l3b = landCandidate(w.ictx, accept(w.ctx, i3b).id, { ticketId: 'T3', deps });
  check('a per-mission ref that already names something else refuses the landing', 'refused' in l3b && /never overwritten/.test(l3b.refused));
  check('and is left as it was; the integration ref did not move', refTarget(w.repo, applyRefFor(t3.m.id)) === foreign && integrationTip(w.repo, w.campaign.id) === i2.integratedCommit);
  git(w.repo, ['update-ref', '-d', applyRefFor(t3.m.id), foreign]);

  section('a store refusal inside the transaction undoes both refs (P2-R22)');
  const i3c = prepareIntegration(w.ictx, t3.c.id, { ticketId: 'T3', deps });
  const refused = landCandidate(w.ictx, accept(w.ctx, i3c).id, { ticketId: 'T3', deps: fakeDeps({ refuse: 'halted' }) });
  check('the envelope refusal is reported', 'refused' in refused && /halted/.test(refused.refused));
  check('the integration ref is back at the tip, by compare-and-swap', integrationTip(w.repo, w.campaign.id) === i2.integratedCommit);
  check('the per-mission ref is gone', refTarget(w.repo, applyRefFor(t3.m.id)) === null);
  check('no decision, no application, the row abandoned', !w.ctx.store.application(t3.c.id) && w.ctx.store.integration(i3c.id)!.state === 'abandoned'
    && !w.ctx.store.decisions(t3.m.id).some((d) => d.scope.operation === 'integrate-candidate'));
  check('HEAD, the index, the worktree and every other ref are still byte-equal', repoState(w.repo) === state);
  check('no hook ran', !fs.existsSync(marker));
  check('the invariants still hold', integrationRefusals(w.ictx, w.campaign.id).length === 0 && applicationRefusals({ store: w.ctx.store, repoRoot: w.repo }).length === 0,
    integrationRefusals(w.ictx, w.campaign.id).join('; '));
  w.ctx.close();
}

section('resume: a crash after each step comes back to the same landing (§4.4)');
const STEPS: IntegrationStep[] = ['recorded', 'built', 'mission-ref', 'cas', 'landed'];
for (const step of STEPS) {
  const w = world();
  const deps = fakeDeps();
  const t = w.ticket('T1', w.base, { 'src/a.js': 'module.exports = 10;\n' });
  const ticketOf = () => 'T1';
  let crashed = false;
  try {
    const i = prepareIntegration(w.ictx, t.c.id, { ticketId: 'T1', deps, crashAfter: step });
    landCandidate(w.ictx, accept(w.ctx, i).id, { ticketId: 'T1', deps, crashAfter: step });
  } catch (err) {
    crashed = err instanceof InjectedCrash;
  }
  check(`${step}: the crash happened there`, crashed);
  const r = reconcileIntegrations(w.ictx, w.campaign.id, { ticketOf, deps });
  if (r.requeue.includes(t.c.id)) {
    const i = prepareIntegration(w.ictx, t.c.id, { ticketId: 'T1', deps });
    landCandidate(w.ictx, accept(w.ctx, i).id, { ticketId: 'T1', deps });
  }
  const again = reconcileIntegrations(w.ictx, w.campaign.id, { ticketOf, deps });
  const landed = w.ctx.store.integrations(w.campaign.id, { state: 'integrated' });
  check(`${step}: exactly one landing, one application`, landed.length === 1 && w.ctx.store.applications(t.m.id).length === 1,
    `${landed.length} landed; ${JSON.stringify(r)}`);
  check(`${step}: the ref is that landing's commit and nothing is unexplained`, integrationTip(w.repo, w.campaign.id) === landed[0]?.integratedCommit && again.moved === null
    && integrationRefusals(w.ictx, w.campaign.id).length === 0, integrationRefusals(w.ictx, w.campaign.id).join('; '));
  check(`${step}: a second reconcile does nothing`, again.requeue.length === 0 && again.landed.length === 0 && again.deletedRefs.length === 0, JSON.stringify(again));
  check(`${step}: the ticket mission is closed as succeeded`, w.ctx.store.mission(t.m.id)!.outcome === 'succeeded');
  w.ctx.close();
}

section('a candidate that is not accepted-by-gates on the integrated tree never lands (P2-R35)');
{
  const w = world();
  const deps = fakeDeps();
  const t = w.ticket('T1', w.base, { 'src/a.js': 'module.exports = 10;\n' });
  const i = prepareIntegration(w.ictx, t.c.id, { ticketId: 'T1', deps });
  accept(w.ctx, i);
  w.ctx.store.updateCandidateVerdict(t.c.id, 'rejected-by-gates', ['gate x: falsified on the integrated tree']);
  const r = landCandidate(w.ictx, i.id, { ticketId: 'T1', deps });
  check('a rejected-by-gates candidate is refused, naming its verdict', 'refused' in r && /rejected-by-gates/.test(r.refused), JSON.stringify(r).slice(0, 200));
  check('nothing moved and nothing was recorded', integrationTip(w.repo, w.campaign.id) === w.base && !w.ctx.store.application(t.c.id));
  const i2 = prepareIntegration(w.ictx, t.c.id, { ticketId: 'T1', deps });
  w.ctx.store.updateCandidateVerdict(t.c.id, 'accepted-by-gates', [`accepted on another tree ${'sha256:' + '0'.repeat(64)}`]);
  check('accepted on another integration\'s tree is not accepted on this one', 'refused' in landCandidate(w.ictx, i2.id, { ticketId: 'T1', deps }));
  const i3 = prepareIntegration(w.ictx, t.c.id, { ticketId: 'T1', deps });
  w.ctx.store.updateCandidateVerdict(t.c.id, 'rejected-by-gates', ['x']);
  git(w.repo, ['update-ref', integrationRefFor(w.campaign.id), i3.integratedCommit!, w.base]);
  reconcileIntegrations(w.ictx, w.campaign.id, { ticketOf: () => 'T1', deps });
  check('the resume path refuses it too: the ref goes back and the row is abandoned', integrationTip(w.repo, w.campaign.id) === w.base
    && w.ctx.store.integration(i3.id)!.state === 'abandoned' && !w.ctx.store.application(t.c.id));
  w.ctx.close();
}

section('resume: the rows the table names that no crash above leaves');
{
  const w = world();
  const deps = fakeDeps();
  const t = w.ticket('T1', w.base, { 'src/a.js': 'module.exports = 10;\n' });
  const i = prepareIntegration(w.ictx, t.c.id, { ticketId: 'T1', deps });
  landCandidate(w.ictx, accept(w.ctx, i).id, { ticketId: 'T1', deps });
  // integrated, no application: only a hand-written row can say this; the ref contains the commit.
  const db = (w.ctx.store as unknown as { db: DatabaseSync }).db;
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('UPDATE integrations SET application_id=NULL WHERE id=?').run(i.id);
  db.prepare('DELETE FROM applications WHERE candidate_id=?').run(t.c.id);
  db.exec('PRAGMA foreign_keys = ON');
  const r = reconcileIntegrations(w.ictx, w.campaign.id, { ticketOf: () => 'T1', deps });
  check('integrated without an application: the application is recorded again', r.landed.includes(i.id) && !!w.ctx.store.application(t.c.id)
    && w.ctx.store.integration(i.id)!.applicationId === w.ctx.store.application(t.c.id)!.id, JSON.stringify(r));

  const t2 = w.ticket('T2', i.integratedCommit!, { 'src/b.js': 'module.exports = 20;\n' });
  const i2 = prepareIntegration(w.ictx, t2.c.id, { ticketId: 'T2', deps });
  landCandidate(w.ictx, accept(w.ctx, i2).id, { ticketId: 'T2', deps });
  w.ctx.store.updateIntegration(i.id, 'integrated', { applicationId: w.ctx.store.application(t.c.id)!.id });
  check('a later repair of an older landing\'s row does not make it look like the tip (L5)', reconcileIntegrations(w.ictx, w.campaign.id, { ticketOf: () => 'T1', deps }).moved === null);
  check('immediate joins a transaction already open instead of nesting BEGIN (L7)', w.ctx.store.immediate(() => w.ctx.store.immediate(() => 7)) === 7);
  const stray = makeTicketMission(w.ctx, w.campaign, 'T9', w.base);
  const strayCommit = commitOn(w.repo, w.base, { 'src/z.js': 'z\n' });
  git(w.repo, ['update-ref', applyRefFor(stray.id), strayCommit]);
  const r2 = reconcileIntegrations(w.ictx, w.campaign.id, { ticketOf: () => 'T9', deps });
  check('a per-mission ref with no application, naming an unrecorded commit, is deleted', r2.deletedRefs.includes(applyRefFor(stray.id)) && refTarget(w.repo, applyRefFor(stray.id)) === null);

  const foreign = commitOn(w.repo, i2.integratedCommit!, { README: 'pushed by hand\n' });
  git(w.repo, ['update-ref', integrationRefFor(w.campaign.id), foreign]);
  const r3 = reconcileIntegrations(w.ictx, w.campaign.id, { ticketOf: () => 'T1', deps });
  check('a ref no row explains is reported moved, for the director to halt integration-moved', r3.moved?.actual === foreign && r3.moved.expected === i2.integratedCommit);

  section('adopt-tip: a person explains the foreign commits and answers the halt');
  const halt = w.ctx.store.recordDecision({
    missionId: w.campaign.id, projectId: w.campaign.projectId, revision: w.base, actor: ACTOR, kind: 'defer', rationale: 'moved',
    scope: { operation: 'halt-campaign', reason: 'integration-moved' }, artifactIds: [],
  });
  const scope = adoptScopeOf(w.ictx, w.campaign.id, halt.id);
  const code = confirmDigest(w.ictx, 'adopt-integration-tip', w.campaign.id, { adopt: { ref: scope.ref, from: scope.from, to: scope.to, haltDecisionId: halt.id } }).digest8;
  const human = { ...process.env, CLAUDECODE: '', DAYLIGHT_SESSION: '' };
  const tryAdopt = (o: Partial<Parameters<typeof adoptIntegrationTip>[1]>) => {
    try {
      adoptIntegrationTip(w.ictx, { campaignId: w.campaign.id, haltDecisionId: halt.id, actor: ACTOR, rationale: 'pushed by hand, reviewed', confirm: code, env: human, ...o });
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };
  check('refused under CLAUDECODE', /CLAUDECODE/.test(tryAdopt({ env: { ...human, CLAUDECODE: '1' } }) ?? ''));
  check('refused with the wrong confirm code', /--confirm/.test(tryAdopt({ confirm: '00000000' }) ?? ''));
  check('the scope names the move: from the last landing to the foreign commit', scope.from === i2.integratedCommit && scope.to === foreign);
  const rewritten = commitOn(w.repo, w.base, { README: 'history rewritten\n' });
  git(w.repo, ['update-ref', integrationRefFor(w.campaign.id), rewritten]);
  const s2 = adoptScopeOf(w.ictx, w.campaign.id, halt.id);
  const c2 = confirmDigest(w.ictx, 'adopt-integration-tip', w.campaign.id, { adopt: { ref: s2.ref, from: s2.from, to: s2.to, haltDecisionId: halt.id } }).digest8;
  check('a ref rewritten under a landing is never adopted', /would be lost/.test(tryAdopt({ confirm: c2 }) ?? ''));
  git(w.repo, ['update-ref', integrationRefFor(w.campaign.id), foreign]);
  check('accepted from a person\'s shell', tryAdopt({}) === null);
  check('the halt is answered and the ref is explained again', reconcileIntegrations(w.ictx, w.campaign.id, { ticketOf: () => 'T1', deps }).moved === null
    && integrationRefusals(w.ictx, w.campaign.id).length === 0, integrationRefusals(w.ictx, w.campaign.id).join('; '));
  const s3 = adoptScopeOf(w.ictx, w.campaign.id, halt.id);
  const c3 = confirmDigest(w.ictx, 'adopt-integration-tip', w.campaign.id, { adopt: { ref: s3.ref, from: s3.from, to: s3.to, haltDecisionId: halt.id } }).digest8;
  check('a second adoption of the same halt is refused', /not an unanswered halt/.test(tryAdopt({ confirm: c3 }) ?? ''));
  w.ctx.close();
}

done();
