/**
 * Campaign reports, the campaign list and `confirm` for campaign acts (WS-R8, ADR-40).
 * Run: node engine/test/forge-campaign-report.ts
 *
 * What must hold: `daylight confirm` prints, for every campaign and assumption act, the digest
 * the act itself accepts, and says the act is refused in an agent session while still printing
 * it (P2-R40, P2-R45 D6). The wave report's landings are exactly the range's integrations with
 * git's own line counts; its spend lines sum to `campaignSpend` and never print a figure for
 * unknown spend; holdouts are counts with no id, path or basename anywhere; the STATUS table is
 * `STATUS_BUCKET_OF` over the ticket states, shared with `campaign status`; forgery-shaped
 * candidates are counted and classed, never quoted; the same rows print the same bytes; `--write`
 * writes under `<out>` only and is refused in an agent session. Mocks only: no model, no cargo,
 * no bwrap.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildWaveReport, campaignList, renderWaveReport, runClaimOf, spendWords, statusTable } from '../forge/campaign-report.ts';
import { registerCampaignGate, registerPlanGates } from '../forge/campaign-gates.ts';
import { haltCampaign, importPlan, planOf, startTicketMission } from '../forge/campaign.ts';
import { campaignReadOnly } from '../forge/commands-campaign.ts';
import { campaignSpend, r5Host, ticketStates } from '../forge/director.ts';
import { ensureIntegrationRef, integrationRefFor, integrationTip, landCandidate, prepareIntegration } from '../forge/integrate.ts';
import { closeWave, fixTicketsFrom } from '../forge/wave.ts';
import { r5StatusHost } from '../forge/campaign-status.ts';
import { runClaimFile } from '../mission/orchestrate.ts';
import { newId } from '../mission/store.ts';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { STATUS_BUCKET_OF, STATUS_BUCKETS, type CandidateForgeryShapes, type CampaignStatusReport, type ForgeAssumptionRow, type ForgeCampaignList, type ForgeCampaignShow, type PlanFileV1, type SpendLine, type WaveReport } from '../mission/types.ts';
import {
  approve, authorize, CLEAN_ENV, git, HUMAN, imported, lock, lockedGateSet, ROOT, tmp,
} from './forge-campaign-fixture.ts';
import { accept, commitOn, diffOf, fakeDeps, filesOf, makeCandidate, repoState } from './forge-campaign-run-fixture.ts';
import { defaultOut as defaultOutFor } from '../paths.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const CLI = path.join(ROOT, 'engine', 'cli.ts');

const cli = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', XDG_DATA_HOME: tmp, ...env }, timeout: 120_000 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const json = <T>(r: { out: string }): T | null => {
  try {
    return JSON.parse(r.out) as T;
  } catch {
    return null;
  }
};
const reopen = (out: string, fn: (ctx: DaylightContext) => void) => {
  const ctx = openDaylight(out);
  try {
    fn(ctx);
  } finally {
    ctx.close();
  }
};

interface Confirmed { operation: string; subjectId: string; digest: string; digest8: string; lines: string[]; refusal: string | null; possibleSecrets: unknown[] }

/**
 * One operation, end to end: `confirm` under CLAUDECODE prints the digest with a refusal and
 * exit 0; the act with that code is refused there; `confirm` in a person's shell prints the same
 * digest with no refusal, and the act accepts its code.
 */
function confirmsAct(name: string, out: string, confirmArgs: string[], act: string[]): boolean {
  const agent = cli(['confirm', ...confirmArgs, '--out', out, '--format', 'json'], { CLAUDECODE: '1' });
  const a = json<Confirmed>(agent);
  check(`${name}: confirm runs under CLAUDECODE, exit 0, with the refusal set`, agent.code === 0 && !!a?.refusal && /CLAUDECODE/.test(a.refusal), `${agent.code} ${agent.err} ${agent.out.slice(0, 200)}`);
  const refused = cli([...act, '--out', out, '--confirm', a?.digest8 ?? '00000000'], { CLAUDECODE: '1' });
  check(`${name}: the act with that code is refused under CLAUDECODE`, refused.code === 1 && /refused/.test(refused.err), `${refused.code} ${refused.err}`);
  const human = cli(['confirm', ...confirmArgs, '--out', out, '--format', 'json']);
  const h = json<Confirmed>(human);
  check(`${name}: in a person's shell the same digest, no refusal`, human.code === 0 && h?.refusal === null && h.digest === a?.digest && /^[0-9a-f]{8}$/.test(h.digest8),
    `${human.code} ${human.err} ${human.out.slice(0, 200)}`);
  const done = cli([...act, '--out', out, '--confirm', h?.digest8 ?? '00000000']);
  check(`${name}: the act accepts the printed code`, done.code === 0, `${done.code} ${done.err}`);
  return done.code === 0;
}

