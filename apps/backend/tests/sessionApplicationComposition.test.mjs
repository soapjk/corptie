import assert from "node:assert/strict";
import test from "node:test";
import { createSessionApplicationComposition } from "../src/application/sessionApplicationComposition.mjs";

function fixture() {
  const calls = [];
  const session = { id: "session:1", title: "stored", agentId: "agent:1", sessionKind: "worker" };
  const reference = { sessionId: session.id, logicalSessionId: "logical:1", bindingId: "new", providerId: "test" };
  const service = createSessionApplicationComposition({
    store: {
      getSession: () => session,
      rerouteUnsentMessageDelivery: (...args) => calls.push(["reroute", ...args]),
      renameSession: (_id, title) => ({ ...session, title }),
      deleteLogicalSessionByLegacySessionId: (id) => calls.push(["delete-logical", id]),
      deleteSession: (id) => calls.push(["delete-session", id])
    },
    agentProviderRegistry: {},
    sessionBindingRepository: { resolve: () => reference },
    assertForkDispatchAllowed: (id) => calls.push(["fork-guard", id]),
    assertSessionRecoveryMessageBoundary: (input) => calls.push(["recovery-guard", input]),
    recoverSession: async (input) => { calls.push(["recover", input]); return { toolCatalog: {} }; },
    requireSessionReference: () => reference,
    resolveContextReferences: async () => { throw new Error("unexpected context resolution"); },
    collaborationCore: { detachSession: (id) => calls.push(["detach", id]) },
    emitEvent: (...args) => calls.push(["event", ...args])
  });
  return { service, calls, session, reference };
}

test("construction does not invoke later-created services and dispatch preserves both guards", () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  f.service.assertMessageDispatchAllowed(f.reference);
  assert.deepEqual(f.calls, [
    ["fork-guard", "session:1"], ["recovery-guard", f.reference]
  ]);
});

test("recovery requires a stable delivery identity before any replacement work", async () => {
  const f = fixture();
  await assert.rejects(f.service.recoverUnavailableSession({
    sessionId: "session:1", reference: f.reference, error: {}, context: {}
  }), { code: "SESSION_RECOVERY_IDEMPOTENCY_REQUIRED" });
  assert.deepEqual(f.calls, []);
});

test("message recovery finalizes the replacement before rerouting its unsent delivery", async () => {
  const f = fixture();
  f.service.resumeSession = async (...args) => f.calls.push(["resume", ...args]);
  const result = await f.service.recoverUnavailableSession({
    sessionId: "session:1", reference: f.reference,
    error: { replacementReason: "missing" }, context: { idempotencyKey: "delivery:1" }
  });
  assert.deepEqual(f.calls.map(([kind]) => kind), ["recover", "resume", "reroute"]);
  assert.equal(f.calls[0][1].idempotencyKey, "message-recovery:delivery:1");
  assert.equal(f.calls[0][1].triggerDeliveryId, "delivery:1");
  assert.equal(f.calls[1][2].purpose, "session-create-finalization");
  assert.equal(f.calls[1][2].providerBindingId, "new");
  assert.equal(result.reference, f.reference);
});

test("restart recovery does not reroute a message delivery", async () => {
  const f = fixture();
  f.service.resumeSession = async (...args) => f.calls.push(["resume", ...args]);
  await f.service.recoverUnavailableSession({
    sessionId: "session:1", reference: f.reference, error: {},
    context: { idempotencyKey: "restart:1", recoveryKind: "restart" }
  });
  assert.equal(f.calls[0][1].idempotencyKey, "restart-recovery:restart:1");
  assert.equal(f.calls[0][1].triggerDeliveryId, null);
  assert.deepEqual(f.calls.map(([kind]) => kind), ["recover", "resume"]);
});

test("deletion detaches both identities and publishes a detached event after durable removal", async () => {
  const f = fixture();
  await f.service.removeSessionBinding({ reference: { ...f.reference, providerSessionId: "native:1" } });
  assert.deepEqual(f.calls.slice(0, 4), [
    ["detach", "session:1"], ["detach", "native:1"],
    ["delete-logical", "session:1"], ["delete-session", "session:1"]
  ]);
  assert.equal(f.calls[4][1], "SessionDeleted");
  assert.deepEqual(f.calls[4][3], { detachedSession: true });
});

