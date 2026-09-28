// Scheduler authorization and queue handoff; all binding checks are performed
// against current persisted state on each call, including paired-device grants.
export function createScheduledSessionBoundary({
  store, environmentName, collaborationCore, canDeliverScheduledMessage,
  registerRuntimeQueuedWork, runtimeQueuePosition, emitEvent, scheduleAgentWorkDrain
}) {
  function authorizeScheduledSessionTask({ actor, logicalSessionId, environment }) {
    if (environment !== environmentName) {
      const error = new Error("计划任务 belongs to another Corptie environment.");
      error.code = "ENVIRONMENT_MISMATCH";
      throw error;
    }
    const logical = store.getLogicalSession(logicalSessionId);
    if (!logical) {
      const error = new Error(`Logical Session ${logicalSessionId} does not exist.`);
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    const session = logical.legacySessionId ? store.getSession(logical.legacySessionId) : null;
    if (!session) {
      const error = new Error(`Logical Session ${logicalSessionId} has no current Session projection.`);
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    if (actor.type === "user" && actor.id === "user:local-macos") {
      return { workId: session.workId ?? null, session };
    }
    // A paired client acts for its user, never impersonates a Session or local admin.
    // Recheck durable device authority on each scheduler operation/delivery.
    if (actor.type === "user" && actor.id?.startsWith("user:paired-device:")
        && canDeliverScheduledMessage(actor.id.slice("user:paired-device:".length))) {
      return { workId: session.workId ?? null, session };
    }
    const actorAgent = actor.type === "agent" ? store.getAgent(actor.id) : null;
    const boundAgent = collaborationCore.getAgentForSession(session.id);
    if (!actorAgent || boundAgent?.agentId !== actorAgent.agentId) {
      const error = new Error(`Actor ${actor.id} is not authorized for logical Session ${logicalSessionId}.`);
      error.code = "AUTHORIZATION_REVOKED";
      throw error;
    }
    return { workId: session.workId ?? null, session };
  }

  function enqueueScheduledSessionWork(input) {
    const { task, inserted } = store.enqueueAgentTaskWithResult(input);
    const deliveryId = input.source?.deliveryId ?? input.taskId;
    console.info(
      `[automation-delivery] result=${inserted ? "inserted" : "deduplicated"}`
      + ` taskId=${input.source?.scheduledTaskId ?? "unknown"}`
      + ` scheduledFor=${input.source?.scheduledFor ?? "unknown"}`
      + ` deliveryId=${deliveryId}`
    );
    if (!inserted) return { task, inserted };
    registerRuntimeQueuedWork(input.sessionId, task.taskId);
    const queuePosition = runtimeQueuePosition(input.sessionId, task.taskId);
    emitEvent("AgentWorkQueued", {
      sessionId: input.sessionId,
      task,
      queuePosition,
      source: task.source
    }, { sessionId: input.sessionId, source: task.source });
    scheduleAgentWorkDrain(input.sessionId, null, task.taskId);
    return { task, inserted };
  }

  function scheduledSessionHttpActor(request) {
    const agentId = typeof request.headers["x-corptie-agent-id"] === "string"
      ? request.headers["x-corptie-agent-id"].trim()
      : "";
    if (agentId) return { type: "agent", id: agentId };
    const address = request.socket?.remoteAddress ?? "";
    if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) {
      return { type: "user", id: "user:local-macos" };
    }
    const error = new Error("计划任务 API requires an authenticated local client or Agent identity.");
    error.code = "ACTOR_REQUIRED";
    throw error;
  }

  function scheduledSessionHttpLogicalSessionId(request) {
    const sessionId = typeof request.headers["x-corptie-session-id"] === "string"
      ? request.headers["x-corptie-session-id"].trim()
      : "";
    if (!sessionId) return null;
    const logical = store.getLogicalSession(sessionId)
      ?? store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) {
      const error = new Error(`Logical Session not found for authenticated Session ${sessionId}.`);
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    return logical.logicalSessionId;
  }

  return {
    authorizeScheduledSessionTask, enqueueScheduledSessionWork,
    scheduledSessionHttpActor, scheduledSessionHttpLogicalSessionId
  };
}
