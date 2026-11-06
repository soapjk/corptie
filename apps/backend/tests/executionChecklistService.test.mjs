import test from "node:test";
import assert from "node:assert/strict";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { SessionMailboxService } from "../src/application/sessionMailboxService.mjs";
import { ExecutionChecklistService } from "../src/application/executionChecklistService.mjs";
import { executionChecklistDynamicTools, callExecutionChecklistTool } from "../src/application/executionChecklistDynamicTools.mjs";
import Ajv from "ajv";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { handleExecutionChecklistHttp } from "../src/application/executionChecklistHttpApi.mjs";

async function fixture(t, providerId = "codex-app-server", dbPath = ":memory:") {
  const store = new CorptieStore({ dbPath, configPath: "/unused-checklist-config", manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false }); t.after(() => store.close());
  const role = store.createAgent({ name: "Worker" });
  const work = new WorkApplicationService({ store }).createWork({ name: "Checklists", contributorAgentIds: [role.agentId] });
  const task = store.createTask({ workId: work.id, title: "Finite_work", mainAgentId: role.agentId });
  const sessionId = "provider:checklist";
  store.createSession({ id: sessionId, agentId: role.agentId, title: "Checklist", provider: providerId, workId: work.id, taskId: task.id, raw: { activeTurnId: "initial" }, sessionKind: "worker" });
  store.createLogicalSessionRoute({ logicalSessionId: "logical:checklist", legacySessionId: sessionId,
    providerThreadId: "checklist", providerSessionId: sessionId, providerId, boundCwd: "/tmp", sessionName: "Checklist" });
  const logical = store.getLogicalSessionByLegacySessionId(sessionId);
  let date = "2026-11-03T00:00:00.000Z", supported = true;
  const wakes = [], changes = [];
  const mailbox = new SessionMailboxService({ store });
  const service = new ExecutionChecklistService({ store, mailbox, clock: () => date, canExecute: () => supported,
    wake: (...args) => wakes.push(args), changed: value => changes.push(structuredClone(value)) });
  const context = { logicalSessionId: logical.logicalSessionId, turnId: "initial", bindingId: logical.activeBinding.bindingId, model: true };
  let serial = 0;
  const update = (input, ctx = context) => service.mutate(task.id, { operationId: `op:${++serial}`, expectedRevision: service.read(task.id)?.revision ?? 0, ...input }, ctx);
  const create = () => update({ action: "create", steps: [{ text: "Inspect" }, { text: "Implement" }, { text: "Validate" }] });
  return { store, service, task, logical, context, mailbox, wakes, changes, update, create,
    setDate: value => { date = value; }, unsupported: () => { supported = false; } };
}

test("CRUD, undo, stable IDs, stale revisions and idempotency never overwrite competing changes", async t => {
  const f = await fixture(t); f.create(); const itemId = f.service.read(f.task.id).steps[0].stepId;
  const command = { action: "status", status: "completed", itemId, expectedRevision: 1, operationId: "repeat" };
  f.update(command); const receipt = f.update(command).receipt;
  assert.equal(receipt.revision, 2); assert.equal(f.service.read(f.task.id).revision, 2);
  assert.throws(() => f.update({ ...command, status: "pending" }), /CHECKLIST_OPERATION_CONFLICT/);
  assert.throws(() => f.update({ action: "edit", itemId, text: "stale", expectedRevision: 1 }), /STALE/);
  f.update({ action: "status", itemId, status: "pending" });
  f.update({ action: "edit", itemId, text: "Updated", condition: "observable evidence" });
  assert.equal(f.service.read(f.task.id).steps[0].stepId, itemId);
  f.update({ action: "move", itemId, position: 2 });
  f.update({ action: "remove", itemId }); f.update({ action: "add", text: "Final verification" });
  assert.equal(f.service.read(f.task.id).steps.length, 3);
  assert.equal(f.service.read(f.task.id).steps[2].text, "Final verification");
});

