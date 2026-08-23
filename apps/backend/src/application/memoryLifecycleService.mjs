import { isTrustedMemory } from "./memoryRecallService.mjs";

export class MemoryLifecycleService {
  constructor({ store } = {}) {
    if (!store) throw new TypeError("MemoryLifecycleService requires a store.");
    this.store = store;
  }

  preserveBeforeCompaction({ sessionId, content, kind = "episodic", sourceEventSeqs = [] } = {}) {
    const session = this.store.getSession(sessionId);
    if (!session) throw lifecycleError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    const owner = session.workItemId
      ? { ownerType: "work_item", ownerId: session.workItemId, workItemId: session.workItemId }
      : session.objectiveId
        ? { ownerType: "objective", ownerId: session.objectiveId }
        : { ownerType: "agent", ownerId: session.agentId };
    if (!owner.ownerId) throw lifecycleError("MEMORY_SCOPE_REQUIRED", "Session has no durable Memory owner.");
    const memory = this.store.createMemory({
      ...owner,
      kind,
      content: requiredText(content, "content"),
      sourceType: "pre_compaction",
      sourceSessionId: session.id,
      sourceEventSeqs,
      trustLevel: "trusted",
      promotionStatus: "active",
      autoApplied: false
    });
    this.store.createMemoryAudit({
      memoryId: memory.id, action: "pre_compaction_preserve", actorType: "system",
      actorId: session.id, after: memory, reason: "Recoverable safety checkpoint before provider compaction"
    });
    return memory;
  }

  consolidate({ memoryIds, content, actorId = null } = {}) {
    const memories = unique(memoryIds).map((id) => this.store.getMemory(id));
    if (!memories.length || memories.some((memory) => !memory)) {
      throw lifecycleError("MEMORY_NOT_FOUND", "All consolidation inputs must exist.");
    }
    const ownerKey = `${memories[0].owner_type}:${memories[0].owner_id}`;
    if (memories.some((memory) => `${memory.owner_type}:${memory.owner_id}` !== ownerKey)) {
      throw lifecycleError("MEMORY_SCOPE_MISMATCH", "Consolidation inputs must share one owner.");
    }
    if (memories.some((memory) => !isTrustedMemory(memory))) {
      throw lifecycleError("UNTRUSTED_MEMORY_PROMOTION_FORBIDDEN", "Untrusted memories cannot be automatically consolidated or promoted.");
    }
    const first = memories[0];
    const consolidated = this.store.createMemory({
      ownerType: first.owner_type,
      ownerId: first.owner_id,
      workItemId: first.owner_type === "work_item" ? first.owner_id : null,
      kind: first.kind,
      content: requiredText(content, "content"),
      sourceType: "consolidated",
      sourceSessionId: first.source_session_id,
      sourceEventSeqs: memories.flatMap((memory) => safeArray(memory.source_event_seqs_json)),
      trustLevel: "trusted",
      promotionStatus: "active",
      structuredJson: { consolidation: { sourceMemoryIds: memories.map((memory) => memory.id) } }
    });
    for (const memory of memories) {
      const updated = this.store.updateMemory(memory.id, {
        promotionStatus: "superseded",
        replacesMemoryId: consolidated.id,
        version: Number(memory.version ?? 1) + 1
      });
      this.store.createMemoryAudit({
        memoryId: memory.id, action: "supersede", actorType: "system", actorId,
        before: memory, after: updated, reason: `Consolidated into ${consolidated.id}`
      });
    }
    const audit = this.store.createMemoryAudit({
      memoryId: consolidated.id, action: "consolidate", actorType: "system", actorId,
      after: consolidated, reason: `Sources: ${memories.map((memory) => memory.id).join(", ")}`
    });
    return { memory: consolidated, audit };
  }

  rollbackConsolidation(auditId, actorId = null) {
    const audit = this.store.getMemoryAudit(auditId);
    const consolidated = audit?.action === "consolidate" ? this.store.getMemory(audit.memoryId) : null;
    const sourceIds = safeJson(consolidated?.structured_json)?.consolidation?.sourceMemoryIds;
    if (!consolidated || !Array.isArray(sourceIds)) {
      throw lifecycleError("CONSOLIDATION_AUDIT_NOT_FOUND", "Consolidation audit cannot be rolled back.");
    }
    const revoked = this.store.updateMemory(consolidated.id, {
      revokedAt: new Date().toISOString(),
      promotionStatus: "rolled_back",
      version: Number(consolidated.version ?? 1) + 1
    });
    for (const sourceId of sourceIds) {
      const source = this.store.getMemory(sourceId);
      if (!source || source.replaces_memory_id !== consolidated.id) continue;
      this.store.updateMemory(source.id, {
        promotionStatus: "active", replacesMemoryId: null,
        version: Number(source.version ?? 1) + 1
      });
    }
    this.store.createMemoryAudit({
      memoryId: consolidated.id, action: "rollback_consolidation", actorType: "user", actorId,
      before: consolidated, after: revoked, rollbackOf: auditId
    });
    return revoked;
  }
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw lifecycleError("INVALID_INPUT", `${field} is required.`);
  return normalized;
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

function safeArray(value) {
  const parsed = safeJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function safeJson(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function lifecycleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
