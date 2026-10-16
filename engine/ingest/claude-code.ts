import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARDENED_GIT_CONFIG, hardenedGitEnv } from '../experiment/runner.ts';
import { canonicalJson } from '../mission/artifacts.ts';
import { mappedRoot, type DaylightContext } from '../mission/context.ts';
import { currentRevision, identifyProject } from '../mission/project.ts';
import { redact } from '../mission/redact.ts';
import type { ArtifactRef, IngestSessionFinishedPayload, IngestSource, TokenUsage } from '../mission/types.ts';
import { readAllLines, readNewLines, sha256, type NewLines } from './cursor.ts';

/**
 * Claude Code transcripts → a `work` mission per session, recorded as work done outside
 * Daylight's controls (R12.1).
 *
 * A transcript is the most complete record of an agent session there is, and almost all of
 * it is text nobody should copy: prompts, the model's prose and thinking, file contents, tool
 * output that may hold a secret. None of that has ledger value (PLAN resolution 8), so the
 * ingester keeps facts only — the model, token counts, tool names, project-relative paths
 * from the file tools' inputs, and commit shas the repository confirms exist. Every string
 * that reaches a row, an event or an artifact is one of those, vetted on the way in and
 * checked again before anything is written (`assertVetted`).
 *
 * Text is held in memory only while a line is parsed, and only Bash output is scanned at
 * all, for 40-hex runs. A run of hex is as likely to be a token as a commit, so a candidate
 * the repository does not know as a commit is dropped and counted, never stored.
 */

export const RUNNER_ID = 'ingest:claude-code';
export const OUTSIDE_CONTROLS = "outside Daylight's controls";
export const COMMIT_LABEL = 'mentioned-in-session';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/;
const TOOL = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,99}$/;
const HEX40 = /(?<![0-9a-fA-F])[0-9a-f]{40}(?![0-9a-fA-F])/g;
// Control and format characters, and the Unicode line breaks: a path holding one can display as
// another path (U+202E) or break a terminal line, so it is dropped rather than shown.
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MAX_SHA_CANDIDATES_PER_LINE = 1000;

/** Line types seen in real transcripts that carry nothing the ledger keeps. */
const IGNORED_TYPES = new Set([
  'attachment', 'system', 'mode', 'permission-mode', 'last-prompt', 'ai-title', 'atis-latch',
  'file-history-snapshot', 'file-history-delta', 'queue-operation', 'summary',
  // A client-side running total in dollars. Resolution 8: a transcript's cost is never
  // estimated, and this is the client's estimate, not the provider's figure.
  'cost-state',
]);

const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

export const isSessionId = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

// ---- vetting: the only ways a transcript string becomes a stored one ---------------

/** A value that would trip `redact` is not stored at all; masking it would still keep its neighbours. */
const clean = (s: string): boolean => redact(s, [], {}).redactions === 0;

/**
 * Bare 40-hex is a commit's shape and a classic GitHub token's; outside a verified commit it is
 * never stored as an id or a model. Paths named by a hash are legitimate and are left alone.
 */
const BARE_HEX40 = /^[0-9a-fA-F]{40}$/;

export function vetModel(v: unknown): string | null {
  return typeof v === 'string' && MODEL.test(v) && !BARE_HEX40.test(v) && clean(v) ? v : null;
}

export function vetTool(v: unknown): string {
  return typeof v === 'string' && TOOL.test(v) && clean(v) ? v : 'other';
}

/** A provider's message or tool-use id, kept for dedupe. Anything else odd becomes its hash. */
export function vetProviderId(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  return PROVIDER_ID.test(v) && !BARE_HEX40.test(v) && clean(v) ? v : `h_${sha256(v).slice(0, 32)}`;
}

export type VettedPath = { rel: string } | { outside: true } | { dropped: true };

/**
 * A tool input's path, relative to the project root, or why it is not kept. Outside the root
 * a path names someone's home directory layout and is counted, never named.
 */
export function vetPath(p: unknown, cwd: string | null, root: string): VettedPath {
  if (typeof p !== 'string' || !p || p.length > 4096 || CONTROL.test(p)) return { dropped: true };
  const abs = path.isAbsolute(p) ? path.normalize(p) : cwd && path.isAbsolute(cwd) ? path.resolve(cwd, p) : null;
  if (!abs) return { dropped: true };
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { outside: true };
  const posix = rel.split(path.sep).join('/');
  return clean(posix) ? { rel: posix } : { dropped: true };
}

const count = (n: unknown): number | null => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : null);

// ---- one line --------------------------------------------------------------------

