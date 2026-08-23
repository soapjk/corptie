import { createHash } from "node:crypto";

export function collaborationMcpServerName(agentId) {
  const identity = String(agentId ?? "").trim();
  const suffix = createHash("sha256").update(identity || "anonymous").digest("hex").slice(0, 12);
  // Codex prefixes and normalizes MCP names before registering them as tools.
  // Keep the per-Agent isolation suffix, but leave ample room below the
  // Responses API's 64-character function-name limit for the actual tool name.
  return `ctc-${suffix}`;
}

export function collaborationMcpEnvironment({
  agentId,
  backendUrl,
  environmentName,
  metadata = null
}) {
  return {
    CORPTIE_AGENT_ID: String(agentId ?? "").trim(),
    CORPTIE_BACKEND_URL: backendUrl,
    CORPTIE_ENV: environmentName,
    CORPTIE_SESSION_ID: metadata?.sessionId ?? "",
    CORPTIE_SESSION_KIND: metadata?.sessionKind ?? "",
    CORPTIE_OBJECTIVE_ID: metadata?.objectiveId ?? "",
    CORPTIE_WORK_ITEM_ID: metadata?.workItemId ?? "",
    ...(metadata?.sessionKind === "objectiveChat" && metadata?.objectiveId
      ? {
          CORPTIE_OBJECTIVE_CHAT_ID: metadata.objectiveId,
          CORPTIE_OBJECTIVE_CHAT_SESSION_ID: metadata.sessionId ?? ""
        }
      : {})
  };
}
