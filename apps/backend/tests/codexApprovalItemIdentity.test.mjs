import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

test("a stale approval item cannot approve a newer Codex request", async () => {
  const client = new CodexAppServerClient();
  client.serverRequestsByThread.set("thread:one", new Map([["request:two", {
    method: "item/commandExecution/requestApproval", requestId: "request:two",
    params: { approvalId: "approval:two", requestId: "request:two", threadId: "thread:one" }
  }]]));
  let dispatched = false;
  client.respondToServerRequest = async () => { dispatched = true; };
  await assert.rejects(client.respondToApproval("thread:one", {
    itemId: "thread:one:app-server-approval:request:one", optionId: "approved", approved: true
  }), { code: "APPROVAL_NOT_PENDING" });
  assert.equal(dispatched, false);
  assert.equal(client.serverRequestsByThread.get("thread:one").size, 1);
});

test("Codex approval notification retains the item before its request cache changes", () => {
  const notifications = [];
  const client = new CodexAppServerClient({ onNotification: (value) => notifications.push(value) });
  client.handleServerRequest({ id: "request:one", method: "item/commandExecution/requestApproval", params: {
    threadId: "thread:one", turnId: "turn:one", command: "pwd",
    availableDecisions: ["approved", "denied"]
  } });
  const notification = notifications[0];
  assert.equal(notification.params.item.id, "thread:one:app-server-approval:request:one");
  assert.equal(notification.params.item.turnId, "turn:one");
  assert.deepEqual(notification.params.item.options.map((option) => option.id), ["approved", "denied"]);
  client.removeServerRequest("thread:one", "request:one");
  assert.equal(client.liveItemsForThread("thread:one").length, 0);
  assert.equal(notification.params.item.text.includes("pwd"), true);
});
