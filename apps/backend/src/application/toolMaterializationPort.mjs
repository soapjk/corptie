export class ToolMaterializationPort {
  constructor(options = {}) {
    this.coordinator = options.coordinator;
    this.resolveCurrentBinding = options.resolveCurrentBinding;
    if (!this.coordinator) {
      throw new TypeError("ToolMaterializationPort requires the authoritative Tool Host coordinator.");
    }
    if (typeof this.resolveCurrentBinding !== "function") {
      throw new TypeError("ToolMaterializationPort requires resolveCurrentBinding().");
    }
  }

  async ensureDomainsApplied(logicalSessionId, domains, turnBoundary = {}) {
    const sessionId = requiredText(logicalSessionId, "logicalSessionId");
    const requestedDomains = normalizedDomains(domains);
    const binding = await this.#currentBinding(sessionId);
    const current = this.coordinator.store.getSessionToolCatalogMaterialization(
      sessionId, binding.providerBindingId
    );
    const desiredDomains = new Set((current?.desiredDomains ?? []).map((domain) => domain.domainId));
    for (const domain of requestedDomains) desiredDomains.add(domain);

    const result = await this.coordinator.ensureApplied({
      logicalSessionId: sessionId,
      providerBindingId: binding.providerBindingId,
      desiredDomains: [...desiredDomains],
      activeTurn: turnBoundary?.activeTurn === true,
      phase: "refresh"
    });
    if (result.status !== "applied"
      || result.record?.status !== "applied"
      || result.record.appliedVersion !== result.record.desiredVersion
      || result.record.providerReceipt?.appliedVersion !== result.record.desiredVersion) {
      throw portError(
        result.status === "blocked"
          ? "SESSION_TOOL_CATALOG_REFRESH_FAILED"
          : "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN",
        "Tool Host did not receive a matching Provider applied receipt for the requested domains.",
        503
      );
    }
    await this.#assertGeneration(binding);
    const appliedDomains = result.record.appliedDomains.map((domain) => domain.domainId);
    for (const domain of requestedDomains) {
      if (!appliedDomains.includes(domain)) {
        throw portError(
          "PROVIDER_TOOL_RECEIPT_INVALID",
          `Provider receipt did not apply the requested Tool domain: ${domain}`,
          502
        );
      }
    }
    return Object.freeze({
      status: "Applied",
      logicalSessionId: sessionId,
      appliedVersion: result.record.appliedVersion,
      appliedCatalogVersion: result.record.appliedCatalogVersion,
      appliedDomains: Object.freeze([...appliedDomains]),
      receiptId: result.record.providerReceipt.receiptId,
      appliedAt: result.record.appliedAt
    });
  }

  async assertCanonicalToolApplied(logicalSessionId, canonicalName) {
    const sessionId = requiredText(logicalSessionId, "logicalSessionId");
    const toolName = requiredText(canonicalName, "canonicalName");
    const binding = await this.#currentBinding(sessionId);
    this.coordinator.assertCanonicalToolApplied(
      sessionId, binding.providerBindingId, toolName
    );
    await this.#assertGeneration(binding);
    return true;
  }

  async #currentBinding(logicalSessionId) {
    const binding = await this.resolveCurrentBinding(logicalSessionId);
    if (!binding
      || binding.logicalSessionId !== logicalSessionId
      || !binding.providerBindingId
      || binding.state !== "active"
      || binding.isCurrent === false
      || binding.tombstoned === true) {
      throw portError("SESSION_BINDING_CHANGED", "The authenticated logical Session has no active current Provider binding.", 409);
    }
    return binding;
  }

  async #assertGeneration(expected) {
    const current = await this.#currentBinding(expected.logicalSessionId);
    if (current.providerBindingId !== expected.providerBindingId
      || Number(current.routingVersion ?? 0) !== Number(expected.routingVersion ?? 0)) {
      throw portError("SESSION_BINDING_CHANGED", "The Provider binding generation changed during Tool materialization.", 409);
    }
  }
}

function normalizedDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0) {
    throw portError("TOOL_ARGUMENT_SCHEMA_INVALID", "At least one Tool domain is required.", 400);
  }
  return [...new Set(domains.map((domain) => requiredText(domain, "domain")))].sort();
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw portError("TOOL_ARGUMENT_SCHEMA_INVALID", `${field} is required.`, 400);
  return normalized;
}

function portError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
