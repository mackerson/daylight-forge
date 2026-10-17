import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digestOf } from '../mission/artifacts.ts';
import type { Application, Candidate, Decision, Mission } from '../mission/types.ts';
import { HARDENED_GIT_CONFIG, hardenedGitEnv } from '../experiment/runner.ts';
import {
  CandidateRefused, candidateStanding, requireImplement, type DecideContext,
} from './decide.ts';
import { applyRefFor, candidateDecisionOf, confirmDigest } from './confirm.ts';
import { DIFF_FLAGS } from './diff.ts';
import { verdictRows } from './gate.ts';
import { assertHumanDecision } from './policy.ts';
import { commitMessage } from './trailers.ts';
import { candidateVerdict } from './verdict.ts';

/**
 * `forge apply`: commit an approved candidate to a new branch with git plumbing only
 * (resolution 10). No worktree, no checkout, no hook: HEAD, the index and the working tree
 * of the real checkout are never touched, and the human merges the branch themselves.
 *
 * The untrusted diff is parsed only inside a scratch bare repository with an empty config,
 * whose object store borrows the real one through alternates. The real repository receives
 * exactly the result: each changed blob (`hash-object -w --no-filters`), a tree built on a
 * private index (`read-tree`, `update-index --index-info`, `write-tree`), a commit
 * (`commit-tree --no-gpg-sign`) and one new ref (`update-ref <ref> <commit> ""`, which refuses
 * an existing ref). Then the commit is re-diffed against the base with the capture flags and
 * must hash to the candidate's diff digest; on a mismatch the ref is deleted and nothing is
 * recorded as applied.
 */

export class ApplyFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyFailed';
  }
}

/** Config a repository could set to make one of these commands run something or write otherwise. */
const REAL_REPO_CONFIG = [
  ...HARDENED_GIT_CONFIG,
  '-c', 'commit.gpgSign=false', '-c', 'gpg.program=false', '-c', 'i18n.commitEncoding=UTF-8',
  '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
];

const ZERO = '0'.repeat(40);
const MAX_BUFFER = 64 * 1024 * 1024;

export const refFor = applyRefFor;

interface GitOpts {
  input?: Buffer | string;
  env?: Record<string, string>;
}

