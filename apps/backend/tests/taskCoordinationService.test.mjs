import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { SessionMailboxService } from "../src/application/sessionMailboxService.mjs";
import { createSessionCollaborationComposition } from "../src/application/sessionCollaborationComposition.mjs";
import { TaskCoordinationService } from "../src/application/taskCoordinationService.mjs";
import { createTaskExecutionComposition } from "../src/application/taskExecutionComposition.mjs";
import { buildTaskCoordinationContext } from "../src/application/workSessionContext.mjs";
import { collaborationDynamicTools, callCollaborationDynamicTool } from "../src/collaboration/collaborationDynamicTools.mjs";
import { handleCollaborationHttpRequest } from "../src/collaboration/collaborationHttpApi.mjs";
import { Readable } from "node:stream";
import { createDetailBusinessActionPorts } from "../src/application/detailBusinessActionPorts.mjs";
import { createDetailActionRegistry } from "../src/application/detailActionService.mjs";
import { projectNativeBusinessDocument } from "../src/application/detailNativeBusinessProjection.mjs";

const nextTick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, providerId = "codex-app-server") {
  const dir = await mkdtemp(join(tmpdir(), "coordination-"));
  const store = new CorptieStore({ dbPath: ":memory:", configPath: join(dir, "config.json"), manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false });
  let coordinator;
  t.after(async () => { await nextTick(); await Promise.all(coordinator?.running.values() ?? []); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const core = new CollaborationCore(store), workService = new WorkApplicationService({ store });
  const role = store.createAgent({ name: "Worker", role: "independentContributor" });
  const work = workService.createWork({ name: "Coordination", contributorAgentIds: [role.agentId] });
  const parent = store.createTask({ workId: work.id, title: "Parent", mainAgentId: role.agentId });
  const open = (name, taskId) => {
    const id = `provider:${name}`;
    store.createSession({ id, agentId: role.agentId, title: name, provider: providerId, workId: work.id, taskId, sessionKind: "worker" });
    store.createLogicalSessionRoute({ logicalSessionId: `logical:${name}`, legacySessionId: id,
      providerThreadId: name, providerSessionId: id, providerId, boundCwd: "/tmp", sessionName: name });
    core.bindSession({ agentId: role.agentId, sessionId: id });
    return { sessionId: id, providerBindingId: store.getLogicalSessionByLegacySessionId(id).activeBinding.bindingId };
  };
  const source = open("parent", parent.id);
  let unblock = null, failure = null;
  const starts = [], proofs = new Map();
  const starter = {
    async start(command) {
      starts.push(command);
      if (unblock) await unblock;
      if (failure) throw Object.assign(new Error("prepare failed"), { code: failure });
      const meta = open(`child${starts.length}`, command.taskId);
      store.setTaskCreationState(command.taskId, "ready");
      const proof = { status: "ready", session: store.getSession(meta.sessionId), task: store.getTask(command.taskId),
        receipt: { startupOperationId: `startup:${starts.length}`, taskId: command.taskId } };
      proofs.set(store.getLogicalSessionByLegacySessionId(meta.sessionId).logicalSessionId, proof);
      return proof;
    }, getSessionBinding(id) { return proofs.get(id); }
  };
  const collaboration = createSessionCollaborationComposition({ store, workService, collaborationCore: core,
    getWorkSessionStartApplicationService: () => starter, defaultProviderId: providerId });
  const mailbox = new SessionMailboxService({ store, resolveActor: () => role.agentId,
    validateExternal: (row, auth) => auth.coordinationDispatchId ? coordinator.validateMailbox(row, auth) : undefined });
  coordinator = new TaskCoordinationService({ store, collaboration, mailbox });
  collaboration.taskCoordinationService = coordinator;
  const item = (key = "one") => ({ action: "create", text: "Execute this isolated instruction", idempotencyKey: key,
    creation: { title: `Child_${key}`, agentId: role.agentId } });
  const child = title => store.createTask({ workId: work.id, title, mainAgentId: role.agentId, parentTaskId: parent.id }, {},
    { expectedParentResourceVersion: store.getTask(parent.id).resource_version });
  return { store, role, core, workService, parent, work, source, open, starts, collaboration, mailbox, coordinator, item, child,
    hold(promise) { unblock = promise; }, fail(code) { failure = code; } };
}

test("mode defaults off, root user update persists without revising the definition; child cannot enable", async t => {
  const f = await fixture(t);
  assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 0);
  assert.ok(f.store.selectOne("SELECT name FROM sqlite_master WHERE type='index' AND name='task_coordination_operation'"));
  const revision = f.store.getTask(f.parent.id).revision;
  f.workService.updateTask(f.parent.id, { coordinationEnabled: true });
  assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 1);
  assert.equal(f.store.getTask(f.parent.id).revision, revision);
  const child = f.child("Child");
  assert.throws(() => f.workService.updateTask(child.id, { coordinationEnabled: true }), { code: "TASK_MAX_DEPTH_EXCEEDED" });
  assert.match(buildTaskCoordinationContext(f.store.getTask(f.parent.id), null), /END this turn/);
});

