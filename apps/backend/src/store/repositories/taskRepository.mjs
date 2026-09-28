import { createHash, randomUUID } from "node:crypto";
import { associationError, validateTaskInput } from "../../domain/workTaskValidation.mjs";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";
import { requiredText, optionalStoredText, storeDomainError } from "../validation.mjs";

// Uses the Store-owned connection and transaction coordinator; owns no connection lifecycle.
export class TaskRepository {
  constructor({ getDatabase, selectOne, selectAll, runInTransaction, scheduleSave, getWork, getWorkspace, getGitRepositoryForWorkspace, listSessionsByTask, hasPendingScheduledWakeForTask, recordRejectedTaskCompletionBypass, getSession, getSessionEvent, assertAssignableAgent }) {
    this.getDatabase = getDatabase;
    this.selectOne = selectOne;
    this.selectAll = selectAll;
    this.runInTransaction = runInTransaction;
    this.scheduleSave = scheduleSave;
    this.getWork = getWork;
    this.getWorkspace = getWorkspace;
    this.getGitRepositoryForWorkspace = getGitRepositoryForWorkspace;
    this.listSessionsByTask = listSessionsByTask;
    this.hasPendingScheduledWakeForTask = hasPendingScheduledWakeForTask;
    this.recordRejectedTaskCompletionBypass = recordRejectedTaskCompletionBypass;
    this.getSession = getSession;
    this.getSessionEvent = getSessionEvent;
    this.assertAssignableAgent = assertAssignableAgent;
  }

  get db() { return this.getDatabase(); }

  createTask(input = {}, creationOrigin = {}) {
    const normalized = validateTaskInput(input, "create");
    if (normalized.lifecycleState === "done") {
      const error = new Error("A completed Task cannot be created without direct-user-intent authorization.");
      error.code = "TASK_COMPLETION_INTENT_REQUIRED";
      error.statusCode = 403;
      throw error;
    }
    const work = this.getWork(normalized.workId);
    if (!work) {
      throw associationError(
        "WORK_NOT_FOUND", "workId", "existing Work ID", normalized.workId,
        `Work not found: ${normalized.workId}`
      );
    }
    this.assertTaskAssociations(normalized, work);
    const id = normalized.id ?? `task:${randomUUID()}`;
    const now = createdAtFromOrNow();
    const origin = normalizeTaskCreationOrigin(creationOrigin);
    this.runInTransaction(() => {
      this.db.run(
        `INSERT INTO tasks (id, work_id, title, description, acceptance_criteria,
          verification_criteria, priority, lifecycle_state, main_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          normalized.workId,
          normalized.title,
          normalized.description ?? "",
          normalized.acceptanceCriteria ?? "",
          normalized.verificationCriteria ?? "",
          normalized.priority ?? "medium",
          normalized.lifecycleState ?? "todo",
          normalized.mainAgentId ?? null,
          now,
          now,
        ]
      );
      this.db.run(
        `INSERT INTO task_creation_origins (
           task_id, origin_type, creator_session_id, creation_context_task_id,
           creation_context_message_id, operation_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, origin.originType, origin.creatorSessionId, origin.creationContextTaskId,
          origin.creationContextMessageId, origin.operationId, now]
      );
    });
    this.scheduleSave();
    return this.getTask(id);
  }

  getTaskCreationOrigin(taskId) {
    const row = this.selectOne(
      "SELECT * FROM task_creation_origins WHERE task_id=?",
      [taskId]
    );
    return row ? {
      taskId: row.task_id,
      originType: row.origin_type,
      creatorSessionId: row.creator_session_id ?? null,
      creationContextTaskId: row.creation_context_task_id ?? null,
      creationContextMessageId: row.creation_context_message_id ?? null,
      operationId: row.operation_id ?? null,
      createdAt: row.created_at
    } : null;
  }

  listTasks(options = {}) {
    const includeCompleted = options.includeCompleted !== false;
    return this.selectAll(
      `SELECT * FROM tasks
       WHERE COALESCE(deletion_status, '') <> 'deleted'
         ${includeCompleted ? "" : "AND lifecycle_state <> 'done'"}
       ORDER BY created_at ASC`
    );
  }

