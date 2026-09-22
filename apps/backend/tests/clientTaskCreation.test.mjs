import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";

const identity = { deviceId: "device:test", permissions: ["tasks.create"] };
const input = { requestId: "create_123", workId: "work:test", title: "Task", mainAgentId: "agent:test", providerId: "provider:test" };

test("creation options are Work-scoped, read-only and explicitly projected", async () => {
  const f = await fixture();
  try {
    f.store.createAgent({ id: "agent:outside", name: "Outside" });
    const requests = [];
    f.taskCreation.options = async (source, providerId) => {
      requests.push([source, providerId]);
      return { defaultProviderId: "provider:test", providers: [{ id: "provider:test", name: "Test", available: true, supportsModels: true, token: "PRIVATE" },
        { id: "provider:unsupported", name: "Unsupported", available: false, reason: "PRIVATE" }],
        models: providerId ? [{ id: "model", name: "Model", reasoningLevels: ["high", { secret: "PRIVATE" }],
          defaultReasoningLevel: "high", path: "PRIVATE" }] : [], currentModel: "model", secret: "PRIVATE" };
    };
    const api = f.make();
    await assert.rejects(api.taskCreationOptions({ ...identity, permissions: ["inventory.read"] }, "session:test", new URLSearchParams()),
      { code: "DEVICE_PERMISSION_REQUIRED" });
    assert.equal(requests.length, 0);
    const choices = await api.taskCreationOptions(identity, "session:test", new URLSearchParams());
    assert.deepEqual(choices.agents, [{ id: "agent:test", name: "Test" }]);
    assert.equal(choices.work.id, "work:test");
    assert.equal(choices.defaultProviderId, "provider:test");
    assert.deepEqual(choices.priorities, ["low", "medium", "high", "urgent"]);
    assert.deepEqual(requests, [["session:test", null]]);
    const selected = await api.taskCreationOptions(identity, "session:test", new URLSearchParams("providerId=provider:test"));
    assert.deepEqual(selected.models[0].reasoningLevels, ["high"]);
    assert.equal(selected.providers[1].reason, "PROVIDER_CAPABILITY_UNAVAILABLE");
    assert.equal(JSON.stringify(selected).includes("PRIVATE"), false);
    assert.equal(f.calls(), 0);
    await assert.rejects(api.taskCreationOptions(identity, "session:test", new URLSearchParams("providerId=provider:unsupported")),
      { code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
    for (const query of ["workId=other", "providerId=a&providerId=b", "providerId="]) {
      await assert.rejects(api.taskCreationOptions(identity, "session:test", new URLSearchParams(query)), error => error.status === 400);
    }
  } finally { await f.close(); }
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "corptie-device-task-"));
  const store = new CorptieStore({ dbPath: join(dir, "db.sqlite"), configPath: join(dir, "config.json") });
  await store.initialize();
  const agent = store.createAgent({ id: "agent:test", name: "Test" });
  store.createWork({ id: "work:test", name: "Work", contributorAgentIds: [agent.agentId] });
  store.createSession({ id: "session:test", title: "Source", sessionKind: "workChat", workId: "work:test", status: "complete" });
  let calls = 0;
  const taskCreation = { validate: async () => {}, create: async (source, intent) => {
    calls++;
    assert.equal(source, "session:test");
    assert.equal(intent.taskInput.workId, "work:test");
    assert.match(intent.operationID, /^device-task:[a-f0-9]{64}$/);
    return { task: { id: "task:new", secret: "PRIVATE" }, session: { id: "session:new", external: { secret: "PRIVATE" } } };
  } };
  const make = (options = {}) => new ClientSessionAPI({ store, actions: () => ({}), taskCreation, ...options });
  return { store, make, taskCreation, calls: () => calls, close: async () => { await store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("task creation uses explicit authority, Work scope, shared callback and durable public receipt", async () => {
  const f = await fixture();
  try {
    const api = f.make();
    await assert.rejects(api.createTask({ ...identity, permissions: ["messages.write"] }, "session:test", input), { code: "DEVICE_PERMISSION_REQUIRED" });
    await assert.rejects(api.createTask(identity, "session:test", { ...input, workId: "work:other" }), { code: "TASK_OUTSIDE_WORK" });
    await assert.rejects(api.createTask(identity, "session:test", { ...input, mainAgentId: "agent:other" }), { code: "AGENT_OUTSIDE_WORK" });
    for (const extra of [{ sourceSessionId: "session:other" }, { id: "task:chosen" }, { workspacePath: "/private" }]) {
      await assert.rejects(api.createTask(identity, "session:test", { ...input, ...extra }), { code: "INVALID_TASK_CREATION" });
    }
    assert.equal(f.calls(), 0);
    const result = await api.createTask(identity, "session:test", input);
    assert.equal(result.status, "completed");
    assert.equal(result.kind, "create_task");
    assert.deepEqual(result.taskResult, { taskId: "task:new", sessionId: "session:new", workId: "work:test" });
    assert.equal(result.commandResult, undefined);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    assert.deepEqual(await f.make().createTask(identity, "session:test", input), result);
    assert.equal(f.calls(), 1);
    await assert.rejects(api.createTask(identity, "session:test", { ...input, model: "different" }), { code: "IDEMPOTENCY_CONFLICT" });
  } finally { await f.close(); }
});

test("permission revocation and racing requests cannot dispatch twice", async () => {
  const f = await fixture();
  try {
    const api = f.make();
    await assert.rejects(api.createTask(identity, "session:test", input,
      () => ({ ...identity, permissions: [] })), { code: "DEVICE_PERMISSION_REQUIRED" });
    assert.equal(f.calls(), 0);
    const results = await Promise.all([api.createTask(identity, "session:test", input), api.createTask(identity, "session:test", input)]);
    assert.equal(f.calls(), 1);
    assert.ok(results.every(result => ["completed", "dispatching"].includes(result.status)));
    await assert.rejects(api.createTask({ ...identity, permissions: [] }, "session:test", input), { code: "DEVICE_PERMISSION_REQUIRED" });
  } finally { await f.close(); }
});

test("partial creation or lost response remains uncertain and is never automatically replayed", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.taskCreation.create = async () => { calls++; throw new Error("PRIVATE startup failed after persistence"); };
    const api = f.make();
    const result = await api.createTask(identity, "session:test", input);
    assert.equal(result.status, "unknown");
    assert.equal(result.errorCode, "TASK_CREATION_OUTCOME_UNCERTAIN");
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    await f.make().createTask(identity, "session:test", input);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});
