import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processAlive } from '../experiment/runner.ts';
import { digestOf, type ArtifactStore } from '../mission/artifacts.ts';
import type { EventLog } from '../mission/events.ts';
import { redact } from '../mission/redact.ts';
import type {
  ArtifactRef, AttemptCredential, AttemptState, CostSource, TokenUsage, UsageRecordResult, UsageSource,
} from '../mission/types.ts';
import { run, type Adapter, type AgentResult, type AgentRun } from './adapters.ts';
import { normalize, streamProviderOf } from './normalize.ts';
import { LineSplitter, UsageAccumulator, type UsageRow } from './usage.ts';

/**
 * Run an adapter as a mission attempt: every byte it prints is kept, every recognisable
 * thing it did becomes an event, and the attempt is finished with the truth about how it
 * ended.
 *
 * `run()` already buffers each agent's whole output and that buffer stays for the callers
 * that read it. What was missing is the live half — a console a person can watch while the
 * agent is still going — and the durable half: the stream as an artifact, redacted, bound
 * to the attempt rather than lost when the job's 200KB window scrolls past.
 *
 * Memory is bounded. Up to `memoryBytes` per stream stays in memory; past that the stream is
 * spilled to a temp file and only a tail is kept, so an agent that prints a hundred
 * megabytes costs disk, not the process that is drawing the window.
 */

/** The one thing this needs from a mission store. DL-01 owns the real class. */
export interface AttemptFinisher {
  finishAttempt(
    id: string,
    result: {
      state: Extract<AttemptState, 'completed' | 'failed' | 'cancelled'>;
      exitCode?: number | null;
      signal?: string | null;
      timedOut?: boolean;
      costUsd: number | null;
      costSource?: CostSource;
      failure?: string;
      artifacts?: ArtifactRef[];
      tokens?: TokenUsage;
      usageSource?: UsageSource;
      model?: string;
    },
  ): unknown;
  /**
   * Record one turn's usage in `attempt_usage`. The mission store has it; a finisher without
   * it still gets the attempt's totals, only not the per-turn rows.
   */
  recordUsage?(attemptId: string, row: UsageRow): { result: UsageRecordResult; seq: number };
}

export interface CaptureContext {
  store: AttemptFinisher;
  events: EventLog;
  artifacts: ArtifactStore;
  projectId: string;
  missionId: string;
  taskId: string;
  attemptId: string;
  /** `agent:<tool>:<model>` — what the events name as their actor. */
  runnerId: string;
  revision?: string;
  /** Values to mask on top of what the environment suggests. */
  secrets?: string[];
  /** Per-stream in-memory cap before spilling to disk. Small in tests. */
  memoryBytes?: number;
  /** Called with each chunk, after redaction, for a live console. */
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Which credential the agent was given, by name and label only (Q4a). Goes on `process.start`. */
  credential?: AttemptCredential;
}

const DEFAULT_MEMORY = 2 * 1024 * 1024;
const SAFE_LABEL = /^[A-Za-z0-9._:/@+-]{1,128}$/;
/** Provider key prefixes. A real id or model name never contains one, so the whitelist refuses it without asking redaction. */
const KEY_PREFIX = /(?<![A-Za-z0-9])(sk-|ghp_|github_pat_|AKIA[0-9A-Z]{4}|xox[bap]-|glpat-|AIza|eyJ)/;
export const isSafeLabel = (s: string): boolean => SAFE_LABEL.test(s) && !KEY_PREFIX.test(s);

/** One stream's bytes: in memory until they are not, then on disk with a tail in memory. */
class StreamCapture {
  private head = '';
  private tail = '';
  private file: string | null = null;
  private readonly cap: number;
  private readonly spillDir: string;
  private readonly name: string;
  bytes = 0;

  constructor(cap: number, spillDir: string, name: string) {
    this.cap = cap;
    this.spillDir = spillDir;
    this.name = name;
  }

