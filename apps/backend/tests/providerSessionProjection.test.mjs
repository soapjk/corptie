import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import {
  ensureProviderSessionProjection,
  isBoundPhysicalProviderSession,
  persistProviderSessionProjection,
  purgeObsoleteUnclassifiedProviderProjections,
  repairStableSessionFromActiveProviderCache,
  repairStableSessionFromBoundPhysicalProjection,
  resolveRoutedProviderSessionProjection,
  visibleStoredSessionProjections
} from "../src/application/providerSessionProjection.mjs";

test("an unowned Provider Session without a product classification is neither persisted nor visible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-unclassified-projection-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const providerSession = {
      id: "codex:unowned",
      title: "Provider-local thread",
      status: "complete",
      external: { provider: "codex-app-server", threadId: "unowned", sessionId: "unowned" }
    };
    const projection = ensureProviderSessionProjection({
      store,
      session: providerSession,
      resolveAgentForSession: () => null
    });
    assert.equal(projection.visible, false);
    assert.equal(projection.reason, "unclassified_unowned_provider_session");
    assert.equal(store.getSession(providerSession.id), null);
    const invalid = ensureProviderSessionProjection({
      store,
      session: { ...providerSession, id: "codex:invalid", sessionKind: "not-a-kind" },
      resolveAgentForSession: () => ({ agentId: "agent:assistant", role: "assistant" })
    });
    assert.equal(invalid.visible, false);
    assert.equal(invalid.reason, "invalid_provider_session_kind");
    assert.equal(store.getSession("codex:invalid"), null);
    assert.throws(
      () => persistProviderSessionProjection(store, { ...providerSession, sessionKind: " " }),
      { code: "SESSION_KIND_INVALID" }
    );
    assert.deepEqual(visibleStoredSessionProjections(store, [
      { ...providerSession, sessionKind: "legacy" },
      { id: "assistant", sessionKind: "assistantChat" }
    ]).map((session) => session.id), ["assistant"]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an assistant-bound Provider Session with a missing kind is inferred as assistantChat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-assistant-projection-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const projection = ensureProviderSessionProjection({
      store,
      session: {
        id: "codex:assistant",
        title: "Assistant",
        status: "complete",
        external: { provider: "codex-app-server", threadId: "assistant", sessionId: "assistant" }
      },
      resolveAgentForSession: () => ({ agentId: "agent:assistant", role: "assistant" }),
      bindAgentToSession: () => null
    });
    assert.equal(projection.visible, true);
    assert.equal(projection.session.sessionKind, "assistantChat");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup deletes only a redundant unclassified historical physical projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-unclassified-cleanup-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "stable",
      title: "Stable Session",
      status: "complete",
      sessionKind: "assistantChat",
      external: { provider: "codex-app-server", threadId: "old", sessionId: "old" }
    });
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:stable",
      legacySessionId: "stable",
      providerThreadId: "old",
      providerSessionId: "old",
      providerId: "codex-app-server",
      boundCwd: directory,
      title: "Stable Session"
    });
    store.beginWorkspaceTransition({
      transitionId: "transition:new",
      logicalSessionId: "logical:stable",
      transitionKind: "provider",
      targetProviderId: "codex-app-server",
      targetCwd: directory,
      sourceRoutingVersion: 1,
      phase: "preflighting"
    });
    store.commitWorkspaceTransition("transition:new", {
      providerThreadId: "new",
      providerSessionId: "new",
      providerId: "codex-app-server",
      boundCwd: directory
    });
    store.upsertSession({
      id: "codex:old",
      title: "Stale physical projection",
      status: "complete",
      sessionKind: "legacy",
      external: { provider: "codex-app-server", threadId: "old", sessionId: "old" }
    });
    store.db.run(
      `INSERT INTO session_items (id, session_id, turn_id, turn_status, type, title, text, status, created_at)
       VALUES ('warning', 'codex:old', 'turn', 'complete', 'warning', 'Starting', 'thread not loaded', 'starting', ?)`,
      [new Date().toISOString()]
    );

    const result = purgeObsoleteUnclassifiedProviderProjections(store);

    assert.deepEqual(result.purged, [{
      sessionId: "codex:old",
      canonicalSessionId: "stable",
      logicalSessionId: "logical:stable",
      removedWarningItems: 1
    }]);
    assert.equal(store.getSession("codex:old"), null);
    assert.equal(store.getSession("stable").sessionKind, "assistantChat");
    assert.equal(store.getAgentSessionBindingByProviderSession("codex-app-server", "old").state, "superseded");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a historical OpenClacky Work Session projection is repaired idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-projection-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const agent = store.createAgent({ id: "agent:liang", name: "梁子", provider: "OpenClacky" });
    const objective = store.createObjective({
      id: "objective:poly",
      name: "PolyMarket",
      contributorAgentIds: [agent.agentId]
    });
    const workItem = store.createWorkItem({
      id: "work-item:poly",
      objectiveId: objective.id,
      title: "PolyMarket 实盘",
      mainAgentId: agent.agentId
    });
    store.db.run("UPDATE work_items SET current_session_id = ? WHERE id = ?", [
      "openclacky:owned",
      workItem.id
    ]);
    const collaboration = new CollaborationCore(store);
    const providerSession = {
      id: "openclacky:owned",
      title: "PolyMarket 实盘",
      status: "complete",
      external: { provider: "openclacky", cwd: directory }
    };

    const first = ensureProviderSessionProjection({
      store,
      session: providerSession,
      resolveAgentForSession: (sessionId) => collaboration.getAgentForSession(sessionId),
      bindAgentToSession: (binding) => collaboration.bindSession(binding)
    });
    assert.equal(first.repaired, true);
    assert.equal(first.session.sessionKind, "worker");
    assert.equal(first.session.agentId, agent.agentId);
    assert.equal(first.session.objectiveId, objective.id);
    assert.equal(first.session.workItemId, workItem.id);
    assert.equal(store.getAgent(agent.agentId).currentSessionId, providerSession.id);

    collaboration.unbindSession(agent.agentId);
    assert.equal(store.getAgent(agent.agentId).currentSessionId, null);
    const second = ensureProviderSessionProjection({
      store,
      session: providerSession,
      resolveAgentForSession: (sessionId) => collaboration.getAgentForSession(sessionId),
      bindAgentToSession: (binding) => collaboration.bindSession(binding)
    });
    assert.equal(second.repaired, true);
    assert.equal(store.getAgent(agent.agentId).currentSessionId, providerSession.id);

    const third = ensureProviderSessionProjection({
      store,
      session: providerSession,
      resolveAgentForSession: (sessionId) => collaboration.getAgentForSession(sessionId),
      bindAgentToSession: (binding) => collaboration.bindSession(binding)
    });
    assert.equal(third.repaired, false);
    assert.equal(store.listSessionsByWorkItem(workItem.id).length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Provider switch projects only the active target thread under the original logical Session identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-routed-provider-projection-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "openclacky:source",
      title: "Stable title",
      agent: "Arbitrage Agent",
      agentId: "agent:arbitrage",
      provider: "openclacky",
      status: "complete"
    });
    store.createObjective({ id: "objective:arbitrage", name: "Arbitrage" });
    store.createWorkItem({
      id: "work-item:arbitrage",
      objectiveId: "objective:arbitrage",
      title: "Run arbitrage"
    });
    store.bindSessionToWorkItem(
      "openclacky:source",
      "work-item:arbitrage",
      "objective:arbitrage"
    );
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:arbitrage",
      legacySessionId: "openclacky:source",
      providerThreadId: "source",
      providerSessionId: "source",
      providerId: "openclacky",
      boundCwd: directory,
      title: "Stable title"
    });
    store.beginWorkspaceTransition({
      transitionId: "transition:codex",
      logicalSessionId: "logical:arbitrage",
      transitionKind: "provider",
      targetProviderId: "codex-app-server",
      targetCwd: directory,
      sourceRoutingVersion: 1,
      phase: "preflighting"
    });
    store.commitWorkspaceTransition("transition:codex", {
      providerThreadId: "codex-target",
      providerSessionId: "codex-target",
      providerId: "codex-app-server",
      boundCwd: directory
    });

    const active = resolveRoutedProviderSessionProjection(store, {
      id: "codex:codex-target",
      title: "Provider-local title",
      status: "running",
      external: {
        provider: "codex-app-server",
        threadId: "codex-target",
        sessionId: "codex-target"
      }
    });
    assert.equal(active.disposition, "active");
    assert.equal(active.session.id, "openclacky:source");
    assert.equal(active.session.title, "Stable title");
    assert.equal(active.session.sessionName, "Stable title");
    assert.equal(active.session.agentId, "agent:arbitrage");
    assert.equal(active.session.sessionKind, "worker");
    assert.equal(active.session.workItemId, "work-item:arbitrage");
    assert.equal(active.session.objectiveId, "objective:arbitrage");
    assert.equal(active.session.external.provider, "codex-app-server");
    assert.equal(store.getSession("codex:codex-target"), null);

    assert.equal(isBoundPhysicalProviderSession(store, {
      id: "codex:codex-target",
      external: {
        provider: "codex-app-server",
        threadId: "codex-target",
        sessionId: "codex-target"
      }
    }), true);
    assert.equal(isBoundPhysicalProviderSession(store, active.session), false);

    store.upsertSession({
      id: "codex:codex-target",
      title: "Provider-local title",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete",
      external: {
        provider: "codex-app-server",
        threadId: "codex-target",
        sessionId: "codex-target",
        currentModel: "target-model",
        currentReasoningLevel: "high"
      }
    });
    const visible = visibleStoredSessionProjections(store, store.listSessions({ archived: false }));
    assert.deepEqual(visible.map((session) => session.id), ["openclacky:source"]);
    assert.equal(visible[0].sessionKind, "worker");
    assert.equal(visible[0].workItemId, "work-item:arbitrage");
    const repaired = repairStableSessionFromBoundPhysicalProjection(
      store,
      store.getSession("codex:codex-target")
    );
    assert.equal(repaired.id, "openclacky:source");
    assert.equal(repaired.title, "Stable title");
    assert.equal(repaired.agentId, "agent:arbitrage");
    assert.equal(repaired.external.threadId, "codex-target");
    assert.equal(repaired.external.currentModel, "target-model");
    assert.equal(repaired.external.currentReasoningLevel, "high");

    const source = resolveRoutedProviderSessionProjection(store, {
      id: "openclacky:source",
      title: "Stable title",
      status: "complete",
      external: {
        provider: "openclacky",
        threadId: "source",
        sessionId: "source"
      }
    });
    assert.equal(source.disposition, "historical");
    assert.equal(source.session, null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Provider switch immediately adopts a target bootstrap turn that completed before route commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-bootstrap-projection-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({
      id: "openclacky:stable",
      title: "PolyMarket 实时套利",
      status: "running",
      summary: "Initializing Codex session…",
      activityStatus: "Starting Codex",
      external: { provider: "openclacky", threadId: "source", sessionId: "source" }
    });
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:poly",
      legacySessionId: "openclacky:stable",
      providerThreadId: "source",
      providerSessionId: "source",
      providerId: "openclacky",
      boundCwd: directory,
      title: "PolyMarket 实时套利"
    });
    store.beginWorkspaceTransition({
      transitionId: "transition:poly",
      logicalSessionId: "logical:poly",
      transitionKind: "provider",
      targetProviderId: "codex-app-server",
      targetCwd: directory,
      sourceRoutingVersion: 1,
      phase: "preflighting"
    });
    store.commitWorkspaceTransition("transition:poly", {
      providerThreadId: "codex-target",
      providerSessionId: "codex-target",
      providerId: "codex-app-server",
      boundCwd: directory,
      sessionProjection: {
        status: "running",
        summary: "Initializing Codex session…",
        activityStatus: "Starting Codex",
        external: { provider: "codex-app-server", threadId: "codex-target", sessionId: "codex-target" }
      }
    });

    const repaired = repairStableSessionFromActiveProviderCache(store, "logical:poly", [{
      id: "codex:codex-target",
      title: "Provider-local title",
      status: "complete",
      summary: "Ready",
      activityStatus: null,
      updatedAt: "2026-08-20T10:15:00.000Z",
      external: {
        provider: "codex-app-server",
        threadId: "codex-target",
        sessionId: "codex-target",
        activeTurnId: null
      }
    }]);

    assert.equal(repaired.id, "openclacky:stable");
    assert.equal(repaired.status, "complete");
    assert.equal(repaired.summary, "Ready");
    assert.equal(repaired.activityStatus ?? null, null);
    assert.equal(repaired.updatedAt, "2026-08-20T10:15:00.000Z");
    assert.equal(repaired.external.threadId, "codex-target");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
