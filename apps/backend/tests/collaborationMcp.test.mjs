import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { handleCollaborationHttpRequest } from "../src/collaboration/collaborationHttpApi.mjs";
import { CollaborationHttpClient } from "../src/mcp/collaborationHttpClient.mjs";
import { createCollaborationMcpServer } from "../src/mcp/collaborationMcpServer.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const expectedTools = [
  "corptie.agents.discover",
  "corptie.agents.get",
  "corptie.services.list",
  "corptie.services.describe",
  "corptie.collaboration.capabilities",
  "corptie.sessions.discover",
  "corptie.sessions.get",
  "corptie.collaboration.work_items.list",
  "corptie.collaboration.work_items.get",
  "corptie.collaboration.work_items.create",
  "corptie.collaboration.work_items.relate",
  "corptie.collaboration.work_items.start",
  "corptie.collaboration.work_items.cancel",
  "corptie_list_workspaces",
  "corptie_create_worktree",
  "corptie_switch_workspace",
  "corptie.collaboration.request",
  "corptie.memory.search",
  "corptie_memory_search",
  "corptie_memory_list",
  "corptie_memory_remember",
  "corptie_memory_update",
  "corptie_memory_revoke",
  "corptie_skill_search",
  "corptie_skill_load",
  "corptie_work_item_report_acceptance",
  "corptie.collaboration.accept",
  "corptie.collaboration.reject",
  "corptie.collaboration.ask",
  "corptie.collaboration.reply",
  "corptie.collaboration.submit_result",
  "corptie.collaboration.request_revision",
  "corptie.collaboration.complete",
  "corptie.collaboration.cancel",
  "corptie.collaboration.get_task",
  "corptie.collaboration.list_inbox"
];

async function connectMcp(backendClient, options = {}) {
  const server = createCollaborationMcpServer({
    agentId: "research-agent", client: backendClient,
    sessionId: "session:research", sessionKind: "worker", sessionObjectiveId: "objective:research",
    ...options
  });
  const client = new Client({ name: "corptie-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("Objective Chat MCP exposes context plus Session-scoped strict collaboration tools", async () => {
  const calls = [];
  const { client } = await connectMcp({
    get: async () => ({}),
    post: async (path, body) => { calls.push({ path, body }); return { ok: true }; }
  }, { objectiveId: "objective:1", objectiveSessionId: "session:1" });
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("corptie_objective_context"));
    assert.equal(names.includes("corptie_objective_work_item_start"), false);
    assert.equal(names.includes("corptie_objective_work_items_manage"), false);
    assert.ok(names.includes("corptie.collaboration.work_items.create"));
    await client.callTool({
      name: "corptie.collaboration.work_items.create",
      arguments: { title: "Scoped item", idempotency_key: "create:scoped" }
    });
    assert.deepEqual(calls[0], {
      path: "/internal/collaboration/work-items",
      body: {
        title: "Scoped item",
        description: undefined,
        acceptanceCriteria: undefined,
        priority: undefined,
        agentId: undefined,
        mainWorkspaceId: undefined,
        parentWorkItemId: undefined,
        sourceWorkItemId: undefined,
        relationship: undefined,
        idempotencyKey: "create:scoped"
      }
    });
  } finally {
    await client.close();
  }
});

test("unbound Assistant Chat does not receive WorkItem creation or collaboration request tools", async () => {
  const { client } = await connectMcp({ get: async () => ({}), post: async () => ({}) }, {
    sessionKind: "assistantChat", sessionObjectiveId: "", objectiveId: ""
  });
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("corptie.sessions.discover"));
    assert.equal(names.includes("corptie.collaboration.work_items.create"), false);
    assert.equal(names.includes("corptie.collaboration.request"), false);
  } finally {
    await client.close();
  }
});

