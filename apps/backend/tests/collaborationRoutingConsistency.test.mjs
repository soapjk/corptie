import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { SessionCollaborationService } from "../src/application/sessionCollaborationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { handleCollaborationHttpRequest } from "../src/collaboration/collaborationHttpApi.mjs";
import { SessionChannelService } from "../src/collaboration/sessionChannelService.mjs";
import { CollaborationHttpClient } from "../src/mcp/collaborationHttpClient.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const LEGACY_DISCOVERY_TASK = "task:1be73667-legacy-discovery";
const AUTHORITATIVE_TASK = "task:0aba863c-runtime-binding";

test("Channel HTTP routing opens a request to an exact peer Work Chat Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-channel-work-chat-routing-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  let server;
  try {
    await store.initialize();
    const core = new CollaborationCore(store, { idFactory: deterministicIds() });
    const works = new WorkApplicationService({ store });
    const source = store.createAgent({
      id: "agent:channel-source", name: "Channel Source", role: "independentContributor"
    });
    const target = store.createAgent({
      id: "agent:channel-target", name: "Channel Target", role: "independentContributor"
    });
    const sourceWork = works.createWork({
      id: "work:channel-source", name: "Channel Source", contributorAgentIds: [source.agentId]
    });
    const targetWork = works.createWork({
      id: "work:channel-target", name: "Channel Target", contributorAgentIds: [target.agentId]
    });
    const sourceTask = works.createTask({
      id: "task:channel-source", workId: sourceWork.id, title: "Open exact Channel",
      mainAgentId: source.agentId
    });
    bindSession(store, core, {
      providerSessionId: "provider:channel-source", logicalSessionId: "logical:channel-source",
      agentId: source.agentId, workId: sourceWork.id, taskId: sourceTask.id
    });
    bindSession(store, core, {
      providerSessionId: "provider:channel-target", logicalSessionId: "logical:channel-target",
      agentId: target.agentId, workId: targetWork.id, taskId: null, kind: "workChat"
    });
    const collaboration = new SessionCollaborationService({
      store, workService: works, collaborationCore: core,
      defaultProviderId: "test-provider",
      workSessionStartApplicationService: { start: async () => { throw new Error("must not launch"); } }
    });
    const channels = new SessionChannelService({
      store, collaborationCore: core, idFactory: deterministicIds()
    });
    const staged = [];
    server = http.createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!handleCollaborationHttpRequest({
        request, response, url, core,
        sessionCollaborationService: collaboration,
        sessionChannelService: channels,
        onChannelRequestStaged: async (channelRequest) => staged.push(channelRequest)
      })) response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new CollaborationHttpClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      agentId: source.agentId,
      sessionScope: {
        sessionId: "provider:channel-source", workId: sourceWork.id, taskId: sourceTask.id
      }
    });

    const result = await client.post("/internal/collaboration/channel-requests", {
      recipientSessionId: "logical:channel-target",
      recipientSessionName: "Channel Target Work Chat",
      sessionAgentId: target.agentId,
      targetWorkId: targetWork.id,
      body: "Please coordinate Discovery v3 incrementally.",
      idempotencyKey: "channel:exact-work-chat"
    });

    assert.equal(result.request.status, "pending");
    assert.equal(result.request.requestedRecipientSessionId, "logical:channel-target");
    assert.equal(staged.length, 1);
    assert.equal(store.listTasksByWork(targetWork.id).length, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy Agent discovery delegates to the authoritative runtime binding and request fails closed on stale parent context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-collaboration-routing-consistency-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  let server;
  try {
    await store.initialize();
    const core = new CollaborationCore(store, { idFactory: deterministicIds() });
    const works = new WorkApplicationService({ store });
    const sourceAgent = store.createAgent({
      id: "agent:source", name: "Source Agent", role: "independentContributor"
    });
    const marketCow = store.createAgent({
      id: "agent:marketcow", name: "MarketCow", role: "independentContributor"
    });
    const sourceWork = works.createWork({
      id: "work:source", name: "Source", contributorAgentIds: [sourceAgent.agentId]
    });
    const marketCowWork = works.createWork({
      id: "work:marketcow", name: "MarketCow", contributorAgentIds: [marketCow.agentId]
    });
    works.createTask({
      id: LEGACY_DISCOVERY_TASK, workId: sourceWork.id, title: "Expired discovery parent"
    });
    works.createTask({
      id: AUTHORITATIVE_TASK, workId: sourceWork.id, title: "Authoritative runtime parent"
    });
    bindSession(store, core, {
      providerSessionId: "provider:legacy", logicalSessionId: "session:legacy",
      agentId: sourceAgent.agentId, workId: sourceWork.id,
      taskId: LEGACY_DISCOVERY_TASK
    });
    bindSession(store, core, {
      providerSessionId: "provider:authoritative", logicalSessionId: "session:authoritative",
      agentId: sourceAgent.agentId, workId: sourceWork.id,
      taskId: AUTHORITATIVE_TASK
    });
    // Reproduce the production split: legacy Agent discovery points at the old
    // Provider cursor while the authenticated runtime is bound to the new Session.
    store.db.run(
      "UPDATE agents SET current_session_id=? WHERE agent_id=?",
      ["provider:legacy", sourceAgent.agentId]
    );

    let collaborationService;
    collaborationService = new SessionCollaborationService({
      store,
      workService: works,
      collaborationCore: core,
      defaultProviderId: "test-provider",
      workSessionStartApplicationService: { start: async (command) => {
        const task = store.getTask(command.taskId);
        const agent = store.getAgent(command.assigneeAgentId);
        bindSession(store, core, {
          providerSessionId: `provider:${task.id}`,
          logicalSessionId: `session:${task.id}`,
          agentId: agent.agentId,
          workId: task.work_id,
          taskId: task.id
        });
        return { session: store.getSession(`provider:${task.id}`) };
      } }
    });
    const staged = [];
    let stagingError = null;
    server = http.createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!handleCollaborationHttpRequest({
        request,
        response,
        url,
        core,
        sessionCollaborationService: collaborationService,
        onConfirmationStaged: async (confirmation) => {
          if (stagingError) throw stagingError;
          staged.push(confirmation);
        },
        onConfirmationResolved: async (confirmationId, approved) => {
          if (!approved) return core.rejectTaskConfirmation(confirmationId);
          const pending = core.getTaskConfirmation(confirmationId);
          const prepared = await collaborationService.prepareTaskConfirmationTarget(pending);
          return core.confirmTaskConfirmation(confirmationId, prepared);
        }
      })) response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const authoritative = new CollaborationHttpClient({
      baseUrl,
      agentId: sourceAgent.agentId,
      sessionScope: {
        sessionId: "provider:authoritative",
        workId: sourceWork.id,
        taskId: AUTHORITATIVE_TASK
      }
    });

    const capabilities = await authoritative.get("/internal/collaboration/session-capabilities");
    const discovery = await authoritative.get("/internal/collaboration/agents");
    const discoveredSource = discovery.agents.find((agent) => agent.agentId === sourceAgent.agentId);
    assert.equal(capabilities.sourceSessionId, "session:authoritative");
    assert.equal(capabilities.taskId, AUTHORITATIVE_TASK);
    assert.ok(capabilities.actions.includes("collaboration.request"));
    assert.equal(discoveredSource.sessionId, capabilities.sourceSessionId);
    assert.equal(discoveredSource.currentTaskId, capabilities.taskId);
    assert.deepEqual(discoveredSource.runtimeBinding, {
      authoritative: true,
      sessionId: "session:authoritative",
      providerSessionId: "provider:authoritative",
      sessionKind: "worker",
      workId: sourceWork.id,
      taskId: AUTHORITATIVE_TASK
    });

    const targetItemsBeforeFailure = store.listTasksByWork(marketCowWork.id).length;
    const staleRuntime = new CollaborationHttpClient({
      baseUrl,
      agentId: sourceAgent.agentId,
      sessionScope: {
        sessionId: "provider:authoritative",
        workId: sourceWork.id,
        taskId: LEGACY_DISCOVERY_TASK
      }
    });
    const staleHeaderCapabilities = await staleRuntime.get("/internal/collaboration/session-capabilities");
    const staleHeaderDiscovery = await staleRuntime.get("/internal/collaboration/agents");
    assert.equal(staleHeaderCapabilities.taskId, AUTHORITATIVE_TASK);
    assert.equal(
      staleHeaderDiscovery.agents.find((agent) => agent.agentId === sourceAgent.agentId).currentTaskId,
      AUTHORITATIVE_TASK
    );
    await assert.rejects(
      staleRuntime.post("/internal/collaboration/task-confirmations", marketCowSwitchRequest(marketCow, marketCowWork)),
      (error) => error.code === "COLLABORATION_CONTEXT_MISMATCH"
        && error.status === 409
        && error.message.includes(LEGACY_DISCOVERY_TASK)
        && error.message.includes(AUTHORITATIVE_TASK)
    );
    assert.equal(staged.length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_request_confirmations").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_requests").length, 0);
    assert.equal(core.listPendingDeliveries().length, 0);
    assert.equal(store.listTasksByWork(marketCowWork.id).length, targetItemsBeforeFailure);
    assert.equal(core.listInbox(marketCow.agentId).length, 0);

    store.db.run(
      `INSERT INTO task_completion_authorizations
       (operation_id, task_id, work_id, source_type, nonce, validated_at)
       VALUES ('fixture:terminal', ?, ?, 'direct_macos_ui_action', 'fixture:terminal', ?)`,
      [AUTHORITATIVE_TASK, sourceWork.id, new Date().toISOString()]
    );
    store.db.run(
      "UPDATE tasks SET lifecycle_state='done', completion_operation_id='fixture:terminal' WHERE id=?",
      [AUTHORITATIVE_TASK]
    );
    const terminalCapabilities = await authoritative.get("/internal/collaboration/session-capabilities");
    assert.equal(terminalCapabilities.actions.includes("collaboration.request"), false);
    await assert.rejects(
      authoritative.post("/internal/collaboration/task-confirmations", marketCowSwitchRequest(marketCow, marketCowWork)),
      (error) => error.code === "COLLABORATION_REQUEST_FORBIDDEN"
        && error.status === 403
        && error.message.includes(AUTHORITATIVE_TASK)
        && /terminal/.test(error.message)
    );
    assert.equal(staged.length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_request_confirmations").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_requests").length, 0);
    assert.equal(core.listPendingDeliveries().length, 0);
    assert.equal(store.listTasksByWork(marketCowWork.id).length, targetItemsBeforeFailure);
    store.db.run("UPDATE tasks SET lifecycle_state='todo' WHERE id=?", [AUTHORITATIVE_TASK]);

    stagingError = Object.assign(new Error("Confirmation card staging failed."), { code: "CONFIRMATION_STAGING_FAILED" });
    await assert.rejects(
      authoritative.post("/internal/collaboration/task-confirmations", marketCowSwitchRequest(marketCow, marketCowWork)),
      (error) => error.code === "CONFIRMATION_STAGING_FAILED" && error.status === 400
    );
    stagingError = null;
    assert.equal(staged.length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_request_confirmations").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_requests").length, 0);
    assert.equal(core.listPendingDeliveries().length, 0);
    assert.equal(store.listTasksByWork(marketCowWork.id).length, targetItemsBeforeFailure);
    assert.equal(core.listInbox(marketCow.agentId).length, 0);

    const proposed = await authoritative.post(
      "/internal/collaboration/task-confirmations",
      marketCowSwitchRequest(marketCow, marketCowWork)
    );
    assert.ok(proposed.confirmation.confirmationId);
    assert.equal(proposed.confirmation.status, "pending");
    assert.equal(staged.length, 1);
    assert.equal(store.selectAll("SELECT * FROM collaboration_requests").length, 0);
    assert.equal(store.listTasksByWork(marketCowWork.id).length, targetItemsBeforeFailure);

    const resolutionResponse = await fetch(
      `${baseUrl}/collaboration/confirmations/${encodeURIComponent(proposed.confirmation.confirmationId)}/confirm`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    assert.equal(resolutionResponse.status, 200);
    const resolved = await resolutionResponse.json();
    assert.ok(resolved.confirmation.taskId);
    const task = core.getTask(resolved.confirmation.taskId);
    assert.ok(task);
    assert.ok(task.taskId);
    assert.equal(store.getTask(task.targetTaskId).work_id, marketCowWork.id);
    assert.equal(task.recipientAgentId, marketCow.agentId);
    assert.ok(task.recipientSessionId);
    assert.equal(core.listPendingDeliveries().some((delivery) =>
      delivery.recipientAgentId === marketCow.agentId
      && core.getDeliveryEnvelope(delivery.deliveryId).task.taskId === task.taskId
    ), true);
    assert.equal(core.listInbox(task.recipientSessionId).some((item) => item.taskId === task.taskId), true);
    assert.equal(store.listTasksByWork(marketCowWork.id).length, targetItemsBeforeFailure + 1);

    const taskCountAfterFirstApproval = store.selectAll("SELECT * FROM collaboration_requests").length;
    const stagedCountAfterFirstApproval = staged.length;
    const repeated = await authoritative.post("/internal/collaboration/task-confirmations", {
      recipientSessionId: task.recipientSessionId,
      targetWorkId: marketCowWork.id,
      targetTaskId: task.targetTaskId,
      type: "question",
      title: "Follow up over the authorized exact Session route",
      summary: "The same source and target Sessions should not require another user confirmation.",
      idempotencyKey: "trusted-session-route-follow-up"
    });
    assert.equal(repeated.routeAuthorization, "trusted_session_pair");
    assert.equal(repeated.confirmation.status, "confirmed");
    assert.ok(repeated.confirmation.taskId);
    assert.equal(repeated.confirmation.initiatorSessionId, "session:authoritative");
    assert.equal(repeated.confirmation.recipientSessionId, task.recipientSessionId);
    assert.equal(staged.length, stagedCountAfterFirstApproval);
    assert.equal(
      store.selectAll("SELECT * FROM collaboration_requests").length,
      taskCountAfterFirstApproval + 1
    );
    assert.equal(core.listInbox(task.recipientSessionId).some((item) =>
      item.taskId === repeated.confirmation.taskId
    ), true);

    const recipientRuntime = new CollaborationHttpClient({
      baseUrl,
      agentId: marketCow.agentId,
      sessionScope: {
        sessionId: `provider:${task.targetTaskId}`,
        workId: marketCowWork.id,
        taskId: task.targetTaskId
      }
    });
    const stagedCountBeforeReverseRoute = staged.length;
    const child = await recipientRuntime.post("/internal/collaboration/task-confirmations", {
      recipientSessionName: "session:authoritative",
      targetWorkId: sourceWork.id,
      type: "question",
      title: "Follow up through the trusted parent relationship",
      summary: "The backend should derive the parent Task and Context from this Task."
    });
    const repeatedTask = core.getTask(repeated.confirmation.taskId);
    assert.equal(child.confirmation.request.parentTaskId, repeatedTask.taskId);
    assert.equal(child.confirmation.request.contextId, repeatedTask.contextId);
    assert.equal(child.confirmation.status, "pending");
    assert.equal(staged.length, stagedCountBeforeReverseRoute + 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("collaboration request permission is absent and the endpoint returns a structured denial for Assistant Chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-collaboration-permission-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  let server;
  try {
    await store.initialize();
    const core = new CollaborationCore(store);
    const works = new WorkApplicationService({ store });
    const source = store.createAgent({ id: "agent:permission-source", name: "Source", role: "independentContributor" });
    const target = store.createAgent({ id: "agent:permission-target", name: "Target", role: "independentContributor" });
    const sourceWork = works.createWork({
      id: "work:permission-source", name: "Source", contributorAgentIds: [source.agentId]
    });
    const targetWork = works.createWork({
      id: "work:permission-target", name: "Target", contributorAgentIds: [target.agentId]
    });
    bindSession(store, core, {
      providerSessionId: "provider:assistant", logicalSessionId: "session:assistant",
      agentId: source.agentId, workId: sourceWork.id, taskId: null,
      kind: "assistantChat"
    });
    const service = new SessionCollaborationService({
      store, workService: works, collaborationCore: core,
      defaultProviderId: "test-provider",
      workSessionStartApplicationService: { start: async () => { throw new Error("must not launch"); } }
    });
    server = http.createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!handleCollaborationHttpRequest({ request, response, url, core, sessionCollaborationService: service })) {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new CollaborationHttpClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      agentId: source.agentId,
      sessionScope: { sessionId: "provider:assistant", workId: sourceWork.id }
    });
    const capabilities = await client.get("/internal/collaboration/session-capabilities");
    assert.equal(capabilities.actions.includes("collaboration.request"), false);
    assert.equal(capabilities.denials["collaboration.request"].code, "COLLABORATION_REQUEST_FORBIDDEN");
    await assert.rejects(
      client.post("/internal/collaboration/task-confirmations", marketCowSwitchRequest(target, targetWork)),
      (error) => error.code === "COLLABORATION_REQUEST_FORBIDDEN"
        && error.status === 403
        && /Work Chat or Worker Session/.test(error.message)
    );
    assert.equal(store.selectAll("SELECT * FROM collaboration_request_confirmations").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_requests").length, 0);
    assert.equal(core.listPendingDeliveries().length, 0);
    assert.equal(store.listTasksByWork(targetWork.id).length, 0);
    assert.equal(core.listInbox(target.agentId).length, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function bindSession(store, core, input) {
  store.createSession({
    id: input.providerSessionId,
    title: input.logicalSessionId,
    agentId: input.agentId,
    sessionKind: input.kind ?? "worker",
    workId: input.workId,
    taskId: input.taskId
  });
  store.createLogicalSessionRoute({
    logicalSessionId: input.logicalSessionId,
    legacySessionId: input.providerSessionId,
    providerThreadId: `thread:${input.providerSessionId}`,
    providerSessionId: input.providerSessionId,
    providerId: "codex-app-server",
    boundCwd: "/tmp/corptie-collaboration-routing",
    sessionName: input.logicalSessionId
  });
  core.bindSession({ agentId: input.agentId, sessionId: input.providerSessionId });
}

function marketCowSwitchRequest(recipient, work) {
  return {
    sessionAgentId: recipient.agentId,
    targetWorkId: work.id,
    type: "change_request",
    title: "Switch MarketCow through the authoritative route",
    summary: "Submit the MarketCow switch request without stale discovery context.",
    acceptanceCriteria: ["The authoritative collaboration route receives the request."],
    idempotencyKey: "marketcow-switch-authoritative"
  };
}

function deterministicIds() {
  let index = 0;
  return () => `generated:${++index}`;
}
