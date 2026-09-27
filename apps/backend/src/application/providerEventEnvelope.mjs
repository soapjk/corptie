import { toolExecutionForItem, withToolExecutionMetadata } from "../utils/toolExecutionProjection.mjs";
import { changeSetForCodexItem, withChangeSetMetadata } from "../utils/changeSetProjection.mjs";
import { providerSafeToolText } from "../utils/providerRawMetadata.mjs";
import { asyncQuestionInput } from "./structuredInteraction.mjs";

const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "dynamicToolCall",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "workspaceWrite"
]);

export function mapCodexProviderNotification({ message, binding, liveItems = [], receivedAt,
  structuredPlanEvents = true }) {
  const method = message?.method;
  const params = message?.params ?? {};
  const turn = params.turn ?? null;
  const approvalItem = method === "corptie/codexApprovalRequested"
    ? (params.item?.type === "approval"
      && params.item.id === `${params.threadId}:app-server-approval:${params.requestId}`
      ? params.item : null) ?? liveItems.find((candidate) => candidate?.type === "approval"
      && candidate.id === `${params.threadId}:app-server-approval:${params.requestId}`) ?? null
    : null;
  const isUserInputNotification = [
    "corptie/codexUserInputRequested",
    "corptie/codexUserInputSubmitted",
    "corptie/codexUserInputResolved"
  ].includes(method);
  const userInputItem = isUserInputNotification
    && params.item?.type === "userInput"
    && params.item.id === `${params.threadId}:app-server-user-input:${params.requestId}`
    ? params.item : null;
  if (isUserInputNotification && !userInputItem) return null;
  const turnId = turn?.id ?? params.turnId ?? params.item?.turnId ?? approvalItem?.turnId ?? null;
  const itemId = userInputItem?.id ?? params.item?.id ?? approvalItem?.id ?? null;
  // The notification can be delivered before the Adapter's live-item cache is
  // updated. Prefer the normalized cache, but never discard the full native
  // item carried by item/started or item/completed; otherwise the final answer
  // event is committed without a Timeline item and the UI can only show the
  // execution card.
  const item = codexToolFallback(normalizeTimelineItem(
    userInputItem ?? approvalItem ?? (itemId
      ? liveItems.find((candidate) => candidate?.id === itemId) ?? params.item ?? null
      : params.item ?? null)
  ), method);
  const type = item?.type === "userInput" && ["item/started", "item/completed"].includes(method)
    ? "interaction.requested" : item?.type === "warning" ? "execution.notice" : codexEventType(method, params.item, turn);
  if (!type) return null;
  return providerEnvelope(binding, {
    providerEventId: optionalText(params.providerEventId ?? params.eventId),
    providerSequence: optionalSequence(params.providerSequence ?? params.sequence),
    resumeToken: optionalText(params.resumeToken),
    turnId,
    itemId,
    type,
    occurredAt: optionalText(params.occurredAt ?? params.timestamp),
    receivedAt,
    payload: compactObject({
      nativeMethod: method,
      item,
      items: method === "turn/completed" ? liveItems.map(normalizeTimelineItem) : undefined,
      turn,
      error: params.error ?? turn?.error,
      failureScope: type === "provider.error" ? providerFailureScope(turnId) : undefined,
      willRetry: params.willRetry,
      tokenUsage: params.tokenUsage ?? params.usage,
      plan: type === "plan.updated" ? (structuredPlanEvents ? normalizedPlanSnapshot(params) : null) : undefined
    }),
    rawPayload: params
  });
}

function codexToolFallback(item, method) {
  if (!TOOL_ITEM_TYPES.has(item?.type)) return item;
  const normalized = {
    ...item,
    status: item.status ?? (method === "item/completed" ? "completed" : "inProgress")
  };
  try {
    if (JSON.parse(normalized.rawMetadataJSON)?.toolExecution?.schemaVersion === 1) return normalized;
  } catch { /* Native event has no normalized metadata yet. */ }
  const input = normalized.type === "commandExecution" ? normalized.command
    : normalized.type === "webSearch" ? normalized.query
      : normalized.arguments ?? normalized.text ?? null;
  const toolExecution = toolExecutionForItem(normalized, {
    input, result: normalized.aggregatedOutput ?? normalized.result ?? normalized.output ?? normalized.error ?? null
  });
  const result = toolExecution ? {
    ...normalized,
    rawMetadataJSON: withToolExecutionMetadata(normalized.rawMetadataJSON, toolExecution)
  } : normalized;
  return result.type === "fileChange" ? {
    ...result,
    rawMetadataJSON: withChangeSetMetadata(result.rawMetadataJSON, changeSetForCodexItem(result))
  } : result;
}

