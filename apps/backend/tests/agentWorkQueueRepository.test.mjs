import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";

test("queue repository preserves idempotent enqueue and caller-owned claim rollback", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-queue-repository-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    const core = new CollaborationCore(store);
    core.registerAgent({ agentId: "agent:queue", name: "Queue" });
    core.bindSession({ agentId: "agent:queue", sessionId: "session:queue" });
    const item = {
      taskId: "operation:test", agentId: "agent:queue", sessionId: "session:queue",
      kind: "user", priority: 10, text: "test", source: { type: "user" }
    };
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    assert.equal(store.enqueueAgentTaskWithResult(item).inserted, true);
    assert.equal(notifications, 1);
    assert.equal(store.enqueueAgentTaskWithResult(item).inserted, false);
    assert.equal(notifications, 1);
    const failure = new Error("claim rollback");
    assert.throws(() => store.runInTransaction(() => {
      assert.equal(store.claimAgentTask(item.taskId).status, "running");
      assert.equal(store.claimRunningAgentTaskForProviderTurn(item.sessionId, "turn:test").targetTurnId, "turn:test");
      assert.equal(notifications, 1);
      throw failure;
    }), error => error === failure);
    assert.equal(store.getAgentTask(item.taskId).status, "queued");
    assert.equal(store.getAgentTaskForTurn(item.sessionId, "turn:test"), null);
    assert.equal(notifications, 1);
    store.runInTransaction(() => {
      store.claimAgentTask(item.taskId);
      store.claimRunningAgentTaskForProviderTurn(item.sessionId, "turn:test");
    });
    assert.equal(notifications, 2);
    assert.equal(store.getAgentTaskForTurn(item.sessionId, "turn:test").taskId, item.taskId);
  } finally {
    await store.close();
  }
});
