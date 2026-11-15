import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { TimelineReadRepository } from "../src/store/repositories/timelineReadRepository.mjs";

test("legacy terminal messages with absent or non-object metadata load across timeline read paths", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-null-timeline", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    store.createAgent({ id: "agent:test", name: "Test" });
    store.upsertSession({ id: "session:test", title: "Test", agentId: "agent:test", provider: "test", status: "idle" });
    const variants = [null, "null", "[]", "false", "42", '"text"', "{broken", "{}",
      JSON.stringify({ userMessageStatus: "queued", taskId: "message:8", queuePosition: 1 })];
    for (let i = 0; i <= variants.length; i += 1) {
      store.createUserMessageDelivery({ deliveryId: `delivery:${i}`, messageId: `message:${i}`,
        sessionId: "session:test", agentId: "agent:test", text: `preserved ${i}`,
        binding: { bindingId: "binding:test", providerId: "test", providerSessionId: "thread:test", routingVersion: 1 } });
      if (i === variants.length) continue; // A healthy queued message must stay queued.
      store.updateAgentTask(`message:${i}`, { status: i % 2 ? "cancelled" : "failed",
        lastError: "VERIFICATION_BUDGET_EXHAUSTED",
        source: { dispatchBlock: { kind: "waiting", code: "VERIFICATION_BUDGET_EXHAUSTED", message: "预算用尽" } } });
      store.db.run("UPDATE session_items SET status=?,turn_status='inProgress',raw_metadata_json=? WHERE session_id=? AND id=?",
        [i % 2 ? "cancelled" : "failed", variants[i], "session:test", `message:${i}`]);
    }
    const snapshot = () => store.selectAll("SELECT * FROM session_items WHERE session_id=? ORDER BY id", ["session:test"]);
    const before = snapshot();
    let operationQueries = 0;
    const repo = new TimelineReadRepository({
      selectAll: (sql, args) => { if (sql.includes("FROM agent_operations")) operationQueries += 1; return store.selectAll(sql, args); },
      selectOne: (sql, args) => { if (sql.includes("FROM agent_operations")) operationQueries += 1; return store.selectOne(sql, args); },
      getSession: id => store.getSession(id)
    });
    for (const provider of ["codex-app-server", "claude-code", "future-provider"]) {
      for (const read of [
        () => repo.getLatestTimelineItemWindow("session:test", { provider }),
        () => repo.getSessionTimelineHistoryPage("session:test", { provider }),
        () => repo.getTimelineItemWindow("session:test", { anchorId: "message:0", provider })
      ]) {
        operationQueries = 0;
        const result = read();
        assert.equal(operationQueries, 1, "one batched operation lookup per page, not one per message");
        for (let i = 0; i < variants.length; i += 1) {
          const item = result.items.find(item => item.id === `message:${i}`);
          assert.ok(item);
          assert.equal(item.text, `preserved ${i}`);
          assert.equal(item.userMessageStatus, i % 2 ? "cancelled" : "failed");
          assert.equal(item.turnStatus, item.userMessageStatus);
          assert.equal(item.queuePosition, null);
          assert.match(item.processingError, /VERIFICATION_BUDGET_EXHAUSTED/);
          assert.equal(item.executionBlock.kind, "settled");
        }
        const queued = result.items.find(item => item.id === `message:${variants.length}`);
        assert.ok(queued);
        assert.notEqual(queued.userMessageStatus, "failed");
        assert.equal(queued.status, before.find(item => item.id === queued.id).status);
      }
    }
    assert.deepEqual(snapshot(), before, "reading compatibility must not rewrite historical rows");
  } finally {
    await store.close();
  }
});

test("terminal messages without operations retain their final status without fabricated errors", () => {
  let queries = 0;
  const repo = new TimelineReadRepository({ selectAll: () => { queries += 1; return []; } });
  const operations = repo.legacyTerminalOperations([
    { id: "missing", type: "userMessage", status: "failed", turn_status: "inProgress", raw_metadata_json: null }
  ], "session:test");
  const item = repo.normalizeItem({ id: "missing", type: "userMessage", status: "failed", turnStatus: "inProgress", rawMetadataJSON: null }, "test", "session:test", operations);
  assert.equal(queries, 1);
  assert.equal(item.userMessageStatus, "failed");
  assert.equal(item.turnStatus, "failed");
  assert.equal(item.processingError, null);
});
