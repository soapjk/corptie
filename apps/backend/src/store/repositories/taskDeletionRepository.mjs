import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";

export class TaskDeletionRepository {
  constructor({ getDatabase, selectOne, selectAll, scheduleSave, runInTransaction, getTask }) {
    this.getDatabase = getDatabase;
    this.selectOne = selectOne;
    this.selectAll = selectAll;
    this.scheduleSave = scheduleSave;
    this.runInTransaction = runInTransaction;
    this.getTask = getTask;
  }

  get db() {
    return this.getDatabase();
  }

  deleteTask(id) {
    this.db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
    this.scheduleSave();
  }

  markTaskDeletion(id, status, error = null) {
    this.db.run(
      `UPDATE tasks SET deletion_status=?, deletion_error=?, updated_at=? WHERE id=?`,
      [status, error, createdAtFromOrNow(), id]
    );
    this.scheduleSave();
  }

  beginTaskDeletionOperation(id, input = {}, idempotencyKey) {
    const key = String(idempotencyKey ?? "").trim();
    if (!key) throw new TypeError("Task deletion idempotencyKey is required.");
    let operation;
    this.runInTransaction(() => {
      const existing = this.selectOne(
        "SELECT * FROM task_deletion_operations WHERE task_id=? AND idempotency_key=?",
        [id, key]
      );
      if (existing) {
        operation = existing;
        return;
      }
      const task = this.selectOne("SELECT * FROM tasks WHERE id=?", [id]);
      if (!task || task.deletion_status === "deleted") {
        const error = new Error(`Task not found: ${id}`);
        error.code = "TASK_NOT_FOUND";
        error.statusCode = 404;
        throw error;
      }
      const activeDeletion = this.selectOne(
        `SELECT * FROM task_deletion_operations
         WHERE task_id=? AND state IN ('queued','running') LIMIT 1`,
        [id]
      );
      if (activeDeletion) {
        operation = activeDeletion;
        return;
      }
      const activeStart = this.selectOne(
        `SELECT startup_operation_id FROM work_session_startup_operations
         WHERE task_id=? AND state IN ('allocated','worktree_prepared','session_bound','provider_bound','compensating') LIMIT 1`,
        [id]
      );
      if (activeStart) {
        const error = new Error("Task is starting. Wait for startup to finish before deletion.");
        error.code = "TASK_DELETE_BLOCKED";
        error.statusCode = 409;
        throw error;
      }
      const timestamp = createdAtFromOrNow();
      const operationId = `task-deletion:${randomUUID()}`;
      this.db.run(
        `UPDATE tasks SET deletion_status='deleting', deletion_error=NULL,
         resource_version=resource_version+1, updated_at=?
         WHERE id=? AND COALESCE(deletion_status, '') IN ('','delete_failed')`,
        [timestamp, id]
      );
      if (Number(this.selectOne("SELECT changes() AS count")?.count) !== 1) {
        const error = new Error("Task deletion state changed before the operation could be claimed.");
        error.code = "TASK_DELETE_STATE_CONFLICT";
        error.statusCode = 409;
        throw error;
      }
      this.db.run(
        `INSERT INTO task_deletion_operations (
          operation_id, task_id, idempotency_key, state, stage, input_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', 'freezing', ?, ?, ?)`,
        [operationId, id, key, JSON.stringify(input), timestamp, timestamp]
      );
      operation = this.selectOne(
        "SELECT * FROM task_deletion_operations WHERE operation_id=?", [operationId]
      );
    });
    this.scheduleSave();
    return taskDeletionOperationFromRow(operation);
  }

  getTaskDeletionOperation(operationId) {
    return taskDeletionOperationFromRow(this.selectOne(
      "SELECT * FROM task_deletion_operations WHERE operation_id=?", [operationId]
    ));
  }

  getTaskDeletionOperationByKey(taskId, idempotencyKey) {
    return taskDeletionOperationFromRow(this.selectOne(
      "SELECT * FROM task_deletion_operations WHERE task_id=? AND idempotency_key=?",
      [taskId, idempotencyKey]
    ));
  }

  listRecoverableTaskDeletionOperations() {
    return this.selectAll(
      "SELECT * FROM task_deletion_operations WHERE state IN ('queued','running') ORDER BY created_at"
    ).map(taskDeletionOperationFromRow);
  }

