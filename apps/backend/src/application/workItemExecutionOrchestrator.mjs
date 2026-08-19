const COMPLETED_WORK_ITEM_STATES = new Set(["done", "complete", "completed"]);

export class WorkItemExecutionOrchestratorError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "WorkItemExecutionOrchestratorError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Owns the product-level start/recovery sequence. Git preparation is kept
// provider-neutral; only an existing Session's route transition and resume are
// delegated to the shared Agent Provider contracts.
export class WorkItemExecutionOrchestrator {
  constructor(options = {}) {
    this.getWorkItem = options.getWorkItem;
    this.getSession = options.getSession;
    this.getSessionRoute = options.getSessionRoute;
    this.ensureWorkspace = options.ensureWorkspace;
    this.switchWorkspace = options.switchWorkspace;
    this.restoreSessionRoute = options.restoreSessionRoute ?? (() => {});
    this.resumeSession = options.resumeSession;
    this.updateWorkItem = options.updateWorkItem;
    this.onChanged = options.onChanged ?? (() => {});
    for (const method of [
      "getWorkItem",
      "getSession",
      "getSessionRoute",
      "ensureWorkspace",
      "switchWorkspace",
      "resumeSession",
      "updateWorkItem"
    ]) {
      if (typeof this[method] !== "function") {
        throw new TypeError(`WorkItemExecutionOrchestrator requires ${method}().`);
      }
    }
  }

  prepareWorkspace(workItem, session = null) {
    return this.ensureWorkspace({ workItem, session });
  }

  async restore(workItemId) {
    const workItem = this.getWorkItem(requiredText(workItemId, "workItemId"));
    if (!workItem) {
      throw new WorkItemExecutionOrchestratorError(
        "WORK_ITEM_NOT_FOUND",
        `WorkItem not found: ${workItemId}`,
        404
      );
    }
    if (!COMPLETED_WORK_ITEM_STATES.has(String(workItem.status ?? ""))) {
      throw new WorkItemExecutionOrchestratorError(
        "WORK_ITEM_NOT_COMPLETED",
        "Only a completed WorkItem can be restored.",
        409
      );
    }
    const sessionId = requiredOptionalText(workItem.current_session_id);
    const session = sessionId ? this.getSession(sessionId) : null;
    if (!session) {
      throw new WorkItemExecutionOrchestratorError(
        "WORK_ITEM_SESSION_REQUIRED",
        "The completed WorkItem has no bound Session to restore.",
        409
      );
    }

    const route = this.getSessionRoute(session.id);
    if (!route?.activeBinding) {
      throw new WorkItemExecutionOrchestratorError(
        "WORK_ITEM_SESSION_ROUTE_REQUIRED",
        "The bound Session has no recoverable Workspace route.",
        409
      );
    }
    const workspace = await this.ensureWorkspace({ workItem, session });

    let transition = null;
    const activePath = requiredOptionalText(route.activeBinding.boundCwd);
    if (workspace.requiresSessionTransition === true
      || route.activeWorkspaceId !== workspace.worktreeId
      || activePath !== workspace.path) {
      transition = await this.switchWorkspace(session.id, workspace.worktreeId);
      if (transition?.status === "waitingForTurn") {
        throw new WorkItemExecutionOrchestratorError(
          "WORK_ITEM_SESSION_BUSY",
          "The bound Session is still processing. Wait for it to become idle before restoring this WorkItem.",
          409
        );
      }
    }

    await this.restoreSessionRoute(session.id);
    const resumedSession = await this.resumeSession(session.id);
    const updatedWorkItem = this.updateWorkItem(workItem.id, {
      status: "in_progress",
      executionStatus: "idle",
      acceptanceAssessment: null
    });
    this.onChanged("WorkItemChanged", {
      action: "execution-restored",
      entity: updatedWorkItem
    });
    return { workItem: updatedWorkItem, session: resumedSession, workspace, transition };
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
