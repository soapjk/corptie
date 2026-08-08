import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";

export class BackgroundAgentUnavailableError extends Error {
  constructor() {
    super("No registered Agent Provider supports hidden background prompts.");
    this.name = "BackgroundAgentUnavailableError";
    this.code = "BACKGROUND_AGENT_UNAVAILABLE";
  }
}

export class BackgroundAgentService {
  constructor(options = {}) {
    this.registry = options.registry;
    this.defaultProviderId = options.defaultProviderId ?? null;
    this.onOperationEvent = options.onOperationEvent ?? (() => {});
    if (!this.registry) throw new TypeError("BackgroundAgentService requires an Agent Provider Registry.");
  }

  async run(input = {}) {
    const permissionProfile = input.permissionProfile ?? "read-only";
    const providerId = this.selectProvider(input.preferredProviderId, permissionProfile);
    const operationId = input.operationId ?? `background:${crypto.randomUUID()}`;
    const request = Object.freeze({
      purpose: requiredText(input.purpose, "purpose"),
      cwd: requiredText(input.cwd, "cwd"),
      prompt: requiredText(input.prompt, "prompt"),
      allowedRoots: Array.isArray(input.allowedRoots) ? [...input.allowedRoots] : [input.cwd],
      permissionProfile,
      model: input.preferredModel ?? null,
      reasoningEffort: input.preferredReasoning ?? null,
      timeoutMs: input.timeoutMs ?? 120_000,
      developerInstructions: typeof input.developerInstructions === "string"
        ? input.developerInstructions.trim()
        : null,
      historyPolicy: "hidden"
    });
    this.onOperationEvent("BackgroundAgentStarted", { operationId, providerId, purpose: request.purpose });
    try {
      const result = await this.registry.invoke(
        providerId,
        AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT,
        request
      );
      this.onOperationEvent("BackgroundAgentCompleted", { operationId, providerId, purpose: request.purpose });
      return { operationId, providerId, historyPolicy: "hidden", ...result };
    } catch (error) {
      this.onOperationEvent("BackgroundAgentFailed", {
        operationId,
        providerId,
        purpose: request.purpose,
        error: error.message
      });
      throw error;
    }
  }

  selectProvider(preferredProviderId = null, permissionProfile = "read-only") {
    const candidates = [preferredProviderId, this.defaultProviderId]
      .filter(Boolean);
    for (const providerId of candidates) {
      if (this.supportsPermissionProfile(providerId, permissionProfile)) return providerId;
    }
    const fallback = this.registry.descriptors().find((descriptor) => {
      return this.supportsPermissionProfile(descriptor.id, permissionProfile);
    });
    if (!fallback) throw new BackgroundAgentUnavailableError();
    return fallback.id;
  }

  supportsPermissionProfile(providerId, permissionProfile) {
    if (!this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT)) return false;
    const profiles = this.registry.get(providerId).descriptor.metadata?.backgroundPermissionProfiles;
    const supported = Array.isArray(profiles) && profiles.length > 0 ? profiles : ["read-only"];
    return supported.includes(permissionProfile);
  }
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`Background Agent ${field} is required.`);
  return text;
}