export interface ToolFact {
  /** The tool_use id, vetted, or null. */
  id: string | null;
  name: string;
  read: string[];
  written: string[];
  outsidePaths: number;
  droppedPaths: number;
}

/** What one transcript line says, with every string already vetted. Holds no transcript text. */
export interface LineFacts {
  kind: 'assistant' | 'user' | 'ignored' | 'unknown' | 'corrupt';
  sessionId: string | null;
  agentId: string | null;
  /**
   * The working directory the line was written in. The one raw transcript string a fact
   * carries; it is used to match the session to the project and is never stored.
   */
  cwd: string | null;
  at: number | null;
  requestId: string | null;
  model: string | null;
  tokens: TokenUsage | null;
  tools: ToolFact[];
  /** tool_use ids of Agent/Task calls: what a subagent's `meta.json` `toolUseId` points at. */
  spawnIds: string[];
  /** 40-hex runs in Bash output. In memory only: unverified, any of them may be a secret. */
  shaCandidates: string[];
}

const EMPTY: Omit<LineFacts, 'kind'> = {
  sessionId: null, agentId: null, cwd: null, at: null, requestId: null, model: null, tokens: null,
  tools: [], spawnIds: [], shaCandidates: [],
};

/** Pure. `root` is the project root that paths are made relative to. */
export function parseLine(line: string, root: string): LineFacts {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return { kind: 'corrupt', ...EMPTY };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { kind: 'corrupt', ...EMPTY };
  const r = o as Record<string, unknown>;
  const type = r.type;
  const base = {
    ...EMPTY,
    tools: [] as ToolFact[],
    spawnIds: [] as string[],
    shaCandidates: [] as string[],
    sessionId: isSessionId(r.sessionId) ? r.sessionId : null,
    agentId: typeof r.agentId === 'string' && AGENT_ID.test(r.agentId) ? r.agentId : null,
    cwd: typeof r.cwd === 'string' && r.cwd && !CONTROL.test(r.cwd) ? r.cwd : null,
    at: typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp)) ? Date.parse(r.timestamp) : null,
  };
  if (type === 'assistant') {
    const m = (r.message && typeof r.message === 'object' ? r.message : {}) as Record<string, unknown>;
    const u = (m.usage && typeof m.usage === 'object' ? m.usage : null) as Record<string, unknown> | null;
    const facts: LineFacts = {
      ...base,
      kind: 'assistant',
      requestId: vetProviderId(m.id),
      model: vetModel(m.model),
      tokens: u ? {
        input: count(u.input_tokens),
        output: count(u.output_tokens),
        cacheRead: count(u.cache_read_input_tokens),
        cacheWrite: count(u.cache_creation_input_tokens),
      } : null,
    };
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (!c || typeof c !== 'object' || (c as Record<string, unknown>).type !== 'tool_use') continue;
      const item = c as Record<string, unknown>;
      const name = vetTool(item.name);
      const id = vetProviderId(item.id);
      const input = (item.input && typeof item.input === 'object' ? item.input : {}) as Record<string, unknown>;
      const tool: ToolFact = { id, name, read: [], written: [], outsidePaths: 0, droppedPaths: 0 };
      const rawPath = name === 'NotebookEdit' ? input.notebook_path : input.file_path;
      if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
        const v = vetPath(rawPath, base.cwd, root);
        if ('rel' in v) (WRITE_TOOLS.has(name) ? tool.written : tool.read).push(v.rel);
        else if ('outside' in v) tool.outsidePaths++;
        else tool.droppedPaths++;
      }
      if (SPAWN_TOOLS.has(name) && id) facts.spawnIds.push(id);
      facts.tools.push(tool);
    }
    return facts;
  }
  if (type === 'user') {
    const facts: LineFacts = { ...base, kind: 'user' };
    const result = r.toolUseResult;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const stdout = (result as Record<string, unknown>).stdout;
      if (typeof stdout === 'string') {
        const seen = new Set(stdout.match(HEX40) ?? []);
        facts.shaCandidates = [...seen].slice(0, MAX_SHA_CANDIDATES_PER_LINE);
      }
    }
    return facts;
  }
  return { ...base, kind: typeof type === 'string' && IGNORED_TYPES.has(type) ? 'ignored' : 'unknown' };
}

/**
 * `ev_cc_<sha256(sessionId \0 agentId \0 key)>`: the same fact read twice is one event. The keys
 * refine resolution 8's `message.id | line hash`: `usage:<message.id>:<seq>` for a turn,
 * `tool:<tool_use.id>` (or `tool:line_<sha256(line)>:<i>`) for a tool call, and
 * `finished:<linesSeen>:<prefixDigest>` for a transcript's run. `seq` is per attempt and in
 * insertion order, so a fresh `<out>` reproduces the same ids.
 */
