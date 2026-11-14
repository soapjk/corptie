import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";
import { BackgroundAgentService } from "../src/application/backgroundAgentService.mjs";
import { createCodexSessionCreator } from "../src/adapters/codexSessionCreator.mjs";
import { ClaudeAgentManager } from "../src/adapters/claudeAgentManager.mjs";
import { createSessionApplicationComposition } from "../src/application/sessionApplicationComposition.mjs";
import { AGENT_PROVIDER_CAPABILITIES as C } from "../src/agent-provider/contracts.mjs";
import { createSessionToolBindingProjection } from "../src/application/sessionToolBindingProjection.mjs";
import { coordinationCreationPolicy, coordinationExecutionPolicy } from "../src/domain/coordinationDelegation.mjs";
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
import { CoordinationRequestService } from "../src/application/coordinationRequestService.mjs";
import { ShadowSessionService } from "../src/application/shadowSessionService.mjs";
import { ChildTaskReclamationService } from "../src/application/childTaskReclamationService.mjs";
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

for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) test(`ordinary child admission reserves and restores a summary without changing user-input mode (${provider})`, async t => {
  const f = await recoveryFixture(t, provider);
  f.remove();
  f.store.db.run("DELETE FROM coordination_shadow_sessions WHERE main_session_id='logical:parent'");
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  const id = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("ordinary_summary")] }).dispatches[0].dispatchId;
  assert.ok(f.shadow.forMain("logical:parent"));
  await f.coordinator.runDispatch(id); await f.shadow.requestRecovery("logical:parent");
  assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 0);
  assert.equal(f.shadow.resolveRecipient("logical:parent").role, "summary-shadow");
  const child = f.store.getTask(f.coordinator.get(id).target_task_id);
  const childId = f.store.getLogicalSessionByLegacySessionId(child.current_session_id).logicalSessionId;
  for (const [senderSessionId, recipientSessionId] of [["logical:parent", childId], [childId, "logical:parent"]]) {
    const envelope = { message: { senderSessionId, recipientSessionId } };
    assert.equal(f.shadow.channelRecipient(envelope), f.shadow.forMain("logical:parent").shadow_session_id);
    assert.equal(envelope.message.senderSessionId, senderSessionId);
    assert.equal(envelope.message.recipientSessionId, recipientSessionId);
  }
  assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n, 0);
});

test("ordinary direct children are adopted on recovery and each reviewed child starts delivery immediately", async t => {
  const f = await recoveryFixture(t);
  f.remove(); f.store.db.run("DELETE FROM coordination_shadow_sessions WHERE main_session_id='logical:parent'");
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  const child = f.child("Manual_child"), meta = f.open("manual_child", child.id);
  f.child("Still_working_sibling");
  f.coordinator.recover(); await f.shadow.requestRecovery("logical:parent");
  const shadowId = f.shadow.forMain("logical:parent").shadow_session_id;
  historyItem(f, meta.sessionId, "ready-evidence", "Verified independent result");
  const report = f.shadow.publish({ shadowId, turnId: "ordinary-review", revision: 0, body: "Verified and ready for delivery" });
  const delivered = [];
  f.shadow.deliverChild = async taskId => { delivered.push(taskId); return { operationId: "delivery:reviewed" }; };
  await f.shadow.deliver({ shadowId, taskId: child.id, reportId: report.report_id, evidence: ["ready-evidence"] });
  assert.deepEqual(delivered, [child.id]);
  assert.equal(f.store.selectOne("SELECT phase FROM coordination_shadow_reclamation WHERE task_id=?", [child.id]).phase, "delivery");
  assert.equal(f.store.listAgentTasksForSession(f.source.sessionId).length, 0);
});

test("an unstarted Channel handoff carries a differently worded final from the same execution once", async t => {
  const f = await fixture(t);
  f.store.db.run("UPDATE sessions SET status='idle' WHERE id=?", [f.source.sessionId]);
  const id = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("merged-final")] }).dispatches[0].dispatchId;
  await f.coordinator.runDispatch(id);
  const work = f.store.updateAgentTask(f.coordinator.get(id).operation_id, { status: "running", targetTurnId: "merge-result-turn" });
  const child = f.store.getLogicalSessionByLegacySessionId(work.sessionId);
  const channels = new SessionChannelService({ store: f.store, collaborationCore: f.core });
  const sent = channels.requestChannel({ requestingSessionId: child.logicalSessionId, recipientSessionId: "logical:parent",
    body: "Code and test files are ready", messageKind: "message", deliveryIntent: "action_required", idempotencyKey: "merge-handoff" });
  const deliveryId = sent.delivery.deliveryId;
  f.store.enqueueAgentTask({ taskId: "channel:queued-result", sessionId: f.source.sessionId, agentId: f.role.agentId,
    kind: "collaboration", priority: 50, channelDeliveryId: deliveryId, text: "handoff", source: { type: "session_channel", deliveryId } });
  f.store.upsertTimelineItemProjection(work.sessionId, { id: "final:merged", turnId: "merge-result-turn", type: "agentMessage",
    text: "Final result with additional verification limitations", status: "completed", createdAt: new Date().toISOString() });
  f.coordinator.onRuntimeEvent("AgentWorkCompleted", { task: f.store.updateAgentTask(work.taskId, { status: "completed" }) });
  f.coordinator.flushReports();
  const receipt = f.store.selectOne("SELECT * FROM coordination_result_receipts WHERE dispatch_id=?", [id]);
  assert.equal(receipt.channel_message_id, sent.message.messageId);
  const envelope = channels.getDeliveryEnvelope(deliveryId);
  assert.equal(envelope.message.body, "Code and test files are ready");
  assert.equal(envelope.executionResults[0].messageId, "final:merged");
  assert.match(envelope.executionResults[0].text, /additional verification limitations/);
  f.coordinator.flushReports();
  assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n, 1);
});

test("legacy queued Channel work moves to the ordinary-mode summary before dispatch without changing the sender", async t => {
  const f = await recoveryFixture(t);
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  const child = f.child("Legacy_channel_child"), meta = f.open("legacy_channel_child", child.id);
  const channels = new SessionChannelService({ store: f.store, collaborationCore: f.core });
  const sent = channels.requestChannel({ requestingSessionId: "logical:legacy_channel_child", recipientSessionId: "logical:parent",
    body: "Need a cross-module decision", messageKind: "question", deliveryIntent: "response_required", idempotencyKey: "legacy-question" });
  const deliveryId = sent.delivery.deliveryId;
  const operation = f.store.enqueueAgentTask({ taskId: "legacy-channel-work", sessionId: f.source.sessionId, agentId: f.role.agentId,
    kind: "collaboration", priority: 50, channelDeliveryId: deliveryId, text: "Question", source: { type: "session_channel", deliveryId } });
  f.mailbox.channelService = channels;
  channels.resolveDelegatedRecipient = envelope => f.shadow.channelRecipient(envelope);
  f.mailbox.dispatchDecision(operation);
  assert.equal(f.store.getAgentTask(operation.taskId).sessionId, f.store.getLogicalSession(f.original.shadow_session_id).legacySessionId);
  const message = f.store.selectOne("SELECT * FROM session_mailbox_messages WHERE channel_delivery_id=?", [deliveryId]);
  assert.equal(message.recipient_session_id, f.original.shadow_session_id);
  assert.equal(channels.getDeliveryEnvelope(deliveryId).message.senderSessionId, "logical:legacy_channel_child");
  assert.equal(channels.getDeliveryEnvelope(deliveryId).message.recipientSessionId, "logical:parent");
});

