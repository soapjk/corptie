import test from "node:test";
import assert from "node:assert/strict";
import { createProviderTerminalLifecycle } from "../src/application/providerTerminalLifecycle.mjs";
import { createClaudeNotificationReceiver } from "../src/adapters/claudeNotificationReceiver.mjs";

for (const adapter of ["shared", "claude"]) {
  for (const status of ["completed", "cancelled", "failed"]) {
    for (const pending of [true, false]) {
      test(`${adapter}: ${status} ${pending ? "awaits queued Provider switch before draining" : "preserves ordinary terminal handling"}`, async () => {
        const calls = [];
        const logical = { logicalSessionId: "logical", legacySessionId: "session" };
        let finish;
        const switching = new Promise(resolve => { finish = resolve; });
        const dependencies = {
          store: {
            getRunningAgentTaskForSession: () => null,
            getAgentTaskForTurn: () => null,
            getLogicalSessionByProviderSessionId: () => logical,
            getAgentSessionBindingByProviderSession: () => ({
              providerId: "claude-sdk", providerSessionId: "native", bindingId: "binding",
              logicalSessionId: "logical", routingVersion: 1
            }),
            getSession: () => ({ id: "session", status })
          },
          emitEvent: () => {}, recordWorkSettled: () => {},
          settleEntityTaskFromSession: () => {},
          collaborationCore: { getAgentForSession: () => ({}) },
          continuePendingProviderSwitch: route => {
            assert.equal(route, logical);
            calls.push("switch");
            return pending ? switching : null;
          },
          continuePendingWorkspaceTransition: () => { calls.push("workspace"); return null; },
          resumeWorkAfterTransition: (_, resume) => resume(),
          scheduleAgentWorkDrain: id => { assert.equal(id, "session"); calls.push("drain"); },
          providerEventIngestion: { ingest: () => ({ status: "applied" }) },
          sessionStateDiagnostics: { record: (_, kind) => assert.notEqual(kind, "providerError") },
          now: () => "2026-11-12T00:00:00Z"
        };
        let result;
        if (adapter === "shared") {
          result = createProviderTerminalLifecycle(dependencies)({
            event: { type: `turn.${status}`, turnId: "turn", payload: {} },
            projection: { session: { id: "session" }, terminalStatus: status }, logicalRoute: logical
          });
        } else {
          result = createClaudeNotificationReceiver(dependencies).handleClaudeTurnSettledSafely({
            providerSessionId: "native", turnId: "turn", status
          });
        }
        if (pending) {
          assert.deepEqual(calls, ["switch"]);
          finish();
          await switching;
          await result;
          assert.deepEqual(calls, ["switch", "drain"]);
        } else {
          await result;
          assert.deepEqual(calls, status === "completed" ? ["switch", "workspace", "drain"] : ["switch", "drain"]);
        }
      });
    }
  }
}

test("recovered terminal state does not authorize a queued switch", () => {
  const handle = createProviderTerminalLifecycle({
    store: { getRunningAgentTaskForSession: () => null, getAgentTaskForTurn: () => null },
    settleEntityTaskFromSession: () => {},
    continuePendingProviderSwitch: () => assert.fail("recovery must not advance execution")
  });
  handle({ event: { type: "turn.cancelled", payload: { suppressAutomaticContinuation: true } },
    projection: { session: { id: "session" } } });
});
