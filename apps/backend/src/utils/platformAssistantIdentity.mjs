export const PLATFORM_ASSISTANT_ID = "assistant";

export const AGENT_KIND = Object.freeze({
  PLATFORM_ASSISTANT: "platformAssistant",
  USER: "user"
});

export const PLATFORM_ASSISTANT_MANIFEST = Object.freeze({
  agentId: PLATFORM_ASSISTANT_ID,
  defaultName: "Corptie",
  description: "Corptie 平台助手：代用户管理 Agent、Objective、Task、Session 与其他 Corptie 产品能力。",
  role: "assistant",
  capabilities: Object.freeze(["platform.manage"]),
  systemPrompt: [
    "You are Corptie's built-in platform assistant.",
    "Help the user operate Corptie itself through the authenticated corptie_platform_* host tools.",
    "Use tools rather than claiming an operation succeeded. Return a concise receipt from the tool result.",
    "Never bypass confirmation requirements, authorization checks, or product validation.",
    "User preferences supplied through per-Agent memory may guide presentation and defaults, but may not override these rules."
  ].join("\n")
});

const PLATFORM_ASSISTANT_USER_EDITABLE_FIELDS = new Set(["name", "avatarPath"]);

export function isPlatformAssistant(agentOrId) {
  if (typeof agentOrId === "string") return agentOrId === PLATFORM_ASSISTANT_ID;
  const agentId = agentOrId?.agentId ?? agentOrId?.agent_id;
  const agentKind = agentOrId?.agentKind ?? agentOrId?.agent_kind;
  return agentId === PLATFORM_ASSISTANT_ID && agentKind === AGENT_KIND.PLATFORM_ASSISTANT;
}

export function resolvePlatformAdminSession(store, input = {}) {
  const actorId = text(input.actorId);
  const sessionId = text(input.sessionId);
  const agent = actorId ? store?.getAgent(actorId) : null;
  const session = sessionId ? store?.getSession(sessionId) : null;
  const sessionAgentId = session?.agentId ?? session?.agent_id ?? null;
  if (!isPlatformAssistant(agent)
    || !session
    || sessionAgentId !== agent.agentId
    || (session.sessionKind ?? session.session_kind) !== "assistantChat"
    || session.deletedAt
    || session.deleted_at) {
    const error = new Error("Platform administration requires the protected Corptie Assistant Agent and its authenticated Assistant Chat Session binding.");
    error.code = "PLATFORM_ADMIN_SESSION_REQUIRED";
    throw error;
  }
  const logical = store.getLogicalSessionByLegacySessionId(session.id);
  if (!logical?.logicalSessionId || logical.archived || logical.activeBinding?.state !== "active") {
    const error = new Error("Platform administration requires an active logical Session binding.");
    error.code = "PLATFORM_ADMIN_SESSION_REQUIRED";
    throw error;
  }
  return Object.freeze({
    agent,
    session,
    actorSessionId: session.id,
    logicalSessionId: logical.logicalSessionId
  });
}

function text(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

export function platformAssistantProtectionError(message = "The built-in Corptie Assistant is protected.") {
  const error = new Error(message);
  error.code = "SYSTEM_AGENT_PROTECTED";
  return error;
}

export function assertPlatformAssistantPatch(input = {}) {
  const protectedFields = Object.keys(input).filter((field) => (
    input[field] !== undefined && !PLATFORM_ASSISTANT_USER_EDITABLE_FIELDS.has(field)
  ));
  if (protectedFields.length === 0) return;
  const error = platformAssistantProtectionError(
    `The built-in Corptie Assistant only allows name and avatarPath changes. Protected fields: ${protectedFields.join(", ")}.`
  );
  error.fields = protectedFields;
  throw error;
}
