import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { TaskDeletionService } from "../src/application/taskDeletionService.mjs";
import { ChildTaskDiscardConfirmationService } from "../src/application/childTaskDiscardConfirmationService.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-discard-approval-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json"), manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const agent = store.createAgent({ name: "Test", provider: "codex-app-server" });
  const work = store.createWork({ name: "Test", contributorAgentIds: [agent.agentId] });
  const parent = store.createTask({ title: "Parent", workId: work.id, mainAgentId: agent.agentId });
  const child = store.createTask({ title: "Child", workId: work.id, mainAgentId: agent.agentId, parentTaskId: parent.id });
  store.upsertSession({ id: "session:main", title: "Parent", provider: "codex-app-server", agentId: agent.agentId,
    workId: work.id, taskId: parent.id, sessionKind: "worker", status: "idle" });
  store.bindSessionToTask("session:main", parent.id, work.id);
  const calls = [], events = [];
  let inspection = { status: "available", worktree: { worktreeId: "worktree:child", path: "/fixture/child", branchName: "task/child",
    dirty: false, statusSummary: "", mergedIntoMain: false, deliveryComparison: { delivered: false, commitCount: 1 } } };
  const getBinding = store.getTaskDeliveryBinding.bind(store);
  store.getTaskDeliveryBinding = id => id === child.id ? { worktree_id: "worktree:child" } : getBinding(id);
  const deletion = new TaskDeletionService({ store,
    authorize: ({ actor, task }) => task.work_id === work.id && (actor.type === "parent_session" && actor.id === "logical:parent"
      || actor.type === "user" && ["user:local-macos", "user:paired-device:device"].includes(actor.id)),
    inspectWorktree: async () => typeof inspection === "function" ? inspection() : inspection,
    removeWorktree: async () => { calls.push("remove"); return {}; },
    deleteSession: async id => { calls.push("session"); store.deleteSession(id); },
    handleArtifacts: async () => { calls.push("artifacts"); return {}; } });
  const service = new ChildTaskDiscardConfirmationService({ store, deletion, emitEvent: (...args) => events.push(args) });
  const actor = { type: "parent_session", id: "logical:parent" };
  const request = (patch = {}) => deletion.request(child.id, { idempotencyKey: "discard-one", stopRunning: true, ...patch }, actor);
  const reference = { sessionId: "session:main", logicalSessionId: "logical:parent" };
  const respond = (id, optionId = "approve", source = { type: "desktop" }) => service.respond(reference,
    { itemId: id, optionId, approved: optionId === "approve" }, source);
  return { store, deletion, service, actor, child, calls, events, request, reference, respond,
    setInspection: next => { inspection = next; } };
}

test("direct deletion only stages one durable approval and notification without freezing or side effects", async t => {
  const f = await fixture(t), receipt = await f.request();
  assert.equal(receipt.accepted, false); assert.equal(receipt.requiresUserConfirmation, true);
  assert.equal(f.store.getTask(f.child.id).deletion_status, null);
  assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM task_deletion_operations").n, 0);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.request()).confirmationId, receipt.confirmationId);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0][0], "ChildTaskDiscardConfirmationRequested");
  assert.match(f.events[0][1].notice.body, /不会先合入/);
  assert.equal(f.service.pendingNotices().length, 1);
  await assert.rejects(f.request({ artifactDisposition: "delete" }), { code: "TASK_DELETE_IDEMPOTENCY_CONFLICT" });
});

test("reject keeps the child; an Agent cannot approve by supplying a boolean", async t => {
  const f = await fixture(t), receipt = await f.request();
  await assert.rejects(f.respond(receipt.confirmationId, "approve", { type: "agent" }), { code: "TASK_DELETE_USER_CONFIRMATION_REQUIRED" });
  await f.respond(receipt.confirmationId, "reject");
  assert.equal(f.service.pendingNotices().length, 0);
  assert.equal((await f.request()).status, "submitted");
  assert.equal(f.store.getTask(f.child.id).deletion_status, null);
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.respond(receipt.confirmationId), { code: "APPROVAL_NOT_PENDING" });
});

test("explicit user click admits one existing deletion operation and replay does not delete again", async t => {
  const f = await fixture(t), receipt = await f.request();
  await Promise.all([f.respond(receipt.confirmationId), f.respond(receipt.confirmationId)]);
  const rows = f.store.selectAll("SELECT operation_id,input_json FROM task_deletion_operations");
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].input_json).actor.id, "user:local-macos");
  await f.deletion.inFlight.get(rows[0].operation_id);
  assert.equal(f.deletion.getOperation(rows[0].operation_id).state, "succeeded");
  await f.respond(receipt.confirmationId);
  assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM task_deletion_operations").n, 1);
});

