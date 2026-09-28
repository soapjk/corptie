import test from "node:test";
import assert from "node:assert/strict";
import { migrateCollaborationProtocol } from "../src/collaboration/collaborationProtocolMigrations.mjs";

test("protocol migration is deferred until the Store is open", () => {
  assert.deepEqual(migrateCollaborationProtocol({ store: {} }), {
    status: "deferred", migrationId: "collaboration-session-actors-v3", migratedTaskCount: 0
  });
});

test("empty migrations retain version order, transactions and idempotent receipts", () => {
  const receipts = new Set();
  const events = [];
  let changes = 0;
  const store = {
    db: {
      run: (sql, args) => {
        assert.ok(sql.startsWith("INSERT"));
        changes = receipts.has(args[0]) ? 0 : 1;
        receipts.add(args[0]);
        events.push(args[0]);
      },
      getRowsModified: () => changes
    },
    selectOne: (_sql, [id]) => receipts.has(id) ? { migration_id: id } : null,
    selectAll: () => [],
    runInTransaction: (run) => { events.push("transaction"); return run(); },
    scheduleSave: () => events.push("save")
  };
  const dependencies = { store, clock: () => "now" };
  assert.equal(migrateCollaborationProtocol(dependencies).migrationId, "collaboration-work-task-v2");
  assert.deepEqual(events, [
    "transaction", "collaboration-work-task-v2", "save",
    "transaction", "collaboration-session-actors-v3", "save",
    "collaboration-session-channels-v1", "save"
  ]);
  events.length = 0;
  assert.equal(migrateCollaborationProtocol(dependencies).status, "already-applied");
  assert.deepEqual(events, ["collaboration-session-channels-v1"]);
});
