const DIRECT_MESSAGE_SOURCES = new Set(["desktop", "macos", "feishu", "dsh"]);

export function authorizeDirectUserTaskCreation(input = {}) {
  const logicalSessionId = required(input.logicalSessionId, "logical_session_id");
  if (logicalSessionId !== input.expectedLogicalSessionId) {
    throw coded("LOGICAL_SESSION_MISMATCH", "The authenticated logical Session does not match the Task-creation evidence.", 403);
  }
  const eventId = required(input.userMessageEventId, "user_message_event_id");
  const sequence = positiveInteger(input.userMessageSequence, "user_message_sequence");
  const event = input.store.getSessionEventByIdentity(input.providerSessionId, eventId, sequence);
  const sourceRejection = directUserTaskCreationRejection(event);
  if (sourceRejection) throw coded(sourceRejection.code, sourceRejection.message, 403);
  const now = input.now?.() ?? new Date();
  const eventAge = now.getTime() - Date.parse(event.createdAt);
  const ttlMs = input.ttlMs ?? 30 * 60_000;
  if (!Number.isFinite(eventAge) || eventAge < -5_000 || eventAge > ttlMs) {
    throw coded("TASK_CREATION_INTENT_EXPIRED", "The direct user message is outside the allowed Task-creation window.", 410);
  }
  const turnId = required(input.turnId, "turn_id");
  const delivery = input.store.getMessageDelivery(event.payload?.deliveryId);
  const authoritativeTurnIds = new Set([delivery?.providerTurnId, event.payload?.deliveryId].filter(Boolean));
  if (!delivery || !authoritativeTurnIds.has(turnId)) {
    throw coded("USER_MESSAGE_TURN_MISMATCH", "The direct user message does not belong to the supplied current turn.", 403);
  }
  const message = String(event.payload?.message?.text ?? "");
  if (!containsExplicitTaskCreationIntent(message)) {
    throw coded("USER_MESSAGE_TASK_CREATION_INTENT_MISSING", "The direct user message does not explicitly request creation of a new Task.", 403);
  }
  return { logicalSessionId, eventId: event.eventId, sequence: event.sequence, turnId };
}

function directUserTaskCreationRejection(event) {
  const sourceType = String(event?.source?.type ?? "");
  const direct = event?.type === "SessionUserMessageCreated"
    && event.producer === "user"
    && event.surface === true
    && DIRECT_MESSAGE_SOURCES.has(sourceType)
    && !event.source?.taskId
    && !event.source?.automationId
    && !event.source?.scheduledTaskId;
  if (direct) return null;
  if (event?.source?.taskId || sourceType === "collaboration") {
    return {
      code: "COLLABORATION_MESSAGE_NOT_AUTHORIZED",
      message: "Collaboration and peer messages cannot authorize creation of a new Task."
    };
  }
  if (event?.source?.automationId || event?.source?.scheduledTaskId
    || ["automation", "scheduled_session_task", "scheduled_task"].includes(sourceType)) {
    return {
      code: "AUTOMATION_MESSAGE_NOT_AUTHORIZED",
      message: "Automation and scheduled messages cannot authorize creation of a new Task."
    };
  }
  if (event && (event.producer !== "user" || event.surface !== true)) {
    return {
      code: "NON_USER_MESSAGE_NOT_AUTHORIZED",
      message: "Assistant, system, Provider, and Tool events cannot authorize creation of a new Task."
    };
  }
  return {
    code: "DIRECT_USER_MESSAGE_REQUIRED",
    message: "Task creation evidence is not a direct user message."
  };
}

export function containsExplicitTaskCreationIntent(text) {
  const message = String(text ?? "");
  const chineseNegation = /(?:不要|别|禁止|不允许|不许|不能|不可|不应|无需|暂不|先不).{0,80}(?:创建|新建|新增|另建|另开|交给|转成|拆成).{0,40}(?:Task|任务|工作项)/iu;
  const englishNegation = /(?:do\s+not|don't|must\s+not|should\s+not|without|unless).{0,100}(?:create|open|make|add|spin\s+up).{0,40}(?:new|another|separate|independent)?\s*(?:task|work\s*item)/iu;
  if (chineseNegation.test(message) || englishNegation.test(message)) return false;
  return /(?:创建|新建|新增|另建|另开|单独(?:建|开|创建|新建)).{0,40}(?:新的?|另一个|独立的?)?\s*(?:Task|任务|工作项)/iu.test(message)
    || /(?:把|将|请|可以|直接).{0,80}(?:交给|放到|转成|拆成).{0,30}(?:另一个|新的?|独立的?)?\s*(?:Task|任务|工作项)/iu.test(message)
    || /(?:create|open|make|add|spin\s+up).{0,40}(?:a\s+)?(?:new|another|separate|independent)\s+(?:task|work\s*item)/iu.test(message)
    || /(?:^|[.!?]\s*|please\s+|can\s+you\s+|could\s+you\s+|go\s+ahead\s+and\s+)(?:create|open|make|add|spin\s+up)\s+(?:a\s+)?(?:task|work\s*item)/iu.test(message)
    || /(?:hand|move|split).{0,60}(?:into|to).{0,20}(?:another|a\s+new|a\s+separate|an\s+independent)\s+(?:task|work\s*item)/iu.test(message);
}

function required(value, field) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw coded("INVALID_INPUT", `${field} is required.`);
  return result;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw coded("INVALID_INPUT", `${field} must be a positive integer.`);
  }
  return number;
}

function coded(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
