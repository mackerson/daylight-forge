const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openEventsReadOnly } = require('./daylight-db.cjs');

/**
 * The shell's direct, read-only view of daylight.db. Run: node app/main/daylight-db.test.cjs
 *
 * The engine refuses any database that is not schema 2 and leaves it exactly as found; the
 * shell reads the same file on a poll and must do both too, or a stale P0 file in <out> gets
 * -shm/-wal beside it every second and its events are served as if nothing were wrong.
 * Local assertions, not engine/test/harness.ts, for the reason session.test.cjs gives.
 */
let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-shell-db-'));
const listing = (dir) => fs.readdirSync(dir).sort().join(',');

function write(dir, version) {
  fs.mkdirSync(dir);
  const file = path.join(dir, 'daylight.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE daylight_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY, id TEXT, payload TEXT);
    INSERT INTO events VALUES (1, 'ev_x', '{}');`);
  if (version !== null) db.prepare("INSERT INTO daylight_meta VALUES ('schema_version', ?)").run(String(version));
  db.close();
  return file;
}

console.log('\nrefused databases');
for (const version of [1, null, 3]) {
  const dir = path.join(tmp, `v${version}`);
  const file = write(dir, version);
  const before = { bytes: fs.readFileSync(file), files: listing(dir) };
  const r = openEventsReadOnly(file);
  check(`schema ${version ?? 'none'}: refused, not opened`, r.db === null && /schema 2/.test(r.refused ?? ''), JSON.stringify(r.refused));
  check(`schema ${version ?? 'none'}: the message says to delete it and re-map`, /Delete it and re-map/.test(r.refused ?? ''));
  check(`schema ${version ?? 'none'}: no -shm or -wal beside it`, listing(dir) === before.files, listing(dir));
  check(`schema ${version ?? 'none'}: bytes unchanged`, fs.readFileSync(file).equals(before.bytes));
}
{
  const dir = path.join(tmp, 'garbage');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'daylight.db');
  fs.writeFileSync(file, 'not a database\n');
  const r = openEventsReadOnly(file);
  check('a non-SQLite file is refused', r.db === null && !!r.refused);
}

console.log('\nschema 2');
{
  const dir = path.join(tmp, 'v2');
  const file = write(dir, 2);
  const r = openEventsReadOnly(file);
  check('a schema 2 database opens', r.db !== null && r.refused === null);
  check('and reads its events', r.db?.prepare('SELECT COUNT(*) AS n FROM events').get().n === 1);
  r.db?.close();
  check('absent is neither', (() => {
    const a = openEventsReadOnly(path.join(tmp, 'nope', 'daylight.db'));
    return a.db === null && a.refused === null;
  })());
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
