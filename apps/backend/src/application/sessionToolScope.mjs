// Transport evidence is supplied by the adapter, never by tool arguments.
// Resolve it afresh for each invocation; attachment metadata is not authority.
export function createSessionToolContextResolver({ store, collaborationCore, resolveToolHostBinding }) {
  return function resolveSessionToolContext(input = {}) {
    const actorId = normalizedText(input.actorId);
    const evidence = Object.freeze({ ...input.evidence });
    const credentials = { actorId, evidence };
    let logical;
    if (evidence.kind === "provider-thread") {
      const threadId = normalizedText(evidence.threadId);
      logical = threadId ? store.getLogicalSessionByProviderThreadId(threadId) : null;
      if (!logical || logical.activeThreadId !== threadId
        || logical.activeBinding?.providerThreadId !== threadId
        || logical.activeBinding?.providerId !== evidence.providerId) scopeRequired();
    } else if (evidence.kind === "provider-session") {
      const providerSessionId = normalizedText(evidence.providerSessionId);
      logical = providerSessionId ? store.getLogicalSessionByProviderSessionId(evidence.providerId, providerSessionId) : null;
      if (!logical || logical.activeBinding?.providerSessionId !== providerSessionId
        || logical.activeBinding?.providerId !== evidence.providerId) scopeRequired();
    } else if (evidence.kind === "session-binding") {
      const sessionId = normalizedText(evidence.sessionId);
      logical = sessionId ? store.getLogicalSessionByLegacySessionId(sessionId) : null;
      if (!logical || !normalizedText(evidence.providerBindingId)
        || logical.activeBinding?.bindingId !== evidence.providerBindingId) scopeRequired();
    } else {
      scopeRequired();
    }
    const session = logical.legacySessionId ? store.getSession(logical.legacySessionId) : null;
    const binding = resolveToolHostBinding(logical.logicalSessionId, logical.activeBinding?.bindingId);
    const boundAgent = session ? collaborationCore.getAgentForSession(session.id) : null;
    if (!actorId || !session || !binding || binding.state !== "active" || !binding.isCurrent
      || binding.tombstoned || session.deletedAt
      || (session.agentId !== actorId && boundAgent?.agentId !== actorId)) scopeRequired();
    if (evidence.sessionKind && (session.sessionKind !== evidence.sessionKind || session.workId !== evidence.workId)) {
      scopeRequired();
    }
    if (session.sessionKind === "worker" && !binding.taskSessionAuthorization) {
      throw Object.assign(new Error("The Session is no longer authorized to execute for this Task."), {
        code: "SESSION_TOOL_EXECUTION_FORBIDDEN", statusCode: 403, stage: "session_authorization"
      });
    }
    const turnId = session.external?.activeTurnId ?? session.rawStatus?.activeTurnId
      ?? store.listUnsettledSessionTurns?.(session.id).at(-1)?.turn_id ?? null;
    const metadata = Object.freeze({
      purpose: "session", sessionKind: session.sessionKind ?? "legacy", turnId,
      sessionId: session.id, logicalSessionId: logical.logicalSessionId,
      workId: session.workId ?? null, taskId: session.taskId ?? null,
      providerBindingId: binding.providerBindingId, providerId: binding.providerId,
      providerSessionId: binding.providerSessionId
    });
    return {
      ...input, actorId, providerId: binding.providerId, metadata,
      context: Object.freeze({
        actorId, metadata, binding: Object.freeze({ ...binding,
          ...(binding.delegation ? { delegation: Object.freeze({ ...binding.delegation }) } : {})
        }),
        revalidate: () => {
          const current = resolveSessionToolContext(credentials).context;
          if (current.metadata.logicalSessionId !== metadata.logicalSessionId
            || current.metadata.providerBindingId !== metadata.providerBindingId) scopeRequired();
          return current;
        }
      })
    };
  };
}

function scopeRequired() {
  throw Object.assign(new Error("Session Tool scope is invalid or no longer active."), {
    code: "SESSION_TOOL_SCOPE_REQUIRED", statusCode: 403, stage: "route_validation"
  });
}

function normalizedText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}
