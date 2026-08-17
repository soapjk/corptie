export const PLATFORM_ASSISTANT_ID = "assistant";

export const AGENT_KIND = Object.freeze({
  PLATFORM_ASSISTANT: "platformAssistant",
  USER: "user"
});

export const PLATFORM_ASSISTANT_MANIFEST = Object.freeze({
  agentId: PLATFORM_ASSISTANT_ID,
  defaultName: "Corptie",
  description: "Corptie 平台助手：代用户管理 Agent、Objective、WorkItem、Session 与其他 Corptie 产品能力。",
  role: "assistant",
  provider: "codex-app-server",
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
  return agentOrId?.agentId === PLATFORM_ASSISTANT_ID
    || agentOrId?.agent_id === PLATFORM_ASSISTANT_ID
    || agentOrId?.agentKind === AGENT_KIND.PLATFORM_ASSISTANT
    || agentOrId?.agent_kind === AGENT_KIND.PLATFORM_ASSISTANT;
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
