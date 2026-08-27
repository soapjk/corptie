import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-eventsourcing-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { store, directory };
}

test("appendSessionEvent：sequence 单调递增且真实落库", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const e1 = store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "user/message", payload: { text: "a" } });
    const e2 = store.appendSessionEvent({ eventId: "e2", sessionId: "s1", type: "assistant/message", payload: { text: "b" } });
    assert.equal(e1.sequence, 1);
    assert.equal(e2.sequence, 2);
    const listed = store.listSessionEvents("s1");
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((e) => e.sequence), [1, 2]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Automation Session 事件按原始 envelope、类型和时间戳可检索", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const envelope = {
      task: {
        taskId: "scheduled_task:b2",
        name: "Shadow exit monitor",
        trigger: { type: "processExit" },
        lastRunId: null,
        lastRunStatus: null
      },
      run: null
    };
    store.appendSessionEvent({
      eventId: "automation-created",
      sessionId: "s1",
      type: "ScheduledSessionTaskCreated",
      source: { type: "scheduled_session_task", taskId: "scheduled_task:b2" },
      payload: envelope,
      createdAt: "2026-08-24T00:56:04.649Z"
    });
    store.appendSessionEvent({
      eventId: "ordinary-message",
      sessionId: "s1",
      type: "user/message",
      payload: { text: "not automation" },
      createdAt: "2026-08-24T00:56:05.000Z"
    });

    const [event] = store.listSessionAutomationEvents("s1");
    assert.equal(event.type, "ScheduledSessionTaskCreated");
    assert.equal(event.createdAt, "2026-08-24T00:56:04.649Z");
    assert.deepEqual(event.payload, envelope);
    assert.deepEqual(event.source, { type: "scheduled_session_task", taskId: "scheduled_task:b2" });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("appendSessionEvent：event_id 冲突时显式抛错，不返回虚假 sequence", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    assert.equal(store.hasSessionEvent("dup"), false);
    store.appendSessionEvent({ eventId: "dup", sessionId: "s1", type: "message", payload: {} });
    assert.equal(store.hasSessionEvent("dup"), true);
    assert.throws(
      () => store.appendSessionEvent({ eventId: "dup", sessionId: "s1", type: "message", payload: {} }),
      /Duplicate event_id/
    );
    // 冲突未落库，sequence 仍为 1
    assert.equal(store.listSessionEvents("s1").length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("appendSessionEvent：surface / producer / call_id / source_event_seqs 落库", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const event = store.appendSessionEvent({
      eventId: "e1",
      sessionId: "s1",
      type: "tool/call",
      producer: "skill:foo",
      surface: false,
      callId: "call-1",
      sourceEventSeqs: [3],
      payload: { name: "run" }
    });
    assert.equal(event.producer, "skill:foo");
    assert.equal(event.surface, false);
    assert.equal(event.callId, "call-1");
    assert.deepEqual(event.sourceEventSeqs, [3]);

    const listed = store.listSessionEvents("s1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].producer, "skill:foo");
    assert.equal(listed[0].surface, false);
    assert.equal(listed[0].callId, "call-1");
    assert.deepEqual(listed[0].sourceEventSeqs, [3]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("appendSessionEvent：surface 按类型推导（user/message → true）", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const event = store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "user/message", payload: { text: "hi" } });
    assert.equal(event.surface, true);
    assert.equal(store.listSessionEvents("s1")[0].surface, true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("listLatestSessionMessageTimes：只按消息事件返回每个 Session 的最新时间", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    store.appendSessionEvent({
      eventId: "message-1", sessionId: "s1", type: "user/message", surface: true,
      payload: { text: "hello" }, createdAt: "2026-08-20T01:00:00Z"
    });
    store.appendSessionEvent({
      eventId: "tool", sessionId: "s1", type: "tool/call", surface: false,
      payload: { name: "exec" }, createdAt: "2026-08-20T03:00:00Z"
    });
    store.appendSessionEvent({
      eventId: "message-2", sessionId: "s1", type: "CodexThreadCompleted", surface: false,
      payload: {}, createdAt: "2026-08-20T02:00:00Z"
    });

    assert.equal(store.listLatestSessionMessageTimes().get("s1"), "2026-08-20T02:00:00Z");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session 列表消息聚合使用稀疏索引且不创建临时排序 B-tree", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    store.appendSessionEvent({
      eventId: "status-noise", sessionId: "s1", type: "ProviderSessionChanged",
      payload: { status: "running" }, createdAt: "2026-08-20T00:00:00Z"
    });
    store.appendSessionEvent({
      eventId: "message", sessionId: "s1", type: "SessionUserMessageCreated",
      payload: { text: "hello" }, createdAt: "2026-08-20T01:00:00Z"
    });
    store.appendSessionEvent({
      eventId: "completion", sessionId: "s1", type: "AgentTurnCompleted",
      payload: { hasAgentMessage: true }, createdAt: "2026-08-20T02:00:00Z"
    });

    const originalSelectAll = store.selectAll.bind(store);
    const capturedSQL = [];
    store.selectAll = (sql, params = []) => {
      capturedSQL.push(sql);
      return originalSelectAll(sql, params);
    };
    store.listLatestSessionMessageTimes();
    store.listSessionMessageCursors();
    store.selectAll = originalSelectAll;

    const plans = capturedSQL.map((sql) => originalSelectAll(`EXPLAIN QUERY PLAN ${sql}`)
      .map((row) => row.detail)
      .join("\n"));
    assert.match(plans[0], /idx_session_events_latest_message/);
    assert.match(plans[1], /idx_session_events_agent_message/);
    assert.doesNotMatch(plans.join("\n"), /USE TEMP B-TREE/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session 未读游标：只计算 Agent 正文并持久化单调已读回执", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "running" });
    store.appendSessionEvent({ eventId: "user", sessionId: "s1", type: "user/message", payload: { text: "hi" } });
    store.appendSessionEvent({ eventId: "tool", sessionId: "s1", type: "tool/call", payload: { name: "exec" } });
    store.appendSessionEvent({
      eventId: "reasoning", sessionId: "s1", type: "assistant/message",
      payload: { text: "thinking", itemType: "reasoning" }
    });
    assert.deepEqual(store.listSessionMessageCursors().get("s1"), {
      lastAgentMessageSequence: 0,
      lastReadMessageSequence: 0
    });

    store.appendSessionEvent({
      eventId: "answer", sessionId: "s1", type: "assistant/message",
      payload: { text: "done", itemType: "agentMessage" }
    });
    assert.equal(store.lastAgentMessageSequence("s1"), 0, "a reply is not unread before the turn completes");
    const completion = store.appendSessionEvent({
      eventId: "completion", sessionId: "s1", type: "AgentTurnCompleted",
      payload: { hasAgentMessage: true, session: { status: "complete", summary: "done" } }
    });
    assert.equal(store.lastAgentMessageSequence("s1"), completion.sequence);
    const beforeRevision = store.stateRevision();
    assert.deepEqual(store.markSessionMessagesRead("s1", completion.sequence), {
      lastAgentMessageSequence: completion.sequence,
      lastReadMessageSequence: completion.sequence
    });
    assert.ok(store.stateRevision() > beforeRevision, "receipt change must invalidate the Session projection");

    const readRevision = store.stateRevision();
    store.markSessionMessagesRead("s1", 0);
    assert.equal(store.listSessionMessageCursors().get("s1").lastReadMessageSequence, completion.sequence);
    assert.equal(store.stateRevision(), readRevision, "an older receipt must be a no-op");
    assert.throws(() => store.markSessionMessagesRead("s1", completion.sequence + 1), /Invalid read sequence/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session 未读游标：迁移完成后新消息没有隐式已读回执", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const completion = store.appendSessionEvent({
      eventId: "completion", sessionId: "s1", type: "CodexThreadCompleted",
      payload: { hasAgentMessage: true, session: { status: "complete", summary: "done" } }
    });
    // A newly created Session after migration has no implicit receipt.
    assert.deepEqual(store.listSessionMessageCursors().get("s1"), {
      lastAgentMessageSequence: completion.sequence,
      lastReadMessageSequence: 0
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical completion migration repairs history as read and future receipts use one high-water mark", async () => {
  const { store, directory } = await createStore();
  const dbPath = join(directory, "corptie.sqlite");
  let reopened = null;
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const historical = [];
    for (let index = 1; index <= 10; index += 1) {
      historical.push(store.appendSessionEvent({
        eventId: `canonical-history-${index}`,
        sessionId: "s1",
        type: "turn.completed",
        payload: {
          turnId: `turn:${index}`,
          items: [{
            id: `answer:${index}`,
            turnId: `turn:${index}`,
            type: "agentMessage",
            presentationRole: "final_answer",
            text: `answer ${index}`
          }]
        }
      }));
    }
    assert.equal(store.lastAgentMessageSequence("s1"), 0);
    store.insertProviderInboxEvent({
      providerId: "codex-app-server",
      providerSessionId: "provider:s1",
      providerEventId: "provider:completion",
      bindingId: "binding:s1",
      logicalSessionId: "logical:s1",
      routingVersion: 1,
      providerSequence: 10,
      turnId: "turn:10",
      itemId: null,
      type: "turn.completed",
      occurredAt: "2026-08-26T10:00:00.000Z",
      receivedAt: "2026-08-26T10:00:00.010Z",
      payload: {},
      rawPayload: {}
    }, "s1");
    store.db.run(
      "DELETE FROM data_migrations WHERE migration_id = ?",
      ["session-events-canonical-agent-message-v2"]
    );
    await store.close();

    reopened = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await reopened.initialize();
    const historicalCursor = historical.at(-1).sequence;
    assert.ok(reopened.canonicalUnreadMigrationBackupPath);
    await access(reopened.canonicalUnreadMigrationBackupPath);
    assert.deepEqual(reopened.canonicalUnreadMigrationAudit, {
      scannedEvents: 10,
      repairedEvents: 10,
      affectedSessions: 1,
      adjustedReceipts: 1
    });
    const backupReader = new DatabaseSync(reopened.canonicalUnreadMigrationBackupPath, { readOnly: true });
    assert.equal(backupReader.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(backupReader.prepare(
      "SELECT SUM(has_agent_message) AS count FROM session_events WHERE type = 'turn.completed'"
    ).get().count, 0);
    backupReader.close();
    assert.deepEqual(reopened.listSessionMessageCursors().get("s1"), {
      lastAgentMessageSequence: historicalCursor,
      lastReadMessageSequence: historicalCursor
    });
    assert.equal(reopened.selectOne(
      "SELECT COUNT(*) AS count FROM session_events WHERE type = 'turn.completed' AND has_agent_message = 1"
    ).count, 10);

    const future = [];
    for (let index = 1; index <= 10; index += 1) {
      future.push(reopened.appendSessionEvent({
        eventId: `canonical-future-${index}`,
        sessionId: "s1",
        type: "turn.completed",
        payload: { hasAgentMessage: true, turnId: `turn:future:${index}` }
      }));
    }
    const latestFutureCursor = future.at(-1).sequence;
    assert.deepEqual(reopened.listSessionMessageCursors().get("s1"), {
      lastAgentMessageSequence: latestFutureCursor,
      lastReadMessageSequence: historicalCursor
    });
    assert.deepEqual(reopened.markSessionMessagesRead("s1", latestFutureCursor), {
      lastAgentMessageSequence: latestFutureCursor,
      lastReadMessageSequence: latestFutureCursor
    });
  } finally {
    if (reopened) await reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session_logs：创建 session 即建立 1:1 log，事件指向该 log", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const log = store.selectOne("SELECT * FROM session_logs WHERE session_id = ?", ["s1"]);
    assert.ok(log, "session_log 应存在");
    assert.equal(log.id, "log:s1");

    const event = store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "message", payload: {} });
    assert.equal(event.logId, "log:s1");
    const row = store.selectOne("SELECT log_id FROM session_events WHERE event_id = ?", ["e1"]);
    assert.equal(row.log_id, "log:s1");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("has_agent_message migration is retryable and removes JSON from hot cursor reads", async () => {
  const { store, directory } = await createStore();
  const dbPath = join(directory, "corptie.sqlite");
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    store.appendSessionEvent({
      eventId: "completion",
      sessionId: "s1",
      type: "AgentTurnCompleted",
      payload: { hasAgentMessage: true, text: "sensitive message that must not enter metrics" }
    });
    store.db.run("UPDATE session_events SET has_agent_message = 0");
    store.db.run("DELETE FROM data_migrations WHERE migration_id = ?", ["session-events-has-agent-message-v1"]);
    await store.close();

    const reopened = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await reopened.initialize();
    assert.equal(reopened.selectOne(
      "SELECT has_agent_message FROM session_events WHERE event_id = ?",
      ["completion"]
    ).has_agent_message, 1);
    assert.equal(reopened.lastAgentMessageSequence("s1"), 1);

    const originalSelectAll = reopened.selectAll.bind(reopened);
    const sql = [];
    reopened.selectAll = (statement, params = []) => {
      sql.push(statement);
      return originalSelectAll(statement, params);
    };
    reopened.listSessionMessageCursors();
    assert.doesNotMatch(sql.join("\n"), /json_extract/i);
    assert.match(sql.join("\n"), /has_agent_message/);
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy schema receives a verified local backup before adding the cursor column", async () => {
  const { store, directory } = await createStore();
  const dbPath = join(directory, "corptie.sqlite");
  try {
    await store.close();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      DROP INDEX IF EXISTS idx_session_events_agent_message;
      DROP TRIGGER IF EXISTS state_sync_session_events_agent_message_insert;
      DELETE FROM data_migrations WHERE migration_id = 'session-events-has-agent-message-v1';
      ALTER TABLE session_events DROP COLUMN has_agent_message;
    `);
    legacy.close();

    const migrated = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await migrated.initialize();
    assert.ok(migrated.performanceMigrationBackupPath);
    await access(migrated.performanceMigrationBackupPath);
    assert.ok(migrated.selectAll("PRAGMA table_info(session_events)")
      .some((column) => column.name === "has_agent_message"));
    const backupReader = new DatabaseSync(migrated.performanceMigrationBackupPath, { readOnly: true });
    assert.equal(backupReader.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(backupReader.prepare("PRAGMA table_info(session_events)").all()
      .some((column) => column.name === "has_agent_message"), false);
    backupReader.close();
    await migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sequence history pages are latest-first windows returned ascending without overlap", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "paged", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    for (let sequence = 1; sequence <= 520; sequence += 1) {
      store.appendSessionEvent({
        eventId: `event-${sequence}`,
        sessionId: "paged",
        type: "tool/call",
        payload: { sequence }
      });
    }
    const latest = store.listSessionEventPage("paged", { limit: 200 });
    const prior = store.listSessionEventPage("paged", { beforeSequence: latest[0].sequence, limit: 200 });
    const oldest = store.listSessionEventPage("paged", { beforeSequence: prior[0].sequence, limit: 200 });
    assert.deepEqual([latest[0].sequence, latest.at(-1).sequence], [321, 520]);
    assert.deepEqual([prior[0].sequence, prior.at(-1).sequence], [121, 320]);
    assert.deepEqual([oldest[0].sequence, oldest.at(-1).sequence], [1, 120]);
    const sequences = [...oldest, ...prior, ...latest].map((event) => event.sequence);
    assert.equal(new Set(sequences).size, 520);
    assert.deepEqual(sequences, sequences.toSorted((left, right) => left - right));
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("query observability aggregates safe fingerprints and iterate releases on early exit", async () => {
  const { store, directory } = await createStore();
  try {
    store.selectOne("SELECT 'private-message' AS value, ? AS parameter", ["secret-payload"]);
    store.selectOne("SELECT 'another-message' AS value, ? AS parameter", ["different-secret"]);
    let visited = 0;
    for (const _row of store.iterate("SELECT name FROM sqlite_master ORDER BY name LIMIT 100")) {
      visited += 1;
      break;
    }
    assert.equal(visited, 1);
    const snapshot = store.queryMetrics({ limit: 1000 });
    const metric = snapshot.queries.find((entry) => entry.normalizedSql === "select ? as value, ? as parameter");
    assert.equal(metric.calls, 2);
    assert.equal(metric.totalRows, 2);
    assert.ok(snapshot.queries.some((entry) => entry.operation === "iterate" && entry.totalRows === 1));
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /private-message|another-message|secret-payload|different-secret/);
    assert.equal(typeof snapshot.eventLoopDelayMilliseconds.p95, "number");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
