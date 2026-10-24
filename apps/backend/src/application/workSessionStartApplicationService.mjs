import {
  decodeWorkSessionStartCommand,
  startContractError
} from "../contracts/workSessionStartCommand.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";

/**
 * The sole application entry point for starting a Task Work Session.
 * Callers supply identifiers only; this service resolves every resource from
 * the Store and authorizes the source Session before the coordinator allocates.
 */
export class WorkSessionStartApplicationService {
  constructor(options = {}) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.managedSandboxCoordinator = options.managedSandboxCoordinator ?? null;
    this.providerRegistry = options.providerRegistry;
    this.resolveProviderId = options.resolveProviderId ?? ((value) => value);
    if (!this.store || !this.coordinator || !this.providerRegistry) {
      throw new TypeError("WorkSessionStartApplicationService requires store, coordinator, and providerRegistry.");
    }
  }

  async start(input) {
    const command = decodeWorkSessionStartCommand(input);
    const authorized = this.authorize(command);
    if (authorized.executionStrategy === "managedSandbox") {
      if (!this.managedSandboxCoordinator) {
        throw startContractError(
          "WORKSPACE_CAPABILITY_UNAVAILABLE",
          "Managed Sandbox execution is unavailable for this non-Git Workspace."
        );
      }
      return this.managedSandboxCoordinator.start(command, authorized);
    }
    return this.coordinator.start({ ...command, providerId: authorized.providerId });
  }

  getReceipt(input) {
    if (String(input?.startupOperationId ?? "").startsWith("execution-space:")) {
      return this.managedSandboxCoordinator?.getReceipt(input);
    }
    return this.coordinator.getReceipt(input);
  }

  taskStartup({ taskId, sourceSessionId }) {
    const { task, operation } = this.#recoveryScope(taskId, sourceSessionId);
    if (!operation) return { taskId, workId: task.work_id, parentTaskId: task.parent_task_id ?? null,
      status: "unavailable", startupOperationId: null, sessionId: task.current_session_id ?? null, canRetry: false, error: null };
    const view = this.coordinator.getReceipt({ taskId, startupOperationId: operation.startup_operation_id });
    return { taskId, workId: task.work_id, parentTaskId: task.parent_task_id ?? null,
      status: view.status, phase: operation.state, startupOperationId: operation.startup_operation_id,
      sessionId: operation.state === "ready" ? operation.legacy_session_id : null,
      canRetry: operation.state === "failed_compensated" && operation.compensation_state === "completed"
        && Boolean(operation.error_retryable) && !task.archived && task.lifecycle_state !== "done"
        && task.main_agent_id === operation.assignee_agent_id
        && !task.deletion_status && !task.current_session_id,
      // Do not expose host paths, Provider errors or configuration to paired clients.
      error: view.error ? { code: view.error.code, retryable: view.error.retryable } : null };
  }

  async retryTaskStartup({ taskId, sourceSessionId, startupOperationId }) {
    const { task, operation } = this.#recoveryScope(taskId, sourceSessionId);
    if (typeof startupOperationId !== "string" || !startupOperationId || startupOperationId.length > 200) {
      throw startContractError("START_REFERENCE_INVALID", "An exact failed startup operation is required.");
    }
    // A lost response or a concurrent click only reads the successor. It must
    // never advance a second attempt without a new explicit user action.
    if (operation?.startup_operation_id !== startupOperationId) return this.taskStartup({ taskId, sourceSessionId });
    if (!this.taskStartup({ taskId, sourceSessionId }).canRetry) {
      throw startContractError("START_RETRY_UNAVAILABLE", "Startup is not safely recoverable; inspect its current state first.");
    }
    try {
      await this.start({ taskId, sourceSessionId, assigneeAgentId: operation.assignee_agent_id,
        expectedTaskVersion: Number(task.resource_version), providerId: operation.provider_id,
        idempotencyKey: `retry:${startupOperationId}`, title: task.title,
        ...(operation.requested_model != null ? { model: operation.requested_model } : {}),
        ...(operation.requested_reasoning_level != null ? { reasoningLevel: operation.requested_reasoning_level } : {}),
        // Recovery establishes a Session only; it never resends a failed prompt.
        dispatchInitialTurn: false });
    } catch (error) {
      if (error.code !== "START_ALREADY_IN_PROGRESS" && error.startup?.status !== "failed") throw error;
    }
    return this.taskStartup({ taskId, sourceSessionId });
  }

  #recoveryScope(taskId, sourceSessionId) {
    const task = this.store.getTask(taskId);
    const source = resolveSourceSession(this.store, sourceSessionId);
    if (!source || source.logical.archived || source.logical.activeBinding?.state !== "active") {
      throw startContractError("SOURCE_SESSION_NOT_FOUND", "The source Session is not active.");
    }
    if (!task || task.work_id !== source.session.workId
      || source.session.sessionKind === "worker" && ![task.id, task.parent_task_id].includes(source.session.taskId)) {
      throw startContractError("TASK_OUTSIDE_WORK", "Task is outside the source Session scope.");
    }
    const work = this.store.getWork(task.work_id);
    if (!(work?.contributorAgentIds ?? []).includes(task.main_agent_id)) {
      throw startContractError("AGENT_OUTSIDE_WORK", "The Task assignee is no longer a Work contributor.");
    }
    const operation = this.store.selectOne(`SELECT * FROM work_session_startup_operations
      WHERE task_id=? ORDER BY rowid DESC LIMIT 1`, [taskId]);
    return { task, operation };
  }

  getSessionBinding(logicalSessionId) {
    try {
      return this.coordinator.getSessionBinding(logicalSessionId);
    } catch (error) {
      if (error?.code !== "START_REFERENCE_INVALID" || !this.managedSandboxCoordinator) throw error;
      return this.managedSandboxCoordinator.getSessionBinding(logicalSessionId);
    }
  }

  authorize(input) {
    const command = decodeWorkSessionStartCommand(input);
    const source = resolveSourceSession(this.store, command.sourceSessionId);
    if (!source || source.logical?.archived || source.logical?.activeBinding?.state !== "active") {
      throw startContractError("SOURCE_SESSION_NOT_FOUND", "The authenticated source Session is not active.");
    }
    const task = this.store.getTask(command.taskId);
    if (!task) throw startContractError("TASK_NOT_FOUND", "Task was not found.");
    if (!source.session?.workId || source.session.workId !== task.work_id) {
      throw startContractError("TASK_OUTSIDE_WORK", "Task is outside the source Session Work scope.");
    }
    const existing = this.store.selectOne(
      `SELECT expected_task_version FROM work_session_startup_operations
       WHERE task_id=? AND idempotency_key=?`,
      [command.taskId, command.idempotencyKey]
    );
    const managedExisting = this.store.selectOne(
      `SELECT request_fingerprint FROM execution_spaces
       WHERE task_id=? AND idempotency_key=?`,
      [command.taskId, command.idempotencyKey]
    );
    const idempotentReplay = (existing
      && Number(existing.expected_task_version) === command.expectedTaskVersion)
      || Boolean(managedExisting);
    if (Number(task.resource_version ?? 1) !== command.expectedTaskVersion && !idempotentReplay) {
      throw startContractError(
        "TASK_VERSION_CONFLICT",
        `Expected Task version ${command.expectedTaskVersion}, current version is ${task.resource_version ?? 1}.`
      );
    }
    const work = this.store.getWork(task.work_id);
    if (!work) throw startContractError("TASK_OUTSIDE_WORK", "Task Work was not found.");
    const agent = this.store.getAgent(command.assigneeAgentId);
    if (!agent) throw startContractError("AGENT_NOT_FOUND", "Assignee Agent was not found.");
    if (!(work.contributorAgentIds ?? []).includes(command.assigneeAgentId)) {
      throw startContractError("AGENT_OUTSIDE_WORK", "Assignee Agent is not an Work contributor.");
    }
    const workspaceContext = this.store.getTaskWorkspaceContext(task);
    const repositoryId = workspaceContext?.repository?.id;
    if (!workspaceContext?.workspace) {
      throw startContractError("WORKSPACE_NOT_FOUND", "Work Workspace was not found.");
    }
    const workspaceRootPath = workspaceContext.workspace.canonicalRootPath
      ?? workspaceContext.workspace.rootPath
      ?? null;
    const executionStrategy = repositoryId ? "gitWorktree" : "managedSandbox";
    if (!repositoryId && (!workspaceRootPath || workspaceContext.workspace.status !== "ready")) {
      throw startContractError("WORKSPACE_UNAVAILABLE", "Non-Git Workspace is not ready for managed Sandbox execution.");
    }
    const providerId = this.resolveProviderId(command.providerId);
    if (!providerId) {
      throw startContractError("PROVIDER_CAPABILITY_UNAVAILABLE", "Agent Provider was not found.");
    }
    const requiredCapabilities = [
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND
    ];
    if (executionStrategy === "gitWorktree") {
      requiredCapabilities.push(AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND);
    }
    for (const capability of requiredCapabilities) {
      if (!this.providerRegistry.supports(providerId, capability)) {
        const error = startContractError(
          "PROVIDER_CAPABILITY_UNAVAILABLE",
          `Agent Provider does not support the required Work Session capability: ${capability}.`
        );
        error.stage = "provider_validation";
        throw error;
      }
    }
    return Object.freeze({
      ...command,
      providerId,
      workId: task.work_id,
      repositoryId,
      workspaceId: workspaceContext.workspace.workspaceId,
      workspaceRootPath,
      workspaceUpdatedAt: workspaceContext.workspace.updatedAt,
      executionStrategy,
      taskTitle: task.title
    });
  }
}

function resolveSourceSession(store, sourceSessionId) {
  const logical = store.getLogicalSession(sourceSessionId)
    ?? store.getLogicalSessionByLegacySessionId(sourceSessionId);
  const session = logical?.legacySessionId
    ? store.getSession(logical.legacySessionId)
    : store.getSession(sourceSessionId);
  const resolvedLogical = logical ?? (session ? store.getLogicalSessionByLegacySessionId(session.id) : null);
  return session && resolvedLogical ? { session, logical: resolvedLogical } : null;
}