test("admission returns before startup, freezes defaults, and mailbox owns one instruction on every Provider", async t => {
  for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) await t.test(providerId, async t => {
    const f = await fixture(t, providerId);
    let release; const gate = new Promise(resolve => { release = resolve; }); f.hold(gate);
    await f.store.updateSettings({ newSessionDefaults: { taskCreation: { providerId, model: "frozen-model", reasoningLevel: "high" } } });
    const input = { items: [f.item()] };
    const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, input);
    assert.equal(receipt.dispatches[0].status, "accepted");
    assert.equal(f.starts.length, 0);
    const id = receipt.dispatches[0].dispatchId;
    const runtime = f.coordinator.get(id).runtime_json;
    await f.store.updateSettings({ newSessionDefaults: { taskCreation: { providerId, model: "later-model", reasoningLevel: "low" } } });
    const repeated = f.coordinator.acceptDispatch(f.source, f.role.agentId, input);
    assert.equal(repeated.dispatches[0].dispatchId, id);
    await nextTick();
    assert.equal(f.coordinator.get(id).status, "preparing");
    release(); await f.coordinator.runDispatch(id);
    const row = f.coordinator.get(id);
    assert.equal(row.status, "queued");
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].model, "frozen-model");
    assert.equal(f.starts[0].reasoningLevel, "high");
    assert.equal(row.runtime_json, runtime);
    assert.equal(JSON.parse(row.request_json).text, null);
    const target = f.store.getTask(row.target_task_id), logical = f.store.getLogicalSessionByLegacySessionId(target.current_session_id);
    const message = f.mailbox.get(logical.logicalSessionId, row.mailbox_message_id);
    assert.equal(message.body, input.items[0].text);
    assert.equal(message.senderSessionId, "logical:parent");
    assert.equal(f.store.getAgentTask(row.operation_id).source.coordinationPurpose, "child_instruction");
    f.coordinator.acceptDispatch(f.source, f.role.agentId, input);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages").n, 1);
    assert.throws(() => f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [{ ...f.item(), text: "changed" }] }), { code: "IDEMPOTENCY_CONFLICT" });
  });
});

test("batch is bounded at ten; queued child reuse needs no user evidence and rejects siblings or grandchildren", async t => {
  const f = await fixture(t);
  assert.throws(() => f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: Array.from({ length: 11 }, (_, i) => f.item(String(i))) }), { code: "INVALID_TASK_BATCH_SIZE" });
  const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item()] });
  await f.coordinator.runDispatch(receipt.dispatches[0].dispatchId);
  const childId = f.coordinator.get(receipt.dispatches[0].dispatchId).target_task_id;
  const sent = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [{ action: "send", taskId: childId, text: "Additional requirement", idempotencyKey: "followup" }] });
  await f.coordinator.runDispatch(sent.dispatches[0].dispatchId);
  assert.equal(f.starts.length, 1);
  assert.throws(() => f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [{ action: "send", taskId: f.parent.id, text: "bad", idempotencyKey: "bad" }] }), { code: "TASK_PARENT_OUTSIDE_SCOPE" });
  const childSource = { sessionId: f.store.getTask(childId).current_session_id };
  assert.throws(() => f.coordinator.acceptDispatch(childSource, f.role.agentId, { items: [f.item("grandchild")] }), { code: "TASK_PARENT_UNAVAILABLE" });
  assert.throws(() => f.coordinator.acceptDispatch({ ...f.source, providerBindingId: "stale" }, f.role.agentId, { items: [f.item("stale")] }), { code: "STALE_SESSION_ROUTE" });
});

