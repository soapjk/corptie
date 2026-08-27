import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ProviderEventIngestionService,
  deterministicProviderEventId,
  normalizeProviderEvent
} from "../src/application/providerEventIngestionService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const binding = {
  bindingId: "binding:one",
  providerId: "provider:test",
  providerSessionId: "provider-session:one",
  logicalSessionId: "logical-session:one",
  routingVersion: 3,
  sessionId: "session:one"
};

async function fixture({ project, onCommitted } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-ingestion-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  store.upsertSession({
    id: binding.sessionId,
    title: "Provider ingestion",
    agent: "Agent",
    provider: binding.providerId,
    status: "running"
  });
  const service = new ProviderEventIngestionService({
    store,
    resolveBinding: () => binding,
    project: project ?? (({ event, store: transactionalStore }) => {
      transactionalStore.upsertSessionTurn({
        sessionId: binding.sessionId,
        bindingId: binding.bindingId,
        routingVersion: binding.routingVersion,
        turnId: event.turnId,
        executionStatus: event.type === "turn.completed" ? "completed" : "running",
        providerSequence: event.providerSequence,
        startedAt: event.occurredAt,
        endedAt: event.type === "turn.completed" ? event.occurredAt : null,
        updatedAt: event.receivedAt
      });
      transactionalStore.upsertTimelineItemProjection(binding.sessionId, {
        id: event.itemId,
        turnId: event.turnId,
        turnStatus: event.type === "turn.completed" ? "completed" : "inProgress",
        type: "agentMessage",
        title: "Agent",
        text: event.payload.text,
        presentationRole: event.payload.presentationRole,
        status: event.type === "turn.completed" ? "completed" : "inProgress",
        createdAt: event.occurredAt
      });
      return {
        surface: true,
        outbox: [{ topic: "timeline", eventType: "TimelineChanged", payload: { itemId: event.itemId } }]
      };
    }),
    onCommitted
  });
  return { directory, store, service };
}

function providerEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: binding.providerId,
    providerSessionId: binding.providerSessionId,
    bindingId: binding.bindingId,
    logicalSessionId: binding.logicalSessionId,
    routingVersion: binding.routingVersion,
    providerEventId: "event:one",
    providerSequence: 10,
    turnId: "turn:one",
    itemId: "item:one",
    type: "assistant.message.completed",
    occurredAt: "2026-08-26T10:00:00.000Z",
    receivedAt: "2026-08-26T10:00:00.032Z",
    payload: { text: "final", presentationRole: "final_answer" },
    ...overrides
  };
}

test("Provider event normalization generates a deterministic ID independent of receipt time", () => {
  const first = normalizeProviderEvent({ ...providerEvent(), providerEventId: null, receivedAt: "2026-08-26T10:00:00.032Z" });
  const replay = normalizeProviderEvent({ ...providerEvent(), providerEventId: null, receivedAt: "2026-08-26T10:01:00.000Z" });
  assert.equal(first.providerEventId, replay.providerEventId);
  assert.equal(first.providerEventId, deterministicProviderEventId(first));
});

test("generated IDs distinguish native lifecycle phases that share one product event type", () => {
  const started = normalizeProviderEvent({
    ...providerEvent({
      providerEventId: null,
      providerSequence: null,
      type: "user.message.accepted",
      payload: { nativeMethod: "item/started" }
    })
  });
  const completed = normalizeProviderEvent({
    ...providerEvent({
      providerEventId: null,
      providerSequence: null,
      type: "user.message.accepted",
      payload: { nativeMethod: "item/completed" }
    })
  });
  const replay = normalizeProviderEvent({
    ...started,
    providerEventId: null,
    receivedAt: "2026-08-26T10:10:00.000Z"
  });

  assert.notEqual(started.providerEventId, completed.providerEventId);
  assert.equal(started.providerEventId, replay.providerEventId);
});

