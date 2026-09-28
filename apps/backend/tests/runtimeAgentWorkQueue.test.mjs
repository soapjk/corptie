import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeAgentWorkQueue } from "../src/runtime/runtimeAgentWorkQueue.mjs";

function fixture(overrides = {}) {
  const tasks = new Map();
  const events = [];
  const sends = [];
  const syncs = [];
  const settled = [];
  const scheduled = [];
  const reads = [];
  const store = {
    listQueuedAgentTasksForSession(sessionId, limit) {
      reads.push({ sessionId, limit });
      return [...tasks.values()].filter(row => row.sessionId === sessionId && row.status === "queued").slice(0, limit);
    },
    getAgentTask: id => tasks.get(id),
    getRunningAgentTaskForSession: id => [...tasks.values()].find(row => row.sessionId === id && row.status === "running"),
    getSession: id => ({ id, status: "idle" }),
    getLogicalSessionByLegacySessionId: () => null,
    updateAgentTask(id, patch) {
      const updated = { ...tasks.get(id), ...patch };
      tasks.set(id, updated);
      return updated;
    },
    claimAgentTask(id) {
      if (tasks.get(id)?.status !== "queued") return null;
      return this.updateAgentTask(id, { status: "running" });
    }
  };
  const deps = {
    store,
    collaborationCore: { getAgentForSession: () => ({ agentId: "agent" }), getDeliveryEnvelope: () => null },
    sessionChannelService: { getDeliveryEnvelope: () => null },
    collaborationDispatcher: {},
    workspaceContinuationCoordinator: {
      assertWorkTarget() {},
      recordWorkStarted: work => settled.push(["started", work]),
      recordWorkSettled: work => settled.push(["settled", work]),
      recordWorkRequeued: work => settled.push(["requeued", work])
    },
    inspectCollaborationSession: async () => "idle",
    resolveCollaborationDeliveryRoute: async () => { throw new Error("unexpected route resolution"); },
    scheduleAgentWorkDrain: (...args) => scheduled.push(args),
    dispatchSessionChannelDelivery: async () => { throw new Error("unexpected channel dispatch"); },
    sendUnifiedSessionMessage: async (...args) => {
      sends.push(args);
      return { result: { turn: { id: "turn" } } };
    },
    emitEvent: (...args) => events.push(args),
    syncSessionChannelDeliveriesIntoAgentWorkQueue: async () => syncs.push("channel"),
    syncCollaborationDeliveriesIntoAgentWorkQueue: async () => syncs.push("collaboration"),
    ...overrides
  };
  const queue = createRuntimeAgentWorkQueue(deps);
  function add(id, patch = {}, admitted = true) {
    const task = { taskId: id, sessionId: "session", agentId: "agent", kind: "user", text: id, source: {}, status: "queued", ...patch };
    tasks.set(id, task);
    if (admitted) queue.registerRuntimeQueuedWork(task.sessionId, id);
    return task;
  }
  return { queue, add, tasks, events, sends, syncs, settled, scheduled, reads, deps };
}

test("durable rows do not reconstruct runtime membership and queue reads remain bounded", async () => {
  const f = fixture();
  f.add("old", {}, false);
  await f.queue.tickAgentWorkQueue();
  assert.deepEqual(f.syncs, ["channel", "collaboration"]);
  assert.equal(f.reads.length, 0);
  assert.equal(f.sends.length, 0);
  f.tasks.delete("old");
  f.add("first");
  f.add("second");
  f.queue.registerRuntimeQueuedWork("session", "first");
  assert.equal(f.queue.runtimeQueuePosition("session", "first"), 1);
  assert.equal(f.queue.runtimeQueuePosition("session", "second"), 2);
  assert.equal(f.queue.runtimeQueuePosition("session", "missing"), 0);
  assert.deepEqual(f.reads[0], { sessionId: "session", limit: 2 });
  await f.queue.drainAgentWork("session");
  assert.equal(f.sends.length, 1);
  assert.equal(f.tasks.get("first").targetTurnId, "turn");
  assert.equal(f.queue.runtimeQueuePosition("session", "first"), 0);
  assert.equal(f.queue.runtimeQueuePosition("session", "second"), 1);
});

test("membership moves to the new Session and stale members are removed", async () => {
  const f = fixture();
  f.add("work");
  f.tasks.set("work", { ...f.tasks.get("work"), sessionId: "replacement" });
  f.queue.moveRuntimeQueuedWork("session", "replacement", "work");
  assert.equal(f.queue.runtimeQueuePosition("session", "work"), 0);
  assert.equal(f.queue.runtimeQueuePosition("replacement", "work"), 1);
  f.tasks.delete("work");
  await f.queue.tickAgentWorkQueue();
  const reads = f.reads.length;
  await f.queue.tickAgentWorkQueue();
  assert.equal(f.reads.length, reads, "empty Session membership is released");
  assert.equal(f.sends.length, 0);
});

