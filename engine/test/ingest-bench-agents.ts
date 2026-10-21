/**
 * The scripted agents and the scripted person for the ingestion benchmark's mock mode: what
 * `daylight ingest bench --extractor <this file>` loads, as `DAYLIGHT_MOCK_ADAPTER` names a mock
 * agent (P2-R57). Not a test itself; forge-ingest-benchmark.ts passes it.
 *
 * Extractor and reviewer: scripted runners calling the real outbox servers (lib/ingest-mocks.ts).
 * Person: every human act of the pipeline, made through the guarded functions with confirm codes
 * read off the previews, on the benchmark's throwaway store; the landing's derived decision is
 * written as R5's writer would, as the campaign tests do.
 */
import os from 'node:os';
import path from 'node:path';
import type { BenchAgents } from '../forge/ingest-bench.ts';
import type { BenchFixture } from '../forge/bench-fixture.ts';
import { approveIr } from '../forge/ir-review.ts';
import { approveBlueprint } from '../forge/blueprint.ts';
import { confirmIngest } from '../forge/commands-corpus-review.ts';
import { approvePlan } from '../forge/campaign.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { lockableIds, lockCampaign, registerCampaignGate, registerPlanGates } from '../forge/campaign-gates.ts';
import type { GateContext } from '../forge/gate.ts';
import { commitOn, diffOf, filesOf, git, makeCandidate, rawDecision } from './forge-campaign-run-fixture.ts';
import { scriptedExtractor, scriptedReviewer } from './lib/ingest-mocks.ts';

const HUMAN = `human:${(os.userInfo().username || 'bench').replace(/\s+/g, '_')}`;
/** Decisions are a person's, from a person's shell; the benchmark itself may run under an agent. */
const CLEAN_ENV: Record<string, string | undefined> = { PATH: process.env.PATH };
const code8 = (digest: string) => digest.slice('sha256:'.length, 'sha256:'.length + 8);

export default function agents(fixture: BenchFixture): BenchAgents {
  return {
    extract: scriptedExtractor({ records: fixture.overlay.records }, { variant: { mock: 'exact', 'mock:b': 'drop5' } }),
    review: (findings) => scriptedReviewer(findings),
    person: {
      approveIr: (ctx, set) => {
        approveIr(ctx, { corpusId: set.corpusId, actor: HUMAN, rationale: 'benchmark: scripted approve-ir set', env: CLEAN_ENV, set,
          confirm: code8(confirmIngest(ctx, 'approve-ir', set.corpusId, { set }).digest) });
      },
      approveBlueprint: (ctx, blueprintId) => {
        approveBlueprint(ctx, { blueprintId, actor: HUMAN, rationale: 'benchmark: fixture blueprint', env: CLEAN_ENV,
          confirm: code8(confirmIngest(ctx, 'approve-blueprint', blueprintId).digest) });
      },
      approvePlan: (ctx, campaignId) => {
        approvePlan(ctx, { campaignId, actor: HUMAN, rationale: 'benchmark: plan read', env: CLEAN_ENV, confirm: code8(confirmDigest(ctx, 'approve-plan', campaignId).digest) });
      },
      lock: (ctx, { root, campaignId, plan, holdoutPath }) => {
        const g: GateContext = { store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: root, out: ctx.out, env: CLEAN_ENV };
        registerPlanGates(g, campaignId, plan);
        registerCampaignGate(g, { campaignId, role: 'holdout', ticketId: null, testSource: 'test("holdout", () => {});\n', basename: path.basename(holdoutPath),
          prediction: { exitCode: 0 } });
        const c = ctx.store.mission(campaignId)!;
        // Baselines as rows, as forge-campaign-run-cli.ts records them: no sandbox here.
        for (const e of ctx.store.experimentsFor(campaignId)) {
          ctx.store.recordGateEvaluation({ missionId: c.id, projectId: c.projectId, revision: c.baseRevision, experimentId: e.id, target: 'base', diffDigest: null,
            harnessDigest: e.harnessDigest, executions: [], conclusion: 'falsified' });
        }
        const confirm = code8(confirmDigest(g, 'lock-campaign-gates', campaignId, { experimentIds: lockableIds(g, campaignId), ratchet: false }).digest);
        lockCampaign(g, { campaignId, actor: HUMAN, rationale: 'benchmark: gates read', ratchet: false, confirm, env: CLEAN_ENV });
      },
      land: (ctx, { root, campaignId, ticketId }) => {
        const store = ctx.store;
        const c = store.mission(campaignId)!;
        const t = store.campaignTicket(c.id, ticketId);
        if (!t) throw new Error(`no ticket ${ticketId} in the campaign`);
        const m = store.authorizeMission({ missionId: store.createMission({ projectId: c.projectId, kind: 'implement', objective: `ticket ${ticketId}`,
          baseRevision: c.baseRevision, parentId: c.id, workItemId: t.workItemId, scope: { paths: t.scope } }).id, actor: HUMAN, rationale: 'benchmark landing',
        permissions: { write: true, execute: false }, maxUsd: 1 }).mission;
        const rel = t.scope.find((s) => !s.endsWith('/')) ?? `${t.scope[0] ?? ''}landed.txt`;
        const change = { [rel]: `landed by the benchmark for ${ticketId}\n` };
        const tip = commitOn(root, c.baseRevision, change, `land ${ticketId}`);
        const cand = makeCandidate(ctx, m, c.baseRevision, diffOf(root, c.baseRevision, tip), filesOf(change));
        const i = store.recordIntegration({ campaignId: c.id, missionId: m.id, candidateId: cand.id, ref: `refs/heads/daylight/campaign/${c.id}`, onto: c.baseRevision,
          candidateBase: c.baseRevision });
        store.updateIntegration(i.id, 'pending', { state: 'evaluating', method: 'apply', integratedCommit: tip, integratedTree: git(root, ['rev-parse', `${tip}^{tree}`]),
          integratedDiffDigest: cand.diffArtifact.digest });
        const d = rawDecision(store, { missionId: c.id, projectId: c.projectId, revision: tip, actor: `campaign:${c.id}`, kind: 'approve', rationale: 'benchmark landing',
          scope: { operation: 'land-integration', integrationId: i.id }, artifactIds: [] });
        return store.updateIntegration(i.id, 'evaluating', { state: 'integrated', decisionId: d.id });
      },
    },
  };
}
