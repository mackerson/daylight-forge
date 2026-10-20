import fs from 'node:fs';
import path from 'node:path';
import { mappedRoot, openDaylight, type DaylightContext } from '../mission/context.ts';
import { NotImplemented } from '../mission/store.ts';
import type { CampaignHaltReason, Decision, ExpectedObservation, GateHarness } from '../mission/types.ts';
import { defaultOut } from '../paths.ts';
import type { SandboxProfile } from '../experiment/sandbox.ts';
import {
  baselineCampaign, listCampaignGates, lockableIds, lockCampaign, registerCampaignGate, registerPlanGates,
} from './campaign-gates.ts';
import { campaignStatus, renderCampaignStatus, type StatusHost } from './campaign-status.ts';
import { actorFor, parse, Usage } from './commands.ts';
import { confirmDigest, type ConfirmOptions } from './confirm.ts';
import { DirectorRefused, r5Host, runCampaign } from './director.ts';
import { GateRefused, type GateContext } from './gate.ts';
import { adoptIntegrationTip, adoptScopeOf, IntegrationRefused } from './integrate.ts';
import { DecisionRefused } from './policy.ts';

/**
 * `daylight campaign gate|baseline|lock|run|status|halt|resume|adopt-tip` (§3.1, §4.1, §7; WS-R6).
 * WS-R5's `runCampaignCommand` dispatches here from its default case, after its agent-session
 * refusal has run (P2-R9, P2-R24): this module does not repeat it. Same contract as every
 * Forge command: `--out`, `--format json`, exit 0 when the command ran, 2 for usage or a
 * missing `--confirm`, 1 for a refusal, a halt or a failure.
 *
 *   gate register <c> --role holdout|gate|regression --file <host path> [--ticket T] --expect-exit n --expect-stdout s…
 *        [--harness node|cargo] [--crate <dir>] [--name <basename>]
 *   gate list <c>
 *   baseline <c> <repo> [--runs n] [--timeout s]
 *   lock <c> --ratchet|--no-ratchet --rationale '<why>' [--accept-vacuous x,…] --confirm <c8>
 *   run <c> <repo> [--concurrency N] [--max-waves K] [--dry-run]
 *   status <c> [<repo>] [--write]
 *   halt <c> --rationale '<why>'
 *   resume <c> --halt <d> --rationale '<why>' --confirm <c8>
 *   adopt-tip <c> <repo> --halt <d> --rationale '<why>' --confirm <c8>
 */

export const CAMPAIGN_RUN_SUBCOMMANDS = ['gate', 'baseline', 'lock', 'run', 'status', 'halt', 'resume', 'adopt-tip'] as const;

/** WS-R5's guarded halt and resume, and the director's host; tests and the merge supply them. */
export interface CampaignRunDeps {
  /** The director's host over the command's own context; WS-R5's by default. */
  host?: (ctx: DaylightContext) => StatusHost;
  halt?: (ctx: DaylightContext, campaignId: string, actor: string, reason: CampaignHaltReason) => Decision;
  resume?: (ctx: DaylightContext, input: { campaignId: string; actor: string; rationale: string; confirm: string | undefined; env: NodeJS.ProcessEnv; haltDecisionId: string }) => Decision;
  sandbox?: SandboxProfile;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

type Parsed = ReturnType<typeof parse>;
const last = (p: Parsed, k: string): string | undefined => p.flags.get(k)?.at(-1);
const need = (p: Parsed, k: string): string => {
  const v = last(p, k);
  if (v === undefined || v === 'true') throw new Usage(`--${k} is required`);
  return v;
};
const list = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Usage(`not a number: ${s}`);
  return n;
};

