// Authenticated Session-scoped Task commands. Agent IDs here are binding
// resources from the existing tool contract, not independent authorization actors.
export function createSessionTaskCommands({
  store, collaborationCore, workService, taskCompletionService, presentTaskForClient
}) {
  function reportTaskAcceptanceForAgent(agentId, input = {}, metadata = {}) {
    const { sessionId, task } = resolveBoundTaskForAgent(agentId, metadata, "Task acceptance");
    return presentTaskForClient(workService.recordAcceptanceAssessment(task.id, {
      sourceSessionId: sessionId,
      results: input.results
    }));
  }

  function getBoundTaskForAgent(agentId, _input = {}, metadata = {}) {
    return presentTaskForClient(resolveBoundTaskForAgent(agentId, metadata, "Bound Task read").task);
  }

  function resolveBoundTaskForAgent(agentId, metadata = {}, operation = "Task operation") {
    const requestedSessionId = String(metadata.sessionId ?? "").trim();
    if (!requestedSessionId) {
      const error = new Error(`${operation} requires the authenticated Session scope.`);
      error.code = "SESSION_SCOPE_REQUIRED";
      throw error;
    }
    const logical = store.getLogicalSession(requestedSessionId)
      ?? store.getLogicalSessionByLegacySessionId(requestedSessionId);
    const sessionId = logical?.legacySessionId ?? requestedSessionId;
    const boundAgent = collaborationCore.getAgentForSession(sessionId);
    if (boundAgent?.agentId !== agentId) {
      const error = new Error("The authenticated Agent is not bound to the scoped Session.");
      error.code = "SESSION_ACTOR_MISMATCH";
      throw error;
    }
    const session = store.getSession(sessionId);
    const taskId = session?.taskId;
    if (!taskId) {
      const error = new Error("The active Agent Session is not bound to a Task.");
      error.code = "TASK_REQUIRED";
      throw error;
    }
    if (metadata.taskId && metadata.taskId !== taskId) {
      const error = new Error("The authenticated Task scope does not match the Session binding.");
      error.code = "TASK_SESSION_MISMATCH";
      throw error;
    }
    const task = store.getTask(taskId);
    if (!task) {
      const error = new Error("The bound Task no longer exists.");
      error.code = "TASK_NOT_FOUND";
      throw error;
    }
    return { sessionId, task };
  }

  function reviseTaskForSession(agentId, input = {}, metadata = {}) {
    if (typeof input.sourceMessageId !== "string" || !input.sourceMessageId.trim()) {
      const error = new Error("Model-initiated Task revision requires the originating direct user message id.");
      error.code = "TASK_REVISION_SOURCE_REQUIRED";
      throw error;
    }
    const requestedSessionId = String(metadata.sessionId ?? "").trim();
    if (!requestedSessionId) {
      const error = new Error("Task revision requires the authenticated Session scope.");
      error.code = "SESSION_SCOPE_REQUIRED";
      throw error;
    }
    const logical = store.getLogicalSession(requestedSessionId)
      ?? store.getLogicalSessionByLegacySessionId(requestedSessionId);
    const sessionId = logical?.legacySessionId ?? requestedSessionId;
    const session = store.getSession(sessionId);
    const boundAgent = session ? collaborationCore.getAgentForSession(sessionId) : null;
    if (!session || (session.agentId !== agentId && boundAgent?.agentId !== agentId)) {
      const error = new Error("The authenticated Agent is not bound to the scoped Session.");
      error.code = "SESSION_ACTOR_MISMATCH";
      throw error;
    }
    if (!session.taskId || (metadata.taskId && metadata.taskId !== session.taskId)) {
      const error = new Error("The authenticated Task scope does not match the Session binding.");
      error.code = "TASK_SESSION_MISMATCH";
      throw error;
    }
    const result = workService.reviseTask(session.taskId, {
      ...input,
      createdBySessionId: session.id
    });
    return {
      task: presentTaskForClient(result.task),
      snapshot: result.snapshot
    };
  }

  function completeTaskForSession(agentId, input = {}, metadata = {}) {
    const requestedSessionId = String(metadata.sessionId ?? "").trim();
    const logicalSessionId = String(metadata.logicalSessionId ?? "").trim();
    if (!requestedSessionId || !logicalSessionId) {
      const error = new Error("Task completion requires an authenticated logical Session scope.");
      error.code = "SESSION_SCOPE_REQUIRED";
      throw error;
    }
    const session = store.getSession(requestedSessionId);
    const boundAgent = session ? collaborationCore.getAgentForSession(session.id) : null;
    if (!session || (session.agentId !== agentId && boundAgent?.agentId !== agentId)) {
      const error = new Error("The authenticated Session actor does not match this Tool Host call.");
      error.code = "SESSION_ACTOR_MISMATCH";
      throw error;
    }
    const result = taskCompletionService.completeFromSession(input, {
      ...metadata,
      sessionId: requestedSessionId,
      logicalSessionId
    });
    return {
      task: presentTaskForClient(result.task),
      operation: result.operation,
      idempotentReplay: result.idempotentReplay
    };
  }

  return {
    reportTaskAcceptanceForAgent, getBoundTaskForAgent,
    reviseTaskForSession, completeTaskForSession
  };
}
