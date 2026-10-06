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

test("only a queued user message in its own Session can be cancelled", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-queue-cancel-config", manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    const core = new CollaborationCore(store);
    core.registerAgent({ agentId: "agent:cancel", name: "Cancel" });
    core.bindSession({ agentId: "agent:cancel", sessionId: "session:cancel" });
    const item = { taskId: "operation:cancel", agentId: "agent:cancel", sessionId: "session:cancel",
      kind: "user", priority: 10, text: "queued", source: { type: "desktop" } };
    store.enqueueAgentTask(item);
    assert.equal(store.cancelQueuedUserAgentTask("session:other", item.taskId), null);
    assert.equal(store.cancelQueuedUserAgentTask(item.sessionId, item.taskId)?.status, "cancelled");
    assert.equal(store.cancelQueuedUserAgentTask(item.sessionId, item.taskId), null);
    assert.equal(store.claimAgentTask(item.taskId), null);
    store.enqueueAgentTask({ ...item, taskId: "operation:running" });
    assert.equal(store.claimAgentTask("operation:running")?.status, "running");
    assert.equal(store.cancelQueuedUserAgentTask(item.sessionId, "operation:running"), null);
    assert.equal(store.getAgentTask("operation:running").status, "running");
    store.enqueueAgentTask({ ...item, taskId: "operation:collaboration", kind: "collaboration" });
    assert.equal(store.cancelQueuedUserAgentTask(item.sessionId, "operation:collaboration"), null);
  } finally {
    await store.close();
  }
});
