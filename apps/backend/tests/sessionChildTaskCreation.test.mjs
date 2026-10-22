import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { SessionCollaborationService } from "../src/application/sessionCollaborationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { collaborationDynamicTools, callCollaborationDynamicTool } from "../src/collaboration/collaborationDynamicTools.mjs";
import { handleCollaborationHttpRequest } from "../src/collaboration/collaborationHttpApi.mjs";
import { containsExplicitTaskCreationIntent } from "../src/application/directUserTaskCreationAuthorization.mjs";
import { resolvePlatformAdminSession } from "../src/utils/platformAssistantIdentity.mjs";
import { createHostToolCatalog } from "../src/application/hostToolCatalogComposition.mjs";
import { PlatformOperationService } from "../src/application/platformOperationService.mjs";
import { TaskWorktreeHierarchyService } from "../src/application/taskWorktreeHierarchyService.mjs";

async function fixture(t, providerId = "codex-app-server") {
  const directory = await mkdtemp(join(tmpdir(), "corptie-child-task-"));
  const store = new CorptieStore({ dbPath: ":memory:", configPath: join(directory, "config.json"), manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const core = new CollaborationCore(store), workService = new WorkApplicationService({ store });
  const agent = store.createAgent({ name: "Worker", role: "independentContributor" });
  const work = workService.createWork({ name: "Child_test", contributorAgentIds: [agent.agentId] });
  const root = store.createTask({ workId: work.id, title: "Parent", mainAgentId: agent.agentId });
  const open = (id, taskId, kind = "worker") => {
    store.createSession({ id: `provider:${id}`, agentId: agent.agentId, title: id, provider: providerId,
      workId: work.id, taskId, sessionKind: kind });
    store.createLogicalSessionRoute({ logicalSessionId: `session:${id}`, legacySessionId: `provider:${id}`,
      providerThreadId: id, providerSessionId: `provider:${id}`, providerId, boundCwd: "/tmp", sessionName: id });
    core.bindSession({ agentId: agent.agentId, sessionId: `provider:${id}` });
    return { sessionId: `provider:${id}` };
  };
  const source = open("source", root.id);
  let sequence = 0;
  const evidence = (metadata = source, text = "请创建一个子任务", sourceType = "desktop") => {
    const logical = store.getLogicalSessionByLegacySessionId(metadata.sessionId), id = `create-${++sequence}`;
    const message = store.createUserMessageDelivery({ deliveryId: `delivery:${id}`, messageId: id,
      sessionId: metadata.sessionId, binding: logical.activeBinding, agentId: agent.agentId, text, source: { type: sourceType } });
    store.updateMessageDelivery(message.delivery.deliveryId, { status: "accepted", providerTurnId: id, providerAcknowledgedAt: new Date().toISOString() });
    const event = store.getSessionEvent(`user-message:${id}`);
    return { logicalSessionId: logical.logicalSessionId, userMessageEventId: event.eventId,
      userMessageSequence: event.sequence, turnId: id };
  };
  const starts = [], proofs = new Map();
  const starter = {
    async start(command) {
      starts.push(command);
      const metadata = open(`child-${starts.length}`, command.taskId);
      const session = store.getSession(metadata.sessionId), task = store.getTask(command.taskId);
      const proof = { status: "ready", session, task, receipt: { startupOperationId: `startup:${starts.length}`, taskId: task.id } };
      proofs.set(store.getLogicalSessionByLegacySessionId(session.id).logicalSessionId, proof);
      return proof;
    },
    getSessionBinding(id) { return proofs.get(id); }
  };
  const service = new SessionCollaborationService({ store, workService, collaborationCore: core,
    workSessionStartApplicationService: starter, defaultProviderId: providerId });
  const input = (patch = {}) => ({ title: "Child", agentId: agent.agentId, parentTaskId: root.id,
    expectedParentResourceVersion: store.getTask(root.id).resource_version, ...evidence(), idempotencyKey: "child:one", ...patch });
  return { store, core, workService, work, root, agent, service, source, open, evidence, starts, starter, proofs, input };
}

test("ordinary Worker creates and replays a child without platform administration on every Provider", async t => {
  for (const providerId of ["codex-app-server", "claude-sdk"]) await t.test(providerId, async t => {
    const f = await fixture(t, providerId), input = f.input();
    assert.throws(() => resolvePlatformAdminSession(f.store, { actorId: f.agent.agentId, sessionId: f.source.sessionId }), { code: "PLATFORM_ADMIN_SESSION_REQUIRED" });
    const [created, concurrent] = await Promise.all([f.service.createTaskAndSession(f.source, f.agent.agentId, input), f.service.createTaskAndSession(f.source, f.agent.agentId, input)]);
    assert.equal(created.task.parentTaskId, f.root.id);
    assert.equal(created.task.id, concurrent.task.id);
    assert.equal(created.startupStatus, "ready");
    assert.equal(f.starts.length, 1);
    f.store.updateTask(f.root.id, { description: "Parent_changed_after_creation" });
    const replay = await f.service.createTaskAndSession(f.source, f.agent.agentId, input);
    assert.equal(replay.task.id, created.task.id); assert.equal(f.starts.length, 1);
    const renewed = await f.service.createTaskAndSession(f.source, f.agent.agentId, { ...input, ...f.evidence() });
    assert.equal(renewed.task.id, created.task.id);
    assert.equal(f.store.getTaskCreationOrigin(created.task.id).creationContextMessageId, input.userMessageEventId);
    f.store.updateTask(created.task.id, { title: "Automatically_updated_title", description: "Updated_task_scope" });
    assert.equal((await f.service.createTaskAndSession(f.source, f.agent.agentId, input)).task.id, created.task.id);
    assert.equal(f.starts.length, 1);
    assert.equal(replay.task.creation_intent_json, undefined);
    await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, { ...input, parentTaskId: null, expectedParentResourceVersion: undefined }), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, { ...input, description: "Other" }), { code: "IDEMPOTENCY_CONFLICT" });
  });
});

