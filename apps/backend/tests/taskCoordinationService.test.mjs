import { SessionChannelService } from "../src/collaboration/sessionChannelService.mjs";
import test from "node:test";
import { ExecutionChecklistService } from "../src/application/executionChecklistService.mjs";
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
import { createProductEventPublisher } from "../src/application/productEventPublisher.mjs";
import { createCollaborationTimelinePresentation } from "../src/collaboration/collaborationTimelinePresentation.mjs";
import { CoordinationReadService } from "../src/application/coordinationReadService.mjs";

const nextTick = () => new Promise(resolve => setImmediate(resolve));
test("repository dispatch records remain valid in native Task detail on every Provider", async t => {
  for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) await t.test(provider, async t => {
    const f = await fixture(t, provider);
    const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("detail-contract")] });
    const id = receipt.dispatches[0].dispatchId;
    for (const errorMessage of [null, "会话正忙，等待派发"]) {
      f.coordinator.update(id, { status: errorMessage ? "waiting_dispatch" : "accepted", error_message: errorMessage });
      const task = { ...f.store.getTask(f.parent.id), coordinationDispatches: f.store.listTaskCoordinationDispatches(f.parent.id) };
      const document = projectNativeBusinessDocument({ session: f.store.getSession(f.source.sessionId),
        logicalSessionId: "logical:parent", task }, {}, "repository-dispatch");
      assert.equal(document.cards.find(card => card.kind === "taskInfo").data.coordinationDispatches[0].errorMessage, errorMessage);
    }
  });
});
async function restrictedFixture(t, providerId = "codex-app-server", supported = true, turnOptions = {}) {
  const f = await fixture(t, providerId, turnOptions.durableStore);
  f.workService.updateTask(f.parent.id, { coordinationEnabled: true });
  const route = () => f.store.getLogicalSessionByLegacySessionId(f.source.sessionId);
  const reference = () => ({ sessionId: f.source.sessionId, logicalSessionId: route().logicalSessionId,
    bindingId: route().activeBinding.bindingId, routingVersion: route().routingVersion,
    providerId, providerSessionId: f.source.sessionId, metadata: { session: f.store.getSession(f.source.sessionId) } });
  let output = { kind: "discussion", reply: "讨论答复", items: [] }, run = null;
  const requests = [], terminals = [], events = [];
  const registry = { supports: () => supported, get: () => ({ descriptor: { metadata: { backgroundExecutionPolicies: supported ? ["no-tools"] : [] } } }),
    invoke: () => { throw new Error("Unrestricted Provider execution must never be invoked"); } };
  const turns = new CoordinationTurnService({ ...turnOptions, store: f.store, registry, resolveReference: reference, dispatch: f.coordinator,
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
async function fixture(t, providerId = "codex-app-server", durable = false) {
  const dir = await mkdtemp(join(tmpdir(), "coordination-"));
  const store = new CorptieStore({ dbPath: durable ? join(dir,"state.sqlite") : ":memory:", configPath: join(dir, "config.json"), manageProcessEnvironment: false });
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
  f.workService.updateTask(child.id,{coordinationEnabled:true});
  assert.equal(f.store.getTask(child.id).coordination_enabled,1);
  assert.match(buildTaskCoordinationContext(f.store.getTask(f.parent.id), null), /END this turn/);
});

test("creation accepts execution projection updates between async preflight and persistence", async t => {
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

test("creation does not fence parent description changes", async t => {
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
  assert.equal(f.coordinator.get(receipt.dispatches[0].dispatchId).status, "queued");
  assert.equal(f.starts.length, 1);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?", [f.parent.id]).n, 1);
});

test("dispatch never polls or loops on an unexpected downstream conflict", async t => {
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
    assert.equal(attempts, 1);
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
  assert.throws(() => f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: Array.from({ length: 101 }, (_, i) => f.item(String(i))) }), { code: "INVALID_TASK_BATCH_SIZE" });
  const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item()] });
  await f.coordinator.runDispatch(receipt.dispatches[0].dispatchId);
  const childId = f.coordinator.get(receipt.dispatches[0].dispatchId).target_task_id;
  const sent = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [{ action: "send", taskId: childId, text: "Additional requirement", idempotencyKey: "followup" }] });
  await f.coordinator.runDispatch(sent.dispatches[0].dispatchId);
  assert.equal(f.starts.length, 1);
  assert.throws(() => f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [{ action: "send", taskId: f.parent.id, text: "bad", idempotencyKey: "bad" }] }), { code: "TASK_PARENT_OUTSIDE_SCOPE" });
  const childSource = { sessionId: f.store.getTask(childId).current_session_id };
  const grandchild=f.coordinator.acceptDispatch(childSource,f.role.agentId,{items:[f.item("grandchild")]});
  assert.equal(grandchild.accepted,true);
  await f.coordinator.runDispatch(grandchild.dispatches[0].dispatchId);
  assert.equal(f.store.getTask(f.coordinator.get(grandchild.dispatches[0].dispatchId).target_task_id).parent_task_id,childId);
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
    f.store.upsertTimelineItemProjection(work.sessionId,{id:`result:${row.dispatch_id}`,turnId:"finished",type:"agentMessage",text:"交付结果",status:"completed",createdAt:new Date().toISOString()});
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
  assert.match(reports[0].body, /不代表目标完成或已验收/);
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
  const retry=f.coordinator.retryDispatch(f.source,f.role.agentId,id);
  assert.equal(retry.status,"unknown");assert.equal(retry.errorCode,"DISPATCH_ACCEPTANCE_UNKNOWN");
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

