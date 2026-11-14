import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { withdrawUnreceivedUserMessage, userMessageWithdrawalEligibility } from "../src/application/userMessageWithdrawal.mjs";

async function fixture(provider = "provider:test") {
  const directory = await mkdtemp(join(tmpdir(), "corptie-withdraw-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.createAgent({ id: "agent:one", name: "Agent", role: "independentContributor" });
  store.upsertSession({ id: "session:one", title: "Test", agent: "Agent", agentId: "agent:one", provider, status: "complete" });
  const input = { deliveryId: "delivery:one", messageId: "message:one", sessionId: "session:one",
    binding: { bindingId: "binding:one", providerId: provider, providerSessionId: "thread:one", routingVersion: 1 },
    agentId: "agent:one", text: "Original instruction", content: { images: [{ managedPath: "image.png" }] } };
  store.createUserMessageDelivery(input);
  return { store, input, close: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const provider of ["codex-app-server", "claude-code", "dsh", "provider:test"]) {
  test(`${provider}: withdrawal keeps an editable marker at the same position and cannot dispatch or resurrect`, async () => {
    const f = await fixture(provider), s = f.store;
    try {
      const original = s.getSessionItem(f.input.sessionId, f.input.messageId);
      const revision = s.sessionTimelineRevision(f.input.sessionId);
      assert.equal(userMessageWithdrawalEligibility(s, f.input.sessionId, f.input.messageId).available, true);
      const result = withdrawUnreceivedUserMessage(s, f.input.sessionId, f.input.messageId);
      assert.equal(result.status, "withdrawn");
      const marker = s.getSessionItem(f.input.sessionId, f.input.messageId);
      assert.equal(marker.id, original.id);
      assert.equal(marker.createdAt, original.createdAt);
      assert.equal(marker.text, "已撤回");
      assert.deepEqual(marker.images, []);
      assert.deepEqual(marker.withdrawnMessage, { text: f.input.text, images: f.input.content.images });
      assert.equal(s.getAgentTask(f.input.messageId).status, "cancelled");
      assert.equal(s.getAgentTask(f.input.messageId).text, "");
      assert.equal(s.claimAgentTask(f.input.messageId), null);
      assert.equal(s.updateAgentTask(f.input.messageId, { status: "queued" }).status, "cancelled");
      assert.throws(() => s.createUserMessageDelivery(f.input), { code: "MESSAGE_WITHDRAWN" });
      const changes = s.sessionTimelineChangesAfter(f.input.sessionId, revision).changes;
      assert.ok(changes.some(change => change.itemId === marker.id && change.operation === "upsert"));
      s.upsertTimelineItemProjection(f.input.sessionId, { ...original, text: "stale echo" });
      assert.equal(s.getSessionItem(f.input.sessionId, f.input.messageId).text, "已撤回");
      const markerRevision = s.sessionTimelineRevision(f.input.sessionId);
      assert.deepEqual(withdrawUnreceivedUserMessage(s, f.input.sessionId, f.input.messageId), result);
      assert.equal(s.sessionTimelineRevision(f.input.sessionId), markerRevision);
    } finally { await f.close(); }
  });
}

test("failed/cancelled undispatched messages share the same withdrawal action", async () => {
  for (const status of ["failed", "cancelled"]) {
    const f = await fixture();
    try {
      f.store.updateAgentTask(f.input.messageId, { status });
      f.store.updateMessageDelivery(f.input.deliveryId, { status });
      assert.equal(withdrawUnreceivedUserMessage(f.store, f.input.sessionId, f.input.messageId).status, "withdrawn");
    } finally { await f.close(); }
  }
});

test("a claimed, previously attempted, or foreign message cannot be withdrawn", async () => {
  const f = await fixture(), s = f.store;
  try {
    assert.throws(() => withdrawUnreceivedUserMessage(s, "session:other", f.input.messageId));
    assert.ok(s.claimAgentTask(f.input.messageId));
    assert.throws(() => withdrawUnreceivedUserMessage(s, f.input.sessionId, f.input.messageId), { code: "MESSAGE_MAY_HAVE_BEEN_RECEIVED" });
    s.updateAgentTask(f.input.messageId, { status: "failed" });
    s.updateMessageDelivery(f.input.deliveryId, { status: "failed", attemptCount: 1 });
    assert.throws(() => withdrawUnreceivedUserMessage(s, f.input.sessionId, f.input.messageId), { code: "MESSAGE_MAY_HAVE_BEEN_RECEIVED" });
    assert.equal(s.getSessionItem(f.input.sessionId, f.input.messageId).text, f.input.text);
  } finally { await f.close(); }
});

test("a failed withdrawal transaction leaves the original message and queue intact", async () => {
  const f = await fixture(), s = f.store;
  try {
    const original = s.upsertTimelineItemProjection;
    s.upsertTimelineItemProjection = () => { throw new Error("injected failure"); };
    assert.throws(() => withdrawUnreceivedUserMessage(s, f.input.sessionId, f.input.messageId), /injected failure/);
    s.upsertTimelineItemProjection = original;
    assert.equal(s.getAgentTask(f.input.messageId).status, "queued");
    assert.equal(s.getSessionItem(f.input.sessionId, f.input.messageId).text, f.input.text);
    assert.ok(s.claimAgentTask(f.input.messageId));
  } finally { await f.close(); }
});