test("MCP Session discovery carries an explicit peer Objective filter", async () => {
  const reads = [];
  const { client } = await connectMcp({
    get: async (path, search) => { reads.push({ path, search }); return { sessions: [] }; },
    post: async () => ({})
  });
  try {
    await client.callTool({
      name: "corptie.sessions.discover",
      arguments: {
        agent_id: "agent:marketcow",
        objective_id: "objective:marketcow",
        session_kind: "objectiveChat"
      }
    });
    assert.deepEqual(reads, [{
      path: "/internal/collaboration/sessions",
      search: {
        agentId: "agent:marketcow",
        objectiveId: "objective:marketcow",
        workItemId: undefined,
        sessionKind: "objectiveChat"
      }
    }]);
  } finally {
    await client.close();
  }
});

test("MCP server exposes the complete Phase 2 peer tool set and maps request fields", async () => {
  const calls = [];
  const reads = [];
  const backendClient = {
    get: async (path, search) => {
      reads.push({ path, search });
      return { path, search };
    },
    post: async (path, body) => {
      calls.push({ path, body });
      return { confirmation: { confirmationId: "confirmation-1", status: "pending" } };
    }
  };
  const { client } = await connectMcp(backendClient);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), expectedTools);
    assert.equal(tools.tools.find((tool) => tool.name === "corptie.agents.discover").annotations.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "corptie_list_workspaces").annotations.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "corptie_memory_search").annotations.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "corptie_memory_list").annotations.readOnlyHint, true);

    await client.callTool({ name: "corptie_list_workspaces", arguments: {} });
    await client.callTool({ name: "corptie.memory.search", arguments: { intent: "style" } });
    await client.callTool({ name: "corptie_memory_search", arguments: { intent: "style" } });
    await client.callTool({ name: "corptie_memory_list", arguments: { scope: "agent", include_revoked: true } });
    await client.callTool({
      name: "corptie_memory_remember",
      arguments: { content: "Concise replies", kind: "preference" }
    });
    await client.callTool({
      name: "corptie_memory_update",
      arguments: { memory_id: "memory:1", content: "Very concise replies" }
    });
    await client.callTool({
      name: "corptie_memory_revoke",
      arguments: { memory_id: "memory:1", reason: "withdrawn" }
    });
    await client.callTool({
      name: "corptie_create_worktree",
      arguments: {
        target_path: "/repo/feature",
        branch: "feature",
        switch_after_create: false,
        continuation_checkpoint: "Continue after migration"
      }
    });
    await client.callTool({
      name: "corptie_switch_workspace",
      arguments: {
        target_worktree_id: "worktree:feature",
        continuation_checkpoint: "Resume the remaining work"
      }
    });
    assert.deepEqual(reads.slice(0, 4), [{
      path: "/internal/collaboration/workspaces",
      search: undefined
    }, {
      path: "/internal/collaboration/memory/search",
      search: { intent: "style" }
    }, {
      path: "/internal/collaboration/memory/search",
      search: { intent: "style" }
    }, {
      path: "/internal/collaboration/memory",
      search: { scope: "agent", includeRevoked: "true" }
    }]);
    assert.deepEqual(calls.slice(0, 5), [{
      path: "/internal/collaboration/memory",
      body: { content: "Concise replies", kind: "preference" }
    }, {
      path: "/internal/collaboration/memory/memory%3A1/update",
      body: { content: "Very concise replies" }
    }, {
      path: "/internal/collaboration/memory/memory%3A1/revoke",
      body: { reason: "withdrawn" }
    }, {
      path: "/internal/collaboration/worktrees",
      body: {
        target_path: "/repo/feature",
        branch: "feature",
        switch_after_create: false,
        continuation_checkpoint: "Continue after migration"
      }
    }, {
      path: "/internal/collaboration/workspaces/switch",
      body: {
        target_worktree_id: "worktree:feature",
        continuation_checkpoint: "Resume the remaining work"
      }
    }]);

    const result = await client.callTool({
      name: "corptie.collaboration.request",
      arguments: {
        recipient_agent_id: "journal-agent",
        service_id: "investment-journal",
        type: "change_request",
        title: "Fix stale status",
        summary: "Completion still shows processing.",
        acceptance_criteria: ["Show completed after the run finishes"],
        max_iterations: 3,
        idempotency_key: "request-1"
      }
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.coordination, {
      delivery: "awaiting_user_confirmation",
      waitRequired: false,
      nextAction: "end_current_turn",
      note: "Corptie will render and resolve confirmation programmatically. Do not write a confirmation message or continue this turn."
    });
    assert.deepEqual(calls.slice(5), [{
      path: "/internal/collaboration/task-confirmations",
      body: {
        recipientAgentId: "journal-agent",
        serviceId: "investment-journal",
        type: "change_request",
        title: "Fix stale status",
        summary: "Completion still shows processing.",
        acceptanceCriteria: ["Show completed after the run finishes"],
        maxIterations: 3,
        idempotencyKey: "request-1"
      }
    }]);

    await client.callTool({
      name: "corptie_work_item_report_acceptance",
      arguments: {
        results: [{
          criterion: "Show completed after the run finishes",
          verdict: "passed",
          evidence: [{ summary: "Test passed", reference: "npm test" }]
        }]
      }
    });
    assert.deepEqual(calls[6], {
      path: "/internal/collaboration/work-items/acceptance",
      body: {
        results: [{
          criterion: "Show completed after the run finishes",
          verdict: "passed",
          evidence: [{ summary: "Test passed", reference: "npm test" }]
        }]
      }
    });

    await client.callTool({
      name: "corptie.collaboration.get_task",
      arguments: { task_id: "task-1" }
    });
    await client.callTool({
      name: "corptie.collaboration.get_task",
      arguments: { task_id: "task-1", include_history: true }
    });
    assert.deepEqual(reads.slice(4), [
      { path: "/internal/collaboration/tasks/task-1", search: { includeHistory: undefined } },
      { path: "/internal/collaboration/tasks/task-1", search: { includeHistory: "true" } }
    ]);
  } finally {
    await client.close();
  }
});