test("retry retains failure as state and emits a result only after an actual final report", async t => {
  const f = await fixture(t); f.fail("PREPARATION_FAILED");
  f.store.db.run("UPDATE sessions SET status='idle' WHERE id=?", [f.source.sessionId]);
  const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("report_retry")] });
  const id = receipt.dispatches[0].dispatchId;
  await f.coordinator.runDispatch(id); f.coordinator.flushReports();
  const failedReportID = f.coordinator.get(id).report_message_id;
  assert.equal(failedReportID,null);
  f.fail(null); f.coordinator.retryDispatch(f.source, f.role.agentId, id); await f.coordinator.runDispatch(id);
  const work = f.store.updateAgentTask(f.coordinator.get(id).operation_id, { status: "completed", targetTurnId: "retry-turn" });
  f.store.upsertTimelineItemProjection(work.sessionId,{id:"result:retry",turnId:"retry-turn",type:"agentMessage",text:"实际交付",status:"completed",createdAt:new Date().toISOString()});
  f.coordinator.onRuntimeEvent("AgentWorkCompleted", { task: work }); f.coordinator.flushReports();
  const successReportID = f.coordinator.get(id).report_message_id;
  assert.ok(successReportID);
  assert.notEqual(successReportID, failedReportID);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n,1);
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
  const retry = f.coordinator.retryDispatch(f.source,f.role.agentId,id);
  assert.equal(retry.status,"running");
  assert.equal(retry.retryAction,"reuse_running");
  assert.equal(retry.originalTurnId,"adopted-turn");
  f.coordinator.recover();
  assert.equal(f.coordinator.get(id).status, "running");
  f.store.db.run(`INSERT INTO session_items(id,session_id,turn_id,turn_status,type,title,text,binding_id,presentation_role,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, ["final:adopted", child.current_session_id, turn.turnId, "completed", "agentMessage", "Result", "Exact child result", turn.bindingId, "final_answer", new Date().toISOString()]);
  f.store.upsertSessionTurn({ ...turn, executionStatus: "completed" });
  assert.equal(f.coordinator.retryDispatch(f.source,f.role.agentId,id).status,"completed");
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

test("child deletion selects Artifact disposal without confirmation and preserves exact parent scope", async t => {
  const f = await fixture(t);
  const child = f.child("Unused_child");
  const calls = [];
  f.coordinator.deletion = { inspect: async (_id, actor) => { calls.push(actor); return { artifacts: [] }; },
    request: async (id, input, actor) => ({ accepted: true, id, input, actor }) };
  const result = await f.collaboration.deleteChildTask(f.source, f.role.agentId, { childTaskId: child.id, idempotencyKey: "delete-one" });
  assert.equal(result.actor.type, "parent_session");
  assert.equal(result.actor.id, "logical:parent");
  assert.equal(result.input.mode, "force");
  assert.equal(result.input.artifactDisposition, "retain");
  assert.equal(Object.hasOwn(result.input, "acknowledgeDataLoss"), false);
  f.coordinator.deletion.inspect = async () => ({ artifacts: [{ artifactId: "artifact:unpreserved" }] });
  const discarded = await f.collaboration.deleteChildTask(f.source, f.role.agentId, { childTaskId: child.id, idempotencyKey: "delete-two", artifactDisposition: "delete", stopRunning: true });
  assert.equal(discarded.input.artifactDisposition, "delete");
  assert.equal(discarded.input.stopRunning, true);
  await assert.rejects(f.collaboration.deleteChildTask(f.source, f.role.agentId, { childTaskId: f.parent.id, idempotencyKey: "bad-delete" }), { code: "TASK_PARENT_OUTSIDE_SCOPE" });
  assert.equal(calls.length, 0);
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

test("parent deletion resumes failed receipt through the authorized deletion service", async t => {
  const f = await fixture(t);
  const child = f.child("Retry_disposable");
  const composition = createTaskExecutionComposition({ store: f.store, workService: f.workService,
    inspectTaskWorktree: async () => ({ status: "none", worktree: null }), removeTaskDeletionWorktree: async () => ({}),
    sessionApplicationService: { deleteSessionForTaskDeletion: async () => ({ providerDeleted: true }) }, artifactService: {}, emitEvent() {},
    ensureTaskWorkspace: async () => ({}) });
  const deletion = composition.taskDeletionService;
  f.coordinator.deletion = deletion;
  let attempts = 0;
  deletion.handleArtifacts = async () => {
    if (++attempts === 1) throw Object.assign(new Error("transient"), { code: "ARTIFACT_IDEMPOTENCY_CONFLICT" });
    return { artifactIds: [] };
  };
  const input = { childTaskId: child.id, idempotencyKey: "parent-retry", artifactDisposition: "work" };
  const first = await f.collaboration.deleteChildTask(f.source, f.role.agentId, input);
  await deletion.inFlight.get(first.operation.operationId);
  assert.equal(deletion.getOperation(first.operation.operationId).state, "failed");
  await f.collaboration.deleteChildTask(f.source, f.role.agentId, { ...input, inspectOnly: true });
  assert.equal(attempts, 1);
  const retry = await f.collaboration.deleteChildTask(f.source, f.role.agentId, input);
  assert.equal(retry.operation.operationId, first.operation.operationId);
  await deletion.inFlight.get(retry.operation.operationId);
  assert.equal(deletion.getOperation(retry.operation.operationId).state, "succeeded");
  assert.equal(attempts, 2);
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
  assert.equal(childDoc.cards.find(row => row.kind === "taskInfo").actions.some(row => row.operation === "task.coordination.update"), true);
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

test("coordination publishes processing before its planner returns on both supported Providers", async t => {
  for (const provider of ["codex-app-server", "claude-sdk"]) await t.test(provider, async t => {
    const f = await restrictedFixture(t, provider);
    const reference = f.reference();
    const binding = f.store.getAgentSessionBinding(reference.bindingId);
    const create = id => f.store.createUserMessageDelivery({ deliveryId: id, messageId: `message:${id}`,
      sessionId: reference.sessionId, binding, agentId: f.role.agentId, text: "请协调处理" });
    const admitted = create("delivery:coordination-feedback");
    create("delivery:still-queued");
    f.store.updateMessageDelivery(admitted.delivery.deliveryId, { status: "dispatching", attemptCount: 1 });
    f.store.updateAgentTask(admitted.task.taskId, { status: "running" });
    const revision = f.store.sessionTimelineRevision(reference.sessionId);
    let entered, release;
    const planning = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    f.run(async () => {
      entered();
      await held;
      return { text: JSON.stringify({ kind: "discussion", reply: "协调答复", items: [] }) };
    });
    const operation = f.application.sendMessage(reference.sessionId, "请协调处理", {
      idempotencyKey: admitted.delivery.deliveryId,
      source: { type: "desktop", deliveryId: admitted.delivery.deliveryId }, options: { agentTask: admitted.task }
    });
    try {
      await planning;
      const delivery = f.store.getMessageDelivery(admitted.delivery.deliveryId);
      assert.equal(delivery.status, "processing");
      assert.equal(delivery.providerTurnId, `coordination:${admitted.delivery.deliveryId}`);
      assert.equal(f.store.getSessionTurn(reference.sessionId, reference.bindingId, delivery.providerTurnId).execution_status, "running");
      const message = f.store.getSessionItem(reference.sessionId, admitted.delivery.messageId);
      assert.equal(message.status, "processing");
      assert.equal(message.turnId, delivery.providerTurnId);
      assert.ok(f.store.sessionTimelineRevision(reference.sessionId) > revision);
      assert.equal(f.store.getMessageDelivery("delivery:still-queued").status, "queued");
      assert.equal(f.store.getMessageDelivery("delivery:still-queued").providerTurnId, null);
      assert.ok(f.events.some(event => event.type === "SessionCoordinationStarted"));
    } finally {
      release();
      await operation;
    }
    assert.equal(f.store.settleMessageDeliveryFromTurn(admitted.delivery.deliveryId).status, "completed");
  });
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

test("queued coordination publishes processing before the planner finishes on every supported Provider", async t => {
  for (const provider of ["codex-app-server", "claude-sdk"]) await t.test(provider, async t => {
    const f = await restrictedFixture(t, provider);
    const presentation = createCollaborationTimelinePresentation({ store: f.store, collaborationCore: f.core });
    const noop = () => {};
    const publisher = createProductEventPublisher({
      store: f.store, eventLog: { append: event => ({ id: 1, ...event }) }, sseClients: new Set(),
      now: () => new Date().toISOString(), getClientDeviceGateway: () => null,
      scheduleStateSyncPublish: noop, requestTaskSummary: noop, notifySessionEventListeners: noop,
      publishDshSessionEvent: noop, handleScheduledWorkEvent: noop,
      reconcileCompletedCollaborationWork: noop, reconcileConflictResolutionSession: noop,
      ...presentation
    });
    const record = f.turns.emitEvent;
    f.turns.emitEvent = (type, payload, options) => {
      record(type, payload);
      return publisher.emitEvent(type, payload, options);
    };
    const taskId = "message:coordination-progress", messageId = "user:coordination-progress";
    f.store.enqueueAgentTask({ taskId, agentId: f.role.agentId, sessionId: f.source.sessionId,
      kind: "user", priority: 10, text: "先讨论方案", source: { type: "desktop", messageId } });
    const task = f.store.claimAgentTask(taskId);
    publisher.emitEvent("AgentWorkPreparing", { task }, { sessionId: f.source.sessionId });
    const messageState = () => JSON.parse(f.store.getSessionItem(f.source.sessionId, messageId).rawMetadataJSON).userMessageStatus;
    assert.equal(messageState(), "preparing");
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    f.run(async () => { entered(); await held; return { text: JSON.stringify({ kind: "discussion", reply: "答复", items: [] }) }; });
    const pending = f.application.sendMessage(f.source.sessionId, "先讨论方案", {
      idempotencyKey: "progress", options: { agentTask: task }, source: task.source
    });
    await started;
    try {
      assert.equal(messageState(), "processing");
      const event = f.events.find(event => event.type === "AgentWorkStarted");
      assert.equal(event.payload.task.targetTurnId, "coordination:progress");
      assert.equal(event.payload.task.source.messageId, messageId);
      assert.equal(f.store.getSessionTurn(f.source.sessionId, f.source.providerBindingId, "coordination:progress").execution_status, "running");
      assert.equal(f.events.some(event => event.type === "SessionCoordinationCompleted"), false);
    } finally {
      release();
      await pending;
    }
    assert.equal(f.terminals[0].status, "completed");
    await f.application.sendMessage(f.source.sessionId, "retry", { idempotencyKey: "progress" });
    assert.equal(f.events.filter(event => event.type === "AgentWorkStarted").length, 1);
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

test("cleanup decision reuses parent Session deletion authority and disposal options", async t => {
  const f = await restrictedFixture(t);
  const child = f.child("已交付子任务");
  let inspected = 0;
  f.coordinator.deletion = { inspect: async (id, actor) => {
    assert.equal(id, child.id); assert.equal(actor.type, "parent_session"); inspected++; return { artifacts: [] };
  }, request: async (id, input, actor) => {
    assert.equal(id, child.id); assert.equal(input.mode, "force"); assert.equal(input.artifactDisposition, "retain");
    assert.equal(actor.id, "logical:parent"); return { accepted: true, operation: { operationId: "cleanup-one" } };
  } };
  f.output({ kind: "cleanup", reply: "not an acceptance", items: [{ action: "delete", taskId: child.id, title: "", text: "", agentId: "" }] });
  await f.application.sendMessage(f.source.sessionId, "清理已交付子任务", { idempotencyKey: "cleanup" });
  assert.equal(inspected, 0);
  assert.equal(f.terminals[0].status, "completed");
});

test("mailbox source can trigger authorized follow-up; completed coordination replies advance unread semantics", async t => {
  const f = await restrictedFixture(t);
  f.output(f.instruction());
  await f.application.sendMessage(f.source.sessionId, "子任务执行结果通知", { idempotencyKey: "report", source: { type: "mailbox_event" } });
  assert.equal(f.terminals[0].status, "completed");
  assert.equal(f.coordinator.listForParent(f.parent.id).length, 1);
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

test("generated summary projection changes cannot reject an otherwise unchanged parent creation",async t=>{
 for(const provider of ["codex-app-server","claude-sdk","openclacky"]) await t.test(provider,async t=>{
  const f=await fixture(t,provider),original=f.store.assertParentForCreate.bind(f.store);let injected=false;
  f.store.assertParentForCreate=input=>{
   const result=original(input);
   if(!injected){injected=true;queueMicrotask(()=>f.store.db.run(
    "UPDATE tasks SET user_summary_json=?,resource_version=resource_version+1 WHERE id=?",
    [JSON.stringify({state:'stale',content:{focus:'Projection changed'}}),f.parent.id]));}
   return result;
  };
  const accepted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('summary')]});
  await f.coordinator.runDispatch(accepted.dispatches[0].dispatchId);
  assert.equal(f.coordinator.get(accepted.dispatches[0].dispatchId).status,'queued');assert.equal(f.starts.length,1);
  assert.equal(f.store.selectOne('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?',[f.parent.id]).n,1);
 });
});

for(const provider of ['codex-app-server','claude-sdk','openclacky']) test(`dispatch blockage remains state-only and a cancelled child can receive new instructions (${provider})`,async t=>{
 const {createRuntimeAgentWorkQueue}=await import('../src/runtime/runtimeAgentWorkQueue.mjs');
 const f=await fixture(t,provider);
 const accepted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('blocked-report')]});
 const id=accepted.dispatches[0].dispatchId;await f.coordinator.runDispatch(id);
 const dispatch=f.coordinator.get(id),child=f.store.getTask(dispatch.target_task_id),childSession=child.current_session_id;
 const logical=f.store.getLogicalSessionByLegacySessionId(childSession).logicalSessionId;
 f.store.db.run("UPDATE sessions SET status='cancelled' WHERE id=?",[childSession]);
 f.store.db.run("UPDATE sessions SET status='complete' WHERE id=?",[f.source.sessionId]);
 let sends=0;
 const queue=createRuntimeAgentWorkQueue({store:f.store,collaborationCore:f.core,sessionMailbox:f.mailbox,
  sessionChannelService:{},collaborationDispatcher:{},workspaceContinuationCoordinator:{recordWorkStarted(){},recordWorkSettled(){},recordWorkRequeued(){},assertWorkTarget(){}},
  inspectCollaborationSession:async()=> 'idle',resolveCollaborationDeliveryRoute:async()=>{},scheduleAgentWorkDrain(){},dispatchSessionChannelDelivery:async()=>{},
  sendUnifiedSessionMessage:async()=>{sends++;return {result:{turnId:'turn:new'}};},
  emitEvent:(type,payload)=>f.coordinator.onRuntimeEvent(type,payload),
  syncSessionChannelDeliveriesIntoAgentWorkQueue:async()=>{},syncCollaborationDeliveriesIntoAgentWorkQueue:async()=>{}});
 f.mailbox.setPaused(logical,true);queue.registerRuntimeQueuedWork(childSession,dispatch.operation_id);
 for(let i=0;i<3;i++)await queue.drainAgentWork(childSession);
 assert.equal(sends,0);assert.equal(f.coordinator.get(id).status,'blocked');assert.equal(f.coordinator.get(id).error_code,'MAILBOX_PAUSED');
 assert.equal(f.mailbox.get(logical,dispatch.mailbox_message_id).dispatchBlock.code,'MAILBOX_PAUSED');
 f.coordinator.flushReports();
 let reports=f.store.selectAll("SELECT * FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'");
 assert.equal(reports.length,0);
 assert.equal(f.store.listTaskCoordinationDispatches(f.parent.id)[0].errorMessage,'接收会话的邮箱已暂停自动处理。');
 f.coordinator.flushReports();assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n,0);
 f.mailbox.setPaused(logical,false);await queue.drainAgentWork(childSession);
 assert.equal(sends,1);assert.equal(f.coordinator.get(id).status,'running');assert.equal(f.coordinator.get(id).error_code,null);
 assert.equal(f.store.getAgentTask(dispatch.operation_id).source.dispatchBlock,undefined);

});

test('ordinary child mailbox failures retain their state without generating parent messages',async t=>{
 const f=await fixture(t);
 const admitted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('ordinary-report')]});
 await f.coordinator.runDispatch(admitted.dispatches[0].dispatchId);
 const child=f.store.getTask(f.coordinator.get(admitted.dispatches[0].dispatchId).target_task_id);
 const logical=f.store.getLogicalSessionByLegacySessionId(child.current_session_id).logicalSessionId;
 const message=f.mailbox.receiveEvent({recipientSessionId:logical,sourceType:'background',sourceId:'direct-parent-message',intent:'action_required',
  body:'New instruction',idempotencyKey:'direct-parent-message',authorization:{ownerLogicalSessionId:logical,sourceId:'direct-parent-message',sourceSessionId:'logical:parent'}});
 const raw=f.mailbox.raw(logical,message.messageId),work=f.store.getAgentTask(raw.operation_id);
 const blocked=f.store.updateAgentTask(work.taskId,{lastError:'工作区有冲突',source:{...work.source,
  dispatchBlock:{code:'WORKTREE_CONFLICT_OR_RECOVERY',message:'工作区有冲突',kind:'waiting'}}});
 f.mailbox.reportDispatchBlock(blocked);f.mailbox.reportDispatchBlock(blocked);
 const reports=f.store.selectAll("SELECT * FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'");
 assert.equal(reports.length,0);
 assert.equal(f.store.getAgentTask(work.taskId).source.dispatchBlock.reportMessageId,undefined);
 const other=f.store.createTask({workId:f.work.id,title:'Unrelated_parent',mainAgentId:f.role.agentId});f.open('unrelated-origin',other.id);
 const wrong=f.mailbox.receiveEvent({recipientSessionId:logical,sourceType:'background',sourceId:'wrong-origin',intent:'action_required',body:'Another instruction',
  idempotencyKey:'wrong-origin',authorization:{ownerLogicalSessionId:logical,sourceId:'wrong-origin',sourceSessionId:'logical:unrelated-origin'}});
 const wrongWork=f.store.getAgentTask(f.mailbox.raw(logical,wrong.messageId).operation_id);
 f.mailbox.reportDispatchBlock(f.store.updateAgentTask(wrongWork.taskId,{source:{...wrongWork.source,dispatchBlock:{code:'MAILBOX_PAUSED',message:'Paused',kind:'paused'}}}));
 assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:unrelated-origin'").n,0);
 assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n,0);
});

const readQuery = (tool, fields = {}) => ({ tool, taskId: null, sessionId: null, query: null,
  cursor: null, messageId: null, offset: 0, limit: 6, ...fields });
function historyItem(f, sessionId, id, text, createdAt = '2026-11-01T00:00:00.000Z') {
  f.store.upsertTimelineItemProjection(sessionId, { id, turnId: `turn:${id}`, type: 'agentMessage',
    presentationRole: 'final_answer', text, status: 'completed', createdAt });
}

for (const provider of ['codex-app-server', 'claude-sdk']) test(`parent reads child history and summarizes without delegating (${provider})`, async t => {
  const f = await restrictedFixture(t, provider), child = f.child('历史查询');
  const meta = f.open('history-reader', child.id);
  historyItem(f, meta.sessionId, 'history-answer', '已完成接口设计与八项任务划分');
  f.run(async input => {
    assert.equal(input.executionPolicy, 'no-tools'); assert.equal(input.permissionProfile, 'read-only');
    assert.equal(input.allowProviderFallback, false);
    const context = JSON.parse(input.prompt);
    assert.equal(Object.hasOwn(context, 'notificationOnly'), false);
    if (!context.readResults.length) return { text: JSON.stringify({ kind: 'read', reply: '', items: [],
      queries: [readQuery('read_messages', { taskId: child.id, sessionId: meta.sessionId, query: '任务划分' })] }) };
    assert.match(context.readResults[0].result.items[0].text, /八项任务划分/);
    return { text: JSON.stringify({ kind: 'discussion', reply: '子任务已完成接口设计与八项任务划分。', items: [], queries: [] }) };
  });
  await f.application.sendMessage(f.source.sessionId, '汇总子任务目前的结果', { idempotencyKey: 'read-summary', source: { type: 'mailbox_event' } });
  assert.equal(f.terminals[0].status, 'completed'); assert.equal(f.requests.length, 2);
  assert.equal(f.coordinator.listForParent(f.parent.id).length, 0); assert.equal(f.starts.length, 0);
  assert.equal(f.events.filter(e => e.type === 'SessionCoordinationRead').length, 1);
  assert.match(f.events.at(-1).payload.item.text, /八项任务划分/);
});

test('mailbox wakeup reads child results then dispatches the next authorized step', async t => {
  const f = await restrictedFixture(t), child = f.child('交付结果'), meta = f.open('delivery-read', child.id);
  historyItem(f, meta.sessionId, 'delivery-result', '规划已完成，可以启动开发');
  f.run(async input => {
    const ctx = JSON.parse(input.prompt);
    if (!ctx.readResults.length) return { text: JSON.stringify({ kind: 'read', reply: '', items: [],
      queries: [readQuery('read_message', { taskId: child.id, sessionId: meta.sessionId, messageId: 'delivery-result' })] }) };
    assert.match(ctx.readResults[0].result.item.text, /规划已完成/);
    return { text: JSON.stringify(f.instruction()) };
  });
  await f.application.sendMessage(f.source.sessionId, '按已授权的规划继续实施', { idempotencyKey: 'read-dispatch', source: { type: 'mailbox_event' } });
  assert.equal(f.terminals[0].status, 'completed'); assert.equal(f.coordinator.listForParent(f.parent.id).length, 1);
});

test('read port scopes historical Sessions, searches long messages and preserves Unicode chunk offsets', async t => {
  const f = await restrictedFixture(t), child = f.child('历史记录');
  const old = f.open('old-history', child.id), current = f.open('new-history', child.id);
  const read = new CoordinationReadService({ store: f.store, mailbox: f.mailbox });
  const execute = query => read.execute(f.reference(), f.parent.id, query);
  historyItem(f, old.sessionId, 'long-history', '😀'.repeat(7000) + '定位命中尾部');
  historyItem(f, old.sessionId, 'literal-history', 'literal 10%_\\path');
  const sessions = execute(readQuery('list_sessions', { taskId: child.id }));
  assert.deepEqual(new Set(sessions.items.map(s => s.id)), new Set([old.sessionId, current.sessionId]));
  const found = execute(readQuery('read_messages', { taskId: child.id, sessionId: old.sessionId, query: '定位命中' }));
  assert.equal(found.items.length, 1); assert.match(found.items[0].text, /定位命中尾部/);
  assert.ok(found.items[0].offset > 6000); assert.equal(found.items[0].textTruncated, true);
  const chunk = execute(readQuery('read_message', { taskId: child.id, sessionId: old.sessionId, messageId: 'long-history' }));
  assert.equal(chunk.nextOffset, 1600); assert.equal(Array.from(chunk.item.text).length, 1600);
  const next = execute(readQuery('read_message', { sessionId: old.sessionId, messageId: 'long-history', offset: chunk.nextOffset }));
  assert.equal(next.nextOffset, 3200); assert.equal(Array.from(next.item.text).length, 1600);
  assert.equal(execute(readQuery('read_messages', { sessionId: old.sessionId, query: '10%_\\path' })).items.length, 1);
  const other = f.store.createTask({ workId: f.work.id, title: '其他父任务', mainAgentId: f.role.agentId });
  const outside = f.open('outside-history', other.id), sibling = f.child('另一个子任务'), siblingSession = f.open('sibling-history', sibling.id);
  for (const query of [readQuery('read_task', { taskId: other.id }), readQuery('read_messages', { sessionId: outside.sessionId }),
    readQuery('read_messages', { taskId: child.id, sessionId: siblingSession.sessionId })]) {
    assert.throws(() => execute(query), e => /OUTSIDE_SCOPE/.test(e.code));
  }
  assert.throws(() => read.execute({ ...f.reference(), bindingId: 'stale' }, f.parent.id, readQuery('list_children')), { code: 'COORDINATION_READ_SCOPE_INVALID' });
  assert.throws(() => execute(readQuery('shell')), { code: 'COORDINATION_READ_TOOL_UNSUPPORTED' });
});

test('read pagination stays complete after byte trimming and mailbox inspection never acknowledges messages', async t => {
  const f = await restrictedFixture(t), child = f.child('分页'), meta = f.open('page-history', child.id);
  const read = new CoordinationReadService({ store: f.store, mailbox: f.mailbox });
  const execute = query => read.execute(f.reference(), f.parent.id, query);
  for (let i = 0; i < 8; i++) historyItem(f, meta.sessionId, `page-${i}`, '汉'.repeat(800), `2026-11-01T00:00:0${i}.000Z`);
  let cursor = null; const seen = [];
  do {
    const result = execute(readQuery('read_messages', { sessionId: meta.sessionId, limit: 6, cursor }));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
    seen.push(...result.items.map(i => i.id)); cursor = result.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 8); assert.equal(seen.length, 8);
  const message = f.mailbox.receiveEvent({ recipientSessionId: 'logical:parent', sourceType: 'background', sourceId: 'read-test',
    body: '只读邮箱测试', intent: 'response_required', idempotencyKey: 'read-test',
    authorization: { ownerLogicalSessionId: 'logical:parent', sourceId: 'read-test' } });
  const before = f.mailbox.raw('logical:parent', message.messageId);
  assert.equal(execute(readQuery('read_mailbox')).messages.length, 1);
  assert.equal(execute(readQuery('read_mailbox', { messageId: message.messageId })).body, '只读邮箱测试');
  assert.deepEqual(f.mailbox.raw('logical:parent', message.messageId), before);
});

test('read rounds are bounded, invalid tools cannot execute and policy changes fence follow-up dispatch', async t => {
  for (const mode of ['exhaustion', 'invalid', 'policy']) await t.test(mode, async t => {
    const f = await restrictedFixture(t);
    f.run(async input => {
      const ctx = JSON.parse(input.prompt);
      if(mode==='exhaustion' && f.requests.length>=4) return {text:JSON.stringify({kind:'discussion',reply:'已完成多轮查询',items:[],queries:[]})};
      if (mode === 'policy' && ctx.readResults.length) {
        f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
        return { text: JSON.stringify(f.instruction()) };
      }
      return { text: JSON.stringify({ kind: 'read', reply: '', items: [],
        queries: [readQuery(mode === 'invalid' ? 'write_file' : 'list_children')] }) };
    });
    await f.application.sendMessage(f.source.sessionId, '查询', { idempotencyKey: mode });
    assert.equal(f.terminals[0].status, mode==='exhaustion' ? 'completed' : 'failed'); assert.equal(f.coordinator.listForParent(f.parent.id).length, 0);
    const turn = f.store.getSessionTurn(f.source.sessionId, f.reference().bindingId, `coordination:${mode}`);
    if(mode==='exhaustion') {assert.equal(f.requests.length,4);return;}
    assert.match(turn.failure_json, new RegExp(mode === 'exhaustion' ? 'COORDINATION_READ_LIMIT' : mode === 'invalid' ? 'COORDINATION_PLAN_INVALID' : 'COORDINATION_POLICY_CHANGED'));
    assert.equal(f.requests.length, mode === 'exhaustion' ? 3 : mode === 'invalid' ? 1 : 2);
  });
});

for (const provider of ['codex-app-server', 'claude-sdk']) test(`coordination gives each model round its own deadline (${provider})`, async t => {
  let clock = 1000;
  const f = await restrictedFixture(t, provider, true, { now: () => clock });
  f.run(async input => {
    const count = JSON.parse(input.prompt).readResults.length;
    assert.equal(input.timeoutMs, 120000);
    clock += count === 0 ? 9000 : 60000;
    return { text: JSON.stringify(count === 0 ? { kind: 'read', reply: '', items: [], queries: [readQuery('read_task')] }
      : { kind: 'discussion', reply: '查询完成', items: [], queries: [] }) };
  });
  await f.application.sendMessage(f.source.sessionId, '汇总', { idempotencyKey: 'round-budgets', source: { type: 'mailbox_event' } });
  assert.equal(f.terminals[0].status, 'completed'); assert.equal(f.requests.length, 2);
  assert.ok(f.events.some(e => e.payload.stage === 'reading'));
});

test('model and total deadlines save read progress and yield to the existing queue', async t => {
  for (const mode of ['call', 'total']) await t.test(mode, async t => {
    let clock = 0;
    const f = await restrictedFixture(t, 'codex-app-server', true, { now: () => clock });
    f.run(async input => {
      const count = JSON.parse(input.prompt).readResults.length;
      if (count < 2) {
        assert.equal(input.timeoutMs, 120000); clock += 110000;
        return { text: JSON.stringify({ kind: 'read', reply: '', items: [], queries: [readQuery('read_task')] }) };
      }
      assert.equal(input.timeoutMs, 80000);
      if (mode === 'total') clock += 80000;
      throw Object.assign(new Error('Timed out while waiting for the Codex ephemeral turn.'), { code: 'BACKGROUND_TIMEOUT' });
    });
    const receipt=await f.application.sendMessage(f.source.sessionId, '查询后继续', { idempotencyKey: 'time-' + mode });
    assert.equal(f.terminals[0].status, 'completed'); assert.equal(f.requests.length, 3);
    const turn = f.store.getSessionTurn(f.source.sessionId, f.reference().bindingId, 'coordination:time-' + mode);
    assert.equal(turn.failure_json,null);
    const operation=f.store.getAgentTask(receipt.continuation.operationId);
    assert.equal(operation.status,'queued');assert.equal(operation.priority,10);
    assert.equal(operation.source.coordinationContinuation.successfulReads,2);
    assert.equal(operation.source.coordinationContinuation.message,'查询后继续');
    assert.equal(f.coordinator.listForParent(f.parent.id).length,0);

  });
});

test('model waiting warning uses existing activity status and timer is cleared on settlement', async t => {
  const timers = [], cleared = [];
  const f = await restrictedFixture(t, 'codex-app-server', true, {
    schedule: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    cancelTimer: timer => cleared.push(timer)
  });
  f.run(async () => {
    assert.equal(timers[0].ms, 20000); timers[0].callback();
    assert.equal(f.store.getSession(f.source.sessionId).activityStatus, '正在等待模型返回，可停止');
    return { text: JSON.stringify({ kind: 'discussion', reply: '好了', items: [] }) };
  });
  await f.application.sendMessage(f.source.sessionId, '讨论', { idempotencyKey: 'warning' });
  assert.deepEqual(cleared, timers); assert.equal(f.store.getSession(f.source.sessionId).activityStatus, null);
});

test('interrupt after child queries prevents subsequent admission without retry', async t => {
  const f = await restrictedFixture(t);
  f.run(async input => {
    if (!JSON.parse(input.prompt).readResults.length) return { text: JSON.stringify({ kind: 'read', reply: '', items: [], queries: [readQuery('read_task')] }) };
    await f.turns.interrupt(f.reference());
    return { text: JSON.stringify(f.instruction()) };
  });
  await f.application.sendMessage(f.source.sessionId, '查询后执行', { idempotencyKey: 'stop-after-read' });
  assert.equal(f.terminals[0].status, 'cancelled'); assert.equal(f.requests.length, 2);
  assert.equal(f.coordinator.listForParent(f.parent.id).length, 0);
});

for(const provider of ['codex-app-server','claude-sdk','openclacky']) test(`cross-turn creation reuses pending receipt and reports changed definition (${provider})`,async t=>{
 const f=await fixture(t,provider);
 const first=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('pending-slot')]});
 const id=first.dispatches[0].dispatchId;
 f.coordinator.update(id,{status:'waiting_workspace',error_code:'TASK_HIERARCHY_BUSY'});
 const same={...f.item('pending-slot'),idempotencyKey:'another-turn'};
 const repeated=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[same]});
 assert.equal(repeated.dispatches[0].dispatchId,id);assert.equal(repeated.dispatches[0].reused,true);
 const changed=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[{...same,idempotencyKey:'third-turn',
  creation:{...same.creation,description:'补充新的实现范围'}}]});
 assert.equal(changed.dispatches[0].dispatchId,id);assert.equal(changed.dispatches[0].definitionChanged,true);
 assert.match(changed.dispatches[0].reuseMessage,/未覆盖/);
 assert.equal(f.store.selectOne('SELECT COUNT(*) AS n FROM task_coordination_dispatches WHERE parent_task_id=?',[f.parent.id]).n,1);
 assert.equal(f.coordinator.get(id).status,'waiting_workspace');
});

test('legacy pending duplicates restored concurrently create only one child and one mailbox instruction',async t=>{
 const f=await fixture(t),first=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('legacy-duplicate')]});
 const original=first.dispatches[0].dispatchId;
 // Simulate records created by the old release, before cross-turn reuse existed.
 f.store.db.run(`UPDATE task_coordination_dispatches SET status='waiting_workspace',created_at='2026-01-01T00:00:00Z' WHERE dispatch_id=?`,[original]);
 f.store.db.run(`INSERT INTO task_coordination_dispatches
  (dispatch_id,source_session_id,parent_task_id,source_role_id,idempotency_key,request_json,runtime_json,mode_at_admission,status,created_at,updated_at)
  SELECT 'dispatch:legacy-duplicate',source_session_id,parent_task_id,source_role_id,'legacy-second-key',request_json,runtime_json,mode_at_admission,'waiting_workspace','2026-01-02T00:00:00Z',updated_at
  FROM task_coordination_dispatches WHERE dispatch_id=?`,[original]);
 await Promise.all([f.coordinator.runDispatch(original),f.coordinator.runDispatch('dispatch:legacy-duplicate')]);
 assert.equal(f.starts.length,1);
 assert.equal(f.store.selectOne('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?',[f.parent.id]).n,1);
 assert.equal(f.coordinator.get('dispatch:legacy-duplicate').status,'cancelled');
 assert.equal(f.coordinator.get('dispatch:legacy-duplicate').error_code,'TASK_CREATION_DUPLICATE');
 assert.match(f.coordinator.get('dispatch:legacy-duplicate').error_message,new RegExp(original));
 assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE json_extract(authorization_json,'$.purpose')='child_instruction'").n,1);
 const canonical=f.coordinator.get(original);f.coordinator.update(original,{status:'completed'});
 const repeated=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[{...f.item('legacy-duplicate'),idempotencyKey:'retry-after-completion'}]});
 assert.equal(repeated.dispatches[0].targetTaskId,canonical.target_task_id);assert.equal(repeated.dispatches[0].reused,true);
 assert.equal(f.starts.length,1);
});

test('distinct creation slots and separate parents still create independently',async t=>{
 const f=await fixture(t);
 const accepted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('independent-a'),f.item('independent-b')]});
 await Promise.all(accepted.dispatches.map(row=>f.coordinator.runDispatch(row.dispatchId)));
 assert.equal(f.starts.length,2);assert.notEqual(accepted.dispatches[0].dispatchId,accepted.dispatches[1].dispatchId);
});

test('progress batch persists one stable card across dispatch updates and coalesces reuse of a child',async t=>{
 const f=await fixture(t);
 const accepted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('progress')]},{sourceTurnId:'parent-turn:one'});
 const dispatch=accepted.dispatches[0].dispatchId;await f.coordinator.runDispatch(dispatch);
 const service=f.coordinator.progress,first=service.refresh(accepted.batchId);
 assert.equal(first.total,1);assert.equal(first.counts.queued,1);
 const id='coordination-progress:'+accepted.batchId;
 const original=f.store.getSessionItem(f.source.sessionId,id);
 assert.ok(original);const beforeRevision=first.revision;
 f.coordinator.update(dispatch,{status:'running'});
 const second=service.refresh(accepted.batchId);assert.equal(second.revision,beforeRevision+1);
 assert.equal(second.items[0].assignmentId,first.items[0].assignmentId);
 assert.equal(f.store.getSessionItem(f.source.sessionId,id).createdAt,original.createdAt);
 assert.equal(service.refresh(accepted.batchId).revision,second.revision);
 const child=f.coordinator.get(dispatch).target_task_id;
 const sent=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[{action:'send',taskId:child,text:'补充同一批要求',idempotencyKey:'progress-send'}]},
  {sourceTurnId:'parent-turn:two',batchId:accepted.batchId});
 assert.equal(service.refresh(accepted.batchId).total,1);assert.equal(sent.batchId,accepted.batchId);
 assert.equal(service.page('logical:parent',accepted.batchId).items.length,1);
 const other=f.store.createTask({workId:f.work.id,title:'Other',mainAgentId:f.role.agentId}),meta=f.open('foreign-progress',other.id);
 assert.throws(()=>service.page(meta.sessionId,accepted.batchId),{code:'COORDINATION_PROGRESS_NOT_FOUND'});
});

test('ordinary child mailbox reports update progress without adding a parent reply; direct user answers remain visible',async t=>{
 const f=await restrictedFixture(t);
 const accepted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('quiet-report')]},{sourceTurnId:'quiet-batch'});
 const id=accepted.dispatches[0].dispatchId;await f.coordinator.runDispatch(id);
 const row=f.coordinator.get(id),child=f.store.getTask(row.target_task_id);
 f.output({kind:'discussion',reply:'这一轮报告已核实',items:[],queries:[],presentation:'progress',batchId:accepted.batchId,
  progressUpdates:[{taskId:child.id,summary:'接口已实现，等待联调'}],focus:'继续其他独立开发',decision:''});
 await f.application.sendMessage(f.source.sessionId,'子任务报告',{idempotencyKey:'quiet-report',source:{type:'mailbox_event',coordinationDispatchId:id,coordinationPurpose:'parent_report'}});
 assert.equal(f.terminals[0].status,'completed');assert.equal(f.events.at(-1).payload.hasAgentMessage,false);
 assert.equal(f.events.at(-1).payload.item,undefined);
 const progress=f.coordinator.progress.refresh(accepted.batchId);assert.equal(progress.items[0].summary,'接口已实现，等待联调');
 assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_items WHERE session_id=? AND type='agentMessage'",[f.source.sessionId]).n,0);
 f.output({kind:'discussion',reply:'这是对用户的回答',items:[]});
 await f.application.sendMessage(f.source.sessionId,'解释一下',{idempotencyKey:'direct-answer'});
 assert.equal(f.events.at(-1).payload.item.text,'这是对用户的回答');
});

test('separate batches keep their own execution receipt and scope amendments to assigned children',async t=>{
 const f=await fixture(t),one=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('batch-one')]},{sourceTurnId:'one'});
 await f.coordinator.runDispatch(one.dispatches[0].dispatchId);
 const child=f.coordinator.get(one.dispatches[0].dispatchId).target_task_id;
 f.coordinator.update(one.dispatches[0].dispatchId,{status:'completed'});
 const two=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[{action:'send',taskId:child,text:'全新工作',idempotencyKey:'new-batch'}]},{sourceTurnId:'two'});
 await f.coordinator.runDispatch(two.dispatches[0].dispatchId);
 assert.notEqual(one.batchId,two.batchId);
 assert.equal(f.coordinator.progress.refresh(one.batchId).counts.needs_review,1);
 assert.equal(f.coordinator.progress.refresh(two.batchId).counts.queued,1);
 const before=f.coordinator.progress.refresh(two.batchId);
 f.coordinator.progress.annotate(two.batchId,{updates:[{taskId:'task:foreign',summary:'不可写入'}]});
 assert.equal(f.coordinator.progress.refresh(two.batchId).items[0].summary,before.items[0].summary);
 assert.equal(f.coordinator.progress.milestone(two.batchId,'decision:one','需要用户决定'),true);
 assert.equal(f.coordinator.progress.milestone(two.batchId,'decision:one','需要用户决定'),false);
 assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_items WHERE session_id=? AND id LIKE 'coordination-summary:%'",[f.source.sessionId]).n,1);
});

test('progress report reading is bounded and cannot read an unrelated child message',async t=>{
 const f=await fixture(t),accepted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('report-read')]},{sourceTurnId:'report-reader'});
 const id=accepted.dispatches[0].dispatchId;await f.coordinator.runDispatch(id);
 const child=f.store.getTask(f.coordinator.get(id).target_task_id);
 historyItem(f,child.current_session_id,'progress-report','😀'.repeat(2000));
 f.coordinator.progress.correlateReports(id,'progress-report');
 const snapshot=f.coordinator.progress.refresh(accepted.batchId),assignment=snapshot.items[0].assignmentId;
 const report=f.coordinator.progress.report('logical:parent',accepted.batchId,assignment);
 assert.equal(report.nextOffset,1600);assert.equal(Array.from(report.text).length,1600);
 const other=f.child('Foreign_report'),meta=f.open('foreign-report',other.id);
 historyItem(f,meta.sessionId,'foreign-report-message','private');
 f.coordinator.progress.correlateReports(id,'foreign-report-message');
 assert.throws(()=>f.coordinator.progress.report('logical:parent',accepted.batchId,assignment),{code:'COORDINATION_PROGRESS_NOT_FOUND'});
});

test('progress survives a service restart and manual children use the same projection',async t=>{
 const f=await fixture(t);
 f.store.db.run('UPDATE tasks SET current_session_id=? WHERE id=?',[f.source.sessionId,f.parent.id]);
 const child=f.child('Manual_progress');f.open('manual-progress',child.id);
 f.coordinator.progress.adoptManualTask(child.id);
 const batch=f.store.selectOne('SELECT batch_id FROM coordination_progress_assignments WHERE task_id=?',[child.id]);
 assert.ok(batch);
 const first=f.coordinator.progress.refresh(batch.batch_id);
 const restored=new (f.coordinator.progress.constructor)(f.store);
 assert.deepEqual(restored.latest(f.parent.id),first);
 assert.equal(restored.page('logical:parent',batch.batch_id).items[0].taskId,child.id);
 assert.equal(restored.reportBatch({type:'mailbox_event',coordinationPurpose:'parent_report'},'logical:parent'),null);
});

test('paired progress pages allow their bounded query, require credentials and reject another Session',async t=>{
 const f=await fixture(t),accepted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('mobile-progress')]},{sourceTurnId:'mobile-progress'});
 await f.coordinator.runDispatch(accepted.dispatches[0].dispatchId);f.coordinator.progress.refresh(accepted.batchId);
 const authority=new ClientDeviceAuthority(join(f.store.dataRoot,'test-progress-devices'));await authority.initialize();
 const invite=authority.invite(),claim=authority.claim({...invite,name:'Test iPhone'});await authority.approve(invite.pairingId,true);
 const credentials=await authority.exchange(claim);
 const resolveSession=id=>{const route=f.store.getLogicalSession(id)??f.store.getLogicalSessionByLegacySessionId(id);return{sessionId:route?.legacySessionId??id,logicalSessionId:route?.logicalSessionId??id};};
 const gateway=new ClientDeviceGateway(authority,{detailActionService:{},sessionAPI:{inspector:new ClientInspectorAPI({store:f.store,resolveSession})}});
 const server=createServer((request,response)=>gateway.handle(request,response));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const root=`http://127.0.0.1:${server.address().port}/client/v1/sessions/`;
 const headers={authorization:`Bearer ${credentials.accessToken}`};
 const path=`logical:parent/coordination-progress/${accepted.batchId}?offset=0`;
 const page=await fetch(root+path,{headers});assert.equal(page.status,200,await page.clone().text());assert.equal((await page.json()).items.length,1);
 assert.equal((await fetch(root+path)).status,401);
 const child=f.store.getTask(f.coordinator.get(accepted.dispatches[0].dispatchId).target_task_id);
 assert.equal((await fetch(root+`${child.current_session_id}/coordination-progress/${accepted.batchId}?offset=0`,{headers})).status,404);
 assert.equal((await fetch(root+path+'&arbitrary=1',{headers})).status,403);
});

