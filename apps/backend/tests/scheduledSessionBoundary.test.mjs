import assert from "node:assert/strict";
import test from "node:test";
import { createScheduledSessionBoundary } from "../src/application/scheduledSessionBoundary.mjs";

function fixture() {
  const calls = [];
  const session = { id: "session", workId: "work" };
  let inserted = true;
  let allowed = true;
  const boundary = createScheduledSessionBoundary({
    store: {
      getLogicalSession: (id) => id === "logical" ? { logicalSessionId: "logical", legacySessionId: "session" } : null,
      getLogicalSessionByLegacySessionId: () => ({ logicalSessionId: "logical" }),
      getSession: () => session,
      getAgent: (id) => ({ agentId: id }),
      enqueueAgentTaskWithResult: (input) => ({ task: { taskId: "queued", source: input.source }, inserted })
    },
    environmentName: "development",
    collaborationCore: { getAgentForSession: () => ({ agentId: "bound" }) },
    canDeliverScheduledMessage: () => allowed,
    registerRuntimeQueuedWork: (...args) => calls.push(["register", ...args]),
    runtimeQueuePosition: () => 2,
    emitEvent: (...args) => calls.push(["event", ...args]),
    scheduleAgentWorkDrain: (...args) => calls.push(["drain", ...args])
  });
  return { boundary, calls, revoke: () => { allowed = false; }, duplicate: () => { inserted = false; } };
}

test("authorization rechecks environment, current binding and device grant", () => {
  const f = fixture();
  const scope = { logicalSessionId: "logical", environment: "development" };
  assert.throws(() => f.boundary.authorizeScheduledSessionTask({
    ...scope, environment: "production", actor: { type: "user", id: "user:local-macos" }
  }), { code: "ENVIRONMENT_MISMATCH" });
  assert.throws(() => f.boundary.authorizeScheduledSessionTask({
    ...scope, actor: { type: "agent", id: "other" }
  }), { code: "AUTHORIZATION_REVOKED" });
  const actor = { type: "user", id: "user:paired-device:one" };
  assert.equal(f.boundary.authorizeScheduledSessionTask({ ...scope, actor }).workId, "work");
  f.revoke();
  assert.throws(() => f.boundary.authorizeScheduledSessionTask({ ...scope, actor }), { code: "AUTHORIZATION_REVOKED" });
});

test("deduplicated deliveries do not register, emit or schedule work again", () => {
  const f = fixture();
  const input = { sessionId: "session", source: { deliveryId: "delivery" } };
  f.boundary.enqueueScheduledSessionWork(input);
  assert.deepEqual(f.calls.map(([name]) => name), ["register", "event", "drain"]);
  assert.equal(f.calls[1][2].queuePosition, 2);
  f.calls.length = 0;
  f.duplicate();
  assert.equal(f.boundary.enqueueScheduledSessionWork(input).inserted, false);
  assert.deepEqual(f.calls, []);
});

test("HTTP identity retains loopback admission and resolves session scope", () => {
  const f = fixture();
  assert.deepEqual(f.boundary.scheduledSessionHttpActor({
    headers: {}, socket: { remoteAddress: "::1" }
  }), { type: "user", id: "user:local-macos" });
  assert.throws(() => f.boundary.scheduledSessionHttpActor({
    headers: {}, socket: { remoteAddress: "192.0.2.1" }
  }), { code: "ACTOR_REQUIRED" });
  assert.equal(f.boundary.scheduledSessionHttpLogicalSessionId({
    headers: { "x-corptie-session-id": " logical " }
  }), "logical");
});
