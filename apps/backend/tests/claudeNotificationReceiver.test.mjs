import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeNotificationReceiver } from "../src/adapters/claudeNotificationReceiver.mjs";

test("workspace route notification uses the committed logical workspace projection", async () => {
  const calls = [];
  const logical = { logicalSessionId: "logical", legacySessionId: "session" };
  const session = { id: "session" };
  const receiver = createClaudeNotificationReceiver({
    store: {
      getLogicalSession: () => logical,
      getSession: () => session
    },
    sessionWithLogicalWorkspace: (value, route) => ({ ...value, route: route.logicalSessionId }),
    emitEvent: (...args) => calls.push(args)
  });
  await receiver.commitManagedClaudeWorkspaceRoute({ logicalSessionId: "logical", transitionId: "transition" });
  assert.deepEqual(calls, [[
    "SessionWorkspaceSwitched",
    { session: { id: "session", route: "logical" }, logicalSessionId: "logical", transitionId: "transition" },
    { sessionId: "session" }
  ]]);
});

test("unknown workspace session does not publish a fabricated route", async () => {
  const receiver = createClaudeNotificationReceiver({
    store: { getLogicalSession: () => null },
    emitEvent: () => assert.fail("must not emit without a session")
  });
  await receiver.commitManagedClaudeWorkspaceRoute({ logicalSessionId: "missing" });
});

test("non-applied terminal events do not complete queued work or resume transitions", async () => {
  const diagnostics = [];
  const receiver = createClaudeNotificationReceiver({
    store: {
      getLogicalSessionByProviderSessionId: () => ({ legacySessionId: "session", logicalSessionId: "logical" }),
      getAgentSessionBindingByProviderSession: () => ({
        providerId: "claude-sdk", providerSessionId: "native",
        bindingId: "binding", logicalSessionId: "logical", routingVersion: 1
      }),
      getSession: () => ({ status: "running" }),
      getRunningAgentTaskForSession: () => assert.fail("quarantined event cannot settle work")
    },
    providerEventIngestion: { ingest: () => ({ status: "quarantined" }) },
    sessionStateDiagnostics: { record: (...args) => diagnostics.push(args) },
    now: () => "2026-09-27T00:00:00Z"
  });
  await receiver.handleClaudeTurnSettledSafely({
    providerSessionId: "native", turnId: "turn", status: "completed"
  });
  assert.deepEqual(diagnostics.map((entry) => entry[1]), ["providerReceived", "persisted"]);
});
