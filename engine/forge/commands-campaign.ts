import fs from 'node:fs';
import path from 'node:path';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { DAYLIGHT_DB } from '../mission/db.ts';
import { needsOf } from '../mission/needs.ts';
import type { AssumptionDecisionScope, AssumptionStatus, CampaignEnvelope } from '../mission/types.ts';
import { defaultOut } from '../paths.ts';
import { ASSUMPTION_STATUSES, decideAssumption, recordAssumption } from './assumptions.ts';
import {
  approvePlan, authorizeCampaign, buildEnvelope, campaignAuthorizationRefusal, importPlan, PlanInvalid, planOf, retryScopeOf, retryTicket,
  type EnvelopeFlags,
} from './campaign.ts';
import { actorFor, Usage } from './commands.ts';
import { CAMPAIGN_REPORT_SUBCOMMANDS, runCampaignReportCommand } from './commands-campaign-report.ts';
import { CAMPAIGN_RUN_SUBCOMMANDS, runCampaignRunCommand } from './commands-campaign-run.ts';
import { confirmDigest, type ConfirmDigest } from './confirm.ts';
import { topoOrder, validatePlanAt, wavesPreview } from './plan.ts';
import { AGENT_SESSION_VARS, DecisionRefused } from './policy.ts';

/**
 * `daylight campaign …` (WS-R5's subcommands) and `daylight assumption …`.
 *
 *   campaign validate <plan> <repo> [--rev HEAD] [--format json]        # plan.ts only; opens no store
 *   campaign import <repo> --file <plan> [--rev HEAD] [--campaign <m>]   # a revision of an existing campaign
 *   campaign show <campaign>
 *   campaign approve-plan <campaign> --rationale '…' --confirm <digest8>
 *   campaign authorize <campaign> --expected-gate-set <digest> --roster mock --max-usd-total 40 --max-usd-per-mission 2
 *            --max-turns 60 --timeout 600 --max-attempts 3 --concurrency 6 [--wave-size 12] [--execute]
 *            --auto-apply integration-ref|none [--review-roster a,b] [--fix-lane 5:1.5|off] [--tickets A,B]
 *            [--not-after 72h] [--identity 'Name <email>'] --rationale '…' --confirm <digest8>
 *   campaign retry <campaign> <ticket> --rationale '…' --confirm <digest8>
 *   assumption list <campaign> [--status open|pending|confirmed|overturned]
 *   assumption record <campaign> --question '…' --default '…' --rationale '…' [--ticket T] --confirm <digest8>
 *   assumption confirm <u> --rationale '…' --confirm <digest8>
 *   assumption decide <u> --value '…' --rationale '…' --confirm <digest8>
 *   assumption overturn <u> --value '…' --follow-up '<statement>' [--lane L] [--scope a,b] --rationale '…' --confirm <digest8>
 *
 * Every campaign or assumption command that writes a row or moves a ref is refused under
 * `CLAUDECODE` and `DAYLIGHT_SESSION` here, at the CLI, before anything is opened (P2-R9,
 * P2-R24); the read-only set runs anywhere, and so does the preview of a guarded act (no
 * `--confirm` at all), as `mission create`'s does (P2-R41). A heuristic, as ADR-20 says of the
 * guard: a session that imports the functions directly is outside the threat model, like raw
 * SQL (ADR-37), and the confirmed act's own guard refuses a session again.
 *
 * Contract as the other Forge commands: `--out`, `--format json`, exit 0 when it ran, 2 for bad
 * arguments or a missing `--confirm` (the digest is printed, P2-R45), 1 for a refusal or a failure.
 */

/** R5's own; WS-R6's `CAMPAIGN_RUN_SUBCOMMANDS` are joined at dispatch (a top-level spread would read it inside an import cycle). */
export const CAMPAIGN_SUBCOMMANDS = ['validate', 'import', 'show', 'retry', 'approve-plan', 'authorize'] as const;
export const ASSUMPTION_SUBCOMMANDS = ['list', 'record', 'confirm', 'decide', 'overturn'] as const;

/** The guarded acts: without `--confirm` each only prints the digest it would decide on. */
const CAMPAIGN_GUARDED: readonly string[] = ['approve-plan', 'authorize', 'retry', 'lock', 'resume', 'adopt-tip'];
const ASSUMPTION_GUARDED: readonly string[] = ['record', 'confirm', 'decide', 'overturn'];