test("Session scope and model tool schema cannot target another Task or create without current scope", async t => {
  const f = await fixture(t);
  const metadata = { sessionId: f.logical.logicalSessionId, providerBindingId: f.context.bindingId, taskId: f.task.id };
  assert.equal(f.service.scope(metadata).task.id, f.task.id);
  assert.throws(() => f.service.scope({ ...metadata, providerBindingId: "stale" }), /SCOPE/);
  assert.throws(() => f.service.scope({ ...metadata, taskId: "other" }), /SCOPE/);
  const validate = new Ajv({ strict: false }).compile(executionChecklistDynamicTools[0].inputSchema);
  assert.equal(validate({ action: "get" }), true);
  assert.equal(validate({ action: "status", itemId: "item" }), false);
  assert.equal(validate({ action: "get", taskId: "other" }), false);
  assert.equal(callExecutionChecklistTool(f.service, { metadata, arguments: { action: "get" } }).checklist.revision, 0);
});

test("SQLite reopen retains progress and dedup receipts without any continuation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "corptie-checklist-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "state.sqlite");
  const f = await fixture(t, "codex-app-server", dbPath); f.create();
  const child = f.store.createTask({ workId: f.task.work_id, parentTaskId: f.task.id, mainAgentId: f.task.main_agent_id, title: "Durable_child" });
  f.update({ action: "assign", itemIds: [f.service.read(f.task.id).steps[0].stepId], taskId: child.id });
  const value = f.service.read(f.task.id), command = { action: "status", itemId: value.steps[0].stepId,
    status: "completed", operationId: "durable-completion", expectedRevision: value.revision };
  f.update(command);
  // A second real connection exercises durable state rather than a JS cache.
  const reopened = new CorptieStore({ dbPath, configPath: "/unused-checklist-reopened-config", manageProcessEnvironment: false });
  await reopened.initialize({ resolveDataPath: false }); t.after(() => reopened.close());
  const service = new ExecutionChecklistService({ store: reopened, mailbox: new SessionMailboxService({ store: reopened }), clock: () => "2026-11-03T00:00:00.000Z" });
  assert.equal(service.read(f.task.id).completedCount, 1);
  assert.equal(service.read(f.task.id).steps[0].assignment.taskId, child.id);
  assert.equal(service.mutate(f.task.id, command, f.context).receipt.revision, 3);
  assert.equal(reopened.selectAll("SELECT * FROM execution_checklist_continuations").length, 0);
});

