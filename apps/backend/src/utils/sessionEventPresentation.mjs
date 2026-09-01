const AUTOMATION_EVENT_PREFIXES = ["ScheduledSession", "Automation"];
export const AUTOMATION_TIMELINE_EVENT_TYPES = new Set([
  "ScheduledSessionTaskCreated",
  "ScheduledSessionTaskDue",
  "ScheduledSessionRunQueued"
]);

export function isAutomationSessionEvent(event) {
  const type = normalizedText(event?.type);
  return AUTOMATION_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

export function automationTimelineItems(events = [], options = {}) {
  return events.filter((event) => AUTOMATION_TIMELINE_EVENT_TYPES.has(normalizedText(event?.type))).map((event) => {
    const referencedAutomationId = normalizedText(
      event.payload?.task?.automationId
        ?? event.payload?.task?.taskId
        ?? event.payload?.automationId
        ?? event.source?.taskId
    );
    const task = event.payload?.task
      ?? (referencedAutomationId && options.resolveAutomation?.(referencedAutomationId))
      ?? {};
    const run = event.payload?.run ?? null;
    const automationId = normalizedText(task.automationId ?? task.taskId) ?? referencedAutomationId;
    if (!automationId) return null;
    const trigger = task.trigger ?? task.triggerSpec ?? {};
    const triggerType = normalizedText(run?.triggerKind ?? trigger.type ?? task.scheduleType) ?? "unknown";
    const eventType = normalizedText(event.type) ?? "AutomationEvent";
    const message = normalizedText(task.message?.text);
    const eventOccurredAt = automationEventOccurredAt(eventType, event, run);
    return {
      id: `automation-event:${event.eventId ?? event.sequence}`,
      turnId: `automation-event:${event.eventId ?? event.sequence}`,
      turnStatus: "completed",
      type: "automationEvent",
      title: "Automation",
      text: message ?? "",
      status: task.status ?? run?.status ?? null,
      createdAt: event.createdAt ?? null,
      sourceType: "automation",
      presentationRole: "automation",
      presentationText: message ?? "",
      automationId,
      automationName: normalizedText(task.name) ?? message ?? "Automation",
      automationTriggerType: normalizedText(trigger.type ?? task.scheduleType) ?? triggerType,
      automationEventType: eventType,
      automationEventOccurredAt: eventOccurredAt,
      automationScheduleType: normalizedText(task.scheduleType ?? trigger.type),
      automationRunAt: normalizedText(task.runAt ?? trigger.at),
      automationNextRunAt: normalizedText(task.nextRunAt),
      automationIntervalSeconds: finitePositiveNumber(task.intervalSeconds ?? trigger.intervalSeconds),
      automationConditionCheckIntervalSeconds: finitePositiveNumber(
        task.conditionSpec?.checkIntervalSeconds ?? trigger.condition?.checkIntervalSeconds
      ),
      automationProcessPollIntervalSeconds: finitePositiveNumber(
        task.processSpec?.pollIntervalSeconds ?? trigger.process?.pollIntervalSeconds
      ),
      automationExpiresAt: normalizedText(task.expiresAt)
    };
  }).filter(Boolean);
}

function automationEventOccurredAt(eventType, event, run) {
  if (eventType === "ScheduledSessionRunQueued") {
    return normalizedText(run?.queuedAt) ?? normalizedText(event.createdAt);
  }
  return normalizedText(event.createdAt);
}

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function collaborationEnvelopeFailure({ task, collaborationTask, envelope } = {}) {
  if (task?.kind !== "collaboration") return "not_collaboration";
  const taskId = normalizedText(task.source?.taskId);
  if (!taskId) return "missing_task_id";
  if (!collaborationTask || normalizedText(collaborationTask.taskId) !== taskId) return "task_not_found";
  if (!envelope || normalizedText(envelope.task?.taskId) !== taskId) return "envelope_not_found";
  if (!normalizedText(envelope.message?.senderSessionId)
      && !normalizedText(envelope.message?.envelope?.sender?.sessionId)) return "missing_sender_session_id";
  if (!normalizedText(envelope.message?.recipientSessionId)
      && !normalizedText(envelope.message?.envelope?.recipient?.sessionId)) return "missing_recipient_session_id";
  if (!normalizedText(envelope.task?.sourceObjectiveId)) return "missing_source_objective_id";
  if (!normalizedText(envelope.task?.targetObjectiveId)) return "missing_target_objective_id";
  if (!normalizedText(envelope.message?.body)) return "missing_message_body";
  return null;
}

function normalizedText(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}
