export function createProviderTerminalLifecycle({
  store, emitEvent, recordWorkSettled, sessionMailbox, settleEntityTaskFromSession,
  collaborationCore,
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

    const runningWork = store.getRunningAgentTaskForSession(nextSession.id);
    const completedWork = store.getAgentTaskForTurn(nextSession.id, event.turnId)
      ?? (runningWork && (!runningWork.targetTurnId || runningWork.targetTurnId === event.turnId) ? runningWork : null);
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
    sessionMailbox?.settleAdopted(nextSession.id, event.turnId, terminalStatus);
    settleEntityTaskFromSession(nextSession);
    // Recovered execution state does not prove the final business result was
    // delivered. Require user review before advancing queued work.
    if (event.payload?.suppressAutomaticContinuation === true) return;
    const agent = collaborationCore.getAgentForSession(nextSession.id);
    // A requested Provider switch waits for execution to stop, not to succeed.
    const providerSwitch = continuePendingProviderSwitch(logicalRoute);
    if (providerSwitch) {
      providerSwitch.then(() => scheduleAgentWorkDrain(nextSession.id));
      return;
    }
    if (!failed && !cancelled) {
      const continuation = continuePendingWorkspaceTransition(logicalRoute, event.turnId);
      resumeWorkAfterTransition(continuation, () => {
        scheduleAgentWorkDrain(nextSession.id);
      });
    } else if (agent) {
      scheduleAgentWorkDrain(nextSession.id);
    }
  };
}
