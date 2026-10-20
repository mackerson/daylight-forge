import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GateHarness } from '../mission/types.ts';

/**
 * Per-project policy (RULINGS P2-R6): `<repo>/daylight.policy.json`, read by the host from the
 * repository's working tree, never by an agent. It adds protected globs, names the project's
 * languages and gate harness, and sets the author's turn and time defaults.
 *
 * It can only tighten what an author may touch (P2-R32): every built-in set applies whatever
 * the file says, and `protectedPaths` only adds. `languages` only chooses which sets the author
 * prompt lists first and, without `gate.harness`, the default gate harness; it never unprotects anything.
 *
 * The protected sets are data (`PROTECTED_SETS`) so that the matcher, the author prompt and
 * docs/daylight/POLICY.md are all read off one list.
 */

export const POLICY_FILE = 'daylight.policy.json';
export const POLICY_SCHEMA = 'daylight.policy/v1';
export const INVARIANTS_FILE = 'daylight.invariants.json';
export const MAX_POLICY_BYTES = 64 * 1024;
export const MAX_AUTHOR_TURNS = 1000;
export const MAX_AUTHOR_TIMEOUT_SECONDS = 6 * 60 * 60;
export const MAX_PROTECTED_GLOBS = 64;
export const MAX_GLOB_CHARS = 256;
const MAX_GLOBSTARS = 4;
const MAX_GATE_ARGS = 32;
const MAX_GATE_ARG_CHARS = 256;

export const LANGUAGES = ['node', 'rust'] as const;
export type Language = (typeof LANGUAGES)[number];
export const GATE_HARNESSES = ['cargo', 'node'] as const satisfies readonly GateHarness[];

/**
 * One protected rule, matched against a repo-relative path split on `/`:
 * - `basename`: the last component is one of `values`, at any depth;
 * - `segment`: any component is one of `values` (the directory and everything under it);
 * - `segment-prefix`: any component starts with one of `values`;
 * - `root-dir`: the first component is one of `values`;
 * - `suffix`: the path ends with one of `values`, a multi-component path, at any depth;
 * - `subtree`: anything under one of `values`, a multi-component directory, at any depth;
 * - `crate-root-file`: the last component is one of `values` and its directory holds a
 *   `Cargo.toml`, or the path is a build script a `Cargo.toml` names (`build = "<path>"`). Read
 *   against a `CrateLayout`; without one it matches the basename at any depth (fail-closed).
 */
export interface ProtectedRule {
  kind: 'basename' | 'segment' | 'segment-prefix' | 'root-dir' | 'suffix' | 'subtree' | 'crate-root-file';
  values: readonly string[];
  /** How the author prompt and POLICY.md name it. */
  label: string;
}

export type ProtectedSetName = 'always' | Language;

/**
 * The built-in sets, every one applied to every repository, with or without a policy file
 * (P2-R32): the rust rules never match in a Node repository and the reverse. The names group
 * them for the prompt and the docs. Each entry is a way to make an install,
 * a build script, a hook, a CI job or a check run the author's code, or to change what the
 * host's own checks read.
 *
 * Per-crate `Cargo.toml` files are protected as well as the workspace one (P2-R4): a member's
 * manifest adds dependencies and build scripts exactly as the root does.
 */
