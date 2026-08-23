import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function createFixture() {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-collaboration-test-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  await store.initialize();
  let sequence = 0;
  const core = new CollaborationCore(store, {
    idFactory: () => `generated-${++sequence}`,
    clock: () => `2026-07-17T00:00:${String(sequence).padStart(2, "0")}.000Z`
  });
  return { directory, dbPath, store, core };
}

function seedAgentsAndService(core) {
  core.registerAgent({
    agentId: "research-agent",
    name: "Research Agent",
    capabilities: ["research", "research"]
  });
  core.registerAgent({
    agentId: "journal-agent",
    name: "Journal Agent",
    capabilities: ["investment-journal"]
  });
  core.registerService({
    serviceId: "investment-journal",
    name: "Investment Journal",
    ownerAgentId: "journal-agent",
    currentVersion: "1.3.0",
    status: "running",
    endpoint: "local://investment-journal"
  });
}

function newTask(core, overrides = {}) {
  return core.createTask({
    initiatorAgentId: "research-agent",
    recipientAgentId: "journal-agent",
    serviceId: "investment-journal",
    type: "change_request",
    title: "Completion notification is stale",
    summary: "The notification remains in processing state.",
    acceptanceCriteria: ["Completed sessions show completed", "Do not complete early"],
    evidence: [{ type: "log", uri: "local-artifact://session.log" }],
    ...overrides
  });
}

async function withFixture(run) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    if (fixture.store.saveTimer) clearTimeout(fixture.store.saveTimer);
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

test("Phase 1 migration creates every collaboration table", async () => {
  await withFixture(async ({ store }) => {
    const names = store.selectAll(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).map((row) => row.name);
    for (const table of [
      "agents",
      "agent_sessions",
      "session_name_aliases",
      "services",
      "service_consumers",
      "collaboration_contexts",
      "collaboration_tasks",
      "collaboration_request_confirmations",
      "collaboration_participants",
      "collaboration_messages",
      "collaboration_artifacts",
      "collaboration_deliveries",
      "collaboration_channels",
      "collaboration_events",
      "agent_work_items"
    ]) {
      assert.ok(names.includes(table), `missing ${table}`);
    }
    assert.ok(store.selectOne(
      "SELECT migration_id FROM data_migrations WHERE migration_id='collaboration-session-channels-v1'"
    ));
  });
});

test("legacy collaboration with multiple candidate Sessions remains explicitly unresolved", async () => {
  await withFixture(async ({ core, store, directory }) => {
    seedAgentsAndService(core);
    const task = newTask(core);
    for (const suffix of ["one", "two"]) {
      store.createSession({
        id: `provider:journal:${suffix}`,
        title: suffix,
        agentId: "journal-agent",
        sessionKind: "worker"
      });
      store.createLogicalSessionRoute({
        logicalSessionId: `session:journal:${suffix}`,
        legacySessionId: `provider:journal:${suffix}`,
        providerThreadId: `thread:journal:${suffix}`,
        providerSessionId: `provider:journal:${suffix}`,
        providerId: "codex-app-server",
        boundCwd: directory,
        sessionName: `journal ${suffix}`
      });
      core.bindSession({ agentId: "journal-agent", sessionId: `provider:journal:${suffix}` });
    }
    store.db.run(
      "UPDATE collaboration_tasks SET recipient_session_id=NULL, route_status='active' WHERE task_id=?",
      [task.taskId]
    );
    store.migrateCollaborationSessionIdentities();
    const migrated = core.getTask(task.taskId);
    assert.equal(migrated.recipientSessionId, null);
    assert.equal(migrated.routeStatus, "unresolved");
  });
});

