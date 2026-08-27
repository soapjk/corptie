const AUTOMATION_EVENT_PREFIXES = ["ScheduledSession", "Automation"];

export function isAutomationSessionEvent(event) {
  const type = normalizedText(event?.type);
  return AUTOMATION_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

export function automationTimelineItems(events = [], options = {}) {
  return events.filter(isAutomationSessionEvent).map((event) => {
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
    const eventSource = normalizedText(event.source?.type ?? event.producer) ?? "system";
    const eventType = normalizedText(event.type) ?? "AutomationEvent";
    const message = normalizedText(task.message?.text);
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
      automationName: normalizedText(task.name) ?? automationId,
      automationTriggerType: triggerType,
      automationEventType: eventType,
      automationEventSource: eventSource,
      automationRunId: normalizedText(run?.runId)
    };
  }).filter(Boolean);
}

export function collaborationEnvelopeFailure({ workItem, task, envelope } = {}) {
  if (workItem?.kind !== "collaboration") return "not_collaboration";
  const taskId = normalizedText(workItem.source?.taskId);
  if (!taskId) return "missing_task_id";
  if (!task || normalizedText(task.taskId) !== taskId) return "task_not_found";
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
