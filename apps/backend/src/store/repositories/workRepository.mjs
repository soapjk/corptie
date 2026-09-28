import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { associationError, validateWorkInput } from "../../domain/workTaskValidation.mjs";
import { parseJson } from "../storedJson.mjs";

export class WorkRepository {
  constructor({ getDatabase, selectAll, selectOne, assertAssignableAgent, getWorkspace, createWorkspace, runInTransaction, scheduleSave, listTasksByWork }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.assertAssignableAgent = assertAssignableAgent;
    this.getWorkspace = getWorkspace;
    this.createWorkspace = createWorkspace;
    this.runInTransaction = runInTransaction;
    this.scheduleSave = scheduleSave;
    this.listTasksByWork = listTasksByWork;
  }

  get db() {
    return this.getDatabase();
  }

  createWork(input = {}) {
    const normalized = validateWorkInput(input, "create");
    const id = normalized.id ?? `work:${randomUUID()}`;
    for (const [index, agentId] of normalized.contributorAgentIds.entries()) {
      this.assertAssignableAgent(agentId, `contributorAgentIds[${index}]`);
    }
    const workspace = normalized.workspaceId
      ? this.getWorkspace(normalized.workspaceId)
      : this.createWorkspace();
    if (!workspace) {
      throw associationError(
        "WORKSPACE_NOT_FOUND", "workspaceId", "existing Workspace ID", normalized.workspaceId,
        `Workspace not found: ${normalized.workspaceId}`
      );
    }
    const inputWithWorkspace = { ...normalized, workspaceId: workspace.workspaceId };
    this.assertWorkAssociations(inputWithWorkspace, { workId: id });
    const now = createdAtFromOrNow();
    this.runInTransaction(() => {
      this.db.run(
        `INSERT INTO works (
          id, workspace_id, name, description, avatar_path, status, profile,
          tags_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          workspace.workspaceId,
          normalized.name,
          normalized.description ?? "",
          normalized.avatarPath ?? null,
          normalized.status ?? "active",
          normalized.profile ?? "general",
          JSON.stringify(normalized.tags ?? []),
          now,
          now,
        ]
      );
      this.replaceWorkContributors(
        id,
        normalized.contributorAgentIds,
        normalized.primaryAgentId ?? normalized.contributorAgentIds[0],
        now
      );
    });
    this.scheduleSave();
    return this.getWork(id);
  }

  listWorks() {
    return this.selectAll(`SELECT * FROM works ORDER BY created_at DESC`)
      .map((row) => workFromRow(row, this.listWorkContributors(row.id)));
  }

  listClientWorkPage({ limit, cursor }) {
    const rows = this.selectAll(
      `SELECT id, name, status, avatar_path, updated_at FROM works WHERE status = 'active'
       ${cursor ? "AND (updated_at < ? OR (updated_at = ? AND id < ?))" : ""}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
      [...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []), limit + 1]);
    const items = rows.slice(0, limit), tail = items.at(-1), hasMore = rows.length > limit;
    return { items, hasMore, nextCursor: hasMore ? { id: tail.id, updatedAt: tail.updated_at } : null };
  }

  getWork(id) {
    const row = this.selectOne(`SELECT * FROM works WHERE id = ?`, [id]);
    return row ? workFromRow(row, this.listWorkContributors(id)) : null;
  }

  listWorkContributors(workId) {
    return this.selectAll(
      `SELECT work_id, agent_id, role, is_primary, created_at
       FROM work_contributors
       WHERE work_id = ?
       ORDER BY is_primary DESC, created_at ASC, agent_id ASC`,
      [workId]
    ).map((row) => ({
      workId: row.work_id,
      agentId: row.agent_id,
      role: row.role,
      isPrimary: row.is_primary === 1,
      createdAt: row.created_at
    }));
  }

  replaceWorkContributors(workId, agentIds, primaryAgentId, timestamp = createdAtFromOrNow()) {
    const uniqueAgentIds = [...new Set(agentIds ?? [])];
    if (uniqueAgentIds.length === 0) {
      throw associationError(
        "WORK_CONTRIBUTOR_REQUIRED", "contributorAgentIds", "at least one assignable Agent ID", agentIds,
        "A Work requires at least one contributor Agent."
      );
    }
    const primary = primaryAgentId && uniqueAgentIds.includes(primaryAgentId)
      ? primaryAgentId
      : uniqueAgentIds[0];
    this.db.run("DELETE FROM work_contributors WHERE work_id = ?", [workId]);
    for (const agentId of uniqueAgentIds) {
      this.db.run(
        `INSERT INTO work_contributors (work_id, agent_id, role, is_primary, created_at)
         VALUES (?, ?, 'contributor', ?, ?)`,
        [workId, agentId, agentId === primary ? 1 : 0, timestamp]
      );
    }
  }

  updateWork(id, patch = {}) {
    const current = this.getWork(id);
    if (!current) return null;
    const normalized = validateWorkInput(patch, "update");
    const prospectiveContributorIds = normalized.contributorAgentIds ?? current.contributorAgentIds;
    const prospectivePrimaryAgentId = Object.prototype.hasOwnProperty.call(normalized, "primaryAgentId")
      ? normalized.primaryAgentId
      : prospectiveContributorIds.includes(current.primaryAgentId)
        ? current.primaryAgentId
        : prospectiveContributorIds[0] ?? null;
    const prospective = {
      ...current,
      ...normalized,
      contributorAgentIds: prospectiveContributorIds,
      primaryAgentId: prospectivePrimaryAgentId
    };
    this.assertWorkAssociations(prospective, { workId: id, validateTaskScope: true });
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    const now = createdAtFromOrNow();
    this.runInTransaction(() => {
      this.db.run(
        `UPDATE works SET name=?, description=?, avatar_path=?, status=?, profile=?, tags_json=?, updated_at=? WHERE id=?`,
        [
          has("name") ? normalized.name : current.name,
          has("description") ? normalized.description : current.description,
          has("avatarPath") ? normalized.avatarPath : current.avatarPath,
          has("status") ? normalized.status : current.status,
          has("profile") ? normalized.profile : current.profile,
          has("tags") ? JSON.stringify(normalized.tags) : JSON.stringify(current.tags ?? []),
          now,
          id,
        ]
      );
      if (has("contributorAgentIds") || has("primaryAgentId")) {
        const contributorAgentIds = has("contributorAgentIds")
          ? normalized.contributorAgentIds
          : current.contributorAgentIds;
        const primaryAgentId = prospectivePrimaryAgentId;
        this.replaceWorkContributors(id, contributorAgentIds, primaryAgentId, now);
      }
    });
    this.scheduleSave();
    return this.getWork(id);
  }

  deleteWork(id) {
    const work = this.getWork(id);
    if (!work) return false;
    const workspace = this.getWorkspace(work.workspaceId);
    this.runInTransaction(() => {
      this.db.run(`DELETE FROM works WHERE id = ?`, [id]);
      if (workspace?.ownership === "corptieManaged") {
        this.db.run("DELETE FROM workspaces WHERE workspace_id = ?", [workspace.workspaceId]);
      }
    });
    this.scheduleSave();
    return true;
  }


  assertWorkAssociations(input, options = {}) {
    const workId = options.workId ?? input.id ?? null;
    const workspaceId = input.workspaceId ?? null;
    const contributorAgentIds = input.contributorAgentIds ?? [];
    if (!workspaceId || !this.getWorkspace(workspaceId)) {
      throw associationError(
        "WORKSPACE_NOT_FOUND", "workspaceId", "existing Workspace ID", workspaceId,
        `Workspace not found: ${workspaceId}`
      );
    }
    const workspaceOwner = this.selectOne(
      "SELECT id FROM works WHERE workspace_id = ? AND id <> ? LIMIT 1",
      [workspaceId, workId]
    );
    if (workspaceOwner) {
      throw associationError(
        "WORKSPACE_ALREADY_BOUND", "workspaceId", "unbound Workspace ID", workspaceId,
        `Workspace is already bound to Work ${workspaceOwner.id}.`
      );
    }
    for (const [index, agentId] of contributorAgentIds.entries()) {
      this.assertAssignableAgent(agentId, `contributorAgentIds[${index}]`);
    }
    if (input.primaryAgentId && !contributorAgentIds.includes(input.primaryAgentId)) {
      throw associationError(
        "PRIMARY_AGENT_OUTSIDE_WORK", "primaryAgentId", "Agent in Work contributors",
        input.primaryAgentId, "Work primaryAgentId must identify one of its contributors."
      );
    }

    if (!options.validateTaskScope || !workId) return;
    const agentScope = new Set(contributorAgentIds);
    for (const task of this.listTasksByWork(workId)) {
      if (task.main_agent_id && !agentScope.has(task.main_agent_id)) {
        throw associationError(
          "WORK_SCOPE_CONFLICT", "contributorAgentIds", "must include every Task mainAgentId",
          task.main_agent_id,
          `Agent is still assigned to Task ${task.id}.`
        );
      }
    }
  }
}

function workFromRow(row, contributors = []) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description ?? "",
    avatarPath: row.avatar_path ?? null,
    status: row.status,
    profile: row.profile ?? "general",
    tags: parseJson(row.tags_json, []),
    contributorAgentIds: contributors.map((item) => item.agentId),
    primaryAgentId: contributors.find((item) => item.isPrimary)?.agentId ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
