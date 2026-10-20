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
/** A captured path longer than this is refused as `path-escape` (review M2). */
export const MAX_PATH_COMPONENTS = 64;
export const MAX_PATH_BYTES = 1024;

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
    || parts.some((s) => s === '..' || s === '.' || s === '')
    || parts.length > MAX_PATH_COMPONENTS || Buffer.byteLength(p) > MAX_PATH_BYTES;
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
