import assert from "node:assert/strict";
import test from "node:test";
import { SessionTimelineProjection } from "../src/application/sessionTimelineProjection.mjs";

test("Provider item lifecycle eagerly materializes the changed normalized item", () => {
  const writes = [];
  const projection = new SessionTimelineProjection({
    store: { upsertItemSnapshot: (sessionId, item) => writes.push({ sessionId, item }) }
  });
  const liveItems = [
    { id: "user:1", type: "userMessage", text: "run in background" },
    { id: "agent:1", type: "agentMessage", text: "finished" }
  ];

  assert.equal(projection.persistChangedItem({
    sessionId: "session:stable",
    eventName: "item/completed",
    itemId: "agent:1",
    liveItems
  }), true);
  assert.deepEqual(writes, [{
    sessionId: "session:stable",
    item: liveItems[1]
  }]);
});

test("unrelated events and non-visible Provider items do not create timeline revisions", () => {
  const writes = [];
  const projection = new SessionTimelineProjection({
    store: { upsertItemSnapshot: (...args) => writes.push(args) }
  });

  assert.equal(projection.persistChangedItem({
    sessionId: "session:stable",
    eventName: "turn/completed",
    itemId: "agent:1",
    liveItems: [{ id: "agent:1", type: "agentMessage", text: "done" }]
  }), false);
  assert.equal(projection.persistChangedItem({
    sessionId: "session:stable",
    eventName: "item/started",
    itemId: "tool:1",
    liveItems: [{ id: "tool:1", type: "toolCall", text: "" }]
  }), false);
  assert.deepEqual(writes, []);
});
