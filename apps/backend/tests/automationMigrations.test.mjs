import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { migrateAutomationCompletedStatusV1 } from "../src/store/migrations/automationMigrations.mjs";

test("completed-status migration rolls back a failed copy and can be retried", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-automation-migration-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    const tableSQL = () => store.selectOne(
      "SELECT sql FROM sqlite_master WHERE name = 'scheduled_session_tasks'"
    ).sql;
    const oldSchema = tableSQL().replace("'cancelled', 'completed', 'expired'", "'cancelled', 'expired'");
    assert.notEqual(oldSchema, tableSQL());
    store.db.run("PRAGMA foreign_keys = OFF");
    store.db.run("DROP TABLE scheduled_session_tasks");
    store.db.run(oldSchema);
    store.db.run("PRAGMA foreign_keys = ON");
    store.db.run(`INSERT INTO scheduled_session_tasks (
      task_id, logical_session_id, message_json, schedule_type, timezone,
      creator_type, creator_id, environment, created_at, updated_at, expires_at
    ) VALUES ('migration:test', 'logical:test', '{}', 'once', 'UTC',
      'session', 'logical:test', 'development',
      '2026-01-01', '2026-01-01', '2027-01-01')`);
    const before = store.selectAll("SELECT * FROM scheduled_session_tasks");
    const run = store.db.run.bind(store.db);
    const failure = new Error("injected copy failure");
    const context = {
      db: { run(sql, params) {
        if (sql.includes("INSERT INTO scheduled_session_tasks_completed_v1")) throw failure;
        return run(sql, params);
      } },
      selectOne: store.selectOne.bind(store)
    };
    assert.throws(() => migrateAutomationCompletedStatusV1(context), error => error === failure);
    assert.equal(tableSQL(), oldSchema);
    assert.deepEqual(store.selectAll("SELECT * FROM scheduled_session_tasks"), before);
    assert.equal(store.selectOne("PRAGMA foreign_keys").foreign_keys, 1);
    assert.equal(store.selectOne(
      "SELECT name FROM sqlite_master WHERE name = 'scheduled_session_tasks_completed_v1'"
    ), null);
    migrateAutomationCompletedStatusV1({ ...context, db: store.db });
    assert.deepEqual(store.selectAll("SELECT * FROM scheduled_session_tasks"), before);
    store.db.run("UPDATE scheduled_session_tasks SET status = 'completed'");
    const upgraded = tableSQL();
    migrateAutomationCompletedStatusV1({ ...context, db: store.db });
    assert.equal(tableSQL(), upgraded);
    assert.equal(store.selectOne("PRAGMA foreign_keys").foreign_keys, 1);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