test('late completion reports cannot overwrite the latest instruction summary for that child',async t=>{
 const f=await fixture(t),one=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('late-progress')]},{sourceTurnId:'late-one'});
 await f.coordinator.runDispatch(one.dispatches[0].dispatchId);
 const taskId=f.coordinator.get(one.dispatches[0].dispatchId).target_task_id;
 const two=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[{action:'send',taskId,text:'后续工作',idempotencyKey:'late-two'}]},
  {sourceTurnId:'late-two',batchId:one.batchId});
 await f.coordinator.runDispatch(two.dispatches[0].dispatchId);
 f.coordinator.progress.annotate(one.batchId,{updates:[{taskId,summary:'正在处理后续工作'}]});
 const snapshot=f.coordinator.progress.annotate(one.batchId,{updates:[{taskId,summary:'旧工作已结束'}],reportDispatchIds:[one.dispatches[0].dispatchId]});
 assert.equal(snapshot.items[0].summary,'正在处理后续工作');
});


test("large dispatches use one existing progress batch and admit each item without waiting for startup",async t=>{
  const f=await fixture(t);
  const receipt=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:Array.from({length:23},(_,i)=>f.item(`chunk-${i}`))});
  assert.equal(receipt.accepted,true);assert.equal(receipt.dispatches.length,23);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM coordination_progress_batches").count,1);
  for(const row of receipt.dispatches) await f.coordinator.runDispatch(row.dispatchId);
  assert.equal(f.starts.length,23);
});


