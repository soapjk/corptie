import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { HubService } from "../src/application/hubService.mjs";
import { CollaborationRouter } from "../src/application/collaborationRouter.mjs";
import { MemoryExtractor } from "../src/application/memoryExtractor.mjs";
import { AssistantService } from "../src/application/assistantService.mjs";
import { handleEntityHttpRequest } from "../src/application/entityHttpApi.mjs";

function mockResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(data) {
      this.body = data;
      this.headersSent = true;
    }
  };
}

function mockRequest(method, pathname, search = "", body = {}) {
  return {
    method,
    url: `http://localhost${pathname}${search}`,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    }
  };
}

async function createServices() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-http-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const objectiveService = new ObjectiveApplicationService({ store });
  return {
    store,
    directory,
    objectiveService,
    hubService: new HubService({ store }),
    router: new CollaborationRouter({ store }),
    memoryExtractor: new MemoryExtractor({ store }),
    assistantService: new AssistantService({ store, objectiveService })
  };
}

async function callApi({ method, pathname, search = "", body, ...services }) {
  const request = mockRequest(method, pathname, search, body);
  const response = mockResponse();
  const url = new URL(request.url);
  const handled = handleEntityHttpRequest({
    request,
    response,
    url,
    objectiveService: services.objectiveService,
    hubService: services.hubService,
    router: services.router,
    memoryExtractor: services.memoryExtractor,
    assistantService: services.assistantService
  });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    handled,
    statusCode: response.statusCode,
    body: response.body ? JSON.parse(response.body) : null
  };
}