section('confirm knows every campaign and assumption act (P2-R40, P2-R45 D6)');
{
  const s = imported('confirm');
  const id = s.imp.campaign.id;
  const [o1, o2] = ['O1', 'O2'].map((o) => s.ctx.store.assumptions(id).find((a) => a.ownerDecisionId === o)!.id);
  registerPlanGates({ store: s.ctx.store, artifacts: s.ctx.artifacts, events: s.ctx.events, repoRoot: s.root, out: s.out, env: CLEAN_ENV }, id, planOf(s.ctx, id).plan);
  for (const x of s.ctx.store.experimentsFor(id)) {
    s.ctx.store.recordGateEvaluation({ missionId: id, projectId: s.imp.campaign.projectId, revision: s.commit, experimentId: x.id, target: 'base', diffDigest: null,
      harnessDigest: x.harnessDigest, executions: [], conclusion: x.role === 'regression' ? 'supported' : 'falsified' });
  }
  s.ctx.close();

  const unknown = cli(['confirm', 'halt-campaign', id, '--out', s.out]);
  check('halt-campaign has no digest and is not a confirm operation', unknown.code === 2 && /confirm needs one of/.test(unknown.err), unknown.err);

  // H8: an empty rationale given as --rationale= reaches the act as '' and is refused there.
  const ap = json<Confirmed>(cli(['confirm', 'approve-plan', id, '--out', s.out, '--format', 'json']));
  const empty = cli(['campaign', 'approve-plan', id, '--rationale=', '--out', s.out, '--confirm', ap?.digest8 ?? '']);
  check('approve-plan with --rationale= and the right code is refused for the empty rationale', empty.code === 1 && /needs a rationale/.test(empty.err), `${empty.code} ${empty.err}`);

  confirmsAct('approve-plan', s.out, ['approve-plan', id], ['campaign', 'approve-plan', id, '--rationale', 'read']);
  // --ratchet is in the digest: confirm agrees with the act's own preview for each, and they differ (L1).
  const ratchetOf = (flag: string) => ({
    confirm: json<Confirmed>(cli(['confirm', 'lock-campaign-gates', id, flag, '--out', s.out, '--format', 'json']))?.digest,
    act: json<{ digest: string }>(cli(['campaign', 'lock', id, flag, '--rationale', 'read', '--out', s.out, '--format', 'json']))?.digest,
  });
  const on = ratchetOf('--ratchet');
  const off = ratchetOf('--no-ratchet');
  check('confirm lock-campaign-gates --ratchet digests as the act does, and not as --no-ratchet', !!on.confirm && on.confirm === on.act && off.confirm === off.act && on.confirm !== off.confirm,
    JSON.stringify({ on, off }));
  // --accept-vacuous is part of what is confirmed (L6): a code for the plain lock does not lock with it.
  let gateId = '';
  reopen(s.out, (ctx) => {
    gateId = ctx.store.experimentsFor(id).find((x) => x.role === 'gate')?.id ?? '';
  });
  const vac = ratchetOf('--no-ratchet');
  const withVac = {
    confirm: json<Confirmed>(cli(['confirm', 'lock-campaign-gates', id, '--no-ratchet', '--accept-vacuous', gateId, '--out', s.out, '--format', 'json'])),
    act: json<{ digest: string }>(cli(['campaign', 'lock', id, '--no-ratchet', '--accept-vacuous', gateId, '--rationale', 'r', '--out', s.out, '--format', 'json']))?.digest,
  };
  check('confirm lock-campaign-gates --accept-vacuous digests as the act does, and not as the plain lock', !!gateId && withVac.confirm?.digest === withVac.act
    && withVac.act !== vac.act && withVac.confirm?.lines.some((l) => l.includes('vacuous')) === true, JSON.stringify(withVac));
  const crossed = cli(['campaign', 'lock', id, '--no-ratchet', '--accept-vacuous', gateId, '--rationale', 'r', '--out', s.out, '--confirm', (vac.confirm ?? 'sha256:00000000').slice(7, 15)]);
  check('the plain lock\'s code does not confirm a lock that accepts a vacuous gate', crossed.code === 1 && /--confirm/.test(crossed.err), crossed.err);
  confirmsAct('lock-campaign-gates', s.out, ['lock-campaign-gates', id, '--no-ratchet'], ['campaign', 'lock', id, '--no-ratchet', '--rationale', 'read']);
  let gateSet = '';
  reopen(s.out, (ctx) => {
    gateSet = lockedGateSet(ctx, id) ?? '';
  });
  const envelope = ['--expected-gate-set', gateSet, '--roster', 'mock', '--max-usd-total', '40', '--max-usd-per-mission', '2', '--max-turns', '60',
    '--timeout', '600', '--max-attempts', '3', '--concurrency', '2', '--auto-apply', 'integration-ref', '--fix-lane', '2:1', '--tickets', 'C1,A1',
    '--review-roster', 'mock,mock', '--not-after', '24h'];
  confirmsAct('authorize-campaign', s.out, ['authorize-campaign', id, ...envelope], ['campaign', 'authorize', id, ...envelope, '--rationale', 'go']);
  confirmsAct('record-assumption', s.out, ['record-assumption', id, '--question', 'Which locale?', '--default', 'en', '--ticket', 'C1'],
    ['assumption', 'record', id, '--question', 'Which locale?', '--default', 'en', '--ticket', 'C1', '--rationale', 'r']);
  confirmsAct('confirm-assumption', s.out, ['confirm-assumption', o2], ['assumption', 'confirm', o2, '--rationale', 'fine']);
  confirmsAct('decide-assumption', s.out, ['decide-assumption', o1, '--value=an error'], ['assumption', 'decide', o1, '--value=an error', '--rationale', 'decided']);
  let recorded = '';
  reopen(s.out, (ctx) => {
    recorded = ctx.store.assumptions(id).find((a) => a.question === 'Which locale?')?.id ?? '';
  });
  confirmsAct('overturn-assumption', s.out,
    ['overturn-assumption', recorded, '--value=fr', '--follow-up=Translate the output to French.', '--lane', 'CORE', '--scope', 'crates/core/src/'],
    ['assumption', 'overturn', recorded, '--value=fr', '--follow-up=Translate the output to French.', '--lane', 'CORE', '--scope', 'crates/core/src/', '--rationale', 'no']);

  let haltId = '';
  reopen(s.out, (ctx) => {
    const m = startTicketMission(ctx, { campaignId: id, ticketId: 'C1', base: s.commit });
    ctx.events.append({ projectId: m.projectId, missionId: m.id, actorId: 'daylight', category: 'process', name: 'forge.author.refused', payload: { why: ['no sandbox'] } });
    ctx.store.closeMission(m.id, 'inconclusive', 'refused at preflight: no sandbox');
    haltId = haltCampaign(ctx, id, HUMAN, 'operator').id;
  });
  confirmsAct('retry-ticket', s.out, ['retry-ticket', id, '--ticket', 'C1'], ['campaign', 'retry', id, 'C1', '--rationale', 'sandbox fixed']);
  const noTicket = cli(['confirm', 'retry-ticket', id, '--out', s.out]);
  check('confirm retry-ticket without --ticket is a usage error', noTicket.code === 2 && /--ticket is required/.test(noTicket.err), noTicket.err);
  confirmsAct('resume-campaign', s.out, ['resume-campaign', id, '--halt', haltId], ['campaign', 'resume', id, '--halt', haltId, '--rationale', 'go on']);

  // A tip moved outside the director, and the halt it caused.
  ensureIntegrationRef(s.root, id, s.commit);
  git(s.root, 'update-ref', integrationRefFor(id), git(s.root, 'commit-tree', `${s.commit}^{tree}`, '-p', s.commit, '-m', 'by hand'));
  reopen(s.out, (ctx) => {
    haltId = haltCampaign(ctx, id, HUMAN, 'integration-moved').id;
  });
  const moved = git(s.root, 'rev-parse', integrationRefFor(id));
  const halted = json<CampaignStatusReport>(cli(['campaign', 'status', id, s.root, '--out', s.out, '--format', 'json']));
  const need = halted?.needs.find((n) => n.kind === 'campaign-halted' && n.ref === haltId);
  check('the integration-moved halt\'s need carries the commit adopt-tip adopts, ref still the halt id', need?.commit === moved, JSON.stringify(halted?.needs));
  const viaMap = json<Confirmed>(cli(['confirm', 'adopt-integration-tip', id, '--halt', haltId, '--out', s.out, '--format', 'json']));
  const viaRepo = json<Confirmed>(cli(['confirm', 'adopt-integration-tip', id, '--halt', haltId, '--repo', s.root, '--out', s.out, '--format', 'json']));
  check('adopt-integration-tip reads the repo from --repo, else the out dir\'s map, to the same digest', !!viaMap && viaMap.digest === viaRepo?.digest);
  confirmsAct('adopt-integration-tip', s.out, ['adopt-integration-tip', id, '--halt', haltId, '--repo', s.root], ['campaign', 'adopt-tip', id, s.root, '--halt', haltId, '--rationale', 'reviewed']);

  // Moved again; this time a person restores the ref to the adopted commit with --to.
  git(s.root, 'update-ref', integrationRefFor(id), git(s.root, 'commit-tree', `${moved}^{tree}`, '-p', moved, '-m', 'by hand again'));
  reopen(s.out, (ctx) => {
    haltId = haltCampaign(ctx, id, HUMAN, 'integration-moved').id;
  });
  const without = json<Confirmed>(cli(['confirm', 'adopt-integration-tip', id, '--halt', haltId, '--out', s.out, '--format', 'json']));
  const withTo = json<Confirmed>(cli(['confirm', 'adopt-integration-tip', id, '--halt', haltId, '--to', moved, '--out', s.out, '--format', 'json']));
  check('--to changes the adopt-integration-tip digest', !!without && !!withTo && without.digest !== withTo.digest && withTo.lines[0].includes(moved), JSON.stringify(withTo?.lines));
  confirmsAct('adopt-integration-tip --to', s.out, ['adopt-integration-tip', id, '--halt', haltId, '--to', moved],
    ['campaign', 'adopt-tip', id, s.root, '--halt', haltId, '--to', moved, '--rationale', 'restored']);
  check('and the act put the ref back on the named commit', git(s.root, 'rev-parse', integrationRefFor(id)) === moved);
}


