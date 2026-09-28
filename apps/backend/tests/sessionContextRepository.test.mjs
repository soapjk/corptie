import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("context reference mutations share the Store transaction and preserve explicit snapshot clearing", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-context-config", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    store.createSession({ id: "session:test", title: "Context", sessionKind: "assistantChat", status: "complete" });
    const input = { referenceId: "reference:test", ownerSessionId: "session:test",
      targetType: "localFile", targetKey: "file:/repo/reference.txt", locator: "/repo/reference.txt",
      displayName: "Reference", snapshotText: "original", metadata: { version: 1 } };
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const failure = new Error("rollback context reference");
    assert.throws(() => store.runInTransaction(() => {
      store.createSessionContextReference(input);
      store.updateSessionContextReference(input.referenceId, { enabled: false });
      throw failure;
    }), error => error === failure);
    assert.equal(store.getSessionContextReference(input.referenceId), null);
    assert.equal(notifications, 0);
    const created = store.createSessionContextReference(input);
    assert.throws(() => store.runInTransaction(() => {
      store.deleteSessionContextReference(input.referenceId);
      throw failure;
    }), error => error === failure);
    assert.deepEqual(store.getSessionContextReference(input.referenceId), created);
    const updated = store.updateSessionContextReference(input.referenceId, { snapshotText: null, metadata: null, enabled: false });
    assert.equal(updated.snapshotText, null);
    assert.deepEqual(updated.metadata, {});
    assert.equal(updated.enabled, false);
    assert.deepEqual(store.listSessionContextReferences(input.ownerSessionId), [updated]);
    assert.equal(store.deleteSessionContextReference(input.referenceId), true);
    assert.equal(store.deleteSessionContextReference(input.referenceId), false);
  } finally {
    await store.close();
  }
});
