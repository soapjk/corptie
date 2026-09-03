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
    CORPTIE_PROVIDER_BINDING_ID: metadata?.providerBindingId ?? "",
    CORPTIE_SESSION_KIND: metadata?.sessionKind ?? "",
    CORPTIE_WORK_ID: metadata?.workId ?? "",
    CORPTIE_TASK_ID: metadata?.taskId ?? "",
    ...(metadata?.sessionKind === "workChat" && metadata?.workId
      ? {
          CORPTIE_WORK_CHAT_ID: metadata.workId,
          CORPTIE_WORK_CHAT_SESSION_ID: metadata.sessionId ?? ""
        }
      : {})
  };
}
