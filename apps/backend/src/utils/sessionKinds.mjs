export const SESSION_KIND = Object.freeze({
  assistantChat: "assistantChat",
  worker: "worker",
  legacy: "legacy"
});

const validSessionKinds = new Set(Object.values(SESSION_KIND));

export function normalizeSessionKind(value, fallback = SESSION_KIND.legacy) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return validSessionKinds.has(normalized) ? normalized : fallback;
}

export function inferSessionKind({ sessionKind, workItemId, agentRole } = {}) {
  const normalized = normalizeSessionKind(sessionKind);
  if (normalized !== SESSION_KIND.legacy) return normalized;
  if (typeof workItemId === "string" && workItemId.trim()) return SESSION_KIND.worker;
  if (agentRole === "assistant") return SESSION_KIND.assistantChat;
  return SESSION_KIND.legacy;
}
