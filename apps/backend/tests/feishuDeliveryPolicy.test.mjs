import test from "node:test";
import assert from "node:assert/strict";
import { feishuProjectionForSessionItem, shouldSeedFeishuSeenItem, pendingRequestForFinalItem } from "../src/feishu/feishuDeliveryPolicy.mjs";

test("streaming replies remain deferred while failed replies and local reasoning stay hidden", () => {
  const streaming = { type: "agentMessage", text: "partial", turnStatus: "running" };
  assert.equal(feishuProjectionForSessionItem(streaming), "deferred");
  assert.equal(shouldSeedFeishuSeenItem(streaming), false);
  assert.equal(feishuProjectionForSessionItem({ type: "reasoning", text: "local" }), "hidden");
  assert.equal(feishuProjectionForSessionItem({ ...streaming, turnStatus: "failed" }), "hidden");
  assert.equal(feishuProjectionForSessionItem({ ...streaming, turnStatus: "completed", presentationRole: "final_answer" }), "assistant");
});

test("final reply binds to the preceding user request in its own Turn", () => {
  const first = { id: "one", type: "userMessage", turnId: "turn-one" };
  const second = { id: "two", type: "userMessage", turnId: "turn-two" };
  const final = { id: "final", type: "agentMessage", turnId: "turn-one" };
  const request = { messageId: "one", sessionId: "session" };
  assert.equal(pendingRequestForFinalItem({ pendingFeishuRequests: [request, { messageId: "two", sessionId: "session" }] }, [first, second, final], final), request);
});
