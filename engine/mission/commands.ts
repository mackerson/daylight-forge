import fs from 'node:fs';
import path from 'node:path';
import { prepareDemo, replayDemo } from '../demo/demo.ts';
import { EXPECTED_FIXTURE_COMMIT } from '../demo/fixture.ts';
import { dataHome, defaultOut, outFor } from '../paths.ts';
import { redact } from './redact.ts';
import { openDaylight, type DaylightContext } from './context.ts';
import { importMission, readExport, writeExport } from './export.ts';
import {
  adjudicateConfirm, closeMission, createMission, decide, holdoutContent, inspectMission, needsOf, parseDecisionValue,
  proposeExperiment, runMission, runMissionExperiment, withholdHoldoutEvents,
} from './orchestrate.ts';
import { AGENT_SESSION_VARS } from '../forge/policy.ts';
import { renderReport } from './report.ts';
import { runProjectReport } from './commands-report.ts';
import { missionAuthorizeCommand, missionCreateImplementCommand, osActor, Usage as ForgeUsage } from '../forge/commands.ts';
import { mappedProject } from './context.ts';
import type { MissionKind, MissionOutcome } from './types.ts';

/**
 * The `daylight mission|experiment|artifact|events|report|demo` commands.
 *
 * Kept out of `cli.ts`, which dispatches here with the raw argv. These commands have a
 * subcommand before their positional, which the main parser reads as a target path, so the
 * parsing is done again here — small, and only for flags these commands own.
 *
 * Output discipline: with `--format json`, stdout is one JSON document and nothing else.
 * Progress goes to stderr as `##daylight {...}` lines, which the Electron shell already scans on
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

const json = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
const say = (line: string) => process.stdout.write(`${line}\n`);
const progress = (data: unknown) => process.stderr.write(`##daylight ${JSON.stringify(data)}\n`);

function withContext<T>(out: () => string, fn: (ctx: DaylightContext) => T): T {
  const ctx = openDaylight(out());
  try {
    return fn(ctx);
  } finally {
    ctx.close();
  }
}

async function withContextAsync<T>(out: () => string, fn: (ctx: DaylightContext) => Promise<T>): Promise<T> {
  const ctx = openDaylight(out());
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

const KINDS: MissionKind[] = ['explore', 'verify', 'implement', 'remediate', 'audit'];
const OUTCOMES: MissionOutcome[] = ['succeeded', 'failed', 'inconclusive', 'cancelled'];

// ---- mission ---------------------------------------------------------------------

async function mission(sub: string | undefined, p: Parsed, out: () => string, asJson: boolean): Promise<number> {
  switch (sub) {
    case 'create': {
      const repo = p.positionals[0];
      if (!repo) throw new Usage('mission create needs a <repo>');
      const kind = (last(p, 'kind') ?? 'explore') as MissionKind;
      if (!KINDS.includes(kind)) throw new Usage(`--kind must be one of ${KINDS.join(', ')}`);
      // An implement mission has one way in: an approved work item, or a person's ad hoc decision.
      if (kind === 'implement') return await missionCreateImplementCommand(p, out, asJson, process.env);
      const m = withContext(out, (ctx) => createMission(ctx, {
        repo: path.resolve(repo), kind, objective: need(p, 'objective'),
        scope: { paths: list(last(p, 'scope')) },
        maxCost: num(last(p, 'max-cost')),
      }));
      if (asJson) json(m);
      else say(`created mission ${m.id} (${m.kind}, ${m.state}) at ${m.baseRevision}`);
      return 0;
    }
    case 'authorize':
      return await missionAuthorizeCommand(p, out, asJson, process.env);
    case 'list': {
      const data = withContext(out, (ctx) => {
        const missions = ctx.store.missions();
        return {
          project: mappedProject(out()),
          missions,
          needs: Object.fromEntries(missions.map((m) => [m.id, needsOf(ctx, m)])),
        };
      });
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
      if (last(p, 'unsandboxed-review') === 'true') {
        console.error('warning: --unsandboxed-review: reviewers run with no sandbox and can read <out>, other missions\' claims included (Sec H5)');
      }
      const report = await withContextAsync(out, (ctx) => runMission(ctx, {
        missionId: id,
        repo: path.resolve(repo),
        tools: list(last(p, 'tools') ?? 'claude'),
        model: last(p, 'model'),
        maxCost: num(last(p, 'max-cost')),
        raiseBudget: last(p, 'raise-budget') === 'true',
        noReviewSandbox: last(p, 'no-review-sandbox') === 'true',
        unsandboxedReview: last(p, 'unsandboxed-review') === 'true',
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
      // The decision is the OS user's (S-8): another human name is ignored, an agent is refused.
      const given = last(p, 'actor');
      if (given?.startsWith('agent:')) throw new Usage(`--actor ${given}: a decision is a person's, never an agent's`);
      const what = {
        subject: need(p, 'subject'), predicate: need(p, 'predicate'), value: parseDecisionValue(need(p, 'value')),
        experimentId: last(p, 'experiment'),
      };
      const confirm = last(p, 'confirm');
      if (confirm === undefined) {
        const c = withContext(out, (ctx) => {
          const m = ctx.store.mission(id);
          if (!m) throw new Error(`unknown mission ${id}`);
          return adjudicateConfirm(m, what);
        });
        if (asJson) json({ confirm: 'required', digest: c.digest, lines: c.lines });
        else for (const l of [...c.lines, `digest ${c.digest}`]) say(l);
        console.error('usage: re-run with --confirm <the first eight hex characters of the digest>');
        return 2;
      }
      const result = withContext(out, (ctx) => decide(ctx, {
        missionId: id, ...what, rationale: need(p, 'rationale'), actor: osActor(), confirm, env: process.env,
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
      throw new Usage('mission needs one of: create, authorize, list, inspect, run, decide, close, replay, export, import');
  }
}

// ---- experiment ------------------------------------------------------------------

async function experiment(sub: string | undefined, p: Parsed, out: () => string, asJson: boolean): Promise<number> {
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

/**
 * `--reveal-holdout`: a person at a terminal reading a holdout's content, which every other
 * read withholds (ws9-review M1). Refused from inside an agent session; the shell never passes it.
 */
