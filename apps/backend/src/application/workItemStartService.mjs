import { createHash } from "node:crypto";

const ACTIVE_STAGES = new Set(["validating", "preparingWorkspace", "creatingSession", "binding"]);

export class WorkItemStartService {
  constructor(options = {}) {
    this.store = options.store;
    this.validateStart = options.validateStart;
    this.prepareWorkspace = options.prepareWorkspace;
    this.createSession = options.createSession;
    this.finalizeStart = options.finalizeStart;
    this.onChanged = options.onChanged ?? (() => {});
    this.onAudit = options.onAudit ?? (() => {});
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.inFlight = new Map();
    for (const method of ["validateStart", "prepareWorkspace", "createSession", "finalizeStart"]) {
      if (typeof this[method] !== "function") throw new TypeError(`WorkItemStartService requires ${method}().`);
    }
    if (!this.store) throw new TypeError("WorkItemStartService requires a Store.");
  }

  recoverInterruptedStarts() {
    const interrupted = this.store.selectAll(
      `SELECT * FROM work_item_start_operations WHERE status='in_progress'`
    );
    for (const operation of interrupted) {
      this.#recordFailure(operation, operation.stage, interruptedError());
    }
    return interrupted.length;
  }

  // Older releases created the deterministic Worktree before persisting any
  // launch state. Detect that exact partial-success shape without touching the
  // Worktree or its files, so the UI can explain and safely retry it.
  detectLegacyPartialStarts() {
    const rows = this.store.selectAll(
      `SELECT wi.id, wi.objective_id, wi.main_agent_id, wi.main_workspace_id,
              wt.worktree_id, COALESCE(wt.canonical_path, wt.path) AS worktree_path,
              wt.branch_name
       FROM work_items wi
       JOIN git_worktrees wt ON wt.repository_id=wi.main_workspace_id
        AND wt.branch_name=('workitem/' || CASE
          WHEN instr(wi.id, ':') > 0 THEN substr(wi.id, instr(wi.id, ':') + 1)
          ELSE wi.id END)
       WHERE wi.current_session_id IS NULL
         AND COALESCE(wi.status, 'todo')='todo'
         AND COALESCE(wi.execution_status, 'idle')='idle'
         AND wi.start_stage IS NULL
         AND wi.start_error IS NULL
         AND wt.availability='available' AND wt.is_main=0`
    );
    const timestamp = this.clock();
    for (const row of rows) {
      this.store.db.run(
        `UPDATE work_items SET execution_status='start_failed', start_stage='failed',
         start_failure_stage='creatingSession', start_error_code='LEGACY_PARTIAL_START_DETECTED',
         start_error='A dedicated Worktree exists, but no Worker Session was persisted. Retry will reuse the Worktree.',
         start_worktree_id=?, start_worktree_path=?, start_worktree_branch=?,
         start_stage_updated_at=?, start_failed_at=?, updated_at=? WHERE id=?`,
        [row.worktree_id, row.worktree_path, row.branch_name, timestamp, timestamp, timestamp, row.id]
      );
      this.#audit({
        event: "legacy_partial_start_detected",
        workItemId: row.id,
        objectiveId: row.objective_id,
        agentId: row.main_agent_id,
        repositoryId: row.main_workspace_id,
        worktreeId: row.worktree_id,
        worktreePath: row.worktree_path,
        worktreeBranch: row.branch_name,
        stage: "creatingSession",
        errorCode: "LEGACY_PARTIAL_START_DETECTED",
        at: timestamp
      });
    }
    if (rows.length > 0) this.store.scheduleSave();
    return rows.length;
  }

  async start(input = {}) {
    const workItemId = requiredText(input.workItemId, "workItemId");
    const agentId = requiredText(input.agentId, "agentId");
    const providerId = requiredText(input.providerId, "providerId");
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    const workItem = this.store.getWorkItem(workItemId);
    if (!workItem) throw coded("WORK_ITEM_NOT_FOUND", `WorkItem not found: ${workItemId}`, 404);
    if (workItem.current_session_id) return this.#runningReceipt(workItem, true);

    const normalized = {
      workItemId,
      objectiveId: workItem.objective_id,
      agentId,
      repositoryId: workItem.main_workspace_id ?? null,
      providerId,
      idempotencyKey,
      title: optionalText(input.title),
      source: optionalText(input.source) ?? "application",
      actorId: optionalText(input.actorId)
    };
    const fingerprint = fingerprintFor(normalized);
    const operationId = operationIdFor(workItemId, idempotencyKey);
    const existing = this.store.selectOne(
      "SELECT * FROM work_item_start_operations WHERE work_item_id=? AND idempotency_key=?",
      [workItemId, idempotencyKey]
    );
    if (existing && existing.input_fingerprint !== fingerprint) {
      throw coded("START_IDEMPOTENCY_CONFLICT", "The start idempotency key is already associated with different Agent or Provider input.", 409);
    }
    if (existing?.status === "succeeded") return this.#runningReceipt(this.store.getWorkItem(workItemId), true);
    const running = this.inFlight.get(operationId);
    if (running) return running;
    const otherKey = this.store.selectOne(
      `SELECT operation_id FROM work_item_start_operations
       WHERE work_item_id=? AND status='in_progress' AND idempotency_key<>? LIMIT 1`,
      [workItemId, idempotencyKey]
    );
    if (otherKey) throw coded("START_IN_PROGRESS", "Another start operation is already in progress for this WorkItem.", 409);

    this.#claim({ ...normalized, operationId, fingerprint }, existing);
    const promise = this.#run({ ...normalized, operationId })
      .finally(() => this.inFlight.delete(operationId));
    this.inFlight.set(operationId, promise);
    return promise;
  }

  cancel(workItemId, reason = "Canceled by user") {
    const item = this.store.getWorkItem(requiredText(workItemId, "workItemId"));
    if (!item) throw coded("WORK_ITEM_NOT_FOUND", `WorkItem not found: ${workItemId}`, 404);
    if (item.current_session_id) throw coded("WORK_ITEM_ALREADY_RUNNING", "Interrupt the bound Worker Session instead of canceling start.", 409);
    const active = this.store.selectOne(
      "SELECT operation_id FROM work_item_start_operations WHERE work_item_id=? AND status='in_progress' LIMIT 1",
      [item.id]
    );
    if (active) throw coded("START_IN_PROGRESS", "Wait for the active start attempt to settle before canceling it safely.", 409);
    const timestamp = this.clock();
    this.store.runInTransaction(() => {
      this.store.db.run(
        `UPDATE work_items SET status='canceled', execution_status='cancelled', cancel_reason=?, canceled_at=?,
         start_stage=CASE WHEN start_stage IS NULL THEN NULL ELSE 'failed' END,
         start_failure_stage=CASE WHEN start_failure_stage IS NULL THEN start_stage ELSE start_failure_stage END,
         start_error_code=COALESCE(start_error_code, 'START_CANCELED'),
         start_error=COALESCE(start_error, 'Start canceled safely; any existing Worktree was preserved.'),
         start_failed_at=COALESCE(start_failed_at, ?), updated_at=?, resource_version=resource_version+1 WHERE id=?`,
        [safeSummary(reason), timestamp, timestamp, timestamp, item.id]
      );
      this.store.db.run(
        `UPDATE work_item_start_operations SET status='canceled', error_code=COALESCE(error_code, 'START_CANCELED'),
         error_summary=COALESCE(error_summary, 'Start canceled safely; Worktree preserved.'), updated_at=?, completed_at=?
         WHERE work_item_id=? AND status='failed'`,
        [timestamp, timestamp, item.id]
      );
    });
    this.store.scheduleSave();
    const updated = this.store.getWorkItem(item.id);
    this.onChanged("WorkItemChanged", { action: "start-canceled", entity: updated });
    return updated;
  }

  async #run(operation) {
    let stage = "validating";
    let workspace = null;
    try {
      const context = await this.validateStart(operation);
      stage = "preparingWorkspace";
      this.#advance(operation, stage);
      workspace = await this.prepareWorkspace({ workItem: context.workItem, session: null });
      this.#recordWorkspace(operation, workspace);

      stage = "creatingSession";
      this.#advance(operation, stage);
      const persisted = this.store.selectOne(
        "SELECT session_id FROM work_item_start_operations WHERE operation_id=?",
        [operation.operationId]
      );
      let session = persisted?.session_id ? this.store.getSession(persisted.session_id) : null;
      if (!session) {
        session = await this.createSession({ ...operation, ...context, workspace });
        if (!session?.id) throw coded("START_SESSION_UNRESOLVED", "Provider returned no persistable Corptie Session.");
        this.#recordSession(operation, session.id);
      }

      stage = "binding";
      this.#advance(operation, stage);
      const finalized = await this.finalizeStart({
        sessionId: session.id,
        workItemId: operation.workItemId,
        objectiveId: operation.objectiveId,
        agentId: operation.agentId,
        operationId: operation.operationId,
        workspace
      });
      const updated = finalized.workItem ?? this.store.getWorkItem(operation.workItemId);
      this.#audit({
        event: "work_item_start_succeeded",
        ...this.#auditContext(operation, workspace),
        stage: "running",
        sessionId: session.id,
        logicalSessionId: finalized.logicalSession?.logicalSessionId ?? null,
        providerBindingId: finalized.logicalSession?.activeBinding?.bindingId ?? null,
        at: this.clock()
      });
      this.onChanged("WorkItemChanged", { action: "execution-started", entity: updated });
      return this.#runningReceipt(updated, false);
    } catch (error) {
      const row = this.store.selectOne("SELECT * FROM work_item_start_operations WHERE operation_id=?", [operation.operationId]);
      this.#recordFailure(row ?? operation, stage, error, workspace);
      error.receipt = this.#failureReceipt(operation.workItemId);
      throw error;
    }
  }

  #claim(operation, existing) {
    const timestamp = this.clock();
    this.store.runInTransaction(() => {
      if (!existing) {
        this.store.db.run(
          `INSERT INTO work_item_start_operations (
             operation_id, work_item_id, objective_id, agent_id, repository_id, provider_id,
             idempotency_key, input_fingerprint, source, status, stage, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', 'validating', ?, ?)`,
          [operation.operationId, operation.workItemId, operation.objectiveId, operation.agentId,
            operation.repositoryId, operation.providerId, operation.idempotencyKey, operation.fingerprint,
            operation.source, timestamp, timestamp]
        );
      } else {
        this.store.db.run(
          `UPDATE work_item_start_operations SET status='in_progress', stage='validating', failure_stage=NULL,
           error_code=NULL, error_summary=NULL, updated_at=?, completed_at=NULL WHERE operation_id=?`,
          [timestamp, operation.operationId]
        );
      }
      this.store.db.run(
        `UPDATE work_items SET execution_status='starting', start_stage='validating',
         start_failure_stage=NULL, start_error_code=NULL, start_error=NULL, start_failed_at=NULL,
         start_idempotency_key=?, start_provider_id=?, start_agent_id=?,
         start_started_at=COALESCE(start_started_at, ?), start_stage_updated_at=?, updated_at=? WHERE id=?`,
        [operation.idempotencyKey, operation.providerId, operation.agentId,
          timestamp, timestamp, timestamp, operation.workItemId]
      );
    });
    this.store.scheduleSave();
    this.onChanged("WorkItemChanged", { action: "start-stage-changed", entity: this.store.getWorkItem(operation.workItemId) });
    this.#audit({ event: existing ? "work_item_start_retried" : "work_item_start_requested", ...this.#auditContext(operation), stage: "validating", at: timestamp });
  }

  #advance(operation, stage) {
    const timestamp = this.clock();
    this.store.runInTransaction(() => {
      this.store.db.run(
        "UPDATE work_item_start_operations SET stage=?, updated_at=? WHERE operation_id=?",
        [stage, timestamp, operation.operationId]
      );
      this.store.db.run(
        "UPDATE work_items SET start_stage=?, start_stage_updated_at=?, updated_at=? WHERE id=?",
        [stage, timestamp, timestamp, operation.workItemId]
      );
    });
    this.store.scheduleSave();
    this.onChanged("WorkItemChanged", { action: "start-stage-changed", entity: this.store.getWorkItem(operation.workItemId) });
    this.#audit({ event: "work_item_start_stage", ...this.#auditContext(operation), stage, at: timestamp });
  }

  #recordWorkspace(operation, workspace) {
    const timestamp = this.clock();
    this.store.runInTransaction(() => {
      this.store.db.run(
        `UPDATE work_item_start_operations SET worktree_id=?, worktree_path=?, worktree_branch=?, updated_at=?
         WHERE operation_id=?`,
        [workspace?.worktreeId ?? null, workspace?.path ?? null, workspace?.branchName ?? null, timestamp, operation.operationId]
      );
      this.store.db.run(
        `UPDATE work_items SET start_worktree_id=?, start_worktree_path=?, start_worktree_branch=?,
         start_stage_updated_at=?, updated_at=? WHERE id=?`,
        [workspace?.worktreeId ?? null, workspace?.path ?? null, workspace?.branchName ?? null,
          timestamp, timestamp, operation.workItemId]
      );
    });
    this.store.scheduleSave();
    this.#audit({ event: "work_item_workspace_prepared", ...this.#auditContext(operation, workspace), stage: "preparingWorkspace", reused: workspace?.reused === true, at: timestamp });
  }

  #recordSession(operation, sessionId) {
    const timestamp = this.clock();
    this.store.db.run(
      "UPDATE work_item_start_operations SET session_id=?, updated_at=? WHERE operation_id=?",
      [sessionId, timestamp, operation.operationId]
    );
    this.store.scheduleSave();
    this.#audit({ event: "work_item_session_created", ...this.#auditContext(operation), stage: "creatingSession", sessionId, at: timestamp });
  }

  #recordFailure(operation, failureStage, error, workspace = null) {
    const timestamp = this.clock();
    const errorCode = stableErrorCode(error);
    const summary = safeSummary(error?.message ?? "WorkItem start failed.");
    this.store.runInTransaction(() => {
      this.store.db.run(
        `UPDATE work_item_start_operations SET status='failed', stage='failed', failure_stage=?,
         error_code=?, error_summary=?, updated_at=?, completed_at=? WHERE operation_id=?`,
        [failureStage, errorCode, summary, timestamp, timestamp, operation.operation_id ?? operation.operationId]
      );
      this.store.db.run(
        `UPDATE work_items SET execution_status='start_failed', start_stage='failed', start_failure_stage=?,
         start_error_code=?, start_error=?, start_failed_at=?, start_stage_updated_at=?, updated_at=?
         , current_session_id=CASE WHEN ?='binding' THEN NULL ELSE current_session_id END
         WHERE id=? AND start_idempotency_key=?`,
        [failureStage, errorCode, summary, timestamp, timestamp, timestamp, failureStage,
          operation.work_item_id ?? operation.workItemId,
          operation.idempotency_key ?? operation.idempotencyKey]
      );
    });
    this.store.scheduleSave();
    const context = this.#auditContext({
      operationId: operation.operation_id ?? operation.operationId,
      workItemId: operation.work_item_id ?? operation.workItemId,
      objectiveId: operation.objective_id ?? operation.objectiveId,
      agentId: operation.agent_id ?? operation.agentId,
      repositoryId: operation.repository_id ?? operation.repositoryId,
      providerId: operation.provider_id ?? operation.providerId,
      idempotencyKey: operation.idempotency_key ?? operation.idempotencyKey,
      source: operation.source
    }, workspace ?? {
      worktreeId: operation.worktree_id,
      path: operation.worktree_path,
      branchName: operation.worktree_branch
    });
    this.#audit({ event: "work_item_start_failed", ...context, stage: "failed", failureStage, errorCode, errorSummary: summary, at: timestamp }, true);
    this.onChanged("WorkItemChanged", { action: "start-failed", entity: this.store.getWorkItem(context.workItemId) });
  }

  #runningReceipt(workItem, idempotentReplay) {
    const session = workItem?.current_session_id ? this.store.getSession(workItem.current_session_id) : null;
    const logical = session ? this.store.getLogicalSessionByLegacySessionId(session.id) : null;
    if (!session || !logical?.activeBinding) throw coded("START_SESSION_UNRESOLVED", "WorkItem says it is running, but its Session binding is incomplete.", 409);
    return {
      phase: "running",
      executionStatus: "running",
      idempotentReplay,
      workItem,
      session,
      logicalSessionId: logical.logicalSessionId,
      providerBinding: {
        bindingId: logical.activeBinding.bindingId,
        providerId: logical.activeBinding.providerId,
        providerSessionId: logical.activeBinding.providerSessionId
      },
      workspace: {
        worktreeId: workItem.start_worktree_id ?? logical.activeWorkspaceId ?? null,
        path: workItem.start_worktree_path ?? logical.activeBinding.boundCwd ?? null,
        branchName: workItem.start_worktree_branch ?? null
      }
    };
  }

  #failureReceipt(workItemId) {
    const item = this.store.getWorkItem(workItemId);
    return {
      phase: "failed",
      workItemId,
      executionStatus: item?.execution_status ?? "start_failed",
      failureStage: item?.start_failure_stage ?? null,
      errorCode: item?.start_error_code ?? null,
      errorSummary: item?.start_error ?? null,
      worktreePreserved: Boolean(item?.start_worktree_path),
      recoveryActions: ["retry", "details", "cancel"]
    };
  }

  #auditContext(operation, workspace = null) {
    return {
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      workItemId: operation.workItemId,
      objectiveId: operation.objectiveId,
      agentId: operation.agentId,
      repositoryId: operation.repositoryId,
      providerId: operation.providerId,
      source: operation.source,
      worktreeId: workspace?.worktreeId ?? null,
      worktreePath: workspace?.path ?? null,
      worktreeBranch: workspace?.branchName ?? null
    };
  }

  #audit(entry, failed = false) {
    try {
      this.onAudit(entry, { failed });
    } catch {
      // Audit transport failure must not replace the authoritative persisted state.
    }
  }
}

function operationIdFor(workItemId, idempotencyKey) {
  return `work_item_start:${createHash("sha256").update(`${workItemId}\0${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

function fingerprintFor(input) {
  return createHash("sha256").update(JSON.stringify({
    workItemId: input.workItemId,
    objectiveId: input.objectiveId,
    agentId: input.agentId,
    providerId: input.providerId,
    title: input.title
  })).digest("hex");
}

function stableErrorCode(error) {
  const candidate = typeof error?.code === "string" ? error.code.trim() : "";
  return /^[A-Z][A-Z0-9_]{1,95}$/.test(candidate) ? candidate : "WORK_ITEM_START_FAILED";
}

function safeSummary(value) {
  return String(value ?? "")
    .replace(/(token|secret|password|authorization|api[-_]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800) || "WorkItem start failed.";
}

function interruptedError() {
  return coded("START_INTERRUPTED", "Backend restarted before the WorkItem start reached a durable running state.", 503);
}

function coded(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw coded("INVALID_INPUT", `${field} is required.`);
  return normalized;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const WORK_ITEM_START_ACTIVE_STAGES = ACTIVE_STAGES;
