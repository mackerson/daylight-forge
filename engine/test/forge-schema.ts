/**
 * Schema 2 and the Forge contracts. Run: node engine/test/forge-schema.ts
 *
 * Three properties carry the weight. A v1 database or export is refused, and refused without
 * being touched (RULINGS R2). Write never stands on an attempt without the human decision
 * that granted it (R7). And no Forge row can be filed under a project other than its own.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ArtifactStore, digestOf } from '../mission/artifacts.ts';
import { openDaylight } from '../mission/context.ts';
import { IncompatibleDatabase, openDaylightDb, schemaVersion } from '../mission/db.ts';
import { EventLog } from '../mission/events.ts';
import { exportMission, importMission, readExport } from '../mission/export.ts';
import { confirmDigest } from '../forge/confirm.ts';
import { guardCheck } from '../forge/policy.ts';
import { gateSetDigestOf, MissionStore, newId, workItemContentDigest } from '../mission/store.ts';
import type { ArtifactRef, CandidateFile, Mission, ProjectIdentity } from '../mission/types.ts';
import {
  costKnown, DAYLIGHT_DB_VERSION, EVENT_SCHEMA_VERSION, EXPORT_SCHEMA_VERSION, isEntityId,
} from '../mission/types.ts';
import { harness } from './harness.ts';

const { check, section, done } = harness();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-forge-schema-'));
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');

const PROJECT: ProjectIdentity = { id: 'git:aaaaaaaaaaaa', root: '/repo/a', name: 'a' };
const OTHER: ProjectIdentity = { id: 'git:bbbbbbbbbbbb', root: '/repo/b', name: 'b' };
const HUMAN = 'human:miz';

const throws = (fn: () => unknown): Error | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const listing = (dir: string) => fs.readdirSync(dir).sort().join(',');
const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env } });

/** The P0 `daylight.db`, as the old build wrote it: WAL, schema 1, a mission row. */
function writeV1(file: string, version: number | null): void {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE daylight_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE missions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL,
      at INTEGER NOT NULL, project_id TEXT NOT NULL, mission_id TEXT, task_id TEXT, attempt_id TEXT, actor_id TEXT,
      category TEXT NOT NULL, name TEXT NOT NULL, artifact_ids TEXT, payload TEXT NOT NULL);
    INSERT INTO missions VALUES ('m_${'0'.repeat(32)}', 'git:aaaaaaaaaaaa', 'explore', 'ready');
  `);
  if (version !== null) db.prepare("INSERT INTO daylight_meta VALUES ('schema_version', ?)").run(String(version));
  db.close();
}

section('versions');
{
  check('the database is at schema 2', DAYLIGHT_DB_VERSION === 2);
  check('events stay at schema 1', EVENT_SCHEMA_VERSION === 1);
  check('the export is at format 2', EXPORT_SCHEMA_VERSION === 2);
  const out = path.join(tmp, 'versions');
  fs.mkdirSync(out);
  const events = new EventLog(out);
  const e = events.append({ projectId: PROJECT.id, category: 'lifecycle', name: 'x', payload: {} });
  check('a new event is stamped with the event version, not the database one', e.schemaVersion === 1);
  events.close();
}

section('a v1 or unversioned database is refused, untouched');
for (const [label, version] of [['schema 1', 1], ['no version at all', null], ['a future schema', 3]] as const) {
  const out = path.join(tmp, `v1-${String(version)}`);
  fs.mkdirSync(out);
  const file = path.join(out, 'daylight.db');
  writeV1(file, version);
  const before = { sha: sha(file), files: listing(out), mtime: fs.statSync(file).mtimeMs };

  const direct = throws(() => openDaylightDb(file));
  check(`${label}: openDaylightDb refuses`, direct instanceof IncompatibleDatabase, String(direct));
  check(`${label}: in one line that says to delete it and re-map`,
    !!direct && !direct.message.includes('\n') && /Delete it and re-map/.test(direct.message), direct?.message);
  check(`${label}: MissionStore refuses`, throws(() => new MissionStore(out)) instanceof IncompatibleDatabase);
  check(`${label}: EventLog refuses`, throws(() => new EventLog(out)) instanceof IncompatibleDatabase);
  check(`${label}: openDaylight refuses`, throws(() => openDaylight(out)) instanceof IncompatibleDatabase);
  const r = cli(['events', '--out', out]);
  const errLines = r.stderr.trim().split('\n');
  check(`${label}: the CLI exits non-zero`, r.status !== 0, String(r.status));
  check(`${label}: and says so in one line`, errLines.length === 1 && /Delete it and re-map/.test(errLines[0]), r.stderr);

  check(`${label}: the file's bytes are unchanged`, sha(file) === before.sha);
  check(`${label}: no -wal or -shm was left beside it`, listing(out) === before.files, listing(out));
  check(`${label}: its mtime is unchanged`, fs.statSync(file).mtimeMs === before.mtime);
}
{
  const out = path.join(tmp, 'not-sqlite');
  fs.mkdirSync(out);
  const file = path.join(out, 'daylight.db');
  fs.writeFileSync(file, 'this is not a database, it is a note someone saved here\n'.repeat(20));
  const before = { sha: sha(file), files: listing(out) };
  const err = throws(() => openDaylightDb(file));
  check('a file that is not SQLite is refused with the same one line', err instanceof IncompatibleDatabase
    && /Delete it and re-map/.test(err.message) && !err.message.includes('\n'), err?.message);
  check('and is left as found', sha(file) === before.sha && listing(out) === before.files);
}
{
  const out = path.join(tmp, 'empty-file');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'daylight.db'), '');
  const store = new MissionStore(out);
  check('an empty file is a fresh database, not a refusal', schemaVersion(openDaylightDb(path.join(out, 'daylight.db'))) === 2);
  store.close();
}

section('a v1 export is refused');
{
  const file = path.join(tmp, 'v1-export.json');
  fs.writeFileSync(file, JSON.stringify({ kind: 'daylight-mission', schemaVersion: 1, mission: { id: 'm_x' }, project: PROJECT }));
  const before = sha(file);
  const err = throws(() => readExport(file));
  check('readExport refuses format 1', !!err && /format 1/.test(err.message), err?.message);
  check('in one line that says to delete it', !!err && !err.message.includes('\n') && /Delete it/.test(err.message));
  const out = path.join(tmp, 'v1-import');
  const r = cli(['mission', 'import', '--file', file, '--out', out]);
  check('the CLI import exits non-zero with that line', r.status !== 0 && /format 1/.test(r.stderr) && r.stderr.trim().split('\n').length === 1, r.stderr);
  check('the export file is untouched', sha(file) === before);
  const partial = path.join(tmp, 'partial-export.json');
  fs.writeFileSync(partial, JSON.stringify({ kind: 'daylight-mission', schemaVersion: 2, mission: { id: 'm_x' }, project: PROJECT, tasks: [] }));
  check('a format-2 file missing its Forge lists is refused', /missing/.test(throws(() => readExport(partial))?.message ?? ''));
}