test("pending confirmation survives service reconstruction and paired approval uses the authenticated user", async t => {
  const f = await fixture(t), receipt = await f.request();
  const restored = new ChildTaskDiscardConfirmationService({ store: f.store, deletion: f.deletion });
  assert.equal(restored.pendingNotices()[0].id, receipt.confirmationId);
  const api = new ClientSessionAPI({ store: f.store, resolveSession: () => f.reference.sessionId,
    respondToApproval: (_session, input, source) => restored.respond(f.reference, input, source) });
  await api.approval({ deviceId: "device" }, "session:main", { itemId: receipt.confirmationId, optionId: "approve" });
  const rows = f.store.selectAll("SELECT operation_id,input_json FROM task_deletion_operations");
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].input_json).actor.id, "user:paired-device:device");
  await f.deletion.inFlight.get(rows[0].operation_id);
  assert.equal(f.deletion.getOperation(rows[0].operation_id).state, "succeeded");
});


test("restart of a legacy parent-owned deletion stages confirmation instead of continuing cleanup", async t => {
  const f = await fixture(t);
  const old = f.store.beginTaskDeletionOperation(f.child.id, { mode: "force", artifactDisposition: "retain", actor: f.actor }, "legacy-before-confirmation");
  f.deletion.recoverInterruptedDeletions();
  await f.deletion.inFlight.get(old.operationId);
  await new Promise(resolve => setImmediate(resolve));
  const current = f.deletion.getOperation(old.operationId);
  assert.equal(current.state, "failed");
  assert.equal(current.errorCode, "TASK_DELETE_USER_CONFIRMATION_REQUIRED");
  assert.equal(f.service.pendingNotices().length, 1);
  assert.deepEqual(f.calls, []);
});


test("confirmation composition is safe before asynchronous Store initialization", () => {
  const deletion = {};
  const service = new ChildTaskDiscardConfirmationService({ store: { db: null }, deletion });
  assert.deepEqual(service.pendingNotices(), []);
  assert.equal(typeof deletion.requestUserConfirmation, "function");
});


const delivered = patch => ({ status: "available", worktree: { worktreeId: "worktree:child", path: "/fixture/child", branchName: "task/child",
  dirty: false, statusSummary: "", mergedIntoMain: false, aheadOfMain: 4, deliveryComparison: { delivered: true, commitCount: 0 }, ...patch } });

test("clean work already delivered to parent is deleted directly even before promotion to main", async t => {
  const f = await fixture(t); f.setInspection(delivered());
  const result = await f.request();
  assert.equal(result.accepted, true);
  await f.deletion.inFlight.get(result.operation.operationId);
  assert.equal(f.deletion.getOperation(result.operation.operationId).state, "succeeded");
  assert.equal(f.calls.filter(x => x === "remove").length, 1);
  assert.equal(f.service.pendingNotices().length, 0);
  assert.equal(f.events.length, 0);
});

test("a child without code resources needs no discard confirmation", async t => {
  const f = await fixture(t); f.setInspection({ status: "none", worktree: null });
  const result = await f.request();
  await f.deletion.inFlight.get(result.operation.operationId);
  assert.equal(f.deletion.getOperation(result.operation.operationId).state, "succeeded");
  assert.equal(f.events.length, 0);
});

for (const patch of [
  { dirty: true, statusSummary: " M source.ts" },
  { dirty: true, statusSummary: "?? new.ts" },
  { dirty: true, statusSummary: "M  staged.ts" },
  { dirty: true, statusSummary: "" },
  { mergedIntoMain: true, deliveryComparison: { delivered: false, commitCount: 1 } }
]) test(`remaining child changes require confirmation: ${JSON.stringify(patch)}`, async t => {
  const f = await fixture(t); f.setInspection(delivered(patch));
  const result = await f.request();
  assert.equal(result.requiresUserConfirmation, true);
  assert.deepEqual(f.calls, []);
});

test("a pending confirmation expires when the child work has since been delivered", async t => {
  const f = await fixture(t), pending = await f.request();
  f.setInspection(delivered());
  const result = await f.request();
  await f.deletion.inFlight.get(result.operation.operationId);
  assert.equal(f.deletion.getOperation(result.operation.operationId).state, "succeeded");
  assert.equal(f.store.getSessionItem("session:main", pending.confirmationId).status, "expired");
  assert.equal(f.service.pendingNotices().length, 0);
});

test("clean parent cleanup asks once if a cascaded descendant still has unmerged work", async t => {
  const f = await fixture(t);
  const nested = f.store.createTask({ title: "Nested", parentTaskId: f.child.id, workId: f.child.work_id, mainAgentId: f.child.main_agent_id });
  const inspect = f.deletion.inspectWorktree;
  f.setInspection(delivered());
  f.deletion.inspectWorktree = async id => id === nested.id ? delivered({ dirty: true, statusSummary: "?? pending.ts" }) : inspect(id);
  const result = await f.request();
  assert.equal(result.requiresUserConfirmation, true);
  assert.equal(f.service.pendingNotices().length, 1);
  assert.deepEqual(f.calls, []);
});

test("new edits arriving after admission stop deletion and generate user confirmation", async t => {
  const f = await fixture(t); let reads = 0;
  f.setInspection(() => delivered(++reads >= 5 ? { dirty: true, statusSummary: "?? late.ts" } : {}));
  const result = await f.request();
  await f.deletion.inFlight.get(result.operation.operationId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.deletion.getOperation(result.operation.operationId).errorCode, "TASK_DELETE_USER_CONFIRMATION_REQUIRED");
  assert.equal(f.service.pendingNotices().length, 1);
  assert.deepEqual(f.calls, []);
});