export function eventId(sessionId: string, agentId: string, key: string): string {
  return `ev_cc_${sha256(`${sessionId}\0${agentId}\0${key}`)}`;
}

// ---- one transcript's new lines, folded --------------------------------------------

export interface LineCounts {
  lines: number;
  assistant: number;
  user: number;
  ignored: number;
  unknown: number;
  corrupt: number;
  oversize: number;
  /** Lines naming a different session or subagent than their file. */
  mismatched: number;
}

interface Turn {
  requestId: string;
  at: number | null;
  model: string | null;
  tokens: TokenUsage;
  /** Lines folded into this turn. More than one is a split message. */
  lines: number;
}

interface ToolEvent {
  key: string;
  at: number | null;
  name: string;
  paths: string[];
}

interface Folded {
  counts: LineCounts;
  turns: Map<string, Turn>;
  toolEvents: ToolEvent[];
  toolCounts: Map<string, number>;
  models: Map<string, number>;
  read: Set<string>;
  written: Set<string>;
  outsidePaths: number;
  droppedPaths: number;
  shaCandidates: Set<string>;
  cwds: Set<string>;
  firstAt: number | null;
  lastAt: number | null;
}

const maxOf = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

function fold(lines: string[], root: string, sessionId: string, agentId: string, oversize: number): Folded {
  const f: Folded = {
    counts: { lines: lines.length + oversize, assistant: 0, user: 0, ignored: 0, unknown: 0, corrupt: 0, oversize, mismatched: 0 },
    turns: new Map(), toolEvents: [], toolCounts: new Map(), models: new Map(), read: new Set(),
    written: new Set(), outsidePaths: 0, droppedPaths: 0, shaCandidates: new Set(), cwds: new Set(),
    firstAt: null, lastAt: null,
  };
  for (const line of lines) {
    const x = parseLine(line, root);
    f.counts[x.kind]++;
    if (x.kind === 'corrupt' || x.kind === 'ignored' || x.kind === 'unknown') continue;
    // A subagent's lines name it; a line naming another agent, in either file, is not this one's.
    if ((x.sessionId !== null && x.sessionId !== sessionId) || (x.agentId !== null && x.agentId !== agentId)) {
      f.counts[x.kind]--;
      f.counts.mismatched++;
      continue;
    }
    if (x.cwd) f.cwds.add(x.cwd);
    if (x.at !== null) {
      f.firstAt = f.firstAt === null ? x.at : Math.min(f.firstAt, x.at);
      f.lastAt = f.lastAt === null ? x.at : Math.max(f.lastAt, x.at);
    }
    for (const sha of x.shaCandidates) f.shaCandidates.add(sha);
    if (x.kind !== 'assistant') continue;
    if (x.model) f.models.set(x.model, (f.models.get(x.model) ?? 0) + 1);
    if (x.tokens) {
      // A line with usage but no usable message id is its own turn, keyed on its content so a
      // re-read finds it again.
      const requestId = x.requestId ?? `line_${sha256(line).slice(0, 32)}`;
      const was = f.turns.get(requestId);
      f.turns.set(requestId, was ? {
        requestId, at: was.at ?? x.at, model: was.model ?? x.model, lines: was.lines + 1,
        tokens: {
          input: maxOf(was.tokens.input, x.tokens.input),
          output: maxOf(was.tokens.output, x.tokens.output),
          cacheRead: maxOf(was.tokens.cacheRead, x.tokens.cacheRead),
          cacheWrite: maxOf(was.tokens.cacheWrite, x.tokens.cacheWrite),
        },
      } : { requestId, at: x.at, model: x.model, tokens: x.tokens, lines: 1 });
    }
    x.tools.forEach((t, i) => {
      f.toolCounts.set(t.name, (f.toolCounts.get(t.name) ?? 0) + 1);
      for (const p of t.read) f.read.add(p);
      for (const p of t.written) f.written.add(p);
      f.outsidePaths += t.outsidePaths;
      f.droppedPaths += t.droppedPaths;
      f.toolEvents.push({
        key: t.id ? `tool:${t.id}` : `tool:line_${sha256(line)}:${i}`,
        at: x.at, name: t.name, paths: [...t.written, ...t.read],
      });
    });
  }
  return f;
}

// ---- commits: only what the repository confirms ------------------------------------

/**
 * The candidates that name a commit in `root`. One hardened `git cat-file --batch-check`,
 * candidates on stdin so none of them appears in a process list.
 */
