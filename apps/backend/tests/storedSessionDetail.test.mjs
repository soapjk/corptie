import assert from "node:assert/strict";
import test from "node:test";
import { persistableSessionItems, storedSessionDetail } from "../src/application/storedSessionDetail.mjs";

test("stored detail remains readable when its Provider is offline", () => {
  const detail = storedSessionDetail({
    summary: {
      id: "openclacky:one",
      title: "Imported conversation",
      status: "complete",
      external: { provider: "openclacky" },
      capabilities: { canSend: true, canInterrupt: true }
    },
    storedDetail: {
      items: [{ id: "local-1", type: "agentMessage", text: "Stored locally" }]
    },
    eventItems: [{ id: "legacy-1", type: "userMessage", text: "Legacy event" }]
  });

  assert.equal(detail.connectionStatus, "disconnected");
  assert.equal(detail.canSend, false);
  assert.equal(detail.capabilities.canSend, false);
  assert.equal(detail.capabilities.canInterrupt, false);
  assert.deepEqual(detail.items.map((item) => item.id), ["local-1"]);
});

test("legacy event projection is used before detail snapshots exist", () => {
  const detail = storedSessionDetail({
    summary: { id: "openclacky:legacy", external: { provider: "openclacky" } },
    storedDetail: { items: [] },
    eventItems: [{ id: "legacy-1", type: "userMessage", text: "Recovered" }]
  });

  assert.deepEqual(detail.items.map((item) => item.id), ["legacy-1"]);
});

test("only stable non-empty timeline items are persisted", () => {
  assert.deepEqual(persistableSessionItems({
    items: [
      { id: "message-1", text: "Hello" },
      { id: "", text: "Missing id" },
      { id: "message-2", text: "" },
      null
    ]
  }), [{ id: "message-1", text: "Hello" }]);
});
