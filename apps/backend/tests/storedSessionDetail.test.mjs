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
    }
  });

  assert.equal(detail.connectionStatus, "disconnected");
  assert.equal(detail.canSend, false);
  assert.equal(detail.capabilities.canSend, false);
  assert.equal(detail.capabilities.canInterrupt, false);
  assert.deepEqual(detail.items.map((item) => item.id), ["local-1"]);
});

test("an empty materialized Timeline remains empty without event-log reconstruction", () => {
  const detail = storedSessionDetail({
    summary: { id: "openclacky:empty", external: { provider: "openclacky" } },
    storedDetail: { items: [] }
  });

  assert.deepEqual(detail.items, []);
});

test("failed Provider detail exposes the actionable provider error", () => {
  const detail = storedSessionDetail({
    summary: {
      id: "openclacky:failed",
      status: "failed",
      summary: "Operation not permitted @ rb_sysopen - /repo/AGENTS.md",
      external: { provider: "openclacky" }
    },
    storedDetail: { items: [] }
  });

  assert.equal(detail.canSend, false);
  assert.equal(detail.sendUnavailableReason, "Operation not permitted @ rb_sysopen - /repo/AGENTS.md");
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
