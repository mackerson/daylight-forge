import os from 'node:os';
import path from 'node:path';
import { mappedProject, mappedRoot, openDaylight, requireMappedRepo, type DaylightContext } from '../mission/context.ts';
import { adjudicateConfirm, parseDecisionValue, publicGateEvaluations, runMission } from '../mission/orchestrate.ts';
import { needsOf } from '../mission/needs.ts';
import { currentRevision } from '../mission/project.ts';
import type { Mission } from '../mission/types.ts';
import { defaultOut } from '../paths.ts';
import { runIngestCommand } from '../ingest/commands.ts';
import { confirmDigest, type ConfirmOperation } from './confirm.ts';
import { decompose } from './decompose.ts';
import { findDependencyRequest, resolveConfirm } from './dependency-requests.ts';
import { evaluate, GateRefused, listGates, type GateContext } from './gate.ts';
import { runGateCommand } from './commands-gate.ts';
import { runWorkItemCommand } from './commands-work-item.ts';
import { runDecideCommand } from './commands-decide.ts';
import { runDepsCommand } from './commands-deps.ts';
import { CAMPAIGN_CONFIRM_OPS, campaignConfirm, runAssumptionCommand, runCampaignCommand, type CampaignConfirmOp } from './commands-campaign.ts';
import { CAMPAIGN_RUN_CONFIRM_OPS, campaignRunConfirm, type CampaignRunConfirmOp } from './commands-campaign-run.ts';
import { candidateForgeryShapes } from './forgery-classes.ts';
import { candidateView, ImplementRefused, possibleSecrets, runImplement } from './orchestrate.ts';
import { assertHumanDecision, DecisionRefused, guardCheck } from './policy.ts';
import { registerSpec, SpecRefused } from './spec.ts';
import { createImplementMission } from './work-items.ts';

/**
 * The Forge's CLI: `confirm`, `mission authorize`, `mission create --kind implement`, and the
 * `forge`, `gate`, `work-item`, `spec` and `ingest` command groups, dispatched from `cli.ts`.
 *
 * Same contract as every mission command: `--out` (default: the repository's data dir),
 * `--format json` for one JSON document on stdout, exit 0 when the command ran (a falsified
 * baseline or a rejected candidate is data), 2 for bad arguments or a missing `--confirm`, 1
 * for a refusal or a failure.
 *
 * Every decision goes through WS1's one guard (`assertHumanDecision`, R10.4, D-9), with the
 * digest `confirmDigest` defines for it. The actor is the OS user: absent, it is supplied;
 * naming anyone else is refused (S-8). That is a record of who ran the command, not
 * authentication, exactly as the guard is a heuristic.
 */

export class Usage extends Error {}

interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
  /**
   * Flags whose last occurrence was bare (`--k`, read as `'true'`), so a literal `--k=true` stays
   * a value. Absent on a mission-command parse, where a `'true'` is taken as bare.
   */
  bare?: Set<string>;
}

export function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let value: string;
    bare.delete(key);
    if (eq >= 0) value = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i];
    else {
      value = 'true';
      bare.add(key);
    }
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { positionals, flags, bare };
}

const last = (p: Parsed, k: string): string | undefined => p.flags.get(k)?.at(-1);
const need = (p: Parsed, k: string): string => {
  const v = last(p, k);
  if (v === undefined || v === 'true') throw new Usage(`--${k} is required`);
  return v;
};
/** `--value` exactly as `mission decide` reads it: `true` is a value here, not a bare flag. */
const valueOf = (p: Parsed): string => {
  const v = last(p, 'value');
  if (v === undefined) throw new Usage('--value is required');
  return v;
};
const list = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Usage(`not a number: ${s}`);
  return n;
};
const seconds = (s: string | undefined): number | undefined => {
  const n = num(s);
  return n === undefined ? undefined : n * 1000;
};

const json = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
const say = (line: string) => process.stdout.write(`${line}\n`);

// ---- the actor -------------------------------------------------------------------------

/** `human:<OS user>`: who runs this command, the only actor a Forge decision is recorded as. */
export function osActor(): string {
  const name = os.userInfo().username.replace(/\s+/g, '_');
  return `human:${name || 'unknown'}`;
}

/** The OS user's actor, or a refusal when the command names someone else. */
export function actorFor(given: string | undefined): string {
  const me = osActor();
  if (given === undefined || given === 'true') return me;
  if (given !== me) {
    throw new Usage(`--actor ${given} is not the user running this command (${me}); a decision is recorded as whoever makes it`);
  }
  return me;
}

