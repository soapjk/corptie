import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  migrateTaskDomainV1,
  migrateTaskGoalRemovalV1,
  needsTaskDomainMigration
} from "../src/store/taskSchemaMigration.mjs";

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

test("Task goal removal drops persisted columns while preserving Task and snapshot data", () => {
  const db = new DatabaseSync(":memory:");
  db.get = (sql, params = []) => db.prepare(sql).get(...params);
  db.all = (sql, params = []) => db.prepare(sql).all(...params);
  db.run = (sql, params = []) => db.prepare(sql).run(...params);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE data_migrations (migration_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE task_snapshots (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT ''
    );
    CREATE TRIGGER task_snapshots_immutable_update
      BEFORE UPDATE ON task_snapshots BEGIN SELECT RAISE(ABORT, 'TASK_SNAPSHOT_IMMUTABLE'); END;
    INSERT INTO tasks VALUES ('task:one', 'Current', 'Current description', 'Legacy goal', 'Accepted');
    INSERT INTO task_snapshots VALUES (
      'snapshot:one', 'task:one', 'Previous', 'Previous description', 'Previous goal', 'Previously accepted'
    );
  `);

  const result = migrateTaskGoalRemovalV1(db, "2026-09-04T00:00:00.000Z");
  assert.deepEqual(result.droppedColumns, [
    { table: "tasks", column: "goal" },
    { table: "task_snapshots", column: "goal" }
  ]);
  assert.equal(db.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "goal"), false);
  assert.equal(db.prepare("PRAGMA table_info(task_snapshots)").all().some((column) => column.name === "goal"), false);
  assert.deepEqual({ ...db.prepare("SELECT title, description, acceptance_criteria FROM tasks").get() }, {
    title: "Current", description: "Current description", acceptance_criteria: "Accepted"
  });
  assert.deepEqual({ ...db.prepare(
    "SELECT title, description, acceptance_criteria FROM task_snapshots"
  ).get() }, {
    title: "Previous", description: "Previous description", acceptance_criteria: "Previously accepted"
  });
  assert.throws(() => db.prepare("UPDATE task_snapshots SET title='Changed'").run(), /TASK_SNAPSHOT_IMMUTABLE/);
  assert.equal(migrateTaskGoalRemovalV1(db).migrated, false);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  db.close();
});

test("retired Task definition columns are dropped transactionally from current rows and snapshots", async () => {
  const { migrateTaskDefinitionRemovalV1 } = await import("../src/store/taskSchemaMigration.mjs");
  const db = database();
  migrateTaskDomainV1(db);
  // Build the old stored shape, including a historical immutable snapshot.
  db.exec("ALTER TABLE tasks ADD COLUMN verification_criteria TEXT NOT NULL DEFAULT ''");
  for (const field of ["description", "acceptance_criteria", "verification_criteria"]) {
    db.exec(`ALTER TABLE task_snapshots ADD COLUMN ${field} TEXT NOT NULL DEFAULT ''`);
  }
  db.exec(`INSERT INTO task_snapshots(id,task_id,version,title,description,acceptance_criteria,verification_criteria,
    created_by_session_id,content_hash,created_at) VALUES ('snapshot:old','work_item:1',1,'Old title','old scope','old criteria','old checks','session:1','old-hash','2026-09-01')`);
  db.exec("UPDATE tasks SET description='scope',acceptance_criteria='criteria',verification_criteria='checks'");
  const result = migrateTaskDefinitionRemovalV1(db);
  assert.equal(result.droppedColumns.length, 6);
  for (const table of ["tasks", "task_snapshots"]) {
    const columns = db.all(`PRAGMA table_info(${table})`).map(row => row.name);
    for (const field of ["description", "acceptance_criteria", "verification_criteria"]) assert.ok(!columns.includes(field));
  }
  assert.equal(db.get("SELECT title FROM tasks").title, "Legacy");
  assert.equal(db.get("SELECT task_id FROM sessions").task_id, "work_item:1");
  assert.equal(db.get("SELECT content_hash FROM task_snapshots").content_hash, "old-hash");
  assert.throws(() => db.run("UPDATE task_snapshots SET title='changed'"), /TASK_SNAPSHOT_IMMUTABLE/);
  assert.throws(() => db.run("DELETE FROM task_snapshots"), /TASK_SNAPSHOT_IMMUTABLE/);
  assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
  assert.equal(migrateTaskDefinitionRemovalV1(db).migrated, false);
  db.close();
});

test("failed column migration rolls back all drops and its receipt", async () => {
  const { migrateTaskDefinitionRemovalV1 } = await import("../src/store/taskSchemaMigration.mjs");
  const db = database();
  migrateTaskDomainV1(db);
  db.exec("CREATE VIEW retired_task_field AS SELECT acceptance_criteria FROM tasks");
  assert.throws(() => migrateTaskDefinitionRemovalV1(db));
  assert.ok(db.all("PRAGMA table_info(tasks)").some(row => row.name === "description"));
  assert.equal(db.get("SELECT migration_id FROM data_migrations WHERE migration_id='task-definition-fields-removal-v1'"), undefined);
  db.exec("DROP VIEW retired_task_field");
  assert.equal(migrateTaskDefinitionRemovalV1(db).migrated, true);
  db.close();
});

test("upgrade removes retired fields from resumable creation metadata without losing instructions or runtime", async () => {
  const { migrateTaskDefinitionRemovalV1 } = await import("../src/store/taskSchemaMigration.mjs");
  const { createHash } = await import("node:crypto");
  const db = database(); migrateTaskDomainV1(db);
  db.exec("ALTER TABLE tasks ADD COLUMN creation_intent_json TEXT");
  db.exec("ALTER TABLE tasks ADD COLUMN creation_intent_fingerprint TEXT");
  db.exec("CREATE TABLE task_coordination_dispatches(dispatch_id TEXT PRIMARY KEY, request_json TEXT NOT NULL)");
  const intent = {version:1,request:{workId:"work:1",title:"Task",description:"scope",acceptanceCriteria:"criteria",verificationCriteria:"checks",priority:"high",eventId:"user:1"},
    runtime:{providerId:"test",model:"chosen"},startupCommand:{idempotencyKey:"original"}};
  const request = {action:"create",text:"Keep the actual instruction",creation:{title:"Task",description:"scope",acceptanceCriteria:"criteria",verificationCriteria:"checks",agentId:"agent:1"}};
  db.run("UPDATE tasks SET creation_intent_json=?,creation_intent_fingerprint='old'",[JSON.stringify(intent)]);
  db.run("INSERT INTO task_coordination_dispatches VALUES (?,?)",["dispatch:1",JSON.stringify(request)]);
  migrateTaskDefinitionRemovalV1(db);
  const row=db.get("SELECT creation_intent_json,creation_intent_fingerprint FROM tasks");
  const migrated=JSON.parse(row.creation_intent_json);
  assert.deepEqual(migrated.request,{workId:"work:1",title:"Task",priority:"high",eventId:"user:1"});
  assert.deepEqual(migrated.runtime,intent.runtime); assert.deepEqual(migrated.startupCommand,intent.startupCommand);
  assert.equal(row.creation_intent_fingerprint,createHash("sha256").update(JSON.stringify({workId:"work:1",title:"Task",priority:"high"})).digest("hex"));
  assert.deepEqual(JSON.parse(db.get("SELECT request_json FROM task_coordination_dispatches").request_json),{
    action:"create",text:request.text,creation:{title:"Task",agentId:"agent:1"}});
  db.close();
});
