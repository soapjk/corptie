import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { createSessionCollaborationComposition } from "../src/application/sessionCollaborationComposition.mjs";
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
      // Real Git and Sandbox coordinators publish ready with their binding.
      store.setTaskCreationState(command.taskId, "ready");
      const session = store.getSession(metadata.sessionId), task = store.getTask(command.taskId);
      const proof = { status: "ready", session, task, receipt: { startupOperationId: `startup:${starts.length}`, taskId: task.id } };
      proofs.set(store.getLogicalSessionByLegacySessionId(session.id).logicalSessionId, proof);
      return proof;
    },
    getSessionBinding(id) { return proofs.get(id); }
  };
  let startupService = null;
  const service = createSessionCollaborationComposition({ store, workService, collaborationCore: core,
    getWorkSessionStartApplicationService: () => startupService, defaultProviderId: providerId });
  // Match server order: collaboration is constructed before startup service.
  startupService = starter;
  const input = (patch = {}) => ({ title: "Child", agentId: agent.agentId, parentTaskId: root.id,
    expectedParentResourceVersion: store.getTask(root.id).resource_version, ...evidence(), idempotencyKey: "child:one", ...patch });
  return { store, core, workService, work, root, agent, service, source, open, evidence, starts, starter, proofs, input };
}

test("ordinary Worker creates and replays a child without platform administration on every Provider", async t => {
  for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) await t.test(providerId, async t => {
    const f = await fixture(t, providerId), input = f.input();
    assert.throws(() => resolvePlatformAdminSession(f.store, { actorId: f.agent.agentId, sessionId: f.source.sessionId }), { code: "PLATFORM_ADMIN_SESSION_REQUIRED" });
    const [created, concurrent] = await Promise.all([f.service.createTaskAndSession(f.source, f.agent.agentId, input), f.service.createTaskAndSession(f.source, f.agent.agentId, input)]);
    assert.equal(created.task.parentTaskId, f.root.id);
    assert.equal(created.task.id, concurrent.task.id);
    assert.equal(created.startupStatus, "ready");
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].dispatchInitialTurn, false);
    f.store.updateTask(f.root.id, { });
    const replay = await f.service.createTaskAndSession(f.source, f.agent.agentId, input);
    assert.equal(replay.task.id, created.task.id); assert.equal(f.starts.length, 1);
    const renewed = await f.service.createTaskAndSession(f.source, f.agent.agentId, { ...input, ...f.evidence() });
    assert.equal(renewed.task.id, created.task.id);
    assert.equal(f.store.getTaskCreationOrigin(created.task.id).creationContextMessageId, null);
    assert.equal(f.store.getTaskCreationOrigin(created.task.id).creatorSessionId,"session:source");
    f.store.updateTask(created.task.id, { title: "Automatically_updated_title"});
    assert.equal((await f.service.createTaskAndSession(f.source, f.agent.agentId, input)).task.id, created.task.id);
    assert.equal(f.starts.length, 1);
    assert.equal(replay.task.creation_intent_json, undefined);
    await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, { ...input, parentTaskId: null, expectedParentResourceVersion: undefined }), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, { ...input, title: "Other" }), { code: "IDEMPOTENCY_CONFLICT" });
  });
});

