import path from 'node:path';
import { mappedProject, openDaylight } from '../mission/context.ts';
import { redact } from '../mission/redact.ts';
import type { WorkItem, WorkItemStatus } from '../mission/types.ts';
import { confirmDigest } from './confirm.ts';
import { DecisionRefused } from './policy.ts';
import { decideWorkItem, listWorkItems, showWorkItem } from './work-items.ts';

/**
 * `daylight work-item list | show <w> | approve <w> | reject <w>`. WS8 adds the dispatch line;
 * this module is the whole command and is tested through `runWorkItemCommand`.
 *
 * Same contract as the mission commands: `--format json` puts one JSON document on stdout;
 * exit 0 ran, 2 bad arguments, 1 failed, and a refused decision is a failure (exit 1) whose
 * reason is printed, never the confirm code it expected.
 *
 * Text that came from a decomposer (titles, statements, examples) is printed as plain lines,
 * redacted, with control characters already refused at ingest: it is data a person reads, and
 * the terminal is not a place for it to do anything else.
 */

export interface WorkItemIo {
  /** `--out`, already resolved by the dispatcher. */
  out: string;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

class Usage extends Error {}

const STATUSES: WorkItemStatus[] = ['proposed', 'approved', 'rejected', 'superseded'];

function parse(argv: string[]): { positionals: string[]; flags: Map<string, string> } {
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

const plain = (s: string) => redact(s).text;

function render(w: WorkItem): string[] {
  return [
    `${w.id}  ${w.status}  ${w.anchor}`,
    `  title: ${plain(w.title)}`,
    `  digest: ${w.contentDigest}`,
    `  proposed by ${w.proposedBy}${w.attemptId ? ` in ${w.attemptId}` : ''} on ${w.specRevision}`,
  ];
}

export function runWorkItemCommand(argv: string[], io: WorkItemIo): number {
  const [sub, ...rest] = argv;
  const p = parse(rest);
  const asJson = p.flags.get('format') === 'json';
  const json = (d: unknown) => io.stdout(`${JSON.stringify(d, null, 2)}\n`);
  const say = (line: string) => io.stdout(`${line}\n`);
  const need = (k: string) => {
    const v = p.flags.get(k);
    if (v === undefined || v === 'true') throw new Usage(`--${k} is required`);
    return v;
  };
  const ctx = (() => {
    try {
      return openDaylight(path.resolve(io.out));
    } catch (err) {
      io.stderr(`error: ${(err as Error).message}\n`);
      return null;
    }
  })();
  if (!ctx) return 1;
  try {
    switch (sub) {
      case 'list': {
        const project = mappedProject(ctx.out);
        if (!project) throw new Error(`${ctx.out} holds no map`);
        const status = p.flags.get('status') as WorkItemStatus | undefined;
        if (status !== undefined && !STATUSES.includes(status)) throw new Usage(`--status is one of ${STATUSES.join(', ')}`);
        const r = listWorkItems(ctx, project.id, { missionId: p.flags.get('mission'), status });
        if (asJson) json(r);
        else {
          if (!r.workItems.length) say('no work items');
          for (const w of r.workItems) for (const l of render(w)) say(l);
          for (const n of r.needs) say(`need: ${n.kind} ${n.ref} — ${n.why}`);
        }
        return 0;
      }
      case 'show': {
        const id = p.positionals[0];
        if (!id) throw new Usage('work-item show <w_…>');
        const v = showWorkItem(ctx, id);
        if (asJson) json(v);
        else {
          for (const l of render(v.workItem)) say(l);
          say('  statement:');
          for (const l of plain(v.workItem.statement).split('\n')) say(`    ${l}`);
          for (const e of v.workItem.examples) say(`  example: ${plain(e)}`);
          for (const e of v.workItem.negativeExamples) say(`  must not: ${plain(e)}`);
          if (v.decision) say(`  decided: ${v.decision.kind} by ${v.decision.actor} (${v.decision.id})`);
          if (v.consumedBy) say(`  built by mission ${v.consumedBy}`);
          if (v.tampered) say('  WARNING: the stored fields no longer hash to this digest');
          say(`  to decide: --confirm <first 8 hex of ${v.confirm.digest.replace(/^sha256:/, '')}>`);
        }
        return 0;
      }
      case 'approve':
      case 'reject': {
        const id = p.positionals[0];
        if (!id) throw new Usage(`work-item ${sub} <w_…> --actor human:<name> --rationale … --confirm <digest8>`);
        if (p.flags.get('confirm') === undefined) {
          // As `mission decide` does: show what would be confirmed, decide nothing, exit 2.
          if (!ctx.store.workItem(id)) throw new Error(`unknown work item ${id}`);
          const c = confirmDigest(ctx, sub === 'approve' ? 'approve-work-item' : 'reject-work-item', id);
          if (asJson) json({ confirm: 'required', digest: c.digest, lines: c.lines });
          else for (const l of [...c.lines, `digest ${c.digest}`]) say(plain(l));
          io.stderr("usage: re-run with --rationale '<why>' --confirm <the first eight hex characters of the digest>\n");
          return 2;
        }
        const { decision, workItem } = decideWorkItem(ctx, {
          id, kind: sub, actor: need('actor'), rationale: need('rationale'), confirm: p.flags.get('confirm'), env: io.env,
        });
        if (asJson) json({ decision, workItem });
        else say(`${workItem.id} ${workItem.status} by ${decision.actor} (${decision.id})`);
        return 0;
      }
      default:
        throw new Usage('work-item list | show <w> | approve <w> | reject <w>');
    }
  } catch (err) {
    if (err instanceof Usage) {
      io.stderr(`usage: ${err.message}\n`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) json({ error: message, refused: err instanceof DecisionRefused });
    io.stderr(`error: ${message}\n`);
    return 1;
  } finally {
    ctx.close();
  }
}
