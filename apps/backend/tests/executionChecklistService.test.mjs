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
import { createRuntimeAgentWorkQueue } from "../src/runtime/runtimeAgentWorkQueue.mjs";
import { createProviderTerminalLifecycle } from "../src/application/providerTerminalLifecycle.mjs";

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
  const terminal = turnId => service.onTerminal({ event: { type: "turn.completed", turnId, bindingId: context.bindingId, payload: {} }, projection: { session: store.getSession(sessionId), terminalStatus: "completed" } });
  return { store, service, task, logical, context, mailbox, wakes, changes, update, create, terminal,
    setDate: value => { date = value; }, unsupported: () => { supported = false; } };
}

for (const provider of ["codex-app-server", "claude-agent-sdk", "openclacky"]) {
test(`${provider}: three finite items continue across turns and stop when complete`, async t => {
  const f = await fixture(t, provider); f.create();
  let plan = f.service.read(f.task.id);
  f.update({ action: "status", itemId: plan.steps[0].stepId, status: "completed" });
  f.terminal("initial"); assert.equal(f.wakes.length, 1);
  f.terminal("initial"); assert.equal(f.wakes.length, 1);
  let operation = f.store.getAgentTask(f.wakes[0][1]);
  f.store.claimAgentTask(operation.taskId); f.service.onStarted(operation, "second");
  f.update({ action: "status", itemId: plan.steps[1].stepId, status: "completed" }, { ...f.context, turnId: "second" });
  f.terminal("second"); assert.equal(f.wakes.length, 2);
  f.store.updateAgentTask(operation.taskId, { status: "completed" });
  operation = f.store.getAgentTask(f.wakes[1][1]); f.store.claimAgentTask(operation.taskId); f.service.onStarted(operation, "third");
  f.update({ action: "status", itemId: plan.steps[2].stepId, status: "completed" }, { ...f.context, turnId: "third" });
  f.terminal("third"); assert.equal(f.wakes.length, 2);
  assert.equal(f.service.read(f.task.id).lifecycle, "completed");
  const items = f.store.getItems(f.logical.legacySessionId).filter(item => item.id === plan.planId);
  assert.equal(items.length, 1); assert.equal(items[0].executionPlan.completedCount, 3);
  assert.equal(items[0].executionPlan.authorizationRef, undefined);
});
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

test("user pause fences queued work and models cannot resume it", async t => {
  const f = await fixture(t); f.create(); f.terminal("initial");
  const operation = f.store.getAgentTask(f.wakes[0][1]);
  f.service.pauseSession(f.logical.legacySessionId);
  assert.equal(f.service.read(f.task.id).lifecycle, "paused");
  assert.throws(() => f.service.validateOperation(operation), /GENERATION/);
  assert.equal(f.store.getAgentTask(operation.taskId).status, "cancelled");
  assert.throws(() => f.update({ action: "resume" }), /USER_CONTROL/);
  f.terminal("initial"); assert.equal(f.wakes.length, 1);
});

test("no progress, blocked item, expiry and missing Provider capability stop without polling", async t => {
  for (const mode of ["no_progress", "blocked", "expiry", "unsupported", "mailbox"]) {
    const f = await fixture(t); f.create();
    if (mode === "blocked") f.update({ action: "status", itemId: f.service.read(f.task.id).steps[0].stepId, status: "blocked", reason: "Missing credential from user" });
    if (mode === "expiry") f.setDate("2026-11-03T01:00:00.000Z");
    if (mode === "unsupported") f.unsupported();
    if (mode === "mailbox") f.mailbox.setPaused(f.logical.logicalSessionId, true);
    f.terminal("initial");
    if (mode === "no_progress") {
      const operation = f.store.getAgentTask(f.wakes[0][1]); f.service.onStarted(operation, "second"); f.terminal("second");
    }
    assert.equal(f.service.read(f.task.id).lifecycle, "blocked");
    assert.equal(f.wakes.length, mode === "no_progress" ? 1 : 0);
  }
});

test("recovery admits only confirmed unsent work, never unknown dispatched work", async t => {
  const f = await fixture(t); f.create(); f.terminal("initial");
  const operation = f.store.getAgentTask(f.wakes[0][1]), registered = [];
  f.service.recover((...args) => registered.push(args)); assert.equal(registered.length, 1);
  f.store.updateAgentTask(operation.taskId, { status: "failed", source: { ...operation.source, mailboxDispatchAttempted: true } });
  f.service.recover(() => assert.fail("must not replay"));
  assert.equal(f.service.read(f.task.id).stopReason, "restart_requires_reconciliation");
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

test("admission failure rolls back budget, continuation receipt and mailbox writes", async t => {
  const f = await fixture(t); f.create(); const before = f.service.read(f.task.id);
  f.service.mailbox = { settings: () => ({ paused: false }), enqueueExternalOperation: () => { throw new Error("injected queue failure"); } };
  assert.throws(() => f.terminal("initial"), /injected/);
  assert.deepEqual(f.service.read(f.task.id), before);
  assert.equal(f.store.selectAll("SELECT * FROM execution_checklist_continuations").length, 0);
});

test("terminal to mailbox to shared queue actually dispatches the next authorized turn once", async t => {
  const f = await fixture(t);
  const sends = [];
  const noop = () => {};
  const queue = createRuntimeAgentWorkQueue({ store: f.store, sessionMailbox: f.mailbox, checklist: f.service,
    collaborationCore: { getAgentForSession: () => ({ agentId: f.store.getSession(f.logical.legacySessionId).agentId }) },
    workspaceContinuationCoordinator: { assertWorkTarget: noop, recordWorkStarted: noop, recordWorkSettled: noop },
    inspectCollaborationSession: async () => f.store.getRunningAgentTaskForSession(f.logical.legacySessionId) ? "running" : "idle", emitEvent: noop,
    sendUnifiedSessionMessage: async (...args) => { sends.push(args); return { result: { turnId: `continued:${sends.length}`, delivery: "accepted" } }; },
    syncSessionChannelDeliveriesIntoAgentWorkQueue: async () => {}, syncCollaborationDeliveriesIntoAgentWorkQueue: async () => {} });
  f.service.wake = (sessionId, operationId) => queue.registerRuntimeQueuedWork(sessionId, operationId);
  const terminal = createProviderTerminalLifecycle({ store: f.store, sessionMailbox: f.mailbox, emitEvent: noop,
    recordWorkSettled: noop, settleEntityTaskFromSession: noop, collaborationCore: { getAgentForSession: noop },
    refreshWorkspaceInventoryAfterTurn: noop, continuePendingWorkspaceTransition: noop, continuePendingProviderSwitch: noop,
    resumeWorkAfterTransition: noop, scheduleAgentWorkDrain: noop, onChecklistTerminal: input => f.service.onTerminal(input) });
  f.create(); const plan = f.service.read(f.task.id);
  f.update({ action: "status", itemId: plan.steps[0].stepId, status: "completed" });
  const event = { type: "turn.completed", bindingId: f.context.bindingId, turnId: "initial", payload: {} };
  terminal({ event, projection: { session: f.store.getSession(f.logical.legacySessionId) } });
  await queue.drainAgentWork(f.logical.legacySessionId);
  assert.equal(sends.length, 1); assert.match(sends[0][1], /Implement/);
  assert.equal(sends[0][3].fromAgentWorkQueue, true);
  assert.equal(f.service.read(f.task.id).observedTurnId, "continued:1");
  terminal({ event, projection: { session: f.store.getSession(f.logical.legacySessionId) } });
  await queue.drainAgentWork(f.logical.legacySessionId); assert.equal(sends.length, 1);
});

test("definition changes cancel a queued stale message; paused undo never resumes execution", async t => {
  const f = await fixture(t); f.create(); f.terminal("initial");
  const old = f.store.getAgentTask(f.wakes[0][1]);
  f.update({ action: "edit", itemId: f.service.read(f.task.id).steps[0].stepId, text: "New instruction" }, {});
  assert.equal(f.store.getAgentTask(old.taskId).status, "cancelled");
  assert.throws(() => f.service.validateOperation(old), /GENERATION/);
  assert.match(f.store.getAgentTask(f.wakes.at(-1)[1]).text, /New instruction/);
  f.update({ action: "pause" }, {});
  const count = f.wakes.length, itemId = f.service.read(f.task.id).steps[0].stepId;
  f.update({ action: "status", itemId, status: "completed" }, {});
  f.update({ action: "status", itemId, status: "pending" }, {});
  assert.equal(f.service.read(f.task.id).lifecycle, "paused"); assert.equal(f.wakes.length, count);
});

test("finite budget and binding or Task definition changes fence automatic dispatch", async t => {
  for (const field of ["remainingTurns", "taskRevision", "observedBindingId"]) {
    const f = await fixture(t); f.create(); const value = f.service.read(f.task.id);
    if (field === "remainingTurns") value.remainingTurns = 0;
    if (field === "taskRevision") value.taskRevision = -1;
    if (field === "observedBindingId") value.observedBindingId = "old-binding";
    f.service.save(value); f.terminal("initial");
    assert.equal(f.wakes.length, 0);
    if (field !== "observedBindingId") assert.equal(f.service.read(f.task.id).lifecycle, "blocked");
  }
});

test("SQLite reopen retains progress, dedup receipts and only unsent continuation admission", async t => {
  const dir = await mkdtemp(join(tmpdir(), "corptie-checklist-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "state.sqlite");
  const f = await fixture(t, "codex-app-server", dbPath); f.create();
  const value = f.service.read(f.task.id), command = { action: "status", itemId: value.steps[0].stepId,
    status: "completed", operationId: "durable-completion", expectedRevision: value.revision };
  f.update(command); f.terminal("initial");
  // A second real connection exercises durable state rather than a JS cache.
  const reopened = new CorptieStore({ dbPath, configPath: "/unused-checklist-reopened-config", manageProcessEnvironment: false });
  await reopened.initialize({ resolveDataPath: false }); t.after(() => reopened.close());
  const service = new ExecutionChecklistService({ store: reopened, mailbox: new SessionMailboxService({ store: reopened }), clock: () => "2026-11-03T00:00:00.000Z" });
  assert.equal(service.read(f.task.id).completedCount, 1);
  assert.equal(service.mutate(f.task.id, command, f.context).receipt.revision, 2);
  const registered = []; service.recover((...args) => registered.push(args));
  assert.equal(registered.length, 1);
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
  f.terminal("initial");
  const operation = f.store.getAgentTask(f.wakes[0][1]); f.service.onFailed(operation);
  assert.equal(f.service.read(f.task.id).stopReason, "dispatch_result_unknown");
  assert.equal(f.store.getAgentTask(operation.taskId).status, "cancelled");
});