test("autonomous single and batch creation need no user message or turn evidence on every Provider",async t=>{
  for(const provider of ["codex-app-server","claude-sdk","openclacky"]) await t.test(provider,async t=>{
    const f=await fixture(t,provider);
    const input={title:"Autonomous",agentId:f.agent.agentId,parentTaskId:f.root.id,
      expectedParentResourceVersion:f.store.getTask(f.root.id).resource_version,idempotencyKey:"autonomous:one"};
    const single=await f.service.createTaskAndSession(f.source,f.agent.agentId,input);
    assert.equal(single.task.parentTaskId,f.root.id);
    const batch=await f.service.createChildTasksBatch(f.source,f.agent.agentId,{
      parentTaskId:f.root.id,expectedParentResourceVersion:f.store.getTask(f.root.id).resource_version,
      items:Array.from({length:3},(_,index)=>({title:`Autonomous_${index}`,agentId:f.agent.agentId,idempotencyKey:`autonomous:batch:${index}`}))});
    assert.equal(batch.succeeded,3);assert.equal(f.starts.length,4);
    assert.equal(f.service.capabilities(f.source,f.agent.agentId).taskCreation.requiresExplicitUserIntent,false);
    assert.ok(batch.results.every(item=>f.store.getTaskCreationOrigin(item.result.task.id).creationContextMessageId===null));
    await assert.rejects(f.service.createTaskAndSession(f.source,f.agent.agentId,{
      title:"Independent",agentId:f.agent.agentId,idempotencyKey:"independent:no-user"}),{code:"INVALID_INPUT"});
  });
});

test("child schemas omit evidence requirements while independent creation keeps them",()=>{
  const ajv=new Ajv({strict:false});
  const single=ajv.compile(collaborationDynamicTools.find(tool=>tool.name==="corptie_collaboration_tasks_create").inputSchema);
  const input={title:"Child",agent_id:"agent:a",parent_task_id:"task:p",idempotency_key:"stable"};
  assert.equal(single(input),true);
  assert.equal(single({...input,parent_task_id:null}),false);
  const batch=ajv.compile(collaborationDynamicTools.find(tool=>tool.name==="corptie_collaboration_tasks_create_batch").inputSchema);
  assert.equal(batch({parent_task_id:"task:p",items:[{title:"Child",agent_id:"agent:a",idempotency_key:"stable"}]}),true);
});

test("child creation does not treat expired, planning or Automation message context as an authorization grant",async t=>{
  const f=await fixture(t);
  for(const [index,source] of ["desktop","automation","collaboration"].entries()) {
    const evidence=f.evidence(f.source,"分析并实现当前任务",source);
    const result=await f.service.createTaskAndSession(f.source,f.agent.agentId,f.input({
      ...evidence,title:`Autonomous_source_${index}`,idempotencyKey:`source:${index}`}));
    assert.equal(f.store.getTaskCreationOrigin(result.task.id).creationContextMessageId,null);
  }
  const input=f.input({title:"Autonomous_expired",idempotencyKey:"expired"});
  f.store.db.run("UPDATE session_events SET created_at='2000-01-01T00:00:00Z' WHERE event_id=?",[input.userMessageEventId]);
  assert.equal((await f.service.createTaskAndSession(f.source,f.agent.agentId,input)).task.parentTaskId,f.root.id);
});

test("production collaboration composition fails closed on invalid proofs and recovers the same pair without restart", async t => {
  for (const invalid of ["missing", "pending", "wrong-task", "wrong-session", "missing-reader"]) await t.test(invalid, async t => {
    const f = await fixture(t), input = f.input(), reader = f.starter.getSessionBinding;
    f.starter.getSessionBinding = invalid === "missing-reader" ? undefined : function (id) {
      const proof = reader.call(this, id);
      if (invalid === "missing") return undefined;
      if (invalid === "pending") return { ...proof, status: "pending" };
      if (invalid === "wrong-task") return { ...proof, task: { ...proof.task, id: "task:other" } };
      return { ...proof, session: { ...proof.session, id: "provider:other" } };
    };
    let recovery;
    await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, input), error => {
      recovery = error.creationRecovery;
      return error.code === "START_REFERENCE_INVALID" && Boolean(recovery?.taskId);
    });
    const task = f.store.getTask(recovery.taskId), sessionId = task.current_session_id;
    assert.ok(sessionId);
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].dispatchInitialTurn, false);
    assert.equal(f.store.listTasks().length, 2);
    f.starter.getSessionBinding = reader;
    const replay = await f.service.createTaskAndSession(f.source, f.agent.agentId, input);
    assert.equal(replay.task.id, task.id);
    assert.equal(replay.task.current_session_id, sessionId);
    assert.equal(replay.startupStatus, "ready");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(f.starts.length, 1);
    assert.equal(f.store.listTasks().length, 2);
    const logicalId = f.store.getLogicalSessionByLegacySessionId(sessionId).logicalSessionId;
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS n FROM message_deliveries WHERE session_id IN (?,?)", [sessionId, logicalId]).n, 0);
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

