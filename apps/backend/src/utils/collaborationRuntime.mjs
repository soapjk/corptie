import { createHash } from "node:crypto";

export function collaborationMcpServerName(agentId) {
  const identity = String(agentId ?? "").trim();
  const suffix = createHash("sha256").update(identity || "anonymous").digest("hex").slice(0, 12);
  return `corptie-collaboration-${suffix}`;
}