export function mapClaudeTurnSettled({ event, binding, receivedAt }) {
  const status = String(event?.status ?? "failed");
  const type = status === "completed"
    ? "turn.completed"
    : status === "cancelled"
      ? "turn.cancelled"
      : "turn.failed";
  return providerEnvelope(binding, {
    providerEventId: optionalText(event?.providerEventId),
    providerSequence: optionalSequence(event?.providerSequence),
    resumeToken: optionalText(event?.resumeToken),
    turnId: optionalText(event?.turnId),
    type,
    occurredAt: optionalText(event?.occurredAt ?? event?.session?.updatedAt),
    receivedAt,
    payload: compactObject({
      session: event?.session,
      items: Array.isArray(event?.items) ? event.items.map(normalizeTimelineItem) : undefined,
      hasAgentMessage: event?.hasAgentMessage === true,
      error: event?.error ?? null,
      status
    }),
    rawPayload: event
  });
}

export function mapClaudeProviderEvent({ event, binding, receivedAt }) {
  if (!event?.type) return null;
  const turnId = optionalText(event.turnId);
  return providerEnvelope(binding, {
    providerEventId: optionalText(event.providerEventId),
    providerSequence: optionalSequence(event.providerSequence),
    resumeToken: optionalText(event.resumeToken),
    turnId,
    itemId: optionalText(event.itemId ?? event.item?.id),
    type: event.type,
    occurredAt: optionalText(event.occurredAt),
    receivedAt,
    payload: compactObject({
      nativeType: event.nativeType ?? event.type,
      item: normalizeTimelineItem(event.item),
      error: event.error ?? null,
      failureScope: event.type === "provider.error" ? providerFailureScope(turnId) : undefined,
      willRetry: event.willRetry,
      connectionStatus: event.connectionStatus,
      plan: event.type === "plan.updated" ? event.plan : undefined
    }),
    rawPayload: event
  });
}

export function mapOpenClackyProviderChange({ change, binding, receivedAt }) {
  const event = change?.event;
  if (!event) return null;
  const type = openClackyEventType(event.type);
  if (!type) return null;
  const item = openClackyProjectedItem(event)
    ?? projectedDetailItem(change?.detail, event);
  const turnId = optionalText(event.turn_id ?? event.turnId);
  return providerEnvelope(binding, {
    providerEventId: optionalText(event.id ?? event.event_id),
    providerSequence: optionalSequence(event.sequence ?? event.seq),
    resumeToken: optionalText(event.resume_token ?? event.cursor),
    turnId,
    itemId: optionalText(item?.id ?? event.item_id),
    type,
    occurredAt: optionalText(event.created_at ?? event.occurred_at),
    receivedAt,
    payload: compactObject({
      item,
      items: type.startsWith("turn.") ? change?.detail?.items ?? undefined : undefined,
      error: change.error ?? event.error,
      failureScope: type === "provider.error" ? providerFailureScope(turnId) : undefined,
      hasAgentMessage: change.hasAgentMessage === true,
      connectionStatus: type === "provider.connection.changed"
        ? optionalText(event.connection_status ?? event.connectionStatus ?? event.status)
        : undefined,
      tokenUsage: type === "usage.updated"
        ? event.usage ?? event.token_usage ?? event.tokenUsage
        : undefined,
      nativeType: event.type
    }),
    rawPayload: event
  });
}

function providerFailureScope(turnId) {
  return turnId ? "turn" : "session";
}

function providerEnvelope(binding, event) {
  if (!binding?.bindingId || !binding.providerId || !binding.providerSessionId) {
    throw new Error("A complete Provider Binding is required to create an event envelope.");
  }
  return {
    schemaVersion: 1,
    providerId: binding.providerId,
    providerSessionId: binding.providerSessionId,
    bindingId: binding.bindingId,
    logicalSessionId: binding.logicalSessionId ?? null,
    routingVersion: Number(binding.routingVersion),
    providerEventId: event.providerEventId ?? null,
    providerSequence: event.providerSequence ?? null,
    resumeToken: event.resumeToken ?? null,
    turnId: event.turnId ?? null,
    itemId: event.itemId ?? null,
    type: event.type,
    occurredAt: event.occurredAt ?? null,
    receivedAt: event.receivedAt ?? new Date().toISOString(),
    payload: event.payload ?? {},
    rawPayload: event.rawPayload ?? {}
  };
}