  listTasksByWork(workId) {
    return this.selectAll(
      `SELECT * FROM tasks
       WHERE work_id = ? AND COALESCE(deletion_status, '') <> 'deleted'
       ORDER BY created_at ASC`,
      [workId]
    );
  }

  listTaskPage(options = {}) {
    const workId = typeof options.workId === "string" && options.workId
      ? options.workId
      : null;
    const includeCompleted = options.includeCompleted !== false;
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const cursor = options.cursor ?? null;
    const hasCursor = Number.isInteger(cursor?.completionRank)
      && typeof cursor?.updatedAt === "string"
      && typeof cursor?.id === "string";
    const completionRankSQL = "CASE WHEN tasks.lifecycle_state = 'done' THEN 1 ELSE 0 END";
    const rows = this.selectAll(
      `SELECT tasks.*, ${completionRankSQL} AS completion_rank
       FROM tasks
       WHERE COALESCE(tasks.deletion_status, '') <> 'deleted'
         ${workId ? "AND tasks.work_id = ?" : ""}
         ${includeCompleted ? "" : "AND tasks.lifecycle_state <> 'done'"}
         ${hasCursor ? `AND (
           ${completionRankSQL} > ?
           OR (${completionRankSQL} = ? AND tasks.updated_at < ?)
           OR (${completionRankSQL} = ? AND tasks.updated_at = ? AND tasks.id < ?)
         )` : ""}
       ORDER BY completion_rank ASC, tasks.updated_at DESC, tasks.id DESC
       LIMIT ?`,
      [
        ...(workId ? [workId] : []),
        ...(hasCursor ? [
          cursor.completionRank,
          cursor.completionRank, cursor.updatedAt,
          cursor.completionRank, cursor.updatedAt, cursor.id
        ] : []),
        limit + 1
      ]
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(({ completion_rank: _completionRank, ...row }) => row);
    const tailRow = pageRows.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && tailRow ? {
        completionRank: Number(tailRow.completion_rank),
        updatedAt: tailRow.updated_at,
        id: tailRow.id
      } : null
    };
  }

  getTask(id) {
    return this.selectOne(
      `SELECT * FROM tasks WHERE id = ? AND COALESCE(deletion_status, '') <> 'deleted'`,
      [id]
    );
  }

  getTaskWorkspaceContext(taskOrId) {
    const task = typeof taskOrId === "string" ? this.getTask(taskOrId) : taskOrId;
    if (!task) return null;
    const work = this.getWork(task.work_id ?? task.workId);
    if (!work) return { task, work: null, workspace: null, repository: null };
    const workspace = this.getWorkspace(work.workspaceId);
    const repository = workspace ? this.getGitRepositoryForWorkspace(workspace.workspaceId) : null;
    return { task, work, workspace, repository };
  }

  getTaskBySessionId(sessionId) {
    return this.selectOne(
      `SELECT * FROM tasks
       WHERE current_session_id = ? AND COALESCE(deletion_status, '') <> 'deleted'`,
      [sessionId]
    );
  }

  setTaskArchived(id, archived) {
    const task = this.getTask(id);
    const reject = (code, message) => {
      const error = new Error(message);
      Object.assign(error, { code, statusCode: 409 });
      throw error;
    };
    if (!task) reject("TASK_NOT_FOUND", "Task not found.");
    if (typeof archived !== "boolean") reject("INVALID_ARCHIVED", "archived must be a boolean.");
    if (Boolean(task.archived) === archived) return task;
    if (task.deletion_status === "deleting") reject("TASK_DELETING", "Task deletion is in progress.");
    if (archived) {
      if (task.lifecycle_state === "done") reject("TASK_COMPLETED", "Completed Tasks are already archived.");
      if (["running", "blocked", "queued", "starting"].includes(task.execution_status)
        || this.listSessionsByTask(id).some((session) => ["running", "processing", "blocked", "queued", "starting"].includes(session.executionStatus ?? session.status))) {
        reject("TASK_ARCHIVE_BUSY", "请先停止 Task 执行，再归档。");
      }
      if (this.hasPendingScheduledWakeForTask(id)) {
        reject("TASK_ARCHIVE_PENDING_WAKE", "请先取消等待执行的计划任务，再归档。");
      }
    }
    this.db.run("UPDATE tasks SET archived=?, resource_version=resource_version+1, updated_at=? WHERE id=?",
      [archived ? 1 : 0, createdAtFromOrNow(), id]);
    this.scheduleSave();
    return this.getTask(id);
  }

