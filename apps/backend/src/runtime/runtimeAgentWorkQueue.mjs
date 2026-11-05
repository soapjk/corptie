import { dispatchReady, dispatchBlocked } from "../utils/dispatchDecision.mjs";
import { redactInlineSecrets } from "../utils/providerRawMetadata.mjs";
import { agentWorkPreDeliveryRetryDecision, interruptedAgentWorkRecoveryPatch } from "../utils/agentWorkQueue.mjs";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";
import { workspaceTransitionBlocksWork } from "./workspaceTransitionBarrier.mjs";
import { normalizeSessionMessageLatencyTrace, logSessionMessageLatency } from "../utils/sessionMessageLatency.mjs";

// Each backend runtime owns its queue membership, drain exclusion and retry budget.
// Durable rows are consulted only for work explicitly admitted to this runtime.
export function createRuntimeAgentWorkQueue({
  store, collaborationCore, sessionChannelService, collaborationDispatcher,
  workspaceContinuationCoordinator, inspectCollaborationSession, resolveCollaborationDeliveryRoute,
  scheduleAgentWorkDrain, dispatchSessionChannelDelivery, sendUnifiedSessionMessage, emitEvent: publishEvent,
  syncSessionChannelDeliveriesIntoAgentWorkQueue, syncCollaborationDeliveriesIntoAgentWorkQueue,
  channelMailbox, sessionMailbox,
  isWorkspaceMutationActive = () => false, inspectWorkspaceDispatchBlocker = null
}) {
  const drainingAgentWorkSessionIds = new Set();
  const runtimeQueuedTasksBySession = new Map();
  const preDeliveryRetryCounts = new Map();
  const mailboxTimers = new Map();
  const MAX_PRE_DELIVERY_RETRIES = 3;

  function emitEvent(type,payload,options) {
    if(type === "AgentWorkFailed" && payload?.task) {
      const item=payload.task;
      const reason=item.source?.dispatchBlock ?? {code:payload.errorCode ?? "DISPATCH_FAILED",
        message:redactInlineSecrets(String(item.lastError ?? "消息派发失败。")),kind:"rejected"};
      const task=item.source?.dispatchBlock ? item : store.updateAgentTask(item.taskId,{source:{...item.source,dispatchBlock:reason},lastError:reason.message});
      try { sessionMailbox?.reportDispatchBlock?.(task); } catch(error) { console.warn(`[mailbox-dispatch-report] ${error.code ?? "REPORT_FAILED"}`); }
      return publishEvent(type,{...payload,task,reason},options);
    }
    return publishEvent(type,payload,options);
  }

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

  function mailboxDecision(item) {
    if(sessionMailbox?.dispatchDecision) return sessionMailbox.dispatchDecision(item);
    return !sessionMailbox || sessionMailbox.canDispatchOperation(item) ? dispatchReady()
      : dispatchBlocked("MAILBOX_DISPATCH_UNAVAILABLE","blocked","邮箱暂时不能派发这条消息。");
  }

  function recordBlocked(item, reason) {
    if(!item || reason.allowed || reason.kind === "settled") return;
    const block={code:reason.code,message:redactInlineSecrets(String(reason.message)).slice(0,1200),kind:reason.kind};
    const old=item.source?.dispatchBlock;
    if(old?.code===block.code && old?.message===block.message && old?.kind===block.kind) {
      try { sessionMailbox?.reportDispatchBlock?.(item); } catch(error) { console.warn(`[mailbox-dispatch-report] ${error.code ?? "REPORT_FAILED"}`); }
      return;
    }
    const task=store.updateAgentTask(item.taskId,{...(reason.kind === "rejected" ? {status:"failed"} : {}),lastError:block.message,source:{...item.source,dispatchBlock:block}});
    if(reason.kind === "rejected") {
      forgetRuntimeQueuedWork(item.sessionId,item.taskId);
      workspaceContinuationCoordinator.recordWorkSettled(task);
    }
    emitEvent(reason.kind === "rejected" ? "AgentWorkFailed" : "AgentWorkDispatchBlocked",{sessionId:item.sessionId,task,reason:block},{sessionId:item.sessionId,source:item.source});
    try { sessionMailbox?.reportDispatchBlock?.(task); } catch(error) { console.warn(`[mailbox-dispatch-report] ${error.code ?? "REPORT_FAILED"}`); }
    try { if(item.source?.mailboxMessageId) sessionMailbox?.notify?.(sessionMailbox.logical(item.sessionId)); } catch { /* An unavailable recipient still has a durable operation reason. */ }
  }

  function reportSessionWait(sessionId,reason) {
    const queued=runtimeQueuedTasksBySession.get(sessionId);
    if(!queued?.size) return;
    for(const item of store.listQueuedAgentTasksForSession(sessionId,queued.size)) {
      if(!queued.has(item.taskId)) continue;
      const decision=mailboxDecision(item);
      recordBlocked(item,decision.allowed ? reason : decision);
    }
  }

  function holdForWorkspace(sessionId) {
    const blocker=inspectWorkspaceDispatchBlocker?.(sessionId);
    if(inspectWorkspaceDispatchBlocker ? !blocker : !isWorkspaceMutationActive(sessionId)) return false;
    reportSessionWait(sessionId,dispatchBlocked(blocker?.reason ?? "WORKTREE_MUTATION_IN_PROGRESS","waiting",blocker?.message));
    return true;
  }

  function clearBlocked(item) {
    if(!item.source?.dispatchBlock) return item;
    const {dispatchBlock,...source}=item.source;
    const task=store.updateAgentTask(item.taskId,{source,lastError:null});
    emitEvent("AgentWorkDispatchReady",{sessionId:item.sessionId,task},{sessionId:item.sessionId,source});
    try { if(source.mailboxMessageId) sessionMailbox?.notify?.(sessionMailbox.logical(item.sessionId)); } catch {}
    return task;
  }

  async function inspectRunState(sessionId) {
    try { return await inspectCollaborationSession(sessionId); }
    catch(error) {
      reportSessionWait(sessionId,dispatchBlocked(error.code ?? "SESSION_STATE_UNAVAILABLE","blocked",error.message));
      throw error;
    }
  }

  function nextRuntimeQueuedWork(sessionId) {
    const queued = runtimeQueuedTasksBySession.get(sessionId);
    if (!queued?.size) return null;
    for (const item of store.listQueuedAgentTasksForSession(sessionId, Math.max(queued.size, 1))) {
      if (!queued.has(item.taskId)) continue;
      const decision=mailboxDecision(item);
      if(decision.allowed) return item;
      recordBlocked(item,decision);
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
    // Do not claim a queued message or spend its dispatch retry budget while
    // project-level Git is mutating this Session's Worktree.
    if (holdForWorkspace(sessionId)) return;
    const boundAgent = collaborationCore.getAgentForSession(sessionId);
    if (!boundAgent) { reportSessionWait(sessionId,dispatchBlocked("SESSION_ROLE_UNBOUND","blocked")); return; }

    const runningWork = store.getRunningAgentTaskForSession(sessionId);
    if (runningWork) {
      const liveState = await inspectRunState(sessionId);
      if (liveState === "running" || liveState === "missing") {
        reportSessionWait(sessionId,dispatchBlocked(liveState === "running" ? "SESSION_BUSY" : "SESSION_STATE_UNAVAILABLE")); return;
      }
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
      reportSessionWait(sessionId,dispatchBlocked("SESSION_RECOVERING"));
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
          emitEvent("AgentWorkFailed", { sessionId, task: failedWork, errorCode:"CHANNEL_DELIVERY_ENVELOPE_MISSING" }, { sessionId, source: next.source });
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
          emitEvent("AgentWorkFailed", { sessionId, task: failedWork, errorCode:error.code ?? "CHANNEL_ROUTE_UNAVAILABLE" }, { sessionId, source: next.source });
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
        emitEvent("AgentWorkFailed", { sessionId, task: failedWork, errorCode:"COLLABORATION_DELIVERY_ENVELOPE_MISSING" }, { sessionId, source: next.source });
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
    if (!session) { recordBlocked(next,dispatchBlocked("RECIPIENT_SESSION_NOT_FOUND","blocked")); return; }
    if (sessionHasActiveRun(session)) {
      // Persisted activeTurnId values can outlive an interrupted turn when the
      // completion notification was missed. Reconcile it before leaving queued
      // work blocked indefinitely.
      const liveState = await inspectRunState(sessionId);
      if (liveState === "running" || liveState === "missing") {
        reportSessionWait(sessionId,dispatchBlocked(liveState === "running" ? "SESSION_BUSY" : "SESSION_STATE_UNAVAILABLE")); return;
      }
      console.log(`[agent-work] reconciled stale run state agent=${boundAgent.agentId} session=${sessionId} previousStatus=${session.status} liveState=${liveState}`);
    }
    if (workspaceTransitionBlocksWork(store.getLogicalSessionByLegacySessionId(sessionId))) {
      reportSessionWait(sessionId,dispatchBlocked("WORKSPACE_TRANSITION_IN_PROGRESS")); return;
    }

    // Route verification and stale-run reconciliation above may await. Check
    // again immediately before the synchronous claim, which reserves dispatch
    // against integration's final idle check.
    if (holdForWorkspace(sessionId)) return;

    if (next.source?.type === "session_channel" && channelMailbox) {
      const waitMs = channelMailbox.waitMs(next.deliveryId, next.taskId);
      if (waitMs > 0) {
        recordBlocked(next,dispatchBlocked("CHANNEL_BATCH_WAIT"));
        if (!mailboxTimers.has(sessionId)) {
          const timer = setTimeout(() => {
            mailboxTimers.delete(sessionId);
            scheduleAgentWorkDrain(sessionId);
          }, waitMs);
          timer.unref?.();
          mailboxTimers.set(sessionId, timer);
        }
        return;
      }
    }
    const pendingTimer = mailboxTimers.get(sessionId);
    if (pendingTimer) { clearTimeout(pendingTimer); mailboxTimers.delete(sessionId); }
    let claimed = store.claimAgentTask(next.taskId);
    if (!claimed) {
      const current=store.getAgentTask(next.taskId);
      if(current?.status === "queued") recordBlocked(current,dispatchBlocked("OPERATION_CLAIM_UNAVAILABLE"));
      return;
    }
    claimed=clearBlocked(claimed);
    forgetRuntimeQueuedWork(sessionId, next.taskId);
    logSessionMessageLatency(latencyTrace, "task_claimed");
    try {
      sessionMailbox?.validateOperation(claimed);
      emitEvent("AgentWorkPreparing", { sessionId, task: claimed }, { sessionId, source: claimed.source });
      let turnId = null;
      if (claimed.kind === "collaboration") {
        const delivered = claimed.source?.type === "session_channel"
          ? await dispatchSessionChannelDelivery(claimed.deliveryId, collaborationRoute)
          : await collaborationDispatcher.dispatch(claimed.deliveryId, { resolvedRoute: collaborationRoute });
        if (delivered?.status !== "delivered") {
          const status = delivered?.status === "failed" ? "failed" : "queued";
          const settled = store.updateAgentTask(claimed.taskId, {
            status,
            startedAt: null,
            lastError: delivered?.lastError ?? null
          });
          if (status === "queued") {
            registerRuntimeQueuedWork(claimed.sessionId, claimed.taskId);
            recordBlocked(settled,dispatchBlocked("CHANNEL_DELIVERY_WAIT","waiting",delivered?.lastError ?? "通道投递尚未被接收，等待后续派发。"));
          }
          else {
            emitEvent("AgentWorkFailed", { sessionId, task: settled }, { sessionId, source: settled.source });
            workspaceContinuationCoordinator.recordWorkSettled(settled);
          }
          return;
        }
        turnId = delivered.targetTurnId;
      } else {
        workspaceContinuationCoordinator.assertWorkTarget(claimed);
        if (claimed.source?.mailboxMessageId) store.updateAgentTask(claimed.taskId, {
          source: { ...claimed.source, mailboxDispatchAttempted: true }
        });
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
        turnId = response.result?.turnId ?? response.result?.turn?.id ?? null;
      }
      if (store.getAgentTask(claimed.taskId)?.status === "running") {
        store.updateAgentTask(claimed.taskId, { status: "running", targetTurnId: turnId, lastError: null });
        const startedWork = store.getAgentTask(claimed.taskId);
        emitEvent("AgentWorkStarted", { sessionId: claimed.sessionId, task: startedWork }, {
          sessionId: claimed.sessionId,
          source: claimed.source
        });
        workspaceContinuationCoordinator.recordWorkStarted(startedWork);
        if (startedWork.source?.mailboxMessageId) sessionMailbox?.notify(sessionMailbox.logical(startedWork.sessionId));
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
      const reason=dispatchBlocked(error.code ?? "DISPATCH_FAILED",shouldRetry ? "waiting" : "rejected",error.message ?? "消息派发失败。");
      const failedWork = store.updateAgentTask(claimed.taskId, {
        status: shouldRetry ? "queued" : "failed",
        startedAt: shouldRetry ? null : claimed.startedAt,
        lastError: redactInlineSecrets(String(reason.message)),
        source:{...store.getAgentTask(claimed.taskId)?.source,dispatchBlock:{code:reason.code,message:redactInlineSecrets(String(reason.message)),kind:reason.kind}}
      });
      if (shouldRetry) {
        registerRuntimeQueuedWork(claimed.sessionId, claimed.taskId);
        emitEvent("AgentWorkDispatchBlocked",{sessionId:claimed.sessionId,task:failedWork,reason:failedWork.source.dispatchBlock},{sessionId:claimed.sessionId,source:claimed.source});
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
    sessionMailbox?.syncQueuedOperations(registerRuntimeQueuedWork);
    await syncSessionChannelDeliveriesIntoAgentWorkQueue();
    await syncCollaborationDeliveriesIntoAgentWorkQueue();
    await Promise.all(
      [...runtimeQueuedTasksBySession.keys()].map((sessionId) => drainAgentWork(sessionId))
    );
  }

  return { registerRuntimeQueuedWork, forgetRuntimeQueuedWork, moveRuntimeQueuedWork,
    runtimeQueuePosition, drainAgentWork, tickAgentWorkQueue };
}
