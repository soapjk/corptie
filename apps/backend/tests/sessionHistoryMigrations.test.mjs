import assert from "node:assert/strict";
import test from "node:test";
import { NativeDatabase } from "../src/store/nativeDatabase.mjs";
import { migrateSessionItemIdentity } from "../src/store/migrations/sessionHistoryMigrations.mjs";

test("legacy item identity migration rolls back failed copy, restores foreign keys and retries idempotently", () => {
  const db = new NativeDatabase(":memory:");
  try {
    db.run(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      INSERT INTO sessions VALUES ('session:one'), ('session:two');
      CREATE TABLE session_items (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        turn_status TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
        text TEXT NOT NULL, options_json TEXT, raw_metadata_json TEXT, binding_id TEXT,
        presentation_role TEXT, presentation_text TEXT, status TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      INSERT INTO session_items (id, session_id, turn_id, turn_status, type, title, text, created_at)
      VALUES ('item:one', 'session:one', 'turn:one', 'completed', 'agentMessage', 'Agent', 'retained', '2026-01-01');
    `);
    const before = db.all("SELECT * FROM session_items");
    const originalSQL = db.get("SELECT sql FROM sqlite_master WHERE name = 'session_items'").sql;
    const failure = new Error("injected copy failure");
    const selectAll = (...args) => db.all(...args);
    assert.throws(() => migrateSessionItemIdentity({
      selectAll,
      db: { run(sql, params) {
        if (sql.includes("INSERT INTO session_items")) throw failure;
        return db.run(sql, params);
      } }
    }), error => error === failure);
    assert.equal(db.get("SELECT sql FROM sqlite_master WHERE name = 'session_items'").sql, originalSQL);
    assert.equal(db.get("PRAGMA foreign_keys").foreign_keys, 1);
    assert.deepEqual(db.all("SELECT * FROM session_items"), before);
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'session_items_global_id_legacy'"), null);
    migrateSessionItemIdentity({ db, selectAll });
    assert.deepEqual(db.all("SELECT * FROM session_items"), before);
    const schema = db.all("SELECT name, sql FROM sqlite_master ORDER BY name");
    migrateSessionItemIdentity({ db, selectAll });
    assert.deepEqual(db.all("SELECT name, sql FROM sqlite_master ORDER BY name"), schema);
    db.run(`INSERT INTO session_items (id, session_id, turn_id, turn_status, type, title, text, created_at)
      VALUES ('item:one', 'session:two', 'turn:two', 'completed', 'agentMessage', 'Agent', 'distinct', '2026-01-01')`);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM session_items").count, 2);
    assert.equal(db.get("PRAGMA foreign_keys").foreign_keys, 1);
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
  } finally {
    db.close();
  }
});
