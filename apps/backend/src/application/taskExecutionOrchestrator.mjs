const COMPLETED_TASK_STATES = new Set(["done"]);

export class TaskExecutionOrchestratorError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "TaskExecutionOrchestratorError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Owns the product-level start/recovery sequence. Git preparation is kept
// provider-neutral; only an existing Session's route transition and resume are
// delegated to the shared Agent Provider contracts.
export class TaskExecutionOrchestrator {
  constructor(options = {}) {
    this.getTask = options.getTask;
    this.getSession = options.getSession;
    this.getSessionRoute = options.getSessionRoute;
    this.ensureWorkspace = options.ensureWorkspace;
    this.switchWorkspace = options.switchWorkspace;
    this.restoreSessionRoute = options.restoreSessionRoute ?? (() => {});
    this.resumeSession = options.resumeSession;
    this.updateTask = options.updateTask;
    this.onChanged = options.onChanged ?? (() => {});
    for (const method of [
      "getTask",
      "getSession",
      "getSessionRoute",
      "ensureWorkspace",
      "switchWorkspace",
      "resumeSession",
      "updateTask"
    ]) {
      if (typeof this[method] !== "function") {
        throw new TypeError(`TaskExecutionOrchestrator requires ${method}().`);
      }
    }
  }

  prepareWorkspace(task, session = null) {
    return this.ensureWorkspace({ task, session });
  }

  async restore(taskId) {
    const task = this.getTask(requiredText(taskId, "taskId"));
    if (!task) {
      throw new TaskExecutionOrchestratorError(
        "TASK_NOT_FOUND",
        `Task not found: ${taskId}`,
        404
      );
    }
    if (!COMPLETED_TASK_STATES.has(String(task.lifecycle_state ?? ""))) {
      throw new TaskExecutionOrchestratorError(
        "TASK_NOT_COMPLETED",
        "Only a completed Task can be restored.",
        409
      );
    }
    const sessionId = requiredOptionalText(task.current_session_id);
    const session = sessionId ? this.getSession(sessionId) : null;
    if (!session) {
      throw new TaskExecutionOrchestratorError(
        "TASK_SESSION_REQUIRED",
        "The completed Task has no bound Session to restore.",
        409
      );
    }

    const route = this.getSessionRoute(session.id);
    if (!route?.activeBinding) {
      throw new TaskExecutionOrchestratorError(
        "TASK_SESSION_ROUTE_REQUIRED",
        "The bound Session has no recoverable Workspace route.",
        409
      );
    }
    const workspace = await this.ensureWorkspace({ task, session });

    let transition = null;
    const activePath = requiredOptionalText(route.activeBinding.boundCwd);
    if (workspace.requiresSessionTransition === true
      || route.activeWorkspaceId !== workspace.worktreeId
      || activePath !== workspace.path) {
      transition = await this.switchWorkspace(session.id, workspace.worktreeId);
      if (transition?.status === "waitingForTurn") {
        throw new TaskExecutionOrchestratorError(
          "TASK_SESSION_BUSY",
          "The bound Session is still processing. Wait for it to become idle before restoring this Task.",
          409
        );
      }
    }

    await this.restoreSessionRoute(session.id);
    const resumedSession = await this.resumeSession(session.id);
    const updatedTask = this.updateTask(task.id, {
      lifecycleState: "in_progress",
      executionStatus: "idle",
      acceptanceAssessment: null
    });
    this.onChanged("TaskChanged", {
      action: "execution-restored",
      entity: updatedTask
    });
    return { task: updatedTask, session: resumedSession, workspace, transition };
  }
}

function requiredText(value, field) {
  const text = requiredOptionalText(value);
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}

function requiredOptionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
