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

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-memory-tools-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const core = new CollaborationCore(store);
  const agent = store.createAgent({ name: "Memory Agent", provider: "codex-app-server" });
  const other = store.createAgent({ name: "Other Agent", provider: "claude-sdk" });
  store.createWork({
    id: "work:bound",
    name: "Bound Work",
    contributorAgentIds: [agent.agentId]
  });
  store.createTask({
    id: "task:bound",
    workId: "work:bound",
    title: "Bound Task",
    mainAgentId: agent.agentId
  });
  store.upsertSession({
    id: "session:current",
    title: "Current",
    provider: "codex-app-server",
    status: "running",
    sessionKind: "worker",
    agentId: agent.agentId,
    workId: "work:bound",
    taskId: "task:bound"
  });
  store.bindSessionToTask("session:current", "task:bound", "work:bound");
  core.bindSession({ agentId: agent.agentId, sessionId: "session:current" });
  const hubService = new HubService({ store });
  const service = new MemoryOperationService({
    store,
    hubService,
    resolveAgentForSession: (sessionId) => core.getAgentForSession(sessionId),
    onDiagnostic: options.onDiagnostic,
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

test("manual remember defaults to the most-specific current Task and preserves provenance", async () => {
  const f = await fixture();
  try {
    const remembered = await call(f.service, f.agent.agentId, "corptie_memory_remember", {
      content: "Always summarize changes concisely",
      kind: "preference",
      tags: ["style"]
    });
    assert.equal(remembered.memory.ownerType, "task");
    assert.equal(remembered.memory.ownerId, "task:bound");
    assert.equal(remembered.memory.sourceType, "user");
    assert.equal(remembered.memory.sourceSessionId, "session:current");
    assert.deepEqual(remembered.memory.sourceEventSeqs, [1]);
    const event = f.store.listSessionEvents("session:current")[0];
    assert.equal(event.type, "memory/remember");
    assert.equal(event.payload.memoryId, remembered.memory.id);

    const nextSessionRecall = await f.hubService.retrieveMemory("summarize changes", {
      agentId: f.agent.agentId,
      workId: "work:bound",
      taskId: "task:bound"
    }, { touch: false });
    assert.equal(nextSessionRecall[0].id, remembered.memory.id);
    const startupContext = await new AgentContextService({
      store: f.store,
      hubService: f.hubService
    }).buildAgentContext(f.agent.agentId, {
      intent: "",
      scope: { workId: "work:bound", taskId: "task:bound" }
    });
    assert.match(startupContext.instructions, /Always summarize changes concisely/);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("remember derives Work/Task owners and rejects every unbound scope", async () => {
  const f = await fixture();
  try {
    const work = await call(f.service, f.agent.agentId, "corptie_memory_remember", {
      content: "Bound work decision",
      kind: "fact",
      scope: "work"
    });
    assert.equal(work.memory.ownerId, "work:bound");
    const task = await call(f.service, f.agent.agentId, "corptie_memory_remember", {
      content: "Bound work item lesson",
      kind: "lesson",
      scope: "task"
    });
    assert.equal(task.memory.ownerId, "task:bound");

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
        arguments: { content: "escape", kind: "fact", scope: "work" },
        metadata: { sessionId: "session:assistant" }
      }),
      { code: "MEMORY_SCOPE_FORBIDDEN" }
    );
    const assistantMemory = await f.service.execute({
      actorId: f.other.agentId,
      tool: "corptie_memory_remember",
      arguments: { content: "Agent-only memory", kind: "fact", scope: "agent" },
      metadata: { sessionId: "session:assistant" }
    });
    assert.equal(assistantMemory.memory.ownerType, "agent");
    assert.equal(assistantMemory.memory.ownerId, f.other.agentId);
    await assert.rejects(
      () => call(f.service, f.other.agentId, "corptie_memory_remember", { content: "escape", kind: "fact" }),
      { code: "MEMORY_SESSION_SCOPE_REQUIRED" }
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("five Work Chat Sessions sharing one Agent route independently and deduplicate retries per Session", async () => {
  const f = await fixture();
  try {
    const sessions = [];
    for (let index = 1; index <= 5; index += 1) {
      const workId = `work:batch-${index}`;
      const sessionId = `session:batch-${index}`;
      f.store.createWork({
        id: workId,
        name: `Batch Work ${index}`,
        contributorAgentIds: [f.agent.agentId]
      });
      f.store.upsertSession({
        id: sessionId,
        title: `Batch Session ${index}`,
        provider: "codex-app-server",
        status: "running",
        sessionKind: "workChat",
        agentId: f.agent.agentId,
        workId
      });
      f.core.bindSession({ agentId: f.agent.agentId, sessionId });
      sessions.push({ workId, sessionId });
    }
    assert.equal(f.store.getAgent(f.agent.agentId).currentSessionId, "session:batch-5");

    const firstPass = await Promise.all(sessions.map(({ workId, sessionId }) => f.service.execute({
      actorId: f.agent.agentId,
      tool: "corptie_memory_remember",
      arguments: {
        content: "Identical durable instruction",
        kind: "procedure",
        scope: "work",
        idempotency_key: "same-instruction"
      },
      metadata: { sessionId, workId }
    })));
    assert.deepEqual(firstPass.map((result) => result.memory.ownerId), sessions.map((item) => item.workId));
    assert.ok(firstPass.every((result) => result.idempotentReplay === false));

    const retries = await Promise.all(sessions.map(({ workId, sessionId }) => f.service.execute({
      actorId: f.agent.agentId,
      tool: "corptie_memory_remember",
      arguments: {
        content: "Identical durable instruction",
        kind: "procedure",
        scope: "work",
        idempotency_key: "same-instruction"
      },
      metadata: { sessionId, workId }
    })));
    assert.deepEqual(retries.map((result) => result.memory.id), firstPass.map((result) => result.memory.id));
    assert.ok(retries.every((result) => result.idempotentReplay === true));

    for (const { workId, sessionId } of sessions) {
      const memories = f.store.listMemoriesByOwner("work", workId);
      assert.equal(memories.length, 1);
      assert.equal(memories[0].source_session_id, sessionId);
      const rememberEvents = f.store.listSessionEvents(sessionId)
        .filter((event) => event.type === "memory/remember");
      assert.equal(rememberEvents.length, 1);
      assert.equal(Object.hasOwn(rememberEvents[0].payload, "content"), false);
    }
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("remember rejects cross-Work claims and idempotency conflicts with content-free diagnostics", async () => {
  const diagnostics = [];
  const f = await fixture({ onDiagnostic: (entry) => diagnostics.push(entry) });
  try {
    const created = await call(f.service, f.agent.agentId, "corptie_memory_remember", {
      content: "Sensitive durable正文",
      kind: "fact",
      scope: "work",
      idempotency_key: "stable-request"
    }, { workId: "work:bound" });

    await assert.rejects(
      () => call(f.service, f.agent.agentId, "corptie_memory_remember", {
        content: "Different sensitive正文",
        kind: "fact",
        scope: "work",
        idempotency_key: "stable-request"
      }, { workId: "work:bound" }),
      (error) => error.code === "MEMORY_IDEMPOTENCY_CONFLICT"
        && error.stage === "idempotency_resolution"
        && error.message.includes("sessionId=session:current")
        && error.message.includes("workId=work:bound")
    );
    await assert.rejects(
      () => call(f.service, f.agent.agentId, "corptie_memory_remember", {
        content: "Sensitive cross-work正文",
        kind: "fact",
        scope: "work"
      }, { workId: "work:other" }),
      (error) => error.code === "MEMORY_SESSION_SCOPE_REQUIRED"
        && error.stage === "context_resolution"
        && error.message.includes("sessionId=session:current")
        && error.message.includes("workId=work:bound")
    );

    assert.equal(f.store.listMemoriesByOwner("work", "work:bound").length, 1);
    assert.equal(f.store.getMemory(created.memory.id).source_session_id, "session:current");
    assert.deepEqual(diagnostics.map(({ sessionId, targetWorkId, failureStage, errorCode }) => ({
      sessionId, targetWorkId, failureStage, errorCode
    })), [{
      sessionId: "session:current",
      targetWorkId: "work:bound",
      failureStage: "idempotency_resolution",
      errorCode: "MEMORY_IDEMPOTENCY_CONFLICT"
    }, {
      sessionId: "session:current",
      targetWorkId: "work:bound",
      failureStage: "context_resolution",
      errorCode: "MEMORY_SESSION_SCOPE_REQUIRED"
    }]);
    const failureEvents = f.store.listSessionEvents("session:current")
      .filter((event) => event.type === "memory/remember-failed");
    assert.equal(failureEvents.length, 2);
    const serializedDiagnostics = JSON.stringify({ diagnostics, failureEvents });
    assert.doesNotMatch(serializedDiagnostics, /Sensitive durable正文|Different sensitive正文|Sensitive cross-work正文/);
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
      workId: "work:bound",
      taskId: "task:bound"
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
