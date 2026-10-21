import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { DAYLIGHT_DB } from '../mission/db.ts';
import { runMission, type OutboxRunner } from '../mission/orchestrate.ts';
import type { ApproveIrSetV1 } from '../mission/types.ts';
import { defaultOut } from '../paths.ts';
import { diffCorpus, reviseCorpus, staleBlueprints } from './authority.ts';
import {
  approveBlueprint, approveBlueprintScope, BlueprintRefused, blueprintRefusals, importBlueprint, proposeBlueprints,
} from './blueprint.ts';
import { actorFor } from './commands.ts';
import { sessionRefusal } from './commands-campaign.ts';
import type { ConfirmDigest } from './confirm.ts';
import { approveIr, parseApproveIrSet, planApproveIr, runIrReview } from './ir-review.ts';
import { emitPlan, importPackets, packetContext, PacketsRefused, proposePackets } from './packets.ts';
import { confirmCodeOf, DecisionRefused } from './policy.ts';

/**
 * `daylight corpus review|approve-ir|approve-blueprint|revise|diff|blueprint|packets` (spec
 * ingestion §6–§9); the one caller file of §9's invariant (`approveIr`, `approveBlueprint`). WS-R15.
 *
 *   corpus review <corpus> <repo> --tools a,b [--blueprint bp_…] [--timeout s]
 *   corpus approve-ir <corpus> (--set <host file.json> | --approve ir_…,… --reject … --accept rf_… --dismiss rf_… | --section <id> [--kind k])
 *          --rationale '…' --confirm <digest8>
 *   corpus approve-blueprint <bp> [--invariant-tags a,b] --rationale '…' --confirm <digest8>
 *   corpus revise <corpus> <repo> [--rev HEAD] [--project alias=<repo>[@rev]]… [--manifest daylight.corpus.json]
 *   corpus diff <corpus> --from cr_… --to cr_… [--format json]
 *   corpus blueprint import <corpus> --file <host path> | validate <bp> [--invariant-tags a,b] | show <bp> | propose <corpus> <repo> --tools a
 *   corpus packets import <bp> --file <host path> | propose <bp> <repo> --tools a | emit <bp> | list <bp> | context <campaign> <ticket>
 *
 * Under `CLAUDECODE` or `DAYLIGHT_SESSION` only reading runs: `diff`, `blueprint validate|show`,
 * `packets list|context`, and a guarded act's preview (no `--confirm` at all). `review` and the two
 * `propose` forms also run there when every tool is a mock (P2-R50 Q5); everything else writes rows
 * or files and is a person's, from their own shell. There is no agreement-count selector anywhere
 * (ADR-14): `approve-ir` takes ids, a set file or a section, and refuses any other flag.
 *
 * Exit 0 when it ran, 2 for bad arguments or a missing `--confirm` (the digest is printed), 1 for a
 * refusal or a failure.
 */

export const CORPUS_REVIEW_SUBCOMMANDS = ['review', 'approve-ir', 'approve-blueprint', 'revise', 'diff', 'blueprint', 'packets'] as const;

class Usage extends Error {}
interface Parsed { positionals: string[]; flags: Map<string, string>; projects: string[] }

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const projects: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    const value = eq >= 0 ? a.slice(eq + 1) : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    if (key === 'project') projects.push(value);
    else flags.set(key, value);
  }
  return { positionals, flags, projects };
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
const allMock = (tools: string[]) => tools.length > 0 && tools.every((t) => t === 'mock' || t.startsWith('mock:'));

/** The real runner: each outbox task as its own sandboxed attempt through `runMission` (§13.0). */
export const defaultOutboxRunner: OutboxRunner = async (ctx, run) => {
  await runMission(ctx, { missionId: run.missionId, repo: run.repo, tools: run.tools, outbox: run.outbox, timeoutMs: run.timeoutMs });
};

/** Whether this invocation only reads (P2-R24, P2-R41), or writes nothing but mock-run rows (P2-R50 Q5). */
export function corpusReviewReadOnly(sub: string | undefined, p: Parsed): boolean {
  const [first] = p.positionals;
  if (sub === 'diff') return true;
  if (sub === 'approve-ir' || sub === 'approve-blueprint') return !p.flags.has('confirm');
  if (sub === 'blueprint') return first === 'validate' || first === 'show' || (first === 'propose' && allMock(list(flag(p, 'tools'))));
  if (sub === 'packets') return first === 'list' || first === 'context' || (first === 'propose' && allMock(list(flag(p, 'tools'))));
  if (sub === 'review') return allMock(list(flag(p, 'tools')));
  return false;
}