test("a staged request creates no task until deterministic user confirmation", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    core.bindSession({ agentId: "research-agent", sessionId: "codex:research" });
    const confirmation = core.proposeTask({
      initiatorAgentId: "research-agent",
      recipientAgentId: "journal-agent",
      sourceTurnId: "turn-1",
      serviceId: "investment-journal",
      type: "change_request",
      title: "Fix stale status",
      summary: "Completion still shows processing.",
      acceptanceCriteria: ["Show completed after the run finishes"]
    });

    assert.equal(confirmation.status, "pending");
    assert.equal(confirmation.recipientAgentName, "Journal Agent");
    assert.equal(confirmation.sourceSessionId, "codex:research");
    assert.equal(confirmation.sourceTurnId, "turn-1");
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_deliveries").length, 0);

    const resolved = core.confirmTaskConfirmation(confirmation.confirmationId);
    assert.equal(resolved.status, "confirmed");
    assert.ok(resolved.taskId);
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 1);
    assert.equal(store.selectAll("SELECT * FROM collaboration_deliveries").length, 1);
    assert.equal(core.confirmTaskConfirmation(confirmation.confirmationId).taskId, resolved.taskId);
  });
});

test("Session names resolve to stable Session ids and collaboration snapshots survive rename", async () => {
  await withFixture(async ({ core, store, directory }) => {
    for (const [legacyId, logicalId, name, agentId] of [
      ["codex:sender-thread", "logical:sender", "sender_agent", "sender-agent"],
      ["claude:recipient-thread", "logical:recipient", "recipient_agent", "recipient-agent"]
    ]) {
      store.upsertSession({
        id: legacyId,
        title: name,
        agent: "Agent",
        provider: legacyId.startsWith("claude:") ? "claude-sdk" : "codex-app-server",
        cwd: directory,
        status: "complete"
      });
      store.createLogicalSessionRoute({
        logicalSessionId: logicalId,
        legacySessionId: legacyId,
        providerThreadId: legacyId.split(":")[1],
        providerId: legacyId.startsWith("claude:") ? "claude-sdk" : "codex-app-server",
        boundCwd: directory,
        title: name
      });
      core.registerAgent({ agentId, name });
      core.bindSession({ agentId, sessionId: legacyId });
    }

    const recipient = core.resolveAgentBySessionName("recipient_agent");
    assert.equal(recipient.agentId, "recipient-agent");
    assert.equal(recipient.sessionId, "logical:recipient");

    const confirmation = core.proposeTask({
      initiatorAgentId: "sender-agent",
      recipientAgentId: recipient.agentId,
      type: "question",
      title: "Confirm stable routing",
      summary: "Which Session receives this task?"
    });
    assert.equal(confirmation.initiatorSessionId, "logical:sender");
    assert.equal(confirmation.recipientSessionId, "logical:recipient");
    assert.equal(confirmation.recipientAgentName, "recipient_agent");

    store.renameSession("claude:recipient-thread", "recipient_agent_v2");
    const resolved = core.confirmTaskConfirmation(confirmation.confirmationId);
    const task = core.getTask(resolved.taskId);
    assert.equal(task.initiatorSessionId, "logical:sender");
    assert.equal(task.recipientSessionId, "logical:recipient");
    assert.equal(task.recipientNameAtSend, "recipient_agent");

    assert.equal(core.resolveAgentBySessionName("recipient_agent").sessionId, "logical:recipient");
    assert.equal(core.getTask(resolved.taskId).recipientNameAtSend, "recipient_agent");
  });
});

