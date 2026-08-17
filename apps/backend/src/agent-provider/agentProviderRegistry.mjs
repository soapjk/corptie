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
  constructor(providers = [], options = {}) {
    this.providers = new Map();
    this.providerIdsByIdentity = new Map();
    this.defaultProviderId = normalizedOptionalProviderId(options.defaultProviderId);
    for (const provider of providers) this.register(provider);
    if (this.defaultProviderId) {
      this.defaultProviderId = this.resolveId(this.defaultProviderId);
      if (!this.defaultProviderId) {
        throw new AgentProviderNotFoundError(options.defaultProviderId);
      }
    }
  }

  register(provider) {
    const descriptor = validateAgentProvider(provider);
    const identities = [descriptor.id, ...descriptor.aliases].map(normalizedProviderIdentity);
    for (const identity of identities) {
      const owner = this.providerIdsByIdentity.get(identity);
      if (owner) {
        throw new AgentProviderContractError(`Agent Provider identity is already registered: ${identity}`, {
          providerId: descriptor.id,
          identity,
          existingProviderId: owner
        });
      }
    }
    provider.descriptor = descriptor;
    this.providers.set(descriptor.id, provider);
    for (const identity of identities) this.providerIdsByIdentity.set(identity, descriptor.id);
    return descriptor;
  }

  unregister(providerId) {
    const resolved = this.resolveId(providerId);
    if (!resolved) return false;
    const provider = this.providers.get(resolved);
    if (!provider) return false;
    for (const identity of [provider.descriptor.id, ...provider.descriptor.aliases]) {
      this.providerIdsByIdentity.delete(normalizedProviderIdentity(identity));
    }
    return this.providers.delete(resolved);
  }

  get(providerId) {
    const normalized = normalizedProviderId(providerId);
    const resolved = this.resolveId(normalized);
    const provider = resolved ? this.providers.get(resolved) : null;
    if (!provider) throw new AgentProviderNotFoundError(normalized);
    return provider;
  }

  resolveId(providerId, options = {}) {
    const normalized = normalizedOptionalProviderId(providerId);
    if (!normalized) return options.useDefault === true ? this.defaultProviderId : null;
    return this.providerIdsByIdentity.get(normalized) ?? null;
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

function normalizedProviderIdentity(value) {
  return normalizedProviderId(value).toLowerCase();
}

function normalizedOptionalProviderId(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized || null;
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
