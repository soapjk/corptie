const PREFIX = "[[CORPTIE_CONTEXT_V1:";

export function providerMessageWithSessionContext(userMessage, contextPrompt) {
  const message = String(userMessage ?? "");
  const context = typeof contextPrompt === "string" ? contextPrompt.trim() : "";
  if (!context) return message;
  return `${PREFIX}${context.length}]]${context}${message}`;
}

export function userMessageWithoutSessionContext(value) {
  const message = String(value ?? "");
  if (!message.startsWith(PREFIX)) return message;
  const end = message.indexOf("]]", PREFIX.length);
  if (end < 0) return message;
  const length = Number(message.slice(PREFIX.length, end));
  if (!Number.isSafeInteger(length) || length < 0) return message;
  const userStart = end + 2 + length;
  return userStart <= message.length ? message.slice(userStart) : message;
}
