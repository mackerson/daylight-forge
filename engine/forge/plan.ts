import { execFileSync } from 'node:child_process';
import { HARDENED_GIT_CONFIG, hardenedGitEnv } from '../experiment/runner.ts';
import { canonicalJson, digestOf } from '../mission/artifacts.ts';
import { workItemContentDigest, type CreateWorkItemInput } from '../mission/store.ts';
import type {
  ArtifactRef, GateHarness, PlanFileV1, PlanRefusal, PlanRule, PlanTicketV1, TicketAcceptance, TicketBudget,
} from '../mission/types.ts';
import { PLAN_KIND, PLAN_VERSION } from '../mission/types.ts';
import { pathViolations } from './policy.ts';
import { parseProjectPolicy, POLICY_FILE, ProjectPolicyError, type ProjectPolicy } from './project-policy.ts';
import {
  MAX_EXAMPLE_BYTES, MAX_EXAMPLES, MAX_STATEMENT_BYTES, MAX_TITLE_CHARS, repoPathRefusal, textRefusal,
} from './proposal.ts';
import { resolveCommit, specTree } from './spec.ts';

/**
 * A campaign plan as data (ADR-36): `daylight.plan.json`, read from git's object store at one
 * commit, never from the working tree, and validated like a proposal: it is text a person
 * approves, but it may have been written by an agent, so every field is capped, every id has a
 * grammar, and a refusal names a JSON path and a fixed reason, never the text it refused.
 *
 * Pure except `readPlanBlob` and `validatePlanAt`, which read git; nothing here opens a store.
 */

export const DEFAULT_PLAN_PATH = 'daylight.plan.json';
export const MAX_PLAN_BYTES = 2 * 1024 * 1024;
export const MAX_TICKETS = 2000;
export const MAX_LANES = 64;
export const MAX_OWNER_DECISIONS = 64;
export const MAX_CAMPAIGN_GATES = 16;
const MAX_LIST = 64;
const MAX_TESTS = 16;
const MAX_EXPECT_ITEMS = 8;
const MAX_EXPECT_BYTES = 256;
const MAX_ATTEMPTS = 10;
const MAX_PARALLEL = 16;

export const TICKET_ID = /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$/;
const LANE_ID = /^[A-Z][A-Z0-9]{0,7}$/;
const GATE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const OWNER_ID = /^O[A-Z0-9.]{1,31}$/;
/** Generated tickets live under these; a plan may not use them (§6.3, §5). */
export const RESERVED_LANE = 'FIX';
const RESERVED_TICKET = /^(FIX|FU)\./;
const HARNESSES: readonly GateHarness[] = ['node', 'cargo'];

export class PlanRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanRefused';
  }
}

function git(root: string, args: string[], maxBuffer = 4 * 1024 * 1024): Buffer {
  return execFileSync('git', [...HARDENED_GIT_CONFIG, '--literal-pathspecs', '-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, env: hardenedGitEnv(), maxBuffer,
  });
}

/**
 * A regular blob's bytes at `commit`, or null when `rel` is not one there. The ls-tree /
 * cat-file path `readSpecBlob` uses: by object id, no filter, hook or textconv, no symlink.
 */
function blobAt(root: string, commit: string, rel: string, maxBytes: number): Buffer | null {
  if (repoPathRefusal(rel)) return null;
  const entry = git(root, ['ls-tree', '-z', '--full-tree', commit, '--', rel]).toString('utf8').split('\0')[0];
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(entry ?? '');
  if (!m || m[4] !== rel || m[2] !== 'blob' || (m[1] !== '100644' && m[1] !== '100755')) return null;
  const size = Number(git(root, ['cat-file', '-s', m[3]]).toString('utf8').trim());
  if (!Number.isFinite(size) || size > maxBytes) throw new PlanRefused(`${rel} is over ${maxBytes} bytes`);
  return git(root, ['cat-file', 'blob', m[3]], maxBytes + 1);
}

/**
 * The plan's bytes at `commit`. Refused: a path outside the repository, anything that is not a
 * regular blob (symlink, submodule, directory), more than 2 MiB, NUL bytes, or not UTF-8.
 */
