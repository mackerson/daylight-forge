import fs from 'node:fs';
import path from 'node:path';
import type { ArtifactStore } from '../mission/artifacts.ts';
import { digestOf } from '../mission/artifacts.ts';
import { redact } from '../mission/redact.ts';
import type {
  ArtifactRef, CandidateFile, FileMode, PolicyRule, PolicyViolation,
} from '../mission/types.ts';
import { checkPolicy, forgeryShapes, MAX_DIFF_BYTES, MAX_DIFF_FILES, pathViolations, type PolicyContext } from './policy.ts';
import { siblingGit, walkTree, type Workspace } from './workspace.ts';

/**
 * Candidate capture (F-3): what the author changed, read back on the host from the sibling
 * git dir, never from inside the sandbox.
 *
 * `add -A -f` stages everything in the tree, ignored files included, so a `.gitignore` the
 * author writes cannot hide a file from the diff; the `.gitignore` itself is then a protected
 * path. The diff is taken with every option that would let repository config or attributes
 * change its bytes switched off, so the same tree always yields the same digest.
 */

/** Paths a rule marks as the human's, not the author's. */
const PROTECTED_RULES: ReadonlySet<PolicyRule> = new Set(['protected-path', 'gate-path', 'spec-path']);

/**
 * Before anything is hashed: a tree that grew by more than this is refused outright, so an
 * author cannot make the host write gigabytes into the sibling object store.
 */
const MAX_NEW_ENTRIES = 10_000;
const MAX_TREE_BYTES = 512 * 1024 * 1024;

export const DIFF_FLAGS = [
  '--binary', '--full-index', '--text', '--no-textconv', '--no-ext-diff', '--no-renames', '--no-color',
  '--src-prefix=a/', '--dst-prefix=b/',
] as const;

export interface FileFlag {
  path: string;
  /** Touches a path only a human may change: protected, gate or spec. */
  protected: boolean;
  rules: PolicyRule[];
  /** High-confidence redactions in this file's part of the diff (R16): each is `secret-in-diff`. */
  secretHits: number;
  /** Low-confidence matches in this file's part: a curable `possible-secret` warning. */
  possibleSecretHits: number;
  /** Test-output forgery shapes on this file's added lines (P2-R43, P2-R49): a curable warning a person acknowledges. */
  forgeryShapes?: string[];
}

/** R16: a warning the approve dialog shows and the human acknowledges; never a violation. */
export interface CandidateWarning {
  rule: 'possible-secret' | 'gate-forgery-shape';
  path: string | null;
}

export interface CandidateSummary {
  files: number;
  insertions: number;
  deletions: number;
  binary: number;
}

/** Everything a Candidate row needs from the workspace; WS8 adds ids, gates and the verdict. */
export interface CandidateDraft {
  baseCommit: string;
  /**
   * The stored bytes: the diff itself, or its redacted copy when a high-confidence secret was
   * found. A low-confidence match alone leaves the diff as written, since a curable candidate's
   * stored diff is what the gates run and `apply` commits.
   */
  diff: Buffer;
  /** `sha256:` of `diff`. */
  diffDigest: string;
  diffArtifact?: ArtifactRef;
  files: CandidateFile[];
  flags: FileFlag[];
  policyViolations: PolicyViolation[];
  warnings: CandidateWarning[];
  secretHits: number;
  possibleSecretHits: number;
  summary: CandidateSummary;
  /** `no-diff` and `policy-violation` are final here; `pending` waits for the gates. */
  verdict: 'pending' | 'no-diff' | 'policy-violation';
}

const MODES: Record<string, FileMode> = {
  '100644': 'file', '100755': 'executable', '120000': 'symlink', '160000': 'gitlink',
};

/** Unknown modes are reported as the one the policy refuses outright. */
const modeOf = (m: string): FileMode => MODES[m] ?? 'gitlink';

interface RawEntry { path: string; status: string; oldMode: string; newMode: string }

/** `diff --raw -z --no-renames`: `:old new osha nsha S\0path\0` per file. */
export function parseRaw(raw: string): RawEntry[] {
  const parts = raw.split('\0');
  const out: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const head = parts[i];
    if (!head.startsWith(':')) break;
    const [oldMode, newMode, , , status] = head.slice(1).split(' ');
    out.push({ path: parts[i + 1], status: status[0], oldMode, newMode });
  }
  return out;
}

