import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-message-delivery-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.createAgent({ id: "agent:one", name: "Agent", role: "independentContributor" });
  store.upsertSession({
    id: "session:one",
    title: "Delivery",
    agent: "Agent",
    agentId: "agent:one",
    provider: "provider:test",
    status: "complete"
  });
  return { directory, store };
}

const binding = {
  bindingId: "binding:one",
  providerId: "provider:test",
  providerSessionId: "thread:one",
  routingVersion: 4
};

test("user message, Delivery, queue work, domain event, and Outbox commit together before dispatch", async () => {
  const { directory, store } = await fixture();
  try {
    const timelineNotifications = [];
    store.setTimelineDirtyListener((change) => timelineNotifications.push(change));
    const created = store.createUserMessageDelivery({
      deliveryId: "delivery:one",
      messageId: "message:one",
      sessionId: "session:one",
      binding,
      agentId: "agent:one",
      text: "run once",
      source: { type: "desktop" },
      createdAt: "2026-08-26T10:00:00.000Z"
    });

    assert.equal(created.inserted, true);
    assert.equal(created.delivery.status, "queued");
    assert.equal(created.message.text, "run once");
    assert.equal(created.message.status, "queued");
    assert.equal(created.message.bindingId, binding.bindingId);
    assert.equal(created.workItem.status, "queued");
    assert.equal(created.workItem.source.deliveryId, "delivery:one");
    assert.equal(store.listSessionEvents("session:one")[0].type, "SessionUserMessageCreated");
    assert.equal(store.listPendingEventOutbox()[0].event_type, "MessageDeliveryQueued");
    assert.equal(store.getSession("session:one").deliveryStatus, "queued");
    assert.equal(timelineNotifications.length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("message creation is idempotent and a conflicting Delivery key is explicit", async () => {
  const { directory, store } = await fixture();
  const input = {
    deliveryId: "delivery:one",
    messageId: "message:one",
    sessionId: "session:one",
    binding,
    agentId: "agent:one",
    text: "run once"
  };
  try {
    assert.equal(store.createUserMessageDelivery(input).inserted, true);
    assert.equal(store.createUserMessageDelivery(input).inserted, false);
    assert.equal(store.getItems("session:one").length, 1);
    assert.equal(store.listSessionEvents("session:one").length, 1);
    assert.equal(store.listPendingEventOutbox().length, 1);
    assert.throws(
      () => store.createUserMessageDelivery({ ...input, messageId: "message:other" }),
      (error) => error.code === "MESSAGE_DELIVERY_CONFLICT"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Delivery state updates increment only the message row Timeline and preserve audit fields", async () => {
  const { directory, store } = await fixture();
  try {
    store.createUserMessageDelivery({
      deliveryId: "delivery:one",
      messageId: "message:one",
      sessionId: "session:one",
      binding,
      agentId: "agent:one",
      text: "run once"
    });
    const initialRevision = store.sessionTimelineRevision("session:one");
    const dispatching = store.updateMessageDelivery("delivery:one", {
      status: "dispatching",
      attemptCount: 1,
      lastAttemptAt: "2026-08-26T10:00:01.000Z"
    });
    assert.equal(dispatching.attemptCount, 1);
    const accepted = store.updateMessageDelivery("delivery:one", {
      status: "accepted",
      providerTurnId: "turn:one",
      providerAcknowledgedAt: "2026-08-26T10:00:01.100Z"
    });
    assert.equal(accepted.providerTurnId, "turn:one");
    assert.equal(store.getSessionItem("session:one", "message:one").status, "accepted");
    assert.equal(store.sessionTimelineRevision("session:one"), initialRevision + 2);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
