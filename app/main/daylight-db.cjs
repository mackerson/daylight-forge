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

module.exports = { openEventsReadOnly, sqliteAvailable: () => sqlite !== null };
