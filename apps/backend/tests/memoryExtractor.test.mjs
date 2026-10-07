import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { MemoryExtractor, ownerForKind } from "../src/application/memoryExtractor.mjs";
import { createMemoryModelClassifier, parseMemoryModelOutput } from "../src/application/memoryModelClassifier.mjs";
import { MemoryExtractionScheduler } from "../src/application/memoryExtractionScheduler.mjs";
import { MemoryRecallService } from "../src/application/memoryRecallService.mjs";
import { HubService } from "../src/application/hubService.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-memory-model-"));
  const store = new CorptieStore({ dbPath: join(directory, "store.sqlite"),
    configPath: join(directory, "config.json") });
  await store.initialize();
  store.createAgent({ id: "agent:a", name: "A", role: "independentContributor" });
  store.createWork({ id: "work:a", name: "A", contributorAgentIds: ["agent:a"] });
  store.createTask({ id: "task:a", workId: "work:a", title: "A" });
  store.createSession({ id: "session:a", title: "A", provider: "test-provider", status: "running",
    sessionKind: "worker", agentId: "agent:a", workId: "work:a", taskId: "task:a" });
  return { store, directory, close: async () => {
    await store.close(); await rm(directory, { recursive: true, force: true });
  } };
}

function userEvent(store, eventId, text) {
  return store.appendSessionEvent({ eventId, sessionId: "session:a", type: "SessionUserMessageCreated",
    payload: { message: { text } } });
}

function proposal(event, overrides = {}) {
  return { eventSequence: event.sequence, evidence: event.text, content: event.text,
    kind: "preference", scope: "global", scopeRationale: "Across all projects",
    rationale: "Durable user preference", confidence: 0.99, conflict: false, ...overrides };
}

test("model extraction ignores tool records and can auto-activate a grounded Global preference", async () => {
  const f = await fixture();
  try {
    f.store.appendSessionEvent({ eventId: "tool", sessionId: "session:a", type: "tool.completed",
      payload: { text: "Run 500 instructions" } });
    userEvent(f.store, "user", "I prefer short answers across all projects.");
    const seen = [];
    const extractor = new MemoryExtractor({ store: f.store, classifyMany: async (events) => {
      seen.push(...events);
      return [proposal(events[0])];
    } });
    const [memory] = await extractor.extractFromSession("session:a");
    assert.deepEqual(seen.map((item) => item.role), ["user"]);
    assert.equal(memory.owner_type, "global");
    assert.equal(memory.owner_id, "user:local");
    assert.equal(memory.promotion_status, "active");
    assert.equal(memory.trust_level, "trusted");
    assert.equal(memory.auto_applied, 1);
    assert.equal(JSON.parse(memory.structured_json).extraction.evidence, seen[0].text);
    assert.equal((await extractor.extractFromSession("session:a")).length, 0);
  } finally { await f.close(); }
});

test("model can return zero or uncertain candidates; no keyword fallback advances cursor", async () => {
  const f = await fixture();
  try {
    userEvent(f.store, "user", "Please remember this preference.");
    const unavailable = new MemoryExtractor({ store: f.store });
    await assert.rejects(unavailable.extractFromSession("session:a"), { code: "MEMORY_MODEL_UNAVAILABLE" });
    assert.equal(f.store.getMemoryExtractionProgress("session:a"), 0);
    const zero = new MemoryExtractor({ store: f.store, classifyMany: async () => [] });
    assert.deepEqual(await zero.extractFromSession("session:a"), []);
    assert.equal(f.store.getMemoryExtractionProgress("session:a"), 1);
    userEvent(f.store, "second", "I prefer concise replies.");
    const review = new MemoryExtractor({ store: f.store, classifyMany: async (events) => [
      proposal(events[0], { scope: "task", confidence: 0.8 })
    ] });
    const [candidate] = await review.extractFromSession("session:a");
    assert.equal(candidate.owner_type, "task");
    assert.equal(candidate.promotion_status, "candidate");
    assert.equal(candidate.trust_level, "untrusted");
  } finally { await f.close(); }
});

