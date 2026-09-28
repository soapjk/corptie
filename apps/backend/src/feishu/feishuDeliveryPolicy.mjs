const feishuHiddenSessionItemTypes = new Set([
  "reasoning",
  "plan",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "contextCompaction",
  "warning",
  "taskComplete"
]);

export function isTerminalSessionStatus(status) {
  return ["complete", "completed", "failed", "cancelled", "canceled", "interrupted"]
    .includes(optionalText(status).toLowerCase());
}

function isPendingApprovalItem(item) {
  return ["approval", "choice"].includes(item?.type)
    && item.status !== "selected"
    && Array.isArray(item.options)
    && item.options.length > 0;
}

function isPendingCollaborationConfirmationItem(item) {
  return item?.type === "collaborationConfirmation"
    && collaborationConfirmationStatus(item) === "pending";
}

function shouldDeliverOnInitialFeishuSync(item) {
  return isPendingApprovalItem(item) || isPendingCollaborationConfirmationItem(item);
}

export function shouldSeedFeishuSeenItem(item) {
  return !shouldDeliverOnInitialFeishuSync(item)
    && feishuProjectionForSessionItem(item) !== "deferred";
}

export function findLatestFormalAgentReply(items = []) {
  return (Array.isArray(items) ? items : []).slice().reverse().find((item) => {
    if (!["agentMessage", "assistantMessage"].includes(item?.type) || !optionalText(item.text)) {
      return false;
    }
    const presentationRole = optionalText(item.presentationRole).toLowerCase();
    if (presentationRole) {
      return presentationRole === "final_answer";
    }
    if (optionalText(item.status).toLowerCase() === "final_answer") {
      return true;
    }
    return isTerminalTurnStatus(item.turnStatus);
  }) ?? null;
}

function isTerminalTurnStatus(status) {
  return ["completed", "complete", "succeeded", "success", "failed", "cancelled", "canceled", "interrupted"]
    .includes(optionalText(status).toLowerCase());
}

export function feishuProjectionForSessionItem(item) {
  if (item?.feishuVisibility === "hidden") return "hidden";
  if (item?.type === "collaborationConfirmation") return "collaboration_confirmation";
  if (isPendingApprovalItem(item)) return "approval";

  if (item?.sourceType === "collaboration" && item?.type === "userMessage") return "collaboration";
  if (feishuHiddenSessionItemTypes.has(item?.type)) return "hidden";
  if (item?.type === "userMessage") {
    return item.status === "queued" || !optionalText(item.text) ? "hidden" : "user";
  }
  if (["agentMessage", "assistantMessage"].includes(item?.type)) {
    const status = optionalText(item.status).toLowerCase();
    const turnStatus = optionalText(item.turnStatus).toLowerCase();
    const isStillGenerating = ["inprogress", "in_progress", "running", "streaming", "pending", "started"]
      .includes(status)
      || (turnStatus && !isTerminalTurnStatus(turnStatus));
    if (!optionalText(item.text) || isStillGenerating) return "deferred";
    return isFinalAssistantItem(item) ? "assistant" : "hidden";
  }

  // Session message cards are remote-visible by default. Types that should
  // remain local must opt out above or set feishuVisibility=hidden.
  return "generic";
}

function isFinalAssistantItem(item) {
  const turnStatus = optionalText(item?.turnStatus).toLowerCase();
  if (["failed", "cancelled", "canceled", "interrupted"].includes(turnStatus)) return false;
  const presentationRole = optionalText(item?.presentationRole).toLowerCase();
  if (presentationRole) return presentationRole === "final_answer";
  if (optionalText(item?.status).toLowerCase() === "final_answer") return true;
  if (turnStatus) return ["completed", "complete", "succeeded", "success"].includes(turnStatus);
  // Old stored sessions predate presentationRole and turnStatus. Their single
  // unphased assistant item is already a completed reply, not a live stream.
  return true;
}

export function pendingRequestForFinalItem(runtime, items = [], finalItem) {
  const requests = runtime.pendingFeishuRequests ?? [];
  if (!requests.length) return null;
  const finalIndex = items.findIndex((item) => item.id === finalItem.id);
  if (finalIndex < 0) return null;
  const preceding = items.slice(0, finalIndex);
  const turnId = optionalText(finalItem.turnId);
  const userItem = turnId
    ? preceding.findLast((item) => item.type === "userMessage" && optionalText(item.turnId) === turnId)
    : preceding.findLast((item) => item.type === "userMessage");
  if (!userItem?.id) return null;
  return requests.find((request) => request.messageId === userItem.id && request.sessionId) ?? null;
}

export function collaborationConfirmationStatus(item) {
  return optionalText(item?.collaborationConfirmationStatus || item?.status).toLowerCase();
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}
