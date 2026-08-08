import { AGENT_PROVIDER_CAPABILITIES, providerSupports } from "./contracts.mjs";

const ACTION_CAPABILITIES = Object.freeze({
  send: AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
  interrupt: AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
  approve: AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
  switchModel: AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
  switchReasoning: AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
  switchWorkspace: AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION
});

export function withSessionActions(session, providerOrDescriptor) {
  if (!session || typeof session !== "object") return session;
  const actions = Object.fromEntries(
    Object.entries(ACTION_CAPABILITIES).map(([action, capability]) => [
      action,
      sessionActionAvailability(action, session, providerOrDescriptor, capability)
    ])
  );
  return { ...session, actions };
}

export function sessionActionAvailability(action, session, providerOrDescriptor, capability = ACTION_CAPABILITIES[action]) {
  if (!capability || !providerSupports(providerOrDescriptor, capability)) {
    return unavailable("CAPABILITY_UNSUPPORTED", false);
  }

  const legacy = session.capabilities ?? {};
  if (action === "send") {
    if (session.canSend === false || legacy.canSend === false) {
      return unavailable(session.sendUnavailableReason ? "PROVIDER_UNAVAILABLE" : "SESSION_NOT_READY", true);
    }
    return available();
  }
  if (action === "interrupt") {
    return legacy.canInterrupt === true
      ? available()
      : unavailable("NO_ACTIVE_TURN", true);
  }
  if (action === "approve") {
    const hasApproval = session.status === "blocked"
      || (Array.isArray(session.suggestedOptions) && session.suggestedOptions.length > 0);
    return hasApproval ? available() : unavailable("NO_PENDING_APPROVAL", true);
  }
  if (action === "switchModel" && legacy.canSwitchModel === false) {
    return unavailable("SESSION_CONFIGURATION_LOCKED", true);
  }
  if (action === "switchReasoning" && legacy.canSwitchReasoning === false) {
    return unavailable("SESSION_CONFIGURATION_LOCKED", true);
  }
  return available();
}

function available() {
  return { available: true, reason: null, retryable: false };
}

function unavailable(reason, retryable) {
  return { available: false, reason, retryable };
}
