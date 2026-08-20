import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";

export class ToolHostService {
  constructor(options = {}) {
    this.registry = options.registry;
    this.catalog = options.catalog;
    this.resolveMcpServers = options.resolveMcpServers ?? null;
    this.recordRuntimeEvent = options.recordRuntimeEvent ?? null;
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
    let mcpServers;
    try {
      mcpServers = typeof this.resolveMcpServers === "function"
        ? await this.resolveMcpServers({ actorId, providerId, context })
        : {};
    } catch (error) {
      this.#record({
        stage: context.purpose === "session-resume" ? "session-recovery" : "provider-materialization",
        status: "failed",
        agentId: actorId,
        sessionId: context.sessionId ?? null,
        providerId,
        errorCode: error?.code ?? "MCP_LOADING_FAILED",
        reason: error?.message ?? String(error)
      });
      throw error;
    }
    const mcpServerNames = Object.keys(mcpServers ?? {});
    if (mcpServerNames.length > 0
      && !this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.SKILL_MCP_DEPENDENCIES)) {
      const error = new Error(`Agent Provider ${providerId} cannot materialize assigned Skill MCP dependencies.`);
      error.code = "MCP_PROVIDER_UNSUPPORTED";
      this.#record({
        stage: "provider-materialization",
        status: "failed",
        agentId: actorId,
        sessionId: context.sessionId ?? null,
        providerId,
        serverNames: mcpServerNames,
        errorCode: error.code,
        reason: error.message
      });
      throw error;
    }
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
    let providerAttachment;
    try {
      providerAttachment = await this.registry.invoke(
        providerId,
        AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH,
        attachment,
        context
      );
    } catch (error) {
      this.#record({
        stage: "provider-materialization",
        status: "failed",
        agentId: actorId,
        sessionId: context.sessionId ?? null,
        providerId,
        serverNames: mcpServerNames,
        errorCode: error?.code ?? "PROVIDER_TOOL_MATERIALIZATION_FAILED",
        reason: error?.message ?? String(error)
      });
      throw error;
    }
    this.#record({
      stage: context.purpose === "session-resume" ? "session-recovery" : "provider-materialization",
      status: "success",
      agentId: actorId,
      sessionId: context.sessionId ?? null,
      providerId,
      serverNames: mcpServerNames,
      reason: context.purpose === "session-resume"
        ? "Session recovery rebuilt the Tool Host attachment."
        : "Provider Tool Host attachment materialized."
    });
    return Object.freeze({ actorId, providerAttachment });
  }

  execute(input = {}) {
    return this.catalog.execute(input);
  }

  #record(event) {
    if (typeof this.recordRuntimeEvent !== "function") return null;
    return this.recordRuntimeEvent(event);
  }
}

function normalizedText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
