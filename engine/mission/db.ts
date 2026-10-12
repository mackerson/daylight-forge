import { DatabaseSync } from 'node:sqlite';
import { DAYLIGHT_SCHEMA_VERSION } from './types.ts';

/**
 * The Daylight database: one `daylight.db` beside `claims.db` in an output directory.
 *
 * A separate file, deliberately. `claims.db` is committed knowledge about a repository and
 * is already under dispute as a god node; missions, attempts and events are bookkeeping
 * about *work*, with a different lifetime and a different reader. Sharing a file would make
 * `migrateSubject` responsible for tables it knows nothing about.
 *
 * Same concurrency posture as the claim store: WAL and a busy timeout, because the MCP
 * server, the driver and the Electron shell all open this at once while a swarm runs.
 *
 * Migrations are numbered and recorded in `daylight_meta`; `openDaylightDb` applies whatever
 * the file is behind on. A test asserts opening twice is a no-op and that the version lands.
 */

export const DAYLIGHT_DB = 'daylight.db';

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS daylight_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  root       TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS missions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  parent_id           TEXT,
  kind                TEXT NOT NULL,
  objective           TEXT NOT NULL,
  base_revision       TEXT NOT NULL,
  scope               TEXT NOT NULL,
  permissions         TEXT NOT NULL,
  budget              TEXT NOT NULL,
  requirement_ids     TEXT NOT NULL,
  acceptance_gate_ids TEXT NOT NULL,
  state               TEXT NOT NULL,
  outcome             TEXT,
  outcome_reason      TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  closed_at           INTEGER
);
CREATE INDEX IF NOT EXISTS missions_project ON missions(project_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  mission_id       TEXT NOT NULL REFERENCES missions(id),
  project_id       TEXT NOT NULL,
  role             TEXT NOT NULL,
  objective        TEXT NOT NULL,
  depends_on       TEXT NOT NULL,
  inputs           TEXT NOT NULL,
  required_outputs TEXT NOT NULL,
  state            TEXT NOT NULL,
  runner_hint      TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_mission ON tasks(mission_id, created_at);

CREATE TABLE IF NOT EXISTS attempts (
  id          TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL REFERENCES missions(id),
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  project_id  TEXT NOT NULL,
  runner_id   TEXT NOT NULL,
  session_id  TEXT,
  worktree    TEXT,
  state       TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  cost_usd    REAL,
  exit_code   INTEGER,
  signal      TEXT,
  timed_out   INTEGER NOT NULL DEFAULT 0,
  failure     TEXT,
  artifacts   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id, started_at);
CREATE INDEX IF NOT EXISTS attempts_session ON attempts(session_id);

CREATE TABLE IF NOT EXISTS experiments (
  id                TEXT PRIMARY KEY,
  mission_id        TEXT NOT NULL REFERENCES missions(id),
  project_id        TEXT NOT NULL,
  claim_ids         TEXT NOT NULL,
  subject           TEXT NOT NULL,
  predicate         TEXT NOT NULL,
  hypothesis        TEXT NOT NULL,
  prediction        TEXT NOT NULL,
  base_revision     TEXT NOT NULL,
  test_artifact     TEXT NOT NULL,
  expected_artifact TEXT NOT NULL,
  harness_digest    TEXT NOT NULL,
  command           TEXT NOT NULL,
  sandbox_profile   TEXT NOT NULL,
  executions        TEXT NOT NULL,
  conclusion        TEXT NOT NULL,
  limitations       TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS experiments_mission ON experiments(mission_id, created_at);

CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  mission_id   TEXT NOT NULL REFERENCES missions(id),
  project_id   TEXT NOT NULL,
  revision     TEXT NOT NULL,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject      TEXT,
  predicate    TEXT,
  value        TEXT,
  rationale    TEXT NOT NULL,
  scope        TEXT NOT NULL,
  artifact_ids TEXT NOT NULL,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_mission ON decisions(mission_id, at);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  digest     TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision   TEXT,
  path       TEXT,
  label      TEXT,
  bytes      INTEGER,
  media_type TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  at             INTEGER NOT NULL,
  project_id     TEXT NOT NULL,
  mission_id     TEXT,
  task_id        TEXT,
  attempt_id     TEXT,
  actor_id       TEXT,
  category       TEXT NOT NULL,
  name           TEXT NOT NULL,
  artifact_ids   TEXT,
  payload        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_mission ON events(mission_id, sequence);
CREATE INDEX IF NOT EXISTS events_attempt ON events(attempt_id, sequence);
`,
  },
];

export function schemaVersion(db: DatabaseSync): number {
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daylight_meta'")
    .get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM daylight_meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

/** Apply pending migrations. Returns the versions applied, in order — empty when up to date. */
export function migrate(db: DatabaseSync): number[] {
  const applied: number[] = [];
  let current = schemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO daylight_meta (key, value) VALUES ('schema_version', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(String(m.version));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    current = m.version;
    applied.push(m.version);
  }
  if (current !== DAYLIGHT_SCHEMA_VERSION) {
    throw new Error(
      `daylight.db is at schema ${current}; this build writes schema ${DAYLIGHT_SCHEMA_VERSION}`,
    );
  }
  return applied;
}

export function openDaylightDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** JSON columns, read back tolerant of a hand-edited or torn value. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
