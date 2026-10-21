import fs from 'node:fs';
import path from 'node:path';
import { mappedRoot, openDaylight, type DaylightContext } from '../mission/context.ts';
import { DAYLIGHT_DB } from '../mission/db.ts';
import { defaultOut } from '../paths.ts';
import { buildWaveReport, campaignList, renderWaveReport, reportFileName, type ReportScope } from './campaign-report.ts';
import { parse, Usage } from './commands.ts';
import { sessionRefusal } from './commands-campaign.ts';
import { DecisionRefused } from './policy.ts';
import { readRefine, RefineRefused, refineReport } from './refine.ts';

/**
 * `daylight campaign list|report|refine` (WS-R8, docs/daylight/REFINE.md), dispatched from
 * `runCampaignCommand`'s default case after its agent-session refusal (P2-R24, P2-R40):
 *
 *   list [<repo>] [--format json]
 *   report <c> [<repo>] [--wave <n> | --open | --all] [--format json|md] [--write]
 *   refine <c> [<repo>] [--rev <sha>] [--rows-only | --cached] [--format json]
 *
 * `list` and `report` read rows and refs only; `report --write` writes
 * `<out>/campaigns/<c>/reports/<name>.{json,md}` and is refused in an agent session; `refine`
 * writes derived map files and `refine.json` under `<out>` only, so it runs there. `<repo>`
 * names the project and derives the default `--out`. Exit 0 ran, 1 refused or failed, 2 usage.
 */

export const CAMPAIGN_REPORT_SUBCOMMANDS = ['list', 'report', 'refine'] as const;

