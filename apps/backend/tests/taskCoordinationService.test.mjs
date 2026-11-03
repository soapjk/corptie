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
import { createLocalDetailBusinessActionService } from "../src/application/detailBusinessActionComposition.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";
import { ClientInspectorAPI } from "../src/application/clientInspectorAPI.mjs";
import { ClientDeviceAuthority } from "../src/application/clientDeviceAuthority.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";
import { createServer } from "node:http";
import { CoordinationTurnService } from "../src/application/coordinationTurnService.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { ToolHostService } from "../src/application/toolHostService.mjs";
import { eventHasAgentMessage } from "../src/store/sessionEventSemantics.mjs";

const nextTick = () => new Promise(resolve => setImmediate(resolve));
async function restrictedFixture(t, providerId = "codex-app-server", supported = true) {
  const f = await fixture(t, providerId);
  f.workService.updateTask(f.parent.id, { coordinationEnabled: true });
  const route = () => f.store.getLogicalSessionByLegacySessionId(f.source.sessionId);
  const reference = () => ({ sessionId: f.source.sessionId, logicalSessionId: route().logicalSessionId,
    bindingId: route().activeBinding.bindingId, routingVersion: route().routingVersion,
    providerId, providerSessionId: f.source.sessionId, metadata: { session: f.store.getSession(f.source.sessionId) } });
  let output = { kind: "discussion", reply: "讨论答复", items: [] }, run = null;
  const requests = [], terminals = [], events = [];
  const registry = { supports: () => supported, get: () => ({ descriptor: { metadata: { backgroundExecutionPolicies: supported ? ["no-tools"] : [] } } }),
    invoke: () => { throw new Error("Unrestricted Provider execution must never be invoked"); } };
  const turns = new CoordinationTurnService({ store: f.store, registry, resolveReference: reference, dispatch: f.coordinator,
    planner: { run: async input => { requests.push(input); if (run) return run(input); return { text: JSON.stringify(output) }; } },
    emitEvent: (type, payload) => events.push({ type, payload }), onTerminal: entry => terminals.push(entry) });
  const application = new SessionApplicationService({ registry, resolveSessionReference: reference, coordinationTurns: turns,
    toolHostService: { prepareSession: () => { throw new Error("Must not prepare ordinary tools"); } } });
  f.workService.onCoordinationChanged = taskId => turns.policyChanged(taskId);
  return { ...f, turns, application, reference, requests, terminals, events,
    output(value) { output = value; }, run(value) { run = value; },
    instruction: () => ({ kind: "dispatch", reply: "不能把这个当作已完成", items: [{ action: "create", taskId: null,
      title: "实施修复", text: "执行开发并提供验证证据", agentId: f.role.agentId }] }) };
}
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

test("creation recovers an execution-only parent update between async preflight and persistence", async t => {
  for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) await t.test(provider, async t => {
    const f = await fixture(t, provider);
    const original = f.store.assertParentForCreate.bind(f.store);
    let injected = false;
    f.store.assertParentForCreate = input => {
      const result = original(input);
      if (!injected) {
        injected = true;
        queueMicrotask(() => f.store.updateTask(f.parent.id, { executionStatus: "running" }));
      }
      return result;
    };
    const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("race")] });
    const id = receipt.dispatches[0].dispatchId;
    await f.coordinator.runDispatch(id);
    assert.equal(f.coordinator.get(id).status, "queued");
    assert.equal(f.starts.length, 1);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?", [f.parent.id]).n, 1);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages").n, 1);
  });
});

test("creation does not rebase a changed parent definition", async t => {
  const f = await fixture(t);
  const original = f.store.assertParentForCreate.bind(f.store);
  let injected = false;
  f.store.assertParentForCreate = input => {
    const result = original(input);
    if (!injected) {
      injected = true;
      queueMicrotask(() => f.workService.updateTask(f.parent.id, { description: "Changed plan" }));
    }
    return result;
  };
  const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("changed")] });
  await f.coordinator.runDispatch(receipt.dispatches[0].dispatchId);
  assert.equal(f.coordinator.get(receipt.dispatches[0].dispatchId).error_code, "TASK_PARENT_VERSION_CONFLICT");
  assert.equal(f.starts.length, 0);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?", [f.parent.id]).n, 0);
});