test("completion reports wait for parent, batch results through mailbox, and never count as acceptance", async t => {
  const f = await fixture(t);
  const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("first"), f.item("second")] });
  await Promise.all(receipt.dispatches.map(row => f.coordinator.runDispatch(row.dispatchId)));
  f.store.db.run("UPDATE sessions SET status='running' WHERE id=?", [f.source.sessionId]);
  for (const accepted of receipt.dispatches) {
    const row = f.coordinator.get(accepted.dispatchId);
    const work = f.store.updateAgentTask(row.operation_id, { status: "completed", targetTurnId: "finished" });
    f.coordinator.onRuntimeEvent("AgentWorkCompleted", { task: work });
  }
  f.coordinator.flushReports();
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n, 0);
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  f.store.db.run("UPDATE sessions SET status='idle' WHERE id=?", [f.source.sessionId]);
  f.coordinator.flushReports();
  const reports = f.store.selectAll("SELECT * FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].intent, "response_required");
  assert.match(reports[0].body, /未验收|不代表已验收/);
  assert.match(reports[0].body, /first|dispatch/);
  f.coordinator.flushReports();
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n, 1);
  for (const row of receipt.dispatches) assert.notEqual(f.store.getTask(f.coordinator.get(row.dispatchId).target_task_id).lifecycle_state, "done");
});

test("user messages outrank parent reports even at the claim boundary", async t => {
  const f = await fixture(t);
  const report = f.mailbox.receiveEvent({ recipientSessionId: "logical:parent", sourceType: "background", sourceId: "report-source",
    body: "Report", intent: "response_required", priority: 100, idempotencyKey: "report-key",
    authorization: { ownerLogicalSessionId: "logical:parent", sourceId: "report-source", purpose: "parent_report" } });
  const reportID = f.mailbox.raw("logical:parent", report.messageId).operation_id;
  f.store.enqueueAgentTask({ taskId: "user:next", agentId: f.role.agentId, sessionId: f.source.sessionId, kind: "user", priority: 1, text: "Next user instruction", source: { type: "desktop" } });
  assert.equal(f.store.claimAgentTask(reportID), null);
  assert.equal(f.store.listQueuedAgentTasksForSession(f.source.sessionId)[0].taskId, "user:next");
  assert.ok(f.store.claimAgentTask("user:next"));
});

test("preparation failure retries with the same identity; unknown accepted delivery is never resent", async t => {
  const f = await fixture(t); f.fail("PREPARATION_FAILED");
  const result = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item()] });
  const id = result.dispatches[0].dispatchId;
  await f.coordinator.runDispatch(id);
  assert.equal(f.coordinator.get(id).status, "failed");
  f.fail(null); f.coordinator.retryDispatch(f.source, f.role.agentId, id); await f.coordinator.runDispatch(id);
  const row = f.coordinator.get(id);
  assert.equal(row.status, "queued");
  f.store.updateAgentTask(row.operation_id, { status: "running", targetTurnId: null,
    source: { ...f.store.getAgentTask(row.operation_id).source, mailboxDispatchAttempted: true } });
  f.coordinator.recover();
  assert.equal(f.coordinator.get(id).status, "unknown");
  assert.throws(() => f.coordinator.retryDispatch(f.source, f.role.agentId, id), { code: "DISPATCH_RETRY_UNSAFE" });
  assert.equal(f.starts.length, 2);
});

test("restart resumes accepted preparation even after mode is switched off", async t => {
  const f = await fixture(t);
  f.coordinator.runDispatch = async () => {};
  const accepted = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("recover")] });
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  const restored = new TaskCoordinationService({ store: f.store, collaboration: f.collaboration, mailbox: f.mailbox });
  f.collaboration.taskCoordinationService = restored;
  restored.recover();
  await restored.runDispatch(accepted.dispatches[0].dispatchId);
  assert.equal(restored.get(accepted.dispatches[0].dispatchId).status, "queued");
  assert.equal(f.starts.length, 1);
  assert.equal(f.store.listTaskCoordinationDispatches(f.parent.id).length, 1);
});

test("retry replaces stale failure reports with a new immutable report generation", async t => {
  const f = await fixture(t); f.fail("PREPARATION_FAILED");
  f.store.db.run("UPDATE sessions SET status='idle' WHERE id=?", [f.source.sessionId]);
  const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("report_retry")] });
  const id = receipt.dispatches[0].dispatchId;
  await f.coordinator.runDispatch(id); f.coordinator.flushReports();
  const failedReportID = f.coordinator.get(id).report_message_id;
  assert.ok(failedReportID);
  f.fail(null); f.coordinator.retryDispatch(f.source, f.role.agentId, id); await f.coordinator.runDispatch(id);
  const work = f.store.updateAgentTask(f.coordinator.get(id).operation_id, { status: "completed", targetTurnId: "retry-turn" });
  f.coordinator.onRuntimeEvent("AgentWorkCompleted", { task: work }); f.coordinator.flushReports();
  const successReportID = f.coordinator.get(id).report_message_id;
  assert.ok(successReportID);
  assert.notEqual(successReportID, failedReportID);
  const old = f.mailbox.raw("logical:parent", failedReportID);
  assert.throws(() => f.coordinator.validateMailbox(old, JSON.parse(old.authorization_json)), { code: "COORDINATION_REPORT_SCOPE_INVALID" });
  const current = f.mailbox.raw("logical:parent", successReportID);
  f.coordinator.validateMailbox(current, JSON.parse(current.authorization_json));
});

