export class ToolMaterializationPort {
  constructor(options = {}) {
    if (typeof options.ensureDomainsApplied !== "function"
      || typeof options.assertCanonicalToolApplied !== "function") {
      throw new TypeError("ToolMaterializationPort requires Tool Host ensure/assert operations.");
    }
    this.ensure = options.ensureDomainsApplied;
    this.assert = options.assertCanonicalToolApplied;
  }

  async ensureDomainsApplied(logicalSessionId, domains, turnBoundary) {
    const receipt = await this.ensure(logicalSessionId, domains, turnBoundary);
    // Tool Host owns receipt validation, persistence, binding/version checks,
    // Provider refresh strategy, and reconciliation. Artifact consumes only the
    // final applied-domain fact and never mirrors that state machine.
    if (!Array.isArray(receipt?.appliedDomains)) {
      const error = new Error("Tool Host did not return applied domains.");
      error.code = "PROVIDER_TOOL_RECEIPT_INVALID";
      throw error;
    }
    for (const domain of domains) {
      if (!receipt.appliedDomains.includes(domain)) {
        const error = new Error(`Tool Host receipt did not apply required domain: ${domain}`);
        error.code = "PROVIDER_TOOL_RECEIPT_INVALID";
        throw error;
      }
    }
    return receipt;
  }

  async assertCanonicalToolApplied(logicalSessionId, canonicalName) {
    return this.assert(logicalSessionId, canonicalName);
  }
}

// This is the only production composition seam between Artifact and Tool Host.
// It deliberately performs no signature translation and owns no catalog,
// Provider, generation, receipt persistence, or refresh state. Until Tool Host
// exposes the approved methods, calls fail closed at this exact boundary.
export function composeArtifactToolMaterializationPort(toolHostService) {
  return new ToolMaterializationPort({
    ensureDomainsApplied(logicalSessionId, domains, turnBoundary) {
      const operation = toolHostService?.ensureDomainsApplied;
      if (typeof operation !== "function") throw missingToolHostPort("ensureDomainsApplied");
      return operation.call(toolHostService, logicalSessionId, domains, turnBoundary);
    },
    assertCanonicalToolApplied(logicalSessionId, canonicalName) {
      const operation = toolHostService?.assertCanonicalToolApplied;
      if (typeof operation !== "function") throw missingToolHostPort("assertCanonicalToolApplied");
      return operation.call(toolHostService, logicalSessionId, canonicalName);
    }
  });
}

function missingToolHostPort(operation) {
  const error = new Error(`The authoritative Tool Host ${operation} contract is unavailable.`);
  error.code = "TOOL_MATERIALIZATION_OUTCOME_UNKNOWN";
  error.statusCode = 503;
  return error;
}