export function readPlanBlob(root: string, commit: string, rel: string): Buffer {
  const why = repoPathRefusal(rel);
  if (why) throw new PlanRefused(`plan path refused: ${why}`);
  const entry = git(root, ['ls-tree', '-z', '--full-tree', commit, '--', rel]).toString('utf8').split('\0')[0];
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(entry ?? '');
  if (!m || m[4] !== rel) throw new PlanRefused(`${rel} is not in commit ${commit.slice(0, 12)}`);
  const [, mode, type, oid] = m;
  if (mode === '120000') throw new PlanRefused(`${rel} is a symlink at ${commit.slice(0, 12)}; a plan is a regular file`);
  if (mode === '160000' || type === 'commit') throw new PlanRefused(`${rel} is a submodule at ${commit.slice(0, 12)}`);
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw new PlanRefused(`${rel} is not a regular file`);
  const size = Number(git(root, ['cat-file', '-s', oid]).toString('utf8').trim());
  if (!Number.isFinite(size) || size > MAX_PLAN_BYTES) throw new PlanRefused(`${rel} is ${size} bytes; a plan is at most ${MAX_PLAN_BYTES}`);
  const bytes = git(root, ['cat-file', 'blob', oid], MAX_PLAN_BYTES + 1);
  if (bytes.length > MAX_PLAN_BYTES) throw new PlanRefused(`${rel} is over ${MAX_PLAN_BYTES} bytes`);
  if (bytes.includes(0)) throw new PlanRefused(`${rel} has NUL bytes; a plan is text`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PlanRefused(`${rel} is not UTF-8`);
  }
  return bytes;
}

// ---- shape ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

class Refusals {
  list: PlanRefusal[] = [];
  add(path: string, rule: PlanRule, detail: string): void {
    this.list.push({ path, rule, detail });
  }
  /** Unknown keys are refused, not dropped: a plan that half-reads is not the plan approved. */
  keys(o: Obj, at: string, known: readonly string[]): void {
    for (const k of Object.keys(o)) if (!known.includes(k)) this.add(at, 'shape', 'unknown field');
  }
  text(v: unknown, at: string, maxBytes: number, multiline: boolean, maxChars?: number): void {
    const why = textRefusal(v, maxBytes, multiline) ?? (maxChars !== undefined && (v as string).length > maxChars ? `over ${maxChars} characters` : null);
    if (why) this.add(at, 'text', why);
  }
  /** A list of strings, at most `max` long. Returns the list, or null when it is not one. */
  strings(v: unknown, at: string, max: number, each: (s: unknown, at: string) => void): string[] | null {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      this.add(at, 'shape', 'not a list');
      return null;
    }
    if (v.length > max) {
      this.add(at, 'too-many', `more than ${max} entries`);
      return null;
    }
    v.forEach((s, i) => each(s, `${at}[${i}]`));
    return v.every((s) => typeof s === 'string') ? (v as string[]) : null;
  }
  id(v: unknown, at: string, re: RegExp, max = 32): boolean {
    if (typeof v !== 'string' || v.length > max || !re.test(v)) {
      this.add(at, 'shape', 'not a valid id');
      return false;
    }
    return true;
  }
}

/** A repo-relative prefix: `src/a/` and `src/a` are the same prefix. */
export const prefixOf = (p: string): string => p.replace(/\/+$/, '');
const under = (p: string, prefix: string) => p === prefix || p.startsWith(`${prefix}/`);

function checkPrefix(r: Refusals, v: unknown, at: string): void {
  if (typeof v !== 'string') return r.add(at, 'scope-path', 'not a string');
  const why = repoPathRefusal(prefixOf(v));
  if (why) r.add(at, 'scope-path', why);
}

function checkExpect(r: Refusals, v: unknown, at: string): void {
  if (!isObj(v)) return r.add(at, 'shape', 'not an object');
  r.keys(v, at, ['exitCode', 'stdoutIncludes', 'stderrIncludes']);
  if (v.exitCode !== undefined && !(Number.isInteger(v.exitCode) && (v.exitCode as number) >= 0 && (v.exitCode as number) <= 255)) {
    r.add(`${at}.exitCode`, 'shape', 'not an exit code');
  }
  for (const k of ['stdoutIncludes', 'stderrIncludes'] as const) {
    r.strings(v[k], `${at}.${k}`, MAX_EXPECT_ITEMS, (s, a) => r.text(s, a, MAX_EXPECT_BYTES, false));
  }
  // An expectation that says nothing matches anything; the runner refuses one, so does the plan.
  if (v.exitCode === undefined && !(v.stdoutIncludes as unknown[] | undefined)?.length && !(v.stderrIncludes as unknown[] | undefined)?.length) {
    r.add(at, 'shape', 'an expectation names an exit code or output');
  }
}