for (const provider of ['codex-app-server','claude-sdk']) test(`saved continuation resumes reads and dispatches only once (${provider})`,async t=>{
 let clock=0;
 const f=await restrictedFixture(t,provider,true,{now:()=>clock});
 f.run(async input=>{
   if(!JSON.parse(input.prompt).readResults.length) return {text:JSON.stringify({kind:'read',reply:'',items:[],queries:[readQuery('list_children')]})};
   clock+=300000;throw Object.assign(new Error('planner deadline'),{code:'BACKGROUND_TIMEOUT'});
 });
 const receipt=await f.application.sendMessage(f.source.sessionId,'原始开发要求',{idempotencyKey:'resumable'});
 const operation=f.store.getAgentTask(receipt.continuation.operationId);
 assert.equal(f.mailbox.dispatchDecision(operation).allowed,true);
 const old=f.turns;
 const restored=new CoordinationTurnService({store:f.store,registry:old.registry,dispatch:f.coordinator,resolveReference:f.reference,now:()=>clock,
  planner:{run:async input=>{
    const payload=JSON.parse(input.prompt);assert.equal(payload.message,'原始开发要求');assert.equal(payload.readResults.length,1);
    return {text:JSON.stringify(f.instruction())};
  }}});
 f.application.coordinationTurns=restored;
 const registered=[];restored.recover((sessionId,id)=>registered.push(id));assert.deepEqual(registered,[operation.taskId]);
 const context={idempotencyKey:operation.taskId,source:operation.source,options:{agentTask:operation}};
 const result=await f.application.sendMessage(f.source.sessionId,operation.text,context);
 await f.application.sendMessage(f.source.sessionId,operation.text,context);
 assert.equal(result.executionMode,'coordination');
 assert.equal(f.coordinator.listForParent(f.parent.id).length,1);
 const row=f.coordinator.listForParent(f.parent.id)[0];
 assert.equal(JSON.parse(f.coordinator.get(row.dispatchId).request_json).idempotencyKey,'coordination:resumable:0');
});

