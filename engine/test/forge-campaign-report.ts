/**
 * Campaign reports, the campaign list and `confirm` for campaign acts (WS-R8, ADR-40).
 * Run: node engine/test/forge-campaign-report.ts
 *
 * What must hold: `daylight confirm` prints, for every campaign and assumption act, the digest
 * the act itself accepts, and says the act is refused in an agent session while still printing
 * it (P2-R40, P2-R45 D6). Mocks only: no model, no cargo, no bwrap.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { registerPlanGates } from '../forge/campaign-gates.ts';
import { haltCampaign, planOf, startTicketMission } from '../forge/campaign.ts';
import { ensureIntegrationRef, integrationRefFor } from '../forge/integrate.ts';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import {
  CLEAN_ENV, git, HUMAN, imported, lockedGateSet, ROOT, tmp,
} from './forge-campaign-fixture.ts';
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
  const viaMap = json<Confirmed>(cli(['confirm', 'adopt-integration-tip', id, '--halt', haltId, '--out', s.out, '--format', 'json']));
  const viaRepo = json<Confirmed>(cli(['confirm', 'adopt-integration-tip', id, '--halt', haltId, '--repo', s.root, '--out', s.out, '--format', 'json']));
  check('adopt-integration-tip reads the repo from --repo, else the out dir\'s map, to the same digest', !!viaMap && viaMap.digest === viaRepo?.digest);
  confirmsAct('adopt-integration-tip', s.out, ['adopt-integration-tip', id, '--halt', haltId, '--repo', s.root], ['campaign', 'adopt-tip', id, s.root, '--halt', haltId, '--rationale', 'reviewed']);
}

done();
