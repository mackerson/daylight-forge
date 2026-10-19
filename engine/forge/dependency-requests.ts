import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import type { DaylightContext } from '../mission/context.ts';
import { redact } from '../mission/redact.ts';
import type { Attempt, Decision, Mission, Need } from '../mission/types.ts';
import { assertHumanDecision, confirmCodeOf } from './policy.ts';
import { textRefusal } from './proposal.ts';

/**
 * The `request-dependency` need (RULINGS P2-R4): an author that needs a crate or a package it
 * may not add itself (every manifest and lockfile is protected) asks for it through the MCP
 * `request_dependency` tool. The request is one line in its attempt's outbox, data and never a
 * command: nothing here edits a manifest, fetches a package or runs anything. A person adds
 * the dependency, refreshes the snapshot, and records that with `daylight deps resolve`, a
 * guarded human decision like every other.
 *
 * Input is hostile twice: the server checks each call, and the host checks every line again
 * when it reads the outbox, since the outbox is a file the agent's uid can write. Provenance
 * (attempt, mission) is the host's, from which outbox it read, never from the line.
 */

export const REQUEST_DEPENDENCY_TOOL = 'request_dependency';
export const ECOSYSTEMS = ['cargo', 'npm'] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];
export const MAX_DEPENDENCY_NAME_CHARS = 128;
/** crates.io's own limit on a crate name. */
export const MAX_CRATE_NAME_CHARS = 64;
export const MAX_DEPENDENCY_VERSION_CHARS = 64;
export const MAX_DEPENDENCY_REASON_BYTES = 1024;
export const MAX_DEPENDENCY_REQUESTS_PER_ATTEMPT = 20;
const MAX_LINE_BYTES = 4 * 1024;
const MAX_OUTBOX_BYTES = (MAX_DEPENDENCY_REQUESTS_PER_ATTEMPT + 1) * MAX_LINE_BYTES;
export const RESOLVE_OPERATION = 'resolve-dependency-request' as const;

export interface DependencyRequest {
  ecosystem: Ecosystem;
  name: string;
  /** A registry version requirement (`1`, `^1.2`, `>=0.4, <0.6`); never a URL, path or git ref. */
  version?: string;
  reason: string;
}

export type DependencyRequestField = 'payload' | 'ecosystem' | 'name' | 'version' | 'reason' | 'count';
export interface DependencyRequestRefusal { field: DependencyRequestField; refused: string }
export const isRequestRefusal = (v: DependencyRequest | DependencyRequestRefusal): v is DependencyRequestRefusal => 'refused' in v;

/** A crate name as cargo accepts it: ASCII alphanumerics, `-` and `_`, starting with a letter. */
const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** An npm name: lower case, optionally `@scope/`, never starting with `.` or `_`. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/**
 * A version requirement: comparators of requirement characters only (no `:` or `/`, so no URL,
 * path or git source), joined by `,` with optional spaces after it. No other whitespace and no
 * comparator starting `-`, so nothing in it reads as a flag (`1 --registry=evil`).
 */
const VERSION = /^[0-9A-Za-z.^~=<>*+|][0-9A-Za-z.^~=<>*+|-]*(?:, ?[0-9A-Za-z.^~=<>*+|][0-9A-Za-z.^~=<>*+|-]*)*$/;

const refuse = (field: DependencyRequestField, refused: string): DependencyRequestRefusal => ({ field, refused });

/**
 * The request, normalised, or the first rule it breaks. A refusal names the field and a fixed
 * reason, never the text. Unknown keys are refused, not dropped: provenance is the host's.
 */