interface Parsed {
  positionals: string[];
  flags: Map<string, string>;
}

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (eq >= 0) flags.set(key, a.slice(eq + 1));
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags.set(key, argv[++i]);
    else flags.set(key, 'true');
  }
  return { positionals, flags };
}

const json = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
const say = (line: string) => process.stdout.write(`${line}\n`);

const flag = (p: Parsed, k: string): string | undefined => {
  const v = p.flags.get(k);
  return v === 'true' ? undefined : v;
};
const need = (p: Parsed, k: string): string => {
  const v = flag(p, k);
  if (v === undefined) throw new Usage(`--${k} is required`);
  return v;
};
const list = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const num = (p: Parsed, k: string, required = true): number | undefined => {
  const v = flag(p, k);
  if (v === undefined) {
    if (required) throw new Usage(`--${k} is required`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Usage(`--${k} is a number`);
  return n;
};

// ---- the session refusal ---------------------------------------------------------------

/**
 * Whether `campaign <sub> …` writes nothing: `show`, `validate`, `status` without `--write`,
 * `gate list`, `run --dry-run` (P2-R24, P2-R25), `list`, `report` without `--write` and
 * `refine`, which writes derived map files under `<out>` only (P2-R40), and a guarded act's preview, with no
 * `--confirm` flag at all (P2-R41). Every other subcommand, known here or not (R6's included),
 * is treated as one that writes.
 */
export function campaignReadOnly(sub: string | undefined, p: Parsed = { positionals: [], flags: new Map() }): boolean {
  if (sub === 'show' || sub === 'validate' || sub === 'list' || sub === 'refine') return true;
  if (sub === 'report') return !p.flags.has('write');
  if (sub !== undefined && CAMPAIGN_GUARDED.includes(sub)) return !p.flags.has('confirm');
  if (sub === 'status') return p.flags.get('write') === undefined;
  if (sub === 'gate') return p.positionals[0] === 'list';
  if (sub === 'run') return p.flags.get('dry-run') === 'true';
  return false;
}

/** Why an agent session may not run this, or null (P2-R9). The CLI's check, not the store's. */
export function sessionRefusal(env: Readonly<Record<string, string | undefined>>, what: string): string | null {
  const set = AGENT_SESSION_VARS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (!set.length) return null;
  return `refused: ${set.join(' and ')} is set, so an agent is running this; \`${what}\` writes rows and is run by a person from their own shell`;
}

// ---- dispatch --------------------------------------------------------------------------

async function run(
  noun: 'campaign' | 'assumption', argv: string[], env: NodeJS.ProcessEnv,
  body: (sub: string | undefined, p: Parsed, out: () => string, asJson: boolean) => Promise<number> | number,
  readOnly: (sub: string | undefined, p: Parsed) => boolean,
): Promise<number> {
  const [first, ...rest] = argv;
  const sub = first && !first.startsWith('--') ? first : undefined;
  const p = parse(sub ? rest : argv);
  const asJson = p.flags.get('format') === 'json';
  try {
    // Before anything is opened, resolved or read: an agent session writes nothing here.
    if (!readOnly(sub, p)) {
      const why = sessionRefusal(env, `${noun} ${sub ?? ''}`.trim());
      if (why) throw new DecisionRefused(why);
    }
    const explicit = flag(p, 'out');
    let resolved: string | undefined;
    const out = () => (resolved ??= explicit ? path.resolve(explicit) : defaultOut(sub === 'import' ? (p.positionals[0] ?? process.cwd()) : process.cwd()));
    return await body(sub, p, out, asJson);
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    const refused = err instanceof DecisionRefused || err instanceof PlanInvalid;
    if (asJson) json({ error: message, refused, ...(err instanceof PlanInvalid ? { refusals: err.refusals } : {}) });
    else if (err instanceof PlanInvalid) for (const r of err.refusals) console.error(`  ${r.path}  ${r.rule}: ${r.detail}`);
    console.error(`error: ${message}`);
    return 1;
  }
}

function withCtx<T>(out: () => string, fn: (ctx: DaylightContext) => T): T {
  const ctx = openDaylight(out());
  try {
    return fn(ctx);
  } finally {
    ctx.close();
  }
}

/** `withCtx` for a read-only command: an out dir with no database is an error, never created (P2-R24). */
function readCtx<T>(out: () => string, fn: (ctx: DaylightContext) => T): T {
  if (!fs.existsSync(path.join(out(), DAYLIGHT_DB))) throw new Error(`${out()} holds no Daylight database; nothing to read`);
  return withCtx(out, fn);
}

/** Without `--confirm`: show what would be confirmed, and stop with exit 2 (P2-R45). */
function preview(c: { digest: string; lines: string[] }, asJson: boolean): number {
  if (asJson) json({ confirm: 'required', digest: c.digest, lines: c.lines });
  else {
    for (const l of c.lines) say(l);
    say(`digest ${c.digest}`);
  }
  console.error('usage: re-run with --confirm <the first eight hex characters of the digest>');
  return 2;
}

/** `--fix-lane 5:1.5` or `off`. */
function fixLaneOf(s: string | undefined): CampaignEnvelope['fixLane'] | undefined {
  if (s === undefined) return undefined;
  if (s === 'off') return { enabled: false, maxTicketsPerWave: 0, maxUsdPerTicket: 0 };
  const m = /^(\d{1,2}):(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) throw new Usage('--fix-lane is <tickets a wave>:<usd a ticket>, or off');
  return { enabled: true, maxTicketsPerWave: Number(m[1]), maxUsdPerTicket: Number(m[2]) };
}

/** `--identity 'Name <email>'`. */
function identityOf(s: string | undefined): CampaignEnvelope['identity'] | undefined {
  if (s === undefined) return undefined;
  const m = /^([^<>\n\r]{1,64}?)\s*<([^<>\s@]{1,64}@[^<>\s@]{1,128})>$/.exec(s.trim());
  if (!m) throw new Usage("--identity is 'Name <email>'");
  return { name: m[1].trim(), email: m[2] };
}

/** A flag's last value; `''` and `'true'` are passed through as given (a bare flag reads `'true'`). */
export type FlagGet = (flag: string) => string | undefined;

/** The envelope flags over a getter, so `campaign authorize` and `confirm authorize-campaign` read them alike. */
export function envelopeFlagsFrom(get: FlagGet): EnvelopeFlags {
  const p: Parsed = { positionals: [], flags: new Map() };
  for (const k of ['auto-apply', 'roster', 'expected-gate-set', 'review-roster', 'max-usd-total', 'max-usd-per-mission', 'max-turns', 'timeout',
    'max-attempts', 'concurrency', 'wave-size', 'execute', 'fix-lane', 'tickets', 'not-after', 'identity']) {
    const v = get(k);
    if (v !== undefined) p.flags.set(k, v);
  }
  return envelopeFlags(p);
}

function envelopeFlags(p: Parsed): EnvelopeFlags {
  const autoApply = need(p, 'auto-apply');
  if (autoApply !== 'integration-ref' && autoApply !== 'none') throw new Usage('--auto-apply is integration-ref or none');
  const roster = list(need(p, 'roster'));
  if (!roster.length) throw new Usage('--roster names at least one author');
  return {
    expectedGateSetDigest: need(p, 'expected-gate-set'), roster, reviewRoster: list(flag(p, 'review-roster')),
    maxUsdTotal: num(p, 'max-usd-total')!, maxUsdPerMission: num(p, 'max-usd-per-mission')!, maxTurns: num(p, 'max-turns')!,
    timeoutSeconds: num(p, 'timeout')!, maxAttemptsPerTicket: num(p, 'max-attempts')!, concurrency: num(p, 'concurrency')!,
    waveSize: num(p, 'wave-size', false), execute: p.flags.get('execute') === 'true', autoApply,
    fixLane: fixLaneOf(flag(p, 'fix-lane')), tickets: list(flag(p, 'tickets')), notAfter: flag(p, 'not-after'),
    identity: identityOf(flag(p, 'identity')),
  };
}

// ---- confirm (P2-R40, P2-R45 D6) ------------------------------------------------------

export type CampaignConfirmOp = 'approve-plan' | 'authorize-campaign' | 'retry-ticket' | 'record-assumption'
  | 'confirm-assumption' | 'decide-assumption' | 'overturn-assumption';
export const CAMPAIGN_CONFIRM_OPS: readonly CampaignConfirmOp[] = [
  'approve-plan', 'authorize-campaign', 'retry-ticket', 'record-assumption', 'confirm-assumption', 'decide-assumption', 'overturn-assumption',
];

/**
 * The digest `daylight confirm <op>` prints for one of WS-R5's acts: computed from the same
 * flags, read by the same rules, as the act's own preview, so the code it shows is the one the
 * act accepts. Read-only. `--ticket` names the ticket for `retry-ticket` (the act's positional).
 */
export function campaignConfirm(ctx: DaylightContext, op: CampaignConfirmOp, subjectId: string, get: FlagGet): ConfirmDigest {
  const flagOf = (k: string) => {
    const v = get(k);
    return v === 'true' ? undefined : v;
  };
  const needOf = (k: string) => {
    const v = flagOf(k);
    if (v === undefined) throw new Usage(`--${k} is required`);
    return v;
  };
  switch (op) {
    case 'approve-plan':
      return confirmDigest(ctx, 'approve-plan', subjectId);
    case 'authorize-campaign':
      return confirmDigest(ctx, 'authorize-campaign', subjectId, { envelope: buildEnvelope(ctx, subjectId, envelopeFlagsFrom(get)) });
    case 'retry-ticket':
      return confirmDigest(ctx, 'retry-ticket', subjectId, { retry: retryScopeOf(ctx, subjectId, needOf('ticket')) });
    case 'record-assumption': {
      const ticketId = flagOf('ticket');
      return confirmDigest(ctx, 'record-assumption', subjectId, { assumption: { question: needOf('question'), default: get('default') ?? '', ...(ticketId ? { ticketId } : {}) } });
    }
    case 'confirm-assumption':
    case 'decide-assumption':
    case 'overturn-assumption': {
      const value = op === 'confirm-assumption' ? undefined : needOf('value');
      const statement = flagOf('follow-up');
      if (op === 'overturn-assumption' && statement === undefined) throw new Usage("overturn-assumption needs --follow-up '<statement>'");
      const followUp = statement !== undefined ? { lane: flagOf('lane'), scope: list(flagOf('scope')) } : undefined;
      return confirmDigest(ctx, op, subjectId, {
        value: value ?? ctx.store.assumption(subjectId)?.default, followUp: statement, followUpLane: followUp?.lane, followUpScope: followUp?.scope,
      });
    }
  }
}

// ---- campaign --------------------------------------------------------------------------

/** Entry for `daylight campaign …`; `argv` starts at the subcommand. Returns the exit code. */
export async function runCampaignCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return run('campaign', argv, env, (sub, p, out, asJson) => {
    switch (sub) {
      case 'validate': {
        const [rel, repo] = p.positionals;
        if (!rel || !repo) throw new Usage('campaign validate needs <plan> <repo>');
        const v = validatePlanAt(path.resolve(repo), rel, flag(p, 'rev') ?? 'HEAD');
        if (asJson) json({ ok: !v.refusals.length, planDigest: v.planDigest, commit: v.commit, refusals: v.refusals });
        else {
          for (const r of v.refusals) say(`${r.path}  ${r.rule}: ${r.detail}`);
          say(v.refusals.length ? `${v.refusals.length} refusal(s); nothing recorded` : `${rel} at ${v.commit.slice(0, 12)} is a valid plan (${v.planDigest})`);
        }
        return v.refusals.length ? 1 : 0;
      }
      case 'import': {
        const repo = p.positionals[0];
        if (!repo) throw new Usage('campaign import needs <repo> --file <plan>');
        const r = withCtx(out, (ctx) => importPlan(ctx, path.resolve(repo), need(p, 'file'), { rev: flag(p, 'rev'), campaignId: flag(p, 'campaign') }));
        if (asJson) json(r);
        else {
          say(`campaign ${r.campaign.id} (${r.campaign.state}): plan ${r.planDigest} at ${r.commit.slice(0, 12)}`);
          say(`tickets: ${r.added.length} new, ${r.kept.length} kept, ${r.dropped.length} dropped; next: daylight campaign approve-plan ${r.campaign.id}`);
        }
        return 0;
      }
      case 'show': {
        const id = p.positionals[0];
        if (!id) throw new Usage('campaign show needs <campaign>');
        const view = readCtx(out, (ctx) => showCampaign(ctx, id));
        if (asJson) json(view);
        else {
          say(`campaign ${view.campaign.id} (${view.campaign.state}): ${view.title}`);
          say(`plan ${view.planDigest} at ${view.commit.slice(0, 12)}; approved ${view.approved ? 'yes' : 'no'}; authorization: ${view.authorization ?? 'in force'}`);
          for (const l of view.lanes) say(`lane ${l.id}: ${l.tickets.join(' ')}`);
          view.waves.forEach((w, i) => say(`wave ${i + 1} (preview): ${w.join(' ')}`));
          for (const a of view.ownerDecisions) say(`owner decision ${a.ownerDecisionId} ${a.status}${a.blocking ? ' blocking' : ''} (${a.id})`);
          for (const n of view.needs) say(`need: ${n.kind} ${n.ref} — ${n.why}`);
        }
        return 0;
      }
      case 'approve-plan': {
        const id = p.positionals[0];
        if (!id) throw new Usage('campaign approve-plan needs <campaign>');
        const confirm = flag(p, 'confirm');
        return withCtx(out, (ctx) => {
          if (confirm === undefined) return preview(confirmDigest(ctx, 'approve-plan', id), asJson);
          const d = approvePlan(ctx, { campaignId: id, actor: actorFor(flag(p, 'actor')), rationale: flag(p, 'rationale'), confirm, env });
          if (asJson) json(d);
          else say(`approved the plan of ${id} (${d.id}): ${Object.keys(d.scope.workItems as object).length} ticket(s)`);
          return 0;
        });
      }
      case 'authorize': {
        const id = p.positionals[0];
        if (!id) throw new Usage('campaign authorize needs <campaign> and the envelope flags');
        const flags = envelopeFlags(p);
        const confirm = flag(p, 'confirm');
        return withCtx(out, (ctx) => {
          if (confirm === undefined) return preview(confirmDigest(ctx, 'authorize-campaign', id, { envelope: buildEnvelope(ctx, id, flags) }), asJson);
          const d = authorizeCampaign(ctx, { campaignId: id, actor: actorFor(flag(p, 'actor')), rationale: flag(p, 'rationale'), confirm, env, flags });
          if (asJson) json(d);
          else say(`authorized campaign ${id} (${d.id}) until ${new Date((d.scope as unknown as CampaignEnvelope).notAfter).toISOString()}`);
          return 0;
        });
      }
      case 'retry': {
        const [id, ticketId] = p.positionals;
        if (!id || !ticketId) throw new Usage('campaign retry needs <campaign> <ticket>');
        const confirm = flag(p, 'confirm');
        return withCtx(out, (ctx) => {
          if (confirm === undefined) return preview(confirmDigest(ctx, 'retry-ticket', id, { retry: retryScopeOf(ctx, id, ticketId) }), asJson);
          const d = retryTicket(ctx, { campaignId: id, ticketId, actor: actorFor(flag(p, 'actor')), rationale: flag(p, 'rationale'), confirm, env });
          if (asJson) json(d);
          else say(`released ticket ${ticketId} of ${id} (${d.id}); a new mission may build it`);
          return 0;
        });
      }
      default:
        // WS-R6's subcommands, behind the same session refusal (`campaignReadOnly` above).
        if (sub && (CAMPAIGN_RUN_SUBCOMMANDS as readonly string[]).includes(sub)) return runCampaignRunCommand(argv, env);
        // WS-R8's list, report and refine derive their own --out from <repo>.
        if (sub && (CAMPAIGN_REPORT_SUBCOMMANDS as readonly string[]).includes(sub)) return runCampaignReportCommand(argv, env);
        throw new Usage(`campaign needs one of: ${[...CAMPAIGN_SUBCOMMANDS, ...CAMPAIGN_RUN_SUBCOMMANDS, ...CAMPAIGN_REPORT_SUBCOMMANDS].join(', ')}`);
    }
  }, campaignReadOnly);
}

/** `campaign show`: the plan's DAG, lanes, a waves preview and owner decisions, with the campaign's needs. */
export function showCampaign(ctx: DaylightContext, campaignId: string) {
  const plan = planOf(ctx, campaignId);
  const campaign = ctx.store.mission(campaignId)!;
  const tickets = ctx.store.campaignTickets(campaignId);
  return {
    campaign, title: plan.plan.title, planDigest: plan.planDigest, commit: plan.commit,
    approved: ctx.store.latestDecision(campaignId, 'approve-plan')?.scope.planDigest === plan.planDigest,
    authorization: campaignAuthorizationRefusal(ctx, campaignId),
    order: topoOrder(plan.plan.tickets),
    lanes: plan.plan.lanes.map((l) => ({ id: l.id, title: l.title, tickets: tickets.filter((t) => t.lane === l.id).map((t) => t.ticketId) })),
    waves: wavesPreview(plan.plan.tickets),
    tickets: tickets.map((t) => ({ ...t, status: ctx.store.workItem(t.workItemId)?.status ?? 'unknown' })),
    ownerDecisions: ctx.store.assumptions(campaignId).filter((a) => a.ownerDecisionId),
    needs: needsOf(ctx, campaign),
  };
}

// ---- assumption ------------------------------------------------------------------------

/** Entry for `daylight assumption …`; `argv` starts at the subcommand. */
export async function runAssumptionCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return run('assumption', argv, env, (sub, p, out, asJson) => {
    switch (sub) {
      case 'list': {
        const id = p.positionals[0];
        if (!id) throw new Usage('assumption list needs <campaign>');
        const status = flag(p, 'status') as AssumptionStatus | undefined;
        if (status !== undefined && !ASSUMPTION_STATUSES.includes(status)) throw new Usage(`--status is one of ${ASSUMPTION_STATUSES.join(', ')}`);
        const rows = readCtx(out, (ctx) => ctx.store.assumptions(id, { status }));
        if (asJson) json(rows);
        else {
          if (!rows.length) say('no assumptions');
          for (const a of rows) say(`${a.id}  ${a.status.padEnd(10)} ${a.ownerDecisionId ?? a.ticketId ?? ''}  ${a.question.split('\n')[0]}`);
        }
        return 0;
      }
      case 'record': {
        const id = p.positionals[0];
        if (!id) throw new Usage('assumption record needs <campaign> --question … --default …');
        const question = need(p, 'question');
        const dflt = p.flags.get('default') ?? '';
        // A bare --default parses as 'true'; a person who means no default leaves the flag out.
        if (dflt === 'true' && !argv.includes('--default=true')) throw new Usage("--default needs a value; leave it out for an assumption with no default");
        const ticketId = flag(p, 'ticket');
        const confirm = flag(p, 'confirm');
        return withCtx(out, (ctx) => {
          if (confirm === undefined) {
            return preview(confirmDigest(ctx, 'record-assumption', id, { assumption: { question, default: dflt, ...(ticketId ? { ticketId } : {}) } }), asJson);
          }
          const a = recordAssumption(ctx, { campaignId: id, question, default: dflt, rationale: flag(p, 'rationale'), ticketId, actor: actorFor(flag(p, 'actor')), confirm, env });
          if (asJson) json(a);
          else say(`recorded assumption ${a.id} (${a.status})`);
          return 0;
        });
      }
      case 'confirm':
      case 'decide':
      case 'overturn': {
        const id = p.positionals[0];
        if (!id) throw new Usage(`assumption ${sub} needs <assumption>`);
        const operation = `${sub}-assumption` as AssumptionDecisionScope['operation'];
        const value = sub === 'confirm' ? undefined : need(p, 'value');
        const statement = flag(p, 'follow-up');
        if (sub === 'overturn' && statement === undefined) throw new Usage("assumption overturn needs --follow-up '<statement>'");
        const followUp = statement !== undefined ? { statement, lane: flag(p, 'lane'), scope: list(flag(p, 'scope')) } : undefined;
        const confirm = flag(p, 'confirm');
        return withCtx(out, (ctx) => {
          if (confirm === undefined) {
            const a = ctx.store.assumption(id);
            return preview(confirmDigest(ctx, operation, id, { value: value ?? a?.default, followUp: statement, followUpLane: followUp?.lane, followUpScope: followUp?.scope }), asJson);
          }
          const r = decideAssumption(ctx, { id, operation, value, followUp, actor: actorFor(flag(p, 'actor')), rationale: flag(p, 'rationale'), confirm, env });
          if (asJson) json(r);
          else say(`assumption ${id} is ${r.assumption.status} (${r.decision.id})${r.assumption.followUpWorkItemId ? `; follow-up work item ${r.assumption.followUpWorkItemId} is proposed` : ''}`);
          return 0;
        });
      }
      default:
        throw new Usage(`assumption needs one of: ${ASSUMPTION_SUBCOMMANDS.join(', ')}`);
    }
  }, (sub, p) => sub === 'list' || (sub !== undefined && ASSUMPTION_GUARDED.includes(sub) && !p.flags.has('confirm')));
}
