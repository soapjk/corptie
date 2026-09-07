export function assertSessionToolScope(input = {}) {
  const actorId = normalizedText(input.actorId);
  const providerBindingId = normalizedText(input.providerBindingId);
  const session = input.session ?? null;
  const activeBindingId = normalizedText(input.metadata?.providerBindingId);
  const boundAgentId = normalizedText(input.boundAgent?.agentId);
  const sessionAgentId = normalizedText(session?.agentId);
  const actorMatches = Boolean(session)
    && (sessionAgentId === actorId || boundAgentId === actorId);
  if (!actorId || !session || !providerBindingId
    || providerBindingId !== activeBindingId || !actorMatches) {
    const error = new Error("Session Tool scope is invalid or no longer active.");
    error.code = "SESSION_TOOL_SCOPE_REQUIRED";
    error.statusCode = 403;
    throw error;
  }
  return Object.freeze({ actorId, sessionId: session.id, providerBindingId });
}

function normalizedText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}
