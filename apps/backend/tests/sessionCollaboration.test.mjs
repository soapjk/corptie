import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { ArtifactService } from "../src/application/artifactService.mjs";
import {
  collaborationSessionEligibility,
  resolveRecipientSession,
  SessionCollaborationService
} from "../src/application/sessionCollaborationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { TaskCompletionService } from "../src/application/taskCompletionService.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-collaboration-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const core = new CollaborationCore(store);
  const workService = new WorkApplicationService({ store });
  const artifactService = new ArtifactService({ store, contentRoot: join(directory, "artifacts") });
  await artifactService.initialize();
  const launches = [];
  const service = new SessionCollaborationService({
    store, workService, artifactService, collaborationCore: core,
    workSessionStartApplicationService: {
      start: async (input) => { launches.push(input); return { session: { id: "worker:launched" } }; }
    },
    defaultProviderId: "codex-app-server"
  });
  return { directory, store, core, workService, artifactService, service, launches };
}

function session(store, core, input) {
  store.createSession({
    id: input.providerSessionId,
    title: input.logicalSessionId,
    agentId: input.agentId,
    sessionKind: input.kind,
    workId: input.workId,
    taskId: input.taskId
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

let collaborationArtifactTurn = 0;
function readPinnedArtifact(service, context, artifact, reference) {
  return service.get(context, artifact.artifactId, {
    version: reference.pinnedVersion,
    contentHash: reference.pinnedHash,
    referenceId: reference.referenceId,
    turnExecutionId: `collaboration-artifact-turn:${++collaborationArtifactTurn}`
  });
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

test("an interrupted Worker remains an active collaboration delivery target", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({
      id: "agent:interrupted-target",
      name: "Interrupted Target",
      role: "independentContributor"
    });
    const work = f.workService.createWork({
      name: "Interrupted Target Work",
      contributorAgentIds: [agent.agentId]
    });
    const task = f.workService.createTask({
      workId: work.id,
      title: "Continue after interruption",
      mainAgentId: agent.agentId
    });
    session(f.store, f.core, {
      providerSessionId: "provider:interrupted-target",
      logicalSessionId: "session:interrupted-target",
      agentId: agent.agentId,
      kind: "worker",
      workId: work.id,
      taskId: task.id,
      cwd: f.directory
    });
    f.store.db.run(
      `UPDATE sessions SET status='cancelled',
       raw_json='{"capabilities":{"canSend":false}}'
       WHERE id='provider:interrupted-target'`
    );

    const eligibility = collaborationSessionEligibility(f.store, "session:interrupted-target");
    assert.equal(eligibility.active, true);
    assert.deepEqual(eligibility.reasons, []);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("same-Agent Sessions are separately discoverable and can collaborate without shared-context assumptions", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:same", name: "Same Agent", role: "independentContributor" });
    const work = f.workService.createWork({ name: "One Work", contributorAgentIds: [agent.agentId] });
    const source = f.workService.createTask({ workId: work.id, title: "Source" });
    const target = f.workService.createTask({ workId: work.id, title: "Target", mainAgentId: agent.agentId });
    session(f.store, f.core, { providerSessionId: "provider:one", logicalSessionId: "session:one", agentId: agent.agentId, kind: "worker", workId: work.id, taskId: source.id, cwd: f.directory });
    session(f.store, f.core, { providerSessionId: "provider:two", logicalSessionId: "session:two", agentId: agent.agentId, kind: "worker", workId: work.id, taskId: target.id, cwd: f.directory });

    const discovered = f.service.discoverSessions({ sessionId: "provider:one" }, agent.agentId);
    assert.deepEqual(new Set(discovered.map((item) => item.sessionId)), new Set(["session:one", "session:two"]));
    assert.ok(discovered.every((item) => item.agentId === agent.agentId));

    let task = f.core.createTask({
      initiatorAgentId: agent.agentId, recipientAgentId: agent.agentId,
      initiatorSessionId: "session:one", recipientSessionId: "session:two",
      sourceWorkId: work.id, targetWorkId: work.id,
      sourceTaskId: source.id, taskId: target.id,
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
    const work = f.workService.createWork({
      name: "Route Guard",
      contributorAgentIds: [source.agentId, recipient.agentId]
    });
    session(f.store, f.core, {
      providerSessionId: "provider:route-source", logicalSessionId: "session:route-source",
      agentId: source.agentId, kind: "workChat", workId: work.id, cwd: f.directory
    });
    const recipientTask = f.workService.createTask({
      workId: work.id,
      title: "Recipient route",
      mainAgentId: recipient.agentId
    });
    session(f.store, f.core, {
      providerSessionId: "provider:route-recipient", logicalSessionId: "session:route-recipient",
      agentId: recipient.agentId, kind: "worker", workId: work.id,
      taskId: recipientTask.id, cwd: f.directory
    });
    const task = f.core.createTask({
      taskId: "c4471174-177e-4fe9-ab1d-cd10e070da35",
      initiatorAgentId: source.agentId,
      recipientAgentId: recipient.agentId,
      initiatorSessionId: "session:route-source",
      recipientSessionId: "session:route-recipient",
      initiatorNameAtSend: "Historical Initiator Session",
      recipientNameAtSend: "Recipient Worker Session",
      sourceWorkId: work.id,
      targetWorkId: work.id,
      title: "Route metadata guard",
      summary: "Do not accept an ambiguous capsule."
    });
    const currentSourceTask = f.workService.createTask({
      workId: work.id,
      title: "Current source route",
      mainAgentId: source.agentId
    });
    session(f.store, f.core, {
      providerSessionId: "provider:route-source-current", logicalSessionId: "session:route-source-current",
      agentId: source.agentId, kind: "worker", workId: work.id,
      taskId: currentSourceTask.id, cwd: f.directory
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
    assert.equal(envelope.message.envelope.resources.sourceWorkId, work.id);
    assert.equal(envelope.message.envelope.resources.targetWorkId, work.id);
    assert.notEqual(f.core.getAgent(source.agentId).currentSessionId, envelope.task.initiatorSessionId);
    assert.throws(
      () => f.store.db.run(
        "UPDATE collaboration_requests SET recipient_session_id=NULL, routing_version=NULL WHERE task_id=?",
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

test("recipient routing reports missing fields and Task ownership mismatches with stable codes", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.ensureTaskRecipientSession({ taskId: "request:missing-task" }),
      { code: "COLLABORATION_TARGET_TASK_REQUIRED" }
    );

    const recipient = f.store.createAgent({ id: "agent:routing-owner", name: "Owner", role: "independentContributor" });
    const other = f.store.createAgent({ id: "agent:routing-other", name: "Other", role: "independentContributor" });
    const work = f.workService.createWork({
      name: "Routing validation", contributorAgentIds: [recipient.agentId, other.agentId]
    });
    const productTask = f.workService.createTask({
      workId: work.id, title: "Owned target", mainAgentId: other.agentId
    });
    await assert.rejects(
      f.service.ensureTaskRecipientSession({
        taskId: "request:wrong-owner",
        targetTaskId: productTask.id,
        targetWorkId: work.id,
        recipientAgentId: recipient.agentId
      }),
      (error) => error.code === "COLLABORATION_TARGET_TASK_AGENT_MISMATCH"
        && error.message.includes(productTask.id)
        && error.message.includes(other.agentId)
        && error.message.includes(recipient.agentId)
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("peer Work discovery exposes context without allowing Work Chat as a delivery target", async () => {
  const f = await fixture();
  try {
    const sourceAgent = f.store.createAgent({ id: "agent:source", name: "Source", role: "independentContributor" });
    const peerAgent = f.store.createAgent({ id: "agent:marketcow", name: "MarketCow", role: "independentContributor" });
    const repositoryId = "repository:marketcow";
    registerRepository(f.store, repositoryId);
    const sourceWork = f.workService.createWork({ name: "Corptie", contributorAgentIds: [sourceAgent.agentId] });
    const peerWork = f.workService.createWork({
      name: "MarketCow", contributorAgentIds: [peerAgent.agentId],
      workspaceId: f.store.getGitRepository(repositoryId).workspaceId
    });
    const peerTask = f.workService.createTask({ workId: peerWork.id, title: "Existing", mainAgentId: peerAgent.agentId });
    session(f.store, f.core, { providerSessionId: "provider:source", logicalSessionId: "session:source", agentId: sourceAgent.agentId, kind: "workChat", workId: sourceWork.id, cwd: "/source/private" });
    session(f.store, f.core, { providerSessionId: "provider:marketcow-chat", logicalSessionId: "session:marketcow-chat", agentId: peerAgent.agentId, kind: "workChat", workId: peerWork.id, cwd: "/marketcow/private" });
    session(f.store, f.core, { providerSessionId: "provider:marketcow-worker", logicalSessionId: "session:marketcow-worker", agentId: peerAgent.agentId, kind: "worker", workId: peerWork.id, taskId: peerTask.id, cwd: "/marketcow/task" });
    const metadata = { sessionId: "provider:source" };

    assert.deepEqual(f.service.discoverSessions(metadata, sourceAgent.agentId), [
      f.service.getSession(metadata, sourceAgent.agentId, "session:source")
    ]);
    const discovered = f.service.discoverSessions(metadata, sourceAgent.agentId, {
      agentId: peerAgent.agentId, workId: peerWork.id
    });
    assert.deepEqual(new Set(discovered.map((item) => item.sessionId)), new Set(["session:marketcow-chat", "session:marketcow-worker"]));
    assert.ok(discovered.every((item) => item.visibilityScope === "peer_work"));
    assert.ok(discovered.every((item) => item.workspace.path === null && item.workspace.repositoryId === null));
    assert.ok(discovered.every((item) => item.providerSessionId === null && item.providerId === null && item.bindingId === null));
    assert.ok(discovered.every((item) => item.collaborationCapabilities.includes("receive_task")));

    assert.throws(() => resolveRecipientSession(f.service, metadata, sourceAgent.agentId, {
      recipientAgentId: peerAgent.agentId,
      targetWorkId: peerWork.id,
      routingIntent: "work_chat"
    }), { code: "INVALID_ROUTING_INTENT" });
    const exactConfirmation = f.core.proposeTask({
      initiatorAgentId: sourceAgent.agentId,
      initiatorSessionId: "session:source",
      recipientAgentId: peerAgent.agentId,
      recipientSessionId: "session:marketcow-worker",
      sourceWorkId: sourceWork.id,
      targetWorkId: peerWork.id,
      targetTaskId: peerTask.id,
      type: "change_request",
      title: "Exact MarketCow collaboration",
      summary: "Confirm the explicitly named active Worker."
    });
    const exactPrepared = await f.service.prepareTaskConfirmationTarget(exactConfirmation);
    assert.equal(exactPrepared.recipientSessionId, "session:marketcow-worker");
    assert.equal(exactPrepared.recipientAgentId, peerAgent.agentId);
    assert.equal(exactPrepared.targetTaskId, peerTask.id);
    assert.equal(exactPrepared.created, false);

    const confirmation = f.core.proposeTask({
      initiatorAgentId: sourceAgent.agentId,
      initiatorSessionId: "session:source",
      recipientAgentId: peerAgent.agentId,
      sourceWorkId: sourceWork.id,
      targetWorkId: peerWork.id,
      routingIntent: "best_available",
      type: "change_request",
      title: "MarketCow collaboration",
      summary: "Create the target-scoped Task only after confirmation."
    });
    assert.equal(confirmation.initiatorAgentName, "Source");
    assert.equal(confirmation.recipientAgentName, "MarketCow");
    assert.equal(confirmation.initiatorSessionTitle, "session:source");
    assert.equal(confirmation.recipientSessionTitle, null);
    assert.equal(confirmation.initiatorSessionKind, "workChat");
    assert.equal(confirmation.recipientSessionKind, null);
    assert.equal(confirmation.sourceWorkId, sourceWork.id);
    assert.equal(confirmation.sourceWorkName, "Corptie");
    assert.equal(confirmation.targetWorkId, peerWork.id);
    assert.equal(confirmation.targetWorkName, "MarketCow");
    assert.equal(f.store.listTasksByWork(peerWork.id).length, 1);
    f.service.workSessionStartApplicationService.start = async ({ taskId, assigneeAgentId }) => {
      const task = f.store.getTask(taskId);
      session(f.store, f.core, {
        providerSessionId: "provider:marketcow-collaboration", logicalSessionId: "session:marketcow-collaboration",
        agentId: assigneeAgentId, kind: "worker", workId: task.work_id,
        taskId: task.id, cwd: f.directory
      });
      return { session: { id: "provider:marketcow-collaboration" } };
    };
    const prepared = await f.service.prepareTaskConfirmationTarget(confirmation);
    assert.equal(f.store.selectAll("SELECT * FROM collaboration_requests").length, 0);
    const confirmed = f.core.confirmTaskConfirmation(confirmation.confirmationId, prepared);
    const task = f.core.getTask(confirmed.taskId);
    assert.equal(task.recipientSessionId, "session:marketcow-collaboration");
    assert.equal(task.targetWorkId, peerWork.id);
    assert.equal(f.store.getTask(task.targetTaskId).work_id, peerWork.id);
    assert.equal(f.store.getTaskWorkspaceContext(task.targetTaskId).repository.id, repositoryId);
    assert.equal(f.store.listTasksByWork(peerWork.id).length, 2);
    assert.equal(f.store.getSession("provider:marketcow-collaboration").sessionKind, "worker");
    assert.equal(f.store.getSession("provider:marketcow-collaboration").taskId, task.targetTaskId);
    assert.throws(() => f.service.getTask(metadata, sourceAgent.agentId, peerTask.id), { code: "TASK_OUTSIDE_SCOPE" });
    assert.throws(() => f.service.createTask(metadata, sourceAgent.agentId, {
      title: "Illegal target write", agentId: peerAgent.agentId, idempotencyKey: "illegal:target"
    }), { code: "AGENT_OUTSIDE_WORK" });
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
    const sourceWork = f.workService.createWork({ name: "Source Work", contributorAgentIds: [sourceAgent.agentId] });
    const peerWork = f.workService.createWork({ name: "Peer Work", contributorAgentIds: [peerAgent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:source", logicalSessionId: "session:source", agentId: sourceAgent.agentId, kind: "workChat", workId: sourceWork.id, cwd: f.directory });
    const peerTasks = new Map();
    for (const suffix of ["one", "two"]) {
      const task = f.workService.createTask({ workId: peerWork.id, title: `Worker ${suffix}`, mainAgentId: peerAgent.agentId });
      peerTasks.set(suffix, task);
      session(f.store, f.core, {
        providerSessionId: `provider:peer:${suffix}`, logicalSessionId: `session:peer:${suffix}`,
        agentId: peerAgent.agentId, kind: "worker", workId: peerWork.id,
        taskId: task.id, cwd: f.directory
      });
    }
    const metadata = { sessionId: "provider:source" };

    assert.throws(() => resolveRecipientSession(f.service, metadata, sourceAgent.agentId, {
      recipientAgentId: peerAgent.agentId,
      targetWorkId: peerWork.id,
      routingIntent: "work_chat"
    }), { code: "INVALID_ROUTING_INTENT" });
    const selectedWorker = resolveRecipientSession(f.service, metadata, sourceAgent.agentId, {
      recipientAgentId: peerAgent.agentId,
      targetWorkId: peerWork.id,
      routingIntent: "existing_task_session",
      taskId: peerTasks.get("one").id
    });
    assert.equal(selectedWorker.sessionId, "session:peer:one");

    const exact = resolveRecipientSession(f.service, metadata, sourceAgent.agentId, {
      recipientAgentId: peerAgent.agentId,
      targetWorkId: peerWork.id,
      recipientSessionId: "session:peer:two",
      taskId: peerTasks.get("two").id
    });
    assert.equal(exact.sessionId, "session:peer:two");
    assert.equal(exact.workId, peerWork.id);
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
    const sourceWork = f.workService.createWork({ name: "Source Filter", contributorAgentIds: [sourceAgent.agentId] });
    const peerWork = f.workService.createWork({ name: "Peer Filter", contributorAgentIds: [peerAgent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:source-filter", logicalSessionId: "session:source-filter", agentId: sourceAgent.agentId, kind: "workChat", workId: sourceWork.id, cwd: f.directory });
    const tasks = new Map();
    for (const suffix of ["closed", "invalid", "active"]) {
      const task = f.workService.createTask({
        workId: peerWork.id,
        title: `Peer ${suffix}`,
        mainAgentId: peerAgent.agentId
      });
      tasks.set(suffix, task);
      session(f.store, f.core, {
        providerSessionId: `provider:peer-${suffix}`, logicalSessionId: `session:peer-${suffix}`,
        agentId: peerAgent.agentId, kind: "worker", workId: peerWork.id,
        taskId: task.id, cwd: f.directory
      });
    }
    f.store.db.run("UPDATE sessions SET archived=1 WHERE id='provider:peer-closed'");
    f.store.db.run("UPDATE logical_sessions SET archived=1 WHERE logical_session_id='session:peer-closed'");
    f.store.db.run("UPDATE provider_thread_bindings SET state='invalid' WHERE logical_session_id='session:peer-invalid'");

    const discovered = f.service.discoverSessions({ sessionId: "provider:source-filter" }, sourceAgent.agentId, {
      agentId: peerAgent.agentId,
      workId: peerWork.id
    });
    const byId = new Map(discovered.map((item) => [item.sessionId, item]));
    assert.equal(byId.get("session:peer-active").active, true);
    assert.equal(byId.get("session:peer-invalid"), undefined);
    assert.equal(byId.get("session:peer-closed"), undefined);
    const selected = resolveRecipientSession(f.service, { sessionId: "provider:source-filter" }, sourceAgent.agentId, {
      recipientAgentId: peerAgent.agentId,
      targetWorkId: peerWork.id,
      routingIntent: "existing_task_session",
      taskId: tasks.get("active").id
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
    const sourceWork = f.workService.createWork({
      name: "Source Archived", contributorAgentIds: [sourceAgent.agentId]
    });
    const peerWork = f.workService.createWork({
      name: "Peer Archived", contributorAgentIds: [peerAgent.agentId]
    });
    session(f.store, f.core, {
      providerSessionId: "provider:source-archived", logicalSessionId: "session:source-archived",
      agentId: sourceAgent.agentId, kind: "workChat", workId: sourceWork.id, cwd: f.directory
    });
    const completedTask = f.workService.createTask({
      workId: peerWork.id,
      title: "Completed peer work",
      mainAgentId: peerAgent.agentId,
      lifecycleState: "in_progress"
    });
    const completionService = new TaskCompletionService({ store: f.store });
    const receipt = completionService.issueMacOSIntent(completedTask.id, {
      requestId: "peer-completed-intent", interactionId: "peer-completed-click",
      uiSurface: "task_completion_confirmation", displayedTaskId: completedTask.id,
      displayedTaskTitle: completedTask.title, displayedAcceptanceStatus: "not_assessed"
    }, { type: "user", id: "user:local-macos" });
    completionService.completeFromMacOS(completedTask.id, {
      intentToken: receipt.intentToken, requestId: "peer-completed-intent",
      idempotencyKey: "peer-completed"
    });
    session(f.store, f.core, {
      providerSessionId: "provider:peer-archived", logicalSessionId: "session:peer-archived",
      agentId: peerAgent.agentId, kind: "worker", workId: peerWork.id,
      taskId: completedTask.id, cwd: f.directory
    });
    session(f.store, f.core, {
      providerSessionId: "provider:unauthorized-archived", logicalSessionId: "session:unauthorized-archived",
      agentId: unauthorizedAgent.agentId, kind: "worker", workId: peerWork.id,
      taskId: completedTask.id, cwd: f.directory
    });
    const metadata = { sessionId: "provider:source-archived" };

    assert.throws(
      () => f.service.getSession(metadata, sourceAgent.agentId, "session:peer-archived"),
      (error) => error.code === "RECIPIENT_SESSION_UNAVAILABLE"
        && error.statusCode === 409
        && /taskCompleted/.test(error.message)
    );
    assert.equal(resolveRecipientSession(f.service, metadata, sourceAgent.agentId, {
      recipientSessionId: "session:peer-archived",
      targetWorkId: peerWork.id,
      sessionAgentId: peerAgent.agentId
    }), null);
    assert.throws(
      () => f.service.getSession(metadata, sourceAgent.agentId, "session:unauthorized-archived"),
      (error) => error.code === "SESSION_NOT_VISIBLE"
    );
    assert.deepEqual(f.service.discoverSessions(metadata, sourceAgent.agentId, {
      agentId: peerAgent.agentId,
      workId: peerWork.id
    }), []);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("an unrouted confirmation creates its Task and target Session before the formal task", async () => {
  const f = await fixture();
  try {
    const routingEvents = [];
    f.service.onRoutingEvent = (event, details) => routingEvents.push({ event, details });
    const sourceAgent = f.store.createAgent({ id: "agent:source-create", name: "Source", role: "independentContributor" });
    const peerAgent = f.store.createAgent({ id: "agent:peer-create", name: "Peer", role: "independentContributor" });
    const sourceWork = f.workService.createWork({ name: "Source Create", contributorAgentIds: [sourceAgent.agentId] });
    const peerWork = f.workService.createWork({ name: "Peer Create", contributorAgentIds: [peerAgent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:source-create", logicalSessionId: "session:source-create", agentId: sourceAgent.agentId, kind: "workChat", workId: sourceWork.id, cwd: f.directory });
    session(f.store, f.core, { providerSessionId: "provider:peer-closed", logicalSessionId: "session:peer-closed-create", agentId: peerAgent.agentId, kind: "workChat", workId: peerWork.id, cwd: f.directory });
    f.store.db.run("UPDATE sessions SET archived=1 WHERE id='provider:peer-closed'");
    f.store.db.run("UPDATE logical_sessions SET archived=1 WHERE logical_session_id='session:peer-closed-create'");
    const confirmation = f.core.proposeTask({
      initiatorAgentId: sourceAgent.agentId,
      recipientAgentId: peerAgent.agentId,
      initiatorSessionId: "session:source-create",
      sourceWorkId: sourceWork.id,
      targetWorkId: peerWork.id,
      sessionAgentId: peerAgent.agentId,
      title: "Create a safe route",
      summary: "No closed Session may receive this message."
    });
    f.service.workSessionStartApplicationService.start = async ({ taskId, assigneeAgentId }) => {
      const task = f.store.getTask(taskId);
      session(f.store, f.core, {
        providerSessionId: "provider:peer-created", logicalSessionId: "session:peer-created",
        agentId: assigneeAgentId, kind: "worker", workId: task.work_id,
        taskId: task.id, cwd: f.directory
      });
      return { session: { id: "provider:peer-created" } };
    };

    const prepared = await f.service.prepareTaskConfirmationTarget(confirmation);
    assert.equal(prepared.created, true);
    assert.equal(prepared.recipientSessionId, "session:peer-created");
    assert.equal(f.store.selectAll("SELECT * FROM collaboration_requests").length, 0);
    const confirmed = f.core.confirmTaskConfirmation(confirmation.confirmationId, prepared);
    const task = f.core.getTask(confirmed.taskId);
    assert.equal(task.recipientSessionId, "session:peer-created");
    assert.equal(f.store.getTask(task.targetTaskId).current_session_id, "provider:peer-created");
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
    const sourceWork = f.workService.createWork({ name: "Source Race", contributorAgentIds: [sourceAgent.agentId] });
    const peerWork = f.workService.createWork({ name: "Peer Race", contributorAgentIds: [peerAgent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:source-race", logicalSessionId: "session:source-race", agentId: sourceAgent.agentId, kind: "workChat", workId: sourceWork.id, cwd: f.directory });
    const peerTask = f.workService.createTask({
      workId: peerWork.id, title: "Race-safe route", mainAgentId: peerAgent.agentId
    });
    session(f.store, f.core, {
      providerSessionId: "provider:peer-race-old", logicalSessionId: "session:peer-race-old",
      agentId: peerAgent.agentId, kind: "worker", workId: peerWork.id,
      taskId: peerTask.id, cwd: f.directory
    });
    const task = f.core.createTask({
      initiatorAgentId: sourceAgent.agentId, recipientAgentId: peerAgent.agentId,
      initiatorSessionId: "session:source-race", recipientSessionId: "session:peer-race-old",
      sourceWorkId: sourceWork.id, targetWorkId: peerWork.id,
      taskId: peerTask.id, routingIntent: "best_available",
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
    const sourceWork = f.workService.createWork({ name: "Source Repair", contributorAgentIds: [sourceAgent.agentId] });
    const peerWork = f.workService.createWork({ name: "MarketCow", contributorAgentIds: [peerAgent.agentId] });
    session(f.store, f.core, {
      providerSessionId: "provider:source-repair", logicalSessionId: "session:source-repair",
      agentId: sourceAgent.agentId, kind: "workChat", workId: sourceWork.id, cwd: f.directory
    });
    const productTask = f.workService.createTask({
      workId: peerWork.id,
      title: "获取 MarketCow 当前 exact 100-market scope",
      mainAgentId: peerAgent.agentId
    });
    session(f.store, f.core, {
      providerSessionId: "provider:missing-rollout", logicalSessionId: "session:missing-rollout",
      agentId: peerAgent.agentId, kind: "worker", workId: peerWork.id,
      taskId: productTask.id, cwd: f.directory
    });
    const task = f.core.createTask({
      initiatorAgentId: sourceAgent.agentId,
      recipientAgentId: peerAgent.agentId,
      initiatorSessionId: "session:source-repair",
      recipientSessionId: "session:missing-rollout",
      sourceWorkId: sourceWork.id,
      targetWorkId: peerWork.id,
      taskId: productTask.id,
      routingIntent: "create_dedicated_session",
      title: productTask.title,
      summary: "Return the exact active market scope."
    });

    session(f.store, f.core, {
      providerSessionId: "provider:replacement", logicalSessionId: "session:replacement",
      agentId: peerAgent.agentId, kind: "worker", workId: peerWork.id,
      taskId: productTask.id, cwd: f.directory
    });
    await assert.rejects(
      f.service.ensureTaskRecipientSession(task, { reason: "delivery_preflight" }),
      (error) => error.code === "RECIPIENT_SESSION_UNAVAILABLE"
        && error.statusCode === 409
        && /task_session_superseded/.test(error.message)
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

test("Worker creates an independent Task with Session provenance and retries idempotently", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:worker", name: "Worker", role: "independentContributor" });
    const work = f.workService.createWork({ name: "Scoped", contributorAgentIds: [agent.agentId] });
    const source = f.workService.createTask({ workId: work.id, title: "Source" });
    session(f.store, f.core, { providerSessionId: "provider:worker", logicalSessionId: "session:worker", agentId: agent.agentId, kind: "worker", workId: work.id, taskId: source.id, cwd: f.directory });
    const metadata = { sessionId: "provider:worker" };

    const created = f.service.createTask(metadata, agent.agentId, {
      title: "Independent", acceptanceCriteria: "Has evidence",
      idempotencyKey: "create:independent"
    });
    const replay = f.service.createTask(metadata, agent.agentId, {
      title: "Independent", acceptanceCriteria: "Has evidence",
      idempotencyKey: "create:independent"
    });
    assert.equal(replay.task.id, created.task.id);
    assert.equal(replay.idempotentReplay, true);
    assert.deepEqual(f.store.listTaskDependencies(created.task.id), []);
    assert.equal(created.task.parentTaskId, undefined);
    assert.equal(f.store.getTask(created.task.id).parent_task_id, null);
    assert.equal(f.store.getTask(created.task.id).source_task_id, null);
    const origin = f.store.getTaskCreationOrigin(created.task.id);
    assert.equal(origin.creatorSessionId, "session:worker");
    assert.equal(origin.creationContextTaskId, source.id);
    assert.throws(() => f.service.createTask(metadata, agent.agentId, {
      title: "Deprecated hierarchy", relationship: "depends_on", idempotencyKey: "create:deprecated"
    }), { code: "UNKNOWN_FIELD" });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Work Chat Task creation persists context and returns only after automatic startup", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({
      id: "agent:auto-start", name: "Auto Start", role: "independentContributor"
    });
    const work = f.workService.createWork({
      name: "Automatic Work Chat Task", contributorAgentIds: [agent.agentId]
    });
    session(f.store, f.core, {
      providerSessionId: "provider:auto-start-source",
      logicalSessionId: "session:auto-start-source",
      agentId: agent.agentId,
      kind: "workChat",
      workId: work.id,
      cwd: f.directory
    });
    let startupCount = 0;
    f.service.workSessionStartApplicationService.start = async (input) => {
      startupCount += 1;
      const task = f.store.getTask(input.taskId);
      session(f.store, f.core, {
        providerSessionId: "provider:auto-start-worker",
        logicalSessionId: "session:auto-start-worker",
        agentId: input.assigneeAgentId,
        kind: "worker",
        workId: work.id,
        taskId: task.id,
        cwd: f.directory
      });
      f.store.db.run(
        `UPDATE tasks SET current_session_id=?, lifecycle_state='in_progress',
         execution_status='running', resource_version=resource_version+1 WHERE id=?`,
        ["provider:auto-start-worker", task.id]
      );
      return { session: { id: "provider:auto-start-worker" } };
    };

    const result = await f.service.createAndStartTask(
      { sessionId: "provider:auto-start-source" },
      agent.agentId,
      {
        title: "Persist structured context",
        description: "Description belongs to Task context only",
        acceptanceCriteria: "Criterion belongs to Task context only",
        agentId: agent.agentId,
        providerId: "codex-app-server",
        idempotencyKey: "create:auto-start"
      }
    );

    const stored = f.store.getTask(result.task.id);
    assert.equal(result.phase, "started");
    assert.equal(result.executionStatus, "running");
    assert.equal(result.session.sessionId, "session:auto-start-worker");
    assert.equal(stored.lifecycle_state, "in_progress");
    assert.equal(stored.execution_status, "running");
    assert.equal(stored.description, "Description belongs to Task context only");
    assert.equal(stored.acceptance_criteria, "Criterion belongs to Task context only");
    assert.equal(startupCount, 1);

    const replay = await f.service.createAndStartTask(
      { sessionId: "provider:auto-start-source" },
      agent.agentId,
      {
        title: "Persist structured context",
        description: "Description belongs to Task context only",
        acceptanceCriteria: "Criterion belongs to Task context only",
        agentId: agent.agentId,
        providerId: "codex-app-server",
        idempotencyKey: "create:auto-start"
      }
    );
    assert.equal(replay.phase, "started");
    assert.equal(startupCount, 1);
    assert.equal(f.workService.listTasksByWork(work.id).length, 1);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Task creation validates, persists, and returns an existing Artifact reference", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:artifact-reference", name: "Artifact owner", role: "independentContributor" });
    const work = f.workService.createWork({ name: "Artifact Work", contributorAgentIds: [agent.agentId] });
    session(f.store, f.core, {
      providerSessionId: "provider:artifact-reference", logicalSessionId: "session:artifact-reference",
      agentId: agent.agentId, kind: "workChat", workId: work.id, cwd: f.directory
    });
    const artifact = await f.artifactService.create({
      actorId: agent.agentId, sessionId: "provider:artifact-reference", workId: work.id
    }, { title: "Implementation contract", content: "Use the shared contract." });

    const created = f.service.createTask({ sessionId: "provider:artifact-reference" }, agent.agentId, {
      title: "Referenced work", idempotencyKey: "create:with-artifact",
      artifactReference: {
        artifactId: artifact.artifactId, relation: "implementation_spec",
        required: true, versionPolicy: "fixed"
      }
    });
    assert.equal(created.task.references.artifacts.length, 1);
    assert.equal(created.task.references.artifacts[0].artifactId, artifact.artifactId);
    assert.equal(created.task.references.artifacts[0].pinnedVersion, 1);
    assert.equal(created.task.references.artifacts[0].required, true);
    assert.deepEqual(
      f.service.getTask({ sessionId: "provider:artifact-reference" }, agent.agentId, created.task.id).references,
      created.task.references
    );
    const replay = f.service.createTask({ sessionId: "provider:artifact-reference" }, agent.agentId, {
      title: "Referenced work", idempotencyKey: "create:with-artifact",
      artifactReference: {
        artifactId: artifact.artifactId, relation: "implementation_spec",
        required: true, versionPolicy: "fixed"
      }
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(f.store.listArtifactReferences({ taskId: created.task.id }).length, 1);

    const otherWork = f.workService.createWork({ name: "Other Work", contributorAgentIds: [agent.agentId] });
    const otherArtifact = await f.artifactService.create({ kind: "local_user", workId: otherWork.id }, {
      title: "Other secret", content: "not visible"
    });
    const before = f.store.listTasksByWork(work.id).length;
    assert.throws(() => f.service.createTask({ sessionId: "provider:artifact-reference" }, agent.agentId, {
      title: "Forbidden cross-work", idempotencyKey: "create:cross-work",
      artifactReference: { artifactId: otherArtifact.artifactId }
    }), { code: "ARTIFACT_CROSS_WORK_FORBIDDEN" });
    assert.equal(f.store.listTasksByWork(work.id).length, before);
    assert.throws(() => f.service.createTask({ sessionId: "provider:artifact-reference" }, agent.agentId, {
      title: "Missing Artifact", idempotencyKey: "create:missing-artifact",
      artifactReference: { artifactId: "artifact:missing" }
    }), { code: "ARTIFACT_NOT_FOUND" });

    const workerAgent = f.store.createAgent({ id: "agent:artifact-worker", name: "Artifact worker", role: "independentContributor" });
    f.workService.updateWork(work.id, {
      contributorAgentIds: [agent.agentId, workerAgent.agentId]
    });
    const source = f.workService.createTask({ workId: work.id, title: "Worker source" });
    session(f.store, f.core, {
      providerSessionId: "provider:artifact-worker", logicalSessionId: "session:artifact-worker",
      agentId: workerAgent.agentId, kind: "worker", workId: work.id,
      taskId: source.id, cwd: f.directory
    });
    f.store.db.run("UPDATE tasks SET current_session_id=? WHERE id=?", ["provider:artifact-worker", source.id]);
    const workerCreated = f.service.createTask({ sessionId: "provider:artifact-worker" }, workerAgent.agentId, {
      title: "Same-Work Artifact propagation",
      idempotencyKey: "create:same-work-artifact",
      artifactReference: { artifactId: artifact.artifactId }
    });
    assert.equal(workerCreated.task.references.artifacts[0].artifactId, artifact.artifactId);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Task creation validates Workspace file authority and returns durable file references", async () => {
  const f = await fixture();
  const outsideDirectory = await mkdtemp(join(tmpdir(), "corptie-file-reference-outside-"));
  try {
    const agent = f.store.createAgent({ id: "agent:file-reference", name: "File owner", role: "independentContributor" });
    const work = f.workService.createWork({ name: "File Work", contributorAgentIds: [agent.agentId] });
    session(f.store, f.core, {
      providerSessionId: "provider:file-reference", logicalSessionId: "session:file-reference",
      agentId: agent.agentId, kind: "workChat", workId: work.id, cwd: f.directory
    });
    const filePath = join(f.directory, "implementation-plan.md");
    await writeFile(filePath, "local plan", "utf8");
    const created = f.service.createTask({ sessionId: "provider:file-reference" }, agent.agentId, {
      title: "File-backed work", idempotencyKey: "create:with-file",
      fileReference: { path: filePath, relation: "test_plan", required: true }
    });
    assert.equal(created.task.references.files.length, 1);
    assert.equal(created.task.references.files[0].path, await realpath(filePath));
    assert.equal(created.task.references.files[0].relation, "test_plan");
    assert.equal(created.task.references.files[0].required, true);
    assert.equal(created.task.references.files[0].byteLength, 10);
    assert.equal(
      f.service.getTask({ sessionId: "provider:file-reference" }, agent.agentId, created.task.id)
        .references.files[0].referenceId,
      created.task.references.files[0].referenceId
    );

    const outsidePath = join(outsideDirectory, "outside.md");
    await writeFile(outsidePath, "outside", "utf8");
    assert.throws(() => f.service.createTask({ sessionId: "provider:file-reference" }, agent.agentId, {
      title: "Outside file", idempotencyKey: "create:outside-file", fileReference: { path: outsidePath }
    }), { code: "FILE_REFERENCE_FORBIDDEN" });
    assert.throws(() => f.service.createTask({ sessionId: "provider:file-reference" }, agent.agentId, {
      title: "Missing file", idempotencyKey: "create:missing-file",
      fileReference: { path: join(f.directory, "missing.md") }
    }), { code: "FILE_REFERENCE_NOT_FOUND" });
    assert.throws(() => f.service.createTask({ sessionId: "provider:file-reference" }, agent.agentId, {
      title: "Ambiguous reference", idempotencyKey: "create:ambiguous",
      artifactReference: { artifactId: "artifact:any" }, fileReference: { path: filePath }
    }), { code: "TASK_REFERENCE_CONFLICT" });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});

test("same-Work Work Sessions discover private Task Artifacts as read-only while explicit References remain fixed", async () => {
  const f = await fixture();
  try {
    const agentA = f.store.createAgent({ id: "agent:share-a", name: "Share A", role: "independentContributor" });
    const agentB = f.store.createAgent({ id: "agent:share-b", name: "Share B", role: "independentContributor" });
    const agentU = f.store.createAgent({ id: "agent:share-unrelated", name: "Unrelated", role: "independentContributor" });
    const work = f.workService.createWork({
      name: "Shared Artifacts", contributorAgentIds: [agentA.agentId, agentB.agentId, agentU.agentId]
    });
    const workA = f.workService.createTask({ workId: work.id, title: "Work A" });
    const workB = f.workService.createTask({ workId: work.id, title: "Work B" });
    const unrelated = f.workService.createTask({ workId: work.id, title: "Unrelated" });
    f.workService.addDependency(workB.id, workA.id, "depends_on");
    session(f.store, f.core, {
      providerSessionId: "provider:share-a", logicalSessionId: "session:share-a",
      agentId: agentA.agentId, kind: "worker", workId: work.id,
      taskId: workA.id, cwd: f.directory
    });
    session(f.store, f.core, {
      providerSessionId: "provider:share-b", logicalSessionId: "session:share-b",
      agentId: agentB.agentId, kind: "worker", workId: work.id,
      taskId: workB.id, cwd: f.directory
    });
    session(f.store, f.core, {
      providerSessionId: "provider:share-unrelated", logicalSessionId: "session:share-unrelated",
      agentId: agentU.agentId, kind: "worker", workId: work.id,
      taskId: unrelated.id, cwd: f.directory
    });
    f.store.db.run("UPDATE tasks SET current_session_id=? WHERE id=?", ["provider:share-a", workA.id]);
    f.store.db.run("UPDATE tasks SET current_session_id=? WHERE id=?", ["provider:share-b", workB.id]);
    f.store.db.run("UPDATE tasks SET current_session_id=? WHERE id=?", ["provider:share-unrelated", unrelated.id]);
    const contextA = { actorId: agentA.agentId, sessionId: "provider:share-a", workId: work.id, taskId: workA.id };
    const contextB = { actorId: agentB.agentId, sessionId: "provider:share-b", workId: work.id, taskId: workB.id };
    const contextU = { actorId: agentU.agentId, sessionId: "provider:share-unrelated", workId: work.id, taskId: unrelated.id };
    const artifactA = await f.artifactService.create(contextA, {
      title: "A contract", content: "read-only from A", idempotencyKey: "artifact:a"
    });
    assert.equal(f.store.listArtifactReferences({ artifactId: artifactA.artifactId, taskId: workB.id }).length, 0);
    await assert.rejects(
      () => readPinnedArtifact(f.artifactService, contextB, artifactA, artifactA.references[0]),
      { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" }
    );
    assert.equal(f.artifactService.list(contextB).find((artifact) => artifact.artifactId === artifactA.artifactId)?.access.write, false);
    assert.equal((await f.artifactService.search(contextB, "A contract")).results.length, 1);
    await assert.rejects(
      () => readPinnedArtifact(f.artifactService, contextU, artifactA, artifactA.references[0]),
      { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" }
    );
    const artifactAVersion = artifactA.versions[0];
    assert.equal((await f.artifactService.get(contextU, artifactA.artifactId, {
      version: artifactAVersion.version,
      contentHash: artifactAVersion.contentHash,
      turnExecutionId: `collaboration-artifact-turn:${++collaborationArtifactTurn}`
    })).content, "read-only from A");
    const sharedA = f.service.shareArtifact({ sessionId: "provider:share-a" }, agentA.agentId, {
      taskId: workB.id, artifactId: artifactA.artifactId,
      relation: "handoff", required: true, versionPolicy: "fixed"
    });
    assert.equal(sharedA.access, "read_only");
    assert.equal(sharedA.reference.taskId, workB.id);
    assert.equal(sharedA.reference.pinnedVersion, 1);
    assert.equal((await readPinnedArtifact(f.artifactService, contextB, artifactA, sharedA.reference)).content, "read-only from A");
    const replay = f.service.shareArtifact({ sessionId: "provider:share-a" }, agentA.agentId, {
      taskId: workB.id, artifactId: artifactA.artifactId,
      relation: "handoff", required: true, versionPolicy: "fixed"
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(f.store.listArtifactReferences({ artifactId: artifactA.artifactId, taskId: workB.id }).length, 1);
    await assert.rejects(() => f.artifactService.publishVersion(contextB, artifactA.artifactId, {
      content: "recipient mutation"
    }), { code: "ARTIFACT_PRIVATE_PUBLISH_FORBIDDEN" });
    assert.throws(() => f.service.shareArtifact({ sessionId: "provider:share-b" }, agentB.agentId, {
      taskId: workA.id, artifactId: artifactA.artifactId
    }), { code: "ARTIFACT_RESHARE_FORBIDDEN" });
    assert.throws(() => f.service.shareArtifact({ sessionId: "provider:share-a" }, agentA.agentId, {
      taskId: unrelated.id, artifactId: artifactA.artifactId
    }), { code: "TASK_OUTSIDE_SCOPE" });

    const artifactB = await f.artifactService.create(contextB, {
      title: "B evidence", content: "read-only from B", idempotencyKey: "artifact:b"
    });
    await assert.rejects(
      () => readPinnedArtifact(f.artifactService, contextA, artifactB, artifactB.references[0]),
      { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" }
    );
    f.store.removeTaskDependency(workB.id, workA.id);
    assert.equal((await readPinnedArtifact(f.artifactService, contextB, artifactB, artifactB.references[0])).content, "read-only from B");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Assistant Chat without an Work cannot create and Tasks reject non-lifecycle statuses", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:assistant-chat", name: "Chat Agent", role: "independentContributor" });
    session(f.store, f.core, { providerSessionId: "provider:chat", logicalSessionId: "session:chat", agentId: agent.agentId, kind: "assistantChat", cwd: f.directory });
    assert.throws(() => f.service.createTask({ sessionId: "provider:chat" }, agent.agentId, {
      title: "Forbidden", idempotencyKey: "create:forbidden"
    }), { code: "COLLABORATION_CREATE_FORBIDDEN" });

    const work = f.workService.createWork({ name: "Work", contributorAgentIds: [agent.agentId] });
    const source = f.workService.createTask({ workId: work.id, title: "Source" });
    session(f.store, f.core, { providerSessionId: "provider:work", logicalSessionId: "session:work", agentId: agent.agentId, kind: "workChat", workId: work.id, cwd: f.directory });
    assert.throws(() => f.workService.createTask({
      workId: work.id, title: "Invalid canceled create", lifecycleState: "canceled"
    }), { code: "INVALID_LIFECYCLE_STATE" });
    assert.throws(() => f.store.updateTask(source.id, { lifecycleState: "blocked" }), { code: "INVALID_LIFECYCLE_STATE" });
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("collaboration start delegates shared orchestration receipts and retries without creating another Task", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:starter", name: "Starter", role: "independentContributor" });
    const work = f.workService.createWork({ name: "Start", contributorAgentIds: [agent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:work-start", logicalSessionId: "session:work-start", agentId: agent.agentId, kind: "workChat", workId: work.id, cwd: f.directory });
    const metadata = { sessionId: "provider:work-start" };
    const created = f.service.createTask(metadata, agent.agentId, {
      title: "Retryable launch", agentId: agent.agentId, idempotencyKey: "create:retryable"
    });

    f.service.workSessionStartApplicationService.start = async () => {
      f.store.db.run(
        `UPDATE tasks SET execution_status='start_failed' WHERE id=?`,
        [created.task.id]
      );
      throw Object.assign(new Error("provider unavailable"), {
        code: "PROVIDER_UNAVAILABLE",
        receipt: {
          phase: "failed", taskId: created.task.id, executionStatus: "start_failed",
          failureStage: "creatingSession", errorCode: "PROVIDER_UNAVAILABLE"
        }
      });
    };
    await assert.rejects(
      f.service.startTask(metadata, agent.agentId, {
        taskId: created.task.id, assigneeAgentId: agent.agentId, providerId: "codex-app-server",
        expectedTaskVersion: 1, idempotencyKey: "start:one", sourceSessionId: "session:work-start"
      }),
      (error) => error.code === "PROVIDER_UNAVAILABLE"
        && error.receipt?.taskId === created.task.id
        && error.receipt?.executionStatus === "start_failed"
        && error.receipt?.failureStage === "creatingSession"
    );
    assert.equal(f.store.getTask(created.task.id).execution_status, "start_failed");
    assert.equal(f.workService.listTasksByWork(work.id).filter((item) => item.title === "Retryable launch").length, 1);

    f.service.workSessionStartApplicationService.start = async () => {
      session(f.store, f.core, {
        providerSessionId: "provider:launched", logicalSessionId: "session:launched",
        agentId: agent.agentId, kind: "worker", workId: work.id,
        taskId: created.task.id, cwd: f.directory
      });
      f.store.db.run(
        "UPDATE tasks SET current_session_id=?, execution_status='running', lifecycle_state='in_progress' WHERE id=?",
        ["provider:launched", created.task.id]
      );
      return { session: { id: "provider:launched" } };
    };
    const started = await f.service.startTask(metadata, agent.agentId, {
      taskId: created.task.id, assigneeAgentId: agent.agentId, providerId: "codex-app-server",
      expectedTaskVersion: 1, idempotencyKey: "start:one", sourceSessionId: "session:work-start"
    });
    assert.equal(started.executionStatus, "running");
    assert.equal(started.session.sessionId, "session:launched");
    assert.equal(started.providerBinding.providerId, "codex-app-server");
    assert.equal(started.task.id, created.task.id);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
