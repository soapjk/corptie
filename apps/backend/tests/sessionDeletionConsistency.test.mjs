import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { SessionBindingRepository } from "../src/agent-provider/sessionBindingRepository.mjs";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES as C } from "../src/agent-provider/contracts.mjs";
import { createSessionApplicationComposition } from "../src/application/sessionApplicationComposition.mjs";
import { createControlPlaneProjection } from "../src/application/controlPlaneProjection.mjs";

test("failed local deletion rolls back ownership, route, aliases and timeline; retry retires exactly one Session", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-delete-consistency-config", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    const core = new CollaborationCore(store);
    const agent = store.createAgent({ name: "Deletion_worker", role: "independentContributor" });
    const input = { id: "session:delete", title: "Delete_test", provider: "test", agentId: agent.agentId,
      sessionKind: "assistantChat", external: { provider: "test", threadId: "native:delete" } };
    store.createSession(input);
    store.createSession({ id: "session:unrelated", title: "Unrelated", provider: "test" });
    store.createLogicalSessionRoute({ logicalSessionId: "logical:delete", legacySessionId: input.id,
      providerThreadId: "native:delete", providerSessionId: "native:delete", providerId: "test",
      bindingId: "binding:delete", boundCwd: "/tmp", sessionName: "Delete_test" });
    core.bindSession({ agentId: agent.agentId, sessionId: input.id });
    store.upsertTimelineItemProjection(input.id, { id: "item:delete", type: "agentMessage", text: "Preserved until commit" });
    const calls = [], events = [];
    const registry = new AgentProviderRegistry([new CallbackAgentProvider({
      id: "test", displayName: "Test", transport: "test", capabilities: [C.SESSION_DELETE]
    }, { deleteSession: async reference => { calls.push(reference.providerSessionId); return {}; } })]);
    const bindingRepository = new SessionBindingRepository({ store });
    const service = createSessionApplicationComposition({ store, agentProviderRegistry: registry,
      sessionBindingRepository: bindingRepository, collaborationCore: core,
      emitEvent: (...args) => events.push(args) });
    const before = { session: store.getSession(input.id), logical: store.getLogicalSession("logical:delete"),
      agent: core.getAgent(agent.agentId), items: store.getItems(input.id), revision: store.stateRevision() };
    let notifications = 0;
    const timeline = [];
    store.setStateDirtyListener(() => { notifications++; });
    store.setTimelineDirtyListener(change => timeline.push(change));
    const run = store.db.run, failure = new Error("injected late Session tombstone failure");
    store.db.run = function (sql, ...args) {
      if (sql.includes("UPDATE sessions") && sql.includes("SET deleted_at = ?")) throw failure;
      return run.call(this, sql, ...args);
    };
    try {
      await assert.rejects(service.deleteSession("logical:delete"), error => error === failure);
    } finally { store.db.run = run; }
    assert.deepEqual(store.getSession(input.id), before.session);
    assert.deepEqual(store.getLogicalSession("logical:delete"), before.logical);
    assert.deepEqual(core.getAgent(agent.agentId), before.agent);
    assert.deepEqual(store.getItems(input.id), before.items);
    assert.equal(store.stateRevision(), before.revision);
    assert.equal(notifications, 0);
    assert.equal(events.length, 0);
    assert.equal(timeline.length, 0);
    assert.ok(store.getLogicalSessionByName("Delete_test"));
    assert.ok(bindingRepository.resolve("logical:delete"));

    const result = await service.deleteSession("logical:delete");
    assert.equal(result.deleted, true);
    assert.deepEqual(calls, ["native:delete", "native:delete"]);
    assert.equal(store.getSession(input.id), null);
    assert.equal(store.getLogicalSession("logical:delete"), null);
    assert.equal(store.getLogicalSessionByName("Delete_test"), null);
    assert.equal(bindingRepository.resolve(input.id), null);
    assert.deepEqual(store.listActiveProviderSessionIds("test"), []);
    assert.deepEqual(store.getItems(input.id), []);
    assert.equal(core.getAgent(agent.agentId).currentSessionId, null);
    assert.equal(notifications, 1);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].quickMessagesGlobalChanged, true);
    assert.equal(events.length, 1);
    assert.equal(events[0][0], "SessionDeleted");
    assert.equal(store.getProviderThreadBinding("native:delete").state, "invalid");
    assert.ok(store.selectOne("SELECT deleted_at FROM sessions WHERE id=?", [input.id]).deleted_at);
    const projection = createControlPlaneProjection({ store, decorateSessionForClient: session => session });
    assert.equal(projection.readControlPlaneEntity("session", input.id), null);
    assert.equal(store.upsertSession(input), false, "late Provider snapshots cannot resurrect deleted Session");
    const revision = store.stateRevision();
    await assert.rejects(service.deleteSession("logical:delete"), { code: "SESSION_NOT_FOUND" });
    assert.equal(calls.length, 2, "already deleted identity must not re-enter Provider deletion");
    assert.equal(store.stateRevision(), revision);
    assert.ok(store.getSession("session:unrelated"));
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally { await store.close(); }
});
