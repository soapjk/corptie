import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubService } from "../src/application/hubService.mjs";
import { MemoryExtractor } from "../src/application/memoryExtractor.mjs";
import { MemoryLifecycleService } from "../src/application/memoryLifecycleService.mjs";
import { MemoryRecallService, lightweightTrigger } from "../src/application/memoryRecallService.mjs";
import { memoryDynamicTools } from "../src/application/memoryDynamicTools.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-memory-recall-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath });
  await store.initialize();
  const agent = store.createAgent({ id: "agent:recall", name: "Recall" });
  store.createObjective({ id: "objective:recall", name: "Recall" });
  store.createWorkItem({ id: "work_item:recall", objectiveId: "objective:recall", title: "Recall" });
  store.createSession({
    id: "session:recall", title: "Recall", provider: "codex-app-server", status: "running",
    sessionKind: "worker", agentId: agent.agentId,
    objectiveId: "objective:recall", workItemId: "work_item:recall"
  });
  return {
    directory, dbPath, configPath, store,
    scope: {
      sessionId: "session:recall", agentId: agent.agentId,
      objectiveId: "objective:recall", workItemId: "work_item:recall"
    }
  };
}

function memory(store, input) {
  return store.createMemory({
    ownerType: "agent", ownerId: "agent:recall", kind: "fact",
    content: input.content, confidence: input.confidence ?? 0.9,
    sourceType: input.sourceType ?? "user", trustLevel: input.trustLevel ?? "trusted",
    promotionStatus: input.promotionStatus ?? "active", expiresAt: input.expiresAt,
    ...input
  });
}

