import { execFileSync } from 'node:child_process';
import { HARDENED_GIT_CONFIG, hardenedGitEnv } from '../experiment/runner.ts';
import { requireMappedRepo, type DaylightContext } from '../mission/context.ts';
import type { ArtifactRef, Mission } from '../mission/types.ts';
import { repoPathRefusal } from './proposal.ts';

/**
 * Spec intake: a Markdown document in the repository, registered at one commit.
 *
 * The spec is read from git's object store, never from the working tree: `ls-tree` then
 * `cat-file blob` by object id, which runs no filter, hook or textconv and follows no symlink.
 * What is registered is those bytes, digested; editing the file afterwards changes nothing
 * that was registered, which is the point (a work item approved against one text is not
 * silently re-pointed at another).
 */

export const MAX_SPEC_BYTES = 512 * 1024;
const MAX_TREE_ENTRIES = 500_000;
const SPEC_EXTENSIONS = /\.(md|markdown)$/i;

export class SpecRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecRefused';
  }
}

function git(root: string, args: string[], maxBuffer = 4 * 1024 * 1024): Buffer {
  return execFileSync('git', [...HARDENED_GIT_CONFIG, '--literal-pathspecs', '-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, env: hardenedGitEnv(), maxBuffer,
  });
}

/** The full commit a revision names, resolved by the repository's own git, hardened. */
export function resolveCommit(root: string, rev = 'HEAD'): string {
  // A revision is a name, never an option: a leading `-` would be read as one.
  if (!/^[0-9A-Za-z][0-9A-Za-z._/~^-]{0,199}$/.test(rev)) throw new SpecRefused(`not a revision name: ${JSON.stringify(rev)}`);
  let out: string;
  try {
    out = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]).toString('utf8').trim();
  } catch {
    throw new SpecRefused(`${rev} is not a commit in ${root}`);
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(out)) throw new SpecRefused(`${rev} did not resolve to a commit`);
  return out;
}

/**
 * The spec's bytes at `commit`. Refused: a path outside the repository, a non-Markdown name,
 * anything that is not a regular blob (symlink, gitlink, directory), more than 512 KB, NUL
 * bytes, or bytes that are not UTF-8.
 */
export function readSpecBlob(root: string, commit: string, rel: string): Buffer {
  const why = repoPathRefusal(rel);
  if (why) throw new SpecRefused(`spec path refused: ${why}`);
  if (!SPEC_EXTENSIONS.test(rel)) throw new SpecRefused('a spec is a Markdown document (.md or .markdown)');
  const entry = git(root, ['ls-tree', '-z', '--full-tree', commit, '--', rel]).toString('utf8').split('\0')[0];
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(entry ?? '');
  if (!m || m[4] !== rel) throw new SpecRefused(`${rel} is not in commit ${commit.slice(0, 12)}`);
  const [, mode, type, oid] = m;
  if (mode === '120000') throw new SpecRefused(`${rel} is a symlink at ${commit.slice(0, 12)}; a spec is a regular file`);
  if (mode === '160000' || type === 'commit') throw new SpecRefused(`${rel} is a submodule at ${commit.slice(0, 12)}`);
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw new SpecRefused(`${rel} is not a regular file`);
  const size = Number(git(root, ['cat-file', '-s', oid]).toString('utf8').trim());
  if (!Number.isFinite(size) || size > MAX_SPEC_BYTES) {
    throw new SpecRefused(`${rel} is ${size} bytes; a spec is at most ${MAX_SPEC_BYTES}`);
  }
  const bytes = git(root, ['cat-file', 'blob', oid], MAX_SPEC_BYTES + 1);
  if (bytes.length > MAX_SPEC_BYTES) throw new SpecRefused(`${rel} is over ${MAX_SPEC_BYTES} bytes`);
  if (bytes.includes(0)) throw new SpecRefused(`${rel} has NUL bytes; a spec is text`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SpecRefused(`${rel} is not UTF-8`);
  }
  return bytes;
}

/** Every file path at `commit`, from git's tree. What a proposal's `touches` must name. */
export function specTree(root: string, commit: string): Set<string> {
  const out = git(root, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit], 256 * 1024 * 1024)
    .toString('utf8').split('\0').filter(Boolean);
  if (out.length > MAX_TREE_ENTRIES) throw new SpecRefused(`the tree at ${commit.slice(0, 12)} has more than ${MAX_TREE_ENTRIES} files`);
  return new Set(out);
}

