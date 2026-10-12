/**
 * The Daylight contracts everything else is built on. Run: node engine/test/daylight-core.ts
 *
 * Schema migrations, project identity and the artifact store are shared by every mission
 * workstream, so a regression here is a regression everywhere at once.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore, digestOf } from '../mission/artifacts.ts';
import { migrate, openDaylightDb, schemaVersion } from '../mission/db.ts';
import { currentRevision, identifyProject, shortRevision } from '../mission/project.ts';
import {
  ATTEMPT_TRANSITIONS, canTransition, DAYLIGHT_SCHEMA_VERSION, MISSION_TRANSITIONS,
  TASK_TRANSITIONS,
} from '../mission/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-daylight-core-'));

section('schema and migrations');
{
  const file = path.join(tmp, 'daylight.db');
  const db = openDaylightDb(file);
  check('a fresh database lands on the current schema',
    schemaVersion(db) === DAYLIGHT_SCHEMA_VERSION, String(schemaVersion(db)));
  check('re-running migrations is a no-op', migrate(db).length === 0);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name);
  for (const t of ['projects', 'missions', 'tasks', 'attempts', 'experiments', 'decisions', 'artifacts', 'events']) {
    check(`table ${t} exists`, tables.includes(t));
  }
  db.close();
  const again = openDaylightDb(file);
  check('reopening an existing file does not rerun migrations', schemaVersion(again) === DAYLIGHT_SCHEMA_VERSION);
  check('and the claim store is untouched — no claims table here', !tables.includes('claims'));
  again.close();
}

section('state tables');
{
  check('a mission goes draft → ready → running', canTransition(MISSION_TRANSITIONS, 'draft', 'ready')
    && canTransition(MISSION_TRANSITIONS, 'ready', 'running'));
  check('a mission cannot skip from draft to running', !canTransition(MISSION_TRANSITIONS, 'draft', 'running'));
  check('closed is terminal', MISSION_TRANSITIONS.closed.length === 0);
  check('a failed task can be requeued, keeping its attempts', canTransition(TASK_TRANSITIONS, 'failed', 'queued'));
  check('a done task is terminal', TASK_TRANSITIONS.done.length === 0);
  check('a completed attempt cannot be reopened', ATTEMPT_TRANSITIONS.completed.length === 0);
  check('an unknown state has no transitions rather than throwing',
    !canTransition(MISSION_TRANSITIONS, 'nonsense' as never, 'ready'));
}

section('project identity');
{
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const run = (args: string[]) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  }).trim();
  run(['init', '-q']);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'first']);
  const first = run(['rev-parse', 'HEAD']);

  const id = identifyProject(repo);
  check('a git repo is identified by its first commit', id.id === `git:${first.slice(0, 12)}`, id.id);
  check('the root is absolute', path.isAbsolute(id.root));
  check('the name is the directory basename', id.name === 'repo');

  fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 2;\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'second']);
  check('a later commit does not change the project id', identifyProject(repo).id === id.id);

  // Same project, another checkout: the identity must agree, the path must not matter.
  const clone = path.join(tmp, 'elsewhere');
  execFileSync('git', ['clone', '-q', repo, clone], { stdio: 'ignore' });
  check('a clone at a different path is the same project', identifyProject(clone).id === id.id);

  const rev = currentRevision(repo);
  check('a clean tree reports its commit', rev.commit === run(['rev-parse', 'HEAD']) && !rev.dirty);
  check('the label is the bare commit when clean', rev.label === rev.commit);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  const dirty = currentRevision(repo);
  check('an uncommitted change marks the revision dirty', dirty.dirty && dirty.label.endsWith('+dirty'));
  check('short form keeps the dirty marker', shortRevision(dirty.label).endsWith('+dirty')
    && shortRevision(dirty.label).length === 18);

  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  const p = identifyProject(plain);
  check('a non-git directory gets a path identity, and says so', p.id.startsWith('path:'));
  check('and an unversioned revision', currentRevision(plain).label === 'unversioned');
  check('two different plain directories are two projects',
    identifyProject(path.join(tmp, 'repo')).id !== p.id);
}

section('artifacts');
{
  const store = new ArtifactStore(tmp);
  const ref = store.put('hello\n', { kind: 'log', projectId: 'git:abc', label: 'stdout' });
  check('an artifact id is its digest', ref.id === ref.digest && ref.digest.startsWith('sha256:'));
  check('the digest is over the bytes', ref.digest === digestOf(Buffer.from('hello\n')));
  check('bytes are recorded', ref.bytes === 6);
  check('it can be read back', store.text(ref) === 'hello\n');
  const twice = store.put('hello\n', { kind: 'test', projectId: 'git:abc' });
  check('the same content is one blob with a different kind on the ref',
    twice.digest === ref.digest && twice.kind === 'test');
  check('has() answers for a digest string', store.has(ref.digest) && !store.has(digestOf('nope')));

  // The property the protected-expected-result design rests on.
  const file = path.join(store.dir, 'sha256', ref.digest.slice('sha256:'.length));
  fs.writeFileSync(file, 'tampered\n');
  let threw = false;
  try { store.get(ref); } catch { threw = true; }
  check('a blob that no longer matches its digest is refused, not returned', threw);

  let badDigest = false;
  try { store.get('md5:deadbeef'); } catch { badDigest = true; }
  check('a non-sha256 digest is refused', badDigest);

  const big = store.put(Buffer.alloc(3000, 0x61), { kind: 'log', projectId: 'x' });
  check('text() is bounded and says what it cut', store.text(big, 1000).includes('2000 more bytes'));
}

done();
