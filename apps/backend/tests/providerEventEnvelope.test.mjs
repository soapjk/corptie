import assert from "node:assert/strict";
import test from "node:test";
import {
  mapClaudeProviderEvent,
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

test("Codex tool text is sanitized before it enters the common Timeline", () => {
  const item = {
    id: "item:tool", turnId: "turn:one", type: "dynamicToolCall",
    title: "Test tool", text: '{"apiKey":"must-not-leak","query":"safe"}',
    presentationText: "ACCESS_TOKEN=also-secret", status: "completed"
  };
  const mapped = mapCodexProviderNotification({
    binding: bindings.codex,
    message: { method: "item/completed", params: {
      threadId: "codex-thread", turnId: "turn:one", item
    } },
    liveItems: [item], receivedAt: "2026-08-26T10:00:00.000Z"
  });
  assert.equal(mapped.type, "tool.completed");
  assert.doesNotMatch(JSON.stringify(mapped.payload), /must-not-leak|also-secret/);
  assert.match(mapped.payload.item.text, /"query":"safe"/);
  assert.match(mapped.payload.item.presentationText, /\[REDACTED\]/);
});

test("Codex plan notification maps a bounded authoritative snapshot", () => {
  const mapped = mapCodexProviderNotification({
    binding: bindings.codex,
    message: { method: "turn/plan/updated", params: {
      threadId: "codex-thread", turnId: "turn:one", explanation: "Next steps",
      plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "inProgress" }]
    } },
    receivedAt: "2026-08-26T10:00:00.000Z"
  });
  assert.equal(mapped.type, "plan.updated");
  assert.equal(mapped.turnId, "turn:one");
  assert.deepEqual(mapped.payload.plan, {
    operation: "replace", explanation: "Next steps",
    steps: [{ text: "Inspect", status: "completed" }, { text: "Implement", status: "inProgress" }]
  });
});

test("Codex without declared plan support shows an uncertain update instead of invented steps", () => {
  const mapped = mapCodexProviderNotification({
    binding: bindings.codex,
    structuredPlanEvents: false,
    message: { method: "turn/plan/updated", params: {
      threadId: "codex-thread", turnId: "turn:one",
      plan: [{ step: "Inspect", status: "completed" }]
    } }
  });
  assert.equal(mapped.type, "plan.updated");
  assert.equal(mapped.payload.plan, null);
});

test("Codex user-input request maps to a common interaction event with exact item identity", () => {
  const item = {
    id: "codex-thread:app-server-user-input:request:one",
    turnId: "turn:one", type: "userInput", status: "pending",
    text: "Which route?", rawMetadataJSON: JSON.stringify({ userInput: {
      schemaVersion: 1, isBlocking: true, questions: [{ id: "route", question: "Which route?" }]
    } })
  };
  const mapped = mapCodexProviderNotification({
    binding: bindings.codex,
    message: { method: "corptie/codexUserInputRequested", params: {
      threadId: "codex-thread", requestId: "request:one", item
    } },
    receivedAt: "2026-08-26T10:00:00.000Z"
  });
  assert.equal(mapped.type, "interaction.requested");
  assert.equal(mapped.itemId, item.id);
  assert.equal(mapped.payload.item.rawMetadataJSON, item.rawMetadataJSON);
  for (const [method, expectedType, status] of [
    ["corptie/codexUserInputSubmitted", "interaction.submitted", "submitted"],
    ["corptie/codexUserInputResolved", "interaction.resolved", "expired"]
  ]) {
    const next = mapCodexProviderNotification({ binding: bindings.codex,
      message: { method, params: { threadId: "codex-thread", requestId: "request:one",
        item: { ...item, status } } } });
    assert.equal(next.type, expectedType);
    assert.equal(next.itemId, item.id);
  }
  assert.equal(mapCodexProviderNotification({
    binding: bindings.codex,
    message: { method: "corptie/codexUserInputRequested", params: {
      threadId: "codex-thread", requestId: "request:other", item
    } }
  }), null);
});

test("Codex plan parser rejects fields outside the installed native schema", () => {
  for (const params of [
    { explanation: null, plan: [{ step: 42, status: "completed" }] },
    { explanation: 42, plan: [{ step: "Inspect", status: "pending" }] }
  ]) {
    const mapped = mapCodexProviderNotification({
      binding: bindings.codex,
      message: { method: "turn/plan/updated", params: {
        threadId: "codex-thread", turnId: "turn:one", ...params
      } },
      receivedAt: "2026-08-26T10:00:00.000Z"
    });
    assert.equal(mapped.type, "plan.updated");
    assert.equal(mapped.payload.plan, null,
      "malformed native fields must be projected as an uncertain update, not coerced into a step");
  }
});

