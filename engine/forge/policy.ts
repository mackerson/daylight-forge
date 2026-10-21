import { createRequire } from 'node:module';
import path from 'node:path';
import type { CandidateFile, MissionScope, PolicyRule, PolicyViolation } from '../mission/types.ts';
import { isHumanActor } from '../mission/types.ts';
import { protectedBy, type ProjectPolicy } from './project-policy.ts';

/**
 * The Forge's pure rules: which paths a candidate diff may touch (ADR-21), and whether a
 * human decision is being made by a human (ADR-20, R10.4).
 *
 * Nothing here reads a file, runs git or knows a database. A rule that needed either would be
 * a rule a caller could skip by not having it to hand; these take everything as arguments and
 * are the one implementation every workstream calls.
 */

// ---- candidate paths ---------------------------------------------------------

export const GATE_DIR = '.daylight-gates';
export { INVARIANTS_FILE } from './project-policy.ts';
export const MAX_DIFF_BYTES = 1024 * 1024;
export const MAX_DIFF_FILES = 200;

export interface PolicyContext {
  /** The mission's scope; an empty or absent `paths` admits every path. */
  scope?: MissionScope;
  /** The registered spec's repo-relative path, which the author may not edit. */
  specPath?: string;
  /** Size of the diff text in bytes, for the size cap. */
  diffBytes?: number;
  maxBytes?: number;
  maxFiles?: number;
  /**
   * The project's `daylight.policy.json`, loaded by the host. Absent: the `always` and `node`
   * sets, exactly as before policies existed.
   */
  policy?: ProjectPolicy | null;
}

/**
 * Why a single path is refused, every reason at once.
 *
 * Protected (fail-closed): every set in `PROTECTED_SETS`, whatever the policy's `languages`,
 * plus the policy's own globs: among them `package.json`, lockfiles, anything under
 * `node_modules`, any component starting `.git` (`.git/`, `.github/`, `.gitignore`,
 * `.gitattributes`, `.gitmodules`), Cargo manifests and build scripts, the invariants and
 * policy files, and `scripts/` at the root. Each one is a
 * way to make an install, a hook, a CI job or a check run the author's code, or to hide files
 * from the host's `add -A`.
 */
export function pathViolations(file: CandidateFile, ctx: PolicyContext = {}): PolicyRule[] {
  const rules: PolicyRule[] = [];
  const p = file.path;
  const parts = p.split('/');
  const escapes = !p || p.includes('\0') || p.includes('\\') || path.posix.isAbsolute(p)
    || parts.some((s) => s === '..' || s === '.' || s === '');
  if (escapes) rules.push('path-escape');

  if (protectedBy(p, ctx.policy).length) rules.push('protected-path');
  if (parts[0] === GATE_DIR) rules.push('gate-path');
  if (ctx.specPath !== undefined && p === normalise(ctx.specPath)) rules.push('spec-path');

  const scoped = (ctx.scope?.paths ?? []).map(normalise).filter(Boolean);
  if (scoped.length && !scoped.some((s) => p === s || p.startsWith(`${s}/`))) rules.push('outside-scope');

  const modes = [file.mode, file.previousMode];
  if (modes.includes('symlink')) rules.push('symlink');
  if (modes.includes('gitlink')) rules.push('gitlink');
  // Becoming executable is refused; editing a script that already was one is not (ADR-21).
  if (file.mode === 'executable' && file.change !== 'deleted' && file.previousMode !== 'executable') rules.push('exec-mode');
  return rules;
}

/**
 * Every violation in a candidate's file list, path by path, then the whole-diff rules: an
 * empty diff, more than `maxFiles` files, more than `maxBytes` of diff. Ordered by path, so
 * the same diff always yields the same list.
 */
export function checkPolicy(files: readonly CandidateFile[], ctx: PolicyContext = {}): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    for (const rule of new Set(pathViolations(f, ctx))) {
      // Which set matched is said only under a loaded policy, so a repository without one
      // records exactly the rows it did before policies existed.
      const why = rule === 'protected-path' && ctx.policy ? `protected by the ${protectedBy(f.path, ctx.policy).join(' and ')} set` : undefined;
      out.push(why ? { rule, path: f.path, why } : { rule, path: f.path });
    }
  }
  if (!files.length) out.push({ rule: 'empty-diff', path: null });
  if (files.length > (ctx.maxFiles ?? MAX_DIFF_FILES)) out.push({ rule: 'too-many-files', path: null });
  if ((ctx.diffBytes ?? 0) > (ctx.maxBytes ?? MAX_DIFF_BYTES)) out.push({ rule: 'too-large', path: null });
  return out;
}

