import fs from 'node:fs';
import path from 'node:path';
import { prepareDemo, replayDemo } from '../demo/demo.ts';
import { redact } from './redact.ts';
import { openDaylight, type DaylightContext } from './context.ts';
import { importMission, readExport, writeExport } from './export.ts';
import {
  closeMission, createMission, decide, inspectMission, proposeExperiment, runMission,
  runMissionExperiment,
} from './orchestrate.ts';
import { renderReport } from './report.ts';
import { mappedProject } from './context.ts';
import type { MissionKind, MissionOutcome } from './types.ts';

/**
 * The `vds mission|experiment|artifact|events|report|demo` commands.
 *
 * Kept out of `cli.ts`, which dispatches here with the raw argv. These commands have a
 * subcommand before their positional, which the main parser reads as a target path, so the
 * parsing is done again here — small, and only for flags these commands own.
 *
 * Output discipline: with `--format json`, stdout is one JSON document and nothing else.
 * Progress goes to stderr as `##vds {...}` lines, which the Electron shell already scans on
 * both streams. Exit 0 means the command ran — a blocked mission or a falsified experiment
 * is data, not a failure. Exit 2 is bad arguments. Exit 1 is the command itself failing.
 */

class Usage extends Error {}

interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
}

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

const last = (p: Parsed, k: string): string | undefined => p.flags.get(k)?.at(-1);
const all = (p: Parsed, k: string): string[] => p.flags.get(k) ?? [];
const need = (p: Parsed, k: string): string => {
  const v = last(p, k);
  // A bare flag reads as 'true', which is a legitimate --value; only absence is an error.
  if (v === undefined) throw new Usage(`--${k} is required`);
  return v;
};
const list = (s: string | undefined): string[] =>
  (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Usage(`not a number: ${s}`);
  return n;
};
const parseValue = (raw: string): unknown => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const json = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
const say = (line: string) => process.stdout.write(`${line}\n`);
const progress = (data: unknown) => process.stderr.write(`##vds ${JSON.stringify(data)}\n`);

function withContext<T>(out: string, fn: (ctx: DaylightContext) => T): T {
  const ctx = openDaylight(out);
  try {
    return fn(ctx);
  } finally {
    ctx.close();
  }
}

