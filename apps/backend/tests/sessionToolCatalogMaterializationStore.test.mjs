import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-tool-store-"));
  const dbPath = join(directory, "db.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  await store.initialize();
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:one", providerThreadId: "thread:one", providerSessionId: "thread:one",
    bindingId: "binding:one", providerId: "fake", boundCwd: directory, sessionName: "Tool Store One"
  });
  return { directory, dbPath, store };
}

test("Store has one authoritative table and CAS prevents false applied state", async () => {
  const value = await fixture();
  try {
    const tables = value.store.selectAll(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%tool%materialization%' ORDER BY name", []
    ).map((row) => row.name);
    assert.deepEqual(tables, ["session_tool_catalog_materializations"]);
    const desired = value.store.writeSessionToolCatalogDesired({
      logicalSessionId: "logical:one", providerBindingId: "binding:one",
      desiredVersion: "desired:1", desiredCatalogVersion: "th2:one",
      desiredDomains: [{ domainId: "artifacts" }], exposurePlan: { exposurePlanHash: "plan:one" }
    });
    assert.equal(desired.status, "stale");
    const refreshing = value.store.beginSessionToolCatalogRefresh(
      "logical:one", "binding:one", desired.resourceVersion
    );
    assert.equal(refreshing.status, "refreshing");
    assert.equal(value.store.applySessionToolCatalogReceipt({
      logicalSessionId: "logical:one", providerBindingId: "binding:one",
      appliedVersion: "wrong", appliedCatalogVersion: "th2:one",
      appliedDomains: [], providerReceipt: {}, appliedAt: new Date().toISOString()
    }, refreshing.resourceVersion), null);
    const applied = value.store.applySessionToolCatalogReceipt({
      logicalSessionId: "logical:one", providerBindingId: "binding:one",
      appliedVersion: "desired:1", appliedCatalogVersion: "th2:one",
      appliedDomains: [{ domainId: "artifacts" }], providerReceipt: { receiptId: "receipt:one" }
    }, refreshing.resourceVersion);
    assert.equal(applied.status, "applied");
    assert.equal(applied.appliedVersion, applied.desiredVersion);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Store state survives restart and old binding can be canceled", async () => {
  const value = await fixture();
  value.store.writeSessionToolCatalogDesired({
    logicalSessionId: "logical:one", providerBindingId: "binding:one",
    desiredVersion: "desired:1", desiredCatalogVersion: "th2:one",
    desiredDomains: [], exposurePlan: {}
  });
  value.store.close();
  const reopened = new CorptieStore({ dbPath: value.dbPath, configPath: join(value.directory, "config.json") });
  try {
    await reopened.initialize();
    assert.equal(reopened.getSessionToolCatalogMaterialization("logical:one", "binding:one").status, "stale");
    assert.equal(reopened.cancelSessionToolCatalogMaterialization("logical:one", "binding:one").status, "canceled");
  } finally {
    reopened.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
