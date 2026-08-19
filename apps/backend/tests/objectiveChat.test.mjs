import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { ObjectiveChatContextService } from "../src/application/objectiveChatContextService.mjs";
import { ObjectiveChatOperationService } from "../src/application/objectiveChatDynamicTools.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { inferSessionKind, normalizeSessionKind } from "../src/utils/sessionKinds.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-objective-chat-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const objectiveService = new ObjectiveApplicationService({ store });
  return { directory, store, objectiveService };
}

test("objectiveChat is a distinct persisted Session kind bound to an Objective without a WorkItem", async () => {
  const { directory, store, objectiveService } = await fixture();
  try {
    const objective = objectiveService.createObjective({ name: "Objective Chat" });
    store.createSession({ id: "chat", title: "Chat", agentId: "assistant", sessionKind: "assistantChat" });
    const session = store.bindSessionToObjective("chat", objective.id);
    assert.equal(session.sessionKind, "objectiveChat");
    assert.equal(session.objectiveId, objective.id);
    assert.equal(session.workItemId, null);
    assert.equal(normalizeSessionKind("objectiveChat"), "objectiveChat");
    assert.equal(inferSessionKind({ objectiveId: objective.id }), "objectiveChat");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Objective Chat context is bounded and includes traceable Objective state", async () => {
  const { directory, store, objectiveService } = await fixture();
  try {
    const objective = objectiveService.createObjective({
      name: "Ship feature", description: "Discuss and decompose", idealState: "Delivery remains reliable across every path"
    });
    objectiveService.createWorkItem({ objectiveId: objective.id, title: "Backend" });
    const context = new ObjectiveChatContextService({ store, characterBudget: 2_000 }).build(objective.id);
    assert.equal(context.objectiveId, objective.id);
    assert.ok(context.characters <= 2_100);
    assert.match(context.prompt, /Delivery remains reliable across every path/);
    assert.match(context.prompt, /Backend/);
    assert.ok(context.generatedAt);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Objective Chat tools enforce the bound Objective and contributor scope", async () => {
  const { directory, store, objectiveService } = await fixture();
  try {
    const contributor = store.createAgent({ name: "IC", role: "independentContributor", provider: "codex" });
    const planner = store.createAgent({ name: "Planner", role: "independentContributor", provider: "codex" });
    const outsider = store.createAgent({ name: "Outside", role: "independentContributor", provider: "codex" });
    const objective = objectiveService.createObjective({ name: "Scoped", contributorAgentIds: [contributor.agentId, planner.agentId] });
    const other = objectiveService.createObjective({ name: "Other" });
    const scopedItem = objectiveService.createWorkItem({ objectiveId: objective.id, title: "Scoped item" });
    const otherItem = objectiveService.createWorkItem({ objectiveId: other.id, title: "Other item" });
    const starts = [];
    const service = new ObjectiveChatOperationService({
      store,
      objectiveService,
      contextService: new ObjectiveChatContextService({ store }),
      startWorkItem: (input) => { starts.push(input); return { id: "worker" }; }
    });
    const metadata = { sessionKind: "objectiveChat", objectiveId: objective.id };
    const agents = await service.execute({ tool: "corptie_objective_agents_list", metadata, arguments: {} });
    assert.deepEqual(new Set(agents.map((agent) => agent.agentId)), new Set([contributor.agentId, planner.agentId]));
    assert.equal(agents.find((agent) => agent.agentId === contributor.agentId).canStartWorkItem, true);
    assert.equal(agents.find((agent) => agent.agentId === planner.agentId).canStartWorkItem, true);
    assert.equal(agents.some((agent) => agent.agentId === outsider.agentId), false);
    const created = await service.execute({
      tool: "corptie_objective_work_items_manage", metadata,
      arguments: { action: "create", title: "New scoped item" }
    });
    assert.equal(created.objective_id, objective.id);
    await assert.rejects(() => service.execute({
      tool: "corptie_objective_work_items_manage", metadata,
      arguments: { action: "get", work_item_id: otherItem.id }
    }), { code: "WORK_ITEM_OUTSIDE_OBJECTIVE" });
    await service.execute({
      tool: "corptie_objective_work_item_start", metadata,
      arguments: { work_item_id: scopedItem.id, agent_id: contributor.agentId }
    });
    assert.equal(starts.length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
