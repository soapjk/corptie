import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { ArtifactService } from "../src/application/artifactService.mjs";
import { resolveRecipientSession, SessionCollaborationService } from "../src/application/sessionCollaborationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkItemCompletionService } from "../src/application/workItemCompletionService.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-collaboration-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const core = new CollaborationCore(store);
  const objectiveService = new ObjectiveApplicationService({ store });
  const artifactService = new ArtifactService({ store, contentRoot: join(directory, "artifacts") });
  await artifactService.initialize();
  const launches = [];
  const service = new SessionCollaborationService({
    store, objectiveService, artifactService, collaborationCore: core,
    startWorkItem: async (input) => { launches.push(input); return { id: "worker:launched" }; }
  });
  return { directory, store, core, objectiveService, artifactService, service, launches };
}

function session(store, core, input) {
  store.createSession({
    id: input.providerSessionId,
    title: input.logicalSessionId,
    agentId: input.agentId,
    sessionKind: input.kind,
    objectiveId: input.objectiveId,
    workItemId: input.workItemId
  });
  store.createLogicalSessionRoute({
    logicalSessionId: input.logicalSessionId,
    legacySessionId: input.providerSessionId,
    providerThreadId: `thread:${input.providerSessionId}`,
    providerSessionId: input.providerSessionId,
    providerId: "codex-app-server",
    boundCwd: input.cwd,
    sessionName: input.logicalSessionId
  });
  core.bindSession({ agentId: input.agentId, sessionId: input.providerSessionId });
}

function registerRepository(store, repositoryId) {
  const observedAt = "2026-08-23T00:00:00.000Z";
  store.upsertGitWorkspaceSnapshot({
    repository: {
      id: repositoryId,
      commonGitDirCanonicalPath: `/tmp/${repositoryId}/.git`,
      discoveredAt: observedAt,
      lastValidatedAt: observedAt
    },
    worktrees: [{
      worktreeId: `worktree:${repositoryId}`,
      repositoryId,
      path: `/tmp/${repositoryId}`,
      canonicalPath: `/tmp/${repositoryId}`,
      gitDirCanonicalPath: `/tmp/${repositoryId}/.git`,
      isMain: true,
      availability: "available",
      headOid: "b".repeat(40),
      branchRef: "refs/heads/main",
      branchName: "main",
      isDetached: false,
      isLocked: false,
      lockReason: null,
      isPrunable: false,
      pruneReason: null,
      inventoryVersion: "inventory:collaboration",
      observedAt
    }],
    inventoryVersion: "inventory:collaboration",
    observedAt
  });
}

