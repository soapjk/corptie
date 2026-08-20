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
  const entityEvents = [];
  const onEntityChanged = (type, payload) => entityEvents.push({ type, payload });
  const objectiveService = new ObjectiveApplicationService({ store, onEntityChanged });
  return {
    store,
    directory,
    entityEvents,
    onEntityChanged,
    objectiveService,
    hubService: new HubService({ store }),
    router: new CollaborationRouter({ store }),
    memoryExtractor: new MemoryExtractor({ store }),
    assistantService: new AssistantService({ store, objectiveService, onEntityChanged })
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
    assistantService: services.assistantService,
    skillRegistryService: services.skillRegistryService,
    backgroundAgentService: services.backgroundAgentService,
    createSession: services.createSession,
    launchSession: services.launchSession,
    launchAgentSession: services.launchAgentSession,
    launchObjectiveChatSession: services.launchObjectiveChatSession,
    resolveAgentAvailability: services.resolveAgentAvailability,
    suggestAgentSessionTitle: services.suggestAgentSessionTitle,
    onEntityChanged: services.onEntityChanged
  });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    handled,
    statusCode: response.statusCode,
    body: response.body ? JSON.parse(response.body) : null
  };
}

test("GET /skills/runtime-events exposes filterable persisted stage diagnostics", async () => {
  const services = await createServices();
  try {
    const calls = [];
    const result = await callApi({
      method: "GET",
      pathname: "/skills/runtime-events",
      search: "?agentId=agent%3Ainvestor&sessionId=session%3A1&stage=session-recovery&limit=25",
      skillRegistryService: {
        runtimeEvents(filters) {
          calls.push(filters);
          return [{
            eventId: "skill_event:1",
            stage: "session-recovery",
            status: "success",
            agentId: "agent:investor",
            sessionId: "session:1",
            providerId: "codex-app-server",
            serverNames: ["investrace"],
            toolCount: 24
          }];
        }
      },
      ...services
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.events[0].toolCount, 24);
    assert.equal(calls[0].agentId, "agent:investor");
    assert.equal(calls[0].stage, "session-recovery");
    assert.equal(calls[0].limit, "25");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

function registerRepository(store, repositoryId = "repository:test", worktreeId = "worktree:test") {
  const observedAt = "2026-08-17T00:00:00.000Z";
  store.upsertGitWorkspaceSnapshot({
    repository: {
      id: repositoryId,
      commonGitDirCanonicalPath: `/tmp/${repositoryId.slice("repository:".length)}/.git`,
      discoveredAt: observedAt,
      lastValidatedAt: observedAt
    },
    worktrees: [{
      worktreeId,
      repositoryId,
      path: `/tmp/${repositoryId.slice("repository:".length)}`,
      canonicalPath: `/tmp/${repositoryId.slice("repository:".length)}`,
      gitDirCanonicalPath: `/tmp/${repositoryId.slice("repository:".length)}/.git`,
      isMain: true,
      availability: "available",
      headOid: "a".repeat(40),
      branchRef: "refs/heads/main",
      branchName: "main",
      isDetached: false,
      isLocked: false,
      lockReason: null,
      isPrunable: false,
      pruneReason: null,
      inventoryVersion: "inventory:test",
      observedAt
    }],
    inventoryVersion: "inventory:test",
    observedAt
  });
  return repositoryId;
}

test("POST /assist/form-draft generates every field without creating an entity", async () => {
  const services = await createServices();
  try {
    const calls = [];
    const result = await callApi({
      method: "POST",
      pathname: "/assist/form-draft",
      body: {
        formType: "workItem",
        prompt: "实现统一的一键填充",
        currentValues: { title: "", description: "", acceptanceCriteria: "", priority: "medium" }
      },
      backgroundAgentService: {
        async run(input) {
          calls.push(input);
          return {
            providerId: "fake-provider",
            text: JSON.stringify({
              title: "统一帮我写",
              description: "一次生成并回填全部字段。",
              acceptanceCriteria: "- 所有字段可编辑\n- 不自动创建实体",
              priority: "high"
            })
          };
        }
      },
      ...services
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.formType, "workItem");
    assert.equal(result.body.fields.title, "统一帮我写");
    assert.equal(result.body.providerId, "fake-provider");
    assert.equal(calls[0].purpose, "assist-form-draft");
    assert.equal(calls[0].permissionProfile, "read-only");
    assert.equal(services.store.listWorkItems().length, 0);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /assist/form-draft shares one structured contract across Agent and Objective forms", async () => {
  const services = await createServices();
  try {
    const calls = [];
    const backgroundAgentService = {
      async run(input) {
        calls.push(input);
        if (input.intent.startsWith("agent:")) {
          return {
            providerId: "fake-provider",
            text: JSON.stringify({
              name: "SwiftUI Agent",
              description: "负责 macOS 客户端体验。",
              role: "independentContributor",
              systemPrompt: "实现变更并运行相关测试。",
              capabilities: "swiftui, testing"
            })
          };
        }
        return {
          providerId: "fake-provider",
          text: JSON.stringify({
            name: "统一创建页辅助填写",
            description: "统一三个实体创建页的草稿生成体验。",
            acceptanceCriteria: "- Agent 创建页可回填\n- Objective 创建页可回填\n- WorkItem 创建页可回填",
            priority: "high",
            targetDate: "2026-09-01",
            tags: "macos, forms"
          })
        };
      }
    };

    const agentResult = await callApi({
      method: "POST",
      pathname: "/assist/form-draft",
      body: {
        formType: "agent",
        prompt: "创建 SwiftUI 客户端 Agent",
        agentId: "agent:test-drafter",
        currentValues: {
          name: "",
          description: "",
          role: "independentContributor",
          systemPrompt: "",
          capabilities: ""
        }
      },
      backgroundAgentService,
      ...services
    });
    const objectiveResult = await callApi({
      method: "POST",
      pathname: "/assist/form-draft",
      body: {
        formType: "objective",
        prompt: "统一创建页",
        currentValues: {
          name: "",
          description: "",
          acceptanceCriteria: "",
          priority: "",
          targetDate: "",
          tags: ""
        }
      },
      backgroundAgentService,
      ...services
    });

    assert.equal(agentResult.statusCode, 200);
    assert.equal(agentResult.body.fields.role, "independentContributor");
    assert.equal(objectiveResult.statusCode, 200);
    assert.equal(objectiveResult.body.fields.targetDate, "2026-09-01");
    assert.equal(objectiveResult.body.fields.priority, "high");
    assert.equal(calls[0].agentId, "agent:test-drafter");
    assert.equal(calls[0].purpose, calls[1].purpose);
    assert.equal(services.store.listAgents().length, 1);
    assert.equal(services.store.listObjectives().length, 0);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /assist/form-draft rejects unknown input and malformed Agent fields", async () => {
  const services = await createServices();
  try {
    const unknownInput = await callApi({
      method: "POST",
      pathname: "/assist/form-draft",
      body: { formType: "agent", prompt: "后端专家", currentValues: { mystery: "value" } },
      backgroundAgentService: { run: async () => ({ text: "{}" }) },
      ...services
    });
    assert.equal(unknownInput.statusCode, 400);
    assert.equal(unknownInput.body.code, "INVALID_INPUT");

    const malformedOutput = await callApi({
      method: "POST",
      pathname: "/assist/form-draft",
      body: { formType: "agent", prompt: "后端专家" },
      backgroundAgentService: {
        run: async () => ({
          text: JSON.stringify({
            name: "后端专家",
            description: "维护接口",
            role: "worker",
            systemPrompt: "负责后端。",
            capabilities: "backend"
          })
        })
      },
      ...services
    });
    assert.equal(malformedOutput.statusCode, 502);
    assert.equal(malformedOutput.body.code, "INVALID_GENERATED_DRAFT");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /sessions delegates Provider-only creation when no WorkItem binding is requested", async () => {
  const services = await createServices();
  try {
    const calls = [];
    const result = await callApi({
      method: "POST",
      pathname: "/sessions",
      body: { providerId: "openclacky", title: "Task", cwd: "/tmp" },
      createSession: async (input) => {
        calls.push(input);
        return { id: "openclacky:native-1", title: input.title };
      },
      ...services
    });
    assert.equal(result.statusCode, 201);
    assert.equal(result.body.session.id, "openclacky:native-1");
    assert.equal(calls[0].providerId, "openclacky");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

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

test("Objective/WorkItem HTTP validation returns structured errors without SQLite details", async () => {
  const services = await createServices();
  try {
    const unknown = await callApi({
      method: "POST",
      pathname: "/objectives",
      body: { name: "Invalid", workspacePath: "/tmp/repo" },
      ...services
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.body.code, "UNKNOWN_FIELD");
    assert.equal(unknown.body.field, "workspacePath");
    assert.match(unknown.body.expected, /workspaceIds/);
    assert.equal(unknown.body.received.type, "string");

    const wrongType = await callApi({
      method: "POST",
      pathname: "/objectives",
      body: { name: "Invalid", acceptanceCriteria: { invalid: true } },
      ...services
    });
    assert.equal(wrongType.statusCode, 400);
    assert.equal(wrongType.body.code, "INVALID_FIELD_TYPE");
    assert.equal(wrongType.body.field, "acceptanceCriteria");
    assert.equal(wrongType.body.expected, "string");
    assert.doesNotMatch(wrongType.body.error, /SQLite|bind|constraint/i);
    assert.equal(services.store.listObjectives().length, 0);

    const objective = await callApi({
      method: "POST", pathname: "/objectives", body: { name: "Valid" }, ...services
    });
    const invalidPatch = await callApi({
      method: "PATCH",
      pathname: `/objectives/${objective.body.id}`,
      body: { agentId: "agent:missing" },
      ...services
    });
    assert.equal(invalidPatch.statusCode, 400);
    assert.equal(invalidPatch.body.code, "UNKNOWN_PATCH_FIELD");
    assert.equal(invalidPatch.body.field, "agentId");
    assert.equal(services.store.getObjective(objective.body.id).name, "Valid");

    const workItem = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: { objectiveId: objective.body.id, title: "Valid item" },
      ...services
    });
    const invalidWorkItemPatch = await callApi({
      method: "PATCH",
      pathname: `/work-items/${workItem.body.id}`,
      body: { main_agent_id: "agent:missing" },
      ...services
    });
    assert.equal(invalidWorkItemPatch.statusCode, 400);
    assert.equal(invalidWorkItemPatch.body.code, "UNKNOWN_PATCH_FIELD");
    assert.equal(invalidWorkItemPatch.body.field, "main_agent_id");
    assert.equal(services.store.getWorkItem(workItem.body.id).title, "Valid item");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /objectives/:id/sessions creates Objective Chat with any attached contributor and rejects outsiders", async () => {
  const services = await createServices();
  try {
    const planner = services.store.createAgent({ name: "Planner", role: "independentContributor" });
    const builder = services.store.createAgent({ name: "Builder", role: "independentContributor" });
    const outsider = services.store.createAgent({ name: "Outsider", role: "independentContributor" });
    const objective = services.objectiveService.createObjective({
      name: "Objective Chat",
      contributorAgentIds: [planner.agentId, builder.agentId]
    });
    const calls = [];
    const launchObjectiveChatSession = async (input) => {
      calls.push(input);
      return {
        id: `objective-chat:${calls.length}`, title: "Planning", agent: input.agent.name, agentId: input.agent.agentId,
        sessionKind: "objectiveChat", objectiveId: objective.id, workItemId: null,
        status: "running", progress: 0.5, summary: "Starting", updatedAt: new Date().toISOString(), accent: "cyan"
      };
    };
    for (const agent of [planner, builder]) {
      const result = await callApi({
        method: "POST",
        pathname: `/objectives/${objective.id}/sessions`,
        body: { agentId: agent.agentId, providerId: "codex-app-server", title: "Planning" },
        launchObjectiveChatSession,
        ...services
      });
      assert.equal(result.statusCode, 201);
      assert.equal(result.body.session.sessionKind, "objectiveChat");
      assert.equal(result.body.session.objectiveId, objective.id);
      assert.equal(result.body.session.workItemId, null);
    }
    assert.deepEqual(calls.map((call) => call.agent.agentId), [planner.agentId, builder.agentId]);
    assert.equal(calls[0].objective.id, objective.id);

    const rejected = await callApi({
      method: "POST",
      pathname: `/objectives/${objective.id}/sessions`,
      body: { agentId: outsider.agentId },
      launchObjectiveChatSession,
      ...services
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.body.code, "AGENT_OUTSIDE_OBJECTIVE");
    assert.equal(calls.length, 2);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("entity mutations publish provider-neutral refresh events", async () => {
  const services = await createServices();
  try {
    const objective = await callApi({
      method: "POST", pathname: "/objectives", body: { name: "事件目标" }, ...services
    });
    await callApi({
      method: "POST",
      pathname: "/work-items",
      body: { objectiveId: objective.body.id, title: "事件任务" },
      ...services
    });
    await callApi({ method: "POST", pathname: "/agents", body: { name: "事件 Agent" }, ...services });

    assert.deepEqual(
      services.entityEvents.map((event) => event.type),
      ["ObjectiveChanged", "WorkItemChanged", "AgentChanged"]
    );
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("Objective 挂靠资源：workspace/关联/contributor + 对称关联", async () => {
  const services = await createServices();
  try {
    const repositoryId = registerRepository(services.store);
    const agent = await callApi({ method: "POST", pathname: "/agents", body: { name: "后端开发" }, ...services });
    const agentId = agent.body.agent.agentId;

    const a = await callApi({
      method: "POST", pathname: "/objectives",
      body: { name: "目标 A", workspaceIds: [repositoryId], contributorAgentIds: [agentId] },
      ...services
    });
    assert.equal(a.statusCode, 201);
    assert.deepEqual(a.body.workspaceIds, [repositoryId]);
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
    assert.equal(itemA.body.acceptanceAssessment, null);

    const listed = await callApi({ method: "GET", pathname: "/work-items", ...services });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.workItems[0].acceptanceAssessment, null);

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

test("WorkItem completion requires a passing evidence-backed acceptance assessment", async () => {
  const services = await createServices();
  try {
    const objective = await callApi({
      method: "POST", pathname: "/objectives", body: { name: "验收目标" }, ...services
    });
    const created = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: {
        objectiveId: objective.body.id,
        title: "验收任务",
        acceptanceCriteria: "- Tests pass\n- App starts"
      },
      ...services
    });
    services.store.upsertSession({
      id: "acceptance-session",
      title: "执行验收任务",
      agent: "worker",
      provider: "codex-app-server",
      status: "complete"
    });
    services.objectiveService.bindSession("acceptance-session", created.body.id);

    await callApi({
      method: "PATCH",
      pathname: `/work-items/${created.body.id}`,
      body: { status: "in_progress" },
      ...services
    });

    const rejectedCompletion = await callApi({
      method: "PATCH",
      pathname: `/work-items/${created.body.id}`,
      body: { status: "done" },
      ...services
    });
    assert.equal(rejectedCompletion.statusCode, 400);
    assert.equal(rejectedCompletion.body.code, "ACCEPTANCE_NOT_PROVEN");

    const assessed = await callApi({
      method: "PUT",
      pathname: `/work-items/${created.body.id}/acceptance-assessment`,
      body: {
        sourceSessionId: "acceptance-session",
        results: [
          {
            criterion: "Tests pass",
            verdict: "passed",
            evidence: [{ summary: "Backend tests passed", reference: "npm test" }]
          },
          {
            criterion: "App starts",
            verdict: "passed",
            evidence: [{ summary: "Development processes healthy", reference: "dev-rebuild-restart" }]
          }
        ]
      },
      ...services
    });
    assert.equal(assessed.statusCode, 200);
    assert.equal(assessed.body.status, "in_progress");
    assert.equal(assessed.body.completionSuggestion.recommended, true);
    assert.equal(assessed.body.completionSuggestion.results.length, 2);

    const completed = await callApi({
      method: "POST",
      pathname: `/work-items/${created.body.id}/confirm-completion`,
      body: { confirmed: true },
      ...services
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.body.status, "done");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("explicit user confirmation completes an in-progress WorkItem without automatic proof", async () => {
  const services = await createServices();
  try {
    const objective = await callApi({
      method: "POST", pathname: "/objectives", body: { name: "人工裁决目标" }, ...services
    });
    const created = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: {
        objectiveId: objective.body.id,
        title: "人工确认任务",
        acceptanceCriteria: "User reviews the delivered result"
      },
      ...services
    });
    await callApi({
      method: "PATCH",
      pathname: `/work-items/${created.body.id}`,
      body: { status: "in_progress" },
      ...services
    });

    const missingConfirmation = await callApi({
      method: "POST",
      pathname: `/work-items/${created.body.id}/confirm-completion`,
      body: { confirmed: false },
      ...services
    });
    assert.equal(missingConfirmation.statusCode, 400);
    assert.equal(missingConfirmation.body.code, "USER_CONFIRMATION_REQUIRED");

    const completed = await callApi({
      method: "POST",
      pathname: `/work-items/${created.body.id}/confirm-completion`,
      body: { confirmed: true },
      ...services
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.body.status, "done");
    assert.equal(completed.body.completionSuggestion, null);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("multiple Sessions can contribute evidence without any Session lifecycle proving acceptance", async () => {
  const services = await createServices();
  try {
    const objective = await callApi({
      method: "POST", pathname: "/objectives", body: { name: "联合验收目标" }, ...services
    });
    const created = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: {
        objectiveId: objective.body.id,
        title: "联合验收任务",
        acceptanceCriteria: "- Implementation verified\n- Runtime verified"
      },
      ...services
    });

    for (const [id, status] of [["implementation-session", "complete"], ["verification-session", "paused"]]) {
      services.store.upsertSession({
        id,
        title: id,
        agent: "worker",
        provider: "codex-app-server",
        status
      });
      services.objectiveService.bindSession(id, created.body.id);
    }

    const beforeAssessment = await callApi({
      method: "GET", pathname: `/work-items/${created.body.id}`, ...services
    });
    assert.equal(beforeAssessment.body.completionSuggestion, null);

    const failed = await callApi({
      method: "PUT",
      pathname: `/work-items/${created.body.id}/acceptance-assessment`,
      body: {
        sourceSessionId: "verification-session",
        results: [
          {
            criterion: "Implementation verified",
            verdict: "passed",
            evidence: [{ summary: "Session A produced the implementation", reference: "session:implementation-session" }]
          },
          { criterion: "Runtime verified", verdict: "unknown", evidence: [] }
        ]
      },
      ...services
    });
    assert.equal(failed.statusCode, 200);
    assert.equal(failed.body.acceptanceAssessment.status, "not_proven");
    assert.equal(failed.body.completionSuggestion, null);

    const passed = await callApi({
      method: "PUT",
      pathname: `/work-items/${created.body.id}/acceptance-assessment`,
      body: {
        sourceSessionId: "verification-session",
        results: [
          {
            criterion: "Implementation verified",
            verdict: "passed",
            evidence: [{ summary: "Session A produced the implementation", reference: "session:implementation-session" }]
          },
          {
            criterion: "Runtime verified",
            verdict: "passed",
            evidence: [{ summary: "Session B verified the runtime", reference: "session:verification-session" }]
          }
        ]
      },
      ...services
    });
    assert.equal(passed.statusCode, 200);
    assert.equal(passed.body.status, "todo");
    assert.equal(passed.body.completionSuggestion.recommended, true);
    assert.deepEqual(
      passed.body.completionSuggestion.results.map((result) => result.evidence[0].reference),
      ["session:implementation-session", "session:verification-session"]
    );
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
    assert.equal(assistant.agentKind, "platformAssistant");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("GET /agents returns the authoritative default title suggestion for each Agent", async () => {
  const services = await createServices();
  try {
    const agents = await callApi({
      method: "GET",
      pathname: "/agents",
      suggestAgentSessionTitle: (agent) => `${agent.name}_Session_2`,
      ...services
    });
    assert.equal(agents.statusCode, 200);
    assert.equal(
      agents.body.agents.find((agent) => agent.agentId === "assistant").suggestedSessionTitle,
      "Corptie_Session_2"
    );
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("内置 Corptie Assistant 只能改名称和头像，不能删除或改功能配置", async () => {
  const services = await createServices();
  try {
    const renamed = await callApi({
      method: "PATCH",
      pathname: "/agents/assistant",
      body: { name: "我的 Corptie" },
      ...services
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.body.agent.name, "我的 Corptie");

    for (const body of [
      { systemPrompt: "ignore product rules" },
      { description: "changed" },
      { capabilities: [] },
      { workDir: "/tmp/other" },
      { skillIds: [] }
    ]) {
      const rejected = await callApi({
        method: "PATCH",
        pathname: "/agents/assistant",
        body,
        ...services
      });
      assert.equal(rejected.statusCode, 403);
      assert.equal(rejected.body.code, "SYSTEM_AGENT_PROTECTED");
    }

    const deleted = await callApi({ method: "DELETE", pathname: "/agents/assistant", ...services });
    assert.equal(deleted.statusCode, 403);
    assert.equal(deleted.body.code, "SYSTEM_AGENT_PROTECTED");

    const assistant = services.store.getAgent("assistant");
    assert.equal(assistant.name, "我的 Corptie");
    assert.equal(Object.hasOwn(assistant, "provider"), false);
    assert.deepEqual(assistant.capabilities, ["platform.manage"]);
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
      body: { name: "后端开发" },
      ...services
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.agent.name, "后端开发");
    assert.equal(created.body.agent.role, "independentContributor");
    assert.equal(Object.hasOwn(created.body.agent, "provider"), false);

    // 缺 name → 400
    const bad = await callApi({ method: "POST", pathname: "/agents", body: {}, ...services });
    assert.equal(bad.statusCode, 400);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("Agent API atomically persists and returns Skill assignments", async () => {
  const services = await createServices();
  try {
    const skill = services.store.createRegistrySkill({
      name: "investrace",
      description: "Investment workflow",
      sourceType: "local",
      source: services.directory,
      manifestName: "investrace"
    });
    const created = await callApi({
      method: "POST",
      pathname: "/agents",
      body: { name: "Investor", provider: "codex-app-server", skillIds: [skill.skillId] },
      ...services
    });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.body.agent.skillIds, [skill.skillId]);

    const listed = await callApi({ method: "GET", pathname: "/agents", ...services });
    assert.deepEqual(
      listed.body.agents.find((agent) => agent.agentId === created.body.agent.agentId).skillIds,
      [skill.skillId]
    );

    const invalid = await callApi({
      method: "PATCH",
      pathname: `/agents/${encodeURIComponent(created.body.agent.agentId)}`,
      body: { name: "Should Not Persist", skillIds: ["skill:missing"] },
      ...services
    });
    assert.equal(invalid.statusCode, 404);
    assert.equal(services.store.getAgent(created.body.agent.agentId).name, "Investor");
    assert.deepEqual(
      services.store.listRegistrySkillIdsForAgent(created.body.agent.agentId),
      [skill.skillId]
    );
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /agents 为每个 Assistant 分配独立 Workspace", async () => {
  const services = await createServices();
  try {
    const first = await callApi({
      method: "POST",
      pathname: "/agents",
      body: { name: "助手一", role: "assistant", provider: "codex-app-server" },
      ...services
    });
    const second = await callApi({
      method: "POST",
      pathname: "/agents",
      body: { name: "助手二", role: "assistant", provider: "claude-sdk" },
      ...services
    });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.notEqual(first.body.agent.workDir, second.body.agent.workDir);

    const conflict = await callApi({
      method: "PATCH",
      pathname: `/agents/${encodeURIComponent(second.body.agent.agentId)}`,
      body: { workDir: first.body.agent.workDir },
      ...services
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.code, "ASSISTANT_WORKSPACE_CONFLICT");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("Session 创建入口严格区分 Assistant Chat 与 Worker 角色", async () => {
  const services = await createServices();
  try {
    const objective = await callApi({
      method: "POST", pathname: "/objectives", body: { name: "目标" }, ...services
    });
    const workItem = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: { objectiveId: objective.body.id, title: "任务" },
      ...services
    });
    const assistantAsWorker = await callApi({
      ...services,
      method: "POST",
      pathname: "/sessions",
      body: { workItemId: workItem.body.id, agentId: "assistant" },
      launchSession: async () => { throw new Error("must not launch"); }
    });
    assert.equal(assistantAsWorker.statusCode, 400);
    assert.equal(assistantAsWorker.body.code, "AGENT_NOT_INDEPENDENT_CONTRIBUTOR");

    const contributor = await callApi({
      method: "POST", pathname: "/agents", body: { name: "贡献者" }, ...services
    });
    const contributorAsAssistant = await callApi({
      ...services,
      method: "POST",
      pathname: `/agents/${contributor.body.agent.agentId}/sessions`,
      body: {},
      launchAgentSession: async () => { throw new Error("must not launch"); }
    });
    assert.equal(contributorAsAssistant.statusCode, 400);
    assert.equal(contributorAsAssistant.body.code, "AGENT_NOT_ASSISTANT");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("Session 创建响应返回可直接增量写入客户端的完整分类与归属", async () => {
  const services = await createServices();
  try {
    const contributor = await callApi({
      method: "POST", pathname: "/agents", body: { name: "贡献者" }, ...services
    });
    const objective = await callApi({
      method: "POST", pathname: "/objectives",
      body: { name: "目标", contributorAgentIds: [contributor.body.agent.agentId] },
      ...services
    });
    const workItem = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: { objectiveId: objective.body.id, title: "任务" },
      ...services
    });
    const worker = await callApi({
      ...services,
      method: "POST",
      pathname: "/sessions",
      body: {
        workItemId: workItem.body.id,
        agentId: contributor.body.agent.agentId,
        providerId: "codex-app-server",
        title: "自定义 Worker"
      },
      launchSession: async ({ agent, title }) => {
        assert.equal(title, "自定义 Worker");
        services.store.upsertSession({
          id: "worker-session",
          title,
          agent: agent.name,
          agentId: agent.agentId,
          provider: "codex-app-server",
          status: "running",
          sessionKind: "worker"
        });
        return services.store.getSession("worker-session");
      }
    });
    assert.equal(worker.statusCode, 201);
    assert.equal(worker.body.session.sessionKind, "worker");
    assert.equal(worker.body.session.workItemId, workItem.body.id);
    assert.equal(worker.body.session.agentId, contributor.body.agent.agentId);
    assert.equal(worker.body.session.title, "自定义 Worker");
    assert.equal(Object.hasOwn(worker.body.session, "avatarPath"), false);

    const assistant = await callApi({
      ...services,
      method: "POST",
      pathname: "/agents/assistant/sessions",
      body: { providerId: "codex-app-server", title: "自定义 Chat" },
      launchAgentSession: async ({ agent, title }) => {
        assert.equal(title, "自定义 Chat");
        services.store.upsertSession({
          id: "assistant-session",
          title,
          agent: agent.name,
          agentId: agent.agentId,
          provider: "codex-app-server",
          status: "running",
          sessionKind: "assistantChat"
        });
        return services.store.getSession("assistant-session");
      }
    });
    assert.equal(assistant.statusCode, 201);
    assert.equal(assistant.body.session.sessionKind, "assistantChat");
    assert.equal(assistant.body.session.workItemId, null);
    assert.equal(assistant.body.session.agentId, "assistant");
    assert.equal(assistant.body.session.title, "自定义 Chat");
    assert.equal(Object.hasOwn(assistant.body.session, "avatarPath"), false);

    const rejectedWorkerAvatar = await callApi({
      ...services,
      method: "POST",
      pathname: "/sessions",
      body: {
        workItemId: workItem.body.id,
        agentId: contributor.body.agent.agentId,
        avatarPath: "/tmp/worker-avatar.png"
      },
      launchSession: async () => { throw new Error("must not launch"); }
    });
    assert.equal(rejectedWorkerAvatar.statusCode, 400);
    assert.equal(rejectedWorkerAvatar.body.code, "SESSION_AVATAR_UNSUPPORTED");

    const rejectedAssistantAvatar = await callApi({
      ...services,
      method: "POST",
      pathname: "/agents/assistant/sessions",
      body: { avatarPath: "/tmp/chat-avatar.png" },
      launchAgentSession: async () => { throw new Error("must not launch"); }
    });
    assert.equal(rejectedAssistantAvatar.statusCode, 400);
    assert.equal(rejectedAssistantAvatar.body.code, "SESSION_AVATAR_UNSUPPORTED");
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
    assert.equal(updated.body.agent.status, "available");

    // 不存在的 id → 404
    const missing = await callApi({ method: "PATCH", pathname: "/agents/nope", body: { name: "x" }, ...services });
    assert.equal(missing.statusCode, 404);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("GET /agents reports availability independently of Session Provider selection", async () => {
  const services = await createServices();
  try {
    const created = await callApi({
      method: "POST",
      pathname: "/agents",
      body: { name: "Provider-neutral Agent" },
      resolveAgentAvailability: () => ({ status: "available" }),
      ...services
    });
    assert.equal(created.body.agent.status, "available");
    assert.equal(created.body.agent.statusReason, null);
    assert.equal(services.store.getAgent(created.body.agent.agentId).status, "available");
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
