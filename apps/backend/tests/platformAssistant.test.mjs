import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentContextService } from "../src/application/agentContextService.mjs";
import { HubService } from "../src/application/hubService.mjs";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { PlatformOperationService } from "../src/application/platformOperationService.mjs";
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
           provider = 'openclacky', capabilities_json = '[]', system_prompt = 'drifted', work_dir = '/tmp/drifted'
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
    assert.equal(healed.provider, PLATFORM_ASSISTANT_MANIFEST.provider);
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
    const entityEvents = [];
    const onEntityChanged = (type, payload) => entityEvents.push({ type, payload });
    const objectiveService = new ObjectiveApplicationService({ store, onEntityChanged });
    const sessionCalls = [];
    const service = new PlatformOperationService({
      store,
      objectiveService,
      sessionService: {
        listSessions: () => [],
        readSession: async () => null,
        sendMessage: async (...args) => sessionCalls.push(args)
      },
      createSession: async (input) => ({ id: "session-1", ...input }),
      onEntityChanged
    });

    await assert.rejects(
      service.execute({
        actorId: userAgent.agentId,
        tool: "corptie_platform_agents_manage",
        arguments: { action: "list" }
      }),
      { code: "PLATFORM_ADMIN_REQUIRED" }
    );

    const created = await service.execute({
      actorId: "assistant",
      tool: "corptie_platform_agents_manage",
      arguments: { action: "create", name: "研究员", provider: "codex-app-server" }
    });
    assert.equal(created.result.name, "研究员");
    assert.equal(created.result.agentKind, "user");

    const objective = await service.execute({
      actorId: "assistant",
      tool: "corptie_platform_objectives_manage",
      arguments: { action: "create", name: "平台事件目标" }
    });
    await service.execute({
      actorId: "assistant",
      tool: "corptie_platform_work_items_manage",
      arguments: { action: "create", objective_id: objective.result.id, title: "平台事件任务" }
    });
    assert.deepEqual(
      entityEvents.map((event) => event.type),
      ["AgentChanged", "ObjectiveChanged", "WorkItemChanged"]
    );

    await assert.rejects(
      service.execute({
        actorId: "assistant",
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