test("parent scope is enforced while nested child Sessions may create their own children", async t => {
  const f = await fixture(t), initial = f.store.listTasks().length;
  const other = f.store.createTask({ workId: f.work.id, title: "Other_root" });
  await assert.rejects(f.service.createTaskAndSession(f.source, f.agent.agentId, f.input({ parentTaskId: other.id })), { code: "TASK_PARENT_OUTSIDE_SCOPE" });
  assert.equal(f.store.listTasks().length, initial + 1);
  const child = f.store.createTask({ workId: f.work.id, title: "Existing_child", parentTaskId: f.root.id }, {}, { expectedParentResourceVersion: f.store.getTask(f.root.id).resource_version });
  const childSource = f.open("child-source", child.id);
  await assert.doesNotReject(f.service.createTaskAndSession(childSource, f.agent.agentId, { ...f.input(), parentTaskId: child.id, ...f.evidence(childSource) }));
  assert.equal(f.service.capabilities(childSource, f.agent.agentId).taskHierarchyCapabilities.createChild, true);
  assert.equal(f.starts.length, 1);
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

test("child tool schema and HTTP adapter preserve parent and exact authenticated Session without CAS", async t => {
  const f = await fixture(t), input = f.input(), tool = collaborationDynamicTools.find(tool => tool.name === "corptie_collaboration_tasks_create");
  const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
  const wire = { title: input.title, agent_id: input.agentId, parent_task_id: input.parentTaskId,
    expected_parent_resource_version: input.expectedParentResourceVersion,
    idempotency_key: input.idempotencyKey};
  assert.equal(validate(wire), true);
  const bad = { ...wire }; delete bad.expected_parent_resource_version; assert.equal(validate(bad), true);
  const client = { post: (path, body) => new Promise(resolve => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { method: "POST", headers: { "x-corptie-agent-id": f.agent.agentId, "x-corptie-session-id": f.source.sessionId } });
    const response = { writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    handleCollaborationHttpRequest({ request, response, url: new URL(path, "http://localhost"), core: f.core, sessionCollaborationService: f.service });
  }) };
  const result = await callCollaborationDynamicTool(client, tool.name, wire);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.task.parentTaskId, f.root.id);
  assert.equal(Object.hasOwn(result.body.task, "verification_criteria"), false);
  assert.equal(f.starts.length, 1);
});

test("explicit subtask authorization recognizes bilingual commands but not plans or quoted instructions", () => {
  for (const text of ["请创建两个子任务", "把这项工作拆成两个子Task", "create a subtask", "Please split this into subtasks", "Please create child tasks as needed"]) assert.equal(containsExplicitTaskCreationIntent(text), true, text);
  for (const text of ["给我一个完整方案", "不要创建子任务", "How to create subtasks?", "How to create child tasks?", "Don't create child tasks", "给我一个创建子任务的方案", "示例：\"create a subtask\"", "```create a subtask``` "]) assert.equal(containsExplicitTaskCreationIntent(text), false, text);
});