export const PROTECTED_SETS: Readonly<Record<ProtectedSetName, readonly ProtectedRule[]>> = Object.freeze({
  always: Object.freeze([
    {
      kind: 'basename',
      values: [
        'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb',
        'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
        'flake.lock',
      ],
      label: 'lockfiles (pnpm-lock.yaml, package-lock.json, yarn.lock, Cargo.lock and the like) at any depth',
    },
    { kind: 'segment-prefix', values: ['.git'], label: 'anything whose path has a component starting .git (.git/, .github/, .gitignore, .gitattributes, .gitmodules)' },
    { kind: 'root-dir', values: ['scripts'], label: 'scripts/ at the root' },
    { kind: 'basename', values: [INVARIANTS_FILE], label: INVARIANTS_FILE },
    { kind: 'basename', values: [POLICY_FILE], label: POLICY_FILE },
    // The invariants loader's alternate locations (invariants/load.ts).
    { kind: 'suffix', values: ['.daylight/invariants.json', '.codemap/invariants.def.json'], label: '.daylight/invariants.json and .codemap/invariants.def.json' },
    // Install-time configuration and code (P2-R32).
    {
      kind: 'basename', values: ['.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', 'pnpm-workspace.yaml', '.yarnrc.yml', '.yarnrc', 'bunfig.toml'],
      label: 'package-manager configuration (.npmrc, .pnpmfile.cjs, .pnpmfile.mjs, pnpm-workspace.yaml, .yarnrc.yml, .yarnrc, bunfig.toml) at any depth',
    },
    // The code a yarnPath / yarn-path setting runs, and yarn berry's plugins.
    { kind: 'subtree', values: ['.yarn/releases', '.yarn/plugins'], label: 'anything under .yarn/releases/ or .yarn/plugins/' },
    // Hook code a person's next commit would run (P2-R32).
    { kind: 'segment', values: ['.husky'], label: 'anything under .husky/' },
    {
      kind: 'basename',
      values: ['.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml', 'lefthook.yaml', '.lefthook.yaml', 'lefthook-local.yml', 'lefthook-local.yaml',
        '.lefthook-local.yml', '.lefthook-local.yaml'],
      label: 'git hook managers\' config (.pre-commit-config.yaml, lefthook.yml, .lefthook.yml, lefthook.yaml, .lefthook.yaml, lefthook-local.yml, '
        + 'lefthook-local.yaml, .lefthook-local.yml, .lefthook-local.yaml) at any depth',
    },
  ] satisfies ProtectedRule[]),
  node: Object.freeze([
    { kind: 'basename', values: ['package.json'], label: 'package.json at any depth' },
    { kind: 'segment', values: ['node_modules'], label: 'anything under node_modules' },
  ] satisfies ProtectedRule[]),
  rust: Object.freeze([
    { kind: 'basename', values: ['Cargo.toml'], label: 'every Cargo.toml, the workspace one and each crate\'s' },
    { kind: 'basename', values: ['Cargo.lock'], label: 'every Cargo.lock' },
    { kind: 'segment', values: ['.cargo'], label: 'anything under a .cargo/ directory' },
    { kind: 'basename', values: ['rust-toolchain.toml', 'rust-toolchain'], label: 'rust-toolchain.toml (and the older rust-toolchain)' },
    // Cargo runs `build.rs` only from a package root (P2-R41); `src/build.rs` is an ordinary module.
    { kind: 'crate-root-file', values: ['build.rs'], label: 'build.rs beside a Cargo.toml (a crate\'s build script), and any build script a Cargo.toml names' },
  ] satisfies ProtectedRule[]),
});

export interface ProjectPolicy {
  schema: typeof POLICY_SCHEMA;
  languages: Language[];
  /** Repo-relative globs the project adds; `**` and `*` only. */
  protectedPaths: string[];
  /** The default harness when set; read through `defaultGateHarness`. */
  gate: { harness: GateHarness; command?: string[] } | null;
  /** Already clamped to `MAX_AUTHOR_TURNS` and `MAX_AUTHOR_TIMEOUT_SECONDS`. */
  author: { maxTurns?: number; timeoutSeconds?: number };
  /** Fields that were above their maximum and were lowered to it. */
  clamped: string[];
  /** sha256 of the file's bytes, for the run event. */
  digest: string;
}

/** The file is not a policy this version reads. One line, naming the file. */
export class ProjectPolicyError extends Error {
  constructor(reason: string) {
    super(`${POLICY_FILE}: ${reason}`);
    this.name = 'ProjectPolicyError';
  }
}

// ---- matching ------------------------------------------------------------------

/**
 * What a check knows of the repository's crates (P2-R41): the directories holding a
 * `Cargo.toml` (`''` for the root) and every build script a manifest names with
 * `build = "<path>"`. A check without one cannot tell a crate root, so `crate-root-file`
 * protects its basename at any depth.
 */
export interface CrateLayout {
  roots: ReadonlySet<string>;
  buildScripts: ReadonlySet<string>;
}

/**
 * The `build` value of a manifest's `[package]`: a path, `null` for none (or `true`/`false`,
 * which name no other file), or `undefined` when it is written in a form this reader does not
 * follow (a multi-line string, an inline `package = { … }`), which the caller treats as unknown.
 */
