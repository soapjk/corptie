import { agentWorkPreDeliveryRetryDecision, interruptedAgentWorkRecoveryPatch } from "../utils/agentWorkQueue.mjs";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";
import { workspaceTransitionBlocksWork } from "./workspaceTransitionBarrier.mjs";
import { normalizeSessionMessageLatencyTrace, logSessionMessageLatency } from "../utils/sessionMessageLatency.mjs";

// Each backend runtime owns its queue membership, drain exclusion and retry budget.
// Durable rows are consulted only for work explicitly admitted to this runtime.
export function createRuntimeAgentWorkQueue({
  store, collaborationCore, sessionChannelService, collaborationDispatcher,
  workspaceContinuationCoordinator, inspectCollaborationSession, resolveCollaborationDeliveryRoute,
  scheduleAgentWorkDrain, dispatchSessionChannelDelivery, sendUnifiedSessionMessage, emitEvent,
  syncSessionChannelDeliveriesIntoAgentWorkQueue, syncCollaborationDeliveriesIntoAgentWorkQueue
}) {
  const drainingAgentWorkSessionIds = new Set();
  const runtimeQueuedTasksBySession = new Map();
  const preDeliveryRetryCounts = new Map();
  const MAX_PRE_DELIVERY_RETRIES = 3;

  function registerRuntimeQueuedWork(sessionId, taskId) {
    if (!sessionId || !taskId) return;
    const queued = runtimeQueuedTasksBySession.get(sessionId) ?? new Set();
    queued.add(taskId);
    runtimeQueuedTasksBySession.set(sessionId, queued);
  }

  function forgetRuntimeQueuedWork(sessionId, taskId) {
    const queued = runtimeQueuedTasksBySession.get(sessionId);
    if (!queued) return;
    queued.delete(taskId);
    if (queued.size === 0) runtimeQueuedTasksBySession.delete(sessionId);
  }

  function moveRuntimeQueuedWork(fromSessionId, toSessionId, taskId) {
    forgetRuntimeQueuedWork(fromSessionId, taskId);
    registerRuntimeQueuedWork(toSessionId, taskId);
  }

  function nextRuntimeQueuedWork(sessionId) {
    const queued = runtimeQueuedTasksBySession.get(sessionId);
    if (!queued?.size) return null;
    for (const item of store.listQueuedAgentTasksForSession(sessionId, Math.max(queued.size, 1))) {
      if (queued.has(item.taskId)) return item;
    }
    for (const taskId of [...queued]) {
      const item = store.getAgentTask(taskId);
      if (!item || item.status !== "queued" || item.sessionId !== sessionId) {
        forgetRuntimeQueuedWork(sessionId, taskId);
      }
    }
    return null;
  }

  function runtimeQueuePosition(sessionId, taskId) {
    const queued = runtimeQueuedTasksBySession.get(sessionId);
    if (!queued?.has(taskId)) return 0;
    return store.listQueuedAgentTasksForSession(sessionId, Math.max(queued.size, 1))
      .filter((item) => queued.has(item.taskId))
      .findIndex((item) => item.taskId === taskId) + 1;
  }

  async function drainAgentWork(sessionId) {
    if (drainingAgentWorkSessionIds.has(sessionId)) return;
    drainingAgentWorkSessionIds.add(sessionId);
    try {
      await drainAgentWorkSession(sessionId);
    } finally {
      drainingAgentWorkSessionIds.delete(sessionId);
    }
  }

  async function drainAgentWorkSession(sessionId) {
    const boundAgent = collaborationCore.getAgentForSession(sessionId);
    if (!boundAgent) return;

    const runningWork = store.getRunningAgentTaskForSession(sessionId);
    if (runningWork) {
      const liveState = await inspectCollaborationSession(sessionId);
      if (liveState === "running" || liveState === "missing") return;
      const patch = interruptedAgentWorkRecoveryPatch(runningWork);
      const recoveredWork = patch ? store.updateAgentTask(runningWork.taskId, patch) : null;
      if (recoveredWork?.status === "cancelled") {
        emitEvent("AgentWorkCompleted", { sessionId: runningWork.sessionId, task: recoveredWork }, {
          sessionId: runningWork.sessionId,
          source: runningWork.source
        });
        workspaceContinuationCoordinator.recordWorkSettled(recoveredWork);
      } else if (recoveredWork?.status === "queued") {
        emitEvent("AgentWorkQueued", { sessionId: runningWork.sessionId, task: recoveredWork, queuePosition: null, source: runningWork.source }, {
          sessionId: runningWork.sessionId,
          source: runningWork.source
        });
        workspaceContinuationCoordinator.recordWorkRequeued(recoveredWork);
      }
      console.log(`[agent-work] recovered orphaned work agent=${boundAgent.agentId} session=${sessionId} work=${runningWork.taskId} status=${recoveredWork?.status ?? "unchanged"} liveState=${liveState}`);
      return;
    }

    const next = nextRuntimeQueuedWork(sessionId);
    if (!next) return;
    let collaborationRoute = null;
    if (next.kind === "collaboration") {
      if (next.source?.type === "session_channel") {
        const envelope = sessionChannelService.getDeliveryEnvelope(next.deliveryId);
        if (!envelope) {
          const failedWork = store.updateAgentTask(next.taskId, {
            status: "failed", lastError: `Channel delivery ${next.deliveryId} no longer has an envelope.`
          });
          forgetRuntimeQueuedWork(sessionId, next.taskId);
          emitEvent("AgentWorkFailed", { sessionId, task: failedWork }, { sessionId, source: next.source });
          return;
        }
        try {
          collaborationRoute = sessionChannelService.resolveDeliveryRoute(next.deliveryId);
          if (collaborationRoute.providerSessionId !== sessionId) {
            store.updateAgentTask(next.taskId, {
              sessionId: collaborationRoute.providerSessionId,
              source: { ...next.source, recipientSessionId: collaborationRoute.sessionId }
            });
            moveRuntimeQueuedWork(sessionId, collaborationRoute.providerSessionId, next.taskId);
            scheduleAgentWorkDrain(collaborationRoute.providerSessionId, null, next.taskId);
            return;
          }
        } catch (error) {
          sessionChannelService.updateDelivery(next.deliveryId, {
            status: "failed", incrementAttempt: true, nextAttemptAt: null, lastError: error.message
          });
          const failedWork = store.updateAgentTask(next.taskId, { status: "failed", lastError: error.message });
          forgetRuntimeQueuedWork(sessionId, next.taskId);
          emitEvent("AgentWorkFailed", { sessionId, task: failedWork }, { sessionId, source: next.source });
          return;
        }
      } else {
      const envelope = collaborationCore.getDeliveryEnvelope(next.deliveryId);
      if (!envelope) {
        const failedWork = store.updateAgentTask(next.taskId, {
          status: "failed",
          lastError: `Collaboration delivery ${next.deliveryId} no longer has an envelope.`
        });
        forgetRuntimeQueuedWork(sessionId, next.taskId);
        emitEvent("AgentWorkFailed", { sessionId, task: failedWork }, { sessionId, source: next.source });
        return;
      }
      try {
        collaborationRoute = await resolveCollaborationDeliveryRoute(envelope, "agent_work_dequeue_preflight");
        if (collaborationRoute.providerSessionId !== sessionId) {
          const source = { ...next.source, recipientSessionId: collaborationRoute.sessionId };
          store.updateAgentTask(next.taskId, { sessionId: collaborationRoute.providerSessionId, source });
          moveRuntimeQueuedWork(sessionId, collaborationRoute.providerSessionId, next.taskId);
          console.info(`[collaboration-routing] event=dequeue_route_changed taskId=${envelope.task.taskId} deliveryId=${next.deliveryId} fromSessionId=${sessionId} toSessionId=${collaborationRoute.providerSessionId}`);
          scheduleAgentWorkDrain(collaborationRoute.providerSessionId, null, next.taskId);
          return;
        }
      } catch (error) {
        console.error(`[collaboration-routing] event=dequeue_route_failed taskId=${envelope.task.taskId} deliveryId=${next.deliveryId} code=${error.code ?? "RECIPIENT_ROUTE_FAILED"} error=${JSON.stringify(error.message)}`);
        const delivery = collaborationDispatcher.failRoute(next.deliveryId, error, {
          envelope,
          eventType: "dequeue_route_failed"
        });
        const failedWork = store.updateAgentTask(next.taskId, {
          status: "failed",
          lastError: delivery?.lastError ?? error.message
        });
        forgetRuntimeQueuedWork(sessionId, next.taskId);
        emitEvent("AgentWorkFailed", { sessionId, task: failedWork }, {
          sessionId,
          source: next.source
        });
        return;
      }
      }
    }
    const latencyTrace = normalizeSessionMessageLatencyTrace(next.source?.latencyTrace ?? {}, { sessionId });
    logSessionMessageLatency(latencyTrace, "task_dequeued");

    if (boundAgent.agentId !== next.agentId) {
      const failedWork = store.updateAgentTask(next.taskId, {
        status: "failed",
        lastError: `Queued work target Session ${sessionId} is no longer bound to Agent ${next.agentId}.`
      });
      forgetRuntimeQueuedWork(sessionId, next.taskId);
      emitEvent("AgentWorkFailed", { sessionId, task: failedWork }, {
        sessionId,
        source: next.source
      });
      workspaceContinuationCoordinator.recordWorkSettled(failedWork);
      return;
    }
    const session = store.getSession(sessionId);
    if (!session) return;
    if (sessionHasActiveRun(session)) {
      // Persisted activeTurnId values can outlive an interrupted turn when the
      // completion notification was missed. Reconcile it before leaving queued
      // work blocked indefinitely.
      const liveState = await inspectCollaborationSession(sessionId);
      if (liveState === "running" || liveState === "missing") return;
      console.log(`[agent-work] reconciled stale run state agent=${boundAgent.agentId} session=${sessionId} previousStatus=${session.status} liveState=${liveState}`);
    }
    if (workspaceTransitionBlocksWork(store.getLogicalSessionByLegacySessionId(sessionId))) return;

    const claimed = store.claimAgentTask(next.taskId);
    if (!claimed) return;
    forgetRuntimeQueuedWork(sessionId, next.taskId);
    logSessionMessageLatency(latencyTrace, "task_claimed");
    try {
      let turnId = null;
      if (claimed.kind === "collaboration") {
        const delivered = claimed.source?.type === "session_channel"
          ? await dispatchSessionChannelDelivery(claimed.deliveryId, collaborationRoute)
          : await collaborationDispatcher.dispatch(claimed.deliveryId, { resolvedRoute: collaborationRoute });
        if (delivered?.status !== "delivered") {
          const status = delivered?.status === "failed" ? "failed" : "queued";
          store.updateAgentTask(claimed.taskId, {
            status,
            startedAt: null,
            lastError: delivered?.lastError ?? null
          });
          if (status === "queued") registerRuntimeQueuedWork(claimed.sessionId, claimed.taskId);
          return;
        }
        turnId = delivered.targetTurnId;
      } else {
        workspaceContinuationCoordinator.assertWorkTarget(claimed);
        const response = await sendUnifiedSessionMessage(
          claimed.sessionId,
          claimed.source?.messageContent ?? claimed.text,
          claimed.source,
          {
            fromAgentWorkQueue: true,
            agentTask: claimed,
            latencyTrace
          }
        );
        turnId = response.result?.turn?.id ?? response.result?.turnId ?? null;
      }
      if (store.getAgentTask(claimed.taskId)?.status === "running") {
        store.updateAgentTask(claimed.taskId, { status: "running", targetTurnId: turnId, lastError: null });
        const startedWork = store.getAgentTask(claimed.taskId);
        emitEvent("AgentWorkStarted", { sessionId: claimed.sessionId, task: startedWork }, {
          sessionId: claimed.sessionId,
          source: claimed.source
        });
        workspaceContinuationCoordinator.recordWorkStarted(startedWork);
      }
      preDeliveryRetryCounts.delete(claimed.taskId);
    } catch (error) {
      const { retryCount, shouldRetry } = agentWorkPreDeliveryRetryDecision({
        errorCode: error.code,
        targetTurnId: claimed.targetTurnId,
        previousRetryCount: preDeliveryRetryCounts.get(claimed.taskId) ?? 0,
        maxRetries: MAX_PRE_DELIVERY_RETRIES
      });
      if (shouldRetry) preDeliveryRetryCounts.set(claimed.taskId, retryCount);
      const failedWork = store.updateAgentTask(claimed.taskId, {
        status: shouldRetry ? "queued" : "failed",
        startedAt: shouldRetry ? null : claimed.startedAt,
        lastError: error.message
      });
      if (shouldRetry) {
        registerRuntimeQueuedWork(claimed.sessionId, claimed.taskId);
      } else {
        preDeliveryRetryCounts.delete(claimed.taskId);
        emitEvent("AgentWorkFailed", { sessionId: claimed.sessionId, task: failedWork }, {
          sessionId: claimed.sessionId,
          source: claimed.source
        });
        workspaceContinuationCoordinator.recordWorkSettled(failedWork);
      }
      if (!shouldRetry) throw error;
    }
  }

  async function tickAgentWorkQueue() {
    await syncSessionChannelDeliveriesIntoAgentWorkQueue();
    await syncCollaborationDeliveriesIntoAgentWorkQueue();
    await Promise.all(
      [...runtimeQueuedTasksBySession.keys()].map((sessionId) => drainAgentWork(sessionId))
    );
  }

  return { registerRuntimeQueuedWork, forgetRuntimeQueuedWork, moveRuntimeQueuedWork,
    runtimeQueuePosition, drainAgentWork, tickAgentWorkQueue };
}
