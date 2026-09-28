import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";

// Agent creation and assignment transactions remain in the Store coordinator.
export class SkillRegistryRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
  }

  get db() {
    return this.getDatabase();
  }

  listRegistrySkills() {
    return this.selectAll(`SELECT * FROM skill_registry ORDER BY name ASC`).map(skillFromRow);
  }

  getRegistrySkill(skillId) {
    const row = this.selectOne(`SELECT * FROM skill_registry WHERE skill_id = ?`, [skillId]);
    return row ? skillFromRow(row) : null;
  }

  createRegistrySkill(input = {}) {
    const id = input.id ?? `skill:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO skill_registry (
         skill_id, name, description, source_type, source, source_subpath, package_subpath,
         mcp_descriptor_subpath, package_discovery_method, cache_path,
         manifest_name, manifest_description, content_hash, installed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.description ?? "",
        input.sourceType ?? "local",
        input.source,
        input.sourceSubpath ?? "",
        input.packageSubpath ?? "",
        input.mcpDescriptorSubpath ?? "",
        input.packageDiscoveryMethod ?? "",
        input.cachePath ?? null,
        input.manifestName ?? input.name ?? "",
        input.manifestDescription ?? input.description ?? "",
        input.contentHash ?? "",
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getRegistrySkill(id);
  }

  updateRegistrySkill(skillId, input = {}) {
    const existing = this.getRegistrySkill(skillId);
    if (!existing) return null;
    const now = createdAtFromOrNow();
    this.db.run(
      `UPDATE skill_registry
       SET name = ?, description = ?, source_type = ?, source = ?, source_subpath = ?, package_subpath = ?,
           mcp_descriptor_subpath = ?, package_discovery_method = ?, cache_path = ?,
           manifest_name = ?, manifest_description = ?, content_hash = ?, updated_at = ?
       WHERE skill_id = ?`,
      [
        input.name ?? existing.name,
        input.description ?? existing.description,
        input.sourceType ?? existing.sourceType,
        input.source ?? existing.source,
        input.sourceSubpath ?? existing.sourceSubpath ?? "",
        input.packageSubpath ?? existing.packageSubpath ?? "",
        input.mcpDescriptorSubpath ?? existing.mcpDescriptorSubpath ?? "",
        input.packageDiscoveryMethod ?? existing.packageDiscoveryMethod ?? "",
        input.cachePath ?? existing.cachePath,
        input.manifestName ?? existing.manifestName ?? existing.name,
        input.manifestDescription ?? existing.manifestDescription ?? existing.description,
        input.contentHash ?? existing.contentHash ?? "",
        now,
        skillId
      ]
    );
    this.scheduleSave();
    return this.getRegistrySkill(skillId);
  }

  deleteRegistrySkill(skillId) {
    const existing = this.getRegistrySkill(skillId);
    if (!existing) return false;
    this.db.run("BEGIN IMMEDIATE");
    try {
      const impact = this.registrySkillDeletionImpact(skillId);
      if (impact?.activeSessionCount > 0) {
        const error = new Error(`Skill has active Sessions: ${skillId}`);
        error.code = "SKILL_HAS_ACTIVE_SESSIONS";
        error.impact = impact;
        throw error;
      }
      this.db.run(`DELETE FROM skill_registry WHERE skill_id = ?`, [skillId]);
      const remainingLinks = this.selectOne(
        `SELECT COUNT(*) AS count FROM agent_skill_links WHERE skill_id = ?`,
        [skillId]
      );
      if (this.getRegistrySkill(skillId) || Number(remainingLinks?.count ?? 0) !== 0) {
        const error = new Error(`Skill deletion did not remove all references: ${skillId}`);
        error.code = "SKILL_DELETE_INTEGRITY_FAILED";
        throw error;
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return true;
  }

  registrySkillDeletionImpact(skillId) {
    const skill = this.getRegistrySkill(skillId);
    if (!skill) return null;
    const affectedAgents = this.selectAll(
      `SELECT a.agent_id, a.name
       FROM agent_skill_links links
       JOIN agents a ON a.agent_id = links.agent_id
       WHERE links.skill_id = ?
       ORDER BY a.name COLLATE NOCASE, a.agent_id`,
      [skillId]
    ).map((row) => ({ agentId: row.agent_id, name: row.name }));
    const activeSessions = this.selectAll(
      `SELECT DISTINCT s.id, s.title, s.status, a.agent_id, a.name AS agent_name
       FROM agent_skill_links links
       JOIN agents a ON a.agent_id = links.agent_id
       JOIN sessions s ON (
         s.agent_id = a.agent_id OR EXISTS (
           SELECT 1 FROM agent_sessions bindings
           WHERE bindings.session_id = s.id
             AND bindings.agent_id = a.agent_id
             AND bindings.unbound_at IS NULL
         )
       )
       WHERE links.skill_id = ? AND s.status IN ('running', 'blocked')
       ORDER BY s.created_at, s.id`,
      [skillId]
    ).map((row) => ({
      sessionId: row.id,
      title: row.title,
      status: row.status,
      agentId: row.agent_id,
      agentName: row.agent_name
    }));
    return {
      skillId,
      skillName: skill.name,
      affectedAgents,
      affectedAgentCount: affectedAgents.length,
      activeSessions,
      activeSessionCount: activeSessions.length,
      canDelete: activeSessions.length === 0,
      policy: "blockWhileAssignedAgentSessionActive"
    };
  }

  createSkillDeletionOperation({ skill, impact, cleanup = [] }) {
    const operationId = `skill-deletion:${randomUUID()}`;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO skill_deletion_operations (
         operation_id, skill_id, skill_name, status, affected_agents_json,
         active_sessions_json, cleanup_json, recovery_json, created_at, updated_at
       ) VALUES (?, ?, ?, 'pending', ?, ?, ?, '[]', ?, ?)`,
      [
        operationId,
        skill.skillId,
        skill.name,
        JSON.stringify(impact.affectedAgents ?? []),
        JSON.stringify(impact.activeSessions ?? []),
        JSON.stringify(cleanup),
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getSkillDeletionOperation(operationId);
  }

  updateSkillDeletionOperation(operationId, input = {}) {
    const existing = this.getSkillDeletionOperation(operationId);
    if (!existing) return null;
    const status = input.status ?? existing.status;
    const now = createdAtFromOrNow();
    this.db.run(
      `UPDATE skill_deletion_operations
       SET status = ?, cleanup_json = ?, recovery_json = ?, error_code = ?,
           error_message = ?, updated_at = ?, completed_at = ?
       WHERE operation_id = ?`,
      [
        status,
        JSON.stringify(input.cleanup ?? existing.cleanup),
        JSON.stringify(input.recovery ?? existing.recovery),
        input.errorCode ?? existing.errorCode,
        input.errorMessage ?? existing.errorMessage,
        now,
        status === "completed" ? now : existing.completedAt,
        operationId
      ]
    );
    this.scheduleSave();
    return this.getSkillDeletionOperation(operationId);
  }

  getSkillDeletionOperation(operationId) {
    const row = this.selectOne(
      `SELECT * FROM skill_deletion_operations WHERE operation_id = ?`,
      [operationId]
    );
    return row ? skillDeletionOperationFromRow(row) : null;
  }

  // ===== Agent ↔ Skill 关联 =====

  listRegistrySkillIdsForAgent(agentId) {
    return this.selectAll(
      `SELECT skill_id FROM agent_skill_links WHERE agent_id = ? ORDER BY added_at ASC`,
      [agentId]
    ).map((row) => row.skill_id);
  }

  listRegistrySkillsForAgent(agentId) {
    const ids = this.listRegistrySkillIdsForAgent(agentId);
    return ids.map((id) => this.getRegistrySkill(id)).filter(Boolean);
  }

  recordSkillRuntimeEvent(input = {}) {
    const eventId = input.eventId ?? `skill_event:${randomUUID()}`;
    const stage = String(input.stage ?? "").trim();
    const status = String(input.status ?? "").trim();
    if (!stage) throw new TypeError("Skill runtime event stage is required.");
    if (!new Set(["info", "success", "failed", "denied"]).has(status)) {
      throw new TypeError(`Invalid Skill runtime event status: ${status || "(empty)"}`);
    }
    const createdAt = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO skill_runtime_events (
         event_id, stage, status, error_code, reason, skill_id, agent_id, session_id,
         provider_id, server_names_json, tool_count, details_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        stage,
        status,
        input.errorCode ? String(input.errorCode) : null,
        String(input.reason ?? ""),
        input.skillId ?? null,
        input.agentId ?? null,
        input.sessionId ?? null,
        input.providerId ?? null,
        JSON.stringify(Array.isArray(input.serverNames) ? [...new Set(input.serverNames.map(String))] : []),
        Number.isInteger(input.toolCount) ? input.toolCount : null,
        JSON.stringify(input.details && typeof input.details === "object" ? input.details : {}),
        createdAt
      ]
    );
    this.scheduleSave();
    return this.getSkillRuntimeEvent(eventId);
  }

  getSkillRuntimeEvent(eventId) {
    const row = this.selectOne(`SELECT * FROM skill_runtime_events WHERE event_id = ?`, [eventId]);
    return row ? skillRuntimeEventFromRow(row) : null;
  }

  listSkillRuntimeEvents(filters = {}) {
    const clauses = [];
    const values = [];
    for (const [column, value] of [
      ["skill_id", filters.skillId],
      ["agent_id", filters.agentId],
      ["session_id", filters.sessionId],
      ["provider_id", filters.providerId],
      ["stage", filters.stage]
    ]) {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (!normalized) continue;
      clauses.push(`${column} = ?`);
      values.push(normalized);
    }
    const requestedLimit = Number(filters.limit ?? 100);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 100;
    values.push(limit);
    return this.selectAll(
      `SELECT * FROM skill_runtime_events${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC, event_id DESC LIMIT ?`,
      values
    ).map(skillRuntimeEventFromRow);
  }
}

