import test from "node:test";
import assert from "node:assert/strict";
import { CodexLiveThreadCache } from "../src/adapters/codexLiveThreadCache.mjs";
import { mapCodexProviderNotification } from "../src/application/providerEventEnvelope.mjs";

test("item completion does not terminate a turn; turn completion settles only matching items", () => {
  const expired = [];
  const cache = new CodexLiveThreadCache({
    expireTurnRequests: (...args) => expired.push(args)
  });
  for (const turnId of ["turn-a", "turn-b"]) {
    cache.captureLiveItem({
      method: "item/completed",
      params: { threadId: "thread", turnId, item: { id: turnId, type: "agentMessage", text: turnId } }
    });
  }
  assert.deepEqual(cache.itemsForThread("thread").map((item) => item.turnStatus), ["inProgress", "inProgress"]);
  cache.captureLiveItem({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-a", status: "completed" } }
  });
  assert.deepEqual(expired, [["thread", "turn-a"]]);
  assert.deepEqual(cache.itemsForThread("thread").map((item) => item.turnStatus), ["completed", "inProgress"]);
  assert.equal(cache.latestAgentMessageText("thread", "turn-a"), "turn-a");
});

test("managed images update both the item and metadata; release removes all thread projections", () => {
  const cache = new CodexLiveThreadCache({ expireTurnRequests() {} });
  cache.captureLiveItem({
    method: "item/started",
    params: { threadId: "thread", turnId: "turn", item: { id: "item", type: "agentMessage", text: "hello" } }
  });
  const images = [{ managedPath: "images/one.png" }];
  assert.equal(cache.attachManagedImagesToLiveItem("thread", "item", images), true);
  assert.deepEqual(cache.itemsForThread("thread")[0].images, images);
  assert.deepEqual(JSON.parse(cache.itemsForThread("thread")[0].rawMetadataJSON).images, images);
  assert.equal(cache.attachManagedImagesToLiveItem("missing", "item", images), false);
  cache.captureLiveItem({
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread", tokenUsage: { totalTokens: 10, modelContextWindow: 100 } }
  });
  cache.captureLiveItem({
    method: "turn/diff/updated", params: { threadId: "thread", turnId: "turn", diff: "patch" }
  });
  assert.equal(cache.tokenUsageForThread("thread").usedTokens, 10);
  assert.equal(cache.turnDiffsByThread.get("thread").get("turn"), "patch");
  cache.releaseThread("thread");
  assert.equal(cache.threadCount, 0);
  assert.equal(cache.tokenUsageForThread("thread"), null);
  assert.equal(cache.turnDiffsByThread.has("thread"), false);
});

test("retryable errors retain in-progress state and terminal failures retain their error text", () => {
  const cache = new CodexLiveThreadCache({ expireTurnRequests() {} });
  cache.captureLiveItem({
    method: "error", params: { threadId: "thread", turnId: "turn", willRetry: true, error: { message: "retry" } }
  });
  assert.equal(cache.itemsForThread("thread")[0].turnStatus, "inProgress");
  cache.captureLiveItem({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn", error: { message: "failed" } } }
  });
  const items = cache.itemsForThread("thread");
  assert.equal(items.at(-1).type, "taskComplete");
  assert.equal(items.at(-1).text, "failed");
  assert.ok(items.every((item) => item.turnStatus === "failed"));
});

test("Codex retry notifications update one Timeline item per Turn", () => {
  const cache = new CodexLiveThreadCache({ expireTurnRequests() {} });
  for (let attempt = 1; attempt <= 5; attempt++) {
    cache.captureLiveItem({
      method: "error",
      params: { threadId: "thread", turnId: "turn-a", willRetry: true,
        error: { message: `connection failure ${attempt}` } }
    });
    const items = cache.itemsForThread("thread");
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "thread:reconnect:turn-a");
    assert.equal(items[0].retryAttempt, attempt);
    assert.match(items[0].title, new RegExp(`retry ${attempt}$`));
    assert.equal(items[0].text, `connection failure ${attempt}`);
  }
  cache.captureLiveItem({
    method: "error", params: { threadId: "thread", turnId: "turn-b", willRetry: true,
      error: { message: "another turn" } }
  });
  assert.equal(cache.itemsForThread("thread").length, 2);
  cache.captureLiveItem({
    method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-a", status: "completed" } }
  });
  const [first, second] = cache.itemsForThread("thread");
  assert.equal(first.status, "completed");
  assert.match(first.title, /5 retries$/);
  assert.equal(first.turnStatus, "completed");
  assert.equal(second.status, "retrying");
  assert.equal(second.retryAttempt, 1);
  const envelope = mapCodexProviderNotification({
    binding: { bindingId: "binding", providerId: "codex-app-server",
      providerSessionId: "thread", logicalSessionId: "session", routingVersion: 1 },
    message: { method: "turn/completed", params: {
      threadId: "thread", turn: { id: "turn-a", status: "completed" }
    } },
    liveItems: cache.itemsForThread("thread"),
    receivedAt: "2026-09-30T00:00:00Z"
  });
  assert.deepEqual(envelope.payload.items.filter((item) => item.turnId === "turn-a")
    .map((item) => item.id), ["thread:reconnect:turn-a"]);
});
