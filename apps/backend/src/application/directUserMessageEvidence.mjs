import { directUserTaskCreationRejection } from "./directUserTaskCreationAuthorization.mjs";

// Shared by all Provider dispatch paths, including IMgateway ingress. Only
// persisted direct-user events can supply evidence; source metadata alone cannot.
export function buildDirectUserMessageEvidence(store, reference, context = {}) {
  const source = context.source;
  if (!source?.messageId || !reference.logicalSessionId) return null;
  const event = store.getSessionEvent(`user-message:${source.messageId}`);
  if (directUserTaskCreationRejection(event)
    || event.sessionId !== reference.sessionId
    || event.payload?.message?.id !== source.messageId
    || directUserTaskCreationRejection({ ...event, source })) return null;
  const delivery = store.getMessageDelivery(event.payload?.deliveryId);
  if (!delivery || delivery.sessionId !== reference.sessionId
    || delivery.messageId !== source.messageId
    || (source.deliveryId && source.deliveryId !== delivery.deliveryId)) return null;
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) return null;
  const attributes = {
    logical_session_id: reference.logicalSessionId,
    event_id: event.eventId,
    sequence: event.sequence,
    turn_id: delivery.deliveryId
  };
  return {
    prompt: `<corptie_direct_user_message_evidence ${Object.entries(attributes).map(([key, value]) => `${key}="${escapeAttribute(value)}"`).join(" ")}>\nThis evidence identifies only this direct user turn; it is not authorization by itself. Use it for Task lifecycle tools only as explicitly requested by the user. Never create a new Task unless this user message explicitly requests creation of a new Task.\n</corptie_direct_user_message_evidence>`
  };
}

function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
