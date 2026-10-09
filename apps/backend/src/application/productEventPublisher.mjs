import { projectTaskDeletionNotification } from "./worktreeIntegrationJobService.mjs";
import { clientSafeJSONStringify } from "../utils/unicodeText.mjs";
import { randomUUID } from "node:crypto";
import { resolveDurableEventSessionId } from "./providerSessionIdentity.mjs";
import { canonicalSessionIdFromEventPayload } from "./providerSessionProjection.mjs";
import { automationTimelineItems } from "../utils/sessionEventPresentation.mjs";

// The transaction commits before any subscriber observes the event.
// Domain follow-ups are explicit ports, not a dependency on the server root.
export function createProductEventPublisher({
  store, eventLog, sseClients, now,
  getClientDeviceGateway, scheduleStateSyncPublish, requestTaskSummary,
  notifySessionEventListeners, publishDshSessionEvent, handleScheduledWorkEvent,
  reconcileCompletedCollaborationWork, reconcileConflictResolutionSession,
  agentWorkTimelineItem, collaborationConfirmationTimelineItem,
  sessionChannelAuthorizationTimelineItem, sessionChannelMessageTimelineItem,
  logger = console, defer = setImmediate
}) {

  function emitEvent(type, payload, options = {}) {
    const clientDeviceGateway = getClientDeviceGateway();
    if (/^(Worktree|GitRepository|ScheduledSession|Automation|Agent|Skill)/.test(type)) {
      clientDeviceGateway?.events.invalidate({ control: true });
      clientDeviceGateway?.events.publishControl();
    }
    // Provider terminal notifications may be replayed after reconnect. A stable
    // event id makes the entire product event idempotent, including global SSE,
    // the durable timeline, unread cursors, and downstream work orchestration.
    // Deletion notifications must survive after the Session row is gone. Keep
    // their identity in the payload without attaching the durable outbox row to
    // the deleted Session's foreign key.
    const requestedSessionId = options.detachedSession === true
      ? null
      : options.sessionId || sessionIdFromEventPayload(payload);
    const sessionId = resolveDurableEventSessionId(store, requestedSessionId);
    const createdAt = now();
    const durableEventId = options.eventId || randomUUID();
    if (options.eventId && store.db && store.hasSessionEvent(options.eventId)) return null;

    let sessionEvent = null;
    let outbox = null;
    if (store.db) {
      // Persistence and the broadcast intent are one commit. No client can see
      // an event that is absent from Corptie's durable authority.
      store.runInTransaction(() => {
        if (sessionId && options.recordSessionEvent !== false) {
          sessionEvent = store.appendSessionEvent({
            eventId: durableEventId,
            sessionId,
            type,
            source: options.source || payload?.source || null,
            payload,
            createdAt
          });
          // Supplementary product events are projected once, at write time,
          // into the same session_items authority as Provider messages. Reads
          // must never reconstruct them by scanning session_events or querying
          // automation state for every active Session.
          for (const item of productTimelineItemsForEvent(type, payload, sessionEvent, sessionId)) {
            if (item.type === "automationEvent" && item.automationRunId) {
              const previous = store.getSessionItem?.(sessionId, item.id);
              if (previous) {
                item.createdAt = previous.createdAt;
                item.automationName = previous.automationName;
                item.automationEventOccurredAt = previous.automationEventOccurredAt;
                for (const key of ["automationTriggerType", "automationScheduleType", "automationRunAt",
                  "automationNextRunAt", "automationIntervalSeconds", "automationConditionCheckIntervalSeconds",
                  "automationProcessPollIntervalSeconds", "automationExpiresAt"]) item[key] = previous[key];
              }
            }
            store.upsertTimelineItemProjection(sessionId, {
              ...item,
              rawMetadataJSON: JSON.stringify(item)
            });
          }
        }
        outbox = store.enqueueEventOutbox({
          outboxId: `product-event:${durableEventId}`,
          topic: "product-events",
          sessionId,
          eventType: type,
          payload: { type, payload, createdAt },
          createdAt
        });
      });
    }

    const event = eventLog.append({ type, payload, createdAt });
    const frame = `id: ${event.id}\nevent: ${event.type}\ndata: ${clientSafeJSONStringify(event)}\n\n`;
    for (const response of sseClients) {
      try {
        response.write(frame);
      } catch (error) {
        logger.warn(`[events] client write failed type=${type}: ${error.message}`);
      }
    }
    if (type === "WorktreeIntegrationJobChanged" && payload?.job?.notification) {
      clientDeviceGateway?.events.publishOperation?.(payload.job.notification);
    }
    if (type === "TaskChanged" && payload?.operation?.operationId) {
      clientDeviceGateway?.events.publishOperation?.(projectTaskDeletionNotification(payload.operation));
    }
    if (outbox) store.markEventOutboxPublished(outbox.outbox_id, now());
    scheduleStateSyncPublish();
    if (type === "TaskChanged" && payload?.entity?.id) {
      requestTaskSummary(payload.entity.id);
    }

    if (sessionEvent) {
      notifySessionEventListeners(sessionEvent);
      publishDshSessionEvent(sessionEvent);
    }
    if (["AgentWorkStarted", "AgentWorkCompleted", "AgentWorkFailed"].includes(type)) {
      try {
        handleScheduledWorkEvent(type, payload?.task);
      } catch (error) {
        logger.error(`[scheduled-session] work event reconciliation failed type=${type}: ${error.message}`);
      }
    }
    if (type === "AgentWorkCompleted" && payload?.task?.kind === "collaboration"
        && payload.task.source?.type !== "session_channel") {
      try {
        reconcileCompletedCollaborationWork(payload.task);
      } catch (error) {
        logger.error(
          `[collaboration] completed work reconciliation failed work=${payload.task.taskId}`
          + ` delivery=${payload.task.deliveryId ?? "unknown"} code=${error.code ?? "unknown"}`
          + ` error=${error.message}`
        );
      }
    }
    if (type === "AgentWorkCompleted" && sessionId) {
      defer(() => {
        try {
          reconcileConflictResolutionSession(sessionId);
        } catch (error) {
          logger.error(`[worktree-integration] conflict completion reconciliation failed session=${sessionId}: ${error.message}`);
        }
      });
    }
    return event;
  }

  function productTimelineItemsForEvent(type, payload, sessionEvent, sessionId) {
    const items = automationTimelineItems([sessionEvent], {
      resolveRun: id => store.getScheduledSessionRun?.(id)
    });
    if (type === "SessionCommandCompleted" && payload?.item) {
      items.push(payload.item);
    }
    if (["AgentWorkQueued", "AgentWorkStarted", "AgentWorkCompleted", "AgentWorkFailed"].includes(type)) {
      const item = agentWorkTimelineItem(payload?.task, sessionId, payload?.queuePosition);
      if (item) items.push(item);
    }
    if (["CollaborationConfirmationRequested", "CollaborationConfirmationResolved"].includes(type)) {
      const item = collaborationConfirmationTimelineItem(payload?.confirmation, sessionId);
      if (item) items.push(item);
    }
    if (["SessionChannelAuthorizationRequested", "SessionChannelRequestResolved"].includes(type)) {
      const item = sessionChannelAuthorizationTimelineItem(payload?.channelRequest ?? payload?.request, sessionId);
      if (item) items.push(item);
    }
    if (type === "SessionChannelMessageSent") {
      const item = sessionChannelMessageTimelineItem(payload, sessionId);
      if (item) items.push(item);
    }
    return items;
  }

  function sessionIdFromEventPayload(payload = {}) {
    return canonicalSessionIdFromEventPayload(payload, {
      resolveStableSessionId: ({
        rawSessionId,
        providerId,
        providerSessionId,
        threadId,
        logicalSessionId
      }) => {
        const logical = (logicalSessionId ? store.getLogicalSession(logicalSessionId) : null)
          ?? (providerId && providerSessionId
            ? store.getLogicalSessionByProviderSessionId(providerId, providerSessionId)
            : null)
          ?? (threadId ? store.getLogicalSessionByProviderThreadId(threadId) : null);
        if (logical?.legacySessionId) return logical.legacySessionId;
        return rawSessionId && store.getSession(String(rawSessionId))
          ? String(rawSessionId)
          : null;
      }
    });
  }

  return { emitEvent };
}