test('continuation persists unfinished read calls and executes them before replanning',async t=>{
 let clock=0;
 const f=await restrictedFixture(t,'codex-app-server',true,{now:()=>clock});
 f.run(async()=>({text:JSON.stringify({kind:'read',reply:'',items:[],queries:[readQuery('read_task'),readQuery('list_children')]})}));
 const execute=f.turns.readOnly.execute.bind(f.turns.readOnly);
 f.turns.readOnly.execute=(...args)=>{const value=execute(...args);clock=300000;return value;};
 const receipt=await f.application.sendMessage(f.source.sessionId,'分页汇总',{idempotencyKey:'unfinished-reads'});
 const operation=f.store.getAgentTask(receipt.continuation.operationId);
 assert.equal(operation.source.coordinationContinuation.pendingQueries[0].tool,'list_children');
 f.turns.readOnly.execute=execute;
 f.run(async input=>{assert.equal(JSON.parse(input.prompt).readResults.length,2);return {text:JSON.stringify({kind:'discussion',reply:'汇总完毕',items:[]})};});
 const result=await f.application.sendMessage(f.source.sessionId,operation.text,{idempotencyKey:operation.taskId,options:{agentTask:operation}});
 assert.equal(f.store.getSessionItem(f.source.sessionId,`${result.turnId}:result`).text,'汇总完毕');
});

