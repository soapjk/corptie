import { TOOL_HOST_BOOTSTRAP_SCHEMA_HASH } from "./hostToolCatalog.mjs";

const REPLACEMENT_ERROR = "PROVIDER_TOOL_APPLICATION_UNCONFIRMED";

export class ToolBootstrapBindingPreflight {
  constructor(options = {}) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.recoverBinding = options.recoverBinding;
    this.isSessionBusy = options.isSessionBusy ?? (() => false);
    this.isAppliedProofCurrent = options.isAppliedProofCurrent ?? (() => true);
    this.maxCandidates = positiveInteger(options.maxCandidates ?? 32, "maxCandidates");
    this.concurrency = positiveInteger(options.concurrency ?? 2, "concurrency");
    this.bootstrapSchemaHash = options.bootstrapSchemaHash ?? TOOL_HOST_BOOTSTRAP_SCHEMA_HASH;
    if (!this.store?.listSessions || !this.store?.getLogicalSessionByLegacySessionId) {
      throw new TypeError("Tool Bootstrap preflight requires a Session Store.");
    }
    if (typeof this.coordinator?.ensureApplied !== "function") {
      throw new TypeError("Tool Bootstrap preflight requires a materialization coordinator.");
    }
    if (typeof this.recoverBinding !== "function") {
      throw new TypeError("Tool Bootstrap preflight requires recoverBinding().");
    }
  }

  candidates() {
    const candidates = [];
    for (const session of this.store.listSessions({ archived: false })) {
      if (this.isSessionBusy(session)) continue;
      const logical = this.store.getLogicalSessionByLegacySessionId(session.id);
      const binding = logical?.activeBinding ?? null;
      if (!binding || binding.state !== "active" || logical.archived) continue;
      const record = this.store.getSessionToolCatalogMaterialization(
        logical.logicalSessionId,
        binding.bindingId
      );
      const claimsCurrentBootstrap = record?.status === "applied"
        && record.appliedVersion === record.desiredVersion
        && record.exposurePlan?.bootstrapSchemaHash === this.bootstrapSchemaHash;
      const appliedProofCurrent = claimsCurrentBootstrap
        && this.isAppliedProofCurrent({ session, logical, binding, record });
      if (appliedProofCurrent) {
        continue;
      }
      candidates.push(Object.freeze({
        session,
        logical,
        binding,
        record,
        untrustedAppliedProof: claimsCurrentBootstrap && !appliedProofCurrent
      }));
      if (candidates.length >= this.maxCandidates) break;
    }
    return candidates;
  }

  async run() {
    const candidates = this.candidates();
    const results = new Array(candidates.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await this.#preflight(candidates[index]);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.concurrency, candidates.length) },
      () => worker()
    ));
    return Object.freeze({
      scanned: candidates.length,
      hotApplied: results.filter((result) => result.status === "hot_applied").length,
      recovered: results.filter((result) => result.status === "recovered").length,
      failed: results.filter((result) => result.status === "failed").length,
      results: Object.freeze(results)
    });
  }

  async #preflight(candidate) {
    const input = {
      logicalSessionId: candidate.logical.logicalSessionId,
      providerBindingId: candidate.binding.bindingId,
      desiredDomains: (candidate.record?.desiredDomains ?? []).map((domain) => domain.domainId),
      activeTurn: false,
      phase: "refresh"
    };
    // A record that merely claims the current desired generation cannot pass
    // back through ensureApplied(): the Coordinator's ordinary applied fast
    // path deliberately trusts durable receipts. Once the Provider-specific
    // proof predicate rejects that receipt, replace the pre-dispatch binding
    // directly instead of accidentally promoting the same false proof again.
    if (candidate.untrustedAppliedProof) {
      return this.#recover(candidate, input);
    }
    try {
      const result = await this.coordinator.ensureApplied(input);
      return Object.freeze({
        logicalSessionId: input.logicalSessionId,
        sourceBindingId: input.providerBindingId,
        status: result.status === "applied" ? "hot_applied" : "failed",
        code: result.status === "applied" ? null : `PREFLIGHT_${String(result.status).toUpperCase()}`
      });
    } catch (error) {
      if (!safeToReplace(error)) {
        return Object.freeze({
          logicalSessionId: input.logicalSessionId,
          sourceBindingId: input.providerBindingId,
          status: "failed",
          code: error?.code ?? "TOOL_BOOTSTRAP_PREFLIGHT_FAILED"
        });
      }
      return this.#recover(candidate, input);
    }
  }

  async #recover(candidate, input) {
    try {
      await this.recoverBinding({
        logicalSessionId: input.logicalSessionId,
        providerId: candidate.binding.providerId,
        idempotencyKey: [
          "tool-bootstrap-upgrade",
          this.bootstrapSchemaHash,
          input.providerBindingId
        ].join(":"),
        sourceBindingId: input.providerBindingId,
        reason: REPLACEMENT_ERROR
      });
      return Object.freeze({
        logicalSessionId: input.logicalSessionId,
        sourceBindingId: input.providerBindingId,
        status: "recovered",
        code: REPLACEMENT_ERROR
      });
    } catch (recoveryError) {
      return Object.freeze({
        logicalSessionId: input.logicalSessionId,
        sourceBindingId: input.providerBindingId,
        status: "failed",
        code: recoveryError?.code ?? "SESSION_RECOVERY_FAILED"
      });
    }
  }
}

export function safeToReplace(error) {
  return error?.code === "SESSION_TOOL_CATALOG_REFRESH_FAILED"
    && error?.dispatchState === "not_sent"
    && error?.recoveryAction === "replace_provider_binding"
    && error?.replacementReason === REPLACEMENT_ERROR;
}

function positiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return normalized;
}