test("Work Chat may choose a same-Work root; parent Session replacement preserves discovery", async t => {
  const f = await fixture(t), chat = f.open("chat", null, "workChat");
  const input = { ...f.input(), ...f.evidence(chat) };
  const created = await f.service.createTaskAndSession(chat, f.agent.agentId, input);
  const replacement = f.open("parent-replacement", f.root.id);
  assert.equal(f.service.getTask(replacement, f.agent.agentId, created.task.id).parentTaskId, f.root.id);
  assert.equal(f.service.getTask(replacement, f.agent.agentId, created.task.id).referencesAvailable, false);
  const childSession = { sessionId: f.store.getTask(created.task.id).current_session_id };
  assert.equal(f.service.getTask(childSession, f.agent.agentId, f.root.id).id, f.root.id);
  assert.equal(f.service.getTask(childSession, f.agent.agentId, f.root.id).referencesAvailable, false);
  const outsider = f.store.createTask({ workId: f.work.id, title: "Unrelated" });
  assert.throws(() => f.service.getTask(childSession, f.agent.agentId, outsider.id), { code: "TASK_OUTSIDE_SCOPE" });
});

test("parent scope, depth, CAS and explicit user intent fail before persistence", async t => {
  const f = await fixture(t), initial = f.store.listTasks().length;
  const other = f.store.createTask({ workId: f.work.id, title: "Other_root" });
  await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, f.input({ parentTaskId: other.id })), { code: "TASK_PARENT_OUTSIDE_SCOPE" });
  await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, f.input({ expectedParentResourceVersion: 999 })), { code: "TASK_PARENT_VERSION_CONFLICT" });
  await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, f.input({ expectedParentResourceVersion: undefined })), { code: "TASK_PARENT_VERSION_CONFLICT" });
  await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, { ...f.input(), ...f.evidence(f.source, "给我一个完整方案") }), { code: "USER_MESSAGE_TASK_CREATION_INTENT_MISSING" });
  assert.equal(f.store.listTasks().length, initial + 1);
  const child = f.store.createTask({ workId: f.work.id, title: "Existing_child", parentTaskId: f.root.id }, {}, { expectedParentResourceVersion: f.store.getTask(f.root.id).resource_version });
  const childSource = f.open("child-source", child.id);
  await assert.rejects(f.service.createTaskAndSession(childSource, f.agent.agentId, { ...f.input(), parentTaskId: child.id, ...f.evidence(childSource) }), { code: "TASK_MAX_DEPTH_EXCEEDED" });
  assert.equal(f.service.capabilities(childSource, f.agent.agentId).taskHierarchyCapabilities.createChild, false);
  assert.equal(f.starts.length, 0);
});