function checkHarness(r: Refusals, o: Obj, at: string): void {
  if (o.harness !== undefined && !HARNESSES.includes(o.harness as GateHarness)) r.add(`${at}.harness`, 'acceptance-harness', 'not a known harness');
  if (o.crate !== undefined) {
    if (o.harness !== 'cargo') r.add(`${at}.crate`, 'acceptance-harness', 'a crate is named only for the cargo harness');
    checkPrefix(r, o.crate, `${at}.crate`);
  }
}

function checkAcceptance(r: Refusals, v: unknown, at: string): void {
  if (v === undefined) return;
  if (!isObj(v)) return r.add(at, 'shape', 'not an object');
  switch (v.kind) {
    case 'ci-only':
      r.keys(v, at, ['kind']);
      return;
    case 'gate': {
      r.keys(v, at, ['kind', 'tests']);
      if (!Array.isArray(v.tests) || !v.tests.length) return r.add(`${at}.tests`, 'shape', 'a gate acceptance names its tests');
      if (v.tests.length > MAX_TESTS) return r.add(`${at}.tests`, 'too-many', `more than ${MAX_TESTS} entries`);
      v.tests.forEach((t, i) => {
        const a = `${at}.tests[${i}]`;
        if (!isObj(t)) return r.add(a, 'shape', 'not an object');
        r.keys(t, a, ['path', 'harness', 'crate', 'expect']);
        if (typeof t.path !== 'string' || repoPathRefusal(t.path)) r.add(`${a}.path`, 'acceptance-path', 'not a repo-relative path');
        checkHarness(r, t, a);
        checkExpect(r, t.expect, `${a}.expect`);
      });
      return;
    }
    case 'writer-authored':
      r.keys(v, at, ['kind', 'harness', 'crate', 'testPaths', 'expect']);
      checkHarness(r, v, at);
      checkExpect(r, v.expect, `${at}.expect`);
      if (!Array.isArray(v.testPaths) || !v.testPaths.length) return r.add(`${at}.testPaths`, 'shape', 'names the paths the author writes tests at');
      if (v.testPaths.length > MAX_TESTS) return r.add(`${at}.testPaths`, 'too-many', `more than ${MAX_TESTS} entries`);
      v.testPaths.forEach((p, i) => {
        if (typeof p !== 'string' || repoPathRefusal(prefixOf(p))) r.add(`${at}.testPaths[${i}]`, 'acceptance-path', 'not a repo-relative path');
      });
      return;
    default:
      r.add(`${at}.kind`, 'shape', 'gate, ci-only or writer-authored');
  }
}

function checkBudget(r: Refusals, v: unknown, at: string): void {
  if (v === undefined) return;
  if (!isObj(v)) return r.add(at, 'shape', 'not an object');
  r.keys(v, at, ['maxUsd', 'maxTurns', 'timeoutSeconds', 'maxAttempts']);
  if (v.maxUsd !== undefined && !(typeof v.maxUsd === 'number' && Number.isFinite(v.maxUsd) && v.maxUsd > 0)) r.add(`${at}.maxUsd`, 'shape', 'a positive dollar figure');
  for (const k of ['maxTurns', 'timeoutSeconds'] as const) {
    if (v[k] !== undefined && !(Number.isInteger(v[k]) && (v[k] as number) > 0)) r.add(`${at}.${k}`, 'shape', 'a positive whole number');
  }
  if (v.maxAttempts !== undefined && !(Number.isInteger(v.maxAttempts) && (v.maxAttempts as number) >= 1 && (v.maxAttempts as number) <= MAX_ATTEMPTS)) {
    r.add(`${at}.maxAttempts`, 'shape', `1 to ${MAX_ATTEMPTS}`);
  }
}

/**
 * The plan, typed, or every shape rule it breaks: JSON, the kind and version exact, no unknown
 * key, ids in their grammars, text within `proposal.ts`'s caps, lists within theirs.
 */
