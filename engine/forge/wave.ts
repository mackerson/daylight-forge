import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SandboxProfile } from '../experiment/sandbox.ts';
import { createWaveReviewServer } from '../mcp/server.ts';
import type { DaylightContext } from '../mission/context.ts';
import { roleAllowlist, runMission } from '../mission/orchestrate.ts';
import type { Attempt, CampaignTicket, CampaignWave, Finding, Integration, Mission } from '../mission/types.ts';
import { FINDING_SEVERITIES } from '../mission/types.ts';
import { gitIn } from './apply.ts';
import type { CampaignHost } from './director.ts';
import {
  findingIdOf, findingOutboxFile, isFindingRefusal, MAX_FINDING_BYTES, MAX_FINDINGS_PER_ATTEMPT, redactFinding, validateFinding,
  type FindingOutboxLine,
} from './finding.ts';
import { holdoutPaths } from './campaign-gates.ts';
import { createWorkspace } from './workspace.ts';

/**
 * Waves and the fix lane (§6, ADR-39).
 *
 * A wave closes every `waveSize` landings, or at quiescence with at least one since the last.
 * Its review is an `audit` mission under the campaign: one blind reviewer per `reviewRoster`
 * entry, under the `review` profile, over a materialised tree of the wave's last commit (not
 * the checkout), with one tool, `report_finding`, that reads nothing back. Findings are
 * re-validated and redacted on the host, then each becomes a proposed fix ticket; only a High
 * finding is admitted by the envelope, at most five per wave (P2-R10), through WS-R5.
 *
 * ADR-19 holds: a finding never touches a verdict or a landed commit. It only creates work
 * that must pass the same gates. A reviewer's text reaches an author fenced, redacted and capped.
 * With `reviewRoster: []` nothing here runs and every other part of the campaign still does.
 */

const landingsSince = (ctx: Pick<DaylightContext, 'store'>, campaignId: string): Integration[] => {
  const landed = ctx.store.integrations(campaignId, { state: 'integrated' }).sort((a, b) => a.updatedAt - b.updatedAt);
  const last = ctx.store.waves(campaignId).at(-1);
  if (!last) return landed;
  const at = landed.findIndex((i) => i.integratedCommit === last.toCommit);
  return at < 0 ? [] : landed.slice(at + 1);
};

/** Whether `waveSize` landings have happened since the last wave closed, and how many have. */
export function waveDue(ctx: Pick<DaylightContext, 'store'>, campaignId: string, waveSize: number): { due: boolean; landed: number } {
  const n = landingsSince(ctx, campaignId).length;
  return { due: n >= Math.max(1, waveSize), landed: n };
}

/** Record the next wave over every landing since the last, or null when there is none. */
export function closeWave(ctx: Pick<DaylightContext, 'store'>, campaignId: string, o: { ticketOf: (missionId: string) => string }): CampaignWave | null {
  const landed = landingsSince(ctx, campaignId);
  if (!landed.length) return null;
  const campaign = ctx.store.mission(campaignId)!;
  const last = ctx.store.waves(campaignId).at(-1);
  return ctx.store.recordWave({
    campaignId, seq: (last?.seq ?? 0) + 1, fromCommit: last?.toCommit ?? campaign.baseRevision, toCommit: landed.at(-1)!.integratedCommit!,
    ticketIds: landed.map((i) => o.ticketOf(i.missionId)),
  });
}

/** The prompt every wave reviewer gets: the same for each, naming the changed files and nothing anyone found. */
export function buildWaveReviewPrompt(w: CampaignWave, files: readonly string[]): string {
  return [
    `You are reviewing wave ${w.seq} of a campaign: the changes from ${w.fromCommit.slice(0, 12)} to ${w.toCommit.slice(0, 12)},`,
    'checked out read-only in your working directory. Read the changed files with your file tools.',
    '',
    'Report each real problem with the report_finding tool on the "daylight" MCP server: a bug, a security hole, a broken',
    'contract, a missing case. Rate it high only for wrong behaviour, a security hole or data loss. Do not report style.',
    'Other reviewers look at the same files; you cannot see what they report, and they cannot see yours.',
    '',
    'Files this wave changed:',
    ...files.map((f) => `  ${f}`),
  ].join('\n');
}