  push(chunk: string): void {
    this.bytes += Buffer.byteLength(chunk);
    if (this.file) {
      fs.appendFileSync(this.file, chunk);
      this.tail = (this.tail + chunk).slice(-this.cap);
      return;
    }
    this.head += chunk;
    if (this.head.length > this.cap) {
      this.file = path.join(this.spillDir, `${this.name}.${process.pid}.${Date.now()}.log`);
      fs.writeFileSync(this.file, this.head);
      this.tail = this.head.slice(-this.cap);
      this.head = '';
    }
  }

  /** Everything, in order. Reads the spill file back when there is one. */
  all(): string {
    return this.file ? fs.readFileSync(this.file, 'utf8') : this.head;
  }

  spilled(): boolean {
    return this.file !== null;
  }

  dispose(): void {
    if (this.file) {
      try {
        fs.unlinkSync(this.file);
      } catch {
        // A leftover temp file is untidy, not wrong.
      }
    }
  }
}

const SPILL_PREFIX = 'daylight-capture-';
const SPILL_OWNER = 'owner.json';
const SPILL_FILE = /^(?:stdout|stderr)\.(\d+)\.\d+\.log$/;

interface SpillOwner { pid: number; repoRoot: string; projectId: string; startedAt: number }

/**
 * Remove spill directories left by captures whose process died before its cleanup ran.
 *
 * They hold raw, unredacted agent output, so leaving them is not only untidy. But they sit in
 * a shared /tmp and `owner.json` is input, not instruction, so the rules are the experiment
 * sweep's: only a real directory this uid made with mode 0700, whose owner is dead and names
 * this repository and project, holding nothing but regular spill files of that owner. Each
 * is unlinked by name and the directory removed without recursion; anything else is left.
 */
export function sweepSpills(ctx: { repoRoot: string; projectId: string }, tmp: string = os.tmpdir()): number {
  const uid = process.getuid?.();
  const repoRoot = path.resolve(ctx.repoRoot);
  let swept = 0;
  let names: string[];
  try {
    names = fs.readdirSync(tmp).filter((n) => n.startsWith(SPILL_PREFIX));
  } catch {
    return 0;
  }
  for (const name of names) {
    const dir = path.join(tmp, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) continue;
      const ownerFile = path.join(dir, SPILL_OWNER);
      if (!fs.lstatSync(ownerFile).isFile()) continue;
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as SpillOwner;
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || processAlive(owner.pid)) continue;
      if (typeof owner.repoRoot !== 'string' || path.resolve(owner.repoRoot) !== repoRoot) continue;
      if (owner.projectId !== ctx.projectId) continue;
      const files = fs.readdirSync(dir).filter((n) => n !== SPILL_OWNER);
      const ours = files.every((n) =>
        SPILL_FILE.exec(n)?.[1] === String(owner.pid) && fs.lstatSync(path.join(dir, n)).isFile());
      if (!ours) {
        process.stderr.write(`daylight: left ${dir} alone: it holds files a capture does not write\n`);
        continue;
      }
      for (const n of files) fs.unlinkSync(path.join(dir, n));
      fs.unlinkSync(ownerFile);
      fs.rmdirSync(dir);
      swept++;
    } catch {
      // Unreadable, malformed or changing under us: not ours to decide about.
    }
  }
  return swept;
}

/** The prompt is the biggest argv element and the one with the least business in a log. */
export function describeArgv(argv: string[], prompt: string): string[] {
  const stand = `<prompt ${prompt.length} chars ${digestOf(prompt)}>`;
  return argv.map((a) => (a === prompt ? stand : a));
}