export function verifyCommits(root: string, candidates: Iterable<string>): Set<string> {
  const list = [...new Set(candidates)].filter((s) => /^[0-9a-f]{40}$/.test(s));
  const out = new Set<string>();
  if (!list.length) return out;
  let text: string;
  try {
    text = execFileSync('git', [...HARDENED_GIT_CONFIG, '-C', root, 'cat-file', '--batch-check'], {
      input: list.map((s) => `${s}^{commit}`).join('\n') + '\n',
      encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'], env: hardenedGitEnv(),
    });
  } catch {
    return out;
  }
  const asked = new Set(list);
  for (const row of text.split('\n')) {
    const m = /^([0-9a-f]{40}) commit \d+$/.exec(row.trim());
    // A tag's sha peels to its commit's, which is not the string the session printed.
    if (m && asked.has(m[1])) out.add(m[1]);
  }
  return out;
}

// ---- the invariant, checked at the write ---------------------------------------------

/** The summary's and payloads' own field names. Tool and model names as keys are vetted values. */
const STRUCT_KEYS = new Set([
  'kind', 'schemaVersion', 'source', 'origin', 'controls', 'sessionId', 'agentId', 'lines', 'from', 'to',
  'restarted', 'model', 'models', 'turns', 'tools', 'files', 'read', 'written', 'commits', 'sha', 'label',
  'counts', 'assistant', 'user', 'ignored', 'unknown', 'corrupt', 'oversize', 'mismatched', 'outsidePaths',
  'droppedValues', 'unverifiedHex', 'seq', 'requestId', 'inputTokens', 'outputTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'costUsd', 'tool', 'via', 'paths',
]);

const CONSTANT_STRINGS = new Set([
  RUNNER_ID, OUTSIDE_CONTROLS, COMMIT_LABEL, 'claude-code', 'ingested', 'transcript',
  'daylight-ingest-summary', 'claude-code-transcript',
]);

/**
 * Every string in `value`, keys included, is a constant of this module or one of `vetted`.
 * Stored transcript-derived strings are only relative paths, model names, tool names,
 * provider ids and repo-verified shas; this is where that is enforced rather than hoped.
 */
export function assertVetted(value: unknown, vetted: ReadonlySet<string>): void {
  const ok = (s: string) => CONSTANT_STRINGS.has(s) || vetted.has(s);
  const walk = (v: unknown, where: string): void => {
    if (typeof v === 'string') {
      if (!ok(v)) throw new Error(`ingest: refusing to store an unvetted string at ${where}`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${where}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (!STRUCT_KEYS.has(k) && !ok(k)) throw new Error(`ingest: refusing to store an unvetted key at ${where}`);
        walk(x, `${where}.${k}`);
      }
    }
  };
  walk(value, '$');
}

// ---- the run ---------------------------------------------------------------------------

/** `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects`: where Claude Code keeps transcripts. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return path.join(dir && path.isAbsolute(dir) ? dir : path.join(os.homedir(), '.claude'), 'projects');
}

/** Claude Code's directory name for a working directory: every non-alphanumeric is `-`. */
export const projectSlug = (root: string): string => path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');

export interface SkippedCounts {
  /** Sessions with a working directory in another project. Never ingested (R12.3). */
  foreign: number;
  /** Sessions whose working directory is gone or names no project. */
  unresolvable: number;
  /** Subagent transcripts with no main transcript beside them. */
  orphaned: number;
  /** Transcripts refused whole: too large, too many lines, unreadable, or a symlink. */
  refusedFiles: number;
  corruptLines: number;
  oversizeLines: number;
  unknownLines: number;
  mismatchedLines: number;
  /** Bytes after the last newline, left for the next run. */
  partialTailBytes: number;
  /** Paths outside the project root, counted and not named. */
  outsidePaths: number;
  /** Values dropped because they failed vetting (a secret shape, a control character). */
  droppedValues: number;
  /** 40-hex runs in Bash output that are not commits of this repository. */
  unverifiedHex: number;
  /** Subagents whose spawning tool call was not found; attached to the session's main attempt. */
  unresolvedParents: number;
}

export interface IngestResult {
  projectId: string;
  missionIds: string[];
  /** Attempts created this run. */
  attempts: number;
  /** Usage rows inserted or merged this run. */
  turns: number;
  /** Lines folded into a turn already counted: split messages and re-reads. */
  deduped: number;
  sessions: { seen: number; ingested: number; unchanged: number };
  skipped: SkippedCounts;
  /**
   * Attempts whose stored totals still differ from the sum of their usage rows after the run.
   * Always empty: an append refreshes them. Kept so the JSON checks itself.
   */
  staleTotals: string[];
}

