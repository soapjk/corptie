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
      throw new Error(`Session ${sessionId} is no longer bound to the WorkItem Agent.`);
    }
    const source = {
      type: "workspace-continuation",
      transitionId,
      logicalSessionId: transition.logicalSessionId,
      routingVersion: logical.routingVersion,
      bindingId: logical.activeBinding.bindingId,
      providerSessionId: logical.activeBinding.providerSessionId,
      productSessionId: sessionId,
      workItemId: ownership.workItemId,
      localVisibility: "status_only"
    };
    let workItem = this.enqueueWork({
      workItemId: continuationWorkItemId(transitionId),
      agentId: agent.agentId,
      sessionId,
      kind: "user",
      priority: 200,
      text: transition.continuationPrompt,
      source,
      localVisibility: "status_only",
      createdAt: transition.updatedAt
    });
    if (workItem && !sameWorkTarget(workItem.source, source)) {
      workItem = this.store.updateAgentWorkItem(workItem.workItemId, { source });
    }
    const state = workItem?.status === "running" ? "running" : "queued";
    this.store.updateWorkspaceTransitionContinuation(transitionId, {
      state,
      turnId: workItem?.targetTurnId ?? null,
      error: null
    });
    this.onEvent("WorkspaceContinuationQueued", { transition, logicalSession: logical, workItem });
    this.scheduleDrain(agent.agentId);
    return workItem;
  }

  assertWorkTarget(workItem) {
    const transitionId = continuationTransitionId(workItem);
    if (!transitionId) return null;
    const transition = this.store.getWorkspaceTransition(transitionId);
    if (!transition || transition.phase !== "committed") {
      throw new Error(`Workspace continuation ${transitionId} no longer has a committed transition.`);
    }
    const logical = this.requireCommittedRoute(transition);
    const ownership = this.store.assertLogicalWorkSessionBinding(transition.logicalSessionId);
    const source = workItem.source ?? {};
    if (workItem.sessionId !== logical.legacySessionId
      || source.productSessionId !== logical.legacySessionId
      || source.logicalSessionId !== logical.logicalSessionId
      || source.routingVersion !== logical.routingVersion
      || source.bindingId !== logical.activeBinding.bindingId
      || source.providerSessionId !== logical.activeBinding.providerSessionId
      || (source.workItemId ?? null) !== (ownership.workItemId ?? null)) {
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
      const workItem = this.store.getAgentWorkItem(continuationWorkItemId(transition.transitionId));
      if (workItem?.status === "completed") {
        this.store.updateWorkspaceTransitionContinuation(transition.transitionId, {
          state: "completed",
          turnId: workItem.targetTurnId,
          error: null
        });
        continue;
      }
      try {
        this.requireCommittedRoute(transition);
        this.store.assertLogicalWorkSessionBinding(transition.logicalSessionId);
      } catch (error) {
        if (workItem && ["queued", "running"].includes(workItem.status)) {
          this.store.updateAgentWorkItem(workItem.workItemId, {
            status: "failed",
            lastError: error.message
          });
        }
        this.store.updateWorkspaceTransitionContinuation(transition.transitionId, {
          state: "failed",
          turnId: workItem?.targetTurnId ?? null,
          error: error.message
        });
        this.onEvent("WorkspaceContinuationSuperseded", {
          transitionId: transition.transitionId,
          error: error.message
        });
        continue;
      }
      if (workItem?.status === "failed" || workItem?.status === "cancelled") {
        this.store.updateAgentWorkItem(workItem.workItemId, {
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

  recordWorkRequeued(workItem) {
    const transitionId = continuationTransitionId(workItem);
    if (!transitionId) return;
    this.store.updateWorkspaceTransitionContinuation(transitionId, {
      state: "queued",
      turnId: null,
      error: workItem.lastError ?? null
    });
    this.onEvent("WorkspaceContinuationQueued", { transitionId, workItem });
  }

  recordWorkStarted(workItem) {
    const transitionId = continuationTransitionId(workItem);
    if (!transitionId) return;
    this.store.updateWorkspaceTransitionContinuation(transitionId, {
      state: "running",
      turnId: workItem.targetTurnId ?? null,
      error: null
    });
    this.onEvent("WorkspaceContinuationStarted", { transitionId, workItem });
  }

  recordWorkSettled(workItem) {
    const transitionId = continuationTransitionId(workItem);
    if (!transitionId) return;
    const state = workItem.status === "completed" ? "completed" : "failed";
    this.store.updateWorkspaceTransitionContinuation(transitionId, {
      state,
      turnId: workItem.targetTurnId ?? null,
      error: workItem.lastError ?? null
    });
    this.onEvent(state === "completed" ? "WorkspaceContinuationCompleted" : "WorkspaceContinuationFailed", {
      transitionId,
      workItem
    });
  }
}

export function continuationWorkItemId(transitionId) {
  return `workspace-continuation:${transitionId}`;
}

function continuationTransitionId(workItem) {
  return workItem?.source?.type === "workspace-continuation"
    ? workItem.source.transitionId
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
    && (actual.workItemId ?? null) === (expected.workItemId ?? null);
}