test("MCP tool failures are returned as tool errors instead of crashing the server", async () => {
  const { client } = await connectMcp({
    get: async () => {
      const error = new Error("Agent is not a participant.");
      error.code = "ACTOR_NOT_AUTHORIZED";
      throw error;
    },
    post: async () => ({})
  });
  try {
    const result = await client.callTool({
      name: "corptie.collaboration.get_task",
      arguments: { task_id: "private-task" }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ACTOR_NOT_AUTHORIZED/);
  } finally {
    await client.close();
  }
});

test("authenticated MCP workspace routes preserve the calling Agent identity", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-workspace-mcp-http-test-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  let server;
  try {
    await store.initialize();
    const core = new CollaborationCore(store);
    core.registerAgent({ agentId: "research-agent", name: "Research Agent" });
    const calls = [];
    server = http.createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!handleCollaborationHttpRequest({
        request,
        response,
        url,
        core,
        onListWorkspaces: async (agentId, metadata) => {
          calls.push({ operation: "list", agentId, metadata });
          return { activeWorktreeId: "worktree:main", workspaces: [] };
        },
        onCreateWorktree: async (agentId, input, metadata) => {
          calls.push({ operation: "create", agentId, input, metadata });
          return { worktree: { id: "worktree:feature" } };
        },
        onSwitchWorkspace: async (agentId, input, metadata) => {
          calls.push({ operation: "switch", agentId, input, metadata });
          return { status: "waitingForTurn" };
        },
        onMemoryOperation: async (agentId, tool, arguments_, metadata) => {
          calls.push({ operation: "memory", agentId, tool, arguments: arguments_, metadata });
          return { count: 0, memories: [] };
        }
      })) response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new CollaborationHttpClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      agentId: "research-agent",
      sessionScope: {
        sessionId: "session:research",
        objectiveId: "objective:research",
        workItemId: "work_item:research"
      }
    });

    await client.get("/internal/collaboration/workspaces");
    await client.post("/internal/collaboration/worktrees", { target_path: "/repo/feature" });
    await client.post("/internal/collaboration/workspaces/switch", { target_worktree_id: "worktree:feature" });
    await client.get("/internal/collaboration/memory/search", { intent: "" });

    assert.deepEqual(calls, [
      { operation: "list", agentId: "research-agent", metadata: {
        sessionId: "session:research", objectiveId: "objective:research", workItemId: "work_item:research"
      } },
      { operation: "create", agentId: "research-agent", input: { target_path: "/repo/feature" }, metadata: {
        sessionId: "session:research", objectiveId: "objective:research", workItemId: "work_item:research"
      } },
      { operation: "switch", agentId: "research-agent", input: { target_worktree_id: "worktree:feature" }, metadata: {
        sessionId: "session:research", objectiveId: "objective:research", workItemId: "work_item:research"
      } },
      {
        operation: "memory",
        agentId: "research-agent",
        tool: "corptie_memory_search",
        arguments: { intent: "" },
        metadata: {
          sessionId: "session:research",
          objectiveId: "objective:research",
          workItemId: "work_item:research"
        }
      }
    ]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("loopback API keeps one database writer and enforces the MCP process identity", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-collaboration-http-test-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  let server;
  try {
    await store.initialize();
    const core = new CollaborationCore(store);
    core.registerAgent({ agentId: "research-agent", name: "Research Agent" });
    core.registerAgent({ agentId: "journal-agent", name: "Journal Agent" });
    core.registerAgent({ agentId: "legacy-agent", name: "Legacy Agent", status: "inactive" });
    core.registerService({
      serviceId: "investment-journal",
      name: "Investment Journal",
      ownerAgentId: "journal-agent",
      status: "running",
      currentVersion: "1.3.0"
    });

    server = http.createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!handleCollaborationHttpRequest({ request, response, url, core })) {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const research = new CollaborationHttpClient({ baseUrl, agentId: "research-agent" });
    const journal = new CollaborationHttpClient({ baseUrl, agentId: "journal-agent" });

    const discovered = await research.get("/internal/collaboration/agents");
    // agents 表已升级为通用 Agent（增 role 列），平台助手（role=assistant）与协作 Agent 同表，
    // 但助手不入协作路由（设计 14）。Agent 不再因历史状态被过滤。
    const discoveredIds = discovered.agents.map((agent) => agent.agentId);
    assert.ok(discoveredIds.includes("journal-agent"));
    assert.ok(discoveredIds.includes("research-agent"));
    assert.ok(discoveredIds.includes("legacy-agent"));
    const unavailable = await research.get("/internal/collaboration/agents", { status: "unavailable" });
    assert.deepEqual(unavailable.agents, []);

    let { task } = await research.post("/internal/collaboration/tasks", {
      recipientAgentId: "journal-agent",
      serviceId: "investment-journal",
      type: "change_request",
      title: "Fix stale completion status",
      summary: "Completion remains processing.",
      acceptanceCriteria: ["Completion displays completed"],
      idempotencyKey: "http-request-1"
    });
    assert.equal(task.initiatorAgentId, "research-agent");

    const compact = await journal.get(`/internal/collaboration/tasks/${task.taskId}`);
    assert.equal(compact.task.role, "recipient");
    assert.equal(compact.task.peerAgentId, "research-agent");
    assert.equal(compact.task.currentMessage.body, "Completion remains processing.");
    assert.deepEqual(compact.task.availableActions, ["accept", "reject", "ask"]);
    assert.equal(Object.hasOwn(compact.task, "messages"), false);
    assert.equal(Object.hasOwn(compact.task, "events"), false);
    assert.equal(Object.hasOwn(compact.task, "artifacts"), false);
    assert.equal(Object.hasOwn(compact.task, "initiatorAgentId"), false);
    assert.equal(Object.hasOwn(compact.task, "recipientAgentId"), false);
    assert.equal(Object.hasOwn(compact.task, "iteration"), false);
    assert.deepEqual(Object.keys(compact.task.currentMessage), ["messageId", "messageType", "body", "createdAt", "envelope"]);
    assert.equal(compact.task.currentMessage.envelope.version, "2.0");
    assert.equal(compact.task.currentMessage.envelope.workItem.id, compact.task.workItemId);

    const full = await journal.get(`/internal/collaboration/tasks/${task.taskId}`, { includeHistory: "true" });
    assert.equal(full.task.messages.length, 1);
    assert.equal(full.task.events.length, 1);
    assert.equal(full.task.artifacts.length, 0);

    ({ task } = await journal.post(`/internal/collaboration/tasks/${task.taskId}/actions/accept`));
    assert.equal(task.status, "working");
    ({ task } = await journal.post(`/internal/collaboration/tasks/${task.taskId}/actions/submit-result`, {
      body: "Version 1.3.1 is ready.",
      artifact: {
        type: "service_release",
        name: "Investment Journal 1.3.1",
        uri: "local-service://investment-journal/1.3.1",
        metadata: { version: "1.3.1" }
      }
    }));
    assert.equal(task.status, "delivered");
    ({ task } = await research.post(`/internal/collaboration/tasks/${task.taskId}/actions/complete`, {
      body: "Verified locally."
    }));
    assert.equal(task.status, "completed");

    const overviewResponse = await fetch(`${baseUrl}/collaboration/overview`);
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json();
    // agents 表含平台助手（agentId="assistant"），协作 overview 统计协作 Agent 数时排除之
    const collaborationAgents = overview.agents.filter((agent) => agent.agentId !== "assistant");
    assert.equal(collaborationAgents.length, 3);
    assert.equal(collaborationAgents.find((agent) => agent.agentId === "legacy-agent").status, "available");
    assert.equal(overview.services.length, 1);
    assert.equal(overview.tasks[0].taskId, task.taskId);

    const detailResponse = await fetch(`${baseUrl}/collaboration/tasks/${task.taskId}`);
    const detail = await detailResponse.json();
    assert.equal(detail.task.messages.length, 3);
    assert.equal(detail.deliveries.length, 3);

    const second = await research.post("/internal/collaboration/tasks", {
      recipientAgentId: "journal-agent",
      type: "question",
      title: "User intervention test",
      summary: "This task will be canceled from the product UI.",
      acceptanceCriteria: ["Cancellation is visible"]
    });
    const cancelResponse = await fetch(
      `${baseUrl}/collaboration/tasks/${second.task.taskId}/interventions/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Canceled in the local collaboration window." })
      }
    );
    assert.equal(cancelResponse.status, 200);
    assert.equal((await cancelResponse.json()).task.status, "canceled");

    const failedDelivery = core.listDeliveriesForTask(second.task.taskId)[0];
    core.updateDelivery(failedDelivery.deliveryId, { status: "failed", lastError: "Session unavailable" });
    const retryResponse = await fetch(
      `${baseUrl}/collaboration/deliveries/${failedDelivery.deliveryId}/retry`,
      { method: "POST" }
    );
    assert.equal(retryResponse.status, 200);
    assert.equal((await retryResponse.json()).delivery.status, "pending");

    await assert.rejects(
      () => journal.get(`/internal/collaboration/tasks/${task.taskId}/actions/not-a-get`),
      (error) => error.code === "NOT_FOUND"
    );
    const outsider = new CollaborationHttpClient({ baseUrl, agentId: "missing-agent" });
    await assert.rejects(
      () => outsider.get(`/internal/collaboration/tasks/${task.taskId}`),
      (error) => error.code === "AGENT_NOT_FOUND" && error.status === 403
    );
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM collaboration_tasks").count, 2);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (store.saveTimer) clearTimeout(store.saveTimer);
    await rm(directory, { recursive: true, force: true });
  }
});
