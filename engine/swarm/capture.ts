import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digestOf, type ArtifactStore } from '../mission/artifacts.ts';
import type { EventLog } from '../mission/events.ts';
import { redact } from '../mission/redact.ts';
import type { ArtifactRef, AttemptState } from '../mission/types.ts';
import { run, type Adapter, type AgentResult, type AgentRun } from './adapters.ts';
import { normalize, providerOf } from './normalize.ts';

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
      failure?: string;
      artifacts?: ArtifactRef[];
    },
  ): unknown;
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
}

const DEFAULT_MEMORY = 2 * 1024 * 1024;

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
  const provider = providerOf(adapter.name);
  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-capture-'));
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
    },
  });

  // Cost only counts when a provider said a number. Silence is null, never zero.
  let reportedCost: number | null = null;
  let reportedTurns: number | null = null;
  let toolCalls = 0;
  let partial = '';

  const onLine = (line: string) => {
    for (const ev of normalize(provider, line)) {
      if (ev.name === 'cost.reported') {
        const c = ev.payload.costUsd;
        if (typeof c === 'number') reportedCost = c;
        const t = ev.payload.turns;
        if (typeof t === 'number') reportedTurns = t;
      }
      if (ev.name === 'tool.call') toolCalls++;
      events.append({
        ...base,
        ...ev,
        // The attempt's own `cost.reported` is appended once, below. The provider's figure is
        // kept beside it under another name, so a reader summing cost.reported over the log
        // counts each attempt once rather than twice.
        name: ev.name === 'cost.reported' ? 'provider.cost' : ev.name,
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
    // Provider JSON is line-delimited; a chunk boundary mid-line is normal.
    partial += chunk;
    const at = partial.lastIndexOf('\n');
    if (at < 0) return;
    for (const line of partial.slice(0, at).split('\n')) if (line.trim()) onLine(line);
    partial = partial.slice(at + 1);
  };

  const started = Date.now();
  const result = await run(adapter, {
    ...options,
    onOutput: (stream, chunk) => {
      options.onOutput?.(stream, chunk);
      onOutput(stream, chunk);
    },
  });
  if (partial.trim()) onLine(partial);

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
    fs.rmdirSync(spillDir);
  } catch {
    // Not empty, or already gone — either way not worth failing an attempt over.
  }

  // The CLI's own spend parser is the fallback for providers that report cost in a shape
  // `normalize` does not know; but its zero means "saw nothing", which is unknown here.
  const costUsd: number | null = reportedCost ?? (result.cost > 0 ? result.cost : null);
  const turns = reportedTurns ?? (result.turns > 0 ? result.turns : null);

  events.append({
    ...base,
    category: 'cost',
    name: 'cost.reported',
    payload: { costUsd, turns, known: costUsd !== null, source: ctx.runnerId },
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
    failure,
    artifacts: [promptRef, ...logs],
  });

  return result;
}