test("failed startup retains the original Task, recovery details and frozen default model", async t => {
  const f = await fixture(t), input = f.input();
  await f.store.updateSettings({ newSessionDefaults: { taskCreation: { providerId: "claude-sdk", model: "first-model", reasoningLevel: "high" } } });
  const start = f.starter.start;
  f.starter.start = async () => { throw Object.assign(new Error("Provider unavailable"), { code: "PROVIDER_CAPABILITY_UNAVAILABLE" }); };
  let taskId;
  await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, input), error => {
    taskId = error.creationRecovery?.taskId; return error.code === "PROVIDER_CAPABILITY_UNAVAILABLE" && Boolean(taskId);
  });
  await f.store.updateSettings({ newSessionDefaults: { taskCreation: { providerId: "codex-app-server", model: "changed-model" } } });
  f.starter.start = start;
  const created = await f.service.createTaskAndSession(f.source, f.agent.agentId, input);
  assert.equal(created.task.id, taskId);
  assert.equal(f.store.listTasks().length, 2);
  assert.equal(f.starts[0].providerId, "claude-sdk"); assert.equal(f.starts[0].model, "first-model");
  f.proofs.clear();
  await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, input), { code: "START_REFERENCE_INVALID" });
});

test("child tool schema and HTTP adapter preserve parent, CAS and exact authenticated Session", async t => {
  const f = await fixture(t), input = f.input(), tool = collaborationDynamicTools.find(tool => tool.name === "corptie_collaboration_tasks_create");
  const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
  const wire = { title: input.title, agent_id: input.agentId, parent_task_id: input.parentTaskId,
    expected_parent_resource_version: input.expectedParentResourceVersion, logical_session_id: input.logicalSessionId,
    user_message_event_id: input.userMessageEventId, user_message_sequence: input.userMessageSequence,
    turn_id: input.turnId, idempotency_key: input.idempotencyKey, verification_criteria: "Run tests" };
  assert.equal(validate(wire), true);
  const bad = { ...wire }; delete bad.expected_parent_resource_version; assert.equal(validate(bad), false);
  const client = { post: (path, body) => new Promise(resolve => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { method: "POST", headers: { "x-corptie-agent-id": f.agent.agentId, "x-corptie-session-id": f.source.sessionId } });
    const response = { writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    handleCollaborationHttpRequest({ request, response, url: new URL(path, "http://localhost"), core: f.core, sessionCollaborationService: f.service });
  }) };
  const result = await callCollaborationDynamicTool(client, tool.name, wire);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.task.parentTaskId, f.root.id);
  assert.equal(result.body.task.verification_criteria, "Run tests");
  assert.equal(f.starts.length, 1);
});

test("explicit subtask authorization recognizes bilingual commands but not plans or quoted instructions", () => {
  for (const text of ["请创建两个子任务", "把这项工作拆成两个子Task", "create a subtask", "Please split this into subtasks"]) assert.equal(containsExplicitTaskCreationIntent(text), true, text);
  for (const text of ["给我一个完整方案", "不要创建子任务", "How to create subtasks?", "给我一个创建子任务的方案", "示例：\"create a subtask\"", "```create a subtask``` "]) assert.equal(containsExplicitTaskCreationIntent(text), false, text);
});