// ---- a campaign with landings, a wave, findings, unknown spend and a forgery-shaped candidate ----

const HOLDOUT_BASENAME = 'secret_holdout_probe.test.js';
const FORGED_TEXT = 'FORGED-OUTPUT-MARKER-7c1e';
const STATEMENT_MARKER = 'STATEMENT-MARKER-91ab';

function reportWorld(name: string) {
  const root = path.join(tmp, name);
  const files: Record<string, string> = {
    'src/api/a.ts': 'export const a = 1;\n', 'src/api/b.ts': 'export const b = 2;\n',
    'src/ui/u.ts': 'export const u = 3;\n', 'src/ui/v.ts': 'export const v = 4;\n',
  };
  const plan: PlanFileV1 = {
    kind: 'daylight-plan', version: 1, title: `Report fixture (${HOLDOUT_BASENAME})`, campaignGates: [],
    lanes: [{ id: 'API', title: 'api', owns: ['src/api/'] }, { id: 'UI', title: 'ui', owns: ['src/ui/'] }],
    ownerDecisions: [
      { id: 'O1', question: `Blocking question about ${HOLDOUT_BASENAME}?`, options: ['error', 'panic'], blocking: true },
      { id: 'O2', question: 'Width?', blocking: false, default: `u64 unless ${HOLDOUT_BASENAME}` },
    ],
    tickets: [
      { id: 'A1', lane: 'API', title: 'First api change', statement: 'a', scope: ['src/api/a.ts', 'src/api/logo.bin'] },
      { id: 'A2', lane: 'API', title: `Second api change near ${HOLDOUT_BASENAME}`, statement: 'b', dependsOn: ['A1'], scope: ['src/api/b.ts'], blocksOn: ['O2'] },
      { id: 'U1', lane: 'UI', title: 'Waits on the owner', statement: 'u', scope: ['src/ui/u.ts'], blocksOn: ['O1'] },
      { id: 'U2', lane: 'UI', title: 'Spends unknown', statement: 'v', scope: ['src/ui/v.ts'] },
    ],
  };
  for (const [rel, text] of Object.entries({ ...files, 'daylight.plan.json': `${JSON.stringify(plan, null, 2)}\n` })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const base = git(root, 'rev-parse', 'HEAD');
  const out = path.join(tmp, `${name}-out`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'view.json'), JSON.stringify({ root }));
  const ctx = openDaylight(out);
  const id = importPlan(ctx, root, 'daylight.plan.json').campaign.id;
  approve(ctx, id);
  const gctx = { store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: root, out, env: CLEAN_ENV };
  const holdout = registerCampaignGate(gctx, {
    campaignId: id, role: 'holdout', ticketId: null, testSource: "require('node:test')('h', () => {});\n", basename: HOLDOUT_BASENAME,
    prediction: { exitCode: 0, stdoutIncludes: ['# fail 0'] },
  });
  lock(ctx, id);
  authorize(ctx, id, { tickets: ['A1', 'A2', 'U1', 'U2'] });
  const deps = fakeDeps();
  const ictx = { store: ctx.store, events: ctx.events, artifacts: ctx.artifacts, repoRoot: root };
  ensureIntegrationRef(root, id, base);
  const land = (ticketId: string, changes: Record<string, string | null>) => {
    const tip = integrationTip(root, id) ?? base;
    const m = startTicketMission(ctx, { campaignId: id, ticketId, base: tip });
    const side = commitOn(root, tip, changes);
    const c = makeCandidate(ctx, m, tip, diffOf(root, tip, side), filesOf(changes), lockedGateSet(ctx, id));
    const i = prepareIntegration(ictx, c.id, { ticketId, deps });
    landCandidate(ictx, accept(ctx, i).id, { ticketId, deps });
    return ctx.store.integration(i.id)!;
  };
  return { root, out, base, ctx, id, holdout, land, plan };
}