test('mode changes retire queued continuations and cannot fall through to native execution',async t=>{
 let clock=0;const f=await restrictedFixture(t,'codex-app-server',true,{now:()=>clock});
 f.run(async input=>{if(!JSON.parse(input.prompt).readResults.length)return {text:JSON.stringify({kind:'read',reply:'',items:[],queries:[readQuery('read_task')]})};
 clock=300000;throw Object.assign(new Error('timeout'),{code:'BACKGROUND_TIMEOUT'});});
 const receipt=await f.application.sendMessage(f.source.sessionId,'查询',{idempotencyKey:'toggle-continuation'});
 const operation=f.store.getAgentTask(receipt.continuation.operationId);
 f.workService.updateTask(f.parent.id,{coordinationEnabled:false});
 assert.equal(f.store.getAgentTask(operation.taskId).status,'cancelled');
 await assert.rejects(f.application.sendMessage(f.source.sessionId,operation.text,{idempotencyKey:operation.taskId,options:{agentTask:operation}}),{code:'COORDINATION_CONTINUATION_RETIRED'});
 assert.equal(f.coordinator.listForParent(f.parent.id).length,0);
});

test('repeated unchanged reads do not generate an endless chain of continuation jobs',async t=>{
 let clock=0;const f=await restrictedFixture(t,'codex-app-server',true,{now:()=>clock});
 f.run(async input=>{if(!JSON.parse(input.prompt).readResults.length)return {text:JSON.stringify({kind:'read',reply:'',items:[],queries:[readQuery('read_task')]})};
 clock+=300000;throw Object.assign(new Error('timeout'),{code:'BACKGROUND_TIMEOUT'});});
 const receipt=await f.application.sendMessage(f.source.sessionId,'查询',{idempotencyKey:'no-loop'});
 const operation=f.store.getAgentTask(receipt.continuation.operationId);
 f.run(async input=>{if(JSON.parse(input.prompt).readResults.length===1)return {text:JSON.stringify({kind:'read',reply:'',items:[],queries:[readQuery('read_task')]})};
 clock+=300000;throw Object.assign(new Error('timeout'),{code:'BACKGROUND_TIMEOUT'});});
 const result=await f.application.sendMessage(f.source.sessionId,operation.text,{idempotencyKey:operation.taskId,options:{agentTask:operation}});
 assert.equal(result.continuation,undefined);assert.equal(f.terminals.at(-1).status,'failed');
 assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM agent_operations WHERE json_extract(source_json,'$.coordinationContinuation.version')=1").n,1);
});

