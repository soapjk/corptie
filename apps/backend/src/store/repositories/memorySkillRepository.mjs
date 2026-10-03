import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";

// Task/Session readers enforce existing association rules on the same Store snapshot.
// Transactions and connection ownership stay with the caller.
export class MemorySkillRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave, getTask, getSession }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
    this.getTask = getTask;
    this.getSession = getSession;
  }

  get db() {
    return this.getDatabase();
  }

  createMemory(input = {}) {
    const association = this.validateMemoryAssociation(input);
    const id = input.id ?? `memory:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO memories (
        id, owner_type, owner_id, task_id, kind, content, structured_json, tags_json,
        base_confidence, confidence, recency_score, usage_count, last_accessed_at,
        source_type, source_session_id, source_event_sequence, source_event_seqs_json,
        promotion_status, promoted_skill_id, access_policy, trust_level, expires_at, replaces_memory_id, version,
        auto_applied, applied_at, revoked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.ownerType,
        input.ownerId,
        association.taskId,
        input.kind,
        input.content,
        JSON.stringify(input.structuredJson ?? {}),
        JSON.stringify(input.tags ?? []),
        input.baseConfidence ?? 0.5,
        input.confidence ?? input.baseConfidence ?? 0.5,
        input.recencyScore ?? 0,
        input.usageCount ?? 0,
        input.lastAccessedAt ?? null,
        input.sourceType ?? "user",
        input.sourceSessionId ?? null,
        input.sourceEventSequence ?? null,
        JSON.stringify(input.sourceEventSeqs ?? []),
        input.promotionStatus ?? "active",
        input.promotedSkillId ?? null,
        JSON.stringify(input.accessPolicy ?? {}),
        input.trustLevel ?? ((input.sourceType ?? "user") === "user" ? "trusted" : "untrusted"),
        input.expiresAt ?? null,
        input.replacesMemoryId ?? null,
        input.version ?? 1,
        input.autoApplied ? 1 : 0,
        input.appliedAt ?? null,
        input.revokedAt ?? null,
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getMemory(id);
  }

  getMemory(id) {
    return this.selectOne(`SELECT * FROM memories WHERE id = ?`, [id]);
  }

  listMemoriesByOwner(ownerType, ownerId) {
    return this.selectAll(
      `SELECT * FROM memories WHERE owner_type = ? AND owner_id = ? ORDER BY confidence DESC`,
      [ownerType, ownerId]
    );
  }

  getMemoryBySourceEvent({ ownerType, ownerId, sourceSessionId, sourceEventSequence }) {
    return this.selectOne(
      `SELECT * FROM memories
       WHERE owner_type = ? AND owner_id = ? AND source_session_id = ? AND source_event_sequence = ?`,
      [ownerType, ownerId, sourceSessionId, sourceEventSequence]
    );
  }

  getMemoryExtractionProgress(sessionId) {
    return Number(this.selectOne(
      "SELECT last_event_sequence FROM memory_extraction_progress WHERE session_id = ?", [sessionId]
    )?.last_event_sequence ?? 0);
  }

  setMemoryExtractionProgress(sessionId, sequence) {
    this.db.run(
      `INSERT INTO memory_extraction_progress (session_id, last_event_sequence, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_event_sequence = MAX(memory_extraction_progress.last_event_sequence, excluded.last_event_sequence),
         updated_at = excluded.updated_at`,
      [sessionId, sequence, createdAtFromOrNow()]
    );
    this.scheduleSave();
  }

  getMemoryRememberOperation(sessionId, idempotencyKey) {
    return this.selectOne(
      `SELECT * FROM memory_remember_operations WHERE session_id = ? AND idempotency_key = ?`,
      [sessionId, idempotencyKey]
    );
  }

  createMemoryRememberOperation(input = {}) {
    const createdAt = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO memory_remember_operations (
        session_id, idempotency_key, request_fingerprint, work_id, memory_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [input.sessionId, input.idempotencyKey, input.requestFingerprint,
        input.workId ?? null, input.memoryId, createdAt]
    );
    this.scheduleSave();
    return this.getMemoryRememberOperation(input.sessionId, input.idempotencyKey);
  }

  validateMemoryAssociation(input = {}) {
    const ownerType = typeof input.ownerType === "string" ? input.ownerType.trim() : "";
    const ownerId = typeof input.ownerId === "string" ? input.ownerId.trim() : "";
    if (!ownerType || !ownerId) {
      throw memoryAssociationError("INVALID_MEMORY_ASSOCIATION", "Memory ownerType and ownerId are required.");
    }
    if (ownerType !== "task") {
      if (input.taskId != null && String(input.taskId).trim()) {
        throw memoryAssociationError(
          "INVALID_MEMORY_ASSOCIATION",
          "taskId is only valid for task memories."
        );
      }
      return { taskId: null };
    }
    const taskId = typeof input.taskId === "string" && input.taskId.trim()
      ? input.taskId.trim()
      : ownerId;
    if (taskId !== ownerId) {
      throw memoryAssociationError(
        "INVALID_MEMORY_ASSOCIATION",
        "taskId must match ownerId for task memories."
      );
    }
    const task = this.getTask(taskId);
    if (!task) {
      throw memoryAssociationError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
    }
    if (!task.current_session_id) {
      throw memoryAssociationError(
        "TASK_NOT_STARTED",
        "Task memories cannot be created before execution starts."
      );
    }
    const sourceSessionId = typeof input.sourceSessionId === "string" ? input.sourceSessionId.trim() : "";
    const sourceSession = sourceSessionId ? this.getSession(sourceSessionId) : null;
    if (!sourceSession || sourceSession.taskId !== task.id
      || sourceSession.workId !== task.work_id) {
      throw memoryAssociationError(
        "INVALID_MEMORY_SOURCE_SESSION",
        "Task memory requires a bound Worker Session for that Task as its source."
      );
    }
    return { taskId };
  }

  listMemoriesByKind(kind) {
    return this.selectAll(
      `SELECT * FROM memories WHERE kind = ? ORDER BY confidence DESC`,
      [kind]
    );
  }

  listAllMemories() {
    return this.selectAll(`SELECT * FROM memories ORDER BY updated_at DESC`);
  }

  listMemoryPage(options = {}) {
    const ownerType = typeof options.ownerType === "string" && options.ownerType ? options.ownerType : null;
    const ownerId = typeof options.ownerId === "string" && options.ownerId ? options.ownerId : null;
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const cursor = options.cursor ?? null;
    const hasCursor = typeof cursor?.updatedAt === "string" && typeof cursor?.id === "string";
    const clauses = [];
    const params = [];
    if (ownerType && ownerId) {
      clauses.push("owner_type = ?", "owner_id = ?");
      params.push(ownerType, ownerId);
    }
    if (options.includeRevoked !== true) clauses.push("revoked_at IS NULL");
    for (const [column, value] of [
      ["kind", options.kind],
      ["promotion_status", options.status],
      ["source_type", options.sourceType],
      ["trust_level", options.trustLevel]
    ]) {
      if (typeof value === "string" && value) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (typeof options.query === "string" && options.query) {
      clauses.push("(LOWER(content) LIKE ? OR LOWER(tags_json) LIKE ?)");
      params.push(`%${options.query.toLocaleLowerCase()}%`, `%${options.query.toLocaleLowerCase()}%`);
    }
    if (hasCursor) {
      clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const rows = this.selectAll(
      `SELECT * FROM memories ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
      [...params, limit + 1]
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const tail = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && tail ? { updatedAt: tail.updated_at, id: tail.id } : null
    };
  }

  updateMemory(id, patch = {}) {
    const current = this.getMemory(id);
    if (!current) return null;
    this.db.run(
      `UPDATE memories SET
        content=?, structured_json=?, tags_json=?, base_confidence=?, confidence=?, recency_score=?,
        usage_count=?, last_accessed_at=?, promotion_status=?, promoted_skill_id=?,
        access_policy=?, trust_level=?, expires_at=?, replaces_memory_id=?, version=?, auto_applied=?, applied_at=?, revoked_at=?, updated_at=?
       WHERE id=?`,
      [
        patch.content ?? current.content,
        JSON.stringify(patch.structuredJson ?? JSON.parse(current.structured_json || "{}")),
        JSON.stringify(patch.tags ?? JSON.parse(current.tags_json || "[]")),
        patch.baseConfidence ?? current.base_confidence,
        patch.confidence ?? current.confidence,
        patch.recencyScore ?? current.recency_score,
        patch.usageCount ?? current.usage_count,
        patch.lastAccessedAt ?? current.last_accessed_at,
        patch.promotionStatus ?? current.promotion_status,
        patch.promotedSkillId ?? current.promoted_skill_id,
        JSON.stringify(patch.accessPolicy ?? JSON.parse(current.access_policy || "{}")),
        patch.trustLevel ?? current.trust_level,
        patch.expiresAt !== undefined ? patch.expiresAt : current.expires_at,
        patch.replacesMemoryId !== undefined ? patch.replacesMemoryId : current.replaces_memory_id,
        patch.version ?? current.version,
        patch.autoApplied !== undefined ? (patch.autoApplied ? 1 : 0) : current.auto_applied,
        patch.appliedAt !== undefined ? patch.appliedAt : current.applied_at,
        patch.revokedAt !== undefined ? patch.revokedAt : current.revoked_at,
        createdAtFromOrNow(),
        id
      ]
    );
    if (patch.content != null && patch.content !== current.content) {
      this.db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [id]);
    }
    this.scheduleSave();
    return this.getMemory(id);
  }

  deleteMemory(id) {
    this.db.run(`DELETE FROM memories WHERE id = ?`, [id]);
    this.scheduleSave();
  }

  createMemoryAudit(input = {}) {
    const id = input.id ?? `memory-audit:${randomUUID()}`;
    this.db.run(
      `INSERT INTO memory_audit (
        id, memory_id, action, actor_type, actor_id, reason,
        before_json, after_json, rollback_of, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.memoryId ?? null, input.action, input.actorType ?? "system", input.actorId ?? null,
        input.reason ?? null, input.before ? JSON.stringify(input.before) : null,
        input.after ? JSON.stringify(input.after) : null, input.rollbackOf ?? null, createdAtFromOrNow()]
    );
    this.scheduleSave();
    return this.getMemoryAudit(id);
  }

  getMemoryAudit(id) {
    return presentMemoryAudit(this.selectOne(`SELECT * FROM memory_audit WHERE id = ?`, [id]));
  }

  listMemoryAudit({ memoryId = null, limit = 200 } = {}) {
    const rows = memoryId
      ? this.selectAll(`SELECT * FROM memory_audit WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?`, [memoryId, limit])
      : this.selectAll(`SELECT * FROM memory_audit ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map(presentMemoryAudit);
  }

  rollbackMemoryAudit(auditId, actorId = null) {
    const audit = this.getMemoryAudit(auditId);
    if (!audit?.memoryId || !audit.before) return null;
    const current = this.getMemory(audit.memoryId);
    if (!current) return null;
    const before = audit.before;
    const restored = this.updateMemory(current.id, {
      content: before.content,
      structuredJson: safeJsonValue(before.structured_json, before.structured ?? {}),
      tags: safeJsonValue(before.tags_json, before.tags ?? []),
      confidence: before.confidence,
      promotionStatus: before.promotion_status ?? before.promotionStatus,
      promotedSkillId: before.promoted_skill_id ?? before.promotedSkillId,
      trustLevel: before.trust_level ?? before.trustLevel,
      expiresAt: before.expires_at ?? before.expiresAt ?? null,
      replacesMemoryId: before.replaces_memory_id ?? before.replacesMemoryId ?? null,
      revokedAt: before.revoked_at ?? before.revokedAt ?? null,
      version: Number(current.version ?? 1) + 1
    });
    this.createMemoryAudit({
      memoryId: current.id, action: "rollback", actorType: "user", actorId,
      reason: `Rollback ${auditId}`, before: current, after: restored, rollbackOf: auditId
    });
    return restored;
  }

  createMemoryRecallAudit(input = {}) {
    const id = input.id ?? `memory-recall:${randomUUID()}`;
    const createdAt = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO memory_recall_audit (
        id, session_id, phase, mode, reason, scope_json, candidate_ids_json,
        selected_ids_json, diagnostics_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.sessionId ?? null, input.phase, input.mode, input.reason,
        JSON.stringify(input.scope ?? {}), JSON.stringify(input.candidateIds ?? []),
        JSON.stringify(input.selectedIds ?? []), JSON.stringify(input.diagnostics ?? {}), createdAt]
    );
    this.scheduleSave();
    return {
      id, sessionId: input.sessionId ?? null, phase: input.phase, mode: input.mode,
      reason: input.reason, scope: input.scope ?? {}, candidateIds: input.candidateIds ?? [],
      selectedIds: input.selectedIds ?? [], diagnostics: input.diagnostics ?? {}, createdAt
    };
  }

  listMemoryRecallAudit({ sessionId = null, limit = 200 } = {}) {
    const rows = sessionId
      ? this.selectAll(`SELECT * FROM memory_recall_audit WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`, [sessionId, limit])
      : this.selectAll(`SELECT * FROM memory_recall_audit ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map((row) => ({
      id: row.id, sessionId: row.session_id, phase: row.phase, mode: row.mode, reason: row.reason,
      scope: safeJsonValue(row.scope_json, {}), candidateIds: safeJsonValue(row.candidate_ids_json, []),
      selectedIds: safeJsonValue(row.selected_ids_json, []), diagnostics: safeJsonValue(row.diagnostics_json, {}),
      createdAt: row.created_at
    }));
  }

  updateMemoryRecallAuditInjection(id, status) {
    const row = this.selectOne("SELECT diagnostics_json FROM memory_recall_audit WHERE id = ?", [id]);
    if (!row) return false;
    const diagnostics = safeJsonValue(row.diagnostics_json, {});
    this.db.run("UPDATE memory_recall_audit SET diagnostics_json = ? WHERE id = ?", [
      JSON.stringify({ ...diagnostics, injection: { status } }), id
    ]);
    this.scheduleSave();
    return true;
  }

  // 置信度衰减（13）：按 factor 下调某 owner 下所有记忆的 confidence
  decayMemories(ownerType, ownerId, factor = 0.9) {
    this.db.run(
      `UPDATE memories SET confidence = confidence * ? WHERE owner_type = ? AND owner_id = ?`,
      [factor, ownerType, ownerId]
    );
    this.scheduleSave();
  }

  // 记忆访问：usage_count +1、recency 提升、刷新 last_accessed_at（供检索排序）
  touchMemory(id) {
    this.db.run(
      `UPDATE memories SET usage_count = usage_count + 1, recency_score = recency_score + 1, last_accessed_at = ? WHERE id = ?`,
      [createdAtFromOrNow(), id]
    );
    this.scheduleSave();
  }

  // 置信度衰减（13.6）：confidence = clamp(base × recency_score × (1 + 0.1 × min(usage,10)), 0, 1)
  // recency_score = exp(-λ·Δt_days)，λ 按 kind 衰减速度不同；confidence < 0.2 视为归档。
  applyConfidenceDecay(ownerType, ownerId, now = new Date()) {
    const mems = this.listMemoriesByOwner(ownerType, ownerId);
    const LAMBDA = {
      episodic: 0.05,
      lesson: 0.02,
      fact: 0.01,
      preference: 0.005,
      skill: 0.002,
      procedure: 0.002,
      dev_experience: 0.002
    };
    for (const m of mems) {
      const base = Number(m.base_confidence ?? 0.5);
      const usage = Number(m.usage_count ?? 0);
      const updated = m.updated_at ? new Date(m.updated_at) : now;
      const deltaDays = Math.max(0, (now - updated) / 86400000);
      const lambda = LAMBDA[m.kind] ?? 0.01;
      const recency = Math.exp(-lambda * deltaDays);
      const confidence = Math.min(1, Math.max(0, base * recency * (1 + 0.1 * Math.min(usage, 10))));
      const status = confidence < 0.2 ? "archived" : m.promotion_status ?? "active";
      this.db.run(
        `UPDATE memories SET confidence=?, recency_score=?, promotion_status=?, updated_at=? WHERE id=?`,
        [confidence, recency, status, createdAtFromOrNow(), m.id]
      );
    }
    this.scheduleSave();
    return this.listMemoriesByOwner(ownerType, ownerId);
  }

  // 晋升候选（13.7）：仅 owner=agent 的 skill/procedure/dev_experience 类记忆，
  // 且 confidence ≥ 0.7 且 usage_count ≥ 5。
  listPromotionCandidates() {
    return this.selectAll(
      `SELECT * FROM memories
        WHERE owner_type = 'agent'
          AND kind IN ('skill', 'procedure', 'dev_experience')
          AND confidence >= 0.7
          AND usage_count >= 5
          AND promotion_status != 'promoted_to_skill'
          AND trust_level = 'trusted'
          AND revoked_at IS NULL
        ORDER BY confidence DESC`
    );
  }

  // 晋升落库（13.7）：记忆 → SkillDraft → skills 表；保留溯源，原记忆标记 promoted_to_skill。
  promoteMemoryToSkill(memoryId, draft = {}) {
    const mem = this.getMemory(memoryId);
    if (!mem) return null;
    if (mem.trust_level !== "trusted") {
      throw memoryAssociationError(
        "UNTRUSTED_MEMORY_PROMOTION_FORBIDDEN",
        "Untrusted memory cannot be promoted to a Skill."
      );
    }
    const id = draft.id ?? `skill:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO skills (
        id, name, scenario, trigger_condition, steps_json, risk_level,
        source_memory_id, source_agent_id, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        draft.name ?? `skill_${memoryId.split(":")[1]}`,
        draft.scenario ?? mem.content ?? "",
        draft.trigger ?? "",
        JSON.stringify(draft.steps ?? []),
        draft.riskLevel ?? "moderate",
        memoryId,
        mem.owner_id ?? null,
        draft.status ?? "draft",
        draft.version ?? 1,
        now,
        now
      ]
    );
    this.updateMemory(memoryId, {
      promotionStatus: "promoted_to_skill",
      promotedSkillId: id
    });
    this.createMemoryAudit({
      memoryId, action: "promote_to_skill", actorType: "system",
      before: mem, after: this.getMemory(memoryId), reason: `Promoted to ${id}`
    });
    this.scheduleSave();
    return this.getSkill(id);
  }

  // 独立创建技能草稿（12.6 none 三岔路 proposeSkill 用，无 source_memory 溯源）。
  createSkill(draft = {}) {
    const id = draft.id ?? `skill:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO skills (
        id, name, scenario, trigger_condition, steps_json, risk_level,
        source_memory_id, source_agent_id, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        draft.name,
        draft.scenario ?? "",
        draft.trigger ?? "",
        JSON.stringify(draft.steps ?? []),
        draft.riskLevel ?? "moderate",
        draft.sourceMemoryId ?? null,
        draft.sourceAgentId ?? null,
        draft.status ?? "draft",
        draft.version ?? 1,
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getSkill(id);
  }

  getSkill(id) {
    return this.selectOne(`SELECT * FROM skills WHERE id = ?`, [id]);
  }

  listSkillsByAgent(agentId) {
    return this.selectAll(`SELECT * FROM skills WHERE source_agent_id = ? ORDER BY updated_at DESC`, [agentId]);
  }

  // 供 hub 发现：仅返回已发布（approved/published）的技能
  listDiscoverableSkills() {
    return this.selectAll(`SELECT * FROM skills WHERE status IN ('approved', 'published') ORDER BY updated_at DESC`);
  }

  updateSkillStatus(id, status) {
    this.db.run(`UPDATE skills SET status = ?, updated_at = ? WHERE id = ?`, [status, createdAtFromOrNow(), id]);
    this.scheduleSave();
    return this.getSkill(id);
  }

  // ===== 向量索引（12.7：embedding 语义召回；向量由 embedder 注入，存储只负责持久化）=====

  setMemoryEmbedding(memoryId, vector) {
    this.db.run(
      `INSERT INTO memory_embeddings (memory_id, vector, created_at) VALUES (?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET vector = excluded.vector, created_at = excluded.created_at`,
      [memoryId, JSON.stringify(vector), createdAtFromOrNow()]
    );
    this.scheduleSave();
  }

  getMemoryEmbedding(memoryId) {
    const row = this.selectOne(`SELECT vector FROM memory_embeddings WHERE memory_id = ?`, [memoryId]);
    if (!row) return null;
    try {
      return JSON.parse(row.vector);
    } catch {
      return null;
    }
  }

  // 返回 { memoryId, vector }[] 供 hub 做余弦相似度召回（内存中计算，万级片段 P95 < 20ms）
  listMemoryEmbeddings() {
    const rows = this.selectAll(`SELECT memory_id, vector FROM memory_embeddings`);
    return rows
      .map((row) => {
        try {
          return { memoryId: row.memory_id, vector: JSON.parse(row.vector) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  deleteMemoryEmbedding(memoryId) {
    this.db.run(`DELETE FROM memory_embeddings WHERE memory_id = ?`, [memoryId]);
    this.scheduleSave();
  }
}

function memoryAssociationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}


function presentMemoryAudit(row) {
  if (!row) return null;
  return {
    id: row.id,
    memoryId: row.memory_id,
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id,
    reason: row.reason,
    before: safeJsonValue(row.before_json, null),
    after: safeJsonValue(row.after_json, null),
    rollbackOf: row.rollback_of,
    createdAt: row.created_at
  };
}

function safeJsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
