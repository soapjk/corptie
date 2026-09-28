export function userMessageCommandSource(input = {}) {
  const source = input.source && typeof input.source === "object" && !Array.isArray(input.source)
    ? { ...input.source }
    : { type: "desktop" };
  const messageId = validatedOptionalMessageCommandId(input.messageId, "messageId");
  const deliveryId = validatedOptionalMessageCommandId(input.deliveryId, "deliveryId");
  if (messageId && source.messageId && source.messageId !== messageId) {
    const error = new Error("messageId conflicts with source.messageId.");
    error.code = "MESSAGE_ID_CONFLICT";
    throw error;
  }
  if (deliveryId && source.deliveryId && source.deliveryId !== deliveryId) {
    const error = new Error("deliveryId conflicts with source.deliveryId.");
    error.code = "DELIVERY_ID_CONFLICT";
    throw error;
  }
  if (messageId) source.messageId = messageId;
  if (deliveryId) source.deliveryId = deliveryId;
  return source;
}

function validatedOptionalMessageCommandId(value, field) {
  if (value == null) return null;
  if (typeof value !== "string") {
    const error = new Error(`${field} must be a string.`);
    error.code = "INVALID_MESSAGE_IDENTITY";
    throw error;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    const error = new Error(`${field} must contain 1 to 200 characters.`);
    error.code = "INVALID_MESSAGE_IDENTITY";
    throw error;
  }
  return normalized;
}