/** `--session` named a session this project does not own. The CLI exits 2. */
export class SessionRefused extends Error {}

interface Transcript {
  agentId: string;
  file: string;
  read: NewLines;
  prior: IngestSource | null;
  folded: Folded;
  meta: { toolUseId: string | null; spawnDepth: number; model: string | null };
}

const zeroSkipped = (): SkippedCounts => ({
  foreign: 0, unresolvable: 0, orphaned: 0, refusedFiles: 0, corruptLines: 0, oversizeLines: 0,
  unknownLines: 0, mismatchedLines: 0, partialTailBytes: 0, outsidePaths: 0, droppedValues: 0,
  unverifiedHex: 0, unresolvedParents: 0,
});

const isPlainFile = (file: string): boolean => {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
};

function readMeta(file: string): Transcript['meta'] {
  const meta = { toolUseId: null as string | null, spawnDepth: 1, model: null as string | null };
  if (!isPlainFile(file)) return meta;
  try {
    const st = fs.statSync(file);
    if (st.size > 1024 * 1024) return meta;
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    meta.toolUseId = vetProviderId(o.toolUseId);
    if (Number.isSafeInteger(o.spawnDepth) && (o.spawnDepth as number) >= 1) meta.spawnDepth = o.spawnDepth as number;
    meta.model = vetModel(o.model);
  } catch {
    // A torn meta file loses the parent link and the fallback model, nothing else.
  }
  return meta;
}

const topModel = (models: Map<string, number>): string | null =>
  [...models].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;

/**
 * Ingest one session (`opts.session`) or every session in the project's transcript directory
 * (`opts.all`). `root` must be the root `ctx.out` holds a map of; the project is that map's.
 */
export function ingestClaudeCode(
  ctx: DaylightContext,
  root: string,
  opts: { session?: string; all?: boolean; projectsDir?: string },
): IngestResult {
  if ((opts.session === undefined) === !opts.all) throw new Error('ingest needs exactly one of a session id or all');
  if (opts.session !== undefined && !isSessionId(opts.session)) throw new Error('a session id is a lowercase uuid');
  const mapped = mappedRoot(ctx.out);
  if (!mapped || path.resolve(mapped) !== path.resolve(root)) {
    throw new Error(`${ctx.out} holds no map of ${root}; the project an ingest files into comes from the map`);
  }
  const abs = path.resolve(root);
  const project = identifyProject(abs);
  ctx.store.ensureProject(project);
  const dir = path.join(opts.projectsDir ?? claudeProjectsDir(), projectSlug(abs));
  const result: IngestResult = {
    projectId: project.id, missionIds: [], attempts: 0, turns: 0, deduped: 0,
    sessions: { seen: 0, ingested: 0, unchanged: 0 }, skipped: zeroSkipped(), staleTotals: [],
  };

  let sessionIds: string[];
  if (opts.session !== undefined) {
    if (!isPlainFile(path.join(dir, `${opts.session}.jsonl`))) {
      throw new Error(`no transcript for session ${opts.session} in this project's Claude Code directory`);
    }
    sessionIds = [opts.session];
  } else {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    sessionIds = names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -6)).filter(isSessionId).sort();
    const orphans = names.filter((n) => isSessionId(n) && !names.includes(`${n}.jsonl`));
    result.skipped.orphaned += orphans.length;
  }

  const projectOf = new Map<string, 'match' | 'foreign' | 'unresolvable'>();
  const classify = (cwd: string): 'match' | 'foreign' | 'unresolvable' => {
    let v = projectOf.get(cwd);
    if (v) return v;
    try {
      v = path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory()
        ? identifyProject(cwd).id === project.id ? 'match' : 'foreign'
        : 'unresolvable';
    } catch {
      v = 'unresolvable';
    }
    projectOf.set(cwd, v);
    return v;
  };

  for (const sessionId of sessionIds) {
    result.sessions.seen++;
    const outcome = ingestSession(ctx, abs, project.id, dir, sessionId, classify, result);
    if (outcome === 'foreign' || outcome === 'unresolvable') {
      result.skipped[outcome]++;
      if (opts.session !== undefined) {
        throw new SessionRefused(outcome === 'foreign'
          ? `session ${sessionId} was run in another project; it is not ingested into ${project.id}`
          : `session ${sessionId}'s working directory is gone or names no project; it is not ingested`);
      }
    } else if (outcome === 'unchanged') {
      result.sessions.unchanged++;
    } else {
      result.sessions.ingested++;
      if (!result.missionIds.includes(outcome.missionId)) result.missionIds.push(outcome.missionId);
    }
  }
  recordRun(ctx, project.id, result, opts.all ? 'all' : 'session');
  return result;
}

