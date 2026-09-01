export class WorkspaceContinuationCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.resolveAgent = options.resolveAgent;
    this.enqueueWork = options.enqueueWork;
    this.scheduleDrain = options.scheduleDrain;
    this.onEvent = options.onEvent ?? (() => {});
    if (!this.store) throw new TypeError("WorkspaceContinuationCoordinator requires a store.");
    if (typeof this.resolveAgent !== "function") throw new TypeError("WorkspaceContinuationCoordinator requires resolveAgent().");
    if (typeof this.enqueueWork !== "function") throw new TypeError("WorkspaceContinuationCoordinator requires enqueueWork().");
    if (typeof this.scheduleDrain !== "function") throw new TypeError("WorkspaceContinuationCoordinator requires scheduleDrain().");
  }

  enqueueForTransition(transitionId) {
    const transition = this.store.getWorkspaceTransition(transitionId);
    if (!transition?.continuationPrompt || transition.phase !== "committed") return null;
    if (transition.continuationState === "completed") return null;
    const logical = this.requireCommittedRoute(transition);
    const ownership = this.store.assertLogicalWorkSessionBinding(transition.logicalSessionId);
    const sessionId = logical.legacySessionId;
    const agent = this.resolveAgent(sessionId);
    if (!agent) throw new Error(`Session ${sessionId} has no Agent identity for workspace continuation.`);
    if (ownership.agentId && ownership.agentId !== agent.agentId) {
      throw new Error(`Session ${sessionId} is no longer bound to the Task Agent.`);
    }
    const source = {
      type: "workspace-continuation",
      transitionId,
      logicalSessionId: transition.logicalSessionId,
      routingVersion: logical.routingVersion,
      bindingId: logical.activeBinding.bindingId,
      providerSessionId: logical.activeBinding.providerSessionId,
      productSessionId: sessionId,
      taskId: ownership.taskId,
      localVisibility: "status_only"
    };
    let task = this.enqueueWork({
      taskId: continuationTaskId(transitionId),
      agentId: agent.agentId,
      sessionId,
      kind: "user",
      priority: 200,
      text: transition.continuationPrompt,
      source,
      localVisibility: "status_only",
      createdAt: transition.updatedAt
    });
    if (task && !sameWorkTarget(task.source, source)) {
      task = this.store.updateAgentTask(task.taskId, { source });
    }
    const state = task?.status === "running" ? "running" : "queued";
    this.store.updateWorkspaceTransitionContinuation(transitionId, {
      state,
      turnId: task?.targetTurnId ?? null,
      error: null
    });
    this.onEvent("WorkspaceContinuationQueued", { transition, logicalSession: logical, task });
    this.scheduleDrain(sessionId);
    return task;
  }

  assertWorkTarget(task) {
    const transitionId = continuationTransitionId(task);
    if (!transitionId) return null;
    const transition = this.store.getWorkspaceTransition(transitionId);
    if (!transition || transition.phase !== "committed") {
      throw new Error(`Workspace continuation ${transitionId} no longer has a committed transition.`);
    }
    const logical = this.requireCommittedRoute(transition);
    const ownership = this.store.assertLogicalWorkSessionBinding(transition.logicalSessionId);
    const source = task.source ?? {};
    if (task.sessionId !== logical.legacySessionId
      || source.productSessionId !== logical.legacySessionId
      || source.logicalSessionId !== logical.logicalSessionId
      || source.routingVersion !== logical.routingVersion
      || source.bindingId !== logical.activeBinding.bindingId
      || source.providerSessionId !== logical.activeBinding.providerSessionId
      || (source.taskId ?? null) !== (ownership.taskId ?? null)) {
      const error = new Error("The workspace continuation target changed before dispatch.");
      error.code = "STALE_WORKSPACE_CONTINUATION";
      throw error;
    }
    return { logical, ownership };
  }

  requireCommittedRoute(transition) {
    const logical = this.store.getLogicalSession(transition.logicalSessionId);
    if (!logical?.activeBinding
      || logical.routingVersion !== transition.sourceRoutingVersion + 1
      || logical.activeThreadId !== transition.newThreadId) {
      throw new Error("The committed workspace route does not match its continuation checkpoint.");
    }
    return logical;
  }

  recover() {
    const results = [];
    for (const transition of this.store.listWorkspaceTransitionsAwaitingContinuation()) {
      const task = this.store.getAgentTask(continuationTaskId(transition.transitionId));
      if (task?.status === "completed") {
        this.store.updateWorkspaceTransitionContinuation(transition.transitionId, {
          state: "completed",
          turnId: task.targetTurnId,
          error: null
        });
        continue;
      }
      try {
        this.requireCommittedRoute(transition);
        this.store.assertLogicalWorkSessionBinding(transition.logicalSessionId);
      } catch (error) {
        if (task && ["queued", "running"].includes(task.status)) {
          this.store.updateAgentTask(task.taskId, {
            status: "failed",
            lastError: error.message
          });
        }
        this.store.updateWorkspaceTransitionContinuation(transition.transitionId, {
          state: "failed",
          turnId: task?.targetTurnId ?? null,
          error: error.message
        });
        this.onEvent("WorkspaceContinuationSuperseded", {
          transitionId: transition.transitionId,
          error: error.message
        });
        continue;
      }
      if (task?.status === "failed" || task?.status === "cancelled") {
        this.store.updateAgentTask(task.taskId, {
          status: "queued",
          startedAt: null,
          completedAt: null,
          targetTurnId: null,
          lastError: null
        });
      }
      try {
        results.push(this.enqueueForTransition(transition.transitionId));
      } catch (error) {
        this.onEvent("WorkspaceContinuationDeferred", {
          transitionId: transition.transitionId,
          error: error.message
        });
      }
    }
    return results.filter(Boolean);
  }

  recordWorkRequeued(task) {
    const transitionId = continuationTransitionId(task);
    if (!transitionId) return;
    this.store.updateWorkspaceTransitionContinuation(transitionId, {
      state: "queued",
      turnId: null,
      error: task.lastError ?? null
    });
    this.onEvent("WorkspaceContinuationQueued", { transitionId, task });
  }

  recordWorkStarted(task) {
    const transitionId = continuationTransitionId(task);
    if (!transitionId) return;
    this.store.updateWorkspaceTransitionContinuation(transitionId, {
      state: "running",
      turnId: task.targetTurnId ?? null,
      error: null
    });
    this.onEvent("WorkspaceContinuationStarted", { transitionId, task });
  }

  recordWorkSettled(task) {
    const transitionId = continuationTransitionId(task);
    if (!transitionId) return;
    const state = task.status === "completed" ? "completed" : "failed";
    this.store.updateWorkspaceTransitionContinuation(transitionId, {
      state,
      turnId: task.targetTurnId ?? null,
      error: task.lastError ?? null
    });
    this.onEvent(state === "completed" ? "WorkspaceContinuationCompleted" : "WorkspaceContinuationFailed", {
      transitionId,
      task
    });
  }
}

export function continuationTaskId(transitionId) {
  return `workspace-continuation:${transitionId}`;
}

function continuationTransitionId(task) {
  return task?.source?.type === "workspace-continuation"
    ? task.source.transitionId
    : null;
}

function sameWorkTarget(actual, expected) {
  return actual?.type === expected.type
    && actual.transitionId === expected.transitionId
    && actual.logicalSessionId === expected.logicalSessionId
    && actual.routingVersion === expected.routingVersion
    && actual.bindingId === expected.bindingId
    && actual.providerSessionId === expected.providerSessionId
    && actual.productSessionId === expected.productSessionId
    && (actual.taskId ?? null) === (expected.taskId ?? null);
}