test("parent CAS recovery is bounded and rejects unrelated or unchanged conflicts", async t => {
  for (const mode of ["continuous-status", "unchanged", "hierarchy", "other-error"]) await t.test(mode, async t => {
    const f = await fixture(t);
    let attempts = 0;
    f.collaboration.createTaskAndSession = async () => {
      attempts++;
      if (mode !== "unchanged") f.store.updateTask(f.parent.id, { executionStatus: attempts % 2 ? "running" : "completed" });
      if (mode === "hierarchy") f.store.bumpHierarchyRevision(f.parent.id);
      throw Object.assign(new Error("preflight rejected"), {
        code: mode === "other-error" ? "TASK_DELIVERY_BINDING_CHANGED" : "TASK_PARENT_VERSION_CONFLICT"
      });
    };
    const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item(mode)] });
    await f.coordinator.runDispatch(receipt.dispatches[0].dispatchId);
    assert.equal(attempts, mode === "continuous-status" ? 3 : 1);
    assert.equal(f.coordinator.get(receipt.dispatches[0].dispatchId).status, "failed");
    assert.equal(f.starts.length, 0);
  });
});

test("parent CAS after Task persistence never restarts or delivers an instruction", async t => {
  const f = await fixture(t);
  const create = f.collaboration.createTaskAndSession.bind(f.collaboration);
  let attempts = 0;
  f.collaboration.createTaskAndSession = async (...args) => {
    attempts++;
    await create(...args);
    f.store.updateTask(f.parent.id, { executionStatus: "running" });
    throw Object.assign(new Error("late conflict"), { code: "TASK_PARENT_VERSION_CONFLICT" });
  };
  const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("persisted")] });
  await f.coordinator.runDispatch(receipt.dispatches[0].dispatchId);
  assert.equal(attempts, 1);
  assert.equal(f.starts.length, 1);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?", [f.parent.id]).n, 1);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages").n, 0);
  assert.equal(f.coordinator.get(receipt.dispatches[0].dispatchId).status, "failed");
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
  const ports = createDetailBusinessActionPorts({ inspector: { scope: bound, updateTask: (id, fields) => f.workService.updateTask(id, fields),
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

test("desktop production composition saves enable and disable through real inspector commands and durable receipts", async t => {
  const f = await fixture(t);
  const identity = { kind: "local_user", principalId: "local-user" };
  const authenticate = () => identity;
  const snapshot = () => projectNativeBusinessDocument({ logicalSessionId: "logical:parent",
    session: f.store.getSession(f.source.sessionId), task: f.store.getTask(f.parent.id), work: f.work }, {}, "desktop-integration", { editors: true });
  const options = { store: f.store, commandAPI: new ClientSessionAPI({ store: f.store }), workService: f.workService,
    documentService: { nativeActionDocument: () => ({ state: snapshot(), revalidate: authenticate }) },
    resolveSession: () => ({ sessionId: f.source.sessionId, logicalSessionId: "logical:parent" }) };
  assert.throws(() => createLocalDetailBusinessActionService({ ...options, workService: {} }), /updateTask/);
  const actions = createLocalDetailBusinessActionService(options).forProfile({ catalog: "native-business-v1" });
  const request = (enabled, requestId) => {
    const document = snapshot(), card = document.cards.find(card => card.kind === "taskInfo");
    const action = card.actions.find(action => action.operation === "task.coordination.update");
    return { schemaVersion: 1, documentId: document.documentId, cardId: card.id, actionId: action.id,
      requestId, expectedResourceRevision: action.expectedResourceRevision, fields: { coordinationEnabled: enabled } };
  };
  const enable = request(true, "desktop_enable_coordination");
  assert.equal(enable.actionId, "task-coordination-setting", "new user actions must not reconcile the broken legacy action identity");
  const enabled = await actions.command(identity, "logical:parent", enable, authenticate);
  assert.equal(enabled.status, "completed", JSON.stringify(enabled));
  assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 1);
  const disabled = await actions.command(identity, "logical:parent", request(false, "desktop_disable_coordination"), authenticate);
  assert.equal(disabled.status, "completed", JSON.stringify(disabled));
  assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 0);
  assert.equal((await actions.command(identity, "logical:parent", enable, authenticate)).status, "completed");
  assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 0, "receipt recovery must not replay an old enable mutation");
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM client_command_receipts WHERE status='unknown'").n, 0);
});

