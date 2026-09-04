import {
  TOOL_HOST_BOOTSTRAP_CONTRACT_HASH,
  TOOL_HOST_BOOTSTRAP_SCHEMA_HASH
} from "./hostToolCatalog.mjs";

const REPLACEMENT_ERROR = "PROVIDER_TOOL_APPLICATION_UNCONFIRMED";
const RECOVERY_REQUIRED_CODE = "PROVIDER_TOOL_RECOVERY_REQUIRED";
const RECOVERY_REQUIRED_SUMMARY = "The existing Provider Thread was preserved, but its Tool schema must be upgraded. Start Session Recovery to replace it safely.";

export class ToolBootstrapBindingPreflight {
  constructor(options = {}) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.isSessionBusy = options.isSessionBusy ?? (() => false);
    this.isAppliedProofCurrent = options.isAppliedProofCurrent ?? (() => true);
    this.maxCandidates = positiveInteger(options.maxCandidates ?? 32, "maxCandidates");
    this.concurrency = positiveInteger(options.concurrency ?? 2, "concurrency");
    this.bootstrapContractHash = options.bootstrapContractHash ?? TOOL_HOST_BOOTSTRAP_CONTRACT_HASH;
    if (!this.store?.listSessions || !this.store?.getLogicalSessionByLegacySessionId) {
      throw new TypeError("Tool Bootstrap preflight requires a Session Store.");
    }
    if (typeof this.coordinator?.ensureApplied !== "function") {
      throw new TypeError("Tool Bootstrap preflight requires a materialization coordinator.");
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
        && (record.exposurePlan?.bootstrapContractHash === this.bootstrapContractHash
          || record.exposurePlan?.bootstrapSchemaHash === TOOL_HOST_BOOTSTRAP_SCHEMA_HASH);
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
      recoveryRequired: results.filter((result) => result.status === "recovery_required").length,
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
    // Startup preparation may verify or reconnect the existing binding, but
    // only an explicit Restart/Recovery operation may replace its Thread.
    if (candidate.untrustedAppliedProof) {
      await this.#markRecoveryRequired(input);
      return recoveryRequired(input);
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
      // ensureApplied records the low-level Provider rejection first. Replace
      // that implementation detail with the product-level recovery state so
      // an intentional bootstrap ABI upgrade does not surface as a fleet of
      // apparently broken Codex threads after an App update.
      await this.#markRecoveryRequired(input);
      return recoveryRequired(input);
    }
  }

  async #markRecoveryRequired(input) {
    if (typeof this.coordinator.markBindingRecoveryRequired === "function") {
      await this.coordinator.markBindingRecoveryRequired(
        input.logicalSessionId,
        input.providerBindingId,
        RECOVERY_REQUIRED_CODE,
        RECOVERY_REQUIRED_SUMMARY
      );
      return;
    }
    await this.coordinator.invalidateAppliedProof(
      input.logicalSessionId,
      input.providerBindingId,
      RECOVERY_REQUIRED_CODE,
      RECOVERY_REQUIRED_SUMMARY
    );
  }
}

function recoveryRequired(input) {
  return Object.freeze({
    logicalSessionId: input.logicalSessionId,
    sourceBindingId: input.providerBindingId,
    status: "recovery_required",
    code: RECOVERY_REQUIRED_CODE
  });
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
