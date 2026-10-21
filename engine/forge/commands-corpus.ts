import fs from 'node:fs';
import path from 'node:path';
import { openDaylight, type DaylightContext } from '../mission/context.ts';
import { runMission, type OutboxRunner } from '../mission/orchestrate.ts';
import type { IrKind, IrStatus } from '../mission/types.ts';
import { IR_KINDS } from '../mission/types.ts';
import { defaultOut } from '../paths.ts';
import { parseSpec } from '../swarm/adapters.ts';
import { corpusOf, CorpusRefused, registerCorpus } from './corpus.ts';
import { coverageOf, fencedBlocksOf, holdoutBasenamesOf, renderCoverageMarkdown, safeExcerpt } from './coverage.ts';
import { extract } from './extract.ts';
import { AGENT_SESSION_VARS } from './policy.ts';
import { windowsOf } from './sectioner.ts';
import { SpecRefused } from './spec.ts';

/**
 * `daylight corpus …` (spec ingestion §5):
 *
 *   corpus register <repo> --manifest daylight.corpus.json [--rev HEAD] [--project alias=<repo>[@rev]]… [--format json]
 *   corpus show|sections <corpus> [--revision cr_…] [--doc K] [--format json]
 *   corpus extract <corpus> <repo> --tools a,b [--windows win1,…] [--force] [--timeout s] [--format json]
 *   corpus coverage <corpus> [--revision cr_…] [--format json|md] [--write]
 *   corpus ir list <corpus> [--status s] [--kind k] [--section id] [--stale] [--format json]
 *
 * `register` and `extract` are refused under CLAUDECODE or DAYLIGHT_SESSION unless every tool is a
 * mock (P2-R50 Q5; register names no tool, so it is refused there); `coverage --write` is refused
 * there too (P2-R40). `show`, `sections`, `coverage` and `ir list` are read-only and run anywhere
 * (P2-R24). Contract as the other Forge commands: `--out`, `--format json`, exit 0 when it ran, 2
 * for bad arguments, 1 for a refusal or a failure.
 */

export const CORPUS_SUBCOMMANDS = ['register', 'show', 'sections', 'extract', 'coverage', 'ir'] as const;

class Usage extends Error {}

interface Parsed { positionals: string[]; flags: Map<string, string[]> }

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let value: string;
    if (eq >= 0) value = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i];
    else value = 'true';
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { positionals, flags };
}

const last = (p: Parsed, k: string): string | undefined => {
  const v = p.flags.get(k)?.at(-1);
  return v === 'true' ? undefined : v;
};
const need = (p: Parsed, k: string): string => {
  const v = last(p, k);
  if (v === undefined) throw new Usage(`--${k} is required`);
  return v;
};
const list = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const json = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
const say = (line: string) => process.stdout.write(`${line}\n`);

/** Why an agent session may not run this, or null (P2-R50 Q5, P2-R40). */
export function corpusSessionRefusal(sub: string | undefined, p: Parsed, env: NodeJS.ProcessEnv): string | null {
  const set = AGENT_SESSION_VARS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (!set.length) return null;
  const why = `refused: ${set.join(' and ')} is set, so an agent is running this`;
  if (sub === 'register') return `${why}; corpus register is run by a person from their own shell`;
  if (sub === 'extract') {
    const tools = list(last(p, 'tools'));
    if (!tools.length || tools.some((t) => parseSpec(t).tool !== 'mock')) return `${why}; corpus extract runs real extractors only from a person's shell (mocks are allowed)`;
  }
  if (sub === 'coverage' && p.flags.has('write')) return `${why}; coverage --write writes under <out> and is run from a person's shell`;
  return null;
}

/** `--project alias=<repo>[@rev]`, repeatable. */
function projectsOf(p: Parsed): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of p.flags.get('project') ?? []) {
    const eq = v.indexOf('=');
    if (eq <= 0 || eq === v.length - 1) throw new Usage('--project takes alias=<repo>[@rev]');
    const alias = v.slice(0, eq);
    if (out[alias] !== undefined) throw new Usage(`--project ${alias} is given twice`);
    out[alias] = v.slice(eq + 1);
  }
  return out;
}

const defaultRunner = (timeoutMs: number | undefined): OutboxRunner => async (ctx, run) => {
  await runMission(ctx, { missionId: run.missionId, repo: run.repo, tools: run.tools, outbox: run.outbox, timeoutMs: run.timeoutMs ?? timeoutMs });
};