function declaredBuildScript(toml: string): string | null | undefined {
  let section = '';
  let found: string | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\[?([^\]]*)\]\]?/.exec(line);
    if (header) {
      section = header[1].replace(/\s/g, '');
      continue;
    }
    let value: string | undefined;
    if (section === 'package') value = /^["']?build["']?\s*=\s*(.*)$/.exec(line)?.[1];
    else if (section === '') {
      if (/^["']?package["']?\s*=/.test(line)) return undefined;
      value = /^["']?package["']?\s*\.\s*["']?build["']?\s*=\s*(.*)$/.exec(line)?.[1];
    }
    if (value === undefined) continue;
    const m = /^(?:"([^"\\]*)"|'([^']*)'|(true|false))\s*(?:#.*)?$/.exec(value);
    if (!m) return undefined;
    found = m[3] ? null : (m[1] ?? m[2]);
  }
  return found;
}

/**
 * The crate layout of a tree listed as `files`, reading each `Cargo.toml` through `manifest`.
 * Null (the check protects every `build.rs`) when a manifest cannot be read, names its build
 * script in a form `declaredBuildScript` does not follow, or names one outside the repository.
 */
export function crateLayoutOf(files: Iterable<string>, manifest: (p: string) => string | null): CrateLayout | null {
  const roots = new Set<string>();
  const buildScripts = new Set<string>();
  for (const f of files) {
    if (f !== 'Cargo.toml' && !f.endsWith('/Cargo.toml')) continue;
    const dir = f.slice(0, -'Cargo.toml'.length).replace(/\/$/, '');
    roots.add(dir);
    let text: string | null;
    try {
      text = manifest(f);
    } catch {
      return null;
    }
    if (text === null) return null;
    const build = declaredBuildScript(text);
    if (build === undefined) return null;
    if (build === null) continue;
    const p = path.posix.normalize(dir ? `${dir}/${build}` : build);
    if (!p || p === '.' || p.startsWith('../') || p === '..' || path.posix.isAbsolute(p)) return null;
    buildScripts.add(p);
  }
  return { roots, buildScripts };
}

function ruleMatches(rule: ProtectedRule, parts: readonly string[], crates?: CrateLayout | null): boolean {
  switch (rule.kind) {
    case 'crate-root-file': {
      if (crates?.buildScripts.has(parts.join('/'))) return true;
      if (!rule.values.includes(parts.at(-1) ?? '')) return false;
      return !crates || crates.roots.has(parts.slice(0, -1).join('/'));
    }
    case 'basename': return rule.values.includes(parts.at(-1) ?? '');
    case 'segment': return parts.some((s) => rule.values.includes(s));
    case 'segment-prefix': return parts.some((s) => rule.values.some((v) => s.startsWith(v)));
    case 'root-dir': return rule.values.includes(parts[0] ?? '');
    case 'suffix': {
      const p = parts.join('/');
      return rule.values.some((v) => p === v || p.endsWith(`/${v}`));
    }
    case 'subtree': return rule.values.some((v) => {
      const dir = v.split('/');
      for (let i = 0; i + dir.length < parts.length; i++) {
        if (dir.every((d, j) => parts[i + j] === d)) return true;
      }
      return false;
    });
  }
}

const segmentRegex = (seg: string) => new RegExp(`^${seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

/** `**` is zero or more whole components; `*` is any run within one component. */
function globMatches(pattern: readonly string[], parts: readonly string[]): boolean {
  if (!pattern.length) return !parts.length;
  if (pattern[0] === '**') return globMatches(pattern.slice(1), parts) || (parts.length > 0 && globMatches(pattern, parts.slice(1)));
  return parts.length > 0 && segmentRegex(pattern[0]).test(parts[0]) && globMatches(pattern.slice(1), parts.slice(1));
}

export const languagesOf = (policy: ProjectPolicy | null | undefined): Language[] => policy?.languages ?? ['node'];

/**
 * The gate harness when none is named (P2-R32): `gate.harness` if the policy says one, else
 * `cargo` for a rust-only project and `node` for anything else, a project of both included.
 */
export const defaultGateHarness = (policy: ProjectPolicy | null | undefined): GateHarness =>
  policy?.gate?.harness ?? (languagesOf(policy).includes('node') ? 'node' : 'cargo');

/**
 * Which sets protect `p`: `always`, `node`, `rust`, or `project` for one of the policy's globs.
 * Empty when nothing does. Every built-in set is checked whatever `languages` says. `crates`,
 * when the caller knows the tree, narrows `build.rs` to crate roots (P2-R41).
 */
export function protectedBy(p: string, policy?: ProjectPolicy | null, crates?: CrateLayout | null): string[] {
  const parts = p.split('/');
  const out: string[] = [];
  for (const name of Object.keys(PROTECTED_SETS) as ProtectedSetName[]) {
    if (PROTECTED_SETS[name].some((r) => ruleMatches(r, parts, crates))) out.push(name);
  }
  if (policy?.protectedPaths.some((g) => globMatches(g.split('/'), parts))) out.push('project');
  return out;
}

/**
 * The protected list as the author prompt says it, one entry per rule, from the data above:
 * every set, since `protectedBy` enforces every set; `always` and the project's languages
 * (no policy: `node`) come first.
 */
export function protectedLabels(policy?: ProjectPolicy | null): string[] {
  const sets = [...new Set<ProtectedSetName>(['always', ...languagesOf(policy), ...Object.keys(PROTECTED_SETS) as ProtectedSetName[]])];
  const labels = [...new Set(sets.flatMap((s) => PROTECTED_SETS[s].map((r) => r.label)))];
  return [...labels, ...(policy?.protectedPaths ?? [])];
}

// ---- loading -------------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keyName = (k: string) => JSON.stringify(k.slice(0, 64));

function onlyKeys(o: Record<string, unknown>, known: readonly string[], where: string): void {
  const unknown = Object.keys(o).find((k) => !known.includes(k));
  if (unknown !== undefined) throw new ProjectPolicyError(`unknown key ${keyName(unknown)}${where ? ` in ${where}` : ''}`);
}

/** Why `g` is not a glob this version reads, or null. */
export function globRefusal(g: unknown): string | null {
  if (typeof g !== 'string' || !g) return 'a protected path must be a non-empty string';
  if (g.length > MAX_GLOB_CHARS) return `a protected path is over ${MAX_GLOB_CHARS} characters`;
  if (CONTROL.test(g) || g.includes('\\')) return 'a protected path has a control character or a backslash';
  if (g.startsWith('/')) return 'a protected path is repo-relative: no leading slash';
  const parts = g.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return 'a protected path may not have an empty, . or .. component';
  if (/[?[\]{}!]/.test(g)) return 'a protected path supports only ** and *';
  if (parts.some((s) => s.includes('**') && s !== '**')) return 'a protected path uses ** only as a whole component';
  if (parts.filter((s) => s === '**').length > MAX_GLOBSTARS) return `a protected path has more than ${MAX_GLOBSTARS} **`;
  return null;
}

function positiveInt(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ProjectPolicyError(`${where} must be a positive integer`);
  return v;
}

/** The policy in `raw` (the file's bytes), validated, or a `ProjectPolicyError`. */
export function parseProjectPolicy(raw: Buffer | string): ProjectPolicy {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  if (bytes.length > MAX_POLICY_BYTES) throw new ProjectPolicyError(`over ${MAX_POLICY_BYTES} bytes`);
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ProjectPolicyError('not JSON');
  }
  if (!isObject(doc)) throw new ProjectPolicyError('not a JSON object');
  onlyKeys(doc, ['schema', 'languages', 'protectedPaths', 'gate', 'author'], '');
  if (doc.schema !== POLICY_SCHEMA) throw new ProjectPolicyError(`schema must be "${POLICY_SCHEMA}"`);

  let languages: Language[] = ['node'];
  if (doc.languages !== undefined) {
    if (!Array.isArray(doc.languages) || !doc.languages.length) throw new ProjectPolicyError('languages must be a non-empty list');
    const bad = doc.languages.find((l) => !(LANGUAGES as readonly unknown[]).includes(l));
    if (bad !== undefined) throw new ProjectPolicyError(`languages: unknown language ${keyName(String(bad))}; known: ${LANGUAGES.join(', ')}`);
    languages = [...new Set(doc.languages as Language[])];
  }

  let protectedPaths: string[] = [];
  if (doc.protectedPaths !== undefined) {
    if (!Array.isArray(doc.protectedPaths)) throw new ProjectPolicyError('protectedPaths must be a list');
    if (doc.protectedPaths.length > MAX_PROTECTED_GLOBS) throw new ProjectPolicyError(`protectedPaths has more than ${MAX_PROTECTED_GLOBS} entries`);
    for (const g of doc.protectedPaths) {
      const why = globRefusal(g);
      if (why) throw new ProjectPolicyError(why);
    }
    protectedPaths = [...new Set(doc.protectedPaths as string[])];
  }

  let gate: ProjectPolicy['gate'] = null;
  if (doc.gate !== undefined) {
    if (!isObject(doc.gate)) throw new ProjectPolicyError('gate must be an object');
    onlyKeys(doc.gate, ['harness', 'command'], 'gate');
    if (!(GATE_HARNESSES as readonly unknown[]).includes(doc.gate.harness)) {
      throw new ProjectPolicyError(`gate.harness must be one of ${GATE_HARNESSES.join(', ')}`);
    }
    gate = { harness: doc.gate.harness as GateHarness };
    if (doc.gate.command !== undefined) {
      const c = doc.gate.command;
      if (!Array.isArray(c) || !c.length || c.length > MAX_GATE_ARGS) throw new ProjectPolicyError(`gate.command must be a list of 1 to ${MAX_GATE_ARGS} strings`);
      if (c.some((a) => typeof a !== 'string' || !a || a.length > MAX_GATE_ARG_CHARS || CONTROL.test(a))) {
        throw new ProjectPolicyError(`gate.command entries must be non-empty strings of at most ${MAX_GATE_ARG_CHARS} characters, without control characters`);
      }
      gate.command = [...c] as string[];
    }
  }

  const author: ProjectPolicy['author'] = {};
  const clamped: string[] = [];
  if (doc.author !== undefined) {
    if (!isObject(doc.author)) throw new ProjectPolicyError('author must be an object');
    onlyKeys(doc.author, ['maxTurns', 'timeoutSeconds'], 'author');
    if (doc.author.maxTurns !== undefined) {
      const n = positiveInt(doc.author.maxTurns, 'author.maxTurns');
      if (n > MAX_AUTHOR_TURNS) clamped.push('author.maxTurns');
      author.maxTurns = Math.min(n, MAX_AUTHOR_TURNS);
    }
    if (doc.author.timeoutSeconds !== undefined) {
      const n = positiveInt(doc.author.timeoutSeconds, 'author.timeoutSeconds');
      if (n > MAX_AUTHOR_TIMEOUT_SECONDS) clamped.push('author.timeoutSeconds');
      author.timeoutSeconds = Math.min(n, MAX_AUTHOR_TIMEOUT_SECONDS);
    }
  }

  return {
    schema: POLICY_SCHEMA, languages, protectedPaths, gate, author, clamped,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/**
 * `<repoRoot>/daylight.policy.json`, validated, or null when there is none. Refused (a
 * `ProjectPolicyError`) when it is not a regular file (a symlink is not followed), is over
 * 64 KB, is not JSON, or has a key this version does not know: a policy that is half-read is
 * a policy that silently protects less than its author meant.
 */
export function loadProjectPolicy(repoRoot: string): ProjectPolicy | null {
  const file = path.join(repoRoot, POLICY_FILE);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ProjectPolicyError('not a regular file');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new ProjectPolicyError('not a regular file');
    if (st.size > MAX_POLICY_BYTES) throw new ProjectPolicyError(`over ${MAX_POLICY_BYTES} bytes`);
    // One byte past the size it reported, so a file that grew since the stat is still caught.
    const buf = Buffer.alloc(st.size + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return parseProjectPolicy(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

// ---- author defaults ---------------------------------------------------------------

export interface AuthorLimits {
  maxTurns: number;
  timeoutMs: number;
  /** Where each came from. */
  source: { maxTurns: 'policy' | 'default'; timeoutMs: 'flag' | 'policy' | 'default' };
  /** What was lowered to its maximum: the policy's own `clamped`, plus `--timeout` for the flag. */
  clamped: string[];
}

/**
 * The turn and time limits `forge run` gives the author: a `--timeout` flag first, then the
 * policy, then the built-in default. A flag is clamped to the same maximum a policy is.
 */
export function authorLimits(
  policy: ProjectPolicy | null | undefined, defaults: { maxTurns: number; timeoutMs: number }, flagTimeoutMs?: number,
): AuthorLimits {
  const fromPolicy = policy?.author.timeoutSeconds;
  const timeoutMs = flagTimeoutMs ?? (fromPolicy !== undefined ? fromPolicy * 1000 : defaults.timeoutMs);
  return {
    maxTurns: Math.min(policy?.author.maxTurns ?? defaults.maxTurns, MAX_AUTHOR_TURNS),
    timeoutMs: Math.min(timeoutMs, MAX_AUTHOR_TIMEOUT_SECONDS * 1000),
    source: {
      maxTurns: policy?.author.maxTurns !== undefined ? 'policy' : 'default',
      timeoutMs: flagTimeoutMs !== undefined ? 'flag' : fromPolicy !== undefined ? 'policy' : 'default',
    },
    clamped: [...(policy?.clamped ?? []), ...(flagTimeoutMs !== undefined && flagTimeoutMs > MAX_AUTHOR_TIMEOUT_SECONDS * 1000 ? ['--timeout'] : [])],
  };
}