test("confirmation snapshots keep registry Agent identity separate from exact Session and Objective context", async () => {
  await withFixture(async ({ core, store, directory }) => {
    const sourceAgent = store.createAgent({ id: "agent:shared", name: "Stable MarketCow Agent", role: "independentContributor" });
    store.createAgent({ id: "agent:other", name: "Other Agent", role: "independentContributor" });
    const sourceObjective = store.createObjective({ id: "objective:source", name: "MarketCow", contributorAgentIds: [sourceAgent.agentId] });
    const targetObjective = store.createObjective({ id: "objective:target", name: "PolyMarket 实时套利", contributorAgentIds: [sourceAgent.agentId] });
    const sourceWorkItem = store.createWorkItem({ objectiveId: sourceObjective.id, title: "Snapshot repair", mainAgentId: sourceAgent.agentId });
    const targetWorkItem = store.createWorkItem({ objectiveId: targetObjective.id, title: "One-hour shadow", mainAgentId: sourceAgent.agentId });
    for (const route of [
      { provider: "provider:source", logical: "logical:source", title: "修复 PolyMarket snapshot/bootstrap", objectiveId: sourceObjective.id, workItemId: sourceWorkItem.id },
      { provider: "provider:target", logical: "logical:target", title: "金融工具开发专家_Session", objectiveId: targetObjective.id, workItemId: targetWorkItem.id }
    ]) {
      store.createSession({
        id: route.provider, title: route.title, agentId: sourceAgent.agentId,
        sessionKind: "worker", objectiveId: route.objectiveId, workItemId: route.workItemId
      });
      store.createLogicalSessionRoute({
        logicalSessionId: route.logical, legacySessionId: route.provider,
        providerThreadId: `thread:${route.provider}`, providerSessionId: route.provider,
        providerId: "codex-app-server", boundCwd: directory, sessionName: route.title
      });
      core.bindSession({ agentId: sourceAgent.agentId, sessionId: route.provider });
    }

    assert.equal(core.getAgentForSession("logical:source").name, "Stable MarketCow Agent");
    assert.equal(core.getAgentForSession("logical:source").sessionName, "修复 PolyMarket snapshot/bootstrap");
    const confirmation = core.proposeTask({
      initiatorAgentId: sourceAgent.agentId,
      recipientAgentId: sourceAgent.agentId,
      initiatorSessionId: "logical:source",
      recipientSessionId: "logical:target",
      sourceObjectiveId: sourceObjective.id,
      targetObjectiveId: targetObjective.id,
      sourceWorkItemId: sourceWorkItem.id,
      workItemId: targetWorkItem.id,
      title: "Run shadow",
      summary: "Use the target Objective context."
    });

    assert.equal(confirmation.initiatorAgentName, "Stable MarketCow Agent");
    assert.equal(confirmation.recipientAgentName, "Stable MarketCow Agent");
    assert.equal(confirmation.initiatorSessionTitle, "修复 PolyMarket snapshot/bootstrap");
    assert.equal(confirmation.recipientSessionTitle, "金融工具开发专家_Session");
    assert.equal(confirmation.sourceObjectiveName, "MarketCow");
    assert.equal(confirmation.targetObjectiveName, "PolyMarket 实时套利");
    assert.equal(confirmation.initiatorWorkItemId, sourceWorkItem.id);
    assert.equal(confirmation.recipientWorkItemId, targetWorkItem.id);

    assert.throws(() => core.proposeTask({
      initiatorAgentId: sourceAgent.agentId,
      recipientAgentId: "agent:other",
      initiatorSessionId: "logical:source",
      recipientSessionId: "logical:target",
      title: "Spoof target",
      summary: "Must fail before staging."
    }), { code: "RECIPIENT_SESSION_AGENT_MISMATCH" });
  });
});

test("rejecting a staged request never creates a task or delivery", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    const confirmation = core.proposeTask({
      initiatorAgentId: "research-agent",
      recipientAgentId: "journal-agent",
      type: "question",
      title: "Ask status",
      summary: "Reply with current status."
    });
    const rejected = core.rejectTaskConfirmation(confirmation.confirmationId);
    assert.equal(rejected.status, "rejected");
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_deliveries").length, 0);
  });
});

test("an Agent can own multiple active Sessions while each Session has one current owner", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    core.bindSession({ agentId: "research-agent", sessionId: "codex:old-thread" });
    core.bindSession({ agentId: "research-agent", sessionId: "codex:new-thread" });

    assert.equal(core.getAgent("research-agent").currentSessionId, "codex:new-thread");
    const bindings = store.selectAll(
      "SELECT session_id, unbound_at FROM agent_sessions WHERE agent_id = ? ORDER BY bound_at ASC, session_id ASC",
      ["research-agent"]
    );
    assert.equal(bindings.length, 2);
    assert.equal(bindings.find((row) => row.session_id === "codex:old-thread").unbound_at, null);
    assert.equal(bindings.find((row) => row.session_id === "codex:new-thread").unbound_at, null);

    assert.throws(
      () => core.bindSession({ agentId: "journal-agent", sessionId: "codex:new-thread" }),
      (error) => error.code === "SESSION_ALREADY_BOUND"
    );
  });
});