test("same Session cannot drain concurrently while another Session may progress", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const f = fixture({
    sendUnifiedSessionMessage: async sessionId => {
      calls.push(sessionId);
      if (sessionId === "session") await gate;
      return { result: { turnId: sessionId } };
    }
  });
  f.add("first");
  f.add("second", { sessionId: "other" });
  const pending = f.queue.drainAgentWork("session");
  await f.queue.drainAgentWork("session");
  await f.queue.drainAgentWork("other");
  assert.deepEqual(calls, ["session", "other"]);
  release();
  await pending;
  assert.equal(f.tasks.get("first").targetTurnId, "session");
  assert.equal(f.tasks.get("second").targetTurnId, "other");
});

test("pre-delivery failures retry three times, then fail and release the drain lock", async () => {
  const error = Object.assign(new Error("busy"), { code: "SESSION_BUSY" });
  const f = fixture({ sendUnifiedSessionMessage: async () => { throw error; } });
  f.add("work");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await f.queue.drainAgentWork("session");
    assert.equal(f.tasks.get("work").status, "queued");
    assert.equal(f.queue.runtimeQueuePosition("session", "work"), 1);
  }
  await assert.rejects(f.queue.drainAgentWork("session"), err => err === error);
  assert.equal(f.tasks.get("work").status, "failed");
  assert.equal(f.events.filter(([type]) => type === "AgentWorkFailed").length, 1);
  f.add("after-failure");
  await f.queue.drainAgentWork("session");
  assert.equal(f.tasks.get("after-failure").status, "queued", "failure did not retain the Session lock");
});

test("already dispatched work is not retried and runtime instances do not share membership", async () => {
  const f = fixture({
    sendUnifiedSessionMessage: async () => { throw Object.assign(new Error("busy"), { code: "SESSION_BUSY" }); }
  });
  f.add("work", { targetTurnId: "existing-turn" });
  const other = createRuntimeAgentWorkQueue(f.deps);
  await other.tickAgentWorkQueue();
  assert.equal(f.tasks.get("work").status, "queued");
  await assert.rejects(f.queue.drainAgentWork("session"), /busy/);
  assert.equal(f.tasks.get("work").status, "failed");
  assert.equal(f.queue.runtimeQueuePosition("session", "work"), 0);
});

test("orphaned dispatched work is cancelled without resending", async () => {
  const f = fixture();
  f.add("work", { status: "running", targetTurnId: "existing-turn" }, false);
  await f.queue.drainAgentWork("session");
  assert.equal(f.tasks.get("work").status, "cancelled");
  assert.equal(f.sends.length, 0);
  assert.equal(f.events[0][0], "AgentWorkCompleted");
  assert.equal(f.settled[0][0], "settled");
});

test("channel preflight migrates queue membership before dispatch", async () => {
  const f = fixture({
    sessionChannelService: {
      getDeliveryEnvelope: () => ({ message: {} }),
      resolveDeliveryRoute: () => ({ providerSessionId: "replacement", sessionId: "logical" })
    }
  });
  f.add("work", { kind: "collaboration", deliveryId: "delivery", source: { type: "session_channel" } });
  await f.queue.drainAgentWork("session");
  assert.equal(f.tasks.get("work").sessionId, "replacement");
  assert.equal(f.tasks.get("work").source.recipientSessionId, "logical");
  assert.equal(f.queue.runtimeQueuePosition("session", "work"), 0);
  assert.equal(f.queue.runtimeQueuePosition("replacement", "work"), 1);
  assert.deepEqual(f.scheduled, [["replacement", null, "work"]]);
  assert.equal(f.sends.length, 0);
});

test("missing channel envelopes fail closed and emit a terminal work event", async () => {
  const f = fixture();
  f.add("work", { kind: "collaboration", deliveryId: "delivery", source: { type: "session_channel" } });
  await f.queue.drainAgentWork("session");
  assert.equal(f.tasks.get("work").status, "failed");
  assert.match(f.tasks.get("work").lastError, /no longer has an envelope/);
  assert.equal(f.events[0][0], "AgentWorkFailed");
  assert.equal(f.queue.runtimeQueuePosition("session", "work"), 0);
});

test("verified channel dispatch writes the returned turn and publishes work started", async () => {
  const f = fixture({
    sessionChannelService: {
      getDeliveryEnvelope: () => ({ message: {} }),
      resolveDeliveryRoute: () => ({ providerSessionId: "session", sessionId: "logical" })
    },
    dispatchSessionChannelDelivery: async () => ({ status: "delivered", targetTurnId: "channel-turn" })
  });
  f.add("work", { kind: "collaboration", deliveryId: "delivery", source: { type: "session_channel" } });
  await f.queue.drainAgentWork("session");
  assert.equal(f.tasks.get("work").targetTurnId, "channel-turn");
  assert.equal(f.tasks.get("work").status, "running");
  assert.equal(f.events[0][0], "AgentWorkStarted");
  assert.equal(f.settled[0][0], "started");
  assert.equal(f.sends.length, 0);
});
