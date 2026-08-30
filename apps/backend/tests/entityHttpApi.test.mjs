import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { HubService } from "../src/application/hubService.mjs";
import { CollaborationRouter } from "../src/application/collaborationRouter.mjs";
import { MemoryExtractor } from "../src/application/memoryExtractor.mjs";
import { MemoryRecallService } from "../src/application/memoryRecallService.mjs";
import { AssistantService } from "../src/application/assistantService.mjs";
import { handleEntityHttpRequest } from "../src/application/entityHttpApi.mjs";
import { SkillRegistryService } from "../src/application/skillRegistryService.mjs";
import { WorkItemCompletionService } from "../src/application/workItemCompletionService.mjs";

const execFileAsync = promisify(execFile);

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

function mockRequest(method, pathname, search = "", body = {}, headers = {}) {
  return {
    method,
    headers,
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
  const workItemCompletionService = new WorkItemCompletionService({ store, onCompleted: (entity) => {
    onEntityChanged("WorkItemChanged", { action: "user-intent-completion", entity });
  } });
  const hubService = new HubService({ store });
  return {
    store,
    directory,
    entityEvents,
    onEntityChanged,
    objectiveService,
    workItemCompletionService,
    hubService,
    memoryRecallService: new MemoryRecallService({ store, hubService }),
    router: new CollaborationRouter({ store }),
    memoryExtractor: new MemoryExtractor({ store }),
    assistantService: new AssistantService({ store, objectiveService, onEntityChanged }),
    skillRegistryService: new SkillRegistryService({ store, skillsDirs: {}, cacheRoot: join(directory, "skill-cache") })
  };
}

async function callApi({ method, pathname, search = "", body, headers, ...services }) {
  const requestHeaders = { ...(headers ?? {}) };
  if (method === "POST" && pathname === "/agents"
    && !Object.hasOwn(requestHeaders, "idempotency-key")) {
    requestHeaders["idempotency-key"] = randomUUID();
  }
  const request = mockRequest(method, pathname, search, body, requestHeaders);
  const response = mockResponse();
  const url = new URL(request.url);
  const startWorkItemExecution = services.startWorkItemExecution ?? (services.launchSession
    ? async (input) => {
        const workItem = services.objectiveService.store.getWorkItem(input.workItemId);
        const agent = services.objectiveService.store.getAgent(input.agentId);
        const session = await services.launchSession({
          workItem,
          agent,
          providerId: input.providerId,
          title: input.title,
          observePerformance: () => {}
        });
        const bound = services.objectiveService.store.bindSessionToWorkItem(
          session.id, workItem.id, workItem.objective_id
        );
        services.objectiveService.store.updateWorkItem(workItem.id, {
          status: "in_progress", mainAgentId: agent.agentId, executionStatus: "running"
        });
        return {
          status: "ready", idempotentReplay: false, session: bound,
          receipt: { status: "ready", logicalSessionId: bound.logicalSessionId ?? bound.id }
        };
      }
    : undefined);
  const handled = handleEntityHttpRequest({
    request,
    response,
    url,
    objectiveService: services.objectiveService,
    hubService: services.hubService,
    router: services.router,
    memoryExtractor: services.memoryExtractor,
    memoryRecallService: services.memoryRecallService,
    assistantService: services.assistantService,
    skillRegistryService: services.skillRegistryService,
    backgroundAgentService: services.backgroundAgentService,
    createSession: services.createSession,
    launchSession: services.launchSession,
    startWorkItemExecution,
    beginWorkItemExecution: services.beginWorkItemExecution,
    getWorkItemStartup: services.getWorkItemStartup,
    getSessionStartupBinding: services.getSessionStartupBinding,
    cancelWorkItemStart: services.cancelWorkItemStart,
    launchAgentSession: services.launchAgentSession,
    launchObjectiveChatSession: services.launchObjectiveChatSession,
    inspectWorkItemWorktree: services.inspectWorkItemWorktree,
    reclaimWorkItemWorktree: services.reclaimWorkItemWorktree,
    inspectWorkItemDeletion: services.inspectWorkItemDeletion,
    deleteWorkItemSafely: services.deleteWorkItemSafely,
    restoreWorkItemExecution: services.restoreWorkItemExecution,
    workItemCompletionService: services.workItemCompletionService,
    resolveAgentAvailability: services.resolveAgentAvailability,
    suggestAgentSessionTitle: services.suggestAgentSessionTitle,
    observeWorkItemPerformance: services.observeWorkItemPerformance,
    observeFormAssistPerformance: services.observeFormAssistPerformance,
    registerGitRepository: services.registerGitRepository,
    auditLog: services.auditLog,
    onEntityChanged: services.onEntityChanged
  });
  const deadline = Date.now() + 2_000;
  while (!response.headersSent && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    handled,
    statusCode: response.statusCode,
    body: response.body ? JSON.parse(response.body) : null
  };
}

async function completeThroughMacOSIntent(services, workItem, suffix = randomUUID()) {
  const requestId = `completion-intent:${suffix}`;
  const intent = await callApi({
    method: "POST",
    pathname: `/work-items/${workItem.id}/completion-intents`,
    body: {
      requestId,
      interactionId: `interaction:${suffix}`,
      uiSurface: "work_item_completion_confirmation",
      displayedWorkItemId: workItem.id,
      displayedWorkItemTitle: workItem.title,
      displayedAcceptanceStatus: workItem.acceptanceAssessment?.status ?? "not_assessed"
    },
    ...services
  });
  assert.equal(intent.statusCode, 201);
  return callApi({
    method: "POST",
    pathname: `/work-items/${workItem.id}/confirm-completion`,
    body: {
      intentToken: intent.body.intentToken,
      requestId,
      idempotencyKey: `completion:${suffix}`
    },
    ...services
  });
}

test("WorkItem Worktree endpoints inspect and reclaim through the project service", async () => {
  const services = await createServices();
  const calls = [];
  try {
    const inspection = {
      status: "available",
      workItemId: "work-item:one",
      canReclaim: true,
      worktree: { worktreeId: "worktree:feature", branchName: "feature/one" }
    };
    const inspected = await callApi({
      method: "GET",
      pathname: "/work-items/work-item%3Aone/worktree",
      inspectWorkItemWorktree: async (workItemId) => {
        calls.push(["inspect", workItemId]);
        return inspection;
      },
      ...services
    });
    assert.equal(inspected.statusCode, 200);
    assert.deepEqual(inspected.body, inspection);

    const reclaimed = await callApi({
      method: "POST",
      pathname: "/work-items/work-item%3Aone/worktree/reclaim",
      reclaimWorkItemWorktree: async (workItemId) => {
        calls.push(["reclaim", workItemId]);
        return { ...inspection, status: "retired", canReclaim: false };
      },
      ...services
    });
    assert.equal(reclaimed.statusCode, 200);
    assert.equal(reclaimed.body.status, "retired");
    assert.deepEqual(calls, [
      ["inspect", "work-item:one"],
      ["reclaim", "work-item:one"]
    ]);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("WorkItem deletion endpoints expose preflight and execute only through the safe deletion service", async () => {
  const services = await createServices();
  const calls = [];
  const plan = {
    workItemId: "work-item:one",
    status: "risky",
    retryable: true,
    worktree: { worktreeId: "worktree:one", path: "/repo-one", branchName: "workitem/one" },
    risks: [{ code: "UNTRACKED_FILES", message: "untracked", files: ["draft.txt"] }],
    blockers: []
  };
  try {
    const inspected = await callApi({
      method: "GET",
      pathname: "/work-items/work-item%3Aone/deletion",
      inspectWorkItemDeletion: async (workItemId, actor) => {
        calls.push(["inspect", workItemId, actor]);
        return plan;
      },
      ...services
    });
    assert.equal(inspected.statusCode, 200);
    assert.deepEqual(inspected.body.risks, plan.risks);

    const deleted = await callApi({
      method: "POST",
      pathname: "/work-items/work-item%3Aone/actions/delete",
      body: { mode: "force", acknowledgeDataLoss: true, confirmedBranchName: "workitem/one" },
      deleteWorkItemSafely: async (workItemId, input, actor) => {
        calls.push(["delete", workItemId, input, actor]);
        return { ok: true, workItemId };
      },
      ...services
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.ok, true);
    assert.deepEqual(calls, [
      ["inspect", "work-item:one", { type: "user", id: "user:local-macos" }],
      ["delete", "work-item:one", { mode: "force", acknowledgeDataLoss: true, confirmedBranchName: "workitem/one" }, { type: "user", id: "user:local-macos" }]
    ]);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("WorkItem deletion HTTP errors preserve forbidden, missing, and association blocker details", async () => {
  const services = await createServices();
  try {
    const forbidden = await callApi({
      method: "POST",
      pathname: "/work-items/work-item%3Aforbidden/actions/delete",
      body: { mode: "safe" },
      deleteWorkItemSafely: async () => {
        throw Object.assign(new Error("You do not have permission to delete this WorkItem."), {
          code: "WORK_ITEM_DELETE_FORBIDDEN", statusCode: 403
        });
      },
      ...services
    });
    assert.deepEqual(forbidden.body, {
      error: "You do not have permission to delete this WorkItem.",
      code: "WORK_ITEM_DELETE_FORBIDDEN"
    });
    assert.equal(forbidden.statusCode, 403);

    const missing = await callApi({
      method: "GET",
      pathname: "/work-items/work-item%3Amissing/deletion",
      inspectWorkItemDeletion: async () => {
        throw Object.assign(new Error("WorkItem not found: work-item:missing"), {
          code: "WORK_ITEM_NOT_FOUND", statusCode: 404
        });
      },
      ...services
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.code, "WORK_ITEM_NOT_FOUND");

    const deletion = {
      workItemId: "work-item:blocked", status: "blocked", retryable: true,
      worktree: null, risks: [], blockers: [{
        code: "WORK_ITEM_HAS_BOUND_ARTIFACTS",
        message: "WorkItem remains bound to retained Artifact Required evidence."
      }]
    };
    const blocked = await callApi({
      method: "POST",
      pathname: "/work-items/work-item%3Ablocked/actions/delete",
      body: { mode: "safe" },
      deleteWorkItemSafely: async () => {
        throw Object.assign(new Error(deletion.blockers[0].message), {
          code: "WORK_ITEM_DELETE_BLOCKED", statusCode: 409, deletion
        });
      },
      ...services
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.body.code, "WORK_ITEM_DELETE_BLOCKED");
    assert.deepEqual(blocked.body.deletion, deletion);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("WorkItem restore endpoint delegates the atomic execution recovery flow", async () => {
  const services = await createServices();
  try {
    const workItem = services.objectiveService.createWorkItem({
      objectiveId: services.objectiveService.createObjective({
        name: "Recovery objective",
        idealState: "Recovered"
      }).id,
      title: "Recover me",
      status: "in_progress"
    });
    const restoreReceipt = services.workItemCompletionService.issueMacOSIntent(
      workItem.id,
      {
        requestId: "restore-setup-intent", interactionId: "restore-setup-click",
        uiSurface: "work_item_completion_confirmation", displayedWorkItemId: workItem.id,
        displayedWorkItemTitle: workItem.title, displayedAcceptanceStatus: "not_assessed"
      },
      { type: "user", id: "user:local-macos" }
    );
    services.workItemCompletionService.completeFromMacOS(workItem.id, {
      intentToken: restoreReceipt.intentToken,
      requestId: "restore-setup-intent",
      idempotencyKey: "restore-setup-completion"
    });
    const calls = [];
    const restored = await callApi({
      method: "POST",
      pathname: `/work-items/${encodeURIComponent(workItem.id)}/actions/restore`,
      restoreWorkItemExecution: async (workItemId) => {
        calls.push(workItemId);
        return {
          workItem: services.store.updateWorkItem(workItemId, {
            status: "in_progress",
            executionStatus: "idle"
          }),
          session: { id: "session:one" },
          workspace: { worktreeId: "worktree:one", reused: true },
          transition: null
        };
      },
      ...services
    });

    assert.equal(restored.statusCode, 200);
    assert.equal(restored.body.workItem.status, "in_progress");
    assert.equal(restored.body.workspace.reused, true);
    assert.deepEqual(calls, [workItem.id]);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("WorkItem restore endpoint preserves an actionable Worktree rebuild failure", async () => {
  const services = await createServices();
  try {
    const failed = await callApi({
      method: "POST",
      pathname: "/work-items/work_item%3Aone/actions/restore",
      restoreWorkItemExecution: async () => {
        throw Object.assign(
          new Error("无法基于 WorkItem work_item:one 的任务分支重建 Worktree：外置磁盘未挂载。"),
          { code: "WORKTREE_REBUILD_FAILED", statusCode: 409 }
        );
      },
      ...services
    });

    assert.equal(failed.statusCode, 409);
    assert.equal(failed.body.code, "WORKTREE_REBUILD_FAILED");
    assert.match(failed.body.error, /外置磁盘未挂载/);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("GET /skills/runtime-events exposes filterable persisted stage diagnostics", async () => {
  const services = await createServices();
  try {
    const calls = [];
    const result = await callApi({
      method: "GET",
      pathname: "/skills/runtime-events",
      search: "?agentId=agent%3Ainvestor&sessionId=session%3A1&stage=session-recovery&limit=25",
      ...services,
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
      }
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
    const performanceMeasurements = [];
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
            performance: {
              phases: { agentContextMs: 2.5, providerInvokeMs: 7.5 },
              totalMs: 10
            },
            text: JSON.stringify({
              title: "统一帮我写",
              description: "一次生成并回填全部字段。",
              acceptanceCriteria: "- 所有字段可编辑\n- 不自动创建实体",
              priority: "high"
            })
          };
        }
      },
      observeFormAssistPerformance: (measurement) => performanceMeasurements.push(measurement),
      ...services
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.formType, "workItem");
    assert.equal(result.body.fields.title, "统一帮我写");
    assert.equal(result.body.providerId, "fake-provider");
    assert.equal(calls[0].purpose, "assist-form-draft");
    assert.equal(calls[0].permissionProfile, "read-only");
    assert.equal(calls[0].preferredReasoning, "low");
    assert.equal(services.store.listWorkItems().length, 0);
    assert.equal(performanceMeasurements.length, 1);
    assert.equal(performanceMeasurements[0].operation, "assist.form-draft");
    assert.equal(performanceMeasurements[0].formType, "workItem");
    assert.equal(performanceMeasurements[0].outcome, "succeeded");
    assert.equal(performanceMeasurements[0].phases.agentContextMs, 2.5);
    assert.equal(performanceMeasurements[0].phases.providerInvokeMs, 7.5);
    assert.ok(performanceMeasurements[0].phases.responseParseMs >= 0);
    assert.ok(performanceMeasurements[0].totalMs >= 0);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /assist/form-draft shares one structured contract across Agent and Objective forms without targetDate", async () => {
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
            idealState: "创建体验持续保持一致，生成内容始终可检查、可编辑。",
            priority: "high",
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
          idealState: "",
          priority: "",
          tags: ""
        }
      },
      backgroundAgentService,
      ...services
    });

    assert.equal(agentResult.statusCode, 200);
    assert.equal(agentResult.body.fields.role, "independentContributor");
    assert.equal(objectiveResult.statusCode, 200);
    assert.equal(Object.hasOwn(objectiveResult.body.fields, "targetDate"), false);
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

test("POST /repositories/detect preserves existing repositories and initializes only after confirmation", async () => {
  const services = await createServices();
  try {
    const existing = join(services.directory, "existing-repository");
    const plain = join(services.directory, "plain-folder");
    await Promise.all([mkdir(existing), mkdir(plain)]);
    await execFileAsync("git", ["-C", existing, "init"]);

    const existingResult = await callApi({
      method: "POST",
      pathname: "/repositories/detect",
      body: { dirPath: existing, initializeIfNeeded: false },
      ...services
    });
    assert.equal(existingResult.statusCode, 201);

    const detectionResult = await callApi({
      method: "POST",
      pathname: "/repositories/detect",
      body: { dirPath: plain, initializeIfNeeded: false },
      ...services
    });
    assert.equal(detectionResult.statusCode, 400);
    assert.equal(detectionResult.body.code, "NOT_A_GIT_REPOSITORY");
    await assert.rejects(stat(join(plain, ".git")), { code: "ENOENT" });

    const initializedResult = await callApi({
      method: "POST",
      pathname: "/repositories/detect",
      body: { dirPath: plain, initializeIfNeeded: true },
      ...services
    });
    assert.equal(initializedResult.statusCode, 201);
    assert.equal((await stat(join(plain, ".git"))).isDirectory(), true);
    assert.equal(services.store.listGitRepositories().length, 2);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /repositories/detect reports Git initialization failure without adding a Workspace", async () => {
  const services = await createServices();
  try {
    const failure = new Error("Git initialization was denied by the filesystem.");
    failure.code = "GIT_INITIALIZATION_FAILED";
    failure.statusCode = 500;
    const result = await callApi({
      method: "POST",
      pathname: "/repositories/detect",
      body: { dirPath: services.directory, initializeIfNeeded: true },
      registerGitRepository: async () => { throw failure; },
      ...services
    });
    assert.equal(result.statusCode, 500);
    assert.equal(result.body.code, "GIT_INITIALIZATION_FAILED");
    assert.match(result.body.error, /denied/);
    assert.equal(services.store.listGitRepositories().length, 0);
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

test("POST 创建接口按客户端 ID 幂等，冲突重放返回 409 而非数据库异常", async () => {
  const services = await createServices();
  try {
    const objectiveBody = { id: "objective:http-idempotent", name: "幂等目标" };
    const firstObjective = await callApi({ method: "POST", pathname: "/objectives", body: objectiveBody, ...services });
    const retriedObjective = await callApi({ method: "POST", pathname: "/objectives", body: objectiveBody, ...services });
    assert.equal(firstObjective.statusCode, 201);
    assert.equal(retriedObjective.statusCode, 201);
    assert.equal(services.store.listObjectives().length, 1);

    const conflict = await callApi({
      method: "POST",
      pathname: "/objectives",
      body: { ...objectiveBody, name: "冲突目标" },
      ...services
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.code, "ENTITY_CREATION_CONFLICT");
    assert.doesNotMatch(conflict.body.error, /SQLite|constraint/i);

    const workItemBody = {
      id: "work_item:http-idempotent",
      objectiveId: objectiveBody.id,
      title: "幂等工作项"
    };
    const firstWorkItem = await callApi({ method: "POST", pathname: "/work-items", body: workItemBody, ...services });
    const retriedWorkItem = await callApi({ method: "POST", pathname: "/work-items", body: workItemBody, ...services });
    assert.equal(firstWorkItem.statusCode, 201);
    assert.equal(retriedWorkItem.statusCode, 201);
    assert.equal(services.store.listWorkItems().length, 1);
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
      body: { name: "Invalid", idealState: { invalid: true } },
      ...services
    });
    assert.equal(wrongType.statusCode, 400);
    assert.equal(wrongType.body.code, "INVALID_FIELD_TYPE");
    assert.equal(wrongType.body.field, "idealState");
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
    const unknownStatus = await callApi({
      method: "PATCH",
      pathname: `/work-items/${workItem.body.id}`,
      body: { status: "reviewing_unknown" },
      ...services
    });
    assert.equal(unknownStatus.statusCode, 400);
    assert.equal(unknownStatus.body.code, "INVALID_STATUS");
    const bypassCancellation = await callApi({
      method: "PATCH",
      pathname: `/work-items/${workItem.body.id}`,
      body: { status: "canceled" },
      ...services
    });
    assert.equal(bypassCancellation.statusCode, 403);
    assert.equal(bypassCancellation.body.code, "WORK_ITEM_CANCELLATION_WORKFLOW_REQUIRED");
    assert.equal(services.store.getWorkItem(workItem.body.id).status, "todo");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /objectives/:id/sessions creates at most one Objective Chat and rejects invalid configurations", async () => {
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
    const created = await callApi({
      method: "POST",
      pathname: `/objectives/${objective.id}/sessions`,
      body: { agentId: planner.agentId, providerId: "codex-app-server", title: "Planning" },
      launchObjectiveChatSession,
      ...services
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.session.sessionKind, "objectiveChat");
    assert.equal(created.body.session.objectiveId, objective.id);
    assert.equal(created.body.session.workItemId, null);

    services.store.upsertSession(created.body.session);
    services.store.bindSessionToObjective(created.body.session.id, objective.id);
    const reused = await callApi({
      method: "POST",
      pathname: `/objectives/${objective.id}/sessions`,
      body: { agentId: builder.agentId, providerId: "codex-app-server", title: "Duplicate" },
      launchObjectiveChatSession,
      ...services
    });
    assert.equal(reused.statusCode, 200);
    assert.equal(reused.body.session.id, created.body.session.id);
    assert.equal(reused.body.created, false);
    assert.deepEqual(calls.map((call) => call.agent.agentId), [planner.agentId]);
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
    assert.equal(calls.length, 1);

    const invalidProvider = await callApi({
      method: "POST",
      pathname: `/objectives/${objective.id}/sessions`,
      body: { agentId: planner.agentId },
      launchObjectiveChatSession,
      ...services
    });
    assert.equal(invalidProvider.statusCode, 400);
    assert.equal(invalidProvider.body.code, "INVALID_INPUT");
    assert.equal(services.store.listSessionsByObjective(objective.id).filter(
      (session) => session.sessionKind === "objectiveChat"
    ).length, 1);
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

test("Skill deletion impact, confirmation permission, cascade response, and refresh events are explicit", async () => {
  const services = await createServices();
  try {
    const skill = services.store.createRegistrySkill({
      name: "Shared",
      sourceType: "local",
      source: services.directory
    });
    const first = services.store.createAgent({ name: "First" });
    const second = services.store.createAgent({ name: "Second" });
    services.store.setAgentRegistrySkills(first.agentId, [skill.skillId]);
    services.store.setAgentRegistrySkills(second.agentId, [skill.skillId]);

    const impact = await callApi({
      method: "GET",
      pathname: `/skills/${encodeURIComponent(skill.skillId)}/deletion-impact`,
      ...services
    });
    assert.equal(impact.statusCode, 200);
    assert.equal(impact.body.impact.affectedAgentCount, 2);
    assert.equal(impact.body.impact.canDelete, true);

    const unconfirmed = await callApi({
      method: "DELETE",
      pathname: `/skills/${encodeURIComponent(skill.skillId)}`,
      ...services
    });
    assert.equal(unconfirmed.statusCode, 403);
    assert.equal(unconfirmed.body.code, "SKILL_DELETE_CONFIRMATION_REQUIRED");
    assert.ok(services.store.getRegistrySkill(skill.skillId));

    const removed = await callApi({
      method: "DELETE",
      pathname: `/skills/${encodeURIComponent(skill.skillId)}`,
      headers: { "x-corptie-confirm-destructive-action": "delete-skill" },
      ...services
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.body.ok, true);
    assert.equal(removed.body.operation.status, "completed");
    assert.deepEqual(services.store.listRegistrySkillIdsForAgent(first.agentId), []);
    assert.deepEqual(services.store.listRegistrySkillIdsForAgent(second.agentId), []);
    assert.deepEqual(
      services.entityEvents.slice(-3).map((event) => event.type),
      ["SkillChanged", "AgentChanged", "AgentChanged"]
    );
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("Skill deletion HTTP failure returns audit operation and never reports success", async () => {
  const services = await createServices();
  try {
    const operation = {
      operationId: "skill-deletion:test",
      skillId: "skill:test",
      skillName: "Test",
      status: "cleanup_failed",
      cleanup: [{ kind: "runtime", path: "/runtime/skill:test", status: "failed" }]
    };
    const error = new Error("simulated cleanup failure");
    error.code = "SKILL_CLEANUP_FAILED";
    error.operation = operation;
    const failed = await callApi({
      method: "DELETE",
      pathname: "/skills/skill%3Atest",
      headers: { "x-corptie-confirm-destructive-action": "delete-skill" },
      ...services,
      skillRegistryService: {
        remove: async () => { throw error; }
      }
    });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.body.code, "SKILL_CLEANUP_FAILED");
    assert.equal(failed.body.operation.status, "cleanup_failed");
    assert.notEqual(failed.body.ok, true);
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

test("binding a valid Workspace is persisted and immediately visible to WorkItem start validation", async () => {
  const services = await createServices();
  try {
    const repositoryId = registerRepository(services.store, "repository:immediate", "worktree:immediate-main");
    const agent = services.store.createAgent({
      name: "Immediate starter", role: "independentContributor", status: "available"
    });
    const objective = services.objectiveService.createObjective({
      name: "Immediate binding",
      idealState: "Starts without rebinding",
      workspaceIds: [repositoryId],
      contributorAgentIds: [agent.agentId]
    });
    const item = services.objectiveService.createWorkItem({
      objectiveId: objective.id,
      title: "Bind then start",
      mainAgentId: agent.agentId
    });

    const bound = await callApi({
      method: "PATCH",
      pathname: `/work-items/${encodeURIComponent(item.id)}`,
      body: { mainWorkspaceId: repositoryId },
      ...services
    });
    assert.equal(bound.statusCode, 200);
    assert.equal(bound.body.main_workspace_id, repositoryId);

    let observedRepositoryId = null;
    const started = await callApi({
      method: "POST",
      pathname: "/sessions",
      body: { workItemId: item.id, agentId: agent.agentId, providerId: "codex-app-server" },
      startWorkItemExecution: async (input) => {
        observedRepositoryId = services.store.getWorkItem(input.workItemId).main_workspace_id;
        return {
          status: "ready", idempotentReplay: false,
          session: { id: "session:immediate" },
          receipt: { status: "ready", repositoryId: observedRepositoryId }
        };
      },
      ...services
    });
    assert.equal(started.statusCode, 201);
    assert.equal(observedRepositoryId, repositoryId);
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
    assert.equal(rejectedCompletion.statusCode, 403);
    assert.equal(rejectedCompletion.body.code, "WORK_ITEM_COMPLETION_INTENT_REQUIRED");
    assert.equal(
      services.store.listWorkItemCompletionOperations(created.body.id)[0].callSurface,
      "macos_work_item_patch"
    );

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

    const rejectedByUser = await callApi({
      method: "POST",
      pathname: `/work-items/${created.body.id}/reject-acceptance`,
      body: { rejected: true },
      ...services
    });
    assert.equal(rejectedByUser.statusCode, 200);
    assert.equal(rejectedByUser.body.status, "in_progress");
    assert.equal(rejectedByUser.body.acceptanceAssessment.status, "rejected");
    assert.equal(rejectedByUser.body.completionSuggestion, null);

    const repeatedRejection = await callApi({
      method: "POST",
      pathname: `/work-items/${created.body.id}/reject-acceptance`,
      body: { rejected: true },
      ...services
    });
    assert.equal(repeatedRejection.statusCode, 200);
    assert.equal(repeatedRejection.body.acceptanceAssessment.status, "rejected");
    assert.equal(
      repeatedRejection.body.acceptanceAssessment.rejectedAt,
      rejectedByUser.body.acceptanceAssessment.rejectedAt
    );
    assert.equal(repeatedRejection.body.completionSuggestion, null);

    const rejectedUnknownField = await callApi({
      method: "POST",
      pathname: `/work-items/${created.body.id}/reject-acceptance`,
      body: { rejected: true, unexpected: true },
      ...services
    });
    assert.equal(rejectedUnknownField.statusCode, 400);
    assert.equal(rejectedUnknownField.body.code, "INVALID_INPUT");

    const reassessed = await callApi({
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
    assert.equal(reassessed.statusCode, 200);
    assert.equal(reassessed.body.completionSuggestion.recommended, true);

    const completed = await completeThroughMacOSIntent(
      services, services.objectiveService.getWorkItem(created.body.id), "passing-assessment"
    );
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.body.workItem.status, "done");
    assert.equal(completed.body.operation.sourceType, "direct_macos_ui_action");
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
    assert.equal(missingConfirmation.statusCode, 403);
    assert.equal(missingConfirmation.body.code, "WORK_ITEM_COMPLETION_INTENT_REQUIRED");
    assert.equal(
      services.store.listWorkItemCompletionOperations(created.body.id)[0].callSurface,
      "legacy_confirmed_true_http"
    );

    const completed = await completeThroughMacOSIntent(
      services, services.objectiveService.getWorkItem(created.body.id), "without-assessment"
    );
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.body.workItem.status, "done");
    assert.equal(completed.body.workItem.completionSuggestion, null);
    assert.equal(completed.body.workItem.completionSource.sourceType, "direct_macos_ui_action");
    const auditByWorkItem = await callApi({
      method: "GET", pathname: `/work-items/${created.body.id}/completion-audit`, ...services
    });
    assert.equal(auditByWorkItem.statusCode, 200);
    assert.equal(auditByWorkItem.body.operations[0].operationId, completed.body.operation.operationId);
    const auditByOperation = await callApi({
      method: "GET",
      pathname: `/work-item-completion-operations/${encodeURIComponent(completed.body.operation.operationId)}`,
      ...services
    });
    assert.equal(auditByOperation.statusCode, 200);
    assert.equal(auditByOperation.body.operation.workItemId, created.body.id);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("explicit user confirmation completes an in-progress WorkItem after automated acceptance fails", async () => {
  const services = await createServices();
  try {
    const objective = await callApi({
      method: "POST", pathname: "/objectives", body: { name: "未通过后人工裁决目标" }, ...services
    });
    const created = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: {
        objectiveId: objective.body.id,
        title: "未通过后人工确认任务",
        acceptanceCriteria: "Tests pass"
      },
      ...services
    });
    services.store.upsertSession({
      id: "failed-acceptance-session",
      title: "未通过验收会话",
      agent: "worker",
      provider: "codex-app-server",
      status: "complete"
    });
    services.objectiveService.bindSession("failed-acceptance-session", created.body.id);
    await callApi({
      method: "PATCH",
      pathname: `/work-items/${created.body.id}`,
      body: { status: "in_progress" },
      ...services
    });

    const assessed = await callApi({
      method: "PUT",
      pathname: `/work-items/${created.body.id}/acceptance-assessment`,
      body: {
        sourceSessionId: "failed-acceptance-session",
        results: [{
          criterion: "Tests pass",
          verdict: "failed",
          evidence: [{ summary: "A test failed", reference: "npm test" }]
        }]
      },
      ...services
    });
    assert.equal(assessed.statusCode, 200);
    assert.equal(assessed.body.acceptanceAssessment.status, "not_proven");
    assert.equal(assessed.body.completionSuggestion, null);

    const completed = await completeThroughMacOSIntent(
      services, services.objectiveService.getWorkItem(created.body.id), "failed-assessment"
    );
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.body.workItem.status, "done");
    assert.equal(completed.body.workItem.acceptanceAssessment.status, "not_proven");
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
    services.store.createAgent({ id: "a1", name: "Memory Agent" });
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
    services.store.createAgent({ id: "a1", name: "Memory Agent" });
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
    services.store.createObjective({ id: "o1", name: "Objective" });
    services.store.createWorkItem({ id: "wi1", objectiveId: "o1", title: "WorkItem" });
    services.store.createSession({
      id: "s1", title: "t", provider: "codex-app-server", status: "complete",
      objectiveId: "o1", workItemId: "wi1", agentId: "a1"
    });
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

test("WorkItem memory HTTP lifecycle validates start, source binding, unknown fields, and isolation", async () => {
  const services = await createServices();
  try {
    services.store.createObjective({ id: "objective:memory-http", name: "Memory HTTP" });
    for (const id of ["work_item:http-one", "work_item:http-two"]) {
      services.store.createWorkItem({ id, objectiveId: "objective:memory-http", title: id });
    }

    const unscoped = await callApi({ method: "GET", pathname: "/memories", ...services });
    assert.equal(unscoped.statusCode, 400);
    assert.equal(unscoped.body.code, "INVALID_INPUT");
    const beforeStart = await callApi({
      method: "GET",
      pathname: "/memories",
      search: "?ownerType=work_item&ownerId=work_item%3Ahttp-one",
      ...services
    });
    assert.equal(beforeStart.statusCode, 200);
    assert.deepEqual(beforeStart.body.memories, []);

    services.store.createSession({
      id: "session:http-one", title: "one", provider: "codex-app-server", status: "running",
      objectiveId: "objective:memory-http", workItemId: "work_item:http-one", agentId: "agent:http"
    });
    services.store.createSession({
      id: "session:http-two", title: "two", provider: "codex-app-server", status: "running",
      objectiveId: "objective:memory-http", workItemId: "work_item:http-two", agentId: "agent:http"
    });

    const created = await callApi({
      method: "POST",
      pathname: "/memories",
      body: {
        ownerType: "work_item",
        ownerId: "work_item:http-one",
        kind: "fact",
        content: "Actual progress context",
        sourceSessionId: "session:http-one"
      },
      ...services
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.work_item_id, "work_item:http-one");

    const crossBound = await callApi({
      method: "POST",
      pathname: "/memories",
      body: {
        ownerType: "work_item",
        ownerId: "work_item:http-two",
        kind: "fact",
        content: "must fail",
        sourceSessionId: "session:http-one"
      },
      ...services
    });
    assert.equal(crossBound.statusCode, 400);
    assert.equal(crossBound.body.code, "INVALID_MEMORY_SOURCE_SESSION");

    const unknown = await callApi({
      method: "POST",
      pathname: "/memories",
      body: {
        ownerType: "work_item",
        ownerId: "work_item:http-one",
        kind: "fact",
        content: "must fail",
        sourceSessionId: "session:http-one",
        templateMemory: true
      },
      ...services
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.body.code, "INVALID_INPUT");

    const one = await callApi({
      method: "GET", pathname: "/memories",
      search: "?ownerType=work_item&ownerId=work_item%3Ahttp-one", ...services
    });
    const two = await callApi({
      method: "GET", pathname: "/memories",
      search: "?ownerType=work_item&ownerId=work_item%3Ahttp-two", ...services
    });
    assert.equal(one.body.memories.length, 1);
    assert.deepEqual(two.body.memories, []);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("Memory Inspector HTTP supports global audit, tag update, revoke, and rollback without physical delete", async () => {
  const services = await createServices();
  try {
    const created = await callApi({
      method: "POST", pathname: "/memories",
      body: { ownerType: "agent", ownerId: "assistant", kind: "preference", content: "Keep this auditable", tags: ["initial"] },
      ...services
    });
    assert.equal(created.statusCode, 201);
    const memoryId = created.body.id;
    const encoded = encodeURIComponent(memoryId);
    const global = await callApi({
      method: "GET", pathname: "/memories", search: "?global=true&includeRevoked=true", ...services
    });
    assert.equal(global.statusCode, 200);
    assert.ok(global.body.memories.some((memory) => memory.id === memoryId && memory.trustLevel === "trusted"));

    const updated = await callApi({
      method: "PATCH", pathname: `/memories/${encoded}`, body: { tags: ["edited", "audit"] }, ...services
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.body.memory.tags, ["edited", "audit"]);
    const audit = await callApi({
      method: "GET", pathname: "/memory-audit", search: `?memoryId=${encoded}`, ...services
    });
    const updateAudit = audit.body.audit.find((entry) => entry.action === "update");
    assert.ok(updateAudit);

    const recalled = await callApi({
      method: "GET", pathname: "/memory-recall",
      search: "?agentId=assistant&intent=auditable", ...services
    });
    assert.equal(recalled.statusCode, 200);
    assert.deepEqual(recalled.body.memories.map((memory) => memory.id), [memoryId]);

    const revoked = await callApi({
      method: "POST", pathname: `/memories/${encoded}/revoke`, body: { reason: "test revoke" }, ...services
    });
    assert.equal(revoked.statusCode, 200);
    assert.ok(revoked.body.memory.revokedAt);
    assert.ok(services.store.getMemory(memoryId), "revoke must preserve the physical record");
    const afterRevokeRecall = await callApi({
      method: "GET", pathname: "/memory-recall",
      search: "?agentId=assistant&intent=auditable", ...services
    });
    assert.deepEqual(afterRevokeRecall.body.memories, []);

    const restored = await callApi({
      method: "POST", pathname: `/memories/${encoded}/restore`, body: { reason: "test enable" }, ...services
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.body.memory.revokedAt, null);
    const afterRestoreRecall = await callApi({
      method: "GET", pathname: "/memory-recall",
      search: "?agentId=assistant&intent=auditable", ...services
    });
    assert.deepEqual(afterRestoreRecall.body.memories.map((memory) => memory.id), [memoryId]);
    assert.ok(services.store.listMemoryAudit({ memoryId }).some((entry) => entry.action === "restore"));

    const rollback = await callApi({
      method: "POST", pathname: `/memory-audit/${encodeURIComponent(updateAudit.id)}/rollback`, body: {}, ...services
    });
    assert.equal(rollback.statusCode, 200);
    assert.deepEqual(rollback.body.memory.tags, ["initial"]);
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

    const missingIdempotencyKey = await callApi({
      method: "POST",
      pathname: "/agents",
      body: { name: "无业务请求标识" },
      headers: { "idempotency-key": "" },
      ...services
    });
    assert.equal(missingIdempotencyKey.statusCode, 400);
    assert.equal(missingIdempotencyKey.body.code, "IDEMPOTENCY_KEY_REQUIRED");
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /agents deduplicates a repeated or concurrent business request", async () => {
  const services = await createServices();
  const auditEntries = [];
  try {
    const request = {
      method: "POST",
      pathname: "/agents",
      body: {
        name: "影音资源寻找专家",
        role: "assistant",
        description: "查找合法资源",
        capabilities: ["资源检索"]
      },
      headers: {
        "idempotency-key": "agent-form-42",
        "x-request-id": "request-42",
        "x-corptie-device-id": "device-local-1"
      },
      auditLog: (entry) => auditEntries.push(entry),
      ...services
    };

    const [first, concurrentReplay] = await Promise.all([
      callApi(request),
      callApi({
        ...request,
        headers: { ...request.headers, "x-request-id": "request-43" }
      })
    ]);
    const networkRetry = await callApi({
      ...request,
      headers: { ...request.headers, "x-request-id": "request-44" }
    });

    assert.deepEqual([first.statusCode, concurrentReplay.statusCode].sort(), [200, 201]);
    assert.equal(networkRetry.statusCode, 200);
    assert.equal(first.body.agent.agentId, concurrentReplay.body.agent.agentId);
    assert.equal(networkRetry.body.agent.agentId, first.body.agent.agentId);
    assert.equal(services.store.listAgents().filter((agent) => agent.name === "影音资源寻找专家").length, 1);
    assert.equal(auditEntries.filter((entry) => entry.outcome === "created").length, 1);
    assert.equal(auditEntries.filter((entry) => entry.outcome === "replayed").length, 2);
    assert.ok(auditEntries.every((entry) => entry.deviceId === "device-local-1"));
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("POST /agents rejects reuse of an idempotency key with different parameters", async () => {
  const services = await createServices();
  try {
    const headers = { "idempotency-key": "agent-form-conflict", "x-request-id": "request-a" };
    const first = await callApi({
      method: "POST", pathname: "/agents", body: { name: "First" }, headers, ...services
    });
    const conflict = await callApi({
      method: "POST",
      pathname: "/agents",
      body: { name: "Second" },
      headers: { ...headers, "x-request-id": "request-b" },
      ...services
    });

    assert.equal(first.statusCode, 201);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(services.store.listAgents().filter((agent) => ["First", "Second"].includes(agent.name)).length, 1);
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

test("WorkItem creation persists the selected Agent and only the explicit run action launches it", async () => {
  const services = await createServices();
  try {
    const performance = [];
    const agent = services.store.createAgent({
      name: "Selected contributor",
      role: "independentContributor",
      status: "available"
    });
    const objective = services.objectiveService.createObjective({
      name: "Explicit execution mode",
      contributorAgentIds: [agent.agentId]
    });
    let launchCount = 0;
    const launchSession = async ({ agent: launchedAgent, workItem, observePerformance }) => {
      launchCount += 1;
      assert.equal(launchedAgent.agentId, agent.agentId);
      assert.equal(workItem.main_agent_id, agent.agentId);
      observePerformance("workspacePrepareMs", 12.34);
      observePerformance("providerSessionCreateMs", 56.78);
      services.store.upsertSession({
        id: `session:explicit:${launchCount}`,
        title: workItem.title,
        agent: launchedAgent.name,
        agentId: launchedAgent.agentId,
        provider: "test-provider",
        status: "running",
        sessionKind: "worker",
        objectiveId: workItem.objective_id,
        workItemId: workItem.id
      });
      return services.store.getSession(`session:explicit:${launchCount}`);
    };

    const created = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: {
        objectiveId: objective.id,
        title: "Create once",
        mainAgentId: agent.agentId
      },
      launchSession,
      observeWorkItemPerformance: (measurement) => performance.push(measurement),
      ...services
    });

    assert.equal(created.statusCode, 201);
    assert.equal(created.body.main_agent_id, agent.agentId);
    assert.equal(created.body.execution_status, "idle");
    assert.equal(created.body.current_session_id, null);
    assert.equal(launchCount, 0, "create-only must not launch a Session");

    const started = await callApi({
      method: "POST",
      pathname: "/sessions",
      body: {
        workItemId: created.body.id,
        agentId: agent.agentId,
        providerId: "test-provider"
      },
      launchSession,
      observeWorkItemPerformance: (measurement) => performance.push(measurement),
      ...services
    });

    assert.equal(started.statusCode, 201);
    assert.equal(launchCount, 1);
    const running = services.store.getWorkItem(created.body.id);
    assert.equal(running.main_agent_id, agent.agentId);
    assert.equal(running.execution_status, "running");
    assert.equal(running.current_session_id, started.body.session.id);
    assert.equal(services.store.listWorkItemsByObjective(objective.id).length, 1);
    assert.deepEqual(performance.map((measurement) => measurement.operation), [
      "work-item.create",
      "work-item.execute"
    ]);
    assert.equal(performance[0].outcome, "succeeded");
    assert.equal(performance[0].workItemId, created.body.id);
    assert.equal(performance[1].phases.orchestrationMs >= 0, true);
    assert.equal(performance[1].totalMs >= 0, true);
  } finally {
    await services.store.close();
    await rm(services.directory, { recursive: true, force: true });
  }
});

test("execution failure is explicit and retrying the existing WorkItem does not create another item", async () => {
  const services = await createServices();
  try {
    const performance = [];
    const agent = services.store.createAgent({ name: "Retry contributor" });
    const objective = services.objectiveService.createObjective({
      name: "Retry without duplicate",
      contributorAgentIds: [agent.agentId]
    });
    const created = await callApi({
      method: "POST",
      pathname: "/work-items",
      body: { objectiveId: objective.id, title: "Stable identity", mainAgentId: agent.agentId },
      ...services
    });

    const failed = await callApi({
      method: "POST",
      pathname: "/sessions",
      body: { workItemId: created.body.id, agentId: agent.agentId, providerId: "test-provider" },
      launchSession: async () => {
        const error = new Error("Provider launch failed clearly");
        error.code = "PROVIDER_LAUNCH_FAILED";
        error.statusCode = 502;
        throw error;
      },
      observeWorkItemPerformance: (measurement) => performance.push(measurement),
      ...services
    });

    assert.equal(failed.statusCode, 502);
    assert.equal(failed.body.code, "PROVIDER_LAUNCH_FAILED");
    assert.match(failed.body.error, /Provider launch failed clearly/);
    assert.equal(services.store.listWorkItemsByObjective(objective.id).length, 1);
    assert.equal(services.store.getWorkItem(created.body.id).execution_status, "idle");
    assert.equal(performance.length, 1);
    assert.equal(performance[0].operation, "work-item.execute");
    assert.equal(performance[0].outcome, "failed");
    assert.equal(performance[0].errorCode, "PROVIDER_LAUNCH_FAILED");
    assert.equal(performance[0].workItemId, created.body.id);

    const retried = await callApi({
      method: "POST",
      pathname: "/sessions",
      body: { workItemId: created.body.id, agentId: agent.agentId, providerId: "test-provider" },
      launchSession: async ({ workItem }) => {
        services.store.upsertSession({
          id: "session:retry",
          title: workItem.title,
          agent: agent.name,
          agentId: agent.agentId,
          provider: "test-provider",
          status: "running",
          sessionKind: "worker",
          objectiveId: workItem.objective_id,
          workItemId: workItem.id
        });
        return services.store.getSession("session:retry");
      },
      ...services
    });

    assert.equal(retried.statusCode, 201);
    assert.equal(services.store.listWorkItemsByObjective(objective.id).length, 1);
    assert.equal(services.store.getWorkItem(created.body.id).current_session_id, "session:retry");
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
      launchSession: async ({ agent, workItem: launchedWorkItem, title }) => {
        assert.equal(title, "自定义 Worker");
        services.store.upsertSession({
          id: "worker-session",
          title,
          agent: agent.name,
          agentId: agent.agentId,
          provider: "codex-app-server",
          status: "running",
          sessionKind: "worker",
          objectiveId: launchedWorkItem.objective_id,
          workItemId: launchedWorkItem.id
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