export function validateDependencyRequest(raw: unknown): DependencyRequest | DependencyRequestRefusal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('payload', 'not an object');
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !['ecosystem', 'name', 'version', 'reason'].includes(k))) return refuse('payload', 'unknown field');
  if (!(ECOSYSTEMS as readonly unknown[]).includes(r.ecosystem)) return refuse('ecosystem', `must be one of ${ECOSYSTEMS.join(', ')}`);
  const ecosystem = r.ecosystem as Ecosystem;
  if (typeof r.name !== 'string' || !r.name) return refuse('name', 'empty');
  if (r.name.length > MAX_DEPENDENCY_NAME_CHARS) return refuse('name', `over ${MAX_DEPENDENCY_NAME_CHARS} characters`);
  if (ecosystem === 'cargo' && (r.name.length > MAX_CRATE_NAME_CHARS || !CRATE_NAME.test(r.name))) return refuse('name', 'not a crate name');
  if (ecosystem === 'npm' && !NPM_NAME.test(r.name)) return refuse('name', 'not an npm package name');
  let version: string | undefined;
  if (r.version !== undefined) {
    if (typeof r.version !== 'string' || !r.version.trim()) return refuse('version', 'empty');
    version = r.version.trim();
    if (version.length > MAX_DEPENDENCY_VERSION_CHARS) return refuse('version', `over ${MAX_DEPENDENCY_VERSION_CHARS} characters`);
    if (!VERSION.test(version)) return refuse('version', 'not a version requirement');
  }
  const reasonWhy = textRefusal(r.reason, MAX_DEPENDENCY_REASON_BYTES, true);
  if (reasonWhy) return refuse('reason', reasonWhy);
  return { ecosystem, name: r.name, ...(version !== undefined ? { version } : {}), reason: r.reason as string };
}

// ---- the outbox ------------------------------------------------------------------

/** `<out>/dependency-requests/<attemptId>.jsonl`, keyed by the attempt the host bound the server to. */
export const DEPENDENCY_REQUESTS_DIR = 'dependency-requests';
export const requestOutboxFile = (out: string, attemptId: string): string =>
  path.join(out, DEPENDENCY_REQUESTS_DIR, `${attemptId}.jsonl`);

export interface RequestOutboxLine { v: 1; at: number; request: DependencyRequest }