  updateTask(id, patch = {}) {
    const current = this.getTask(id);
    if (!current) return null;
    if (patch.lifecycleState === "done" && current.lifecycle_state !== "done") {
      this.recordRejectedTaskCompletionBypass(current, "store.updateTask");
      const error = new Error("TASK_COMPLETION_INTENT_REQUIRED");
      error.code = "TASK_COMPLETION_INTENT_REQUIRED";
      throw error;
    }
    const internalPatch = {};
    if (Object.prototype.hasOwnProperty.call(patch, "executionStatus")) {
      internalPatch.executionStatus = patch.executionStatus;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "acceptanceAssessment")) {
      internalPatch.acceptanceAssessment = patch.acceptanceAssessment;
    }
    const publicPatch = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !["executionStatus", "acceptanceAssessment"].includes(key))
    );
    const normalized = validateTaskInput(publicPatch, "update");
    const prospective = {
      title: current.title,
      description: current.description,
      acceptanceCriteria: current.acceptance_criteria,
      verificationCriteria: current.verification_criteria,
      priority: current.priority,
      lifecycleState: current.lifecycle_state,
      mainAgentId: current.main_agent_id,
      ...normalized
    };
    if (prospective.lifecycleState === "done" && current.lifecycle_state !== "done") {
      const error = new Error("Task completion requires a consumed direct-user-intent credential.");
      error.code = "TASK_COMPLETION_INTENT_REQUIRED";
      error.statusCode = 403;
      throw error;
    }
    const work = this.getWork(current.work_id);
    if (!work) {
      throw associationError(
        "WORK_NOT_FOUND", "workId", "existing Work ID", current.work_id,
        `Work not found: ${current.work_id}`
      );
    }
    this.assertTaskAssociations(prospective, work);
    const has = (key) => Object.prototype.hasOwnProperty.call(normalized, key);
    this.db.run(
      `UPDATE tasks SET title=?, description=?, acceptance_criteria=?, verification_criteria=?,
        priority=?, lifecycle_state=?, main_agent_id=?,
        execution_status=?, acceptance_assessment_json=?, resource_version=resource_version+1,
        updated_at=? WHERE id=?`,
      [
        has("title") ? normalized.title : current.title,
        has("description") ? normalized.description : current.description,
        has("acceptanceCriteria") ? normalized.acceptanceCriteria : current.acceptance_criteria,
        has("verificationCriteria") ? normalized.verificationCriteria : current.verification_criteria,
        has("priority") ? normalized.priority : current.priority,
        has("lifecycleState") ? normalized.lifecycleState : current.lifecycle_state,
        has("mainAgentId") ? normalized.mainAgentId : current.main_agent_id,
        Object.prototype.hasOwnProperty.call(internalPatch, "executionStatus")
          ? internalPatch.executionStatus
          : (current.execution_status ?? "idle"),
        Object.prototype.hasOwnProperty.call(internalPatch, "acceptanceAssessment")
          ? JSON.stringify(internalPatch.acceptanceAssessment ?? {})
          : (current.acceptance_assessment_json ?? "{}"),
        createdAtFromOrNow(),
        id,
      ]
    );
    this.scheduleSave();
    return this.getTask(id);
  }

  getTaskSnapshot(snapshotId) {
    const row = this.selectOne("SELECT * FROM task_snapshots WHERE id=?", [snapshotId]);
    return row ? taskSnapshotFromRow(row) : null;
  }

  listTaskSnapshots(taskId) {
    return this.selectAll(
      "SELECT * FROM task_snapshots WHERE task_id=? ORDER BY version DESC",
      [taskId]
    ).map(taskSnapshotFromRow);
  }

  reviseTask(id, input = {}) {
    const current = this.getTask(id);
    if (!current) return null;
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(current.revision ?? 1)) {
      const error = new Error("Task revision has changed; reload before evolving it.");
      error.code = "TASK_REVISION_CONFLICT";
      error.statusCode = 409;
      throw error;
    }
    const sessionId = requiredText(input.createdBySessionId, "createdBySessionId");
    const session = this.getSession(sessionId);
    if (!session || session.taskId !== id) {
      const error = new Error("Only the Task's bound Session may evolve it.");
      error.code = "TASK_SESSION_REQUIRED";
      error.statusCode = 403;
      throw error;
    }
    let sourceMessageId = null;
    if (input.sourceMessageId != null) {
      const suppliedId = requiredText(input.sourceMessageId, "sourceMessageId");
      const event = this.getSessionEvent(suppliedId) ?? this.getSessionEvent(`user-message:${suppliedId}`);
      const source = event?.source;
      if (!event || event.sessionId !== sessionId || event.type !== "SessionUserMessageCreated"
        || event.producer !== "user" || event.surface !== true
        || !["desktop", "macos", "feishu"].includes(source?.type)
        || source.taskId || source.automationId || source.scheduledTaskId) {
        const error = new Error("Task revision source must be a direct user message in the bound Session.");
        error.code = "TASK_REVISION_SOURCE_INVALID";
        error.statusCode = 403;
        throw error;
      }
      sourceMessageId = event.eventId;
    }
    const definitionFields = {
      title: "title", description: "description",
      acceptanceCriteria: "acceptance_criteria", verificationCriteria: "verification_criteria"
    };
    const next = input.next;
    if (!next || typeof next !== "object" || Array.isArray(next)
      || Object.keys(next).some((key) => !Object.hasOwn(definitionFields, key))) {
      const error = new Error("Task revisions may only change title, description, acceptanceCriteria and verificationCriteria.");
      error.code = "TASK_REVISION_INVALID_FIELDS";
      error.statusCode = 400;
      throw error;
    }
    const patch = validateTaskInput(next, "update");
    if (!Object.entries(patch).some(([key, value]) =>
      Object.hasOwn(definitionFields, key) && value !== (current[definitionFields[key]] ?? ""))) {
      const error = new Error("A Task revision must change its current problem definition.");
      error.code = "TASK_REVISION_EMPTY";
      error.statusCode = 400;
      throw error;
    }
    const snapshot = {
      id: input.snapshotId ?? `task_snapshot:${randomUUID()}`,
      taskId: id,
      version: Number(current.revision ?? 1),
      title: current.title,
      description: current.description ?? "",
      acceptanceCriteria: current.acceptance_criteria ?? "",
      verificationCriteria: current.verification_criteria ?? "",
      acceptanceAssessment: parseJson(current.acceptance_assessment_json, {}),
      completionEvidence: Array.isArray(input.completionEvidence) ? input.completionEvidence : [],
      executionSummary: String(input.executionSummary ?? ""),
      sourceMessageId,
      createdBySessionId: sessionId,
      createdAt: createdAtFromOrNow()
    };
    snapshot.contentHash = createHash("sha256").update(JSON.stringify({
      title: snapshot.title,
      description: snapshot.description,
      acceptanceCriteria: snapshot.acceptanceCriteria,
      verificationCriteria: snapshot.verificationCriteria,
      acceptanceAssessment: snapshot.acceptanceAssessment,
      completionEvidence: snapshot.completionEvidence,
      executionSummary: snapshot.executionSummary,
      sourceMessageId: snapshot.sourceMessageId
    })).digest("hex");

    return this.runInTransaction(() => {
      this.db.run(
        `INSERT INTO task_snapshots (
          id, task_id, version, title, description, acceptance_criteria,
          verification_criteria, acceptance_assessment_json, completion_evidence_json,
          execution_summary, source_message_id, created_by_session_id, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [snapshot.id, id, snapshot.version, snapshot.title, snapshot.description,
          snapshot.acceptanceCriteria, snapshot.verificationCriteria,
          JSON.stringify(snapshot.acceptanceAssessment), JSON.stringify(snapshot.completionEvidence),
          snapshot.executionSummary, snapshot.sourceMessageId, snapshot.createdBySessionId,
          snapshot.contentHash, snapshot.createdAt]
      );
      this.updateTask(id, { ...patch, lifecycleState: patch.lifecycleState ?? "in_progress" });
      this.db.run(
        `UPDATE tasks SET current_snapshot_id=?, revision=revision+1,
          acceptance_assessment_json='{}', updated_at=?
         WHERE id=? AND revision=?`,
        [snapshot.id, snapshot.createdAt, id, expectedRevision]
      );
      if (this.db.getRowsModified() !== 1) {
        const error = new Error("Task revision changed during snapshot creation.");
        error.code = "TASK_REVISION_CONFLICT";
        throw error;
      }
      this.scheduleSave();
      return { task: this.getTask(id), snapshot: this.getTaskSnapshot(snapshot.id) };
    });
  }

  assertTaskAssociations(input, work) {
    if (input.mainAgentId) {
      this.assertAssignableAgent(input.mainAgentId, "mainAgentId");
      if (!(work.contributorAgentIds ?? []).includes(input.mainAgentId)) {
        throw associationError(
          "ASSOCIATION_OUT_OF_SCOPE", "mainAgentId", "Agent in owning Work.contributorAgentIds",
          input.mainAgentId,
          "Task mainAgentId is outside its Work contributor scope."
        );
      }
    }
  }

  addTaskDependency(taskId, targetTaskId, type = "depends_on") {
    this.db.run(
      `INSERT OR REPLACE INTO task_dependencies (task_id, target_task_id, type) VALUES (?, ?, ?)`,
      [taskId, targetTaskId, type]
    );
    this.scheduleSave();
  }

  removeTaskDependency(taskId, targetTaskId) {
    this.db.run(
      `DELETE FROM task_dependencies WHERE task_id = ? AND target_task_id = ?`,
      [taskId, targetTaskId]
    );
    this.scheduleSave();
  }

  listTaskDependencies(taskId) {
    return this.selectAll(
      `SELECT * FROM task_dependencies WHERE task_id = ?`,
      [taskId]
    );
  }

  listTaskDependents(targetTaskId) {
    return this.selectAll(
      `SELECT * FROM task_dependencies WHERE target_task_id = ?`,
      [targetTaskId]
    );
  }
}

function normalizeTaskCreationOrigin(input = {}) {
  const originType = optionalStoredText(input.originType) ?? "system";
  if (!["direct_user", "session", "system", "legacy_unattributed"].includes(originType)) {
    throw storeDomainError("INVALID_TASK_CREATION_ORIGIN", `Unsupported Task creation origin: ${originType}.`);
  }
  const creatorSessionId = optionalStoredText(input.creatorSessionId);
  if (originType === "session" && !creatorSessionId) {
    throw storeDomainError("TASK_CREATOR_SESSION_REQUIRED", "Session-created Tasks require creatorSessionId.");
  }
  if (originType !== "session" && creatorSessionId) {
    throw storeDomainError("TASK_CREATOR_SESSION_FORBIDDEN", `${originType} Tasks cannot name a creator Session.`);
  }
  return {
    originType,
    creatorSessionId,
    creationContextTaskId: optionalStoredText(input.creationContextTaskId),
    creationContextMessageId: optionalStoredText(input.creationContextMessageId),
    operationId: optionalStoredText(input.operationId)
  };
}

function taskSnapshotFromRow(row) {
  const storedAssessment = parseJson(row.acceptance_assessment_json, null);
  const acceptanceAssessment = storedAssessment
    && typeof storedAssessment.status === "string"
    && Array.isArray(storedAssessment.results)
    ? storedAssessment
    : null;
  return {
    id: row.id,
    taskId: row.task_id,
    version: Number(row.version),
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    verificationCriteria: row.verification_criteria,
    acceptanceAssessment,
    completionEvidence: parseJson(row.completion_evidence_json, []),
    executionSummary: row.execution_summary,
    sourceMessageId: row.source_message_id ?? null,
    createdBySessionId: row.created_by_session_id,
    contentHash: row.content_hash,
    createdAt: row.created_at
  };
}
