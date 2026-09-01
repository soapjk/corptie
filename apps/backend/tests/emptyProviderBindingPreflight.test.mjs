import assert from "node:assert/strict";
import test from "node:test";

import { EmptyProviderBindingPreflight } from "../src/application/emptyProviderBindingPreflight.mjs";

function fixture({ ensureUsable = async () => ({ recovered: true }) } = {}) {
  const turns = new Set(["session:durable\0binding:durable"]);
  const logicalBySession = new Map([
    ["session:empty", logical("empty")],
    ["session:durable", logical("durable")],
    ["session:claude", logical("claude", "claude-sdk")],
    ["session:transitioning", { ...logical("transitioning"), transitionState: "sessionRecovery" }]
  ]);
  const changes = [];
  const preflight = new EmptyProviderBindingPreflight({
    store: {
      listSessions: () => [...logicalBySession.keys()].map((id) => ({ id, archived: false })),
      getLogicalSessionByLegacySessionId: (id) => logicalBySession.get(id),
      hasSessionTurnForBinding: (sessionId, bindingId) => turns.has(`${sessionId}\0${bindingId}`)
    },
    providerId: "codex-app-server",
    ensureUsable,
    onChanged: (candidate, readiness) => changes.push({ candidate, readiness })
  });
  return { preflight, changes };
}

test("startup preflight marks only zero-Turn active Provider bindings Not Ready", () => {
  const f = fixture();
  assert.deepEqual(f.preflight.prepare(), { candidates: 1 });
  assert.equal(f.preflight.readiness("logical:empty").reasonCode, "BINDING_RUNTIME_VERIFYING");
  assert.equal(f.preflight.readiness("logical:durable"), null);
  assert.equal(f.preflight.readiness("logical:claude"), null);
  assert.equal(f.preflight.readiness("logical:transitioning"), null);
});

test("successful background repair removes the readiness block and wakes projection", async () => {
  const f = fixture();
  f.preflight.prepare();

  const result = await f.preflight.run();

  assert.equal(result.ready, 1);
  assert.equal(result.failed, 0);
  assert.equal(f.preflight.readiness("logical:empty"), null);
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].readiness, null);
});

test("failed background repair remains explicitly Not Ready", async () => {
  const error = Object.assign(new Error("rollout reconstruction failed"), {
    code: "PROVIDER_SESSION_UNAVAILABLE"
  });
  const f = fixture({ ensureUsable: async () => { throw error; } });
  f.preflight.prepare();

  const result = await f.preflight.run();

  assert.equal(result.failed, 1);
  assert.equal(f.preflight.readiness("logical:empty").reasonCode, "PROVIDER_SESSION_UNAVAILABLE");
  assert.equal(f.changes[0].readiness.message, "rollout reconstruction failed");
});

function logical(name, providerId = "codex-app-server") {
  return {
    logicalSessionId: `logical:${name}`,
    archived: false,
    transitionState: null,
    activeBinding: {
      bindingId: `binding:${name}`,
      providerId,
      providerSessionId: `thread:${name}`,
      state: "active"
    }
  };
}