test("paired mobile HTTP toggle uses the injected shared Detail service, persists and recovers without replay", async t => {
  const f = await fixture(t);
  const authority = new ClientDeviceAuthority(join(f.store.dataRoot, "test-devices"));
  await authority.initialize();
  const invitation = authority.invite();
  const claim = authority.claim({ ...invitation, name: "Test iPhone" });
  await authority.approve(invitation.pairingId, true);
  const credentials = await authority.exchange(claim);
  const authenticate = () => authority.authenticate(credentials.accessToken);
  const snapshot = () => projectNativeBusinessDocument({ logicalSessionId: "logical:parent",
    session: f.store.getSession(f.source.sessionId), task: f.store.getTask(f.parent.id), work: f.work }, {}, "mobile-integration", { editors: true });
  const resolveSession = () => ({ sessionId: f.source.sessionId, logicalSessionId: "logical:parent" });
  const detailActionService = createLocalDetailBusinessActionService({ store: f.store, workService: f.workService,
    commandAPI: new ClientSessionAPI({ store: f.store }), resolveSession,
    documentService: { nativeActionDocument: () => ({ state: snapshot(), revalidate: authenticate }) } });
  const gateway = new ClientDeviceGateway(authority, { detailActionService, detailWritesAllowed: true,
    sessionAPI: { inspector: new ClientInspectorAPI({ store: f.store, resolveSession,
      updateTask: () => { throw new Error("Mobile fallback inspector must not shadow the shared Detail service"); } }) } });
  const server = createServer((request, response) => gateway.handle(request, response));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/client/v1/sessions/logical:parent/detail`;
  const headers = { authorization: `Bearer ${credentials.accessToken}`,
    accept: "application/json; corptie-detail=native-business-v1", "content-type": "application/json" };
  const command = async (enabled, requestId) => {
    const document = snapshot(), card = document.cards.find(card => card.kind === "taskInfo");
    const action = card.actions.find(action => action.operation === "task.coordination.update");
    const response = await fetch(`${base}/actions`, { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1,
      requestId, documentId: document.documentId, cardId: card.id, actionId: action.id,
      expectedResourceRevision: action.expectedResourceRevision, fields: { coordinationEnabled: enabled } }) });
    const receipt = await response.json();
    assert.equal(response.status, 200, JSON.stringify(receipt));
    assert.equal(receipt.status, "completed", JSON.stringify(receipt));
  };
  await command(true, "mobile_enable_coordination");
  assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 1);
  await command(false, "mobile_disable_coordination");
  assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 0);
  const recovered = await fetch(`${base}/receipts/mobile_enable_coordination`, { headers });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).status, "completed");
  assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 0);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM client_command_receipts WHERE device_id=? AND status='completed'", [credentials.deviceId]).n, 2);
});

test("restricted coordination bypasses all native tools and sends on both no-tools Providers", async t => {
  for (const provider of ["codex-app-server", "claude-sdk"]) await t.test(provider, async t => {
    const f = await restrictedFixture(t, provider);
    f.output(f.instruction());
    const receipt = await f.application.sendMessage(f.source.sessionId, "只有一行的小修复也请开发", { idempotencyKey: "instruction-one" });
    assert.equal(receipt.executionMode, "coordination");
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].executionPolicy, "no-tools");
    assert.equal(f.requests[0].permissionProfile, "read-only");
    assert.equal(f.requests[0].allowProviderFallback, false);
    assert.equal(f.requests[0].priority, "interactive");
    assert.equal(f.requests[0].preferredProviderId, provider);
    assert.equal(f.coordinator.listForParent(f.parent.id).length, 1);
    assert.equal(f.terminals[0].status, "completed");
    assert.match(f.events.at(-1).payload.item.text, /已受理 1/);
    assert.doesNotMatch(f.events.at(-1).payload.item.text, /不能把这个当作已完成/);
    await f.application.sendMessage(f.source.sessionId, "retry", { idempotencyKey: "instruction-one" });
    assert.equal(f.requests.length, 1);
    assert.equal(f.coordinator.listForParent(f.parent.id).length, 1);
  });
});

test("discussion remains responsive without dispatching; unsafe command cannot escape", async t => {
  const f = await restrictedFixture(t);
  const receipt = await f.application.sendMessage(f.source.sessionId, "先讨论方案", { idempotencyKey: "discussion" });
  assert.equal(f.coordinator.listForParent(f.parent.id).length, 0);
  assert.equal(f.store.getSessionItem(f.source.sessionId, `${receipt.turnId}:result`).text, "讨论答复");
  assert.equal(f.turns.state(f.reference()).status, "enforced");
  await assert.rejects(f.application.executeCommand(f.source.sessionId, { name: "review", arguments: "" }), { code: "COORDINATION_COMMAND_DENIED" });
});

test("unsupported runtime and image inputs fail closed before any planner or native send", async t => {
  const f = await restrictedFixture(t, "openclacky", false);
  await assert.rejects(f.application.sendMessage(f.source.sessionId, "开发"), { code: "COORDINATION_ISOLATION_UNSUPPORTED" });
  assert.equal(f.requests.length, 0);
  assert.equal(f.turns.state(f.reference()).status, "unsupported");
  assert.throws(() => f.turns.assertCanEnable({ ...f.parent, current_session_id: f.source.sessionId }), { code: "COORDINATION_ISOLATION_UNSUPPORTED" });
  const supported = await restrictedFixture(t);
  await assert.rejects(supported.application.sendMessage(supported.source.sessionId, { text: "看图开发", images: [{}] }), { code: "COORDINATION_IMAGE_UNSUPPORTED" });
  assert.equal(supported.requests.length, 0);
});

test("invalid plan, runtime isolation error and failed admission never fall back or blindly retry", async t => {
  for (const kind of ["invalid", "runtime", "admission"]) await t.test(kind, async t => {
    const f = await restrictedFixture(t);
    if (kind === "invalid") f.output({ kind: "discussion", reply: "I did it", items: [f.instruction().items[0]] });
    if (kind === "runtime") f.run(async () => { throw Object.assign(new Error("Runtime tool config unverified"), { code: "BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED" }); });
    if (kind === "admission") f.output({ ...f.instruction(), items: [{ ...f.instruction().items[0], agentId: "foreign-role" }] });
    const receipt = await f.application.sendMessage(f.source.sessionId, "开发", { idempotencyKey: "failure" });
    assert.equal(f.terminals[0].status, "failed");
    assert.equal(f.store.getSessionTurn(f.source.sessionId, f.source.providerBindingId, receipt.turnId).execution_status, "failed");
    assert.equal(f.coordinator.listForParent(f.parent.id).length, 0);
    await f.application.sendMessage(f.source.sessionId, "retry", { idempotencyKey: "failure" });
    assert.equal(f.requests.length, 1);
  });
});

test("mode toggle during planning fences stale decisions and never restores writable execution", async t => {
  const f = await restrictedFixture(t);
  f.run(async () => {
    f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
    return { text: JSON.stringify(f.instruction()) };
  });
  await f.application.sendMessage(f.source.sessionId, "开发", { idempotencyKey: "toggle-race" });
  assert.equal(f.terminals[0].status, "failed");
  assert.match(f.events.at(-1).payload.item.text, /策略|开关/);
  assert.equal(f.coordinator.listForParent(f.parent.id).length, 0);
});

test("stop aborts only the host planner; an unresolved original execution is not replayed", async t => {
  const f = await restrictedFixture(t);
  f.run(input => new Promise((resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true })));
  const pending = f.application.sendMessage(f.source.sessionId, "开发", { idempotencyKey: "cancel" });
  for (let i = 0; i < 30 && !f.requests.length; i++) await nextTick();
  assert.equal((await f.application.interrupt(f.source.sessionId)).coordination, true);
  await pending;
  assert.equal(f.terminals[0].status, "cancelled");
  assert.equal(f.coordinator.listForParent(f.parent.id).length, 0);
  const ref = f.reference();
  f.store.upsertSessionTurn({ sessionId: ref.sessionId, bindingId: ref.bindingId, routingVersion: ref.routingVersion,
    turnId: "coordination:crash", executionStatus: "running" });
  await assert.rejects(f.application.sendMessage(f.source.sessionId, "retry", { idempotencyKey: "crash" }), { code: "COORDINATION_OUTCOME_UNCERTAIN" });
});

test("native admission lease prevents an enable racing the ordinary send boundary", async t => {
  const f = await restrictedFixture(t);
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  const release = f.turns.beginNative(f.reference());
  assert.throws(() => f.turns.assertCanEnable({ ...f.parent, current_session_id: f.source.sessionId }), { code: "COORDINATION_SWITCH_BUSY" });
  assert.throws(() => f.turns.beginNative(f.reference()), { code: "SESSION_BUSY" });
  release();
  f.turns.assertCanEnable({ ...f.parent, current_session_id: f.source.sessionId });
  f.workService.updateTask(f.parent.id, { coordinationEnabled: true });
  assert.throws(() => f.turns.beginNative(f.reference()), { code: "COORDINATION_POLICY_CHANGED" });
});

test("host tool policy denies before catalog, skill gateway or discovery can execute", async () => {
  const host = new ToolHostService({ registry: {}, catalog: { entry: () => null, execute() { assert.fail("must not execute"); } },
    skillMcpGateway: { execute() { assert.fail("must not execute MCP"); } } });
  host.assertExecutionAllowed = () => { throw Object.assign(new Error("blocked"), { code: "COORDINATION_NATIVE_TOOL_DENIED" }); };
  for (const tool of ["corptie_tool_catalog_search", "corptie_tool_call", "arbitrary-shell", "corptie_task_dispatch"]) {
    await assert.rejects(host.execute({ tool }), { code: "COORDINATION_NATIVE_TOOL_DENIED" });
  }
});

test("safe cleanup decision reuses parent Session deletion authority and never force discards", async t => {
  const f = await restrictedFixture(t);
  const child = f.child("已交付子任务");
  let inspected = 0;
  f.coordinator.deletion = { inspect: async (id, actor) => {
    assert.equal(id, child.id); assert.equal(actor.type, "parent_session"); inspected++; return { artifacts: [] };
  }, request: async (id, input, actor) => {
    assert.equal(id, child.id); assert.equal(input.mode, "safe"); assert.equal(input.artifactDisposition, "retain");
    assert.equal(actor.id, "logical:parent"); return { accepted: true, operation: { operationId: "cleanup-one" } };
  } };
  f.output({ kind: "cleanup", reply: "not an acceptance", items: [{ action: "delete", taskId: child.id, title: "", text: "", agentId: "" }] });
  await f.application.sendMessage(f.source.sessionId, "清理已交付子任务", { idempotencyKey: "cleanup" });
  assert.equal(inspected, 1);
  assert.equal(f.terminals[0].status, "completed");
});

test("background reports cannot trigger new tasks; completed coordination replies advance unread semantics", async t => {
  const f = await restrictedFixture(t);
  f.output(f.instruction());
  await f.application.sendMessage(f.source.sessionId, "子任务执行结果通知", { idempotencyKey: "report", source: { type: "mailbox_event" } });
  assert.equal(f.terminals[0].status, "failed");
  assert.equal(f.coordinator.listForParent(f.parent.id).length, 0);
  assert.equal(eventHasAgentMessage({ type: "SessionCoordinationCompleted", payload: { hasAgentMessage: true } }), true);
  assert.equal(f.requests[0].priority, "background");
  assert.equal(eventHasAgentMessage({ type: "SessionCoordinationCompleted", payload: {} }), false);
});

test("host planning exposes running/stop state and hands discussion back when normal mode resumes", async t => {
  const f = await restrictedFixture(t);
  f.run(async () => {
    const live = f.store.getSession(f.source.sessionId);
    assert.equal(live.status, "running");
    assert.equal(live.capabilities.canInterrupt, true);
    assert.match(live.external.activeTurnId, /^coordination:/);
    return { text: JSON.stringify({ kind: "discussion", reply: "讨论中新增的要求", items: [] }) };
  });
  await f.application.sendMessage(f.source.sessionId, "讨论", { idempotencyKey: "handoff" });
  const settled = f.store.getSession(f.source.sessionId);
  assert.equal(settled.status, "complete");
  assert.equal(settled.capabilities.canInterrupt, false);
  assert.match(f.turns.handoffContext(f.reference()).prompt, /讨论中新增的要求/);
  assert.ok(Buffer.byteLength(f.turns.handoffContext(f.reference()).prompt) <= 4096);
});

test("cosmetic title updates do not cancel dispatch but off-on toggles invalidate the old plan", async t => {
  for (const toggle of [false, true]) await t.test(String(toggle), async t => {
    const f = await restrictedFixture(t);
    f.run(async () => {
      f.workService.updateTask(f.parent.id, { title: "新标题" });
      if (toggle) {
        f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
        f.workService.updateTask(f.parent.id, { coordinationEnabled: true });
      }
      return { text: JSON.stringify(f.instruction()) };
    });
    await f.application.sendMessage(f.source.sessionId, "开发", { idempotencyKey: "policy" });
    assert.equal(f.terminals[0].status, toggle ? "failed" : "completed");
    assert.equal(f.coordinator.listForParent(f.parent.id).length, toggle ? 0 : 1);
  });
});

for (const providerId of ["codex-app-server", "claude-code"]) test(`workspace contention waits for a job event before creating a child (${providerId})`,async t=>{
  const f=await fixture(t,providerId), original=f.collaboration.createTaskAndSession.bind(f.collaboration);
  let busy=true,calls=0;
  f.collaboration.createTaskAndSession=async(...args)=>{calls++;if(busy)throw Object.assign(new Error('Parent workspace busy'),{code:'TASK_HIERARCHY_BUSY'});return original(...args);};
  const accepted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('workspace')]});
  const id=accepted.dispatches[0].dispatchId;
  await nextTick();await f.coordinator.running.get(id);
  assert.equal(f.coordinator.get(id).status,'waiting_workspace');assert.equal(f.coordinator.get(id).target_task_id,null);
  assert.equal(calls,1);busy=false;f.coordinator.onRuntimeEvent('WorktreeIntegrationJobChanged',{job:{status:'completed'}});
  await nextTick();await f.coordinator.running.get(id);
  assert.equal(f.coordinator.get(id).status,'queued');assert.ok(f.coordinator.get(id).target_task_id);assert.equal(calls,2);assert.equal(f.starts.length,1);
});
