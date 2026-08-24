import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { AgentContextService } from "../src/application/agentContextService.mjs";
import { HubService } from "../src/application/hubService.mjs";
import { MemoryExtractor } from "../src/application/memoryExtractor.mjs";
import { MemoryOperationService } from "../src/application/memoryOperationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-memory-tools-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const core = new CollaborationCore(store);
  const agent = store.createAgent({ name: "Memory Agent", provider: "codex-app-server" });
  const other = store.createAgent({ name: "Other Agent", provider: "claude-sdk" });
  store.createObjective({
    id: "objective:bound",
    name: "Bound Objective",
    contributorAgentIds: [agent.agentId]
  });
  store.createWorkItem({
    id: "work_item:bound",
    objectiveId: "objective:bound",
    title: "Bound WorkItem",
    mainAgentId: agent.agentId
  });
  store.upsertSession({
    id: "session:current",
    title: "Current",
    provider: "codex-app-server",
    status: "running",
    sessionKind: "worker",
    agentId: agent.agentId,
    objectiveId: "objective:bound",
    workItemId: "work_item:bound"
  });
  store.bindSessionToWorkItem("session:current", "work_item:bound", "objective:bound");
  core.bindSession({ agentId: agent.agentId, sessionId: "session:current" });
  const hubService = new HubService({ store });
  const service = new MemoryOperationService({
    store,
    hubService,
    resolveAgentForSession: (sessionId) => core.getAgentForSession(sessionId),
    clock: () => "2026-08-18T08:00:00.000Z",
    idFactory: (() => { let value = 0; return () => `fixed-${++value}`; })()
  });
  return { directory, store, core, agent, other, hubService, service };
}

function call(service, actorId, tool, arguments_, metadata = {}) {
  return service.execute({
    actorId,
    tool,
    arguments: arguments_,
    metadata: { sessionId: "session:current", ...metadata }
  });
}

