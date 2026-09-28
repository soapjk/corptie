import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("migration composition stops at a failed step and retries without schema or receipt drift", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-migration-coordinator", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    const schema = () => store.selectAll("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name");
    const receipts = () => store.selectAll("SELECT * FROM data_migrations ORDER BY migration_id");
    const beforeSchema = schema();
    const beforeReceipts = receipts();
    const migrateMemories = store.migrateTaskMemoryAssociations;
    const sort = store.initializeSortOrder;
    const failure = new Error("injected migration step failure");
    const steps = [];
    store.migrateTaskMemoryAssociations = () => { steps.push("memory"); throw failure; };
    store.initializeSortOrder = () => { steps.push("sort"); return sort.call(store); };
    try {
      assert.throws(() => store.migrate(), error => error === failure);
      assert.deepEqual(steps, ["memory"]);
      store.migrateTaskMemoryAssociations = () => { steps.push("memory"); return migrateMemories.call(store); };
      store.migrate();
      assert.deepEqual(steps, ["memory", "memory", "sort"]);
      assert.deepEqual(schema(), beforeSchema);
      assert.deepEqual(receipts(), beforeReceipts);
      assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
    } finally {
      store.migrateTaskMemoryAssociations = migrateMemories;
      store.initializeSortOrder = sort;
    }
  } finally {
    await store.close();
  }
});
