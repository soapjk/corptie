import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";
import { SessionNotFoundError } from "../agent-provider/sessionApplicationService.mjs";

export class SessionWorkspaceCoordinator {
  constructor(options = {}) {
    this.registry = options.registry;
    this.resolveSessionReference = options.resolveSessionReference;
    this.onTransitionEvent = options.onTransitionEvent ?? (() => {});
    if (!this.registry) throw new TypeError("SessionWorkspaceCoordinator requires an Agent Provider Registry.");
    if (typeof this.resolveSessionReference !== "function") {
      throw new TypeError("SessionWorkspaceCoordinator requires resolveSessionReference().");
    }
  }

  async switchWorkspace(sessionId, input = {}) {
    const reference = await this.resolveSessionReference(sessionId);
    if (!reference?.providerId || !reference?.providerSessionId) {
      throw new SessionNotFoundError(sessionId);
    }
    const targetWorkspaceId = requiredText(input.targetWorkspaceId, "targetWorkspaceId");
    this.onTransitionEvent("SessionWorkspaceTransitionRequested", {
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId ?? null,
      targetWorkspaceId
    });
    const result = await this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION,
      reference,
      { ...input, targetWorkspaceId }
    );
    this.onTransitionEvent("SessionWorkspaceTransitionSettled", {
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId ?? null,
      targetWorkspaceId,
      status: result?.status ?? "completed"
    });
    return result;
  }
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}