/** `argv` starts at the subcommand, as `runCampaignCommand`'s does. Returns the exit code. */
export async function runCampaignRunCommand(argv: string[], env: NodeJS.ProcessEnv = process.env, deps: CampaignRunDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const [sub, ...rest] = argv;
  const p = parse(rest);
  const asJson = last(p, 'format') === 'json';
  const json = (d: unknown) => stdout(`${JSON.stringify(d, null, 2)}\n`);
  const say = (l: string) => stdout(`${l}\n`);
  const hostOf = (ctx: DaylightContext): StatusHost => (deps.host ?? r5Host)(ctx);
  const repoArg = sub === 'baseline' || sub === 'run' || sub === 'adopt-tip' ? p.positionals[1] : sub === 'status' ? p.positionals[1] : undefined;
  const explicit = last(p, 'out');
  const out = explicit && explicit !== 'true' ? path.resolve(explicit) : defaultOut(repoArg ?? process.cwd());
  const withCtx = async <T>(fn: (ctx: DaylightContext) => Promise<T> | T): Promise<T> => {
    const ctx = openDaylight(out);
    try {
      return await fn(ctx);
    } finally {
      ctx.close();
    }
  };
  const repoOf = (ctx: DaylightContext, named: string | undefined) => {
    const root = named ? path.resolve(named) : mappedRoot(ctx.out);
    if (!root) throw new Usage(`${ctx.out} holds no map; name the repository`);
    return root;
  };
  const gctx = (ctx: DaylightContext, repo: string): GateContext => {
    const timeout = num(last(p, 'timeout'));
    return {
      store: ctx.store, artifacts: ctx.artifacts, events: ctx.events, repoRoot: repo, out: ctx.out, env, sandbox: deps.sandbox,
      runs: num(last(p, 'runs')), ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}),
    };
  };
  const campaignId = p.positionals[0];
  try {
    if (!sub || !(CAMPAIGN_RUN_SUBCOMMANDS as readonly string[]).includes(sub)) throw new Usage(`campaign needs one of: ${CAMPAIGN_RUN_SUBCOMMANDS.join(', ')}`);
    if (sub !== 'gate' && !campaignId) throw new Usage(`campaign ${sub} needs a <campaign>`);
    switch (sub) {
      case 'gate': {
        const [what, id] = p.positionals;
        if (!id) throw new Usage('campaign gate register|list needs a <campaign>');
        if (what === 'list') {
          return await withCtx((ctx) => {
            const l = listCampaignGates(ctx, id);
            if (asJson) json(l);
            else for (const g of l.gates) say(`${g.role.padEnd(10)} ${g.experimentId} ${g.testPath ?? '(path withheld)'} baseline=${g.baseline ?? 'none'}${g.lockedBy ? ' locked' : ''}`);
            return 0;
          });
        }
        if (what !== 'register') throw new Usage('campaign gate needs register or list');
        const role = last(p, 'role');
        if (role !== 'holdout' && role !== 'gate' && role !== 'regression') throw new Usage('--role holdout|gate|regression is required and has no default');
        const file = need(p, 'file');
        const harness = last(p, 'harness') as GateHarness | undefined;
        if (harness !== undefined && harness !== 'node' && harness !== 'cargo') throw new Usage(`--harness is node or cargo, not ${harness}`);
        const exit = num(last(p, 'expect-exit'));
        const prediction: ExpectedObservation = {
          ...(exit !== undefined ? { exitCode: exit } : {}), ...(p.flags.get('expect-stdout')?.length ? { stdoutIncludes: p.flags.get('expect-stdout') } : {}),
        };
        const x = await withCtx((ctx) => registerCampaignGate(gctx(ctx, ''), {
          campaignId: id, role, ticketId: last(p, 'ticket') ?? null, testSource: fs.readFileSync(file, 'utf8'), basename: last(p, 'name') ?? path.basename(file),
          prediction, ...(harness ? { harness } : {}), ...(last(p, 'crate') !== undefined ? { crate: last(p, 'crate') } : {}),
        }));
        if (asJson) json(role === 'holdout' ? { experimentId: x.id, role: x.role, harnessDigest: x.harnessDigest } : x);
        else say(`registered ${x.role} ${x.id} (${x.harness ?? 'node'})${role === 'holdout' ? '' : ` at ${x.testArtifact.path}`}`);
        return 0;
      }
      case 'baseline': {
        const rows = await withCtx(async (ctx) => {
          const repo = repoOf(ctx, p.positionals[1]);
          registerPlanGates(gctx(ctx, repo), campaignId, hostOf(ctx).plan(campaignId));
          return baselineCampaign(gctx(ctx, repo), campaignId);
        });
        if (asJson) json(rows);
        else for (const g of rows) say(`${g.experimentId}: ${g.conclusion} at the campaign base`);
        return 0;
      }
      case 'lock': {
        const ratchet = last(p, 'ratchet') === 'true' ? true : last(p, 'no-ratchet') === 'true' ? false : undefined;
        if (ratchet === undefined) throw new Usage('--ratchet or --no-ratchet is required: a person says whether passing gates become required for later tickets');
        const confirm = last(p, 'confirm');
        return await withCtx((ctx) => {
          const g = gctx(ctx, '');
          const ids = lockableIds(g, campaignId);
          if (confirm === undefined) {
            const preview = confirmDigest(g, 'lock-campaign-gates', campaignId, { experimentIds: ids, ratchet });
            if (asJson) json({ confirm: 'required', digest: preview.digest, lines: preview.lines });
            else {
              for (const l of preview.lines) say(l);
              say(`gate set ${preview.digest}`);
            }
            stderr('usage: re-run with --confirm <the first eight hex characters of the gate-set digest>\n');
            return 2;
          }
          const d = lockCampaign(g, {
            campaignId, actor: actorFor(last(p, 'actor')), rationale: need(p, 'rationale'), ratchet, confirm, acceptVacuous: list(last(p, 'accept-vacuous')), env,
          });
          if (asJson) json(d);
          else say(`locked campaign gates ${String(d.scope.gateSetDigest)} (ratchet ${ratchet ? 'on' : 'off'}) by ${d.actor} (${d.id}); authorize with --expected-gate-set ${String(d.scope.gateSetDigest)}`);
          return 0;
        });
      }
      case 'run': {
        const r = await withCtx((ctx) => runCampaign(ctx, {
          campaignId, repo: repoOf(ctx, p.positionals[1]), concurrency: num(last(p, 'concurrency')), maxWaves: num(last(p, 'max-waves')),
          dryRun: last(p, 'dry-run') === 'true', host: hostOf(ctx), env, ...(deps.sandbox ? { sandbox: deps.sandbox } : {}),
        }));
        if (asJson) json(r);
        else {
          if (r.dryRun) for (const s of r.schedule) say(`would dispatch ${s.ticketId} (${s.lane}) reserving $${s.reserveUsd.toFixed(2)}`);
          for (const [id, st] of Object.entries(r.statuses)) say(`${id}: ${st}`);
          if (r.refused) say(`refused: ${r.refused}`);
          if (r.halted) say(`halted: ${r.halted}`);
          say(`${r.integrationRef} at ${r.tip ?? '(not created)'}; ${r.landed.length} landed this run`);
        }
        return r.refused || r.halted ? 1 : 0;
      }
      case 'status': {
        const r = await withCtx((ctx) => {
          const report = campaignStatus(ctx, campaignId, repoOf(ctx, p.positionals[1]), hostOf(ctx));
          if (last(p, 'write') === 'true') {
            const dir = path.join(ctx.out, 'campaigns', campaignId);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'STATUS.md'), renderCampaignStatus(report));
          }
          return report;
        });
        if (asJson) json(r);
        else stdout(renderCampaignStatus(r));
        return 0;
      }
      case 'halt': {
        const halt = deps.halt ?? ((): never => {
          throw new NotImplemented('haltCampaign');
        });
        const d = await withCtx((ctx) => halt(ctx, campaignId, actorFor(last(p, 'actor')), 'operator'));
        if (asJson) json(d);
        else say(`halted campaign ${campaignId} (${d.id}); \`campaign resume ${campaignId} --halt ${d.id}\` resumes it`);
        return 0;
      }
      case 'resume': {
        const resume = deps.resume ?? ((): never => {
          throw new NotImplemented('resumeCampaign');
        });
        const haltDecisionId = need(p, 'halt');
        if (last(p, 'confirm') === undefined) {
          // The digest is shown, not the code, as for every guarded act. WS-R5 defines it (`resume-campaign`).
          const preview = await withCtx((ctx) => confirmDigest(ctx, 'resume-campaign', campaignId, { haltDecisionId } as unknown as ConfirmOptions));
          if (asJson) json({ confirm: 'required', digest: preview.digest, lines: preview.lines });
          else for (const l of [...preview.lines, `digest ${preview.digest}`]) say(l);
          stderr('usage: re-run with --confirm <the first eight hex characters of the digest>\n');
          return 2;
        }
        const d = await withCtx((ctx) => resume(ctx, {
          campaignId, actor: actorFor(last(p, 'actor')), rationale: need(p, 'rationale'), confirm: last(p, 'confirm'), env, haltDecisionId: need(p, 'halt'),
        }));
        if (asJson) json(d);
        else say(`resumed campaign ${campaignId} (${d.id})`);
        return 0;
      }
      case 'adopt-tip': {
        const haltDecisionId = need(p, 'halt');
        const confirm = last(p, 'confirm');
        return await withCtx((ctx) => {
          const repo = repoOf(ctx, p.positionals[1]);
          const ictx = { store: ctx.store, events: ctx.events, artifacts: ctx.artifacts, repoRoot: repo };
          if (confirm === undefined) {
            const s = adoptScopeOf(ictx, campaignId, haltDecisionId);
            const preview = confirmDigest(ctx, 'adopt-integration-tip', campaignId, { adopt: { ref: s.ref, from: s.from, to: s.to, haltDecisionId } });
            if (asJson) json({ confirm: 'required', digest: preview.digest, lines: preview.lines });
            else for (const l of [...preview.lines, `digest ${preview.digest}`]) say(l);
            stderr('usage: re-run with --confirm <the first eight hex characters of the digest>\n');
            return 2;
          }
          const d = adoptIntegrationTip(ictx, { campaignId, haltDecisionId, actor: actorFor(last(p, 'actor')), rationale: need(p, 'rationale'), confirm, env });
          if (asJson) json(d);
          else say(`adopted ${String(d.scope.ref)} at ${String(d.scope.to)} (${d.id})`);
          return 0;
        });
      }
    }
    throw new Usage(`unknown campaign subcommand ${sub}`);
  } catch (err) {
    if (err instanceof Usage) {
      stderr(`usage: ${err.message}\n`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    const refused = err instanceof DecisionRefused || err instanceof GateRefused || err instanceof IntegrationRefused || err instanceof DirectorRefused;
    if (asJson) json({ error: message, refused });
    stderr(`error: ${message}\n`);
    return 1;
  }
}

