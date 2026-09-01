import assert from "node:assert/strict";
import test from "node:test";
import { withSessionReadiness } from "../src/application/sessionReadiness.mjs";
import { sessionActionAvailability } from "../src/agent-provider/sessionActions.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";

const sendable = {
  id: "session:one",
  status: "complete",
  actions: { send: { available: true, reason: null, retryable: false } },
  capabilities: { canSend: true }
};

test("Session readiness is independent from execution status", () => {
  const descriptor = {
    capabilities: [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND]
  };
  const running = withSessionReadiness({
    ...sendable,
    status: "running",
    canSend: false,
    capabilities: { canSend: false },
    actions: {
      send: sessionActionAvailability("send", {
        status: "running",
        canSend: false,
        capabilities: { canSend: false }
      }, descriptor)
    }
  }, {
    logicalSession: { activeBinding: { bindingId: "binding:one" } },
    requireActiveBinding: true,
    providerRuntime: { state: "ready" }
  });
  assert.equal(running.readiness, "ready");
  assert.equal(running.actions.send.available, true);
});

test("an interrupted Session remains reusable when no separate readiness boundary blocks it", () => {
  const descriptor = {
    capabilities: [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND]
  };
  const availability = sessionActionAvailability("send", {
    status: "cancelled",
    capabilities: { canSend: false }
  }, descriptor);
  assert.equal(availability.available, true);
});

test("Provider preparation and Tool confirmation produce explicit Not Ready reasons", () => {
  const initializing = withSessionReadiness(sendable, {
    logicalSession: { activeBinding: { bindingId: "binding:one" } },
    requireActiveBinding: true,
    providerRuntime: { state: "not_ready", reasonCode: "PROVIDER_INITIALIZING", message: "Preparing" }
  });
  assert.equal(initializing.readiness, "not_ready");
  assert.equal(initializing.notReadyReason.code, "PROVIDER_INITIALIZING");
  assert.equal(initializing.actions.send.available, false);

  const toolFailure = withSessionReadiness(sendable, {
    logicalSession: { activeBinding: { bindingId: "binding:one" } },
    requireActiveBinding: true,
    providerRuntime: { state: "ready" },
    toolMaterialization: {
      status: "error",
      desiredVersion: "v5",
      appliedVersion: "v4",
      desiredCatalogVersion: "catalog:5",
      appliedCatalogVersion: "catalog:4",
      lastErrorCode: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED",
      lastErrorSummary: "Tool schema was not confirmed."
    }
  });
  assert.equal(toolFailure.readiness, "not_ready");
  assert.equal(toolFailure.notReadyReason.code, "PROVIDER_TOOL_APPLICATION_UNCONFIRMED");
});
