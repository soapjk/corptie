import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const execFileAsync = promisify(execFile);

test("event storage maintenance compacts legacy applied payloads and removes published Outbox rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-event-storage-compaction-"));
  const dbPath = join(directory, "corptie.sqlite");
  let store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    store.upsertSession({
      id: "session:compact",
      title: "Compact",
      agent: "Agent",
      provider: "provider:test",
      status: "complete"
    });
    const event = {
      schemaVersion: 1,
      providerId: "provider:test",
      providerSessionId: "provider-session:compact",
      bindingId: "binding:compact",
      logicalSessionId: "logical-session:compact",
      routingVersion: 1,
      providerEventId: "event:compact",
      providerSequence: 1,
      turnId: "turn:compact",
      itemId: "item:compact",
      type: "turn.completed",
      occurredAt: "2026-09-02T12:00:00.000Z",
      receivedAt: "2026-09-02T12:00:00.010Z",
      payload: { items: [{ id: "item:compact", type: "agentMessage", text: "x".repeat(20_000) }] },
      rawPayload: { items: [{ id: "item:compact", text: "x".repeat(20_000) }] }
    };
    store.insertProviderInboxEvent(event, "session:compact");
    store.markProviderInboxEvent(event.providerId, event.providerSessionId, event.providerEventId, {
      status: "applied",
      appliedAt: event.receivedAt
    });
    store.appendSessionEvent({
      eventId: "session-event:compact",
      sessionId: "session:compact",
      type: event.type,
      source: { type: "provider", providerId: event.providerId },
      payload: event.payload,
      createdAt: event.receivedAt
    });
    store.enqueueEventOutbox({
      outboxId: "outbox:published",
      topic: "provider-events",
      sessionId: "session:compact",
      eventType: event.type,
      payload: event,
      createdAt: event.receivedAt
    });
    store.db.run("UPDATE event_outbox SET status='published' WHERE outbox_id='outbox:published'");
    await store.close();

    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/compact-event-storage.mjs",
      "--db", dbPath,
      "--batch-size", "10"
    ], { cwd: new URL("..", import.meta.url).pathname });
    const report = JSON.parse(stdout);
    assert.equal(report.appliedInboxCompacted, 1);
    assert.equal(report.providerSessionEventsCompacted, 1);
    assert.equal(report.publishedOutboxDeleted, 1);

    store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await store.initialize();
    const inbox = store.providerInboxEvent(event.providerId, event.providerSessionId, event.providerEventId);
    assert.match(inbox.event_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(inbox.raw_payload_json, "{}");
    assert.equal(inbox.normalized_event_json, "{}");
    const sessionEvent = store.selectOne(
      "SELECT payload_json, storage_version FROM session_events WHERE event_id='session-event:compact'"
    );
    assert.equal(sessionEvent.storage_version, 2);
    assert.equal(JSON.parse(sessionEvent.payload_json).items, undefined);
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM event_outbox").count, 0);
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