test("same-Agent Sessions are separately discoverable and can collaborate without shared-context assumptions", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:same", name: "Same Agent", role: "independentContributor" });
    const objective = f.objectiveService.createObjective({ name: "One Objective", contributorAgentIds: [agent.agentId] });
    const source = f.objectiveService.createWorkItem({ objectiveId: objective.id, title: "Source" });
    const target = f.objectiveService.createWorkItem({ objectiveId: objective.id, title: "Target", mainAgentId: agent.agentId });
    session(f.store, f.core, { providerSessionId: "provider:one", logicalSessionId: "session:one", agentId: agent.agentId, kind: "worker", objectiveId: objective.id, workItemId: source.id, cwd: f.directory });
    session(f.store, f.core, { providerSessionId: "provider:two", logicalSessionId: "session:two", agentId: agent.agentId, kind: "worker", objectiveId: objective.id, workItemId: target.id, cwd: f.directory });

    const discovered = f.service.discoverSessions({ sessionId: "provider:one" }, agent.agentId);
    assert.deepEqual(new Set(discovered.map((item) => item.sessionId)), new Set(["session:one", "session:two"]));
    assert.ok(discovered.every((item) => item.agentId === agent.agentId));

    let task = f.core.createTask({
      initiatorAgentId: agent.agentId, recipientAgentId: agent.agentId,
      initiatorSessionId: "session:one", recipientSessionId: "session:two",
      sourceObjectiveId: objective.id, targetObjectiveId: objective.id,
      sourceWorkItemId: source.id, workItemId: target.id,
      title: "Session handoff", summary: "Two isolated contexts cooperate."
    });
    assert.equal(task.initiatorSessionId, "session:one");
    assert.equal(task.recipientSessionId, "session:two");
    assert.equal(task.routeStatus, "active");
    assert.throws(() => f.core.accept(task.taskId, agent.agentId, "session:one"), { code: "SESSION_ACTOR_MISMATCH" });

    const beforeRoute = f.store.getLogicalSession("session:two");
    f.store.beginWorkspaceTransition({
      transitionId: "transition:recipient-provider-fork",
      logicalSessionId: "session:two",
      transitionKind: "provider",
      targetProviderId: "claude-sdk",
      targetCwd: f.directory,
      sourceRoutingVersion: beforeRoute.routingVersion,
      phase: "waitingForTurn",
      strategy: "fork"
    });
    f.store.commitWorkspaceTransition("transition:recipient-provider-fork", {
      providerThreadId: "thread:recipient-recovered",
      providerSessionId: "thread:recipient-recovered",
      providerId: "claude-sdk",
      boundCwd: f.directory,
      sessionProjection: { status: "running", external: { provider: "claude-sdk" } }
    });
    task = f.core.accept(task.taskId, agent.agentId, "session:two");
    assert.equal(task.status, "accepted");
    assert.equal(task.routingVersion, 2);
    assert.equal(task.routeStatus, "recovered");
    assert.equal(task.recipientBindingId, f.store.getLogicalSession("session:two").activeBinding.bindingId);
    assert.ok(f.store.selectAll("SELECT * FROM collaboration_events WHERE task_id=? AND type='route_recovered'", [task.taskId]).length === 1);
    task = f.core.reply(task.taskId, agent.agentId, "Stable sender identity", { actorSessionId: "provider:two" });
    assert.equal(task.messages.at(-1).senderSessionId, "session:two");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("protocol v3 persistence rejects missing authoritative recipient Session metadata", async () => {
  const f = await fixture();
  try {
    const source = f.store.createAgent({ id: "agent:route-source", name: "Route Source", role: "independentContributor" });
    const recipient = f.store.createAgent({ id: "agent:route-recipient", name: "Route Recipient", role: "independentContributor" });
    const objective = f.objectiveService.createObjective({
      name: "Route Guard",
      contributorAgentIds: [source.agentId, recipient.agentId]
    });
    session(f.store, f.core, {
      providerSessionId: "provider:route-source", logicalSessionId: "session:route-source",
      agentId: source.agentId, kind: "objectiveChat", objectiveId: objective.id, cwd: f.directory
    });
    const recipientWorkItem = f.objectiveService.createWorkItem({
      objectiveId: objective.id,
      title: "Recipient route",
      mainAgentId: recipient.agentId
    });
    session(f.store, f.core, {
      providerSessionId: "provider:route-recipient", logicalSessionId: "session:route-recipient",
      agentId: recipient.agentId, kind: "worker", objectiveId: objective.id,
      workItemId: recipientWorkItem.id, cwd: f.directory
    });
    const task = f.core.createTask({
      taskId: "c4471174-177e-4fe9-ab1d-cd10e070da35",
      initiatorAgentId: source.agentId,
      recipientAgentId: recipient.agentId,
      initiatorSessionId: "session:route-source",
      recipientSessionId: "session:route-recipient",
      initiatorNameAtSend: "Historical Initiator Session",
      recipientNameAtSend: "Recipient Worker Session",
      sourceObjectiveId: objective.id,
      targetObjectiveId: objective.id,
      title: "Route metadata guard",
      summary: "Do not accept an ambiguous capsule."
    });
    const currentSourceWorkItem = f.objectiveService.createWorkItem({
      objectiveId: objective.id,
      title: "Current source route",
      mainAgentId: source.agentId
    });
    session(f.store, f.core, {
      providerSessionId: "provider:route-source-current", logicalSessionId: "session:route-source-current",
      agentId: source.agentId, kind: "worker", objectiveId: objective.id,
      workItemId: currentSourceWorkItem.id, cwd: f.directory
    });
    const delivery = f.core.listPendingDeliveries().find((item) => item.recipientAgentId === recipient.agentId);
    const envelope = f.core.getDeliveryEnvelope(delivery.deliveryId);
    assert.equal(envelope.task.taskId, "c4471174-177e-4fe9-ab1d-cd10e070da35");
    assert.equal(envelope.task.initiatorAgentId, source.agentId);
    assert.equal(envelope.task.recipientAgentId, recipient.agentId);
    assert.equal(envelope.task.initiatorSessionId, "session:route-source");
    assert.equal(envelope.task.recipientSessionId, "session:route-recipient");
    assert.equal(envelope.task.initiatorNameAtSend, "Historical Initiator Session");
    assert.equal(envelope.task.recipientNameAtSend, "Recipient Worker Session");
    assert.equal(envelope.message.envelope.resources.sourceObjectiveId, objective.id);
    assert.equal(envelope.message.envelope.resources.targetObjectiveId, objective.id);
    assert.notEqual(f.core.getAgent(source.agentId).currentSessionId, envelope.task.initiatorSessionId);
    assert.throws(
      () => f.store.db.run(
        "UPDATE collaboration_tasks SET recipient_session_id=NULL, routing_version=NULL WHERE task_id=?",
        [task.taskId]
      ),
      /COLLABORATION_V3_DISTINCT_SESSIONS_REQUIRED/
    );
    assert.equal(f.core.getTask(task.taskId).status, "proposed");
    assert.equal(f.core.getTask(task.taskId).recipientSessionId, "session:route-recipient");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("recipient routing reports missing fields and WorkItem ownership mismatches with stable codes", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.ensureTaskRecipientSession({ taskId: "task:missing-work-item" }),
      { code: "COLLABORATION_WORK_ITEM_REQUIRED" }
    );

    const recipient = f.store.createAgent({ id: "agent:routing-owner", name: "Owner", role: "independentContributor" });
    const other = f.store.createAgent({ id: "agent:routing-other", name: "Other", role: "independentContributor" });
    const objective = f.objectiveService.createObjective({
      name: "Routing validation", contributorAgentIds: [recipient.agentId, other.agentId]
    });
    const workItem = f.objectiveService.createWorkItem({
      objectiveId: objective.id, title: "Owned target", mainAgentId: other.agentId
    });
    await assert.rejects(
      f.service.ensureTaskRecipientSession({
        taskId: "task:wrong-owner",
        workItemId: workItem.id,
        targetObjectiveId: objective.id,
        recipientAgentId: recipient.agentId
      }),
      (error) => error.code === "COLLABORATION_WORK_ITEM_AGENT_MISMATCH"
        && error.message.includes(workItem.id)
        && error.message.includes(other.agentId)
        && error.message.includes(recipient.agentId)
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("peer Objective discovery exposes context without allowing Objective Chat as a delivery target", async () => {
  const f = await fixture();
  try {
    const sourceAgent = f.store.createAgent({ id: "agent:source", name: "Source", role: "independentContributor" });
    const peerAgent = f.store.createAgent({ id: "agent:marketcow", name: "MarketCow", role: "independentContributor" });
    const repositoryId = "repository:marketcow";
    registerRepository(f.store, repositoryId);
    const sourceObjective = f.objectiveService.createObjective({ name: "Corptie", contributorAgentIds: [sourceAgent.agentId] });
    const peerObjective = f.objectiveService.createObjective({
      name: "MarketCow", contributorAgentIds: [peerAgent.agentId], workspaceIds: [repositoryId]
    });
    const peerWorkItem = f.objectiveService.createWorkItem({ objectiveId: peerObjective.id, title: "Existing", mainAgentId: peerAgent.agentId });
    session(f.store, f.core, { providerSessionId: "provider:source", logicalSessionId: "session:source", agentId: sourceAgent.agentId, kind: "objectiveChat", objectiveId: sourceObjective.id, cwd: "/source/private" });
    session(f.store, f.core, { providerSessionId: "provider:marketcow-chat", logicalSessionId: "session:marketcow-chat", agentId: peerAgent.agentId, kind: "objectiveChat", objectiveId: peerObjective.id, cwd: "/marketcow/private" });
    session(f.store, f.core, { providerSessionId: "provider:marketcow-worker", logicalSessionId: "session:marketcow-worker", agentId: peerAgent.agentId, kind: "worker", objectiveId: peerObjective.id, workItemId: peerWorkItem.id, cwd: "/marketcow/workitem" });
    const metadata = { sessionId: "provider:source" };

    assert.deepEqual(f.service.discoverSessions(metadata, sourceAgent.agentId), [
      f.service.getSession(metadata, sourceAgent.agentId, "session:source")
    ]);
    const discovered = f.service.discoverSessions(metadata, sourceAgent.agentId, {
      agentId: peerAgent.agentId, objectiveId: peerObjective.id
    });
    assert.deepEqual(new Set(discovered.map((item) => item.sessionId)), new Set(["session:marketcow-chat", "session:marketcow-worker"]));
    assert.ok(discovered.every((item) => item.visibilityScope === "peer_objective"));
    assert.ok(discovered.every((item) => item.workspace.path === null && item.workspace.repositoryId === null));
    assert.ok(discovered.every((item) => item.providerSessionId === null && item.providerId === null && item.bindingId === null));
    assert.ok(discovered.every((item) => item.collaborationCapabilities.includes("receive_task")));

    assert.throws(() => resolveRecipientSession(f.service, metadata, sourceAgent.agentId, {
      recipientAgentId: peerAgent.agentId,
      targetObjectiveId: peerObjective.id,
      routingIntent: "objective_chat"
    }), { code: "INVALID_ROUTING_INTENT" });
    const exactConfirmation = f.core.proposeTask({
      initiatorAgentId: sourceAgent.agentId,
      initiatorSessionId: "session:source",
      recipientAgentId: peerAgent.agentId,
      recipientSessionId: "session:marketcow-worker",
      sourceObjectiveId: sourceObjective.id,
      targetObjectiveId: peerObjective.id,
      workItemId: peerWorkItem.id,
      type: "change_request",
      title: "Exact MarketCow collaboration",
      summary: "Confirm the explicitly named active Worker."
    });
    const exactPrepared = await f.service.prepareTaskConfirmationTarget(exactConfirmation);
    assert.equal(exactPrepared.recipientSessionId, "session:marketcow-worker");
    assert.equal(exactPrepared.recipientAgentId, peerAgent.agentId);
    assert.equal(exactPrepared.workItemId, peerWorkItem.id);
    assert.equal(exactPrepared.created, false);

    const confirmation = f.core.proposeTask({
      initiatorAgentId: sourceAgent.agentId,
      initiatorSessionId: "session:source",
      recipientAgentId: peerAgent.agentId,
      sourceObjectiveId: sourceObjective.id,
      targetObjectiveId: peerObjective.id,
      routingIntent: "best_available",
      type: "change_request",
      title: "MarketCow collaboration",
      summary: "Create the target-scoped WorkItem only after confirmation."
    });
    assert.equal(confirmation.initiatorAgentName, "Source");
    assert.equal(confirmation.recipientAgentName, "MarketCow");
    assert.equal(confirmation.initiatorSessionTitle, "session:source");
    assert.equal(confirmation.recipientSessionTitle, null);
    assert.equal(confirmation.initiatorSessionKind, "objectiveChat");
    assert.equal(confirmation.recipientSessionKind, null);
    assert.equal(confirmation.sourceObjectiveId, sourceObjective.id);
    assert.equal(confirmation.sourceObjectiveName, "Corptie");
    assert.equal(confirmation.targetObjectiveId, peerObjective.id);
    assert.equal(confirmation.targetObjectiveName, "MarketCow");
    assert.equal(f.store.listWorkItemsByObjective(peerObjective.id).length, 1);
    f.service.launchWorkItem = async ({ workItem, agent, autoUniqueTitle }) => {
      assert.equal(autoUniqueTitle, true);
      session(f.store, f.core, {
        providerSessionId: "provider:marketcow-collaboration", logicalSessionId: "session:marketcow-collaboration",
        agentId: agent.agentId, kind: "worker", objectiveId: workItem.objective_id,
        workItemId: workItem.id, cwd: f.directory
      });
      return { id: "provider:marketcow-collaboration" };
    };
    const prepared = await f.service.prepareTaskConfirmationTarget(confirmation);
    assert.equal(f.store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    const confirmed = f.core.confirmTaskConfirmation(confirmation.confirmationId, prepared);
    const task = f.core.getTask(confirmed.taskId);
    assert.equal(task.recipientSessionId, "session:marketcow-collaboration");
    assert.equal(task.targetObjectiveId, peerObjective.id);
    assert.equal(f.store.getWorkItem(task.workItemId).objective_id, peerObjective.id);
    assert.equal(f.store.getWorkItem(task.workItemId).main_workspace_id, repositoryId);
    assert.equal(f.store.listWorkItemsByObjective(peerObjective.id).length, 2);
    assert.equal(f.store.getSession("provider:marketcow-collaboration").sessionKind, "worker");
    assert.equal(f.store.getSession("provider:marketcow-collaboration").workItemId, task.workItemId);
    assert.throws(() => f.service.getWorkItem(metadata, sourceAgent.agentId, peerWorkItem.id), { code: "WORK_ITEM_OUTSIDE_SCOPE" });
    assert.throws(() => f.service.createWorkItem(metadata, sourceAgent.agentId, {
      title: "Illegal target write", agentId: peerAgent.agentId, idempotencyKey: "illegal:target"
    }), { code: "AGENT_OUTSIDE_OBJECTIVE" });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("routing intent returns only suitable active Sessions and leaves creation as the automatic fallback", async () => {
  const f = await fixture();
  try {
    const sourceAgent = f.store.createAgent({ id: "agent:source", name: "Source", role: "independentContributor" });
    const peerAgent = f.store.createAgent({ id: "agent:peer", name: "Peer", role: "independentContributor" });
    const sourceObjective = f.objectiveService.createObjective({ name: "Source Objective", contributorAgentIds: [sourceAgent.agentId] });
    const peerObjective = f.objectiveService.createObjective({ name: "Peer Objective", contributorAgentIds: [peerAgent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:source", logicalSessionId: "session:source", agentId: sourceAgent.agentId, kind: "objectiveChat", objectiveId: sourceObjective.id, cwd: f.directory });
    const peerWorkItems = new Map();
    for (const suffix of ["one", "two"]) {
      const workItem = f.objectiveService.createWorkItem({ objectiveId: peerObjective.id, title: `Worker ${suffix}`, mainAgentId: peerAgent.agentId });
      peerWorkItems.set(suffix, workItem);
      session(f.store, f.core, {
        providerSessionId: `provider:peer:${suffix}`, logicalSessionId: `session:peer:${suffix}`,
        agentId: peerAgent.agentId, kind: "worker", objectiveId: peerObjective.id,
        workItemId: workItem.id, cwd: f.directory
      });
    }
    const metadata = { sessionId: "provider:source" };

    assert.throws(() => resolveRecipientSession(f.service, metadata, sourceAgent.agentId, {
      recipientAgentId: peerAgent.agentId,
      targetObjectiveId: peerObjective.id,
      routingIntent: "objective_chat"
    }), { code: "INVALID_ROUTING_INTENT" });
    const selectedWorker = resolveRecipientSession(f.service, metadata, sourceAgent.agentId, {
      recipientAgentId: peerAgent.agentId,
      targetObjectiveId: peerObjective.id,
      routingIntent: "existing_work_item_session",
      workItemId: peerWorkItems.get("one").id
    });
    assert.equal(selectedWorker.sessionId, "session:peer:one");

    const exact = resolveRecipientSession(f.service, metadata, sourceAgent.agentId, {
      recipientAgentId: peerAgent.agentId,
      targetObjectiveId: peerObjective.id,
      recipientSessionId: "session:peer:two",
      workItemId: peerWorkItems.get("two").id
    });
    assert.equal(exact.sessionId, "session:peer:two");
    assert.equal(exact.objectiveId, peerObjective.id);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("closed and invalid Sessions are filtered while an active suitable Session is reused", async () => {
  const f = await fixture();
  try {
    const sourceAgent = f.store.createAgent({ id: "agent:source-filter", name: "Source", role: "independentContributor" });
    const peerAgent = f.store.createAgent({ id: "agent:peer-filter", name: "Peer", role: "independentContributor" });
    const sourceObjective = f.objectiveService.createObjective({ name: "Source Filter", contributorAgentIds: [sourceAgent.agentId] });
    const peerObjective = f.objectiveService.createObjective({ name: "Peer Filter", contributorAgentIds: [peerAgent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:source-filter", logicalSessionId: "session:source-filter", agentId: sourceAgent.agentId, kind: "objectiveChat", objectiveId: sourceObjective.id, cwd: f.directory });
    const workItems = new Map();
    for (const suffix of ["closed", "invalid", "active"]) {
      const workItem = f.objectiveService.createWorkItem({
        objectiveId: peerObjective.id,
        title: `Peer ${suffix}`,
        mainAgentId: peerAgent.agentId
      });
      workItems.set(suffix, workItem);
      session(f.store, f.core, {
        providerSessionId: `provider:peer-${suffix}`, logicalSessionId: `session:peer-${suffix}`,
        agentId: peerAgent.agentId, kind: "worker", objectiveId: peerObjective.id,
        workItemId: workItem.id, cwd: f.directory
      });
    }
    f.store.db.run("UPDATE sessions SET archived=1 WHERE id='provider:peer-closed'");
    f.store.db.run("UPDATE logical_sessions SET archived=1 WHERE logical_session_id='session:peer-closed'");
    f.store.db.run("UPDATE provider_thread_bindings SET state='invalid' WHERE logical_session_id='session:peer-invalid'");

    const discovered = f.service.discoverSessions({ sessionId: "provider:source-filter" }, sourceAgent.agentId, {
      agentId: peerAgent.agentId,
      objectiveId: peerObjective.id
    });
    const byId = new Map(discovered.map((item) => [item.sessionId, item]));
    assert.equal(byId.get("session:peer-active").active, true);
    assert.equal(byId.get("session:peer-invalid"), undefined);
    assert.equal(byId.get("session:peer-closed"), undefined);
    const selected = resolveRecipientSession(f.service, { sessionId: "provider:source-filter" }, sourceAgent.agentId, {
      recipientAgentId: peerAgent.agentId,
      targetObjectiveId: peerObjective.id,
      routingIntent: "existing_work_item_session",
      workItemId: workItems.get("active").id
    });
    assert.equal(selected.sessionId, "session:peer-active");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a completed peer Worker is never routed and creation resources fall back to a new Session", async () => {
  const f = await fixture();
  try {
    const sourceAgent = f.store.createAgent({ id: "agent:source-archived", name: "Source", role: "independentContributor" });
    const peerAgent = f.store.createAgent({ id: "agent:peer-archived", name: "Peer", role: "independentContributor" });
    const unauthorizedAgent = f.store.createAgent({ id: "agent:unauthorized-archived", name: "Unauthorized", role: "independentContributor" });
    const sourceObjective = f.objectiveService.createObjective({
      name: "Source Archived", contributorAgentIds: [sourceAgent.agentId]
    });
    const peerObjective = f.objectiveService.createObjective({
      name: "Peer Archived", contributorAgentIds: [peerAgent.agentId]
    });
    session(f.store, f.core, {
      providerSessionId: "provider:source-archived", logicalSessionId: "session:source-archived",
      agentId: sourceAgent.agentId, kind: "objectiveChat", objectiveId: sourceObjective.id, cwd: f.directory
    });
    const completedWorkItem = f.objectiveService.createWorkItem({
      objectiveId: peerObjective.id,
      title: "Completed peer work",
      mainAgentId: peerAgent.agentId,
      status: "in_progress"
    });
    const completionService = new WorkItemCompletionService({ store: f.store });
    const receipt = completionService.issueMacOSIntent(completedWorkItem.id, {
      requestId: "peer-completed-intent", interactionId: "peer-completed-click",
      uiSurface: "work_item_completion_confirmation", displayedWorkItemId: completedWorkItem.id,
      displayedWorkItemTitle: completedWorkItem.title, displayedAcceptanceStatus: "not_assessed"
    }, { type: "user", id: "user:local-macos" });
    completionService.completeFromMacOS(completedWorkItem.id, {
      intentToken: receipt.intentToken, requestId: "peer-completed-intent",
      idempotencyKey: "peer-completed"
    });
    session(f.store, f.core, {
      providerSessionId: "provider:peer-archived", logicalSessionId: "session:peer-archived",
      agentId: peerAgent.agentId, kind: "worker", objectiveId: peerObjective.id,
      workItemId: completedWorkItem.id, cwd: f.directory
    });
    session(f.store, f.core, {
      providerSessionId: "provider:unauthorized-archived", logicalSessionId: "session:unauthorized-archived",
      agentId: unauthorizedAgent.agentId, kind: "worker", objectiveId: peerObjective.id,
      workItemId: completedWorkItem.id, cwd: f.directory
    });
    const metadata = { sessionId: "provider:source-archived" };

    assert.throws(
      () => f.service.getSession(metadata, sourceAgent.agentId, "session:peer-archived"),
      (error) => error.code === "RECIPIENT_SESSION_UNAVAILABLE"
        && error.statusCode === 409
        && /workItemCompleted/.test(error.message)
    );
    assert.equal(resolveRecipientSession(f.service, metadata, sourceAgent.agentId, {
      recipientSessionId: "session:peer-archived",
      targetObjectiveId: peerObjective.id,
      sessionAgentId: peerAgent.agentId
    }), null);
    assert.throws(
      () => f.service.getSession(metadata, sourceAgent.agentId, "session:unauthorized-archived"),
      (error) => error.code === "SESSION_NOT_VISIBLE"
    );
    assert.deepEqual(f.service.discoverSessions(metadata, sourceAgent.agentId, {
      agentId: peerAgent.agentId,
      objectiveId: peerObjective.id
    }), []);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("an unrouted confirmation creates its WorkItem and target Session before the formal task", async () => {
  const f = await fixture();
  try {
    const routingEvents = [];
    f.service.onRoutingEvent = (event, details) => routingEvents.push({ event, details });
    const sourceAgent = f.store.createAgent({ id: "agent:source-create", name: "Source", role: "independentContributor" });
    const peerAgent = f.store.createAgent({ id: "agent:peer-create", name: "Peer", role: "independentContributor" });
    const sourceObjective = f.objectiveService.createObjective({ name: "Source Create", contributorAgentIds: [sourceAgent.agentId] });
    const peerObjective = f.objectiveService.createObjective({ name: "Peer Create", contributorAgentIds: [peerAgent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:source-create", logicalSessionId: "session:source-create", agentId: sourceAgent.agentId, kind: "objectiveChat", objectiveId: sourceObjective.id, cwd: f.directory });
    session(f.store, f.core, { providerSessionId: "provider:peer-closed", logicalSessionId: "session:peer-closed-create", agentId: peerAgent.agentId, kind: "objectiveChat", objectiveId: peerObjective.id, cwd: f.directory });
    f.store.db.run("UPDATE sessions SET archived=1 WHERE id='provider:peer-closed'");
    f.store.db.run("UPDATE logical_sessions SET archived=1 WHERE logical_session_id='session:peer-closed-create'");
    const confirmation = f.core.proposeTask({
      initiatorAgentId: sourceAgent.agentId,
      recipientAgentId: peerAgent.agentId,
      initiatorSessionId: "session:source-create",
      sourceObjectiveId: sourceObjective.id,
      targetObjectiveId: peerObjective.id,
      sessionAgentId: peerAgent.agentId,
      title: "Create a safe route",
      summary: "No closed Session may receive this message."
    });
    f.service.launchWorkItem = async ({ workItem, agent }) => {
      session(f.store, f.core, {
        providerSessionId: "provider:peer-created", logicalSessionId: "session:peer-created",
        agentId: agent.agentId, kind: "worker", objectiveId: workItem.objective_id,
        workItemId: workItem.id, cwd: f.directory
      });
      return { id: "provider:peer-created" };
    };

    const prepared = await f.service.prepareTaskConfirmationTarget(confirmation);
    assert.equal(prepared.created, true);
    assert.equal(prepared.recipientSessionId, "session:peer-created");
    assert.equal(f.store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    const confirmed = f.core.confirmTaskConfirmation(confirmation.confirmationId, prepared);
    const task = f.core.getTask(confirmed.taskId);
    assert.equal(task.recipientSessionId, "session:peer-created");
    assert.equal(f.store.getWorkItem(task.workItemId).current_session_id, "provider:peer-created");
    assert.equal(task.messages[0].recipientSessionId, "session:peer-created");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a formal task never changes its target Session during delivery preflight", async () => {
  const f = await fixture();
  try {
    const sourceAgent = f.store.createAgent({ id: "agent:source-race", name: "Source", role: "independentContributor" });
    const peerAgent = f.store.createAgent({ id: "agent:peer-race", name: "Peer", role: "independentContributor" });
    const sourceObjective = f.objectiveService.createObjective({ name: "Source Race", contributorAgentIds: [sourceAgent.agentId] });
    const peerObjective = f.objectiveService.createObjective({ name: "Peer Race", contributorAgentIds: [peerAgent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:source-race", logicalSessionId: "session:source-race", agentId: sourceAgent.agentId, kind: "objectiveChat", objectiveId: sourceObjective.id, cwd: f.directory });
    const peerWorkItem = f.objectiveService.createWorkItem({
      objectiveId: peerObjective.id, title: "Race-safe route", mainAgentId: peerAgent.agentId
    });
    session(f.store, f.core, {
      providerSessionId: "provider:peer-race-old", logicalSessionId: "session:peer-race-old",
      agentId: peerAgent.agentId, kind: "worker", objectiveId: peerObjective.id,
      workItemId: peerWorkItem.id, cwd: f.directory
    });
    const task = f.core.createTask({
      initiatorAgentId: sourceAgent.agentId, recipientAgentId: peerAgent.agentId,
      initiatorSessionId: "session:source-race", recipientSessionId: "session:peer-race-old",
      sourceObjectiveId: sourceObjective.id, targetObjectiveId: peerObjective.id,
      workItemId: peerWorkItem.id, routingIntent: "best_available",
      title: "Race-safe route", summary: "Deliver after revalidation."
    });
    const first = await f.service.ensureTaskRecipientSession(task, { reason: "initial_selection" });
    assert.equal(first.created, false);
    f.store.db.run("UPDATE sessions SET archived=1 WHERE id='provider:peer-race-old'");
    f.store.db.run("UPDATE logical_sessions SET archived=1 WHERE logical_session_id='session:peer-race-old'");
    await assert.rejects(
      f.service.ensureTaskRecipientSession(f.core.getTask(task.taskId), { reason: "delivery_preflight" }),
      { code: "RECIPIENT_SESSION_UNAVAILABLE" }
    );
    const delivery = f.core.listPendingDeliveries()[0];
    assert.equal(delivery.status, "pending");
    assert.equal(f.core.getDeliveryEnvelope(delivery.deliveryId).task.recipientSessionId, "session:peer-race-old");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a formal task rejects a replaced broken Worker without silently changing its recipient Session", async () => {
  const f = await fixture();
  try {
    const sourceAgent = f.store.createAgent({ id: "agent:source-repair", name: "Source", role: "independentContributor" });
    const peerAgent = f.store.createAgent({ id: "agent:peer-repair", name: "MarketCow", role: "independentContributor" });
    const sourceObjective = f.objectiveService.createObjective({ name: "Source Repair", contributorAgentIds: [sourceAgent.agentId] });
    const peerObjective = f.objectiveService.createObjective({ name: "MarketCow", contributorAgentIds: [peerAgent.agentId] });
    session(f.store, f.core, {
      providerSessionId: "provider:source-repair", logicalSessionId: "session:source-repair",
      agentId: sourceAgent.agentId, kind: "objectiveChat", objectiveId: sourceObjective.id, cwd: f.directory
    });
    const workItem = f.objectiveService.createWorkItem({
      objectiveId: peerObjective.id,
      title: "获取 MarketCow 当前 exact 100-market scope",
      mainAgentId: peerAgent.agentId
    });
    session(f.store, f.core, {
      providerSessionId: "provider:missing-rollout", logicalSessionId: "session:missing-rollout",
      agentId: peerAgent.agentId, kind: "worker", objectiveId: peerObjective.id,
      workItemId: workItem.id, cwd: f.directory
    });
    const task = f.core.createTask({
      initiatorAgentId: sourceAgent.agentId,
      recipientAgentId: peerAgent.agentId,
      initiatorSessionId: "session:source-repair",
      recipientSessionId: "session:missing-rollout",
      sourceObjectiveId: sourceObjective.id,
      targetObjectiveId: peerObjective.id,
      workItemId: workItem.id,
      routingIntent: "create_dedicated_session",
      title: workItem.title,
      summary: "Return the exact active market scope."
    });

    session(f.store, f.core, {
      providerSessionId: "provider:replacement", logicalSessionId: "session:replacement",
      agentId: peerAgent.agentId, kind: "worker", objectiveId: peerObjective.id,
      workItemId: workItem.id, cwd: f.directory
    });
    await assert.rejects(
      f.service.ensureTaskRecipientSession(task, { reason: "delivery_preflight" }),
      (error) => error.code === "RECIPIENT_SESSION_UNAVAILABLE"
        && error.statusCode === 409
        && /work_item_session_superseded/.test(error.message)
    );
    assert.equal(f.core.getTask(task.taskId).recipientSessionId, "session:missing-rollout");
    assert.equal(f.store.selectOne(
      "SELECT COUNT(*) AS count FROM collaboration_events WHERE task_id=? AND type='recipient_route_reselected'",
      [task.taskId]
    ).count, 0);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Worker creation requires an explicit relation, is Objective-scoped, and retries idempotently", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:worker", name: "Worker", role: "independentContributor" });
    const objective = f.objectiveService.createObjective({ name: "Scoped", contributorAgentIds: [agent.agentId] });
    const source = f.objectiveService.createWorkItem({ objectiveId: objective.id, title: "Source" });
    session(f.store, f.core, { providerSessionId: "provider:worker", logicalSessionId: "session:worker", agentId: agent.agentId, kind: "worker", objectiveId: objective.id, workItemId: source.id, cwd: f.directory });
    const metadata = { sessionId: "provider:worker" };

    assert.throws(() => f.service.createWorkItem(metadata, agent.agentId, {
      title: "Unrelated", idempotencyKey: "create:bad"
    }), { code: "WORKER_RELATION_REQUIRED" });
    const created = f.service.createWorkItem(metadata, agent.agentId, {
      title: "Delegated", acceptanceCriteria: "Has evidence", relationship: "delegated_subtask",
      idempotencyKey: "create:delegated"
    });
    const replay = f.service.createWorkItem(metadata, agent.agentId, {
      title: "Delegated", acceptanceCriteria: "Has evidence", relationship: "delegated_subtask",
      idempotencyKey: "create:delegated"
    });
    assert.equal(replay.workItem.id, created.workItem.id);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(f.store.listWorkItemDependencies(created.workItem.id)[0].target_work_item_id, source.id);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("WorkItem creation validates, persists, and returns an existing Artifact reference", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:artifact-reference", name: "Artifact owner", role: "independentContributor" });
    const objective = f.objectiveService.createObjective({ name: "Artifact Objective", contributorAgentIds: [agent.agentId] });
    session(f.store, f.core, {
      providerSessionId: "provider:artifact-reference", logicalSessionId: "session:artifact-reference",
      agentId: agent.agentId, kind: "objectiveChat", objectiveId: objective.id, cwd: f.directory
    });
    const artifact = await f.artifactService.create({
      actorId: agent.agentId, sessionId: "provider:artifact-reference", objectiveId: objective.id
    }, { title: "Implementation contract", content: "Use the shared contract." });

    const created = f.service.createWorkItem({ sessionId: "provider:artifact-reference" }, agent.agentId, {
      title: "Referenced work", idempotencyKey: "create:with-artifact",
      artifactReference: {
        artifactId: artifact.artifactId, relation: "implementation_spec",
        required: true, versionPolicy: "fixed"
      }
    });
    assert.equal(created.workItem.references.artifacts.length, 1);
    assert.equal(created.workItem.references.artifacts[0].artifactId, artifact.artifactId);
    assert.equal(created.workItem.references.artifacts[0].pinnedVersion, 1);
    assert.equal(created.workItem.references.artifacts[0].required, true);
    assert.deepEqual(
      f.service.getWorkItem({ sessionId: "provider:artifact-reference" }, agent.agentId, created.workItem.id).references,
      created.workItem.references
    );
    const replay = f.service.createWorkItem({ sessionId: "provider:artifact-reference" }, agent.agentId, {
      title: "Referenced work", idempotencyKey: "create:with-artifact",
      artifactReference: {
        artifactId: artifact.artifactId, relation: "implementation_spec",
        required: true, versionPolicy: "fixed"
      }
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(f.store.listArtifactReferences({ workItemId: created.workItem.id }).length, 1);

    const otherObjective = f.objectiveService.createObjective({ name: "Other Objective", contributorAgentIds: [agent.agentId] });
    const otherArtifact = await f.artifactService.create({ kind: "local_user", objectiveId: otherObjective.id }, {
      title: "Other secret", content: "not visible"
    });
    const before = f.store.listWorkItemsByObjective(objective.id).length;
    assert.throws(() => f.service.createWorkItem({ sessionId: "provider:artifact-reference" }, agent.agentId, {
      title: "Forbidden cross-objective", idempotencyKey: "create:cross-objective",
      artifactReference: { artifactId: otherArtifact.artifactId }
    }), { code: "ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN" });
    assert.equal(f.store.listWorkItemsByObjective(objective.id).length, before);
    assert.throws(() => f.service.createWorkItem({ sessionId: "provider:artifact-reference" }, agent.agentId, {
      title: "Missing Artifact", idempotencyKey: "create:missing-artifact",
      artifactReference: { artifactId: "artifact:missing" }
    }), { code: "ARTIFACT_NOT_FOUND" });

    const workerAgent = f.store.createAgent({ id: "agent:artifact-worker", name: "Artifact worker", role: "independentContributor" });
    f.objectiveService.updateObjective(objective.id, {
      contributorAgentIds: [agent.agentId, workerAgent.agentId]
    });
    const source = f.objectiveService.createWorkItem({ objectiveId: objective.id, title: "Worker source" });
    session(f.store, f.core, {
      providerSessionId: "provider:artifact-worker", logicalSessionId: "session:artifact-worker",
      agentId: workerAgent.agentId, kind: "worker", objectiveId: objective.id,
      workItemId: source.id, cwd: f.directory
    });
    f.store.db.run("UPDATE work_items SET current_session_id=? WHERE id=?", ["provider:artifact-worker", source.id]);
    assert.throws(() => f.service.createWorkItem({ sessionId: "provider:artifact-worker" }, workerAgent.agentId, {
      title: "Unauthorized Artifact propagation", relationship: "delegated_subtask",
      idempotencyKey: "create:unauthorized-artifact",
      artifactReference: { artifactId: artifact.artifactId }
    }), { code: "ARTIFACT_READ_FORBIDDEN" });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("WorkItem creation validates Workspace file authority and returns durable file references", async () => {
  const f = await fixture();
  const outsideDirectory = await mkdtemp(join(tmpdir(), "corptie-file-reference-outside-"));
  try {
    const agent = f.store.createAgent({ id: "agent:file-reference", name: "File owner", role: "independentContributor" });
    const objective = f.objectiveService.createObjective({ name: "File Objective", contributorAgentIds: [agent.agentId] });
    session(f.store, f.core, {
      providerSessionId: "provider:file-reference", logicalSessionId: "session:file-reference",
      agentId: agent.agentId, kind: "objectiveChat", objectiveId: objective.id, cwd: f.directory
    });
    const filePath = join(f.directory, "implementation-plan.md");
    await writeFile(filePath, "local plan", "utf8");
    const created = f.service.createWorkItem({ sessionId: "provider:file-reference" }, agent.agentId, {
      title: "File-backed work", idempotencyKey: "create:with-file",
      fileReference: { path: filePath, relation: "test_plan", required: true }
    });
    assert.equal(created.workItem.references.files.length, 1);
    assert.equal(created.workItem.references.files[0].path, await realpath(filePath));
    assert.equal(created.workItem.references.files[0].relation, "test_plan");
    assert.equal(created.workItem.references.files[0].required, true);
    assert.equal(created.workItem.references.files[0].byteLength, 10);
    assert.equal(
      f.service.getWorkItem({ sessionId: "provider:file-reference" }, agent.agentId, created.workItem.id)
        .references.files[0].referenceId,
      created.workItem.references.files[0].referenceId
    );

    const outsidePath = join(outsideDirectory, "outside.md");
    await writeFile(outsidePath, "outside", "utf8");
    assert.throws(() => f.service.createWorkItem({ sessionId: "provider:file-reference" }, agent.agentId, {
      title: "Outside file", idempotencyKey: "create:outside-file", fileReference: { path: outsidePath }
    }), { code: "FILE_REFERENCE_FORBIDDEN" });
    assert.throws(() => f.service.createWorkItem({ sessionId: "provider:file-reference" }, agent.agentId, {
      title: "Missing file", idempotencyKey: "create:missing-file",
      fileReference: { path: join(f.directory, "missing.md") }
    }), { code: "FILE_REFERENCE_NOT_FOUND" });
    assert.throws(() => f.service.createWorkItem({ sessionId: "provider:file-reference" }, agent.agentId, {
      title: "Ambiguous reference", idempotencyKey: "create:ambiguous",
      artifactReference: { artifactId: "artifact:any" }, fileReference: { path: filePath }
    }), { code: "WORK_ITEM_REFERENCE_CONFLICT" });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});

test("WorkItems inherently read active Artifacts without receiving write or transitive sharing authority", async () => {
  const f = await fixture();
  try {
    const agentA = f.store.createAgent({ id: "agent:share-a", name: "Share A", role: "independentContributor" });
    const agentB = f.store.createAgent({ id: "agent:share-b", name: "Share B", role: "independentContributor" });
    const agentU = f.store.createAgent({ id: "agent:share-unrelated", name: "Unrelated", role: "independentContributor" });
    const objective = f.objectiveService.createObjective({
      name: "Shared Artifacts", contributorAgentIds: [agentA.agentId, agentB.agentId, agentU.agentId]
    });
    const workA = f.objectiveService.createWorkItem({ objectiveId: objective.id, title: "Work A" });
    const workB = f.objectiveService.createWorkItem({ objectiveId: objective.id, title: "Work B" });
    const unrelated = f.objectiveService.createWorkItem({ objectiveId: objective.id, title: "Unrelated" });
    f.objectiveService.addDependency(workB.id, workA.id, "depends_on");
    session(f.store, f.core, {
      providerSessionId: "provider:share-a", logicalSessionId: "session:share-a",
      agentId: agentA.agentId, kind: "worker", objectiveId: objective.id,
      workItemId: workA.id, cwd: f.directory
    });
    session(f.store, f.core, {
      providerSessionId: "provider:share-b", logicalSessionId: "session:share-b",
      agentId: agentB.agentId, kind: "worker", objectiveId: objective.id,
      workItemId: workB.id, cwd: f.directory
    });
    session(f.store, f.core, {
      providerSessionId: "provider:share-unrelated", logicalSessionId: "session:share-unrelated",
      agentId: agentU.agentId, kind: "worker", objectiveId: objective.id,
      workItemId: unrelated.id, cwd: f.directory
    });
    f.store.db.run("UPDATE work_items SET current_session_id=? WHERE id=?", ["provider:share-a", workA.id]);
    f.store.db.run("UPDATE work_items SET current_session_id=? WHERE id=?", ["provider:share-b", workB.id]);
    f.store.db.run("UPDATE work_items SET current_session_id=? WHERE id=?", ["provider:share-unrelated", unrelated.id]);
    const contextA = { actorId: agentA.agentId, sessionId: "provider:share-a", objectiveId: objective.id, workItemId: workA.id };
    const contextB = { actorId: agentB.agentId, sessionId: "provider:share-b", objectiveId: objective.id, workItemId: workB.id };
    const contextU = { actorId: agentU.agentId, sessionId: "provider:share-unrelated", objectiveId: objective.id, workItemId: unrelated.id };
    const artifactA = await f.artifactService.create(contextA, {
      title: "A contract", content: "read-only from A", idempotencyKey: "artifact:a"
    });
    assert.equal(f.store.listArtifactReferences({ artifactId: artifactA.artifactId, workItemId: workB.id }).length, 0);
    assert.equal((await f.artifactService.get(contextB, artifactA.artifactId)).content, "read-only from A");
    assert.ok(f.artifactService.list(contextB).some((artifact) => artifact.artifactId === artifactA.artifactId));
    assert.equal((await f.artifactService.search(contextB, "read-only from A")).results[0].artifact.artifactId, artifactA.artifactId);
    assert.equal((await f.artifactService.get(contextU, artifactA.artifactId)).content, "read-only from A");
    const sharedA = f.service.shareArtifact({ sessionId: "provider:share-a" }, agentA.agentId, {
      workItemId: workB.id, artifactId: artifactA.artifactId,
      relation: "handoff", required: true, versionPolicy: "fixed"
    });
    assert.equal(sharedA.access, "read_only");
    assert.equal(sharedA.reference.workItemId, workB.id);
    assert.equal(sharedA.reference.pinnedVersion, 1);
    assert.equal((await f.artifactService.get(contextB, artifactA.artifactId)).content, "read-only from A");
    const replay = f.service.shareArtifact({ sessionId: "provider:share-a" }, agentA.agentId, {
      workItemId: workB.id, artifactId: artifactA.artifactId,
      relation: "handoff", required: true, versionPolicy: "fixed"
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(f.store.listArtifactReferences({ artifactId: artifactA.artifactId, workItemId: workB.id }).length, 1);
    await assert.rejects(() => f.artifactService.publishVersion(contextB, artifactA.artifactId, {
      content: "recipient mutation"
    }), { code: "ARTIFACT_WRITE_FORBIDDEN" });
    assert.throws(() => f.service.shareArtifact({ sessionId: "provider:share-b" }, agentB.agentId, {
      workItemId: workA.id, artifactId: artifactA.artifactId
    }), { code: "ARTIFACT_RESHARE_FORBIDDEN" });
    assert.throws(() => f.service.shareArtifact({ sessionId: "provider:share-a" }, agentA.agentId, {
      workItemId: unrelated.id, artifactId: artifactA.artifactId
    }), { code: "WORK_ITEM_OUTSIDE_SCOPE" });

    const artifactB = await f.artifactService.create(contextB, {
      title: "B evidence", content: "read-only from B", idempotencyKey: "artifact:b"
    });
    assert.equal((await f.artifactService.get(contextA, artifactB.artifactId)).content, "read-only from B");
    f.store.removeWorkItemDependency(workB.id, workA.id);
    assert.equal((await f.artifactService.get(contextA, artifactB.artifactId)).content, "read-only from B");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Assistant Chat without an Objective cannot create and cancellation preserves audit data", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:assistant-chat", name: "Chat Agent", role: "independentContributor" });
    session(f.store, f.core, { providerSessionId: "provider:chat", logicalSessionId: "session:chat", agentId: agent.agentId, kind: "assistantChat", cwd: f.directory });
    assert.throws(() => f.service.createWorkItem({ sessionId: "provider:chat" }, agent.agentId, {
      title: "Forbidden", idempotencyKey: "create:forbidden"
    }), { code: "COLLABORATION_CREATE_FORBIDDEN" });

    const objective = f.objectiveService.createObjective({ name: "Objective", contributorAgentIds: [agent.agentId] });
    const source = f.objectiveService.createWorkItem({ objectiveId: objective.id, title: "Source" });
    session(f.store, f.core, { providerSessionId: "provider:objective", logicalSessionId: "session:objective", agentId: agent.agentId, kind: "objectiveChat", objectiveId: objective.id, cwd: f.directory });
    const created = f.service.createWorkItem({ sessionId: "provider:objective" }, agent.agentId, {
      title: "Cancelable", parentWorkItemId: source.id, idempotencyKey: "create:cancel"
    });
    const canceled = f.service.cancelWorkItem({ sessionId: "provider:objective" }, agent.agentId, {
      workItemId: created.workItem.id, resourceVersion: "1", reason: "No longer needed"
    });
    assert.equal(canceled.workItem.status, "canceled");
    assert.ok(canceled.workItem.canceled_at);
    assert.equal(canceled.workItem.cancel_reason, "No longer needed");
    assert.equal(canceled.workItem.resource_version, 2);
    assert.equal(canceled.cancellationOperation.resource_version_before, 1);
    assert.equal(canceled.cancellationOperation.resource_version_after, 2);
    assert.equal(canceled.idempotentReplay, false);
    assert.equal(canceled.physicallyDeleted, false);
    assert.ok(f.store.getWorkItem(created.workItem.id));
    const replay = f.service.cancelWorkItem({ sessionId: "provider:objective" }, agent.agentId, {
      workItemId: created.workItem.id, resourceVersion: "1", reason: "No longer needed"
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.cancellationOperation.operation_id, canceled.cancellationOperation.operation_id);
    assert.equal(f.store.listWorkItemCancellationOperations(created.workItem.id).length, 1);
    assert.throws(() => f.service.cancelWorkItem({ sessionId: "provider:objective" }, agent.agentId, {
      workItemId: created.workItem.id, resourceVersion: "2", reason: "A different reason"
    }), { code: "CANCELLATION_IDEMPOTENCY_CONFLICT" });
    assert.throws(() => f.objectiveService.createWorkItem({
      objectiveId: objective.id, title: "Invalid canceled create", status: "canceled"
    }), { code: "WORK_ITEM_CANCELLATION_WORKFLOW_REQUIRED" });
    assert.throws(() => f.store.updateWorkItem(source.id, { status: "canceled" }), {
      code: "WORK_ITEM_CANCELLATION_WORKFLOW_REQUIRED"
    });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("collaboration start delegates shared orchestration receipts and retries without creating another WorkItem", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:starter", name: "Starter", role: "independentContributor" });
    const objective = f.objectiveService.createObjective({ name: "Start", contributorAgentIds: [agent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:objective-start", logicalSessionId: "session:objective-start", agentId: agent.agentId, kind: "objectiveChat", objectiveId: objective.id, cwd: f.directory });
    const metadata = { sessionId: "provider:objective-start" };
    const created = f.service.createWorkItem(metadata, agent.agentId, {
      title: "Retryable launch", agentId: agent.agentId, idempotencyKey: "create:retryable"
    });

    f.service.launchWorkItem = async () => {
      f.store.db.run(
        `UPDATE work_items SET execution_status='start_failed', start_stage='failed',
         start_failure_stage='creatingSession', start_error_code='PROVIDER_UNAVAILABLE',
         start_error='provider unavailable' WHERE id=?`,
        [created.workItem.id]
      );
      throw Object.assign(new Error("provider unavailable"), {
        code: "PROVIDER_UNAVAILABLE",
        receipt: {
          phase: "failed", workItemId: created.workItem.id, executionStatus: "start_failed",
          failureStage: "creatingSession", errorCode: "PROVIDER_UNAVAILABLE"
        }
      });
    };
    await assert.rejects(
      f.service.startWorkItem(metadata, agent.agentId, {
        workItemId: created.workItem.id, resourceVersion: "1", idempotencyKey: "start:one"
      }),
      (error) => error.code === "PROVIDER_UNAVAILABLE"
        && error.receipt?.workItemId === created.workItem.id
        && error.receipt?.executionStatus === "start_failed"
        && error.receipt?.failureStage === "creatingSession"
    );
    assert.equal(f.store.getWorkItem(created.workItem.id).execution_status, "start_failed");
    assert.equal(f.objectiveService.listWorkItemsByObjective(objective.id).filter((item) => item.title === "Retryable launch").length, 1);

    f.service.launchWorkItem = async () => {
      session(f.store, f.core, {
        providerSessionId: "provider:launched", logicalSessionId: "session:launched",
        agentId: agent.agentId, kind: "worker", objectiveId: objective.id,
        workItemId: created.workItem.id, cwd: f.directory
      });
      f.store.db.run(
        "UPDATE work_items SET current_session_id=?, execution_status='running', status='in_progress' WHERE id=?",
        ["provider:launched", created.workItem.id]
      );
      return { id: "provider:launched" };
    };
    const started = await f.service.startWorkItem(metadata, agent.agentId, {
      workItemId: created.workItem.id, resourceVersion: "1", idempotencyKey: "start:one"
    });
    assert.equal(started.executionStatus, "running");
    assert.equal(started.session.sessionId, "session:launched");
    assert.equal(started.providerBinding.providerId, "codex-app-server");
    assert.equal(started.workItem.id, created.workItem.id);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