export function parsePlan(raw: Buffer | string): PlanFileV1 | PlanRefusal[] {
  const r = new Refusals();
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (bytes(text) > MAX_PLAN_BYTES) return [{ path: '$', rule: 'too-large', detail: `over ${MAX_PLAN_BYTES} bytes` }];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [{ path: '$', rule: 'shape', detail: 'not JSON' }];
  }
  if (!isObj(doc)) return [{ path: '$', rule: 'shape', detail: 'not an object' }];
  if (doc.kind !== PLAN_KIND || doc.version !== PLAN_VERSION) {
    return [{ path: '$', rule: 'version', detail: `this build reads ${PLAN_KIND} version ${PLAN_VERSION} only` }];
  }
  r.keys(doc, '$', ['kind', 'version', 'title', 'derivedStatus', 'statusPath', 'defaults', 'campaignGates', 'lanes', 'ownerDecisions', 'tickets']);
  r.text(doc.title, '$.title', MAX_TITLE_CHARS * 4, false, MAX_TITLE_CHARS);
  if (doc.derivedStatus !== undefined && typeof doc.derivedStatus !== 'boolean') r.add('$.derivedStatus', 'shape', 'yes or no');
  if (doc.statusPath !== undefined && (typeof doc.statusPath !== 'string' || repoPathRefusal(doc.statusPath))) {
    r.add('$.statusPath', 'scope-path', 'not a repo-relative path');
  }
  if (doc.defaults !== undefined) {
    if (!isObj(doc.defaults)) r.add('$.defaults', 'shape', 'not an object');
    else {
      r.keys(doc.defaults, '$.defaults', ['budget', 'acceptance']);
      checkBudget(r, doc.defaults.budget, '$.defaults.budget');
      checkAcceptance(r, doc.defaults.acceptance, '$.defaults.acceptance');
    }
  }
  const lists: Array<[string, number, boolean]> = [
    ['campaignGates', MAX_CAMPAIGN_GATES, true], ['lanes', MAX_LANES, true], ['ownerDecisions', MAX_OWNER_DECISIONS, false], ['tickets', MAX_TICKETS, true],
  ];
  for (const [k, max, required] of lists) {
    const v = doc[k];
    if (v === undefined && !required) continue;
    if (!Array.isArray(v)) r.add(`$.${k}`, 'shape', 'not a list');
    else if (v.length > max) r.add(`$.${k}`, 'too-many', `more than ${max} entries`);
  }
  if (r.list.some((x) => x.rule === 'shape' && /^\$\.(campaignGates|lanes|ownerDecisions|tickets)$/.test(x.path) || x.rule === 'too-many')) return r.list;

  (doc.campaignGates as unknown[]).forEach((g, i) => {
    const at = `$.campaignGates[${i}]`;
    if (!isObj(g)) return r.add(at, 'shape', 'not an object');
    r.keys(g, at, ['id', 'role', 'harness', 'path', 'crate', 'expect', 'timeoutSeconds']);
    r.id(g.id, `${at}.id`, GATE_ID);
    if (g.role !== 'regression') r.add(`${at}.role`, 'shape', 'a campaign gate is a regression gate');
    if (typeof g.path !== 'string' || repoPathRefusal(g.path)) r.add(`${at}.path`, 'acceptance-path', 'not a repo-relative path');
    checkHarness(r, g, at);
    checkExpect(r, g.expect, `${at}.expect`);
    if (g.timeoutSeconds !== undefined && !(Number.isInteger(g.timeoutSeconds) && (g.timeoutSeconds as number) > 0)) {
      r.add(`${at}.timeoutSeconds`, 'shape', 'a positive whole number');
    }
  });
  (doc.lanes as unknown[]).forEach((l, i) => {
    const at = `$.lanes[${i}]`;
    if (!isObj(l)) return r.add(at, 'shape', 'not an object');
    r.keys(l, at, ['id', 'title', 'owns', 'maxParallel', 'shared']);
    if (r.id(l.id, `${at}.id`, LANE_ID, 8) && l.id === RESERVED_LANE) r.add(`${at}.id`, 'shape', 'reserved for the fix lane');
    r.text(l.title, `${at}.title`, MAX_TITLE_CHARS * 4, false, MAX_TITLE_CHARS);
    if (!Array.isArray(l.owns) || !l.owns.length) r.add(`${at}.owns`, 'shape', 'a lane owns at least one prefix');
    else r.strings(l.owns, `${at}.owns`, MAX_LIST, (s, a) => checkPrefix(r, s, a));
    r.strings(l.shared, `${at}.shared`, MAX_LIST, (s, a) => checkPrefix(r, s, a));
    if (l.maxParallel !== undefined && !(Number.isInteger(l.maxParallel) && (l.maxParallel as number) >= 1 && (l.maxParallel as number) <= MAX_PARALLEL)) {
      r.add(`${at}.maxParallel`, 'shape', `1 to ${MAX_PARALLEL}`);
    }
  });
  ((doc.ownerDecisions as unknown[] | undefined) ?? []).forEach((o, i) => {
    const at = `$.ownerDecisions[${i}]`;
    if (!isObj(o)) return r.add(at, 'shape', 'not an object');
    r.keys(o, at, ['id', 'question', 'options', 'blocking', 'rationale', 'default']);
    r.id(o.id, `${at}.id`, OWNER_ID);
    r.text(o.question, `${at}.question`, MAX_STATEMENT_BYTES, true);
    r.strings(o.options, `${at}.options`, MAX_EXAMPLES, (s, a) => r.text(s, a, MAX_EXAMPLE_BYTES, false));
    if (typeof o.blocking !== 'boolean') r.add(`${at}.blocking`, 'shape', 'yes or no');
    if (o.rationale !== undefined) r.text(o.rationale, `${at}.rationale`, MAX_STATEMENT_BYTES, true);
    if (o.default !== undefined) r.text(o.default, `${at}.default`, MAX_EXAMPLE_BYTES, true);
  });
  (doc.tickets as unknown[]).forEach((t, i) => {
    const at = `$.tickets[${i}]`;
    if (!isObj(t)) return r.add(at, 'shape', 'not an object');
    r.keys(t, at, ['id', 'lane', 'title', 'statement', 'examples', 'negativeExamples', 'dependsOn', 'blocksOn', 'scope', 'acceptance', 'budget']);
    if (r.id(t.id, `${at}.id`, TICKET_ID) && RESERVED_TICKET.test(t.id as string)) r.add(`${at}.id`, 'shape', 'FIX. and FU. are reserved for generated tickets');
    r.id(t.lane, `${at}.lane`, LANE_ID, 8);
    r.text(t.title, `${at}.title`, MAX_TITLE_CHARS * 4, false, MAX_TITLE_CHARS);
    if (Array.isArray(t.statement)) {
      if (!t.statement.length || t.statement.some((s) => typeof s !== 'string')) r.add(`${at}.statement`, 'shape', 'a list of lines');
      else r.text(t.statement.join('\n'), `${at}.statement`, MAX_STATEMENT_BYTES, true);
    } else r.text(t.statement, `${at}.statement`, MAX_STATEMENT_BYTES, true);
    for (const k of ['examples', 'negativeExamples'] as const) {
      r.strings(t[k], `${at}.${k}`, MAX_EXAMPLES, (s, a) => r.text(s, a, MAX_EXAMPLE_BYTES, true));
    }
    r.strings(t.dependsOn, `${at}.dependsOn`, MAX_LIST, (s, a) => r.id(s, a, TICKET_ID));
    r.strings(t.blocksOn, `${at}.blocksOn`, MAX_LIST, (s, a) => r.id(s, a, OWNER_ID));
    if (!Array.isArray(t.scope) || !t.scope.length) r.add(`${at}.scope`, 'shape', 'a ticket names its scope');
    else r.strings(t.scope, `${at}.scope`, MAX_LIST, (s, a) => checkPrefix(r, s, a));
    checkAcceptance(r, t.acceptance, `${at}.acceptance`);
    checkBudget(r, t.budget, `${at}.budget`);
  });
  return r.list.length ? r.list : (doc as unknown as PlanFileV1);
}

