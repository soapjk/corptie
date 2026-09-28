import assert from "node:assert/strict";
import test from "node:test";
import { createProviderEventPublisher } from "../src/application/providerEventPublisher.mjs";

function fixture() {
  const calls = [];
  const frames = [];
  const publisher = createProviderEventPublisher({
    store: {
      markEventOutboxPublished: (id) => calls.push(["published", id]),
      getSessionUsageSnapshot: () => ({ context: { tokens: 12 } })
    },
    eventLog: { append: (event) => { calls.push(["event", event]); return { id: calls.length, ...event }; } },
    sseClients: new Set([{ write: (frame) => frames.push(frame) }]),
    now: () => "2026-01-01T00:00:00Z",
    resolveProviderEventBinding: () => ({ sessionId: "session" }),
    scheduleTimelineChangePublish: (value) => calls.push(["timeline", value]),
    scheduleStateSyncPublish: () => calls.push(["state"]),
    scheduleAgentWorkDrain: (id) => calls.push(["drain", id]),
    onCommittedMessageDelivery: (value) => calls.push(["delivery", value]),
    publishDeviceTimeline: (id) => calls.push(["device", id])
  });
  const row = (topic, payload = {}, event_type = "") => ({
    topic, outbox_id: topic, payload_json: JSON.stringify(payload), event_type
  });
  return { publisher, calls, frames, row };
}

test("each outbox topic publishes its effects before acknowledging its row", () => {
  const f = fixture();
  f.publisher.publishProviderEventOutbox([
    f.row("timeline", { sessionId: "session" }),
    f.row("state"),
    f.row("provider-commands", { sessionId: "session" }, "MessageDeliveryQueued")
  ]);
  assert.deepEqual(f.calls.map(([name]) => name), [
    "timeline", "published", "state", "published", "delivery", "drain", "published"
  ]);
});

test("a malformed outbox row remains unpublished without blocking subsequent rows", () => {
  const f = fixture();
  f.publisher.publishProviderEventOutbox([
    { topic: "state", outbox_id: "bad", payload_json: "invalid json" },
    f.row("state")
  ]);
  assert.deepEqual(f.calls, [["state"], ["published", "state"]]);
});

test("usage wake publishes persisted context and notifies durable session listeners", () => {
  const f = fixture();
  const received = [];
  const stop = f.publisher.addSessionEventListener((event) => received.push(event));
  const sessionEvent = { sessionId: "session", type: "usage" };
  f.publisher.publishProviderEventOutbox([f.row("provider-events", {
    event: { type: "usage.updated", providerId: "test-provider", bindingId: "binding" },
    sessionEvent
  })]);
  assert.deepEqual(f.calls.filter(([name]) => name === "event").map(([, event]) => event.type), [
    "ProviderEventCommitted", "SessionUsageUpdated"
  ]);
  assert.equal(f.frames.length, 2);
  assert.deepEqual(received, [sessionEvent]);
  assert.deepEqual(f.calls.at(-1), ["published", "provider-events"]);
  stop();
  f.publisher.notifySessionEventListeners(sessionEvent);
  assert.equal(received.length, 1);
});

test("one failing listener does not prevent subsequent listeners", () => {
  const f = fixture();
  const received = [];
  f.publisher.addSessionEventListener(() => { throw new Error("listener failed"); });
  f.publisher.addSessionEventListener((event) => received.push(event));
  const event = { sessionId: "session", type: "completed" };
  f.publisher.notifySessionEventListeners(event);
  assert.deepEqual(received, [event]);
});