test("manual remember defaults to the most-specific current WorkItem and preserves provenance", async () => {
  const f = await fixture();
  try {
    const remembered = await call(f.service, f.agent.agentId, "corptie_memory_remember", {
      content: "Always summarize changes concisely",
      kind: "preference",
      tags: ["style"]
    });
    assert.equal(remembered.memory.ownerType, "work_item");
    assert.equal(remembered.memory.ownerId, "work_item:bound");
    assert.equal(remembered.memory.sourceType, "user");
    assert.equal(remembered.memory.sourceSessionId, "session:current");
    assert.deepEqual(remembered.memory.sourceEventSeqs, [1]);
    const event = f.store.listSessionEvents("session:current")[0];
    assert.equal(event.type, "memory/remember");
    assert.equal(event.payload.memoryId, remembered.memory.id);

    const nextSessionRecall = await f.hubService.retrieveMemory("summarize changes", {
      agentId: f.agent.agentId,
      objectiveId: "objective:bound",
      workItemId: "work_item:bound"
    }, { touch: false });
    assert.equal(nextSessionRecall[0].id, remembered.memory.id);
    const startupContext = await new AgentContextService({
      store: f.store,
      hubService: f.hubService
    }).buildAgentContext(f.agent.agentId, {
      intent: "",
      scope: { objectiveId: "objective:bound", workItemId: "work_item:bound" }
    });
    assert.match(startupContext.instructions, /Always summarize changes concisely/);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("remember derives Objective/WorkItem owners and rejects every unbound scope", async () => {
  const f = await fixture();
  try {
    const objective = await call(f.service, f.agent.agentId, "corptie_memory_remember", {
      content: "Bound objective decision",
      kind: "fact",
      scope: "objective"
    });
    assert.equal(objective.memory.ownerId, "objective:bound");
    const workItem = await call(f.service, f.agent.agentId, "corptie_memory_remember", {
      content: "Bound work item lesson",
      kind: "lesson",
      scope: "work_item"
    });
    assert.equal(workItem.memory.ownerId, "work_item:bound");

    f.store.upsertSession({
      id: "session:assistant",
      title: "Assistant",
      provider: "claude-sdk",
      status: "running",
      sessionKind: "assistantChat",
      agentId: f.other.agentId
    });
    f.core.bindSession({ agentId: f.other.agentId, sessionId: "session:assistant" });
    await assert.rejects(
      () => f.service.execute({
        actorId: f.other.agentId,
        tool: "corptie_memory_remember",
        arguments: { content: "escape", kind: "fact", scope: "objective" },
        metadata: { sessionId: "session:assistant" }
      }),
      { code: "MEMORY_SCOPE_FORBIDDEN" }
    );
    await assert.rejects(
      () => call(f.service, f.other.agentId, "corptie_memory_remember", { content: "escape", kind: "fact" }),
      { code: "MEMORY_SESSION_SCOPE_REQUIRED" }
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("update/revoke preserve ownership and source; revoke remains auditable but stops search and injection", async () => {
  const f = await fixture();
  try {
    const created = await call(f.service, f.agent.agentId, "corptie_memory_remember", {
      content: "Use the old convention",
      kind: "preference",
      scope: "agent"
    });
    const updated = await call(f.service, f.agent.agentId, "corptie_memory_update", {
      memory_id: created.memory.id,
      content: "Use the corrected convention"
    });
    assert.equal(updated.memory.content, "Use the corrected convention");
    assert.equal(updated.memory.sourceSessionId, "session:current");
    assert.deepEqual(updated.memory.sourceEventSeqs, [1]);

    const revoked = await call(f.service, f.agent.agentId, "corptie_memory_revoke", {
      memory_id: created.memory.id,
      reason: "User withdrew the preference"
    });
    assert.equal(revoked.memory.revokedAt, "2026-08-18T08:00:00.000Z");
    assert.equal(f.store.getMemory(created.memory.id).source_session_id, "session:current");
    assert.deepEqual(await f.hubService.retrieveMemory("corrected convention", {
      agentId: f.agent.agentId
    }), []);
    assert.deepEqual(await f.hubService.retrieveMemory("", { agentId: f.agent.agentId }), []);

    const activeList = await call(f.service, f.agent.agentId, "corptie_memory_list", {});
    assert.equal(activeList.count, 0);
    const auditList = await call(f.service, f.agent.agentId, "corptie_memory_list", { include_revoked: true });
    assert.equal(auditList.count, 1);
    assert.equal(auditList.memories[0].structured.revocation.reason, "User withdrew the preference");
    assert.equal(auditList.memories[0].sourceSessionId, "session:current");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("search and empty-intent recall update usage_count/last_accessed_at only for returned active memories", async () => {
  const f = await fixture();
  try {
    const first = f.store.createMemory({
      ownerType: "agent", ownerId: f.agent.agentId, kind: "fact", content: "Alpha convention", confidence: 0.9
    });
    const second = f.store.createMemory({
      ownerType: "agent", ownerId: f.agent.agentId, kind: "fact", content: "Beta convention", confidence: 0.8
    });
    const search = await call(f.service, f.agent.agentId, "corptie_memory_search", { intent: "Alpha" });
    assert.equal(search.memories[0].usageCount, 1);
    assert.ok(search.memories[0].lastAccessedAt);
    assert.equal(f.store.getMemory(second.id).usage_count, 0);

    const startup = await call(f.service, f.agent.agentId, "corptie_memory_search", { intent: "" });
    assert.equal(startup.count, 2);
    assert.equal(f.store.getMemory(first.id).usage_count, 2);
    assert.equal(f.store.getMemory(second.id).usage_count, 1);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("legacy MCP search alias and Host Tool search share one operation result contract", async () => {
  const f = await fixture();
  try {
    const memory = f.store.createMemory({
      ownerType: "agent", ownerId: f.agent.agentId, kind: "procedure", content: "Release checklist"
    });
    const host = await call(f.service, f.agent.agentId, "corptie_memory_search", { intent: "Release" });
    const legacy = await call(f.service, f.agent.agentId, "corptie.memory.search", { intent: "Release" });
    assert.deepEqual(host.scopes, legacy.scopes);
    assert.deepEqual(host.memories.map((item) => item.id), [memory.id]);
    assert.deepEqual(legacy.memories.map((item) => item.id), [memory.id]);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("automatic extraction and manual memory use distinct source_type with exact event provenance", async () => {
  const f = await fixture();
  try {
    f.store.appendSessionEvent({
      eventId: "event:extract-source",
      sessionId: "session:current",
      type: "summary",
      payload: { summary: "Stable extracted fact" }
    });
    const extracted = await new MemoryExtractor({ store: f.store }).extractFromSession("session:current", {
      agentId: f.agent.agentId,
      objectiveId: "objective:bound",
      workItemId: "work_item:bound"
    });
    assert.equal(extracted[0].source_type, "extracted");
    assert.equal(extracted[0].source_session_id, "session:current");
    assert.deepEqual(JSON.parse(extracted[0].source_event_seqs_json), [1]);

    const manual = await call(f.service, f.agent.agentId, "corptie_memory_remember", {
      content: "Manual preference",
      kind: "preference"
    });
    assert.equal(manual.memory.sourceType, "user");
    assert.equal(manual.memory.sourceSessionId, "session:current");
    assert.deepEqual(manual.memory.sourceEventSeqs, [2]);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