test("Provider event ingestion atomically commits Inbox, event, turn, item, cursor, and Outbox before notification", async () => {
  const committed = [];
  const { directory, store, service } = await fixture({ onCommitted: (rows) => committed.push(rows) });
  try {
    let stateNotifications = 0;
    const timelineNotifications = [];
    store.setStateDirtyListener(() => { stateNotifications += 1; });
    store.setTimelineDirtyListener((change) => timelineNotifications.push(change));

    const result = service.ingest(providerEvent());

    assert.equal(result.status, "applied");
    assert.equal(store.providerInboxEvent(binding.providerId, binding.providerSessionId, "event:one").status, "applied");
    assert.equal(store.listSessionEvents(binding.sessionId).length, 1);
    assert.equal(store.getItems(binding.sessionId)[0].presentationRole, "final_answer");
    assert.equal(store.selectOne("SELECT execution_status FROM session_turns WHERE turn_id = ?", ["turn:one"]).execution_status, "running");
    assert.equal(store.providerBindingCursor(binding.bindingId).last_provider_sequence, 10);
    assert.equal(store.providerBindingCursor(binding.bindingId).connection_status, "connected");
    assert.equal(store.listPendingEventOutbox().length, 2);
    assert.equal(committed.length, 1);
    assert.equal(committed[0][0].status, "pending");
    assert.equal(stateNotifications, 1, "nested state writes notify once after commit");
    assert.equal(timelineNotifications.length, 1, "nested timeline writes notify once after commit");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed Provider events persist the projector's canonical Agent-message fact", async () => {
  const { directory, store, service } = await fixture({
    project: () => ({ surface: true, hasAgentMessage: true, outbox: [] })
  });
  try {
    const result = service.ingest(providerEvent({
      type: "turn.completed",
      payload: { hasAgentMessage: false, items: [] }
    }));

    assert.equal(result.sessionEvent.payload.hasAgentMessage, true);
    assert.equal(store.lastAgentMessageSequence(binding.sessionId), result.sessionEvent.sequence);
    assert.deepEqual(store.listSessionMessageCursors().get(binding.sessionId), {
      lastAgentMessageSequence: result.sessionEvent.sequence,
      lastReadMessageSequence: 0
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Inbox, Cursor, Timeline, and pending Outbox survive a Store restart", async () => {
  const { directory, store, service } = await fixture();
  let reopened = null;
  try {
    assert.equal(service.ingest(providerEvent()).status, "applied");
    await store.close();

    reopened = new CorptieStore({
      dbPath: join(directory, "corptie.sqlite"),
      configPath: join(directory, "config.json")
    });
    await reopened.initialize();

    assert.equal(
      reopened.providerInboxEvent(binding.providerId, binding.providerSessionId, "event:one")?.status,
      "applied"
    );
    assert.equal(reopened.providerBindingCursor(binding.bindingId)?.last_provider_sequence, 10);
    assert.equal(reopened.getItems(binding.sessionId)[0]?.presentationRole, "final_answer");
    assert.equal(reopened.listPendingEventOutbox().length, 2);
  } finally {
    if (reopened) await reopened.close();
    else await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an exact replay is idempotent even after cursor advance and with a new receivedAt", async () => {
  const { directory, store, service } = await fixture();
  try {
    assert.equal(service.ingest(providerEvent()).status, "applied");
    const replay = providerEvent({
      receivedAt: "2026-08-26T10:05:00.000Z",
      payload: { presentationRole: "final_answer", text: "final" }
    });
    assert.equal(service.ingest(replay).status, "duplicate");
    assert.equal(store.listSessionEvents(binding.sessionId).length, 1);
    assert.equal(store.listPendingEventOutbox().length, 2);
    assert.equal(store.sessionTimelineRevision(binding.sessionId), 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reusing a Provider event ID with different content fails explicitly", async () => {
  const { directory, store, service } = await fixture();
  try {
    service.ingest(providerEvent());
    assert.throws(
      () => service.ingest(providerEvent({ payload: { text: "different" } })),
      (error) => error.code === "PROVIDER_EVENT_ID_CONFLICT"
    );
    assert.equal(store.listSessionEvents(binding.sessionId).length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sequence gaps and stale events are quarantined without changing Timeline or its applied cursor", async () => {
  const { directory, store, service } = await fixture();
  try {
    service.ingest(providerEvent());
    const revision = store.sessionTimelineRevision(binding.sessionId);
    const gap = service.ingest(providerEvent({ providerEventId: "event:gap", providerSequence: 12, itemId: "item:gap" }));
    assert.equal(gap.status, "quarantined");
    assert.equal(gap.code, "PROVIDER_SEQUENCE_GAP");
    let cursor = store.providerBindingCursor(binding.bindingId);
    assert.equal(cursor.last_provider_sequence, 10);
    assert.equal(cursor.last_provider_event_id, "event:one");
    assert.equal(cursor.sync_health, "gap");

    const stale = service.ingest(providerEvent({ providerEventId: "event:stale", providerSequence: 9, itemId: "item:stale" }));
    assert.equal(stale.status, "quarantined");
    assert.equal(stale.code, "PROVIDER_SEQUENCE_STALE");
    cursor = store.providerBindingCursor(binding.bindingId);
    assert.equal(cursor.last_provider_sequence, 10);
    assert.equal(store.sessionTimelineRevision(binding.sessionId), revision);
    assert.equal(store.getItems(binding.sessionId).length, 1);
    assert.equal(store.listPendingEventOutbox().length, 2);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binding and routing mismatches are quarantined before projection", async () => {
  let projections = 0;
  const { directory, store, service } = await fixture({ project: () => { projections += 1; } });
  try {
    const result = service.ingest(providerEvent({ routingVersion: 2 }));
    assert.equal(result.status, "quarantined");
    assert.equal(result.code, "PROVIDER_ROUTING_VERSION_STALE");
    assert.equal(projections, 0);
    assert.equal(store.listSessionEvents(binding.sessionId).length, 0);
    assert.equal(store.listPendingEventOutbox().length, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("projection failure rolls back all UI-visible writes and emits no dirty or committed notification", async () => {
  let committed = 0;
  const { directory, store, service } = await fixture({
    project: ({ event, store: transactionalStore }) => {
      transactionalStore.upsertTimelineItemProjection(binding.sessionId, {
        id: event.itemId,
        type: "agentMessage",
        text: "must roll back"
      });
      transactionalStore.upsertSession({
        id: binding.sessionId,
        title: "must roll back",
        agent: "Agent",
        provider: binding.providerId,
        status: "complete"
      });
      throw new Error("projection failed");
    },
    onCommitted: () => { committed += 1; }
  });
  try {
    let stateNotifications = 0;
    let timelineNotifications = 0;
    store.setStateDirtyListener(() => { stateNotifications += 1; });
    store.setTimelineDirtyListener(() => { timelineNotifications += 1; });

    assert.throws(() => service.ingest(providerEvent()), /projection failed/);
    assert.equal(store.providerInboxEvent(binding.providerId, binding.providerSessionId, "event:one"), null);
    assert.equal(store.getItems(binding.sessionId).length, 0);
    assert.equal(store.getSession(binding.sessionId).title, "Provider ingestion");
    assert.equal(store.listSessionEvents(binding.sessionId).length, 0);
    assert.equal(store.listPendingEventOutbox().length, 0);
    assert.equal(stateNotifications, 0);
    assert.equal(timelineNotifications, 0);
    assert.equal(committed, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