section('fresh schema 2');
{
  const out = path.join(tmp, 'fresh');
  const store = new MissionStore(out);
  store.close();
  const db = new DatabaseSync(path.join(out, 'daylight.db'), { readOnly: true });
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const t of ['attempt_usage', 'work_items', 'candidates', 'gate_evaluations', 'applications', 'ingest_sources']) {
    check(`table ${t} exists`, tables.includes(t));
  }
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  const attemptCols = cols('attempts');
  for (const c of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'usage_source', 'cost_source',
    'model', 'parent_attempt_id', 'gate_set_digest', 'pid', 'heartbeat_at', 'sandbox_profile', 'sandbox_network',
    'sandbox_write', 'sandbox_exec', 'authorize_decision_id', 'credential', 'mcp_token_digest']) {
    check(`attempts.${c} exists`, attemptCols.includes(c));
  }
  for (const c of ['role', 'locked_by', 'started_at']) check(`experiments.${c} exists`, cols('experiments').includes(c));
  check('missions.work_item_id exists', cols('missions').includes('work_item_id'));
  for (const c of ['mission_id', 'attempt_id', 'proposal_artifact', 'content_digest']) {
    check(`work_items.${c} exists`, cols('work_items').includes(c));
  }
  for (const t of ['attempt_usage', 'work_items', 'candidates', 'gate_evaluations', 'applications', 'ingest_sources']) {
    check(`${t} carries project_id`, cols(t).includes('project_id'));
  }
  check('gate_evaluations carries its revision', cols('gate_evaluations').includes('revision'));
  db.close();
}

// ---- a full Forge flow on one store ------------------------------------------------

const out = path.join(tmp, 'flow');
const store = new MissionStore(out);
const artifacts = new ArtifactStore(out);
store.ensureProject(PROJECT);
store.ensureProject(OTHER);
const art = (text: string, kind: ArtifactRef['kind'], projectId = PROJECT.id): ArtifactRef => {
  const ref = artifacts.put(text, { kind, projectId, revision: 'base1' });
  store.recordArtifact(ref);
  return ref;
};

section('ids');
{
  for (const k of ['workItem', 'candidate', 'gateEvaluation', 'application', 'experiment'] as const) {
    const id = newId(k);
    check(`${k} ids are well formed (${id.split('_')[0]}_)`, isEntityId(k, id), id);
  }
  check('the prefixes are w_, c_, g_, p_', ['w', 'c', 'g', 'p'].join() ===
    [newId('workItem'), newId('candidate'), newId('gateEvaluation'), newId('application')].map((s) => s.split('_')[0]).join());
  check('an id of one kind is not an id of another', !isEntityId('candidate', newId('workItem')));
}

section('spec missions and work items');
const spec = store.createMission({ projectId: PROJECT.id, kind: 'spec', objective: 'decompose the spec', baseRevision: 'base1' });
const specRef = art('# Spec\n## Login\nUsers log in.\n', 'spec');
let decomposeAttempt: string;
{
  check('a spec mission refuses a non-decompose task',
    !!throws(() => store.createTask({ missionId: spec.id, role: 'review', objective: 'x' })));
  check('a spec mission refuses execute',
    !!throws(() => store.createMission({ projectId: PROJECT.id, kind: 'spec', objective: 'x', baseRevision: 'b', permissions: { execute: true } })));
  const t = store.createTask({ missionId: spec.id, role: 'decompose', objective: 'propose' });
  decomposeAttempt = store.startAttempt({ taskId: t.id, runnerId: 'agent:mock:plan' }).id;
}
const wInput = {
  projectId: PROJECT.id, missionId: spec.id, attemptId: decomposeAttempt, specArtifact: specRef, specRevision: 'base1',
  anchor: 'login', title: 'Login', statement: 'Users can log in', examples: ['good password logs in'],
  negativeExamples: ['bad password is refused'], proposedBy: 'agent:mock:plan',
};
const w = store.createWorkItem({ ...wInput, id: newId('workItem') });
{
  check('a work item starts proposed', w.status === 'proposed');
  check('it carries the content digest of what will be approved', w.contentDigest === workItemContentDigest(wInput));
  check('it records the mission and attempt that proposed it', w.missionId === spec.id && w.attemptId === decomposeAttempt);
  check('createWorkItem is idempotent on id', store.createWorkItem({ ...wInput, id: w.id }).createdAt === w.createdAt);
  check('the same id with other content is refused', !!throws(() => store.createWorkItem({ ...wInput, id: w.id, title: 'Other' })));
  check('a work item filed under another project is refused',
    !!throws(() => store.createWorkItem({ ...wInput, projectId: OTHER.id })));
  check('a work item whose spec belongs elsewhere is refused',
    !!throws(() => store.createWorkItem({ ...wInput, specArtifact: art('other spec', 'spec', OTHER.id) })));

  check('an implement mission from a proposed item is refused', !!throws(() => store.createMission({
    projectId: PROJECT.id, kind: 'implement', objective: 'build login', baseRevision: 'base1', workItemId: w.id,
  })));
  check('moving a work item without a decision is refused', !!throws(() => store.setWorkItemStatus(w.id, 'proposed', 'approved', 'd_nope')));
  const stale = store.recordDecision({
    missionId: spec.id, projectId: PROJECT.id, revision: 'base1', actor: HUMAN, kind: 'approve', rationale: 'ok',
    scope: { operation: 'approve-work-item', workItemId: w.id, contentDigest: 'sha256:' + '0'.repeat(64) }, artifactIds: [],
  });
  check('a decision naming another content digest does not approve it',
    !!throws(() => store.setWorkItemStatus(w.id, 'proposed', 'approved', stale.id)));
  const elsewhere = store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'unrelated', baseRevision: 'base1' });
  const misfiled = store.recordDecision({
    missionId: elsewhere.id, projectId: PROJECT.id, revision: 'base1', actor: HUMAN, kind: 'approve', rationale: 'ok',
    scope: { operation: 'approve-work-item', workItemId: w.id, contentDigest: w.contentDigest }, artifactIds: [],
  });
  check('a decision filed on another mission does not approve the item',
    !!throws(() => store.setWorkItemStatus(w.id, 'proposed', 'approved', misfiled.id)) && store.workItem(w.id)!.status === 'proposed');
  const ok = store.recordDecision({
    missionId: spec.id, projectId: PROJECT.id, revision: 'base1', actor: HUMAN, kind: 'approve', rationale: 'ok',
    scope: { operation: 'approve-work-item', workItemId: w.id, contentDigest: w.contentDigest }, artifactIds: [],
  });
  check('a compare-and-set from the wrong state is refused', !!throws(() => store.setWorkItemStatus(w.id, 'approved', 'superseded', ok.id)));
  const approved = store.setWorkItemStatus(w.id, 'proposed', 'approved', ok.id);
  check('a human decision naming the digest approves it', approved.status === 'approved' && approved.decisionId === ok.id);
  check('approving twice is refused', !!throws(() => store.setWorkItemStatus(w.id, 'proposed', 'approved', ok.id)));
  check('workItems lists by project', store.workItems(PROJECT.id).length === 1 && store.workItems(OTHER.id).length === 0);
}

