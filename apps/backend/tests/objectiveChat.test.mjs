import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import {
  OBJECTIVE_CHAT_REPOSITORY_CHANGE_RULE,
  ObjectiveChatContextService
} from "../src/application/objectiveChatContextService.mjs";
import { ObjectiveChatOperationService, objectiveChatDynamicTools } from "../src/application/objectiveChatDynamicTools.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { assertExplicitSessionKind, inferSessionKind, normalizeSessionKind } from "../src/utils/sessionKinds.mjs";

test("explicit empty, unknown, and legacy classifications are rejected at product write boundaries", async () => {
  for (const value of ["", "unknown", "legacy", null]) {
    assert.throws(() => assertExplicitSessionKind(value), { code: "SESSION_KIND_INVALID" });
  }
  const { directory, store } = await fixture();
  try {
    assert.throws(
      () => store.createSession({ id: "invalid", sessionKind: "unknown" }),
      { code: "SESSION_KIND_INVALID" }
    );
    store.createSession({ id: "valid", sessionKind: "assistantChat" });
    assert.throws(
      () => store.setSessionKind("valid", " "),
      { code: "SESSION_KIND_INVALID" }
    );
    assert.equal(store.getSession("valid").sessionKind, "assistantChat");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup migration repairs illegal stored classifications from authoritative ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-kind-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  let store = new CorptieStore({ dbPath, configPath });
  try {
    await store.initialize();
    const assistant = store.createAgent({ id: "agent:assistant", name: "Assistant", role: "assistant" });
    store.createSession({ id: "recoverable", agentId: assistant.agentId, sessionKind: "assistantChat" });
    store.createSession({ id: "unowned", sessionKind: "assistantChat" });
    store.db.run("UPDATE sessions SET session_kind = 'not-a-kind' WHERE id IN ('recoverable', 'unowned')");
    await store.close();

    store = new CorptieStore({ dbPath, configPath });
    await store.initialize();

    assert.equal(store.getSession("recoverable").sessionKind, "assistantChat");
    assert.equal(store.getSession("unowned").sessionKind, "legacy");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-objective-chat-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const objectiveService = new ObjectiveApplicationService({ store });
  return { directory, store, objectiveService };
}

test("objectiveChat is a distinct persisted Session kind bound to an Objective without a Task", async () => {
  const { directory, store, objectiveService } = await fixture();
  try {
    const objective = objectiveService.createObjective({ name: "Objective Chat" });
    store.createSession({ id: "chat", title: "Chat", agentId: "assistant", sessionKind: "assistantChat" });
    const session = store.bindSessionToObjective("chat", objective.id);
    assert.equal(session.sessionKind, "objectiveChat");
    assert.equal(session.objectiveId, objective.id);
    assert.equal(session.taskId, null);
    assert.equal(normalizeSessionKind("objectiveChat"), "objectiveChat");
    assert.equal(inferSessionKind({ objectiveId: objective.id }), "objectiveChat");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an Objective keeps only its first bound Objective Chat Session", async () => {
  const { directory, store, objectiveService } = await fixture();
  try {
    const objective = objectiveService.createObjective({ name: "Unique Objective Chat" });
    store.createSession({ id: "first-chat", title: "First", sessionKind: "assistantChat" });
    store.createSession({ id: "second-chat", title: "Second", sessionKind: "assistantChat" });

    const first = store.bindSessionToObjective("first-chat", objective.id);
    const reused = store.bindSessionToObjective("second-chat", objective.id);

    assert.equal(reused.id, first.id);
    assert.equal(store.getSession("second-chat").objectiveId, null);
    assert.deepEqual(
      store.listSessionsByObjective(objective.id).filter((session) => session.sessionKind === "objectiveChat").map((session) => session.id),
      ["first-chat"]
    );
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
    objectiveService.createTask({ objectiveId: objective.id, title: "Backend" });
    const context = new ObjectiveChatContextService({ store, characterBudget: 3_000 }).build(objective.id);
    assert.equal(context.objectiveId, objective.id);
    assert.ok(context.characters <= 3_100);
    assert.match(context.prompt, /Delivery remains reliable across every path/);
    assert.match(context.prompt, /Backend/);
    assert.ok(context.generatedAt);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Objective Chat context delegates every code or repository mutation to a new Task", async () => {
  const { directory, store, objectiveService } = await fixture();
  try {
    const objective = objectiveService.createObjective({ name: "Delegated implementation" });
    const context = new ObjectiveChatContextService({ store }).build(objective.id);

    assert.ok(context.prompt.includes(OBJECTIVE_CHAT_REPOSITORY_CHANGE_RULE));
    assert.match(context.prompt, /requires any code change or repository-content mutation/);
    assert.match(context.prompt, /Do not switch or create a worktree/);
    assert.match(context.prompt, /do not edit, create, delete, rename, stage, commit/);
    assert.match(context.prompt, /First create a new Task in this Objective/);
    assert.match(context.prompt, /title, description, and acceptance criteria must record the concrete/);
    assert.match(context.prompt, /assign and start that Task so its Worker Session performs the actual changes and verification/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Objective Chat repository delegation rule preserves non-mutating discussion scope", () => {
  assert.match(
    OBJECTIVE_CHAT_REPOSITORY_CHANGE_RULE,
    /applies only when code or repository content must change/
  );
  assert.match(
    OBJECTIVE_CHAT_REPOSITORY_CHANGE_RULE,
    /Continue handling discussion, planning, status review, and other non-mutating Objective work normally/
  );
});

test("Objective Chat tools enforce the bound Objective and contributor scope", async () => {
  const { directory, store, objectiveService } = await fixture();
  try {
    const contributor = store.createAgent({ name: "IC", role: "independentContributor", provider: "codex" });
    const planner = store.createAgent({ name: "Planner", role: "independentContributor", provider: "codex" });
    const outsider = store.createAgent({ name: "Outside", role: "independentContributor", provider: "codex" });
    const objective = objectiveService.createObjective({ name: "Scoped", contributorAgentIds: [contributor.agentId, planner.agentId] });
    const other = objectiveService.createObjective({ name: "Other" });
    const scopedItem = objectiveService.createTask({ objectiveId: objective.id, title: "Scoped item" });
    const otherItem = objectiveService.createTask({ objectiveId: other.id, title: "Other item" });
    const starts = [];
    const service = new ObjectiveChatOperationService({
      store,
      objectiveService,
      contextService: new ObjectiveChatContextService({ store }),
      startTask: (input) => { starts.push(input); return { id: "worker" }; }
    });
    const metadata = { sessionKind: "objectiveChat", objectiveId: objective.id };
    const agents = await service.execute({ tool: "corptie_objective_agents_list", metadata, arguments: {} });
    assert.deepEqual(new Set(agents.map((agent) => agent.agentId)), new Set([contributor.agentId, planner.agentId]));
    assert.equal(agents.find((agent) => agent.agentId === contributor.agentId).canStartTask, true);
    assert.equal(agents.find((agent) => agent.agentId === planner.agentId).canStartTask, true);
    assert.equal(agents.some((agent) => agent.agentId === outsider.agentId), false);
    const created = await service.execute({
      tool: "corptie_objective_tasks_manage", metadata,
      arguments: { action: "create", title: "New scoped item" }
    });
    assert.equal(created.objective_id, objective.id);
    await assert.rejects(() => service.execute({
      tool: "corptie_objective_tasks_manage", metadata,
      arguments: { action: "get", task_id: otherItem.id }
    }), { code: "TASK_OUTSIDE_OBJECTIVE" });
    await service.execute({
      tool: "corptie_objective_task_start", metadata,
      arguments: { task_id: scopedItem.id, agent_id: contributor.agentId }
    });
    assert.equal(starts.length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Objective Chat dynamic tools expose no arbitrary Task update or delete surface", () => {
  const names = objectiveChatDynamicTools.map((tool) => tool.name);
  assert.deepEqual(names, ["corptie_objective_context", "corptie_objective_agents_list"]);
  assert.equal(names.some((name) => name.includes("manage") || name.includes("delete") || name.includes("update")), false);
});
