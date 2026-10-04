import test from "node:test";
import assert from "node:assert/strict";
import { createSessionMessageOperation } from "../src/application/sessionMessageOperation.mjs";
import { CODEX_APP_SERVER_PROVIDER_ID } from "../src/agent-provider/providers/codexAppServerProvider.mjs";
import { CLAUDE_AGENT_SDK_PROVIDER_ID } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { OPENCLACKY_PROVIDER_ID } from "../src/agent-provider/providers/openClackyProvider.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const session = { id: "session", status: "complete" };
  const reference = { sessionId: "session", logicalSessionId: "logical",
    providerId: "provider", metadata: { session } };
  const operation = createSessionMessageOperation({
    store: {
      getLogicalSession: () => ({ activeBinding: { bindingId: "binding" } }),
      getLogicalSessionByLegacySessionId: () => ({ activeBinding: { bindingId: "binding", state: "active" } }),
      getRunningAgentTaskForSession: () => null,
      createUserMessageDelivery: (input) => {
        calls.push(["persist", input]);
        return { task: { taskId: "task" }, outbox: { id: "outbox" } };
      }
    },
    requireSessionReference: () => reference,
    sessionBindingReadinessProbe: {
      verify: async (...args) => { calls.push(["verify", ...args]); return { ready: true }; }
    },
    decorateSessionForClient: () => ({ readiness: "ready" }),
    collaborationCore: { getAgentForSession: () => ({ agentId: "agent" }) },
    registerRuntimeQueuedWork: (...args) => calls.push(["register", ...args]),
    runtimeQueuePosition: () => 1,
    publishProviderEventOutbox: (...args) => calls.push(["outbox", ...args]),
    emitEvent: (...args) => calls.push(["event", ...args]),
    scheduleAgentWorkDrain: (...args) => calls.push(["drain", ...args]),
    now: () => "2026-09-27T00:00:00Z",
    ...overrides
  });
  return { operation, calls };
}

test("ordinary text verifies readiness before admission to the existing queue", async () => {
  const { operation, calls } = fixture();
  assert.deepEqual(await operation.sendUnifiedSessionMessage("session", "hello"), {
    accepted: true, queued: false, queuePosition: 0, sessionId: "session", task: { taskId: "task" }
  });
  assert.deepEqual(calls.map(([name]) => name), ["verify", "persist", "register", "outbox", "event", "drain"]);
  assert.deepEqual(calls[0].slice(1), ["session", { reuseReady: true }]);
  assert.equal(calls[1][1].text, "hello");
});

test("reliable admission is Provider-neutral and never waits for startup or interprets confirmation text", () => {
  for (const providerId of [CODEX_APP_SERVER_PROVIDER_ID, CLAUDE_AGENT_SDK_PROVIDER_ID, OPENCLACKY_PROVIDER_ID]) {
    const session = { id: "session", status: "complete" };
    const { operation, calls } = fixture({
      requireSessionReference: () => ({ sessionId: "session", logicalSessionId: "logical", providerId, metadata: { session } }),
      agentProviderRegistry: { supports: () => true },
      sessionBindingReadinessProbe: { verify: () => { throw new Error("Must not start Provider during admission"); } }
    });
    assert.equal(operation.admitReliableMessage("session", { text: "确认" }, { type: "remote-client" }).accepted, true);
    assert.deepEqual(calls.map(([name]) => name), ["persist", "register", "outbox", "event", "drain"]);
    assert.throws(() => operation.admitReliableMessage("session", { text: "/clear" }, { type: "remote-client" }), { code: "INVALID_MESSAGE" });
  }
});

test("recovery rejects messages before readiness probes and queue writes", async () => {
  const { operation, calls } = fixture({
    store: { getLogicalSession: () => ({ transitionState: "sessionRecovery" }) }
  });
  await assert.rejects(operation.sendUnifiedSessionMessage("session", "hello"), {
    code: "SESSION_BUSY", reason: "sessionRecovery"
  });
  assert.equal(calls.length, 0);
});

test("failed binding verification never admits queued work", async () => {
  const { operation, calls } = fixture({
    sessionBindingReadinessProbe: {
      verify: async () => ({ ready: false, readiness: { message: "not ready", reasonCode: "missing" } })
    }
  });
  await assert.rejects(operation.sendUnifiedSessionMessage("session", "hello"), {
    code: "SESSION_NOT_READY", reason: "missing"
  });
  assert.equal(calls.length, 0);
});