test("re-observing existing Agent Session bindings is revision-idempotent", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    core.bindSession({ agentId: "research-agent", sessionId: "codex:old-thread" });
    core.bindSession({ agentId: "research-agent", sessionId: "codex:new-thread" });
    const revision = store.stateRevision();

    core.bindSession({ agentId: "research-agent", sessionId: "codex:old-thread" });
    core.bindSession({ agentId: "research-agent", sessionId: "codex:new-thread" });

    assert.equal(store.stateRevision(), revision);
    assert.equal(core.getAgent("research-agent").currentSessionId, "codex:new-thread");
  });
});

test("detaching one Session keeps the Agent attached to its other active Session", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    for (const id of ["codex:first-thread", "codex:second-thread"]) {
      store.upsertSession({ id, title: id, agent: "Codex", provider: "codex-app-server", status: "complete" });
      core.bindSession({ agentId: "research-agent", sessionId: id });
    }

    const agent = core.detachSession("codex:second-thread");

    assert.equal(agent.currentSessionId, "codex:first-thread");
    assert.notEqual(agent.status, "inactive");
    const activeBindings = store.selectAll(
      "SELECT session_id FROM agent_sessions WHERE agent_id = ? AND unbound_at IS NULL ORDER BY session_id",
      ["research-agent"]
    );
    assert.deepEqual(activeBindings.map((row) => row.session_id), ["codex:first-thread"]);
    assert.deepEqual(
      store.listSessionsByAgent("research-agent").map((session) => session.id).sort(),
      ["codex:first-thread", "codex:second-thread"]
    );
  });
});

test("deleting a Session detaches it without changing Agent lifecycle status", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    store.upsertSession({
      id: "codex:temporary-thread",
      title: "Research Agent",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    core.bindSession({ agentId: "research-agent", sessionId: "codex:temporary-thread" });
    const task = newTask(core);

    const detached = core.detachSession("codex:temporary-thread");
    store.deleteSession("codex:temporary-thread");

    assert.equal(detached.status, "available");
    assert.equal(detached.currentSessionId, null);
    assert.equal(core.getTask(task.taskId).initiatorAgentId, "research-agent");
    const binding = store.selectOne(
      "SELECT unbound_at FROM agent_sessions WHERE agent_id = ? AND session_id = ?",
      ["research-agent", "codex:temporary-thread"]
    );
    assert.ok(binding.unbound_at);
  });
});

test("startup reconciliation detaches missing Sessions without deactivating Agents", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    core.bindSession({ agentId: "research-agent", sessionId: "codex:missing-thread" });

    const detached = core.detachMissingSessionBindings();

    assert.deepEqual(detached.map((agent) => agent.agentId), ["research-agent"]);
    assert.equal(core.getAgent("research-agent").status, "available");
    assert.equal(core.getAgent("research-agent").currentSessionId, null);
    assert.ok(store.selectOne(
      "SELECT unbound_at FROM agent_sessions WHERE agent_id = ? AND session_id = ?",
      ["research-agent", "codex:missing-thread"]
    ).unbound_at);
    assert.deepEqual(core.detachMissingSessionBindings(), []);
  });
});

test("service requests must target the owner and ownership cannot be silently transferred", async () => {
  await withFixture(async ({ core }) => {
    seedAgentsAndService(core);
    assert.throws(
      () => core.registerService({
        serviceId: "investment-journal",
        name: "Investment Journal",
        ownerAgentId: "research-agent"
      }),
      (error) => error.code === "SERVICE_OWNER_MISMATCH"
    );
    assert.throws(
      () => core.createTask({
        initiatorAgentId: "journal-agent",
        recipientAgentId: "research-agent",
        serviceId: "investment-journal",
        title: "Wrong owner",
        summary: "This must be rejected."
      }),
      (error) => error.code === "RECIPIENT_NOT_SERVICE_OWNER"
    );
    assert.throws(
      () => core.updateService("investment-journal", "research-agent", { currentVersion: "9.9.9" }),
      (error) => error.code === "SERVICE_OWNER_REQUIRED"
    );
    assert.equal(
      core.updateService("investment-journal", "journal-agent", { currentVersion: "1.3.1" }).currentVersion,
      "1.3.1"
    );
  });
});

