import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { migrateStoreOffMainThread, optimizeStoreOffMainThread } from "../src/store/storeMigrationRunner.mjs";

test("Store migration Worker prepares a database that the main connection opens without migrating", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "corptie-store-worker-"));
  const dbPath = join(root, "database", "corptie.sqlite");
  const configPath = join(root, "config", "config.json");
  try {
    await migrateStoreOffMainThread({ dbPath, configPath, dataRoot: root });

    const store = new CorptieStore({ dbPath, configPath, dataRoot: root });
    await store.initialize({ performMigrations: false });
    assert.equal(
      store.selectOne("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='sessions'").count,
      1
    );
    await store.close();
    await optimizeStoreOffMainThread({ dbPath, configPath, dataRoot: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
