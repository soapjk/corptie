import { AGENT_PROVIDER_CAPABILITIES, AgentProviderNotFoundError } from "../agent-provider/contracts.mjs";
import { performance } from "node:perf_hooks";
import { BackgroundOperationQueue } from "./backgroundOperationQueue.mjs";

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
    this.isEnabled = options.isEnabled ?? (() => true);
    this.queue = options.queue ?? new BackgroundOperationQueue();
    this.activeControllers = new Map();
    if (!this.registry) throw new TypeError("BackgroundAgentService requires an Agent Provider Registry.");
  }

  async run(input = {}) {
    if (!this.isEnabled()) throw backgroundError("BACKGROUND_EXECUTION_DISABLED", "Background execution is disabled.");
    const operationId = input.operationId ?? `background:${crypto.randomUUID()}`;
    if (this.activeControllers.has(operationId)) throw backgroundError("BACKGROUND_OPERATION_EXISTS", "Operation is already active.");
    const timeoutMs = input.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new TypeError("Background timeout must be between 1 and 600000 ms.");
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(input.signal.reason);
    if (input.signal?.aborted) forwardAbort();
    else input.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(backgroundError("BACKGROUND_TIMEOUT", "Background deadline exceeded.")), timeoutMs);
    timeout.unref?.();
    this.activeControllers.set(operationId, controller);
    const queuedAt = performance.now();
    try {
      return await this.queue.run(() => {
        if (!this.isEnabled()) throw backgroundError("BACKGROUND_EXECUTION_DISABLED", "Background execution is disabled.");
        return this.execute({ ...input, operationId, signal: controller.signal,
          timeoutMs: Math.max(1, Math.ceil(timeoutMs - (performance.now() - queuedAt))),
          queueWaitMs: roundedMilliseconds(performance.now() - queuedAt) });
      }, { signal: controller.signal, priority: input.priority === "interactive" ? 1 : 0 });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", forwardAbort);
      this.activeControllers.delete(operationId);
    }
  }

  cancel(operationId) {
    const controller = this.activeControllers.get(operationId);
    if (!controller) return false;
    controller.abort(backgroundError("BACKGROUND_CANCELLED", "Background operation cancelled."));
    return true;
  }

  close() {
    this.queue.close();
    for (const operationId of this.activeControllers.keys()) this.cancel(operationId);
  }

  async execute(input = {}) {
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

    input.signal?.throwIfAborted();
    if (input.allowProviderFallback === false && preferredProviderId && !resolvedProviderId) {
      throw new BackgroundAgentUnavailableError();
    }

    const providerId = this.selectProvider(resolvedProviderId, permissionProfile, {
      allowFallback: input.allowProviderFallback !== false,
      executionPolicy: input.executionPolicy ?? "legacy"
    });
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
      historyPolicy: "hidden",
      signal: input.signal,
      executionPolicy: input.executionPolicy ?? "legacy",
      outputSchema: input.outputSchema ?? null
    });
    this.onOperationEvent("BackgroundAgentStarted", {
      operationId,
      providerId,
      purpose: request.purpose,
      phases: { agentContextMs }
    });
    const providerStartedAt = performance.now();
    try {
      input.signal?.throwIfAborted();
      const result = await this.registry.invoke(
        providerId,
        AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT,
        request
      );
      input.signal?.throwIfAborted();
      const validatedOutput = input.validateOutput ? input.validateOutput(result.text ?? "") : undefined;
      const performanceMeasurement = {
        phases: {
          agentContextMs,
          queueWaitMs: input.queueWaitMs,
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
      return { ...result, operationId, providerId, historyPolicy: "hidden", validatedOutput, performance: performanceMeasurement };
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

  selectProvider(preferredProviderId = null, permissionProfile = "read-only", { allowFallback = true, executionPolicy = "legacy" } = {}) {
    const supports = (id) => this.supportsPermissionProfile(id, permissionProfile)
      && (executionPolicy === "legacy" || this.registry.get(id).descriptor.metadata?.backgroundExecutionPolicies?.includes(executionPolicy));
    if (!allowFallback) {
      const providerId = preferredProviderId ?? this.defaultProviderId;
      if (providerId && supports(providerId)) return providerId;
      throw new BackgroundAgentUnavailableError();
    }
    const candidates = [preferredProviderId, this.defaultProviderId]
      .filter(Boolean);
    for (const providerId of candidates) {
      if (supports(providerId)) return providerId;
    }
    const fallback = this.registry.descriptors().find((descriptor) => {
      return supports(descriptor.id);
    });
    if (!fallback) throw new BackgroundAgentUnavailableError();
    return fallback.id;
  }

  supportsPermissionProfile(providerId, permissionProfile) {
    try {
      if (!this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT)) return false;
    } catch (error) {
      if (error instanceof AgentProviderNotFoundError) return false;
      throw error;
    }
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

function backgroundError(code, message) { return Object.assign(new Error(message), { code }); }
