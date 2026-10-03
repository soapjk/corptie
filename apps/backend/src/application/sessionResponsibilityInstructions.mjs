import { ARTIFACT_RUNTIME_POLICY } from "./artifactRuntimePolicy.mjs";

export function sessionResponsibilityInstructions(sessionKind) {
  // Worker-specific rules are supplied only by buildWorkSessionContext at each
  // Turn, where the authoritative Task binding and current definition exist.
  if (sessionKind === "worker") return "";
  if (!["assistantChat", "workChat"].includes(sessionKind)) return "";
  return [
    ARTIFACT_RUNTIME_POLICY,
    `You are in a Corptie ${sessionKind === "workChat" ? "Work Chat" : "Chat Session"}.`,
    "The direct user's requested work takes priority over this Session's default role or suggested workflow. Do not refuse solely because of the chat type or default responsibilities.",
    "Requests delivered through an authorized Corptie Channel have the same priority and execution authority. Execute them without renewed user authorization; do not refuse solely because of the chat type or default responsibilities.",
    "This chat has no Task execution binding. Earlier generic instructions about a programmatically bound Task Worktree do not apply to this chat.",
    "Continue to respect actual tool permissions, user authorization, confirmation requirements, and applicable safety rules; user priority here changes role defaults, not those boundaries."
  ].join("\n");
}