async function withContext<T>(out: string, fn: (ctx: DaylightContext) => Promise<T> | T): Promise<T> {
  const ctx = openDaylight(out);
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

export async function runCorpusCommand(argv: string[], env: NodeJS.ProcessEnv, deps: { runner?: OutboxRunner } = {}): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const p = parse(argv.slice(sub ? 1 : 0));
  const asJson = last(p, 'format') === 'json';
  try {
    if (!sub || !(CORPUS_SUBCOMMANDS as readonly string[]).includes(sub)) throw new Usage(`corpus needs one of: ${CORPUS_SUBCOMMANDS.join(', ')}`);
    const refusal = corpusSessionRefusal(sub, p, env);
    if (refusal) throw new CorpusRefused(refusal);
    const explicitOut = last(p, 'out');
    const outFor = (repo: string | undefined) => (explicitOut ? path.resolve(explicitOut) : defaultOut(repo ?? process.cwd()));
    switch (sub) {
      case 'register': {
        const repo = p.positionals[0];
        if (!repo) throw new Usage('corpus register needs <repo> --manifest <repo-relative path>');
        const rev = await withContext(outFor(repo), (ctx) => registerCorpus(ctx, path.resolve(repo), need(p, 'manifest'), { rev: last(p, 'rev'), projects: projectsOf(p) }));
        if (asJson) json(rev);
        else {
          say(`registered corpus ${rev.corpusId} revision ${rev.id} (${rev.corpusDigest})`);
          say(`${rev.docs.length} document(s), sections ${rev.sectionSetDigest.slice(0, 19)}, config ${rev.configDigest.slice(0, 19)}`);
          for (const [a, b] of rev.unordered) say(`unordered: ${a} ⟷ ${b} (a conflict between them stays open)`);
        }
        return 0;
      }
      case 'show':
      case 'sections': {
        const corpusId = p.positionals[0];
        if (!corpusId) throw new Usage(`corpus ${sub} needs <corpus>`);
        return await withContext(outFor(undefined), (ctx) => {
          const c = corpusOf(ctx, corpusId, last(p, 'revision'));
          const doc = last(p, 'doc');
          const docs = c.index.docs.filter((d) => !doc || d.key === doc);
          if (doc && !docs.length) throw new Usage(`corpus ${corpusId} has no document ${doc}`);
          if (sub === 'show') {
            const windows = windowsOf(c.index, c.bytesOf);
            const view = {
              corpusId, revisionId: c.id, seq: c.seq, corpusDigest: c.corpusDigest, sectionSetDigest: c.sectionSetDigest, configDigest: c.configDigest,
              docs: c.docs.filter((d) => !doc || d.key === doc).map(({ artifact: _a, ...d }) => ({ ...d,
                sections: c.index.docs.find((x) => x.key === d.key)?.sections.length ?? 0, normative: c.index.sentences.filter((u) => u.docKey === d.key).length })),
              precedence: c.precedence.map((x) => ({ over: x.over, under: x.under, basis: x.basis ? { docKey: x.basis.docKey, sectionId: x.basis.sectionId } : null })),
              dependencies: c.dependencies.map((x) => ({ from: x.from, on: x.on, kinds: x.kinds })), unordered: c.unordered,
              windows: windows.filter((w) => !doc || w.docKey === doc).map((w) => ({ id: w.id, docKey: w.docKey, sections: w.sectionIds.length, bytes: w.bytes })),
              fencedBlocks: fencedBlocksOf(c).filter((f) => !doc || f.docKey === doc),
            };
            if (asJson) json(view);
            else {
              say(`corpus ${corpusId} revision ${c.id} (seq ${c.seq}) ${c.corpusDigest}`);
              for (const d of view.docs) say(`  ${d.key.padEnd(20)} ${d.role.padEnd(8)} ${d.domain.padEnd(10)} ${String(d.sections).padStart(4)} sections ${String(d.normative).padStart(5)} normative  ${d.path}`);
              for (const x of view.precedence) say(`  precedence: ${x.over} over ${x.under}`);
              for (const x of view.dependencies) say(`  dependency: ${x.from} cites ${x.on} (${x.kinds.join(', ')})`);
              for (const [a, b] of view.unordered) say(`  unordered: ${a} ⟷ ${b}`);
              say(`  ${view.windows.length} window(s); ${view.fencedBlocks.length} fenced block(s) not read`);
            }
            return 0;
          }
          const rows = docs.flatMap((d) => d.sections.map((s) => ({ id: s.id, label: s.label, level: s.level, start: s.start, end: s.end,
            normative: c.index.sentences.filter((u) => u.sectionId === s.id).length, informative: s.informative, withdrawn: s.withdrawn, openDecision: s.openDecision })));
          if (asJson) json({ corpusId, revisionId: c.id, sections: rows });
          else for (const r of rows) say(`${'  '.repeat(r.level)}${r.id}${r.label ? ` [${r.label}]` : ''} ${r.normative ? `${r.normative} normative` : ''}${r.informative ? ' informative' : ''}${r.openDecision ? ' open-decision' : ''}`);
          return 0;
        });
      }
      case 'extract': {
        const [corpusId, repo] = p.positionals;
        if (!corpusId || !repo) throw new Usage('corpus extract needs <corpus> <repo> --tools a,b');
        const tools = list(last(p, 'tools'));
        if (!tools.length) throw new Usage('corpus extract needs --tools');
        const timeout = last(p, 'timeout');
        const timeoutMs = timeout === undefined ? undefined : Number(timeout) * 1000;
        if (timeoutMs !== undefined && !(timeoutMs > 0)) throw new Usage('--timeout is seconds');
        const r = await withContext(outFor(repo), (ctx) => extract(ctx, corpusId, path.resolve(repo), tools, {
          runner: deps.runner ?? defaultRunner(timeoutMs), windows: list(last(p, 'windows')), force: p.flags.has('force'),
        }));
        if (asJson) json({ ran: r.ran, skipped: r.skipped, proposed: r.proposed.length, observed: r.observed, refused: r.refused, irVersion: r.irVersion });
        else {
          say(`windows × tools: ${r.ran} extracted, ${r.skipped} skipped (already done; --force re-extracts)`);
          say(`${r.proposed.length} new IR record(s), ${r.observed} new observation(s); ${r.refused.length} outbox line(s) refused; ${r.irVersion}`);
          for (const x of r.refused) say(`  refused ${x.attemptId} line ${x.line ?? '-'}: ${x.field} ${x.reason}`);
        }
        return 0;
      }
      case 'coverage': {
        const corpusId = p.positionals[0];
        if (!corpusId) throw new Usage('corpus coverage needs <corpus>');
        const format = last(p, 'format') ?? 'md';
        if (format !== 'md' && format !== 'json') throw new Usage('--format is json or md');
        return await withContext(outFor(undefined), (ctx) => {
          const r = coverageOf(ctx, corpusId, { revisionId: last(p, 'revision') });
          const holdouts = holdoutBasenamesOf(ctx, ctx.store.mission(corpusId)!.projectId);
          const md = renderCoverageMarkdown(r, (s) => safeExcerpt(ctx, s, { holdoutBasenames: holdouts, revisionId: r.revisionId }));
          if (p.flags.has('write')) {
            const dir = path.join(ctx.out, 'corpus', corpusId);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'coverage.json'), `${JSON.stringify(r, null, 2)}\n`);
            fs.writeFileSync(path.join(dir, 'coverage.md'), md);
          }
          if (format === 'json') json(r);
          else process.stdout.write(md);
          return 0;
        });
      }
      case 'ir': {
        const [verb, corpusId] = p.positionals;
        if (verb !== 'list' || !corpusId) throw new Usage('corpus ir list <corpus> [--status s] [--kind k] [--section id] [--stale]');
        const status = last(p, 'status') as IrStatus | undefined;
        if (status !== undefined && !['proposed', 'approved', 'rejected', 'superseded'].includes(status)) throw new Usage('--status is proposed, approved, rejected or superseded');
        const kind = last(p, 'kind') as IrKind | undefined;
        if (kind !== undefined && !(IR_KINDS as readonly string[]).includes(kind)) throw new Usage(`--kind is one of ${IR_KINDS.join(', ')}`);
        return await withContext(outFor(undefined), (ctx) => {
          corpusOf(ctx, corpusId);
          const stale = p.flags.has('stale');
          const rows = ctx.store.irRecords(corpusId, { status, kind, sectionId: last(p, 'section') })
            .filter((r) => !stale || (r.source === 'extracted' && !r.span))
            .map((r) => ({ id: r.id, kind: r.kind, source: r.source, status: r.status, sectionId: r.span?.sectionId ?? null, start: r.span?.start ?? null,
              end: r.span?.end ?? null, stale: r.source === 'extracted' && !r.span, observedBy: r.observedBy, contentDigest: r.contentDigest }));
          // Statements are an extractor's words: JSON carries ids and spans, never them (P2-R40).
          if (asJson) json({ corpusId, records: rows });
          else for (const r of rows) say(`${r.id} ${r.status.padEnd(10)} ${r.kind.padEnd(20)} ${r.source.padEnd(9)} ${r.sectionId ?? '(no span)'}${r.stale ? ' STALE' : ''} ×${r.observedBy.length}`);
          return 0;
        });
      }
    }
    return 2;
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    const refused = err instanceof CorpusRefused || err instanceof SpecRefused;
    if (asJson) json({ error: message, refused });
    console.error(`error: ${message}`);
    return 1;
  }
}
