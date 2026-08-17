import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { ensureProviderSessionProjection } from "../src/application/providerSessionProjection.mjs";

test("a historical OpenClacky Work Session projection is repaired idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-provider-projection-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const agent = store.createAgent({ id: "agent:liang", name: "梁子", provider: "OpenClacky" });
    const objective = store.createObjective({ id: "objective:poly", name: "PolyMarket" });
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