test("Codex approval notification selects its own request when several are pending", () => {
  const approval = (requestId, turnId) => ({
    id: `codex-thread:app-server-approval:${requestId}`,
    turnId,
    type: "approval",
    text: `Approve ${requestId}?`,
    status: "pending",
    options: [{ id: "approved", label: "Approve", role: "approve" }]
  });
  const mapped = mapCodexProviderNotification({
    binding: bindings.codex,
    message: { method: "corptie/codexApprovalRequested", params: {
      threadId: "codex-thread", requestId: "request:first"
    } },
    liveItems: [approval("request:first", "turn:first"), approval("request:second", "turn:second")],
    receivedAt: "2026-08-26T10:00:00.000Z"
  });
  assert.equal(mapped.type, "approval.requested");
  assert.equal(mapped.itemId, "codex-thread:app-server-approval:request:first");
  assert.equal(mapped.turnId, "turn:first");
  assert.equal(mapped.payload.item.text, "Approve request:first?");
  assert.equal(mapped.payload.item.options[0].id, "approved");

  const delayed = mapCodexProviderNotification({
    binding: bindings.codex,
    message: { method: "corptie/codexApprovalRequested", params: {
      threadId: "codex-thread", requestId: "request:first",
      item: approval("request:first", "turn:first")
    } },
    liveItems: [],
    receivedAt: "2026-08-26T10:00:01.000Z"
  });
  assert.equal(delayed.itemId, mapped.itemId);
  assert.equal(delayed.turnId, "turn:first");
  assert.equal(delayed.payload.item.text, "Approve request:first?");
});

test("Provider errors distinguish a failed Turn from an unavailable Session", () => {
  const turnError = mapCodexProviderNotification({
    binding: bindings.codex,
    message: {
      method: "error",
      params: {
        threadId: "codex-thread",
        turnId: "turn:capacity",
        error: {
          message: "Selected model is at capacity. Please try a different model.",
          codexErrorInfo: "serverOverloaded"
        },
        willRetry: false
      }
    },
    receivedAt: "2026-08-31T07:08:38.415Z"
  });
  const sessionError = mapCodexProviderNotification({
    binding: bindings.codex,
    message: {
      method: "error",
      params: {
        threadId: "codex-thread",
        error: { message: "Provider process exited." },
        willRetry: false
      }
    },
    receivedAt: "2026-08-31T07:09:00.000Z"
  });
  const claudeTurnError = mapClaudeProviderEvent({
    binding: bindings.claude,
    event: {
      type: "provider.error",
      turnId: "claude-turn:capacity",
      error: "Selected model is at capacity."
    },
    receivedAt: "2026-08-31T07:09:01.000Z"
  });
  const openClackyTurnError = mapOpenClackyProviderChange({
    binding: bindings.openClacky,
    change: {
      event: {
        type: "error",
        turn_id: "openclacky-turn:capacity",
        error: "Selected model is at capacity."
      }
    },
    receivedAt: "2026-08-31T07:09:02.000Z"
  });

  assert.equal(turnError.payload.failureScope, "turn");
  assert.equal(sessionError.payload.failureScope, "session");
  assert.equal(claudeTurnError.payload.failureScope, "turn");
  assert.equal(openClackyTurnError.payload.failureScope, "turn");
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

test("OpenClacky feedback projects actionable neutral confirmation options", () => {
  const envelope = mapOpenClackyProviderChange({
    binding: bindings.openClacky,
    change: { event: { id: "feedback:one", type: "request_feedback", turn_id: "turn:one",
      question: "Continue?" } },
    receivedAt: "2026-09-24T00:00:00.000Z"
  });
  assert.equal(envelope.type, "approval.requested");
  assert.equal(envelope.payload.item.status, "pending");
  assert.deepEqual(envelope.payload.item.options.map(option => [option.id, option.role]),
    [["yes", "approve"], ["no", "deny"]]);
});

test("OpenClacky adapter-normalized ids are preserved for Timeline projection", () => {
  const envelope = mapOpenClackyProviderChange({
    binding: bindings.openClacky,
    change: {
      event: {
        event_id: "openclacky:event:stable",
        item_id: "openclacky:event:stable",
        type: "assistant_message",
        session_id: "open-session",
        turn_id: "turn:open",
        content: "recovered context answer"
      }
    }
  });
  assert.equal(envelope.providerEventId, "openclacky:event:stable");
  assert.equal(envelope.itemId, "openclacky:event:stable");
  assert.equal(envelope.payload.item.id, "openclacky:event:stable");
  assert.equal(envelope.payload.item.turnId, "turn:open");
});