test("POST /objectives → 创建，GET /objectives → 列表", async () => {
  const services = await createServices();
  try {
    const created = await callApi({ method: "POST", pathname: "/objectives", body: { name: "重构 Corptie" }, ...services });
    assert.equal(created.statusCode, 201);
    assert.ok(created.body.id);

    const listed = await callApi({ method: "GET", pathname: "/objectives", ...services });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.objectives.length, 1);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("Objective 挂靠资源：workspace/关联/contributor + 对称关联", async () => {
  const services = await createServices();
  try {
    const agent = await callApi({ method: "POST", pathname: "/agents", body: { name: "后端开发" }, ...services });
    const agentId = agent.body.agent.agentId;

    const a = await callApi({
      method: "POST", pathname: "/objectives",
      body: { name: "目标 A", workspaceIds: ["repo:1"], contributorAgentIds: [agentId] },
      ...services
    });
    assert.equal(a.statusCode, 201);
    assert.deepEqual(a.body.workspaceIds, ["repo:1"]);
    assert.deepEqual(a.body.contributorAgentIds, [agentId]);
    assert.deepEqual(a.body.relatedObjectiveIds, []);

    const b = await callApi({
      method: "POST", pathname: "/objectives",
      body: { name: "目标 B", relatedObjectiveIds: [a.body.id] },
      ...services
    });
    assert.equal(b.statusCode, 201);
    assert.deepEqual(b.body.relatedObjectiveIds, [a.body.id]);

    // 对称：B 关联 A 后，A 的 relatedObjectiveIds 也应反向包含 B
    const aRefreshed = await callApi({ method: "GET", pathname: `/objectives/${a.body.id}`, ...services });
    assert.deepEqual(aRefreshed.body.relatedObjectiveIds, [b.body.id]);

    // 取消关联：A 清空 relatedObjectiveIds，B 侧也应同步移除 A
    const aUpdated = await callApi({
      method: "PATCH", pathname: `/objectives/${a.body.id}`,
      body: { relatedObjectiveIds: [] },
      ...services
    });
    assert.deepEqual(aUpdated.body.relatedObjectiveIds, []);
    const bRefreshed = await callApi({ method: "GET", pathname: `/objectives/${b.body.id}`, ...services });
    assert.deepEqual(bRefreshed.body.relatedObjectiveIds, []);

    // 列出 Git 仓库（测试环境无仓库，返回空数组）
    const repos = await callApi({ method: "GET", pathname: "/repositories", ...services });
    assert.equal(repos.statusCode, 200);
    assert.ok(Array.isArray(repos.body.repositories));
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /work-items 挂 objective + 依赖环 409", async () => {
  const services = await createServices();
  try {
    const objective = await callApi({ method: "POST", pathname: "/objectives", body: { name: "目标" }, ...services });
    const objectiveId = objective.body.id;

    const itemA = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: { objectiveId, title: "A" },
      ...services
    });
    assert.equal(itemA.statusCode, 201);

    const itemB = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: { objectiveId, title: "B" },
      ...services
    });

    // A 依赖 B
    const dep = await callApi({
      method: "POST",
      pathname: `/work-items/${itemA.body.id}/dependencies`,
      body: { targetWorkItemId: itemB.body.id },
      ...services
    });
    assert.equal(dep.statusCode, 201);

    // B 依赖 A → 环，409
    const cycle = await callApi({
      method: "POST",
      pathname: `/work-items/${itemB.body.id}/dependencies`,
      body: { targetWorkItemId: itemA.body.id },
      ...services
    });
    assert.equal(cycle.statusCode, 409);
    assert.equal(cycle.body.code, "CYCLE_DETECTED");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("GET /memories + GET /hub/search 走通", async () => {
  const services = await createServices();
  try {
    services.hubService.store.createMemory({
      ownerType: "agent",
      ownerId: "a1",
      kind: "procedure",
      content: "git commit 流程"
    });

    const memories = await callApi({
      method: "GET",
      pathname: "/memories",
      search: "?ownerType=agent&ownerId=a1",
      ...services
    });
    assert.equal(memories.statusCode, 200);
    assert.equal(memories.body.memories.length, 1);

    const search = await callApi({
      method: "GET",
      pathname: "/hub/search",
      search: "?intent=git%20commit&agentId=a1",
      ...services
    });
    assert.equal(search.statusCode, 200);
    assert.equal(search.body.found, true);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("GET /collaboration/route 真正可达（修复死代码）", async () => {
  const services = await createServices();
  try {
    services.router.registerAgent({ agentId: "a1", capabilityTags: ["backend"], availability: "idle" });

    const route = await callApi({
      method: "GET",
      pathname: "/collaboration/route",
      search: "?capabilities=backend",
      ...services
    });
    assert.equal(route.statusCode, 200);
    assert.equal(route.body.candidates.length, 1);
    assert.equal(route.body.candidates[0].candidate.entry_id, "a1");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /memories 缺字段 → 400（不再撞 NOT NULL）", async () => {
  const services = await createServices();
  try {
    const missing = await callApi({
      method: "POST",
      pathname: "/memories",
      body: { ownerType: "agent", kind: "fact" }, // 缺 ownerId / content
      ...services
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body.code, "INVALID_INPUT");

    const ok = await callApi({
      method: "POST",
      pathname: "/memories",
      body: { ownerType: "agent", ownerId: "a1", kind: "fact", content: "手动记录" },
      ...services
    });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.body.owner_type, "agent");
    assert.equal(ok.body.source_type, "user");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /memories/extract 从 Session 提炼记忆（主路径）", async () => {
  const services = await createServices();
  try {
    services.store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    services.store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "tool_call", payload: { text: "git commit 流程" } });
    services.store.appendSessionEvent({ eventId: "e2", sessionId: "s1", type: "summary", payload: { summary: "完成实体层" } });

    const extract = await callApi({
      method: "POST",
      pathname: "/memories/extract",
      body: { sessionId: "s1", objectiveId: "o1", workItemId: "wi1", agentId: "a1" },
      ...services
    });
    assert.equal(extract.statusCode, 201);
    assert.equal(extract.body.memories.length, 2);
    const procedure = extract.body.memories.find((m) => m.kind === "procedure");
    assert.equal(procedure.owner_type, "agent");
    assert.equal(procedure.owner_id, "a1");

    // 缺 sessionId → 400
    const bad = await callApi({ method: "POST", pathname: "/memories/extract", body: {}, ...services });
    assert.equal(bad.statusCode, 400);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("GET /agents 返回带 role 的 Agent（预种助手 Corptie）", async () => {
  const services = await createServices();
  try {
    const agents = await callApi({ method: "GET", pathname: "/agents", ...services });
    assert.equal(agents.statusCode, 200);
    assert.ok(agents.body.agents.length >= 1);

    const assistant = agents.body.agents.find((a) => a.role === "assistant");
    assert.ok(assistant, "预种的助手 Agent 应存在");
    assert.equal(assistant.name, "Corptie");
    assert.equal(assistant.agentId, "assistant");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /assistant/chat 建目标（HTTP 层）", async () => {
  const services = await createServices();
  try {
    const chat = await callApi({
      method: "POST",
      pathname: "/assistant/chat",
      body: { content: "建目标 重构 Corptie" },
      ...services
    });
    assert.equal(chat.statusCode, 200);
    assert.equal(chat.body.messages.length, 2);
    assert.equal(chat.body.messages[1].kind, "receipt");
    assert.equal(chat.body.messages[1].data.objective.name, "重构 Corptie");

    // 缺 content → 400
    const bad = await callApi({ method: "POST", pathname: "/assistant/chat", body: {}, ...services });
    assert.equal(bad.statusCode, 400);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /agents 创建独立贡献者 Agent", async () => {
  const services = await createServices();
  try {
    const created = await callApi({
      method: "POST",
      pathname: "/agents",
      body: { name: "后端开发", provider: "codex" },
      ...services
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.agent.name, "后端开发");
    assert.equal(created.body.agent.role, "independentContributor");
    assert.equal(created.body.agent.provider, "codex");

    // 缺 name → 400
    const bad = await callApi({ method: "POST", pathname: "/agents", body: {}, ...services });
    assert.equal(bad.statusCode, 400);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("PATCH /agents/:id 编辑 Agent", async () => {
  const services = await createServices();
  try {
    const created = await callApi({
      method: "POST",
      pathname: "/agents",
      body: { name: "后端开发", provider: "codex" },
      ...services
    });
    const id = created.body.agent.agentId;

    const updated = await callApi({
      method: "PATCH",
      pathname: `/agents/${id}`,
      body: { name: "后端开发 2", description: "负责后端", systemPrompt: "你是后端专家", status: "inactive" },
      ...services
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.agent.name, "后端开发 2");
    assert.equal(updated.body.agent.description, "负责后端");
    assert.equal(updated.body.agent.systemPrompt, "你是后端专家");
    assert.equal(updated.body.agent.status, "inactive");

    // 不存在的 id → 404
    const missing = await callApi({ method: "PATCH", pathname: "/agents/nope", body: { name: "x" }, ...services });
    assert.equal(missing.statusCode, 404);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("DELETE /agents/:id 删除 Agent", async () => {
  const services = await createServices();
  try {
    const created = await callApi({
      method: "POST",
      pathname: "/agents",
      body: { name: "待删除" },
      ...services
    });
    const id = created.body.agent.agentId;

    const deleted = await callApi({ method: "DELETE", pathname: `/agents/${id}`, ...services });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.ok, true);

    const list = await callApi({ method: "GET", pathname: "/agents", ...services });
    assert.equal(list.body.agents.some((a) => a.agentId === id), false);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});