export interface CampaignReportDeps {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/** `argv` starts at the subcommand, as `runCampaignCommand`'s does. Returns the exit code. */
export async function runCampaignReportCommand(argv: string[], env: NodeJS.ProcessEnv = process.env, deps: CampaignReportDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const [sub, ...rest] = argv;
  const p = parse(rest);
  const last = (k: string) => p.flags.get(k)?.at(-1);
  const on = (k: string) => last(k) === 'true';
  const asJson = last('format') === 'json';
  const json = (d: unknown) => stdout(`${JSON.stringify(d, null, 2)}\n`);
  const say = (l: string) => stdout(`${l}\n`);
  try {
    if (!sub || !(CAMPAIGN_REPORT_SUBCOMMANDS as readonly string[]).includes(sub)) throw new Usage(`campaign needs one of: ${CAMPAIGN_REPORT_SUBCOMMANDS.join(', ')}`);
    const format = last('format');
    if (format !== undefined && format !== 'json' && !(sub === 'report' && format === 'md')) throw new Usage(`--format is json${sub === 'report' ? ' or md' : ''}`);
    const campaignId = sub === 'list' ? undefined : p.positionals[0];
    if (sub !== 'list' && !campaignId) throw new Usage(`campaign ${sub} needs a <campaign>`);
    const repoArg = sub === 'list' ? p.positionals[0] : p.positionals[1];
    const explicit = last('out');
    const out = explicit && explicit !== 'true' ? path.resolve(explicit) : defaultOut(repoArg ?? process.cwd());
    // A read-only command never creates a database it was pointed at by mistake (P2-R24).
    if (!fs.existsSync(path.join(out, DAYLIGHT_DB))) throw new Error(`${out} holds no Daylight database; nothing to read`);
    const withCtx = <T>(fn: (ctx: DaylightContext) => T): T => {
      const ctx = openDaylight(out);
      try {
        return fn(ctx);
      } finally {
        ctx.close();
      }
    };
    const repoOf = (ctx: DaylightContext): string => {
      const root = repoArg ? path.resolve(repoArg) : mappedRoot(ctx.out) ?? ctx.store.project(ctx.store.mission(campaignId!)?.projectId ?? '')?.root ?? null;
      if (!root) throw new Usage(`${ctx.out} holds no map; name the repository`);
      return root;
    };

    switch (sub) {
      case 'list': {
        const l = withCtx((ctx) => campaignList(ctx));
        if (asJson) json(l);
        else {
          if (!l.campaigns.length) say('no campaigns');
          for (const c of l.campaigns) {
            say(`${c.id}  ${c.state.padEnd(8)} ${c.title ?? '(no plan)'}`);
            say(`  ${c.tickets} ticket(s): ${Object.entries(c.byBucket).filter(([, n]) => n).map(([b, n]) => `${n} ${b}`).join(', ') || 'none derived'}; ${c.needs} need(s)`
              + `${c.halted ? `; halted (${c.halted})` : ''}${c.run ? (c.run.alive ? `; running, pid ${c.run.pid}` : `; claim left by pid ${c.run.pid}, not running`) : ''}`);
            if (c.unavailable) say(`  ${c.unavailable}`);
          }
        }
        return 0;
      }
      case 'report': {
        const picked = [last('wave') !== undefined, on('open'), on('all')].filter(Boolean).length;
        if (picked > 1) throw new Usage('--wave, --open and --all pick one scope');
        let scope: ReportScope | undefined;
        if (last('wave') !== undefined) {
          const seq = Number(last('wave'));
          if (!Number.isInteger(seq) || seq < 1) throw new Usage('--wave is a wave number, 1 or more');
          scope = { kind: 'wave', seq };
        } else if (on('open')) scope = { kind: 'open' };
        else if (on('all')) scope = { kind: 'all' };
        const write = p.flags.has('write');
        if (write) {
          // R5's dispatcher refused this already; checked again for a direct caller.
          const why = sessionRefusal(env, 'campaign report --write');
          if (why) throw new DecisionRefused(why);
        }
        const r = withCtx((ctx) => buildWaveReport(ctx, campaignId!, repoOf(ctx), scope ? { scope } : {}));
        const md = renderWaveReport(r);
        if (write) {
          const dir = path.join(out, 'campaigns', campaignId!, 'reports');
          fs.mkdirSync(dir, { recursive: true });
          const name = reportFileName(r.scope, r.integration.tip);
          fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(r, null, 2)}\n`);
          fs.writeFileSync(path.join(dir, `${name}.md`), md);
        }
        if (asJson) json(r);
        else stdout(md);
        return 0;
      }
      case 'refine': {
        if (on('rows-only') && on('cached')) throw new Usage('--rows-only and --cached are exclusive');
        const rev = last('rev');
        if (rev !== undefined && !/^[0-9a-f]{7,64}$/.test(rev)) throw new Usage('--rev is a commit sha');
        const r = withCtx((ctx) => {
          if (on('cached')) {
            const cached = readRefine(ctx.out, campaignId!, repoOf(ctx));
            if (!cached) throw new Error(`no refine of ${campaignId} is cached; run \`daylight campaign refine ${campaignId}\``);
            return cached;
          }
          return refineReport(ctx, campaignId!, repoOf(ctx), { ...(rev ? { rev } : {}), rowsOnly: on('rows-only') });
        });
        if (asJson) json(r);
        else {
          say(`refine of ${r.campaignId}: ${r.base.slice(0, 12)}..${r.rev.slice(0, 12)} (${r.integrationRef})${r.stale ? ' — stale: the integration tip moved since' : ''}`);
          say(`${r.changed.length} file(s) changed${r.maps ? `; maps under ${r.maps.rev.dir}` : '; no map (rows only)'}`);
          if (r.findings) {
            const f = r.findings;
            say(`introduced: ${f.duplication.introduced.length} duplicated familie(s), ${f.deadEnds.introduced.length} dead end(s), ${f.cycles.introduced.length} cycle(s); `
              + `invariants ${f.invariants.regressed} regressed, ${f.invariants.fixed} fixed`);
          }
          const tierOf = new Map(r.focusRules.map((x) => [x.kind, x.tier]));
          for (const i of r.focus) say(`  [${tierOf.get(i.kind)}] ${i.kind} ${i.ref}: ${i.title.replace(/[\r\n]+/g, ' ')} (${i.why.replace(/[\r\n]+/g, ' ')})`);
        }
        return 0;
      }
    }
    throw new Usage(`unknown campaign subcommand ${sub}`);
  } catch (err) {
    if (err instanceof Usage) {
      stderr(`usage: ${err.message}\n`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    const refused = err instanceof DecisionRefused || err instanceof RefineRefused;
    if (asJson) json({ error: message, refused });
    stderr(`error: ${message}\n`);
    return 1;
  }
}