/** `diff --numstat -z --no-renames`: `ins\tdel\tpath\0`, `-` for a binary count. */
export function parseNumstat(raw: string): Map<string, { insertions: number | null; deletions: number | null }> {
  const out = new Map<string, { insertions: number | null; deletions: number | null }>();
  for (const rec of raw.split('\0').filter(Boolean)) {
    const [ins, del, ...rest] = rec.split('\t');
    out.set(rest.join('\t'), { insertions: ins === '-' ? null : Number(ins), deletions: del === '-' ? null : Number(del) });
  }
  return out;
}

function candidateFiles(raw: RawEntry[], numstat: ReturnType<typeof parseNumstat>): CandidateFile[] {
  return raw.map((r) => {
    const counts = numstat.get(r.path) ?? { insertions: null, deletions: null };
    const change: CandidateFile['change'] = r.status === 'A' ? 'added' : r.status === 'D' ? 'deleted' : 'modified';
    if (change === 'added') return { path: r.path, change, ...counts, mode: modeOf(r.newMode) };
    if (change === 'deleted') {
      return { path: r.path, change, ...counts, mode: modeOf(r.oldMode), previousMode: modeOf(r.oldMode) };
    }
    return { path: r.path, change, ...counts, mode: modeOf(r.newMode), previousMode: modeOf(r.oldMode) };
  });
}

/**
 * Split a patch into its per-file parts, in order. `diff --git` only ever starts a line at a
 * file boundary: a content line inside a hunk carries a ` `, `+` or `-` prefix.
 */
/** The post-image line numbers (1-based) a file's part of the diff adds. */
export function addedLines(part: string): number[] {
  const out: number[] = [];
  let n = 0;
  let inHunk = false;
  for (const l of part.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      n = Number(h[1]);
      inHunk = true;
    } else if (!inHunk) continue;
    else if (l.startsWith('+')) out.push(n++);
    else if (l.startsWith(' ')) n++;
    else if (!l.startsWith('-') && !l.startsWith('\\') && l !== '') inHunk = false;
  }
  return out;
}

const MAX_SCANNED_BYTES = 2 * 1024 * 1024;
const SCANNED = /\.(?:rs|[cm]?[jt]s|[jt]sx)$/;

/**
 * A changed file's post-image for the forgery scan: read from the tree when it is a regular file
 * of bounded size; otherwise only its added lines, at their line numbers, so no test context
 * is found and every shape on them counts (fail closed).
 */
function postImageOf(ws: Workspace, rel: string, part: string, added: number[]): string {
  try {
    const abs = path.join(ws.tree, rel);
    const st = fs.lstatSync(abs);
    if (st.isFile() && st.size <= MAX_SCANNED_BYTES) return fs.readFileSync(abs, 'utf8');
  } catch {
    // fall through to the diff's own lines
  }
  const plus = part.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++ '));
  const lines: string[] = [];
  added.forEach((n, i) => { lines[n - 1] = Buffer.from(plus[i] ?? '', 'latin1').toString('utf8').slice(1); });
  return Array.from(lines, (l) => l ?? '').join('\n');
}

function fileParts(patch: string): string[] {
  const starts: number[] = [];
  const re = /^diff --git /gm;
  for (let m = re.exec(patch); m; m = re.exec(patch)) starts.push(m.index);
  return starts.map((s, i) => patch.slice(s, starts[i + 1] ?? patch.length));
}

