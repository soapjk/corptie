// Execution transport kinds are not presentation roles. Mailbox input remains
// inspectable in the mailbox even when a Provider receives it as a user prompt.
export function isMailboxOperation(operation) {
  const source = operation?.source;
  return Boolean(source?.mailboxMessageId
    || ["scheduled_session_task", "session_channel", "mailbox_event"].includes(source?.type));
}

export function isMailboxTimelineInput(item, selectOne) {
  if (item.type === "automationEvent") return true;
  if (item.type !== "userMessage") return false;
  let metadata = {};
  try { metadata = JSON.parse(item.rawMetadataJSON ?? "{}"); } catch { /* Legacy metadata. */ }
  const data = { ...metadata, ...item };
  // Outbound correspondence is a separate, existing sender-side presentation.
  if (data.collaborationDirection === "outbound") return false;
  if (data.mailboxMessageId || data.messageOrigin === "scheduled_task"
    || ["scheduled_session_task", "mailbox_event"].includes(data.sourceChannel)
    || (data.sourceChannel === "session_channel" && data.collaborationDirection === "inbound")) return true;
  const operationId = data.taskId ?? data.id;
  if (!operationId || !selectOne) return false;
  const operation = selectOne("SELECT session_id,source_json FROM agent_operations WHERE task_id=?", [operationId]);
  if (!operation || operation.session_id !== data.sessionId) return false;
  try { return isMailboxOperation({ source: JSON.parse(operation.source_json) }); } catch { return false; }
}
