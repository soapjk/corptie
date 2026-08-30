import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import {
  withResolvedSessionActions,
  withSessionActions
} from "../src/agent-provider/sessionActions.mjs";

const descriptor = {
  capabilities: [
    AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
    AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
    AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
    AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH
  ]
};

test("dynamic Session actions separate Provider support from current availability", () => {
  const session = withSessionActions({
    status: "running",
    canSend: false,
    sendUnavailableReason: "Connecting",
    capabilities: { canInterrupt: false, canSwitchModel: true }
  }, descriptor);

  assert.deepEqual(session.actions.send, {
    available: false,
    reason: "PROVIDER_UNAVAILABLE",
    retryable: true
  });
  assert.deepEqual(session.actions.interrupt, {
    available: false,
    reason: "NO_ACTIVE_TURN",
    retryable: true
  });
  assert.equal(session.actions.switchModel.available, true);
  assert.deepEqual(session.actions.switchWorkspace, {
    available: false,
    reason: "CAPABILITY_UNSUPPORTED",
    retryable: false
  });
});

test("a failed Session remains sendable only when its Provider supports binding recovery", () => {
  const failed = {
    status: "failed",
    canSend: false,
    sendUnavailableReason: "Provider Session failed",
    capabilities: { canSend: false }
  };
  const recoverable = withSessionActions(failed, {
    capabilities: [
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
      AGENT_PROVIDER_CAPABILITIES.SESSION_FAILED_BINDING_RECOVERY
    ]
  });
  const unavailable = withSessionActions(failed, descriptor);

  assert.equal(recoverable.actions.send.available, true);
  assert.equal(unavailable.actions.send.available, false);
  assert.equal(unavailable.actions.send.reason, "PROVIDER_UNAVAILABLE");
});

test("approval becomes available only while the Session has a pending approval", () => {
  const idle = withSessionActions({ status: "complete", capabilities: {} }, descriptor);
  const blocked = withSessionActions({ status: "blocked", capabilities: {} }, descriptor);

  assert.equal(idle.actions.approve.available, false);
  assert.equal(idle.actions.approve.reason, "NO_PENDING_APPROVAL");
  assert.equal(blocked.actions.approve.available, true);
});

test("restart availability is driven only by the Provider capability", () => {
  const supported = withSessionActions({ status: "complete", capabilities: {} }, {
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART]
  });
  const unsupported = withSessionActions({ status: "complete", capabilities: {} }, descriptor);

  assert.equal(supported.actions.restart.available, true);
  assert.equal(unsupported.actions.restart.available, false);
  assert.equal(unsupported.actions.restart.reason, "CAPABILITY_UNSUPPORTED");
});

test("stored Session projections resolve Provider capabilities before reaching the client", () => {
  const registry = {
    resolveId: (identity) => identity === "codex-app-server" ? identity : null,
    decorateSession: (_providerId, session) => withSessionActions(session, {
      capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART]
    })
  };
  const projected = withResolvedSessionActions({
    id: "session:stored",
    status: "complete",
    external: { provider: "codex-app-server" }
  }, registry);
  const unknown = { id: "session:legacy", external: { provider: "retired-provider" } };

  assert.equal(projected.actions.restart.available, true);
  assert.strictEqual(withResolvedSessionActions(unknown, registry), unknown);
});

test("manual disconnect availability is driven only by the Provider capability", () => {
  const supported = withSessionActions({ status: "running", capabilities: {} }, {
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_DISCONNECT]
  });
  const unsupported = withSessionActions({ status: "running", capabilities: {} }, descriptor);

  assert.equal(supported.actions.disconnect.available, true);
  assert.equal(unsupported.actions.disconnect.available, false);
  assert.equal(unsupported.actions.disconnect.reason, "CAPABILITY_UNSUPPORTED");
});
