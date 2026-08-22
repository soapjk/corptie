import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";
import { performance } from "node:perf_hooks";

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
    // provider-neutral Agent 上下文解析器：resolveAgentContext(agentId, { intent }) → { agent, instructions }。
    // 由组合根注入（agentContextService），BackgroundAgentService 不依赖具体 Provider 或 store。
    this.resolveAgentContext = options.resolveAgentContext ?? null;
    // provider-neutral provider id 规范化器：resolveProviderId(providerTagOrId) → registryId | null。
    // Provider belongs to the invoking Session/background operation, never to the Agent resource bundle.
    this.resolveProviderId = options.resolveProviderId ?? null;
    if (!this.registry) throw new TypeError("BackgroundAgentService requires an Agent Provider Registry.");
  }

  async run(input = {}) {
    const operationStartedAt = performance.now();
    const permissionProfile = input.permissionProfile ?? "read-only";
    // 指定 Agent 只解析资源上下文（systemPrompt + description + per-agent 记忆）。
    // Runtime routing comes exclusively from the invoking Session/request or the background default.
    const agentContext = input.agentId && typeof this.resolveAgentContext === "function"
      ? await this.resolveAgentContext(input.agentId, { intent: input.intent ?? "" })
      : null;
    const agentContextMs = roundedMilliseconds(performance.now() - operationStartedAt);
    const preferredProviderId = input.preferredProviderId ?? null;

    const resolvedProviderId = this.resolveProviderId
      ? this.resolveProviderId(preferredProviderId)
      : preferredProviderId;

    const providerId = this.selectProvider(resolvedProviderId, permissionProfile);
    const operationId = input.operationId ?? `background:${crypto.randomUUID()}`;

    const developerInstructions = [
      agentContext?.instructions,
      typeof input.developerInstructions === "string" ? input.developerInstructions.trim() : null
    ].filter(Boolean).join("\n\n");

    const request = Object.freeze({
      purpose: requiredText(input.purpose, "purpose"),
      cwd: requiredText(input.cwd, "cwd"),
      prompt: requiredText(input.prompt, "prompt"),
      allowedRoots: Array.isArray(input.allowedRoots) ? [...input.allowedRoots] : [input.cwd],
      permissionProfile,
      model: input.preferredModel ?? null,
      reasoningEffort: input.preferredReasoning ?? null,
      timeoutMs: input.timeoutMs ?? 120_000,
      developerInstructions: developerInstructions || null,
      historyPolicy: "hidden"
    });
    this.onOperationEvent("BackgroundAgentStarted", {
      operationId,
      providerId,
      purpose: request.purpose,
      phases: { agentContextMs }
    });
    const providerStartedAt = performance.now();
    try {
      const result = await this.registry.invoke(
        providerId,
        AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT,
        request
      );
      const performanceMeasurement = {
        phases: {
          agentContextMs,
          providerInvokeMs: roundedMilliseconds(performance.now() - providerStartedAt)
        },
        totalMs: roundedMilliseconds(performance.now() - operationStartedAt)
      };
      this.onOperationEvent("BackgroundAgentCompleted", {
        operationId,
        providerId,
        purpose: request.purpose,
        ...performanceMeasurement
      });
      return { operationId, providerId, historyPolicy: "hidden", ...result, performance: performanceMeasurement };
    } catch (error) {
      const performanceMeasurement = {
        phases: {
          agentContextMs,
          providerInvokeMs: roundedMilliseconds(performance.now() - providerStartedAt)
        },
        totalMs: roundedMilliseconds(performance.now() - operationStartedAt)
      };
      this.onOperationEvent("BackgroundAgentFailed", {
        operationId,
        providerId,
        purpose: request.purpose,
        error: error.message,
        ...performanceMeasurement
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

function roundedMilliseconds(value) {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`Background Agent ${field} is required.`);
  return text;
}
