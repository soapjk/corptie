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
    // provider-neutral Agent 上下文解析器：resolveAgentContext(agentId, { intent }) → { agent, instructions }。
    // 由组合根注入（agentContextService），BackgroundAgentService 不依赖具体 Provider 或 store。
    this.resolveAgentContext = options.resolveAgentContext ?? null;
    // provider-neutral provider id 规范化器：resolveProviderId(providerTagOrId) → registryId | null。
    // agent.provider 存储的是前端展示 tag（如 "codex"），而 registry 用内部 id（如 "codex-app-server"），
    // 必须经此规范化后再交给 selectProvider，否则会抛 AgentProviderNotFoundError。
    // 未知值应返回 null，让 selectProvider 走 default / fallback 逻辑。
    this.resolveProviderId = options.resolveProviderId ?? null;
    if (!this.registry) throw new TypeError("BackgroundAgentService requires an Agent Provider Registry.");
  }

  async run(input = {}) {
    const permissionProfile = input.permissionProfile ?? "read-only";
    // 指定 Agent 时：解析其上下文（systemPrompt + description + per-agent 记忆），
    // 并按其 provider 路由；否则回退到 preferredProviderId / default。
    const agentContext = input.agentId && typeof this.resolveAgentContext === "function"
      ? await this.resolveAgentContext(input.agentId, { intent: input.intent ?? "" })
      : null;
    const preferredProviderId = agentContext?.agent?.provider
      ?? input.preferredProviderId
      ?? null;

    // agent.provider 可能是前端展示 tag（"codex"），需要规范化为 registry id；
    // 未知/未设置时返回 null，交由 selectProvider 的 default / fallback 逻辑兜底。
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