function gitIn(where: { repo: string } | { gitDir: string }, args: string[], o: GitOpts = {}): Buffer {
  const loc = 'repo' in where ? ['-C', where.repo] : [`--git-dir=${where.gitDir}`];
  const config = 'repo' in where ? REAL_REPO_CONFIG : [...HARDENED_GIT_CONFIG, '-c', 'core.autocrlf=false'];
  return execFileSync('git', [...config, ...loc, ...args], {
    input: o.input, stdio: [o.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    timeout: 60_000, maxBuffer: MAX_BUFFER, env: { ...hardenedGitEnv(), ...o.env },
  });
}

const text = (b: Buffer) => b.toString('utf8').trim();

function succeeds(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/** A bare repository with no config, hooks or template, reading the real object store. */
interface Scratch {
  gitDir: string;
  index: string;
  realIndex: string;
  dispose(): void;
}

function scratchFor(repo: string): Scratch {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-apply-'));
  const gitDir = path.join(base, 'git');
  const dispose = () => fs.rmSync(base, { recursive: true, force: true });
  try {
    execFileSync('git', [...HARDENED_GIT_CONFIG, 'init', '-q', '--bare', '--template=', gitDir], {
      stdio: 'ignore', env: hardenedGitEnv(), timeout: 60_000,
    });
    const common = text(gitIn({ repo }, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), `${path.join(common, 'objects')}\n`);
    return { gitDir, index: path.join(base, 'scratch.index'), realIndex: path.join(base, 'real.index'), dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

/** `base` → `commit` with capture's flags (`diff.ts`), from the scratch's empty config. */
function rediff(s: Scratch, base: string, commit: string): Buffer {
  return gitIn({ gitDir: s.gitDir }, ['diff', ...DIFF_FLAGS, base, commit, '--']);
}

interface RawEntry {
  newMode: string;
  newSha: string;
  status: string;
  path: string;
}

/** `diff-tree --raw -z`: `:oldmode newmode oldsha newsha status\0path\0` per file. */
function parseRaw(raw: string): RawEntry[] {
  const parts = raw.split('\0');
  const out: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const head = parts[i];
    if (!head) break;
    const [, newMode, , newSha, status] = head.slice(1).split(' ');
    out.push({ newMode, newSha, status, path: parts[i + 1] });
  }
  return out;
}

function identityOf(repo: string, actor: string, given?: { name: string; email: string }): { name: string; email: string; source: string } {
  const clean = (s: string) => s.replace(/[<>\u0000-\u001f\u007f]/g, '').trim();
  if (given) return { name: clean(given.name), email: clean(given.email), source: 'given' };
  const read = (key: string): string => {
    try {
      // Reading config runs nothing; the user's global identity is wanted here, so only the
      // system file is dropped.
      return clean(execFileSync('git', [...HARDENED_GIT_CONFIG, '-C', repo, 'config', '--get', key], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1' },
      }));
    } catch {
      return '';
    }
  };
  const name = read('user.name');
  const email = read('user.email');
  if (name && email) return { name, email, source: 'git-config' };
  const who = clean(actor.slice('human:'.length)) || 'unknown';
  return { name: who, email: `${who.replace(/[^A-Za-z0-9._-]/g, '_')}@daylight.invalid`, source: 'actor' };
}

export interface ApplyInput {
  candidateId: string;
  actor: string;
  /** `--confirm <digest8>` of `confirmDigest('apply', candidateId)`. */
  confirm: string | undefined;
  /** The commit's author and committer; by default the repository's git identity. */
  identity?: { name: string; email: string };
}

export interface ApplyResult {
  application: Application;
  commit: string;
  tree: string;
  ref: string;
}

export type ApplyContext = DecideContext & { now?: () => number };

function approvingDecision(c: Candidate, d: Decision | null): Decision {
  if (!d) throw new CandidateRefused(`candidate ${c.id} has no approve or override decision`);
  const ok = (d.kind === 'approve' && d.scope.operation === 'approve-candidate')
    || (d.kind === 'override' && d.scope.operation === 'override-candidate');
  if (!ok) throw new CandidateRefused(`candidate ${c.id}'s latest decision ${d.id} is ${String(d.scope.operation)}, not an approval`);
  if (d.scope.diffDigest !== c.diffArtifact.digest || d.scope.gateSetDigest !== c.gateSetDigest || d.scope.baseCommit !== c.baseCommit) {
    throw new CandidateRefused(`decision ${d.id} approved a different diff, gate set or base than candidate ${c.id} holds`);
  }
  return d;
}

export function applyCandidate(ctx: ApplyContext, input: ApplyInput): ApplyResult {
  const c = ctx.store.candidate(input.candidateId);
  if (!c) throw new CandidateRefused(`unknown candidate ${input.candidateId}`);
  const preview = confirmDigest(ctx, 'apply', c.id);
  assertHumanDecision(ctx.env ?? process.env, input.actor, input.confirm, preview.digest);
  const m = requireImplement(ctx, c);
  const emit = (name: string, payload: Record<string, unknown>) =>
    ctx.events?.append({ projectId: m.projectId, missionId: m.id, category: 'approval', name, payload });
  const refuse = (why: string): never => {
    emit('forge.apply.refused', { candidateId: c.id, why });
    throw new CandidateRefused(`apply refused: ${why}`);
  };

  const repo = ctx.repoRoot;
  const ref = applyRefFor(c.missionId);
  let d: Decision;
  try {
    d = approvingDecision(c, candidateDecisionOf(ctx, c));
  } catch (err) {
    return refuse((err as Error).message);
  }
  if (ctx.store.application(c.id)) refuse(`candidate ${c.id} is already applied`);
  const standing = candidateStanding(ctx, c);
  if (standing.length) refuse(standing.join('; '));
  if (d.kind === 'approve') {
    const v = candidateVerdict(verdictRows(ctx, c));
    if (v.verdict !== 'accepted-by-gates') refuse(`the verdict is now ${v.verdict}, not accepted-by-gates: ${v.reasons.join('; ')}`);
  }
  const diff = ctx.artifacts.get(c.diffArtifact);
  if (!/^[0-9a-f]{40}$/.test(c.baseCommit)) refuse(`base ${c.baseCommit} is not a full commit id`);
  if (!succeeds(() => gitIn({ repo }, ['cat-file', '-e', `${c.baseCommit}^{commit}`]))) refuse(`base ${c.baseCommit} is not a commit of ${repo}`);
  if (!succeeds(() => gitIn({ repo }, ['merge-base', '--is-ancestor', c.baseCommit, 'HEAD']))) refuse(`base ${c.baseCommit} is not an ancestor of HEAD`);
  if (!succeeds(() => gitIn({ repo }, ['check-ref-format', ref]))) refuse(`${ref} is not a valid ref name`);
  if (succeeds(() => gitIn({ repo }, ['show-ref', '--verify', '--quiet', ref]))) refuse(`${ref} already exists; it is never overwritten`);

  const attempt = ctx.store.attempt(c.attemptId);
  const workItem = m.workItemId ? ctx.store.workItem(m.workItemId) : null;
  const subject = typeof d.scope.commitSubject === 'string' ? d.scope.commitSubject : workItem?.title ?? m.objective;
  const message = commitMessage({
    title: subject, fallbackTitle: `Daylight mission ${m.id}`, files: c.files,
    missionId: m.id, attemptId: c.attemptId, runnerId: attempt?.runnerId ?? 'unknown',
  });
  const who = identityOf(repo, input.actor, input.identity);
  const when = `${Math.floor((ctx.now?.() ?? Date.now()) / 1000)} +0000`;

  const s = scratchFor(repo);
  let created: string | null = null;
  try {
    const onScratch = { env: { GIT_INDEX_FILE: s.index } };
    const onReal = { env: { GIT_INDEX_FILE: s.realIndex } };
    gitIn({ gitDir: s.gitDir }, ['read-tree', c.baseCommit], onScratch);
    try {
      gitIn({ gitDir: s.gitDir }, ['apply', '--cached', '--binary', '-'], { ...onScratch, input: diff });
    } catch (err) {
      const stderr = String((err as { stderr?: Buffer }).stderr ?? '').trim().split('\n')[0];
      refuse(`the diff does not apply to ${c.baseCommit.slice(0, 12)}: ${stderr || 'git apply refused it'}`);
    }
    const scratchTree = text(gitIn({ gitDir: s.gitDir }, ['write-tree'], onScratch));
    const entries = parseRaw(gitIn({ gitDir: s.gitDir }, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', c.baseCommit, scratchTree]).toString('utf8'));

    const info: string[] = [];
    for (const e of entries) {
      if (e.status === 'D') {
        info.push(`0 ${ZERO}\t${e.path}`);
        continue;
      }
      if (e.newMode !== '100644' && e.newMode !== '100755') refuse(`${e.path} would be mode ${e.newMode}; only files are applied`);
      const blob = gitIn({ gitDir: s.gitDir }, ['cat-file', 'blob', e.newSha]);
      const sha = text(gitIn({ repo }, ['hash-object', '-w', '--no-filters', '--stdin'], { input: blob }));
      if (sha !== e.newSha) refuse(`${e.path} hashed to ${sha} in the repository, not ${e.newSha}`);
      info.push(`${e.newMode} ${sha}\t${e.path}`);
    }
    gitIn({ repo }, ['read-tree', c.baseCommit], onReal);
    if (info.length) gitIn({ repo }, ['update-index', '-z', '--index-info'], { ...onReal, input: `${info.join('\0')}\0` });
    const tree = text(gitIn({ repo }, ['write-tree'], onReal));
    if (tree !== scratchTree) refuse(`the repository built tree ${tree}, not the ${scratchTree} the diff gives`);

    const commit = text(gitIn({ repo }, ['commit-tree', '--no-gpg-sign', tree, '-p', c.baseCommit, '-F', '-'], {
      input: message,
      env: {
        GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: when,
      },
    }));
    try {
      gitIn({ repo }, ['update-ref', '-m', `daylight apply ${c.id}`, ref, commit, '']);
    } catch {
      refuse(`${ref} could not be created; it may have appeared since the check`);
    }
    created = commit;

    const again = digestOf(rediff(s, c.baseCommit, commit));
    if (again !== c.diffArtifact.digest) {
      gitIn({ repo }, ['update-ref', '-d', ref, commit]);
      created = null;
      emit('forge.apply.failed', { candidateId: c.id, commit, ref, expected: c.diffArtifact.digest, actual: again, refDeleted: true });
      throw new ApplyFailed(`apply failed: commit ${commit} diffs to ${again}, not the approved ${c.diffArtifact.digest}; ${ref} was deleted`);
    }

    const application = ctx.store.recordApplication({
      candidateId: c.id, decisionId: d.id, baseCommit: c.baseCommit, commit, tree, ref, appliedBy: input.actor,
    });
    created = null;
    emit('forge.applied', {
      applicationId: application.id, candidateId: c.id, decisionId: d.id, commit, tree, ref,
      diffDigest: c.diffArtifact.digest, identitySource: who.source,
    });
    return { application, commit, tree, ref };
  } finally {
    // Anything that threw after the ref was made (the store refusing, say) takes the ref with it.
    if (created) succeeds(() => gitIn({ repo }, ['update-ref', '-d', ref, created as string]));
    s.dispose();
  }
}

/**
 * The applications invariant, recomputed from rows and the repository: every application
 * names an approve or override decision of its own candidate at that candidate's diff digest,
 * and its commit's parent is the base and its diff against the base hashes to that digest.
 * Returns one line per breach; empty means it holds.
 */
export function applicationRefusals(ctx: Pick<DecideContext, 'store' | 'repoRoot'>, opts: { projectId?: string } = {}): string[] {
  const out: string[] = [];
  const missions: Mission[] = ctx.store.missions(opts.projectId);
  const apps = missions.flatMap((m) => ctx.store.applications(m.id));
  if (!apps.length) return out;
  const s = scratchFor(ctx.repoRoot);
  try {
    for (const p of apps) {
      const c = ctx.store.candidate(p.candidateId);
      if (!c) {
        out.push(`${p.id}: candidate ${p.candidateId} does not exist`);
        continue;
      }
      try {
        approvingDecision(c, ctx.store.decision(p.decisionId));
      } catch (err) {
        out.push(`${p.id}: ${(err as Error).message}`);
      }
      if (ctx.store.decision(p.decisionId)?.scope.candidateId !== c.id) out.push(`${p.id}: decision ${p.decisionId} is not about ${c.id}`);
      if (!/^[0-9a-f]{40}$/.test(p.commit) || !succeeds(() => gitIn({ gitDir: s.gitDir }, ['cat-file', '-e', `${p.commit}^{commit}`]))) {
        out.push(`${p.id}: commit ${p.commit} is not in the repository`);
        continue;
      }
      let parent = 'none';
      try {
        parent = text(gitIn({ gitDir: s.gitDir }, ['rev-parse', '--verify', '--quiet', `${p.commit}^1`]));
      } catch {
        // A root commit has no parent, which is itself the breach reported below.
      }
      if (parent !== c.baseCommit) out.push(`${p.id}: commit ${p.commit}'s parent is ${parent}, not the base ${c.baseCommit}`);
      const tree = text(gitIn({ gitDir: s.gitDir }, ['rev-parse', '--verify', `${p.commit}^{tree}`]));
      if (tree !== p.tree) out.push(`${p.id}: commit ${p.commit}'s tree is ${tree}, not the recorded ${p.tree}`);
      const digest = digestOf(rediff(s, c.baseCommit, p.commit));
      if (digest !== c.diffArtifact.digest) out.push(`${p.id}: commit ${p.commit} diffs to ${digest}, not ${c.diffArtifact.digest}`);
    }
  } finally {
    s.dispose();
  }
  return out;
}
