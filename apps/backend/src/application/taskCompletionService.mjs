import { createHash, randomBytes, randomUUID } from "node:crypto";

const COMPLETED = new Set(["done", "complete", "completed"]);
const UI_SURFACES = new Set(["task_completion_confirmation", "task_edit_status_confirmation"]);
const DIRECT_MESSAGE_SOURCES = new Set(["desktop", "macos"]);

export class TaskCompletionError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "TaskCompletionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class TaskCompletionService {
  constructor({ store, onCompleted = null, now = () => new Date(), uiTtlMs = 5 * 60_000, sessionTtlMs = 30 * 60_000 } = {}) {
    if (!store) throw new TypeError("TaskCompletionService requires a Store.");
    this.store = store;
    this.onCompleted = onCompleted;
    this.now = now;
    this.uiTtlMs = uiTtlMs;
    this.sessionTtlMs = sessionTtlMs;
  }

  issueMacOSIntent(taskId, input = {}, actor = {}) {
    const requestId = required(input.requestId, "COMPLETION_REQUEST_ID_REQUIRED", "requestId is required.");
    const existing = this.store.getTaskCompletionIntentByRequest("direct_macos_ui_action", requestId);
    if (existing) {
      if (existing.taskId !== taskId) throw completionError("COMPLETION_INTENT_REQUEST_CONFLICT", "The intent request is bound to another Task.");
      return presentReceipt(existing);
    }
    if (actor.type !== "user" || actor.id !== "user:local-macos") {
      throw completionError("DIRECT_USER_INTENT_REQUIRED", "Only the authenticated local macOS user may issue this intent.", 403);
    }
    const task = this.#task(taskId);
    const interactionId = required(input.interactionId, "UI_INTERACTION_ID_REQUIRED", "interactionId is required.");
    const uiSurface = required(input.uiSurface, "UI_SURFACE_REQUIRED", "uiSurface is required.");
    if (!UI_SURFACES.has(uiSurface)) throw completionError("UI_SURFACE_NOT_AUTHORIZED", "This UI surface cannot issue completion intent.", 403);
    if (input.displayedTaskId !== task.id || input.displayedTaskTitle !== task.title) {
      throw completionError("UI_TARGET_SNAPSHOT_MISMATCH", "The displayed Task snapshot is stale or mismatched.");
    }
    const issuedAt = this.now();
    const receiptId = `completion_intent:${randomUUID()}`;
    const nonce = randomBytes(32).toString("base64url");
    const token = `${receiptId}.${nonce}`;
    const intent = this.store.createTaskCompletionIntent({
      receiptId,
      tokenHash: sha256(token),
      taskId: task.id,
      objectiveId: task.objective_id,
      sourceType: "direct_macos_ui_action",
      interactionId,
      uiSurface,
      requestId,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.uiTtlMs).toISOString(),
      metadata: {
        displayedTaskId: task.id,
        displayedTaskTitle: task.title,
        displayedAcceptanceStatus: input.displayedAcceptanceStatus ?? null,
        purpose: "task_completion"
      }
    });
    return presentReceipt(intent);
  }

  completeFromMacOS(taskId, input = {}) {
    const sourceType = "direct_macos_ui_action";
    const task = this.#task(taskId);
    const fallbackAttemptId = `invalid-completion-attempt:${randomUUID()}`;
    let idempotencyKey = optionalText(input.idempotencyKey) ?? fallbackAttemptId;
    let requestId = optionalText(input.requestId) ?? fallbackAttemptId;
    let intent;
    try {
      idempotencyKey = required(input.idempotencyKey, "COMPLETION_IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.");
      requestId = required(input.requestId, "COMPLETION_REQUEST_ID_REQUIRED", "requestId is required.");
      const token = required(input.intentToken, "COMPLETION_INTENT_REQUIRED", "A completion intent token is required.");
      const existing = this.store.getTaskCompletionOperationByIdempotency(sourceType, idempotencyKey);
      if (existing) return this.#replay(existing, taskId, requestId);
      intent = this.store.getTaskCompletionIntentByTokenHash(sha256(token));
      if (!intent) throw completionError("COMPLETION_INTENT_INVALID", "Completion intent token is invalid.", 403);
      if (token !== `${intent.receiptId}.${intent.nonce}`) throw completionError("COMPLETION_INTENT_INVALID", "Completion intent token is invalid.", 403);
      if (intent.sourceType !== sourceType || intent.taskId !== task.id || intent.objectiveId !== task.objective_id) {
        throw completionError("COMPLETION_INTENT_TARGET_MISMATCH", "Completion intent does not match this Task.", 403);
      }
      if (intent.requestId !== requestId) throw completionError("COMPLETION_INTENT_REQUEST_MISMATCH", "Completion request does not match its intent.", 403);
      if (intent.consumedOperationId) throw completionError("COMPLETION_INTENT_REPLAYED", "Completion intent was already consumed.", 409);
      if (Date.parse(intent.expiresAt) <= this.now().getTime()) throw completionError("COMPLETION_INTENT_EXPIRED", "Completion intent has expired.", 410);
      const result = this.store.completeTaskWithAuthorization(this.#operationInput({
        task, sourceType, idempotencyKey, requestId, nonce: intent.nonce,
        receiptId: intent.receiptId, interactionId: intent.interactionId,
        callSurface: intent.uiSurface, details: { purpose: "task_completion" }
      }));
      this.onCompleted?.(result.task, result.operation);
      return result;
    } catch (error) {
      this.#auditRejection({ error, task, sourceType, idempotencyKey, requestId,
        nonce: intent?.nonce, receiptId: intent?.receiptId, interactionId: intent?.interactionId,
        callSurface: intent?.uiSurface ?? "macos_completion_http" });
      throw error;
    }
  }

  completeFromSession(input = {}, metadata = {}) {
    const sourceType = "direct_session_user_instruction";
    const taskId = required(input.targetTaskId, "TASK_ID_REQUIRED", "targetTaskId is required.");
    const task = this.#task(taskId);
    const fallbackAttemptId = `invalid-completion-attempt:${randomUUID()}`;
    let idempotencyKey = optionalText(input.idempotencyKey) ?? fallbackAttemptId;
    let requestId = optionalText(input.requestId) ?? fallbackAttemptId;
    try {
      const objectiveId = required(input.objectiveId, "OBJECTIVE_ID_REQUIRED", "objectiveId is required.");
      idempotencyKey = required(input.idempotencyKey, "COMPLETION_IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.");
      requestId = required(input.requestId, "COMPLETION_REQUEST_ID_REQUIRED", "requestId is required.");
      const existing = this.store.getTaskCompletionOperationByIdempotency(sourceType, idempotencyKey);
      if (existing) return this.#replay(existing, taskId, requestId);
      if (task.objective_id !== objectiveId) throw completionError("TASK_OBJECTIVE_MISMATCH", "Task does not belong to the supplied Objective.", 403);
      const logicalSessionId = required(input.logicalSessionId, "LOGICAL_SESSION_ID_REQUIRED", "logicalSessionId is required.");
      if (!metadata.logicalSessionId || metadata.logicalSessionId !== logicalSessionId) {
        throw completionError("LOGICAL_SESSION_MISMATCH", "The authenticated logical Session does not match the completion evidence.", 403);
      }
      const logical = this.store.getLogicalSession(logicalSessionId);
      if (!logical || logical.legacySessionId !== metadata.sessionId) {
        throw completionError("LOGICAL_SESSION_MISMATCH", "A Provider Session ID cannot substitute for the logical Session ID.", 403);
      }
      const session = this.store.getSession(logical.legacySessionId);
      if (!sessionCanOperate(session, task)) throw completionError("TASK_SESSION_UNAUTHORIZED", "The logical Session cannot complete this Task.", 403);
      const eventId = required(input.userMessageEventId, "USER_MESSAGE_EVENT_REQUIRED", "userMessageEventId is required.");
      const sequence = positiveInteger(input.userMessageSequence, "USER_MESSAGE_SEQUENCE_REQUIRED");
      const event = this.store.getSessionEventByIdentity(session.id, eventId, sequence);
      const sourceRejection = directUserEventRejection(event);
      if (sourceRejection) throw completionError(sourceRejection.code, sourceRejection.message, 403);
      const eventAge = this.now().getTime() - Date.parse(event.createdAt);
      if (!Number.isFinite(eventAge) || eventAge < -5_000 || eventAge > this.sessionTtlMs) {
        throw completionError("COMPLETION_INTENT_EXPIRED", "The direct user message is outside the allowed completion window.", 410);
      }
      const turnId = required(input.turnId, "TURN_ID_REQUIRED", "turnId is required.");
      const delivery = this.store.getMessageDelivery(event.payload?.deliveryId);
      const authoritativeTurnIds = new Set([delivery?.providerTurnId, event.payload?.deliveryId].filter(Boolean));
      if (!delivery || !authoritativeTurnIds.has(turnId)) {
        throw completionError("USER_MESSAGE_TURN_MISMATCH", "The user message does not belong to the supplied current turn.", 403);
      }
      const message = String(event.payload?.message?.text ?? "");
      if (!containsCompletionIntent(message)) throw completionError("USER_MESSAGE_COMPLETION_INTENT_MISSING", "The direct user message does not explicitly request completion.", 403);
      if (!mentionsTarget(message, task)) throw completionError("USER_MESSAGE_TARGET_AMBIGUOUS", "The direct user message does not unambiguously identify this Task.", 403);
      const nonce = `session:${logicalSessionId}:${event.eventId}:${event.sequence}:${turnId}`;
      const result = this.store.completeTaskWithAuthorization(this.#operationInput({
        task, sourceType, idempotencyKey, requestId, nonce, logicalSessionId,
        userMessageEventId: event.eventId, userMessageSequence: event.sequence, turnId,
        callSurface: "provider_neutral_tool_host", details: { purpose: "task_completion" }
      }));
      this.onCompleted?.(result.task, result.operation);
      return result;
    } catch (error) {
      this.#auditRejection({ error, task, sourceType, idempotencyKey, requestId,
        logicalSessionId: input.logicalSessionId, userMessageEventId: input.userMessageEventId,
        userMessageSequence: input.userMessageSequence, turnId: input.turnId,
        callSurface: "provider_neutral_tool_host" });
      throw error;
    }
  }

  listAudit(taskId, limit) {
    this.#task(taskId);
    return this.store.listTaskCompletionOperations(taskId, limit);
  }

  getAuditOperation(operationId) {
    const operation = this.store.getTaskCompletionOperation(operationId);
    if (!operation) throw completionError("COMPLETION_OPERATION_NOT_FOUND", `Completion operation not found: ${operationId}`, 404);
    return operation;
  }

  rejectNonDirectAttempt(taskId, { callSurface, errorCode = "TASK_COMPLETION_INTENT_REQUIRED" } = {}) {
    const task = this.#task(taskId);
    this.store.recordRejectedTaskCompletionBypass(task, callSurface ?? "unknown_completion_surface", errorCode);
    throw completionError(errorCode, "A user-direct completion intent credential is required.", 403);
  }

  #task(id) {
    const task = this.store.getTask(id);
    if (!task) throw completionError("TASK_NOT_FOUND", `Task not found: ${id}`, 404);
    return task;
  }

  #replay(operation, taskId, requestId) {
    if (operation.taskId !== taskId || operation.requestId !== requestId) {
      throw completionError("COMPLETION_IDEMPOTENCY_CONFLICT", "Idempotency key is bound to another completion request.");
    }
    if (operation.result === "rejected") throw completionError(operation.errorCode ?? "COMPLETION_REJECTED", "The original completion attempt was rejected.", 403);
    return { operation, task: this.store.getTask(taskId), idempotentReplay: true };
  }

  #operationInput(input) {
    const { task, ...rest } = input;
    return {
      operationId: `completion_operation:${randomUUID()}`,
      createdAt: this.now().toISOString(),
      ...(task ? { taskId: task.id, objectiveId: task.objective_id } : {}),
      ...(input.nonce ? { auditNonce: sha256(input.nonce) } : {}),
      ...rest
    };
  }

  #auditRejection(input) {
    if (!input.task || !input.idempotencyKey || !input.requestId) return;
    try {
      this.store.recordRejectedTaskCompletion(this.#operationInput({
        taskId: input.task.id, objectiveId: input.task.objective_id,
        sourceType: input.sourceType, idempotencyKey: input.idempotencyKey,
        requestId: input.requestId, nonce: input.nonce ?? null,
        logicalSessionId: input.logicalSessionId ?? null,
        userMessageEventId: input.userMessageEventId ?? null,
        userMessageSequence: input.userMessageSequence ?? null, turnId: input.turnId ?? null,
        receiptId: input.receiptId ?? null, interactionId: input.interactionId ?? null,
        callSurface: input.callSurface, errorCode: input.error?.code ?? "COMPLETION_REJECTED",
        details: { category: rejectionCategory(input.error?.code) }
      }));
    } catch {
      // Preserve the original stable rejection. The Store transaction prevents partial completion.
    }
  }
}