test('restart restores only interrupted read checkpoints, never an uncertain write admission',async t=>{
 const f=await restrictedFixture(t);const ref=f.reference();
 f.store.upsertSessionTurn({sessionId:ref.sessionId,bindingId:ref.bindingId,routingVersion:ref.routingVersion,turnId:'coordination:root',executionStatus:'completed'});
 const checkpoint={version:1,rootTurnId:'coordination:root',rootBindingId:ref.bindingId,segment:0,taskId:f.parent.id,workId:f.work.id,
  logicalSessionId:ref.logicalSessionId,message:'查询',originalSource:{type:'desktop'},readResults:[],pendingQueries:[],successfulReads:0,phase:'reading'};
 const old=f.turns.queueContinuation(ref,checkpoint);
 const hostTurn=`coordination:${old.taskId}`;
 f.store.upsertSessionTurn({sessionId:ref.sessionId,bindingId:ref.bindingId,routingVersion:ref.routingVersion,turnId:hostTurn,executionStatus:'running'});
 f.store.updateAgentTask(old.taskId,{status:'running',targetTurnId:hostTurn});
 const registered=[];f.turns.recover((_session,id)=>registered.push(id));
 assert.equal(f.store.getAgentTask(old.taskId).status,'cancelled');assert.equal(registered.length,1);
 const next=f.store.getAgentTask(registered[0]);assert.equal(next.source.coordinationContinuation.segment,2);
 assert.equal(f.store.getSessionTurn(ref.sessionId,ref.bindingId,hostTurn).execution_status,'cancelled');
 f.store.updateAgentTask(next.taskId,{status:'running',source:{...next.source,coordinationContinuation:{...next.source.coordinationContinuation,phase:'admitting'}}});
 registered.length=0;f.turns.recover((_session,id)=>registered.push(id));assert.equal(registered.length,0);
 assert.equal(f.store.getAgentTask(next.taskId).status,'running');
});

test('continuation checkpoints survive SQLite close and reopen without an in-memory queue',async t=>{
 let clock=0;const f=await restrictedFixture(t,'codex-app-server',true,{now:()=>clock,durableStore:true});
 f.run(async input=>{if(!JSON.parse(input.prompt).readResults.length)return {text:JSON.stringify({kind:'read',reply:'',items:[],queries:[readQuery('list_children')]})};
 clock=300000;throw Object.assign(new Error('timeout'),{code:'BACKGROUND_TIMEOUT'});});
 const result=await f.application.sendMessage(f.source.sessionId,'重启后继续查询',{idempotencyKey:'durable-continuation'});
 const paths={dbPath:f.store.dbPath,configPath:f.store.configPath};
 const baseReference=f.reference();
 await f.store.close();
 const restored=new CorptieStore({...paths,manageProcessEnvironment:false});
 try {
  await restored.initialize({resolveDataPath:false});
  const operation=restored.getAgentTask(result.continuation.operationId);
  assert.equal(operation.source.coordinationContinuation.readResults.length,1);
  const reference=()=>{const route=restored.getLogicalSessionByLegacySessionId(f.source.sessionId);return {...baseReference,bindingId:route.activeBinding.bindingId};};
  const mailbox=new SessionMailboxService({store:restored});
  const turns=new CoordinationTurnService({store:restored,registry:f.turns.registry,dispatch:{mailbox,listForParent:()=>[]},resolveReference:reference,
   planner:{run:async input=>{assert.equal(JSON.parse(input.prompt).message,'重启后继续查询');return {text:JSON.stringify({kind:'discussion',reply:'已恢复',items:[]})};}}});
  const queued=[];turns.recover((_session,id)=>queued.push(id));assert.deepEqual(queued,[operation.taskId]);
  const receipt=await turns.send(reference(),operation.text,{idempotencyKey:operation.taskId,options:{agentTask:operation}});
  assert.equal(restored.getSessionItem(reference().sessionId,`${receipt.turnId}:result`).text,'已恢复');
 } finally {await restored.close();}
});

test('the original queued request checkpoints reads and marks write admission before dispatch',async t=>{
 const f=await restrictedFixture(t),ref=f.reference();
 const operation=f.store.enqueueAgentTask({taskId:'original-coordination-request',agentId:f.role.agentId,
  sessionId:ref.sessionId,kind:'user',priority:100,text:'开发原请求',source:{type:'desktop',messageId:'user:original'}});
 f.store.updateAgentTask(operation.taskId,{status:'running'});
 const accept=f.coordinator.acceptDispatch.bind(f.coordinator);
 f.coordinator.acceptDispatch=(...args)=>{
  assert.equal(f.store.getAgentTask(operation.taskId).source.coordinationContinuation.phase,'admitting');
  return accept(...args);
 };
 f.run(async input=>{
  const saved=f.store.getAgentTask(operation.taskId).source.coordinationContinuation;
  assert.equal(saved.phase,'reading');assert.equal(saved.message,'开发原请求');
  if(!JSON.parse(input.prompt).readResults.length) return {text:JSON.stringify({kind:'read',reply:'',items:[],queries:[readQuery('list_children')]})};
  assert.equal(saved.readResults.length,1);
  return {text:JSON.stringify(f.instruction())};
 });
 await f.application.sendMessage(ref.sessionId,operation.text,{idempotencyKey:'original-checkpoint',source:operation.source,options:{agentTask:operation}});
 const saved=f.store.getAgentTask(operation.taskId).source.coordinationContinuation;
 assert.equal(saved.phase,'settled');assert.deepEqual(saved.originalSource,{type:'desktop',messageId:'user:original'});
 assert.ok(Buffer.byteLength(JSON.stringify(saved))<32000);
});

test('continuations stay behind an already queued direct-user instruction',async t=>{
 const f=await restrictedFixture(t),ref=f.reference();
 f.store.upsertSessionTurn({sessionId:ref.sessionId,bindingId:ref.bindingId,routingVersion:ref.routingVersion,
  turnId:'coordination:priority',executionStatus:'completed'});
 const continuation=f.turns.queueContinuation(ref,{version:1,rootTurnId:'coordination:priority',rootBindingId:ref.bindingId,segment:0,
  taskId:f.parent.id,workId:f.work.id,logicalSessionId:ref.logicalSessionId,message:'继续查询',readResults:[],pendingQueries:[],phase:'reading'});
 f.store.enqueueAgentTask({taskId:'new-user-instruction',agentId:f.role.agentId,sessionId:ref.sessionId,kind:'user',
  priority:50,text:'新的指令',source:{type:'desktop'}});
 assert.deepEqual(f.store.listQueuedAgentTasksForSession(ref.sessionId).map(row=>row.taskId),['new-user-instruction',continuation.taskId]);
});
for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`${provider}: dispatch separate checklist items to concurrent children without completing parent items`, async t => {
    const f = await fixture(t, provider);
    const checklist = new ExecutionChecklistService({ store: f.store });
    const logical = f.store.getLogicalSessionByLegacySessionId(f.source.sessionId);
    const context = { logicalSessionId: logical.logicalSessionId, bindingId: f.source.providerBindingId, turnId: "parent-turn" };
    let serial = 0;
    const update = input => checklist.mutate(f.parent.id, { operationId: `link:${++serial}`,
      expectedRevision: checklist.read(f.parent.id)?.revision ?? 0, ...input }, context);
    update({ action: "create", steps: [{ text: "API" }, { text: "UI" }, { text: "Final verification" }] });
    const steps = checklist.read(f.parent.id).steps;
    const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("api"), f.item("ui")] });
    for (const [index, dispatch] of receipt.dispatches.entries()) {
      update({ action: "assign", itemIds: [steps[index].stepId], dispatchId: dispatch.dispatchId });
    }
    assert.equal(checklist.read(f.parent.id).completedCount, 0);
    await Promise.all(receipt.dispatches.map(d => f.coordinator.runDispatch(d.dispatchId)));
    for (const dispatch of receipt.dispatches) {
      const row = f.coordinator.get(dispatch.dispatchId);
      assert.equal(row.status, "queued");
      f.coordinator.onRuntimeEvent("AgentWorkStarted", { task: f.store.updateAgentTask(row.operation_id,{status:"running"}) });
    }
    let shown = checklist.display(checklist.read(f.parent.id));
    assert.deepEqual(shown.steps.slice(0, 2).map(s => s.assignment.status), ["running", "running"]);
    assert.notEqual(shown.steps[0].assignment.taskId, shown.steps[1].assignment.taskId);
    const first = f.coordinator.get(receipt.dispatches[0].dispatchId);
    const firstChild = f.store.getTask(first.target_task_id);
    const firstSession = f.store.getSession(firstChild.current_session_id);
    f.store.upsertSession({ ...firstSession, status: "completed", executionStatus: "completed" });
    f.coordinator.onRuntimeEvent("AgentWorkCompleted", { task: f.store.updateAgentTask(first.operation_id,{status:"completed"}) });
    shown = checklist.display(checklist.read(f.parent.id));
    assert.equal(shown.steps[0].assignment.status, "completed");
    assert.equal(shown.steps[1].assignment.status, "running");
    assert.equal(shown.completedCount, 0);
    update({ action: "status", itemId: steps[0].stepId, status: "completed" });
    assert.equal(checklist.read(f.parent.id).completedCount, 1);
    assert.equal(f.starts.length, 2);
  });
}


