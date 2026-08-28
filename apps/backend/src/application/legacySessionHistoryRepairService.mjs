// Commit 1afc169 switched product history reads to the durable Store at this
// instant. Sessions created afterwards already project Provider events live.
export const LEGACY_HISTORY_REPAIR_CUTOFF = "2026-08-25T22:30:57.000Z";

const COMPLETED_STATUSES = new Set(["imported", "no_history", "conflict", "rolled_back"]);

// Explicit maintenance workflow for Sessions created before durable Provider
// event projection became authoritative. Ordinary product reads remain Store-
// only; Provider-native history is consulted only by a registered importer and
// every attempt is audited before a later startup decides whether to retry.
export class LegacySessionHistoryRepairService {
  constructor(options = {}) {
    this.store = options.store;
    this.resolveReference = options.resolveReference;
    this.importers = normalizeImporters(options.importers);
    this.createdBefore = options.createdBefore ?? LEGACY_HISTORY_REPAIR_CUTOFF;
    this.now = options.now ?? (() => new Date().toISOString());
    if (!this.store?.listLegacyHistoryRepairCandidates
      || !this.store?.recordLegacyHistoryRepair
      || !this.store?.importLegacyHistoryRepair) {
      throw new TypeError("LegacySessionHistoryRepairService requires a repair-capable Store.");
    }
    if (typeof this.resolveReference !== "function") {
      throw new TypeError("LegacySessionHistoryRepairService requires resolveReference().");
    }
  }

  async run({ limit = 200 } = {}) {
    const candidates = this.store.listLegacyHistoryRepairCandidates({
      createdBefore: this.createdBefore,
      limit
    });
    const result = {
      scanned: candidates.length,
      imported: 0,
      noHistory: 0,
      skipped: 0,
      unsupported: 0,
      unavailable: 0,
      failed: 0,
      importedItems: 0,
      details: []
    };
    for (const candidate of candidates) {
      const detail = await this.repairCandidate(candidate);
      result.details.push(detail);
      switch (detail.status) {
        case "imported":
          result.imported += 1;
          result.importedItems += detail.importedItemCount;
          break;
        case "no_history": result.noHistory += 1; break;
        case "unsupported": result.unsupported += 1; break;
        case "unavailable": result.unavailable += 1; break;
        case "failed": result.failed += 1; break;
        default: result.skipped += 1; break;
      }
    }
    return result;
  }

  async repairCandidate(candidate) {
    const session = candidate?.session;
    if (!session?.id) throw new TypeError("Legacy history repair candidate requires a Session.");
    if (COMPLETED_STATUSES.has(candidate.repair?.status)) {
      return repairDetail(session.id, candidate.repair.status, candidate.repair.imported_item_count, true);
    }
    const providerId = normalizedText(session.external?.provider ?? session.provider);
    const attemptedAt = this.now();
    const importer = providerId ? this.importers.get(providerId) : null;
    if (!importer) {
      if (candidate.repair?.status !== "unsupported") {
        this.store.recordLegacyHistoryRepair({
          sessionId: session.id,
          providerId: providerId ?? "unknown",
          status: "unsupported",
          sourceItemCount: 0,
          importedItemCount: 0,
          failureCode: "LEGACY_HISTORY_IMPORT_UNSUPPORTED",
          failureMessage: `No legacy history importer is registered for ${providerId ?? "unknown"}.`,
          attemptedAt,
          completedAt: attemptedAt
        });
      }
      return repairDetail(session.id, "unsupported", 0);
    }

    let reference = null;
    try {
      reference = await this.resolveReference(session.id);
      validateReference(session.id, providerId, reference);
      const imported = await importer(reference, session);
      const items = validatedImportResult(imported);
      const receipt = this.store.importLegacyHistoryRepair({
        sessionId: session.id,
        providerId,
        bindingId: reference.bindingId,
        providerSessionId: reference.providerSessionId,
        items,
        attemptedAt
      });
      return repairDetail(session.id, receipt.status, receipt.imported_item_count);
    } catch (error) {
      const unavailable = legacyHistoryUnavailable(error);
      const status = unavailable ? "unavailable" : "failed";
      this.store.recordLegacyHistoryRepair({
        sessionId: session.id,
        providerId,
        bindingId: reference?.bindingId ?? null,
        providerSessionId: reference?.providerSessionId ?? null,
        status,
        sourceItemCount: 0,
        importedItemCount: 0,
        failureCode: error?.code ?? (unavailable ? "PROVIDER_HISTORY_UNAVAILABLE" : "LEGACY_HISTORY_IMPORT_FAILED"),
        failureMessage: error?.message ?? String(error),
        attemptedAt,
        completedAt: null
      });
      return repairDetail(session.id, status, 0, false, error);
    }
  }
}

function normalizeImporters(value) {
  if (value instanceof Map) return new Map(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value));
}

function validateReference(sessionId, providerId, reference) {
  if (!reference?.bindingId || !reference.providerSessionId) {
    const error = new Error(`Session ${sessionId} does not have a complete Provider Binding.`);
    error.code = "SESSION_BINDING_NOT_FOUND";
    throw error;
  }
  if (reference.sessionId !== sessionId || reference.providerId !== providerId) {
    const error = new Error(`Session ${sessionId} resolved to a mismatched Provider Binding.`);
    error.code = "SESSION_BINDING_MISMATCH";
    throw error;
  }
}

function validatedImportResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.items)) {
    throw new TypeError("A legacy history importer must return { items: [] }.");
  }
  return result.items;
}

function legacyHistoryUnavailable(error) {
  if (["PROVIDER_SESSION_UNAVAILABLE", "SESSION_BINDING_NOT_FOUND"].includes(error?.code)) return true;
  return /(?:no rollout found for thread id|thread not (?:found|loaded)|provider session unavailable)/i.test(
    String(error?.message ?? error ?? "")
  );
}

function repairDetail(sessionId, status, importedItemCount = 0, skipped = false, error = null) {
  return {
    sessionId,
    status,
    importedItemCount: Number(importedItemCount ?? 0),
    skipped,
    errorCode: error?.code ?? null
  };
}

function normalizedText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