/**
 * What a person confirms for the two ingest acts (`daylight confirm approve-ir|approve-blueprint`
 * asks the same): `approve-ir` over the act's whole scope — every record at
 * its content digest, every finding disposition, the approved set's digest after it — and
 * `approve-blueprint` over the blueprint's digest, the IR set it was drawn over, what it
 * supersedes and the invariant tags it is checked against. Refused, with no code, when the act would be.
 */
export function confirmIngest(ctx: DaylightContext, op: 'approve-ir' | 'approve-blueprint', subject: string,
  o: { set?: ApproveIrSetV1; invariantTags?: readonly string[] } = {}): ConfirmDigest {
  if (op === 'approve-ir') {
    if (!o.set) throw new Error('approve-ir confirms a set; pass it');
    const plan = planApproveIr(ctx, subject, o.set);
    if (plan.refusals.length) throw new DecisionRefused(`refused: approve-ir:\n  ${plan.refusals.join('\n  ')}`);
    const digest = digestOf(canonicalJson(plan.scope));
    return { digest, digest8: confirmCodeOf(digest), lines: plan.lines };
  }
  const scope = approveBlueprintScope(ctx, subject, o.invariantTags);
  const bp = ctx.store.blueprint(subject)!;
  const refusals = blueprintRefusals(ctx, bp.corpusId, bp.body, o.invariantTags ?? []);
  if (refusals.length) throw new DecisionRefused(`refused: approve-blueprint:\n  ${refusals.map((r) => `${r.path}  ${r.rule}: ${r.detail}`).join('\n  ')}`);
  const digest = digestOf(canonicalJson(scope));
  const b = bp.body;
  return {
    digest, digest8: confirmCodeOf(digest), lines: [
      `approve blueprint ${bp.id} of corpus ${bp.corpusId} (${bp.blueprintDigest})`,
      `drawn over approved IR set ${b.irSetDigest}`,
      `${b.boundaries.length} boundar${b.boundaries.length === 1 ? 'y' : 'ies'} (${b.boundaries.filter((x) => x.lifecycle === 'external').length} external), `
        + `${b.components.length} component(s), ${b.interfaces.length} interface(s), order ${b.order.map((l) => l.join('+')).join(' → ')}`,
      `${b.deferred.length} deferred, ${b.outOfScope.length} out of scope; milestones ${b.scope.milestones.join(', ') || '(none)'}`,
      `supersedes ${scope.supersedes ?? 'nothing'}; invariant tags checked: ${scope.invariantTags?.join(', ') ?? 'none'}`,
    ],
  };
}

function preview(c: ConfirmDigest, asJson: boolean): number {
  if (asJson) json({ confirm: 'required', digest: c.digest, lines: c.lines });
  else {
    for (const l of c.lines) say(l);
    say(`digest ${c.digest}`);
  }
  console.error('usage: re-run with --confirm <the first eight hex characters of the digest>');
  return 2;
}

/** The set an `approve-ir` invocation names: a host file, ids, or a section sweep (never an agreement count). */
function setFrom(ctx: DaylightContext, corpusId: string, p: Parsed): ApproveIrSetV1 {
  const allowed = ['set', 'approve', 'reject', 'accept', 'dismiss', 'section', 'kind', 'rationale', 'confirm', 'actor', 'out', 'format'];
  const extra = [...p.flags.keys()].filter((k) => !allowed.includes(k));
  if (extra.length) throw new Usage(`approve-ir takes no --${extra.join(', --')}: records are approved by name or by section, never by agreement`);
  const file = flag(p, 'set');
  if (file !== undefined) {
    if (['approve', 'reject', 'section', 'accept', 'dismiss'].some((k) => p.flags.has(k))) throw new Usage('--set is the whole act; pass no ids beside it');
    const st = fs.lstatSync(file);
    if (!st.isFile()) throw new Usage('--set is a regular file on this host');
    const set = parseApproveIrSet(fs.readFileSync(file));
    if (typeof set === 'string') throw new Usage(`--set: ${set}`);
    return set;
  }
  const rev = ctx.store.currentCorpusRevision(corpusId);
  if (!rev) throw new Error(`corpus ${corpusId} has no revision`);
  const section = flag(p, 'section');
  const kind = flag(p, 'kind');
  const swept = section === undefined ? [] : ctx.store.irRecords(corpusId, { status: 'proposed', sectionId: section })
    .filter((r) => kind === undefined || r.kind === kind).map((r) => r.id);
  return {
    kind: 'daylight-approve-ir', version: 1, corpusId, revisionId: rev.id, approve: [...new Set([...list(flag(p, 'approve')), ...swept])],
    reject: list(flag(p, 'reject')), accept: list(flag(p, 'accept')), dismiss: list(flag(p, 'dismiss')),
  };
}