test('ten minutes of busy/batch/cancel telemetry creates no parent conversation or mailbox work',async t=>{
 const f=await fixture(t);
 const accepted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('quiet-status')]});
 const id=accepted.dispatches[0].dispatchId;await f.coordinator.runDispatch(id);
 const operation=f.store.getAgentTask(f.coordinator.get(id).operation_id);
 for(let minute=0;minute<10;minute++) {
  for(const code of ['SESSION_BUSY','CHANNEL_BATCH_WAIT']) {
   const work={...operation,source:{...operation.source,dispatchBlock:{code,message:code,kind:'waiting'}}};
   f.coordinator.onRuntimeEvent('AgentWorkDispatchBlocked',{task:work,reason:work.source.dispatchBlock});
   f.mailbox.reportDispatchBlock(work);f.coordinator.flushReports();
  }
 }
 f.coordinator.onRuntimeEvent('AgentWorkCompleted',{task:f.store.updateAgentTask(operation.taskId,{status:'cancelled'})});f.coordinator.flushReports();
 assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n,0);
 assert.equal(f.coordinator.get(id).status,'cancelled');
});

test('a completed host round without a final result does not manufacture a delivery',async t=>{
 const f=await fixture(t);
 const accepted=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item('no-result')]});
 const id=accepted.dispatches[0].dispatchId;await f.coordinator.runDispatch(id);
 const operation=f.store.updateAgentTask(f.coordinator.get(id).operation_id,{status:'completed',targetTurnId:'round:ended'});
 f.coordinator.onRuntimeEvent('AgentWorkCompleted',{task:operation});f.coordinator.flushReports();
 assert.equal(f.coordinator.get(id).status,'completed');
 assert.equal(f.coordinator.get(id).report_message_id,null);
 assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n,0);
});

test("late operation events cannot replace a stored completion or emit its result twice", async t => {
  const f = await fixture(t);
  f.store.db.run("UPDATE sessions SET status='idle' WHERE id=?",[f.source.sessionId]);
  const admission = f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item("late-events")]});
  const id = admission.dispatches[0].dispatchId;
  await f.coordinator.runDispatch(id);
  const row = f.coordinator.get(id);
  const old = f.store.updateAgentTask(row.operation_id,{status:"running",targetTurnId:"original-turn"});
  const work = f.store.updateAgentTask(row.operation_id,{status:"completed"});
  f.store.upsertTimelineItemProjection(work.sessionId,{id:"final:stable",turnId:"original-turn",type:"agentMessage",text:"交付结果",status:"completed",createdAt:new Date().toISOString()});
  f.coordinator.onRuntimeEvent("AgentWorkCompleted",{task:work});
  f.coordinator.flushReports();
  const report = f.coordinator.get(id).report_message_id;
  assert.ok(report);
  f.coordinator.onRuntimeEvent("AgentWorkStarted",{task:old});
  assert.equal(f.coordinator.get(id).status,"completed");
  // Recover an interrupted report-link update using the durable result receipt.
  f.store.db.run("UPDATE task_coordination_dispatches SET report_message_id=NULL WHERE dispatch_id=?",[id]);
  const restored = new TaskCoordinationService({store:f.store,collaboration:f.collaboration,mailbox:f.mailbox});
  restored.flushReports();
  assert.equal(restored.get(id).report_message_id,report);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n,1);
});

test("retry of a cancelled accepted execution reports its original result identity without replay",async t=>{
  const f=await fixture(t);
  const admission=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item("cancel-evidence")]});
  const id=admission.dispatches[0].dispatchId;await f.coordinator.runDispatch(id);
  const row=f.coordinator.get(id);
  f.store.updateAgentTask(row.operation_id,{status:"running",targetTurnId:"accepted-turn"});
  const cancelled=f.store.updateAgentTask(row.operation_id,{status:"cancelled",cancellation:{actor:"user",reason:"USER_STOP"}});
  f.coordinator.onRuntimeEvent("AgentWorkCompleted",{task:cancelled});
  const result=f.coordinator.retryDispatch(f.source,f.role.agentId,id);
  assert.equal(result.status,"cancelled");
  assert.equal(result.retryAction,"inspect_original_result");
  assert.equal(result.originalTurnId,"accepted-turn");
  assert.equal(result.executionEvidence.cancellation.reason,"USER_STOP");
  assert.equal(result.executionEvidence.cancellation.phase,"execution_started");
  assert.equal(f.store.getAgentTask(row.operation_id).status,"cancelled");
});

test("an identical final already sent through Channel is linked instead of reported twice",async t=>{
  const f=await fixture(t);f.store.db.run("UPDATE sessions SET status='idle' WHERE id=?",[f.source.sessionId]);
  const admission=f.coordinator.acceptDispatch(f.source,f.role.agentId,{items:[f.item("channel-final")]});
  const id=admission.dispatches[0].dispatchId;await f.coordinator.runDispatch(id);
  const row=f.coordinator.get(id),work=f.store.updateAgentTask(row.operation_id,{status:"running",targetTurnId:"result-turn"});
  const child=f.store.getLogicalSessionByLegacySessionId(work.sessionId);
  const channels=new SessionChannelService({store:f.store,collaborationCore:f.core});
  const sent=channels.requestChannel({requestingSessionId:child.logicalSessionId,recipientSessionId:"logical:parent",body:"实际交付结果",deliveryIntent:"response_required",idempotencyKey:"channel-final"});
  assert.equal(sent.status,"sent");
  f.store.upsertTimelineItemProjection(work.sessionId,{id:"final:channel",turnId:"result-turn",type:"agentMessage",text:"实际交付结果",status:"completed",createdAt:new Date().toISOString()});
  f.coordinator.onRuntimeEvent("AgentWorkCompleted",{task:f.store.updateAgentTask(work.taskId,{status:"completed"})});
  f.coordinator.flushReports();
  const receipt=f.store.selectOne("SELECT * FROM coordination_result_receipts WHERE dispatch_id=?",[id]);
  assert.ok(receipt?.channel_message_id);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n,1);
});

test('current execution view reports live operation instead of stale Task completion',async t=>{
 const f=await restrictedFixture(t),child=f.child('统一执行'),meta=f.open('execution-view',child.id);
 f.store.updateTask(child.id,{executionStatus:'completed'});
 f.store.enqueueAgentTask({taskId:'operation:view',agentId:f.role.agentId,sessionId:meta.sessionId,kind:'user',priority:1,text:'new instruction'});
 f.store.updateAgentTask('operation:view',{status:'running',targetTurnId:'turn:current'});
 const read=new CoordinationReadService({store:f.store,mailbox:f.mailbox});
 const view=read.execute(f.reference(),f.parent.id,readQuery('read_execution',{taskId:child.id}));
 assert.equal(view.status,'running');assert.equal(view.turnId,'turn:current');assert.equal(view.targetOutcome,'not_assessed');
 assert.equal(view.operationId,'operation:view');
});

 test('closed children leave active progress without being counted as delivered',async t=>{
 const f=await fixture(t);
 f.store.db.run('UPDATE tasks SET current_session_id=? WHERE id=?',[f.source.sessionId,f.parent.id]);
 const first=f.child('Closing_progress'),second=f.child('Archived_progress');
 f.open('closing-progress',first.id);f.open('archived-progress',second.id);
 const service=f.coordinator.progress;
 service.adoptManualTask(first.id);
 const batch=f.store.selectOne('SELECT batch_id FROM coordination_progress_assignments WHERE task_id=?',[first.id]);
 service.attach(service.batch(batch.batch_id),{target_task_id:second.id,dispatch_id:null});
 assert.equal(service.refresh(batch.batch_id).total,2);
 f.store.db.run('INSERT INTO task_completion_authorizations(operation_id,task_id,work_id,source_type,nonce,validated_at) VALUES(?,?,?,?,?,?)',
 ['progress-close-fixture',first.id,first.work_id,'direct_macos_ui_action','progress-fixture',new Date().toISOString()]);
 f.store.db.run("UPDATE tasks SET lifecycle_state='done', completion_operation_id='progress-close-fixture', completion_source_type='direct_macos_ui_action' WHERE id=?",[first.id]);
 let snapshot=service.refresh(batch.batch_id);
 assert.equal(snapshot.total,1);assert.equal(snapshot.counts.delivered,0);
 assert.equal(service.page('logical:parent',batch.batch_id).items[0].taskId,second.id);
 f.store.db.run('UPDATE tasks SET archived=1 WHERE id=?',[second.id]);
 assert.equal(service.refresh(batch.batch_id).total,0);
 assert.equal(service.latest(f.parent.id),null);
 assert.equal(f.store.selectOne('SELECT id FROM session_items WHERE id=?',[`coordination-progress:${batch.batch_id}`]),null);
 assert.equal(service.page('logical:parent',batch.batch_id).items.length,0);
 assert.equal(f.store.selectOne('SELECT COUNT(*) AS n FROM coordination_progress_assignments WHERE batch_id=?',[batch.batch_id]).n,2);
 });
