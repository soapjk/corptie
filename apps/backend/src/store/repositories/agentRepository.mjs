import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { resolveAgentWorkDir } from "../../runtime/agentWorkDir.mjs";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";
import {
  AGENT_KIND,
  PLATFORM_ASSISTANT_ID,
  PLATFORM_ASSISTANT_MANIFEST,
  assertPlatformAssistantPatch,
  isPlatformAssistant,
  platformAssistantProtectionError
} from "../../utils/platformAssistantIdentity.mjs";

// Agent persistence and skill assignment share the Store-owned connection.
export class AgentRepository {
  constructor({ getDatabase, environmentName, selectAll, selectOne, scheduleSave, getRegistrySkill, listRegistrySkillIdsForAgent, recordSkillRuntimeEvent }) {
    this.getDatabase = getDatabase;
    this.environmentName = environmentName;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
    this.getRegistrySkill = getRegistrySkill;
    this.listRegistrySkillIdsForAgent = listRegistrySkillIdsForAgent;
    this.recordSkillRuntimeEvent = recordSkillRuntimeEvent;
  }

  get db() { return this.getDatabase(); }

  createAgentWithRegistrySkills(agentInput, skillIds = []) {
    const normalized = this.#validateRegistrySkillIds(skillIds);
    this.db.run("BEGIN IMMEDIATE");
    try {
      const agent = this.createAgent(agentInput);
      this.#replaceAgentRegistrySkills(agent.agentId, normalized);
      this.#recordSkillAssignmentDelta(agent.agentId, [], normalized);
      this.db.run("COMMIT");
      this.scheduleSave();
      return agent;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  createAgentWithRegistrySkillsIdempotently(agentInput, skillIds = [], request = {}) {
    const normalized = this.#validateRegistrySkillIds(skillIds);
    const idempotencyKey = String(request.idempotencyKey ?? "").trim();
    const requestHash = String(request.requestHash ?? "").trim();
    const requestId = String(request.requestId ?? "").trim();
    if (!idempotencyKey || !requestHash || !requestId) {
      const error = new Error("Agent creation idempotency metadata is required.");
      error.code = "INVALID_INPUT";
      throw error;
    }

    this.db.run("BEGIN IMMEDIATE");
    try {
      const existing = this.selectOne(
        `SELECT idempotency_key, request_hash, agent_id, request_id, device_id, created_at
         FROM agent_creation_requests WHERE idempotency_key = ?`,
        [idempotencyKey]
      );
      if (existing) {
        if (existing.request_hash !== requestHash) {
          const error = new Error("Idempotency key was already used for different Agent creation parameters.");
          error.code = "IDEMPOTENCY_CONFLICT";
          error.existingRequestId = existing.request_id;
          throw error;
        }
        const agent = this.getAgent(existing.agent_id);
        if (!agent) {
          const error = new Error("The Agent created by this idempotency key no longer exists.");
          error.code = "IDEMPOTENCY_RESOURCE_GONE";
          error.existingRequestId = existing.request_id;
          throw error;
        }
        this.db.run("COMMIT");
        return { agent, replayed: true, originalRequestId: existing.request_id };
      }

      const agent = this.createAgent(agentInput);
      this.#replaceAgentRegistrySkills(agent.agentId, normalized);
      this.#recordSkillAssignmentDelta(agent.agentId, [], normalized);
      this.db.run(
        `INSERT INTO agent_creation_requests (
           idempotency_key, request_hash, agent_id, request_id, device_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          idempotencyKey,
          requestHash,
          agent.agentId,
          requestId,
          typeof request.deviceId === "string" && request.deviceId.trim() ? request.deviceId.trim() : null,
          createdAtFromOrNow()
        ]
      );
      this.db.run("COMMIT");
      this.scheduleSave();
      return { agent, replayed: false, originalRequestId: requestId };
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  updateAgentWithRegistrySkills(agentId, agentInput, skillIds) {
    if (isPlatformAssistant(agentId) && skillIds != null) {
      throw platformAssistantProtectionError("The built-in Corptie Assistant Skill assignment is managed by the product.");
    }
    const normalized = skillIds == null ? null : this.#validateRegistrySkillIds(skillIds);
    const previous = normalized ? this.listRegistrySkillIdsForAgent(agentId) : null;
    this.db.run("BEGIN IMMEDIATE");
    try {
      const agent = this.updateAgent(agentId, agentInput);
      if (!agent) {
        const error = new Error(`Agent not found: ${agentId}`);
        error.code = "AGENT_NOT_FOUND";
        throw error;
      }
      if (normalized) this.#replaceAgentRegistrySkills(agentId, normalized);
      if (normalized) this.#recordSkillAssignmentDelta(agentId, previous, normalized);
      this.db.run("COMMIT");
      this.scheduleSave();
      return agent;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  setAgentRegistrySkills(agentId, skillIds = []) {
    if (isPlatformAssistant(agentId)) {
      throw platformAssistantProtectionError("The built-in Corptie Assistant Skill assignment is managed by the product.");
    }
    const normalized = this.#validateRegistrySkillIds(skillIds);
    const previous = this.listRegistrySkillIdsForAgent(agentId);
    if (!this.getAgent(agentId)) {
      const error = new Error(`Agent not found: ${agentId}`);
      error.code = "AGENT_NOT_FOUND";
      throw error;
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.#replaceAgentRegistrySkills(agentId, normalized);
      this.#recordSkillAssignmentDelta(agentId, previous, normalized);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return normalized;
  }

  #recordSkillAssignmentDelta(agentId, previous = [], next = []) {
    const before = new Set(previous);
    const after = new Set(next);
    for (const skillId of after) {
      if (before.has(skillId)) continue;
      this.recordSkillRuntimeEvent({
        stage: "assignment",
        status: "success",
        skillId,
        agentId,
        reason: "Skill assigned to Agent."
      });
    }
    for (const skillId of before) {
      if (after.has(skillId)) continue;
      this.recordSkillRuntimeEvent({
        stage: "assignment",
        status: "denied",
        skillId,
        agentId,
        reason: "Skill assignment removed from Agent."
      });
    }
  }

  #validateRegistrySkillIds(skillIds) {
    const normalized = [...new Set((skillIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    const missing = normalized.filter((skillId) => !this.getRegistrySkill(skillId));
    if (missing.length > 0) {
      const error = new Error(`Skill not found: ${missing.join(", ")}`);
      error.code = "SKILL_NOT_FOUND";
      throw error;
    }
    return normalized;
  }

  #replaceAgentRegistrySkills(agentId, skillIds) {
    const now = createdAtFromOrNow();
    this.db.run(`DELETE FROM agent_skill_links WHERE agent_id = ?`, [agentId]);
    for (const skillId of skillIds) {
      this.db.run(
        `INSERT INTO agent_skill_links (agent_id, skill_id, added_at) VALUES (?, ?, ?)`,
        [agentId, skillId, now]
      );
    }
    this.db.run(`DELETE FROM hub_intent_cache WHERE agent_id = ?`, [agentId]);
  }

  listAgents() {
    return this.selectAll(`SELECT * FROM agents ORDER BY created_at ASC`).map(agentFromRow);
  }

  getAgent(agentId) {
    const row = this.selectOne(`SELECT * FROM agents WHERE agent_id = ?`, [agentId]);
    return row ? agentFromRow(row) : null;
  }

  ensureAssistantAgent() {
    // 迁移：修正历史遗留的平台助手旧名（仅限 "Copilot" 等已知旧值），幂等。
    // 注意：不能对任意非 "Corptie" 名称做统一改写，否则会覆盖用户对助手的合法重命名。
    this.db.run(
      `UPDATE agents SET name = ? WHERE agent_id = ? AND name IN ('Copilot')`,
      [PLATFORM_ASSISTANT_MANIFEST.defaultName, PLATFORM_ASSISTANT_ID]
    );
    const existing = this.selectOne(`SELECT * FROM agents WHERE agent_id = ?`, [PLATFORM_ASSISTANT_ID]);
    const defaultDir = typeof existing?.work_dir === "string" && existing.work_dir.trim()
      ? resolve(existing.work_dir)
      : resolveAgentWorkDir({ agentId: PLATFORM_ASSISTANT_ID }, { environmentName: this.environmentName });
    if (existing) {
      this.db.run(
        `UPDATE agents SET
           agent_kind = ?, description = ?, role = 'agent', status = 'available',
           capabilities_json = ?, system_prompt = ?, work_dir = ?
         WHERE agent_id = ?
           AND (agent_kind IS NOT ? OR description IS NOT ? OR role IS NOT 'agent'
             OR status IS NOT 'available' OR capabilities_json IS NOT ?
             OR system_prompt IS NOT ? OR work_dir IS NOT ?)`,
        [
          AGENT_KIND.PLATFORM_ASSISTANT,
          PLATFORM_ASSISTANT_MANIFEST.description,
          JSON.stringify(PLATFORM_ASSISTANT_MANIFEST.capabilities),
          PLATFORM_ASSISTANT_MANIFEST.systemPrompt,
          defaultDir,
          PLATFORM_ASSISTANT_ID,
          AGENT_KIND.PLATFORM_ASSISTANT,
          PLATFORM_ASSISTANT_MANIFEST.description,
          JSON.stringify(PLATFORM_ASSISTANT_MANIFEST.capabilities),
          PLATFORM_ASSISTANT_MANIFEST.systemPrompt,
          defaultDir
        ]
      );
      this.db.run("DELETE FROM agent_skill_links WHERE agent_id = ?", [PLATFORM_ASSISTANT_ID]);
      return this.getAgent(PLATFORM_ASSISTANT_ID);
    }
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO agents (agent_id, agent_kind, name, description, role, status, capabilities_json, system_prompt, work_dir, current_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        PLATFORM_ASSISTANT_ID,
        AGENT_KIND.PLATFORM_ASSISTANT,
        PLATFORM_ASSISTANT_MANIFEST.defaultName,
        PLATFORM_ASSISTANT_MANIFEST.description,
        "agent",
        "available",
        JSON.stringify(PLATFORM_ASSISTANT_MANIFEST.capabilities),
        PLATFORM_ASSISTANT_MANIFEST.systemPrompt,
        defaultDir,
        null,
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getAgent(PLATFORM_ASSISTANT_ID);
  }

  migrateAgentAvailability() {
    const migrationId = "agent-always-available-v1";
    if (this.selectOne("SELECT migration_id FROM data_migrations WHERE migration_id = ?", [migrationId])) {
      return [];
    }
    const affected = this.selectAll(
      `SELECT agent_id FROM agents WHERE status <> 'available'`
    ).map((row) => row.agent_id);
    const appliedAt = createdAtFromOrNow();
    this.db.run("BEGIN IMMEDIATE");
    try {
      if (affected.length > 0) {
        const placeholders = affected.map(() => "?").join(",");
        this.db.run(
          `UPDATE agents SET status = 'available', updated_at = ?
           WHERE agent_id IN (${placeholders})`,
          [appliedAt, ...affected]
        );
      }
      this.db.run(
        "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
        [migrationId, appliedAt]
      );
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    return affected;
  }

  createAgent(input = {}) {
    const id = input.id ?? `agent:${randomUUID()}`;
    const workDir = typeof input.workDir === "string" && input.workDir.trim()
      ? resolve(input.workDir.trim())
      : resolveAgentWorkDir({ agentId: id }, { environmentName: this.environmentName });
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO agents (agent_id, agent_kind, name, description, role, status, capabilities_json, system_prompt, work_dir, avatar_path, current_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        AGENT_KIND.USER,
        input.name,
        input.description ?? "",
        "agent",
        "available",
        JSON.stringify(input.capabilities ?? []),
        input.systemPrompt ?? "",
        workDir,
        typeof input.avatarPath === "string" && input.avatarPath.trim() ? input.avatarPath.trim() : null,
        input.currentSessionId ?? null,
        now,
        now
      ]
    );
    this.scheduleSave();
    return this.getAgent(id);
  }

  updateAgent(agentId, input = {}) {
    const existing = this.getAgent(agentId);
    if (!existing) return null;
    if (isPlatformAssistant(existing)) assertPlatformAssistantPatch(input);
    const now = createdAtFromOrNow();
    const workDir = typeof input.workDir === "string" && input.workDir.trim()
      ? resolve(input.workDir.trim())
      : existing.workDir;
    // avatarPath 需区分「未传」与「显式置空」：传入 null / 空串表示清除头像，
    // 未传（不含该键）则保持原值。其余字段沿用 ?? 回退。
    const avatarPath = Object.prototype.hasOwnProperty.call(input, "avatarPath")
      ? (typeof input.avatarPath === "string" && input.avatarPath.trim() ? input.avatarPath.trim() : null)
      : existing.avatarPath;
    this.db.run(
      `UPDATE agents SET name = ?, description = ?, role = ?, status = ?, system_prompt = ?, capabilities_json = ?, work_dir = ?, avatar_path = ?, updated_at = ? WHERE agent_id = ?`,
      [
        input.name ?? existing.name,
        input.description ?? existing.description,
        "agent",
        "available",
        input.systemPrompt ?? existing.systemPrompt ?? "",
        input.capabilities != null ? JSON.stringify(input.capabilities) : JSON.stringify(existing.capabilities ?? []),
        workDir,
        avatarPath,
        now,
        agentId
      ]
    );
    this.scheduleSave();
    return this.getAgent(agentId);
  }

  deleteAgent(agentId) {
    if (isPlatformAssistant(agentId)) {
      throw platformAssistantProtectionError("The built-in Corptie Assistant cannot be deleted.");
    }
    const sessionIds = this.selectAll(
      `SELECT session_id FROM agent_sessions WHERE agent_id = ? AND unbound_at IS NULL`,
      [agentId]
    ).map((row) => row.session_id);
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => "?").join(",");
      const active = this.selectOne(
        `SELECT COUNT(*) AS count FROM sessions
         WHERE id IN (${placeholders}) AND status = 'running' AND deleted_at IS NULL`,
        sessionIds
      );
      if (active && active.count > 0) {
        const error = new Error("Agent has running sessions; stop them before deleting.");
        error.code = "AGENT_HAS_RUNNING_SESSIONS";
        throw error;
      }
    }
    const assignedWork = this.selectOne(
      "SELECT work_id FROM work_contributors WHERE agent_id = ? LIMIT 1",
      [agentId]
    );
    if (assignedWork) {
      const error = new Error(`Agent is still assigned to Work ${assignedWork.work_id}.`);
      error.code = "AGENT_ASSIGNED_TO_WORK";
      error.statusCode = 409;
      throw error;
    }
    this.db.run(`DELETE FROM agents WHERE agent_id = ?`, [agentId]);
    this.scheduleSave();
    return true;
  }
}

function agentFromRow(row) {
  return {
    agentId: row.agent_id,
    agentKind: row.agent_kind ?? AGENT_KIND.USER,
    name: row.name,
    description: row.description ?? "",
    // 防御性规范化：即使旧客户端或外部 SQL 写入了历史值，
    // 也不允许会话生命周期重新污染 Agent 可用性。
    status: "available",
    systemPrompt: row.system_prompt ?? "",
    capabilities: parseJson(row.capabilities_json, []),
    workDir: row.work_dir ?? null,
    avatarPath: row.avatar_path ?? null,
    currentSessionId: row.current_session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
