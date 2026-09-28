import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";

// Repositories share the Store connection and transaction/notification owner.
export class AutomationRepository {
  constructor({ getDatabase, selectAll, selectOne, runInTransaction, scheduleSave, environmentName }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.runInTransaction = runInTransaction;
    this.scheduleSave = scheduleSave;
    this.environmentName = environmentName;
  }

  get db() {
    return this.getDatabase();
  }

  createScheduledSessionTask(input) {
    const timestamp = createdAtFromOrNow(input.createdAt);
    this.db.run(
      `INSERT INTO scheduled_session_tasks (
        task_id, logical_session_id, message_json, schedule_type, run_at, next_run_at,
        interval_seconds, timezone, status, missed_policy, condition_spec_json,
        condition_state_json, process_spec_json, process_state_json,
        creator_type, creator_id, work_id, environment,
        max_retries, name, trigger_spec_json, condition_specs_json, actions_json,
        policy_spec_json, risk_json, max_concurrent_runs, timeout_seconds, backpressure_limit, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.logicalSessionId,
        JSON.stringify(input.message),
        input.scheduleType,
        input.runAt ?? null,
        input.nextRunAt ?? null,
        input.intervalSeconds ?? null,
        input.timezone,
        input.missedPolicy,
        input.conditionSpec ? JSON.stringify(input.conditionSpec) : null,
        input.conditionState ? JSON.stringify(input.conditionState) : null,
        input.processSpec ? JSON.stringify(input.processSpec) : null,
        input.processState ? JSON.stringify(input.processState) : null,
        input.creatorType,
        input.creatorId,
        input.workId ?? null,
        input.environment,
        input.maxRetries ?? 5,
        input.name ?? null,
        input.triggerSpec ? JSON.stringify(input.triggerSpec) : null,
        JSON.stringify(input.conditionSpecs ?? []),
        JSON.stringify(input.actions ?? []),
        JSON.stringify(input.policySpec ?? {}),
        JSON.stringify(input.risk ?? {}),
        input.maxConcurrentRuns ?? 1,
        input.timeoutSeconds ?? 3600,
        input.backpressureLimit ?? 100,
        input.expiresAt,
        timestamp,
        timestamp
      ]
    );
    this.scheduleSave();
    return this.getScheduledSessionTask(input.taskId);
  }

  getScheduledSessionTask(taskId) {
    const row = this.selectOne("SELECT * FROM scheduled_session_tasks WHERE task_id = ?", [taskId]);
    return row ? scheduledSessionTaskFromRow(row) : null;
  }

  listScheduledSessionTasks(options = {}) {
    const clauses = ["environment = ?"];
    const params = [options.environment];
    if (options.logicalSessionId) {
      clauses.push("logical_session_id = ?");
      params.push(options.logicalSessionId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    return this.selectAll(
      `SELECT * FROM scheduled_session_tasks WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, task_id ASC`,
      params
    ).map(scheduledSessionTaskFromRow);
  }

  listTaskIdsWithPendingScheduledWake(options = {}) {
    const environment = options.environment ?? this.environmentName;
    const timestamp = options.now ?? createdAtFromOrNow();
    const taskId = typeof options.taskId === "string" && options.taskId ? options.taskId : null;
    return this.selectAll(
      `SELECT DISTINCT session.task_id
       FROM scheduled_session_tasks scheduled
       JOIN logical_sessions logical
         ON logical.logical_session_id = scheduled.logical_session_id
       JOIN sessions session ON session.id = logical.legacy_session_id
       JOIN tasks task ON task.id = session.task_id
       WHERE scheduled.environment = ?
         AND scheduled.status = 'active'
         AND scheduled.next_run_at IS NOT NULL
         AND scheduled.expires_at > ?
         AND logical.deleted_at IS NULL
         AND logical.archived = 0
         AND session.deleted_at IS NULL
         AND session.archived = 0
         AND task.lifecycle_state <> 'done'
         AND COALESCE(task.deletion_status, '') <> 'deleted'
         ${taskId ? "AND task.id = ?" : ""}
       ORDER BY session.task_id`,
      [environment, timestamp, ...(taskId ? [taskId] : [])]
    ).map((row) => row.task_id);
  }

  hasPendingScheduledWakeForTask(taskId, options = {}) {
    return this.listTaskIdsWithPendingScheduledWake({ ...options, taskId }).length > 0;
  }

  listSessionIdsWithPendingScheduledWake(options = {}) {
    return this.selectAll(
      `SELECT DISTINCT session.id
       FROM scheduled_session_tasks scheduled
       JOIN logical_sessions logical ON logical.logical_session_id = scheduled.logical_session_id
       JOIN sessions session ON session.id = logical.legacy_session_id
       WHERE scheduled.environment = ? AND scheduled.status = 'active'
         AND scheduled.next_run_at IS NOT NULL AND scheduled.expires_at > ?
         AND logical.deleted_at IS NULL AND logical.archived = 0
         AND session.deleted_at IS NULL AND session.archived = 0
         ${options.sessionId ? "AND session.id = ?" : ""}`,
      [options.environment ?? this.environmentName, options.now ?? createdAtFromOrNow(),
        ...(options.sessionId ? [options.sessionId] : [])]
    ).map((row) => row.id);
  }

  updateScheduledSessionTask(taskId, patch = {}, expectedVersion = null) {
    const task = this.getScheduledSessionTask(taskId);
    if (!task) return null;
    if (expectedVersion != null && Number(expectedVersion) !== task.resourceVersion) {
      const error = new Error(`计划任务 ${taskId} was modified by another request.`);
      error.code = "RESOURCE_VERSION_CONFLICT";
      throw error;
    }
    const value = (key, fallback) => Object.hasOwn(patch, key) ? patch[key] : fallback;
    const timestamp = new Date().toISOString();
    this.db.run(
      `UPDATE scheduled_session_tasks SET
         name = ?, message_json = ?, trigger_spec_json = ?, condition_specs_json = ?, actions_json = ?,
         policy_spec_json = ?, risk_json = ?, run_at = ?, next_run_at = ?, interval_seconds = ?, timezone = ?,
         status = ?, missed_policy = ?, condition_spec_json = ?, condition_state_json = ?,
         process_spec_json = ?, process_state_json = ?,
         pending_scheduled_for = ?, lease_owner = ?, lease_expires_at = ?, retry_count = ?,
         max_retries = ?, last_run_id = ?, last_run_status = ?, last_error_code = ?,
         last_error_message = ?, last_run_at = ?, resource_version = resource_version + 1,
         max_concurrent_runs = ?, timeout_seconds = ?, backpressure_limit = ?, expires_at = ?,
         paused_at = ?, cancelled_at = ?, completed_at = ?, updated_at = ?
       WHERE task_id = ?`,
      [
        value("name", task.name),
        JSON.stringify(value("message", task.message)),
        value("triggerSpec", task.triggerSpec) ? JSON.stringify(value("triggerSpec", task.triggerSpec)) : null,
        JSON.stringify(value("conditionSpecs", task.conditionSpecs) ?? []),
        JSON.stringify(value("actions", task.actions) ?? []),
        JSON.stringify(value("policySpec", task.policySpec) ?? {}),
        JSON.stringify(value("risk", task.risk) ?? {}),
        value("runAt", task.runAt),
        value("nextRunAt", task.nextRunAt),
        value("intervalSeconds", task.intervalSeconds),
        value("timezone", task.timezone),
        value("status", task.status),
        value("missedPolicy", task.missedPolicy),
        value("conditionSpec", task.conditionSpec) ? JSON.stringify(value("conditionSpec", task.conditionSpec)) : null,
        value("conditionState", task.conditionState) ? JSON.stringify(value("conditionState", task.conditionState)) : null,
        value("processSpec", task.processSpec) ? JSON.stringify(value("processSpec", task.processSpec)) : null,
        value("processState", task.processState) ? JSON.stringify(value("processState", task.processState)) : null,
        value("pendingScheduledFor", task.pendingScheduledFor),
        value("leaseOwner", task.leaseOwner),
        value("leaseExpiresAt", task.leaseExpiresAt),
        value("retryCount", task.retryCount),
        value("maxRetries", task.maxRetries),
        value("lastRunId", task.lastRunId),
        value("lastRunStatus", task.lastRunStatus),
        value("lastErrorCode", task.lastErrorCode),
        value("lastErrorMessage", task.lastErrorMessage),
        value("lastRunAt", task.lastRunAt),
        value("maxConcurrentRuns", task.maxConcurrentRuns),
        value("timeoutSeconds", task.timeoutSeconds),
        value("backpressureLimit", task.backpressureLimit),
        value("expiresAt", task.expiresAt),
        value("pausedAt", task.pausedAt),
        value("cancelledAt", task.cancelledAt),
        value("completedAt", task.completedAt),
        timestamp,
        taskId
      ]
    );
    this.scheduleSave();
    return this.getScheduledSessionTask(taskId);
  }

  claimDueScheduledSessionTasks(input = {}) {
    const now = input.now;
    const leaseUntil = input.leaseUntil;
    const owner = input.leaseOwner;
    const environment = input.environment;
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 25));
    return this.runInTransaction(() => {
      const rows = this.selectAll(
        `SELECT task_id FROM scheduled_session_tasks
         WHERE environment = ? AND status = 'active' AND expires_at > ? AND next_run_at IS NOT NULL
           AND next_run_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY next_run_at ASC, task_id ASC LIMIT ?`,
        [environment, now, now, now, limit]
      );
      const claimed = [];
      for (const row of rows) {
        this.db.run(
          `UPDATE scheduled_session_tasks SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE task_id = ? AND status = 'active'
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
          [owner, leaseUntil, now, row.task_id, now]
        );
        if (this.db.getRowsModified() > 0) claimed.push(this.getScheduledSessionTask(row.task_id));
      }
      return claimed;
    });
  }

  listExpiredActiveScheduledSessionTasks(environment, now) {
    return this.selectAll(
      `SELECT * FROM scheduled_session_tasks
       WHERE environment = ? AND status IN ('active', 'error') AND expires_at <= ?
       ORDER BY expires_at ASC, task_id ASC`,
      [environment, now]
    ).map(scheduledSessionTaskFromRow);
  }

  createScheduledSessionRun(input) {
    const timestamp = input.createdAt ?? new Date().toISOString();
    this.db.run(
      `INSERT OR IGNORE INTO scheduled_session_runs (
         run_id, task_id, run_key, scheduled_for, trigger_kind, trigger_reason,
         status, attempt_count, exit_status_json, condition_result_json,
         stages_json, action_results_json, deadline_at, claimed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        input.taskId,
        input.runKey,
        input.scheduledFor,
        input.triggerKind,
        input.triggerReason,
        input.status ?? "claimed",
        input.attemptCount ?? 1,
        input.exitStatus ? JSON.stringify(input.exitStatus) : null,
        input.conditionResult ? JSON.stringify(input.conditionResult) : null,
        JSON.stringify(input.stages ?? []),
        JSON.stringify(input.actionResults ?? []),
        input.deadlineAt ?? null,
        input.claimedAt ?? timestamp,
        timestamp,
        timestamp
      ]
    );
    if (this.db.getRowsModified() > 0) this.scheduleSave();
    return this.getScheduledSessionRunByKey(input.runKey);
  }

  getScheduledSessionRun(runId) {
    const row = this.selectOne("SELECT * FROM scheduled_session_runs WHERE run_id = ?", [runId]);
    return row ? scheduledSessionRunFromRow(row) : null;
  }

  getScheduledSessionRunByKey(runKey) {
    const row = this.selectOne("SELECT * FROM scheduled_session_runs WHERE run_key = ?", [runKey]);
    return row ? scheduledSessionRunFromRow(row) : null;
  }

  getScheduledSessionRunForAgentTask(taskId) {
    const row = this.selectOne(
      "SELECT * FROM scheduled_session_runs WHERE agent_task_id = ? ORDER BY created_at DESC LIMIT 1",
      [taskId]
    );
    return row ? scheduledSessionRunFromRow(row) : null;
  }

  listScheduledSessionRuns(taskId, limit = 100) {
    return this.selectAll(
      "SELECT * FROM scheduled_session_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
      [taskId, Math.max(1, Math.min(1000, Number(limit) || 100))]
    ).map(scheduledSessionRunFromRow);
  }

  listScheduledSessionRunsForTasks(taskIds, limitPerTask = 100) {
    const ids = [...new Set(taskIds)].filter((taskId) => typeof taskId === "string" && taskId.length > 0);
    if (ids.length === 0) return new Map();
    const limit = Math.max(1, Math.min(1000, Number(limitPerTask) || 100));
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.selectAll(
      `SELECT * FROM (
         SELECT scheduled_session_runs.*,
           ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY created_at DESC) AS history_rank
         FROM scheduled_session_runs
         WHERE task_id IN (${placeholders})
       ) WHERE history_rank <= ?
       ORDER BY task_id ASC, created_at DESC`,
      [...ids, limit]
    );
    const runsByTaskId = new Map(ids.map((taskId) => [taskId, []]));
    for (const row of rows) {
      runsByTaskId.get(row.task_id)?.push(scheduledSessionRunFromRow(row));
    }
    return runsByTaskId;
  }

  countActiveScheduledSessionRuns(taskId) {
    return Number(this.selectOne(
      `SELECT COUNT(*) AS count FROM scheduled_session_runs
       WHERE task_id = ? AND status IN ('claimed', 'running')`,
      [taskId]
    )?.count ?? 0);
  }

  countPendingScheduledSessionRunsForLogicalSession(logicalSessionId) {
    return Number(this.selectOne(
      `SELECT COUNT(*) AS count FROM scheduled_session_runs r
       JOIN scheduled_session_tasks t ON t.task_id = r.task_id
       WHERE t.logical_session_id = ? AND r.status IN ('claimed', 'queued', 'running', 'retry_wait')`,
      [logicalSessionId]
    )?.count ?? 0);
  }

  listExpiredScheduledSessionRuns(now, environment) {
    return this.selectAll(
      `SELECT r.* FROM scheduled_session_runs r
       JOIN scheduled_session_tasks t ON t.task_id = r.task_id
       WHERE t.environment = ? AND r.status IN ('claimed', 'queued', 'running')
         AND r.deadline_at IS NOT NULL AND r.deadline_at <= ?`,
      [environment, now]
    ).map(scheduledSessionRunFromRow);
  }

  updateScheduledSessionRun(runId, patch = {}) {
    const run = this.getScheduledSessionRun(runId);
    if (!run) return null;
    const value = (key, fallback) => Object.hasOwn(patch, key) ? patch[key] : fallback;
    const timestamp = new Date().toISOString();
    this.db.run(
      `UPDATE scheduled_session_runs SET status = ?, attempt_count = ?, agent_task_id = ?,
         target_turn_id = ?, binding_id = ?, provider_session_id = ?, routing_version = ?,
         exit_status_json = ?, condition_result_json = ?, stages_json = ?, action_results_json = ?, deadline_at = ?,
         error_code = ?, error_message = ?, claimed_at = ?, queued_at = ?,
         started_at = ?, completed_at = ?, updated_at = ? WHERE run_id = ?`,
      [
        value("status", run.status),
        value("attemptCount", run.attemptCount),
        value("agentTaskId", run.agentTaskId),
        value("targetTurnId", run.targetTurnId),
        value("bindingId", run.bindingId),
        value("providerSessionId", run.providerSessionId),
        value("routingVersion", run.routingVersion),
        value("exitStatus", run.exitStatus) ? JSON.stringify(value("exitStatus", run.exitStatus)) : null,
        value("conditionResult", run.conditionResult) ? JSON.stringify(value("conditionResult", run.conditionResult)) : null,
        JSON.stringify(value("stages", run.stages) ?? []),
        JSON.stringify(value("actionResults", run.actionResults) ?? []),
        value("deadlineAt", run.deadlineAt),
        value("errorCode", run.errorCode),
        value("errorMessage", run.errorMessage),
        value("claimedAt", run.claimedAt),
        value("queuedAt", run.queuedAt),
        value("startedAt", run.startedAt),
        value("completedAt", run.completedAt),
        timestamp,
        runId
      ]
    );
    this.scheduleSave();
    return this.getScheduledSessionRun(runId);
  }

  recordScheduledSessionEvent(input) {
    const sequence = Number(this.selectOne(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM scheduled_session_events WHERE task_id = ?",
      [input.taskId]
    )?.sequence ?? 1);
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.run(
      `INSERT INTO scheduled_session_events (
        event_id, task_id, run_id, sequence, type, actor_type, actor_id,
        payload_json, environment, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.eventId ?? randomUUID(), input.taskId, input.runId ?? null, sequence, input.type,
        input.actorType ?? null, input.actorId ?? null, JSON.stringify(input.payload ?? {}),
        input.environment, createdAt
      ]
    );
    this.scheduleSave();
    return { ...input, sequence, createdAt };
  }

  listScheduledSessionEvents(taskId, limit = 200) {
    return this.selectAll(
      `SELECT * FROM scheduled_session_events WHERE task_id = ?
       ORDER BY sequence DESC LIMIT ?`,
      [taskId, Math.max(1, Math.min(1000, Number(limit) || 200))]
    ).map(scheduledSessionEventFromRow).reverse();
  }
}