section('decisions name a human');
{
  for (const actor of ['agent:claude:sonnet', 'human', 'runner:experiment']) {
    check(`a Forge operation by ${actor} is refused`, !!throws(() => store.recordDecision({
      missionId: spec.id, projectId: PROJECT.id, revision: 'b', actor, kind: 'approve', rationale: 'r',
      scope: { operation: 'lock-gates' }, artifactIds: [],
    })));
  }
  for (const kind of ['adhoc-mission', 'override'] as const) {
    check(`an ${kind} decision with no operation, by an agent, is refused`, !!throws(() => store.recordDecision({
      missionId: spec.id, projectId: PROJECT.id, revision: 'b', actor: 'agent:claude:opus', kind, rationale: 'r',
      scope: {}, artifactIds: [],
    })));
  }
  check('an adhoc-mission decision must say it is one', !!throws(() => store.recordDecision({
    missionId: spec.id, projectId: PROJECT.id, revision: 'b', actor: HUMAN, kind: 'adhoc-mission', rationale: 'r',
    scope: {}, artifactIds: [],
  })));
  check('an unknown operation is refused', !!throws(() => store.recordDecision({
    missionId: spec.id, projectId: PROJECT.id, revision: 'b', actor: HUMAN, kind: 'approve', rationale: 'r',
    scope: { operation: 'deploy-everything' }, artifactIds: [],
  })));
  check('a P0 adjudication with no operation is unchanged', !throws(() => store.recordDecision({
    missionId: spec.id, projectId: PROJECT.id, revision: 'b', actor: 'human', kind: 'adjudicate', rationale: 'r',
    scope: { claimId: 1 }, artifactIds: [],
  })));
}

