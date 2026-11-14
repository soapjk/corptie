import test from "node:test";
import assert from "node:assert/strict";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { ExecutionChecklistService } from "../src/application/executionChecklistService.mjs";
import { VerificationBudgetService } from "../src/application/verificationBudgetService.mjs";
import { verificationBudgetDynamicTools, callVerificationBudgetTool } from "../src/application/verificationBudgetDynamicTools.mjs";
import { handleVerificationBudgetHttp } from "../src/application/verificationBudgetHttpApi.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { createServer } from "node:http";
import { ClientDeviceAuthority } from "../src/application/clientDeviceAuthority.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

async function fixture(t, { provider = "codex-app-server", dbPath = ":memory:", run } = {}) {
  const store = new CorptieStore({ dbPath, configPath: "/unused-verification-config", manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false }); t.after(() => store.close());
  const agent = store.createAgent({ name: "BudgetWorker" });
  const work = new WorkApplicationService({ store }).createWork({ name: "Budget", contributorAgentIds: [agent.agentId] });
  const task = store.createTask({ workId: work.id, title: "Budget_task", mainAgentId: agent.agentId });
  const sessionId = "provider:budget";
  store.createSession({ id: sessionId, agentId: agent.agentId, title: "Budget", provider, workId: work.id,
    taskId: task.id, raw: { activeTurnId: "turn:1" }, sessionKind: "worker" });
  store.createLogicalSessionRoute({ logicalSessionId: "logical:budget", legacySessionId: sessionId, providerThreadId: "budget", providerSessionId: sessionId,
    providerId: provider, boundCwd: "/tmp", sessionName: "Budget" });
  const logical = store.getLogicalSessionByLegacySessionId(sessionId);
  store.enqueueAgentTask({ taskId: "instruction:1", agentId: agent.agentId, sessionId, kind: "user", priority: 0,
    text: "Implement", source: { type: "desktop", messageId: "instruction:1" } });
  store.claimAgentTask("instruction:1");
  store.db.run("UPDATE agent_operations SET target_turn_id='turn:1' WHERE task_id='instruction:1'");
  const metadata = { sessionId: logical.logicalSessionId, providerBindingId: logical.activeBinding.bindingId, taskId: task.id };
  const calls = [], interrupts = [];
  const service = new VerificationBudgetService({ store, scope: value => new ExecutionChecklistService({ store }).scope(value),
    workingDirectory: () => "/tmp", run: run ?? (async (...args) => { calls.push(args); return { stdout: "passed", stderr: "" }; }),
    interrupt: async id => { interrupts.push(id); } });
  const input = id => ({ executionId: id, developmentComplete: true, commands: [{ file: "/usr/bin/true", args: [] }] });
  return { service, store, task, metadata, calls, interrupts, input, logical, agent, work, sessionId };
}

test("one batch charges once and retries never rerun or duplicate outputs", async t => {
  const f = await fixture(t);
  const first = await f.service.execute(f.metadata, f.input("run:1"));
  assert.equal(first.results[0].stdout, "passed"); assert.equal(first.budget.used, 1);
  const retry = await f.service.execute(f.metadata, { ...f.input("run:1"), commands: [{ file: "changed", args: [] }] });
  assert.equal(retry.launch, false); assert.equal(f.calls.length, 1);
  assert.equal(f.store.selectOne("SELECT * FROM verification_budget_charges").stdout, undefined);
});

test("final permitted success completes; next round cannot launch and notifies once", async t => {
  const f = await fixture(t); f.service.setDefault(1);
  const result = await f.service.execute(f.metadata, f.input("run:1"));
  assert.equal(result.budget.paused, false); assert.equal(f.interrupts.length, 0);
  await assert.rejects(f.service.execute(f.metadata, f.input("run:2")), { code: "VERIFICATION_BUDGET_EXHAUSTED" });
  await assert.rejects(f.service.execute(f.metadata, f.input("run:3")), { code: "VERIFICATION_BUDGET_EXHAUSTED" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.selectAll("SELECT * FROM session_items WHERE id LIKE 'verification-budget:%'").length, 1);
});

test("failed final output is returned before interruption; extending is idempotent and task-scoped", async t => {
  const f = await fixture(t, { run: async () => { throw Object.assign(new Error("failed"), { code: 1, stdout: "assertion failure" }); } });
  f.service.setDefault(1);
  const result = await f.service.execute(f.metadata, f.input("run:1"));
  assert.equal(result.results[0].stdout, "assertion failure"); assert.equal(result.budget.paused, true);
  assert.equal(f.interrupts.length, 0);
  assert.throws(() => f.service.extend("other", "instruction:1", { requestId: "extend:1" }), { code: "VERIFICATION_NOT_FOUND" });
  assert.equal(f.service.extend(f.task.id, "instruction:1", { requestId: "extend:1" }).limit, 2);
  assert.equal(f.service.extend(f.task.id, "instruction:1", { requestId: "extend:1" }).limit, 2);
  assert.throws(() => f.service.extend(f.task.id, "instruction:1", { requestId: "extend:1", amount: 2 }), { code: "VERIFICATION_REQUEST_CONFLICT" });
});

test("simultaneous calls cannot consume the last slot twice", async t => {
  let finish; const f = await fixture(t, { run: () => new Promise(resolve => { finish = resolve; }) });
  f.service.setDefault(1);
  const first = f.service.execute(f.metadata, f.input("run:1"));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.execute(f.metadata, f.input("run:2")), { code: "VERIFICATION_ALREADY_RUNNING" });
  finish({ stdout: "ok", stderr: "" }); await first;
  assert.equal(f.service.read("instruction:1").used, 1);
});

