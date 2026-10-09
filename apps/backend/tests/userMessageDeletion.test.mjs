import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { deleteUnreceivedUserMessage, userMessageDeletionEligibility } from "../src/application/userMessageDeletion.mjs";

async function fixture(provider) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-delete-message-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.createAgent({ id: "agent:one", name: "Agent", role: "independentContributor" });
  store.upsertSession({ id: "session:one", title: "Test", agent: "Agent", agentId: "agent:one", provider, status: "complete" });
  const input = { deliveryId: "delivery:one", messageId: "message:one", sessionId: "session:one",
    binding: { bindingId: "binding:one", providerId: provider, providerSessionId: "thread:one", routingVersion: 1 },
    agentId: "agent:one", text: "private message body", content: { images: [{ managedPath: "private-image" }] } };
  store.createUserMessageDelivery(input);
  return { store, input, close: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const provider of ["codex", "claude", "provider:test"]) {
  test(`${provider}: cancelled never-dispatched message deletes atomically and cannot resurrect`, async () => {
    const f = await fixture(provider), s = f.store;
    try {
      s.cancelQueuedUserAgentTask(f.input.sessionId, f.input.messageId);
      s.updateMessageDelivery(f.input.deliveryId, { status: "cancelled" });
      assert.equal(userMessageDeletionEligibility(s, f.input.sessionId, f.input.messageId).available, true);
      const revision = s.sessionTimelineRevision(f.input.sessionId);
      const result = deleteUnreceivedUserMessage(s, f.input.sessionId, f.input.messageId);
      assert.equal(result.status, "deleted");
      assert.equal(s.getSessionItem(f.input.sessionId, f.input.messageId), null);
      assert.ok(s.sessionTimelineRevision(f.input.sessionId) > revision);
      assert.ok(s.sessionTimelineChangesAfter(f.input.sessionId, revision).changes.some(
        change => change.itemId === f.input.messageId && change.operation === "delete"));
      assert.equal(s.getAgentTask(f.input.messageId).text, "");
      assert.equal(s.getAgentTask(f.input.messageId).source.messageContent, undefined);
      assert.equal(JSON.stringify(s.listSessionEvents(f.input.sessionId)).includes("private message body"), false);
      assert.deepEqual(deleteUnreceivedUserMessage(s, f.input.sessionId, f.input.messageId), result);
      assert.throws(() => s.createUserMessageDelivery(f.input), { code: "MESSAGE_DELETED" });
      s.upsertTimelineItemProjection(f.input.sessionId, { id: f.input.messageId, type: "userMessage",
        turnId: "old", turnStatus: "cancelled", title: "User", text: "stale replay" });
      assert.equal(s.getSessionItem(f.input.sessionId, f.input.messageId), null);
      s.updateAgentTask(f.input.messageId, { status: "queued" });
      assert.equal(s.claimAgentTask(f.input.messageId), null);
    } finally { await f.close(); }
  });
}

test("queued, running, ambiguous and foreign-session messages are never deleted", async () => {
  const f = await fixture("provider:test"), s = f.store;
  try {
    assert.throws(() => deleteUnreceivedUserMessage(s, "session:other", f.input.messageId));
    assert.throws(() => deleteUnreceivedUserMessage(s, f.input.sessionId, f.input.messageId));
    s.claimAgentTask(f.input.messageId);
    s.updateAgentTask(f.input.messageId, { status: "failed" });
    s.updateMessageDelivery(f.input.deliveryId, { status: "failed", attemptCount: 1 });
    assert.throws(() => deleteUnreceivedUserMessage(s, f.input.sessionId, f.input.messageId),
      { code: "MESSAGE_MAY_HAVE_BEEN_RECEIVED" });
    assert.equal(s.getSessionItem(f.input.sessionId, f.input.messageId).text, f.input.text);
  } finally { await f.close(); }
});

test("deletion failure rolls back tombstone and scrubbed content", async () => {
  const f = await fixture("provider:test"), s = f.store;
  try {
    s.cancelQueuedUserAgentTask(f.input.sessionId, f.input.messageId);
    s.updateMessageDelivery(f.input.deliveryId, { status: "cancelled" });
    const original = s.removeItem;
    s.removeItem = () => { throw new Error("injected failure"); };
    assert.throws(() => deleteUnreceivedUserMessage(s, f.input.sessionId, f.input.messageId), /injected failure/);
    s.removeItem = original;
    assert.equal(s.getAgentTask(f.input.messageId).text, f.input.text);
    assert.equal(s.selectOne("SELECT COUNT(*) AS n FROM deleted_user_messages").n, 0);
  } finally { await f.close(); }
});
