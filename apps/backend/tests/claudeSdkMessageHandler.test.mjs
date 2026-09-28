import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeSdkMessageHandler } from "../src/adapters/claudeSdkMessageHandler.mjs";

function fixture() {
  const events = [];
  const settled = [];
  const session = {
    id: "session", currentTurnId: "turn", nextItemSeq: 1, nextTurnSeq: 1,
    items: [], pendingPlanCalls: new Map(), pendingToolCalls: new Map(),
    activeTaskIds: new Set(), hiddenTaskIds: new Set(), pendingChoices: new Map()
  };
  const handler = createClaudeSdkMessageHandler({
    emitProviderEvent: (_session, event) => events.push(event),
    appendItem: (state, input) => {
      const item = { id: "item-" + state.nextItemSeq++, turnId: state.currentTurnId, ...input };
      state.items.push(item);
      return item;
    },
    persistSessionIdentity() {},
    settleToolResults() {},
    structuredPlanEvents: () => true,
    appendPlanToolFallback() {},
    expireInteractions() {},
    environment: () => ({}),
    upsertTaskProgressItem() {},
    notifyTurnSettled: (_session, event) => settled.push(event)
  });
  return { handler, session, events, settled };
}

test("streaming updates reuse an item until message completion and retain fork metadata", () => {
  const { handler, session, events } = fixture();
  handler.handleStreamEvent(session, {
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }
  });
  const firstID = session.items[0].id;
  handler.updateStreamingAssistant(session, "hello world", { completed: true, providerMessageId: "native" });
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].id, firstID);
  assert.equal(session.items[0].presentationRole, "commentary");
  assert.equal(JSON.parse(session.items[0].rawMetadataJSON).forkPoint.messageId, "native");
  assert.equal(session.streamingAssistant, null);
  assert.equal(events.at(-1).type, "assistant.message.completed");
  handler.updateStreamingAssistant(session, "next message");
  assert.equal(session.items.length, 2);
  assert.notEqual(session.items[1].id, firstID);
});

test("result settlement publishes once and clears deferred work", () => {
  const { handler, session, settled } = fixture();
  handler.updateStreamingAssistant(session, "final", { completed: true });
  const result = { turnId: "turn", succeeded: true, notified: false };
  session.deferredResult = result;
  session.pendingToolCalls.set("tool", "item");
  handler.settleClaudeResult(session, result);
  handler.settleClaudeResult(session, result);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, "completed");
  assert.equal(session.status, "complete");
  assert.equal(session.deferredResult, null);
  assert.equal(session.pendingToolCalls.size, 0);
  assert.equal(session.items[0].presentationRole, "final_answer");
});

test("foreground result waits for blocking background work to terminate", () => {
  const { handler, session, settled } = fixture();
  session.activeTaskIds.add("background");
  handler.handleSdkMessage(session, { type: "result", subtype: "success", result: "done" });
  assert.equal(session.turnState, "running");
  assert.equal(settled.length, 0);
  handler.handleSdkMessage(session, { type: "task_complete", task_id: "background" });
  assert.equal(session.turnState, "idle");
  assert.equal(settled.length, 1);
});