test("unsupported model evidence leaves cursor unchanged for a retry", async () => {
  const f = await fixture();
  try {
    userEvent(f.store, "user", "Keep the response concise.");
    const bad = new MemoryExtractor({ store: f.store, classifyMany: async (events) => [
      proposal(events[0], { evidence: "text absent from source" })
    ] });
    await assert.rejects(bad.extractFromSession("session:a"), { code: "MEMORY_MODEL_INVALID_OUTPUT" });
    assert.equal(f.store.getMemoryExtractionProgress("session:a"), 0);
    assert.equal(f.store.listMemoriesByOwner("global", "user:local").length, 0);
  } finally { await f.close(); }
});

test("one user message can yield separate atomic memories with the same evidence event", async () => {
  const f = await fixture();
  try {
    userEvent(f.store, "user", "Keep answers short and use Chinese.");
    const extractor = new MemoryExtractor({ store: f.store, classifyMany: async (events) => [
      proposal(events[0], { content: "Prefer concise answers.", confidence: 0.8 }),
      proposal(events[0], { content: "Prefer Chinese replies.", confidence: 0.8 })
    ] });
    const created = await extractor.extractFromSession("session:a");
    assert.equal(created.length, 2);
    assert.deepEqual(created.map((item) => JSON.parse(item.source_event_seqs_json)), [[1], [1]]);
  } finally { await f.close(); }
});

test("explicit scope is independent of kind and Global is available without a Work", () => {
  assert.deepEqual(ownerForKind("procedure", { taskId: "task:a" }, "task"),
    { ownerType: "task", ownerId: "task:a" });
  assert.deepEqual(ownerForKind("fact", {}, "global"),
    { ownerType: "global", ownerId: "user:local" });
  assert.equal(ownerForKind("preference", {}, "work"), null);
});

test("model output must be bounded JSON", () => {
  assert.deepEqual(parseMemoryModelOutput('{"memories":[]}'), []);
  assert.throws(() => parseMemoryModelOutput("not JSON"), { code: "MEMORY_MODEL_INVALID_OUTPUT" });
});

test("model extraction uses the Session Provider through the common hidden background contract", async () => {
  let request;
  const classify = createMemoryModelClassifier({ backgroundAgent: {
    async run(input) {
      request = input;
      return { validatedOutput: [] };
    }
  }, cwd: "/tmp" });
  assert.deepEqual(await classify([{ sequence: 1, role: "user", text: "Preference" }], {
    scope: { providerId: "test-provider", taskId: "task:a" }, existing: []
  }), []);
  assert.equal(request.executionPolicy, "no-tools");
  assert.equal(request.preferredProviderId, "test-provider");
  assert.equal(request.allowProviderFallback, false);
  assert.deepEqual(request.allowedRoots, []);
});

test("a rejected no-tools runtime refunds the Memory call reservation", async () => {
  const f = await fixture();
  try {
    let dispatched = 0;
    const classify = createMemoryModelClassifier({ backgroundAgent: {
      async run() {
        dispatched += 1;
        throw Object.assign(new Error("Unverified runtime"), {
          code: "BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED"
        });
      }
    }, claimBudget: (day) => f.store.claimMemoryExtractionDailyCall(day, 1),
    refundBudget: (day) => f.store.refundMemoryExtractionDailyCall(day) });
    const input = { scope: { providerId: "test-provider" }, existing: [] };
    await assert.rejects(classify([], input), { code: "BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED" });
    await assert.rejects(classify([], input), { code: "BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED" });
    assert.equal(dispatched, 2);
    assert.equal(f.store.selectOne("SELECT calls FROM memory_extraction_daily_budget").calls, 0);
  } finally { await f.close(); }
});

test("durable scheduler coalesces Session requests and processes them with one worker", async () => {
  const f = await fixture();
  try {
    let runs = 0;
    const scheduler = new MemoryExtractionScheduler({ store: f.store,
      extractor: { async extractPageFromSession() { runs += 1; return { memories: [], hasMore: false }; } } });
    scheduler.request("session:a");
    scheduler.request("session:a");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runs, 1);
    assert.equal(f.store.listMemoryExtractionJobs()[0].state, "done");
    scheduler.close();
  } finally { await f.close(); }
});