test("task creation is idempotent and atomically creates message, delivery, participants and event", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    const first = newTask(core, { idempotencyKey: "request-42" });
    const second = newTask(core, { idempotencyKey: "request-42" });

    assert.equal(second.taskId, first.taskId);
    assert.equal(first.status, "proposed");
    assert.deepEqual(first.acceptanceCriteria, ["Completed sessions show completed", "Do not complete early"]);
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].messageType, "change_request");
    assert.equal(first.events.length, 1);
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM collaboration_deliveries").count, 1);
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM collaboration_participants").count, 2);

    const [delivery] = core.listPendingDeliveries();
    const delivered = core.updateDelivery(delivery.deliveryId, {
      status: "delivered",
      incrementAttempt: true,
      targetTurnId: "turn-1"
    });
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.attemptCount, 1);
    assert.equal(delivered.targetTurnId, "turn-1");
  });
});

test("Objective-to-Objective collaboration creates and drives the target WorkItem", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    store.createObjective({
      id: "objective:research",
      name: "Research",
      contributorAgentIds: ["research-agent"]
    });
    store.createObjective({
      id: "objective:journal",
      name: "Journal",
      contributorAgentIds: ["journal-agent"]
    });
    store.createWorkItem({
      id: "work_item:research-origin",
      objectiveId: "objective:research",
      title: "Find stale notification cause",
      mainAgentId: "research-agent"
    });

    let task = core.createTask({
      initiatorAgentId: "research-agent",
      recipientAgentId: "journal-agent",
      sourceObjectiveId: "objective:research",
      targetObjectiveId: "objective:journal",
      sourceWorkItemId: "work_item:research-origin",
      type: "change_request",
      title: "Fix stale completion state",
      summary: "Update the journal completion projection.",
      acceptanceCriteria: ["Completed runs render completed"]
    });

    assert.equal(task.protocolVersion, "2.0");
    assert.equal(task.sourceObjectiveId, "objective:research");
    assert.equal(task.targetObjectiveId, "objective:journal");
    assert.equal(task.sourceWorkItemId, "work_item:research-origin");
    assert.equal(task.workItemId, `work_item:collaboration:${task.taskId}`);
    assert.equal(store.getWorkItem(task.workItemId).status, "todo");
    assert.equal(store.getWorkItem(task.workItemId).main_agent_id, "journal-agent");
    assert.equal(task.messages[0].envelope.objective.sourceId, "objective:research");
    assert.equal(task.messages[0].envelope.error, null);

    task = core.accept(task.taskId, "journal-agent");
    task = core.startWorking(task.taskId, "journal-agent");
    assert.equal(store.getWorkItem(task.workItemId).execution_status, "running");
    task = core.submitResult(task.taskId, "journal-agent", {
      body: "Projection fixed.",
      artifact: { type: "patch", name: "projection patch", uri: "local-artifact://projection.patch" }
    });
    assert.equal(store.getWorkItem(task.workItemId).execution_status, "awaiting_acceptance");
    assert.equal(task.messages.at(-1).envelope.objective.sourceId, "objective:journal");
    assert.equal(task.messages.at(-1).envelope.objective.targetId, "objective:research");
    task = core.beginVerification(task.taskId, "research-agent");
    task = core.complete(task.taskId, "research-agent", "Verified.");
    assert.equal(store.getWorkItem(task.workItemId).status, "done");
    assert.equal(JSON.parse(store.getWorkItem(task.workItemId).acceptance_assessment_json).collaborationTaskId, task.taskId);
  });
});

