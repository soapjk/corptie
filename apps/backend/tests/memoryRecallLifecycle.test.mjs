import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubService } from "../src/application/hubService.mjs";
import { MemoryExtractor } from "../src/application/memoryExtractor.mjs";
import { MemoryLifecycleService } from "../src/application/memoryLifecycleService.mjs";
import { MemoryRecallService, lightweightTrigger, presentMemoryRecallAudit, presentSessionMemoryHits } from "../src/application/memoryRecallService.mjs";
import { memoryDynamicTools } from "../src/application/memoryDynamicTools.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { createSessionApplicationComposition } from "../src/application/sessionApplicationComposition.mjs";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { reviewExtractedMemory } from "../src/application/memoryOperationService.mjs";
import { AgentContextService } from "../src/application/agentContextService.mjs";
import { createCollaborationProviderOptions } from "../src/adapters/collaborationProviderOptions.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-memory-recall-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath });
  await store.initialize();
  const agent = store.createAgent({ id: "agent:recall", name: "Recall" });
  store.createWork({ id: "work:recall", name: "Recall", contributorAgentIds: [agent.agentId] });
  store.createTask({ id: "task:recall", workId: "work:recall", title: "Recall" });
  store.createSession({
    id: "session:recall", title: "Recall", provider: "codex-app-server", status: "running",
    sessionKind: "worker", agentId: agent.agentId,
    workId: "work:recall", taskId: "task:recall"
  });
  return {
    directory, dbPath, configPath, store,
    scope: {
      sessionId: "session:recall", agentId: agent.agentId,
      workId: "work:recall", taskId: "task:recall"
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

test("startup recall is bounded, trusted, high-confidence and respects Task→Work→Agent ties", async () => {
  const f = await fixture();
  try {
    memory(f.store, { ownerType: "agent", ownerId: "agent:recall", content: "same agent" });
    memory(f.store, { ownerType: "work", ownerId: "work:recall", content: "same work" });
    memory(f.store, {
      ownerType: "task", ownerId: "task:recall", taskId: "task:recall",
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
    assert.deepEqual(recall.memories.slice(0, 3).map((item) => item.owner_type), ["task", "work", "agent"]);
    assert.ok(recall.memories.every((item) => item.trust_level === "trusted" && item.confidence >= 0.7));
    assert.equal(recall.mode, "bounded_trusted");
    const presented = presentMemoryRecallAudit(f.store, recall);
    assert.equal(presented.candidateEntries.length, recall.candidateIds.length);
    assert.equal(presented.candidateEntries[0].content, "same work item");
    assert.equal(presented.candidateEntries[0].snapshotAtRecall, true);
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
    const skipped = await recall.turn("hi", f.scope);
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
    assert.deepEqual(lightweightTrigger("hi"), {
      triggered: false, reason: "no_recall_cue", score: 0, termCount: 1
    });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Session Memory hits deduplicate accepted Turns and keep older distinct hits", async () => {
  const f = await fixture();
  try {
    const repeated = memory(f.store, { content: "Shared preference" });
    const older = memory(f.store, { content: "Older distinct preference" });
    const candidate = memory(f.store, { content: "Only a candidate" });
    const record = (selected, status) => {
      const audit = f.store.createMemoryRecallAudit({
        sessionId: f.scope.sessionId, phase: "turn", mode: "lightweight",
        reason: "test", candidateIds: [candidate.id], selectedIds: selected.map((item) => item.id),
        diagnostics: { selectedEntries: selected.map((item) => ({
          id: item.id, kind: item.kind, content: item.content,
          ownerType: item.owner_type, ownerId: item.owner_id, snapshotAtRecall: true
        })) }
      });
      f.store.updateMemoryRecallAuditInjection(audit.id, status);
    };
    record([older], "provider_accepted");
    for (let index = 0; index < 12; index += 1) record([repeated], "provider_accepted");
    record([candidate], "budget_omitted");
    record([candidate], "provider_rejected");
    const hits = presentSessionMemoryHits(f.store, f.scope.sessionId);
    assert.deepEqual(new Set(hits.map((item) => item.id)), new Set([repeated.id, older.id]));
    assert.equal(hits.length, 2);
    assert.equal(hits.find((item) => item.id === older.id)?.content, "Older distinct preference");
    assert.ok(hits.every((item) => item.snapshotAtRecall));
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("low-confidence trusted Memory starts up and Chinese paraphrases recall without a cue", async () => {
  const f = await fixture();
  try {
    const retained = memory(f.store, { content: "提交代码之前先运行本地测试", confidence: 0.5 });
    const service = new MemoryRecallService({ store: f.store, hubService: new HubService({ store: f.store }) });
    assert.equal((await service.startup(f.scope)).memories[0].id, retained.id);
    const recall = await service.turn("代码提交前需要运行测试吗", f.scope);
    assert.deepEqual(recall.selectedIds, [retained.id]);
    service.markInjection(recall, "context_included");
    const [audit] = f.store.listMemoryRecallAudit({ sessionId: f.scope.sessionId });
    assert.equal(presentMemoryRecallAudit(f.store, audit).injectionStatus, "context_included");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("startup is complete only after Provider acceptance or an empty selection", async () => {
  const f = await fixture();
  try {
    const service = new MemoryRecallService({ store: f.store, hubService: new HubService({ store: f.store }) });
    const empty = await service.startup(f.scope);
    assert.equal(service.hasStartupRecall(f.scope.sessionId), false);
    service.markInjection(empty, "not_selected");
    assert.equal(service.hasStartupRecall(f.scope.sessionId), true);

    const sessionId = "session:startup-status";
    f.store.createSession({ id: sessionId, title: "Status", provider: "test-provider",
      status: "running", sessionKind: "assistantChat", agentId: f.scope.agentId });
    memory(f.store, { content: "Preferred durable rule" });
    const selected = await service.startup({ sessionId, agentId: f.scope.agentId });
    service.markInjection(selected, "context_included");
    assert.equal(service.hasStartupRecall(sessionId), false);
    service.markInjection(selected, "provider_rejected");
    assert.equal(service.hasStartupRecall(sessionId), false);
    service.markInjection(selected, "provider_accepted");
    assert.equal(service.hasStartupRecall(sessionId), true);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("recall audit keeps the selected memory content at recall time and labels legacy fallback", async () => {
  const f = await fixture();
  try {
    const selected = memory(f.store, { content: "Remember the original workflow" });
    await new MemoryRecallService({ store: f.store, hubService: new HubService({ store: f.store }) })
      .explicitSearch("original workflow", f.scope);
    f.store.updateMemory(selected.id, { content: "Updated workflow" });
    const [audit] = f.store.listMemoryRecallAudit({ sessionId: f.scope.sessionId });
    assert.deepEqual(f.store.listMemoryRecallAudit({ memoryId: selected.id }).map((entry) => entry.id), [audit.id]);
    const presented = presentMemoryRecallAudit(f.store, audit);
    assert.deepEqual(presented.selectedEntries.map((entry) => [entry.content, entry.snapshotAtRecall]), [
      ["Remember the original workflow", true]
    ]);

    const legacy = f.store.createMemoryRecallAudit({
      sessionId: f.scope.sessionId, phase: "turn", mode: "lightweight", reason: "legacy",
      selectedIds: [selected.id], candidateIds: [selected.id]
    });
    assert.deepEqual(presentMemoryRecallAudit(f.store, legacy).selectedEntries.map((entry) => [entry.content, entry.snapshotAtRecall]), [
      ["Updated workflow", false]
    ]);
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
      eventId: "event:user-preference", sessionId: "session:recall", type: "SessionUserMessageCreated",
      payload: { message: { text: "以后先运行本地测试" } }
    });
    const extracted = await new MemoryExtractor({ store: f.store, classifyMany: async (events) => [{
      eventSequence: events[0].sequence, evidence: events[0].text, content: events[0].text,
      kind: "preference", scope: "task", scopeRationale: "Task-specific",
      rationale: "User preference", confidence: 0.8, conflict: false
    }] }).extractFromSession("session:recall");
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].content, "以后先运行本地测试");
    assert.equal(extracted[0].promotion_status, "candidate");
    assert.equal(extracted[0].trust_level, "untrusted");
    assert.equal(extracted[0].auto_applied, 0);
    const recall = await new MemoryRecallService({ store: f.store, hubService: new HubService({ store: f.store }) })
      .startup(f.scope);
    assert.equal(recall.memories.length, 0);
    const audit = f.store.listMemoryRecallAudit({ sessionId: f.scope.sessionId })
      .find((entry) => entry.id === recall.id);
    assert.equal(presentMemoryRecallAudit(f.store, audit).pendingReviewCount, 1);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("confirmed Memory reaches a Provider turn and its Session Detail audit", async () => {
  const f = await fixture();
  try {
    const sourceSessionId = "session:memory-source";
    const sessionId = "session:memory-target";
    f.store.createSession({ id: sourceSessionId, title: "Memory Source", provider: "test-provider",
      status: "running", sessionKind: "assistantChat", agentId: f.scope.agentId });
    f.store.createSession({ id: sessionId, title: "Memory Target", provider: "test-provider",
      status: "running", sessionKind: "workChat", workId: f.scope.workId, agentId: f.scope.agentId });
    f.store.appendSessionEvent({ eventId: "preference:source", sessionId: sourceSessionId,
      type: "SessionUserMessageCreated", payload: { message: { id: "item:preference",
        text: "以后提交代码前先运行本地测试" } } });
    const [candidate] = await new MemoryExtractor({ store: f.store, classifyMany: async (events) => [{
      eventSequence: events[0].sequence, evidence: events[0].text, content: events[0].text,
      kind: "preference", scope: "global", scopeRationale: "Across sessions",
      rationale: "User preference", confidence: 0.8, conflict: false
    }] }).extractFromSession(sourceSessionId);
    assert.equal(candidate.promotion_status, "candidate");
    reviewExtractedMemory(f.store, candidate.id, {
      action: "confirm", expectedVersion: candidate.version, actorId: "user:test"
    });
    const staticOptions = createCollaborationProviderOptions({
      agentContextService: new AgentContextService({ store: f.store,
        hubService: new HubService({ store: f.store }),
        recallService: new MemoryRecallService({ store: f.store,
          hubService: new HubService({ store: f.store }) }) }),
      collaborationMcpServerPath: "/runtime/mcp.mjs", port: 12345,
      environmentName: "development"
    });
    const bootstrap = await staticOptions.collaborationProviderRuntimeOptionsWithAgentContext(
      f.scope.agentId, { sessionId, workId: f.scope.workId }
    );
    assert.doesNotMatch(bootstrap.developerInstructions, /以后提交代码前先运行本地测试/);
    assert.deepEqual(f.store.listMemoryRecallAudit({ sessionId }), []);
    let providerContext;
    const registry = new AgentProviderRegistry([new CallbackAgentProvider({
      id: "test-provider", displayName: "Test Provider", transport: "test",
      capabilities: [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND]
    }, {
      send: async (_reference, _message, context) => {
        providerContext = context.sessionContext;
        return { accepted: true };
      }
    })]);
    const reference = { sessionId, providerId: "test-provider",
      providerSessionId: "provider:recall", logicalSessionId: "logical:recall",
      bindingId: "binding:recall", routingVersion: 1 };
    const recallService = new MemoryRecallService({ store: f.store,
      hubService: new HubService({ store: f.store }) });
    const service = createSessionApplicationComposition({
      store: f.store, agentProviderRegistry: registry,
      sessionBindingRepository: { resolve: () => reference },
      assertForkDispatchAllowed: () => {},
      assertSessionRecoveryMessageBoundary: () => {},
      memoryRecallService: recallService,
      workChatContextService: { build: () => ({ prompt: "Work context" }) },
      resolveContextReferences: async () => null,
      mcpAssignmentRevisionForAgent: () => null,
      emitEvent: () => {}
    });
    await service.sendMessage(sessionId, { text: "提交之前怎么验证？" });
    assert.match(providerContext.prompt, /以后提交代码前先运行本地测试/);
    const audit = f.store.listMemoryRecallAudit({ sessionId })[0];
    const presented = presentMemoryRecallAudit(f.store, audit);
    assert.equal(presented.phase, "startup");
    assert.equal(presented.injectionStatus, "provider_accepted");
    assert.equal(presented.selectedEntries[0].content, "以后提交代码前先运行本地测试");
    await service.sendMessage(sessionId, { text: "提交之前怎么验证？" });
    const nextAudit = f.store.listMemoryRecallAudit({ sessionId })[0];
    assert.equal(nextAudit.phase, "turn");
    assert.equal(presentMemoryRecallAudit(f.store, nextAudit).injectionStatus, "provider_accepted");
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
      ownerType: "task", ownerId: "task:recall", taskId: "task:recall",
      sourceSessionId: "session:recall", content: "Second trusted checkpoint"
    });
    const consolidated = lifecycle.consolidate({
      memoryIds: [checkpoint.id, second.id], content: "Consolidated recoverable context"
    });
    assert.equal(f.store.getMemory(checkpoint.id).promotion_status, "superseded");
    lifecycle.rollbackConsolidation(consolidated.audit.id, "user:test");
    assert.equal(f.store.getMemory(checkpoint.id).promotion_status, "active");
    assert.equal(f.store.getMemory(consolidated.memory.id).promotion_status, "rolled_back");

    const untrusted = memory(f.store, {
      ownerType: "task", ownerId: "task:recall", taskId: "task:recall",
      sourceSessionId: "session:recall", content: "untrusted",
      sourceType: "extracted", trustLevel: "untrusted"
    });
    assert.throws(
      () => lifecycle.consolidate({ memoryIds: [untrusted.id, second.id], content: "must fail" }),
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
