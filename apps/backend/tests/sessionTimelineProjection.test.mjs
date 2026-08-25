import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionTimelineProjection } from "../src/application/sessionTimelineProjection.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Provider item lifecycle eagerly materializes the changed normalized item", () => {
  const writes = [];
  const projection = new SessionTimelineProjection({
    store: { upsertItemSnapshot: (sessionId, item) => writes.push({ sessionId, item }) }
  });
  const liveItems = [
    { id: "user:1", type: "userMessage", text: "run in background" },
    { id: "agent:1", type: "agentMessage", text: "finished" }
  ];

  assert.equal(projection.persistChangedItem({
    sessionId: "session:stable",
    eventName: "item/completed",
    itemId: "agent:1",
    liveItems
  }), true);
  assert.deepEqual(writes, [{
    sessionId: "session:stable",
    item: liveItems[1]
  }]);
});

test("terminal lifecycle reconciles the final reply even when item completion was missed", () => {
  const writes = [];
  const projection = new SessionTimelineProjection({
    store: { upsertItemSnapshot: (sessionId, item) => writes.push({ sessionId, item }) }
  });
  const liveItems = [
    { id: "tool:1", type: "commandExecution", text: "running tests" },
    { id: "agent:final", type: "agentMessage", text: "All requested work is complete." }
  ];

  assert.equal(projection.persistChangedItem({
    sessionId: "session:stable",
    eventName: "turn/completed",
    itemId: null,
    liveItems
  }), true);
  assert.deepEqual(writes, liveItems.map((item) => ({
    sessionId: "session:stable",
    item
  })));
});

test("a completed Session stored snapshot exposes the final reply on first load", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-terminal-snapshot-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.createSession({
      id: "session:completed",
      title: "Completed",
      status: "complete",
      provider: "codex-app-server"
    });
    const projection = new SessionTimelineProjection({ store });
    projection.persistChangedItem({
      sessionId: "session:completed",
      eventName: "turn/completed",
      itemId: null,
      liveItems: [
        {
          id: "process:1", turnId: "turn:1", type: "commandExecution", text: "tests running",
          turnStatus: "completed", createdAt: "2026-08-24T12:00:00.000Z"
        },
        {
          id: "answer:1", turnId: "turn:1", type: "agentMessage", text: "Final answer",
          turnStatus: "completed", presentationRole: "final_answer",
          createdAt: "2026-08-24T12:00:01.000Z"
        }
      ]
    });

    const stored = store.getDetail("session:completed");
    assert.equal(stored.items.at(-1).type, "agentMessage");
    assert.equal(stored.items.at(-1).text, "Final answer");
    assert.equal(stored.items.at(-1).presentationRole, "final_answer");
    assert.equal(stored.items.at(-1).turnStatus, "completed");
    assert.equal(store.sessionTimelineRevision("session:completed"), 2);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unrelated events and non-visible Provider items do not create timeline revisions", () => {
  const writes = [];
  const projection = new SessionTimelineProjection({
    store: { upsertItemSnapshot: (...args) => writes.push(args) }
  });

  assert.equal(projection.persistChangedItem({
    sessionId: "session:stable",
    eventName: "turn/completed",
    itemId: "agent:1",
    liveItems: []
  }), false);
  assert.equal(projection.persistChangedItem({
    sessionId: "session:stable",
    eventName: "item/started",
    itemId: "tool:1",
    liveItems: [{ id: "tool:1", type: "toolCall", text: "" }]
  }), false);
  assert.deepEqual(writes, []);
});