test("ordinary Session discovers the child-capable tool but not platform administration", async t => {
  const f = await fixture(t);
  const platform = { store: f.store, canAccess: PlatformOperationService.prototype.canAccess };
  const catalog = createHostToolCatalog({ sessionCollaborationV2Enabled: true,
    getProjectCodeApplicationService: () => null, getPlatformOperationService: () => platform });
  const names = catalog.definitions({ actorId: f.agent.agentId, metadata: f.source }).map(tool => tool.name);
  assert.ok(names.includes("corptie_collaboration_tasks_create"));
  assert.ok(names.includes("corptie_collaboration_tasks_create_batch"));
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

test("parent Sessions decide child count without a natural-language numeric quota", async t => {
  const f = await fixture(t), input = f.input();
  await f.service.createTaskAndSession(f.source, f.agent.agentId, input);
  await f.service.createTaskAndSession(f.source, f.agent.agentId,
    { ...input, title: "Another_child", idempotencyKey: "child:extra" });
  assert.equal(f.store.listTasks().length, 3);
  const batch = { ...f.input(), ...f.evidence(f.source, "请创建两个子任务"), idempotencyKey: "batch:one", title: "Batch_one" };
  await f.service.createTaskAndSession(f.source, f.agent.agentId, batch);
  await f.service.createTaskAndSession(f.source, f.agent.agentId, { ...batch, title: "Batch_two", idempotencyKey: "batch:two" });
  await f.service.createTaskAndSession(f.source, f.agent.agentId, { ...batch, title: "Batch_three", idempotencyKey: "batch:three" });
  assert.equal(f.store.listTasks().length, 6);
});

function batchInput(f, count = 3, prefix = "batch") {
  return { parentTaskId: f.root.id, expectedParentResourceVersion: f.store.getTask(f.root.id).resource_version,
    ...f.evidence(f.source, "请创建子任务来分工，具体数量你决定"),
    items: Array.from({ length: count }, (_, index) => ({ title: `Child_${prefix}_${index}`, agentId: f.agent.agentId,
      idempotencyKey: `${prefix}:${index}`})) };
}

test("batch schema, dynamic tool and HTTP endpoint create multiple children in one request", async t => {
  const f = await fixture(t), input = batchInput(f), definition = collaborationDynamicTools.find(tool => tool.name === "corptie_collaboration_tasks_create_batch");
  const wire = { parent_task_id: input.parentTaskId, expected_parent_resource_version: input.expectedParentResourceVersion,
    items: input.items.map(item => ({ title: item.title, agent_id: item.agentId, idempotency_key: item.idempotencyKey})) };
  const validate = new Ajv({ strict: false }).compile(definition.inputSchema);
  assert.equal(validate(wire), true);
  assert.equal(validate({ ...wire, items: [] }), false);
  assert.equal(validate({ ...wire, items: Array.from({ length: 11 }, () => wire.items[0]) }), true);
  let requests = 0;
  const client = { post: (path, body) => new Promise(resolve => {
    requests++;
    assert.equal(path, "/internal/collaboration/tasks/batch");
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { method: "POST", headers: { "x-corptie-agent-id": f.agent.agentId, "x-corptie-session-id": f.source.sessionId } });
    const response = { writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    handleCollaborationHttpRequest({ request, response, url: new URL(path, "http://localhost"), core: f.core, sessionCollaborationService: f.service });
  }) };
  const created = await callCollaborationDynamicTool(client, definition.name, wire);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.succeeded, 3); assert.equal(f.starts.length, 3); assert.equal(requests, 1);
  assert.ok(created.body.results.every(result => !Object.hasOwn(result.result.task, "verification_criteria")));
  const before = f.store.listTasks().length;
  const denied = await client.post("/internal/collaboration/tasks/batch", { ...input, items: Array(11).fill(input.items[0]) });
  assert.equal(denied.status, 400);
  assert.equal(f.store.listTasks().length, before);
});

test("batch items preserve configured defaults and explicit Provider override", async t => {
  const f = await fixture(t), input = batchInput(f, 2);
  await f.store.updateSettings({ newSessionDefaults: { taskCreation: { providerId: "claude-sdk", model: "configured-model", reasoningLevel: "high" } } });
  input.items[1].providerId = "openclacky";
  const result = await f.service.createChildTasksBatch(f.source, f.agent.agentId, input);
  assert.equal(result.succeeded, 2);
  assert.equal(f.starts[0].providerId, "claude-sdk"); assert.equal(f.starts[0].model, "configured-model");
  assert.equal(f.starts[0].reasoningLevel, "high"); assert.equal(f.starts[1].providerId, "openclacky");
});

test("one batch creates up to ten children on every Provider and replay is per item, not batch position", async t => {
  for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) await t.test(provider, async t => {
    const f = await fixture(t, provider), input = batchInput(f, 10);
    const [first, duplicate] = await Promise.all([f.service.createChildTasksBatch(f.source, f.agent.agentId, input),
      f.service.createChildTasksBatch(f.source, f.agent.agentId, input)]);
    assert.equal(first.status, "completed"); assert.equal(first.succeeded, 10); assert.equal(duplicate.succeeded, 10);
    assert.equal(f.starts.length, 10); assert.equal(f.store.listTasks().length, 11);
    assert.deepEqual(first.results.map(r => r.result.task.id), duplicate.results.map(r => r.result.task.id));
    assert.ok(first.results.every(r => r.result.task.parentTaskId === f.root.id && r.result.startupStatus === "ready"));
    const replay = await f.service.createChildTasksBatch(f.source, f.agent.agentId, { ...input, items: [...input.items].reverse() });
    assert.equal(replay.succeeded, 10); assert.equal(f.starts.length, 10);
    assert.deepEqual(replay.results.map(r => r.result.task.id), first.results.map(r => r.result.task.id).reverse());
    const more = await f.service.createChildTasksBatch(f.source, f.agent.agentId, { ...input, items: [{
      title: "Extra_child", agentId: f.agent.agentId, idempotencyKey: "extra:eleven" }] });
    assert.equal(more.succeeded, 1); assert.equal(f.starts.length, 11);
    const caps = f.service.capabilities(f.source, f.agent.agentId);
    assert.equal(caps.taskCreation.maxChildBatchSize, 10); assert.equal(caps.taskCreation.childCountPolicy, "session_decides");
    assert.ok(caps.actions.includes("tasks.create_batch"));
  });
});

