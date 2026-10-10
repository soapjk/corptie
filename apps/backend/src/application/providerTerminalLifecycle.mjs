export function createProviderTerminalLifecycle({
  store, emitEvent, recordWorkSettled, settleEntityTaskFromSession,
  collaborationCore, refreshWorkspaceInventoryAfterTurn,
  continuePendingWorkspaceTransition, continuePendingProviderSwitch,
  resumeWorkAfterTransition, scheduleAgentWorkDrain
}) {
  return function handleCommittedProviderTerminalLifecycle({ event, projection, logicalRoute }) {
    const nextSession = projection?.session;
    if (!nextSession) return;
    const terminal = ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type);
    if (!terminal) return;
    const terminalStatus = projection?.terminalStatus
      ?? (event.type === "turn.failed" ? "failed" : (event.type === "turn.cancelled" ? "cancelled" : "completed"));
    const failed = terminalStatus === "failed";
    const cancelled = terminalStatus === "cancelled";

    const completedWork = store.getAgentTaskForTurn(nextSession.id, event.turnId)
      ?? store.getRunningAgentTaskForSession(nextSession.id);
    if (completedWork?.status === "running") {
      const updatedWork = store.updateAgentTask(completedWork.taskId, {
        status: failed ? "failed" : (cancelled ? "cancelled" : "completed"),
        lastError: projection?.terminalFailure?.message ?? event.payload?.error?.message ?? null
      });
      emitEvent("AgentWorkCompleted", { sessionId: nextSession.id, task: updatedWork }, {
        sessionId: nextSession.id,
        source: completedWork.source
      });
      recordWorkSettled(updatedWork);
    }
    settleEntityTaskFromSession(nextSession);
    // Recovered execution state does not prove the final business result was
    // delivered. Require user review before advancing queued work.
    if (event.payload?.suppressAutomaticContinuation === true) return;
    const agent = collaborationCore.getAgentForSession(nextSession.id);
    if (!failed && !cancelled) {
      refreshWorkspaceInventoryAfterTurn(logicalRoute);
      const continuation = continuePendingWorkspaceTransition(logicalRoute, event.turnId);
      const providerSwitch = continuePendingProviderSwitch(logicalRoute);
      resumeWorkAfterTransition(continuation, () => {
        scheduleAgentWorkDrain(nextSession.id);
      });
      if (providerSwitch) providerSwitch.then(() => scheduleAgentWorkDrain(nextSession.id));
    } else if (agent) {
      scheduleAgentWorkDrain(nextSession.id);
    }
  };
}
