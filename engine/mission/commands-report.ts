import fs from 'node:fs';
import path from 'node:path';
import { mappedProject, mappedRoot, openDaylight, type DaylightContext } from './context.ts';
import {
  LEDGER_GROUPS, OUTSIDE_CONTROLS, dollarsOf, ledger, ledgerWithGaps, renderLedger, tokenCells, totalGaps, totalOf,
  type LedgerGroup, type TokenGaps,
} from './ledger.ts';
import { shortRevision } from './project.ts';
import type { AttemptOrigin, Ledger } from './types.ts';

/**
 * `daylight report --project [<id>] [--format text|json] [--group <g>] [--origin <o>]
 * [--since <iso>] [--file <path>]` — the project ledger.
 *
 * Kept out of `commands.ts`, which dispatches here when `--project` is given (the integrator
 * adds that line). JSON is one `Ledger` document for `--group` (default `runner`), so an
 * export → import → report round trip compares byte for byte. Text is the whole ledger, with
 * ingested work split out and labelled as outside Daylight's controls. Exit 2 is bad
 * arguments; exit 1 is a refusal, such as a project this output directory does not hold.
 */

class Usage extends Error {}

interface Flags {
  project: string | undefined;
  format: 'text' | 'json';
  group: LedgerGroup;
  origin: AttemptOrigin | undefined;
  since: number | undefined;
  file: string | undefined;
}

function parseFlags(argv: string[]): Flags {
  const seen = new Map<string, string | undefined>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    const value = eq >= 0 ? a.slice(eq + 1)
      : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : undefined;
    seen.set(key, value);
  }
  if (!seen.has('project')) throw new Usage('report --project needs --project');
  const format = seen.get('format') ?? 'text';
  if (format !== 'text' && format !== 'json' && format !== 'markdown') throw new Usage('--format must be text or json');
  const group = (seen.get('group') ?? 'runner') as LedgerGroup;
  if (!LEDGER_GROUPS.includes(group)) throw new Usage(`--group must be one of ${LEDGER_GROUPS.join(', ')}`);
  const origin = seen.get('origin') as AttemptOrigin | undefined;
  if (origin !== undefined && origin !== 'daylight' && origin !== 'ingested') throw new Usage('--origin must be daylight or ingested');
  const rawSince = seen.get('since');
  const since = rawSince === undefined ? undefined : Date.parse(rawSince);
  if (since !== undefined && !Number.isFinite(since)) throw new Usage(`--since is not a date: ${rawSince}`);
  return { project: seen.get('project'), format: format === 'json' ? 'json' : 'text', group, origin, since, file: seen.get('file') };
}

/**
 * The project the ledger is for. A named id must be one this directory holds, and the one its
 * map is of when it has a map; a bare `--project` means the mapped project.
 */
