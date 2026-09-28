import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Store compatibility accessors share one live data-location owner", async () => {
  const store = new CorptieStore({ dbPath: "/fixture/data/corptie.sqlite", configPath: "/fixture/data/config.json", manageProcessEnvironment: false });
  await store.resolveDataPath();
  assert.equal(store.dataRoot, "/fixture/data");
  assert.equal(store.dataDir, "/fixture/data");
  assert.equal(store.dataLocation.dbPath, store.dbPath);
  assert.equal(Object.hasOwn(store, "dbPath"), false);
  assert.equal(Object.hasOwn(store.dataLocation, "db"), false);
  store.config = { gateway: { trustedWorkspaces: ["/workspace"] } };
  assert.equal(store.config, store.dataLocation.config);
  assert.deepEqual(store.settings().gateway.trustedWorkspaces, ["/workspace"]);
  store.dataLocation.config = { codeDiff: { tool: "filemerge" } };
  assert.deepEqual(store.codeDiffSettings(), { tool: "filemerge" });
  store.configPath = "/fixture/replaced/config.json";
  assert.equal(store.dataLocation.configPath, store.configPath);
  assert.equal(store.db, null);
});