test("Worker message context injects bounded selected references after authoritative Task binding", async () => {
  const session = { id: "session:worker", sessionKind: "worker", taskId: "task:one", workId: "work:one" };
  const task = { id: "task:one", work_id: "work:one", title: "Task one", description: "Build it",
    acceptance_criteria: "Verified", verification_criteria: "Run tests", revision: 1, resource_version: 1 };
  const reference = { sessionId: session.id, logicalSessionId: "logical:one", bindingId: "binding:one" };
  const calls = [];
  const service = createSessionApplicationComposition({
    store: {
      getSession: () => session,
      assertLogicalWorkSessionBinding: () => ({ taskId: task.id }),
      getTask: () => task,
      getWork: () => ({ id: "work:one", name: "Work one" }),
      selectOne: () => null,
      getSessionToolCatalogMaterialization: () => null
    },
    agentProviderRegistry: {}, sessionBindingRepository: { resolve: () => reference },
    artifactService: { indexForSession: () => ({ items: [] }) },
    mcpAssignmentRevisionForAgent: () => null,
    resolveContextReferences: async (id, options) => {
      calls.push([id, options]);
      return { prompt: "The following Corptie Session context references are user-selected reference material.\nReference: test document" };
    },
    emitEvent: () => {}
  });
  const context = await service.resolveMessageContext(reference, { message: { text: "Use the reference" } });
  assert.deepEqual(calls, [[session.id, { characterBudget: 4_096 }]]);
  assert.match(context.prompt, /Authoritative bound Task definition/);
  assert.match(context.prompt, /Reference: test document/);
  assert.ok(context.prompt.indexOf("Authoritative bound Task definition") < context.prompt.indexOf("Reference: test document"));
});

test("Worker message context retains user-saved Global preferences independently of optional recall", async () => {
  const session = { id: "session:worker", sessionKind: "worker", taskId: "task:one",
    workId: "work:one", agentId: "agent:one" };
  const task = { id: "task:one", work_id: "work:one", title: "Task one",
    description: "Build it", revision: 1, resource_version: 1 };
  const reference = { sessionId: session.id, logicalSessionId: "logical:one", bindingId: "binding:one" };
  const statuses = [];
  const globalRecall = { id: "recall:global", mode: "always_on",
    memories: [{ id: "memory:global", content: "Run one combined test pass after development." }] };
  const service = createSessionApplicationComposition({
    store: { getSession: () => session,
      assertLogicalWorkSessionBinding: () => ({ taskId: task.id }),
      getTask: () => task, getWork: () => ({ id: "work:one", name: "Work one" }),
      selectOne: () => null, getSessionToolCatalogMaterialization: () => null },
    agentProviderRegistry: {}, sessionBindingRepository: { resolve: () => reference },
    artifactService: { indexForSession: () => ({ items: [] }) },
    mcpAssignmentRevisionForAgent: () => null,
    resolveContextReferences: async () => null,
    memoryRecallService: {
      globalPreferences: () => globalRecall,
      hasStartupRecall: () => true,
      turn: async () => ({ id: "recall:ordinary", mode: "skipped", memories: [] }),
      markInjection: (recall, status) => statuses.push([recall.id, status])
    }, emitEvent: () => {}
  });
  const context = await service.resolveMessageContext(reference, { message: { text: "Continue coding" } });
  assert.match(context.prompt, /Run one combined test pass after development/);
  assert.equal(context.globalPreferenceRecall, globalRecall);
  assert.ok(context.prompt.indexOf("Run one combined test pass")
    > context.prompt.indexOf("Authoritative bound Task definition"));
  assert.deepEqual(statuses, [["recall:global", "context_included"], ["recall:ordinary", "not_selected"]]);
});

test("Work Chat message context also includes references already allowed by its Detail UI", async () => {
  const session = { id: "session:work-chat", sessionKind: "workChat", workId: "work:one" };
  const reference = { sessionId: session.id, logicalSessionId: "logical:work-chat" };
  const service = createSessionApplicationComposition({
    store: { getSession: () => session },
    agentProviderRegistry: {}, sessionBindingRepository: { resolve: () => reference },
    workChatContextService: { build: () => ({ prompt: "Work snapshot: authoritative scope" }) },
    resolveContextReferences: async () => ({ prompt: "Reference: selected document" }),
    mcpAssignmentRevisionForAgent: () => null,
    emitEvent: () => {}
  });
  const context = await service.resolveMessageContext(reference, { message: { text: "Use the document" } });
  assert.match(context.prompt, /Work snapshot: authoritative scope/);
  assert.match(context.prompt, /Reference: selected document/);
});

test("Work Chat records selected Memory only when it enters the provider-neutral context", async () => {
  const session = { id: "session:work-memory", sessionKind: "workChat",
    workId: "work:one", agentId: "agent:one" };
  const reference = { sessionId: session.id, logicalSessionId: "logical:work-memory" };
  const statuses = [];
  const service = createSessionApplicationComposition({
    store: { getSession: () => session },
    agentProviderRegistry: {}, sessionBindingRepository: { resolve: () => reference },
    workChatContextService: { build: () => ({ prompt: "Work context" }) },
    resolveContextReferences: async () => null,
    mcpAssignmentRevisionForAgent: () => null,
    memoryRecallService: {
      turn: async () => ({ id: "recall:one", mode: "lightweight", reason: "routine_context",
        memories: [{ kind: "preference", content: "先运行本地测试" }] }),
      markInjection: (recall, status) => statuses.push([recall.id, status])
    },
    emitEvent: () => {}
  });
  const context = await service.resolveMessageContext(reference, { message: { text: "如何提交？" } });
  assert.match(context.prompt, /先运行本地测试/);
  assert.deepEqual(statuses, [["recall:one", "context_included"]]);
});
