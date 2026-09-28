import assert from "node:assert/strict";
import test from "node:test";
import { createSessionApplicationComposition } from "../src/application/sessionApplicationComposition.mjs";

function fixture() {
  const calls = [];
  const session = { id: "session:1", title: "stored", agentId: "agent:1", sessionKind: "worker" };
  const reference = { sessionId: session.id, logicalSessionId: "logical:1", bindingId: "new", providerId: "test" };
  const service = createSessionApplicationComposition({
    store: {
      getSession: () => session,
      rerouteUnsentMessageDelivery: (...args) => calls.push(["reroute", ...args]),
      renameSession: (_id, title) => ({ ...session, title }),
      deleteLogicalSessionByLegacySessionId: (id) => calls.push(["delete-logical", id]),
      deleteSession: (id) => calls.push(["delete-session", id])
    },
    agentProviderRegistry: {},
    sessionBindingRepository: { resolve: () => reference },
    assertForkDispatchAllowed: (id) => calls.push(["fork-guard", id]),
    assertSessionRecoveryMessageBoundary: (input) => calls.push(["recovery-guard", input]),
    recoverSession: async (input) => { calls.push(["recover", input]); return { toolCatalog: {} }; },
    requireSessionReference: () => reference,
    resolveContextReferences: async () => { throw new Error("unexpected context resolution"); },
    collaborationCore: { detachSession: (id) => calls.push(["detach", id]) },
    emitEvent: (...args) => calls.push(["event", ...args])
  });
  return { service, calls, session, reference };
}

test("construction does not invoke later-created services and dispatch preserves both guards", () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  f.service.assertMessageDispatchAllowed(f.reference);
  assert.deepEqual(f.calls, [
    ["fork-guard", "session:1"], ["recovery-guard", f.reference]
  ]);
});

test("recovery requires a stable delivery identity before any replacement work", async () => {
  const f = fixture();
  await assert.rejects(f.service.recoverUnavailableSession({
    sessionId: "session:1", reference: f.reference, error: {}, context: {}
  }), { code: "SESSION_RECOVERY_IDEMPOTENCY_REQUIRED" });
  assert.deepEqual(f.calls, []);
});

test("message recovery finalizes the replacement before rerouting its unsent delivery", async () => {
  const f = fixture();
  f.service.resumeSession = async (...args) => f.calls.push(["resume", ...args]);
  const result = await f.service.recoverUnavailableSession({
    sessionId: "session:1", reference: f.reference,
    error: { replacementReason: "missing" }, context: { idempotencyKey: "delivery:1" }
  });
  assert.deepEqual(f.calls.map(([kind]) => kind), ["recover", "resume", "reroute"]);
  assert.equal(f.calls[0][1].idempotencyKey, "message-recovery:delivery:1");
  assert.equal(f.calls[0][1].triggerDeliveryId, "delivery:1");
  assert.equal(f.calls[1][2].purpose, "session-create-finalization");
  assert.equal(f.calls[1][2].providerBindingId, "new");
  assert.equal(result.reference, f.reference);
});

test("restart recovery does not reroute a message delivery", async () => {
  const f = fixture();
  f.service.resumeSession = async (...args) => f.calls.push(["resume", ...args]);
  await f.service.recoverUnavailableSession({
    sessionId: "session:1", reference: f.reference, error: {},
    context: { idempotencyKey: "restart:1", recoveryKind: "restart" }
  });
  assert.equal(f.calls[0][1].idempotencyKey, "restart-recovery:restart:1");
  assert.equal(f.calls[0][1].triggerDeliveryId, null);
  assert.deepEqual(f.calls.map(([kind]) => kind), ["recover", "resume"]);
});

test("deletion detaches both identities and publishes a detached event after durable removal", async () => {
  const f = fixture();
  await f.service.removeSessionBinding({ reference: { ...f.reference, providerSessionId: "native:1" } });
  assert.deepEqual(f.calls.slice(0, 4), [
    ["detach", "session:1"], ["detach", "native:1"],
    ["delete-logical", "session:1"], ["delete-session", "session:1"]
  ]);
  assert.equal(f.calls[4][1], "SessionDeleted");
  assert.deepEqual(f.calls[4][3], { detachedSession: true });
});
