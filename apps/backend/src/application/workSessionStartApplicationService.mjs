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
    this.providerRegistry = options.providerRegistry;
    this.resolveProviderId = options.resolveProviderId ?? ((value) => value);
    if (!this.store || !this.coordinator || !this.providerRegistry) {
      throw new TypeError("WorkSessionStartApplicationService requires store, coordinator, and providerRegistry.");
    }
  }

  async start(input) {
    const command = decodeWorkSessionStartCommand(input);
    const authorized = this.authorize(command);
    return this.coordinator.start({ ...command, providerId: authorized.providerId });
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
    const idempotentReplay = existing
      && Number(existing.expected_task_version) === command.expectedTaskVersion;
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
    if (agent.role !== "independentContributor") {
      throw startContractError("AGENT_NOT_INDEPENDENT_CONTRIBUTOR", "Assignee Agent must be an Independent Contributor.");
    }
    const workspaceContext = this.store.getTaskWorkspaceContext(task);
    const repositoryId = workspaceContext?.repository?.id;
    if (!workspaceContext?.workspace) {
      throw startContractError("WORKSPACE_NOT_FOUND", "Work Workspace was not found.");
    }
    if (!repositoryId) {
      throw startContractError(
        "WORKSPACE_CAPABILITY_UNAVAILABLE",
        "Work Workspace does not provide the Git capability required by this execution strategy."
      );
    }
    const providerId = this.resolveProviderId(command.providerId);
    if (!providerId) {
      throw startContractError("PROVIDER_CAPABILITY_UNAVAILABLE", "Agent Provider was not found.");
    }
    for (const capability of [
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND
    ]) {
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