/** Files `from..to` changed, by name; read from git objects. */
function changedFiles(repo: string, from: string, to: string): string[] {
  return gitIn({ repo }, ['diff', '--name-only', '--no-renames', '-z', from, to, '--']).toString('utf8').split('\0').filter(Boolean).sort();
}

export interface WaveReviewOptions {
  repo: string;
  roster: string[];
  sandbox?: SandboxProfile;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The campaign's reservation for the whole review: the audit mission's budget, shared by its reviewers (P2-R35). */
  reserveUsd?: number;
}

/**
 * Run wave `seq`'s review: an audit mission over the wave's files at its last commit, one blind
 * reviewer per roster entry, findings ingested. Its spend is a child mission's, so it counts
 * against the campaign cap.
 */
export async function runWaveReview(ctx: DaylightContext, campaignId: string, seq: number, o: WaveReviewOptions): Promise<{ reviewMission: Mission; findings: Finding[] }> {
  const campaign = ctx.store.mission(campaignId);
  if (!campaign || campaign.kind !== 'campaign') throw new Error(`${campaignId} is not a campaign`);
  const w = ctx.store.waves(campaignId).find((x) => x.seq === seq);
  if (!w) throw new Error(`campaign ${campaignId} has no wave ${seq}`);
  const files = changedFiles(o.repo, w.fromCommit, w.toCommit);
  let review = w.reviewMissionId ? ctx.store.mission(w.reviewMissionId)! : null;
  if (!review) {
    review = ctx.store.createMission({
      projectId: campaign.projectId, kind: 'audit', parentId: campaign.id, baseRevision: w.toCommit, scope: { paths: files },
      ...(o.reserveUsd !== undefined ? { budget: { maxUsd: o.reserveUsd } } : {}),
      objective: `wave ${seq} review of campaign ${campaign.id}: ${w.fromCommit.slice(0, 12)}..${w.toCommit.slice(0, 12)}`,
    });
    review = ctx.store.transitionMission(review.id, 'ready');
    ctx.store.setWaveReview(campaignId, seq, review.id);
  }
  if (review.state === 'closed') return { reviewMission: review, findings: ctx.store.findings(campaignId, { waveSeq: seq }) };
  const tree = createWorkspace(o.repo, w.toCommit, { hidden: holdoutPaths(ctx, campaignId) });
  try {
    const serve = (attempt: Attempt): McpServer => createWaveReviewServer({ dir: ctx.out, attemptId: attempt.id, paths: files }).server;
    await runMission(ctx, {
      missionId: review.id, repo: o.repo, tools: o.roster, role: 'review', prompt: buildWaveReviewPrompt(w, files), sandbox: o.sandbox,
      tree: tree.tree, reviewServer: { serve, allowedTools: roleAllowlist('waveReview') }, timeoutMs: o.timeoutMs,
      // All reviewers at once, each reserving its share of the review's budget.
      concurrency: o.roster.length,
      ...(o.reserveUsd !== undefined ? { maxCost: o.reserveUsd, raiseBudget: true, reserve: true } : {}),
    });
  } finally {
    tree.dispose();
  }
  const findings = ingestFindings(ctx, review.id);
  const now = ctx.store.mission(review.id)!;
  if (now.state === 'running') ctx.store.closeMission(now.id, 'succeeded', `${findings.length} finding(s) filed by ${o.roster.length} blind reviewer(s)`);
  return { reviewMission: ctx.store.mission(review.id)!, findings };
}

