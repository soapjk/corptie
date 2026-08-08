import {
  AGENT_PROVIDER_METHOD_BY_CAPABILITY,
  AgentProviderCapabilityError,
  AgentProviderContractError,
  AgentProviderNotFoundError,
  providerSupports,
  validateAgentProvider
} from "./contracts.mjs";
import { withSessionActions } from "./sessionActions.mjs";

export class AgentProviderRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    const descriptor = validateAgentProvider(provider);
    if (this.providers.has(descriptor.id)) {
      throw new AgentProviderContractError(`Agent Provider is already registered: ${descriptor.id}`, {
        providerId: descriptor.id
      });
    }
    provider.descriptor = descriptor;
    this.providers.set(descriptor.id, provider);
    return descriptor;
  }

  unregister(providerId) {
    return this.providers.delete(normalizedProviderId(providerId));
  }

  get(providerId) {
    const normalized = normalizedProviderId(providerId);
    const provider = this.providers.get(normalized);
    if (!provider) throw new AgentProviderNotFoundError(normalized);
    return provider;
  }

  descriptors() {
    return Array.from(this.providers.values())
      .map((provider) => provider.descriptor)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  supports(providerId, capability) {
    return providerSupports(this.get(providerId), capability);
  }

  requireCapability(providerId, capability) {
    const provider = this.get(providerId);
    if (!providerSupports(provider, capability)) {
      throw new AgentProviderCapabilityError(provider.descriptor.id, capability);
    }
    const method = AGENT_PROVIDER_METHOD_BY_CAPABILITY[capability];
    if (!method || typeof provider[method] !== "function") {
      throw new AgentProviderContractError(
        `Agent Provider ${provider.descriptor.id} has no operation for ${capability}.`,
        { providerId: provider.descriptor.id, capability, method: method ?? null }
      );
    }
    return { provider, method };
  }

  invoke(providerId, capability, ...args) {
    const { provider, method } = this.requireCapability(providerId, capability);
    return provider[method](...args);
  }

  decorateSession(providerId, session) {
    return withSessionActions(session, this.get(providerId).descriptor);
  }

  async listSessions(options = {}) {
    const results = await Promise.all(
      Array.from(this.providers.values()).map(async (provider) => {
        const sessions = await provider.listSessions(options);
        return sessions.map((session) => withSessionActions(session, provider.descriptor));
      })
    );
    return sortedSessions(results.flat());
  }

  // Compatibility path for the current synchronous store-backed call sites.
  // New application services should use listSessions().
  listSessionsSync(options = {}) {
    const results = Array.from(this.providers.values()).map((provider) => {
      const sessions = provider.listSessions(options);
      if (sessions && typeof sessions.then === "function") {
        throw new AgentProviderContractError(
          `Agent Provider ${provider.descriptor.id} returned an asynchronous Session list to a synchronous caller.`,
          { providerId: provider.descriptor.id, method: "listSessions" }
        );
      }
      return sessions.map((session) => withSessionActions(session, provider.descriptor));
    });
    return sortedSessions(results.flat());
  }
}

function sortedSessions(sessions) {
  return sessions.sort(compareSessionOrder);
}

function normalizedProviderId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new AgentProviderNotFoundError(String(value ?? ""));
  return normalized;
}

function compareSessionOrder(left, right) {
  const leftPinned = left?.pinned === true ? 1 : 0;
  const rightPinned = right?.pinned === true ? 1 : 0;
  if (leftPinned !== rightPinned) return rightPinned - leftPinned;
  const leftOrder = Number.isFinite(left?.sortOrder) ? left.sortOrder : 0;
  const rightOrder = Number.isFinite(right?.sortOrder) ? right.sortOrder : 0;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(right?.updatedAt ?? "").localeCompare(String(left?.updatedAt ?? ""));
}