/** `argv` with `--actor` set to the OS user's: supplied when absent, refused when it names another. */
export function withActor(argv: string[]): string[] {
  const p = parse(argv);
  const given = p.flags.get('actor');
  if (given && given.length > 1) throw new Usage('--actor is given more than once');
  const actor = actorFor(given?.[0]);
  return given ? argv : [...argv, '--actor', actor];
}

// ---- context ---------------------------------------------------------------------------

function outOf(p: Parsed, repoArg: string | undefined): () => string {
  const explicit = last(p, 'out');
  let resolved: string | undefined;
  return () => (resolved ??= explicit && explicit !== 'true' ? path.resolve(explicit) : defaultOut(repoArg ?? process.cwd()));
}

async function withContext<T>(out: () => string, fn: (ctx: DaylightContext) => Promise<T> | T): Promise<T> {
  const ctx = openDaylight(out());
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

function repoFor(ctx: DaylightContext, named: string | undefined): string {
  const root = named ? path.resolve(named) : mappedRoot(ctx.out);
  if (!root) throw new Usage(`${ctx.out} holds no map; name the repository`);
  return root;
}

/** Without `--confirm`: show what would be confirmed, and stop with exit 2. */
function preview(digest: string, lines: string[], asJson: boolean): number {
  if (asJson) json({ confirm: 'required', digest, lines });
  else {
    for (const l of lines) say(l);
    say(`digest ${digest}`);
  }
  console.error('usage: re-run with --confirm <the first eight hex characters of the digest>');
  return 2;
}

// R17.1: exec runs over the author's own writable tree, so it is granted only beside write.
const EXEC_WITHOUT_WRITE = 'author exec is granted only with write: authorize --execute without --write is refused';

// ---- confirm ---------------------------------------------------------------------------

const OPERATIONS: readonly (ConfirmOperation | 'adjudicate')[] = [
  'authorize-mission', 'adhoc-mission', 'lock-gates', 'approve-work-item', 'reject-work-item',
  'approve-candidate', 'reject-candidate', 'override-candidate', 'apply', 'adjudicate', 'resolve-dependency-request',
  'acknowledge-forgery-shape',
  // Campaign and assumption acts (P2-R40, P2-R45 D6): the GUI confirms only through here.
  'approve-plan', 'authorize-campaign', 'retry-ticket', 'record-assumption', 'confirm-assumption', 'decide-assumption', 'overturn-assumption',
  'lock-campaign-gates', 'resume-campaign', 'adopt-integration-tip',
];

/**
 * `confirm <operation> <subject> [--write] [--execute] [--max-usd N] [--only x,…]`: what a
 * person would confirm, read-only. `refusal` is the guard's answer for this environment and
 * actor (only those checks can fire, since the code is the digest's own), or why the act is
 * refused regardless; a UI shows it instead of a dialog.
 */
function confirmCommand(p: Parsed, out: () => string, env: NodeJS.ProcessEnv) {
  const [operation, subjectId] = p.positionals as [ConfirmOperation | 'adjudicate' | undefined, string | undefined];
  if (!operation || !OPERATIONS.includes(operation)) throw new Usage(`confirm needs one of: ${OPERATIONS.join(', ')}`);
  if (!subjectId) throw new Usage(`confirm ${operation} needs a subject`);
  const actor = actorFor(last(p, 'actor'));
  const write = last(p, 'write') === 'true';
  const execute = last(p, 'execute') === 'true';
  return withContext(out, (ctx) => {
    if (operation === 'adjudicate') {
      // P0 `mission decide`: the subject is the mission, the belief comes in as flags.
      const m = ctx.store.mission(subjectId);
      if (!m) throw new Error(`unknown mission ${subjectId}`);
      const c = adjudicateConfirm(m, {
        subject: need(p, 'subject'), predicate: need(p, 'predicate'), value: parseDecisionValue(valueOf(p)),
        experimentId: last(p, 'experiment'),
      });
      return { operation, subjectId, actor, digest: c.digest, digest8: c.digest8, lines: c.lines, refusal: guardCheck(env, actor, c.digest8, c.digest), possibleSecrets: [] };
    }
    if (operation === 'resolve-dependency-request') {
      // `deps resolve`'s digest, `--declined` included; the request lives in an outbox, not the store.
      const c = resolveConfirm(findDependencyRequest(ctx, subjectId), { declined: last(p, 'declined') === 'true' });
      return { operation, subjectId, actor, digest: c.digest, digest8: c.digest8, lines: c.lines, refusal: guardCheck(env, actor, c.digest8, c.digest), possibleSecrets: [] };
    }
    const campaignOp = (CAMPAIGN_CONFIRM_OPS as readonly string[]).includes(operation);
    if (campaignOp || (CAMPAIGN_RUN_CONFIRM_OPS as readonly string[]).includes(operation)) {
      const get = (k: string) => last(p, k);
      const bare = p.bare;
      const named = last(p, 'repo');
      const c = campaignOp
        ? campaignConfirm(ctx, operation as CampaignConfirmOp, subjectId, get, bare ? (k) => bare.has(k) : undefined)
        : campaignRunConfirm(ctx, operation as CampaignRunConfirmOp, subjectId, get, named && named !== 'true' ? path.resolve(named) : mappedRoot(ctx.out));
      return { operation, subjectId, actor, digest: c.digest, digest8: c.digest8, lines: c.lines, refusal: guardCheck(env, actor, c.digest8, c.digest), possibleSecrets: [] };
    }
    let opts = {};
    if (operation === 'authorize-mission') opts = { permissions: { write, execute }, maxUsd: num(last(p, 'max-usd')) ?? null };
    if (operation === 'lock-gates') {
      const only = list(last(p, 'only'));
      // Without --only, the full gate and holdout set, exactly as `gate lock` locks it.
      opts = { experimentIds: only.length ? only : listGates({ store: ctx.store, artifacts: ctx.artifacts, repoRoot: '' }, subjectId).gates.map((g) => g.experimentId) };
    }
    if (operation === 'acknowledge-forgery-shape') opts = { declined: last(p, 'declined') === 'true' };
    if (operation === 'adhoc-mission') {
      const project = mappedProject(ctx.out);
      if (!project) throw new Error(`${ctx.out} holds no map`);
      opts = { projectId: project.id };
    }
    const c = confirmDigest(ctx, operation, subjectId, opts);
    const candidate = operation === 'approve-candidate' || operation === 'override-candidate' ? ctx.store.candidate(subjectId) : null;
    const possible = candidate ? possibleSecrets(ctx, candidate) : [];
    const lines = possible.length
      ? [...c.lines, ...possible.map((p) => `possible secret in ${p}: acknowledge it (--acknowledge-possible-secret) to ${operation === 'approve-candidate' ? 'approve' : 'override'}`)]
      : c.lines;
    const refusal = guardCheck(env, actor, c.digest8, c.digest) ?? (operation === 'authorize-mission' && execute && !write ? EXEC_WITHOUT_WRITE : null);
    return {
      operation, subjectId, actor, digest: c.digest, digest8: c.digest8, lines, refusal, possibleSecrets: possible,
      ...(candidate ? { forgeryShapes: candidateForgeryShapes(ctx.artifacts, candidate) } : {}),
    };
  });
}

// ---- mission authorize / create implement ----------------------------------------------

export interface AuthorizeInput {
  missionId: string;
  rationale: string | undefined;
  write: boolean;
  execute: boolean;
  maxUsd: number | null;
  actor: string;
  confirm: string;
  env: NodeJS.ProcessEnv;
}

/**
 * `mission authorize`: the one path to write (R7). The guard first, against the grant's own
 * digest; then exec without write is refused (exec is the nested no-network `run` tool over
 * the author's writable tree, R17.1); then the store records the decision and the grant,
 * `execute` explicitly, in one transaction, and `mission.authorized` says so.
 */
export function authorizeMission(ctx: DaylightContext, input: AuthorizeInput): { mission: Mission; decisionId: string } {
  const digest = confirmDigest(ctx, 'authorize-mission', input.missionId, {
    permissions: { write: input.write, execute: input.execute }, maxUsd: input.maxUsd,
  }).digest;
  assertHumanDecision(input.env, input.actor, input.confirm, digest);
  if (input.execute && !input.write) throw new DecisionRefused(`refused: ${EXEC_WITHOUT_WRITE}`);
  if (!input.rationale?.trim()) throw new DecisionRefused('refused: an authorization needs a rationale');
  const { mission, decision } = ctx.store.authorizeMission({
    missionId: input.missionId, actor: input.actor, rationale: input.rationale.trim(),
    permissions: { write: input.write, execute: input.execute }, maxUsd: input.maxUsd,
  });
  ctx.events.append({
    projectId: mission.projectId, missionId: mission.id, actorId: input.actor, category: 'approval', name: 'mission.authorized',
    payload: { decisionId: decision.id, permissions: mission.permissions, maxUsd: input.maxUsd, state: mission.state },
  });
  return { mission, decisionId: decision.id };
}

/** `mission authorize <m> --rationale … [--write [--execute]] [--max-usd N] --confirm <digest8>`. */
export async function missionAuthorizeCommand(p: Parsed, out: () => string, asJson: boolean, env: NodeJS.ProcessEnv): Promise<number> {
  const missionId = p.positionals[0];
  if (!missionId) throw new Usage('mission authorize needs a <mission-id>');
  const write = last(p, 'write') === 'true';
  const execute = last(p, 'execute') === 'true';
  const maxUsd = num(last(p, 'max-usd')) ?? null;
  const actor = actorFor(last(p, 'actor'));
  const confirm = last(p, 'confirm');
  return withContext(out, (ctx) => {
    if (confirm === undefined) {
      const c = confirmDigest(ctx, 'authorize-mission', missionId, { permissions: { write, execute }, maxUsd });
      return preview(c.digest, c.lines, asJson);
    }
    const r = authorizeMission(ctx, { missionId, rationale: last(p, 'rationale'), write, execute, maxUsd, actor, confirm, env });
    if (asJson) json(r.mission);
    else say(`authorized ${r.mission.id} (${r.mission.state}): write ${r.mission.permissions.write ? 'yes' : 'no'}, exec ${r.mission.permissions.execute ? 'yes' : 'no'}, by ${actor} (${r.decisionId})`);
    return 0;
  });
}

/**
 * `mission create <repo> --kind implement --work-item <w>` or `… --no-work-item --objective
 * '<o>' --rationale '<why>' --confirm <digest8>`: through WS7's `createImplementMission`, the
 * sole path (R10.1). The mission starts as a `draft` without write; its base is the commit
 * HEAD names, since an author builds from objects, never from a working tree.
 */
export async function missionCreateImplementCommand(p: Parsed, out: () => string, asJson: boolean, env: NodeJS.ProcessEnv): Promise<number> {
  const repo = p.positionals[0];
  if (!repo) throw new Usage('mission create needs a <repo>');
  const workItemId = last(p, 'work-item');
  const adhoc = last(p, 'no-work-item') === 'true';
  if ((workItemId !== undefined) === adhoc) throw new Usage('an implement mission takes exactly one of --work-item <w> or --no-work-item');
  const maxCost = num(last(p, 'max-cost'));
  return withContext(out, (ctx) => {
    const { root, project } = requireMappedRepo(ctx.out, path.resolve(repo));
    ctx.store.ensureProject(project);
    const revision = currentRevision(root);
    if (!revision.commit) throw new Error(`${root} has no commit; an implement mission builds from one`);
    const objective = last(p, 'objective');
    let from: Parameters<typeof createImplementMission>[1]['from'];
    if (adhoc) {
      const text = objective?.trim();
      if (!text || objective === 'true') throw new Usage('--no-work-item needs --objective');
      const confirm = last(p, 'confirm');
      if (confirm === undefined) {
        const c = confirmDigest(ctx, 'adhoc-mission', text, { projectId: project.id });
        return preview(c.digest, c.lines, asJson);
      }
      from = { adhoc: { actor: actorFor(last(p, 'actor')), rationale: last(p, 'rationale') ?? '', confirm } };
    } else {
      from = { workItemId: workItemId! };
    }
    const m = createImplementMission(ctx, {
      projectId: project.id, baseRevision: revision.commit, env, from,
      ...(objective && objective !== 'true' ? { objective } : {}),
      ...(maxCost !== undefined ? { budget: { maxUsd: maxCost } } : {}),
    });
    ctx.events.append({
      projectId: m.projectId, missionId: m.id, actorId: 'daylight', category: 'lifecycle', name: 'mission.created',
      payload: {
        state: m.state, kind: m.kind, objective: m.objective, scope: m.scope, baseRevision: m.baseRevision,
        dirty: revision.dirty, permissions: m.permissions, workItemId: m.workItemId ?? null,
      },
    });
    if (asJson) json(m);
    else say(`created mission ${m.id} (implement, ${m.state}, write ${m.permissions.write ? 'yes' : 'no'}) at ${m.baseRevision.slice(0, 12)}; next: daylight mission authorize ${m.id} --write`);
    return 0;
  });
}

// ---- forge run / evaluate / candidate --------------------------------------------------

async function forge(sub: string | undefined, p: Parsed, out: () => string, asJson: boolean, env: NodeJS.ProcessEnv): Promise<number> {
  switch (sub) {
    case 'run': {
      const [missionId, repo] = p.positionals;
      if (!missionId || !repo) throw new Usage('forge run needs <mission-id> <repo> --tools <one author>');
      const tools = list(last(p, 'tools'));
      if (tools.length !== 1) throw new Usage('forge run takes exactly one author in --tools (mock or mock:<model>)');
      const r = await withContext(out, (ctx) => runImplement(ctx, {
        missionId, repo: path.resolve(repo), tool: tools[0], maxCost: num(last(p, 'max-cost')), timeoutMs: seconds(last(p, 'timeout')),
        keepWorkspace: last(p, 'keep-workspace') === 'true', runs: num(last(p, 'runs')), env,
      }));
      if (asJson) json(r);
      else {
        say(`attempt ${r.attempt.id} ${r.attempt.state}${r.attempt.failure ? ` (${r.attempt.failure})` : ''}, cost ${r.attempt.costUsd === null ? 'unknown' : `$${r.attempt.costUsd.toFixed(2)}`}`);
        if (r.candidate) {
          say(`candidate ${r.candidate.id}: ${r.candidate.verdict} — ${r.candidate.files.length} file(s), diff ${r.candidate.diffArtifact.digest}`);
          for (const reason of r.candidate.verdictReasons) say(`  ${reason}`);
        } else say(`no candidate: ${r.refused ?? 'nothing captured'}`);
        if (r.workspace) say(`workspace kept at ${r.workspace}`);
        for (const n of r.needs) say(`need: ${n.kind} ${n.ref} — ${n.why}`);
      }
      return 0;
    }
    case 'evaluate': {
      const [candidateId, repo] = p.positionals;
      if (!candidateId) throw new Usage('forge evaluate needs a <candidate-id> [repo]');
      const c = await withContext(out, (ctx) => {
        const gctx: GateContext = {
          store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: repoFor(ctx, repo), out: ctx.out,
          runs: num(last(p, 'runs')), timeoutMs: seconds(last(p, 'timeout')),
        };
        return evaluate(gctx, candidateId);
      });
      if (asJson) json(c);
      else {
        say(`candidate ${c.id}: ${c.verdict}`);
        for (const r of c.verdictReasons) say(`  ${r}`);
      }
      return 0;
    }
    case 'candidate': {
      const candidateId = p.positionals[0];
      if (!candidateId) throw new Usage('forge candidate needs a <candidate-id>');
      const maxBytes = num(last(p, 'max-bytes')) ?? 256 * 1024;
      if (!(maxBytes > 0)) throw new Usage('--max-bytes is a positive number');
      const view = await withContext(out, (ctx) => {
        const v = candidateView(ctx, candidateId, maxBytes);
        return {
          candidate: v.candidate,
          possibleSecrets: v.possibleSecrets,
          forgeryShapes: v.forgeryShapes,
          diff: { text: v.diff.text, truncated: v.diff.truncated },
          gateEvaluations: publicGateEvaluations(ctx, ctx.store.gateEvaluations({ candidateId })),
        };
      });
      if (asJson) json(view);
      else {
        say(`candidate ${view.candidate.id} on mission ${view.candidate.missionId}: ${view.candidate.verdict}`);
        for (const v of view.candidate.policyViolations) say(`  policy: ${v.rule}${v.path ? ` ${v.path}` : ''}`);
        process.stdout.write(view.diff.text);
        if (view.diff.truncated) say('\n… [truncated]');
      }
      return 0;
    }
    default:
      throw new Usage('forge needs one of: run, evaluate, candidate, approve, reject, override, apply');
  }
}

// ---- spec ------------------------------------------------------------------------------

async function spec(sub: string | undefined, p: Parsed, out: () => string, asJson: boolean): Promise<number> {
  switch (sub) {
    case 'register': {
      const repo = p.positionals[0];
      if (!repo) throw new Usage('spec register needs a <repo> --file <repo-relative path>');
      const r = await withContext(out, (ctx) => registerSpec(ctx, path.resolve(repo), need(p, 'file'), { rev: last(p, 'rev') }));
      if (asJson) json(r);
      else say(`registered ${r.path} at ${r.commit.slice(0, 12)} as spec mission ${r.mission.id} (${r.specRevision})`);
      return 0;
    }
    case 'decompose': {
      const [missionId, repo] = p.positionals;
      if (!missionId || !repo) throw new Usage('spec decompose needs <spec-mission-id> <repo> --tools <a,b>');
      const tools = list(last(p, 'tools'));
      if (!tools.length) throw new Usage('spec decompose needs --tools');
      const root = path.resolve(repo);
      const timeoutMs = seconds(last(p, 'timeout'));
      const r = await withContext(out, async (ctx) => {
        // Each decompose task runs as its own blind attempt through runMission (R14 D-3).
        const result = await decompose(ctx, missionId, root, tools, {
          runner: async (cc, run) => {
            await runMission(cc, { missionId: run.mission.id, repo: root, tools: [run.tool], role: 'decompose', prompt: run.prompt, timeoutMs });
          },
        });
        return { ...result, needs: needsOf(ctx, ctx.store.mission(missionId)!) };
      });
      if (asJson) json(r);
      else {
        say(`${r.proposed.length} work item(s) proposed, ${r.refused.length} proposal line(s) refused`);
        for (const w of r.proposed) say(`  ${w.id} ${w.status.padEnd(9)} ${w.anchor}  ${w.title}`);
        for (const n of r.needs) say(`need: ${n.kind} ${n.ref} — ${n.why}`);
      }
      return 0;
    }
    default:
      throw new Usage('spec needs one of: register, decompose');
  }
}

// ---- dispatch --------------------------------------------------------------------------

/** Subcommands that record a decision: their actor is the OS user's, supplied or checked. */
const GUARDED: Record<string, readonly string[]> = {
  gate: ['lock'],
  forge: ['approve', 'reject', 'override', 'apply', 'acknowledge-forgery'],
  'work-item': ['approve', 'reject'],
  campaign: ['approve-plan', 'lock', 'authorize', 'resume', 'adopt-tip', 'retry'],
  assumption: ['confirm', 'decide', 'overturn', 'record'],
};

/**
 * Entry from cli.ts for `confirm`, `forge`, `gate`, `work-item`, `spec`, `ingest`, `deps`, `campaign` and `assumption`; `argv`
 * is `process.argv.slice(2)`. Returns the exit code.
 */
export async function runForgeCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  const sub = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
  const tail = rest.slice(sub ? 1 : 0);
  let asJson = false;
  try {
    const p = parse(tail);
    asJson = last(p, 'format') === 'json';
    const guarded = sub !== undefined && GUARDED[command]?.includes(sub);
    const args = guarded ? [sub!, ...withActor(tail)] : rest;
    switch (command) {
      case 'gate':
        return await runGateCommand(args);
      case 'work-item': {
        const out = outOf(p, undefined)();
        return runWorkItemCommand(args, {
          out, env, stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s),
        });
      }
      case 'ingest':
        return runIngestCommand(rest);
      case 'deps':
        return await runDepsCommand(rest, env);
      case 'campaign':
        return await runCampaignCommand(args, env);
      case 'assumption':
        return await runAssumptionCommand(args, env);
      case 'confirm': {
        const cp = parse(rest);
        asJson = last(cp, 'format') === 'json';
        const r = await confirmCommand(cp, outOf(cp, undefined), env);
        if (asJson) json(r);
        else {
          for (const l of r.lines) say(l);
          say(`digest ${r.digest}`);
          say(r.refusal ? `refused: ${r.refusal}` : `confirm with --confirm ${r.digest8}`);
        }
        return 0;
      }
      case 'forge':
        // approve, reject, override and apply are WS4's, behind the same actor rule.
        if (sub && GUARDED.forge.includes(sub)) return await runDecideCommand(args);
        return await forge(sub, p, outOf(p, sub === 'run' || sub === 'evaluate' ? p.positionals[1] : undefined), asJson, env);
      case 'spec':
        return await spec(sub, p, outOf(p, p.positionals[sub === 'decompose' ? 1 : 0]), asJson);
      default:
        throw new Usage(`unknown command ${command}`);
    }
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    const refused = err instanceof DecisionRefused || err instanceof ImplementRefused || err instanceof GateRefused || err instanceof SpecRefused;
    if (asJson) json({ error: message, refused });
    console.error(`error: ${message}`);
    return 1;
  }
}
