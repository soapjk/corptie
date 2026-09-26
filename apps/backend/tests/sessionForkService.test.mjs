import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { SessionForkService } from "../src/application/sessionForkService.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "corptie-session-fork-"));
  const store = new CorptieStore({ dbPath: join(root, "db.sqlite"), configPath: join(root, "config.json") });
  await store.initialize();
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const agent = store.createAgent({ id: "agent:test", name: "Test", role: "independentContributor" });
  function session(id, kind = "assistantChat") {
    store.createSession({ id, title: id, provider: "test", agentId: agent.agentId, sessionKind: kind, cwd: root, status: "complete" });
    store.createLogicalSessionRoute({ logicalSessionId: `logical:${id}`, legacySessionId: id,
      providerThreadId: id, providerSessionId: id, providerId: "test", boundCwd: root, sessionName: id });
    return store.getSession(id);
  }
  const source = session("source");
  const binding = store.getLogicalSessionByLegacySessionId(source.id).activeBinding;
  for (const [id, turnId, type, text] of [["u1", "t1", "userMessage", "one"], ["a1", "t1", "agentMessage", "first"],
    ["u2", "t2", "userMessage", "two"], ["a2", "t2", "agentMessage", "later"]]) {
    store.upsertTimelineItemProjection(source.id, { id, turnId, type, text, turnStatus: "completed",
      bindingId: binding.bindingId, status: "completed", createdAt: "2026-09-01T00:00:00Z" });
  }
  let creates = 0;
  const service = new SessionForkService({ store, registry: { requireCapability() {}, get: () => ({ descriptor: { displayName: "Test" } }) },
    sessionService: { referenceFor: async id => ({ sessionId: id, logicalSessionId: `logical:${id}`,
      bindingId: store.getLogicalSessionByLegacySessionId(id).activeBinding.bindingId, providerId: "test", providerSessionId: id }) },
    workService: new WorkApplicationService({ store }), startWorkSession: async () => { throw new Error("Unexpected Task creation"); },
    createChat: async () => { creates++; return session("target"); } });
  const input = { requestId: "request-12345678", itemId: "a1", sourceBindingId: binding.bindingId, title: "测试分支" };
  return { store, service, input, session, creates: () => creates };
}
test("Chat fork is idempotent and includes only the selected completed turn", async t => {
  const { store, service, input, creates } = await fixture(t);
  const [a, b] = await Promise.all([service.create("source", input), service.create("source", input)]);
  assert.equal(a.session.id, b.session.id); assert.equal(creates(), 1); assert.equal(a.taskId, null);
  assert.deepEqual(store.getItems("target").map(item => item.text).sort(), ["first", "one"]);
  assert.equal(store.getItems("source").length, 4);
  assert.equal((await service.create("source", input)).session.id, "target");
  await assert.rejects(service.create("source", { ...input, title: "另一个分支" }), { code: "FORK_IDEMPOTENCY_CONFLICT" });
});
test("fork rejects stale binding and pending turns before allocating", async t => {
  const { store, service, input, creates } = await fixture(t);
  await assert.rejects(service.create("source", { ...input, sourceBindingId: "stale" }), { code: "FORK_SOURCE_CHANGED" });
  store.db.run("UPDATE session_items SET turn_status='running' WHERE id='a1'");
  await assert.rejects(service.create("source", input), { code: "FORK_POINT_UNAVAILABLE" });
  assert.equal(creates(), 0);
});
test("Work Chat cannot fork", async t => {
  const { store, service, input, creates } = await fixture(t);
  const getSession = store.getSession.bind(store);
  store.getSession = id => ({ ...getSession(id), sessionKind: "workChat" });
  await assert.rejects(service.create("source", input), { code: "FORK_KIND_UNSUPPORTED" });
  assert.equal(creates(), 0);
});

test("Task fork retains Work and Agent, applies confirmed fields, and never dispatches a turn", async t => {
  const { store, service, input, session, creates } = await fixture(t);
  const work = service.workService.createWork({ name: "项目", contributorAgentIds: ["agent:test"] });
  const parent = service.workService.createTask({ workId: work.id, title: "原任务", mainAgentId: "agent:test",
    description: "原描述", acceptanceCriteria: "原标准" });
  store.bindSessionToTask("source", parent.id, work.id);
  store.getTaskWorkspaceContext = () => ({ repository: { id: "repo:test" } });
  service.startWorkSession = async command => {
    assert.equal(command.dispatchInitialTurn, false);
    assert.equal(command.providerId, "test");
    assert.equal(command.assigneeAgentId, "agent:test");
    assert.equal((await service.contextForTask(command.taskId)).session.id, "source");
    session("child");
    store.bindSessionToTask("child", command.taskId, work.id);
    return { status: "ready", session: store.getSession("child") };
  };
  const result = await service.create("source", { ...input, description: "新目标", acceptanceCriteria: "新标准" });
  const child = store.getTask(result.taskId);
  assert.notEqual(child.id, parent.id);
  assert.equal(child.work_id, work.id);
  assert.equal(child.description, "新目标");
  assert.equal(child.acceptance_criteria, "新标准");
  assert.equal(result.session.sessionKind, "worker");
  assert.equal(creates(), 0);
  assert.equal(store.getTask(parent.id).description, "原描述");
});

test("finalization retries retain the same target and do not duplicate history or audit events", async t => {
  const { store, service, input, creates } = await fixture(t);
  await service.create("source", input);
  store.db.run("UPDATE session_fork_operations SET state='finalizing' WHERE request_id=?", [input.requestId]);
  assert.throws(() => service.assertCanDispatch("target"), { code: "FORK_NOT_READY" });
  await Promise.all([service.create("source", input), service.create("source", input)]);
  assert.equal(creates(), 1);
  assert.equal(store.getItems("target").length, 2);
  assert.equal(store.selectOne("SELECT COUNT(*) AS n FROM session_events WHERE event_id=?", ["fork:target"]).n, 1);
  service.assertCanDispatch("target");
});