section('implement missions and the authorize invariant');
let mission: Mission;
let authorId: string;
{
  check('an implement mission with neither a work item nor an ad hoc decision is refused',
    !!throws(() => store.createMission({ projectId: PROJECT.id, kind: 'implement', objective: 'x', baseRevision: 'b' })));
  check('an implement mission with both is refused', !!throws(() => store.createMission({
    projectId: PROJECT.id, kind: 'implement', objective: 'x', baseRevision: 'b', workItemId: w.id, adhoc: { actor: HUMAN, rationale: 'r' },
  })));
  check('an ad hoc implement mission by an agent is refused', !!throws(() => store.createMission({
    projectId: PROJECT.id, kind: 'implement', objective: 'x', baseRevision: 'b', adhoc: { actor: 'agent:x:y', rationale: 'r' },
  })));
  const adhoc = store.createMission({
    projectId: PROJECT.id, kind: 'implement', objective: 'fix typo', baseRevision: 'base1', adhoc: { actor: HUMAN, rationale: 'tiny' },
  });
  const ad = store.decisions(adhoc.id);
  check('an ad hoc implement mission records an adhoc-mission decision on itself',
    ad.length === 1 && ad[0].kind === 'adhoc-mission' && ad[0].actor === HUMAN && ad[0].scope.operation === 'adhoc-mission');
  check('a review mission naming a work item is refused', !!throws(() => store.createMission({
    projectId: PROJECT.id, kind: 'explore', objective: 'x', baseRevision: 'b', workItemId: w.id,
  })));
  check('a mission created with write is refused', !!throws(() => store.createMission({
    projectId: PROJECT.id, kind: 'explore', objective: 'x', baseRevision: 'b', permissions: { write: true },
  })));
  check('a work item of another project is refused', !!throws(() => store.createMission({
    projectId: OTHER.id, kind: 'implement', objective: 'x', baseRevision: 'b', workItemId: w.id,
  })));

  mission = store.createMission({ projectId: PROJECT.id, kind: 'implement', objective: 'build login', baseRevision: 'base1', workItemId: w.id });
  check('an implement mission starts draft without write', mission.state === 'draft' && !mission.permissions.write && mission.workItemId === w.id);

  const review = store.createMission({ projectId: PROJECT.id, kind: 'explore', objective: 'look', baseRevision: 'base1' });
  for (const kind of ['spec', 'work'] as const) {
    const m = store.createMission({ projectId: PROJECT.id, kind, objective: `no execute for ${kind}`, baseRevision: 'base1' });
    check(`execute is never granted to a ${kind} mission`, !!throws(() => store.authorizeMission({
      missionId: m.id, actor: HUMAN, rationale: 'r', permissions: { write: false, execute: true }, maxUsd: null,
    })) && !store.mission(m.id)!.permissions.execute && store.decisions(m.id).length === 0);
  }
  check('write is never granted to a review mission', !!throws(() => store.authorizeMission({
    missionId: review.id, actor: HUMAN, rationale: 'r', permissions: { write: true, execute: false }, maxUsd: null,
  })));
  check('authorize by an agent is refused', !!throws(() => store.authorizeMission({
    missionId: mission.id, actor: 'agent:claude:opus', rationale: 'r', permissions: { write: true, execute: false }, maxUsd: 1,
  })));
  check('and leaves the mission as it was', store.mission(mission.id)!.state === 'draft' && store.decisions(mission.id).length === 0);

  const author = store.createTask({ missionId: mission.id, role: 'author', objective: 'write it' });
  check('an attempt asking for write before any grant is refused',
    !!throws(() => store.startAttempt({ taskId: author.id, runnerId: 'agent:mock:a', sandbox: { profile: 'author', write: true } })));
  check('and the task did not move', store.task(author.id)!.state === 'queued');

  const { mission: m2, decision } = store.authorizeMission({
    missionId: mission.id, actor: HUMAN, rationale: 'go', permissions: { write: true, execute: true }, maxUsd: 2,
  });
  mission = m2;
  check('authorize is draft → ready, grants write and sets the budget',
    m2.state === 'ready' && m2.permissions.write && m2.permissions.execute && !m2.permissions.deploy && m2.budget.maxUsd === 2);
  check('it is recorded as an approving authorize-mission decision', decision.kind === 'approve'
    && decision.scope.operation === 'authorize-mission' && store.authorizeDecision(mission.id)?.id === decision.id);

  const otherAuth = store.authorizeMission({
    missionId: adhoc.id, actor: HUMAN, rationale: 'go', permissions: { write: true, execute: false }, maxUsd: null,
  }).decision;
  check('another mission\'s authorize decision does not grant write here', !!throws(() => store.startAttempt({
    taskId: author.id, runnerId: 'agent:mock:a', sandbox: { profile: 'author', write: true, authorizeDecisionId: otherAuth.id },
  })));
  for (const profile of ['none', 'review', 'gate'] as const) {
    check(`write under the ${profile} profile is refused, grant or not`, !!throws(() => store.startAttempt({
      taskId: author.id, runnerId: 'agent:mock:a', sandbox: { profile, write: true, authorizeDecisionId: decision.id },
    })));
  }
  check('and the task did not move for any of them', store.task(author.id)!.state === 'queued');
  check('exec without write is refused', !!throws(() => store.startAttempt({
    taskId: author.id, runnerId: 'agent:mock:a', sandbox: { profile: 'author', exec: true },
  })));
  check('an unknown network mode is refused', !!throws(() => store.startAttempt({
    taskId: author.id, runnerId: 'agent:mock:a', sandbox: { network: 'filtered' as never },
  })));
  const token = 'tok_' + 'a'.repeat(40);
  const a = store.startAttempt({
    taskId: author.id, runnerId: 'agent:mock:a', pid: process.pid, gateSetDigest: undefined,
    sandbox: { profile: 'author', network: 'none', write: true, exec: false, authorizeDecisionId: decision.id },
    credential: { present: true, envName: 'ANTHROPIC_API_KEY', label: 'forge-capped-1' }, mcpToken: token,
  });
  authorId = a.id;
  const back = store.attempt(a.id)!;
  check('write, exec, network and profile are stamped on the attempt row', back.sandbox!.write && !back.sandbox!.exec
    && back.sandbox!.network === 'none' && back.sandbox!.profile === 'author' && back.sandbox!.authorizeDecisionId === decision.id);
  check('a credential is recorded by name and label only', back.credential?.envName === 'ANTHROPIC_API_KEY' && back.credential.label === 'forge-capped-1');
  check('a credential label shaped like a value is refused', !!throws(() => store.startAttempt({
    taskId: store.createTask({ missionId: mission.id, role: 'author', objective: 'x' }).id, runnerId: 'agent:mock:a',
    credential: { present: true, envName: 'K', label: 'sk-ant-api03-' + 'x'.repeat(80) },
  })));
  check('the MCP token is stored as a digest only', back.mcpTokenDigest === digestOf(token)
    && !fs.readFileSync(path.join(out, 'daylight.db')).includes(token));
  check('the token finds its live attempt', store.attemptByMcpToken(token)?.id === a.id);
  check('pid and heartbeat are recorded', back.pid === process.pid && back.heartbeatAt !== undefined);
  store.heartbeat(a.id, 42);
  check('heartbeat moves heartbeat_at', store.attempt(a.id)!.heartbeatAt === 42);
  check('a default attempt is read-only, unsandboxed, shared network', (() => {
    const r = store.createTask({ missionId: review.id, role: 'review', objective: 'r' });
    const s = store.startAttempt({ taskId: r.id, runnerId: 'agent:mock:r' }).sandbox;
    return !s!.write && !s!.exec && s!.network === 'shared' && s!.profile === 'none' && s!.authorizeDecisionId === null;
  })());

  check('no attempt holds write without its grant', store.unauthorizedWriteAttempts().length === 0);
  const raw = new DatabaseSync(path.join(out, 'daylight.db'));
  check('the database itself refuses write with no grant', !!throws(() =>
    raw.prepare('UPDATE attempts SET authorize_decision_id=NULL WHERE id=?').run(a.id)));
  check('and exec without write', !!throws(() =>
    raw.prepare('UPDATE attempts SET sandbox_exec=1, sandbox_write=0 WHERE id=?').run(back.id)));
  raw.prepare('UPDATE attempts SET authorize_decision_id=? WHERE id=?').run(otherAuth.id, a.id);
  check('a row edited to point at another mission\'s grant is found by the invariant',
    store.unauthorizedWriteAttempts(PROJECT.id).map((x) => x.id).join() === a.id);
  raw.prepare('UPDATE attempts SET authorize_decision_id=? WHERE id=?').run(decision.id, a.id);
  check('and clears once it is put back', store.unauthorizedWriteAttempts().length === 0);
  raw.prepare("UPDATE attempts SET sandbox_profile='review' WHERE id=?").run(a.id);
  check('a write attempt edited onto a non-author profile is found by the invariant',
    store.unauthorizedWriteAttempts().map((x) => x.id).join() === a.id);
  raw.prepare("UPDATE attempts SET sandbox_profile='author' WHERE id=?").run(a.id);
  raw.close();
}

