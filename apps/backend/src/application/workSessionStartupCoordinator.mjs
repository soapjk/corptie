import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

const ACTIVE_STATES = new Set([
  "allocated", "worktree_prepared", "session_bound", "provider_bound", "compensating"
]);
const TERMINAL_FAILURE_STATES = new Set(["failed_compensated", "failed_manual_cleanup"]);
const PHASE_TIMESTAMP = Object.freeze({
  worktree_prepared: "worktree_prepared_at",
  session_bound: "session_bound_at",
  provider_bound: "provider_bound_at",
  ready: "ready_at"
});

/**
 * Authoritative pre-Turn Work Session startup lifecycle.
 *
 * The Store is the sole source of phase and identity state. The in-memory map
 * only avoids duplicate work inside one process; SQLite claims, leases and CAS
 * transitions remain the cross-process arbiter.
 */
export class WorkSessionStartupCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.validateStart = options.validateStart;
    this.prepareWorktree = options.prepareWorktree;
    this.inspectWorktree = options.inspectWorktree;
    this.createSession = options.createSession;
    this.bindProviderWorkspace = options.bindProviderWorkspace;
    this.inspectProviderBinding = options.inspectProviderBinding;
    this.activateSession = options.activateSession ?? (() => {});
    this.compensateWorktree = options.compensateWorktree ?? null;
    this.markSessionStartupFailed = options.markSessionStartupFailed ?? null;
    this.onChanged = options.onChanged ?? (() => {});
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.leaseOwner = options.leaseOwner ?? `startup-worker:${process.pid}:${randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.inFlight = new Map();
    for (const method of [
      "validateStart", "prepareWorktree", "inspectWorktree", "createSession",
      "bindProviderWorkspace", "inspectProviderBinding"
    ]) {
      if (typeof this[method] !== "function") throw new TypeError(`WorkSessionStartupCoordinator requires ${method}().`);
    }
    if (!this.store) throw new TypeError("WorkSessionStartupCoordinator requires a Store.");
  }

  async start(input = {}) {
    const operation = this.#allocate(input);
    if (operation.state === "ready") return this.#readyView(operation, true);
    if (TERMINAL_FAILURE_STATES.has(operation.state)) return this.#failureView(operation);
    const running = this.inFlight.get(operation.startup_operation_id);
    if (running) return running;
    const promise = this.#drive(operation.startup_operation_id)
      .finally(() => this.inFlight.delete(operation.startup_operation_id));
    this.inFlight.set(operation.startup_operation_id, promise);
    return promise;
  }

  begin(input = {}) {
    const operation = this.#allocate(input);
    if (operation.state === "ready") return this.#readyView(operation, true);
    if (TERMINAL_FAILURE_STATES.has(operation.state)) return this.#failureView(operation);
    if (!this.inFlight.has(operation.startup_operation_id)) {
      const promise = this.#drive(operation.startup_operation_id)
        .catch(() => this.#failureView(this.#operation(operation.startup_operation_id)))
        .finally(() => this.inFlight.delete(operation.startup_operation_id));
      this.inFlight.set(operation.startup_operation_id, promise);
    }
    return this.#pendingView(operation);
  }

  getReceipt({ startupOperationId, taskId = null } = {}) {
    const operation = this.#operation(requiredText(startupOperationId, "startupOperationId"));
    if (!operation || (taskId && operation.task_id !== taskId)) {
      throw coded("START_REFERENCE_INVALID", "Startup operation was not found in the requested Task.", 404, false);
    }
    if (operation.state === "ready") return this.#readyView(operation, true);
    if (TERMINAL_FAILURE_STATES.has(operation.state)) return this.#failureView(operation);
    return this.#pendingView(operation);
  }

  getSessionBinding(logicalSessionId) {
    const id = requiredText(logicalSessionId, "logicalSessionId");
    if (!id.startsWith("session:") && !id.startsWith("logical:")) {
      throw coded("START_REFERENCE_INVALID", "logicalSessionId must use the session: namespace.", 400, false);
    }
    const operation = this.store.selectOne(
      `SELECT op.* FROM work_session_startup_operations op
       JOIN work_session_startup_bindings binding
         ON binding.startup_operation_id=op.startup_operation_id
       WHERE binding.logical_session_id=? AND binding.status='ready'
       ORDER BY binding.binding_generation DESC LIMIT 1`,
      [id]
    );
    if (!operation) throw coded("START_REFERENCE_INVALID", "No ready startup binding exists for this logical Session.", 404, false);
    return this.#readyView(operation, true);
  }

  recover(startupOperationId) {
    const operation = this.#operation(requiredText(startupOperationId, "startupOperationId"));
    if (!operation) throw coded("START_REFERENCE_INVALID", "Startup operation was not found.", 404, false);
    if (operation.state === "ready") return Promise.resolve(this.#readyView(operation, true));
    if (TERMINAL_FAILURE_STATES.has(operation.state)) return Promise.resolve(this.#failureView(operation));
    if (!this.#takeLease(operation)) return Promise.resolve(this.#pendingView(this.#operation(startupOperationId)));
    return this.#drive(startupOperationId);
  }

  recoverInterruptedStarts() {
    const now = this.clock();
    const rows = this.store.selectAll(
      `SELECT startup_operation_id FROM work_session_startup_operations
       WHERE state IN ('allocated','worktree_prepared','session_bound','provider_bound','compensating')
         AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY allocated_at`,
      [now]
    );
    for (const row of rows) {
      queueMicrotask(() => this.recover(row.startup_operation_id).catch(() => {}));
    }
    return rows.length;
  }

  acceptProviderProof(proof) {
    const providerBindingId = requiredText(proof?.providerBindingId, "providerBindingId");
    const binding = this.store.selectOne(
      "SELECT * FROM work_session_startup_bindings WHERE provider_binding_id=?",
      [providerBindingId]
    );
    if (!binding) throw coded("START_REFERENCE_INVALID", "Provider binding is not registered.", 404, false);
    const generation = positiveInteger(proof.bindingGeneration, "bindingGeneration");
    if (generation < binding.binding_generation) {
      this.#audit(binding.startup_operation_id, "startup.provider_receipt_rejected_stale_generation", {
        bindingGeneration: generation,
        currentGeneration: binding.binding_generation
      });
      return { accepted: false, code: "START_PROVIDER_GENERATION_STALE" };
    }
    if (generation > binding.binding_generation) {
      this.#audit(binding.startup_operation_id, "startup.provider_receipt_rejected_future_generation", {
        bindingGeneration: generation,
        currentGeneration: binding.binding_generation
      });
      throw coded("START_PROVIDER_GENERATION_INVALID", "Provider returned an unknown future binding generation.", 409, false);
    }
    const cwd = canonicalPath(proof.canonicalWorkingDirectory);
    if (cwd !== binding.canonical_worktree_path) {
      throw coded("START_PROVIDER_CWD_MISMATCH", "Provider working-directory proof does not match the verified Worktree.", 409, true);
    }
    if (proof.trustedContextHash !== binding.provider_context_hash) {
      throw coded("START_PROVIDER_CONTEXT_MISMATCH", "Provider trusted-context proof does not match the authoritative snapshot.", 409, true);
    }
    const operation = this.#operation(binding.startup_operation_id);
    if (!operation || operation.binding_generation !== generation
      || operation.provider_binding_id !== providerBindingId) {
      throw coded("START_PROVIDER_GENERATION_STALE", "Provider receipt no longer targets the current startup generation.", 409, false);
    }
    this.#transition(operation, "provider_bound", {
      bindingUpdate: {
        provider_resource_id: requiredText(proof.providerResourceId, "providerResourceId"),
        provider_cwd_proof: cwd
      }
    });
    return { accepted: true, operation: this.#operation(operation.startup_operation_id) };
  }

  verifyReceipt(receipt) {
    if (!receipt || receipt.schemaVersion !== 2 || receipt.status !== "ready") return false;
    const { receiptHash, ...unsigned } = receipt;
    return sha256(canonicalJson(unsigned)) === receiptHash;
  }

  async #drive(operationId) {
    let operation = this.#operation(operationId);
    try {
      if (!operation) throw coded("START_REFERENCE_INVALID", "Startup operation disappeared.", 404, false);
      if (!this.#leaseOwned(operation) && !this.#takeLease(operation)) return this.#pendingView(this.#operation(operationId));
      const context = await this.validateStart(this.#inputFor(operation));
      operation = this.#operation(operationId);

      let allocation = jsonObject(operation.allocation_json);
      if (operation.state === "allocated") {
        allocation = await this.prepareWorktree({
          startupOperationId: operationId,
          taskId: operation.task_id,
          repositoryId: operation.repository_id ?? context.task.main_workspace_id,
          idempotencyKey: operation.idempotency_key,
          task: context.task
        });
        allocation = await this.#verifiedAllocation(operation, allocation);
        operation = this.#transition(operation, "worktree_prepared", { allocation });
      } else if (allocation) {
        allocation = await this.#verifiedAllocation(operation, allocation);
      }

      let session = operation.legacy_session_id ? this.store.getSession(operation.legacy_session_id) : null;
      if (operation.state === "worktree_prepared") {
        if (!session) {
          session = await this.createSession({
            ...this.#inputFor(operation),
            ...context,
            workspace: allocation,
            startupOperationId: operationId,
            trustedContext: this.#trustedSnapshot(operation, allocation)
          });
        }
        const logical = this.#verifiedLogicalSession(operation, session, allocation);
        operation = this.#transition(operation, "session_bound", {
          logicalSessionId: logical.logicalSessionId,
          legacySessionId: session.id
        });
      } else {
        session = this.store.getSession(operation.legacy_session_id);
        this.#verifiedLogicalSession(operation, session, allocation);
      }

      let binding = this.#binding(operationId);
      if (operation.state === "session_bound") {
        if (!binding) binding = this.#allocateProviderBinding(operation, allocation);
        let proof = null;
        try {
          proof = await this.inspectProviderBinding(this.#providerBindingInput(operation, binding, allocation));
        } catch (error) {
          if (error?.code !== "START_PROVIDER_BINDING_NOT_FOUND") throw error;
        }
        if (!proof) {
          proof = await this.bindProviderWorkspace(this.#providerBindingInput(operation, binding, allocation));
        }
        this.acceptProviderProof(proof);
        operation = this.#operation(operationId);
      }

      if (operation.state === "provider_bound") {
        const ready = this.#commitReady(operation, allocation);
        try {
          await this.activateSession({
            ...context,
            session: this.store.getSession(ready.session.id),
            receipt: ready.receipt,
            startupOperationId: operationId,
            initialPrompt: operation.initial_prompt
          });
        } catch (error) {
          this.#audit(operationId, "startup.initial_turn_dispatch_failed", {
            errorCode: stableErrorCode(error)
          });
          return { ...ready, turnDispatch: { status: "failed", errorCode: stableErrorCode(error) } };
        }
        return { ...ready, turnDispatch: { status: "accepted", errorCode: null } };
      }
      if (operation.state === "ready") return this.#readyView(operation, true);
      return this.#pendingView(operation);
    } catch (error) {
      operation = this.#operation(operationId);
      if (operation?.state === "ready") throw error;
      await this.#failAndCompensate(operation, error);
      error.startup = this.#failureView(this.#operation(operationId));
      throw error;
    }
  }

  #allocate(input) {
    const taskId = namespaced(input.taskId, "task:", "taskId");
    const requestedAgentId = namespaced(input.requestedAgentId, "agent:", "requestedAgentId");
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    const task = this.store.getTask(taskId);
    if (!task) throw coded("START_REFERENCE_INVALID", "Task was not found.", 404, false);
    const objectiveId = namespaced(task.objective_id, "objective:", "objectiveId");
    const repositoryId = namespaced(task.main_workspace_id, "repository:", "repositoryId");
    const providerId = requiredText(input.providerId, "providerId");
    const normalized = {
      authenticatedSessionId: optionalText(input.authenticatedSessionId),
      objectiveId,
      taskId,
      requestedAgentId,
      providerId,
      repositoryId,
      title: optionalText(input.title),
      initialPrompt: optionalText(input.initialPrompt),
      source: optionalText(input.source) ?? "application",
      replacingSessionId: optionalText(input.replacingSessionId)
    };
    const fingerprint = sha256(canonicalJson(normalized));
    const operationId = `startup:${sha256(`${taskId}\0${idempotencyKey}`).slice(0, 32)}`;
    let result;
    this.store.runInTransaction(() => {
      const existing = this.store.selectOne(
        "SELECT * FROM work_session_startup_operations WHERE task_id=? AND idempotency_key=?",
        [taskId, idempotencyKey]
      );
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw coded("START_IDEMPOTENCY_CONFLICT", "The startup idempotency key is already associated with different input.", 409, false);
        }
        result = existing;
        return;
      }
      const active = this.store.selectOne(
        `SELECT startup_operation_id FROM work_session_startup_operations
         WHERE task_id=? AND state IN ('allocated','worktree_prepared','session_bound','provider_bound','compensating') LIMIT 1`,
        [taskId]
      );
      if (active) {
        throw coded("START_ALREADY_IN_PROGRESS", "Another startup operation already owns this Task.", 409, true, {
          startupOperationId: active.startup_operation_id
        });
      }
      const now = this.clock();
      const correlationId = `startup-correlation:${randomUUID()}`;
      this.store.db.run(
        `INSERT INTO work_session_startup_operations (
          startup_operation_id, objective_id, task_id, requested_agent_id, provider_id,
          repository_id, actor_logical_session_id,
          idempotency_key, request_fingerprint, source, requested_title, initial_prompt, replacing_session_id, state,
          lease_owner, lease_expires_at, correlation_id, allocated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'allocated', ?, ?, ?, ?, ?)`,
        [operationId, objectiveId, taskId, requestedAgentId, providerId,
          repositoryId, normalized.authenticatedSessionId, idempotencyKey, fingerprint,
          normalized.source, normalized.title, normalized.initialPrompt, normalized.replacingSessionId, this.leaseOwner,
          expiresAt(now, this.leaseTtlMs), correlationId, now, now]
      );
      this.store.db.run(
        `UPDATE tasks SET execution_status='starting', updated_at=? WHERE id=?`,
        [now, taskId]
      );
      result = this.store.selectOne(
        "SELECT * FROM work_session_startup_operations WHERE startup_operation_id=?", [operationId]
      );
      this.#insertAudit(result, "startup.allocated", null, 1, {});
    });
    this.store.scheduleSave();
    this.onChanged("TaskChanged", { action: "startup-allocated", entity: this.store.getTask(taskId) });
    return result;
  }

  async #verifiedAllocation(operation, input) {
    const allocation = normalizeAllocation(input, operation);
    const inspected = normalizeAllocation(
      await this.inspectWorktree({ operation, allocation }), operation
    );
    const fields = [
      "repositoryId", "worktreeId", "canonicalWorktreePath", "sourceCommitOid",
      "sourceTreeOid", "repositoryInventoryVersion", "workspaceResourceVersion",
      "createdByStartupOperationId", "baseRef", "reused"
    ];
    if (fields.some((field) => inspected[field] !== allocation[field])
      || canonicalJson(inspected.headIdentity) !== canonicalJson(allocation.headIdentity)) {
      throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Git inventory no longer matches the prepared Worktree allocation.", 409, true);
    }
    if (allocation.createdByStartupOperationId !== operation.startup_operation_id) {
      throw coded("START_WORKTREE_COLLISION", "Prepared Worktree ownership does not belong to this startup operation.", 409, false);
    }
    return allocation;
  }

  #verifiedLogicalSession(operation, session, allocation) {
    if (!session?.id) throw coded("START_SESSION_BIND_FAILED", "Provider returned no persisted Session.", 409, true);
    const persisted = this.store.getSession(session.id);
    const logical = this.store.getLogicalSessionByLegacySessionId(session.id);
    const boundCwd = logical?.activeBinding?.boundCwd ? canonicalPath(logical.activeBinding.boundCwd) : null;
    if (!persisted || persisted.objectiveId !== operation.objective_id
      || persisted.taskId !== operation.task_id || persisted.sessionKind !== "worker"
      || !logical?.logicalSessionId || boundCwd !== allocation.canonicalWorktreePath) {
      throw coded("START_SESSION_BIND_FAILED", "Persisted logical Session does not match the authoritative Task/Worktree identity.", 409, true);
    }
    return logical;
  }

  #allocateProviderBinding(operation, allocation) {
    let binding;
    this.store.runInTransaction(() => {
      const current = this.#operation(operation.startup_operation_id);
      if (current.resource_version !== operation.resource_version || current.state !== "session_bound") {
        throw coded("START_READY_COMMIT_CONFLICT", "Startup state changed while allocating Provider binding.", 409, true);
      }
      const generation = Number(this.store.selectOne(
        "SELECT MAX(binding_generation) AS generation FROM work_session_startup_bindings WHERE logical_session_id=?",
        [operation.logical_session_id]
      )?.generation ?? 0) + 1;
      const providerBindingId = `startup-binding:${sha256(`${operation.startup_operation_id}\0${generation}`).slice(0, 32)}`;
      const trustedContext = this.#trustedSnapshot({ ...operation, binding_generation: generation, provider_binding_id: providerBindingId }, allocation);
      const contextHash = sha256(canonicalJson(trustedContext));
      const now = this.clock();
      this.store.db.run(
        `INSERT INTO work_session_startup_bindings (
          provider_binding_id, startup_operation_id, objective_id, task_id, logical_session_id,
          repository_id, worktree_id, canonical_worktree_path, head_kind, branch,
          detached_commit_oid, base_ref, source_commit_oid, source_tree_oid,
          repository_inventory_version, workspace_resource_version, binding_generation, status,
          provider_id, provider_context_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'binding', ?, ?, ?)`,
        [providerBindingId, operation.startup_operation_id, operation.objective_id, operation.task_id,
          operation.logical_session_id, allocation.repositoryId, allocation.worktreeId,
          allocation.canonicalWorktreePath, allocation.headIdentity.kind,
          allocation.headIdentity.kind === "branch" ? allocation.headIdentity.branch : null,
          allocation.headIdentity.kind === "detached" ? allocation.headIdentity.commitOid : null,
          allocation.baseRef, allocation.sourceCommitOid, allocation.sourceTreeOid,
          allocation.repositoryInventoryVersion, allocation.workspaceResourceVersion, generation,
          operation.provider_id, contextHash, now]
      );
      this.store.db.run(
        `UPDATE work_session_startup_operations SET provider_binding_id=?, binding_generation=?,
         resource_version=resource_version+1, lease_expires_at=?, updated_at=?
         WHERE startup_operation_id=? AND resource_version=? AND state='session_bound'`,
        [providerBindingId, generation, expiresAt(now, this.leaseTtlMs), now,
          operation.startup_operation_id, operation.resource_version]
      );
      requireSingleRowChange(this.store, "Startup generation allocation lost its CAS claim.");
      binding = this.#binding(operation.startup_operation_id);
    });
    this.store.scheduleSave();
    return binding;
  }

  #providerBindingInput(operation, binding, allocation) {
    const currentOperation = {
      ...operation,
      provider_binding_id: binding.provider_binding_id,
      binding_generation: binding.binding_generation
    };
    const trustedContext = this.#trustedSnapshot(currentOperation, allocation);
    if (sha256(canonicalJson(trustedContext)) !== binding.provider_context_hash) {
      throw coded("START_PROVIDER_CONTEXT_MISMATCH", "Stored Provider context hash does not match the current startup identity.", 409, false);
    }
    return {
      providerId: binding.provider_id,
      logicalSessionId: operation.logical_session_id,
      legacySessionId: operation.legacy_session_id,
      providerBindingId: binding.provider_binding_id,
      bindingGeneration: binding.binding_generation,
      workingDirectory: allocation.canonicalWorktreePath,
      trustedContext,
      trustedContextHash: binding.provider_context_hash,
      idempotencyKey: `${operation.idempotency_key}:provider-binding`
    };
  }

  #trustedSnapshot(operation, allocation) {
    return {
      schemaVersion: 2,
      startupOperationId: operation.startup_operation_id,
      objectiveId: operation.objective_id,
      taskId: operation.task_id,
      logicalSessionId: operation.logical_session_id ?? null,
      repositoryId: allocation.repositoryId,
      worktreeId: allocation.worktreeId,
      canonicalWorktreePath: allocation.canonicalWorktreePath,
      headIdentity: allocation.headIdentity,
      providerBindingId: operation.provider_binding_id ?? null,
      bindingGeneration: operation.binding_generation ?? null,
      sourceCommitOid: allocation.sourceCommitOid,
      sourceTreeOid: allocation.sourceTreeOid,
      repositoryInventoryVersion: allocation.repositoryInventoryVersion
    };
  }

  #commitReady(operation, allocation) {
    const binding = this.#binding(operation.startup_operation_id);
    const session = this.store.getSession(operation.legacy_session_id);
    const logical = this.#verifiedLogicalSession(operation, session, allocation);
    const task = this.store.getTask(operation.task_id);
    const inventory = this.store.getGitWorktree(allocation.worktreeId);
    if (!task || task.objective_id !== operation.objective_id
      || task.main_workspace_id !== allocation.repositoryId
      || !inventory || inventory.repositoryId !== allocation.repositoryId
      || canonicalPath(inventory.canonicalPath || inventory.path) !== allocation.canonicalWorktreePath
      || binding.status !== "binding" || binding.binding_generation !== operation.binding_generation
      || !binding.provider_resource_id
      || binding.provider_cwd_proof !== allocation.canonicalWorktreePath) {
      throw coded("START_READY_COMMIT_CONFLICT", "Authoritative identity changed before ready commit.", 409, true);
    }
    const now = this.clock();
    const nextVersion = operation.resource_version + 1;
    const compensation = compensationFor(operation);
    const unsigned = {
      schemaVersion: 2,
      status: "ready",
      startupOperationId: operation.startup_operation_id,
      objectiveId: operation.objective_id,
      taskId: operation.task_id,
      logicalSessionId: logical.logicalSessionId,
      repositoryId: allocation.repositoryId,
      worktreeId: allocation.worktreeId,
      canonicalWorktreePath: allocation.canonicalWorktreePath,
      headIdentity: allocation.headIdentity,
      providerBindingId: binding.provider_binding_id,
      bindingGeneration: binding.binding_generation,
      sourceCommitOid: allocation.sourceCommitOid,
      sourceTreeOid: allocation.sourceTreeOid,
      baseRef: allocation.baseRef,
      repositoryInventoryVersion: allocation.repositoryInventoryVersion,
      workspaceResourceVersion: allocation.workspaceResourceVersion,
      resourceVersion: nextVersion,
      providerContextHash: binding.provider_context_hash,
      phaseTimestamps: {
        allocatedAt: operation.allocated_at,
        worktreePreparedAt: operation.worktree_prepared_at,
        sessionBoundAt: operation.session_bound_at,
        providerBoundAt: operation.provider_bound_at,
        readyAt: now
      },
      compensation,
      error: null
    };
    const receipt = { ...unsigned, receiptHash: sha256(canonicalJson(unsigned)) };
    this.store.runInTransaction(() => {
      const current = this.#operation(operation.startup_operation_id);
      if (current.resource_version !== operation.resource_version || current.state !== "provider_bound") {
        throw coded("START_READY_COMMIT_CONFLICT", "Startup state changed before ready receipt commit.", 409, true);
      }
      this.store.db.run(
        `INSERT INTO work_session_startup_receipts (
          startup_operation_id, provider_binding_id, binding_generation, receipt_schema_version,
          receipt_hash, receipt_json, created_at, resource_version
        ) VALUES (?, ?, ?, 2, ?, ?, ?, ?)`,
        [operation.startup_operation_id, binding.provider_binding_id, binding.binding_generation,
          receipt.receiptHash, canonicalJson(receipt), now, nextVersion]
      );
      this.store.db.run(
        `UPDATE work_session_startup_bindings SET status='ready', ready_at=?,
         resource_version=resource_version+1 WHERE provider_binding_id=? AND status='binding'`,
        [now, binding.provider_binding_id]
      );
      requireSingleRowChange(this.store, "Provider binding changed before ready commit.");
      this.store.db.run(
        `UPDATE work_session_startup_operations SET state='ready', ready_at=?, resource_version=?,
         lease_owner=NULL, lease_expires_at=NULL, updated_at=?
         WHERE startup_operation_id=? AND resource_version=? AND state='provider_bound'`,
        [now, nextVersion, now, operation.startup_operation_id, operation.resource_version]
      );
      requireSingleRowChange(this.store, "Startup operation changed before ready commit.");
      this.store.db.run(
        `UPDATE tasks SET current_session_id=?, lifecycle_state='in_progress', execution_status='running',
         main_agent_id=?, acceptance_assessment_json='{}',
         resource_version=resource_version+1, updated_at=? WHERE id=?`,
        [session.id, operation.requested_agent_id, now, operation.task_id]
      );
      this.store.db.run("UPDATE agents SET current_session_id=?, updated_at=? WHERE agent_id=?", [
        session.id, now, operation.requested_agent_id
      ]);
      this.#insertAudit(operation, "startup.ready", operation.resource_version, nextVersion, {
        receiptHash: receipt.receiptHash,
        bindingGeneration: binding.binding_generation
      });
    });
    this.store.scheduleSave();
    this.onChanged("TaskChanged", { action: "startup-ready", entity: this.store.getTask(operation.task_id) });
    return this.#readyView(this.#operation(operation.startup_operation_id), false);
  }

  #transition(operation, state, details = {}) {
    const allowed = {
      allocated: "worktree_prepared",
      worktree_prepared: "session_bound",
      session_bound: "provider_bound"
    };
    if (allowed[operation.state] !== state) {
      throw coded("START_READY_COMMIT_CONFLICT", `Illegal startup transition ${operation.state} -> ${state}.`, 409, true);
    }
    const now = this.clock();
    const nextVersion = operation.resource_version + 1;
    const timestampColumn = PHASE_TIMESTAMP[state];
    this.store.runInTransaction(() => {
      const current = this.#operation(operation.startup_operation_id);
      if (current.state !== operation.state || current.resource_version !== operation.resource_version) {
        throw coded("START_READY_COMMIT_CONFLICT", "Startup resource version changed.", 409, true);
      }
      if (details.allocation) {
        this.store.db.run(
          `UPDATE work_session_startup_operations SET state=?, worktree_id=?, allocation_json=?,
           ${timestampColumn}=?, resource_version=?, lease_expires_at=?, updated_at=?
           WHERE startup_operation_id=? AND state=? AND resource_version=?`,
          [state, details.allocation.worktreeId, canonicalJson(details.allocation), now, nextVersion,
            expiresAt(now, this.leaseTtlMs), now, operation.startup_operation_id, operation.state,
          operation.resource_version]
        );
        requireSingleRowChange(this.store, "Startup allocation transition lost its CAS claim.");
      } else if (details.logicalSessionId) {
        this.store.db.run(
          `UPDATE work_session_startup_operations SET state=?, logical_session_id=?, legacy_session_id=?,
           ${timestampColumn}=?, resource_version=?, lease_expires_at=?, updated_at=?
           WHERE startup_operation_id=? AND state=? AND resource_version=?`,
          [state, details.logicalSessionId, details.legacySessionId, now, nextVersion,
            expiresAt(now, this.leaseTtlMs), now, operation.startup_operation_id, operation.state,
          operation.resource_version]
        );
        requireSingleRowChange(this.store, "Startup Session transition lost its CAS claim.");
      } else {
        const binding = details.bindingUpdate;
        this.store.db.run(
          `UPDATE work_session_startup_bindings SET provider_resource_id=?, provider_cwd_proof=?,
           resource_version=resource_version+1 WHERE provider_binding_id=? AND status='binding'`,
          [binding.provider_resource_id, binding.provider_cwd_proof, operation.provider_binding_id]
        );
        requireSingleRowChange(this.store, "Provider binding proof no longer targets an active binding.");
        this.store.db.run(
          `UPDATE work_session_startup_operations SET state=?, ${timestampColumn}=?, resource_version=?,
           lease_expires_at=?, updated_at=? WHERE startup_operation_id=? AND state=? AND resource_version=?`,
          [state, now, nextVersion, expiresAt(now, this.leaseTtlMs), now,
            operation.startup_operation_id, operation.state, operation.resource_version]
        );
        requireSingleRowChange(this.store, "Startup Provider transition lost its CAS claim.");
      }
      this.#insertAudit(operation, `startup.${state}`, operation.resource_version, nextVersion, details);
    });
    this.store.scheduleSave();
    this.onChanged("TaskChanged", { action: `startup-${state}`, entity: this.store.getTask(operation.task_id) });
    return this.#operation(operation.startup_operation_id);
  }

  async #failAndCompensate(operation, error) {
    if (!operation || operation.state === "ready" || TERMINAL_FAILURE_STATES.has(operation.state)) return;
    const errorCode = stableErrorCode(error);
    const retryable = error?.retryable === true || error?.statusCode >= 500;
    let current = operation;
    for (let attempt = 0; current.state !== "compensating" && attempt < 2; attempt += 1) {
      const now = this.clock();
      const nextVersion = current.resource_version + 1;
      let claimed = false;
      this.store.runInTransaction(() => {
        this.store.db.run(
          `UPDATE work_session_startup_operations SET state='compensating', error_code=?,
           error_message_redacted=?, error_retryable=?, compensation_state='pending',
           resource_version=?, lease_expires_at=?, updated_at=?
           WHERE startup_operation_id=? AND resource_version=?
             AND state IN ('allocated','worktree_prepared','session_bound','provider_bound')`,
          [errorCode, safeSummary(error?.message), retryable ? 1 : 0, nextVersion,
            expiresAt(now, this.leaseTtlMs), now, current.startup_operation_id, current.resource_version]
        );
        if (this.store.db.getRowsModified() !== 1) return;
        claimed = true;
        this.#insertAudit(current, "startup.failed", current.resource_version, nextVersion, { errorCode });
        this.#insertAudit({ ...current, resource_version: nextVersion }, "startup.compensation_started", nextVersion, nextVersion, {});
      });
      current = this.#operation(current.startup_operation_id);
      if (claimed) break;
      if (!current || current.state === "ready" || TERMINAL_FAILURE_STATES.has(current.state)) return;
    }
    if (current.state !== "compensating") return;
    const completedSteps = [];
    let failedStep = null;
    let manualRequired = false;
    const binding = this.#binding(current.startup_operation_id);
    if (binding) {
      this.store.db.run(
        `UPDATE work_session_startup_bindings SET status='failed', failure_code=?, retired_at=?,
         resource_version=resource_version+1 WHERE provider_binding_id=? AND status<>'ready'`,
        [errorCode, this.clock(), binding.provider_binding_id]
      );
      completedSteps.push("provider_binding_retired");
    }
    if (current.legacy_session_id && this.markSessionStartupFailed) {
      try {
        await this.markSessionStartupFailed(current.legacy_session_id, { operation: current, errorCode });
        completedSteps.push("logical_session_marked_failed");
      } catch {
        failedStep = "logical_session_marked_failed";
        manualRequired = true;
      }
    }
    const allocation = jsonObject(current.allocation_json);
    if (allocation && allocation.reused !== true && !manualRequired && this.compensateWorktree) {
      try {
        const result = await this.compensateWorktree({ operation: current, allocation });
        if (result?.manualRequired || result?.dirty) {
          failedStep = "worktree_removed";
          manualRequired = true;
          if (result?.dirty) current.error_code = "START_COMPENSATION_DIRTY_WORKTREE";
        } else if (result?.removed) {
          completedSteps.push("worktree_removed");
        }
      } catch {
        failedStep = "worktree_removed";
        manualRequired = true;
      }
    } else if (allocation) {
      completedSteps.push("worktree_preserved_verified_reuse");
    }
    completedSteps.push("task_claim_released");
    const now = this.clock();
    const state = manualRequired ? "failed_manual_cleanup" : "failed_compensated";
    const result = {
      status: manualRequired ? "manual_required" : "completed",
      completedSteps,
      failedStep
    };
    this.store.runInTransaction(() => {
      const latest = this.#operation(current.startup_operation_id);
      const nextVersion = latest.resource_version + 1;
      this.store.db.run(
        `UPDATE work_session_startup_operations SET state=?, error_code=?, compensation_state=?,
         compensation_result_json=?, failed_at=?, resource_version=?, lease_owner=NULL,
         lease_expires_at=NULL, updated_at=? WHERE startup_operation_id=? AND state='compensating'`,
        [state, current.error_code ?? errorCode, result.status, canonicalJson(result), now,
          nextVersion, now, current.startup_operation_id]
      );
      requireSingleRowChange(this.store, "Startup compensation result lost its state claim.");
      this.store.db.run(
        `UPDATE tasks SET execution_status='start_failed', updated_at=?,
         current_session_id=CASE WHEN current_session_id=? THEN NULL ELSE current_session_id END WHERE id=?`,
        [now, current.legacy_session_id, current.task_id]
      );
      this.#insertAudit(latest, manualRequired ? "startup.compensation_failed" : "startup.compensation_completed",
        latest.resource_version, nextVersion, result);
    });
    this.store.scheduleSave();
    this.onChanged("TaskChanged", { action: "startup-failed", entity: this.store.getTask(current.task_id) });
  }

  #takeLease(operation) {
    const now = this.clock();
    let taken = false;
    this.store.runInTransaction(() => {
      const current = this.#operation(operation.startup_operation_id);
      if (!current || !ACTIVE_STATES.has(current.state)) return;
      if (current.lease_expires_at && current.lease_expires_at > now && current.lease_owner !== this.leaseOwner) return;
      this.store.db.run(
        `UPDATE work_session_startup_operations SET lease_owner=?, lease_expires_at=?, attempt=attempt+1,
         resource_version=resource_version+1, updated_at=? WHERE startup_operation_id=? AND resource_version=?`,
        [this.leaseOwner, expiresAt(now, this.leaseTtlMs), now,
          current.startup_operation_id, current.resource_version]
      );
      taken = true;
      if (current.lease_owner && current.lease_owner !== this.leaseOwner) {
        this.#insertAudit(current, "startup.lease_taken_over", current.resource_version, current.resource_version + 1, {
          previousLeaseOwner: current.lease_owner
        });
      }
    });
    if (taken) this.store.scheduleSave();
    return taken;
  }

  #leaseOwned(operation) {
    return operation.lease_owner === this.leaseOwner && (!operation.lease_expires_at || operation.lease_expires_at > this.clock());
  }

  #readyView(operation, idempotentReplay) {
    const row = this.store.selectOne(
      "SELECT receipt_json FROM work_session_startup_receipts WHERE startup_operation_id=?",
      [operation.startup_operation_id]
    );
    if (!row) throw coded("START_READY_COMMIT_CONFLICT", "Ready startup has no persisted receipt.", 500, true);
    const receipt = JSON.parse(row.receipt_json);
    if (!this.verifyReceipt(receipt)) throw coded("START_READY_COMMIT_CONFLICT", "Persisted startup receipt hash is invalid.", 500, false);
    return {
      status: "ready",
      idempotentReplay,
      receipt,
      operation: this.#operationView(operation),
      session: this.store.getSession(operation.legacy_session_id),
      task: this.store.getTask(operation.task_id)
    };
  }

  #pendingView(operation) {
    return {
      status: "pending",
      startupOperationId: operation.startup_operation_id,
      phase: operation.state,
      resourceVersion: operation.resource_version,
      retryAfterMilliseconds: 250,
      error: null
    };
  }

  #failureView(operation) {
    const compensation = jsonObject(operation.compensation_result_json) ?? {
      status: operation.compensation_state ?? "pending", completedSteps: [], failedStep: null
    };
    return {
      status: "failed",
      startupOperationId: operation.startup_operation_id,
      phase: operation.state,
      resourceVersion: operation.resource_version,
      error: {
        code: operation.error_code ?? "START_FAILED",
        retryable: Boolean(operation.error_retryable),
        correlationId: operation.correlation_id,
        message: operation.error_message_redacted ?? "Work Session startup failed."
      },
      compensation
    };
  }

  #operationView(operation) {
    return {
      startupOperationId: operation.startup_operation_id,
      taskId: operation.task_id,
      state: operation.state,
      resourceVersion: operation.resource_version,
      bindingGeneration: operation.binding_generation ?? null
    };
  }

  #inputFor(operation) {
    return {
      authenticatedSessionId: operation.actor_logical_session_id ?? null,
      taskId: operation.task_id,
      objectiveId: operation.objective_id,
      requestedAgentId: operation.requested_agent_id,
      providerId: operation.provider_id,
      title: operation.requested_title,
      initialPrompt: operation.initial_prompt,
      idempotencyKey: operation.idempotency_key,
      source: operation.source,
      replacingSessionId: operation.replacing_session_id
    };
  }

  #operation(operationId) {
    return this.store.selectOne(
      "SELECT * FROM work_session_startup_operations WHERE startup_operation_id=?", [operationId]
    );
  }

  #binding(operationId) {
    return this.store.selectOne(
      "SELECT * FROM work_session_startup_bindings WHERE startup_operation_id=?", [operationId]
    );
  }

  #audit(operationId, event, details = {}) {
    const operation = this.#operation(operationId);
    if (!operation) return;
    this.store.runInTransaction(() => this.#insertAudit(
      operation, event, operation.resource_version, operation.resource_version, details
    ));
    this.store.scheduleSave();
  }

  #insertAudit(operation, event, previousResourceVersion, resourceVersion, details) {
    this.store.db.run(
      `INSERT INTO work_session_startup_audit (
        audit_id, startup_operation_id, event, actor_logical_session_id, correlation_id,
        previous_resource_version, resource_version, binding_generation, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`startup-audit:${randomUUID()}`, operation.startup_operation_id, event,
        operation.actor_logical_session_id ?? null, operation.correlation_id,
        previousResourceVersion, resourceVersion, operation.binding_generation ?? null,
        canonicalJson(details ?? {}), this.clock()]
    );
  }
}

