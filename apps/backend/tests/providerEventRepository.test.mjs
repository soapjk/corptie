import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Provider inbox, cursor and outbox share the caller transaction and deduplication", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-provider-repository-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    const event = {
      providerId: "test", providerSessionId: "native:test", providerEventId: "event:test",
      bindingId: "binding:test", routingVersion: 1, providerSequence: 1,
      type: "turn.started", receivedAt: "2026-01-01T00:00:00.000Z", payload: { text: "test" }
    };
    const read = () => store.providerInboxEvent(event.providerId, event.providerSessionId, event.providerEventId);
    const write = () => {
      assert.equal(store.insertProviderInboxEvent(event, null, "fingerprint"), true);
      assert.equal(store.insertProviderInboxEvent(event, null, "fingerprint"), false);
      store.upsertProviderBindingCursor(event);
      store.enqueueEventOutbox({
        outboxId: "outbox:test", topic: "session", eventType: event.type,
        payload: {}, createdAt: event.receivedAt
      });
    };
    const failure = new Error("rollback");
    assert.throws(() => store.runInTransaction(() => { write(); throw failure; }), error => error === failure);
    assert.equal(read(), null);
    assert.equal(store.providerBindingCursor(event.bindingId), null);
    assert.deepEqual(store.listPendingEventOutbox(), []);
    store.runInTransaction(write);
    assert.equal(read().status, "received");
    assert.equal(store.providerBindingCursor(event.bindingId).last_provider_sequence, 1);
    store.markProviderInboxEvent(event.providerId, event.providerSessionId, event.providerEventId, {
      status: "applied", appliedAt: event.receivedAt
    });
    assert.equal(read().raw_payload_json, "{}");
    assert.equal(read().normalized_event_json, "{}");
    assert.equal(store.insertProviderInboxEvent(event), false);
    store.markEventOutboxPublished("outbox:test");
    assert.deepEqual(store.listPendingEventOutbox(), []);
  } finally {
    await store.close();
  }
});