section('usage');
{
  const turn = (requestId: string | null, input: number | null, output: number | null) => ({
    requestId, model: 'mock-1', tokens: { input, output, cacheRead: null, cacheWrite: null },
    costUsd: null, costSource: 'none' as const, source: 'provider' as const,
  });
  const r1 = store.recordUsage(authorId, turn('msg_1', 10, null));
  const r2 = store.recordUsage(authorId, turn('msg_1', 10, 5));
  const r3 = store.recordUsage(authorId, turn('msg_1', 10, 5));
  const r4 = store.recordUsage(authorId, turn('msg_1', 3, 2));
  const r5 = store.recordUsage(authorId, turn(null, 1, 1));
  check('a new request id inserts seq 1', r1.result === 'inserted' && r1.seq === 1);
  check('the same request id with more merges', r2.result === 'merged' && r2.seq === 1);
  check('the same line again is a duplicate', r3.result === 'duplicate');
  check('smaller counts never lower a field (MAX merge)', r4.result === 'duplicate' && store.usageRows(authorId)[0].tokens.input === 10);
  check('a turn with no request id is its own row', r5.result === 'inserted' && r5.seq === 2);
  const totals = store.usageTotals(authorId);
  check('totals sum each field', totals.input === 11 && totals.output === 6);
  check('a field no turn reported stays null, not 0', totals.cacheRead === null);
  check('a cost labelled none is refused', !!throws(() => store.recordUsage(authorId, { ...turn('msg_2', 1, 1), costUsd: 0.1 })));
  check('only a provider cost is known', costKnown('provider') && !costKnown('stdout-scan') && !costKnown('none'));
  check('rows carry their project', store.usageRows(authorId).every((u) => u.projectId === PROJECT.id));
}

section('gates, candidates, applications');
let candidateId: string;
{
  const test = art('test("x", () => {})', 'test');
  const expected = art('{"exitCode":0}', 'expected');
  const mk = (role: 'gate' | 'holdout' | 'probe', id?: string) => store.createExperiment({
    id, missionId: mission.id, projectId: PROJECT.id, claimIds: [], subject: 'src/a.ts', predicate: 'works',
    hypothesis: 'h', prediction: { exitCode: 0 }, baseRevision: 'base1', testArtifact: test, expectedArtifact: expected,
    harnessDigest: digestOf(`${role}-${id ?? ''}`), command: ['node', '--test'], sandboxProfile: 'bwrap', limitations: [], role,
  });
  const preId = newId('experiment');
  const gate = mk('gate', preId);
  const holdout = mk('holdout');
  const probe = mk('probe');
  check('an experiment can be created under an id minted first', gate.id === preId);
  check('a malformed experiment id is refused', !!throws(() => mk('gate', 'x_short')));
  check('roles are stored', store.experimentsFor(mission.id, 'gate').length === 1 && store.experimentsFor(mission.id, 'holdout').length === 1);
  check('a P0 experiment defaults to probe', store.createExperiment({ ...probe, id: undefined, role: undefined }).role === 'probe');

  check('locking a probe is refused', !!throws(() => store.lockGates(mission.id, { experimentIds: [probe.id], actor: HUMAN, rationale: 'r' })));
  check('locking by an agent is refused and writes nothing', !!throws(() =>
    store.lockGates(mission.id, { experimentIds: [gate.id], actor: 'agent:a:b', rationale: 'r' }))
    && store.experiment(gate.id)!.lockedBy === undefined && store.lockDecision(mission.id) === null);
  const lock = store.lockGates(mission.id, { experimentIds: [holdout.id, gate.id], actor: HUMAN, rationale: 'these', vacuousOverrides: [] });
  check('the gate-set digest is over the sorted id:harness lines', lock.gateSetDigest === gateSetDigestOf([gate, holdout]));
  check('the lock decision records it', lock.decision.scope.gateSetDigest === lock.gateSetDigest && store.lockDecision(mission.id)?.id === lock.decision.id);
  check('every locked experiment names the decision', [gate.id, holdout.id].every((id) => store.experiment(id)!.lockedBy === lock.decision.id));
  check('the mission\'s acceptance gates are exactly the locked set',
    lock.mission.acceptanceGateIds.join() === [gate.id, holdout.id].sort().join());

  const base = store.recordGateEvaluation({
    missionId: mission.id, projectId: PROJECT.id, revision: 'base1', experimentId: gate.id, target: 'base',
    diffDigest: null, harnessDigest: gate.harnessDigest, executions: [], conclusion: 'falsified',
  });
  check('a base evaluation records falsified', base.conclusion === 'falsified' && base.id.startsWith('g_'));
  check('a base evaluation naming a diff is refused', !!throws(() => store.recordGateEvaluation({ ...base, diffDigest: digestOf('x') })));

  const diff = art('diff --git a/src/a.ts b/src/a.ts\n', 'diff');
  const files: CandidateFile[] = [{ path: 'src/a.ts', change: 'modified', insertions: 1, deletions: 0, mode: 'file', previousMode: 'file' }];
  const cInput = {
    missionId: mission.id, attemptId: authorId, projectId: PROJECT.id, baseCommit: 'base1', diffArtifact: diff,
    summaryArtifact: art('{"files":1}', 'summary'), narrativeArtifact: art('I did it', 'narrative'), files,
    policyViolations: [], secretHits: 0, gateSetDigest: lock.gateSetDigest,
    profile: { name: 'author-bwrap' as const, network: 'none' as const, write: true, exec: false },
    attemptState: 'completed' as const,
  };
  check('a candidate under another project is refused', !!throws(() => store.createCandidate({ ...cInput, projectId: OTHER.id })));
  check('a candidate from another mission\'s attempt is refused', !!throws(() => store.createCandidate({ ...cInput, missionId: spec.id })));
  const c = store.createCandidate(cInput);
  candidateId = c.id;
  check('a candidate starts pending', c.verdict === 'pending' && store.candidates(mission.id).length === 1);
  check('a candidate evaluation on another diff is refused', !!throws(() => store.recordGateEvaluation({
    ...base, target: 'candidate', candidateId: c.id, diffDigest: digestOf('other'), conclusion: 'supported',
  })));
  store.recordGateEvaluation({ ...base, target: 'candidate', candidateId: c.id, diffDigest: diff.digest, conclusion: 'supported' });
  check('gate evaluations filter by candidate and target',
    store.gateEvaluations({ candidateId: c.id }).length === 1 && store.gateEvaluations({ missionId: mission.id, target: 'base' }).length === 1);
  const v = store.updateCandidateVerdict(c.id, 'accepted-by-gates', ['all gates supported']);
  check('a verdict is recorded with its reasons', v.verdict === 'accepted-by-gates' && v.verdictReasons.length === 1);

  check('closing the implement mission as succeeded before apply is refused', (() => {
    store.transitionMission(mission.id, 'running');
    return !!throws(() => store.closeMission(mission.id, 'succeeded', 'gates passed'));
  })());

  const approveScope = { operation: 'approve-candidate', candidateId: c.id, diffDigest: diff.digest, gateSetDigest: lock.gateSetDigest, baseCommit: 'base1' };
  const wrong = store.recordDecision({
    missionId: mission.id, projectId: PROJECT.id, revision: 'base1', actor: HUMAN, kind: 'approve', rationale: 'r',
    scope: { ...approveScope, diffDigest: digestOf('different bytes') }, artifactIds: [],
  });
  const app = { candidateId: c.id, baseCommit: 'base1', commit: 'c0ffee', ref: 'refs/heads/daylight/x/y', appliedBy: HUMAN };
  check('apply with a decision on another diff is refused', !!throws(() => store.recordApplication({ ...app, decisionId: wrong.id })));
  const approve = store.recordDecision({
    missionId: mission.id, projectId: PROJECT.id, revision: 'base1', actor: HUMAN, kind: 'approve', rationale: 'good', scope: approveScope, artifactIds: [],
  });
  check('apply by a non-human is refused', !!throws(() => store.recordApplication({ ...app, decisionId: approve.id, appliedBy: 'agent:a:b' })));
  check('apply on another base is refused', !!throws(() => store.recordApplication({ ...app, decisionId: approve.id, baseCommit: 'base2' })));
  const p = store.recordApplication({ ...app, decisionId: approve.id });
  check('an approved candidate is applied once', p.id.startsWith('p_') && store.application(c.id)?.id === p.id && p.missionId === mission.id);
  check('a second application is refused', !!throws(() => store.recordApplication({ ...app, decisionId: approve.id })));
  const closed = store.closeMission(mission.id, 'succeeded', 'applied');
  check('and now the implement mission may close as succeeded', closed.outcome === 'succeeded');
}

