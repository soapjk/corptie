export function collaborationMessagePresentationRoute(envelope) {
  const task = envelope?.task ?? {};
  const message = envelope?.message ?? {};
  const protocol = message.envelope ?? {};
  const senderAgentId = protocol.resources?.sourceAgentId ?? message.senderAgentId ?? null;
  const recipientAgentId = protocol.resources?.targetAgentId ?? message.recipientAgentId ?? null;
  const sourceSessionId = protocol.sender?.sessionId ?? message.senderSessionId ?? null;
  const targetSessionId = protocol.recipient?.sessionId ?? message.recipientSessionId ?? null;

  return {
    senderAgentId,
    recipientAgentId,
    sourceWorkId: protocol.resources?.sourceWorkId ?? null,
    targetWorkId: protocol.resources?.targetWorkId ?? null,
    sourceSessionId,
    targetSessionId,
    sourceSessionTitle: sessionNameAtSend(task, sourceSessionId),
    targetSessionTitle: sessionNameAtSend(task, targetSessionId)
  };
}

function sessionNameAtSend(task, sessionId) {
  if (sameSession(sessionId, task.initiatorSessionId)) return task.initiatorNameAtSend ?? null;
  if (sameSession(sessionId, task.recipientSessionId)) return task.recipientNameAtSend ?? null;
  return null;
}

function sameSession(left, right) {
  return Boolean(left && right && left === right);
}
