import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { SessionAbilityPreferences } from "../src/application/sessionAbilityPreferences.mjs";
import { handleSessionAbilityHttp } from "../src/application/sessionAbilityHttpApi.mjs";
import { SkillMcpGateway } from "../src/application/skillMcpGateway.mjs";
import { callSkillDynamicTool } from "../src/application/skillDynamicTools.mjs";

async function fixture(run) {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-ability-config", manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false });
  // Real SQLite transactions, with deterministic logical route projections.
  store.getLogicalSession = id => id.startsWith("logical:") ? { logicalSessionId: id, legacySessionId: id.slice(8) } : null;
  store.getLogicalSessionByLegacySessionId = id => ({ logicalSessionId: `logical:${id}`, legacySessionId: id });
  store.getSession = id => ({ id, agentId: "agent:one" });
  store.listRegistrySkills = () => [{ skillId: "skill:one", name: "One" }];
  const registry = { list: () => [{ serverId: "mcp:one", name: "One", enabled: true }] };
  try { await run(new SessionAbilityPreferences({ store, registry }), store); } finally { await store.close(); }
}
const toggle = { expectedResourceVersion: 0, requestId: "first", kind: "mcp", id: "mcp:one", disabled: false };

test("only the shipped default is enabled initially and an explicit close survives recreation", () => fixture(async (service, store) => {
  const builtin = { serverId: "mcp:builtin", name: "Computer Use", enabled: true, builtin: true, defaultEnabled: true };
  const ordinary = service.registry.list();
  service.registry.list = () => [...ordinary, builtin];
  service.registry.defaultEnabledServerIds = () => builtin.enabled ? [builtin.serverId] : [];
  assert.equal(service.isDisabled("a", "mcp", builtin.serverId), false);
  assert.equal(service.isDisabled("a", "mcp", "mcp:one"), true);
  assert.deepEqual(service.inspect("a").enabledMcpServerIds, [builtin.serverId]);
  assert.equal(store.selectOne("SELECT COUNT(*) n FROM session_ability_activations").n, 0);
  service.update("a", { ...toggle, id: builtin.serverId, disabled: true });
  const recreated = new SessionAbilityPreferences({ store, registry: service.registry });
  assert.equal(recreated.isDisabled("a", "mcp", builtin.serverId), true);
  assert.equal(recreated.isDisabled("b", "mcp", builtin.serverId), false);
  assert.deepEqual(recreated.inspect("a").enabledMcpServerIds, []);
  recreated.update("b", { expectedResourceVersion: 0, requestId: "reset-default", reset: true });
  assert.equal(recreated.isDisabled("b", "mcp", builtin.serverId), true);
  assert.equal(recreated.isDisabled("c", "mcp", builtin.serverId), false);
}));

test("Session ability preferences isolate Sessions and preserve Role grants", () => fixture(async (service, store) => {
  assert.equal(service.inspect("a").resourceVersion, 0);
  const receipt = service.update("a", toggle);
  assert.equal(receipt.preferences.resourceVersion, 1);
  assert.equal(service.isDisabled("logical:a", "mcp", "mcp:one"), false);
  assert.equal(service.isDisabled("b", "mcp", "mcp:one"), true);
  assert.equal(store.selectOne("SELECT count(*) n FROM session_capability_grants").n, 0);
  const recreated = new SessionAbilityPreferences({ store, registry: service.registry });
  assert.equal(recreated.isDisabled("a", "mcp", "mcp:one"), false);
}));

