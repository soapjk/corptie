import { randomUUID } from "node:crypto";
import { parseJson } from "../storedJson.mjs";

export class TaskCompletionRepository {
  constructor({ getDatabase, selectOne, selectAll, runInTransaction, getTask, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectOne = selectOne;
    this.selectAll = selectAll;
    this.runInTransaction = runInTransaction;
    this.getTask = getTask;
    this.scheduleSave = scheduleSave;
  }

  get db() {
    return this.getDatabase();
  }

  createTaskCompletionIntent(input) {
    this.db.run(
      `INSERT INTO task_completion_intents (
        receipt_id, token_hash, task_id, work_id, source_type,
        logical_session_id, user_message_event_id, user_message_sequence, turn_id,
        interaction_id, ui_surface, request_id, nonce, issued_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.receiptId, input.tokenHash, input.taskId, input.workId, input.sourceType,
        input.logicalSessionId ?? null, input.userMessageEventId ?? null,
        input.userMessageSequence ?? null, input.turnId ?? null, input.interactionId ?? null,
        input.uiSurface ?? null, input.requestId, input.nonce, input.issuedAt, input.expiresAt,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    this.scheduleSave();
    return this.getTaskCompletionIntent(input.receiptId);
  }

  getTaskCompletionIntent(receiptId) {
    const row = this.selectOne(
      "SELECT * FROM task_completion_intents WHERE receipt_id = ?",
      [receiptId]
    );
    return row ? taskCompletionIntentFromRow(row) : null;
  }

  getTaskCompletionIntentByTokenHash(tokenHash) {
    const row = this.selectOne(
      "SELECT * FROM task_completion_intents WHERE token_hash = ?",
      [tokenHash]
    );
    return row ? taskCompletionIntentFromRow(row) : null;
  }

  getTaskCompletionIntentByRequest(sourceType, requestId) {
    const row = this.selectOne(
      `SELECT * FROM task_completion_intents
       WHERE source_type = ? AND request_id = ?`,
      [sourceType, requestId]
    );
    return row ? taskCompletionIntentFromRow(row) : null;
  }

  getTaskCompletionOperationByIdempotency(sourceType, idempotencyKey) {
    const row = this.selectOne(
      `SELECT * FROM task_completion_operations
       WHERE source_type = ? AND idempotency_key = ?`,
      [sourceType, idempotencyKey]
    );
    return row ? taskCompletionOperationFromRow(row) : null;
  }

  getTaskCompletionOperation(operationId) {
    const row = this.selectOne(
      "SELECT * FROM task_completion_operations WHERE operation_id = ?",
      [operationId]
    );
    return row ? taskCompletionOperationFromRow(row) : null;
  }

  listTaskCompletionOperations(taskId, limit = 100) {
    return this.selectAll(
      `SELECT * FROM task_completion_operations WHERE task_id = ?
       ORDER BY created_at DESC, operation_id DESC LIMIT ?`,
      [taskId, Math.max(1, Math.min(500, Number(limit) || 100))]
    ).map(taskCompletionOperationFromRow);
  }

  recordRejectedTaskCompletion(input) {
    return this.runInTransaction(() => {
      const existing = this.getTaskCompletionOperationByIdempotency(
        input.sourceType, input.idempotencyKey
      );
      if (existing) return existing;
      this.#insertTaskCompletionOperation({ ...input, result: "rejected" });
      this.scheduleSave();
      return this.getTaskCompletionOperation(input.operationId);
    });
  }

  recordRejectedTaskCompletionBypass(task, callSurface, errorCode = "TASK_COMPLETION_INTENT_REQUIRED") {
    if (!task) return null;
    const operationId = `completion_operation:${randomUUID()}`;
    return this.recordRejectedTaskCompletion({
      operationId,
      taskId: task.id,
      workId: task.work_id,
      result: "rejected",
      sourceType: "non_direct_request",
      callSurface,
      requestId: operationId,
      idempotencyKey: operationId,
      errorCode,
      details: { category: "non_direct_or_unattributed" },
      createdAt: new Date().toISOString()
    });
  }

  completeTaskWithAuthorization(input) {
    return this.runInTransaction(() => {
      const existing = this.getTaskCompletionOperationByIdempotency(
        input.sourceType, input.idempotencyKey
      );
      if (existing) {
        if (existing.taskId !== input.taskId || existing.requestId !== input.requestId) {
          const error = new Error("Completion idempotency key is bound to another request.");
          error.code = "COMPLETION_IDEMPOTENCY_CONFLICT";
          throw error;
        }
        return { operation: existing, task: this.getTask(existing.taskId), idempotentReplay: true };
      }
      const task = this.getTask(input.taskId);
      if (!task || task.work_id !== input.workId) {
        const error = new Error("Completion target no longer matches its Work.");
        error.code = "TASK_WORK_MISMATCH";
        throw error;
      }
      const completed = task.lifecycle_state === "done";
      if (completed) {
        const error = new Error("The Task was already completed by another operation.");
        error.code = "TASK_ALREADY_COMPLETED";
        throw error;
      }
      if (input.receiptId) {
        const intent = this.getTaskCompletionIntent(input.receiptId);
        if (!intent || intent.taskId !== input.taskId || intent.workId !== input.workId) {
          const error = new Error("Completion intent target mismatch.");
          error.code = "COMPLETION_INTENT_TARGET_MISMATCH";
          throw error;
        }
        this.db.run(
          `UPDATE task_completion_intents
           SET consumed_operation_id = ?, consumed_at = ?
           WHERE receipt_id = ? AND consumed_operation_id IS NULL`,
          [input.operationId, input.createdAt, input.receiptId]
        );
        if (this.db.getRowsModified() !== 1) {
          const error = new Error("Completion intent has already been consumed.");
          error.code = "COMPLETION_INTENT_REPLAYED";
          throw error;
        }
      }
      this.db.run(
        `INSERT INTO task_completion_authorizations
         (operation_id, task_id, work_id, source_type, nonce, validated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.operationId, input.taskId, input.workId, input.sourceType, input.nonce, input.createdAt]
      );
      this.db.run(
        `UPDATE tasks SET lifecycle_state='done', completion_operation_id=?, completion_source_type=?,
         resource_version=resource_version+1, updated_at=? WHERE id=?`,
        [input.operationId, input.sourceType, input.createdAt, input.taskId]
      );
      if (this.db.getRowsModified() !== 1) {
        const error = new Error("Task completion did not update exactly one row.");
        error.code = "TASK_COMPLETION_WRITE_FAILED";
        throw error;
      }
      this.#insertTaskCompletionOperation({ ...input, result: "succeeded" });
      this.scheduleSave();
      return {
        operation: this.getTaskCompletionOperation(input.operationId),
        task: this.getTask(input.taskId),
        idempotentReplay: false
      };
    });
  }

  #insertTaskCompletionOperation(input) {
    this.db.run(
      `INSERT INTO task_completion_operations (
        operation_id, task_id, work_id, result, source_type,
        logical_session_id, user_message_event_id, user_message_sequence, turn_id,
        ui_receipt_id, ui_interaction_id, call_surface, request_id, idempotency_key,
        nonce, error_code, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.operationId, input.taskId, input.workId, input.result, input.sourceType,
        input.logicalSessionId ?? null, input.userMessageEventId ?? null,
        input.userMessageSequence ?? null, input.turnId ?? null, input.receiptId ?? null,
        input.interactionId ?? null, input.callSurface, input.requestId, input.idempotencyKey,
        input.auditNonce ?? null, input.errorCode ?? null, JSON.stringify(input.details ?? {}), input.createdAt
      ]
    );
  }
}

function taskCompletionIntentFromRow(row) {
  return {
    receiptId: row.receipt_id,
    tokenHash: row.token_hash,
    taskId: row.task_id,
    workId: row.work_id,
    sourceType: row.source_type,
    logicalSessionId: row.logical_session_id ?? null,
    userMessageEventId: row.user_message_event_id ?? null,
    userMessageSequence: row.user_message_sequence == null ? null : Number(row.user_message_sequence),
    turnId: row.turn_id ?? null,
    interactionId: row.interaction_id ?? null,
    uiSurface: row.ui_surface ?? null,
    requestId: row.request_id,
    nonce: row.nonce,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedOperationId: row.consumed_operation_id ?? null,
    consumedAt: row.consumed_at ?? null,
    metadata: parseJson(row.metadata_json, {})
  };
}

function taskCompletionOperationFromRow(row) {
  return {
    operationId: row.operation_id,
    taskId: row.task_id,
    workId: row.work_id,
    result: row.result,
    sourceType: row.source_type,
    logicalSessionId: row.logical_session_id ?? null,
    userMessageEventId: row.user_message_event_id ?? null,
    userMessageSequence: row.user_message_sequence == null ? null : Number(row.user_message_sequence),
    turnId: row.turn_id ?? null,
    uiReceiptId: row.ui_receipt_id ?? null,
    uiInteractionId: row.ui_interaction_id ?? null,
    callSurface: row.call_surface,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    nonce: row.nonce ?? null,
    errorCode: row.error_code ?? null,
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at
  };
}
