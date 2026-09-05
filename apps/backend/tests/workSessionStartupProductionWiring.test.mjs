import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkSessionStartApplicationService } from "../src/application/workSessionStartApplicationService.mjs";
import { WorkSessionStartupCoordinator } from "../src/application/workSessionStartupCoordinator.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { SessionCollaborationService } from "../src/application/sessionCollaborationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { handleCollaborationHttpRequest } from "../src/collaboration/collaborationHttpApi.mjs";
import {
  callCollaborationDynamicTool
} from "../src/collaboration/collaborationDynamicTools.mjs";
import { CollaborationHttpClient } from "../src/mcp/collaborationHttpClient.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);

test("Dynamic Tool and real HTTP wiring create one deferred bound Worker Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-start-production-wiring-"));
  const store = new CorptieStore({
    dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json")
  });
  let server;
  try {
    await store.initialize();
    const core = new CollaborationCore(store);
    const workService = new WorkApplicationService({ store });
    const agent = store.createAgent({
      id: "agent:worker", name: "Worker", role: "independentContributor"
    });
    const now = new Date().toISOString();
    const worktreePath = join(directory, "worktree");
    store.createWorkspace({
      workspaceId: "workspace:one", kind: "linkedLocal", ownership: "userManaged", rootPath: directory
    });
    store.db.run(
      "INSERT INTO git_repositories (repository_id, workspace_id, common_git_dir, discovered_at, last_validated_at) VALUES (?, ?, ?, ?, ?)",
      ["repository:one", "workspace:one", join(directory, ".git"), now, now]
    );
    store.db.run(
      `INSERT INTO git_worktrees (worktree_id, repository_id, path, canonical_path, git_dir,
       is_main, availability, head_oid, branch_ref, branch_name, detached, inventory_version,
       observed_at, raw_json) VALUES ('worktree:one','repository:one',?,?,?,0,'available',?,
       'refs/heads/task/one','task/one',0,'inventory:one',?,'{}')`,
      [worktreePath, worktreePath, join(directory, ".git", "worktrees", "one"), COMMIT, now]
    );
    const work = workService.createWork({
      id: "work:one", name: "Work", contributorAgentIds: [agent.agentId],
      workspaceId: "workspace:one"
    });
    store.createSession({
      id: "provider:source", title: "Work Chat", provider: "test-provider",
      agentId: agent.agentId, sessionKind: "workChat", workId: work.id,
      cwd: directory
    });
    store.createLogicalSessionRoute({
      logicalSessionId: "session:source", legacySessionId: "provider:source",
      providerThreadId: "thread:source", providerSessionId: "provider:source",
      providerId: "test-provider", boundCwd: directory, sessionName: "Work Chat"
    });
    core.bindSession({ agentId: agent.agentId, sessionId: "provider:source" });
    const sourceLogical = store.getLogicalSession("session:source");
    const creationMessage = store.createUserMessageDelivery({
      deliveryId: "delivery:create-task",
      messageId: "message:create-task",
      sessionId: "provider:source",
      binding: sourceLogical.activeBinding,
      agentId: agent.agentId,
      text: "请创建一个新的 Task 来完成这项工作",
      source: { type: "desktop" }
    });
    store.updateMessageDelivery(creationMessage.delivery.deliveryId, {
      status: "accepted", providerTurnId: "turn:create-task",
      providerAcknowledgedAt: new Date().toISOString()
    });
    const creationEvent = store.getSessionEvent("user-message:message:create-task");
    const creationEvidence = {
      logical_session_id: "session:source",
      user_message_event_id: creationEvent.eventId,
      user_message_sequence: creationEvent.sequence,
      turn_id: "turn:create-task"
    };

    let applicationService;
    const calls = { create: 0, bind: 0, activate: 0 };
    const coordinator = new WorkSessionStartupCoordinator({
      store,
      authorizeStart: (command) => applicationService.authorize(command),
      prepareWorktree: async ({ startupOperationId }) => ({
        repositoryId: "repository:one", worktreeId: "worktree:one",
        canonicalWorktreePath: worktreePath,
        headIdentity: { kind: "branch", branch: "task/one" },
        sourceCommitOid: COMMIT, sourceTreeOid: TREE, baseRef: "main",
        repositoryInventoryVersion: "inventory:one", workspaceResourceVersion: 1,
        createdByStartupOperationId: startupOperationId, reused: false
      }),
      inspectWorktree: async ({ allocation }) => allocation,
      providerWorkSessionPort: {
        createSession: async ({ taskId, assigneeAgentId, providerId, workspace }) => {
          calls.create += 1;
          store.createSession({
            id: "provider:worker", title: "Worker", provider: providerId,
            agentId: assigneeAgentId, sessionKind: "worker", workId: work.id,
            taskId, cwd: workspace.canonicalWorktreePath, deferTaskProjection: true
          });
          store.createLogicalSessionRoute({
            logicalSessionId: "session:worker", legacySessionId: "provider:worker",
            providerThreadId: "thread:worker", providerSessionId: "provider:worker",
            providerId, boundCwd: workspace.canonicalWorktreePath, sessionName: "Worker"
          });
          core.bindSession({ agentId: assigneeAgentId, sessionId: "provider:worker" });
          return store.getSession("provider:worker");
        },
        inspectBinding: async () => {
          throw Object.assign(new Error("not bound"), { code: "START_PROVIDER_BINDING_NOT_FOUND" });
        },
        bindWorkspace: async (input) => {
          calls.bind += 1;
          return {
            providerBindingId: input.providerBindingId,
            bindingGeneration: input.bindingGeneration,
            providerResourceId: "provider:worker",
            canonicalWorkingDirectory: input.workingDirectory,
            trustedContextHash: input.trustedContextHash
          };
        },
        activateSession: async (activation) => {
          if (activation.dispatchInitialTurn !== true) return {
            providerResourceId: "provider:worker",
            canonicalWorkingDirectory: activation.workingDirectory,
            toolContractHash: "c".repeat(64), instructionSourcesHash: "d".repeat(64)
          };
          const { receipt } = activation;
          calls.activate += 1;
          assert.equal(store.selectOne(
            "SELECT state FROM work_session_startup_operations WHERE startup_operation_id=?",
            [receipt.startupOperationId]
          ).state, "ready");
          store.appendSessionEvent({
            eventId: "event:initial-turn", sessionId: "provider:worker", type: "SessionUserMessageCreated",
            producer: "corptie", surface: true, payload: { text: "Initial Turn" }
          });
        },
        compensateSession: async () => {}
      },
      compensateWorktree: async () => ({ removed: true })
    });
    const providerRegistry = { supports: () => true };
    applicationService = new WorkSessionStartApplicationService({
      store, coordinator, providerRegistry, resolveProviderId: (value) => value
    });
    const collaborationService = new SessionCollaborationService({
      store, workService, collaborationCore: core,
      workSessionStartApplicationService: applicationService,
      defaultProviderId: "test-provider"
    });

    server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (!handleCollaborationHttpRequest({
        request, response, url, core, sessionCollaborationService: collaborationService
      })) {
        response.writeHead(404); response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const client = new CollaborationHttpClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      agentId: agent.agentId,
      sessionScope: { sessionId: "session:source", workId: work.id }
    });
    const started = await callCollaborationDynamicTool(client, "corptie_collaboration_tasks_create", {
      title: "ProductionWiring",
      agent_id: agent.agentId,
      provider_id: "test-provider",
      ...creationEvidence,
      idempotency_key: "create:one"
    });

    assert.equal(started.executionStatus, "idle");
    assert.equal(started.session.sessionId, "session:worker");
    assert.deepEqual(calls, { create: 1, bind: 1, activate: 0 });
    const task = store.getTask(started.task.id);
    assert.equal(task.main_agent_id, agent.agentId);
    assert.equal(task.current_session_id, "provider:worker");
    assert.equal(task.lifecycle_state, "in_progress");
    assert.equal(task.execution_status, "idle");
    assert.equal(store.listSessionEvents("provider:worker").some(
      (event) => event.payload?.text === "Initial Turn"
    ), false);

    await callCollaborationDynamicTool(client, "corptie_collaboration_tasks_create", {
      title: "ProductionWiring",
      agent_id: agent.agentId,
      provider_id: "test-provider",
      ...creationEvidence,
      idempotency_key: "create:one"
    });
    assert.deepEqual(calls, { create: 1, bind: 1, activate: 0 });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
