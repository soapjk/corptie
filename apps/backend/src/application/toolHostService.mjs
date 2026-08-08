import { randomUUID } from "node:crypto";
import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";

export class ToolHostService {
  constructor(options = {}) {
    this.registry = options.registry;
    this.catalog = options.catalog;
    if (!this.registry) throw new TypeError("ToolHostService requires an Agent Provider Registry.");
    if (!this.catalog) throw new TypeError("ToolHostService requires a Host Tool Catalog.");
  }

  async prepareSession(providerId, context = {}) {
    if (!this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH)) return null;
    const actorId = normalizedText(context.actorId) ?? `agent-${randomUUID()}`;
    const attachment = Object.freeze({
      actorId,
      tools: Object.freeze([...this.catalog.definitions()]),
      metadata: Object.freeze({ purpose: context.purpose ?? "session" })
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
