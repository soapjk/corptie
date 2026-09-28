import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("startup repair rolls back partial failure and a successful retry is idempotent", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-startup-repair-config", manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    store.createAgent({ id: "agent:test", name: "Test", role: "independentContributor" });
    store.upsertSession({ id: "session:test", title: "Test", agent: "Test",
      agentId: "agent:test", provider: "provider:test", status: "running" });
    const binding = { bindingId: "binding:test", providerId: "provider:test",
      providerSessionId: "thread:test", routingVersion: 1 };
    store.createUserMessageDelivery({ deliveryId: "delivery:test", messageId: "message:test",
      sessionId: "session:test", agentId: "agent:test", binding, text: "preserve until commit" });
    store.upsertSessionTurn({ sessionId: "session:test", bindingId: binding.bindingId,
      routingVersion: 1, turnId: "turn:test", executionStatus: "running" });
    const tables = ["agent_operations", "message_deliveries", "session_items", "session_turns", "sessions"];
    const snapshot = () => tables.map(table => store.selectAll(`SELECT * FROM ${table}`));
    const before = snapshot();
    const revision = store.stateRevision();
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const original = store.db.run;
    const failure = new Error("injected turn repair failure");
    store.db.run = function (sql, ...args) {
      if (/UPDATE session_turns/.test(sql)) throw failure;
      return original.call(this, sql, ...args);
    };
    try {
      assert.throws(() => store.reconcileInterruptedSessionExecutionAtStartup(), error => error === failure);
    } finally {
      store.db.run = original;
    }
    assert.deepEqual(snapshot(), before);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    assert.deepEqual(store.reconcileInterruptedSessionExecutionAtStartup(), {
      tasks: 1, deliveries: 1, collaborationDeliveries: 0, sessionCollaborationDeliveries: 0, turns: 1
    });
    assert.equal(notifications, 1);
    const repaired = snapshot();
    const repairedRevision = store.stateRevision();
    assert.deepEqual(store.reconcileInterruptedSessionExecutionAtStartup(), {
      tasks: 0, deliveries: 0, collaborationDeliveries: 0, sessionCollaborationDeliveries: 0, turns: 0
    });
    assert.deepEqual(snapshot(), repaired);
    assert.equal(store.stateRevision(), repairedRevision);
    assert.equal(notifications, 1);
  } finally {
    await store.close();
  }
});
