import assert from "node:assert/strict";
import test from "node:test";
import { createProductEventPublisher } from "../src/application/productEventPublisher.mjs";

function fixture() {
  const calls = [], deferred = [], seen = new Set();
  const store = {
    db: {},
    getSession: (id) => id === "session:1" ? { id } : null,
    hasSessionEvent: (id) => seen.has(id),
    runInTransaction: (operation) => {
      calls.push(["begin"]);
      operation();
      calls.push(["commit"]);
    },
    appendSessionEvent: (event) => {
      calls.push(["event", event]);
      seen.add(event.eventId);
      return event;
    },
    upsertTimelineItemProjection: (...args) => calls.push(["timeline", ...args]),
    enqueueEventOutbox: (event) => {
      calls.push(["outbox", event]);
      return { outbox_id: event.outboxId };
    },
    markEventOutboxPublished: (...args) => calls.push(["published", ...args])
  };
  const sseClients = new Set([{ write: (frame) => calls.push(["sse", frame]) }]);
  const options = {
    store, sseClients, now: () => "2026-09-27T00:00:00Z",
    eventLog: { append: (event) => { calls.push(["replay", event]); return { id: 1, ...event }; } },
    getClientDeviceGateway: () => null,
    scheduleStateSyncPublish: () => calls.push(["sync"]),
    requestTaskSummary: (id) => calls.push(["summary", id]),
    notifySessionEventListeners: (event) => calls.push(["listener", event]),
    publishDshSessionEvent: (event) => calls.push(["dsh", event]),
    handleScheduledWorkEvent: () => calls.push(["scheduled"]),
    reconcileCompletedCollaborationWork: () => calls.push(["collaboration"]),
    reconcileConflictResolutionSession: (id) => calls.push(["conflict", id]),
    agentWorkTimelineItem: () => null,
    collaborationConfirmationTimelineItem: () => null,
    sessionChannelAuthorizationTimelineItem: () => null,
    sessionChannelMessageTimelineItem: () => null,
    logger: {
      warn: (message) => calls.push(["warning", message]),
      error: (message) => calls.push(["error", message])
    },
    defer: (operation) => deferred.push(operation)
  };
  return { store, options, calls, deferred, sseClients };
}

test("product events commit timeline and outbox before SSE and downstream listeners", () => {
  const f = fixture();
  const publisher = createProductEventPublisher(f.options);
  const item = { id: "item:1", type: "agentMessage", text: "done" };
  publisher.emitEvent("SessionCommandCompleted", { item }, {
    sessionId: "session:1", eventId: "event:1"
  });
  assert.deepEqual(f.calls.map(([kind]) => kind), [
    "begin", "event", "timeline", "outbox", "commit",
    "replay", "sse", "published", "sync", "listener", "dsh"
  ]);
  assert.equal(f.calls[2][1], "session:1");
  assert.equal(f.calls[2][2].rawMetadataJSON, JSON.stringify(item));
  const count = f.calls.length;
  assert.equal(publisher.emitEvent("SessionCommandCompleted", { item }, {
    sessionId: "session:1", eventId: "event:1"
  }), null);
  assert.equal(f.calls.length, count);
});

test("a failed persistence transaction never enters replay or client publication", () => {
  const f = fixture();
  f.store.enqueueEventOutbox = () => { throw new Error("storage unavailable"); };
  const publisher = createProductEventPublisher(f.options);
  assert.throws(() => publisher.emitEvent("SessionCommandCompleted", {}, {
    sessionId: "session:1", eventId: "event:1"
  }), /storage unavailable/);
  assert.equal(f.calls.some(([kind]) => ["replay", "sse", "sync", "listener"].includes(kind)), false);
});

test("detached deletion broadcasts without attaching a deleted Session foreign key", () => {
  const f = fixture();
  createProductEventPublisher(f.options).emitEvent("SessionDeleted", { sessionId: "gone" }, {
    detachedSession: true, eventId: "deletion:1"
  });
  assert.equal(f.calls.some(([kind]) => kind === "event"), false);
  assert.equal(f.calls.find(([kind]) => kind === "outbox")[1].sessionId, null);
  assert.equal(f.calls.filter(([kind]) => kind === "sse").length, 1);
});

test("client and work reconciliation failures do not suppress other subscribers or deferred completion", () => {
  const f = fixture();
  f.sseClients.add({ write: () => { throw new Error("disconnected"); } });
  f.options.handleScheduledWorkEvent = () => { throw new Error("scheduled failure"); };
  f.options.reconcileCompletedCollaborationWork = () => { throw new Error("collaboration failure"); };
  createProductEventPublisher(f.options).emitEvent("AgentWorkCompleted", {
    task: { kind: "collaboration", taskId: "work:1" }
  }, { sessionId: "session:1", eventId: "event:1" });
  assert.equal(f.calls.filter(([kind]) => kind === "warning").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "error").length, 2);
  assert.equal(f.calls.filter(([kind]) => kind === "listener").length, 1);
  assert.equal(f.deferred.length, 1);
  f.deferred[0]();
  assert.deepEqual(f.calls.at(-1), ["conflict", "session:1"]);
});