export function resolveProject(ctx: DaylightContext, asked: string | undefined): string {
  const mapped = mappedRoot(ctx.out) ? mappedProject(ctx.out)?.id ?? null : null;
  const held = [...new Set(ctx.store.missions().map((m) => m.projectId))];
  const id = asked ?? mapped ?? (held.length === 1 ? held[0] : undefined);
  if (!id) throw new Error(`${ctx.out} holds no single project; name one with --project <id>`);
  if (!ctx.store.project(id) || (mapped !== null && id !== mapped)) {
    throw new Error(`project ${id} is not the project ${ctx.out} holds; a ledger is read only from its own directory`);
  }
  return id;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function totalLine({ ledger: l, gaps }: { ledger: Ledger; gaps: TokenGaps }): string {
  const t = totalOf(l.rows);
  if (!t.attempts) return 'no attempts';
  const [input, output, cacheRead, cacheWrite] = tokenCells(t, totalGaps(gaps, l.rows.map((r) => r.key)));
  const tokens = `tokens in ${input}, out ${output}, cache read ${cacheRead}, cache write ${cacheWrite}`
    + (t.tokens.unknownCount ? ` (${t.tokens.unknownCount} attempt(s) reported none)` : '');
  return `${t.attempts} attempt(s), dollars ${dollarsOf(t)}, ${tokens}`;
}

/** The whole project ledger as markdown. Every figure is from attempt rows. */
export function projectReportText(ctx: DaylightContext, projectId: string, since?: number): string {
  const detail = (group: LedgerGroup, origin?: AttemptOrigin) => ledgerWithGaps(ctx, { projectId, group, since, origin });
  const table = (group: LedgerGroup, origin: AttemptOrigin | undefined, heading: string, keyLabel: string) => {
    const d = detail(group, origin);
    return renderLedger(d.ledger, { heading, keyLabel, gaps: d.gaps });
  };
  const project = ctx.store.project(projectId);
  const allDetail = detail('runner');
  const all = allDetail.ledger;
  const out: string[] = [];
  out.push(`# Ledger — project \`${projectId}\`${project ? ` (${project.name})` : ''}`, '');
  out.push(
    'Every figure comes from attempt rows. Dollars are the provider\'s own figures; **unknown** means no provider '
      + 'reported one, never zero, and nothing here is estimated from tokens. A scanned figure was read out of '
      + 'output by pattern: it counts against a budget and is not known. `≥` marks a floor.',
    '',
  );
  out.push('## Totals', '');
  out.push(`- Daylight: ${totalLine(detail('runner', 'daylight'))}`);
  out.push(`- Ingested — ${OUTSIDE_CONTROLS}: ${totalLine(detail('runner', 'ingested'))}`);
  out.push(`- All: ${totalLine(allDetail)}`, '');

  out.push(table('runner', 'daylight', 'Daylight attempts by runner', 'runner'));
  out.push(table('model', 'daylight', 'Daylight attempts by model', 'model'));
  out.push(table('runner', 'ingested', `Ingested attempts by runner — ${OUTSIDE_CONTROLS}`, 'runner'));
  out.push(table('model', 'ingested', `Ingested attempts by model — ${OUTSIDE_CONTROLS}`, 'model'));
  out.push(table('origin', undefined, 'Attempts by origin', 'origin'));

  out.push('## Decisions by actor', '');
  if (!all.decisions.length) out.push('No decisions.');
  else {
    out.push('| actor | kind | operation | count |', '|---|---|---|---:|');
    for (const d of all.decisions) out.push(`| \`${cell(d.actor)}\` | ${d.kind} | ${d.operation ?? '—'} | ${d.count} |`);
  }
  out.push('', '## Work items', '');
  if (!all.workItems.length) out.push('No work items.');
  for (const w of all.workItems) out.push(`- \`${w.id}\` "${cell(w.title)}" — ${w.status} (spec mission \`${w.missionId}\`)`);

  const c = totalOf(all.rows).candidates;
  out.push('', '## Candidates', '');
  out.push(`accepted by gates ${c.accepted} · rejected ${c.rejected} · applied ${c.applied} · overridden ${c.overridden}`);

  out.push('', '## Applications', '');
  if (!all.applications.length) out.push('No applications.');
  for (const p of all.applications) {
    out.push(`- \`${p.id}\` candidate \`${p.candidateId}\` → \`${p.commit.slice(0, 12)}\` on \`${cell(p.ref)}\`, applied by \`${cell(p.appliedBy)}\` (decision \`${p.decisionId}\`, mission \`${p.missionId}\`)`);
  }

  out.push('', '## Revisions', '');
  if (!all.revisions.length) out.push('No missions.');
  for (const r of all.revisions) out.push(`- \`${shortRevision(r.revision)}\` — ${r.missions} mission(s), ${r.attempts} attempt(s)`);
  out.push('');
  return out.join('\n');
}

/** Entry for `daylight report --project …`; `argv` is everything after `report`. */
export function runProjectReport(argv: string[], out: () => string): number {
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    console.error(`usage: ${(err as Error).message}`);
    return 2;
  }
  let ctx: DaylightContext | null = null;
  try {
    ctx = openDaylight(out());
    const projectId = resolveProject(ctx, flags.project);
    const text = flags.format === 'json'
      ? `${JSON.stringify(ledger(ctx, { projectId, group: flags.group, since: flags.since, origin: flags.origin }), null, 2)}\n`
      : projectReportText(ctx, projectId, flags.since);
    if (flags.file) {
      fs.mkdirSync(path.dirname(path.resolve(flags.file)), { recursive: true });
      fs.writeFileSync(flags.file, text);
      process.stdout.write(`wrote ${flags.file}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (flags.format === 'json') process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    console.error(`error: ${message}`);
    return 1;
  } finally {
    ctx?.close();
  }
}
