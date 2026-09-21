import { createHash } from "node:crypto";
import { access, cp, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { decodeWorkSessionStartCommand } from "../contracts/workSessionStartCommand.mjs";

// Provider-neutral startup strategy for writable Tasks whose Workspace has no
// Git capability. The source Workspace is never used as the Provider cwd: a
// private, Corptie-owned copy is prepared first and becomes the ExecutionSpace.
export class ManagedSandboxStartupCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.providerWorkSessionPort = options.providerWorkSessionPort;
    this.onChanged = options.onChanged ?? (() => {});
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.root = resolve(options.root ?? join(this.store?.dataRoot ?? "", "execution-spaces"));
    this.inFlight = new Map();
    if (!this.store || !this.providerWorkSessionPort) {
      throw new TypeError("ManagedSandboxStartupCoordinator requires store and ProviderWorkSessionPort.");
    }
  }

  async start(input = {}, authorization = {}) {
    const command = decodeWorkSessionStartCommand(input);
    const operationId = managedOperationId(command.taskId, command.idempotencyKey);
    const running = this.inFlight.get(operationId);
    if (running) return running;
    const operation = this.#drive(operationId, command, authorization)
      .finally(() => this.inFlight.delete(operationId));
    this.inFlight.set(operationId, operation);
    return operation;
  }

  getReceipt({ startupOperationId, taskId = null } = {}) {
    const row = this.#row(startupOperationId);
    if (!row || (taskId && row.task_id !== taskId)) throw coded("START_REFERENCE_INVALID", "Managed Sandbox startup was not found.", 404);
    return this.#view(row, true);
  }

  getSessionBinding(logicalSessionId) {
    const row = this.store.selectOne(
      `SELECT * FROM execution_spaces WHERE logical_session_id=? AND strategy='managedSandbox'
       AND status='ready' ORDER BY updated_at DESC LIMIT 1`,
      [logicalSessionId]
    );
    if (!row) throw coded("START_REFERENCE_INVALID", "No ready managed Sandbox binding exists for this Session.", 404);
    return this.#view(row, true);
  }

  async #drive(operationId, command, authorization) {
    const task = this.store.getTask(command.taskId);
    if (!task) throw coded("TASK_NOT_FOUND", "Task was not found.", 404);
    const sourcePath = await canonicalDirectory(authorization.workspaceRootPath);
    const workspaceId = required(authorization.workspaceId, "workspaceId");
    const fingerprint = digest(JSON.stringify({
      taskId: command.taskId,
      workId: authorization.workId,
      workspaceId,
      sourcePath,
      providerId: authorization.providerId,
      assigneeAgentId: command.assigneeAgentId,
      expectedTaskVersion: command.expectedTaskVersion,
      idempotencyKey: command.idempotencyKey
    }));
    let row = this.#allocate({ operationId, command, authorization, sourcePath, workspaceId, fingerprint });
    if (row.request_fingerprint !== fingerprint) {
      throw coded("START_IDEMPOTENCY_CONFLICT", "Managed Sandbox startup key is associated with different input.", 409);
    }
    if (row.status === "ready") return this.#view(row, true);

    const rootPath = resolve(row.root_path);
    assertOwnedPath(this.root, rootPath);
    let session = row.session_id ? this.store.getSession(row.session_id) : null;
    try {
      if (!session) {
        await this.#prepareCopy(sourcePath, rootPath, operationId);
        this.#update(operationId, { status: "preparing", preparedAt: this.clock(), errorCode: null, errorMessage: null });
        session = await this.providerWorkSessionPort.createSession({
          ...command,
          workId: authorization.workId,
          workspaceId,
          executionStrategy: "managedSandbox",
          workspace: { canonicalWorktreePath: rootPath, canonicalExecutionPath: rootPath },
          trustedContext: this.#trustedContext(row, rootPath)
        });
        const logical = this.store.getLogicalSessionByLegacySessionId(session?.id);
        if (!session?.id || !logical?.logicalSessionId
          || resolve(logical.activeBinding?.boundCwd ?? "") !== rootPath) {
          throw coded("START_SESSION_BIND_FAILED", "Managed Sandbox Session did not bind to its authoritative ExecutionSpace.", 409);
        }
        this.#update(operationId, {
          status: "binding", sessionId: session.id, logicalSessionId: logical.logicalSessionId
        });
        row = this.#row(operationId);
      }

      const activation = await this.providerWorkSessionPort.activateSession({
        ...command,
        session,
        workId: authorization.workId,
        workspaceId,
        executionStrategy: "managedSandbox",
        workingDirectory: rootPath,
        dispatchInitialTurn: false
      });
      const logical = this.store.getLogicalSessionByLegacySessionId(session.id);
      const now = this.clock();
      const unsignedReceipt = {
        schemaVersion: 2,
        status: "ready",
        startupOperationId: operationId,
        executionSpaceId: operationId,
        executionStrategy: "managedSandbox",
        workId: authorization.workId,
        taskId: command.taskId,
        workspaceId,
        logicalSessionId: logical.logicalSessionId,
        canonicalWorkingDirectory: rootPath,
        providerBindingId: logical.activeBinding?.bindingId ?? null,
        providerResourceId: activation?.providerResourceId ?? logical.activeBinding?.providerSessionId ?? null,
        baseWorkspaceRevision: row.base_workspace_revision,
        toolContractHash: activation?.toolContractHash ?? null,
        instructionSourcesHash: activation?.instructionSourcesHash ?? null,
        readyAt: now
      };
      const receipt = { ...unsignedReceipt, receiptHash: digest(stableJson(unsignedReceipt)) };
      this.store.runInTransaction(() => {
        const currentTask = this.store.selectOne("SELECT * FROM tasks WHERE id=?", [command.taskId]);
        if (!currentTask || Number(currentTask.resource_version) !== command.expectedTaskVersion
          || currentTask.current_session_id) {
          throw coded("TASK_VERSION_CONFLICT", "Task changed before the managed Sandbox became ready.", 409);
        }
        this.store.db.run(
          `UPDATE execution_spaces SET status='ready', receipt_json=?, ready_at=?, updated_at=?,
           resource_version=resource_version+1 WHERE execution_space_id=? AND status IN ('preparing','binding','prepareFailed')`,
          [stableJson(receipt), now, now, operationId]
        );
        requireSingleChange(this.store, "Managed Sandbox ready commit lost its claim.");
        this.store.db.run(
          `UPDATE tasks SET current_session_id=?, lifecycle_state='in_progress', execution_status=?,
           main_agent_id=?, acceptance_assessment_json='{}', resource_version=resource_version+1,
           updated_at=? WHERE id=? AND resource_version=? AND lifecycle_state='todo'
           AND current_session_id IS NULL AND COALESCE(deletion_status, '')=''`,
          [session.id, command.dispatchInitialTurn === false ? "idle" : "running",
            command.assigneeAgentId, now, command.taskId, command.expectedTaskVersion]
        );
        requireSingleChange(this.store, "Task changed before the managed Sandbox ready commit.");
        this.store.db.run("UPDATE agents SET current_session_id=?, updated_at=? WHERE agent_id=?", [
          session.id, now, command.assigneeAgentId
        ]);
      });
      this.store.scheduleSave();
      this.onChanged("TaskChanged", { action: "startup-ready", entity: this.store.getTask(command.taskId) });
      if (command.dispatchInitialTurn !== false) {
        await this.providerWorkSessionPort.activateSession({
          ...command, session, workId: authorization.workId, workspaceId,
          executionStrategy: "managedSandbox", workingDirectory: rootPath,
          dispatchInitialTurn: true, receipt
        });
        return {
          ...this.#view(this.#row(operationId), false),
          turnDispatch: { status: "accepted", errorCode: null }
        };
      }
      return this.#view(this.#row(operationId), false);
    } catch (error) {
      if (session?.id && this.#row(operationId)?.status !== "ready") {
        await this.providerWorkSessionPort.compensateSession({
          sessionId: session.id, startupOperationId: operationId,
          errorCode: error?.code ?? "START_MANAGED_SANDBOX_FAILED"
        }).catch(() => {});
      }
      this.#update(operationId, {
        status: "prepareFailed",
        errorCode: error?.code ?? "START_MANAGED_SANDBOX_FAILED",
        errorMessage: safeMessage(error)
      });
      throw error;
    }
  }

  #allocate({ operationId, command, authorization, sourcePath, workspaceId, fingerprint }) {
    let row = this.#row(operationId);
    if (row) return row;
    const rootPath = join(this.root, digest(command.taskId).slice(0, 32));
    const now = this.clock();
    const revision = digest(`${workspaceId}\0${authorization.workspaceUpdatedAt ?? ""}\0${sourcePath}`);
    this.store.db.run(
      `INSERT INTO execution_spaces (
        execution_space_id, work_id, task_id, session_id, logical_session_id, workspace_id,
        strategy, status, root_path, source_workspace_path, base_workspace_revision,
        idempotency_key, request_fingerprint, receipt_json, error_code, error_message,
        resource_version, created_at, updated_at, prepared_at, ready_at, released_at
      ) VALUES (?, ?, ?, NULL, NULL, ?, 'managedSandbox', 'preparing', ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?, NULL, NULL, NULL)`,
      [operationId, authorization.workId, command.taskId, workspaceId, rootPath, sourcePath,
        revision, command.idempotencyKey, fingerprint, now, now]
    );
    this.store.scheduleSave();
    return this.#row(operationId);
  }

  async #prepareCopy(sourcePath, rootPath, operationId) {
    try {
      await access(rootPath);
      return;
    } catch {}
    await mkdir(this.root, { recursive: true });
    const staging = `${rootPath}.staging-${digest(operationId).slice(0, 12)}`;
    assertOwnedPath(this.root, staging);
    await rm(staging, { recursive: true, force: true });
    await cp(sourcePath, staging, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    await rename(staging, rootPath);
  }

  #trustedContext(row, rootPath) {
    return {
      schemaVersion: 1,
      executionSpaceId: row.execution_space_id,
      executionStrategy: "managedSandbox",
      workspaceId: row.workspace_id,
      canonicalWorkingDirectory: rootPath,
      baseWorkspaceRevision: row.base_workspace_revision
    };
  }

  #update(operationId, patch) {
    const fields = [];
    const values = [];
    const map = {
      status: "status", sessionId: "session_id", logicalSessionId: "logical_session_id",
      preparedAt: "prepared_at", errorCode: "error_code", errorMessage: "error_message"
    };
    for (const [key, column] of Object.entries(map)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      fields.push(`${column}=?`);
      values.push(patch[key]);
    }
    fields.push("updated_at=?", "resource_version=resource_version+1");
    values.push(this.clock(), operationId);
    this.store.db.run(`UPDATE execution_spaces SET ${fields.join(", ")} WHERE execution_space_id=?`, values);
    this.store.scheduleSave();
    return this.#row(operationId);
  }

  #row(operationId) {
    return this.store.selectOne("SELECT * FROM execution_spaces WHERE execution_space_id=?", [operationId]);
  }

  #view(row, idempotentReplay) {
    if (row.status !== "ready") {
      return {
        status: row.status === "prepareFailed" ? "failed" : "pending",
        startupOperationId: row.execution_space_id,
        phase: row.status,
        error: row.error_code ? { code: row.error_code, message: row.error_message } : null
      };
    }
    return {
      status: "ready",
      idempotentReplay,
      receipt: JSON.parse(row.receipt_json),
      operation: {
        startupOperationId: row.execution_space_id,
        taskId: row.task_id,
        state: row.status,
        resourceVersion: row.resource_version
      },
      session: this.store.getSession(row.session_id),
      task: this.store.getTask(row.task_id),
      turnDispatch: { status: "deferred", errorCode: null }
    };
  }
}

function managedOperationId(taskId, idempotencyKey) {
  return `execution-space:${digest(`${taskId}\0${idempotencyKey}`).slice(0, 32)}`;
}

function digest(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
function required(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw coded("START_REFERENCE_INVALID", `${field} is required.`, 400);
  return text;
}
async function canonicalDirectory(path) {
  const canonical = await realpath(required(path, "workspaceRootPath"));
  if (!(await stat(canonical)).isDirectory()) throw coded("WORKSPACE_UNAVAILABLE", "Workspace is not a directory.", 409);
  return canonical;
}
function assertOwnedPath(root, path) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!path.startsWith(prefix)) throw coded("EXECUTION_SPACE_PATH_INVALID", "Managed Sandbox path escaped its owned root.", 500);
}
function requireSingleChange(store, message) {
  if (store.db.getRowsModified() !== 1) throw coded("START_READY_COMMIT_CONFLICT", message, 409);
}
function safeMessage(error) { return String(error?.message ?? error ?? "Managed Sandbox startup failed.").replace(/\s+/g, " ").slice(0, 1000); }
function coded(code, message, statusCode) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
