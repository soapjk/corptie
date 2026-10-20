import assert from "node:assert/strict";
import test from "node:test";
import { createSessionCreationOperation } from "../src/application/sessionCreationOperation.mjs";
import { createSessionTitleReservations } from "../src/application/sessionTitleReservations.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES as C } from "../src/agent-provider/contracts.mjs";

test("creation validates explicit names before side effects and generates valid unique defaults", async () => {
  const sessions = [];
  const store = { listSessionTitleIdentities: () => sessions,
    getSession: id => sessions.find(item => item.id === id) };
  let directoryChecks = 0;
  const operation = createSessionCreationOperation({ store,
    sessionTitleReservations: createSessionTitleReservations({ store }),
    assertDirectory: async () => { directoryChecks++; }, emitEvent() {},
    sessionApplicationService: { createSession: async (_provider, input) => {
      const session = { id: `session:${sessions.length}`, ...input }; sessions.push(session); return session;
    } }
  });
  for (const title of ["1Chat", " bad", "bad\n", "收益%", "Task，分析"]) {
    await assert.rejects(operation.createSessionThroughApplication("neutral", { title, cwd: "/tmp" }), { code: "INVALID_ENTITY_NAME" });
  }
  assert.equal(directoryChecks, 0);
  const first = await operation.createSessionThroughApplication("neutral", { cwd: "/tmp/123 project" });
  const second = await operation.createSessionThroughApplication("neutral", { cwd: "/tmp/123 project" });
  assert.equal(first.title, "_123_project_agent");
  assert.equal(second.title, "_123_project_agent_1");
  assert.equal(sessions.length, 2);
});

for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`${providerId} create and rename share the Provider-neutral title gate`, async () => {
    const calls = [];
    const provider = new CallbackAgentProvider({ id: providerId, displayName: providerId, transport: "test",
      capabilities: [C.SESSION_CREATE, C.SESSION_RENAME] }, {
      createSession: async input => { calls.push(input.title); return { id: "new", title: input.title }; },
      renameSession: async (_reference, title) => { calls.push(title); return { title }; }
    });
    const service = new SessionApplicationService({ registry: new AgentProviderRegistry([provider]),
      resolveSessionReference: () => ({ providerId, sessionId: "session", providerSessionId: "native" }) });
    for (const title of ["1Chat", "Task%", "Task\n", "Task,One"]) {
      await assert.rejects(service.createSession(providerId, { title }), { code: "INVALID_ENTITY_NAME" });
      await assert.rejects(service.renameSession("session", title), { code: "INVALID_ENTITY_NAME" });
    }
    assert.deepEqual(calls, []);
    await service.createSession(providerId, { title: "策略-SDK_v2" });
    await service.renameSession("session", "_2026");
    assert.deepEqual(calls, ["策略-SDK_v2", "_2026"]);
    // Rebinding keeps a historical title; it does not create a new product Session.
    await service.createSessionForRouteTransition(providerId, { title: "旧会话，标题" });
  });
}