/** `daylight confirm approve-ir|approve-blueprint <subject> …`: `argv` starts at the subject; the flags are the corpus command's. */
export function ingestConfirmOf(ctx: DaylightContext, op: 'approve-ir' | 'approve-blueprint', argv: string[]): ConfirmDigest {
  const p = parse(argv);
  const subject = p.positionals[0];
  if (!subject) throw new Usage(`confirm ${op} needs a subject`);
  return op === 'approve-ir'
    ? confirmIngest(ctx, op, subject, { set: setFrom(ctx, subject, p) })
    : confirmIngest(ctx, op, subject, { invariantTags: list(flag(p, 'invariant-tags')) });
}

/** `--project alias=<repo>[@rev]`, repeatable. */
function projectsOf(p: Parsed): { projects: Record<string, string> } {
  const projects: Record<string, string> = {};
  for (const v of p.projects) {
    const m = /^([a-z][a-z0-9-]{0,31})=(.+)$/.exec(v);
    if (!m) throw new Usage('--project is alias=<repo>[@rev]');
    projects[m[1]] = m[2];
  }
  return { projects };
}

/** Entry for `daylight corpus <review-sub> …`; `argv` starts at the subcommand. */
export async function runCorpusReviewCommand(argv: string[], env: NodeJS.ProcessEnv = process.env, deps: { runner?: OutboxRunner } = {}): Promise<number> {
  const [first, ...rest] = argv;
  const sub = first && !first.startsWith('--') ? first : undefined;
  const p = parse(sub ? rest : argv);
  const asJson = p.flags.get('format') === 'json';
  const runner = deps.runner ?? defaultOutboxRunner;
  try {
    // Before anything is opened, resolved or read: an agent session writes nothing here.
    if (!corpusReviewReadOnly(sub, p)) {
      const why = sessionRefusal(env, `corpus ${sub ?? ''}${p.positionals[0] && (sub === 'blueprint' || sub === 'packets') ? ` ${p.positionals[0]}` : ''}`.trim());
      if (why) throw new DecisionRefused(why);
    }
    const explicit = flag(p, 'out');
    const repoArg = sub === 'review' || sub === 'revise' ? p.positionals[1] : (sub === 'blueprint' || sub === 'packets') && p.positionals[0] === 'propose' ? p.positionals[2] : undefined;
    const out = () => (explicit ? path.resolve(explicit) : defaultOut(repoArg ? path.resolve(repoArg) : process.cwd()));
    const withCtx = async <T>(fn: (ctx: DaylightContext) => T | Promise<T>, readOnly = false): Promise<T> => {
      if (readOnly && !fs.existsSync(path.join(out(), DAYLIGHT_DB))) throw new Error(`${out()} holds no Daylight database; nothing to read`);
      const ctx = openDaylight(out());
      try {
        return await fn(ctx);
      } finally {
        ctx.close();
      }
    };
    switch (sub) {
      case 'review': {
        const [corpusId, repo] = p.positionals;
        if (!corpusId || !repo) throw new Usage('corpus review needs <corpus> <repo> --tools a,b');
        const tools = list(need(p, 'tools'));
        const timeout = flag(p, 'timeout');
        const timed: OutboxRunner = timeout ? (c, run) => runner(c, { ...run, timeoutMs: Number(timeout) * 1000 }) : runner;
        const r = await withCtx((ctx) => runIrReview(ctx, corpusId, path.resolve(repo), tools, { runner: timed, blueprintId: flag(p, 'blueprint') }));
        if (asJson) json({ missionId: r.missionId, findings: r.findings.map((f) => ({ id: f.id, kind: f.kind, severity: f.severity, irId: f.irId, corroboratedBy: f.corroboratedBy })), refused: r.refused });
        else say(`review ${r.missionId}: ${r.findings.length} finding(s), ${r.refused.length} refused line(s); next: daylight corpus approve-ir ${corpusId}`);
        return 0;
      }
      case 'approve-ir': {
        const corpusId = p.positionals[0];
        if (!corpusId) throw new Usage('corpus approve-ir needs <corpus> and a set');
        const confirm = flag(p, 'confirm');
        return await withCtx((ctx) => {
          const set = setFrom(ctx, corpusId, p);
          if (confirm === undefined) return preview(confirmIngest(ctx, 'approve-ir', corpusId, { set }), asJson);
          const d = approveIr(ctx, { corpusId, actor: actorFor(flag(p, 'actor')), rationale: flag(p, 'rationale'), confirm, env, set });
          if (asJson) json(d);
          else say(`approve-ir ${d.id}: approved IR set ${String(d.scope.irSetDigest)}`);
          return 0;
        });
      }
      case 'approve-blueprint': {
        const bpId = p.positionals[0];
        if (!bpId) throw new Usage('corpus approve-blueprint needs <bp>');
        const confirm = flag(p, 'confirm');
        const invariantTags = list(flag(p, 'invariant-tags'));
        return await withCtx((ctx) => {
          if (confirm === undefined) return preview(confirmIngest(ctx, 'approve-blueprint', bpId, { invariantTags }), asJson);
          const d = approveBlueprint(ctx, { blueprintId: bpId, actor: actorFor(flag(p, 'actor')), rationale: flag(p, 'rationale'), confirm, env, invariantTags });
          if (asJson) json(d);
          else say(`approve-blueprint ${d.id}: blueprint ${bpId} approved`);
          return 0;
        });
      }
      case 'revise': {
        const [corpusId, repo] = p.positionals;
        if (!corpusId || !repo) throw new Usage('corpus revise needs <corpus> <repo>');
        const r = await withCtx((ctx) => reviseCorpus(ctx, path.resolve(repo), corpusId, { rev: flag(p, 'rev'), manifest: flag(p, 'manifest'), ...projectsOf(p) }));
        if (asJson) json(r);
        else {
          const n = (s: string) => r.diff.records.filter((x) => x.status === s).length;
          say(`revision ${r.revision.id} (seq ${r.revision.seq}): ${n('carried')} carried, ${n('moved')} moved, ${n('review')} to review, ${n('stale')} stale`);
          const inv = r.diff.invalidated;
          say(`invalidated: ${inv.blueprints.length} blueprint(s), ${inv.packets.length} packet(s), ${inv.tickets.length} ticket(s), ${inv.gates.length} gate(s), ${inv.assumptions.length} assumption(s)`);
        }
        return 0;
      }
      case 'diff': {
        const corpusId = p.positionals[0];
        if (!corpusId) throw new Usage('corpus diff needs <corpus> --from cr_… --to cr_…');
        const d = await withCtx((ctx) => diffCorpus(ctx, corpusId, need(p, 'from'), need(p, 'to')), true);
        if (asJson) json(d);
        else {
          say(`sections: ${d.sections.added.length} added, ${d.sections.removed.length} removed, ${d.sections.changed.length} changed, ${d.sections.renamed.length} renamed`);
          for (const r of d.records.filter((x) => x.status !== 'carried')) say(`${r.irId} ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
        }
        return 0;
      }
      case 'blueprint': {
        const [verb, id, repo] = p.positionals;
        if (verb === 'import') {
          if (!id) throw new Usage('corpus blueprint import needs <corpus> --file <path>');
          const r = await withCtx((ctx) => importBlueprint(ctx, id, path.resolve(need(p, 'file'))));
          if (asJson) json({ blueprintId: r.blueprint.id, blueprintDigest: r.blueprint.blueprintDigest, refusals: r.refusals });
          else {
            for (const x of r.refusals) say(`  ${x.path}  ${x.rule}: ${x.detail}`);
            say(`blueprint ${r.blueprint.id} proposed (${r.refusals.length} refusal(s) to fix before approval)`);
          }
          return 0;
        }
        if (verb === 'validate' || verb === 'show') {
          if (!id) throw new Usage(`corpus blueprint ${verb} needs <bp>`);
          return await withCtx((ctx) => {
            const bp = ctx.store.blueprint(id);
            if (!bp) throw new Error(`unknown blueprint ${id}`);
            const refusals = blueprintRefusals(ctx, bp.corpusId, bp.body, list(flag(p, 'invariant-tags')));
            const stale = staleBlueprints(ctx, bp.corpusId).has(bp.id);
            if (asJson) json(verb === 'show' ? { ...bp, stale, refusals } : { blueprintId: bp.id, stale, refusals });
            else {
              for (const x of refusals) say(`  ${x.path}  ${x.rule}: ${x.detail}`);
              say(`blueprint ${bp.id} ${bp.status}${stale ? ', stale' : ''}: ${refusals.length} refusal(s)`);
            }
            return verb === 'validate' && refusals.length ? 1 : 0;
          }, true);
        }
        if (verb === 'propose') {
          if (!id || !repo) throw new Usage('corpus blueprint propose needs <corpus> <repo> --tools a');
          const r = await withCtx((ctx) => proposeBlueprints(ctx, id, path.resolve(repo), list(need(p, 'tools')), { runner }));
          if (asJson) json({ proposed: r.proposed.map((b) => b.id), refused: r.refused });
          else say(`${r.proposed.length} blueprint(s) proposed, ${r.refused.length} refused line(s)`);
          return 0;
        }
        throw new Usage('corpus blueprint needs import, validate, show or propose');
      }
      case 'packets': {
        const [verb, id, third] = p.positionals;
        if (verb === 'import') {
          if (!id) throw new Usage('corpus packets import needs <bp> --file <path>');
          const r = await withCtx((ctx) => importPackets(ctx, id, path.resolve(need(p, 'file'))));
          if (asJson) json({ packets: r.packets.map((x) => ({ id: x.id, ticketId: x.ticketId, packetDigest: x.packetDigest })), refusals: r.refusals });
          else {
            for (const x of r.refusals) say(`  ${x.path}  ${x.rule}: ${x.detail}`);
            say(r.refusals.length ? `${r.refusals.length} refusal(s); nothing recorded` : `${r.packets.length} packet(s) proposed`);
          }
          return r.refusals.length ? 1 : 0;
        }
        if (verb === 'propose') {
          if (!id || !third) throw new Usage('corpus packets propose needs <bp> <repo> --tools a');
          const r = await withCtx((ctx) => proposePackets(ctx, id, path.resolve(third), list(need(p, 'tools')), { runner }));
          if (asJson) json({ proposed: r.proposed.map((x) => x.id), refused: r.refused });
          else say(`${r.proposed.length} packet(s) proposed, ${r.refused.length} refused`);
          return 0;
        }
        if (verb === 'emit') {
          if (!id) throw new Usage('corpus packets emit needs <bp>');
          const r = await withCtx((ctx) => emitPlan(ctx, id, { lanes: [], campaignGates: [] }));
          if (asJson) json({ file: r.file, packetSetDigest: r.packetSetDigest, tickets: r.plan.tickets.length });
          else say(`wrote ${r.file} (${r.plan.tickets.length} ticket(s), packet set ${r.packetSetDigest}); commit it, then \`daylight campaign import\``);
          return 0;
        }
        if (verb === 'list') {
          if (!id) throw new Usage('corpus packets list needs <bp>');
          return await withCtx((ctx) => {
            const rows = ctx.store.packets(id);
            if (asJson) json(rows);
            else for (const x of rows) say(`${x.ticketId} ${x.id} ${x.status}`);
            return 0;
          }, true);
        }
        if (verb === 'context') {
          if (!id || !third) throw new Usage('corpus packets context needs <campaign> <ticket>');
          return await withCtx((ctx) => {
            const c = packetContext(ctx, { campaignId: id, ticketId: third });
            // Counts only: the passages themselves reach the author's prompt, not this terminal's scrollback.
            if (asJson) json({ spans: c.spans.map((s) => ({ irId: s.irId, label: s.label, docKey: s.docKey })), bytes: c.bytes, truncated: c.truncated, withheld: c.withheld });
            else say(`${c.spans.length} passage(s), ${c.bytes} bytes; ${c.withheld} withheld, ${c.truncated} left out for length`);
            return 0;
          }, true);
        }
        throw new Usage('corpus packets needs import, propose, emit, list or context');
      }
      default:
        throw new Usage(`corpus needs one of: ${CORPUS_REVIEW_SUBCOMMANDS.join(', ')}`);
    }
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    const refused = err instanceof DecisionRefused || err instanceof BlueprintRefused || err instanceof PacketsRefused;
    if (asJson) json({ error: message, refused, ...(err instanceof BlueprintRefused || err instanceof PacketsRefused ? { refusals: err.refusals } : {}) });
    else if (err instanceof BlueprintRefused || err instanceof PacketsRefused) for (const r of err.refusals) console.error(`  ${r.path}  ${r.rule}: ${r.detail}`);
    console.error(`error: ${message}`);
    return 1;
  }
}
