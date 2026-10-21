import path from 'node:path';
import { defaultOut } from '../paths.ts';
import { mappedProject, mappedRoot, openDaylight, type DaylightContext } from '../mission/context.ts';
import type { IngestSource } from '../mission/types.ts';
import { ingestClaudeCode, isSessionId, OUTSIDE_CONTROLS, SessionRefused, type SkippedCounts } from './claude-code.ts';
import { runIngestBench } from './bench.ts';

/**
 * `daylight ingest claude-code --out <out> (--session <uuid> | --all) [--format json]` and
 * `daylight ingest list --out <out> [--format json]`.
 *
 * The project and the transcript directory both come from `<out>`'s map (R12.3), never from
 * an argument, so nothing here can point the ingester at another project's sessions. Exit 0
 * ran, 2 bad arguments or a refused session, 1 the command failed — as in mission/commands.ts.
 */

class Usage extends Error {}

function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Usage(`unexpected argument ${a}`);
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let value = 'true';
    if (eq >= 0) value = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i];
    out.set(key, value);
  }
  return out;
}

/**
 * What `ingest list` prints: the cursors, and the skip counts of the last `--all` run that
 * ingested anything (else the last such `--session` run), or null if none has.
 */
export interface IngestListing {
  projectId: string;
  controls: typeof OUTSIDE_CONTROLS;
  sources: IngestSource[];
  skipped: SkippedCounts | null;
  sessions: { seen: number; ingested: number; unchanged: number } | null;
}

export function ingestList(ctx: DaylightContext, projectId: string): IngestListing {
  // The run event carries no mission, so it is found by scanning; the newest scan of the whole
  // directory wins, because a one-session run never sees the other sessions it would skip.
  let last: Record<string, unknown> | null = null;
  let lastAll: Record<string, unknown> | null = null;
  for (let after = 0; ;) {
    const page = ctx.events.since(after, {}, 5000);
    if (!page.length) break;
    for (const e of page) {
      if (e.name !== 'ingest.run.finished' || e.projectId !== projectId) continue;
      last = e.payload;
      if (e.payload.mode === 'all') lastAll = e.payload;
    }
    after = page[page.length - 1].sequence;
  }
  last = lastAll ?? last;
  return {
    projectId,
    controls: OUTSIDE_CONTROLS,
    sources: ctx.store.ingestSources(projectId),
    skipped: (last?.skipped as SkippedCounts | undefined) ?? null,
    sessions: (last?.sessions as IngestListing['sessions'] | undefined) ?? null,
  };
}

const print = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);

/**
 * Entry for the dispatcher: `argv` starts after `ingest`. `env.projectsDir` overrides where
 * Claude Code's transcripts are looked for; the CLI leaves it to `$CLAUDE_CONFIG_DIR`.
 *
 * `ingest bench` is asynchronous and returns a promise that never rejects; the dispatcher
 * (`runForgeCli`, an async function) returns whatever this returns, so either form is awaited.
 */
export function runIngestCommand(argv: ['bench', ...string[]], env?: { projectsDir?: string; process?: NodeJS.ProcessEnv }): Promise<number>;
export function runIngestCommand(argv: string[], env?: { projectsDir?: string; process?: NodeJS.ProcessEnv }): number;
export function runIngestCommand(argv: string[], env: { projectsDir?: string; process?: NodeJS.ProcessEnv } = {}): number | Promise<number> {
  if (argv[0] === 'bench') return runIngestBench(argv.slice(1), env.process ?? process.env);
  const [sub, ...rest] = argv;
  let asJson = false;
  try {
    const f = flags(rest);
    asJson = f.get('format') === 'json';
    const explicit = f.get('out');
    const out = explicit && explicit !== 'true' ? path.resolve(explicit) : defaultOut(process.cwd());
    switch (sub) {
      case 'claude-code': {
        const session = f.get('session');
        const all = f.get('all') === 'true';
        if ((session === undefined) === !all) throw new Usage('ingest claude-code needs exactly one of --session <id> or --all');
        if (session !== undefined && !isSessionId(session)) throw new Usage('--session takes a lowercase uuid');
        const root = mappedRoot(out);
        if (!root) throw new Error(`${out} holds no map; run \`daylight map <repo> --out ${out}\` first`);
        const ctx = openDaylight(out);
        try {
          const r = ingestClaudeCode(ctx, root, { session, all, projectsDir: env.projectsDir });
          if (asJson) print(r);
          else {
            process.stdout.write(
              `ingested ${r.sessions.ingested} of ${r.sessions.seen} session(s) into ${r.projectId} ` +
                `(${r.attempts} new attempt(s), ${r.turns} turn(s); ${OUTSIDE_CONTROLS}); ` +
                `skipped ${r.skipped.foreign} foreign, ${r.skipped.unresolvable} unresolvable, ` +
                `${r.skipped.corruptLines} corrupt line(s)\n`,
            );
          }
        } finally {
          ctx.close();
        }
        return 0;
      }
      case 'list': {
        const project = mappedProject(out);
        if (!project) throw new Error(`${out} holds no map`);
        const ctx = openDaylight(out);
        try {
          const listing = ingestList(ctx, project.id);
          if (asJson) print(listing);
          else {
            for (const s of listing.sources) {
              process.stdout.write(`${s.sessionId}${s.agentId ? `/${s.agentId}` : ''} ${s.linesSeen} line(s) → ${s.attemptId}\n`);
            }
          }
        } finally {
          ctx.close();
        }
        return 0;
      }
      default:
        throw new Usage('ingest needs one of: claude-code, list, bench');
    }
  } catch (err) {
    if (err instanceof Usage || err instanceof SessionRefused) {
      console.error(`${err instanceof Usage ? 'usage' : 'refused'}: ${err.message}`);
      if (asJson && err instanceof SessionRefused) print({ error: err.message, refused: true });
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) print({ error: message });
    console.error(`error: ${message}`);
    return 1;
  }
}