/** `git diff --numstat` read independently of the report. */
const numstat = (repo: string, a: string, b: string) => {
  const rows = git(repo, 'diff', '--numstat', '--no-renames', a, b).split('\n').filter(Boolean).map((l) => l.split('\t'));
  return {
    files: rows.length,
    insertions: rows.filter((r) => r[0] !== '-').reduce((n, r) => n + Number(r[0]), 0),
    deletions: rows.filter((r) => r[1] !== '-').reduce((n, r) => n + Number(r[1]), 0),
    binary: rows.filter((r) => r[0] === '-').length,
  };
};

section('the wave report: landings, spend, holdouts, the STATUS table, forgery shapes');
{
  const w = reportWorld('report');
  const { ctx, id, root } = w;
  const before = repoState(root);
  const i1 = w.land('A1', { 'src/api/a.ts': 'export const a = 10;\nexport const a2 = 11;\n', 'src/api/logo.bin': 'PNG\u0000\u0001\u0002binary' });
  const i2 = w.land('A2', { 'src/api/b.ts': 'export const b = 20;\n' });
  const ticketOf = (missionId: string) => ctx.store.campaignTickets(id).find((t) => t.workItemId === ctx.store.mission(missionId)?.workItemId)!.ticketId;
  const wave = closeWave(ctx, id, { ticketOf })!;

  // The wave's review: one reviewer attempt, a corroborated High and a Medium.
  const c = ctx.store.mission(id)!;
  const review = ctx.store.createMission({ projectId: c.projectId, kind: 'audit', objective: 'wave 1 review', baseRevision: wave.toCommit, parentId: id, scope: { paths: [] } });
  ctx.store.setWaveReview(id, wave.seq, review.id);
  const rt = ctx.store.createTask({ missionId: review.id, role: 'review', objective: 'review' });
  const ra = ctx.store.startAttempt({ taskId: rt.id, runnerId: 'agent:mock:review' });
  ctx.store.finishAttempt(ra.id, { state: 'completed', costUsd: 0.02, costSource: 'provider' });
  const finding = (severity: 'high' | 'medium' | 'low', p: string, title: string) => ctx.store.recordFinding({
    id: newId('finding'), projectId: c.projectId, campaignId: id, waveSeq: 1, reviewMissionId: review.id, attemptId: ra.id, path: p, severity, title,
    statement: `${STATEMENT_MARKER} ${title}`, findingArtifact: ctx.artifacts.put(`${title}\n`, { kind: 'summary', projectId: c.projectId, label: 'finding' }),
  });
  const high = finding('high', 'src/api/a.ts', 'a2 is `unchecked` | wrong');
  const other = finding('high', 'src/api/a.ts', 'a2 is `unchecked` | wrong (second reviewer)');
  ctx.store.updateFinding(high.id, { corroboratedBy: [other.id] });
  finding('medium', 'src/api/b.ts', 'b could be clearer');
  // A reviewer (agent-authored text) names the holdout in a path, a title and a statement.
  finding('low', `src/api/${HOLDOUT_BASENAME}`, `compare with ${HOLDOUT_BASENAME}`);
  fixTicketsFrom(ctx, id, 1, r5Host(ctx));

  // U2: an attempt that reported no cost, then one read by stdout scan whose candidate tripped the forgery heuristic.
  const tip = integrationTip(root, id)!;
  const u2 = startTicketMission(ctx, { campaignId: id, ticketId: 'U2', base: tip });
  const grant = ctx.store.authorizeDecision(u2.id)!;
  const sandbox = { profile: 'author' as const, network: 'none' as const, write: true, exec: false, authorizeDecisionId: grant.id };
  const t1 = ctx.store.createTask({ missionId: u2.id, role: 'author', objective: 'author', runnerHint: 'mock:0' });
  const a1 = ctx.store.startAttempt({ taskId: t1.id, runnerId: 'agent:mock:default', sandbox });
  ctx.store.finishAttempt(a1.id, { state: 'completed', costUsd: null });
  const t2 = ctx.store.createTask({ missionId: u2.id, role: 'author', objective: 'author', runnerHint: 'mock:1' });
  const a2 = ctx.store.startAttempt({ taskId: t2.id, runnerId: 'agent:mock:default', sandbox });
  ctx.store.finishAttempt(a2.id, { state: 'completed', costUsd: 0.3, costSource: 'stdout-scan' });
  // An attempt cut short with no figure is charged at its reservation (P2-R44).
  const t3 = ctx.store.createTask({ missionId: u2.id, role: 'author', objective: 'author', runnerHint: 'mock:2' });
  const a3 = ctx.store.startAttempt({ taskId: t3.id, runnerId: 'agent:mock:default', sandbox, maxCostUsd: 0.5 });
  ctx.store.finishAttempt(a3.id, { state: 'failed', costUsd: null });
  const forgedDiff = Buffer.from(`+process.stdout.write("${FORGED_TEXT} # pass 1 # fail 0");\n`);
  const forged = ctx.store.createCandidate({
    missionId: u2.id, attemptId: a2.id, projectId: c.projectId, baseCommit: tip,
    diffArtifact: ctx.artifacts.put(forgedDiff, { kind: 'diff', projectId: c.projectId, revision: tip, label: 'candidate diff' }),
    // The shape names capture records in the summary flags (R13): constants, never the matched text.
    summaryArtifact: ctx.artifacts.put(JSON.stringify({ flags: [
      { path: 'src/ui/v.ts', forgeryShapes: ['process.stdout.write( with a test summary', 'process.exit(0) outside a function'] },
      { path: 'src/ui/elsewhere.ts', possibleSecretHits: 1 },
      { path: `src/ui/${HOLDOUT_BASENAME}`, forgeryShapes: ['TAP version'] },
    ] }), { kind: 'summary', projectId: c.projectId, revision: tip, label: 'summary' }),
    files: filesOf({ 'src/ui/v.ts': 'x' }),
    policyViolations: [],
    secretHits: 0, gateSetDigest: lockedGateSet(ctx, id)!, profile: { name: 'author', network: 'none', write: true, exec: false }, attemptState: 'completed',
  });

  const r = buildWaveReport(ctx, id, root);
  const md = renderWaveReport(r);
  const text = JSON.stringify(r);

  check('the default scope is the latest closed wave', r.scope.kind === 'wave' && r.scope.seq === 1 && r.range.from === w.base && r.range.to === i2.integratedCommit);
  check('landings of wave 1 are exactly its integrations, in order', r.landed.map((l) => l.integrationId).join() === [i1.id, i2.id].join(), JSON.stringify(r.landed.map((l) => l.ticketId)));
  check('each landing\'s diff is git\'s numstat of onto..commit, the binary file counted',
    r.landed.every((l) => JSON.stringify(l.diff) === JSON.stringify(numstat(root, l.onto, l.commit))) && r.landed[0].diff.binary === 1, JSON.stringify(r.landed.map((l) => [l.diff, numstat(root, l.onto, l.commit)])));
  check('the range diff is git\'s numstat of from..to', JSON.stringify(r.diff) === JSON.stringify(numstat(root, r.range.from, r.range.to)));
  check('a landing carries its work item title and acceptance kind', r.landed[0].title === 'First api change' && r.landed[0].acceptance === 'ci-only');

  const all = buildWaveReport(ctx, id, root, { scope: { kind: 'all' } });
  const open = buildWaveReport(ctx, id, root, { scope: { kind: 'open' } });
  check('--all covers base..tip and every wave\'s review', all.range.from === w.base && all.range.to === integrationTip(root, id) && all.review.length === 1);
  check('--open covers the landings after the last wave (none yet)', open.range.from === wave.toCommit && open.landed.length === 0);

  const sum = (ls: SpendLine[], k: keyof SpendLine) => Math.round(ls.reduce((n, l) => n + (l[k] as number), 0) * 1e6) / 1e6;
  const closing = [...r.spend.lanes, ...r.spend.reviews];
  const camp = campaignSpend(ctx, id);
  check('Σ lanes + Σ reviews = campaignSpend, field by field',
    (['spentUsd', 'knownUsd', 'unknownCount', 'scannedCount', 'runningCount'] as const).every((k) => sum(closing, k) === camp[k]),
    JSON.stringify({ lanes: closing.map((l) => [l.key, l.spentUsd, l.knownUsd, l.unknownCount]), camp }));
  check('the report\'s campaign spend is campaignSpend, unchanged', JSON.stringify(r.spend.campaign) === JSON.stringify(camp));
  const ui = r.spend.lanes.find((l) => l.key === 'UI')!;
  const u2line = r.spend.tickets.find((l) => l.key === 'U2')!;
  check('the attempt with no cost is one unknown on its ticket and its lane', u2line.unknownCount === 1 && ui.unknownCount === 1 && camp.unknownCount === 1);
  check('scanned dollars are never inside knownUsd, and are their own figure', u2line.knownUsd === 0 && u2line.scannedUsd === 0.3);
  check('a reservation charge is counted with its dollars, inside spentUsd, never known', u2line.reservationCount === 1 && u2line.reservationUsd === 0.5
    && u2line.spentUsd === 0.8 && camp.reservationUsd === 0.5 && sum(closing, 'reservationUsd') === camp.reservationUsd, JSON.stringify(u2line));
  check('a review line carries the review mission\'s spend', r.spend.reviews.some((l) => l.key === 'review:1' && l.knownUsd === 0.02));
  check('wave 1\'s line is its tickets\' missions', r.spend.waves.length === 1 && r.spend.waves[0].attempts === 2);
  const uiWords = md.split('\n').find((l) => l.startsWith('- lane UI:')) ?? '';
  check('a line with nothing known and something beside keeps the floor (L3)', uiWords.startsWith('- lane UI: ≥ unknown (1 attempt(s) reported no cost); '), uiWords);
  const campWords = md.split('\n').find((l) => l.startsWith('- campaign:')) ?? '';
  check('the campaign line leads with the ≥ total counted against the cap, the breakdown after (L4)',
    campWords.startsWith(`- campaign: ≥ $${camp.spentUsd.toFixed(2)} counted against the $${camp.capUsd.toFixed(2)} cap (≥ `) && !/running of \$/.test(campWords), campWords);
  check('markdown prints unknown spend as unknown, never $0.00, scanned and reserved beside', /unknown/.test(uiWords) && !/\$0\.00/.test(uiWords)
    && /scanned, not known/.test(uiWords) && /\$0\.50 charged at reservation for 1 unfinished/.test(uiWords), uiWords);
  check('spendWords: unknown alone, a floor with some known, a dash for nothing',
    spendWords({ ...u2line, reservationCount: 0, reservationUsd: 0, attempts: 1, unknownCount: 1, scannedCount: 0, scannedUsd: 0, spentUsd: 0 }) === 'unknown'
      && /^≥ \$0\.05 \(1 unknown\)$/.test(spendWords({ ...u2line, reservationCount: 0, reservationUsd: 0, attempts: 2, unknownCount: 1, scannedCount: 0, scannedUsd: 0, spentUsd: 0.05, knownUsd: 0.05 }))
      && spendWords({ ...u2line, reservationCount: 0, reservationUsd: 0, attempts: 0 }) === '—'
      && /^\$2\.00 charged at reservation for 1 unfinished$/.test(spendWords({ ...u2line, attempts: 1, unknownCount: 0, scannedCount: 0, scannedUsd: 0, spentUsd: 2, knownUsd: 0, reservationCount: 1, reservationUsd: 2 })));

  const holdoutPath = w.holdout.testArtifact.path ?? '';
  check('holdouts are counted: one locked, not run at the tip', r.holdouts.locked === 1 && r.holdouts.atTip['not-run'] === 1);
  check('a holdout named in free text is redacted in every echoed field (M2)', r.title === 'Report fixture ([holdout])'
    && r.landed.some((l) => l.title === 'Second api change near [holdout]') && r.assumptions.open.some((a) => a.question === 'Blocking question about [holdout]?')
    && r.findings.some((f) => f.path === 'src/api/[holdout]' && f.title === 'compare with [holdout]' && f.statement.includes('[holdout]'))
    && r.needs.some((n) => n.why.includes('[holdout]')) && r.forgeryShapes.items.some((i) => i.paths.includes('src/ui/[holdout]')),
  JSON.stringify({ title: r.title, needs: r.needs.map((n) => n.why) }).slice(0, 1500));
  for (const [what, s] of [['JSON', text], ['markdown', md]] as const) {
    check(`the ${what} names no holdout id, path or basename`, !s.includes(w.holdout.id) && !s.includes(HOLDOUT_BASENAME) && !s.includes(holdoutPath) && !s.includes('secret_holdout'));
  }

  const states = ticketStates(ctx, id, root, r5StatusHost(ctx));
  const expected = statusTable(states.values());
  check('the STATUS table is STATUS_BUCKET_OF over the ticket states', JSON.stringify(r.status) === JSON.stringify(expected)
    && [...states.values()].every((s) => r.status.rows.find((x) => x.lane === s.ticket.lane)!.tickets[STATUS_BUCKET_OF[s.status]].includes(s.ticket.ticketId)));
  check('its totals sum to the ticket count', STATUS_BUCKETS.reduce((n, b) => n + r.status.totals[b], 0) === states.size, JSON.stringify(r.status.totals));
  check('landed tickets are done, the owner-held one is a request', r.status.totals.done >= 2 && r.status.rows.find((x) => x.lane === 'UI')!.tickets.requests.includes('U1'));

  const o1 = r.assumptions.open.find((a) => a.ownerDecisionId === 'O1');
  const o2 = r.assumptions.pending.find((a) => a.ownerDecisionId === 'O2');
  check('an open assumption carries its held tickets', !!o1 && o1.blocking && o1.heldTickets.join() === 'U1' && o1.landedOnIt.length === 0, JSON.stringify(o1));
  check('a pending one carries its default and what landed on it', !!o2 && o2.default === 'u64 unless [holdout]' && o2.landedOnIt.join() === 'A2', JSON.stringify(o2));
  const hf = r.findings.find((f) => f.id === high.id);
  check('findings are most severe first and carry the fix ticket, its status and who admitted it',
    r.findings[0].severity === 'high' && !!hf?.fixTicketId && hf.fixAdmission === 'derived' && hf.fixStatus !== 'none' && hf.corroboratedBy.join() === other.id, JSON.stringify(hf));
  const med = r.findings.find((f) => f.severity === 'medium');
  check('a medium finding\'s fix waits for a person', med?.fixAdmission === 'none', JSON.stringify(med));
  const fixRows = ctx.store.campaignTickets(id).filter((t) => t.origin === 'fix');
  const derivedAdmissions = fixRows.filter((t) => ctx.store.admission(id, t.workItemId)?.actor.startsWith('campaign:')).length;
  check('the fix lane counts filed, admitted by the envelope and waiting, as the rows say',
    fixRows.length >= 2 && r.fixLane.filed === fixRows.length && r.fixLane.admittedDerived === derivedAdmissions && derivedAdmissions >= 1
      && r.fixLane.approvedByPerson === 0 && r.fixLane.waiting === fixRows.length && r.fixLane.landed === 0, JSON.stringify(r.fixLane));
  check('the review is done with one reviewer and the counts', r.review[0].state === 'done' && r.review[0].reviewers === 1 && r.review[0].findings.high === 2);
  check('markdown shows a finding as severity · path · title (reviewer-claimed), its text escaped, never its statement',
    md.includes('high · src/api/a.ts · a2 is \\`unchecked\\` \\| wrong (reviewer-claimed)') && !md.includes(STATEMENT_MARKER), md.split('\n').filter((l) => l.includes('reviewer-claimed')).join('\n'));
  check('the JSON keeps the statement, redacted as stored', text.includes(STATEMENT_MARKER));

  const u1 = r.blocked.find((b) => b.ticketId === 'U1');
  check('a ticket held by an open owner decision is blocked with act owner-decision, its reason verbatim',
    u1?.status === 'waiting-owner' && u1.act === 'owner-decision' && u1.reason === states.get('U1')!.reason, JSON.stringify(r.blocked));

  const fsh = r.forgeryShapes;
  check('the forgery-shaped candidate is counted, by ticket, path and class, as a heuristic',
    fsh.heuristic && fsh.candidates === 1 && fsh.items[0].ticketId === 'U2' && fsh.items[0].candidateId === forged.id && fsh.items[0].paths.join() === 'src/ui/[holdout],src/ui/v.ts'
      && fsh.items[0].classes.join() === 'process-exit,stdout-fd-write,test-summary-literal' && fsh.byClass['stdout-fd-write'] === 1 && !fsh.items[0].ticketLanded, JSON.stringify(fsh));
  check('a flag without shapes is not a forgery shape', !JSON.stringify(fsh).includes('elsewhere'));
  check('the report never carries the violating diff\'s text', !text.includes(FORGED_TEXT) && !md.includes(FORGED_TEXT));
  check('markdown names it a warning with its forgery-shape-review need', /Forgery-shaped candidates \(heuristic\)/.test(md) && md.includes('forgery-shape-review'));

  const again = buildWaveReport(ctx, id, root);
  check('the same rows print the same bytes, JSON and markdown', JSON.stringify(again) === text && renderWaveReport(again) === md);
  check('the target repository is untouched (HEAD, index, worktree, refs)', repoState(root) === before);

  section('run claims (§1.4)');
  check('no claim file: run is null', runClaimOf(w.out, id) === null && r.run === null);
  fs.writeFileSync(runClaimFile(w.out, id), String(process.pid));
  check('a claim by a live pid is a running claim', JSON.stringify(runClaimOf(w.out, id)) === JSON.stringify({ pid: process.pid, alive: true }));
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(runClaimFile(w.out, id), String(dead));
  check('a claim by a dead pid is a claim left behind', JSON.stringify(runClaimOf(w.out, id)) === JSON.stringify({ pid: dead, alive: false }));
  fs.writeFileSync(runClaimFile(w.out, id), '0');
  check('a pid of 0 is never signalled: a dead claim', runClaimOf(w.out, id)?.alive === false);
  fs.rmSync(runClaimFile(w.out, id));

  section('campaign list');
  const list = campaignList(ctx);
  const row = list.campaigns.find((x) => x.id === id)!;
  check('the list has the campaign with its plan, buckets, spend and run hint',
    list.kind === 'daylight-campaign-list' && row.title === 'Report fixture ([holdout])' && row.planApproved && row.tickets === ctx.store.campaignTickets(id).length
      && JSON.stringify(row.byBucket) === JSON.stringify(r.status.totals) && JSON.stringify(row.spend) === JSON.stringify(camp)
      && row.runHint === `daylight campaign run ${id} ${root} --out ${w.out}` && row.unavailable === null && row.run === null, JSON.stringify(row));
  ctx.close();

  section('the CLI: report, list, refine run in an agent session; report --write does not');
  const status = json<CampaignStatusReport>(cli(['campaign', 'status', id, root, '--out', w.out, '--format', 'json']));
  check('campaign status --format json carries the same STATUS table and a run claim', JSON.stringify(status?.table) === JSON.stringify(r.status) && status?.run === null);
  const cand = json<{ forgeryShapes?: CandidateForgeryShapes }>(cli(['forge', 'candidate', forged.id, '--out', w.out, '--format', 'json']));
  check('forge candidate --format json carries the forgery shapes by class and path',
    JSON.stringify(cand?.forgeryShapes?.items) === JSON.stringify([
      { path: `src/ui/${HOLDOUT_BASENAME}`, classes: ['test-summary-literal'] }, { path: 'src/ui/v.ts', classes: ['process-exit', 'stdout-fd-write', 'test-summary-literal'] }])
      && cand?.forgeryShapes?.byClass['test-summary-literal'] === 2, JSON.stringify(cand?.forgeryShapes));
  for (const op of ['approve-candidate', 'override-candidate']) {
    const pv = json<{ forgeryShapes?: CandidateForgeryShapes }>(cli(['confirm', op, forged.id, '--out', w.out, '--format', 'json']));
    check(`confirm ${op} carries them too`, JSON.stringify(pv?.forgeryShapes) === JSON.stringify(cand?.forgeryShapes), JSON.stringify(pv));
  }
  const clean = json<{ forgeryShapes?: CandidateForgeryShapes }>(cli(['forge', 'candidate', r.landed[0].candidateId, '--out', w.out, '--format', 'json']));
  check('a candidate without shapes has none', clean?.forgeryShapes?.items.length === 0);
  for (const v of ['CLAUDECODE', 'DAYLIGHT_SESSION']) {
    const rep = cli(['campaign', 'report', id, root, '--out', w.out, '--format', 'json'], { [v]: '1' });
    check(`${v}: campaign report runs, exit 0, the same report`, rep.code === 0 && json<WaveReport>(rep)?.landed.length === 2, `${rep.code} ${rep.err}`);
    const md2 = cli(['campaign', 'report', id, root, '--out', w.out], { [v]: '1' });
    check(`${v}: campaign report prints the markdown`, md2.code === 0 && md2.out === md, md2.err);
    const lst = cli(['campaign', 'list', '--out', w.out, '--format', 'json'], { [v]: '1' });
    check(`${v}: campaign list runs`, lst.code === 0 && json<ForgeCampaignList>(lst)?.campaigns.some((x) => x.id === id) === true, lst.err);
    const ref = cli(['campaign', 'refine', id, root, '--rows-only', '--out', w.out, '--format', 'json'], { [v]: '1' });
    check(`${v}: campaign refine --rows-only runs`, ref.code === 0 && json<{ kind: string }>(ref)?.kind === 'daylight-refine', `${ref.code} ${ref.err}`);
    const write = cli(['campaign', 'report', id, root, '--out', w.out, '--write'], { [v]: '1' });
    check(`${v}: campaign report --write is refused, exit 1, naming the variable`, write.code === 1 && write.err.includes(v) && !fs.existsSync(path.join(w.out, 'campaigns', id, 'reports')), write.err);
  }
  const written = cli(['campaign', 'report', id, root, '--out', w.out, '--write', '--all']);
  const reports = path.join(w.out, 'campaigns', id, 'reports');
  const tip12 = (integrationTip(root, id) ?? '').slice(0, 12);
  check('report --write writes the json and md under <out>/campaigns/<c>/reports only', written.code === 0
    && fs.readdirSync(reports).sort().join() === [`all-${tip12}.json`, `all-${tip12}.md`].join(), `${written.code} ${written.err} ${fs.existsSync(reports) ? fs.readdirSync(reports) : ''}`);
  check('and what it wrote is what it printed', fs.readFileSync(path.join(reports, `all-${tip12}.md`), 'utf8') === written.out);
  check('the repository is still untouched', repoState(root) === before);
  const wave1 = cli(['campaign', 'report', id, root, '--out', w.out, '--wave', '1', '--write']);
  check('--wave 1 --write names its file wave-1', wave1.code === 0 && fs.existsSync(path.join(reports, 'wave-1.json')), wave1.err);
  check('an unknown wave exits 1', cli(['campaign', 'report', id, root, '--out', w.out, '--wave', '9']).code === 1);
  check('two scopes are a usage error, exit 2', cli(['campaign', 'report', id, root, '--out', w.out, '--wave', '1', '--all']).code === 2);
  check('an unknown campaign exits 1', cli(['campaign', 'report', 'm_00000000000000000000000000000000', root, '--out', w.out]).code === 1);
  check('report with no campaign is a usage error, exit 2', cli(['campaign', 'report', '--out', w.out]).code === 2);
  const empty = path.join(tmp, 'report-empty-out');
  const none = cli(['campaign', 'list', '--out', empty]);
  check('an out dir with no database is an error, never created', none.code === 1 && !fs.existsSync(empty), none.err);
  const derived = cli(['campaign', 'list', root]);
  const expectedOut = (() => {
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmp;
    try {
      return path.join(defaultOutFor(root));
    } finally {
      process.env.XDG_DATA_HOME = prev;
    }
  })();
  check('without --out, the out dir derives from <repo>', derived.code === 1 && derived.err.includes(expectedOut), `${derived.err} vs ${expectedOut}`);
  const show = json<ForgeCampaignShow>(cli(['campaign', 'show', id, '--out', w.out, '--format', 'json']));
  check('campaign show carries the envelope, the lock as counts, lane ownership and ticket titles',
    !!show && show.envelope?.ticketIds.join() === 'A1,A2,U1,U2' && show.lock?.holdouts === 1 && show.lock.gates === 0 && show.lock.gateSetDigest.startsWith('sha256:')
      && show.lanes.find((l) => l.id === 'API')?.owns.join() === 'src/api/' && show.lanes.every((l) => l.maxParallel === 1)
      && show.tickets.find((t) => t.ticketId === 'A1')?.title === 'First api change', JSON.stringify(show?.lock));
  // show echoes the person's own plan text; it never carries a holdout id or registered path.
  check('and names no holdout id or path', !JSON.stringify(show).includes(w.holdout.id) && !JSON.stringify(show).includes(w.holdout.testArtifact.path!));
  const rows = json<ForgeAssumptionRow[]>(cli(['assumption', 'list', id, '--out', w.out, '--format', 'json']));
  const r1 = rows?.find((a) => a.ownerDecisionId === 'O1');
  check('assumption list rows carry held tickets and the plan\'s options', r1?.heldTickets.join() === 'U1' && r1.options.join() === 'error,panic'
    && rows?.find((a) => a.ownerDecisionId === 'O2')?.options.length === 0, JSON.stringify(r1));
  const haltCtx = openDaylight(w.out);
  const halt = haltCampaign(haltCtx, id, HUMAN, 'operator');
  haltCtx.close();
  const halted = json<CampaignStatusReport>(cli(['campaign', 'status', id, root, '--out', w.out, '--format', 'json']));
  const listed = json<ForgeCampaignList>(cli(['campaign', 'list', '--out', w.out, '--format', 'json']))?.campaigns.find((x) => x.id === id);
  check('status and list name the unanswered halt for resume and adopt-tip', halted?.authorization.haltDecisionId === halt.id && halted.authorization.halted === 'operator'
    && listed?.authorization.haltDecisionId === halt.id, JSON.stringify([halted?.authorization, listed?.authorization]));
  check('the read-only set gains list, report without --write and refine',
    campaignReadOnly('list') && campaignReadOnly('report') && campaignReadOnly('refine')
      && !campaignReadOnly('report', { positionals: [], flags: new Map([['write', 'true']]) }));
}

done();
