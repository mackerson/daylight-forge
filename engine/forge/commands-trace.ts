import fs from 'node:fs';
import path from 'node:path';
import { defaultOut } from '../paths.ts';
import { openDaylight } from '../mission/context.ts';
import { isEntityId, type SpanRef, type TraceMatrix, type TraceReport } from '../mission/types.ts';
import { AGENT_SESSION_VARS } from './policy.ts';
import { safeExcerpt } from './coverage.ts';
import { holdoutPaths } from './campaign-gates.ts';
import { renderTraceMarkdown, traceBackward, traceForward, traceMatrix } from './trace.ts';

/**
 * `daylight trace …` (spec ingestion §10). Every subcommand is read-only and allowed in an agent
 * session (P2-R24); only `matrix --write`, which writes under `<out>`, is refused there.
 *
 *   trace passage <corpus> --doc K (--section <id> | --label §11.3 | --range a-b) [--revision cr_…]
 *   trace requirement <ir_…>
 *   trace ticket <campaign> <ticketId>
 *   trace landing <commit | i_… | c_…> [--campaign m_…]
 *   trace matrix <campaign> [--write]
 *
 * `--format json` prints the report; otherwise markdown with excerpts through `safeExcerpt`
 * (a holdout basename of any campaign, or a secret-shaped span, withholds an excerpt and is counted). Exit 0 ran, 2 bad arguments or a
 * refusal, 1 the trace failed.
 */

export const TRACE_SUBCOMMANDS = ['passage', 'requirement', 'ticket', 'landing', 'matrix'] as const;

class Usage extends Error {}

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
    if (flags.has(key)) throw new Usage(`--${key} given twice`);
    if (eq >= 0) flags.set(key, a.slice(eq + 1));
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags.set(key, argv[++i]);
    else flags.set(key, 'true');
  }
  return { positionals, flags };
}

const agentSession = (env: NodeJS.ProcessEnv) => AGENT_SESSION_VARS.some((k) => env[k] !== undefined && env[k] !== '');

export async function runTraceCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [sub, ...rest] = argv;
  let asJson = false;
  try {
    const { positionals, flags } = parse(rest);
    const format = flags.get('format') ?? 'md';
    if (format !== 'json' && format !== 'md') throw new Usage('--format is json or md');
    asJson = format === 'json';
    const known = new Set(['out', 'format', 'doc', 'section', 'label', 'range', 'revision', 'campaign', 'write']);
    for (const k of flags.keys()) if (!known.has(k)) throw new Usage(`unknown flag --${k}`);
    if (!(TRACE_SUBCOMMANDS as readonly string[]).includes(sub ?? '')) throw new Usage(`trace needs one of: ${TRACE_SUBCOMMANDS.join(', ')}`);
    const write = flags.get('write') === 'true';
    if (write && sub !== 'matrix') throw new Usage('--write is for trace matrix only');
    if (write && agentSession(env)) {
      console.error('refused: trace matrix --write writes under <out> and is not run from an agent session (P2-R24); run it without --write');
      return 2;
    }
    const explicit = flags.get('out');
    const out = explicit && explicit !== 'true' ? path.resolve(explicit) : defaultOut(process.cwd());
    const ctx = openDaylight(out);
    try {
      let report: TraceReport | TraceMatrix;
      switch (sub) {
        case 'passage': {
          const [corpusId] = positionals;
          const docKey = flags.get('doc');
          if (!corpusId || !docKey) throw new Usage('trace passage <corpus> --doc K (--section <id> | --label <label> | --range a-b)');
          const chosen = ['section', 'label', 'range'].filter((k) => flags.has(k));
          if (chosen.length !== 1) throw new Usage('trace passage takes exactly one of --section, --label, --range');
          let range: [number, number] | undefined;
          if (flags.has('range')) {
            const m = /^(\d+)-(\d+)$/.exec(flags.get('range')!);
            if (!m) throw new Usage('--range is two byte offsets a-b');
            range = [Number(m[1]), Number(m[2])];
          }
          report = traceForward(ctx, { corpusId, docKey, sectionId: flags.get('section'), label: flags.get('label'), range, revisionId: flags.get('revision') });
          break;
        }
        case 'requirement': {
          const [irId] = positionals;
          if (!irId || !isEntityId('irRecord', irId)) throw new Usage('trace requirement <ir_…>');
          report = traceForward(ctx, { irId });
          break;
        }
        case 'ticket': {
          const [campaignId, ticketId] = positionals;
          if (!campaignId || !ticketId) throw new Usage('trace ticket <campaign> <ticketId>');
          report = traceBackward(ctx, { campaignId, ticketId });
          break;
        }
        case 'landing': {
          const [what] = positionals;
          if (!what) throw new Usage('trace landing <commit | i_… | c_…> [--campaign m_…]');
          if (isEntityId('integration', what)) report = traceBackward(ctx, { integrationId: what });
          else if (isEntityId('candidate', what)) report = traceBackward(ctx, { candidateId: what });
          else report = traceBackward(ctx, { commit: what, campaignId: flags.get('campaign') });
          break;
        }
        default: {
          const [campaignId] = positionals;
          if (!campaignId) throw new Usage('trace matrix <campaign> [--write]');
          report = traceMatrix(ctx, campaignId);
        }
      }
      const holdouts = new Set<string>();
      for (const m of ctx.store.missions()) {
        if (m.kind !== 'campaign') continue;
        for (const p of holdoutPaths(ctx, m.id)) holdouts.add(path.basename(p));
      }
      const excerpt = (s: SpanRef) => safeExcerpt(ctx, s, { holdoutBasenames: holdouts });
      if (write && report.kind === 'daylight-trace-matrix') {
        const dir = path.join(ctx.out, 'campaigns', report.campaignId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'trace-matrix.json'), `${JSON.stringify(report, null, 2)}\n`);
        fs.writeFileSync(path.join(dir, 'trace-matrix.md'), renderTraceMarkdown(report, excerpt));
      }
      process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderTraceMarkdown(report, excerpt));
      return 0;
    } finally {
      ctx.close();
    }
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    console.error(`error: ${message}`);
    return 1;
  }
}
