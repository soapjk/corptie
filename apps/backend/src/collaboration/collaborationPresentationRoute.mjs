export function collaborationMessagePresentationRoute(envelope) {
  const task = envelope?.task ?? {};
  const message = envelope?.message ?? {};
  const protocol = message.envelope ?? {};
  const senderAgentId = protocol.sender?.agentId ?? message.senderAgentId ?? null;
  const recipientAgentId = protocol.recipient?.agentId ?? message.recipientAgentId ?? null;
  const sourceSessionId = protocol.sender?.sessionId ?? message.senderSessionId ?? null;
  const targetSessionId = protocol.recipient?.sessionId ?? message.recipientSessionId ?? null;

  return {
    senderAgentId,
    recipientAgentId,
    sourceObjectiveId: protocol.objective?.sourceId ?? protocol.sender?.objectiveId ?? null,
    targetObjectiveId: protocol.objective?.targetId ?? protocol.recipient?.objectiveId ?? null,
    sourceSessionId,
    targetSessionId,
    sourceSessionTitle: sessionNameAtSend(task, senderAgentId, sourceSessionId),
    targetSessionTitle: sessionNameAtSend(task, recipientAgentId, targetSessionId)
  };
}

function sessionNameAtSend(task, agentId, sessionId) {
  if (sameSession(sessionId, task.initiatorSessionId)) return task.initiatorNameAtSend ?? null;
  if (sameSession(sessionId, task.recipientSessionId)) return task.recipientNameAtSend ?? null;
  if (task.initiatorAgentId !== task.recipientAgentId) {
    if (agentId === task.initiatorAgentId) return task.initiatorNameAtSend ?? null;
    if (agentId === task.recipientAgentId) return task.recipientNameAtSend ?? null;
  }
  return null;
}

function sameSession(left, right) {
  return Boolean(left && right && left === right);
}
