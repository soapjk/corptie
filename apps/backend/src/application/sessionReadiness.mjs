const READY = "ready";
const NOT_READY = "not_ready";

export function withSessionReadiness(session, context = {}) {
  if (!session || typeof session !== "object") return session;
  const readiness = resolveSessionReadiness(session, context);
  const send = session.actions?.send ?? null;
  const actions = session.actions
    ? {
        ...session.actions,
        send: readiness.state === READY
          ? send
          : {
              available: false,
              reason: readiness.reason.code,
              retryable: readiness.reason.retryable
            }
      }
    : session.actions;
  return {
    ...session,
    readiness: readiness.state,
    notReadyReason: readiness.reason,
    canSend: readiness.state === READY,
    sendUnavailableReason: readiness.reason?.message ?? null,
    capabilities: session.capabilities
      ? { ...session.capabilities, canSend: readiness.state === READY }
      : session.capabilities,
    ...(actions ? { actions } : {})
  };
}

export function resolveSessionReadiness(session, context = {}) {
  if (session.archived === true) {
    return notReady("SESSION_ARCHIVED", "This Session is archived and cannot accept messages.", false);
  }
  if (context.readOnly === true) {
    return notReady("SESSION_READ_ONLY", "This Session is read-only.", false);
  }
  const transitionState = context.logicalSession?.transitionState
    ?? context.logicalSession?.transition_state
    ?? session.transitionState
    ?? null;
  if (transitionState === "sessionRecovery") {
    return notReady("BINDING_RECOVERING", "Session binding recovery is in progress.", true);
  }
  if (transitionState) {
    return notReady("WORKSPACE_TRANSITIONING", "The Session workspace route is changing.", true);
  }
  if (!context.logicalSession?.activeBinding && context.requireActiveBinding === true) {
    return notReady("SESSION_BINDING_NOT_FOUND", "The Session has no active Provider binding.", true);
  }
  if (context.providerRuntime?.state && context.providerRuntime.state !== READY) {
    return notReady(
      context.providerRuntime.reasonCode ?? "PROVIDER_INITIALIZING",
      context.providerRuntime.message ?? "The Provider is still preparing to accept Session messages.",
      context.providerRuntime.retryable !== false
    );
  }
  const materialization = context.toolMaterialization ?? null;
  if (materialization && (
    materialization.status !== "applied"
    || materialization.appliedVersion !== materialization.desiredVersion
    || materialization.appliedCatalogVersion !== materialization.desiredCatalogVersion
  )) {
    return notReady(
      materialization.lastErrorCode ?? "TOOL_SCHEMA_UNCONFIRMED",
      materialization.lastErrorSummary ?? "The Provider has not confirmed this Session's Tool schema.",
      true
    );
  }
  const send = session.actions?.send;
  if (send?.available === false) {
    return notReady(
      send.reason ?? "SESSION_NOT_READY",
      session.sendUnavailableReason ?? messageForActionReason(send.reason),
      send.retryable !== false
    );
  }
  if (!send && (session.canSend === false || session.capabilities?.canSend === false)) {
    return notReady(
      "SESSION_NOT_READY",
      session.sendUnavailableReason ?? "This Session cannot accept messages right now.",
      true
    );
  }
  return Object.freeze({ state: READY, reason: null });
}

function notReady(code, message, retryable) {
  return Object.freeze({
    state: NOT_READY,
    reason: Object.freeze({ code, message, retryable })
  });
}

function messageForActionReason(reason) {
  switch (reason) {
    case "CAPABILITY_UNSUPPORTED": return "This Provider does not support Session messages.";
    case "PROVIDER_UNAVAILABLE": return "The Provider is unavailable for this Session.";
    case "SESSION_READ_ONLY": return "This Session is read-only.";
    default: return "This Session cannot accept messages right now.";
  }
}