function skillFromRow(row) {
  return {
    skillId: row.skill_id,
    name: row.name,
    description: row.description ?? "",
    sourceType: row.source_type ?? "local",
    source: row.source,
    sourceSubpath: row.source_subpath ?? "",
    packageSubpath: row.package_subpath ?? "",
    mcpDescriptorSubpath: row.mcp_descriptor_subpath ?? "",
    packageDiscoveryMethod: row.package_discovery_method ?? "",
    cachePath: row.cache_path ?? null,
    manifestName: row.manifest_name || row.name,
    manifestDescription: row.manifest_description || row.description || "",
    contentHash: row.content_hash ?? "",
    installedAt: row.installed_at,
    updatedAt: row.updated_at
  };
}

function skillDeletionOperationFromRow(row) {
  return {
    operationId: row.operation_id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    status: row.status,
    affectedAgents: parseJson(row.affected_agents_json, []),
    activeSessions: parseJson(row.active_sessions_json, []),
    cleanup: parseJson(row.cleanup_json, []),
    recovery: parseJson(row.recovery_json, []),
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null
  };
}

function skillRuntimeEventFromRow(row) {
  return {
    eventId: row.event_id,
    stage: row.stage,
    status: row.status,
    errorCode: row.error_code ?? null,
    reason: row.reason ?? "",
    skillId: row.skill_id ?? null,
    agentId: row.agent_id ?? null,
    sessionId: row.session_id ?? null,
    providerId: row.provider_id ?? null,
    serverNames: parseJson(row.server_names_json, []),
    toolCount: row.tool_count == null ? null : Number(row.tool_count),
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at
  };
}