function presentReceipt(intent) {
  return {
    receiptId: intent.receiptId,
    intentToken: `${intent.receiptId}.${intent.nonce}`,
    taskId: intent.taskId,
    objectiveId: intent.objectiveId,
    interactionId: intent.interactionId,
    uiSurface: intent.uiSurface,
    issuedAt: intent.issuedAt,
    expiresAt: intent.expiresAt,
    purpose: "task_completion"
  };
}

function isDirectUserEvent(event) {
  return event?.type === "SessionUserMessageCreated"
    && event.producer === "user"
    && event.surface === true
    && DIRECT_MESSAGE_SOURCES.has(String(event.source?.type ?? ""))
    && !event.source?.taskId
    && !event.source?.automationId
    && !event.source?.scheduledTaskId;
}

function directUserEventRejection(event) {
  if (isDirectUserEvent(event)) return null;
  const sourceType = String(event?.source?.type ?? "");
  if (event?.source?.taskId || sourceType === "collaboration") {
    return { code: "COLLABORATION_MESSAGE_NOT_AUTHORIZED", message: "Collaboration messages cannot authorize Task completion." };
  }
  if (event?.source?.automationId || event?.source?.scheduledTaskId
    || ["automation", "scheduled_session_task", "scheduled_task"].includes(sourceType)) {
    return { code: "AUTOMATION_MESSAGE_NOT_AUTHORIZED", message: "Automation and scheduled messages cannot authorize Task completion." };
  }
  if (event && (event.producer !== "user" || event.surface !== true)) {
    return { code: "NON_USER_MESSAGE_NOT_AUTHORIZED", message: "Assistant, system, Provider, and Tool events cannot authorize Task completion." };
  }
  return { code: "DIRECT_USER_MESSAGE_REQUIRED", message: "Completion evidence is not a direct user message." };
}

