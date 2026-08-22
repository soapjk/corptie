import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { SessionCollaborationService } from "../src/application/sessionCollaborationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-collaboration-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const core = new CollaborationCore(store);
  const objectiveService = new ObjectiveApplicationService({ store });
  const launches = [];
  const service = new SessionCollaborationService({
    store, objectiveService, collaborationCore: core,
    startWorkItem: async (input) => { launches.push(input); return { id: "worker:launched" }; }
  });
  return { directory, store, core, objectiveService, service, launches };
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
    assert.equal(canceled.physicallyDeleted, false);
    assert.ok(f.store.getWorkItem(created.workItem.id));
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("start is concurrency-safe, exposes partial failure, and retries without creating another WorkItem", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:starter", name: "Starter", role: "independentContributor" });
    const objective = f.objectiveService.createObjective({ name: "Start", contributorAgentIds: [agent.agentId] });
    session(f.store, f.core, { providerSessionId: "provider:objective-start", logicalSessionId: "session:objective-start", agentId: agent.agentId, kind: "objectiveChat", objectiveId: objective.id, cwd: f.directory });
    const metadata = { sessionId: "provider:objective-start" };
    const created = f.service.createWorkItem(metadata, agent.agentId, {
      title: "Retryable launch", agentId: agent.agentId, idempotencyKey: "create:retryable"
    });

    f.service.launchWorkItem = async () => { throw Object.assign(new Error("provider unavailable"), { code: "PROVIDER_UNAVAILABLE" }); };
    await assert.rejects(
      f.service.startWorkItem(metadata, agent.agentId, {
        workItemId: created.workItem.id, resourceVersion: "1", idempotencyKey: "start:one"
      }),
      (error) => error.code === "PROVIDER_UNAVAILABLE"
        && error.receipt?.workItemId === created.workItem.id
        && error.receipt?.executionStatus === "start_failed"
    );
    assert.equal(f.store.getWorkItem(created.workItem.id).execution_status, "start_failed");
    assert.equal(f.objectiveService.listWorkItemsByObjective(objective.id).filter((item) => item.title === "Retryable launch").length, 1);

    let releaseLaunch;
    f.service.launchWorkItem = () => new Promise((resolve) => { releaseLaunch = resolve; });
    const firstStart = f.service.startWorkItem(metadata, agent.agentId, {
      workItemId: created.workItem.id, resourceVersion: "1", idempotencyKey: "start:one"
    });
    const inProgress = await f.service.startWorkItem(metadata, agent.agentId, {
      workItemId: created.workItem.id, resourceVersion: "1", idempotencyKey: "start:one"
    });
    assert.equal(inProgress.executionStatus, "starting");
    assert.equal(inProgress.idempotentReplay, true);

    session(f.store, f.core, { providerSessionId: "provider:launched", logicalSessionId: "session:launched", agentId: agent.agentId, kind: "worker", objectiveId: objective.id, workItemId: created.workItem.id, cwd: f.directory });
    f.store.db.run("UPDATE work_items SET current_session_id=? WHERE id=?", ["provider:launched", created.workItem.id]);
    releaseLaunch({ id: "provider:launched" });
    const started = await firstStart;
    assert.equal(started.executionStatus, "running");
    assert.equal(started.session.sessionId, "session:launched");
    assert.equal(started.providerBinding.providerId, "codex-app-server");
    assert.equal(started.workItem.id, created.workItem.id);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
