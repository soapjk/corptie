import { createHash } from "node:crypto";

export function collaborationMcpServerName(agentId) {
  const identity = String(agentId ?? "").trim();
  const suffix = createHash("sha256").update(identity || "anonymous").digest("hex").slice(0, 12);
  // Codex prefixes and normalizes MCP names before registering them as tools.
  // Keep the per-Agent isolation suffix, but leave ample room below the
  // Responses API's 64-character function-name limit for the actual tool name.
  return `ctc-${suffix}`;
}
