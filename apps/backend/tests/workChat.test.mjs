import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import {
  WORK_CHAT_REPOSITORY_CHANGE_RULE,
  WorkChatContextService
} from "../src/application/workChatContextService.mjs";
import { WorkChatOperationService, workChatDynamicTools } from "../src/application/workChatDynamicTools.mjs";
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
  const directory = await mkdtemp(join(tmpdir(), "corptie-work-chat-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const contributor = store.createAgent({
    id: "agent:work-chat-default",
    name: "Work Chat Worker",
    role: "independentContributor"
  });
  const workService = new WorkApplicationService({ store });
  return { directory, store, workService, contributor };
}

function createWork(workService, contributor, input) {
  return workService.createWork({ ...input, contributorAgentIds: [contributor.agentId] });
}

test("workChat is a distinct persisted Session kind bound to an Work without a Task", async () => {
  const { directory, store, workService, contributor } = await fixture();
  try {
    const work = createWork(workService, contributor, { name: "Work Chat" });
    store.createSession({ id: "chat", title: "Chat", agentId: "assistant", sessionKind: "assistantChat" });
    const session = store.bindSessionToWork("chat", work.id);
    assert.equal(session.sessionKind, "workChat");
    assert.equal(session.workId, work.id);
    assert.equal(session.taskId, null);
    assert.equal(normalizeSessionKind("workChat"), "workChat");
    assert.equal(inferSessionKind({ workId: work.id }), "workChat");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an Work keeps only its first bound Work Chat Session", async () => {
  const { directory, store, workService, contributor } = await fixture();
  try {
    const work = createWork(workService, contributor, { name: "Unique Work Chat" });
    store.createSession({ id: "first-chat", title: "First", sessionKind: "assistantChat" });
    store.createSession({ id: "second-chat", title: "Second", sessionKind: "assistantChat" });

    const first = store.bindSessionToWork("first-chat", work.id);
    const reused = store.bindSessionToWork("second-chat", work.id);

    assert.equal(reused.id, first.id);
    assert.equal(store.getSession("second-chat").workId, null);
    assert.deepEqual(
      store.listSessionsByWork(work.id).filter((session) => session.sessionKind === "workChat").map((session) => session.id),
      ["first-chat"]
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Work Chat context is bounded and includes traceable Work state", async () => {
  const { directory, store, workService, contributor } = await fixture();
  try {
    const work = createWork(workService, contributor, {
      name: "Ship feature", description: "Delivery remains reliable across every path", profile: "software"
    });
    workService.createTask({ workId: work.id, title: "Backend" });
    const context = new WorkChatContextService({ store, characterBudget: 3_000 }).build(work.id);
    assert.equal(context.workId, work.id);
    assert.ok(context.characters <= 3_100);
    assert.match(context.prompt, /Delivery remains reliable across every path/);
    assert.match(context.prompt, /Backend/);
    assert.ok(context.generatedAt);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Work Chat context forbids Task creation without a direct explicit user request", async () => {
  const { directory, store, workService, contributor } = await fixture();
  try {
    const work = createWork(workService, contributor, { name: "Delegated implementation" });
    const context = new WorkChatContextService({ store }).build(work.id);

    assert.ok(context.prompt.includes(WORK_CHAT_REPOSITORY_CHANGE_RULE));
    assert.match(context.prompt, /requires any code change or repository-content mutation/);
    assert.match(context.prompt, /Do not switch or create a worktree/);
    assert.match(context.prompt, /do not edit, create, delete, rename, stage, commit/);
    assert.match(context.prompt, /Never create a new Task unless the direct user explicitly asks/);
    assert.match(context.prompt, /Complexity, code changes, decomposition, parallelism, missing information/);
    assert.match(context.prompt, /Do not infer consent/);
    assert.match(context.prompt, /explicitly requests a new Task, its title, description, and acceptance criteria/);
    assert.match(context.prompt, /Task creation starts its Worker Session automatically/);
    assert.match(context.prompt, /never request or perform a separate start action/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Work Chat repository delegation rule preserves non-mutating discussion scope", () => {
  assert.match(
    WORK_CHAT_REPOSITORY_CHANGE_RULE,
    /applies only when code or repository content must change/
  );
  assert.match(
    WORK_CHAT_REPOSITORY_CHANGE_RULE,
    /Continue handling discussion, planning, status review, and other non-mutating Work work normally/
  );
  assert.doesNotMatch(WORK_CHAT_REPOSITORY_CHANGE_RULE, /Create a new Task in this Work with an assignee/);
});

test("Work Chat tools enforce the bound Work and contributor scope", async () => {
  const { directory, store, workService } = await fixture();
  try {
    const contributor = store.createAgent({ name: "IC", role: "independentContributor", provider: "codex" });
    const planner = store.createAgent({ name: "Planner", role: "independentContributor", provider: "codex" });
    const outsider = store.createAgent({ name: "Outside", role: "independentContributor", provider: "codex" });
    const work = workService.createWork({ name: "Scoped", contributorAgentIds: [contributor.agentId, planner.agentId] });
    const other = createWork(workService, contributor, { name: "Other" });
    const scopedItem = workService.createTask({ workId: work.id, title: "Scoped item" });
    const otherItem = workService.createTask({ workId: other.id, title: "Other item" });
    const starts = [];
    const service = new WorkChatOperationService({
      store,
      workService,
      contextService: new WorkChatContextService({ store }),
      workSessionStartApplicationService: {
        start: (input) => { starts.push(input); return { session: { id: "worker" } }; }
      },
      defaultProviderId: "codex-app-server"
    });
    const metadata = {
      sessionKind: "workChat", workId: work.id, sessionId: "session:work"
    };
    const agents = await service.execute({ tool: "corptie_work_agents_list", metadata, arguments: {} });
    assert.deepEqual(new Set(agents.map((agent) => agent.agentId)), new Set([contributor.agentId, planner.agentId]));
    assert.equal(agents.find((agent) => agent.agentId === contributor.agentId).canStartTask, true);
    assert.equal(agents.find((agent) => agent.agentId === planner.agentId).canStartTask, true);
    assert.equal(agents.some((agent) => agent.agentId === outsider.agentId), false);
    const created = await service.execute({
      tool: "corptie_work_tasks_manage", metadata,
      arguments: { action: "create", title: "New scoped item" }
    });
    assert.equal(created.work_id, work.id);
    await assert.rejects(() => service.execute({
      tool: "corptie_work_tasks_manage", metadata,
      arguments: { action: "get", task_id: otherItem.id }
    }), { code: "TASK_OUTSIDE_WORK" });
    await service.execute({
      tool: "corptie_work_task_start", metadata,
      arguments: {
        task_id: scopedItem.id, agent_id: contributor.agentId,
        resource_version: scopedItem.resource_version, provider_id: "codex-app-server",
        idempotency_key: "work-start:one"
      }
    });
    assert.equal(starts.length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Work Chat dynamic tools expose no arbitrary Task update or delete surface", () => {
  const names = workChatDynamicTools.map((tool) => tool.name);
  assert.deepEqual(names, ["corptie_work_context", "corptie_work_agents_list"]);
  assert.equal(names.some((name) => name.includes("manage") || name.includes("delete") || name.includes("update")), false);
});
