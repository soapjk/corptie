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

test("local context failures settle unsent deliveries without invalidating healthy Provider bindings", async () => {
  for (const stage of ["context_assembly", "context_delivery", "provider_dispatch"]) {
    const updates = [];
    let invalidations = 0;
    const failure = Object.assign(new Error("Message was not sent to the model: context limit"), {
      code: "SESSION_CONTEXT_BUDGET_EXCEEDED", dispatchState: "not_sent", stage
    });
    const { operation, calls } = fixture({
      store: {
        getLogicalSession: () => ({}), listUnsettledSessionTurns: () => [],
        getMessageDelivery: () => ({ status: "queued", attemptCount: 0 }),
        updateMessageDelivery: (id, patch) => updates.push({ id, ...patch })
      },
      sessionBindingReadinessProbe: {
        verify: async () => ({ ready: true }),
        invalidateBinding: () => { invalidations += 1; }
      },
      sessionApplicationService: { sendMessage: async () => { throw failure; } }
    });
    await assert.rejects(operation.sendUnifiedSessionMessage("session", "?",
      { type: "desktop", deliveryId: "delivery" }, { fromAgentWorkQueue: true }), error => error === failure);
    assert.equal(invalidations, stage === "provider_dispatch" ? 1 : 0);
    assert.equal(updates.at(-1).status, "failed");
    assert.match(updates.at(-1).lastError, /not sent to the model/);
    assert.equal(calls.length, 0); // No SessionRunStarted or response watchdog.
  }
});

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

test("pre-dispatch readiness failure settles the queued Delivery for every Provider", async () => {
  for (const providerId of [CODEX_APP_SERVER_PROVIDER_ID, CLAUDE_AGENT_SDK_PROVIDER_ID, OPENCLACKY_PROVIDER_ID]) {
    const updates = [];
    const { operation } = fixture({
      requireSessionReference: () => ({ sessionId: "session", logicalSessionId: "logical", providerId, metadata: { session: { id: "session" } } }),
      store: {
        getLogicalSession: () => ({ transitionState: null }),
        getMessageDelivery: () => ({ status: "queued" }),
        updateMessageDelivery: (id, patch) => updates.push({ id, ...patch })
      },
      sessionBindingReadinessProbe: {
        verify: async () => ({ ready: false, readiness: { reasonCode: "PROVIDER_SESSION_UNAVAILABLE", message: "binding unavailable" } })
      }
    });
    await assert.rejects(operation.sendUnifiedSessionMessage("session", "resolve", {
      deliveryId: "delivery:initial"
    }, { fromAgentWorkQueue: true }), { code: "SESSION_NOT_READY", deliveryStatus: "failed" });
    assert.deepEqual(updates, [{ id: "delivery:initial", status: "failed", lastError: "binding unavailable" }]);
  }
});

test("dispatch acceptance arms both monitors without native events for every Provider", async () => {
  for (const providerId of [CODEX_APP_SERVER_PROVIDER_ID, CLAUDE_AGENT_SDK_PROVIDER_ID, OPENCLACKY_PROVIDER_ID]) {
    for (const settled of [false, true]) {
      const monitored = [];
      let turn;
      const binding = { sessionId: "session", logicalSessionId: "logical", providerId,
        providerSessionId: "native", bindingId: "binding", routingVersion: 2 };
      const { operation } = fixture({
        requireSessionReference: () => ({ ...binding, metadata: { session: { id: "session", status: "complete" } } }),
        store: {
          getLogicalSession: () => ({}), listUnsettledSessionTurns: () => [],
          getAgentSessionBinding: () => binding,
          getSessionTurn: () => turn,
          upsertSessionTurn: input => { turn = { execution_status: input.executionStatus }; }
        },
        sessionApplicationService: { sendMessage: async () => {
          if (settled) turn = { execution_status: "completed" };
          return { turnId: "turn" };
        } },
        providerTurnResponseWatchdog: { watch: entry => monitored.push(["watch", entry]) },
        onTurnAccepted: entry => {
          assert.equal(turn.execution_status, "running", "persist before scheduling probes");
          monitored.push(["probe", entry]);
        }
      });
      const result = await operation.sendUnifiedSessionMessage("session", "hello", { type: "desktop" }, { fromAgentWorkQueue: true });
      assert.equal(result.accepted, true);
      assert.deepEqual(monitored.map(([name]) => name), settled ? [] : ["watch", "probe"]);
      if (!settled) {
        assert.deepEqual(monitored[0][1], monitored[1][1]);
        assert.equal(monitored[1][1].turnId, "turn");
        assert.equal(monitored[1][1].routingVersion, 2);
      }
    }
  }
});
