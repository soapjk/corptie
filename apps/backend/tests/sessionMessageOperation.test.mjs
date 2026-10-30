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


test("a late dispatch acknowledgement settles against the durable Turn for every Provider", async () => {
  for (const providerId of [CODEX_APP_SERVER_PROVIDER_ID, CLAUDE_AGENT_SDK_PROVIDER_ID, OPENCLACKY_PROVIDER_ID]) {
    for (const status of ["completed", "failed", "cancelled"]) {
      let turn;
      let delivery = {deliveryId:"delivery",bindingId:"binding",attemptCount:0,status:"queued"};
      let settlements = 0;
      const binding = {sessionId:"session",logicalSessionId:"logical",providerId,
        providerSessionId:"native",bindingId:"binding",routingVersion:2};
      const {operation} = fixture({
        requireSessionReference:()=>({...binding,metadata:{session:{id:"session",status:"complete"}}}),
        store:{getLogicalSession:()=>({}),listUnsettledSessionTurns:()=>[],
          getMessageDelivery:()=>delivery,getAgentSessionBinding:()=>binding,
          getSessionTurn:()=>turn,upsertSessionTurn:()=>assert.fail("terminal Turn already exists"),
          updateMessageDelivery:(_id,patch)=>{delivery={...delivery,...patch};},
          settleMessageDeliveryFromTurn:id=>{
            assert.equal(id,"delivery");
            assert.equal(delivery.providerTurnId,"turn");
            assert.equal(delivery.bindingId,binding.bindingId);
            settlements++;
            delivery={...delivery,status:turn.execution_status,lastError:status==="failed" ? "original failure" : null};
            return delivery;
          }},
        sessionApplicationService:{sendMessage:async()=>{turn={execution_status:status};return {turnId:"turn"};}},
        providerTurnResponseWatchdog:{watch:()=>assert.fail("terminal Turn must not be watched")}
      });
      await operation.sendUnifiedSessionMessage("session","hello",{type:"desktop",deliveryId:"delivery"},{fromAgentWorkQueue:true});
      assert.equal(settlements,1);
      assert.equal(delivery.status,status);
      assert.equal(delivery.lastError,status==="failed" ? "original failure" : null);
    }
  }
});

test('attachment reads are bounded and parallel, retain order and finish before Provider submission', async () => {
  const gates = [];
  let active = 0, maximum = 0, sentImages;
  const { operation } = fixture({
    store: { getLogicalSession: () => ({}), listUnsettledSessionTurns: () => [] }, agentProviderRegistry: { supports: () => true },
    chatResourceService: { readImage: async (_reference, managedPath) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => gates.push(resolve));
      active--; return { path: managedPath, mimeType: 'image/png', byteLength: 1 };
    } },
    sessionApplicationService: { sendMessage: async (_id, message) => { sentImages = message.images; return {}; } }
  });
  const images = Array.from({ length: 6 }, (_, i) => ({ managedPath: `chat-resources/${i}.png` }));
  const pending = operation.sendUnifiedSessionMessage('session', { text: 'Images', images }, {}, { fromAgentWorkQueue: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 4);
  assert.equal(sentImages, undefined);
  gates.slice().reverse().forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  gates.slice(4).forEach(release => release());
  await pending;
  assert.equal(maximum, 4);
  assert.deepEqual(sentImages.map(image => image.absolutePath), images.map(image => image.managedPath));
});

test('a missing required image settles outstanding reads and never dispatches a partial message', async () => {
  let release, settled = false, sends = 0;
  const { operation } = fixture({
    store: { getLogicalSession: () => ({}), listUnsettledSessionTurns: () => [] }, agentProviderRegistry: { supports: () => true },
    chatResourceService: { readImage: async (_reference, path) => {
      if (path.endsWith('missing.png')) throw Object.assign(new Error('Missing image'), { code: 'ENOENT' });
      await new Promise(resolve => { release = resolve; });
      return { path, mimeType: 'image/png', byteLength: 1 };
    } },
    sessionApplicationService: { sendMessage: async () => { sends++; return {}; } }
  });
  const pending = operation.sendUnifiedSessionMessage('session', { text: 'Images', images: [
    { managedPath: 'chat-resources/missing.png' }, { managedPath: 'chat-resources/present.png' }
  ] }, {}, { fromAgentWorkQueue: true });
  const checked = assert.rejects(pending, { code: 'ENOENT' }).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release(); await checked;
  assert.equal(sends, 0);
});