function ingestSession(
  ctx: DaylightContext, root: string, projectId: string, dir: string, sessionId: string,
  classify: (cwd: string) => 'match' | 'foreign' | 'unresolvable', result: IngestResult,
): 'foreign' | 'unresolvable' | 'unchanged' | { missionId: string } {
  const skipped = zeroSkipped();
  try {
    return ingestSessionInner(ctx, root, projectId, dir, sessionId, classify, result, skipped);
  } finally {
    for (const k of Object.keys(skipped) as Array<keyof SkippedCounts>) result.skipped[k] += skipped[k];
  }
}

function ingestSessionInner(
  ctx: DaylightContext, root: string, projectId: string, dir: string, sessionId: string,
  classify: (cwd: string) => 'match' | 'foreign' | 'unresolvable', result: IngestResult,
  skipped: SkippedCounts,
): 'foreign' | 'unresolvable' | 'unchanged' | { missionId: string } {
  const { store } = ctx;
  const files: Array<{ agentId: string; file: string; metaFile: string | null }> = [
    { agentId: '', file: path.join(dir, `${sessionId}.jsonl`), metaFile: null },
  ];
  const subDir = path.join(dir, sessionId, 'subagents');
  try {
    for (const n of fs.readdirSync(subDir).sort()) {
      const m = /^agent-(.+)\.jsonl$/.exec(n);
      if (!m) continue;
      // The id comes from a file name and is stored and printed, so it is vetted like any other.
      if (!AGENT_ID.test(m[1]) || !clean(m[1])) {
        skipped.refusedFiles++;
        continue;
      }
      files.push({ agentId: m[1], file: path.join(subDir, n), metaFile: path.join(subDir, `agent-${m[1]}.meta.json`) });
    }
  } catch {
    // No subagents.
  }

  // Phase 1: read and fold, writing nothing, so a session that turns out to belong elsewhere
  // leaves no trace here.
  const transcripts: Transcript[] = [];
  for (const f of files) {
    const prior = store.ingestSource(sessionId, f.agentId);
    if (prior && prior.projectId !== projectId) return 'foreign';
    if (!isPlainFile(f.file)) {
      skipped.refusedFiles++;
      if (f.agentId === '') return 'unchanged';
      continue;
    }
    const read = readNewLines(f.file, prior);
    if ('refused' in read) {
      skipped.refusedFiles++;
      if (f.agentId === '') return 'unchanged';
      continue;
    }
    const folded = fold(read.lines, root, sessionId, f.agentId, read.oversizeLines);
    transcripts.push({
      agentId: f.agentId, file: f.file, read, prior, folded,
      meta: f.metaFile ? readMeta(f.metaFile) : { toolUseId: null, spawnDepth: 0, model: null },
    });
  }
  const main = transcripts.find((t) => t.agentId === '')!;
  const cwds = new Set(transcripts.flatMap((t) => [...t.folded.cwds]));
  const verdicts = new Set([...cwds].map(classify));
  if (verdicts.has('foreign')) return 'foreign';
  if (verdicts.has('unresolvable') || (!main.prior && cwds.size === 0)) return 'unresolvable';

  const changed = transcripts.filter((t) => t.read.bytesSeen !== (t.prior?.bytesSeen ?? -1) || t.read.restarted || !t.prior);
  for (const t of transcripts) skipped.partialTailBytes += t.read.partialTailBytes;
  if (!changed.length) return 'unchanged';

  // Phase 2: write. Mission, then each transcript parent-first.
  let missionId = main.prior?.missionId;
  if (!missionId) {
    missionId = store.createMission({
      projectId, kind: 'work',
      objective: `Claude Code session ${sessionId}, ingested from its transcript; ${OUTSIDE_CONTROLS}`,
      baseRevision: currentRevision(root).label,
    }).id;
  }
  const attemptOf = new Map<string, string>();
  for (const t of transcripts) if (t.prior) attemptOf.set(t.agentId, t.prior.attemptId);

  // Which transcript each spawning tool call is in. Built over whole files, ids only, because a
  // subagent new this run may have been spawned by a line an earlier run already read.
  let spawnIndex: Map<string, string> | null = null;
  const spawnedIn = (toolUseId: string): string | undefined => {
    if (!spawnIndex) {
      spawnIndex = new Map();
      for (const t of transcripts) {
        for (const line of readAllLines(t.file)) {
          for (const id of parseLine(line, root).spawnIds) spawnIndex.set(id, t.agentId);
        }
      }
    }
    return spawnIndex.get(toolUseId);
  };

  const order = [main, ...transcripts.filter((t) => t !== main).sort((a, b) =>
    a.meta.spawnDepth - b.meta.spawnDepth || (a.agentId < b.agentId ? -1 : 1))];
  const subagents = transcripts.length - 1;
  let novel = false;
  for (const t of order) {
    if (!changed.includes(t) && attemptOf.has(t.agentId)) continue;
    let attemptId = attemptOf.get(t.agentId);
    const fresh = !attemptId;
    if (!attemptId) {
      let parentAttemptId: string | undefined;
      if (t !== main) {
        const host = t.meta.toolUseId ? spawnedIn(t.meta.toolUseId) : undefined;
        parentAttemptId = host !== undefined && host !== t.agentId ? attemptOf.get(host) : undefined;
        if (!parentAttemptId) {
          skipped.unresolvedParents++;
          parentAttemptId = attemptOf.get('');
        }
      }
      const task = store.createTask({
        missionId, role: 'session',
        objective: t === main ? 'the session\'s main transcript' : `subagent ${t.agentId} (spawn depth ${t.meta.spawnDepth})`,
      });
      attemptId = store.startAttempt({
        taskId: task.id, runnerId: RUNNER_ID, origin: 'ingested', parentAttemptId,
        at: t.folded.firstAt ?? undefined,
      }).id;
      attemptOf.set(t.agentId, attemptId);
      result.attempts++;
      // Recorded before anything else is written, cursor at zero: a crash from here on leaves
      // a source the next run resumes, rather than a second mission for the same session.
      store.recordIngestSource({
        sessionId, agentId: t.agentId, projectId, pathDigest: t.read.pathDigest,
        prefixDigest: sha256(''), bytesSeen: 0, linesSeen: 0, missionId, attemptId,
        ingestedAt: Date.now(),
      });
    }
    if (writeTranscript(ctx, root, projectId, missionId, sessionId, t, attemptId, fresh, skipped, result, subagents)) novel = true;
  }
  return novel ? { missionId } : 'unchanged';
}

