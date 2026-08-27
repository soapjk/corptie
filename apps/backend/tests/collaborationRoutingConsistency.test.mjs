import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { SessionCollaborationService } from "../src/application/sessionCollaborationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { handleCollaborationHttpRequest } from "../src/collaboration/collaborationHttpApi.mjs";
import { CollaborationHttpClient } from "../src/mcp/collaborationHttpClient.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const LEGACY_DISCOVERY_WORK_ITEM = "work_item:1be73667-legacy-discovery";
const AUTHORITATIVE_WORK_ITEM = "work_item:0aba863c-runtime-binding";

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
    const objectives = new ObjectiveApplicationService({ store });
    const sourceAgent = store.createAgent({
      id: "agent:source", name: "Source Agent", role: "independentContributor"
    });
    const marketCow = store.createAgent({
      id: "agent:marketcow", name: "MarketCow", role: "independentContributor"
    });
    const sourceObjective = objectives.createObjective({
      id: "objective:source", name: "Source", contributorAgentIds: [sourceAgent.agentId]
    });
    const marketCowObjective = objectives.createObjective({
      id: "objective:marketcow", name: "MarketCow", contributorAgentIds: [marketCow.agentId]
    });
    objectives.createWorkItem({
      id: LEGACY_DISCOVERY_WORK_ITEM, objectiveId: sourceObjective.id, title: "Expired discovery parent"
    });
    objectives.createWorkItem({
      id: AUTHORITATIVE_WORK_ITEM, objectiveId: sourceObjective.id, title: "Authoritative runtime parent"
    });
    bindSession(store, core, {
      providerSessionId: "provider:legacy", logicalSessionId: "session:legacy",
      agentId: sourceAgent.agentId, objectiveId: sourceObjective.id,
      workItemId: LEGACY_DISCOVERY_WORK_ITEM
    });
    bindSession(store, core, {
      providerSessionId: "provider:authoritative", logicalSessionId: "session:authoritative",
      agentId: sourceAgent.agentId, objectiveId: sourceObjective.id,
      workItemId: AUTHORITATIVE_WORK_ITEM
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
      objectiveService: objectives,
      collaborationCore: core,
      startWorkItem: async ({ workItem, agent }) => {
        bindSession(store, core, {
          providerSessionId: `provider:${workItem.id}`,
          logicalSessionId: `session:${workItem.id}`,
          agentId: agent.agentId,
          objectiveId: workItem.objective_id,
          workItemId: workItem.id
        });
        return { id: `provider:${workItem.id}` };
      }
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
        objectiveId: sourceObjective.id,
        workItemId: AUTHORITATIVE_WORK_ITEM
      }
    });

    const capabilities = await authoritative.get("/internal/collaboration/session-capabilities");
    const discovery = await authoritative.get("/internal/collaboration/agents");
    const discoveredSource = discovery.agents.find((agent) => agent.agentId === sourceAgent.agentId);
    assert.equal(capabilities.sourceSessionId, "session:authoritative");
    assert.equal(capabilities.workItemId, AUTHORITATIVE_WORK_ITEM);
    assert.ok(capabilities.actions.includes("collaboration.request"));
    assert.equal(discoveredSource.sessionId, capabilities.sourceSessionId);
    assert.equal(discoveredSource.currentWorkItemId, capabilities.workItemId);
    assert.deepEqual(discoveredSource.runtimeBinding, {
      authoritative: true,
      sessionId: "session:authoritative",
      providerSessionId: "provider:authoritative",
      sessionKind: "worker",
      objectiveId: sourceObjective.id,
      workItemId: AUTHORITATIVE_WORK_ITEM
    });

    const targetItemsBeforeFailure = store.listWorkItemsByObjective(marketCowObjective.id).length;
    const staleRuntime = new CollaborationHttpClient({
      baseUrl,
      agentId: sourceAgent.agentId,
      sessionScope: {
        sessionId: "provider:authoritative",
        objectiveId: sourceObjective.id,
        workItemId: LEGACY_DISCOVERY_WORK_ITEM
      }
    });
    const staleHeaderCapabilities = await staleRuntime.get("/internal/collaboration/session-capabilities");
    const staleHeaderDiscovery = await staleRuntime.get("/internal/collaboration/agents");
    assert.equal(staleHeaderCapabilities.workItemId, AUTHORITATIVE_WORK_ITEM);
    assert.equal(
      staleHeaderDiscovery.agents.find((agent) => agent.agentId === sourceAgent.agentId).currentWorkItemId,
      AUTHORITATIVE_WORK_ITEM
    );
    await assert.rejects(
      staleRuntime.post("/internal/collaboration/task-confirmations", marketCowSwitchRequest(marketCow, marketCowObjective)),
      (error) => error.code === "COLLABORATION_CONTEXT_MISMATCH"
        && error.status === 409
        && error.message.includes(LEGACY_DISCOVERY_WORK_ITEM)
        && error.message.includes(AUTHORITATIVE_WORK_ITEM)
    );
    assert.equal(staged.length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_request_confirmations").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    assert.equal(core.listPendingDeliveries().length, 0);
    assert.equal(store.listWorkItemsByObjective(marketCowObjective.id).length, targetItemsBeforeFailure);
    assert.equal(core.listInbox(marketCow.agentId).length, 0);

    store.db.run("UPDATE work_items SET status='done' WHERE id=?", [AUTHORITATIVE_WORK_ITEM]);
    const terminalCapabilities = await authoritative.get("/internal/collaboration/session-capabilities");
    assert.equal(terminalCapabilities.actions.includes("collaboration.request"), false);
    await assert.rejects(
      authoritative.post("/internal/collaboration/task-confirmations", marketCowSwitchRequest(marketCow, marketCowObjective)),
      (error) => error.code === "COLLABORATION_REQUEST_FORBIDDEN"
        && error.status === 403
        && error.message.includes(AUTHORITATIVE_WORK_ITEM)
        && /terminal/.test(error.message)
    );
    assert.equal(staged.length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_request_confirmations").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    assert.equal(core.listPendingDeliveries().length, 0);
    assert.equal(store.listWorkItemsByObjective(marketCowObjective.id).length, targetItemsBeforeFailure);
    store.db.run("UPDATE work_items SET status='todo' WHERE id=?", [AUTHORITATIVE_WORK_ITEM]);

    stagingError = Object.assign(new Error("Confirmation card staging failed."), { code: "CONFIRMATION_STAGING_FAILED" });
    await assert.rejects(
      authoritative.post("/internal/collaboration/task-confirmations", marketCowSwitchRequest(marketCow, marketCowObjective)),
      (error) => error.code === "CONFIRMATION_STAGING_FAILED" && error.status === 400
    );
    stagingError = null;
    assert.equal(staged.length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_request_confirmations").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    assert.equal(core.listPendingDeliveries().length, 0);
    assert.equal(store.listWorkItemsByObjective(marketCowObjective.id).length, targetItemsBeforeFailure);
    assert.equal(core.listInbox(marketCow.agentId).length, 0);

    const proposed = await authoritative.post(
      "/internal/collaboration/task-confirmations",
      marketCowSwitchRequest(marketCow, marketCowObjective)
    );
    assert.ok(proposed.confirmation.confirmationId);
    assert.equal(proposed.confirmation.status, "pending");
    assert.equal(staged.length, 1);
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    assert.equal(store.listWorkItemsByObjective(marketCowObjective.id).length, targetItemsBeforeFailure);

    const resolutionResponse = await fetch(
      `${baseUrl}/collaboration/confirmations/${encodeURIComponent(proposed.confirmation.confirmationId)}/confirm`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    assert.equal(resolutionResponse.status, 200);
    const resolved = await resolutionResponse.json();
    assert.ok(resolved.confirmation.taskId);
    const task = core.getTask(resolved.confirmation.taskId);
    assert.ok(task);
    assert.ok(task.workItemId);
    assert.equal(store.getWorkItem(task.workItemId).objective_id, marketCowObjective.id);
    assert.equal(task.recipientAgentId, marketCow.agentId);
    assert.ok(task.recipientSessionId);
    assert.equal(core.listPendingDeliveries().some((delivery) =>
      delivery.recipientAgentId === marketCow.agentId
      && core.getDeliveryEnvelope(delivery.deliveryId).task.taskId === task.taskId
    ), true);
    assert.equal(core.listInbox(task.recipientSessionId).some((item) => item.taskId === task.taskId), true);
    assert.equal(store.listWorkItemsByObjective(marketCowObjective.id).length, targetItemsBeforeFailure + 1);

    const recipientRuntime = new CollaborationHttpClient({
      baseUrl,
      agentId: marketCow.agentId,
      sessionScope: {
        sessionId: `provider:${task.workItemId}`,
        objectiveId: marketCowObjective.id,
        workItemId: task.workItemId
      }
    });
    const child = await recipientRuntime.post("/internal/collaboration/task-confirmations", {
      recipientSessionName: "session:authoritative",
      targetObjectiveId: sourceObjective.id,
      type: "question",
      title: "Follow up through the trusted parent relationship",
      summary: "The backend should derive the parent Task and Context from this WorkItem."
    });
    assert.equal(child.confirmation.request.parentTaskId, task.taskId);
    assert.equal(child.confirmation.request.contextId, task.contextId);
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
    const objectives = new ObjectiveApplicationService({ store });
    const source = store.createAgent({ id: "agent:permission-source", name: "Source", role: "independentContributor" });
    const target = store.createAgent({ id: "agent:permission-target", name: "Target", role: "independentContributor" });
    const sourceObjective = objectives.createObjective({
      id: "objective:permission-source", name: "Source", contributorAgentIds: [source.agentId]
    });
    const targetObjective = objectives.createObjective({
      id: "objective:permission-target", name: "Target", contributorAgentIds: [target.agentId]
    });
    bindSession(store, core, {
      providerSessionId: "provider:assistant", logicalSessionId: "session:assistant",
      agentId: source.agentId, objectiveId: sourceObjective.id, workItemId: null,
      kind: "assistantChat"
    });
    const service = new SessionCollaborationService({
      store, objectiveService: objectives, collaborationCore: core,
      startWorkItem: async () => { throw new Error("must not launch"); }
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
      sessionScope: { sessionId: "provider:assistant", objectiveId: sourceObjective.id }
    });
    const capabilities = await client.get("/internal/collaboration/session-capabilities");
    assert.equal(capabilities.actions.includes("collaboration.request"), false);
    assert.equal(capabilities.denials["collaboration.request"].code, "COLLABORATION_REQUEST_FORBIDDEN");
    await assert.rejects(
      client.post("/internal/collaboration/task-confirmations", marketCowSwitchRequest(target, targetObjective)),
      (error) => error.code === "COLLABORATION_REQUEST_FORBIDDEN"
        && error.status === 403
        && /Objective Chat or Worker Session/.test(error.message)
    );
    assert.equal(store.selectAll("SELECT * FROM collaboration_request_confirmations").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    assert.equal(core.listPendingDeliveries().length, 0);
    assert.equal(store.listWorkItemsByObjective(targetObjective.id).length, 0);
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
    objectiveId: input.objectiveId,
    workItemId: input.workItemId
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

function marketCowSwitchRequest(recipient, objective) {
  return {
    sessionAgentId: recipient.agentId,
    targetObjectiveId: objective.id,
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