function codexEventType(method, item, turn) {
  if (method === "turn/plan/updated") return "plan.updated";
  if (method === "turn/started") return "turn.started";
  if (method === "turn/completed") {
    if (turn?.status === "interrupted" || turn?.status === "cancelled") return "turn.cancelled";
    if (turn?.error || turn?.status === "failed") return "turn.failed";
    return "turn.completed";
  }
  if (method === "error") return "provider.error";
  if (method === "thread/tokenUsage/updated") return "usage.updated";
  if (method === "corptie/codexApprovalRequested") return "approval.requested";
  if (method === "corptie/codexUserInputRequested") return "interaction.requested";
  if (method === "corptie/codexUserInputSubmitted") return "interaction.submitted";
  if (method === "corptie/codexUserInputResolved") return "interaction.resolved";
  if (method !== "item/started" && method !== "item/completed") return null;
  if (item?.type === "agentMessage") {
    return method === "item/completed" ? "assistant.message.completed" : "assistant.message.started";
  }
  if (item?.type === "userMessage") return "user.message.accepted";
  if (item?.type === "approval") {
    return method === "item/completed" ? "approval.resolved" : "approval.requested";
  }
  if (TOOL_ITEM_TYPES.has(item?.type)) {
    return method === "item/completed" ? "tool.completed" : "tool.started";
  }
  return method === "item/completed" ? "tool.completed" : "tool.started";
}

function normalizedPlanSnapshot(params) {
  if (!Array.isArray(params.plan) || params.plan.length > 200) return null;
  if (params.explanation != null && typeof params.explanation !== "string") return null;
  const steps = [];
  for (const entry of params.plan) {
    if (typeof entry?.step !== "string") return null;
    const text = optionalText(entry?.step);
    if (!text || text.length > 2_000 || !["pending", "inProgress", "completed"].includes(entry?.status)) return null;
    steps.push({ text, status: entry.status });
  }
  return {
    operation: "replace",
    explanation: optionalText(params.explanation)?.slice(0, 2_000) ?? null,
    steps
  };
}

function openClackyEventType(type) {
  switch (type) {
    case "task_started": return "turn.started";
    case "task_finished": return "turn.completed";
    case "task_failed": return "turn.failed";
    case "task_cancelled": return "turn.cancelled";
    case "user_message": return "user.message.accepted";
    case "assistant_message": return "assistant.message.completed";
    case "tool_started": return "tool.started";
    case "tool_progress": return "tool.progress";
    case "tool_finished": return "tool.completed";
    case "tool_failed": return "tool.failed";
    case "request_feedback": return "approval.requested";
    case "feedback_received": return "approval.resolved";
    case "token_usage": return "usage.updated";
    case "connection_changed": return "provider.connection.changed";
    case "error": return "provider.error";
    default: return null;
  }
}

function openClackyProjectedItem(event) {
  const type = String(event?.type ?? "");
  if (type !== "assistant_message" && type !== "user_message" && type !== "request_feedback") return null;
  const text = optionalText(event.content ?? event.question);
  if (!text) return null;
  return {
    id: optionalText(event.item_id ?? event.id ?? event.event_id),
    turnId: optionalText(event.turn_id),
    turnStatus: type === "request_feedback" ? "blocked" : "inProgress",
    type: type === "user_message" ? "userMessage" : (type === "request_feedback" ? "approval" : "agentMessage"),
    title: type === "user_message" ? "You" : "OpenClacky",
    text,
    options: type === "request_feedback" ? [
      { id: "yes", label: "允许", role: "approve", index: 0, selected: false },
      { id: "no", label: "拒绝", role: "deny", index: 1, selected: false }
    ] : undefined,
    presentationRole: type === "assistant_message" ? "final_answer" : null,
    status: type === "request_feedback" ? "pending" : "completed",
    createdAt: optionalText(event.created_at)
  };
}

function projectedDetailItem(detail, event) {
  const items = Array.isArray(detail?.items) ? detail.items : [];
  const explicitItemId = optionalText(event?.item_id ?? event?.call_id);
  if (explicitItemId) {
    const exact = items.find((item) => item?.id === explicitItemId);
    if (exact) return exact;
  }
  const turnId = optionalText(event?.turn_id);
  return [...items].reverse().find((item) => !turnId || item?.turnId === turnId) ?? null;
}

function normalizeTimelineItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item ?? null;
  const userInput = asyncQuestionInput(item);
  if (userInput) {
    let raw = {};
    try { raw = JSON.parse(item.rawMetadataJSON) ?? {}; } catch { /* Native item. */ }
    item = { ...item, type: "userInput", status: "pending", userInput,
      rawMetadataJSON: JSON.stringify({ ...raw, userInput }) };
  }
  const role = normalizedPresentationRole(item.presentationRole ?? item.phase);
  const tool = TOOL_ITEM_TYPES.has(item.type);
  return {
    ...item,
    ...(tool && typeof item.text === "string" ? { text: providerSafeToolText(item.text) } : {}),
    ...(tool && typeof item.presentationText === "string"
      ? { presentationText: providerSafeToolText(item.presentationText) } : {}),
    ...(role ? { presentationRole: role } : {})
  };
}

function normalizedPresentationRole(value) {
  const normalized = optionalText(value)?.toLowerCase().replaceAll("-", "_");
  if (["final", "finalanswer", "final_answer"].includes(normalized)) return "final_answer";
  if (["analysis", "commentary", "progress"].includes(normalized)) return "commentary";
  return normalized;
}

function optionalSequence(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