  updateTaskDeletionOperation(operationId, patch = {}) {
    const current = this.getTaskDeletionOperation(operationId);
    if (!current) return null;
    const timestamp = createdAtFromOrNow();
    this.db.run(
      `UPDATE task_deletion_operations SET state=?, stage=?, result_json=?, error_code=?,
       error_message=?, retryable=?, attempt=?, started_at=?, completed_at=?, updated_at=?
       WHERE operation_id=?`,
      [patch.state ?? current.state, patch.stage ?? current.stage,
        JSON.stringify(patch.result !== undefined ? patch.result : current.result),
        patch.errorCode !== undefined ? patch.errorCode : current.errorCode,
        patch.errorMessage !== undefined ? patch.errorMessage : current.errorMessage,
        (patch.retryable !== undefined ? patch.retryable : current.retryable) ? 1 : 0,
        patch.attempt ?? current.attempt,
        patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
        patch.completedAt !== undefined ? patch.completedAt : current.completedAt,
        timestamp, operationId]
    );
    this.scheduleSave();
    return this.getTaskDeletionOperation(operationId);
  }

  markTaskWorktreeRemoved(id) {
    const timestamp = createdAtFromOrNow();
    this.db.run(
      `UPDATE tasks SET deletion_status='deleting', deletion_error=NULL,
       deletion_worktree_removed_at=COALESCE(deletion_worktree_removed_at, ?), updated_at=? WHERE id=?`,
      [timestamp, timestamp, id]
    );
    this.scheduleSave();
  }

  listTaskDeletionBlockingAssociations(id) {
    return {
      // Artifact content and its audit history are retained user data. The
      // RESTRICT foreign key deliberately prevents Task deletion until the
      // user explicitly re-scopes the Artifact instead of silently losing it.
      artifacts: this.selectAll(
        `SELECT artifact_id, title, visibility, status
         FROM artifacts WHERE bound_task_id=? ORDER BY created_at, artifact_id`,
        [id]
      ).map((row) => ({
        artifactId: row.artifact_id,
        title: row.title,
        visibility: row.visibility,
        status: row.status
      }))
    };
  }

  finalizeTaskDeletion(id) {
    const item = this.getTask(id);
    if (!item) return { alreadyDeleted: true };
    const sessions = this.selectAll(
      "SELECT id FROM sessions WHERE task_id=? AND deleted_at IS NULL",
      [id]
    );
    if (sessions.length > 0) {
      const error = new Error(`Delete the ${sessions.length} associated Session(s) before deleting Task ${id}.`);
      error.code = "TASK_SESSIONS_REMAIN";
      throw error;
    }
    const collaborationRequests = this.selectAll(
      "SELECT task_id FROM collaboration_requests WHERE source_task_id=? OR target_task_id=?",
      [id, id]
    );
    this.runInTransaction(() => {
      // Collaboration records and integration history are shared audit data.
      // Preserve them while removing their live ownership references.
      this.db.run(
        `UPDATE collaboration_messages SET source_task_id=NULL WHERE source_task_id=?`, [id]
      );
      this.db.run(`UPDATE collaboration_messages SET target_task_id=NULL WHERE target_task_id=?`, [id]);
      this.db.run(`UPDATE collaboration_requests SET source_task_id=NULL WHERE source_task_id=?`, [id]);
      this.db.run(`UPDATE collaboration_requests SET target_task_id=NULL WHERE target_task_id=?`, [id]);
      this.db.run(`UPDATE project_integration_runs SET conflict_task_id=NULL WHERE conflict_task_id=?`, [id]);
      // Completion, cancellation, startup, and repair records are immutable
      // audit evidence with RESTRICT references to the Task identity. A
      // user-visible deletion therefore retires the live resource while
      // preserving the minimum parent identity required by those receipts.
      this.db.run(
        `UPDATE tasks SET deletion_status='deleted', deletion_error=NULL,
           current_session_id=NULL, main_agent_id=NULL,
           resource_version=resource_version+1, updated_at=? WHERE id=?`,
        [createdAtFromOrNow(), id]
      );
    });
    this.scheduleSave();
    return {
      preservedCollaborationRequestIds: collaborationRequests.map((row) => row.task_id)
    };
  }
}

function taskDeletionOperationFromRow(row) {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    stage: row.stage,
    input: parseJson(row.input_json, {}),
    result: parseJson(row.result_json, null),
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    retryable: Boolean(row.retryable),
    attempt: Number(row.attempt),
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    updatedAt: row.updated_at
  };
}