function readLines(file: string): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return [];
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return [];
    const buf = Buffer.alloc(MAX_OUTBOX_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

/** The valid requests in one attempt's outbox, each re-checked and redacted; the rest are skipped. */
export function readRequestOutbox(out: string, attemptId: string): DependencyRequest[] {
  const got: DependencyRequest[] = [];
  for (const raw of readLines(requestOutboxFile(out, attemptId))) {
    if (got.length >= MAX_DEPENDENCY_REQUESTS_PER_ATTEMPT) break;
    if (!raw.trim() || Buffer.byteLength(raw, 'utf8') > MAX_LINE_BYTES) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const env = line as Partial<RequestOutboxLine>;
    if (!env || typeof env !== 'object' || env.v !== 1 || Object.keys(env).some((k) => !['v', 'at', 'request'].includes(k))) continue;
    const checked = validateDependencyRequest(env.request);
    if (!isRequestRefusal(checked)) got.push({ ...checked, reason: redact(checked.reason).text });
  }
  return got;
}

/**
 * Registers `request_dependency` on an author's MCP server. Each accepted call is one line in
 * the attempt's outbox; the reply says nothing was installed and a person decides.
 */
export function registerRequestDependencyTool(server: McpServer, ctx: { attempt: Pick<Attempt, 'id'>; out: string }): void {
  const file = requestOutboxFile(ctx.out, ctx.attempt.id);
  const reply = (body: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(body) }], ...(isError ? { isError: true } : {}),
  });
  server.registerTool(
    REQUEST_DEPENDENCY_TOOL,
    {
      description:
        'Ask a person to add ONE dependency you need: you may not edit Cargo.toml, package.json, any lockfile ' +
        'or build script yourself. `ecosystem` is cargo or npm, `name` the crate or package, `version` an optional ' +
        'registry requirement (e.g. "1" or "^0.4"), `reason` one short paragraph on why. Nothing is installed now; ' +
        `a person decides, and the mission is re-run if they add it. At most ${MAX_DEPENDENCY_REQUESTS_PER_ATTEMPT} per session.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        ecosystem: z.enum(ECOSYSTEMS),
        name: z.string().max(MAX_DEPENDENCY_NAME_CHARS),
        version: z.string().max(MAX_DEPENDENCY_VERSION_CHARS).optional(),
        reason: z.string().max(MAX_DEPENDENCY_REASON_BYTES),
      },
    },
    async (a) => {
      const checked = validateDependencyRequest(a);
      if (isRequestRefusal(checked)) return reply({ accepted: false, field: checked.field, reason: checked.refused }, true);
      if (readRequestOutbox(ctx.out, ctx.attempt.id).length >= MAX_DEPENDENCY_REQUESTS_PER_ATTEMPT) {
        return reply({ accepted: false, field: 'count', reason: `at most ${MAX_DEPENDENCY_REQUESTS_PER_ATTEMPT} requests per session` }, true);
      }
      const line: RequestOutboxLine = { v: 1, at: Date.now(), request: { ...checked, reason: redact(checked.reason).text } };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
        try {
          fs.writeSync(fd, `${JSON.stringify(line)}\n`);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return reply({ accepted: false, field: 'payload', reason: 'the request could not be recorded' }, true);
      }
      return reply({ accepted: true, installed: false, note: 'recorded for a person to decide; carry on without it or stop' });
    },
  );
}

// ---- reading requests --------------------------------------------------------------

export interface DependencyRequestRow extends DependencyRequest {
  /** `dr_<32 hex>`, derived from the mission and the dependency, so one ask is one row however often it is made. */
  id: string;
  missionId: string;
  projectId: string;
  /** The author attempts that asked, oldest first. */
  attemptIds: string[];
  status: 'open' | 'resolved';
  decisionId: string | null;
}

export function dependencyRequestId(missionId: string, r: Pick<DependencyRequest, 'ecosystem' | 'name' | 'version'>): string {
  const hex = createHash('sha256').update(canonicalJson([missionId, r.ecosystem, r.name, r.version ?? null])).digest('hex');
  return `dr_${hex.slice(0, 32)}`;
}
export const isDependencyRequestId = (s: unknown): boolean => typeof s === 'string' && /^dr_[0-9a-f]{32}$/.test(s);

const resolutionOf = (decisions: readonly Decision[], id: string): Decision | null =>
  decisions.filter((d) => d.scope.operation === RESOLVE_OPERATION && d.scope.requestId === id).at(-1) ?? null;

/** Every request the mission's author attempts filed, with whether a person has resolved it. */
export function missionDependencyRequests(ctx: Pick<DaylightContext, 'out' | 'store'>, mission: Mission): DependencyRequestRow[] {
  if (mission.kind !== 'implement') return [];
  const rows = new Map<string, DependencyRequestRow>();
  const decisions = ctx.store.decisions(mission.id);
  for (const task of ctx.store.tasks(mission.id).filter((t) => t.role === 'author')) {
    for (const a of ctx.store.attempts(task.id)) {
      for (const r of readRequestOutbox(ctx.out, a.id)) {
        const id = dependencyRequestId(mission.id, r);
        const seen = rows.get(id);
        if (seen) {
          if (!seen.attemptIds.includes(a.id)) seen.attemptIds.push(a.id);
          continue;
        }
        const d = resolutionOf(decisions, id);
        rows.set(id, {
          id, missionId: mission.id, projectId: mission.projectId, attemptIds: [a.id], ...r,
          status: d ? 'resolved' : 'open', decisionId: d?.id ?? null,
        });
      }
    }
  }
  return [...rows.values()];
}

export function dependencyRequests(ctx: Pick<DaylightContext, 'out' | 'store'>, o: { missionId?: string } = {}): DependencyRequestRow[] {
  const missions = o.missionId ? [ctx.store.mission(o.missionId)].filter((m): m is Mission => !!m) : ctx.store.missions();
  return missions.flatMap((m) => missionDependencyRequests(ctx, m));
}

const describe = (r: Pick<DependencyRequest, 'ecosystem' | 'name' | 'version'>) => `${r.ecosystem} ${r.name}${r.version ? ` ${r.version}` : ''}`;

/** One `request-dependency` need per open request (ADR-13: derived on read, never stored). */
export function dependencyNeeds(ctx: Pick<DaylightContext, 'out' | 'store'>, mission: Mission): Need[] {
  return missionDependencyRequests(ctx, mission)
    .filter((r) => r.status === 'open')
    .map((r) => ({
      kind: 'request-dependency', ref: r.id,
      why: `the author asked for ${describe(r)}; a person adds it (or declines), then runs \`daylight deps resolve ${r.id}\``,
    }));
}

// ---- resolving -----------------------------------------------------------------------

export class DependencyRequestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyRequestRefused';
  }
}