test("invalid batch envelopes, duplicate keys and foreign parents reject before creating anything", async t => {
  const f = await fixture(t), input = batchInput(f);
  for (const items of [[], Array.from({ length: 11 }, () => input.items[0]), [null]]) {
    await assert.rejects(f.service.createChildTasksBatch(f.source, f.agent.agentId, { ...input, items }));
  }
  await assert.rejects(f.service.createChildTasksBatch(f.source, f.agent.agentId, { ...input,
    items: [input.items[0], input.items[0]] }), { code: "DUPLICATE_TASK_BATCH_KEY" });
  await assert.rejects(f.service.createChildTasksBatch(f.source, f.agent.agentId, { ...input,
    parentTaskId: "task:outside" }), { code: "TASK_PARENT_OUTSIDE_SCOPE" });
  assert.equal(f.store.listTasks().length, 1); assert.equal(f.starts.length, 0);
});

test("batch partial startup failure retries the same child without restarting successful siblings", async t => {
  const f = await fixture(t), input = batchInput(f), original = f.starter.start;
  let failed = false;
  f.starter.start = async command => {
    if (f.store.getTask(command.taskId).title.endsWith("_1") && !failed) {
      failed = true;
      throw Object.assign(new Error("Temporary Provider failure"), { code: "PROVIDER_UNAVAILABLE" });
    }
    return original(command);
  };
  const first = await f.service.createChildTasksBatch(f.source, f.agent.agentId, input);
  assert.equal(first.status, "partial"); assert.equal(first.succeeded, 2); assert.equal(first.failed, 1);
  const failure = first.results[1];
  assert.equal(failure.error.code, "PROVIDER_UNAVAILABLE");
  assert.ok(failure.error.creationRecovery.taskId);
  assert.equal(f.store.listTasks().length, 3); // failed Task remains hidden but recoverable
  const retry = await f.service.createChildTasksBatch(f.source, f.agent.agentId, { ...input, items: [input.items[1]] });
  assert.equal(retry.succeeded, 1); assert.equal(retry.results[0].result.task.id, failure.error.creationRecovery.taskId);
  assert.equal(f.starts.length, 3); assert.equal(f.store.listTasks().length, 4);
  const changed = await f.service.createChildTasksBatch(f.source, f.agent.agentId, { ...input,
    items: [{ ...input.items[0], title: "Changed_definition" }] });
  assert.equal(changed.results[0].error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(f.starts.length, 3);
});

for (const provider of ['codex-app-server','claude-sdk','openclacky']) test(`children need no parent revision and accept stale legacy callers (${provider})`,async t=>{
 const f=await fixture(t,provider);
 const intent={title:'No_parent_version',agentId:f.agent.agentId,parentTaskId:f.root.id,idempotencyKey:'no-version'};
 const original=f.store.assertParentForCreate.bind(f.store);let checked=0;
 f.store.assertParentForCreate=input=>{
  const result=original(input);
  if(++checked===1) queueMicrotask(()=>{
   f.workService.updateTask(f.root.id,{title:'Renamed_parent',priority:'low'});
   f.store.db.run('UPDATE tasks SET user_summary_json=?,resource_version=resource_version+1 WHERE id=?',['{"state":"stale"}',f.root.id]);
   f.store.createTask({workId:f.work.id,title:'Concurrent_sibling',parentTaskId:f.root.id});
  });
  return result;
 };
 const created=await f.service.createTaskAndSession(f.source,f.agent.agentId,intent);
 assert.equal(created.task.parentTaskId,f.root.id);assert.equal(f.starts.length,1);
 const replay=await f.service.createTaskAndSession(f.source,f.agent.agentId,{...intent,expectedParentResourceVersion:999999});
 assert.equal(replay.task.id,created.task.id);assert.equal(f.starts.length,1);
 const legacy=await f.service.createTaskAndSession(f.source,f.agent.agentId,{...intent,title:'Legacy_child',idempotencyKey:'legacy-version',expectedParentResourceVersion:1});
 assert.equal(legacy.task.parentTaskId,f.root.id);assert.equal(f.starts.length,2);
 const batch=await f.service.createChildTasksBatch(f.source,f.agent.agentId,{parentTaskId:f.root.id,
   items:[{title:'Batch_child_one',agentId:f.agent.agentId,idempotencyKey:'batch-one'},
     {title:'Batch_child_two',agentId:f.agent.agentId,idempotencyKey:'batch-two'}]});
 assert.equal(batch.succeeded,2);assert.equal(f.starts.length,4);
});

for(const state of ['archived','done','deleting','failed']) test(`parent becoming ${state} during preflight rejects before persistence`,async t=>{
 const f=await fixture(t),original=f.store.assertParentForCreate.bind(f.store);let changed=false;
 const getTask=f.store.getTask.bind(f.store);let completed=false;
 // Model an authorized completed parent. A raw SQL 'done' without a completion
 // receipt is deliberately repaired by the Store and is not a real completion.
 f.store.getTask=id=>{const task=getTask(id);return completed && id===f.root.id ? {...task,lifecycle_state:'done'} : task;};
 f.store.assertParentForCreate=input=>{
  const result=original(input);
  if(!changed){changed=true;queueMicrotask(()=>{
   if(state==='done'){completed=true;return;}
   const [field,value]=state==='archived'?['archived',1]:state==='deleting'?['deletion_status','deleting']:['creation_state','failed'];
   f.store.db.run(`UPDATE tasks SET ${field}=? WHERE id=?`,[value,f.root.id]);
  });}
  return result;
 };
 await assert.rejects(f.service.createTaskAndSession(f.source,f.agent.agentId,{title:'Child',agentId:f.agent.agentId,parentTaskId:f.root.id,idempotencyKey:'state-race'}),error=>['TASK_PARENT_UNAVAILABLE','STALE_SESSION_ROUTE'].includes(error.code));
 assert.equal(f.store.selectOne('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?',[f.root.id]).n,0);assert.equal(f.starts.length,0);
});
