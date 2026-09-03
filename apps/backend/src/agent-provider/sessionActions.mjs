import { AGENT_PROVIDER_CAPABILITIES, providerSupports } from "./contracts.mjs";

const ACTION_CAPABILITIES = Object.freeze({
  resume: AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
  prepareExecution: AGENT_PROVIDER_CAPABILITIES.SESSION_EXECUTION_PREPARE,
  delete: AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
  restart: AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART,
  disconnect: AGENT_PROVIDER_CAPABILITIES.SESSION_DISCONNECT,
  send: AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
  interrupt: AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
  approve: AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
  switchModel: AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
  switchReasoning: AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
  updatePermissions: AGENT_PROVIDER_CAPABILITIES.PERMISSIONS_UPDATE,
  switchWorkspace: AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION,
  switchProvider: null
});

export function withSessionActions(session, providerOrDescriptor) {
  if (!session || typeof session !== "object") return session;
  const actions = Object.fromEntries(
    Object.entries(ACTION_CAPABILITIES).map(([action, capability]) => [
      action,
      sessionActionAvailability(action, session, providerOrDescriptor, capability)
    ])
  );
  return {
    ...session,
    capabilities: {
      ...(session.capabilities ?? {}),
      canSendImages: providerSupports(
        providerOrDescriptor,
        AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND_IMAGE
      )
    },
    actions
  };
}

export function withResolvedSessionActions(session, registry) {
  if (!session || typeof session !== "object") return session;
  const providerIdentity = session.external?.provider ?? session.provider ?? null;
  const providerId = providerIdentity ? registry?.resolveId?.(providerIdentity) : null;
  return providerId ? registry.decorateSession(providerId, session) : session;
}

export function sessionActionAvailability(action, session, providerOrDescriptor, capability = ACTION_CAPABILITIES[action]) {
  if (action === "switchProvider") {
    // Provider switching is a backend session-level operation (fork to a target
    // Provider), not a capability of the current Provider. It is offered whenever
    // the Session has an active logical route and no switch is already in flight.
    const inFlight = session.providerSwitchInFlight === true
      || session.external?.providerSwitchInFlight === true;
    if (inFlight) {
      return unavailable("PROVIDER_SWITCH_IN_FLIGHT", true);
    }
    return available();
  }
  if (!capability || !providerSupports(providerOrDescriptor, capability)) {
    return unavailable("CAPABILITY_UNSUPPORTED", false);
  }

  const legacy = session.capabilities ?? {};
  if (action === "resume") {
    return legacy.canReconnect === false
      ? unavailable("SESSION_ALREADY_CONNECTED", true)
      : available();
  }
  if (action === "send") {
    // Provider-native canSend commonly means "dispatch another Provider Turn
    // right now". Corptie's send action means "accept an application message",
    // which remains available while the current Turn is running/blocked because
    // the backend owns a serial in-memory queue. Separate readiness boundaries
    // (recovery, archive, workspace transition, Provider preparation) close it.
    if (["running", "blocked", "cancelled", "canceled"].includes(session.status)) return available();
    if (session.canSend === false || legacy.canSend === false) {
      if (session.status === "failed" && providerSupports(
        providerOrDescriptor,
        AGENT_PROVIDER_CAPABILITIES.SESSION_FAILED_BINDING_RECOVERY
      )) {
        return available();
      }
      return unavailable(session.sendUnavailableReason ? "PROVIDER_UNAVAILABLE" : "SESSION_NOT_READY", true);
    }
    return available();
  }
  if (action === "prepareExecution") {
    return ["running", "blocked"].includes(session.status)
      ? unavailable("SESSION_ALREADY_ACTIVE", true)
      : available();
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