function revealHoldout(p: Parsed): boolean {
  if (last(p, 'reveal-holdout') !== 'true') return false;
  const agent = AGENT_SESSION_VARS.find((v) => process.env[v]);
  if (agent) throw new Error(`refused: ${agent} is set; a holdout is revealed only to a person, never inside an agent session`);
  return true;
}

function artifact(p: Parsed, out: () => string, asJson: boolean): number {
  const id = p.positionals[0];
  if (!id) throw new Usage('artifact needs a <digest>');
  const maxBytes = num(last(p, 'max-bytes')) ?? 256 * 1024;
  const reveal = revealHoldout(p);
  const result = withContext(out, (ctx) => {
    if (!reveal && holdoutContent(ctx).artifacts.has(id)) {
      throw new Error(`refused: ${id} holds a holdout's content, which never leaves the gate runner (pass --reveal-holdout at a terminal to read it)`);
    }
    if (!ctx.artifacts.has(id)) throw new Error(`no artifact ${id} in ${out()}`);
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

function events(p: Parsed, out: () => string, asJson: boolean): number {
  const since = num(last(p, 'since')) ?? 0;
  const limit = num(last(p, 'limit')) ?? 1000;
  const reveal = revealHoldout(p);
  const rows = withContext(out, (ctx) => {
    const raw = ctx.events.since(since, { missionId: last(p, 'mission'), attemptId: last(p, 'attempt') }, limit);
    return reveal ? raw : withholdHoldoutEvents(holdoutContent(ctx), raw);
  });
  if (asJson) json(rows);
  else for (const e of rows) say(`${e.sequence} ${new Date(e.at).toISOString()} ${e.category} ${e.name} ${e.missionId ?? ''} ${e.attemptId ?? ''}`);
  return 0;
}

function report(p: Parsed, out: () => string, argv: string[]): number {
  if (last(p, 'project') !== undefined) return runProjectReport(argv, out);
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

/**
 * With `--out`, the fixture repo goes beside it as before. Without, both live under the data
 * home: the fixture's project id is pinned, so its out is known before the repo exists.
 */
function demo(sub: string | undefined, p: Parsed, explicitOut: string, asJson: boolean): number {
  const dest = path.resolve(last(p, 'dest') ?? (explicitOut
    ? path.join(explicitOut, '..', 'daylight-demo-repo')
    : path.join(dataHome(), 'daylight', 'daylight-demo-repo')));
  const out = explicitOut
    ? path.resolve(explicitOut)
    : outFor(`git:${EXPECTED_FIXTURE_COMMIT.slice(0, 12)}`, dest);
  switch (sub) {
    case 'prepare': {
      const prepared = prepareDemo(out, dest);
      const { mission: _m, experiment: _x, ...summary } = prepared;
      void _m; void _x;
      if (asJson) json(summary);
      else {
        say(`fixture at ${prepared.root} @ ${prepared.commit.slice(0, 12)} (project ${prepared.projectId})`);
        say(`mission ${prepared.missionId}, experiment ${prepared.experimentId}, in ${out}`);
        say('next: daylight mission run <mission-id> <fixture-root> --tools <a>,<b>');
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
  const explicitOut = last(p, 'out');
  const asJson = last(p, 'format') === 'json';
  try {
    // The default out belongs to a repository: the one a subcommand names positionally, or
    // the working directory for those that name none. The demo derives its own.
    const repoArg = command === 'mission' && sub === 'create' ? p.positionals[0]
      : (command === 'mission' || command === 'experiment') && sub === 'run' ? p.positionals[1]
        : undefined;
    // Resolved on first use, so a usage error is reported as one rather than as a project id
    // the working directory cannot answer.
    let resolved: string | undefined;
    const out = () => (resolved ??= explicitOut ? path.resolve(explicitOut) : defaultOut(repoArg ?? process.cwd()));
    switch (command) {
      case 'mission': return await mission(sub, p, out, asJson);
      case 'experiment': return await experiment(sub, p, out, asJson);
      case 'artifact': return artifact(p, out, asJson);
      case 'events': return events(p, out, asJson);
      case 'report': return report(p, out, rest);
      case 'demo': return demo(sub, p, explicitOut ?? '', asJson);
      default: throw new Usage(`unknown command ${command}`);
    }
  } catch (err) {
    if (err instanceof Usage || err instanceof ForgeUsage) {
      console.error(`usage: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) json({ error: message });
    console.error(`error: ${message}`);
    return 1;
  }
}