async function withContextAsync<T>(out: string, fn: (ctx: DaylightContext) => Promise<T>): Promise<T> {
  const ctx = openDaylight(out);
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

const KINDS: MissionKind[] = ['explore', 'verify', 'implement', 'remediate', 'audit'];
const OUTCOMES: MissionOutcome[] = ['succeeded', 'failed', 'inconclusive', 'cancelled'];

// ---- mission ---------------------------------------------------------------------

async function mission(sub: string | undefined, p: Parsed, out: string, asJson: boolean): Promise<number> {
  switch (sub) {
    case 'create': {
      const repo = p.positionals[0];
      if (!repo) throw new Usage('mission create needs a <repo>');
      const kind = (last(p, 'kind') ?? 'explore') as MissionKind;
      if (!KINDS.includes(kind)) throw new Usage(`--kind must be one of ${KINDS.join(', ')}`);
      const m = withContext(out, (ctx) => createMission(ctx, {
        repo: path.resolve(repo), kind, objective: need(p, 'objective'),
        scope: { paths: list(last(p, 'scope')) },
        maxCost: num(last(p, 'max-cost')),
      }));
      if (asJson) json(m);
      else say(`created mission ${m.id} (${m.kind}, ${m.state}) at ${m.baseRevision}`);
      return 0;
    }
    case 'list': {
      const data = withContext(out, (ctx) => ({
        project: mappedProject(out),
        missions: ctx.store.missions(),
      }));
      if (asJson) json(data);
      else {
        if (!data.missions.length) say('no missions');
        for (const m of data.missions) {
          say(`${m.id}  ${m.kind.padEnd(9)} ${m.state.padEnd(8)} ${m.outcome ?? ''}  ${m.objective.split('\n')[0].slice(0, 70)}`);
        }
      }
      return 0;
    }
    case 'inspect': {
      const id = p.positionals[0];
      if (!id) throw new Usage('mission inspect needs a <mission-id>');
      const view = withContext(out, (ctx) => inspectMission(ctx, id));
      if (asJson) json(view);
      else {
        const m = view.mission;
        say(`${m.id}  ${m.kind} ${m.state}${m.outcome ? ` → ${m.outcome}` : ''}  ${m.baseRevision}`);
        say(`objective: ${m.objective.split('\n')[0]}`);
        for (const t of view.tasks) {
          const attempts = view.attempts.filter((a) => a.taskId === t.id);
          say(`  task ${t.role.padEnd(8)} ${t.state.padEnd(8)} ${t.runnerHint ?? ''}  ${attempts.length} attempt(s)`);
        }
        say(`  disputes ${view.disputes.length} · unverified ${view.unverified.length} · settled ${view.settled.length}`);
        say(`  experiments ${view.experiments.length} · decisions ${view.decisions.length} · events ${view.events.length}`);
      }
      return 0;
    }
    case 'run': {
      const [id, repo] = p.positionals;
      if (!id || !repo) throw new Usage('mission run needs <mission-id> <repo>');
      const report = await withContextAsync(out, (ctx) => runMission(ctx, {
        missionId: id,
        repo: path.resolve(repo),
        tools: list(last(p, 'tools') ?? 'claude'),
        model: last(p, 'model'),
        maxCost: num(last(p, 'max-cost')),
        raiseBudget: last(p, 'raise-budget') === 'true',
        dryRun: last(p, 'dry-run') === 'true',
        timeoutMs: num(last(p, 'timeout')) !== undefined ? num(last(p, 'timeout'))! * 1000 : undefined,
        concurrency: num(last(p, 'concurrency')),
        onProgress: (m, note) => progress({ mission: { id: m.id, state: m.state, outcomeReason: m.outcomeReason ?? null, note } }),
      }));
      if (asJson) {
        json(report);
        return 0;
      }
      say(`mission ${report.mission.id} is ${report.mission.state}${report.mission.outcomeReason ? ` — ${report.mission.outcomeReason}` : ''}`);
      say(`roster: ${report.plans.map((x) => `${x.spec.tool}:${x.spec.model ?? 'default'}`).join(', ') || 'nothing runnable'} · ${report.sourceDiversity} independent source(s)`);
      for (const u of report.unavailable) say(`skipped: ${u}`);
      for (const n of report.notes) say(`note: ${n}`);
      for (const a of report.attempts) {
        say(`  ${a.runnerId.padEnd(28)} ${a.state}${a.failure ? ` (${a.failure})` : ''}  cost ${a.costUsd === null ? 'unknown' : `$${a.costUsd.toFixed(2)}`}`);
      }
      if (report.comparison) {
        say(`disputes ${report.comparison.disputes.length} · unverified ${report.comparison.unverified.length} · settled ${report.comparison.settled.length}`);
        for (const d of report.comparison.disputes) {
          say(`  ${d.subject} ${d.predicate}: ${d.sides.map((s) => `${s.source}=${JSON.stringify(s.value)}`).join(' vs ')}`);
        }
      }
      if (!report.costKnown) say('note: at least one agent reported no spend; the total is a floor');
      return 0;
    }
    case 'decide': {
      const id = p.positionals[0];
      if (!id) throw new Usage('mission decide needs a <mission-id>');
      const result = withContext(out, (ctx) => decide(ctx, {
        missionId: id,
        subject: need(p, 'subject'),
        predicate: need(p, 'predicate'),
        value: parseValue(need(p, 'value')),
        rationale: need(p, 'rationale'),
        actor: last(p, 'actor'),
        experimentId: last(p, 'experiment'),
      }));
      if (asJson) json(result);
      else say(`decision ${result.decision.id}: ${result.belief.subject} ${result.belief.predicate} is now ${result.belief.status}`);
      return 0;
    }
    case 'close': {
      const id = p.positionals[0];
      if (!id) throw new Usage('mission close needs a <mission-id>');
      const outcome = need(p, 'outcome') as MissionOutcome;
      if (!OUTCOMES.includes(outcome)) throw new Usage(`--outcome must be one of ${OUTCOMES.join(', ')}`);
      const m = withContext(out, (ctx) => closeMission(ctx, id, outcome, need(p, 'reason')));
      if (asJson) json(m);
      else say(`mission ${m.id} closed: ${m.outcome} — ${m.outcomeReason}`);
      return 0;
    }
    case 'replay': {
      const id = p.positionals[0];
      if (!id) throw new Usage('mission replay needs a <mission-id>');
      const events = withContext(out, (ctx) => {
        if (!ctx.store.mission(id)) throw new Error(`unknown mission ${id}`);
        return ctx.events.forMission(id);
      });
      if (asJson) json(events);
      else {
        const t0 = events[0]?.at ?? 0;
        for (const e of events) {
          const dt = ((e.at - t0) / 1000).toFixed(1).padStart(7);
          say(`${String(e.sequence).padStart(5)} ${dt}s ${e.category.padEnd(10)} ${e.name.padEnd(22)} ${e.actorId ?? ''}${e.attemptId ? `  ${e.attemptId}` : ''}`);
        }
      }
      return 0;
    }
    case 'export': {
      const id = p.positionals[0];
      if (!id) throw new Usage('mission export needs a <mission-id>');
      const file = need(p, 'file');
      const data = withContext(out, (ctx) => writeExport(ctx, id, file));
      if (asJson) json({ file, mission: data.mission.id, events: data.events.length, artifacts: Object.keys(data.artifacts).length });
      else say(`wrote ${file}: mission ${data.mission.id}, ${data.events.length} events, ${Object.keys(data.artifacts).length} artifacts`);
      return 0;
    }
    case 'import': {
      const file = need(p, 'file');
      const result = withContext(out, (ctx) => importMission(ctx, readExport(file), { force: last(p, 'force') === 'true' }));
      if (asJson) json(result);
      else say(`imported mission ${result.mission.id}: +${result.added.events} events, +${result.added.artifacts} artifacts (${result.skipped.events} events already present)`);
      return 0;
    }
    default:
      throw new Usage('mission needs one of: create, list, inspect, run, decide, close, replay, export, import');
  }
}

// ---- experiment ------------------------------------------------------------------

async function experiment(sub: string | undefined, p: Parsed, out: string, asJson: boolean): Promise<number> {
  switch (sub) {
    case 'propose': {
      const id = p.positionals[0];
      if (!id) throw new Usage('experiment propose needs a <mission-id>');
      const testFile = need(p, 'test');
      const exit = num(last(p, 'expect-exit'));
      const x = withContext(out, (ctx) => proposeExperiment(ctx, {
        missionId: id,
        subject: need(p, 'subject'),
        predicate: need(p, 'predicate'),
        hypothesis: need(p, 'hypothesis'),
        prediction: {
          ...(exit !== undefined ? { exitCode: exit } : {}),
          ...(all(p, 'expect-stdout').length ? { stdoutIncludes: all(p, 'expect-stdout') } : {}),
          ...(all(p, 'expect-stderr').length ? { stderrIncludes: all(p, 'expect-stderr') } : {}),
        },
        testSource: fs.readFileSync(testFile, 'utf8'),
        testPath: need(p, 'test-path'),
        command: list(last(p, 'command')).length ? list(last(p, 'command')) : ['node', '--test', need(p, 'test-path')],
        claimIds: list(last(p, 'claims')).map(Number).filter(Number.isFinite),
      }));
      if (asJson) json(x);
      else say(`registered experiment ${x.id} (${x.harnessDigest})`);
      return 0;
    }
    case 'run': {
      const [id, repo] = p.positionals;
      if (!id) throw new Usage('experiment run needs an <experiment-id> [repo]');
      const x = await withContextAsync(out, (ctx) => runMissionExperiment(ctx, {
        experimentId: id,
        repo: repo ? path.resolve(repo) : undefined,
        runs: num(last(p, 'runs')),
        timeoutMs: num(last(p, 'timeout')) !== undefined ? num(last(p, 'timeout'))! * 1000 : undefined,
      }));
      if (asJson) json(x);
      else {
        say(`experiment ${x.id}: ${x.conclusion} after ${x.executions.length} run(s)`);
        for (const l of x.limitations) say(`  limitation: ${l}`);
      }
      return 0;
    }
    default:
      throw new Usage('experiment needs one of: propose, run');
  }
}

// ---- the rest ----------------------------------------------------------------------

function artifact(p: Parsed, out: string, asJson: boolean): number {
  const id = p.positionals[0];
  if (!id) throw new Usage('artifact needs a <digest>');
  const maxBytes = num(last(p, 'max-bytes')) ?? 256 * 1024;
  const result = withContext(out, (ctx) => {
    if (!ctx.artifacts.has(id)) throw new Error(`no artifact ${id} in ${out}`);
    const ref = ctx.store.artifact(id);
    const bytes = ctx.artifacts.get(id);
    const shown = bytes.subarray(0, maxBytes).toString('utf8');
    return { ref, text: redact(shown).text, truncated: bytes.length > maxBytes, bytes: bytes.length };
  });
  if (asJson) json(result);
  else {
    process.stdout.write(result.text);
    if (result.truncated) say(`\n… [${result.bytes - maxBytes} more bytes not shown]`);
  }
  return 0;
}

function events(p: Parsed, out: string, asJson: boolean): number {
  const since = num(last(p, 'since')) ?? 0;
  const limit = num(last(p, 'limit')) ?? 1000;
  const rows = withContext(out, (ctx) =>
    ctx.events.since(since, { missionId: last(p, 'mission'), attemptId: last(p, 'attempt') }, limit));
  if (asJson) json(rows);
  else for (const e of rows) say(`${e.sequence} ${new Date(e.at).toISOString()} ${e.category} ${e.name} ${e.missionId ?? ''} ${e.attemptId ?? ''}`);
  return 0;
}

function report(p: Parsed, out: string): number {
  const id = p.positionals[0];
  if (!id) throw new Usage('report needs a <mission-id>');
  const md = withContext(out, (ctx) => renderReport(ctx, inspectMission(ctx, id, Number.MAX_SAFE_INTEGER)));
  const file = last(p, 'file');
  if (file) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, md);
    say(`wrote ${file}`);
  } else {
    process.stdout.write(md);
  }
  return 0;
}