section('experiment reaper');
{
  const m = store.createMission({ projectId: PROJECT.id, kind: 'verify', objective: 'x', baseRevision: 'b' });
  const t = art('t', 'test');
  const e = art('{}', 'expected');
  const base = {
    missionId: m.id, projectId: PROJECT.id, claimIds: [], subject: 's', predicate: 'p', hypothesis: 'h', prediction: { exitCode: 0 },
    baseRevision: 'b', testArtifact: t, expectedArtifact: e, harnessDigest: digestOf('h'), command: ['node'], sandboxProfile: 'bwrap', limitations: [],
  };
  const dead = store.createExperiment(base);
  const live = store.createExperiment(base);
  const never = store.createExperiment(base);
  const gateRow = store.createExperiment({ ...base, role: 'gate' });
  store.markExperimentStarted(dead.id, 100);
  store.markExperimentStarted(live.id, 100);
  store.markExperimentStarted(gateRow.id, 100);
  const reaped = store.reapPendingExperiments({ projectId: PROJECT.id, startedBefore: 1_000, isLive: (id) => id === live.id });
  check('a pending row whose run started long ago is concluded invalid', reaped.map((x) => x.id).join() === dead.id
    && store.experiment(dead.id)!.conclusion === 'invalid' && /runner died/.test(store.experiment(dead.id)!.limitations.join()));
  check('a live one is left alone', store.experiment(live.id)!.conclusion === 'pending');
  check('one that never started is left alone', store.experiment(never.id)!.conclusion === 'pending');
  check('a gate is never reaped: its conclusion is not what candidate runs record', store.experiment(gateRow.id)!.conclusion === 'pending');
  check('another project is never reaped', store.reapPendingExperiments({ projectId: OTHER.id, startedBefore: 1e15 }).length === 0);
}

section('ingested attempts and ingest sources');
{
  const work = store.createMission({ projectId: PROJECT.id, kind: 'work', objective: 'sessions', baseRevision: 'b' });
  const task = store.createTask({ missionId: work.id, role: 'session', objective: 's' });
  const a = store.startAttempt({ taskId: task.id, runnerId: 'ingest:claude-code', origin: 'ingested', at: 500 });
  check('an ingested attempt has no sandbox record', a.origin === 'ingested' && a.sandbox === null
    && store.attempt(a.id)!.sandbox === null && store.attempt(a.id)!.origin === 'ingested');
  check('and keeps the time it actually started', store.attempt(a.id)!.startedAt === 500);
  check('an ingested attempt with a sandbox record is refused', !!throws(() => store.startAttempt({
    taskId: store.createTask({ missionId: work.id, role: 'session', objective: 's2' }).id, runnerId: 'ingest:claude-code',
    origin: 'ingested', sandbox: { write: false },
  })));
  check('an ingested attempt outside a work mission is refused', !!throws(() => store.startAttempt({
    taskId: store.createTask({ missionId: spec.id, role: 'decompose', objective: 'i' }).id, runnerId: 'ingest:claude-code', origin: 'ingested',
  })));
  check('the write invariant does not count ingested attempts', store.unauthorizedWriteAttempts().length === 0);
  const raw = new DatabaseSync(path.join(out, 'daylight.db'));
  check('the database refuses a sandbox record on an ingested attempt', !!throws(() =>
    raw.prepare("UPDATE attempts SET sandbox_profile='author', sandbox_network='none', sandbox_write=0, sandbox_exec=0 WHERE id=?").run(a.id)));
  check('and a daylight attempt without one', !!throws(() =>
    raw.prepare('UPDATE attempts SET sandbox_profile=NULL, sandbox_network=NULL, sandbox_write=NULL, sandbox_exec=NULL WHERE id=?').run(authorId)));
  raw.close();
  check('an ingested attempt cannot finish with a provider-known cost', !!throws(() =>
    store.finishAttempt(a.id, { state: 'completed', costUsd: 0.5, costSource: 'provider' })));
  check('nor with an unlabelled one', !!throws(() => store.finishAttempt(a.id, { state: 'completed', costUsd: 0.5 }))
    && store.attempt(a.id)!.state === 'running');
  const ended = store.finishAttempt(a.id, { state: 'completed', costUsd: null, at: 900 });
  check('finishAttempt keeps an explicit end time', ended.finishedAt === 900);

  const sub = store.startAttempt({
    taskId: store.createTask({ missionId: work.id, role: 'session', objective: 'sub' }).id, runnerId: 'ingest:claude-code',
    origin: 'ingested', parentAttemptId: a.id,
  });
  const src = {
    sessionId: 'sess-1', agentId: '', projectId: PROJECT.id, pathDigest: digestOf('/p'), prefixDigest: digestOf('first ten'),
    bytesSeen: 10, linesSeen: 2, missionId: work.id, attemptId: a.id, ingestedAt: 1,
  };
  store.recordIngestSource(src);
  store.recordIngestSource({ ...src, linesSeen: 5 });
  store.recordIngestSource({ ...src, agentId: 'agent-7', attemptId: sub.id, linesSeen: 1 });
  check('an ingest source upserts its progress', store.ingestSource('sess-1')?.linesSeen === 5);
  check('a subagent shares the session id under its own key', store.ingestSource('sess-1', 'agent-7')?.attemptId === sub.id
    && store.ingestSources(PROJECT.id, { missionId: work.id }).length === 2);
  check('ingest sources list by project', store.ingestSources(PROJECT.id).length === 2 && store.ingestSources(OTHER.id).length === 0);
  check('a session already ingested into another project is refused', !!throws(() => store.recordIngestSource({ ...src, projectId: OTHER.id })));
  check('a Daylight-run attempt cannot be an ingest source', !!throws(() => store.recordIngestSource({ ...src, attemptId: authorId, missionId: mission.id })));
  check('content-derived event ids are event ids', isEntityId('event', `ev_cc_${'a'.repeat(64)}`)
    && isEntityId('event', `ev_mcp_${'b'.repeat(32)}`) && isEntityId('event', `ev_${'c'.repeat(32)}`) && !isEntityId('event', 'ev_cc_xyz'));
}