test("invalid scope, incomplete development, and invalid commands spend nothing", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.execute({ ...f.metadata, providerBindingId: "stale" }, f.input("r")));
  await assert.rejects(f.service.execute(f.metadata, { ...f.input("r"), developmentComplete: false }), { code: "DEVELOPMENT_NOT_FINISHED" });
  await assert.rejects(f.service.execute(f.metadata, { ...f.input("r"), commands: [] }), { code: "VERIFICATION_COMMANDS_INVALID" });
  assert.equal(f.service.list(f.task.id).length, 0);
});

test("known spawn failure refunds while interrupted or unknown execution remains charged", async t => {
  const f = await fixture(t, { run: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  const result = await f.service.execute(f.metadata, f.input("run:1"));
  assert.equal(result.budget.used, 0);
  const scope = f.service.current(f.metadata);
  f.service.reserve(scope, "uncertain"); f.service.recover();
  assert.equal(f.service.read(scope.instructionId).used, 1);
  assert.equal(f.service.reserve(scope, "uncertain").launch, false);
});

test("SQLite reopen preserves charges and existing limits despite changed defaults", async t => {
  const dir = await mkdtemp(join(tmpdir(), "corptie-budget-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "budget.sqlite"), f = await fixture(t, { dbPath: path });
  await f.service.execute(f.metadata, f.input("run:1")); f.service.setDefault(7);
  const reopened = new CorptieStore({ dbPath: path, configPath: "/unused-budget-reopened", manageProcessEnvironment: false });
  await reopened.initialize({ resolveDataPath: false }); t.after(() => reopened.close());
  const service = new VerificationBudgetService({ store: reopened });
  assert.equal(service.read("instruction:1").used, 1); assert.equal(service.read("instruction:1").limit, 3);
  assert.equal(service.defaultLimit(), 7);
});

test("Codex, Claude, and OpenClacky share the exact entry contract", async t => {
  for (const provider of ["codex-app-server", "claude-agent-sdk", "openclacky"]) {
    const f = await fixture(t, { provider });
    const result = await callVerificationBudgetTool(f.service, { metadata: f.metadata, arguments: { action: "run", ...f.input("r") } });
    assert.equal(result.budget.used, 1); assert.match(result.budget.limitation, /绕过/);
  }
  const validate = new Ajv({ strict: false }).compile(verificationBudgetDynamicTools[0].inputSchema);
  assert.equal(validate({ action: "get" }), true); assert.equal(validate({ action: "run" }), false);
  assert.equal(validate({ action: "extend", amount: 100 }), false);
});

test("desktop mutations require user transport and preview stays read-only", async t => {
  const f = await fixture(t); await f.service.execute(f.metadata, f.input("run:1"));
  const response = (headers, preview) => new Promise(resolve => {
    handleVerificationBudgetHttp({ request: { method: "POST", headers, socket: { remoteAddress: "127.0.0.1" } }, response: {},
      url: new URL(`http://localhost/tasks/${encodeURIComponent(f.task.id)}/verification-budgets/instruction%3A1/extend`), service: f.service,
      readJson: async () => ({ requestId: "local-extend" }), sendJson: (_response, status, value) => resolve({ status, value }), preview });
  });
  assert.equal((await response({ "x-corptie-agent-id": "agent" }, false)).status, 403);
  assert.equal((await response({}, true)).status, 403);
  assert.equal((await response({}, false)).status, 200);
});

test("child dispatches use the parent's original operation budget and queued work sees exhaustion", async t => {
  const f = await fixture(t); f.service.setDefault(1);
  await f.service.execute(f.metadata, f.input("r"));
  f.store.db.run(`INSERT INTO task_coordination_dispatches(dispatch_id,source_session_id,parent_task_id,source_role_id,
    idempotency_key,request_json,runtime_json,mode_at_admission,operation_id,source_turn_id,created_at,updated_at)
    VALUES('dispatch:child',?,?,?,'child','{}','{}',0,'child:operation','turn:1','2026-11-01','2026-11-01')`,
  [f.logical.logicalSessionId, f.task.id, f.agent.agentId]);
  f.store.enqueueAgentTask({ taskId: "child:operation", agentId: f.agent.agentId, sessionId: f.sessionId,
    kind: "collaboration", priority: 0, text: "Child", source: { coordinationDispatchId: "dispatch:child" } });
  const raw = f.store.selectOne("SELECT * FROM agent_operations WHERE task_id='child:operation'");
  assert.equal(f.service.operationRoot(raw).instructionId, "instruction:1");
  const scope = f.service.operationRoot(raw);
  assert.throws(() => f.service.reserve(scope, "child:run"), { code: "VERIFICATION_BUDGET_EXHAUSTED" });
  f.service.stop(f.task.id, "instruction:1"); assert.equal(f.service.operationPaused("child:operation"), true);
  f.service.extend(f.task.id, "instruction:1", { requestId: "more" }); assert.equal(f.service.operationPaused("child:operation"), false);
});

test("an interrupted verification aborts only its own executor", async t => {
  let started; const start = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { run: async (_file, _args, { signal }) => {
    started(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }))));
  } });
  const execution = f.service.execute(f.metadata, f.input("r")); await start;
  f.service.cancelSession("other"); assert.equal(f.service.active.size, 1);
  f.service.cancelSession(f.sessionId);
  const result = await execution; assert.equal(result.results[0].reason, "ABORT_ERR"); assert.equal(result.budget.used, 1);
});