export function canonicalStartupJson(value) {
  return canonicalJson(value);
}

export function startupContextHash(snapshot) {
  return sha256(canonicalJson(snapshot));
}

function normalizeAllocation(input, operation) {
  if (!input || typeof input !== "object") throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Worktree allocation is missing.", 409, true);
  const head = input.headIdentity ?? (input.isDetached
    ? { kind: "detached", commitOid: input.headOid }
    : { kind: "branch", branch: input.branchName });
  const headIdentity = head.kind === "detached"
    ? { kind: "detached", commitOid: fullOid(head.commitOid, "detachedCommitOid") }
    : { kind: "branch", branch: requiredText(head.branch, "branch") };
  const sourceCommitOid = fullOid(input.sourceCommitOid ?? input.headOid, "sourceCommitOid");
  return {
    repositoryId: namespaced(input.repositoryId ?? operation.repository_id, "repository:", "repositoryId"),
    worktreeId: namespaced(input.worktreeId, "worktree:", "worktreeId"),
    canonicalWorktreePath: canonicalPath(input.canonicalWorktreePath ?? input.canonicalPath ?? input.path),
    headIdentity,
    sourceCommitOid,
    sourceTreeOid: fullOid(input.sourceTreeOid, "sourceTreeOid"),
    baseRef: optionalText(input.baseRef),
    repositoryInventoryVersion: requiredText(input.repositoryInventoryVersion ?? input.inventoryVersion, "repositoryInventoryVersion"),
    workspaceResourceVersion: positiveInteger(input.workspaceResourceVersion ?? 1, "workspaceResourceVersion"),
    createdByStartupOperationId: requiredText(input.createdByStartupOperationId ?? operation.startup_operation_id, "createdByStartupOperationId"),
    reused: input.reused === true
  };
}