test("shadow creation is singleflight, preserves the interactive binding and publishes without waking it", async t => {
  for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) await t.test(providerId, async t => {
    const f = await fixture(t, providerId);
    f.store.db.run("UPDATE tasks SET current_session_id=?,coordination_enabled=1 WHERE id=?", [f.source.sessionId, f.parent.id]);
    let creations = 0;
    const events = [];
    const shadows = new ShadowSessionService({ store: f.store, emitEvent: (...args) => events.push(args),
      createSession: async (provider, input) => {
        assert.equal(provider, providerId); assert.equal(input.sessionKind, "worker"); creations++;
        const meta = f.open("shadow", f.parent.id, { deferTaskProjection: true });
        return f.store.getSession(meta.sessionId);
      } });
    const [first, second] = await Promise.all([shadows.ensure("logical:parent"), shadows.ensure("logical:parent")]);
    assert.equal(creations, 1); assert.equal(first.shadow_session_id, second.shadow_session_id);
    assert.equal(f.store.getTask(f.parent.id).current_session_id, f.source.sessionId);
    assert.equal(f.store.assertLogicalWorkSessionBinding(first.shadow_session_id).taskId, f.parent.id);
    assert.ok(!f.store.listSessions().some(session => session.id === "provider:shadow"));
    const before = f.store.getSession(f.source.sessionId).status;
    const report = shadows.publish({ shadowId: first.shadow_session_id, turnId: "review-one", revision: 0, body: "已完成技术核对，准备交付。" });
    assert.equal(shadows.publish({ shadowId: first.shadow_session_id, turnId: "review-one", revision: 0, body: "已完成技术核对，准备交付。" }).report_id, report.report_id);
    assert.equal(events.filter(([type]) => type === "SessionCoordinationMilestone").length, 1);
    assert.equal(f.store.getSession(f.source.sessionId).status, before);
    assert.equal(f.store.listAgentTasksForSession(f.source.sessionId).length, 0);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM session_mailbox_messages").count, 0);
    shadows.revise("logical:parent");
    assert.throws(() => shadows.publish({ shadowId: first.shadow_session_id, turnId: "stale-review", revision: 0, body: "旧结论" }), { code: "SHADOW_REQUIREMENT_CHANGED" });
    f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
    assert.equal(shadows.assertDelegate(first.shadow_session_id).main_session_id, "logical:parent");
  });
});

test("reenabling coordination recovers an unqueued shadow request exactly once", async t => {
  const f = await fixture(t);
  f.store.db.run("UPDATE tasks SET current_session_id=?,coordination_enabled=1 WHERE id=?", [f.source.sessionId, f.parent.id]);
  const shadow = new ShadowSessionService({ store: f.store,
    createSession: async () => f.store.getSession(f.open("resumed_shadow", f.parent.id, { deferTaskProjection: true }).sessionId) });
  f.coordinator.shadow = shadow;
  shadow.reserve("logical:parent");
  f.store.db.run(`INSERT INTO coordination_shadow_requests
    (request_id,main_session_id,source_turn_id,body,source_json,created_at) VALUES(?,?,?,?,?,?)`,
    ["request:resume", "logical:parent", "turn:cleanup", "清理已完成子任务", "{}", new Date().toISOString()]);
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  f.coordinator.activateShadow(f.parent.id);
  await nextTick();
  assert.ok(shadow.forMain("logical:parent").shadow_session_id);
  f.workService.updateTask(f.parent.id, { coordinationEnabled: true });
  f.coordinator.activateShadow(f.parent.id);
  await nextTick(); await nextTick();
  const request = f.store.selectOne("SELECT * FROM coordination_shadow_requests WHERE request_id=?", ["request:resume"]);
  assert.ok(request.mailbox_message_id);
  f.coordinator.activateShadow(f.parent.id);
  await nextTick();
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM session_mailbox_messages WHERE source_id=?", ["request:resume"]).count, 1);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM session_mailbox_messages WHERE recipient_session_id=?", ["logical:parent"]).count, 0);
});

test("shadow delegation rejects an unrelated child and preserves original channel identities", async t => {
  const f = await fixture(t);
  f.store.db.run("UPDATE tasks SET current_session_id=?,coordination_enabled=1 WHERE id=?", [f.source.sessionId, f.parent.id]);
  const shadows = new ShadowSessionService({ store: f.store, createSession: async () => f.store.getSession(f.open("shadow_route", f.parent.id, { deferTaskProjection: true }).sessionId) });
  const delegate = await shadows.ensure("logical:parent");
  const child = f.child("Delegated_child"); f.open("delegated_child", child.id);
  const envelope = { message: { recipientSessionId: "logical:parent", senderSessionId: "logical:delegated_child" } };
  assert.equal(shadows.channelRecipient(envelope), delegate.shadow_session_id);
  assert.equal(envelope.message.recipientSessionId, "logical:parent");
  const other = f.store.createTask({ workId: f.work.id, title: "Independent", mainAgentId: f.role.agentId });
  f.open("independent", other.id);
  assert.equal(shadows.channelRecipient({ message: { ...envelope.message, senderSessionId: "logical:independent" } }), null);
  const report = shadows.publish({ shadowId: delegate.shadow_session_id, turnId: "review", revision: 0, body: "核对结果" });
  await assert.rejects(shadows.deliver({ shadowId: delegate.shadow_session_id, taskId: other.id, reportId: report.report_id, evidence: ["unknown"] }), { code: "SHADOW_CHILD_OUTSIDE_SCOPE" });
  await assert.rejects(shadows.deliver({ shadowId: delegate.shadow_session_id, taskId: child.id, reportId: report.report_id, evidence: ["unknown"] }), { code: "SHADOW_REVIEW_EVIDENCE_INVALID" });
});