export const isPlanRefusals = (v: PlanFileV1 | PlanRefusal[]): v is PlanRefusal[] => Array.isArray(v);

// ---- meaning ---------------------------------------------------------------------------

export interface PlanValidationContext {
  /** `git ls-tree -r` at the plan commit. */
  tree: ReadonlySet<string>;
  /** A regular blob at the plan commit, or null. */
  blobAt: (p: string) => Buffer | null;
  /** `daylight.policy.json` at the plan commit, parsed, or null when there is none. */
  policy: ProjectPolicy | null;
  /** Where the plan itself sits; refused as any ticket's scope. */
  planPath?: string;
}

/** Ticket ids in dependency order (Kahn), ties broken by plan order. Ids in a cycle are left out. */
export function topoOrder(tickets: ReadonlyArray<Pick<PlanTicketV1, 'id' | 'dependsOn'>>): string[] {
  const index = new Map(tickets.map((t, i) => [t.id, i]));
  const indegree = new Map(tickets.map((t) => [t.id, (t.dependsOn ?? []).filter((d) => index.has(d)).length]));
  const dependents = new Map<string, string[]>();
  for (const t of tickets) for (const d of t.dependsOn ?? []) if (index.has(d)) dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
  const ready = tickets.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const out: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => index.get(a)! - index.get(b)!);
    const id = ready.shift()!;
    out.push(id);
    for (const n of dependents.get(id) ?? []) {
      indegree.set(n, indegree.get(n)! - 1);
      if (indegree.get(n) === 0) ready.push(n);
    }
  }
  return out;
}

