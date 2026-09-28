import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("route creation rolls back partial binding activation and permits retry with the same identity", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-route-repository-config", manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    const input = { logicalSessionId: "logical:test", providerThreadId: "thread:test",
      bindingId: "binding:test", providerSessionId: "thread:test", providerId: "provider:test",
      boundCwd: "/repo", sessionName: "Route Test" };
    const revision = store.stateRevision();
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const run = store.db.run;
    const failure = new Error("injected route activation failure");
    store.db.run = function (sql, ...args) {
      if (sql.includes("UPDATE logical_sessions SET active_thread_id")) throw failure;
      return run.call(this, sql, ...args);
    };
    try {
      assert.throws(() => store.createLogicalSessionRoute(input), error => error === failure);
    } finally {
      store.db.run = run;
    }
    assert.equal(store.getLogicalSession(input.logicalSessionId), null);
    assert.equal(store.getProviderThreadBinding(input.providerThreadId), null);
    assert.equal(store.getAgentSessionBinding(input.bindingId), null);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    const route = store.createLogicalSessionRoute(input);
    assert.equal(route.activeBinding.bindingId, input.bindingId);
    assert.equal(store.assertLogicalSessionRoute(input.logicalSessionId), true);
    assert.equal(notifications, 1);
    assert.deepEqual(store.getLogicalSessionByProviderSessionId(input.providerId, input.providerSessionId), route);
    assert.deepEqual(store.listActiveProviderSessionIds(input.providerId), [input.providerSessionId]);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
