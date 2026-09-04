export function createScheduledSessionRouteResolver({ store, collaborationCore }) {
  if (!store || !collaborationCore) {
    throw new TypeError("Scheduled Session routing requires store and collaborationCore ports.");
  }

  return async function resolveScheduledSessionRoute(logicalSessionId) {
    const logical = store.getLogicalSession(logicalSessionId);
    if (!logical) {
      routeError("SESSION_NOT_FOUND", `Logical Session ${logicalSessionId} no longer exists.`);
    }
    if (logical.archived) {
      routeError("SESSION_ARCHIVED", `Logical Session ${logicalSessionId} is archived.`);
    }
    if (!logical.activeBinding || logical.activeBinding.state !== "active") {
      routeError("ROUTE_UNAVAILABLE", `Logical Session ${logicalSessionId} has no active Provider binding.`);
    }
    const session = logical.legacySessionId ? store.getSession(logical.legacySessionId) : null;
    const agent = session ? collaborationCore.getAgentForSession(session.id) : null;
    if (!session || !agent) {
      routeError(
        session ? "AGENT_NOT_FOUND" : "SESSION_NOT_FOUND",
        session
          ? `Logical Session ${logicalSessionId} has no authorized Agent.`
          : `Logical Session ${logicalSessionId} has no current Session projection.`
      );
    }
    return {
      logicalSession: logical,
      sessionId: session.id,
      agentId: agent.agentId,
      binding: logical.activeBinding
    };
  };
}

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