export async function captureRun(
  adapter: Adapter,
  options: AgentRun,
  ctx: CaptureContext,
): Promise<AgentResult> {
  const { events, artifacts, store } = ctx;
  const base = {
    projectId: ctx.projectId,
    missionId: ctx.missionId,
    taskId: ctx.taskId,
    attemptId: ctx.attemptId,
    actorId: ctx.runnerId,
  };
  const scrub = (text: string) => redact(text, ctx.secrets).text;
  // A request id or model name is stored in columns of its own, so it is held to the shape an
  // id has. Anything else — including anything redaction would touch — is kept only as a
  // digest, which still dedupes the same turn and carries nothing of the string.
  const safeLabel = (s: string): string =>
    isSafeLabel(s) && scrub(s) === s ? s : `unsafe:${digestOf(s).slice(7, 23)}`;
  // A label redaction would alter is shaped like a secret, so it is refused before anything
  // runs rather than recorded masked: the ledger names a credential, never carries one.
  if (ctx.credential) {
    const said = JSON.stringify(ctx.credential);
    if (scrub(said) !== said) throw new Error('the credential record looks like it holds a secret; name the variable and give it a plain label');
    // The store's own shape rule (checkCredential), so process.start never carries what the attempt row would refuse.
    const { envName, label } = ctx.credential;
    if ((envName !== null && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(envName)) || (label !== null && !/^[\w .:@/-]{1,64}$/.test(label))) {
      throw new Error('a credential is a variable name and a short plain label');
    }
  }
  const provider = streamProviderOf(adapter);
  const usage = new UsageAccumulator(provider);
  sweepSpills({ repoRoot: options.cwd, projectId: ctx.projectId });
  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), SPILL_PREFIX));
  const owner: SpillOwner = { pid: process.pid, repoRoot: path.resolve(options.cwd), projectId: ctx.projectId, startedAt: Date.now() };
  fs.writeFileSync(path.join(spillDir, SPILL_OWNER), JSON.stringify(owner));
  const cap = ctx.memoryBytes ?? DEFAULT_MEMORY;
  const streams = {
    stdout: new StreamCapture(cap, spillDir, 'stdout'),
    stderr: new StreamCapture(cap, spillDir, 'stderr'),
  };

  // The prompt is recorded whole, so a replay can say exactly what was asked.
  const promptRef = artifacts.put(scrub(options.prompt), {
    kind: 'trace', projectId: ctx.projectId, revision: ctx.revision, label: 'prompt',
  });

  const argv = adapter.argv(options);
  events.append({
    ...base,
    category: 'process',
    name: 'process.start',
    artifactIds: [promptRef.id],
    payload: {
      runnerId: ctx.runnerId,
      sessionId: options.session,
      bin: adapter.bin,
      argv: describeArgv(argv, options.prompt).map(scrub),
      cwd: options.cwd,
      model: options.model ?? null,
      provider,
      ...(ctx.credential ? { credential: ctx.credential } : {}),
    },
  });

  // Cost only counts when a provider said a number. Silence is null, never zero.
  let reportedCost: number | null = null;
  let reportedTurns: number | null = null;
  let toolCalls = 0;
  const lines = new LineSplitter();

  // A turn's event says what the row now holds. `merged` means it replaces the earlier event
  // with the same `seq`; the ledger reads the rows, never a sum over these.
  const recordUsage = (ev: Parameters<UsageAccumulator['observe']>[0]) => {
    for (const change of usage.observe(ev)) {
      if (change.kind === 'mismatch') {
        events.append({ ...base, category: 'cost', name: 'cost.usage.mismatch', payload: {
          requestId: safeLabel(change.requestId), field: change.field, turns: change.turns, summary: change.summary,
        } });
        continue;
      }
      const row: UsageRow = {
        ...change.row,
        requestId: change.row.requestId === null ? null : safeLabel(change.row.requestId),
        model: change.row.model === null ? null : safeLabel(change.row.model),
      };
      const stored = store.recordUsage?.(ctx.attemptId, row);
      if (stored?.result === 'duplicate') continue;
      events.append({ ...base, category: 'cost', name: 'cost.usage', payload: {
        seq: stored?.seq ?? null, requestId: row.requestId, model: row.model,
        inputTokens: row.tokens.input, outputTokens: row.tokens.output,
        cacheReadTokens: row.tokens.cacheRead, cacheWriteTokens: row.tokens.cacheWrite,
        costUsd: row.costUsd, costSource: row.costSource, source: row.source,
        merged: (stored?.result ?? change.result) === 'merged',
      } });
    }
  };

  const onLine = (line: string) => {
    for (const ev of normalize(provider, line)) {
      if (ev.name === 'cost.usage') {
        recordUsage(ev);
        continue;
      }
      // The provider's figure arrives as `provider.cost`; the attempt's own `cost.reported` is
      // appended once, below, so a reader summing that name counts each attempt once.
      if (ev.name === 'provider.cost') {
        const c = ev.payload.costUsd;
        if (typeof c === 'number') reportedCost = c;
        const t = ev.payload.turns;
        if (typeof t === 'number') reportedTurns = t;
      }
      if (ev.name === 'tool.call') toolCalls++;
      events.append({
        ...base,
        ...ev,
        payload: Object.fromEntries(
          Object.entries(ev.payload).map(([k, v]) => [k, typeof v === 'string' ? scrub(v) : v]),
        ),
      });
    }
  };

  const onOutput = (stream: 'stdout' | 'stderr', chunk: string) => {
    streams[stream].push(chunk);
    ctx.onChunk?.(stream, scrub(chunk));
    if (stream !== 'stdout') return;
    for (const line of lines.push(chunk)) onLine(line);
  };

  const started = Date.now();
  const result = await run(adapter, {
    ...options,
    onOutput: (stream, chunk) => {
      options.onOutput?.(stream, chunk);
      onOutput(stream, chunk);
    },
  });
  for (const line of lines.end()) onLine(line);

  const logs: ArtifactRef[] = [];
  for (const stream of ['stdout', 'stderr'] as const) {
    const cap = streams[stream];
    const { text, redactions } = redact(cap.all(), ctx.secrets);
    logs.push(artifacts.put(text, {
      kind: 'log', projectId: ctx.projectId, revision: ctx.revision,
      label: `${stream}${redactions ? ` (${redactions} redacted)` : ''}`,
    }));
    cap.dispose();
  }
  try {
    fs.unlinkSync(path.join(spillDir, SPILL_OWNER));
    fs.rmdirSync(spillDir);
  } catch {
    // Not empty, or already gone — either way not worth failing an attempt over.
  }

  // The CLI's own spend parser is the fallback for providers that report cost in a shape
  // `normalize` does not know; but its zero means "saw nothing", which is unknown here. A
  // figure it scraped from stdout is a guess, and the event says so: known is only ever a
  // number the provider put in its own structured result.
  const costUsd: number | null = reportedCost ?? (result.cost > 0 ? result.cost : null);
  const turns = reportedTurns ?? (result.turns > 0 ? result.turns : null);
  const costSource = reportedCost !== null ? 'provider' : costUsd !== null ? 'stdout-scan' : 'none';
  // Token totals are the sum of the rows; the scan never supplies tokens.
  const totals = usage.totals();
  const model = totals.model === null ? undefined : safeLabel(totals.model);

  events.append({
    ...base,
    category: 'cost',
    name: 'cost.reported',
    payload: {
      costUsd, turns, known: costSource === 'provider', costSource, source: ctx.runnerId,
      tokens: totals.tokens, usageSource: totals.usageSource, dupes: totals.dupes,
    },
  });

  const failure = result.ok
    ? undefined
    : result.timedOut
      ? 'timed out'
      : result.overBudget
        ? 'over budget'
        : result.exitCode === null
          ? `killed by ${result.signal ?? 'signal'}`
          : `exit ${result.exitCode}`;

  events.append({
    ...base,
    category: 'process',
    name: 'process.exit',
    artifactIds: logs.map((l) => l.id),
    payload: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      overBudget: result.overBudget,
      ok: result.ok,
      durationMs: Date.now() - started,
      toolCalls,
      stdoutBytes: streams.stdout.bytes,
      stderrBytes: streams.stderr.bytes,
      failure,
    },
  });

  store.finishAttempt(ctx.attemptId, {
    state: result.ok ? 'completed' : 'failed',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    costUsd,
    costSource,
    tokens: totals.tokens,
    usageSource: totals.usageSource,
    model,
    failure,
    artifacts: [promptRef, ...logs],
  });

  return result;
}
