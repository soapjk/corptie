import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNewSessionDefaults, resolveTaskCreationDefaults } from "../src/utils/newSessionDefaults.mjs";
import { TaskCreationSettingsService } from "../src/application/taskCreationSettingsService.mjs";
import { createTaskAndSession } from "../src/application/taskCreationApplicationService.mjs";
import { AGENT_PROVIDER_CAPABILITIES as C } from "../src/agent-provider/contracts.mjs";

function fixture() {
  let defaults = {};
  let available = true;
  let broken = false;
  const store = { settings: () => ({ newSessionDefaults: defaults }), updateSettings: async input => {
    defaults = normalizeNewSessionDefaults({ ...defaults, ...input.newSessionDefaults });
  } };
  const registry = { defaultProviderId: "provider:a", descriptors: () => ["provider:a", "provider:b", "provider:fixed"]
    .map(id => ({ id, displayName: id, secret: "never-return-this", runtime: { home: "/private/home" } })),
  supports: (id, cap) => available && !(id === "provider:fixed" && [C.MODEL_LIST, C.REASONING_SWITCH].includes(cap)) };
  const sessions = { listModels: async () => {
    if (broken) throw new Error("/private/credential");
    return { currentModel: "model:default", currentReasoningLevel: "medium", raw: { apiKey: "secret" },
      models: [{ id: "model:new", name: "New", reasoningLevels: ["low", "high", { credentials: "hidden" }], defaultReasoningLevel: "low", credentials: "hidden" }] };
  } };
  return { store, service: new TaskCreationSettingsService({ store, registry, sessions }),
    unavailable: () => { available = false; }, breakModels: () => { broken = true; } };
}

test("defaults stay Provider neutral, normalize and do not leak across explicit overrides", () => {
  const defaults = { taskCreation: { providerId: "provider:b", model: "model:new", reasoningLevel: "high" } };
  assert.deepEqual(resolveTaskCreationDefaults({}, defaults, "provider:a"), defaults.taskCreation);
  assert.deepEqual(resolveTaskCreationDefaults({ providerId: "provider:a" }, defaults),
    { providerId: "provider:a", model: null, reasoningLevel: null });
  assert.deepEqual(resolveTaskCreationDefaults({ model: "model:other" }, defaults),
    { providerId: "provider:b", model: "model:other", reasoningLevel: null });
  assert.equal(resolveTaskCreationDefaults({ reasoningLevel: "low" }, defaults).reasoningLevel, "low");
  assert.equal(normalizeNewSessionDefaults({ taskCreation: { ...defaults.taskCreation, reasoningLevel: " HIGH " } }).taskCreation.reasoningLevel, "high");
});

test("settings persist in shared backend and catalog is a closed redacted projection", async () => {
  const f = fixture();
  const saved = await f.service.save({ providerId: "provider:b", model: "model:new", reasoningLevel: "high" });
  assert.deepEqual(saved.value, f.store.settings().newSessionDefaults.taskCreation);
  assert.equal((await f.service.read()).selectedProviderId, "provider:b");
  const json = JSON.stringify(saved);
  for (const secret of ["never-return-this", "/private", "apiKey", "credentials", "runtime"]) assert.equal(json.includes(secret), false);
  await f.service.save({});
  assert.deepEqual((await f.service.read()).value, { providerId: null, model: null, reasoningLevel: null });
});

test("invalid settings do not write and unavailable catalogs preserve saved selections", async () => {
  const f = fixture();
  for (const input of [{ providerId: "unknown" }, { providerId: "provider:a", model: "bad" },
    { providerId: "provider:a", model: "model:new", reasoningLevel: "max" },
    { providerId: "provider:fixed", model: "model:new" }, { model: "model:new" },
    { providerId: "provider:a", reasoningLevel: "high" }, { providerId: "provider:a", apiKey: "secret" }]) {
    await assert.rejects(f.service.save(input));
    assert.equal(f.store.settings().newSessionDefaults.taskCreation, undefined);
  }
  await f.service.save({ providerId: "provider:a", model: "model:new", reasoningLevel: "high" });
  f.breakModels();
  const read = await f.service.read();
  assert.equal(read.modelError, "MODEL_CATALOG_UNAVAILABLE");
  assert.equal(read.value.model, "model:new");
  await assert.rejects(f.service.save(read.value), { code: "MODEL_CATALOG_UNAVAILABLE" });
});

test("capability-limited Provider supports default model and authorization is rechecked before write", async () => {
  const f = fixture();
  await f.service.save({ providerId: "provider:fixed" });
  const before = f.store.settings().newSessionDefaults;
  await assert.rejects(f.service.save({ providerId: "provider:a" }, () => { throw new Error("revoked"); }), /revoked/);
  assert.equal(f.store.settings().newSessionDefaults, before);
  f.unavailable();
  await assert.rejects(f.service.save({ providerId: "provider:a" }), { code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
});

test("Development preview reads settings without starting Provider operations and denies writes", async () => {
  let modelCalls = 0, writes = 0;
  const service = new TaskCreationSettingsService({ readOnly: true,
    store: { settings: () => ({ newSessionDefaults: {} }), updateSettings: async () => { writes++; } },
    registry: { defaultProviderId: "provider:a", descriptors: () => [{ id: "provider:a", displayName: "A" }], supports: () => true },
    sessions: { listModels: async () => { modelCalls++; return { models: [] }; } } });
  const value = await service.read();
  assert.equal(value.readOnly, true);
  assert.equal(modelCalls, 0);
  await assert.rejects(service.save({ providerId: "provider:a" }), { code: "DEVELOPMENT_PREVIEW_READ_ONLY", status: 403 });
  assert.equal(writes, 0);
});

test("common Task creation applies configured runtime for every Provider without changing existing Sessions", async () => {
  for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) {
    let task = null, command = null;
    const saved = { providerId, model: "chosen-model", reasoningLevel: "high" };
    const store = { settings: () => ({ newSessionDefaults: { taskCreation: saved } }),
      getTask: () => task, getSession: id => ({ id, taskId: task.id, workId: task.workId }),
      setTaskCreationState: (_id, state) => Object.assign(task, { creation_state: state }) };
    const workService = { store, createTask: input => (task = { ...input, work_id: input.workId, main_agent_id: input.mainAgentId, resource_version: 1 }), getTask: () => task };
    const options = { workService, taskInput: { workId: "work:one", title: "New", mainAgentId: "agent:one" }, sourceSessionId: "session:source",
      idempotencyKey: "test", startWorkSession: async input => { command = input; task.current_session_id = "session:new"; return { status: "ready", session: { id: "session:new" } }; } };
    await createTaskAndSession(options);
    assert.equal(command.providerId, saved.providerId);
    assert.equal(command.model, saved.model);
    assert.equal(command.reasoningLevel, saved.reasoningLevel);
    task.current_session_id = "session:existing";
    command = null;
    await createTaskAndSession(options);
    assert.equal(command, null);
  }
});
