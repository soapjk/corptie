const AUTOMATION_EVENT_PREFIXES = ["ScheduledSession", "Automation"];
export const AUTOMATION_TIMELINE_EVENT_TYPES = new Set([
  "ScheduledSessionTaskCreated",
  "ScheduledSessionTaskDue",
  "ScheduledSessionRunQueued",
  "ScheduledSessionRunStarted",
  "ScheduledSessionRunCompleted",
  "ScheduledSessionRunFailed",
  "ScheduledSessionRunCancelled",
  "ScheduledSessionRunMissed"
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
    const suppliedRun = event.payload?.run ?? null;
    const run = (suppliedRun?.runId && options.resolveRun?.(suppliedRun.runId)) ?? suppliedRun;
    const automationId = normalizedText(task.automationId ?? task.taskId) ?? referencedAutomationId;
    if (!automationId) return null;
    const trigger = task.trigger ?? task.triggerSpec ?? {};
    const triggerType = normalizedText(run?.triggerKind ?? trigger.type ?? task.scheduleType) ?? "unknown";
    const eventType = normalizedText(event.type) ?? "AutomationEvent";
    const runId = normalizedText(run?.runId ?? event.payload?.runId ?? event.runId);
    const isRun = eventType !== "ScheduledSessionTaskCreated" && runId != null;
    // Unlinked legacy lifecycle events must not create duplicate run cards.
    if (!isRun && !["ScheduledSessionTaskCreated", "ScheduledSessionTaskDue", "ScheduledSessionRunQueued"].includes(eventType)) return null;
    const identity = isRun ? `automation-run:${runId}` : `automation-event:${event.eventId ?? event.sequence}`;
    const message = normalizedText(task.message?.text);
    const eventOccurredAt = automationEventOccurredAt(eventType, event, run);
    return {
      id: identity,
      turnId: identity,
      turnStatus: "completed",
      type: "automationEvent",
      title: "Automation",
      text: isRun ? "" : message ?? "",
      status: isRun ? run.status : task.status ?? null,
      createdAt: isRun ? run.createdAt ?? run.scheduledFor ?? event.createdAt : event.createdAt ?? null,
      sourceType: "automation",
      presentationRole: "automation",
      presentationText: isRun ? "" : message ?? "",
      automationId,
      automationRunId: isRun ? runId : null,
      automationRunStatus: isRun ? run.status : null,
      automationRunError: isRun && run.status === "failed" ? "execution_failed" : null,
      automationName: normalizedText(task.name) ?? message ?? null,
      automationTriggerType: normalizedText(trigger.type ?? task.scheduleType) ?? triggerType,
      automationEventType: eventType,
      automationEventOccurredAt: isRun ? run.createdAt ?? run.scheduledFor ?? eventOccurredAt : eventOccurredAt,
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
  if (!normalizedText(envelope.task?.sourceWorkId)) return "missing_source_work_id";
  if (!normalizedText(envelope.task?.targetWorkId)) return "missing_target_work_id";
  if (!normalizedText(envelope.message?.body)) return "missing_message_body";
  return null;
}

function normalizedText(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}
