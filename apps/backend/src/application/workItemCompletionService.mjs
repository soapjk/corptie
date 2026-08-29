import { createHash, randomBytes, randomUUID } from "node:crypto";

const COMPLETED = new Set(["done", "complete", "completed"]);
const UI_SURFACES = new Set(["work_item_completion_confirmation", "work_item_edit_status_confirmation"]);
const DIRECT_MESSAGE_SOURCES = new Set(["desktop", "macos"]);

export class WorkItemCompletionError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "WorkItemCompletionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class WorkItemCompletionService {
  constructor({ store, onCompleted = null, now = () => new Date(), uiTtlMs = 5 * 60_000, sessionTtlMs = 30 * 60_000 } = {}) {
    if (!store) throw new TypeError("WorkItemCompletionService requires a Store.");
    this.store = store;
    this.onCompleted = onCompleted;
    this.now = now;
    this.uiTtlMs = uiTtlMs;
    this.sessionTtlMs = sessionTtlMs;
  }

  issueMacOSIntent(workItemId, input = {}, actor = {}) {
    const requestId = required(input.requestId, "COMPLETION_REQUEST_ID_REQUIRED", "requestId is required.");
    const existing = this.store.getWorkItemCompletionIntentByRequest("direct_macos_ui_action", requestId);
    if (existing) {
      if (existing.workItemId !== workItemId) throw completionError("COMPLETION_INTENT_REQUEST_CONFLICT", "The intent request is bound to another WorkItem.");
      return presentReceipt(existing);
    }
    if (actor.type !== "user" || actor.id !== "user:local-macos") {
      throw completionError("DIRECT_USER_INTENT_REQUIRED", "Only the authenticated local macOS user may issue this intent.", 403);
    }
    const workItem = this.#workItem(workItemId);
    const interactionId = required(input.interactionId, "UI_INTERACTION_ID_REQUIRED", "interactionId is required.");
    const uiSurface = required(input.uiSurface, "UI_SURFACE_REQUIRED", "uiSurface is required.");
    if (!UI_SURFACES.has(uiSurface)) throw completionError("UI_SURFACE_NOT_AUTHORIZED", "This UI surface cannot issue completion intent.", 403);
    if (input.displayedWorkItemId !== workItem.id || input.displayedWorkItemTitle !== workItem.title) {
      throw completionError("UI_TARGET_SNAPSHOT_MISMATCH", "The displayed WorkItem snapshot is stale or mismatched.");
    }
    const issuedAt = this.now();
    const receiptId = `completion_intent:${randomUUID()}`;
    const nonce = randomBytes(32).toString("base64url");
    const token = `${receiptId}.${nonce}`;
    const intent = this.store.createWorkItemCompletionIntent({
      receiptId,
      tokenHash: sha256(token),
      workItemId: workItem.id,
      objectiveId: workItem.objective_id,
      sourceType: "direct_macos_ui_action",
      interactionId,
      uiSurface,
      requestId,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.uiTtlMs).toISOString(),
      metadata: {
        displayedWorkItemId: workItem.id,
        displayedWorkItemTitle: workItem.title,
        displayedAcceptanceStatus: input.displayedAcceptanceStatus ?? null,
        purpose: "work_item_completion"
      }
    });
    return presentReceipt(intent);
  }

  completeFromMacOS(workItemId, input = {}) {
    const sourceType = "direct_macos_ui_action";
    const workItem = this.#workItem(workItemId);
    const fallbackAttemptId = `invalid-completion-attempt:${randomUUID()}`;
    let idempotencyKey = optionalText(input.idempotencyKey) ?? fallbackAttemptId;
    let requestId = optionalText(input.requestId) ?? fallbackAttemptId;
    let intent;
    try {
      idempotencyKey = required(input.idempotencyKey, "COMPLETION_IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.");
      requestId = required(input.requestId, "COMPLETION_REQUEST_ID_REQUIRED", "requestId is required.");
      const token = required(input.intentToken, "COMPLETION_INTENT_REQUIRED", "A completion intent token is required.");
      const existing = this.store.getWorkItemCompletionOperationByIdempotency(sourceType, idempotencyKey);
      if (existing) return this.#replay(existing, workItemId, requestId);
      intent = this.store.getWorkItemCompletionIntentByTokenHash(sha256(token));
      if (!intent) throw completionError("COMPLETION_INTENT_INVALID", "Completion intent token is invalid.", 403);
      if (token !== `${intent.receiptId}.${intent.nonce}`) throw completionError("COMPLETION_INTENT_INVALID", "Completion intent token is invalid.", 403);
      if (intent.sourceType !== sourceType || intent.workItemId !== workItem.id || intent.objectiveId !== workItem.objective_id) {
        throw completionError("COMPLETION_INTENT_TARGET_MISMATCH", "Completion intent does not match this WorkItem.", 403);
      }
      if (intent.requestId !== requestId) throw completionError("COMPLETION_INTENT_REQUEST_MISMATCH", "Completion request does not match its intent.", 403);
      if (intent.consumedOperationId) throw completionError("COMPLETION_INTENT_REPLAYED", "Completion intent was already consumed.", 409);
      if (Date.parse(intent.expiresAt) <= this.now().getTime()) throw completionError("COMPLETION_INTENT_EXPIRED", "Completion intent has expired.", 410);
      const result = this.store.completeWorkItemWithAuthorization(this.#operationInput({
        workItem, sourceType, idempotencyKey, requestId, nonce: intent.nonce,
        receiptId: intent.receiptId, interactionId: intent.interactionId,
        callSurface: intent.uiSurface, details: { purpose: "work_item_completion" }
      }));
      this.onCompleted?.(result.workItem, result.operation);
      return result;
    } catch (error) {
      this.#auditRejection({ error, workItem, sourceType, idempotencyKey, requestId,
        nonce: intent?.nonce, receiptId: intent?.receiptId, interactionId: intent?.interactionId,
        callSurface: intent?.uiSurface ?? "macos_completion_http" });
      throw error;
    }
  }

  completeFromSession(input = {}, metadata = {}) {
    const sourceType = "direct_session_user_instruction";
    const workItemId = required(input.targetWorkItemId, "WORK_ITEM_ID_REQUIRED", "targetWorkItemId is required.");
    const workItem = this.#workItem(workItemId);
    const fallbackAttemptId = `invalid-completion-attempt:${randomUUID()}`;
    let idempotencyKey = optionalText(input.idempotencyKey) ?? fallbackAttemptId;
    let requestId = optionalText(input.requestId) ?? fallbackAttemptId;
    try {
      const objectiveId = required(input.objectiveId, "OBJECTIVE_ID_REQUIRED", "objectiveId is required.");
      idempotencyKey = required(input.idempotencyKey, "COMPLETION_IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.");
      requestId = required(input.requestId, "COMPLETION_REQUEST_ID_REQUIRED", "requestId is required.");
      const existing = this.store.getWorkItemCompletionOperationByIdempotency(sourceType, idempotencyKey);
      if (existing) return this.#replay(existing, workItemId, requestId);
      if (workItem.objective_id !== objectiveId) throw completionError("WORK_ITEM_OBJECTIVE_MISMATCH", "WorkItem does not belong to the supplied Objective.", 403);
      const logicalSessionId = required(input.logicalSessionId, "LOGICAL_SESSION_ID_REQUIRED", "logicalSessionId is required.");
      if (!metadata.logicalSessionId || metadata.logicalSessionId !== logicalSessionId) {
        throw completionError("LOGICAL_SESSION_MISMATCH", "The authenticated logical Session does not match the completion evidence.", 403);
      }
      const logical = this.store.getLogicalSession(logicalSessionId);
      if (!logical || logical.legacySessionId !== metadata.sessionId) {
        throw completionError("LOGICAL_SESSION_MISMATCH", "A Provider Session ID cannot substitute for the logical Session ID.", 403);
      }
      const session = this.store.getSession(logical.legacySessionId);
      if (!sessionCanOperate(session, workItem)) throw completionError("WORK_ITEM_SESSION_UNAUTHORIZED", "The logical Session cannot complete this WorkItem.", 403);
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
      if (!mentionsTarget(message, workItem)) throw completionError("USER_MESSAGE_TARGET_AMBIGUOUS", "The direct user message does not unambiguously identify this WorkItem.", 403);
      const nonce = `session:${logicalSessionId}:${event.eventId}:${event.sequence}:${turnId}`;
      const result = this.store.completeWorkItemWithAuthorization(this.#operationInput({
        workItem, sourceType, idempotencyKey, requestId, nonce, logicalSessionId,
        userMessageEventId: event.eventId, userMessageSequence: event.sequence, turnId,
        callSurface: "provider_neutral_tool_host", details: { purpose: "work_item_completion" }
      }));
      this.onCompleted?.(result.workItem, result.operation);
      return result;
    } catch (error) {
      this.#auditRejection({ error, workItem, sourceType, idempotencyKey, requestId,
        logicalSessionId: input.logicalSessionId, userMessageEventId: input.userMessageEventId,
        userMessageSequence: input.userMessageSequence, turnId: input.turnId,
        callSurface: "provider_neutral_tool_host" });
      throw error;
    }
  }

  listAudit(workItemId, limit) {
    this.#workItem(workItemId);
    return this.store.listWorkItemCompletionOperations(workItemId, limit);
  }

  getAuditOperation(operationId) {
    const operation = this.store.getWorkItemCompletionOperation(operationId);
    if (!operation) throw completionError("COMPLETION_OPERATION_NOT_FOUND", `Completion operation not found: ${operationId}`, 404);
    return operation;
  }

  rejectNonDirectAttempt(workItemId, { callSurface, errorCode = "WORK_ITEM_COMPLETION_INTENT_REQUIRED" } = {}) {
    const workItem = this.#workItem(workItemId);
    this.store.recordRejectedWorkItemCompletionBypass(workItem, callSurface ?? "unknown_completion_surface", errorCode);
    throw completionError(errorCode, "A user-direct completion intent credential is required.", 403);
  }

  #workItem(id) {
    const workItem = this.store.getWorkItem(id);
    if (!workItem) throw completionError("WORK_ITEM_NOT_FOUND", `WorkItem not found: ${id}`, 404);
    return workItem;
  }

  #replay(operation, workItemId, requestId) {
    if (operation.workItemId !== workItemId || operation.requestId !== requestId) {
      throw completionError("COMPLETION_IDEMPOTENCY_CONFLICT", "Idempotency key is bound to another completion request.");
    }
    if (operation.result === "rejected") throw completionError(operation.errorCode ?? "COMPLETION_REJECTED", "The original completion attempt was rejected.", 403);
    return { operation, workItem: this.store.getWorkItem(workItemId), idempotentReplay: true };
  }

  #operationInput(input) {
    const { workItem, ...rest } = input;
    return {
      operationId: `completion_operation:${randomUUID()}`,
      createdAt: this.now().toISOString(),
      ...(workItem ? { workItemId: workItem.id, objectiveId: workItem.objective_id } : {}),
      ...(input.nonce ? { auditNonce: sha256(input.nonce) } : {}),
      ...rest
    };
  }

  #auditRejection(input) {
    if (!input.workItem || !input.idempotencyKey || !input.requestId) return;
    try {
      this.store.recordRejectedWorkItemCompletion(this.#operationInput({
        workItemId: input.workItem.id, objectiveId: input.workItem.objective_id,
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
    workItemId: intent.workItemId,
    objectiveId: intent.objectiveId,
    interactionId: intent.interactionId,
    uiSurface: intent.uiSurface,
    issuedAt: intent.issuedAt,
    expiresAt: intent.expiresAt,
    purpose: "work_item_completion"
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
    return { code: "COLLABORATION_MESSAGE_NOT_AUTHORIZED", message: "Collaboration messages cannot authorize WorkItem completion." };
  }
  if (event?.source?.automationId || event?.source?.scheduledTaskId
    || ["automation", "scheduled_session_task", "scheduled_task"].includes(sourceType)) {
    return { code: "AUTOMATION_MESSAGE_NOT_AUTHORIZED", message: "Automation and scheduled messages cannot authorize WorkItem completion." };
  }
  if (event && (event.producer !== "user" || event.surface !== true)) {
    return { code: "NON_USER_MESSAGE_NOT_AUTHORIZED", message: "Assistant, system, Provider, and Tool events cannot authorize WorkItem completion." };
  }
  return { code: "DIRECT_USER_MESSAGE_REQUIRED", message: "Completion evidence is not a direct user message." };
}