test("ordinary Session discovers the child-capable tool but not platform administration", async t => {
  const f = await fixture(t);
  const platform = { store: f.store, canAccess: PlatformOperationService.prototype.canAccess };
  const catalog = createHostToolCatalog({ sessionCollaborationV2Enabled: true,
    getProjectCodeApplicationService: () => null, getPlatformOperationService: () => platform });
  const names = catalog.definitions({ actorId: f.agent.agentId, metadata: f.source }).map(tool => tool.name);
  assert.ok(names.includes("corptie_collaboration_tasks_create"));
  assert.equal(names.some(name => name.startsWith("corptie_platform_")), false);
  platform.canAccess = () => true;
  assert.ok(catalog.definitions({ actorId: f.agent.agentId, metadata: f.source }).some(tool => tool.name === "corptie_platform_tasks_manage"));
  assert.equal(f.service.capabilities(f.source, f.agent.agentId).actions.includes("tasks.create_child"), true);
});

test("cross-Work parents and non-Contributors never persist a Task", async t => {
  const f = await fixture(t), chat = f.open("chat-denial", null, "workChat");
  const outsider = f.store.createAgent({ name: "Outsider", role: "independentContributor" });
  const otherWork = f.workService.createWork({ name: "Other_work", contributorAgentIds: [outsider.agentId] });
  const otherRoot = f.store.createTask({ workId: otherWork.id, title: "Other_parent" });
  const before = f.store.listTasks().length;
  await assert.rejects(f.service.createTaskAndSession(chat, f.agent.agentId, { ...f.input(), ...f.evidence(chat), parentTaskId: otherRoot.id }), { code: "TASK_PARENT_OUTSIDE_SCOPE" });
  await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, f.input({ agentId: outsider.agentId })), { code: "AGENT_OUTSIDE_WORK" });
  assert.equal(f.store.listTasks().length, before);
  assert.equal(f.starts.length, 0);
});

test("asynchronous preflight cannot persist after its source Session is archived", async t => {
  const f = await fixture(t), original = TaskWorktreeHierarchyService.prototype.validateCreate;
  TaskWorktreeHierarchyService.prototype.validateCreate = async function (...args) {
    await original.apply(this, args);
    f.store.db.run("UPDATE logical_sessions SET archived=1 WHERE logical_session_id='session:source'");
  };
  try {
    await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, f.input()), { code: "STALE_SESSION_ROUTE" });
    assert.equal(f.store.listTasks().length, 1);
    assert.equal(f.starts.length, 0);
    assert.equal(f.service.capabilities(f.source, f.agent.agentId).taskCreation.child, false);
  } finally { TaskWorktreeHierarchyService.prototype.validateCreate = original; }
});

test("Git preflight rejection is not downgraded to an independent Task", async t => {
  const f = await fixture(t), original = TaskWorktreeHierarchyService.prototype.validateCreate;
  TaskWorktreeHierarchyService.prototype.validateCreate = async () => { throw Object.assign(new Error("Parent is dirty"), { code: "PARENT_WORKTREE_DIRTY" }); };
  try {
    await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, f.input()), { code: "PARENT_WORKTREE_DIRTY" });
    assert.equal(f.store.listTasks().length, 1);
    assert.equal(f.starts.length, 0);
  } finally { TaskWorktreeHierarchyService.prototype.validateCreate = original; }
});

test("one direct-user request cannot silently create more Tasks than requested", async t => {
  const f = await fixture(t), input = f.input();
  await f.service.createTaskAndSession(f.source, f.agent.agentId, input);
  await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId,
    { ...input, title: "Unexpected_extra_child", idempotencyKey: "child:extra" }), { code: "TASK_CREATION_QUOTA_EXCEEDED" });
  assert.equal(f.store.listTasks().length, 2);
  const batch = { ...f.input(), ...f.evidence(f.source, "请创建两个子任务"), idempotencyKey: "batch:one", title: "Batch_one" };
  await f.service.createTaskAndSession(f.source, f.agent.agentId, batch);
  await f.service.createTaskAndSession(f.source, f.agent.agentId, { ...batch, title: "Batch_two", idempotencyKey: "batch:two" });
  await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, { ...batch, title: "Batch_three", idempotencyKey: "batch:three" }), { code: "TASK_CREATION_QUOTA_EXCEEDED" });
  assert.equal(f.store.listTasks().length, 4);
});
