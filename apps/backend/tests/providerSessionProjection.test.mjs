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
  repairStableSessionFromBoundPhysicalProjection,
  resolveRoutedProviderSessionProjection
} from "../src/application/providerSessionProjection.mjs";

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
      sessionKind: "assistantChat",
      status: "complete"
    });
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
    assert.equal(active.session.sessionKind, "assistantChat");
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