/** One cycle among the tickets, as its id path (`A → B → A`), or null. */
function findCycle(tickets: readonly PlanTicketV1[]): string[] | null {
  const deps = new Map(tickets.map((t) => [t.id, t.dependsOn ?? []]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const t of tickets) if (!state.has(t.id)) {
    const c = visit(t.id);
    if (c) return c;
  }
  return null;
}

const SYNTHETIC = { change: 'modified', insertions: 0, deletions: 0, mode: 'file' } as const;

/** Why a scope prefix is one no author may be given, or null: protected, a gate path, an escape. */
function protectedScope(p: string, policy: ProjectPolicy | null): boolean {
  return pathViolations({ path: p, ...SYNTHETIC }, { policy }).some((r) => r === 'protected-path' || r === 'gate-path' || r === 'path-escape');
}

/**
 * Every rule the parsed plan breaks against its own commit, all at once: unique ids, known
 * lanes, dependencies and owner decisions, no cycle, scopes that exist, are not protected and
 * sit inside their lane, lanes that do not overlap except where both share, and gate and
 * acceptance paths that are regular files (and crates that have a manifest) at the commit.
 */
export function validatePlan(plan: PlanFileV1, ctx: PlanValidationContext): PlanRefusal[] {
  const r = new Refusals();
  const dup = (ids: string[], at: string) => {
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (seen.has(id)) r.add(`${at}[${i}].id`, 'duplicate-id', 'id used twice');
      seen.add(id);
    });
  };
  dup(plan.campaignGates.map((g) => g.id), '$.campaignGates');
  dup(plan.lanes.map((l) => l.id), '$.lanes');
  dup((plan.ownerDecisions ?? []).map((o) => o.id), '$.ownerDecisions');
  dup(plan.tickets.map((t) => t.id), '$.tickets');

  const lanes = new Map(plan.lanes.map((l) => [l.id, l]));
  const owners = new Map((plan.ownerDecisions ?? []).map((o) => [o.id, o]));
  const tickets = new Set(plan.tickets.map((t) => t.id));
  const protectedPaths = new Set([ctx.planPath, plan.statusPath].filter((p): p is string => !!p).map(prefixOf));
  const isFile = (p: string) => ctx.tree.has(p);
  const dirs = new Set<string>();
  for (const f of ctx.tree) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  const exists = (p: string) => isFile(p) || dirs.has(p);
  const isCrate = (c: string) => isFile(`${prefixOf(c)}/Cargo.toml`);

  (plan.ownerDecisions ?? []).forEach((o, i) => {
    if (!o.blocking && !o.default?.trim()) r.add(`$.ownerDecisions[${i}].default`, 'owner-default-missing', 'a non-blocking owner decision names its default');
  });

  plan.lanes.forEach((a, i) => plan.lanes.forEach((b, j) => {
    if (j <= i) return;
    for (const oa of a.owns.map(prefixOf)) for (const ob of b.owns.map(prefixOf)) {
      if (!under(oa, ob) && !under(ob, oa)) continue;
      const region = oa.length >= ob.length ? oa : ob;
      const sharedBy = (l: typeof a) => (l.shared ?? []).map(prefixOf).some((s) => under(region, s));
      if (!(sharedBy(a) && sharedBy(b))) r.add(`$.lanes[${j}].owns`, 'lane-overlap', `overlaps lane ${a.id} outside a prefix both share`);
    }
  }));

  const gatePath = (at: string, p: string, harness: unknown, crate: unknown) => {
    if (!ctx.blobAt(p)) r.add(at, 'acceptance-path', 'not a regular file at the plan commit');
    if (protectedPaths.has(p)) r.add(at, 'acceptance-path', 'the plan itself is not a test');
    if (typeof crate === 'string' && !isCrate(crate)) r.add(at, 'acceptance-path', 'the crate has no Cargo.toml at the plan commit');
    if (harness === 'cargo' && typeof crate === 'string' && !under(p, `${prefixOf(crate)}/tests`)) {
      r.add(at, 'acceptance-path', 'a cargo test sits under its crate\'s tests/');
    }
  };
  plan.campaignGates.forEach((g, i) => gatePath(`$.campaignGates[${i}].path`, g.path, g.harness, g.crate));

  plan.tickets.forEach((t, i) => {
    const at = `$.tickets[${i}]`;
    const lane = lanes.get(t.lane);
    if (!lane) r.add(`${at}.lane`, 'unknown-lane', 'no lane with this id');
    (t.dependsOn ?? []).forEach((d, k) => {
      if (d === t.id) r.add(`${at}.dependsOn[${k}]`, 'self-dependency', 'a ticket does not depend on itself');
      else if (!tickets.has(d)) r.add(`${at}.dependsOn[${k}]`, 'unknown-dependency', 'no ticket with this id');
    });
    (t.blocksOn ?? []).forEach((o, k) => {
      if (!owners.has(o)) r.add(`${at}.blocksOn[${k}]`, 'unknown-owner-decision', 'no owner decision with this id');
    });
    const owns = (lane?.owns ?? []).map(prefixOf);
    t.scope.forEach((raw, k) => {
      const s = prefixOf(raw);
      const sat = `${at}.scope[${k}]`;
      if (protectedPaths.has(s) || protectedScope(s, ctx.policy)) r.add(sat, 'scope-protected', 'an author may not be given this path');
      const planned = raw.endsWith('/') && owns.some((o) => under(s, o));
      if (!exists(s) && !planned) r.add(sat, 'scope-path', 'not a file or directory at the plan commit');
      if (lane && !owns.some((o) => under(s, o))) r.add(sat, 'scope-outside-lane', `not inside lane ${lane.id}'s prefixes`);
    });
    const acc = t.acceptance;
    if (acc?.kind === 'gate') acc.tests.forEach((g, k) => gatePath(`${at}.acceptance.tests[${k}].path`, g.path, g.harness, g.crate));
    if (acc?.kind === 'writer-authored') {
      if (acc.crate !== undefined && !isCrate(acc.crate)) r.add(`${at}.acceptance.crate`, 'acceptance-path', 'the crate has no Cargo.toml at the plan commit');
      acc.testPaths.forEach((p, k) => {
        const tp = prefixOf(p);
        if (!t.scope.map(prefixOf).some((s) => under(tp, s))) r.add(`${at}.acceptance.testPaths[${k}]`, 'acceptance-path', 'outside the ticket\'s scope');
        if (acc.harness === 'cargo' && acc.crate !== undefined && !under(tp, `${prefixOf(acc.crate)}/tests`)) {
          r.add(`${at}.acceptance.testPaths[${k}]`, 'acceptance-path', 'a cargo test sits under its crate\'s tests/');
        }
      });
    }
  });

  const known = plan.tickets.filter((t) => (t.dependsOn ?? []).every((d) => d !== t.id));
  const cycle = findCycle(known);
  if (cycle) r.add('$.tickets', 'cycle', cycle.join(' → '));
  return r.list;
}