test("task input rejects unknown fields and mismatched Objective or WorkItem references", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    store.createObjective({ id: "objective:a", name: "A", contributorAgentIds: ["research-agent"] });
    store.createObjective({ id: "objective:b", name: "B", contributorAgentIds: ["journal-agent"] });
    store.createWorkItem({ id: "work_item:a", objectiveId: "objective:a", title: "A", mainAgentId: "research-agent" });
    assert.throws(
      () => core.createTask({
        initiatorAgentId: "research-agent", recipientAgentId: "journal-agent",
        title: "Unknown", summary: "Unknown", unexpected: true
      }),
      (error) => error.code === "UNKNOWN_FIELD"
    );
    assert.throws(
      () => core.createTask({
        initiatorAgentId: "research-agent", recipientAgentId: "journal-agent",
        sourceObjectiveId: "objective:a", targetObjectiveId: "objective:b",
        workItemId: "work_item:a", title: "Mismatch", summary: "Mismatch"
      }),
      (error) => error.code === "WORK_ITEM_OBJECTIVE_MISMATCH"
    );
  });
});

test("legacy point-to-point tasks migrate to compatibility Objectives and a target WorkItem", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    store.db.run("DELETE FROM data_migrations WHERE migration_id = 'collaboration-objective-work-item-v2'");
    store.db.run(
      "INSERT INTO collaboration_contexts (context_id, title, metadata_json, created_at, updated_at) VALUES ('legacy-context', 'Legacy', '{}', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')"
    );
    store.db.run(
      `INSERT INTO collaboration_tasks (
         task_id, context_id, protocol_version, initiator_agent_id, recipient_agent_id,
         type, status, iteration, max_iterations, title, summary, acceptance_criteria_json,
         created_at, updated_at
       ) VALUES ('legacy-task', 'legacy-context', '1.0', 'research-agent', 'journal-agent',
         'change_request', 'working', 1, 3, 'Legacy task', 'Migrate me', '["Migrated"]',
         '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`
    );
    store.db.run(
      `INSERT INTO collaboration_messages (
         message_id, task_id, protocol_version, sender_agent_id, recipient_agent_id,
         message_type, body, evidence_json, created_at
       ) VALUES ('legacy-message', 'legacy-task', '1.0', 'research-agent', 'journal-agent',
         'change_request', 'Migrate me', '[]', '2026-08-19T00:00:00.000Z')`
    );

    const migratedCore = new CollaborationCore(store);
    const task = migratedCore.getTask("legacy-task");
    assert.equal(task.protocolVersion, "2.0");
    assert.match(task.sourceObjectiveId, /^objective:collaboration:/);
    assert.match(task.targetObjectiveId, /^objective:collaboration:/);
    assert.equal(task.workItemId, "work_item:collaboration:legacy-task");
    assert.equal(store.getWorkItem(task.workItemId).status, "in_progress");
    assert.equal(task.messages[0].envelope.version, "2.0");
  });
});

