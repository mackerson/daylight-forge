import path from 'node:path';
import type { CandidateFile, MissionScope, PolicyRule, PolicyViolation } from '../mission/types.ts';
import { isHumanActor } from '../mission/types.ts';

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
export const INVARIANTS_FILE = 'daylight.invariants.json';
export const MAX_DIFF_BYTES = 1024 * 1024;
export const MAX_DIFF_FILES = 200;

/** Lockfiles by basename, at any depth: each pins what an install would fetch and run. */
const LOCKFILES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
  'flake.lock',
]);

export interface PolicyContext {
  /** The mission's scope; an empty or absent `paths` admits every path. */
  scope?: MissionScope;
  /** The registered spec's repo-relative path, which the author may not edit. */
  specPath?: string;
  /** Size of the diff text in bytes, for the size cap. */
  diffBytes?: number;
  maxBytes?: number;
  maxFiles?: number;
}

/**
 * Why a single path is refused, every reason at once.
 *
 * Protected (fail-closed, at any depth): `package.json`, lockfiles, anything under
 * `node_modules`, any component starting `.git` (`.git/`, `.github/`, `.gitignore`,
 * `.gitattributes`, `.gitmodules`), the invariants file, and `scripts/` at the root. Each one
 * is a way to make an install, a hook, a CI job or a check run the author's code, or to hide
 * files from the host's `add -A`.
 */
export function pathViolations(file: CandidateFile, ctx: PolicyContext = {}): PolicyRule[] {
  const rules: PolicyRule[] = [];
  const p = file.path;
  const parts = p.split('/');
  const escapes = !p || p.includes('\0') || p.includes('\\') || path.posix.isAbsolute(p)
    || parts.some((s) => s === '..' || s === '.' || s === '');
  if (escapes) rules.push('path-escape');

  const base = parts.at(-1) ?? '';
  if (base === 'package.json' || LOCKFILES.has(base) || base === INVARIANTS_FILE
    || parts.includes('node_modules') || parts.some((s) => s.startsWith('.git'))
    || parts[0] === 'scripts') {
    rules.push('protected-path');
  }
  if (parts[0] === GATE_DIR) rules.push('gate-path');
  if (ctx.specPath !== undefined && p === normalise(ctx.specPath)) rules.push('spec-path');

  const scoped = (ctx.scope?.paths ?? []).map(normalise).filter(Boolean);
  if (scoped.length && !scoped.some((s) => p === s || p.startsWith(`${s}/`))) rules.push('outside-scope');

  const modes = [file.mode, file.previousMode];
  if (modes.includes('symlink')) rules.push('symlink');
  if (modes.includes('gitlink')) rules.push('gitlink');
  if (file.mode === 'executable' && file.change !== 'deleted') rules.push('exec-mode');
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
    for (const rule of new Set(pathViolations(f, ctx))) out.push({ rule, path: f.path });
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
  const set = AGENT_SESSION_VARS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (set.length) {
    throw new DecisionRefused(`refused: ${set.join(' and ')} is set, so an agent is running this; a human decides this from their own shell`);
  }
  if (!isHumanActor(actor)) throw new DecisionRefused(`refused: the actor must be human:<name>, not ${actor}`);
  const code = confirmCodeOf(digest);
  if (confirm === undefined || confirm.trim().toLowerCase() !== code) {
    // The expected code is not echoed: a retry should come from reading the digest, not this.
    throw new DecisionRefused('refused: --confirm must be the first eight characters of the digest you are deciding on');
  }
}
