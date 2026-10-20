/**
 * Shared setup for the forge-campaign-* tests: a copy of fixtures/cargo-workspace with a plan,
 * committed and mapped, and the helpers that walk a campaign to an authorization by rows. Not a
 * test itself. Nothing here runs a model, cargo or bwrap; only git.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import type { Decision, PlanFileV1 } from '../mission/types.ts';
import { approvePlan, authorizeCampaign, buildEnvelope, importPlan, type EnvelopeFlags, type ImportedPlan } from '../forge/campaign.ts';
import { confirmDigest } from '../forge/confirm.ts';

export const HUMAN = `human:${os.userInfo().username.replace(/\s+/g, '_') || 'unknown'}`;
/** Decisions are made from a person's shell; these tests may themselves run under an agent. */
export const CLEAN_ENV: Record<string, string | undefined> = { PATH: process.env.PATH };
export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const GATE_SET = `sha256:${'a'.repeat(64)}`;

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-campaign-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
export const git = (root: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
  '-C', root, ...args,
], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export const throws = (fn: () => unknown): Error | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};

/** A plan for the cargo workspace: two lanes, four tickets, two owner decisions, one regression gate. */
export function samplePlan(): PlanFileV1 {
  return {
    kind: 'daylight-plan', version: 1, title: 'Widen the decimal API',
    campaignGates: [{ id: 'core-regress', role: 'regression', harness: 'cargo', crate: 'crates/core', path: 'crates/core/tests/regress.rs', expect: { exitCode: 0 } }],
    lanes: [
      { id: 'CORE', title: 'Core crate', owns: ['crates/core/src', 'crates/core/tests'] },
      { id: 'APP', title: 'App crate', owns: ['crates/app/src', 'crates/app/tests'] },
    ],
    ownerDecisions: [
      { id: 'O1', question: 'Is a negative input an error or a panic?', blocking: true },
      { id: 'O2', question: 'Which integer width?', blocking: false, default: 'u64' },
    ],
    tickets: [
      { id: 'C1', lane: 'CORE', title: 'Add signed decimal', statement: ['decimal_i64 formats a signed integer.', 'It never allocates twice.'],
        examples: ['decimal_i64(-7) == "-7"'], scope: ['crates/core/src/lib.rs'], budget: { maxUsd: 1.5 } },
      { id: 'C2', lane: 'CORE', title: 'Reject negatives on request', statement: 'A checked variant.', dependsOn: ['C1'], blocksOn: ['O1'],
        scope: ['crates/core/src/'] },
      { id: 'A1', lane: 'APP', title: 'Print a signed value', statement: 'main prints -7.', dependsOn: ['C1'], scope: ['crates/app/src/main.rs'],
        acceptance: { kind: 'gate', tests: [{ path: 'crates/app/tests/app_gate.rs', harness: 'cargo', crate: 'crates/app', expect: { exitCode: 0 } }] } },
      { id: 'A2', lane: 'APP', title: 'App tests', statement: 'The author writes its tests.', dependsOn: ['A1'], scope: ['crates/app/tests/'],
        acceptance: { kind: 'writer-authored', harness: 'cargo', crate: 'crates/app', testPaths: ['crates/app/tests/new/'], expect: { exitCode: 0 } } },
    ],
  };
}

/** The cargo workspace with test files and `plan` at daylight.plan.json, committed and mapped into its out dir. */
export function makeRepo(name: string, plan: unknown = samplePlan(), extra: Record<string, string> = {}): { root: string; out: string; commit: string } {
  const root = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, 'fixtures', 'cargo-workspace'), root, { recursive: true });
  const files: Record<string, string> = {
    'crates/core/tests/regress.rs': '#[test]\nfn decimal_still_works() { assert_eq!(fixture_core::decimal(7), "7"); }\n',
    'crates/app/tests/app_gate.rs': '#[test]\nfn prints() {}\n',
    'daylight.plan.json': typeof plan === 'string' ? plan : `${JSON.stringify(plan, null, 2)}\n`,
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const out = path.join(tmp, `${name}-out`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'view.json'), JSON.stringify({ root }));
  return { root, out, commit: git(root, 'rev-parse', 'HEAD') };
}

/** Commit `plan` as the repository's new plan. Returns the new commit. */
export function revisePlan(root: string, plan: unknown): string {
  fs.writeFileSync(path.join(root, 'daylight.plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'revise plan');
  return git(root, 'rev-parse', 'HEAD');
}

export const code = (digest: string) => digest.slice('sha256:'.length, 'sha256:'.length + 8);

export function approve(ctx: DaylightContext, campaignId: string): Decision {
  return approvePlan(ctx, {
    campaignId, actor: HUMAN, rationale: 'plan read', env: CLEAN_ENV, confirm: code(confirmDigest(ctx, 'approve-plan', campaignId).digest),
  });
}

/** A `lock-campaign-gates` decision by hand: R6 owns the real lock; R5 only compares its digest. */
export function lockByHand(ctx: DaylightContext, campaignId: string, gateSetDigest = GATE_SET): Decision {
  const c = ctx.store.mission(campaignId)!;
  return ctx.store.recordDecision({
    missionId: c.id, projectId: c.projectId, revision: c.baseRevision, actor: HUMAN, kind: 'approve', rationale: 'locked by hand',
    scope: { operation: 'lock-campaign-gates', experimentIds: [], harnessDigests: {}, vacuousOverrides: [], bindings: {}, roles: {}, ratchet: false, gateSetDigest },
    artifactIds: [],
  });
}

export const FLAGS: EnvelopeFlags = {
  expectedGateSetDigest: GATE_SET, roster: ['mock'], maxUsdTotal: 40, maxUsdPerMission: 2, maxTurns: 60, timeoutSeconds: 600,
  maxAttemptsPerTicket: 3, concurrency: 2, execute: false, autoApply: 'integration-ref', fixLane: { enabled: true, maxTicketsPerWave: 2, maxUsdPerTicket: 1 },
  tickets: ['C1', 'A1'], notAfter: '72h',
};

export function authorize(ctx: DaylightContext, campaignId: string, flags: Partial<EnvelopeFlags> = {}): Decision {
  const f = { ...FLAGS, ...flags };
  const envelope = buildEnvelope(ctx, campaignId, f);
  return authorizeCampaign(ctx, {
    campaignId, actor: HUMAN, rationale: 'go', env: CLEAN_ENV, flags: f,
    confirm: code(confirmDigest(ctx, 'authorize-campaign', campaignId, { envelope }).digest),
  });
}

/** A fresh repo, out dir and context with the sample plan imported. */
export function imported(name: string, plan: unknown = samplePlan(), now?: () => number): {
  root: string; out: string; commit: string; ctx: DaylightContext; imp: ImportedPlan;
} {
  const r = makeRepo(name, plan);
  const ctx = openDaylight(r.out, now);
  const imp = importPlan(ctx, r.root, 'daylight.plan.json');
  return { ...r, ctx, imp };
}

/** Imported, approved, locked by hand and authorized. */
export function authorized(name: string, flags: Partial<EnvelopeFlags> = {}, now?: () => number) {
  const s = imported(name, samplePlan(), now);
  approve(s.ctx, s.imp.campaign.id);
  lockByHand(s.ctx, s.imp.campaign.id);
  const auth = authorize(s.ctx, s.imp.campaign.id, flags);
  return { ...s, auth };
}