test("deferred collaboration migration runs after the Store becomes ready", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-collaboration-deferred-test-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  const core = new CollaborationCore(store);
  try {
    await store.initialize();
    core.registerAgent({ agentId: "research-agent", name: "Research Agent" });
    core.registerAgent({ agentId: "journal-agent", name: "Journal Agent" });
    store.db.run(
      "INSERT INTO collaboration_contexts (context_id, title, metadata_json, created_at, updated_at) VALUES ('deferred-context', 'Deferred', '{}', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')"
    );
    store.db.run(
      `INSERT INTO collaboration_tasks (
         task_id, context_id, protocol_version, initiator_agent_id, recipient_agent_id,
         type, status, iteration, max_iterations, title, summary, acceptance_criteria_json,
         created_at, updated_at
       ) VALUES ('deferred-task', 'deferred-context', '1.0', 'research-agent', 'journal-agent',
         'change_request', 'working', 1, 3, 'Deferred task', 'Migrate after initialize', '[]',
         '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`
    );
    store.db.run(
      `INSERT INTO collaboration_messages (
         message_id, task_id, protocol_version, sender_agent_id, recipient_agent_id,
         message_type, body, evidence_json, created_at
       ) VALUES ('deferred-message', 'deferred-task', '1.0', 'research-agent', 'journal-agent',
         'change_request', 'Migrate after initialize', '[]', '2026-08-19T00:00:00.000Z')`
    );

    const result = core.initialize();
    assert.deepEqual(result, {
      status: "applied",
      migrationId: "collaboration-objective-work-item-v2",
      migratedTaskCount: 1
    });
    const task = core.getTask("deferred-task");
    assert.equal(task.protocolVersion, "2.0");
    assert.match(task.sourceObjectiveId, /^objective:collaboration:/);
    assert.match(task.targetObjectiveId, /^objective:collaboration:/);
    assert.equal(task.messages[0].envelope.sender.objectiveId, task.sourceObjectiveId);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy collaboration migration preserves platform Assistant boundaries without assigning it", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-collaboration-assistant-migration-test-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  const core = new CollaborationCore(store);
  try {
    await store.initialize();
    core.registerAgent({ agentId: "research-agent", name: "Research Agent" });
    store.db.run(
      `INSERT INTO agents (
         agent_id, agent_kind, name, description, role, status, capabilities_json,
         system_prompt, current_session_id, created_at, updated_at
       ) VALUES ('platform-assistant', 'platformAssistant', 'Corptie Assistant', '', 'assistant',
         'available', '[]', '', NULL, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`
    );
    store.db.run(
      "INSERT INTO collaboration_contexts (context_id, title, metadata_json, created_at, updated_at) VALUES ('assistant-context', 'Assistant', '{}', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')"
    );
    store.db.run(
      `INSERT INTO collaboration_tasks (
         task_id, context_id, protocol_version, initiator_agent_id, recipient_agent_id,
         type, status, iteration, max_iterations, title, summary, acceptance_criteria_json,
         created_at, updated_at
       ) VALUES ('assistant-task', 'assistant-context', '1.0', 'research-agent', 'platform-assistant',
         'question', 'working', 1, 3, 'Legacy assistant task', 'Migrate safely', '[]',
         '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`
    );
    store.db.run(
      `INSERT INTO collaboration_messages (
         message_id, task_id, protocol_version, sender_agent_id, recipient_agent_id,
         message_type, body, evidence_json, created_at
       ) VALUES ('assistant-message', 'assistant-task', '1.0', 'research-agent', 'platform-assistant',
         'question', 'Migrate safely', '[]', '2026-08-19T00:00:00.000Z')`
    );

    const result = core.initialize();
    assert.equal(result.status, "applied");
    const task = core.getTask("assistant-task");
    const compatibilityObjective = store.getObjective(task.targetObjectiveId);
    const workItem = store.getWorkItem(task.workItemId);
    assert.equal(task.protocolVersion, "2.0");
    assert.deepEqual(compatibilityObjective.contributorAgentIds, []);
    assert.equal(workItem.main_agent_id, null);
    assert.equal(task.messages[0].envelope.recipient.objectiveId, task.targetObjectiveId);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("clarification and delivery follow role-based state transitions", async () => {
  await withFixture(async ({ core }) => {
    seedAgentsAndService(core);
    let task = newTask(core);
    task = core.askForInformation(task.taskId, "journal-agent", "Please attach a trace.");
    assert.equal(task.status, "needs_information");
    assert.equal(task.messages.at(-1).messageType, "needs_information");
    task = core.replyWithInformation(task.taskId, "research-agent", "Trace attached.", {
      evidence: [{ type: "log", uri: "local-artifact://trace.txt" }]
    });
    assert.equal(task.status, "proposed");
    task = core.accept(task.taskId, "journal-agent");
    task = core.startWorking(task.taskId, "journal-agent");

    assert.throws(
      () => core.submitResult(task.taskId, "research-agent", {
        body: "Unauthorized release",
        artifact: { type: "service_release", name: "bad", uri: "local://bad" }
      }),
      (error) => error.code === "ACTOR_NOT_AUTHORIZED"
    );

    task = core.submitResult(task.taskId, "journal-agent", {
      body: "Version 1.3.1 is ready.",
      artifact: {
        artifactId: "release-1.3.1",
        type: "service_release",
        name: "Investment Journal 1.3.1",
        uri: "local-service://investment-journal/1.3.1",
        metadata: { version: "1.3.1", testStatus: "passed" }
      }
    });
    assert.equal(task.status, "delivered");
    assert.equal(task.artifacts.length, 1);
    task = core.beginVerification(task.taskId, "research-agent");
    task = core.complete(task.taskId, "research-agent", "All acceptance criteria passed.");
    assert.equal(task.status, "completed");
    assert.ok(task.completedAt);
    assert.deepEqual(task.events.map((event) => event.sequence), task.events.map((_, index) => index + 1));
  });
});

test("a third failed verification escalates instead of starting an unbounded fourth iteration", async () => {
  await withFixture(async ({ core }) => {
    seedAgentsAndService(core);
    let task = newTask(core, { maxIterations: 3 });
    task = core.accept(task.taskId, "journal-agent");

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      task = core.startWorking(task.taskId, "journal-agent");
      task = core.submitResult(task.taskId, "journal-agent", {
        body: `Iteration ${iteration} is ready.`,
        artifact: {
          artifactId: `release-${iteration}`,
          type: "service_release",
          name: `Release ${iteration}`,
          uri: `local-service://investment-journal/iteration-${iteration}`,
          metadata: { version: `1.3.${iteration}` }
        }
      });
      task = core.beginVerification(task.taskId, "research-agent");
      task = core.requestRevision(task.taskId, "research-agent", `Iteration ${iteration} failed verification.`);
    }

    assert.equal(task.status, "escalated");
    assert.equal(task.iteration, 3);
    assert.equal(task.events.at(-1).type, "iteration_limit_reached");
    assert.throws(
      () => core.startWorking(task.taskId, "journal-agent"),
      (error) => error.code === "INVALID_TASK_TRANSITION"
    );
  });
});

test("a question answer completes the task and initiators cannot reuse it for a new question", async () => {
  await withFixture(async ({ core }) => {
    seedAgentsAndService(core);
    let task = core.createTask({
      initiatorAgentId: "research-agent",
      recipientAgentId: "journal-agent",
      type: "question",
      title: "Return ready",
      summary: "Reply with exactly ready.",
      acceptanceCriteria: ["The reply is exactly ready"]
    });
    task = core.accept(task.taskId, "journal-agent");
    task = core.startWorking(task.taskId, "journal-agent");

    assert.throws(
      () => core.reply(task.taskId, "research-agent", "Reply with OK instead."),
      (error) => error.code === "QUESTION_FOLLOWUP_REQUIRES_NEW_TASK"
    );

    task = core.reply(task.taskId, "journal-agent", "ready");
    assert.equal(task.status, "completed");
    assert.ok(task.completedAt);
    assert.equal(task.messages.at(-1).body, "ready");
    assert.equal(task.events.at(-1).type, "question_answered");
    assert.throws(
      () => core.reply(task.taskId, "research-agent", "Another question"),
      (error) => error.code === "TASK_TERMINAL"
    );
  });
});

test("agents, task history and pending delivery survive a database restart", async () => {
  await withFixture(async ({ directory, dbPath, core, store }) => {
    seedAgentsAndService(core);
    const task = newTask(core);
    await store.save();
    if (store.saveTimer) {
      clearTimeout(store.saveTimer);
      store.saveTimer = null;
    }

    const reopenedStore = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await reopenedStore.initialize();
    const reopened = new CollaborationCore(reopenedStore);
    assert.equal(reopened.getAgent("research-agent").name, "Research Agent");
    assert.equal(reopened.getTask(task.taskId).messages.length, 1);
    assert.equal(reopened.listPendingDeliveries().length, 1);
    if (reopenedStore.saveTimer) clearTimeout(reopenedStore.saveTimer);
  });
});