test("simple continue reuses the budget, independent user instruction does not", async t => {
  const f = await fixture(t); await f.service.execute(f.metadata, f.input("r"));
  const original = f.store.selectOne("SELECT * FROM agent_operations WHERE task_id='instruction:1'");
  const later = { ...original, task_id: "next", created_at: "2099-01-01", text: "继续" };
  assert.equal(f.service.operationRoot(later).instructionId, "instruction:1");
  assert.equal(f.service.operationRoot({ ...later, text: "Implement an unrelated feature" }).instructionId, "next");
});

test("paired budget API authenticates, scopes the task, and deduplicates user extensions", async t => {
  const f = await fixture(t); await f.service.execute(f.metadata, f.input("r"));
  const dir = await mkdtemp(join(tmpdir(), "budget-device-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const authority = new ClientDeviceAuthority(dir); await authority.initialize();
  const invite = authority.invite(), claim = authority.claim({ ...invite, name: "BudgetPhone" });
  authority.approve(invite.pairingId, true); const credentials = await authority.exchange(claim);
  const gateway = new ClientDeviceGateway(authority, { verificationBudgetService: f.service });
  const server = createServer((req, res) => gateway.handle(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/client/v1/tasks/${encodeURIComponent(f.task.id)}/verification-budgets`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" };
  assert.equal((await (await fetch(url, { headers })).json()).budgets.length, 1);
  const extension = `${url}/instruction%3A1/extend`, init = { method: "POST", headers, body: JSON.stringify({ requestId: "same-request", amount: 1 }) };
  assert.equal((await (await fetch(extension, init)).json()).budget.limit, 4);
  assert.equal((await (await fetch(extension, init)).json()).budget.limit, 4);
  assert.equal((await fetch(extension, { ...init, headers: { ...headers, "x-corptie-agent-id": "spoof" } })).status, 403);
  await authority.revoke(credentials.deviceId);
  assert.equal((await fetch(url, { headers })).status, 401);
});

test("same-millisecond receipts preserve admission order and the final passing result", async t => {
  const f = await fixture(t); f.service.setDefault(2);
  const scope = f.service.current(f.metadata);
  f.service.reserve(scope, "z-first"); f.service.finish(scope.instructionId, "z-first", "failed");
  f.service.reserve(scope, "a-last"); f.service.finish(scope.instructionId, "a-last", "passed");
  f.store.db.run("UPDATE verification_budget_charges SET created_at='2026-01-01'");
  assert.equal(f.service.read(scope.instructionId).paused, false);
  assert.deepEqual(f.service.read(scope.instructionId).runs.map(run => run.execution_id), ["z-first", "a-last"]);
});

test("child UI includes both parent-shared and independently instructed child budgets", async t => {
  const f = await fixture(t); await f.service.execute(f.metadata, f.input("parent:run"));
  const child = f.store.createTask({ workId: f.work.id, parentTaskId: f.task.id, mainAgentId: f.agent.agentId, title: "Child_budget" });
  f.service.reserve({ instructionId: "child:user", taskId: child.id, sessionId: f.logical.logicalSessionId }, "child:run");
  assert.equal(f.service.list(child.id).length, 2);
  assert.equal(f.service.list(f.task.id).length, 1);
});

test("the entry executes a real local process and returns its actual output", async t => {
  const f = await fixture(t, { run: promisify(execFile) });
  const result = await f.service.execute(f.metadata, { ...f.input("native"), commands: [
    { file: process.execPath, args: ["-e", "process.stdout.write('verification-entry-ok')"] }
  ] });
  assert.equal(result.results[0].stdout, "verification-entry-ok");
  assert.equal(result.budget.runs[0].status, "passed");
});
