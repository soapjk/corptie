import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";

// Historical AgentTask method names remain compatible; execution is Session-scoped.
export class AgentWorkQueueRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
  }

  get db() {
    return this.getDatabase();
  }

  enqueueAgentTask(item) {
    return this.enqueueAgentTaskWithResult(item).task;
  }

  enqueueAgentTaskWithResult(item) {
    const timestamp = createdAtFromOrNow(item.createdAt);
    this.db.run(
      `INSERT OR IGNORE INTO agent_operations (
        task_id, agent_id, session_id, kind, priority, text, source_json,
        local_visibility, status, delivery_id, channel_delivery_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      [
        item.taskId,
        item.agentId,
        item.sessionId,
        item.kind,
        Number(item.priority),
        item.text,
        JSON.stringify(item.source ?? {}),
        item.localVisibility ?? "normal",
        item.deliveryId ?? null,
        item.channelDeliveryId ?? null,
        timestamp,
        timestamp
      ]
    );
    const inserted = this.db.getRowsModified() > 0;
    if (inserted) this.scheduleSave();
    const task = inserted
      ? this.getAgentTask(item.taskId)
      : (item.deliveryId || item.channelDeliveryId
          ? this.getAgentTaskForDelivery(item.deliveryId ?? item.channelDeliveryId)
          : this.getAgentTask(item.taskId));
    return { task, inserted };
  }

  getAgentTask(taskId) {
    const row = this.selectOne("SELECT * FROM agent_operations WHERE task_id = ?", [taskId]);
    return row ? agentTaskFromRow(row) : null;
  }

  getAgentTaskForDelivery(deliveryId) {
    const row = this.selectOne(
      "SELECT * FROM agent_operations WHERE delivery_id = ? OR channel_delivery_id = ?",
      [deliveryId, deliveryId]
    );
    return row ? agentTaskFromRow(row) : null;
  }

  getAgentTaskForTurn(sessionId, turnId) {
    if (!turnId) return null;
    const row = this.selectOne(
      "SELECT * FROM agent_operations WHERE session_id = ? AND target_turn_id = ? ORDER BY created_at DESC LIMIT 1",
      [sessionId, turnId]
    );
    return row ? agentTaskFromRow(row) : null;
  }

  claimRunningAgentTaskForProviderTurn(sessionId, turnId) {
    if (!turnId) return null;
    const existing = this.getAgentTaskForTurn(sessionId, turnId);
    if (existing) return existing;
    const candidates = this.selectAll(
      `SELECT task_id FROM agent_operations
       WHERE session_id = ? AND status = 'running' AND target_turn_id IS NULL
       ORDER BY started_at ASC, created_at ASC LIMIT 2`,
      [sessionId]
    );
    // A Provider event must never guess between multiple possible commands.
    if (candidates.length !== 1) return null;
    this.db.run(
      `UPDATE agent_operations SET target_turn_id = ?, updated_at = ?
       WHERE task_id = ? AND status = 'running' AND target_turn_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_operations
           WHERE session_id = ? AND target_turn_id = ?
         )`,
      [turnId, createdAtFromOrNow(), candidates[0].task_id, sessionId, turnId]
    );
    if (this.db.getRowsModified() === 0) return this.getAgentTaskForTurn(sessionId, turnId);
    this.scheduleSave();
    return this.getAgentTask(candidates[0].task_id);
  }

  getRunningAgentTaskForSession(sessionId) {
    const row = this.selectOne(
      "SELECT * FROM agent_operations WHERE session_id = ? AND status = 'running' ORDER BY started_at ASC LIMIT 1",
      [sessionId]
    );
    return row ? agentTaskFromRow(row) : null;
  }

  getRunningAgentTask(agentId) {
    const row = this.selectOne(
      "SELECT * FROM agent_operations WHERE agent_id = ? AND status = 'running' ORDER BY started_at ASC LIMIT 1",
      [agentId]
    );
    return row ? agentTaskFromRow(row) : null;
  }

  listAgentTasksForSession(sessionId, options = {}) {
    const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
      ? options.statuses
      : ["queued", "running", "completed", "failed", "cancelled"];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.selectAll(
      `SELECT * FROM agent_operations WHERE session_id = ? AND status IN (${placeholders})
       ORDER BY created_at ASC`,
      [sessionId, ...statuses]
    ).map(agentTaskFromRow);
  }

  listQueuedAgentTasks(agentId, limit = 100) {
    return this.selectAll(
      `SELECT * FROM agent_operations WHERE agent_id = ? AND status = 'queued'
       ORDER BY priority DESC, created_at ASC, task_id ASC LIMIT ?`,
      [agentId, Math.max(1, Math.min(1000, Number(limit) || 100))]
    ).map(agentTaskFromRow);
  }

  listQueuedAgentTasksForSession(sessionId, limit = 100) {
    return this.selectAll(
      `SELECT * FROM agent_operations WHERE session_id = ? AND status = 'queued'
       ORDER BY priority DESC, created_at ASC, task_id ASC LIMIT ?`,
      [sessionId, Math.max(1, Math.min(1000, Number(limit) || 100))]
    ).map(agentTaskFromRow);
  }

  listAgentIdsWithQueuedWork() {
    return this.selectAll(
      "SELECT DISTINCT agent_id FROM agent_operations WHERE status = 'queued' ORDER BY agent_id ASC"
    ).map((row) => row.agent_id);
  }

  listAgentIdsWithUnsettledWork() {
    return this.selectAll(
      "SELECT DISTINCT agent_id FROM agent_operations WHERE status IN ('queued', 'running') ORDER BY agent_id ASC"
    ).map((row) => row.agent_id);
  }

  listSessionIdsWithUnsettledAgentWork() {
    return this.selectAll(
      "SELECT DISTINCT session_id FROM agent_operations WHERE status IN ('queued', 'running') ORDER BY session_id ASC"
    ).map((row) => row.session_id);
  }

  claimAgentTask(taskId) {
    const item = this.getAgentTask(taskId);
    if (!item) return null;
    // Older Corptie processes sharing a development database can recreate the
    // retired Agent-wide uniqueness index after this process has migrated it.
    // Remove that compatibility artifact at the claim boundary as well, so it
    // cannot silently restore cross-Session serialization.
    if (this.selectOne(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_operations_one_running'"
    )) {
      this.db.run("DROP INDEX idx_agent_operations_one_running");
    }
    const timestamp = new Date().toISOString();
    this.db.run(
      `UPDATE agent_operations SET status = 'running', started_at = ?, updated_at = ?, last_error = NULL
       WHERE task_id = ? AND status = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM agent_operations running
           WHERE running.session_id = ? AND running.status = 'running'
         )
         AND NOT EXISTS (
           SELECT 1 FROM logical_sessions logical
           WHERE logical.legacy_session_id = ? AND logical.transition_state IS NOT NULL
         )`,
      [timestamp, timestamp, taskId, item.sessionId, item.sessionId]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getAgentTask(taskId);
  }

  updateAgentTask(taskId, patch = {}) {
    const item = this.getAgentTask(taskId);
    if (!item) return null;
    const status = patch.status ?? item.status;
    const timestamp = new Date().toISOString();
    const completedAt = Object.hasOwn(patch, "completedAt")
      ? patch.completedAt
      : (["completed", "failed", "cancelled"].includes(status) ? timestamp : item.completedAt);
    this.db.run(
      `UPDATE agent_operations SET status = ?, session_id = ?, target_turn_id = ?, last_error = ?,
       started_at = ?, completed_at = ?, source_json = ?, updated_at = ? WHERE task_id = ?`,
      [
        status,
        Object.hasOwn(patch, "sessionId") ? patch.sessionId : item.sessionId,
        Object.hasOwn(patch, "targetTurnId") ? patch.targetTurnId : item.targetTurnId,
        Object.hasOwn(patch, "lastError") ? patch.lastError : item.lastError,
        Object.hasOwn(patch, "startedAt") ? patch.startedAt : item.startedAt,
        completedAt,
        JSON.stringify(Object.hasOwn(patch, "source") ? (patch.source ?? {}) : item.source),
        timestamp,
        taskId
      ]
    );
    this.scheduleSave();
    return this.getAgentTask(taskId);
  }
}

function agentTaskFromRow(row) {
  return {
    taskId: row.task_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    kind: row.kind,
    priority: Number(row.priority),
    text: row.text,
    source: parseJson(row.source_json, {}),
    localVisibility: row.local_visibility,
    status: row.status,
    deliveryId: row.channel_delivery_id || row.delivery_id || null,
    targetTurnId: row.target_turn_id || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at
  };
}
