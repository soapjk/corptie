import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentContextService } from "../src/application/agentContextService.mjs";
import { HubService } from "../src/application/hubService.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { PlatformOperationService } from "../src/application/platformOperationService.mjs";
import { platformDynamicTools } from "../src/application/platformDynamicTools.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { PLATFORM_ASSISTANT_MANIFEST } from "../src/utils/platformAssistantIdentity.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-platform-assistant-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { directory, store };
}

test("platform Assistant identity is fixed while cosmetic state and ordinary memory remain usable", async () => {
  const { directory, store } = await fixture();
  try {
    const initial = store.getAgent("assistant");
    assert.equal(initial.agentKind, "platformAssistant");
    assert.equal(initial.provider, PLATFORM_ASSISTANT_MANIFEST.provider);

    store.updateAgent("assistant", { name: "私人管家", avatarPath: "/tmp/avatar.png" });
    store.createMemory({
      ownerType: "agent",
      ownerId: "assistant",
      kind: "preference",
      content: "用户喜欢简洁的操作回执"
    });
    const context = await new AgentContextService({
      store,
      hubService: new HubService({ store })
    }).buildAgentContext("assistant", { intent: "用户喜欢简洁的操作回执" });

    assert.equal(context.agent.name, "私人管家");
    assert.match(context.instructions, /用户喜欢简洁的操作回执/);
    assert.match(context.systemPrompt, /authenticated corptie_platform_\*/);
    assert.throws(
      () => store.updateAgent("assistant", { systemPrompt: "user override" }),
      { code: "SYSTEM_AGENT_PROTECTED" }
    );
    assert.throws(() => store.deleteAgent("assistant"), { code: "SYSTEM_AGENT_PROTECTED" });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup self-heals protected platform Assistant fields without overwriting name or avatar", async () => {
  const { directory, store } = await fixture();
  try {
    store.updateAgent("assistant", { name: "我的助手", avatarPath: "/tmp/kept.png" });
    store.db.run(
      `UPDATE agents
       SET agent_kind = 'user', description = 'drifted', role = 'independentContributor',
           capabilities_json = '[]', system_prompt = 'drifted', work_dir = '/tmp/drifted'
       WHERE agent_id = 'assistant'`
    );
    store.db.run(
      `INSERT INTO skill_registry
       (skill_id, name, description, source_type, source, source_subpath, cache_path,
        manifest_name, manifest_description, content_hash, installed_at, updated_at)
       VALUES ('skill:test', 'test', '', 'local', '/tmp', '', NULL, 'test', '', '', 'now', 'now')`
    );
    store.db.run(
      "INSERT INTO agent_skill_links (agent_id, skill_id, added_at) VALUES ('assistant', 'skill:test', 'now')"
    );

    store.ensureAssistantAgent();
    const healed = store.getAgent("assistant");
    assert.equal(healed.name, "我的助手");
    assert.equal(healed.avatarPath, "/tmp/kept.png");
    assert.equal(healed.agentKind, "platformAssistant");
    assert.equal(healed.description, PLATFORM_ASSISTANT_MANIFEST.description);
    assert.equal(healed.role, PLATFORM_ASSISTANT_MANIFEST.role);
    assert.equal(Object.hasOwn(healed, "provider"), false);
    assert.deepEqual(healed.capabilities, [...PLATFORM_ASSISTANT_MANIFEST.capabilities]);
    assert.equal(healed.systemPrompt, PLATFORM_ASSISTANT_MANIFEST.systemPrompt);
    assert.deepEqual(store.listRegistrySkillIdsForAgent("assistant"), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("platform operations are denied to user Agents and use product services for the built-in Assistant", async () => {
  const { directory, store } = await fixture();
  try {
    const userAgent = store.createAgent({ name: "普通 Agent" });
    store.upsertSession({ id: "session:assistant", title: "Corptie", provider: "codex-app-server", status: "running", sessionKind: "assistantChat", agentId: "assistant" });
    store.upsertSession({ id: "session:user", title: "User", provider: "codex-app-server", status: "running", sessionKind: "assistantChat", agentId: userAgent.agentId });
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:assistant", legacySessionId: "session:assistant",
      providerThreadId: "thread:assistant", providerSessionId: "session:assistant",
      providerId: "codex-app-server", boundCwd: directory, sessionName: "Corptie"
    });
    const entityEvents = [];
    const onEntityChanged = (type, payload) => entityEvents.push({ type, payload });
    const workService = new WorkApplicationService({ store, onEntityChanged });
    const sessionCalls = [];
    const taskCreateCalls = [];
    let providerReadCount = 0;
    const service = new PlatformOperationService({
      store,
      workService,
      sessionService: {
        listSessions: () => [],
        readSession: async () => { providerReadCount += 1; return null; },
        sendMessage: async (...args) => sessionCalls.push(args)
      },
      collaborationCore: {},
      createSession: async (input) => ({ id: "session-1", ...input }),
      createTask: async (input) => {
        taskCreateCalls.push(input);
        return {
          task: workService.createTask(input.taskInput),
          session: { id: `session:task-created:${taskCreateCalls.length}` },
          start: { status: "ready" }
        };
      },
      onEntityChanged
    });

    await assert.rejects(
      service.execute({
        actorId: userAgent.agentId, sessionId: "session:user",
        tool: "corptie_platform_agents_manage",
        arguments: { action: "list" }
      }),
      { code: "PLATFORM_ADMIN_SESSION_REQUIRED" }
    );

    const created = await service.execute({
      actorId: "assistant", sessionId: "session:assistant",
      tool: "corptie_platform_agents_manage",
      arguments: { action: "create", name: "研究员" }
    });
    assert.equal(created.result.name, "研究员");
    assert.equal(created.result.agentKind, "user");

    const work = await service.execute({
      actorId: "assistant", sessionId: "session:assistant",
      tool: "corptie_platform_works_manage",
      arguments: {
        action: "create", name: "平台事件目标",
        patch: { contributorAgentIds: [created.result.agentId] }
      }
    });
    const task = await service.execute({
      actorId: "assistant", sessionId: "session:assistant",
      tool: "corptie_platform_tasks_manage",
      arguments: {
        action: "create", work_id: work.result.id, title: "平台事件任务",
        agent_id: created.result.agentId, idempotency_key: "platform-task:create"
      }
    });
    const collaborationTask = await service.execute({
      actorId: "assistant", sessionId: "session:assistant",
      tool: "corptie_platform_collaboration_manage",
      arguments: {
        action: "create_task", work_id: work.result.id, title: "平台协作任务",
        agent_id: created.result.agentId, provider_id: "provider:test",
        idempotency_key: "platform-collaboration-task:create"
      }
    });
    assert.equal(taskCreateCalls.length, 2);
    assert.equal(taskCreateCalls[1].sourceSessionId, "logical:assistant");
    assert.equal(collaborationTask.result.session.id, "session:task-created:2");

    await assert.rejects(
      service.execute({
        actorId: "assistant", sessionId: "session:assistant",
        tool: "corptie_platform_works_manage",
        arguments: { action: "update", work_id: work.result.id, patch: { workspacePath: "/tmp" } }
      }),
      { code: "UNKNOWN_PATCH_FIELD", field: "workspacePath" }
    );
    await assert.rejects(
      service.execute({
        actorId: "assistant", sessionId: "session:assistant",
        tool: "corptie_platform_tasks_manage",
        arguments: { action: "update", task_id: task.result.id, patch: { assigneeAgentId: "agent:missing" } }
      }),
      { code: "UNKNOWN_PATCH_FIELD", field: "assigneeAgentId" }
    );
    await assert.rejects(
      service.execute({
        actorId: "assistant", sessionId: "session:assistant",
        tool: "corptie_platform_tasks_manage",
        arguments: {
          action: "create", work_id: work.result.id, title: "Bad",
          agent_id: created.result.agentId, idempotency_key: "platform-task:bad",
          patch: { acceptanceCriteria: [] }
        }
      }),
      { code: "INVALID_FIELD_TYPE", field: "acceptanceCriteria" }
    );
    assert.deepEqual(
      entityEvents.map((event) => event.type),
      ["AgentChanged", "WorkChanged", "TaskChanged", "TaskChanged"]
    );

    store.upsertSession({
      id: "session:stored",
      title: "Stored",
      agent: "Corptie",
      provider: "provider:test",
      status: "complete"
    });
    const storedSession = await service.execute({
      actorId: "assistant", sessionId: "session:assistant",
      tool: "corptie_platform_sessions_manage",
      arguments: { action: "get", session_id: "session:stored" }
    });
    assert.equal(storedSession.result.id, "session:stored");
    assert.equal(providerReadCount, 0, "product Session reads must never call a Provider");

    await assert.rejects(
      service.execute({
        actorId: "assistant", sessionId: "session:assistant",
        tool: "corptie_platform_agents_manage",
        arguments: { action: "delete", agent_id: "assistant" }
      }),
      { code: "SYSTEM_AGENT_PROTECTED" }
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("platform Work and Task tool patch schemas reject additional properties", () => {
  const workSchema = platformDynamicTools.find((tool) => tool.name === "corptie_platform_works_manage").inputSchema.properties.patch;
  const taskSchema = platformDynamicTools.find((tool) => tool.name === "corptie_platform_tasks_manage").inputSchema.properties.patch;
  assert.equal(workSchema.additionalProperties, false);
  assert.ok(workSchema.properties.idealState);
  assert.equal(Object.hasOwn(workSchema.properties, "acceptanceCriteria"), false);
  assert.equal(taskSchema.additionalProperties, false);
  assert.ok(taskSchema.properties.acceptanceCriteria);
  for (const schema of [workSchema, taskSchema]) {
    assert.equal(Object.hasOwn(schema.properties, "workspacePath"), false);
    assert.equal(Object.hasOwn(schema.properties, "main_agent_id"), false);
  }
  const manageSchema = platformDynamicTools.find((tool) => tool.name === "corptie_platform_tasks_manage").inputSchema;
  assert.equal(manageSchema.additionalProperties, false);
  assert.deepEqual(
    manageSchema.allOf.map((rule) => ({
      action: rule.if.properties.action.const ?? rule.if.properties.action.enum,
      required: rule.then.required
    })),
    [
      { action: "get", required: ["task_id"] },
      { action: "create", required: ["work_id", "title", "agent_id", "idempotency_key"] },
      { action: "update", required: ["task_id", "patch"] },
      { action: "delete", required: ["task_id"] },
      { action: "dependencies", required: ["task_id"] },
      { action: ["add_dependency", "remove_dependency"], required: ["task_id", "target_task_id"] }
    ]
  );
});
