import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateTaskDomainV1, needsTaskDomainMigration } from "../src/store/taskSchemaMigration.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.get = (sql, params = []) => db.prepare(sql).get(...params);
  db.all = (sql, params = []) => db.prepare(sql).all(...params);
  db.run = (sql, params = []) => db.prepare(sql).run(...params);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE data_migrations (migration_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE works (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, work_item_id TEXT);
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES works(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      work_item_id TEXT REFERENCES work_items(id)
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN (
        'work_private', 'work_item_private', 'session_private', 'repository_tracked'
      )),
      work_item_id TEXT REFERENCES work_items(id)
    );
    CREATE INDEX idx_artifacts_scope ON artifacts(scope, visibility);
    CREATE TABLE collaboration_tasks (
      task_id TEXT PRIMARY KEY,
      parent_task_id TEXT REFERENCES collaboration_tasks(task_id),
      work_item_id TEXT REFERENCES work_items(id)
    );
    CREATE TABLE collaboration_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES collaboration_tasks(task_id),
      source_work_item_id TEXT REFERENCES work_items(id)
    );
  `);
  db.prepare("INSERT INTO works VALUES (?)").run("work:1");
  db.prepare("INSERT INTO sessions(id, work_item_id) VALUES (?, ?)").run("session:1", null);
  db.prepare(`INSERT INTO work_items(id, work_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run("work_item:1", "work:1", "Legacy", "2026-09-01", "2026-09-01");
  db.prepare("UPDATE sessions SET work_item_id=? WHERE id=?").run("work_item:1", "session:1");
  db.prepare("INSERT INTO memories VALUES (?, ?, ?, ?)")
    .run("memory:1", "work_item", "work_item:1", "work_item:1");
  db.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?)")
    .run("artifact:1", "work_item", "work_item_private", "work_item:1");
  db.prepare("INSERT INTO collaboration_tasks VALUES (?, ?, ?)")
    .run("collaboration:1", null, "work_item:1");
  db.prepare("INSERT INTO collaboration_messages VALUES (?, ?, ?)")
    .run("message:1", "collaboration:1", "work_item:1");
  return db;
}

test("task domain migration renames the authoritative graph without dual tables", () => {
  const db = database();
  assert.equal(needsTaskDomainMigration(db), true);
  const result = migrateTaskDomainV1(db, "2026-09-01T00:00:00.000Z");
  assert.equal(result.migrated, true);
  assert.equal(needsTaskDomainMigration(db), false);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'").get(), undefined);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_snapshots'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collaboration_requests'").get());
  assert.deepEqual({ ...db.prepare("SELECT task_id FROM sessions WHERE id='session:1'").get() }, { task_id: "work_item:1" });
  assert.deepEqual({ ...db.prepare("SELECT owner_type, task_id FROM memories").get() }, {
    owner_type: "task", task_id: "work_item:1"
  });
  assert.deepEqual({ ...db.prepare("SELECT scope, visibility, task_id FROM artifacts").get() }, {
    scope: "task", visibility: "task_private", task_id: "work_item:1"
  });
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'").get().sql,
    /task_private/
  );
  assert.doesNotMatch(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'").get().sql,
    /work_item_private/
  );
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_artifacts_scope'").get());
  assert.doesNotThrow(() => db.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?)")
    .run("artifact:2", "task", "task_private", "work_item:1"));
  assert.deepEqual({ ...db.prepare("SELECT task_id, target_task_id FROM collaboration_requests").get() }, {
    task_id: "collaboration:1", target_task_id: "work_item:1"
  });
  assert.deepEqual({ ...db.prepare("SELECT task_id, source_task_id FROM collaboration_messages").get() }, {
    task_id: "collaboration:1", source_task_id: "work_item:1"
  });
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  db.prepare(`INSERT INTO task_snapshots (
    id, task_id, version, title, created_by_session_id, content_hash, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("snapshot:1", "work_item:1", 1, "Legacy", "session:1", "hash", "2026-09-01");
  assert.throws(() => db.prepare("UPDATE task_snapshots SET title='Changed'").run(), /TASK_SNAPSHOT_IMMUTABLE/);
  db.close();
});

test("task domain migration rejects an ambiguous dual schema", () => {
  const db = database();
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
  assert.throws(() => migrateTaskDomainV1(db), /both exist/);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'").get());
  db.close();
});