test("ordinary Turn completion waits for the low-frequency idle window", async () => {
  const f = await fixture();
  try {
    userEvent(f.store, "user", "Please keep this in mind.");
    let runs = 0;
    const scheduler = new MemoryExtractionScheduler({ store: f.store,
      extractor: { async extractPageFromSession() { runs += 1; return { memories: [], hasMore: false }; } } });
    scheduler.requestForTurn("session:a");
    assert.equal(f.store.listMemoryExtractionJobs()[0].reason, "idle_window");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(runs, 0);
    await scheduler.close();
  } finally { await f.close(); }
});

test("retry cooldown survives a new Turn and blocked jobs resume only at startup", async () => {
  const f = await fixture();
  try {
    const future = new Date(Date.now() + 60_000).toISOString();
    f.store.enqueueMemoryExtraction("session:a", "initial", new Date(0).toISOString());
    const job = f.store.listMemoryExtractionJobs()[0];
    f.store.finishMemoryExtractionJob("session:a", {
      error: "MEMORY_DAILY_CALL_BUDGET", retryAt: future, expectedUpdatedAt: job.updated_at
    });
    f.store.enqueueMemoryExtraction("session:a", "new_turn", new Date(0).toISOString());
    assert.equal(f.store.listMemoryExtractionJobs()[0].retry_at, future);
    f.store.finishMemoryExtractionJob("session:a", {
      error: "BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED", terminalState: "blocked"
    });
    f.store.enqueueMemoryExtraction("session:a", "another_turn", new Date(0).toISOString());
    assert.equal(f.store.listMemoryExtractionJobs()[0].state, "blocked");
    f.store.resumeBlockedMemoryExtractionJobs();
    assert.equal(f.store.listMemoryExtractionJobs()[0].state, "queued");
  } finally { await f.close(); }
});

test("deleted Sessions cannot enqueue and their old jobs are skipped", async () => {
  const f = await fixture();
  try {
    f.store.enqueueMemoryExtraction("session:a", "before_delete", new Date(0).toISOString());
    f.store.deleteSession("session:a");
    const scheduler = new MemoryExtractionScheduler({ store: f.store,
      extractor: { async extractPageFromSession() {
        throw Object.assign(new Error("Gone"), { code: "SESSION_NOT_FOUND" });
      } } });
    scheduler.request("session:a", "after_delete");
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.store.listMemoryExtractionJobs()[0].state, "skipped");
    await scheduler.close();
  } finally { await f.close(); }
});

test("auto-activated Global Memory is recalled in a different Work Session", async () => {
  const f = await fixture();
  try {
    userEvent(f.store, "user", "I prefer short answers across all projects.");
    await new MemoryExtractor({ store: f.store, classifyMany: async (events) => [proposal(events[0])] })
      .extractFromSession("session:a");
    f.store.createWork({ id: "work:b", name: "B", contributorAgentIds: ["agent:a"] });
    f.store.createSession({ id: "session:b", title: "B", provider: "test-provider", status: "running",
      sessionKind: "workChat", workId: "work:b", agentId: "agent:a" });
    const recall = await new MemoryRecallService({ store: f.store,
      hubService: new HubService({ store: f.store }) }).startup({
      sessionId: "session:b", workId: "work:b", agentId: "agent:a"
    });
    assert.equal(recall.memories.length, 1);
    assert.equal(recall.memories[0].owner_type, "global");
    assert.equal(recall.diagnostics.selectedEntries[0].content, "I prefer short answers across all projects.");
  } finally { await f.close(); }
});

test("migration quarantines old extracted candidates and keeps a rollback audit", async () => {
  const f = await fixture();
  try {
    const old = f.store.createMemory({ ownerType: "task", ownerId: "task:a", taskId: "task:a",
      kind: "fact", content: "Old heuristic claim", sourceType: "extracted",
      sourceSessionId: "session:a", promotionStatus: "candidate", trustLevel: "untrusted" });
    f.store.db.run("DELETE FROM data_migrations WHERE migration_id = ?",
      ["memory-model-extraction-quarantine-v2"]);
    await f.store.close();
    f.store = new CorptieStore({ dbPath: join(f.directory, "store.sqlite"),
      configPath: join(f.directory, "config.json") });
    await f.store.initialize();
    assert.equal(f.store.getMemory(old.id).promotion_status, "archived");
    assert.ok(f.store.listMemoryAudit({ memoryId: old.id })
      .some((audit) => audit.action === "quarantine_pre_model_extraction"));
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