function sessionCanOperate(session, workItem) {
  if (!session || session.deletedAt) return false;
  if (session.sessionKind === "worker") return session.workItemId === workItem.id && session.objectiveId === workItem.objective_id;
  return session.sessionKind === "objectiveChat" && session.objectiveId === workItem.objective_id;
}

function containsCompletionIntent(text) {
  if (/(?:不要|别|禁止|无需|不许|不能|不可|不应|暂不|先不).{0,40}(?:完成|done|complete)|(?:do\s+not|don't|must\s+not|should\s+not|not\s+yet).{0,40}(?:complete|done)/i.test(text)) {
    return false;
  }
  return /(?:标记|设为|改为|确认)(?:为|成)?\s*(?:已)?完成|(?:请|将|把|现在|立即).{0,200}(?:标记|设为|改为|确认)?\s*(?:已)?完成|(?:^|[。！？.!?\s])完成\s+(?:这个|该|此|work.?item|任务)|(?:mark|set|confirm|complete).{0,200}(?:complete|completed|done|work.?item)/i.test(text);
}

function mentionsTarget(text, workItem) {
  return text.includes(workItem.id) || (workItem.title.trim().length >= 4 && text.includes(workItem.title.trim()));
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
  return new WorkItemCompletionError(code, message, statusCode);
}

export function presentWorkItemCompletionSource(workItem, latestOperation = null) {
  if (!COMPLETED.has(String(workItem?.status ?? "").toLowerCase())) return null;
  if (!workItem.completion_operation_id) return { sourceType: "legacy/unattributed", operationId: null, completedAt: null };
  return {
    sourceType: workItem.completion_source_type,
    operationId: workItem.completion_operation_id,
    completedAt: latestOperation?.createdAt ?? workItem.updated_at ?? null
  };
}