test("version, idempotency, reset and immutable audit receipts", () => fixture(async service => {
  const first = service.update("a", toggle);
  assert.equal(service.update("a", toggle).idempotentReplay, true);
  assert.throws(() => service.update("a", { ...toggle, disabled: true }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => service.update("a", { ...toggle, requestId: "stale" }), { code: "RESOURCE_VERSION_CONFLICT" });
  service.update("a", { expectedResourceVersion: 1, requestId: "reset", reset: true });
  assert.equal(service.isDisabled("a", "mcp", "mcp:one"), true);
  assert.deepEqual(service.update("a", toggle).preferences, first.preferences);
}));

test("unknown assignments and invalid input fail closed", () => fixture(async service => {
  assert.throws(() => service.update("a", { ...toggle, id: "mcp:other" }), { code: "CAPABILITY_NOT_INSTALLED" });
  assert.throws(() => service.update("a", { ...toggle, extra: true }), { code: "INVALID_INPUT" });
  assert.throws(() => service.update("a", { ...toggle, reset: true }), { code: "INVALID_INPUT" });
  assert.equal(service.inspect("a").resourceVersion, 0);
}));

test("transaction failure rolls back preferences and receipts", () => fixture(async (service, store) => {
  assert.throws(() => store.runInTransaction(() => { service.update("a", toggle); throw Error("rollback"); }), /rollback/);
  assert.equal(service.inspect("a").resourceVersion, 0);
  assert.equal(store.selectOne("SELECT count(*) n FROM session_ability_preference_receipts").n, 0);
}));

test("native ability writes reject browser and preview requests", async () => {
  for (const [headers, writesAllowed, expected] of [[{ origin: "http://evil" }, true, 403], [{}, false, 403]]) {
    let status;
    await handleSessionAbilityHttp({ request: { method: "PATCH", headers }, response: {},
      url: new URL("http://local/sessions/a/abilities"), writesAllowed,
      sendJson: (_, value) => { status = value; }, service: { update: () => { throw Error("must not run"); } } });
    assert.equal(status, expected);
  }
});

test("MCP cache is Session scoped and final guard blocks a disable during connection", async () => {
  let disabled = false, calls = 0, closed = 0;
  const gateway = new SkillMcpGateway({ resolveServers: async () => ({ standalone_one: { serverId: "mcp:one" } }),
    assertSessionEnabled: () => { if (disabled) throw Object.assign(Error("disabled"), { code: "SESSION_CAPABILITY_DISABLED" }); },
    connectServer: async () => ({ listTools: async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object" } }] }),
      callTool: async () => { calls++; return {}; }, close: async () => { closed++; } }) });
  const input = id => ({ actorId: "agent:one", providerId: "test", metadata: { logicalSessionId: id } });
  try {
    await gateway.definitions(input("logical:a"));
    await gateway.definitions(input("logical:b"));
    assert.equal(gateway.entries.size, 2);
    disabled = true;
    await assert.rejects(gateway.execute({ ...input("logical:a"), tool: "standalone_one__lookup" }), { code: "SESSION_CAPABILITY_DISABLED" });
    assert.equal(calls, 0);
  } finally { await gateway.close(); }
  assert.equal(closed, 2);
});

test("Skill search and load forward the authenticated logical Session", async () => {
  const calls = [];
  const service = { searchForAgent: (...args) => calls.push(args), loadForAgent: (...args) => calls.push(args) };
  const base = { actorId: "agent:one", metadata: { logicalSessionId: "logical:one", sessionId: "provider:one" } };
  await callSkillDynamicTool(service, { ...base, tool: "corptie_skill_search", arguments: { intent: "test" } });
  await callSkillDynamicTool(service, { ...base, tool: "corptie_skill_load", arguments: { skill_id: "skill:one" } });
  assert.deepEqual(calls, [["agent:one", "test", "logical:one"], ["agent:one", "skill:one", "logical:one"]]);
});

test("disable retires a cached MCP connection only after its running call completes", async () => {
  let servers = { standalone_one: {} }, closed = 0, finish, started;
  const running = new Promise(resolve => { started = resolve; });
  const gateway = new SkillMcpGateway({ resolveServers: async () => servers,
    connectServer: async () => ({ listTools: async () => ({ tools: [{ name: "run", inputSchema: { type: "object" } }] }),
      callTool: () => { started(); return new Promise(resolve => { finish = resolve; }); },
      close: async () => { closed++; } }) });
  const scope = { actorId: "agent:one", providerId: "test", metadata: { logicalSessionId: "logical:one" } };
  try {
    const call = gateway.execute({ ...scope, tool: "standalone_one__run" });
    await running;
    servers = {};
    assert.deepEqual(await gateway.definitions(scope), []);
    assert.equal(closed, 0);
    finish({ content: [] });
    await call;
    assert.equal(closed, 1);
  } finally { await gateway.close(); }
});

test("installed abilities start off without role links and explicit mentions activate only this Session", () => fixture(async (service, store) => {
  store.listRegistrySkillsForAgent = () => { throw Error("Role links must not be read"); };
  assert.equal(service.inspect("a").abilities.length, 2);
  assert.ok(service.inspect("a").abilities.every(a => a.disabled));
  assert.equal(service.isDisabled(null, "skill", "skill:one"), true);
  service.activateMentions("a", [{ targetType: "skill", targetId: "skill:one" }]);
  assert.equal(service.isDisabled("a", "skill", "skill:one"), false);
  assert.equal(service.isDisabled("b", "skill", "skill:one"), true);
  assert.throws(() => service.activateMentions("a", [{ targetType: "mcp", targetId: "unknown" }]),
    { code: "CAPABILITY_NOT_AVAILABLE" });
  service.update("a", { expectedResourceVersion: 1, requestId: "reset-all", reset: true });
  assert.ok(service.inspect("a").abilities.every(a => a.disabled));
}));
