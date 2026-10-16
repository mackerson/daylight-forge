import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { DAYLIGHT_DB_VERSION } from './types.ts';

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
 * There is one schema and no migrations (RULINGS R2). A fresh file gets schema 2; a file at
 * any other version, or with tables and no version at all, is refused with one line saying
 * to delete it and re-map, and is left exactly as it was found. P0 data is disposable, and
 * a half-understood upgrade path is a second schema nobody tests.
 */

export const DAYLIGHT_DB = 'daylight.db';

/**
 * Schema 2. The P0 tables with the Forge columns folded in, and the Forge tables.
 *
 * Every Forge row carries its project, and a revision where it has one, so a query by
 * project needs no join and one repository's rows can never be read as another's.
 */
const SCHEMA = `
CREATE TABLE daylight_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  root       TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE missions (
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
  work_item_id        TEXT REFERENCES work_items(id),
  state               TEXT NOT NULL,
  outcome             TEXT,
  outcome_reason      TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  closed_at           INTEGER
);
CREATE INDEX missions_project ON missions(project_id, created_at);

CREATE TABLE tasks (
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
CREATE INDEX tasks_mission ON tasks(mission_id, created_at);

CREATE TABLE attempts (
  id                 TEXT PRIMARY KEY,
  mission_id         TEXT NOT NULL REFERENCES missions(id),
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  project_id         TEXT NOT NULL,
  runner_id          TEXT NOT NULL,
  session_id         TEXT,
  worktree           TEXT,
  state              TEXT NOT NULL,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER,
  cost_usd           REAL,
  exit_code          INTEGER,
  signal             TEXT,
  timed_out          INTEGER NOT NULL DEFAULT 0,
  failure            TEXT,
  artifacts          TEXT NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  usage_source       TEXT NOT NULL DEFAULT 'none' CHECK (usage_source IN ('provider','transcript','none')),
  cost_source        TEXT NOT NULL DEFAULT 'none' CHECK (cost_source IN ('provider','stdout-scan','none')),
  model              TEXT,
  parent_attempt_id  TEXT REFERENCES attempts(id),
  gate_set_digest    TEXT,
  pid                INTEGER,
  heartbeat_at       INTEGER,
  sandbox_profile    TEXT NOT NULL DEFAULT 'none' CHECK (sandbox_profile IN ('none','review','author','gate')),
  sandbox_network    TEXT NOT NULL DEFAULT 'shared' CHECK (sandbox_network IN ('none','shared')),
  sandbox_write      INTEGER NOT NULL DEFAULT 0 CHECK (sandbox_write IN (0,1)),
  sandbox_exec       INTEGER NOT NULL DEFAULT 0 CHECK (sandbox_exec IN (0,1)),
  authorize_decision_id TEXT REFERENCES decisions(id),
  -- {present, envName, label}: which credential, never its value.
  credential         TEXT,
  -- sha256 of the per-attempt MCP socket token (R11.2), never the token.
  mcp_token_digest   TEXT UNIQUE,
  -- A cost nobody reported is not a cost (R10.2).
  CHECK (cost_source <> 'none' OR cost_usd IS NULL),
  -- R7, as a constraint as well as a store check: write never stands without its grant.
  CHECK (sandbox_write = 0 OR authorize_decision_id IS NOT NULL),
  CHECK (sandbox_exec = 0 OR sandbox_write = 1)
);
CREATE INDEX attempts_task ON attempts(task_id, started_at);
CREATE INDEX attempts_session ON attempts(session_id);
CREATE INDEX attempts_mission_state ON attempts(mission_id, state);

CREATE TABLE attempt_usage (
  attempt_id         TEXT NOT NULL REFERENCES attempts(id),
  project_id         TEXT NOT NULL,
  seq                INTEGER NOT NULL,
  request_id         TEXT,
  at                 INTEGER NOT NULL,
  model              TEXT,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           REAL,
  cost_source        TEXT NOT NULL DEFAULT 'none' CHECK (cost_source IN ('provider','stdout-scan','none')),
  source             TEXT NOT NULL CHECK (source IN ('provider','transcript')),
  CHECK (cost_source <> 'none' OR cost_usd IS NULL),
  PRIMARY KEY (attempt_id, seq),
  UNIQUE (attempt_id, request_id)
);

CREATE TABLE experiments (
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
  role              TEXT NOT NULL DEFAULT 'probe' CHECK (role IN ('probe','gate','holdout')),
  locked_by         TEXT REFERENCES decisions(id),
  started_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX experiments_mission ON experiments(mission_id, created_at);

CREATE TABLE decisions (
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
CREATE INDEX decisions_mission ON decisions(mission_id, at);

CREATE TABLE artifacts (
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

CREATE TABLE events (
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
CREATE INDEX events_mission ON events(mission_id, sequence);
CREATE INDEX events_attempt ON events(attempt_id, sequence);

-- mission_id and attempt_id name the spec mission and decompose attempt that proposed the
-- item. No foreign keys: an implement mission's export carries its work item, not them.
CREATE TABLE work_items (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  mission_id        TEXT NOT NULL,
  attempt_id        TEXT,
  proposal_artifact TEXT,
  content_digest    TEXT NOT NULL,
  spec_artifact     TEXT NOT NULL,
  spec_revision     TEXT NOT NULL,
  anchor            TEXT NOT NULL,
  title             TEXT NOT NULL,
  statement         TEXT NOT NULL,
  examples          TEXT NOT NULL,
  negative_examples TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','superseded')),
  proposed_by       TEXT NOT NULL,
  decision_id       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX work_items_project ON work_items(project_id, created_at);

CREATE TABLE candidates (
  id                 TEXT PRIMARY KEY,
  mission_id         TEXT NOT NULL REFERENCES missions(id),
  attempt_id         TEXT NOT NULL REFERENCES attempts(id),
  project_id         TEXT NOT NULL,
  base_commit        TEXT NOT NULL,
  diff_artifact      TEXT NOT NULL,
  summary_artifact   TEXT NOT NULL,
  narrative_artifact TEXT,
  files              TEXT NOT NULL,
  policy_violations  TEXT NOT NULL,
  secret_hits        INTEGER NOT NULL,
  gate_set_digest    TEXT NOT NULL,
  profile            TEXT NOT NULL,
  attempt_state      TEXT NOT NULL,
  attempt_failure    TEXT,
  verdict            TEXT NOT NULL,
  verdict_reasons    TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX candidates_mission ON candidates(mission_id, created_at);

CREATE TABLE gate_evaluations (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT NOT NULL REFERENCES missions(id),
  project_id     TEXT NOT NULL,
  revision       TEXT NOT NULL,
  experiment_id  TEXT NOT NULL REFERENCES experiments(id),
  candidate_id   TEXT REFERENCES candidates(id),
  target         TEXT NOT NULL CHECK (target IN ('base','candidate')),
  diff_digest    TEXT,
  harness_digest TEXT NOT NULL,
  executions     TEXT NOT NULL,
  conclusion     TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX gate_evals_candidate ON gate_evaluations(candidate_id);
CREATE INDEX gate_evals_mission ON gate_evaluations(mission_id, created_at);

CREATE TABLE applications (
  id           TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES candidates(id),
  mission_id   TEXT NOT NULL REFERENCES missions(id),
  decision_id  TEXT NOT NULL REFERENCES decisions(id),
  project_id   TEXT NOT NULL,
  base_commit  TEXT NOT NULL,
  commit_sha   TEXT NOT NULL,
  ref          TEXT NOT NULL,
  applied_by   TEXT NOT NULL,
  at           INTEGER NOT NULL
);
CREATE INDEX applications_mission ON applications(mission_id);

CREATE TABLE ingest_sources (
  session_id  TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  path_digest TEXT NOT NULL,
  bytes_seen  INTEGER NOT NULL,
  lines_seen  INTEGER NOT NULL,
  mission_id  TEXT NOT NULL REFERENCES missions(id),
  attempt_id  TEXT NOT NULL REFERENCES attempts(id),
  ingested_at INTEGER NOT NULL
);
`;