test("startup recall is bounded, trusted, high-confidence and respects WorkItem→Objective→Agent ties", async () => {
  const f = await fixture();
  try {
    memory(f.store, { ownerType: "agent", ownerId: "agent:recall", content: "same agent" });
    memory(f.store, { ownerType: "objective", ownerId: "objective:recall", content: "same objective" });
    memory(f.store, {
      ownerType: "work_item", ownerId: "work_item:recall", workItemId: "work_item:recall",
      sourceSessionId: "session:recall", content: "same work item"
    });
    memory(f.store, { content: "untrusted", sourceType: "extracted", trustLevel: "untrusted" });
    memory(f.store, { content: "low confidence", confidence: 0.69 });
    memory(f.store, { content: "expired", expiresAt: "2020-01-01T00:00:00.000Z" });
    for (let index = 0; index < 10; index += 1) memory(f.store, { content: `bounded ${index}` });

    const recall = await new MemoryRecallService({
      store: f.store, hubService: new HubService({ store: f.store }),
      clock: () => "2026-08-23T00:00:00.000Z"
    }).startup(f.scope);
    assert.equal(recall.memories.length, 8);
    assert.deepEqual(recall.memories.slice(0, 3).map((item) => item.owner_type), ["work_item", "objective", "agent"]);
    assert.ok(recall.memories.every((item) => item.trust_level === "trusted" && item.confidence >= 0.7));
    assert.equal(recall.mode, "bounded_trusted");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("per-turn trigger is model-free, diagnostic, and Deep Recall degrades explicitly", async () => {
  const f = await fixture();
  try {
    memory(f.store, { content: "Use provider-neutral Memory tools for every Provider" });
    let embeddingCalls = 0;
    const hub = new HubService({ store: f.store, embedder: async () => { embeddingCalls += 1; return [1, 0]; } });
    const recall = new MemoryRecallService({ store: f.store, hubService: hub });
    const skipped = await recall.turn("hello", f.scope);
    assert.equal(skipped.mode, "skipped");
    assert.equal(embeddingCalls, 0);
    const light = await recall.turn("How should I implement Memory tools again?", f.scope);
    assert.equal(light.mode, "lightweight");
    assert.equal(embeddingCalls, 0);
    const deep = await recall.explicitSearch("Memory Provider", f.scope, { deepRecall: true });
    assert.equal(deep.mode, "deep");
    assert.ok(embeddingCalls > 0);

    const degraded = await new MemoryRecallService({
      store: f.store, hubService: new HubService({ store: f.store })
    }).explicitSearch("Memory Provider", f.scope, { deepRecall: true });
    assert.equal(degraded.reason, "deep_recall_unavailable_fell_back_to_lexical");
    assert.equal(degraded.diagnostics.degraded, true);
    assert.deepEqual(lightweightTrigger("hello"), {
      triggered: false, reason: "no_recall_cue", score: 0, termCount: 1
    });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("extraction creates untrusted candidates and never relearns injected recall", async () => {
  const f = await fixture();
  try {
    f.store.appendSessionEvent({
      eventId: "event:memory-inject", sessionId: "session:recall", type: "memory/inject",
      producer: "memory", source: { type: "memory-recall" }, payload: { text: "do not relearn" }
    });
    f.store.appendSessionEvent({
      eventId: "event:summary", sessionId: "session:recall", type: "summary",
      payload: { summary: "candidate only" }
    });
    const extracted = await new MemoryExtractor({ store: f.store }).extractFromSession("session:recall");
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].content, "candidate only");
    assert.equal(extracted[0].promotion_status, "candidate");
    assert.equal(extracted[0].trust_level, "untrusted");
    assert.equal(extracted[0].auto_applied, 0);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("pre-compaction preservation, consolidation audit/rollback, and recall audit survive reconnect", async () => {
  const f = await fixture();
  try {
    const lifecycle = new MemoryLifecycleService({ store: f.store });
    const checkpoint = lifecycle.preserveBeforeCompaction({
      sessionId: "session:recall", content: "Recover this before compaction", sourceEventSeqs: [1, 2]
    });
    const second = memory(f.store, {
      ownerType: "work_item", ownerId: "work_item:recall", workItemId: "work_item:recall",
      sourceSessionId: "session:recall", content: "Second trusted checkpoint"
    });
    const consolidated = lifecycle.consolidate({
      memoryIds: [checkpoint.id, second.id], content: "Consolidated recoverable context"
    });
    assert.equal(f.store.getMemory(checkpoint.id).promotion_status, "superseded");
    lifecycle.rollbackConsolidation(consolidated.audit.id, "user:test");
    assert.equal(f.store.getMemory(checkpoint.id).promotion_status, "active");
    assert.equal(f.store.getMemory(consolidated.memory.id).promotion_status, "rolled_back");

    const untrusted = memory(f.store, { content: "untrusted", sourceType: "extracted", trustLevel: "untrusted" });
    assert.throws(
      () => lifecycle.consolidate({ memoryIds: [untrusted.id], content: "must fail" }),
      { code: "UNTRUSTED_MEMORY_PROMOTION_FORBIDDEN" }
    );

    await new MemoryRecallService({
      store: f.store, hubService: new HubService({ store: f.store })
    }).turn("hello", f.scope);
    await f.store.close();
    f.store = new CorptieStore({ dbPath: f.dbPath, configPath: f.configPath });
    await f.store.initialize();
    assert.equal(f.store.getMemory(checkpoint.id).content, "Recover this before compaction");
    assert.equal(f.store.listMemoryRecallAudit({ sessionId: "session:recall" }).length, 1);
    assert.ok(f.store.listMemoryAudit({ memoryId: consolidated.memory.id }).some((entry) => entry.action === "rollback_consolidation"));
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("one provider-neutral Memory tool contract exposes search/get/update/revoke to every Tool Host", () => {
  const names = memoryDynamicTools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "corptie_memory_search", "corptie_memory_get", "corptie_memory_list",
    "corptie_memory_remember", "corptie_memory_update", "corptie_memory_revoke"
  ]);
  const search = memoryDynamicTools.find((tool) => tool.name === "corptie_memory_search");
  assert.equal(search.inputSchema.properties.deep_recall.type, "boolean");
  assert.ok(!names.some((name) => /codex|claude|openclacky/i.test(name)));
});
