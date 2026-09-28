import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Session grants and runtime values follow the owning Store transaction", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-capability-config", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    store.createSession({ id: "session:grantee", title: "Grantee", provider: "test" });
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const failure = new Error("rollback grants and runtime state");
    assert.throws(() => store.runInTransaction(() => {
      store.grantSessionCapability("session:grantee", " platform.manage ");
      store.setRuntimeState("test:key", { enabled: true });
      assert.equal(store.sessionHasCapability("session:grantee", "platform.manage"), true);
      assert.equal(notifications, 0);
      throw failure;
    }), error => error === failure);
    assert.deepEqual(store.listSessionCapabilities("session:grantee"), []);
    assert.equal(store.getRuntimeState("test:key"), null);
    assert.equal(notifications, 0);
    store.grantSessionCapability("session:grantee", "platform.manage");
    assert.equal(store.sessionHasCapability("session:grantee", "platform.manage"), true);
    store.revokeSessionCapability("session:grantee", "platform.manage");
    assert.equal(store.sessionHasCapability("session:grantee", "platform.manage"), false);
    store.grantSessionCapability("session:grantee", "platform.manage");
    assert.deepEqual(store.listSessionCapabilities("session:grantee"), ["platform.manage"]);
    assert.throws(() => store.grantSessionCapability("missing", "platform.manage"), /Session not found/);
    assert.throws(() => store.grantSessionCapability("session:grantee", " "), TypeError);
    const savedNotifications = notifications;
    store.setRuntimeState("test:key", { enabled: true });
    assert.deepEqual(store.getRuntimeState("test:key"), { enabled: true });
    store.setRuntimeState("test:key", undefined);
    assert.equal(store.getRuntimeState("test:key"), null);
    assert.equal(notifications, savedNotifications);
  } finally {
    await store.close();
  }
});