function compensationFor(operation) {
  const previous = jsonObject(operation.compensation_result_json);
  if (!previous) return { attempted: false, result: "not_required", completedSteps: [], failedStep: null };
  return {
    attempted: true,
    result: previous.status === "manual_required" ? "manual_required" : "completed",
    completedSteps: previous.completedSteps ?? [],
    failedStep: previous.failedStep ?? null
  };
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPath(value) {
  const path = requiredText(value, "canonicalWorktreePath");
  if (!path.startsWith("/")) throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Worktree path must be absolute.", 409, false);
  return resolve(path);
}

function fullOid(value, field) {
  const oid = requiredText(value, field);
  if (!/^[0-9a-f]{40,64}$/i.test(oid)) {
    throw coded("START_SOURCE_IDENTITY_UNAVAILABLE", `${field} must be a full commit/tree OID.`, 409, false);
  }
  return oid.toLowerCase();
}

function namespaced(value, prefix, field) {
  const text = requiredText(value, field);
  if (!text.startsWith(prefix)) throw coded("START_REFERENCE_INVALID", `${field} must use the ${prefix} namespace.`, 400, false);
  return text;
}

function requiredText(value, field) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw coded("START_REFERENCE_INVALID", `${field} is required.`, 400, false);
  return result;
}

function optionalText(value) {
  const result = typeof value === "string" ? value.trim() : "";
  return result || null;
}

function positiveInteger(value, field) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw coded("START_REFERENCE_INVALID", `${field} must be a positive integer.`, 400, false);
  return result;
}

function jsonObject(value) {
  if (!value) return null;
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
}

function expiresAt(now, milliseconds) {
  return new Date(new Date(now).getTime() + milliseconds).toISOString();
}

function stableErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code.trim() : "";
  return code && /^[A-Z0-9_]+$/.test(code) ? code : "START_FAILED";
}

function safeSummary(message) {
  return String(message ?? "Work Session startup failed.")
    .replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, 1000);
}

function coded(code, message, statusCode = 409, retryable = false, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = retryable;
  Object.assign(error, extra);
  return error;
}

function requireSingleRowChange(store, message) {
  if (store.db.getRowsModified() === 1) return;
  throw coded("START_READY_COMMIT_CONFLICT", message, 409, true);
}