test("desktop HTTP mutations require local user authority and preview remains read-only", async t => {
  const f = await fixture(t); f.create(); let preview = false;
  const server = createServer((request, response) => handleExecutionChecklistHttp({ request, response,
    url: new URL(request.url, "http://localhost"), service: f.service, preview,
    sendJson: (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); },
    readJson: async req => { let body = ""; for await (const chunk of req) body += chunk; return JSON.parse(body); } }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/tasks/${encodeURIComponent(f.task.id)}/execution-checklist`;
  assert.equal((await fetch(url, { headers: { Origin: "https://external.invalid" } })).status, 403);
  assert.equal((await fetch(url, { headers: { "x-corptie-agent-id": "role" } })).status, 403);
  const snapshot = await (await fetch(url)).json(); assert.equal(snapshot.checklist.steps.length, 3);
  assert.equal(snapshot.checklist.authorizationRef, undefined);
  preview = true;
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 403);
  preview = false;
  const response = await fetch(url, { method: "POST", body: JSON.stringify({ action: "add", text: "User addition", operationId: "http-add", expectedRevision: 1 }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).checklist.steps.length, 4);
  const closed = await fetch(url, { method: "POST", body: JSON.stringify({ action: "close", operationId: "http-close", expectedRevision: 2 }) });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).checklist.closed, true);
});

test("model tool creates through authenticated binding and returns bounded remaining pages", async t => {
  const f = await fixture(t);
  const metadata = { sessionId: f.logical.logicalSessionId, providerBindingId: f.context.bindingId, taskId: f.task.id };
  const response = callExecutionChecklistTool(f.service, { metadata, arguments: { action: "create", expectedRevision: 0,
    operationId: "tool-create", steps: Array.from({ length: 100 }, (_, index) => ({ text: `Work ${index}` })) } });
  assert.equal(response.totalSteps, 100); assert.equal(response.checklist.steps.length, 8);
  assert.equal(response.remaining.length, 8); assert.equal(response.checklist.authorizationRef, undefined);
  const page = callExecutionChecklistTool(f.service, { metadata, arguments: { action: "get", offset: 20, limit: 10 } });
  assert.equal(page.checklist.steps[0].text, "Work 20"); assert.equal(page.nextOffset, 30);

});

for (const provider of ["codex-app-server", "claude-agent-sdk", "openclacky"]) {
  test(`${provider}: checklist records obstacles and completion without execution controls`, async t => {
    const f = await fixture(t, provider); f.create();
    const plan = f.service.read(f.task.id);
    assert.equal(plan.expiresAt, undefined);
    assert.equal(plan.remainingTurns, undefined);
    f.setDate("2030-01-01T00:00:00Z"); f.unsupported();
    f.mailbox.setPaused(f.logical.logicalSessionId, true);
    f.update({ action: "status", itemId: plan.steps[0].stepId, status: "blocked", reason: "Waiting for dependency" });
    f.update({ action: "status", itemId: plan.steps[1].stepId, status: "inProgress" });
    assert.equal(f.service.read(f.task.id).lifecycle, "active");
    assert.equal(f.service.read(f.task.id).stopReason, null);
    for (const step of plan.steps) f.update({ action: "status", itemId: step.stepId, status: "completed" });
    assert.equal(f.service.read(f.task.id).lifecycle, "completed");
    f.update({ action: "status", itemId: plan.steps[0].stepId, status: "pending" });
    assert.equal(f.service.read(f.task.id).lifecycle, "active");
    assert.equal(f.wakes.length, 0);
    assert.equal(f.store.selectAll("SELECT * FROM execution_checklist_continuations").length, 0);
    assert.equal(f.service.onTerminal, undefined);
    assert.equal(f.service.pauseSession, undefined);
  });
}

test("old stopped states are ignored without modifying progress or resuming anything", async t => {
  const f = await fixture(t); f.create();
  for (const lifecycle of ["blocked", "paused", "cancelled"]) {
    const old = { ...f.service.read(f.task.id), lifecycle, stopReason: "CHECKLIST_EXPIRED", expiresAt: "2000-01-01", remainingTurns: 0 };
    f.store.db.run("UPDATE execution_checklists SET body_json=? WHERE task_id=?", [JSON.stringify(old), f.task.id]);
    assert.equal(f.service.read(f.task.id).lifecycle, "active");
    assert.equal(f.service.display(old).stopReason, null);
    f.update({ action: "edit", itemId: old.steps[0].stepId, text: "Work still editable" });
    assert.equal(f.wakes.length, 0);
  }
});

test("retirement removes only unsent legacy checklist messages, leaving ordinary and running work intact", async t => {
  const f = await fixture(t); f.create();
  for (const id of ["legacy", "ordinary", "running"]) {
    f.store.enqueueAgentTask({ taskId: id, agentId: f.store.getSession(f.logical.legacySessionId).agentId,
      sessionId: f.logical.legacySessionId, kind: "user", priority: 0, text: "Work",
      source: id === "ordinary" ? { type: "desktop" } : { checklistTaskId: f.task.id } });
  }
  f.store.claimAgentTask("running");
  f.service.retireLegacyContinuations(); f.service.retireLegacyContinuations();
  assert.equal(f.store.getAgentTask("legacy").status, "cancelled");
  assert.equal(f.store.getAgentTask("ordinary").status, "queued");
  assert.equal(f.store.getAgentTask("running").status, "running");
  assert.equal(f.service.read(f.task.id).lifecycle, "active");
});

test("assignment supports many items per child, reassignment and removal without controlling child execution", async t => {
  const f = await fixture(t); f.create();
  const makeChild = title => f.store.createTask({ workId: f.task.work_id, parentTaskId: f.task.id,
    mainAgentId: f.task.main_agent_id, title });
  const child = makeChild("API"), other = makeChild("UI");
  const ids = f.service.read(f.task.id).steps.slice(0, 2).map(s => s.stepId);
  f.update({ action: "assign", itemIds: ids, taskId: child.id });
  let shown = f.service.display(f.service.read(f.task.id));
  assert.deepEqual(shown.steps.slice(0, 2).map(s => s.assignment.title), ["API", "API"]);
  assert.equal(shown.completedCount, 0);
  const stored = JSON.parse(f.store.selectOne("SELECT body_json FROM execution_checklists WHERE task_id=?", [f.task.id]).body_json);
  assert.deepEqual(stored.steps[0].assignment, { taskId: child.id });
  f.update({ action: "edit", itemId: ids[0], text: "Changed definition" });
  assert.equal(f.service.read(f.task.id).steps[0].assignment.taskId, child.id);
  f.update({ action: "assign", itemId: ids[0], taskId: other.id });
  f.update({ action: "unassign", itemIds: [ids[1]] });
  shown = f.service.display(f.service.read(f.task.id));
  assert.equal(shown.steps[0].assignment.title, "UI");
  assert.equal(shown.steps[1].assignment, undefined);
  assert.equal(f.store.getTask(child.id).lifecycle_state, "todo");
  assert.equal(f.wakes.length, 0);
  const before = f.service.read(f.task.id);
  assert.throws(() => f.update({ action: "assign", itemIds: [ids[0], "missing"], taskId: child.id }), /ITEM_NOT_FOUND/);
  assert.deepEqual(f.service.read(f.task.id), before);
  assert.throws(() => f.update({ action: "assign", itemIds: ids, taskId: f.task.id }), /SCOPE_INVALID/);
});

test("missing linked tasks do not prevent checklist display or progress edits", async t => {
  const f = await fixture(t); f.create();
  const value = f.service.read(f.task.id);
  value.steps[0].assignment = { taskId: "task:gone" };
  f.service.save(value);
  assert.equal(f.service.display(f.service.read(f.task.id)).steps[0].assignment.status, "unavailable");
  f.update({ action: "status", itemId: value.steps[1].stepId, status: "completed" });
  assert.equal(f.service.read(f.task.id).completedCount, 1);
});

test("successive batches preserve closed history and never control model execution", async t => {
  const f = await fixture(t); f.create();
  const first = f.service.read(f.task.id);
  f.update({ action: "status", itemId: first.steps[0].stepId, status: "completed" });
  const command = { action: "create", steps: [{ text: "Second batch" }],
    expectedRevision: f.service.read(f.task.id).revision, operationId: "second-batch" };
  const second = f.update(command).checklist;
  assert.notEqual(second.planId, first.planId);
  assert.equal(second.closed, false);
  assert.equal(second.steps[0].text, "Second batch");
  f.update(command);
  let history = f.store.getItems(f.logical.legacySessionId).filter(i => i.type === "executionChecklist");
  assert.equal(history.length, 2);
  const previous = history.find(i => i.id === first.planId).executionPlan;
  assert.equal(previous.closed, true);
  assert.equal(previous.completedCount, 1);
  assert.equal(previous.steps.length, 3);
  f.update({ action: "close" });
  assert.equal(f.service.read(f.task.id).closed, true);
  assert.equal(f.service.read(f.task.id).steps[0].status, "pending");
  f.update({ action: "status", itemId: second.steps[0].stepId, status: "completed" });
  assert.equal(f.service.read(f.task.id).closed, true);
  f.create();
  const third = f.service.read(f.task.id);
  assert.notEqual(third.planId, second.planId);
  assert.equal(third.closed, false);
  assert.equal(f.wakes.length, 0);
  assert.equal(f.store.getSession(f.logical.legacySessionId).status, "running");
});

test("manual close and closed batch history survive a SQLite reopen", async t => {
  const dir = await mkdtemp(join(tmpdir(), "corptie-checklist-batches-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "state.sqlite");
  const f = await fixture(t, "codex-app-server", dbPath); f.create();
  const first = f.service.read(f.task.id).planId;
  f.create(); f.update({ action: "close" });
  const reopened = new CorptieStore({ dbPath, configPath: "/unused-batch-config", manageProcessEnvironment: false });
  await reopened.initialize({ resolveDataPath: false }); t.after(() => reopened.close());
  const service = new ExecutionChecklistService({ store: reopened });
  assert.equal(service.read(f.task.id).closed, true);
  const history = reopened.getItems(f.logical.legacySessionId).filter(i => i.type === "executionChecklist");
  assert.equal(history.length, 2);
  assert.equal(history.find(i => i.id === first).executionPlan.closed, true);
});
