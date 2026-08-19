import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";

export class ToolHostService {
  constructor(options = {}) {
    this.registry = options.registry;
    this.catalog = options.catalog;
    this.resolveMcpServers = options.resolveMcpServers ?? null;
    if (!this.registry) throw new TypeError("ToolHostService requires an Agent Provider Registry.");
    if (!this.catalog) throw new TypeError("ToolHostService requires a Host Tool Catalog.");
  }

  async prepareSession(providerId, context = {}) {
    const supportsAttachment = this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH);
    // Session 必须绑定已有 Agent：actorId 必传，不再静默生成随机 actor。
    const actorId = normalizedText(context.actorId);
    if (!supportsAttachment && !actorId) return null;
    if (!actorId) {
      const error = new Error("A session must be bound to an existing Agent; actorId is required.");
      error.code = "AGENT_REQUIRED";
      throw error;
    }
    const mcpServers = typeof this.resolveMcpServers === "function"
      ? await this.resolveMcpServers({ actorId, providerId, context })
      : {};
    if (!supportsAttachment) {
      if (Object.keys(mcpServers ?? {}).length > 0) {
        const error = new Error(`Agent Provider ${providerId} cannot attach assigned Skill MCP dependencies.`);
        error.code = "MCP_PROVIDER_UNSUPPORTED";
        throw error;
      }
      return null;
    }
    const attachment = Object.freeze({
      actorId,
      tools: Object.freeze([...this.catalog.definitions({ actorId, metadata: context })]),
      mcpServers: Object.freeze({ ...(mcpServers ?? {}) }),
      metadata: Object.freeze({ ...context, purpose: context.purpose ?? "session" })
    });
    const providerAttachment = await this.registry.invoke(
      providerId,
      AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH,
      attachment,
      context
    );
    return Object.freeze({ actorId, providerAttachment });
  }

  execute(input = {}) {
    return this.catalog.execute(input);
  }
}

function normalizedText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