test("child reclamation erases transcript payloads and its recovery record while retaining the parent report", async t => {
  const f = await fixture(t);
  const child = f.child("Reclaim_child"), childMeta = f.open("reclaim_child", child.id);
  historyItem(f, childMeta.sessionId, "child-private", "private child transcript");
  historyItem(f, f.source.sessionId, "parent-result", "independent final result");
  f.store.enqueueAgentTask({ taskId: "reclaimed-work", sessionId: childMeta.sessionId, agentId: f.role.agentId,
    kind: "user", priority: 50, text: "private tool instruction", source: { private: "payload" } });
  const now = new Date().toISOString();
  f.store.db.run("INSERT INTO session_events(event_id,session_id,sequence,type,payload_json,created_at) VALUES(?,?,1,'agent.reply',?,?)",
    ["private-event", childMeta.sessionId, JSON.stringify({ text: "private transcript event" }), now]);
  f.store.db.run(`INSERT INTO coordination_shadow_reclamation
    (task_id,main_session_id,shadow_session_id,report_id,phase,recovery_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
    [child.id, "logical:parent", "logical:shadow", "parent-result", "delivery", "{}", now, now]);
  const removed = [];
  const reclamation = new ChildTaskReclamationService({ store: f.store, resources: { reclaimDeletedTask: async id => removed.push(id) } });
  await assert.rejects(reclamation.reclaim(child.id), { code: "CHILD_RECLAMATION_NOT_READY" });
  f.store.deleteSession(childMeta.sessionId);
  f.store.markTaskDeletion(child.id, "deleting");
  f.store.finalizeTaskDeletion(child.id);
  await reclamation.reclaim(child.id);
  assert.deepEqual(removed, [child.id]);
  assert.equal(f.store.getAgentTask("reclaimed-work").text, "");
  assert.equal(f.store.getSessionItem(childMeta.sessionId, "child-private"), null);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_events WHERE session_id=?", [childMeta.sessionId]).n, 0);
  assert.equal(f.store.getSessionItem(f.source.sessionId, "parent-result").text, "independent final result");
  assert.equal(f.store.selectOne("SELECT 1 FROM coordination_shadow_reclamation WHERE task_id=?", [child.id]), null);
  await reclamation.reclaim(child.id);
  assert.equal(removed.length, 1);
});
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
    planner: { run: async input => { input.onStart?.(); requests.push(input); if (run) return run(input); return { text: JSON.stringify(output) }; } },
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
  const open = (name, taskId, options = {}) => {
    const id = `provider:${name}`;
    store.createSession({ id, agentId: role.agentId, title: name, provider: providerId, workId: work.id, taskId, sessionKind: "worker", ...options });
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

test("ordinary coordination context exposes useful children without an extra planning phase or an empty index", () => {
  const task = { id: "task:parent", coordination_enabled: 0 };
  const empty = buildTaskCoordinationContext(task, { children: [], dispatches: [] });
  assert.match(empty, /autonomously delegate/);
  assert.match(empty, /prefer Corptie child Tasks/);
  assert.match(empty, /Native subagents remain available for local reading/);
  assert.match(empty, /No explicit user request to create children is needed/);
  assert.match(empty, /do not add a separate planning model call/);
  assert.doesNotMatch(empty, /Current bounded child\/dispatch index/);
  const populated = buildTaskCoordinationContext(task, { children: [{ id: "task:existing", title: "已有工作" }], dispatches: [] });
  assert.match(populated, /task:existing/);
  assert.match(populated, /Reuse a suitable existing child/);
  const pending = buildTaskCoordinationContext(task, { children: [], dispatches: [{ dispatchId: "dispatch:pending", status: "preparing" }] });
  assert.match(pending, /dispatch:pending/);
  assert.match(pending, /Inspect existing pending receipts/);
});

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
      queueMicrotask(() => f.workService.updateTask(f.parent.id, { }));
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

test("shadow receives child results while main is running without occupying the main queue", async t => {
  const f = await fixture(t);
  f.workService.updateTask(f.parent.id, { coordinationEnabled: true });
  const shadow = new ShadowSessionService({ store: f.store,
    createSession: async () => f.store.getSession(f.open("report_shadow", f.parent.id, { deferTaskProjection: true }).sessionId) });
  f.coordinator.shadow = shadow;
  const delegate = await shadow.ensure("logical:parent");
  const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item("shadow_result")] });
  const id = receipt.dispatches[0].dispatchId;
  await f.coordinator.runDispatch(id);
  const row = f.coordinator.get(id);
  const operation = f.store.updateAgentTask(row.operation_id, { status: "completed", targetTurnId: "result-turn" });
  f.store.upsertTimelineItemProjection(operation.sessionId, { id: "shadow-child-final", turnId: "result-turn",
    type: "agentMessage", text: "技术结果", status: "completed", createdAt: new Date().toISOString() });
  f.store.db.run("UPDATE sessions SET status='running' WHERE id=?", [f.source.sessionId]);
  f.coordinator.onRuntimeEvent("AgentWorkCompleted", { task: operation });
  f.coordinator.flushReports();
  const messages = f.store.selectAll("SELECT * FROM session_mailbox_messages WHERE recipient_session_id=?", [delegate.shadow_session_id]);
  assert.equal(messages.length, 1);
  assert.equal(JSON.parse(messages[0].authorization_json).purpose, "shadow_report");
  f.coordinator.validateMailbox(messages[0], JSON.parse(messages[0].authorization_json));
  assert.equal(f.store.listAgentTasksForSession(f.source.sessionId).length, 0);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n, 0);
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

test("native Detail toggle is user-command scoped, revision checked and available to child controls", async t => {
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
  const childPorts = createDetailBusinessActionPorts({ inspector: {
    scope: () => ({ sessionId: "logical:child", logicalSessionId: "logical:child", task: f.store.getTask(child.id) }),
    updateTask: (id, fields) => f.workService.updateTask(id, fields),
    perform: (_scope, operation, fields) => { assert.equal(operation, "task.update"); return f.workService.updateTask(child.id, fields); }
  } });
  const childRegistry = createDetailActionRegistry(childPorts);
  const childScope = { sessionId: "logical:child", identity };
  for (const enabled of [true, false]) {
    const current = f.store.getTask(child.id);
    const currentDoc = projectNativeBusinessDocument({ logicalSessionId: "logical:child", session: { sessionKind: "worker" }, task: current }, {}, "test-generation", { editors: true });
    const action = currentDoc.cards.find(row => row.kind === "taskInfo").actions.find(row => row.operation === "task.coordination.update");
    const prepared = await childRegistry.prepare({ action, fields: { coordinationEnabled: enabled }, expectedResourceRevision: action.expectedResourceRevision, scope: childScope });
    await prepared.port.execute(childScope, action.target, { coordinationEnabled: enabled }, { resource: prepared.resource, fingerprint: `child-${enabled}` });
    assert.equal(f.store.getTask(child.id).coordination_enabled, Number(enabled));
  }
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
 const f=await fixture(t,provider,true);
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
  creation:{...same.creation,priority:'urgent'}}]});
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

async function requestFixture(t, providerId = "codex-app-server", nativeRuntime = null) {
  // Cleanup and admission use separate SQLite workers, so they need a shared file.
  const f = await fixture(t, providerId, true);
  f.store.db.run("UPDATE tasks SET current_session_id=?,coordination_enabled=1 WHERE id=?", [f.source.sessionId, f.parent.id]);
  const reference = id => {
    const route = f.store.getLogicalSession(id) ?? f.store.getLogicalSessionByLegacySessionId(id);
    return { logicalSessionId: route.logicalSessionId, sessionId: route.legacySessionId,
      bindingId: route.activeBinding.bindingId, routingVersion: route.routingVersion, providerId,
      providerSessionId: route.activeBinding.providerSessionId,
      metadata: { session: f.store.getSession(route.legacySessionId) } };
  };
  let planner = async input => ({ text: JSON.stringify({kind:"discussion",reply:"回答",items:[]}) });
  const events = [], deleted = [], created = [];
  const codexCreator = createCodexSessionCreator({ collaborationCore: f.core,
    codexRuntime: nativeRuntime ?? { startThread: async input => {
      assert.equal(input.executionPolicy, "no-tools"); assert.deepEqual(input.dynamicTools, []);
      assert.equal(input.sandbox, "read-only");
      return { thread: { id: `request_${created.length}`, cwd: input.cwd } };
    } }, resolvedNewCodexRuntimeConfig: async input => ({ model: input.model, reasoningLevel: input.reasoningLevel }),
    collaborationThreadOptionsWithAgentContext: () => assert.fail("must not load ordinary Agent tools"),
    codexAppServerSessionCapabilities: () => ({}) });
  const claude = new ClaudeAgentManager({ query: () => assert.fail("creation must not execute a native turn") });
  const registry = { supports: () => true, decorateSession: (_provider, session) => session, get: () => ({ descriptor: { metadata: {
    backgroundExecutionPolicies: ["no-tools"], backgroundImages: true } } }),
    invoke: async (provider, capability, input, context) => {
      if (capability === C.SESSION_DELETE) { deleted.push(input.logicalSessionId);
        if (nativeRuntime) await nativeRuntime.deleteThread(input.providerSessionId);
        return {}; }
      if (capability === C.BACKGROUND_PROMPT && nativeRuntime) return nativeRuntime.runEphemeralPrompt(input);
      assert.equal(capability, C.SESSION_CREATE, "ordinary Provider execution is forbidden for shadows");
      assert.equal(input.toolHost, undefined);
      const session = provider === "codex-app-server" ? await codexCreator.create(input)
        : provider === "claude-sdk" ? claude.start(input) : { id: `provider:request_${created.length}`, title: input.title, status: "idle",
        sessionKind: input.sessionKind, external: { provider, cwd: "/tmp", threadId: `request_${created.length}` } };
      created.push({ session, input, context });
      return session;
    }
  };
  const application = createSessionApplicationComposition({ store: f.store, agentProviderRegistry: registry,
    sessionBindingRepository: { resolve: reference }, collaborationCore: f.core, emitEvent: () => {},
    toolHostService: { prepareSession: () => assert.fail("shadow must not prepare ordinary tools") },
    ensureCollaborationAgentForSession: (session, agentId) => f.core.bindSession({ sessionId: session.id, agentId }),
    ensureLogicalRouteForProviderSession: (session, provider) => f.store.createLogicalSessionRoute({
      logicalSessionId: `logical:${session.id}`, legacySessionId: session.id, providerId: provider,
      providerThreadId: session.external.threadId ?? session.id, providerSessionId: session.external.threadId ?? session.id, boundCwd: "/tmp", sessionName: session.title })
  });
  const turns = new CoordinationTurnService({ store:f.store, dispatch:f.coordinator, resolveReference:reference,
    registry,
    planner:{run: input => { input.onStart?.(); return planner(input); }}, emitEvent:(type,payload,scope)=>events.push({type,payload,scope}) });
  const requests = new CoordinationRequestService({ store:f.store, turns, resolveReference:reference,
    buildContext:async()=>({prompt:"existing canonical context"}),
    createSession: application.createSession.bind(application),
    deleteSession: application.deleteSession.bind(application),
    emitEvent:(type,payload,scope)=>events.push({type,payload,scope}) });
  turns.requests=requests; f.coordinator.requests=requests;
  return {...f, requests,turns,events,deleted,created,application,registry,reference, setPlanner:fn=>{planner=fn;},
    admit:text=>requests.admit(reference("logical:parent"),{text,images:[]},{type:"desktop",messageId:text})};
}

test("independent request Sessions answer concurrently without locking the main Session", async t => {
  for (const provider of ["codex-app-server","claude-sdk","openclacky"]) await t.test(provider, async t => {
    const f=await requestFixture(t,provider);
    let release; const firstGate=new Promise(resolve=>{release=resolve;});
    f.setPlanner(async input=>{
      const payload=JSON.parse(input.prompt);
      assert.ok(payload.requestContext.conversation.instructions);
      if(payload.message==="first") await firstGate;
      return {text:JSON.stringify({kind:"discussion",reply:`answer ${payload.message}`,items:[]})};
    });
    const first=f.admit("first"), second=f.admit("second");
    await f.requests.running.get(second.request_id);
    assert.equal(f.requests.get(first.request_id).status,"running");
    assert.equal(f.requests.get(second.request_id).status,"completed");
    assert.equal(f.store.getTask(f.parent.id).current_session_id,f.source.sessionId);
    assert.equal(f.store.listUnsettledSessionTurns(f.source.sessionId).length,0);
    await Promise.all([...f.requests.reclaiming.values()]);
    assert.equal(f.requests.get(second.request_id).context_json,null);
    release(); await f.requests.running.get(first.request_id);
    await Promise.all([...f.requests.reclaiming.values()]);
    assert.equal(f.requests.get(first.request_id).status,"completed");
    assert.equal(f.events.filter(e=>e.type==="SessionCoordinationCompleted" && e.scope?.sessionId===f.source.sessionId).length,2);
  });
});

test("request identity deduplicates admission and cancellation is scoped to one request", async t => {
  const f=await requestFixture(t); let releases=[];
  f.setPlanner(input=>new Promise((resolve,reject)=>{
    releases.push(()=>resolve({text:JSON.stringify({kind:"discussion",reply:"done",items:[]})}));
    input.signal.addEventListener("abort",()=>reject(Object.assign(new Error("stopped"),{code:"ABORTED"})),{once:true});
  }));
  const one=f.admit("one"), two=f.admit("two");
  assert.equal(f.admit("one").request_id,one.request_id);
  await nextTick(); await nextTick();
  await assert.rejects(f.requests.cancel("logical:unrelated",one.request_id),{code:"REQUEST_NOT_FOUND"});
  await f.requests.cancel("logical:parent",one.request_id);
  assert.equal(f.requests.get(one.request_id).status,"cancelled");
  assert.equal(f.requests.get(two.request_id).status,"running");
  for(const release of releases)release();
  await Promise.all([...f.requests.running.values()]);
  await Promise.all([...f.requests.reclaiming.values()]);
});

test("request dependency releases execution and resumes only after the referenced result", async t => {
  const f=await requestFixture(t); let release;
  const gate=new Promise(resolve=>{release=resolve;}); let firstId;
  f.setPlanner(async input=>{
    const payload=JSON.parse(input.prompt);
    if(payload.message==="first"){await gate;return {text:JSON.stringify({kind:"discussion",reply:"base result",items:[]})};}
    const dependency=payload.requestContext.dependency;
    return {text:JSON.stringify({kind:"discussion",reply:dependency?.status==="completed"?"derived result":"",
      items:[],requestRelation:{kind:"depends_on",requestId:firstId}})};
  });
  const first=f.admit("first"); firstId=first.request_id;
  const second=f.admit("second"); await f.requests.running.get(second.request_id);
  assert.equal(f.requests.get(second.request_id).status,"waiting");
  release(); await f.requests.running.get(first.request_id); await nextTick();
  await f.requests.running.get(second.request_id);
  assert.equal(f.requests.get(second.request_id).status,"completed");
  await Promise.all([...f.requests.reclaiming.values()]);
});

test("request recovery reconciles a published reply without replaying execution", async t => {
  const f=await requestFixture(t);
  const request=f.admit("recover reply");
  await f.requests.running.get(request.request_id);
  await Promise.all([...f.requests.reclaiming.values()]);
  f.requests.update(request.request_id,{status:"running",phase:"admitting"});
  let executions=0;
  f.setPlanner(async()=>{executions++;throw new Error("must not replay");});
  f.requests.recover();
  await Promise.all([...f.requests.reclaiming.values()]);
  assert.equal(f.requests.get(request.request_id).status,"completed");
  assert.equal(executions,0);
});

test("request recovery does not replay an uncertain dispatch", async t => {
  const f=await requestFixture(t);
  const request=f.admit("uncertain");
  await f.requests.running.get(request.request_id);
  await Promise.all([...f.requests.reclaiming.values()]);
  f.requests.update(request.request_id,{status:"running",phase:"admitting",response_item_id:null});
  f.requests.recover();
  assert.equal(f.requests.get(request.request_id).error_code,"REQUEST_OUTCOME_UNCERTAIN");
  await assert.rejects(f.requests.retry("logical:parent",request.request_id),{code:"REQUEST_OUTCOME_UNCERTAIN"});
});

test("request preview and final answer share identity and temporary context is purged", async t => {
  const f=await requestFixture(t);
  f.setPlanner(async input=>{
    input.onText?.('{"kind":"discussion","reply":"partial');
    return {text:JSON.stringify({kind:"discussion",reply:"partial complete",items:[]})};
  });
  const request=f.admit("preview");
  await f.requests.running.get(request.request_id);
  await Promise.all([...f.requests.reclaiming.values()]);
  const rows=f.store.selectAll("SELECT id,text FROM session_items WHERE session_id=? AND id=?",[f.source.sessionId,`${request.request_id}:reply`]);
  assert.equal(rows.length,1);assert.equal(rows[0].text,"partial complete");
  assert.equal(f.requests.get(request.request_id).message_json,null);
  assert.equal(f.requests.get(request.request_id).context_json,null);
});

test("request dispatch remains owned by the interactive Session after the temporary executor is reclaimed", async t => {
  const f=await requestFixture(t);
  f.setPlanner(async()=>({text:JSON.stringify({kind:"dispatch",reply:"已派发",items:[{action:"create",taskId:null,title:"Request_child",text:"Execute isolated instruction",agentId:f.role.agentId}]})}));
  const request=f.admit("implement");
  await f.requests.running.get(request.request_id);
  await Promise.all([...f.requests.reclaiming.values()]);
  const row=f.requests.get(request.request_id);
  assert.equal(row.status,"completed",row.error_message);
  const dispatch=f.store.selectOne("SELECT * FROM task_coordination_dispatches WHERE executor_session_id=?",[row.shadow_session_id]);
  assert.ok(dispatch);assert.equal(dispatch.source_session_id,"logical:parent");
  assert.equal(JSON.parse(row.dispatch_json)[0].dispatchId,dispatch.dispatch_id);
  assert.equal(f.store.getTask(f.parent.id).current_session_id,f.source.sessionId);
});

test("real Session composition binds request and summary delegates while denying ordinary tools", async t => {
  for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) await t.test(provider, async t => {
    const f = await requestFixture(t, provider);
    const shadows = new ShadowSessionService({ store: f.store, createSession: f.application.createSession.bind(f.application) });
    const summary = await shadows.ensure("logical:parent");
    const reference = f.reference(summary.shadow_session_id);
    assert.equal(f.store.assertLogicalWorkSessionBinding(summary.shadow_session_id).taskId, f.parent.id);
    const ready = await f.application.ensureActiveBindingToolsReady(summary.shadow_session_id);
    assert.equal(ready.executionPolicy, "host-coordination");
    assert.equal(ready.providerSession.id, reference.sessionId);
    const projection = createSessionToolBindingProjection({ store: f.store });
    assert.equal(projection.resolveToolHostBinding(reference.logicalSessionId, reference.bindingId).taskSessionAuthorization, "summary-shadow");
    assert.equal(f.store.getTask(f.parent.id).current_session_id, f.source.sessionId);
    await f.application.deleteSession(reference.logicalSessionId);
    const replacement = await shadows.ensure("logical:parent");
    assert.notEqual(replacement.shadow_session_id, summary.shadow_session_id);
    const replacementReady = await f.application.ensureActiveBindingToolsReady(replacement.shadow_session_id);
    assert.equal(replacementReady.executionPolicy, "host-coordination");
    assert.equal(f.store.getTask(f.parent.id).current_session_id, f.source.sessionId);
    f.store.db.run("UPDATE sessions SET archived=1 WHERE id=?", [replacementReady.providerSession.id]);
    const unarchived = await shadows.ensure("logical:parent");
    assert.notEqual(unarchived.shadow_session_id, replacement.shadow_session_id);
    assert.equal((await f.application.ensureActiveBindingToolsReady(unarchived.shadow_session_id)).executionPolicy, "host-coordination");
    assert.throws(() => coordinationCreationPolicy(f.store, { source: "coordination-request", requestId: "forged",
      shadowOwnerSessionId: "logical:parent", actorId: f.role.agentId, taskId: f.parent.id, workId: f.work.id }),
      { code: "COORDINATION_RESERVATION_INVALID" });
    f.store.db.run("UPDATE tasks SET current_session_id=NULL WHERE id=?", [f.parent.id]);
    assert.throws(() => shadows.assertDelegate(unarchived.shadow_session_id), { code: "SHADOW_OWNER_UNAVAILABLE" });
    assert.throws(() => coordinationExecutionPolicy(f.store, unarchived.shadow_session_id), { code: "COORDINATION_DELEGATION_UNAVAILABLE" });
  });
});

test("old queued user inputs migrate once while mailbox and running work remain with their owners", async t => {
  const f = await requestFixture(t), forgotten = [];
  f.requests.forgetQueued = (...args) => forgotten.push(args);
  const add = (id, type, status = "queued") => {
    f.store.enqueueAgentTask({ taskId: id, sessionId: f.source.sessionId, agentId: f.role.agentId,
      kind: "user", priority: 50, text: id, source: { type, messageId: id } });
    if (status !== "queued") f.store.updateAgentTask(id, { status });
  };
  add("queued-desktop", "desktop"); add("queued-mobile", "remote-client");
  add("mailbox", "mailbox_event"); add("running", "desktop", "running");
  f.requests.migrateQueued("logical:parent"); f.requests.migrateQueued("logical:parent");
  await Promise.all([...f.requests.running.values()]);
  await Promise.all([...f.requests.reclaiming.values()]);
  assert.equal(forgotten.length, 2);
  assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM coordination_requests").n, 2);
  assert.equal(f.store.getAgentTask("queued-desktop").status, "completed");
  assert.equal(f.store.getAgentTask("mailbox").status, "queued");
  assert.equal(f.store.getAgentTask("running").status, "running");
});

test("cancelling creation reclaims a late Provider Session without planning or dispatch", async t => {
  const f = await requestFixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const invoke = f.registry.invoke;
  f.registry.invoke = async (...args) => { if (args[1] === C.SESSION_CREATE) { entered(); await gate; } return invoke(...args); };
  f.setPlanner(() => assert.fail("cancelled preparation must not plan"));
  const request = f.admit("cancel during create");
  await started;
  await f.requests.cancel("logical:parent", request.request_id);
  release(); await f.requests.running.get(request.request_id);
  await Promise.all([...f.requests.reclaiming.values()]);
  const row = f.requests.get(request.request_id);
  assert.equal(row.status, "cancelled"); assert.equal(row.context_json, null);
  assert.equal(row.message_json, null); assert.equal(f.deleted.length, 1);
  assert.equal(f.store.getTask(f.parent.id).current_session_id, f.source.sessionId);
});

test("request history crosses page boundaries, preserves instructions and excludes later user inputs", async t => {
  const f = await requestFixture(t);
  for (let n = 0; n < 45; n++) f.store.upsertTimelineItemProjection(f.source.sessionId, {
    id: `history:${n}`, turnId: `turn:${n}`, type: "userMessage", text: `past ${n}`, status: "completed",
    createdAt: new Date(Date.now() - 100000 + n * 1000).toISOString() });
  let payload;
  f.setPlanner(async input => { payload = JSON.parse(input.prompt); return { text: JSON.stringify({ kind: "discussion", reply: "answer", items: [] }) }; });
  const row = f.admit("current");
  f.store.upsertTimelineItemProjection(f.source.sessionId, { id: "future", turnId: "future", type: "userMessage",
    text: "later unrelated input", createdAt: "2099-01-01T00:00:00.000Z" });
  await f.requests.running.get(row.request_id);
  await Promise.all([...f.requests.reclaiming.values()]);
  assert.equal(f.requests.get(row.request_id).status, "completed");
  assert.equal(payload.requestContext.conversation.messages.length, 45);
  assert.equal(payload.requestContext.conversation.messages[0].text, "past 0");
  assert.equal(payload.requestContext.conversation.instructions, "existing canonical context");
  assert.ok(!JSON.stringify(payload.requestContext.conversation).includes("later unrelated input"));
});

test("older unfinished requests remain visible after many completed inputs and mode changes", async t => {
  const f = await requestFixture(t);
  f.requests.schedule = () => {};
  const active = f.admit("old active");
  for (let n = 0; n < 30; n++) { const row = f.admit(`done ${n}`); f.requests.finish(row.request_id, "completed"); }
  const indexed = f.requests.index("logical:parent", null, { activeOnly: true });
  assert.deepEqual(indexed.map(row => row.requestId), [active.request_id]);
  f.store.upsertSessionTurn({ sessionId: f.source.sessionId, bindingId: f.reference("logical:parent").bindingId,
    turnId: "native:running", routingVersion: f.reference("logical:parent").routingVersion, executionStatus: "running", startedAt: new Date().toISOString() });
  assert.equal(f.turns.state(f.reference("logical:parent")).requests[0].requestId, active.request_id);
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  assert.equal(f.turns.state(f.reference("logical:parent")).requests[0].requestId, active.request_id);
});

test("a supplement waits for the original target without occupying an execution slot", async t => {
  const f = await requestFixture(t);
  f.requests.schedule = () => {};
  const target = f.admit("target"), extra = f.admit("supplement");
  let dispatches = [{ dispatchId: "dispatch:target", taskId: null, status: "preparing" }];
  f.requests.dispatches = () => dispatches;
  assert.equal(f.requests.relate(extra.request_id, "supplement", target.request_id).waiting, true);
  f.requests.finish(target.request_id, "completed");
  assert.equal(f.requests.get(extra.request_id).status, "waiting");
  dispatches = [{ dispatchId: "dispatch:target", taskId: "task:target", status: "accepted" }];
  f.requests.wakeDependents(target.request_id);
  assert.equal(f.requests.get(extra.request_id).status, "accepted");
  assert.equal(f.requests.dependency(target.request_id).dispatches[0].taskId, "task:target");
});

test("retry immediately restores the original delivery state and preserves input identity", async t => {
  const f = await requestFixture(t);
  f.setPlanner(() => { throw Object.assign(new Error("temporary transport failure"), { code: "TEST_TRANSPORT" }); });
  const row = f.admit("retry input");
  await f.requests.running.get(row.request_id); await Promise.all([...f.requests.reclaiming.values()]);
  assert.equal(f.requests.get(row.request_id).status, "failed");
  f.requests.update(row.request_id, { delivery_id: "test-delivery" });
  const deliveries = [];
  f.store.getMessageDelivery = () => ({ deliveryId: "test-delivery", messageId: row.message_id, text: "retry input" });
  f.store.updateMessageDelivery = (id, patch) => deliveries.push({ id, ...patch });
  f.requests.schedule = () => {};
  await f.requests.retry("logical:parent", row.request_id);
  assert.equal(f.requests.get(row.request_id).status, "accepted");
  assert.equal(f.requests.get(row.request_id).message_id, row.message_id);
  assert.equal(deliveries.at(-1).status, "processing");
  assert.ok(f.events.some(event => event.type === "MessageDeliveryChanged"));
});

test("unsupported Providers cannot create a restricted Session or silently use ordinary tools", async t => {
  const f = await requestFixture(t);
  f.registry.get = () => ({ descriptor: { metadata: {} } });
  const row = f.admit("unsupported");
  await f.requests.running.get(row.request_id); await Promise.all([...f.requests.reclaiming.values()]);
  assert.equal(f.requests.get(row.request_id).error_code, "COORDINATION_ISOLATION_UNSUPPORTED");
  assert.equal(f.created.length, 0);
  assert.equal(f.requests.get(row.request_id).context_json, null);
});

test("live Codex independent requests use restricted startup and return to the main timeline", {
  skip: process.env.CORPTIE_LIVE_COORDINATION_SMOKE !== "1", timeout: 180000
}, async t => {
  // Explicit opt-in: only synthetic fixture context, an empty temporary cwd,
  // no project files or native tools. Use the environment-owned Provider home.
  const runtime = new CodexAppServerClient({ command: process.env.CORPTIE_LIVE_CODEX_BINARY ?? "codex" });
  t.after(() => runtime.close());
  const f = await requestFixture(t, "codex-app-server", runtime);
  const directory = await mkdtemp(join(tmpdir(), "corptie-live-shadow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  f.store.upsertSession({ ...f.store.getSession(f.source.sessionId), external: { cwd: directory } });
  const background = new BackgroundAgentService({ registry: f.registry });
  t.after(() => background.close());
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.setPlanner(async input => {
    if (JSON.parse(input.prompt).message.includes("FIRST")) await gate;
    return background.run(input);
  });
  const started = Date.now();
  const first = f.admit("Discussion only. Reply FIRST. Do not create or change any task."),
    second = f.admit("Discussion only. Reply SECOND. Do not create or change any task.");
  try {
    await f.requests.running.get(second.request_id);
    assert.equal(f.requests.get(second.request_id).status, "completed", f.requests.get(second.request_id).error_message);
    assert.equal(f.store.listUnsettledSessionTurns(f.source.sessionId).length, 0);
    release(); await f.requests.running.get(first.request_id);
    assert.equal(f.requests.get(first.request_id).status, "completed", f.requests.get(first.request_id).error_message);
    await Promise.all([...f.requests.reclaiming.values()]);
    assert.equal(f.store.getTask(f.parent.id).current_session_id, f.source.sessionId);
    assert.equal(f.deleted.length, 2);
    console.info("[live-coordination-evidence]", JSON.stringify({ elapsedMs: Date.now() - started,
      requests: [first.request_id, second.request_id].map(id => ({ id, status: f.requests.get(id).status,
        replyId: f.requests.get(id).response_item_id, cleanupError: f.requests.get(id).cleanup_error })) }));
  } finally { release(); await Promise.all([...f.requests.running.values()]); await Promise.all([...f.requests.reclaiming.values()]); }
});

async function recoveryFixture(t, provider = "codex-app-server") {
  const f = await fixture(t, provider);
  f.store.db.run("UPDATE tasks SET current_session_id=?,coordination_enabled=1 WHERE id=?", [f.source.sessionId, f.parent.id]);
  f.store.db.run("UPDATE sessions SET status='idle' WHERE id=?", [f.source.sessionId]);
  let created = 0;
  const shadow = new ShadowSessionService({ store: f.store,
    createSession: async () => f.store.getSession(f.open(`recovery_${++created}`, f.parent.id, { deferTaskProjection: true, status: "idle" }).sessionId),
    deleteSession: async id => f.store.deleteSession(id) });
  f.coordinator.shadow = shadow;
  const original = await shadow.ensure("logical:parent");
  const remove = () => {
    const id = f.store.getLogicalSession(shadow.forMain("logical:parent").shadow_session_id).legacySessionId;
    f.store.deleteSession(id); f.store.deleteLogicalSessionByLegacySessionId(id);
  };
  const finish = async key => {
    const receipt = f.coordinator.acceptDispatch(f.source, f.role.agentId, { items: [f.item(key)] });
    const id = receipt.dispatches[0].dispatchId;
    await f.coordinator.runDispatch(id);
    const operation = f.store.updateAgentTask(f.coordinator.get(id).operation_id, { status: "completed", targetTurnId: `turn:${key}` });
    f.store.upsertTimelineItemProjection(operation.sessionId, { id: `final:${key}`, turnId: operation.targetTurnId,
      type: "agentMessage", text: `Result ${key}`, status: "completed", createdAt: new Date().toISOString() });
    f.coordinator.onRuntimeEvent("AgentWorkCompleted", { task: operation });
    return id;
  };
  return { ...f, shadow, original, remove, finish, creations: () => created };
}

for (const provider of ["codex-app-server", "claude-sdk"]) test(`deleted summary is rebuilt once and keeps the main binding (${provider})`, async t => {
  const f = await recoveryFixture(t, provider), mainBinding = f.store.getLogicalSession("logical:parent").activeBinding.bindingId;
  f.remove();
  assert.equal(f.shadow.summary("logical:parent").status, "failed");
  const rows = await Promise.all(Array.from({ length: 10 }, () => f.shadow.ensure("logical:parent")));
  assert.equal(f.creations(), 2);
  assert.equal(new Set(rows.map(row => row.shadow_session_id)).size, 1);
  assert.notEqual(rows[0].shadow_session_id, f.original.shadow_session_id);
  assert.equal(f.store.getLogicalSession("logical:parent").activeBinding.bindingId, mainBinding);
  assert.equal(f.store.getTask(f.parent.id).current_session_id, f.source.sessionId);
  assert.equal(f.shadow.summary("logical:parent").status, "idle");
});

test("normal mode restores a deleted shadow and delivers the stored result without another child run", async t => {
  const f = await recoveryFixture(t);
  f.remove(); f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  const id = await f.finish("ordinary_after_shadow");
  await f.shadow.requestRecovery("logical:parent");
  f.coordinator.flushReports();
  const messageId = f.coordinator.get(id).report_message_id;
  assert.ok(messageId);
  const row = f.mailbox.raw(f.shadow.forMain("logical:parent").shadow_session_id, messageId);
  assert.equal(JSON.parse(row.authorization_json).purpose, "shadow_report");
  assert.equal(f.shadow.summary("logical:parent").status, "idle");
  f.coordinator.recover(); await nextTick(); f.coordinator.flushReports();
  assert.equal(f.coordinator.get(id).report_message_id, messageId);
  assert.equal(f.creations(), 2); assert.equal(f.starts.length, 1);
  assert.equal(f.store.selectOne("SELECT count(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n, 0);
});

test("pending shared result mailbox moves once after shadow deletion and keeps every receipt", async t => {
  const f = await recoveryFixture(t);
  const schedule = f.coordinator.scheduleReports;
  f.coordinator.scheduleReports = () => {};
  const ids = [await f.finish("move_one"), await f.finish("move_two")];
  f.coordinator.scheduleReports = schedule;
  f.coordinator.flushReports();
  const messages = ids.map(id => f.coordinator.get(id).report_message_id);
  assert.equal(messages[0], messages[1]);
  const originalOp = f.mailbox.raw(f.original.shadow_session_id, messages[0]).operation_id;
  f.remove(); await f.shadow.ensure("logical:parent");
  f.shadow.recover(f.mailbox, "logical:parent");
  const recipient = f.shadow.forMain("logical:parent").shadow_session_id;
  const moved = f.mailbox.raw(recipient, messages[0]);
  assert.equal(moved.operation_id, originalOp);
  assert.equal(f.store.getAgentTask(originalOp).status, "queued");
  assert.equal(f.store.getAgentTask(originalOp).sessionId, f.store.getLogicalSession(recipient).legacySessionId);
  assert.equal(f.store.selectOne("SELECT count(*) AS n FROM coordination_result_receipts WHERE mailbox_message_id=?", [messages[0]]).n, 2);
  f.coordinator.recover(); await nextTick(); f.coordinator.flushReports();
  assert.deepEqual(ids.map(id => f.coordinator.get(id).report_message_id), messages);
  assert.equal(f.starts.length, 2);
});

test("mode changes move only unstarted result messages and preserve their identity", async t => {
  const f = await recoveryFixture(t), id = await f.finish("switch_route");
  f.coordinator.flushReports();
  const messageId = f.coordinator.get(id).report_message_id;
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  f.coordinator.handleModeChanged(f.parent.id);
  assert.equal(JSON.parse(f.mailbox.raw(f.original.shadow_session_id, messageId).authorization_json).purpose, "shadow_report");
  f.workService.updateTask(f.parent.id, { coordinationEnabled: true });
  f.coordinator.handleModeChanged(f.parent.id);
  const moved = f.mailbox.raw(f.original.shadow_session_id, messageId);
  assert.equal(JSON.parse(moved.authorization_json).purpose, "shadow_report");
  f.store.updateAgentTask(moved.operation_id, { status: "running", startedAt: new Date().toISOString(), targetTurnId: "review:already-started" });
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  f.coordinator.handleModeChanged(f.parent.id);
  assert.equal(f.mailbox.raw(f.original.shadow_session_id, messageId).operation_id, moved.operation_id);
  assert.equal(f.creations(), 1);
});

test("an acceptance-unknown or user-cancelled mailbox operation is never retargeted", async t => {
  const f = await recoveryFixture(t);
  const messages = [];
  for (const state of ["unknown", "user_cancelled"]) {
    const message = f.mailbox.receiveEvent({ recipientSessionId: f.original.shadow_session_id,
      sourceType: "background", sourceId: state, body: state, intent: "response_required", idempotencyKey: state,
      authorization: { ownerLogicalSessionId: f.original.shadow_session_id, sourceId: state, purpose: "shadow_request" } });
    const row = f.mailbox.raw(f.original.shadow_session_id, message.messageId), op = f.store.getAgentTask(row.operation_id);
    f.store.updateAgentTask(op.taskId, state === "unknown"
      ? { source: { ...op.source, mailboxDispatchAttempted: true } }
      : { status: "cancelled", cancellation: { actor: "user", reason: "USER_STOP" } });
    assert.equal(f.mailbox.retargetUnstarted(message.messageId, "logical:parent", { purpose: "shadow_request" }), false);
    messages.push(message.messageId);
  }
  f.remove();
  for (const id of messages) assert.equal(f.mailbox.retargetUnstarted(id, "logical:parent", { purpose: "shadow_request" }), false);
});

test("turning mode off during summary creation keeps its child-management executor", async t => {
  const f = await recoveryFixture(t); f.remove();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const create = f.shadow.createSession;
  f.shadow.createSession = async (...args) => { await gate; return create(...args); };
  const flight = f.shadow.ensure("logical:parent");
  f.workService.updateTask(f.parent.id, { coordinationEnabled: false }); release();
  await flight;
  assert.equal(f.shadow.resolveRecipient("logical:parent").sessionId, "logical:recovery_2");
  assert.equal(f.store.selectOne("SELECT deleted_at FROM sessions WHERE id='provider:recovery_2'").deleted_at, null);
  assert.equal(f.shadow.forMain("logical:parent").shadow_session_id, "logical:recovery_2");
});

test("old report decisions are answered through the new executor without changing report authorship", async t => {
  const f = await recoveryFixture(t);
  const report = f.shadow.publish({ shadowId: f.original.shadow_session_id, turnId: "question", revision: 0,
    body: "需要选择", decision: { question: "选择A还是B" } });
  f.remove();
  const response = await f.shadow.answer("logical:parent", report.report_id, "A", "user-answer", f.mailbox);
  const newId = f.shadow.forMain("logical:parent").shadow_session_id;
  assert.notEqual(newId, f.original.shadow_session_id);
  const row = f.mailbox.raw(newId, response.messageId);
  f.shadow.validateDecision(row, JSON.parse(row.authorization_json));
  const saved = f.store.selectOne("SELECT * FROM coordination_shadow_reports WHERE report_id=?", [report.report_id]);
  assert.equal(saved.shadow_session_id, f.original.shadow_session_id);
  const repeated = await f.shadow.answer("logical:parent", report.report_id, "A", "user-answer", f.mailbox);
  assert.equal(repeated.messageId, response.messageId);
});

test("a stored shadow request is moved after deletion instead of being mistaken for already handled", async t => {
  const f = await recoveryFixture(t);
  const admitted = f.shadow.admit("logical:parent", "cleanup-request", "处理已授权交付", {}, f.mailbox);
  await nextTick();
  const initial = f.store.selectOne("SELECT * FROM coordination_shadow_requests WHERE request_id=?", [admitted.requestId]);
  assert.ok(initial.mailbox_message_id);
  f.remove(); await f.shadow.ensure("logical:parent");
  await f.shadow.deliverRequest(initial.request_id, f.mailbox);
  const row = f.mailbox.raw(f.shadow.forMain("logical:parent").shadow_session_id, initial.mailbox_message_id);
  f.shadow.validateRequest(row, JSON.parse(row.authorization_json));
  assert.equal(f.store.selectOne("SELECT count(*) AS n FROM session_mailbox_messages WHERE source_id=?", [initial.request_id]).n, 1);
});

test("child Channels recover historical shadows in ordinary mode and wait durably during rebuild", async t => {
  const f = await recoveryFixture(t), child = f.child("Channel_recovery");
  f.open("channel_recovery", child.id);
  const envelope = { message: { recipientSessionId: "logical:parent", senderSessionId: "logical:channel_recovery" } };
  f.remove(); f.workService.updateTask(f.parent.id, { coordinationEnabled: false });
  assert.throws(() => f.shadow.channelRecipient(envelope), { code: "SHADOW_SESSION_PREPARING" });
  await f.shadow.recovering.get("logical:parent");
  assert.equal(f.shadow.channelRecipient(envelope), f.shadow.forMain("logical:parent").shadow_session_id);
  assert.equal(envelope.message.recipientSessionId, "logical:parent");
});

test("desktop and mobile share the explicit shadow recovery action without changing mode", async t => {
  const f = await recoveryFixture(t); f.remove();
  const task = { ...f.store.getTask(f.parent.id), coordinationExecution: { status: "enforced", reason: "",
    shadow: f.shadow.summary("logical:parent") } };
  const document = projectNativeBusinessDocument({ session: f.store.getSession(f.source.sessionId), logicalSessionId: "logical:parent", task }, {}, "recovery", { editors: true });
  const card = document.cards.find(card => card.kind === "taskInfo");
  const action = card.actions.find(action => action.operation === "task.shadow.recover");
  assert.ok(action); assert.equal(card.data.coordinationExecution.shadow.status, "failed");
  for (const kind of ["local_user", "paired_device"]) {
    const calls = [];
    const ports = createDetailBusinessActionPorts({ inspector: {
      scope: () => ({ logicalSessionId: "logical:parent", task, context: {} }),
      recoverCoordinationShadow: id => calls.push(id)
    } });
    const scope = { sessionId: "logical:parent", identity: { kind } };
    assert.equal(ports["task.shadow.recover"].authorize(scope, action.target, task), true);
    ports["task.shadow.recover"].execute(scope, action.target, {});
    assert.deepEqual(calls, ["logical:parent"]);
    assert.equal(f.store.getTask(f.parent.id).coordination_enabled, 1);
    assert.throws(() => ports["task.shadow.recover"].execute(scope, { id: "task:foreign" }, {}), { code: "DETAIL_SCOPE_FORBIDDEN" });
  }
});

test("arrival of a final result automatically restores a deleted summary and never resends child instructions", async t => {
  const f = await recoveryFixture(t); f.remove();
  const id = await f.finish("automatic_restore");
  f.coordinator.flushReports();
  await f.shadow.recovering.get("logical:parent");
  await nextTick();
  const report = f.coordinator.get(id).report_message_id;
  assert.ok(report);
  assert.equal(f.mailbox.raw(f.shadow.forMain("logical:parent").shadow_session_id, report).disposition, "pending");
  assert.equal(f.creations(), 2); assert.equal(f.starts.length, 1);
  f.coordinator.flushReports();
  assert.equal(f.coordinator.get(id).report_message_id, report);
});

test("a failed summary creation retries on explicit recovery and keeps the stored child result", async t => {
  const f = await recoveryFixture(t); f.remove();
  const create = f.shadow.createSession;
  let attempts = 0;
  f.shadow.createSession = async (...args) => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("Provider setup incomplete"), { code: "PROVIDER_SETUP_REQUIRED" });
    return create(...args);
  };
  const id = await f.finish("retry_summary");
  f.coordinator.flushReports(); await f.shadow.recovering.get("logical:parent");
  assert.equal(f.shadow.summary("logical:parent").status, "failed");
  assert.equal(f.shadow.summary("logical:parent").canRecover, true);
  assert.equal(f.coordinator.get(id).report_message_id, null);
  f.coordinator.flushReports(); await nextTick();
  assert.equal(attempts, 1);
  await f.shadow.requestRecovery("logical:parent", { force: true }); f.coordinator.flushReports();
  assert.ok(f.coordinator.get(id).report_message_id);
  assert.equal(attempts, 2); assert.equal(f.starts.length, 1);
});

test("transient shadow startup failure uses bounded delayed recovery rather than a parent message", async t => {
  const f = await recoveryFixture(t); f.remove();
  f.shadow.recoveryDelaysMs = [5]; t.after(() => f.shadow.dispose());
  const create = f.shadow.createSession; let attempts = 0;
  f.shadow.createSession = async (...args) => {
    if (++attempts === 1) throw Object.assign(new Error("Temporary reset"), { code: "ECONNRESET" });
    return create(...args);
  };
  let recovered; const done = new Promise(resolve => { recovered = resolve; });
  f.shadow.onRecovered = () => recovered(f.shadow.forMain("logical:parent"));
  await f.shadow.requestRecovery("logical:parent");
  const timeout = setTimeout(() => recovered(null), 2000);
  const row = await done; clearTimeout(timeout);
  assert.ok(row?.shadow_session_id); assert.equal(attempts, 2);
  assert.equal(f.store.selectOne("SELECT count(*) AS n FROM session_mailbox_messages WHERE recipient_session_id='logical:parent'").n, 0);
});

test("legacy summary dispatch keeps its main owner through replacement before the first report", async t => {
  const f = await recoveryFixture(t);
  const id = await f.finish("legacy_summary");
  f.store.db.run("UPDATE task_coordination_dispatches SET source_session_id=?,report_message_id=NULL WHERE dispatch_id=?", [f.original.shadow_session_id, id]);
  f.remove(); await f.shadow.ensure("logical:parent");
  assert.equal(f.coordinator.reportOwner(f.coordinator.get(id)), "logical:parent");
  f.coordinator.flushReports();
  const messageId = f.coordinator.get(id).report_message_id;
  assert.ok(messageId);
  const row = f.mailbox.raw(f.shadow.forMain("logical:parent").shadow_session_id, messageId);
  f.coordinator.validateMailbox(row, JSON.parse(row.authorization_json));
  assert.equal(f.starts.length, 1);
});

test("startup request recovery pages beyond one hundred records and preserves message identity", async t => {
  const f = await recoveryFixture(t);
  const now = new Date().toISOString();
  for (let index = 0; index < 105; index++) f.store.db.run(`INSERT INTO coordination_shadow_requests
    (request_id,main_session_id,source_turn_id,body,source_json,created_at) VALUES(?,?,?,?,?,?)`,
    [`paged:${index}`, "logical:parent", `turn:${index}`, "Continue authorized work", "{}", now]);
  await f.shadow.recoverRequests(f.mailbox, "logical:parent");
  assert.equal(f.store.selectOne("SELECT count(*) AS n FROM coordination_shadow_requests WHERE mailbox_message_id IS NOT NULL").n, 105);
  await f.shadow.recoverRequests(f.mailbox, "logical:parent");
  assert.equal(f.store.selectOne("SELECT count(*) AS n FROM session_mailbox_messages WHERE recipient_session_id=?", [f.original.shadow_session_id]).n, 105);
});

test("live Codex summary replacement uses the restricted Session lifecycle", {
  skip: process.env.CORPTIE_LIVE_COORDINATION_SMOKE !== "1", timeout: 120000
}, async t => {
  const runtime = new CodexAppServerClient({ command: process.env.CORPTIE_LIVE_CODEX_BINARY ?? "codex" });
  t.after(() => runtime.close());
  const f = await requestFixture(t, "codex-app-server", runtime);
  const directory = await mkdtemp(join(tmpdir(), "corptie-live-summary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  f.store.upsertSession({ ...f.store.getSession(f.source.sessionId), external: { cwd: directory } });
  const shadow = new ShadowSessionService({ store: f.store,
    createSession: f.application.createSession.bind(f.application), deleteSession: f.application.deleteSession.bind(f.application) });
  let latest;
  try {
    const first = await shadow.ensure("logical:parent");
    await f.application.deleteSession(first.shadow_session_id);
    const restored = await Promise.all(Array.from({ length: 10 }, () => shadow.ensure("logical:parent")));
    latest = restored[0].shadow_session_id;
    assert.equal(new Set(restored.map(row => row.shadow_session_id)).size, 1);
    assert.notEqual(latest, first.shadow_session_id);
    assert.equal((await f.application.ensureActiveBindingToolsReady(latest)).executionPolicy, "host-coordination");
    assert.equal(f.created.length, 2);
    assert.equal(f.store.getTask(f.parent.id).current_session_id, f.source.sessionId);
    assert.equal(f.store.listUnsettledSessionTurns(f.source.sessionId).length, 0);
    console.info("[live-summary-recovery-evidence]", JSON.stringify({ created: f.created.length, concurrentRecoveryCalls: 10,
      mainUnsettledTurns: 0, childExecutions: f.starts.length, restored: true }));
  } finally { if (latest) await f.application.deleteSession(latest); }
});
