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
  "corptie.collaboration.request",
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

async function connectMcp(backendClient) {
  const server = createCollaborationMcpServer({ agentId: "research-agent", client: backendClient });
  const client = new Client({ name: "corptie-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

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
    assert.deepEqual(calls, [{
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
      name: "corptie.collaboration.get_task",
      arguments: { task_id: "task-1" }
    });
    await client.callTool({
      name: "corptie.collaboration.get_task",
      arguments: { task_id: "task-1", include_history: true }
    });
    assert.deepEqual(reads, [
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
    assert.deepEqual(Object.keys(compact.task.currentMessage), ["messageId", "messageType", "body", "createdAt"]);

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
    assert.equal(overview.agents.length, 2);
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