/** Read one outbox without following a link, bounded. */
function readFindingOutbox(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc((MAX_FINDINGS_PER_ATTEMPT + 1) * (MAX_FINDING_BYTES + 64));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Every finding the review's attempts filed, checked again on the host against the wave's files
 * (the outbox is same-uid writable), redacted, recorded once each, and marked corroborated when
 * another reviewer filed the same path and title. Idempotent.
 */
export function ingestFindings(ctx: DaylightContext, reviewMissionId: string): Finding[] {
  const review = ctx.store.mission(reviewMissionId);
  if (!review || review.kind !== 'audit' || !review.parentId) throw new Error(`${reviewMissionId} is not a wave review`);
  const campaignId = review.parentId;
  const wave = ctx.store.waves(campaignId).find((w) => w.reviewMissionId === review.id);
  if (!wave) throw new Error(`${reviewMissionId} reviews no wave of ${campaignId}`);
  const paths = new Set(review.scope.paths ?? []);
  const attempts = ctx.store.tasks(review.id).filter((t) => t.role === 'review').flatMap((t) => ctx.store.attempts(t.id));
  for (const a of attempts) {
    const text = readFindingOutbox(findingOutboxFile(ctx.out, a.id));
    if (!text) continue;
    for (const line of text.split('\n').filter((l) => l.trim()).slice(0, MAX_FINDINGS_PER_ATTEMPT)) {
      if (Buffer.byteLength(line, 'utf8') > MAX_FINDING_BYTES) continue;
      let parsed: FindingOutboxLine;
      try {
        parsed = JSON.parse(line) as FindingOutboxLine;
      } catch {
        continue;
      }
      if (parsed?.v !== 1) continue;
      const valid = validateFinding(parsed.finding, { paths });
      if (isFindingRefusal(valid)) {
        ctx.events.append({
          projectId: review.projectId, missionId: review.id, attemptId: a.id, actorId: 'daylight', category: 'claim', name: 'campaign.finding.refused',
          payload: { field: valid.field, reason: valid.refused },
        });
        continue;
      }
      const f = redactFinding(valid);
      const id = findingIdOf(a.id, f);
      if (ctx.store.finding(id)) continue;
      const findingArtifact = ctx.artifacts.put(JSON.stringify(f), {
        kind: 'report', projectId: review.projectId, revision: wave.toCommit, path: f.path, label: 'wave finding (reviewer-claimed)', mediaType: 'application/json',
      });
      const row = ctx.store.recordFinding({
        id, projectId: review.projectId, campaignId, waveSeq: wave.seq, reviewMissionId: review.id, attemptId: a.id, ...f, findingArtifact,
      });
      ctx.events.append({
        projectId: review.projectId, missionId: campaignId, actorId: 'daylight', category: 'claim', name: 'campaign.finding.recorded',
        payload: { findingId: row.id, severity: row.severity, path: row.path },
      });
    }
  }
  const all = ctx.store.findings(campaignId, { waveSeq: wave.seq });
  for (const f of all) {
    const same = all.filter((g) => g.id !== f.id && g.attemptId !== f.attemptId && g.path === f.path && g.title.toLowerCase() === f.title.toLowerCase()).map((g) => g.id).sort();
    if (same.join(',') !== f.corroboratedBy.join(',')) ctx.store.updateFinding(f.id, { corroboratedBy: same });
  }
  return ctx.store.findings(campaignId, { waveSeq: wave.seq });
}

const rank = (s: Finding['severity']) => FINDING_SEVERITIES.indexOf(s);

/**
 * One proposed fix ticket per finding of wave `seq` (corroborated duplicates are one), most
 * severe first (§6.3), filed by WS-R5 (`fileFixTicket`, P2-R36). Each is offered to the
 * envelope; R5 admits a High one up to the wave's cap, and anything else waits for a person.
 */
export function fixTicketsFrom(ctx: Pick<DaylightContext, 'store'>, campaignId: string, seq: number, host: CampaignHost): { filed: CampaignTicket[]; admitted: string[] } {
  const findings = ctx.store.findings(campaignId, { waveSeq: seq })
    .sort((a, b) => rank(b.severity) - rank(a.severity) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const filed: CampaignTicket[] = [];
  const admitted: string[] = [];
  const done = new Set<string>();
  for (const f of findings) {
    if (f.fixTicketId || done.has(f.id)) continue;
    for (const g of f.corroboratedBy) done.add(g);
    const ticketId = host.fileFixTicket(campaignId, { waveSeq: seq, finding: f });
    const t = host.tickets(campaignId).find((x) => x.ticketId === ticketId);
    if (!t) throw new Error(`fix ticket ${ticketId} of finding ${f.id} was not filed`);
    ctx.store.updateFinding(f.id, { fixTicketId: t.ticketId });
    filed.push(t);
    // Every finding is offered; the envelope admits a High one only, at most its per-wave cap (P2-R10).
    if (host.admitIfWithinEnvelope(campaignId, t.workItemId, { seq, admitted: admitted.length, severity: f.severity, findingId: f.id }).admitted) admitted.push(t.ticketId);
  }
  return { filed, admitted };
}
