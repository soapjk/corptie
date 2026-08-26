import assert from "node:assert/strict";
import test from "node:test";
import {
  mapClaudeTurnSettled,
  mapCodexProviderNotification,
  mapOpenClackyProviderChange
} from "../src/application/providerEventEnvelope.mjs";

const bindings = {
  codex: {
    bindingId: "binding:codex",
    providerId: "codex-app-server",
    providerSessionId: "codex-thread",
    logicalSessionId: "logical:one",
    routingVersion: 2
  },
  claude: {
    bindingId: "binding:claude",
    providerId: "claude-sdk",
    providerSessionId: "claude-session",
    logicalSessionId: "logical:one",
    routingVersion: 3
  },
  openClacky: {
    bindingId: "binding:openclacky",
    providerId: "openclacky",
    providerSessionId: "open-session",
    logicalSessionId: "logical:one",
    routingVersion: 4
  }
};

test("Codex maps final item and terminal turn into the shared Provider envelope", () => {
  const finalItem = {
    id: "item:final",
    turnId: "turn:one",
    turnStatus: "completed",
    type: "agentMessage",
    text: "final answer",
    presentationRole: "final_answer",
    status: "completed"
  };
  const itemEvent = mapCodexProviderNotification({
    binding: bindings.codex,
    message: { method: "item/completed", params: { threadId: "codex-thread", turnId: "turn:one", item: { id: "item:final", type: "agentMessage" } } },
    liveItems: [finalItem],
    receivedAt: "2026-08-26T10:00:00.000Z"
  });
  assert.equal(itemEvent.type, "assistant.message.completed");
  assert.equal(itemEvent.payload.item.presentationRole, "final_answer");

  const turnEvent = mapCodexProviderNotification({
    binding: bindings.codex,
    message: { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn:one", status: "completed" } } },
    liveItems: [finalItem],
    receivedAt: "2026-08-26T10:00:01.000Z"
  });
  assert.equal(turnEvent.type, "turn.completed");
  assert.deepEqual(turnEvent.payload.items, [finalItem]);
  assert.equal(turnEvent.providerId, "codex-app-server");
});

test("Codex persists the native completed item when its live cache has not caught up", () => {
  const itemEvent = mapCodexProviderNotification({
    binding: bindings.codex,
    message: {
      method: "item/completed",
      params: {
        threadId: "codex-thread",
        turnId: "turn:one",
        item: {
          id: "item:native-final",
          turnId: "turn:one",
          turnStatus: "completed",
          type: "agentMessage",
          text: "native final answer",
          phase: "finalAnswer",
          status: "completed"
        }
      }
    },
    liveItems: [],
    receivedAt: "2026-08-26T10:00:00.000Z"
  });

  assert.equal(itemEvent.type, "assistant.message.completed");
  assert.equal(itemEvent.payload.item.id, "item:native-final");
  assert.equal(itemEvent.payload.item.text, "native final answer");
  assert.equal(itemEvent.payload.item.presentationRole, "final_answer");
});

test("Claude terminal callback maps completed, cancelled, and failed without Provider-specific product types", () => {
  const completed = mapClaudeTurnSettled({
    binding: bindings.claude,
    event: {
      status: "completed",
      turnId: "t1",
      items: [{ id: "claude:final", turnId: "t1", type: "agentMessage", text: "done", presentationRole: "finalAnswer" }]
    }
  });
  assert.equal(completed.type, "turn.completed");
  assert.equal(completed.payload.items[0].presentationRole, "final_answer");
  assert.equal(mapClaudeTurnSettled({ binding: bindings.claude, event: { status: "cancelled", turnId: "t2" } }).type, "turn.cancelled");
  assert.equal(mapClaudeTurnSettled({ binding: bindings.claude, event: { status: "failed", turnId: "t3" } }).type, "turn.failed");
});

test("OpenClacky assistant events map to the same final-answer item contract", () => {
  const envelope = mapOpenClackyProviderChange({
    binding: bindings.openClacky,
    change: {
      event: {
        id: "event:open",
        type: "assistant_message",
        session_id: "open-session",
        turn_id: "turn:open",
        content: "done",
        created_at: "2026-08-26T10:00:00.000Z"
      }
    },
    receivedAt: "2026-08-26T10:00:00.010Z"
  });
  assert.equal(envelope.type, "assistant.message.completed");
  assert.equal(envelope.payload.item.type, "agentMessage");
  assert.equal(envelope.payload.item.presentationRole, "final_answer");
  assert.equal(envelope.providerId, "openclacky");
});