function sessionCanOperate(session, task) {
  if (!session || session.deletedAt) return false;
  if (session.sessionKind === "worker") return session.taskId === task.id && session.objectiveId === task.objective_id;
  return session.sessionKind === "objectiveChat" && session.objectiveId === task.objective_id;
}

function containsCompletionIntent(text) {
  if (/(?:不要|别|禁止|无需|不许|不能|不可|不应|暂不|先不).{0,40}(?:完成|done|complete)|(?:do\s+not|don't|must\s+not|should\s+not|not\s+yet).{0,40}(?:complete|done)/i.test(text)) {
    return false;
  }
  return /(?:标记|设为|改为|确认)(?:为|成)?\s*(?:已)?完成|(?:请|将|把|现在|立即).{0,200}(?:标记|设为|改为|确认)?\s*(?:已)?完成|(?:^|[。！？.!?\s])完成\s+(?:这个|该|此|work.?item|任务)|(?:mark|set|confirm|complete).{0,200}(?:complete|completed|done|work.?item)/i.test(text);
}

function mentionsTarget(text, task) {
  return text.includes(task.id) || (task.title.trim().length >= 4 && text.includes(task.title.trim()));
}

function rejectionCategory(code = "") {
  if (String(code).includes("COLLABORATION")) return "collaboration_message";
  if (String(code).includes("USER_MESSAGE") || String(code).includes("DIRECT_USER")) return "non_user_or_ambiguous_intent";
  if (String(code).includes("AUTOMATION") || String(code).includes("SCHEDULED")) return "system_or_automation";
  if (String(code).includes("NON_USER")) return "assistant_system_provider_or_tool";
  return "rejected_request";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw completionError(code, "A positive event sequence is required.");
  return number;
}

function required(value, code, message) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw completionError(code, message, 400);
  return normalized;
}

function optionalText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function completionError(code, message, statusCode = 409) {
  return new TaskCompletionError(code, message, statusCode);
}