/** A database this build will not read. The message is one line and says what to do. */
export class IncompatibleDatabase extends Error {
  constructor(file: string, found: number) {
    super(
      `${file} is ${found ? `a schema ${found}` : 'an unversioned'} Daylight database; this build reads ` +
        `schema ${DAYLIGHT_DB_VERSION} only and never migrates. Delete it and re-map ` +
        '(daylight map <repo> --out <dir>).',
    );
    this.name = 'IncompatibleDatabase';
  }
}

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

const hasTables = (db: DatabaseSync): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();

/**
 * The version of an existing file, read without writing to it, or null when there is nothing
 * there yet. A read-write open would already have changed the file (WAL switch, `-wal` and
 * `-shm` beside it) before it could tell it was refusing, and even a read-only open of a WAL
 * file leaves `-shm` and `-wal` behind. So a file with no `-wal` is read `immutable`, which
 * creates nothing; one with a `-wal` is in use, its sidecars already exist, and only a normal
 * read-only open sees the committed state in it.
 */
function existingVersion(file: string): number | null {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return null;
  let target: string | URL = file;
  if (!fs.existsSync(`${file}-wal`)) {
    target = pathToFileURL(file);
    target.searchParams.set('immutable', '1');
  }
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    return hasTables(db) ? schemaVersion(db) : null;
  } finally {
    db.close();
  }
}

/**
 * Create schema 2 on an empty database, or confirm it is there. Returns true when it created
 * it. Anything else is refused: there is no older schema this knows how to read.
 */
export function ensureSchema(db: DatabaseSync, file = 'daylight.db'): boolean {
  if (schemaVersion(db) === DAYLIGHT_DB_VERSION) return false;
  // IMMEDIATE takes the write lock before looking, so two processes opening one fresh
  // directory cannot both decide it is empty.
  db.exec('BEGIN IMMEDIATE');
  try {
    const found = schemaVersion(db);
    if (found === DAYLIGHT_DB_VERSION) {
      db.exec('COMMIT');
      return false;
    }
    if (found !== 0 || hasTables(db)) throw new IncompatibleDatabase(file, found);
    db.exec(SCHEMA);
    db.prepare("INSERT INTO daylight_meta (key, value) VALUES ('schema_version', ?)")
      .run(String(DAYLIGHT_DB_VERSION));
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function openDaylightDb(file: string): DatabaseSync {
  const found = existingVersion(file);
  if (found !== null && found !== DAYLIGHT_DB_VERSION) throw new IncompatibleDatabase(file, found);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('PRAGMA foreign_keys = ON');
    ensureSchema(db, file);
  } catch (err) {
    db.close();
    throw err;
  }
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