section('a supplied event id is appended once');
{
  const dir = path.join(tmp, 'events-dupe');
  fs.mkdirSync(dir);
  const log = new EventLog(dir);
  const id = `ev_cc_${'d'.repeat(64)}`;
  const first = log.append({ projectId: PROJECT.id, category: 'cost', name: 'cost.usage', payload: { n: 1 } }, id);
  const second = log.append({ projectId: PROJECT.id, category: 'cost', name: 'cost.usage', payload: { n: 2 } }, id);
  check('a second append under the same id is ignored, not an error', log.forMission('x').length === 0 && log.head() === 1);
  check('and returns the event already there', second.sequence === first.sequence && second.payload.n === 1);
  log.close();
}

section('finishAttempt records usage and cost source');
{
  const t = store.createTask({ missionId: spec.id, role: 'decompose', objective: 'again' });
  const a = store.startAttempt({ taskId: t.id, runnerId: 'agent:mock:x' });
  const f = store.finishAttempt(a.id, {
    state: 'completed', costUsd: 0.05, costSource: 'stdout-scan', model: 'mock-1',
    tokens: { input: 3, output: 4, cacheRead: null, cacheWrite: 0 }, usageSource: 'provider',
  });
  check('cost source, model and tokens land on the row', f.costSource === 'stdout-scan' && f.model === 'mock-1'
    && f.tokens.input === 3 && f.tokens.cacheRead === null && f.tokens.cacheWrite === 0 && f.usageSource === 'provider');
  const g = store.finishAttempt(store.startAttempt({ taskId: store.createTask({ missionId: spec.id, role: 'decompose', objective: 'n' }).id, runnerId: 'r' }).id,
    { state: 'failed', costUsd: null });
  check('a null cost defaults to source none', g.costSource === 'none' && g.costUsd === null);
  check('a cost labelled none is refused by the database', !!throws(() =>
    store.finishAttempt(store.startAttempt({ taskId: store.createTask({ missionId: spec.id, role: 'decompose', objective: 'z' }).id, runnerId: 'r' }).id,
      { state: 'failed', costUsd: 0.1, costSource: 'none' })));
  check('projectAttempts is scoped to one project', store.projectAttempts(PROJECT.id).length > 0 && store.projectAttempts(OTHER.id).length === 0);
}
section('confirm digests');
{
  const ctx = { store };
  const lockDecision = store.lockDecision(mission.id)!;
  const lockDigest = lockDecision.scope.gateSetDigest;
  const lock = confirmDigest(ctx, 'lock-gates', mission.id, { experimentIds: lockDecision.scope.experimentIds as string[] });
  check('lock-gates confirms the gate-set digest the lock records', lock.digest === lockDigest && lock.digest8 === lock.digest.slice(7, 15));
  check('and lists each gate', lock.lines.length === 3);
  check('a candidate act confirms the diff digest', confirmDigest(ctx, 'approve-candidate', candidateId).digest
    === store.candidate(candidateId)!.diffArtifact.digest && confirmDigest(ctx, 'apply', candidateId).digest8.length === 8);
  check('a work-item act confirms the content digest', confirmDigest(ctx, 'approve-work-item', w.id).digest === w.contentDigest);
  const grant = { permissions: { write: true, execute: false }, maxUsd: 2 };
  const auth = confirmDigest(ctx, 'authorize-mission', mission.id, grant);
  check('authorize confirms a stable digest of the mission', auth.digest === confirmDigest(ctx, 'authorize-mission', mission.id, grant).digest
    && auth.digest !== confirmDigest(ctx, 'authorize-mission', spec.id, grant).digest);
  check('authorize binds the grant asked for: other permissions, another code',
    auth.digest !== confirmDigest(ctx, 'authorize-mission', mission.id, { ...grant, permissions: { write: true, execute: true } }).digest
    && auth.digest !== confirmDigest(ctx, 'authorize-mission', mission.id, { ...grant, maxUsd: 200 }).digest);
  check('authorize without the grant is refused, not guessed', !!throws(() => confirmDigest(ctx, 'authorize-mission', mission.id)));
  const adhoc = confirmDigest(ctx, 'adhoc-mission', 'fix the typo', { projectId: PROJECT.id });
  check('an ad hoc mission binds its project: same objective, another project, another code',
    adhoc.digest !== confirmDigest(ctx, 'adhoc-mission', 'fix the typo', { projectId: OTHER.id }).digest);
  check('ad hoc without a project is refused', !!throws(() => confirmDigest(ctx, 'adhoc-mission', 'fix the typo')));
  check('an unknown subject is refused', !!throws(() => confirmDigest(ctx, 'lock-gates', 'm_nope', { experimentIds: [] })));

  // A partial lock, the normal case when a vacuous gate is left out (ws1-review M1).
  const pm = store.createMission({ projectId: PROJECT.id, kind: 'verify', objective: 'partial lock', baseRevision: 'base1' });
  const pt = art('test("p", () => {})', 'test');
  const pe = art('{"exitCode":0,"p":1}', 'expected');
  const gate = (role: 'gate' | 'holdout', n: number) => store.createExperiment({
    missionId: pm.id, projectId: PROJECT.id, claimIds: [], subject: 's', predicate: 'p', hypothesis: `h${n}`,
    prediction: { exitCode: 0 }, baseRevision: 'base1', testArtifact: pt, expectedArtifact: pe,
    harnessDigest: digestOf(`partial-${n}`), command: ['node', '--test'], sandboxProfile: 'bwrap', limitations: [], role,
  });
  const g1 = gate('gate', 1);
  gate('gate', 2);
  const h1 = gate('holdout', 3);
  const chosen = [g1.id, h1.id];
  const preview = confirmDigest(ctx, 'lock-gates', pm.id, { experimentIds: chosen });
  const locked = store.lockGates(pm.id, { experimentIds: chosen, actor: HUMAN, rationale: 'g2 is vacuous' });
  check('a partial lock is confirmable: the preview is the recorded digest', preview.digest === locked.gateSetDigest);
  check('and the guard accepts its code against the lock', guardCheck({}, HUMAN, preview.digest8, locked.gateSetDigest) === null);
  gate('gate', 4);
  check('a gate registered after the lock does not move the preview of the locked set',
    confirmDigest(ctx, 'lock-gates', pm.id, { experimentIds: chosen }).digest === store.lockDecision(pm.id)!.scope.gateSetDigest);
  check('the preview refuses what the lock would refuse', !!throws(() => confirmDigest(ctx, 'lock-gates', pm.id, { experimentIds: [] })));
  check('lock-gates without a chosen set is refused, not guessed', !!throws(() => confirmDigest(ctx, 'lock-gates', pm.id)));
}
store.close();

