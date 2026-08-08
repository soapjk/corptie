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
    const providerId = this.selectProvider(input.preferredProviderId);
    const operationId = input.operationId ?? `background:${crypto.randomUUID()}`;
    const request = Object.freeze({
      purpose: requiredText(input.purpose, "purpose"),
      cwd: requiredText(input.cwd, "cwd"),
      prompt: requiredText(input.prompt, "prompt"),
      allowedRoots: Array.isArray(input.allowedRoots) ? [...input.allowedRoots] : [input.cwd],
      permissionProfile: input.permissionProfile ?? "read-only",
      model: input.preferredModel ?? null,
      reasoningEffort: input.preferredReasoning ?? null,
      timeoutMs: input.timeoutMs ?? 120_000,
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

  selectProvider(preferredProviderId = null) {
    const candidates = [preferredProviderId, this.defaultProviderId]
      .filter(Boolean);
    for (const providerId of candidates) {
      if (this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT)) return providerId;
    }
    const fallback = this.registry.descriptors().find((descriptor) => {
      return descriptor.capabilities.includes(AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT);
    });
    if (!fallback) throw new BackgroundAgentUnavailableError();
    return fallback.id;
  }
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`Background Agent ${field} is required.`);
  return text;
}