function demo(sub: string | undefined, p: Parsed, out: string, asJson: boolean): number {
  const dest = last(p, 'dest') ?? path.resolve(out, '..', 'daylight-demo-repo');
  switch (sub) {
    case 'prepare': {
      const prepared = prepareDemo(out, dest);
      const { mission: _m, experiment: _x, ...summary } = prepared;
      void _m; void _x;
      if (asJson) json(summary);
      else {
        say(`fixture at ${prepared.root} @ ${prepared.commit.slice(0, 12)} (project ${prepared.projectId})`);
        say(`mission ${prepared.missionId}, experiment ${prepared.experimentId}, in ${out}`);
        say('next: vds mission run <mission-id> <fixture-root> --tools <a>,<b>');
      }
      return 0;
    }
    case 'replay': {
      const result = replayDemo(out, dest, need(p, 'recording'), last(p, 'force') === 'true');
      if (asJson) json(result);
      else say(`replayed mission ${result.mission.id} against ${result.root} @ ${result.commit.slice(0, 12)}`);
      return 0;
    }
    default:
      throw new Usage('demo needs one of: prepare, replay');
  }
}



/** Entry from cli.ts: `argv` is `process.argv.slice(2)`. Returns the exit code. */
export async function runDaylightCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const hasSub = command === 'mission' || command === 'experiment' || command === 'demo';
  const sub = hasSub && rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
  const p = parse(hasSub ? rest.slice(sub ? 1 : 0) : rest);
  const out = path.resolve(last(p, 'out') ?? 'out');
  const asJson = last(p, 'format') === 'json';
  try {
    switch (command) {
      case 'mission': return await mission(sub, p, out, asJson);
      case 'experiment': return await experiment(sub, p, out, asJson);
      case 'artifact': return artifact(p, out, asJson);
      case 'events': return events(p, out, asJson);
      case 'report': return report(p, out);
      case 'demo': return demo(sub, p, out, asJson);
      default: throw new Usage(`unknown command ${command}`);
    }
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) json({ error: message });
    console.error(`error: ${message}`);
    return 1;
  }
}