function writeTranscript(
  ctx: DaylightContext, root: string, projectId: string, missionId: string, sessionId: string,
  t: Transcript, attemptId: string, fresh: boolean, skipped: SkippedCounts, result: IngestResult,
  subagents: number,
): boolean {
  const { store, events, artifacts } = ctx;
  const f = t.folded;
  const attempt = store.attempt(attemptId)!;
  const model = topModel(f.models) ?? t.meta.model;
  const commits = [...verifyCommits(root, f.shaCandidates)].sort();
  const vetted = new Set<string>([
    sessionId, t.agentId, projectId, missionId, attemptId, ...f.read, ...f.written, ...f.models.keys(),
    ...f.toolCounts.keys(), ...f.turns.keys(), ...commits, ...(model ? [model] : []),
  ]);

  let usageAdded = 0;
  for (const turn of f.turns.values()) {
    const r = store.recordUsage(attemptId, {
      requestId: turn.requestId, at: turn.at ?? undefined, model: turn.model, tokens: turn.tokens,
      costUsd: null, costSource: 'none', source: 'transcript',
    });
    result.deduped += turn.lines - 1;
    if (r.result === 'duplicate') {
      result.deduped++;
      continue;
    }
    usageAdded++;
    result.turns++;
    const payload = {
      seq: r.seq, requestId: turn.requestId, model: turn.model, inputTokens: turn.tokens.input,
      outputTokens: turn.tokens.output, cacheReadTokens: turn.tokens.cacheRead,
      cacheWriteTokens: turn.tokens.cacheWrite, costUsd: null, source: 'transcript',
    };
    assertVetted(payload, vetted);
    events.append({
      at: turn.at ?? undefined, projectId, missionId, taskId: attempt.taskId, attemptId, actorId: RUNNER_ID,
      category: 'cost', name: 'cost.usage', payload,
    }, eventId(sessionId, t.agentId, `usage:${turn.requestId}:${r.seq}`));
  }
  let toolsAdded = 0;
  for (const e of f.toolEvents) {
    const payload = { tool: e.name, via: 'claude-code-transcript', paths: e.paths };
    assertVetted(payload, vetted);
    const id = eventId(sessionId, t.agentId, e.key);
    if (events.has(id)) continue;
    toolsAdded++;
    events.append({
      at: e.at ?? undefined, projectId, missionId, taskId: attempt.taskId, attemptId, actorId: RUNNER_ID,
      category: 'tool', name: 'tool.call', payload,
    }, id);
  }

  const unverified = f.shaCandidates.size - commits.length;
  skipped.corruptLines += f.counts.corrupt;
  skipped.oversizeLines += f.counts.oversize;
  skipped.unknownLines += f.counts.unknown;
  skipped.mismatchedLines += f.counts.mismatched;
  skipped.outsidePaths += f.outsidePaths;
  skipped.droppedValues += f.droppedPaths;
  skipped.unverifiedHex += unverified;

  const cursor: IngestSource = {
    sessionId, agentId: t.agentId, projectId, pathDigest: t.read.pathDigest,
    prefixDigest: t.read.prefixDigest, bytesSeen: t.read.bytesSeen, linesSeen: t.read.linesSeen,
    missionId, attemptId, ingestedAt: Date.now(),
  };
  // Nothing new — a rewritten file read again, or lines that carried no facts: only the cursor
  // moves, so a re-run adds no rows.
  if (!fresh && attempt.state !== 'running' && usageAdded === 0 && toolsAdded === 0) {
    store.recordIngestSource(cursor);
    return false;
  }

  const summary = {
    kind: 'daylight-ingest-summary', schemaVersion: 1, source: 'claude-code', origin: 'ingested',
    controls: OUTSIDE_CONTROLS, sessionId, agentId: t.agentId,
    lines: { from: t.read.firstLine, to: t.read.linesSeen }, restarted: t.read.restarted,
    model, models: Object.fromEntries([...f.models].sort()),
    turns: f.turns.size, tools: Object.fromEntries([...f.toolCounts].sort()),
    files: { read: [...f.read].sort(), written: [...f.written].sort() },
    commits: commits.map((sha) => ({ sha, label: COMMIT_LABEL })),
    counts: { ...f.counts, outsidePaths: f.outsidePaths, droppedValues: f.droppedPaths, unverifiedHex: unverified },
  };
  assertVetted(summary, vetted);
  const ref: ArtifactRef = artifacts.put(canonicalJson(summary), {
    kind: 'ingest-summary', projectId, label: `claude-code ${sessionId}${t.agentId ? `/${t.agentId}` : ''}`,
    mediaType: 'application/json',
  });
  store.recordArtifact(ref);

  if (fresh || attempt.state === 'running') {
    store.finishAttempt(attemptId, {
      state: 'completed', costUsd: null, costSource: 'none', model: model ?? undefined,
      tokens: store.usageTotals(attemptId),
      usageSource: store.usageRows(attemptId).length ? 'transcript' : 'none',
      artifacts: [ref], at: f.lastAt ?? undefined,
    });
  } else if (usageAdded > 0) {
    store.refreshUsageTotals(attemptId);
  }
  const stored = store.attempt(attemptId)!.tokens;
  if (canonicalJson(stored) !== canonicalJson(store.usageTotals(attemptId))) result.staleTotals.push(attemptId);

  const finished: IngestSessionFinishedPayload = {
    sessionId, agentId: t.agentId, pathDigest: t.read.pathDigest, turns: f.turns.size,
    dedupedLines: [...f.turns.values()].reduce((n, x) => n + x.lines - 1, 0),
    skippedLines: f.counts.corrupt + f.counts.oversize + f.counts.unknown + f.counts.mismatched,
    subagents: t.agentId === '' ? subagents : 0,
  };
  events.append({
    projectId, missionId, taskId: attempt.taskId, attemptId, actorId: RUNNER_ID,
    category: 'lifecycle', name: 'ingest.session.finished', payload: { ...finished }, artifactIds: [ref.id],
  }, eventId(sessionId, t.agentId, `finished:${t.read.linesSeen}:${t.read.prefixDigest}`));

  store.recordIngestSource(cursor);
  return true;
}

/**
 * `ingest.run.finished`: the skip counts, which belong to no session and so to no mission.
 * Recorded only by a run that ingested something, so a re-run that changed nothing adds no
 * row; `ingest list` therefore shows the last run that did. Its id is its content's.
 */
function recordRun(ctx: DaylightContext, projectId: string, r: IngestResult, mode: 'all' | 'session'): void {
  if (r.sessions.ingested === 0) return;
  // `mode` lets `ingest list` prefer a whole-directory scan's counts over one session's.
  const payload = { mode, sessions: r.sessions, skipped: r.skipped };
  ctx.events.append({
    projectId, actorId: RUNNER_ID, category: 'lifecycle', name: 'ingest.run.finished', payload,
  }, eventId('', '', `run:${projectId}:${canonicalJson(payload)}`));
}