// ---- gate-forgery shapes (P2-R43) ------------------------------------------------

/**
 * The `why` of a `gate-forgery-shape` violation. A heuristic: library code that writes to fd 1
 * directly, exits the process, or prints a test runner's summary can make a gate's run look like
 * a pass from inside the code under test. Expected to be rare in library code; a false positive
 * is a person's call, made outside the candidate, since no decision waves an uncurable rule through.
 */
export const forgeryWhy = (shapes: readonly string[]): string =>
  `heuristic (P2-R43): added non-test code has ${shapes.join(', ')}, a shape that can forge a gate's pass; a false positive is a person's call`;

const RUST_SHAPES: ReadonlyArray<[string, RegExp]> = [
  ['from_raw_fd(1)', /from_raw_fd\(\s*1\s*\)/],
  ['libc::write(1', /libc::write\(\s*1\b/],
  ['std::process::exit(', /std::process::exit\s*\(/],
  ['test result: ok.', /test result: ok\./],
  ['running 0 tests', /running 0 tests/],
];
const JS_SHAPES: ReadonlyArray<[string, RegExp]> = [
  ['process.stdout.write( with a test summary', /process\.stdout\.write\(\s*['"`][^'"`]*(?:# pass|# fail 0|ok 1)/],
  ['fs.writeSync(1,', /\bfs\.writeSync\(\s*1\s*,/],
  ['TAP version', /TAP version/],
];
const PROCESS_EXIT_0 = /\bprocess\.exit\(\s*0\s*\)/;
const JS_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** A test file by its path: under `tests/` or `__tests__/`, or named `*.test.*`. */
export function isTestPath(p: string): boolean {
  const parts = p.split('/');
  return parts.slice(0, -1).some((s) => s === 'tests' || s === '__tests__') || /\.test\.[^/]+$/.test(parts.at(-1) ?? '');
}

/** A binary's entry point, where `std::process::exit` is how a program ends: `main.rs`, `bin/*.rs`. */
const rustEntryPoint = (p: string) => /(^|\/)main\.rs$/.test(p) || /(^|\/)bin\/[^/]+\.rs$/.test(p);

/**
 * The 1-based lines of a Rust file inside a `#[cfg(test)]` item's braces (the attribute line on),
 * by a small lexer that skips comments, strings, raw strings and char literals.
 */
export function rustTestLines(src: string): Set<number> {
  const out = new Set<number>();
  let line = 1;
  let depth = 0;
  let pendingFrom = 0;
  let open: { depth: number; from: number } | null = null;
  const attr = /^#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') { line++; continue; }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      i--;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let nest = 1;
      i += 2;
      while (i < src.length && nest > 0) {
        if (src[i] === '\n') line++;
        if (src[i] === '/' && src[i + 1] === '*') { nest++; i++; } else if (src[i] === '*' && src[i + 1] === '/') { nest--; i++; }
        i++;
      }
      i--;
      continue;
    }
    const raw = (ch === 'r' || ch === 'b') && (i === 0 || !/\w/.test(src[i - 1])) ? /^b?r(#*)"/.exec(src.slice(i, i + 260)) : null;
    if (raw) {
      const close = `"${raw[1]}`;
      const end = src.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? src.length : end + close.length;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop - 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i++;
        if (src[i] === '\n') line++;
        i++;
      }
      continue;
    }
    if (ch === '\'') {
      if (src[i + 1] === '\\') {
        i += 2;
        while (i < src.length && src[i] !== '\'' && src[i] !== '\n') i++;
      } else if (src[i + 2] === '\'') i += 2;
      continue;
    }
    if (ch === '#' && attr.test(src.slice(i, i + 40))) {
      if (!open) pendingFrom = line;
      continue;
    }
    if (ch === ';' && pendingFrom && !open) { pendingFrom = 0; continue; }
    if (ch === '{') {
      depth++;
      if (pendingFrom && !open) { open = { depth, from: pendingFrom }; pendingFrom = 0; }
      continue;
    }
    if (ch === '}') {
      if (open && depth === open.depth) {
        for (let n = open.from; n <= line; n++) out.add(n);
        open = null;
      }
      depth--;
    }
  }
  if (open) for (let n = open.from; n <= line; n++) out.add(n);
  return out;
}

type Ts = typeof import('typescript');
let tsModule: Ts | null = null;
/** Loaded on first use: most candidates never call `process.exit(0)`, and policy is imported widely. */
const typescript = (): Ts => (tsModule ??= createRequire(import.meta.url)('typescript') as Ts);

/** The 1-based lines holding a `process.exit(0)` call outside every function body. */
function topLevelExits(p: string, src: string): Set<number> {
  const ts = typescript();
  const sf = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, true);
  const out = new Set<number>();
  const visit = (n: import('typescript').Node, inFunction: boolean): void => {
    const fn = inFunction || ts.isFunctionLike(n);
    if (!fn && ts.isCallExpression(n) && n.expression.getText(sf).replace(/\s+/g, '') === 'process.exit'
      && n.arguments.length === 1 && n.arguments[0].getText(sf).trim() === '0') {
      out.add(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, (c) => visit(c, fn));
  };
  visit(sf, false);
  return out;
}

/**
 * The forgery shapes on `added` lines (1-based, of `postImage`) of one non-test file, by name;
 * empty for a test file, a file of another language, or added lines without any.
 */
export function forgeryShapes(p: string, postImage: string, added: readonly number[]): string[] {
  if (!added.length || isTestPath(p)) return [];
  const lines = postImage.split('\n');
  const found = new Set<string>();
  if (p.endsWith('.rs')) {
    const inTests = rustTestLines(postImage);
    for (const n of added) {
      if (inTests.has(n)) continue;
      for (const [name, re] of RUST_SHAPES) {
        if (name === 'std::process::exit(' && rustEntryPoint(p)) continue;
        if (re.test(lines[n - 1] ?? '')) found.add(name);
      }
    }
  } else if (JS_FILE.test(p)) {
    let exits: Set<number> | null = null;
    for (const n of added) {
      const text = lines[n - 1] ?? '';
      for (const [name, re] of JS_SHAPES) if (re.test(text)) found.add(name);
      if (PROCESS_EXIT_0.test(text) && (exits ??= topLevelExits(p, postImage)).has(n)) found.add('process.exit(0) outside a function');
    }
  }
  return [...found];
}

const normalise = (p: string) => path.posix.normalize(p.trim()).replace(/^(\.\/)+/, '').replace(/\/+$/, '');

// ---- decision authenticity -----------------------------------------------------

export class DecisionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionRefused';
  }
}

/** Variables that mean "an agent is running this command". */
export const AGENT_SESSION_VARS = ['DAYLIGHT_SESSION', 'CLAUDECODE'] as const;

/** The 8 hex characters a person types to confirm they saw this digest. */
export function confirmCodeOf(digest: string): string {
  const m = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (!m) throw new DecisionRefused(`${digest} is not a sha256 digest`);
  return m[1].slice(0, 8);
}

/**
 * The one guard on every Forge human act: authorize, gate lock, work-item approve, candidate
 * approve, override and apply (ADR-20, R10.4). WS4, WS7 and WS8 call this; none reimplements it.
 *
 * Refused when the environment says an agent is driving (`DAYLIGHT_SESSION` or `CLAUDECODE`
 * set to anything), when the actor is not `human:<name>`, and when `confirm` is not the first
 * eight hex of the digest being decided on. A heuristic, not authentication: it catches an
 * agent approving its own work by accident, not a person determined to lie.
 */
export function assertHumanDecision(
  env: Readonly<Record<string, string | undefined>>, actor: string, confirm: string | undefined, digest: string,
): void {
  const why = guardCheck(env, actor, confirm, digest);
  if (why !== null) throw new DecisionRefused(why);
}

/**
 * The same rules as `assertHumanDecision`, answered rather than enforced: the reason the act
 * would be refused, or null when it would pass. Read-only, for a UI that shows why a button
 * is disabled before anyone presses it (R12.5). Never a substitute for the assert at the act.
 */
export function guardCheck(
  env: Readonly<Record<string, string | undefined>>, actor: string, confirm: string | undefined, digest: string,
): string | null {
  const set = AGENT_SESSION_VARS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (set.length) {
    return `refused: ${set.join(' and ')} is set, so an agent is running this; a human decides this from their own shell`;
  }
  if (!isHumanActor(actor)) return `refused: the actor must be human:<name>, not ${actor}`;
  let code: string;
  try {
    code = confirmCodeOf(digest);
  } catch (err) {
    return (err as Error).message;
  }
  if (confirm === undefined || confirm.trim().toLowerCase() !== code) {
    // The expected code is not echoed: a retry should come from reading the digest, not this.
    return 'refused: --confirm must be the first eight characters of the digest you are deciding on';
  }
  return null;
}