export interface CaptureOptions {
  /** Where the diff artifact is put. Without one the draft carries the bytes only. */
  artifacts?: ArtifactStore;
  projectId?: string;
  /** Values to mask beyond what `redact` finds in the environment and by shape. */
  secrets?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Stage the tree into the sibling, diff it against the base, and judge the result: the path
 * policy (resolution 14) per file and for the whole diff, and a secret scan whose any hit is
 * an uncurable `secret-in-diff` with only the redacted copy kept.
 *
 * Refused (no draft) only when the tree cannot be read back at all, or grew past what is safe
 * to hash; anything that can be described is a draft with violations instead.
 */
export function captureCandidate(
  ws: Workspace, ctx: PolicyContext = {}, o: CaptureOptions = {},
): CandidateDraft | { refused: string } {
  let grown: { entries: number; bytes: number };
  try {
    grown = walkTree(ws.tree);
  } catch (err) {
    return { refused: `the workspace cannot be read back: ${(err as Error).message}` };
  }
  if (grown.entries > ws.files + MAX_NEW_ENTRIES || grown.bytes > MAX_TREE_BYTES) {
    return { refused: `the workspace grew to ${grown.entries} files and ${grown.bytes} bytes; nothing was staged` };
  }

  let patch: Buffer;
  let raw: RawEntry[];
  let numstat: ReturnType<typeof parseNumstat>;
  try {
    siblingGit(ws, ['add', '--all', '--force']);
    patch = siblingGit(ws, ['diff', '--cached', ...DIFF_FLAGS, ws.commit, '--']);
    raw = parseRaw(siblingGit(ws, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', ws.commit, '--']).toString('utf8'));
    numstat = parseNumstat(siblingGit(ws, ['diff', '--cached', '--numstat', '-z', '--no-renames', ws.commit, '--']).toString('utf8'));
  } catch (err) {
    return { refused: `the workspace could not be staged: ${String((err as { stderr?: Buffer }).stderr ?? err).split('\n')[0].slice(0, 300)}` };
  }

  const files = candidateFiles(raw, numstat);
  // latin1 maps every byte to one code unit and back, so masking a secret changes only the
  // secret's bytes; a utf8 round trip would rewrite any invalid sequence in a binary file.
  const text = patch.toString('latin1');
  const parts = fileParts(text);
  const aligned = parts.length === files.length;
  const hitsByPath = new Map<string, number>();
  const possibleByPath = new Map<string, number>();
  let secretHits = 0;
  let possibleSecretHits = 0;
  const redactedParts = parts.map((part, i) => {
    const r = redact(part, o.secrets ?? [], o.env ?? process.env, aligned ? { path: files[i].path } : {});
    secretHits += r.high;
    possibleSecretHits += r.low;
    if (aligned && r.high) hitsByPath.set(files[i].path, r.high);
    if (aligned && r.low) possibleByPath.set(files[i].path, r.low);
    return r.text;
  });
  const stored = secretHits ? Buffer.from(redactedParts.join(''), 'latin1') : patch;

  const policyCtx: PolicyContext = {
    maxBytes: MAX_DIFF_BYTES, maxFiles: MAX_DIFF_FILES, ...ctx, diffBytes: patch.length,
  };
  const violations = checkPolicy(files, policyCtx);
  // P2-R43, P2-R49: library code shaped like a test runner's output, a heuristic (POLICY.md);
  // a warning a person acknowledges, never a violation.
  const forged = new Map<string, string[]>();
  if (aligned) {
    files.forEach((f, i) => {
      if (f.change === 'deleted' || !SCANNED.test(f.path)) return;
      const added = addedLines(parts[i]);
      if (!added.length) return;
      const shapes = forgeryShapes(f.path, postImageOf(ws, f.path, parts[i], added), added);
      if (shapes.length) forged.set(f.path, shapes);
    });
  }
  if (secretHits) {
    if (aligned) for (const p of hitsByPath.keys()) violations.push({ rule: 'secret-in-diff', path: p });
    else violations.push({ rule: 'secret-in-diff', path: null });
  }
  const warnings: CandidateWarning[] = [];
  if (possibleSecretHits) {
    if (aligned) for (const p of possibleByPath.keys()) warnings.push({ rule: 'possible-secret', path: p });
    else warnings.push({ rule: 'possible-secret', path: null });
  }
  for (const p of forged.keys()) warnings.push({ rule: 'gate-forgery-shape', path: p });
  const flags: FileFlag[] = files.map((f) => {
    const rules = [...new Set(pathViolations(f, policyCtx))];
    const hits = hitsByPath.get(f.path) ?? 0;
    if (hits) rules.push('secret-in-diff');
    return {
      path: f.path, protected: rules.some((r) => PROTECTED_RULES.has(r)), rules,
      secretHits: hits, possibleSecretHits: possibleByPath.get(f.path) ?? 0,
      ...(forged.has(f.path) ? { forgeryShapes: forged.get(f.path) } : {}),
    };
  });

  const summary: CandidateSummary = {
    files: files.length,
    insertions: files.reduce((n, f) => n + (f.insertions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    binary: files.filter((f) => f.insertions === null).length,
  };
  const diffDigest = digestOf(stored);
  const diffArtifact = o.artifacts
    ? o.artifacts.put(stored, {
      kind: 'diff', projectId: o.projectId ?? 'unknown', revision: ws.commit,
      label: secretHits ? 'candidate diff (redacted: secret-in-diff)' : 'candidate diff',
      mediaType: 'text/x-diff',
    })
    : undefined;
  return {
    baseCommit: ws.commit,
    diff: stored,
    diffDigest,
    diffArtifact,
    files,
    flags,
    policyViolations: violations,
    warnings,
    secretHits,
    possibleSecretHits,
    summary,
    verdict: !files.length ? 'no-diff' : violations.length ? 'policy-violation' : 'pending',
  };
}