/** `sha256:<hex>@<commit12>`: the spec's bytes and where they came from, in one string. */
export const specRevisionOf = (digest: string, commit: string): string => `${digest}@${commit.slice(0, 12)}`;

export interface RegisteredSpec {
  mission: Mission;
  specArtifact: ArtifactRef;
  specRevision: string;
  commit: string;
  path: string;
}

/**
 * Register `rel` at `rev` (default HEAD) as a spec mission: kind `spec`, read-only, never
 * executing, `ready` for its decompose tasks. The spec bytes are an artifact; the mission's
 * scope names the path so a later author cannot edit it (`PolicyContext.specPath`).
 */
export function registerSpec(ctx: DaylightContext, repo: string, rel: string, o: { rev?: string } = {}): RegisteredSpec {
  const { root, project } = requireMappedRepo(ctx.out, repo);
  const commit = resolveCommit(root, o.rev ?? 'HEAD');
  const bytes = readSpecBlob(root, commit, rel);
  ctx.store.ensureProject(project);
  const specArtifact = ctx.artifacts.put(bytes, {
    kind: 'spec', projectId: project.id, revision: commit, path: rel, label: 'spec', mediaType: 'text/markdown',
  });
  ctx.store.recordArtifact(specArtifact);
  const specRevision = specRevisionOf(specArtifact.digest, commit);
  let mission = ctx.store.createMission({
    projectId: project.id, kind: 'spec', objective: `decompose ${rel} into work items`,
    baseRevision: commit, scope: { paths: [rel] }, permissions: { execute: false },
  });
  ctx.events.append({
    projectId: project.id, missionId: mission.id, actorId: 'daylight', category: 'claim', name: 'spec.registered',
    artifactIds: [specArtifact.id],
    payload: { specArtifact: specArtifact.id, specRevision, commit, bytes: bytes.length, path: rel },
  });
  mission = ctx.store.transitionMission(mission.id, 'ready');
  return { mission, specArtifact, specRevision, commit, path: rel };
}

/**
 * The spec a spec mission registered, with its bytes re-verified against the digest. Read
 * from the mission's own `spec.registered` event and the artifact store; refused when either
 * is missing or the bytes on disk no longer hash to what was registered.
 */
export function specOf(ctx: DaylightContext, missionId: string): RegisteredSpec & { bytes: Buffer } {
  const mission = ctx.store.mission(missionId);
  if (!mission) throw new SpecRefused(`unknown mission ${missionId}`);
  if (mission.kind !== 'spec') throw new SpecRefused(`mission ${missionId} is a ${mission.kind} mission, not a spec mission`);
  const ev = ctx.events.forMission(missionId).find((e) => e.name === 'spec.registered' && e.actorId === 'daylight');
  const p = ev?.payload as { specArtifact?: unknown; specRevision?: unknown; commit?: unknown; path?: unknown } | undefined;
  if (!p || typeof p.specArtifact !== 'string' || typeof p.commit !== 'string' || typeof p.path !== 'string') {
    throw new SpecRefused(`mission ${missionId} has no registered spec`);
  }
  const specArtifact = ctx.store.artifact(p.specArtifact);
  if (!specArtifact || specArtifact.kind !== 'spec' || specArtifact.projectId !== mission.projectId) {
    throw new SpecRefused(`mission ${missionId}'s spec artifact is not recorded`);
  }
  // The registration is the mission's: its commit is the mission's base, its path its scope.
  if (p.commit !== mission.baseRevision || mission.scope.paths?.[0] !== p.path) {
    throw new SpecRefused(`mission ${missionId}'s spec registration does not match the mission`);
  }
  const specRevision = specRevisionOf(specArtifact.digest, p.commit);
  if (p.specRevision !== specRevision) throw new SpecRefused(`mission ${missionId}'s spec revision does not match its artifact`);
  const bytes = ctx.artifacts.get(specArtifact);
  return { mission, specArtifact, specRevision, commit: p.commit, path: p.path, bytes };
}
