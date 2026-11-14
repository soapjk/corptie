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
  // Internal child correspondence belongs to the mailbox, never the main chat.
  if (data.collaborationDirection === "outbound") {
    if (!selectOne) return false;
    const sender = data.collaborationSourceTaskId, recipient = data.collaborationTargetTaskId;
    return Boolean(sender && recipient && selectOne(`SELECT 1 FROM tasks a JOIN tasks b ON a.work_id=b.work_id
      WHERE a.id=? AND b.id=? AND (a.parent_task_id=b.id OR b.parent_task_id=a.id)`, [sender, recipient]));
  }
  if (data.mailboxMessageId || data.messageOrigin === "scheduled_task"
    || ["scheduled_session_task", "mailbox_event"].includes(data.sourceChannel)
    || (data.sourceChannel === "session_channel" && data.collaborationDirection === "inbound")) return true;
  const operationId = data.taskId ?? data.id;
  if (!operationId || !selectOne) return false;
  const operation = selectOne("SELECT session_id,source_json FROM agent_operations WHERE task_id=?", [operationId]);
  if (!operation || operation.session_id !== data.sessionId) return false;
  try { return isMailboxOperation({ source: JSON.parse(operation.source_json) }); } catch { return false; }
}