test("adopted child instructions recover from the mailbox turn, not the cancelled queue placeholder", async t => {
  const f = await fixture(t);
  const accepted = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("adopt")] });
  const id = accepted.dispatches[0].dispatchId;
  await f.coordinator.runDispatch(id);
  const row = f.coordinator.get(id), child = f.store.getTask(row.target_task_id);
  const logical = f.store.getLogicalSessionByLegacySessionId(child.current_session_id);
  const turn = { sessionId: child.current_session_id, bindingId: logical.activeBinding.bindingId,
    routingVersion: logical.routingVersion, turnId: "adopted-turn", executionStatus: "running" };
  f.store.upsertSessionTurn(turn);
  f.mailbox.adopt(logical.logicalSessionId, [row.mailbox_message_id]);
  assert.equal(f.store.getAgentTask(row.operation_id).status, "cancelled");
  f.coordinator.recover();
  assert.equal(f.coordinator.get(id).status, "running");
  f.store.db.run(`INSERT INTO session_items(id,session_id,turn_id,turn_status,type,title,text,binding_id,presentation_role,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, ["final:adopted", child.current_session_id, turn.turnId, "completed", "agentMessage", "Result", "Exact child result", turn.bindingId, "final_answer", new Date().toISOString()]);
  f.store.upsertSessionTurn({ ...turn, executionStatus: "completed" });
  f.coordinator.recover();
  assert.equal(f.coordinator.get(id).status, "completed");
  f.store.db.run("UPDATE sessions SET status='idle' WHERE id=?", [f.source.sessionId]);
  f.coordinator.flushReports();
  const report = f.store.selectOne("SELECT body FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'");
  assert.ok(report);
  assert.match(report.body, /Exact child result/);
  assert.match(report.body, /final:adopted/);
  assert.match(report.body, /adopted-turn/);
});

test("failed batches retain independent dispatch outcomes and only safe preparation retries", async t => {
  const f = await fixture(t);
  const receipts = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("a"), f.item("b")] });
  const original = f.collaboration.createTaskAndSession.bind(f.collaboration);
  f.collaboration.createTaskAndSession = (...args) => args[2].title === "Child_b"
    ? Promise.reject(Object.assign(new Error("child b unavailable"), { code: "PREPARATION_FAILED" })) : original(...args);
  await Promise.all(receipts.dispatches.map(row => f.coordinator.runDispatch(row.dispatchId)));
  assert.equal(f.coordinator.get(receipts.dispatches[0].dispatchId).status, "queued");
  assert.equal(f.coordinator.get(receipts.dispatches[1].dispatchId).status, "failed");
  assert.equal(f.starts.length, 1);
});

test("child deletion uses parent Session authority without confirmation and blocks undelivered artifacts", async t => {
  const f = await fixture(t);
  const child = f.child("Unused_child");
  const calls = [];
  f.coordinator.deletion = { inspect: async (_id, actor) => { calls.push(actor); return { artifacts: [] }; },
    request: async (id, input, actor) => ({ accepted: true, id, input, actor }) };
  const result = await f.collaboration.deleteChildTask(f.source, f.role.agentId, { childTaskId: child.id, idempotencyKey: "delete-one" });
  assert.equal(result.actor.type, "parent_session");
  assert.equal(result.actor.id, "logical:parent");
  assert.equal(result.input.mode, "safe");
  assert.equal(result.input.artifactDisposition, "retain");
  assert.equal(Object.hasOwn(result.input, "acknowledgeDataLoss"), false);
  f.coordinator.deletion.inspect = async () => ({ artifacts: [{ artifactId: "artifact:unpreserved" }] });
  await assert.rejects(f.collaboration.deleteChildTask(f.source, f.role.agentId, { childTaskId: child.id, idempotencyKey: "delete-two" }), { code: "CHILD_ARTIFACT_DELIVERY_REQUIRED" });
  await assert.rejects(f.collaboration.deleteChildTask(f.source, f.role.agentId, { childTaskId: f.parent.id, idempotencyKey: "bad-delete" }), { code: "TASK_PARENT_OUTSIDE_SCOPE" });
  assert.equal(calls.length, 1);
});

test("production deletion composition authorizes only the real parent Session and retains original provenance", async t => {
  const f = await fixture(t);
  const child = f.child("Disposable");
  const composition = createTaskExecutionComposition({ store: f.store, workService: f.workService,
    inspectTaskWorktree: async () => ({ status: "none", worktree: null }), removeTaskDeletionWorktree: async () => ({}),
    sessionApplicationService: { deleteSessionForTaskDeletion: async () => ({ providerDeleted: true }) }, artifactService: {}, emitEvent() {},
    ensureTaskWorkspace: async () => ({}) });
  f.coordinator.deletion = composition.taskDeletionService;
  const result = await f.collaboration.deleteChildTask(f.source, f.role.agentId, { childTaskId: child.id, idempotencyKey: "actual-delete" });
  assert.equal(result.accepted, true);
  await composition.taskDeletionService.inFlight.get(result.operation.operationId);
  const operation = composition.taskDeletionService.getOperation(result.operation.operationId);
  assert.equal(operation.state, "succeeded");
  assert.equal(operation.input.actor.type, "parent_session");
  assert.equal(operation.input.target.taskId, child.id);
  assert.equal(operation.input.target.parentTaskId, f.parent.id);
  const repeated = await f.collaboration.deleteChildTask(f.source, f.role.agentId, { childTaskId: child.id, idempotencyKey: "actual-delete" });
  assert.equal(repeated.operation.operationId, operation.operationId);
});

test("MCP schemas and HTTP dispatch share authenticated Session context", async t => {
  const f = await fixture(t);
  const tool = collaborationDynamicTools.find(row => row.name === "corptie_task_dispatch");
  const args = { items: [{ action: "create", text: "Do this", idempotency_key: "transport", creation: { title: "Transport", agent_id: f.role.agentId } }] };
  const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
  assert.equal(validate(args), true, JSON.stringify(validate.errors));
  const calls = [];
  await callCollaborationDynamicTool({ post: async (path, body) => calls.push({ path, body }) }, tool.name, args);
  let status, payload;
  const request = Readable.from([Buffer.from(JSON.stringify(calls[0].body))]); request.method = "POST";
  request.headers = { "x-corptie-agent-id": f.role.agentId, "x-corptie-session-id": f.source.sessionId };
  await new Promise(resolve => {
    const response = { writeHead(code) { status = code; }, end(body) { payload = JSON.parse(body); resolve(); } };
    handleCollaborationHttpRequest({ request, response, url: new URL(`http://local${calls[0].path}`),
      core: f.core, sessionCollaborationService: f.collaboration });
  });
  assert.equal(status, 202, JSON.stringify(payload)); assert.equal(payload.accepted, true);
  await f.coordinator.runDispatch(payload.dispatches[0].dispatchId);
});

