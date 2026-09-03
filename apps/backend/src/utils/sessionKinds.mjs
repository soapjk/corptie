export const SESSION_KIND = Object.freeze({
  assistantChat: "assistantChat",
  workChat: "workChat",
  worker: "worker",
  legacy: "legacy"
});

const validSessionKinds = new Set(Object.values(SESSION_KIND));
const productSessionKinds = new Set([
  SESSION_KIND.assistantChat,
  SESSION_KIND.workChat,
  SESSION_KIND.worker
]);

export function normalizeSessionKind(value, fallback = SESSION_KIND.legacy) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return validSessionKinds.has(normalized) ? normalized : fallback;
}

export function isProductSessionKind(value) {
  return productSessionKinds.has(typeof value === "string" ? value.trim() : "");
}

// `legacy` is a read/migration sentinel, not a classification that new product
// Sessions may opt into. Reject a supplied empty/unknown value at write
// boundaries instead of silently persisting it as an unclassified Session.
export function assertExplicitSessionKind(value, { allowLegacy = false, field = "sessionKind" } = {}) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || !validSessionKinds.has(normalized) || (!allowLegacy && normalized === SESSION_KIND.legacy)) {
    const error = new TypeError(`${field} must be one of: ${Array.from(productSessionKinds).join(", ")}.`);
    error.code = "SESSION_KIND_INVALID";
    error.field = field;
    error.value = value ?? null;
    throw error;
  }
  return normalized;
}

export function inferSessionKind({ sessionKind, workId, taskId, agentRole } = {}) {
  const normalized = normalizeSessionKind(sessionKind);
  if (normalized !== SESSION_KIND.legacy) return normalized;
  if (typeof taskId === "string" && taskId.trim()) return SESSION_KIND.worker;
  if (typeof workId === "string" && workId.trim()) return SESSION_KIND.workChat;
  if (agentRole === "assistant") return SESSION_KIND.assistantChat;
  return SESSION_KIND.legacy;
}
