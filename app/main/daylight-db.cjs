const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

/**
 * The shell's direct, read-only open of `daylight.db` for the live event projection.
 *
 * The engine owns the schema (engine/mission/db.ts); this mirrors only its refusal, because the
 * shell cannot import the engine. A file that is not schema 2 is not opened at all, and the
 * check is made without leaving anything behind: a read-only open of a WAL file still creates
 * `-shm` and `-wal`, so a file with no `-wal` is read `immutable`, which creates nothing.
 */
const DB_VERSION = '2';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  // Older Electron. Callers fall back to the CLI.
}

const refusal = (file, what) =>
  `${file} is ${what} Daylight database; this build reads schema ${DB_VERSION} only and never migrates. ` +
  'Delete it and re-map (daylight map <repo> --out <dir>).';

/** `{db, refused}`: an open database, or why it was refused, or neither when there is no file. */
function openEventsReadOnly(file) {
  if (!sqlite || !fs.existsSync(file) || fs.statSync(file).size === 0) return { db: null, refused: null };
  const head = Buffer.alloc(SQLITE_HEADER.length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.equals(SQLITE_HEADER)) return { db: null, refused: refusal(file, 'not a SQLite file, so not a') };
  let target = file;
  if (!fs.existsSync(`${file}-wal`)) {
    target = pathToFileURL(file);
    target.searchParams.set('immutable', '1');
  }
  const db = new sqlite.DatabaseSync(target, { readOnly: true });
  let version = null;
  try {
    const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daylight_meta'").get();
    const row = meta ? db.prepare("SELECT value FROM daylight_meta WHERE key='schema_version'").get() : undefined;
    version = row ? String(row.value) : null;
  } catch (err) {
    db.close();
    throw err;
  }
  if (version !== DB_VERSION) {
    db.close();
    return { db: null, refused: refusal(file, version ? `a schema ${version}` : 'an unversioned') };
  }
  return { db, refused: null };
}

/** One events row as the engine's `DaylightEvent`. */
function rowToEvent(r) {
  const json = (v, fallback) => {
    if (v === null || v === undefined || v === '') return fallback;
    try { return JSON.parse(v); } catch { return fallback; }
  };
  return {
    schemaVersion: r.schema_version,
    id: r.id,
    sequence: Number(r.sequence),
    at: Number(r.at),
    projectId: r.project_id,
    missionId: r.mission_id ?? undefined,
    taskId: r.task_id ?? undefined,
    attemptId: r.attempt_id ?? undefined,
    actorId: r.actor_id ?? undefined,
    category: r.category,
    name: r.name,
    artifactIds: json(r.artifact_ids, undefined),
    payload: json(r.payload, {}),
  };
}

const KEPT = ['experimentId', 'gateEvaluationId', 'target', 'diffDigest', 'conclusion', 'runIndex', 'status', 'runs'];

/**
 * The engine's `withholdHoldoutEvents`, for the shell's direct read: an event about a holdout,
 * or pointing at one of its artifacts, keeps its ids and outcome and loses everything else, so
 * holdout content never reaches the renderer (ws9-review M1). The engine's set also covers the
 * logs a run record names; an event pointing at those also names the run record, caught here.
 */
function withholdHoldouts(db, events) {
  const parse = (v) => { try { return JSON.parse(v); } catch { return null; } };
  const ids = new Set();
  const artifacts = new Set();
  for (const x of db.prepare("SELECT id, test_artifact, expected_artifact, executions FROM experiments WHERE role='holdout'").all()) {
    ids.add(x.id);
    for (const ref of [parse(x.test_artifact), parse(x.expected_artifact), ...(parse(x.executions) ?? [])]) if (ref && ref.id) artifacts.add(ref.id);
  }
  if (!ids.size) return events;
  for (const g of db.prepare('SELECT experiment_id, executions FROM gate_evaluations').all()) {
    if (!ids.has(g.experiment_id)) continue;
    for (const ref of parse(g.executions) ?? []) if (ref && ref.id) artifacts.add(ref.id);
  }
  return events.map((e) => {
    const p = e.payload || {};
    const about = typeof p.experimentId === 'string' && ids.has(p.experimentId);
    const points = (e.artifactIds || []).some((a) => artifacts.has(a));
    if (!about && !points && p.role !== 'holdout') return e;
    const keep = { role: 'holdout', withheld: true };
    for (const k of KEPT) if (k in p) keep[k] = p[k];
    return { ...e, payload: keep, artifactIds: [] };
  });
}

module.exports = { openEventsReadOnly, rowToEvent, withholdHoldouts, sqliteAvailable: () => sqlite !== null };