section('export format 2 round-trips the Forge rows');
{
  const src = openDaylight(out);
  const file = exportMission(src, mission.id);
  check('the export is format 2', file.schemaVersion === 2);
  check('it carries the work item, candidate, gate evaluations, application and usage',
    file.workItems.length === 1 && file.candidates.length === 1 && file.gateEvaluations.length === 2
    && file.applications.length === 1 && file.usage.length === 2);
  check('it carries the diff, summary, narrative and spec bytes', [file.candidates[0].diffArtifact, file.candidates[0].summaryArtifact,
    file.candidates[0].narrativeArtifact!, file.workItems[0].specArtifact].every((r) => !!file.artifacts[r.id]));
  const exportFile = path.join(tmp, 'v2-export.json');
  fs.writeFileSync(exportFile, JSON.stringify(file));
  src.close();

  const dst = openDaylight(path.join(tmp, 'flow-import'));
  const result = importMission(dst, readExport(exportFile));
  check('import adds every Forge row', result.added.workItems === 1 && result.added.candidates === 1
    && result.added.gateEvaluations === 2 && result.added.applications === 1 && result.added.usage === 2);
  const a = dst.store.attempt(authorId)!;
  check('the attempt keeps its sandbox stamp and grant', a.sandbox!.write && a.sandbox!.authorizeDecisionId === file.attempts.find((x) => x.id === authorId)!.sandbox!.authorizeDecisionId);
  check('the imported rows equal the exported ones', JSON.stringify(dst.store.candidate(candidateId)) === JSON.stringify(file.candidates[0])
    && JSON.stringify(dst.store.usageRows(authorId)) === JSON.stringify(file.usage));
  check('the write invariant holds after import', dst.store.unauthorizedWriteAttempts().length === 0);
  const again = importMission(dst, readExport(exportFile));
  check('importing twice adds nothing', again.added.candidates === 0 && again.added.usage === 0 && again.conflicts.length === 0);
  const tampered = { ...file, candidates: [{ ...file.candidates[0], verdict: 'rejected-by-gates' as const }] };
  check('a tampered candidate is a conflict', /candidate .* differs/.test(throws(() => importMission(dst, tampered))?.message ?? ''));
  dst.close();
}

section('import enforces R7 and R12 the way the store does');
{
  const file = readExport(path.join(tmp, 'v2-export.json'));
  const refusedWhole = (label: string, forged: typeof file, pattern: RegExp) => {
    const dir = path.join(tmp, `forged-${label}`);
    const dst = openDaylight(dir);
    const err = throws(() => importMission(dst, forged));
    check(`${label}: refused`, !!err && pattern.test(err.message), err?.message);
    check(`${label}: in one line`, !!err && !err.message.includes('\n'));
    check(`${label}: nothing was written`, dst.store.mission(forged.mission.id) === null
      && dst.store.projectAttempts(forged.project.id).length === 0 && dst.events.head() === 0
      && dst.claims.allSubjects().length === 0 && !fs.existsSync(path.join(dir, 'artifacts')));
    dst.close();
  };
  // The reviewer's forgery (rv-1/p2-bypass.ts): the grant flipped to a rejection.
  refusedWhole('grant flipped to reject', {
    ...file, decisions: file.decisions.map((d) => (d.scope.operation === 'authorize-mission' ? { ...d, kind: 'reject' as const } : d)),
  }, /write/);
  refusedWhole('grant removed', {
    ...file, decisions: file.decisions.filter((d) => d.scope.operation !== 'authorize-mission'),
  }, /write/);
  refusedWhole('grant from an agent', {
    ...file, decisions: file.decisions.map((d) => (d.scope.operation === 'authorize-mission' ? { ...d, actor: 'agent:claude:opus' } : d)),
  }, /human/);
  refusedWhole('write on a non-author profile', {
    ...file, attempts: file.attempts.map((a) => (a.sandbox?.write ? { ...a, sandbox: { ...a.sandbox, profile: 'review' as const } } : a)),
  }, /author/);
  // The reviewer's second forgery: ingested attempts on an implement mission.
  refusedWhole('ingested attempts on an implement mission', {
    ...file, attempts: file.attempts.map((a) => ({ ...a, origin: 'ingested' as const, sandbox: null })),
  }, /work mission/);
  refusedWhole('a daylight attempt with no sandbox record', {
    ...file, attempts: file.attempts.map((a) => ({ ...a, sandbox: null })),
  }, /sandbox/);
  refusedWhole('an attempt of another mission', {
    ...file, attempts: file.attempts.map((a, i) => (i === 0 ? { ...a, missionId: `m_${'7'.repeat(32)}` } : a)),
  }, /mission/);
  refusedWhole('a mission imported holding write it was never granted', {
    ...file, decisions: [], attempts: file.attempts.filter((a) => !a.sandbox?.write),
    candidates: [], gateEvaluations: [], applications: [], usage: [], experiments: [],
  }, /write/);
}

done();
