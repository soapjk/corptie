import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";

test("Session activity status survives store restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-activity-status-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const first = new CorptieStore({ dbPath, configPath });

  try {
    await first.initialize();
    first.upsertSession({
      id: "codex:active-session",
      title: "Active Session",
      agent: "Codex",
      provider: "codex-app-server",
      status: "running",
      activityStatus: "Running command",
      external: { activeTurnId: "turn:active", lastSettledTurnId: "turn:previous" }
    });
    await first.close();

    const restarted = new CorptieStore({ dbPath, configPath });
    try {
      await restarted.initialize();
      const session = restarted.getSession("codex:active-session");
      assert.equal(session.activityStatus, "Running command");
      assert.equal(session.external.activeTurnId, "turn:active");
      assert.equal(session.external.lastSettledTurnId, "turn:previous");
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session tables do not own avatar columns while Agents still do", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-avatar-schema-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const initialStore = new CorptieStore({ dbPath, configPath });

  try {
    await initialStore.initialize();
    await initialStore.close();

    const legacyDatabase = new DatabaseSync(dbPath);
    legacyDatabase.exec("ALTER TABLE sessions ADD COLUMN avatar_path TEXT");
    legacyDatabase.exec("ALTER TABLE logical_sessions ADD COLUMN avatar_path TEXT");
    legacyDatabase.exec("ALTER TABLE agents ADD COLUMN provider TEXT");
    legacyDatabase.exec("UPDATE agents SET provider = 'codex-app-server'");
    legacyDatabase.close();

    const migratedStore = new CorptieStore({ dbPath, configPath });
    await migratedStore.initialize();
    assert.equal(migratedStore.selectAll("PRAGMA table_info(sessions)").some((column) => column.name === "avatar_path"), false);
    assert.equal(migratedStore.selectAll("PRAGMA table_info(logical_sessions)").some((column) => column.name === "avatar_path"), false);
    assert.equal(migratedStore.selectAll("PRAGMA table_info(agents)").some((column) => column.name === "avatar_path"), true);
    assert.equal(migratedStore.selectAll("PRAGMA table_info(agents)").some((column) => column.name === "provider"), false);
    await migratedStore.close();
  } finally {
    await initialStore.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy Objective acceptance criteria migrate to the evolving ideal state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-objective-ideal-state-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const initialStore = new CorptieStore({ dbPath, configPath });
  try {
    await initialStore.initialize();
    initialStore.createObjective({ id: "objective:legacy", name: "Long-lived objective" });
    await initialStore.close();

    const legacyDatabase = new DatabaseSync(dbPath);
    legacyDatabase.exec("ALTER TABLE objectives RENAME COLUMN ideal_state TO acceptance_criteria");
    legacyDatabase.prepare(
      "UPDATE objectives SET acceptance_criteria = ? WHERE id = ?"
    ).run("The system continuously becomes easier to evolve.", "objective:legacy");
    legacyDatabase.close();

    const migratedStore = new CorptieStore({ dbPath, configPath });
    await migratedStore.initialize();
    assert.equal(
      migratedStore.getObjective("objective:legacy").idealState,
      "The system continuously becomes easier to evolve."
    );
    const columns = migratedStore.selectAll("PRAGMA table_info(objectives)").map((column) => column.name);
    assert.equal(columns.includes("ideal_state"), true);
    assert.equal(columns.includes("acceptance_criteria"), false);
    await migratedStore.close();
  } finally {
    await initialStore.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("native SQLite persists committed writes immediately in WAL mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-native-sqlite-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });

  try {
    await store.initialize();
    store.upsertSession({
      id: "native-session",
      title: "Native SQLite",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete",
      updatedAt: "2026-07-20T00:00:00.000Z"
    });

    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(reader.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.equal(
        reader.prepare("SELECT title FROM sessions WHERE id = ?").get("native-session").title,
        "Native SQLite"
      );
    } finally {
      reader.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session items persist Provider raw metadata for diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-item-raw-metadata-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "raw-session",
      title: "Raw metadata",
      agent: "Claude Code",
      provider: "claude-sdk",
      status: "running"
    });
    const rawMetadataJSON = JSON.stringify({ provider: "claude-sdk", payload: { command: "npm test" } });
    store.upsertTimelineItemProjection("raw-session", {
      id: "command-1",
      turnId: "turn-1",
      turnStatus: "running",
      type: "commandExecution",
      title: "Bash",
      text: "npm test",
      status: "running",
      rawMetadataJSON
    });

    assert.equal(store.getItems("raw-session", 10, "claude-sdk")[0].rawMetadataJSON, rawMetadataJSON);
    assert.equal(
      store.selectOne("SELECT raw_metadata_json FROM session_items WHERE id = ?", ["command-1"]).raw_metadata_json,
      rawMetadataJSON
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored timeline event reads exclude noisy Provider status events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-timeline-events-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "timeline-session",
      title: "Timeline",
      provider: "openclacky",
      status: "complete"
    });
    store.appendSessionEvent({
      eventId: "status-1",
      sessionId: "timeline-session",
      type: "ProviderSessionChanged",
      payload: { status: "running" }
    });
    store.appendSessionEvent({
      eventId: "message-1",
      sessionId: "timeline-session",
      type: "assistant/message",
      payload: { text: "Saved response" }
    });

    assert.deepEqual(
      store.listStoredTimelineEvents("timeline-session").map((event) => event.eventId),
      ["message-1"]
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored Session detail reads its complete local timeline without Provider access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-stored-detail-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "offline-session",
      title: "Offline",
      provider: "openclacky",
      status: "complete"
    });
    store.runInTransaction(() => {
      store.appendSessionEvent({
        eventId: "assistant-message:stored-message",
        sessionId: "offline-session",
        type: "assistant/message",
        producer: "agent",
        surface: true,
        payload: { itemId: "stored-message", text: "Available offline" }
      });
      store.upsertTimelineItemProjection("offline-session", {
        id: "stored-message",
        type: "agentMessage",
        text: "Available offline"
      });
    });

    const rowsModifiedBeforeRead = store.db.getRowsModified();
    const stateRevisionBeforeRead = store.stateRevision();
    const timelineRevisionBeforeRead = store.sessionTimelineRevision("offline-session");
    const detail = store.getDetail("offline-session");
    assert.equal(detail.connectionStatus, "disconnected");
    assert.deepEqual(detail.items.map((item) => item.id), ["stored-message"]);
    assert.deepEqual(store.getLatestTimelineItemWindow("offline-session", { limit: 50 }).items.map((item) => item.id), ["stored-message"]);
    assert.deepEqual(
      store.listSessionEvents("offline-session").map((event) => event.eventId),
      ["assistant-message:stored-message"]
    );
    assert.equal(store.db.getRowsModified(), rowsModifiedBeforeRead, "product reads must execute zero SQLite writes");
    assert.equal(store.stateRevision(), stateRevisionBeforeRead, "product reads must not advance state revision");
    assert.equal(
      store.sessionTimelineRevision("offline-session"),
      timelineRevisionBeforeRead,
      "product reads must not emit Timeline changes"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored item window returns the newest records in stable ascending order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-latest-items-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({ id: "latest-items", title: "Latest", agent: "Codex", provider: "codex-app-server", status: "complete" });
    for (let index = 0; index < 260; index += 1) {
      store.upsertTimelineItemProjection("latest-items", {
        id: `item-${String(index).padStart(3, "0")}`,
        type: "agentMessage",
        text: `message ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      });
    }
    const items = store.getItems("latest-items", 200);
    assert.equal(items.length, 200);
    assert.equal(items[0].id, "item-060");
    assert.equal(items.at(-1).id, "item-259");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored timeline anchor window uses bounded keyset queries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-anchor-window-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({ id: "anchor-window", title: "Anchor", agent: "Codex", provider: "codex-app-server", status: "complete" });
    for (let index = 0; index < 1_000; index += 1) {
      store.upsertTimelineItemProjection("anchor-window", {
        id: `item-${String(index).padStart(4, "0")}`,
        turnId: index >= 500 && index <= 502 ? "turn-anchor" : `turn-${index}`,
        type: "agentMessage",
        text: `message ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      });
    }
    const itemWindow = store.getTimelineItemWindow("anchor-window", {
      anchorId: "item-0500",
      before: 20,
      after: 30
    });
    assert.equal(itemWindow.items.length, 51);
    assert.equal(itemWindow.items[0].id, "item-0480");
    assert.equal(itemWindow.items.at(-1).id, "item-0530");
    assert.equal(itemWindow.hasEarlier, true);
    assert.equal(itemWindow.hasLater, true);

    const turnWindow = store.getTimelineItemWindow("anchor-window", {
      anchorKind: "turn",
      anchorId: "turn-anchor",
      before: 1,
      after: 1
    });
    assert.deepEqual(turnWindow.items.map((item) => item.id), [
      "item-0499", "item-0500", "item-0501", "item-0502", "item-0503"
    ]);
    assert.equal(
      store.selectAll("PRAGMA index_list(session_items)")
        .some((index) => index.name === "idx_session_items_turn_window"),
      true
    );
    assert.equal(store.getTimelineItemWindow("anchor-window", { anchorId: "deleted" }), null);

    const samples = [];
    for (let index = 0; index < 50; index += 1) {
      const startedAt = performance.now();
      store.getTimelineItemWindow("anchor-window", {
        anchorId: "item-0500",
        before: 40,
        after: 40
      });
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    const p50 = samples[Math.floor(samples.length / 2)];
    console.log(`[perf] stored timeline anchor window (1k items) p50=${p50.toFixed(2)}ms`);
    assert.ok(p50 < 50, `anchor lookup p50 ${p50.toFixed(2)}ms exceeded 50ms`);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored latest timeline window is bounded and reports earlier history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-latest-window-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({ id: "latest-window", title: "Latest", agent: "Codex", provider: "codex-app-server", status: "complete" });
    for (let index = 0; index < 500; index += 1) {
      store.upsertTimelineItemProjection("latest-window", {
        id: `item-${String(index).padStart(4, "0")}`,
        type: "agentMessage",
        text: `message ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      });
    }

    const window = store.getLatestTimelineItemWindow("latest-window", { limit: 80 });
    assert.equal(window.items.length, 80);
    assert.equal(window.items[0].id, "item-0420");
    assert.equal(window.items.at(-1).id, "item-0499");
    assert.equal(window.hasEarlier, true);
    assert.equal(window.hasLater, false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Timeline history uses stable keyset pages and never needs a reconstructed detail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-history-keyset-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({ id: "history-keyset", title: "History", agent: "Codex", provider: "codex-app-server", status: "complete" });
    for (let index = 0; index < 12; index += 1) {
      store.upsertTimelineItemProjection("history-keyset", {
        id: `item-${String(index).padStart(2, "0")}`,
        type: index % 2 === 0 ? "userMessage" : "agentMessage",
        text: `message ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      });
    }

    const first = store.getSessionTimelineHistoryPage("history-keyset", {
      beforeId: "item-10",
      limit: 4
    });
    assert.deepEqual(first.items.map((item) => item.id), ["item-06", "item-07", "item-08", "item-09"]);
    assert.equal(first.hasMoreHistory, true);
    assert.equal(first.historyItemsCount, 6);
    assert.equal(first.cursorStatus, "found");

    const second = store.getSessionTimelineHistoryPage("history-keyset", {
      beforeId: first.items[0].id,
      limit: 4
    });
    assert.deepEqual(second.items.map((item) => item.id), ["item-02", "item-03", "item-04", "item-05"]);
    assert.equal(second.historyItemsCount, 2);
    assert.equal(second.cursorStatus, "found");
    assert.deepEqual(
      store.getSessionTimelineHistoryPage("history-keyset", { beforeId: "item-00", limit: 4 }),
      { items: [], hasMoreHistory: false, historyItemsCount: 0, cursorStatus: "exhausted" }
    );
    assert.deepEqual(
      store.getSessionTimelineHistoryPage("history-keyset", { beforeId: "missing", limit: 4 }),
      { items: [], hasMoreHistory: false, historyItemsCount: 0, cursorStatus: "invalid" }
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an empty stored timeline is an authoritative window instead of a legacy fallback miss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-empty-window-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({ id: "empty-window", title: "Empty", agent: "Codex", provider: "codex-app-server", status: "complete" });
    assert.deepEqual(store.getLatestTimelineItemWindow("empty-window"), {
      items: [],
      hasEarlier: false,
      hasLater: false
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored timeline items restore provider-neutral supplementary presentation metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-timeline-metadata-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({ id: "metadata-window", title: "Metadata", agent: "Codex", provider: "codex-app-server", status: "complete" });
    store.upsertTimelineItemProjection("metadata-window", {
      id: "automation:event-1",
      turnId: "automation:event-1",
      turnStatus: "completed",
      type: "automationEvent",
      title: "Automation",
      text: "Run checks",
      createdAt: "2026-08-26T10:00:00.000Z",
      rawMetadataJSON: JSON.stringify({
        id: "must-not-override-indexed-identity",
        automationId: "automation:1",
        automationName: "Nightly checks",
        automationEventType: "ScheduledSessionTaskCreated"
      })
    });
    const [item] = store.getLatestTimelineItemWindow("metadata-window").items;
    assert.equal(item.id, "automation:event-1");
    assert.equal(item.automationId, "automation:1");
    assert.equal(item.automationName, "Nightly checks");
    assert.equal(item.automationEventType, "ScheduledSessionTaskCreated");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored latest window preserves conversation boundaries for a process-heavy turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-process-boundaries-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({ id: "process-boundaries", title: "Long turn", agent: "Codex", provider: "codex-app-server", status: "complete" });
    store.upsertTimelineItemProjection("process-boundaries", {
      id: "prompt", turnId: "turn-long", type: "userMessage", text: "Original request", createdAt: "2026-01-01T00:00:00.000Z"
    });
    for (let index = 0; index < 260; index += 1) {
      store.upsertTimelineItemProjection("process-boundaries", {
        id: `process-${String(index).padStart(3, "0")}`,
        turnId: "turn-long",
        type: "commandExecution",
        text: `command ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString()
      });
    }
    store.upsertTimelineItemProjection("process-boundaries", {
      id: "final", turnId: "turn-long", type: "agentMessage", text: "Final answer", createdAt: "2026-01-01T00:00:01.000Z"
    });

    const window = store.getLatestTimelineItemWindow("process-boundaries", { limit: 200 });
    assert.equal(window.items[0].id, "prompt");
    assert.equal(window.items.at(-1).id, "final");
    assert.equal(window.items.filter((item) => item.type === "commandExecution").length, 200);
    const detailItems = store.getDetail("process-boundaries").items;
    assert.equal(detailItems[0].id, "prompt");
    assert.equal(detailItems.at(-1).id, "final");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("item snapshot updates never move the original creation time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-item-created-at-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({ id: "stable-item-time", title: "Stable", agent: "Codex", provider: "codex-app-server", status: "running" });
    store.upsertTimelineItemProjection("stable-item-time", {
      id: "process", turnId: "turn", type: "commandExecution", text: "running", createdAt: "2026-01-01T00:00:00.000Z"
    });
    store.upsertTimelineItemProjection("stable-item-time", {
      id: "process", turnId: "turn", type: "commandExecution", text: "completed", createdAt: "2026-08-25T00:00:00.000Z"
    });

    const row = store.selectOne(
      "SELECT text, created_at FROM session_items WHERE session_id = ? AND id = ?",
      ["stable-item-time", "process"]
    );
    assert.equal(row.text, "completed");
    assert.equal(row.created_at, "2026-01-01T00:00:00.000Z");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("distinct user message IDs are never collapsed merely because turn and text match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-user-message-alias-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({ id: "alias-session", title: "Alias", agent: "Codex", provider: "codex-app-server", status: "running" });
    const prompt = {
      turnId: "turn-one", type: "userMessage", title: "User", text: "Sent only once",
      turnStatus: "completed", createdAt: "2026-08-25T15:42:34.000Z"
    };
    store.upsertTimelineItemProjection("alias-session", { ...prompt, id: "item-47" });
    assert.equal(store.upsertTimelineItemProjection("alias-session", {
      ...prompt,
      id: "item-48",
      createdAt: "2026-08-25T15:55:20.000Z"
    }), true);
    assert.deepEqual(
      store.getItems("alias-session").filter((item) => item.type === "userMessage").map((item) => item.id),
      ["item-47", "item-48"]
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Timeline presentation semantics survive SQLite round-trip and raw metadata is backfilled locally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-presentation-roundtrip-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({ id: "presentation-session", title: "Presentation", agent: "Codex", provider: "codex-app-server", status: "running" });
    store.upsertTimelineItemProjection("presentation-session", {
      id: "final", turnId: "turn-one", turnStatus: "completed", type: "agentMessage",
      title: "Codex", text: "Final answer", status: "completed",
      presentationRole: "final_answer", presentationText: "Presented final answer"
    });

    const stored = store.getSessionItem("presentation-session", "final");
    assert.equal(stored.presentationRole, "final_answer");
    assert.equal(stored.presentationText, "Presented final answer");

    store.db.run(
      "UPDATE session_items SET presentation_role = NULL WHERE session_id = ? AND id = ?",
      ["presentation-session", "final"]
    );
    store.db.run(
      "UPDATE session_items SET raw_metadata_json = ? WHERE session_id = ? AND id = ?",
      [JSON.stringify({ payload: { phase: "final_answer" } }), "presentation-session", "final"]
    );
    // Model a database created before the presentation migration existed. A
    // current database never creates rows without presentation semantics, so
    // the one-time migration must not be turned back into a startup scan just
    // to support this deliberately legacy fixture.
    store.db.run(
      "DELETE FROM data_migrations WHERE migration_id = ?",
      ["session-item-presentation-v1"]
    );
    store.backfillSessionItemPresentation();
    assert.equal(
      store.getSessionItem("presentation-session", "final").presentationRole,
      "final_answer"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted running Session state survives backend store restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-running-restart-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  let store = new CorptieStore({ dbPath, configPath });
  await store.initialize();
  try {
    store.upsertSession({
      id: "running-session",
      title: "Running",
      agent: "Codex",
      provider: "codex-app-server",
      status: "running"
    });
    await store.close();

    store = new CorptieStore({ dbPath, configPath });
    await store.initialize();
    assert.equal(store.getSession("running-session")?.status, "running");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session execution projection is derived from durable Turns instead of a stale legacy status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-execution-projection-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.upsertSession({
      id: "execution-session",
      title: "Execution",
      agent: "Agent",
      provider: "provider:test",
      status: "running"
    });
    store.upsertSessionTurn({
      sessionId: "execution-session",
      bindingId: "binding:one",
      routingVersion: 1,
      turnId: "turn:one",
      executionStatus: "completed",
      endedAt: "2026-08-26T10:00:01.000Z",
      updatedAt: "2026-08-26T10:00:01.000Z"
    });

    assert.equal(store.getSession("execution-session").status, "running");
    assert.equal(store.getSession("execution-session").executionStatus, "completed");

    store.upsertSessionTurn({
      sessionId: "execution-session",
      bindingId: "binding:one",
      routingVersion: 1,
      turnId: "turn:two",
      executionStatus: "blocked",
      updatedAt: "2026-08-26T10:00:02.000Z"
    });
    assert.equal(store.getSession("execution-session").executionStatus, "blocked");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart repairs a terminal Provider turn regressed by a late item event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-terminal-turn-repair-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  let store = new CorptieStore({ dbPath, configPath });
  await store.initialize();
  try {
    store.upsertSession({
      id: "regressed-session",
      title: "Regressed",
      agent: "Agent",
      provider: "provider:test",
      status: "running",
      activityStatus: "Using tool",
      external: { activeTurnId: "turn:one" },
      capabilities: { canInterrupt: true }
    });
    store.upsertSessionTurn({
      sessionId: "regressed-session",
      bindingId: "binding:one",
      routingVersion: 1,
      turnId: "turn:one",
      executionStatus: "completed",
      endedAt: "2026-08-26T10:00:00.000Z",
      updatedAt: "2026-08-26T10:00:00.000Z"
    });
    const terminalEvent = {
      providerId: "provider:test",
      providerSessionId: "thread:one",
      providerEventId: "event:turn-completed",
      bindingId: "binding:one",
      routingVersion: 1,
      turnId: "turn:one",
      type: "turn.completed",
      occurredAt: "2026-08-26T10:00:00.000Z",
      receivedAt: "2026-08-26T10:00:00.010Z",
      payload: {}
    };
    store.insertProviderInboxEvent(terminalEvent, "regressed-session");
    store.markProviderInboxEvent(
      terminalEvent.providerId,
      terminalEvent.providerSessionId,
      terminalEvent.providerEventId,
      { status: "applied", appliedAt: terminalEvent.receivedAt }
    );
    // Reproduce a database written by the previous release, before terminal
    // state became monotonic.
    store.db.run(
      "UPDATE session_turns SET execution_status = 'running', ended_at = NULL, updated_at = ? WHERE session_id = ?",
      ["2026-08-26T10:06:00.000Z", "regressed-session"]
    );
    await store.close();

    store = new CorptieStore({ dbPath, configPath });
    await store.initialize();

    const turn = store.getSessionTurn("regressed-session", "binding:one", "turn:one");
    const session = store.getSession("regressed-session");
    assert.equal(turn.execution_status, "completed");
    assert.equal(turn.ended_at, terminalEvent.occurredAt);
    assert.equal(session.status, "complete");
    assert.equal(session.executionStatus, "completed");
    assert.equal(session.external.activeTurnId, null);
    assert.equal(session.activityStatus, null);
    assert.equal(session.capabilities.canInterrupt, false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("identical Provider Session and history projections do not rewrite rows or advance revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-projection-noop-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    const session = {
      id: "projection-noop",
      title: "Stable",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete",
      progress: 1,
      summary: "done",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z"
    };
    store.upsertSession(session);
    store.upsertTimelineItemProjection(session.id, {
      id: "stable-item",
      type: "agentMessage",
      text: "done",
      createdAt: "2026-08-23T00:00:01.000Z"
    });
    const revision = store.stateRevision();
    store.upsertSession({ ...session, updatedAt: "2026-08-23T00:10:00.000Z" });
    store.upsertTimelineItemProjection(session.id, {
      id: "stable-item",
      type: "agentMessage",
      text: "done",
      createdAt: "2026-08-23T00:00:01.000Z"
    });
    assert.equal(store.stateRevision(), revision);
    assert.equal(store.selectOne("SELECT updated_at FROM sessions WHERE id = ?", [session.id]).updated_at,
      "2026-08-23T00:00:01.000Z");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Timeline projection upserts never duplicate unread domain events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-timeline-projection-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "snapshot-session",
      title: "Snapshot",
      provider: "openclacky",
      status: "complete"
    });
    store.upsertTimelineItemProjection("snapshot-session", {
      id: "old-agent-message",
      type: "agentMessage",
      text: "Already existed at the Provider",
      createdAt: "2026-08-01T00:00:00Z"
    });

    assert.deepEqual(store.getItems("snapshot-session").map((item) => item.id), ["old-agent-message"]);
    assert.equal(store.lastAgentMessageSequence("snapshot-session"), 0);
    assert.deepEqual(store.listSessionEvents("snapshot-session"), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("state revision log commits and rolls back atomically with entity writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-state-revision-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const initialRevision = store.stateRevision();
    store.upsertSession({
      id: "revision-session",
      title: "Before",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    assert.equal(store.stateRevision(), initialRevision + 1);
    assert.deepEqual(
      store.stateChangesAfter(initialRevision).map(({ entityType, entityId, operation }) => ({ entityType, entityId, operation })),
      [{ entityType: "session", entityId: "revision-session", operation: "upsert" }]
    );

    const committedRevision = store.stateRevision();
    assert.throws(() => store.runInTransaction(() => {
      store.db.run("UPDATE sessions SET title = 'Rolled back' WHERE id = 'revision-session'");
      throw new Error("force rollback");
    }), /force rollback/);
    assert.equal(store.stateRevision(), committedRevision);
    assert.equal(store.getSession("revision-session").title, "Before");
    assert.deepEqual(store.stateChangesAfter(committedRevision), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("conflict-resolution launch finalizes all visible bindings in one transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-conflict-finalize-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.createObjective({ id: "objective:conflict", name: "Resolve conflict" });
    store.createAgent({ id: "agent:conflict", name: "Conflict Agent", role: "independentContributor" });
    store.createWorkItem({
      id: "work-item:conflict",
      objectiveId: "objective:conflict",
      title: "Resolve merge conflict"
    });
    store.upsertSession({
      id: "session:conflict",
      title: "Conflict session",
      agent: "Codex",
      provider: "codex-app-server",
      status: "running"
    });
    store.createProjectIntegrationRun({
      id: "integration:conflict",
      repositoryId: "repository:test",
      objectiveId: "objective:conflict",
      mainHeadBefore: "abc123",
      status: "conflicted"
    });

    const before = store.stateRevision();
    const finalized = store.finalizeConflictResolutionLaunch({
      sessionId: "session:conflict",
      workItemId: "work-item:conflict",
      objectiveId: "objective:conflict",
      agentId: "agent:conflict",
      integrationRunId: "integration:conflict"
    });
    assert.equal(finalized.session.workItemId, "work-item:conflict");
    assert.equal(finalized.session.objectiveId, "objective:conflict");
    assert.equal(finalized.workItem.current_session_id, "session:conflict");
    assert.equal(finalized.integrationRun.conflictSessionId, "session:conflict");
    assert.deepEqual(store.stateConsistencyIssues(), []);
    assert.deepEqual(
      new Set(store.stateChangesAfter(before).map((change) => change.entityType)),
      new Set(["session", "workItem", "integrationRun"])
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session kind persists explicitly and WorkItem binding classifies worker sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-kind-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "assistant-session",
      title: "Assistant",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete",
      sessionKind: "assistantChat"
    });
    store.setSessionKind("assistant-session", "assistantChat", "assistant");
    assert.equal(store.getSession("assistant-session").sessionKind, "assistantChat");
    assert.equal(store.getSession("assistant-session").agentId, "assistant");

    store.upsertSession({
      id: "worker-session",
      title: "Worker",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    store.createObjective({ id: "objective:1", name: "Objective" });
    store.createWorkItem({ id: "work-item:1", objectiveId: "objective:1", title: "Work item" });
    store.bindSessionToWorkItem("worker-session", "work-item:1", "objective:1");
    const worker = store.getSession("worker-session");
    assert.equal(worker.sessionKind, "worker");
    assert.equal(worker.workItemId, "work-item:1");
    assert.equal(store.getWorkItem("work-item:1").current_session_id, "worker-session");

    assert.throws(
      () => store.bindSessionToWorkItem("missing-session", "work-item:1", "objective:1"),
      (error) => error?.code === "SESSION_NOT_FOUND"
    );
    assert.equal(store.getWorkItem("work-item:1").current_session_id, "worker-session");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace route replacement preserves the stable Work Session and WorkItem ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-work-session-transition-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "worker-session",
      title: "Worker",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    store.createObjective({ id: "objective:one", name: "Objective" });
    store.createWorkItem({ id: "work-item:one", objectiveId: "objective:one", title: "Work item" });
    store.bindSessionToWorkItem("worker-session", "work-item:one", "objective:one");
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:worker",
      legacySessionId: "worker-session",
      providerThreadId: "provider:source",
      providerSessionId: "provider:source",
      providerId: "codex-app-server",
      boundCwd: "/repo/main",
      title: "Worker"
    });

    assert.equal(store.assertLogicalWorkSessionBinding("logical:worker").workItemId, "work-item:one");
    store.beginWorkspaceTransition({
      transitionId: "transition:worker",
      logicalSessionId: "logical:worker",
      targetCwd: "/repo/feature",
      sourceRoutingVersion: 1,
      phase: "forking"
    });
    store.updateWorkspaceTransition("transition:worker", {
      phase: "validatingInstructions",
      newThreadId: "provider:feature"
    });
    store.commitWorkspaceTransition("transition:worker", {
      providerThreadId: "provider:feature",
      providerSessionId: "provider:feature",
      providerId: "codex-app-server",
      boundCwd: "/repo/feature"
    });

    assert.equal(store.getLogicalSession("logical:worker").legacySessionId, "worker-session");
    assert.equal(store.getWorkItem("work-item:one").current_session_id, "worker-session");
    assert.equal(store.getSession("worker-session").workItemId, "work-item:one");

    store.db.run("UPDATE work_items SET current_session_id = 'worker-session:replacement' WHERE id = 'work-item:one'");
    assert.throws(
      () => store.beginWorkspaceTransition({
        transitionId: "transition:stale-worker",
        logicalSessionId: "logical:worker",
        targetCwd: "/repo/other",
        sourceRoutingVersion: 2,
        phase: "forking"
      }),
      (error) => error.code === "WORK_SESSION_BINDING_STALE"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retiring a Worktree preserves the Work Session while making its workspace route read-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-worktree-retirement-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertGitWorkspaceSnapshot(workspaceSnapshot());
    store.upsertSession({
      id: "worker-session:retired",
      title: "Retained history",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete",
      rawStatus: { capabilities: { canSend: true, canInterrupt: true } }
    });
    store.createObjective({ id: "objective:retired", name: "Objective" });
    store.createWorkItem({
      id: "work-item:retired",
      objectiveId: "objective:retired",
      title: "Completed item"
    });
    store.bindSessionToWorkItem("worker-session:retired", "work-item:retired", "objective:retired");
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:retired",
      legacySessionId: "worker-session:retired",
      providerThreadId: "thread:retired",
      repositoryId: "repository:one",
      worktreeId: "worktree:feature",
      boundCwd: "/repo/feature",
      title: "Retained history"
    });

    const retired = store.retireLogicalSessionWorkspace("logical:retired", "worktree:feature");
    assert.equal(retired.activeWorkspaceId, null);
    assert.equal(retired.activeBinding.worktreeId, null);
    assert.equal(retired.archived, true);

    const session = store.getSession("worker-session:retired");
    assert.equal(session.workItemId, "work-item:retired");
    assert.equal(session.archived, true);
    assert.equal(session.status, "complete");
    assert.equal(session.rawStatus.capabilities.canSend, false);
    assert.equal(session.rawStatus.capabilities.canInterrupt, false);
    assert.equal(session.rawStatus.capabilities.canReconnect, false);
    assert.equal(session.rawStatus.workspaceRetired.worktreeId, "worktree:feature");
    assert.equal(store.getWorkItem("work-item:retired").current_session_id, "worker-session:retired");
    assert.equal(store.assertLogicalSessionRoute("logical:retired"), true);

    store.beginWorkspaceTransition({
      transitionId: "transition:restore-retired",
      logicalSessionId: "logical:retired",
      targetWorktreeId: "worktree:feature",
      sourceRoutingVersion: retired.routingVersion,
      lastCompletedTurnId: "turn:completed",
      strategy: "fork",
      phase: "forking"
    });
    store.updateWorkspaceTransition("transition:restore-retired", {
      phase: "validatingInstructions",
      newThreadId: "thread:restored"
    });
    store.commitWorkspaceTransition("transition:restore-retired", {
      providerThreadId: "thread:restored",
      providerSessionId: "thread:restored",
      providerId: "codex-app-server",
      boundCwd: "/repo/feature worktree"
    });
    const restored = store.restoreLogicalSessionWorkspace("logical:retired");
    assert.equal(restored.archived, false);
    assert.equal(restored.activeWorkspaceId, "worktree:feature");
    assert.equal(store.getSession("worker-session:retired").archived, false);
    assert.equal(store.getSession("worker-session:retired").rawStatus.workspaceRetired, undefined);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Assistant agents receive distinct workspaces and reject explicit reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-assistant-workspaces-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const first = store.createAgent({ id: "assistant:first", name: "First", role: "assistant" });
    const second = store.createAgent({ id: "assistant:second", name: "Second", role: "assistant" });

    assert.notEqual(first.workDir, second.workDir);
    assert.match(first.workDir, /assistants\/assistant%3Afirst\/workspace$/);
    assert.throws(
      () => store.updateAgent(second.agentId, { workDir: first.workDir }),
      (error) => error.code === "ASSISTANT_WORKSPACE_CONFLICT"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy shared Assistant workspaces are split during store migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-assistant-workspace-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const sharedWorkspace = join(directory, "legacy-shared-workspace");
  const firstStore = new CorptieStore({ dbPath, configPath });

  try {
    await firstStore.initialize();
    firstStore.createAgent({ id: "assistant:first", name: "First", role: "assistant" });
    firstStore.createAgent({ id: "assistant:second", name: "Second", role: "assistant" });
    firstStore.db.run("DROP INDEX idx_agents_assistant_work_dir");
    firstStore.db.run(
      "UPDATE agents SET work_dir = ? WHERE agent_id IN (?, ?)",
      [sharedWorkspace, "assistant:first", "assistant:second"]
    );
    await firstStore.close();

    const migratedStore = new CorptieStore({ dbPath, configPath });
    try {
      await migratedStore.initialize();
      const first = migratedStore.getAgent("assistant:first");
      const second = migratedStore.getAgent("assistant:second");
      assert.notEqual(first.workDir.toLowerCase(), second.workDir.toLowerCase());
      assert.equal([first.workDir, second.workDir].includes(sharedWorkspace), true);
    } finally {
      await migratedStore.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy Agent lifecycle status is repaired even with an active Session binding and cannot be reintroduced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-agent-status-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const first = new CorptieStore({ dbPath, configPath });

  try {
    await first.initialize();
    first.createAgent({ id: "agent:legacy-inactive", name: "Legacy", role: "assistant" });
    first.upsertSession({
      id: "codex:deleted-session",
      title: "Deleted",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    const core = new CollaborationCore(first);
    core.bindSession({ agentId: "agent:legacy-inactive", sessionId: "codex:deleted-session" });
    first.db.run("UPDATE agents SET status = 'inactive' WHERE agent_id = ?", ["agent:legacy-inactive"]);
    first.db.run(
      "DELETE FROM data_migrations WHERE migration_id = ?",
      ["agent-always-available-v1"]
    );
    await first.close();

    const migrated = new CorptieStore({ dbPath, configPath });
    await migrated.initialize();
    assert.equal(migrated.getAgent("agent:legacy-inactive").status, "available");
    migrated.updateAgent("agent:legacy-inactive", { status: "inactive" });
    assert.equal(migrated.getAgent("agent:legacy-inactive").status, "available");
    await migrated.close();

    const restarted = new CorptieStore({ dbPath, configPath });
    await restarted.initialize();
    assert.equal(restarted.getAgent("agent:legacy-inactive").status, "available");
    assert.equal(
      restarted.getAgent("agent:legacy-inactive").currentSessionId,
      "codex:deleted-session"
    );
    await restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("logical Session owns the canonical unique name and preserves renamed aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-identity-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.createAgent({ id: "agent:stable-name", name: "Stable Agent", role: "assistant" });
    store.upsertSession({
      id: "codex:provider-thread",
      title: "original_agent",
      agent: "Codex",
      provider: "codex-app-server",
      cwd: directory,
      status: "complete"
    });
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:stable-session",
      legacySessionId: "codex:provider-thread",
      providerThreadId: "provider-thread",
      providerId: "codex-app-server",
      boundCwd: directory,
      title: "original_agent"
    });
    new CollaborationCore(store).bindSession({
      agentId: "agent:stable-name",
      sessionId: "codex:provider-thread"
    });

    store.renameSession("logical:stable-session", "renamed_agent");

    assert.equal(store.getAgent("agent:stable-name").name, "Stable Agent");
    assert.equal(store.getLogicalSession("logical:stable-session").sessionName, "renamed_agent");
    assert.equal(store.getSession("codex:provider-thread").title, "renamed_agent");
    assert.equal(store.getLogicalSessionByName("renamed_agent").logicalSessionId, "logical:stable-session");
    assert.equal(store.getLogicalSessionByName("original_agent").logicalSessionId, "logical:stable-session");

    store.updateAgent("agent:stable-name", { name: "Renamed Agent" });
    assert.equal(store.getSession("codex:provider-thread").title, "renamed_agent");
    assert.equal(store.getLogicalSession("logical:stable-session").sessionName, "renamed_agent");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("active Provider Session ids are scoped by Provider and survive store restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-ownership-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const first = new CorptieStore({ dbPath, configPath });

  try {
    await first.initialize();
    first.createLogicalSessionRoute({
      logicalSessionId: "logical:openclacky-owned",
      legacySessionId: "openclacky:owned-native",
      providerThreadId: "owned-native",
      providerId: "openclacky",
      providerSessionId: "owned-native",
      boundCwd: directory,
      title: "Owned OpenClacky Session"
    });
    first.createLogicalSessionRoute({
      logicalSessionId: "logical:other-provider",
      legacySessionId: "other:foreign-native",
      providerThreadId: "foreign-native",
      providerId: "other-provider",
      providerSessionId: "foreign-native",
      boundCwd: directory,
      title: "Other Provider Session"
    });
    await first.close();

    const restarted = new CorptieStore({ dbPath, configPath });
    try {
      await restarted.initialize();
      assert.deepEqual(restarted.listActiveProviderSessionIds("openclacky"), ["owned-native"]);
      assert.deepEqual(restarted.listActiveProviderSessionIds("other-provider"), ["foreign-native"]);
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy workspace transition tables migrate to support regular directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-directory-transition-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE workspace_transitions (
      transition_id TEXT PRIMARY KEY,
      logical_session_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      target_worktree_id TEXT NOT NULL,
      source_routing_version INTEGER NOT NULL,
      last_completed_turn_id TEXT,
      new_thread_id TEXT,
      phase TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'fork',
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.close();
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });

  try {
    await store.initialize();
    const columns = store.selectAll("PRAGMA table_info(workspace_transitions)");
    assert.equal(columns.find((column) => column.name === "target_worktree_id")?.notnull, 0);
    assert.equal(columns.find((column) => column.name === "target_cwd")?.notnull, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("initialization refuses a corrupt database instead of replacing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-corrupt-sqlite-"));
  const dbPath = join(directory, "corptie.sqlite");
  const corruptBytes = Buffer.from("not a sqlite database");

  try {
    await writeFile(dbPath, corruptBytes);
    const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await assert.rejects(store.initialize(), /database|malformed|encrypted/i);
    assert.deepEqual(await readFile(dbPath), corruptBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git workspace snapshots persist stable repository and worktree identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-git-registry-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  const snapshot = {
    repository: {
      id: "repository:abc",
      commonGitDirCanonicalPath: "/repo/.git",
      discoveredAt: "2026-07-28T00:00:00.000Z",
      lastValidatedAt: "2026-07-28T00:00:00.000Z"
    },
    inventoryVersion: "inventory-v1",
    observedAt: "2026-07-28T00:00:00.000Z",
    worktrees: [{
      worktreeId: "worktree:main",
      path: "/repo",
      canonicalPath: "/repo",
      gitDirCanonicalPath: "/repo/.git",
      isMain: true,
      availability: "available",
      headOid: "abc123",
      branchRef: "refs/heads/main",
      branchName: "main",
      isDetached: false,
      isLocked: false,
      lockReason: null,
      isPrunable: false,
      pruneReason: null
    }]
  };

  try {
    await store.initialize();
    const persisted = store.upsertGitWorkspaceSnapshot(snapshot);
    assert.deepEqual(store.getGitRepository("repository:abc"), snapshot.repository);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].worktreeId, "worktree:main");
    assert.equal(persisted[0].branchName, "main");

    const nextSnapshot = {
      ...snapshot,
      inventoryVersion: "inventory-v2",
      observedAt: "2026-07-28T00:01:00.000Z",
      repository: {
        ...snapshot.repository,
        lastValidatedAt: "2026-07-28T00:01:00.000Z"
      },
      worktrees: []
    };
    const missing = store.upsertGitWorkspaceSnapshot(nextSnapshot);
    assert.equal(missing[0].availability, "missing");
    assert.equal(missing[0].inventoryVersion, "inventory-v2");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unchanged Git workspace snapshots skip SQLite writes, audit, and dirty notifications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-git-noop-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const snapshot = workspaceSnapshot();
    store.upsertGitWorkspaceSnapshot(snapshot);
    const before = store.selectOne("SELECT total_changes() AS count").count;
    let dirtyCount = 0;
    let auditCount = 0;
    store.setStateDirtyListener(() => { dirtyCount += 1; });
    store.auditObjectiveWorkItemAssociations = () => { auditCount += 1; };
    const repeated = {
      ...snapshot,
      observedAt: "2099-01-01T00:00:00.000Z",
      repository: { ...snapshot.repository, lastValidatedAt: "2099-01-01T00:00:00.000Z" },
      worktrees: snapshot.worktrees.map((worktree) => ({
        ...worktree,
        observedAt: "2099-01-01T00:00:00.000Z"
      }))
    };
    store.upsertGitWorkspaceSnapshot(repeated);
    const after = store.selectOne("SELECT total_changes() AS count").count;
    assert.equal(after, before);
    assert.equal(dirtyCount, 0);
    assert.equal(auditCount, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("logical session route commits switch the active thread and workspace atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-logical-session-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertGitWorkspaceSnapshot(workspaceSnapshot());
    store.upsertSession({
      id: "codex:thread-source",
      title: "Stable UI session",
      agent: "Codex",
      provider: "codex-app-server",
      cwd: "/repo/main",
      status: "complete",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z"
    });

    const created = store.createLogicalSessionRoute({
      logicalSessionId: "logical:one",
      legacySessionId: "codex:thread-source",
      providerThreadId: "thread-source",
      repositoryId: "repository:one",
      worktreeId: "worktree:main",
      boundCwd: "/repo/main",
      instructionSources: ["/repo/main/AGENTS.md"],
      permissionSnapshot: { sandbox: "workspaceWrite", writableRoots: ["/repo/main"] },
      title: "Stable UI session",
      createdAt: "2026-07-28T00:00:00.000Z"
    });
    assert.equal(created.activeThreadId, "thread-source");
    assert.equal(created.activeWorkspaceId, "worktree:main");
    assert.equal(created.routingVersion, 1);
    assert.match(created.activeBinding.bindingId, /^binding:/);
    assert.equal(created.activeBinding.providerId, "codex-app-server");
    assert.equal(created.activeBinding.providerSessionId, "thread-source");
    assert.deepEqual(created.activeBinding.providerMetadata, {});
    assert.deepEqual(
      store.getAgentSessionBindingByProviderSession("codex-app-server", "thread-source"),
      created.activeBinding
    );
    assert.equal(store.assertLogicalSessionRoute("logical:one"), true);

    store.beginWorkspaceTransition({
      transitionId: "transition:one",
      logicalSessionId: "logical:one",
      targetWorktreeId: "worktree:feature",
      sourceRoutingVersion: 1,
      lastCompletedTurnId: "turn-7",
      strategy: "fork",
      phase: "forking",
      createdAt: "2026-07-28T00:01:00.000Z"
    });
    store.updateWorkspaceTransition("transition:one", {
      phase: "validatingInstructions",
      newThreadId: "thread-feature",
      updatedAt: "2026-07-28T00:02:00.000Z"
    });
    const switched = store.commitWorkspaceTransition("transition:one", {
      providerThreadId: "thread-feature",
      boundCwd: "/repo/feature worktree",
      instructionSources: ["/repo/feature worktree/AGENTS.md"],
      permissionSnapshot: {
        sandbox: "workspaceWrite",
        writableRoots: ["/repo/feature worktree"]
      },
      createdAt: "2026-07-28T00:03:00.000Z"
    });

    assert.equal(switched.logicalSessionId, "logical:one");
    assert.equal(switched.activeThreadId, "thread-feature");
    assert.equal(switched.activeWorkspaceId, "worktree:feature");
    assert.equal(switched.routingVersion, 2);
    assert.equal(switched.transitionState, null);
    assert.equal(store.assertLogicalSessionRoute("logical:one"), true);
    assert.equal(store.getSession("codex:thread-source").external.cwd, "/repo/feature worktree");

    const bindings = store.listProviderThreadBindings("logical:one");
    assert.deepEqual(bindings.map((binding) => binding.state), ["superseded", "active"]);
    assert.notEqual(bindings[0].bindingId, bindings[1].bindingId);
    assert.equal(bindings[1].providerId, "codex-app-server");
    assert.equal(bindings[1].providerSessionId, "thread-feature");
    assert.equal(bindings[1].parentBindingId, bindings[0].bindingId);
    assert.equal(bindings[1].parentThreadId, "thread-source");
    assert.equal(bindings[1].forkedAtTurnId, "turn-7");
    assert.deepEqual(bindings[1].instructionSources, ["/repo/feature worktree/AGENTS.md"]);
    assert.deepEqual(bindings[1].permissionSnapshot.writableRoots, ["/repo/feature worktree"]);
    assert.equal(store.getWorkspaceTransition("transition:one").phase, "committed");

    const retried = store.commitWorkspaceTransition("transition:one", {
      providerThreadId: "thread-feature",
      boundCwd: "/repo/feature worktree"
    });
    assert.equal(retried.routingVersion, 2);

    store.beginWorkspaceTransition({
      transitionId: "transition:two",
      logicalSessionId: "logical:one",
      targetWorktreeId: "worktree:main",
      sourceRoutingVersion: 2,
      lastCompletedTurnId: "turn-8",
      strategy: "fork",
      phase: "forking",
      createdAt: "2026-07-28T00:04:00.000Z"
    });
    store.updateWorkspaceTransition("transition:two", {
      phase: "validatingInstructions",
      newThreadId: "thread-main-again",
      updatedAt: "2026-07-28T00:05:00.000Z"
    });
    store.commitWorkspaceTransition("transition:two", {
      providerThreadId: "thread-main-again",
      boundCwd: "/repo/main",
      createdAt: "2026-07-28T00:06:00.000Z"
    });
    store.updateWorkspaceTransitionContinuation("transition:one", {
      state: "failed",
      error: "Late failure from a superseded route.",
      updatedAt: "2026-07-28T00:07:00.000Z"
    });
    assert.equal(
      store.getLatestCommittedWorkspaceTransition("logical:one").transitionId,
      "transition:two"
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("logical session transitions reject stale routing versions without changing the active route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-logical-session-stale-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertGitWorkspaceSnapshot(workspaceSnapshot());
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:stale",
      providerThreadId: "thread-source",
      repositoryId: "repository:one",
      worktreeId: "worktree:main",
      boundCwd: "/repo/main"
    });

    assert.throws(
      () => store.beginWorkspaceTransition({
        transitionId: "transition:stale",
        logicalSessionId: "logical:stale",
        targetWorktreeId: "worktree:feature",
        sourceRoutingVersion: 0
      }),
      /routing version changed/
    );
    const logical = store.getLogicalSession("logical:stale");
    assert.equal(logical.activeThreadId, "thread-source");
    assert.equal(logical.activeWorkspaceId, "worktree:main");
    assert.equal(logical.routingVersion, 1);
    assert.equal(logical.transitionState, null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session Provider binding migration backfills legacy thread identities idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-binding-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const first = new CorptieStore({ dbPath, configPath });
  try {
    await first.initialize();
    first.upsertSession({
      id: "codex:legacy-thread",
      title: "Legacy Provider Binding",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    first.createLogicalSessionRoute({
      logicalSessionId: "logical:legacy-provider",
      legacySessionId: "codex:legacy-thread",
      providerThreadId: "legacy-thread",
      boundCwd: "/repo/legacy"
    });
    first.db.run(
      `UPDATE provider_thread_bindings
       SET binding_id = NULL, provider_id = NULL, provider_session_id = NULL
       WHERE provider_thread_id = 'legacy-thread'`
    );
  } finally {
    await first.close();
  }

  const second = new CorptieStore({ dbPath, configPath });
  try {
    await second.initialize();
    const migrated = second.getProviderThreadBinding("legacy-thread");
    assert.match(migrated.bindingId, /^binding:/);
    assert.equal(migrated.providerId, "codex-app-server");
    assert.equal(migrated.providerSessionId, "legacy-thread");
    assert.deepEqual(migrated.providerMetadata, {});
    const stableBindingId = migrated.bindingId;
    await second.close();

    const third = new CorptieStore({ dbPath, configPath });
    await third.initialize();
    try {
      assert.equal(third.getProviderThreadBinding("legacy-thread").bindingId, stableBindingId);
    } finally {
      await third.close();
    }
  } finally {
    if (second.db) await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stable Codex session id can route to a different active provider thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-stable-session-provider-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "codex:stable-ui-id",
      title: "Stable UI",
      agent: "Codex",
      provider: "codex-app-server",
      cwd: "/repo/feature",
      status: "complete",
      external: {
        provider: "codex-app-server",
        threadId: "provider-thread-after-fork",
        cwd: "/repo/feature",
        logicalSessionId: "logical:stable",
        workspace: {
          id: "worktree:feature",
          repositoryId: "repository:one",
          path: "/repo/feature"
        },
        routingVersion: 3
      }
    });

    const restored = store.getSession("codex:stable-ui-id");
    assert.equal(restored.id, "codex:stable-ui-id");
    assert.equal(restored.external.threadId, "provider-thread-after-fork");
    assert.equal(restored.external.logicalSessionId, "logical:stable");
    assert.equal(restored.external.workspace.id, "worktree:feature");
    assert.equal(restored.external.routingVersion, 3);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function workspaceSnapshot() {
  return {
    repository: {
      id: "repository:one",
      commonGitDirCanonicalPath: "/repo/main/.git",
      discoveredAt: "2026-07-28T00:00:00.000Z",
      lastValidatedAt: "2026-07-28T00:00:00.000Z"
    },
    inventoryVersion: "inventory:one",
    observedAt: "2026-07-28T00:00:00.000Z",
    worktrees: [
      {
        worktreeId: "worktree:main",
        path: "/repo/main",
        canonicalPath: "/repo/main",
        gitDirCanonicalPath: "/repo/main/.git",
        isMain: true,
        availability: "available",
        headOid: "abc123",
        branchRef: "refs/heads/main",
        branchName: "main",
        isDetached: false,
        isLocked: false,
        lockReason: null,
        isPrunable: false,
        pruneReason: null
      },
      {
        worktreeId: "worktree:feature",
        path: "/repo/feature worktree",
        canonicalPath: "/repo/feature worktree",
        gitDirCanonicalPath: "/repo/main/.git/worktrees/feature",
        isMain: false,
        availability: "available",
        headOid: "def456",
        branchRef: "refs/heads/feature/workspace",
        branchName: "feature/workspace",
        isDetached: false,
        isLocked: false,
        lockReason: null,
        isPrunable: false,
        pruneReason: null
      }
    ]
  };
}