test("native Detail toggle is user-command scoped, revision checked and absent from child controls", async t => {
  const f = await fixture(t);
  const identity = { kind: "local_user", principalId: "owner" };
  const bound = () => ({ sessionId: "logical:parent", logicalSessionId: "logical:parent", task: f.store.getTask(f.parent.id) });
  const ports = createDetailBusinessActionPorts({ inspector: { scope: bound,
    perform: (_scope, operation, fields) => { assert.equal(operation, "task.update"); return f.workService.updateTask(f.parent.id, fields); } } });
  const registry = createDetailActionRegistry(ports), scope = { sessionId: "logical:parent", identity };
  const document = projectNativeBusinessDocument({ logicalSessionId: "logical:parent", session: f.store.getSession(f.source.sessionId),
    task: f.store.getTask(f.parent.id), work: f.work }, {}, "test-generation", { editors: true });
  const card = document.cards.find(card => card.kind === "taskInfo");
  assert.equal(card.data.coordinationEnabled, false);
  const action = card.actions.find(action => action.operation === "task.coordination.update");
  assert.ok(action);
  const prepared = await registry.prepare({ action, fields: { coordinationEnabled: true }, expectedResourceRevision: action.expectedResourceRevision, scope });
  await prepared.port.execute(scope, action.target, { coordinationEnabled: true }, { resource: prepared.resource, fingerprint: "toggle-mode" });
  assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 1);
  await assert.rejects(registry.prepare({ action, fields: { coordinationEnabled: false }, expectedResourceRevision: action.expectedResourceRevision, scope }), { code: "DETAIL_REVISION_CONFLICT" });
  const child = f.child("Child_view");
  const childDoc = projectNativeBusinessDocument({ logicalSessionId: "logical:child", session: { sessionKind: "worker" }, task: child, work: f.work }, {}, "test-generation", { editors: true });
  assert.equal(childDoc.cards.find(row => row.kind === "taskInfo").actions.some(row => row.operation === "task.coordination.update"), false);
});