function scheduledSessionTaskFromRow(row) {
  const message = parseJson(row.message_json, {});
  const fallbackTrigger = row.schedule_type === "once"
    ? { type: "at", at: row.run_at }
    : row.schedule_type === "interval"
      ? { type: "interval", startAt: row.run_at, intervalSeconds: Number(row.interval_seconds) }
      : row.schedule_type === "condition"
        ? { type: "condition", condition: parseJson(row.condition_spec_json, null) }
        : { type: "processExit", process: parseJson(row.process_spec_json, null) };
  const trigger = parseJson(row.trigger_spec_json, fallbackTrigger);
  const actions = parseJson(row.actions_json, [{ type: "queueSessionMessage", message }]);
  const policy = parseJson(row.policy_spec_json, {
    misfire: row.missed_policy === "skip" ? "skip" : "fireOnce",
    maxCatchUpRuns: 10,
    maxConcurrentRuns: Number(row.max_concurrent_runs ?? 1),
    timeoutSeconds: Number(row.timeout_seconds ?? 3600),
    backpressureLimit: Number(row.backpressure_limit ?? 100)
  });
  return {
    taskId: row.task_id,
    automationId: row.task_id,
    name: row.name || message.text || row.task_id,
    logicalSessionId: row.logical_session_id,
    message,
    scheduleType: row.schedule_type,
    trigger,
    triggerSpec: trigger,
    conditions: parseJson(row.condition_specs_json, []),
    conditionSpecs: parseJson(row.condition_specs_json, []),
    actions,
    policy,
    policySpec: policy,
    risk: parseJson(row.risk_json, { level: "minimal", remoteWrite: false, destructive: false }),
    runAt: row.run_at,
    nextRunAt: row.next_run_at,
    expiresAt: row.expires_at,
    intervalSeconds: row.interval_seconds == null ? null : Number(row.interval_seconds),
    timezone: row.timezone,
    status: row.status,
    missedPolicy: row.missed_policy,
    conditionSpec: parseJson(row.condition_spec_json, null),
    conditionState: parseJson(row.condition_state_json, null),
    processSpec: parseJson(row.process_spec_json, null),
    processState: parseJson(row.process_state_json, null),
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    workId: row.work_id,
    environment: row.environment,
    pendingScheduledFor: row.pending_scheduled_for,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 5),
    maxConcurrentRuns: Number(row.max_concurrent_runs ?? policy.maxConcurrentRuns ?? 1),
    timeoutSeconds: Number(row.timeout_seconds ?? policy.timeoutSeconds ?? 3600),
    backpressureLimit: Number(row.backpressure_limit ?? policy.backpressureLimit ?? 100),
    lastRunId: row.last_run_id,
    lastRunStatus: row.last_run_status,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastRunAt: row.last_run_at,
    resourceVersion: Number(row.resource_version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pausedAt: row.paused_at,
    cancelledAt: row.cancelled_at,
    completedAt: row.completed_at
  };
}

function scheduledSessionRunFromRow(row) {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    runKey: row.run_key,
    scheduledFor: row.scheduled_for,
    triggerKind: row.trigger_kind,
    triggerReason: row.trigger_reason,
    status: row.status,
    attemptCount: Number(row.attempt_count ?? 0),
    agentTaskId: row.agent_task_id,
    targetTurnId: row.target_turn_id,
    bindingId: row.binding_id,
    providerSessionId: row.provider_session_id,
    routingVersion: row.routing_version == null ? null : Number(row.routing_version),
    exitStatus: parseJson(row.exit_status_json, null),
    conditionResult: parseJson(row.condition_result_json, null),
    stages: parseJson(row.stages_json, []),
    actionResults: parseJson(row.action_results_json, []),
    deadlineAt: row.deadline_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    claimedAt: row.claimed_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function scheduledSessionEventFromRow(row) {
  return {
    eventId: row.event_id,
    taskId: row.task_id,
    runId: row.run_id,
    sequence: Number(row.sequence),
    type: row.type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    payload: parseJson(row.payload_json, {}),
    environment: row.environment,
    createdAt: row.created_at
  };
}
