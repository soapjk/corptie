import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { assertExplicitSessionKind } from "../../utils/sessionKinds.mjs";

// Shared connection and transaction ownership remain with Store.
export class SessionAssociationRepository {
  constructor({ getDatabase, selectOne, selectAll, getSession, getTask, getWork, getAgent, getProjectIntegrationRun, getWorkChatSession, runInTransaction, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectOne = selectOne;
    this.selectAll = selectAll;
    this.getSession = getSession;
    this.getTask = getTask;
    this.getWork = getWork;
    this.getAgent = getAgent;
    this.getProjectIntegrationRun = getProjectIntegrationRun;
    this.getWorkChatSession = getWorkChatSession;
    this.runInTransaction = runInTransaction;
    this.scheduleSave = scheduleSave;
  }

  get db() { return this.getDatabase(); }

  bindSessionToTask(sessionId, taskId, workId) {
    const session = this.getSession(sessionId);
    if (!session) {
      const error = new Error(`Session not found: ${sessionId}`);
      error.name = "SessionNotFoundError";
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    const task = taskId ? this.getTask(taskId) : null;
    if (taskId && !task) {
      const error = new Error(`Task not found: ${taskId}`);
      error.name = "TaskNotFoundError";
      error.code = "TASK_NOT_FOUND";
      throw error;
    }
    if (!taskId || !workId || task.work_id !== workId) {
      const error = new Error(`Worker Session ${sessionId} must use the Work owned by Task ${taskId ?? "<missing>"}.`);
      error.name = "SessionAssociationError";
      error.code = "SESSION_TASK_WORK_MISMATCH";
      throw error;
    }
    const timestamp = createdAtFromOrNow();
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `UPDATE sessions SET work_id = ?, task_id = ?, session_kind = 'worker', updated_at = ? WHERE id = ?`,
        [workId ?? null, taskId ?? null, timestamp, sessionId]
      );
      // 1:1 语义：task 记录当前活跃 session（换 Agent/重来时覆盖为新的）
      if (taskId) {
        this.db.run(
          `UPDATE tasks SET current_session_id = ?, updated_at = ? WHERE id = ?`,
          [sessionId, timestamp, taskId]
        );
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getSession(sessionId);
  }

  assertSessionAssociation({ sessionId, sessionKind, workId, taskId }) {
    if (sessionKind !== "worker") return;
    if (!workId || !taskId) {
      const error = new Error(`Worker Session ${sessionId ?? "<unknown>"} requires workId and taskId.`);
      error.name = "SessionAssociationError";
      error.code = "WORKER_SESSION_ASSOCIATION_REQUIRED";
      throw error;
    }
    const task = this.getTask(taskId);
    if (!task) {
      const error = new Error(`Task not found for Worker Session ${sessionId ?? "<unknown>"}: ${taskId}`);
      error.name = "SessionAssociationError";
      error.code = "SESSION_TASK_NOT_FOUND";
      throw error;
    }
    if (task.work_id !== workId || !this.getWork(workId)) {
      const error = new Error(`Worker Session ${sessionId ?? "<unknown>"} Work does not match Task ${taskId}.`);
      error.name = "SessionAssociationError";
      error.code = "SESSION_TASK_WORK_MISMATCH";
      throw error;
    }
  }

  sessionAssociationIssues() {
    return this.selectAll(`
      SELECT 'worker_work_missing' AS code, s.id AS session_id,
             s.work_id, s.task_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.deleted_at IS NULL AND s.session_kind='worker'
        AND (s.work_id IS NULL OR TRIM(s.work_id)='')
      UNION ALL
      SELECT 'worker_task_missing', s.id, s.work_id, s.task_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.deleted_at IS NULL AND s.session_kind='worker'
        AND (s.task_id IS NULL OR TRIM(s.task_id)='')
      UNION ALL
      SELECT 'session_work_not_found', s.id, s.work_id, s.task_id, s.session_kind, s.title
      FROM sessions s LEFT JOIN works o ON o.id=s.work_id
      WHERE s.deleted_at IS NULL AND s.work_id IS NOT NULL AND TRIM(s.work_id)<>'' AND o.id IS NULL
      UNION ALL
      SELECT 'session_task_not_found', s.id, s.work_id, s.task_id, s.session_kind, s.title
      FROM sessions s LEFT JOIN tasks wi ON wi.id=s.task_id
      WHERE s.deleted_at IS NULL AND s.task_id IS NOT NULL AND TRIM(s.task_id)<>'' AND wi.id IS NULL
      UNION ALL
      SELECT 'session_task_work_mismatch', s.id, s.work_id, s.task_id, s.session_kind, s.title
      FROM sessions s JOIN tasks wi ON wi.id=s.task_id
      WHERE s.deleted_at IS NULL AND s.work_id IS NOT wi.work_id
      UNION ALL
      SELECT 'bound_session_kind_not_worker', s.id, s.work_id, s.task_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.deleted_at IS NULL AND s.task_id IS NOT NULL
        AND TRIM(s.task_id)<>'' AND s.session_kind<>'worker'
      UNION ALL
      SELECT 'work_chat_work_missing', s.id, s.work_id, s.task_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.deleted_at IS NULL AND s.session_kind='workChat'
        AND (s.work_id IS NULL OR TRIM(s.work_id)='')
      UNION ALL
      SELECT 'work_chat_has_task', s.id, s.work_id, s.task_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.deleted_at IS NULL AND s.session_kind='workChat'
        AND s.task_id IS NOT NULL AND TRIM(s.task_id)<>''
      UNION ALL
      SELECT 'task_current_session_not_found', wi.current_session_id, wi.work_id, wi.id, NULL, wi.title
      FROM tasks wi LEFT JOIN sessions s ON s.id=wi.current_session_id AND s.deleted_at IS NULL
      WHERE wi.current_session_id IS NOT NULL AND TRIM(wi.current_session_id)<>'' AND s.id IS NULL
      UNION ALL
      SELECT 'task_current_session_binding_mismatch', wi.current_session_id, wi.work_id, wi.id, s.session_kind, wi.title
      FROM tasks wi JOIN sessions s ON s.id=wi.current_session_id
      WHERE s.deleted_at IS NOT NULL OR s.task_id IS NOT wi.id
        OR s.work_id IS NOT wi.work_id OR s.session_kind<>'worker'
      ORDER BY code, session_id
    `).map((row) => ({
      code: row.code,
      sessionId: row.session_id,
      workId: row.work_id ?? null,
      taskId: row.task_id ?? null,
      sessionKind: row.session_kind ?? null,
      title: row.title
    }));
  }

  listUnusableReplacedTaskSessionIds() {
    return this.selectAll(
      `SELECT DISTINCT s.id
       FROM sessions s
       JOIN tasks wi
         ON wi.id=s.task_id AND wi.current_session_id IS NOT s.id
       JOIN work_session_startup_operations replacement
         ON replacement.task_id=s.task_id
        AND replacement.source='self-repair'
        AND replacement.state='ready'
        AND replacement.replacing_session_id=s.id
        AND replacement.idempotency_key=('self-repair:' || s.task_id || ':' || s.id)
       WHERE s.session_kind='worker'
         AND s.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM session_turns turn WHERE turn.session_id=s.id
         )
       ORDER BY s.created_at ASC`
    ).map((row) => row.id);
  }

  finalizeConflictResolutionLaunch({ sessionId, taskId, workId, agentId, integrationRunId }) {
    if (!this.getSession(sessionId)) {
      const error = new Error(`Session not found: ${sessionId}`);
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    const task = this.getTask(taskId);
    if (!task) {
      const error = new Error(`Task not found: ${taskId}`);
      error.code = "TASK_NOT_FOUND";
      throw error;
    }
    if (!this.getWork(workId) || task.work_id !== workId) {
      const error = new Error(`Work does not match Task: ${workId}`);
      error.code = "WORK_MISMATCH";
      throw error;
    }
    if (!this.getAgent(agentId)) {
      const error = new Error(`Agent not found: ${agentId}`);
      error.code = "AGENT_NOT_FOUND";
      throw error;
    }
    if (!this.getProjectIntegrationRun(integrationRunId)) {
      const error = new Error(`Integration Run not found: ${integrationRunId}`);
      error.code = "INTEGRATION_NOT_FOUND";
      throw error;
    }
    const timestamp = createdAtFromOrNow();
    this.runInTransaction(() => {
      this.db.run(
        `UPDATE sessions SET work_id=?, task_id=?, session_kind='worker', agent_id=?, updated_at=? WHERE id=?`,
        [workId, taskId, agentId, timestamp, sessionId]
      );
      this.db.run(
        `UPDATE tasks SET current_session_id=?, lifecycle_state='in_progress', execution_status='running',
         main_agent_id=?, acceptance_assessment_json='{}', updated_at=? WHERE id=?`,
        [sessionId, agentId, timestamp, taskId]
      );
      this.db.run(
        `UPDATE project_integration_runs SET status='conflict_resolution_running',
         conflict_task_id=?, conflict_session_id=?, updated_at=? WHERE id=?`,
        [taskId, sessionId, timestamp, integrationRunId]
      );
      const finalized = this.selectOne(
        `SELECT wi.id
         FROM tasks wi
         JOIN sessions s ON s.id = wi.current_session_id
         JOIN project_integration_runs r ON r.id = ?
         WHERE wi.id = ? AND wi.work_id = ? AND wi.main_agent_id = ?
           AND s.id = ? AND s.task_id = wi.id AND s.work_id = wi.work_id
           AND s.agent_id = wi.main_agent_id
           AND r.conflict_task_id = wi.id AND r.conflict_session_id = s.id`,
        [integrationRunId, taskId, workId, agentId, sessionId]
      );
      if (!finalized) {
        const error = new Error("Conflict-resolution launch violated state invariants.");
        error.code = "STATE_INVARIANT_VIOLATION";
        throw error;
      }
    });
    this.scheduleSave();
    return {
      session: this.getSession(sessionId),
      task: this.getTask(taskId),
      integrationRun: this.getProjectIntegrationRun(integrationRunId)
    };
  }

  bindSessionToWork(sessionId, workId) {
    if (!this.getSession(sessionId)) {
      const error = new Error(`Session not found: ${sessionId}`);
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    if (!this.getWork(workId)) {
      const error = new Error(`Work not found: ${workId}`);
      error.code = "WORK_NOT_FOUND";
      throw error;
    }
    const existing = this.getWorkChatSession(workId);
    if (existing && existing.id !== sessionId) return existing;
    this.db.run(
      "UPDATE sessions SET work_id = ?, task_id = NULL, session_kind = 'workChat', updated_at = ? WHERE id = ?",
      [workId, createdAtFromOrNow(), sessionId]
    );
    this.scheduleSave();
    return this.getSession(sessionId);
  }

  setSessionKind(sessionId, sessionKind, agentId = null) {
    const normalized = assertExplicitSessionKind(sessionKind);
    this.db.run(
      "UPDATE sessions SET session_kind = ?, agent_id = COALESCE(?, agent_id), updated_at = ? WHERE id = ?",
      [normalized, agentId, createdAtFromOrNow(), sessionId]
    );
    this.scheduleSave();
    return this.getSession(sessionId);
  }
}
