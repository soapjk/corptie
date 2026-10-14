import test from "node:test";
import assert from "node:assert/strict";
import { NativeDatabase } from "../src/store/nativeDatabase.mjs";
import { migrateCanonicalSessionNames } from "../src/store/migrations/sessionRoutingMigrations.mjs";

function fixture(t, rows) {
  const db = new NativeDatabase(":memory:");
  t.after(() => db.close());
  db.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE logical_sessions (logical_session_id TEXT PRIMARY KEY, legacy_session_id TEXT,
      title TEXT, session_name TEXT, session_name_key TEXT, deleted_at TEXT, created_at INTEGER);
    CREATE UNIQUE INDEX idx_logical_sessions_session_name ON logical_sessions(session_name_key)
      WHERE session_name_key IS NOT NULL;
    CREATE TABLE session_name_aliases (alias TEXT);
    INSERT INTO session_name_aliases VALUES ('old-alias');`);
  rows.forEach(([id, name, key, deleted = null], i) => {
    db.run("INSERT INTO sessions VALUES (?,?)", [id, name]);
    db.run("INSERT INTO logical_sessions VALUES (?,?,?,?,?,?,?)", [id, id, name, name, key, deleted, i]);
  });
  const snapshot = () => ({
    logical: db.all("SELECT * FROM logical_sessions ORDER BY created_at"),
    legacy: db.all("SELECT * FROM sessions ORDER BY id"),
    aliases: db.all("SELECT * FROM session_name_aliases")
  });
  const migrate = (connection = db) => migrateCanonicalSessionNames({ db: connection,
    selectAll: (...args) => db.all(...args) });
  return { db, migrate, snapshot };
}

test("deleted Session names stay released when a live Session has reused the label", t => {
  const f = fixture(t, [["deleted", "Shared", null, "deleted-at"], ["live", "Shared", "shared"],
    ["old-key", "Old", "old", "deleted-at"]]);
  f.migrate();
  const state = f.snapshot();
  assert.deepEqual(state.logical.map(row => [row.session_name, row.session_name_key]),
    [["Shared", null], ["Shared", "shared"], ["Old", null]]);
  assert.deepEqual(state.legacy.map(row => row.title), ["Shared", "Shared", "Old"]);
  assert.equal(state.aliases.length, 0);
  f.migrate();
  assert.deepEqual(f.snapshot(), state);
});

test("existing UNIQUE index permits swapped keys without transient collisions", t => {
  const f = fixture(t, [["first", "Alpha", "beta"], ["second", "Beta", "alpha"]]);
  f.migrate();
  assert.deepEqual(f.snapshot().logical.map(row => row.session_name_key), ["alpha", "beta"]);
  assert.ok(f.db.get("SELECT name FROM sqlite_master WHERE name='idx_logical_sessions_session_name'"));
});

test("generated suffixes do not steal a later live Session's existing name", t => {
  const f = fixture(t, [["first", "Task", null], ["duplicate", "Task", null], ["named", "Task 1", "task 1"]]);
  f.migrate();
  assert.deepEqual(f.snapshot().logical.map(row => row.session_name), ["Task", "Task 2", "Task 1"]);
});

test("migration failure rolls back cleared keys, renamed labels and alias deletion", t => {
  const f = fixture(t, [["first", "Alpha", "beta"], ["second", "Beta", "alpha"]]);
  const before = f.snapshot();
  const injected = { run: (sql, params) => {
    if (sql.includes("UPDATE sessions") && params[1] === "second") throw new Error("injected failure");
    return f.db.run(sql, params);
  } };
  assert.throws(() => f.migrate(injected), /injected failure/);
  assert.deepEqual(f.snapshot(), before);
});

test("migration savepoint does not commit its caller's outer transaction", t => {
  const f = fixture(t, [["first", "Alpha", "beta"], ["second", "Beta", "alpha"]]);
  const before = f.snapshot();
  f.db.run("BEGIN");
  f.migrate();
  f.db.run("ROLLBACK");
  assert.deepEqual(f.snapshot(), before);
});