/**
 * `daylight.policy.json` at `commit`, from its blob, never the working tree (P2-R20), or null
 * when there is none. Throws `ProjectPolicyError` when it does not parse.
 */
export function policyAt(root: string, commit: string): ProjectPolicy | null {
  const blob = blobAt(root, commit, POLICY_FILE, 64 * 1024);
  return blob ? parseProjectPolicy(blob) : null;
}

/** The plan file at `rev` (default HEAD) of `root`, parsed and validated. Opens no store. */
export function validatePlanAt(root: string, rel: string, rev = 'HEAD'): {
  plan: PlanFileV1 | null; refusals: PlanRefusal[]; planDigest: string | null; commit: string; policy: ProjectPolicy | null; bytes: Buffer | null;
} {
  const commit = resolveCommit(root, rev);
  let bytes: Buffer;
  try {
    bytes = readPlanBlob(root, commit, rel);
  } catch (err) {
    if (!(err instanceof PlanRefused)) throw err;
    return { plan: null, refusals: [{ path: '$', rule: /over \d+ bytes|is \d+ bytes/.test(err.message) ? 'too-large' : 'shape', detail: err.message }], planDigest: null, commit, policy: null, bytes: null };
  }
  const planDigest = digestOf(bytes);
  let policy: ProjectPolicy | null = null;
  try {
    policy = policyAt(root, commit);
  } catch (err) {
    if (!(err instanceof ProjectPolicyError) && !(err instanceof PlanRefused)) throw err;
    return { plan: null, refusals: [{ path: POLICY_FILE, rule: 'policy', detail: 'the project policy at the plan commit does not parse' }], planDigest, commit, policy: null, bytes };
  }
  const parsed = parsePlan(bytes);
  if (isPlanRefusals(parsed)) return { plan: null, refusals: parsed, planDigest, commit, policy, bytes };
  const tree = specTree(root, commit);
  const refusals = validatePlan(parsed, { tree, blobAt: (p) => (tree.has(p) ? blobAt(root, commit, p, 4 * 1024 * 1024) : null), policy, planPath: rel });
  return { plan: refusals.length ? null : parsed, refusals, planDigest, commit, policy, bytes };
}