/**
 * What `--confirm` checks for a resolve: the request's identity, its dependency, and whether it
 * is declined, so a code confirmed for adding a dependency does not decline it or the reverse.
 */
export function resolveConfirm(r: DependencyRequestRow, o: { declined?: boolean } = {}): { digest: string; digest8: string; lines: string[] } {
  const declined = o.declined === true;
  const digest = digestOf(canonicalJson({
    operation: RESOLVE_OPERATION, requestId: r.id, missionId: r.missionId, ecosystem: r.ecosystem, name: r.name, version: r.version ?? null, declined,
  }));
  return {
    digest, digest8: confirmCodeOf(digest),
    lines: [
      `${declined ? 'decline' : 'resolve'} dependency request ${r.id} on mission ${r.missionId}`,
      `${describe(r)} (asked by ${r.attemptIds.length} attempt(s))`,
      'this records your decision only: it edits no manifest and runs nothing',
    ],
  };
}

export function findDependencyRequest(ctx: Pick<DaylightContext, 'out' | 'store'>, requestId: string): DependencyRequestRow {
  if (!isDependencyRequestId(requestId)) throw new DependencyRequestRefused(`not a dependency request id: ${requestId.slice(0, 80)}`);
  const found = dependencyRequests(ctx).find((r) => r.id === requestId);
  if (!found) throw new DependencyRequestRefused(`unknown dependency request ${requestId}`);
  return found;
}

/** What a person does after resolving, by ecosystem. Never run here. */
export function nextSteps(r: Pick<DependencyRequest, 'ecosystem'>, repo: string, missionId: string): string {
  return r.ecosystem === 'cargo'
    ? `add the crate to the manifest yourself, then run \`daylight deps snapshot ${repo}\`, then \`daylight forge run ${missionId} ${repo} --tools <author>\``
    : `add the package to package.json and the lockfile yourself, then \`daylight forge run ${missionId} ${repo} --tools <author>\``;
}

export interface ResolveInput {
  requestId: string;
  actor: string;
  rationale: string | undefined;
  confirm: string | undefined;
  env: NodeJS.ProcessEnv;
  /** `--declined`: the person will not add it; recorded as a `reject` decision. */
  declined?: boolean;
}

/**
 * `deps resolve`: the guard first, against the request's own digest; then a rationale; then
 * one decision row recording it. Refused under CLAUDECODE or DAYLIGHT_SESSION like every
 * decision. It changes no file in the repository and runs no snapshot.
 */
export function resolveDependencyRequest(ctx: DaylightContext, input: ResolveInput): { decision: Decision; request: DependencyRequestRow; next: string } {
  const r = findDependencyRequest(ctx, input.requestId);
  const declined = input.declined === true;
  assertHumanDecision(input.env, input.actor, input.confirm, resolveConfirm(r, { declined }).digest);
  if (!input.rationale?.trim()) throw new DependencyRequestRefused('refused: resolving a dependency request needs a rationale');
  if (r.status === 'resolved') throw new DependencyRequestRefused(`dependency request ${r.id} is already resolved (${r.decisionId})`);
  const mission = ctx.store.mission(r.missionId)!;
  const decision = ctx.store.recordDecision({
    missionId: mission.id, projectId: mission.projectId, revision: mission.baseRevision, actor: input.actor, kind: declined ? 'reject' : 'approve',
    rationale: input.rationale.trim(),
    scope: { operation: RESOLVE_OPERATION, requestId: r.id, ecosystem: r.ecosystem, name: r.name, version: r.version ?? null, declined },
    artifactIds: [],
  });
  ctx.events.append({
    projectId: mission.projectId, missionId: mission.id, actorId: input.actor, category: 'approval', name: 'dependency.request.resolved',
    payload: { decisionId: decision.id, requestId: r.id, ecosystem: r.ecosystem, name: r.name, version: r.version ?? null, declined },
  });
  const repo = ctx.store.project(mission.projectId)?.root ?? '<repo>';
  const next = declined ? `nothing to add; re-run \`daylight forge run ${mission.id} ${repo} --tools <author>\` if the author should try without it` : nextSteps(r, repo, mission.id);
  return { decision, request: { ...r, status: 'resolved', decisionId: decision.id }, next };
}