// ---- tickets -------------------------------------------------------------------------

export const statementOf = (t: Pick<PlanTicketV1, 'statement'>): string => (Array.isArray(t.statement) ? t.statement.join('\n') : t.statement);
export const acceptanceOf = (t: PlanTicketV1, defaults: PlanFileV1['defaults']): TicketAcceptance =>
  t.acceptance ?? defaults?.acceptance ?? { kind: 'ci-only' };
export const budgetOf = (t: PlanTicketV1, defaults: PlanFileV1['defaults']): TicketBudget => ({ ...defaults?.budget, ...t.budget });

/** The digest of a ticket as it will be built: its fields with the plan's defaults applied. */
export function ticketDigestOf(t: PlanTicketV1, defaults: PlanFileV1['defaults']): string {
  return digestOf(canonicalJson({
    id: t.id, lane: t.lane, title: t.title, statement: statementOf(t), examples: t.examples ?? [], negativeExamples: t.negativeExamples ?? [],
    dependsOn: [...(t.dependsOn ?? [])].sort(), blocksOn: [...(t.blocksOn ?? [])].sort(), scope: t.scope.map(prefixOf),
    acceptance: acceptanceOf(t, defaults), budget: budgetOf(t, defaults),
  }));
}

/** `w_` + 32 hex of sha256 over the campaign, the ticket and its content, so re-import is idempotent. */
export function ticketWorkItemId(campaignId: string, ticketId: string, contentDigest: string): string {
  return `w_${digestOf(canonicalJson([campaignId, ticketId, contentDigest])).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

export const anchorOfTicket = (ticketId: string): string => `ticket:${ticketId}`;

/** A plan ticket as the work item a person approves with the plan. */
export function planTicketToWorkItem(
  t: PlanTicketV1, o: { campaignId: string; projectId: string; planArtifact: ArtifactRef; planRevision: string },
): CreateWorkItemInput & { id: string } {
  const base = {
    projectId: o.projectId, missionId: o.campaignId, specArtifact: o.planArtifact, specRevision: o.planRevision,
    anchor: anchorOfTicket(t.id), title: t.title, statement: statementOf(t), examples: t.examples ?? [],
    negativeExamples: t.negativeExamples ?? [], proposedBy: 'plan',
  };
  return { ...base, id: ticketWorkItemId(o.campaignId, t.id, workItemContentDigest(base)) };
}

/** Topological layers: what could run together if every dependency landed at once. A preview. */
export function wavesPreview(tickets: ReadonlyArray<Pick<PlanTicketV1, 'id' | 'dependsOn'>>): string[][] {
  const depth = new Map<string, number>();
  const deps = new Map(tickets.map((t) => [t.id, t.dependsOn ?? []]));
  for (const id of topoOrder(tickets)) depth.set(id, Math.max(-1, ...deps.get(id)!.map((d) => depth.get(d) ?? -1)) + 1);
  const out: string[][] = [];
  for (const id of topoOrder(tickets)) (out[depth.get(id)!] ??= []).push(id);
  return out;
}
