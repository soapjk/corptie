import { randomUUID } from "node:crypto";
import { normalizeSessionTitle } from "../../utils/sessionTitles.mjs";
import { SESSION_KIND } from "../../utils/sessionKinds.mjs";
import { requiredText } from "../validation.mjs";
import { parseJson } from "../storedJson.mjs";

export class SessionRouteRepository {
  constructor({
    getDatabase,
    sessionProjectionSelectSQL,
    sessionPresentationTitle,
    selectOne,
    scheduleSave,
    getSession,
    selectAll,
    runInTransaction,
    getGitWorktree,
    getTask
  }) {
    this.getDatabase = getDatabase;
    this.sessionProjectionSelectSQL = sessionProjectionSelectSQL;
    this.sessionPresentationTitle = sessionPresentationTitle;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
    this.getSession = getSession;
    this.selectAll = selectAll;
    this.runInTransaction = runInTransaction;
    this.getGitWorktree = getGitWorktree;
    this.getTask = getTask;
  }

  get db() {
    return this.getDatabase();
  }

  createLogicalSessionRoute(input) {
    const logicalSessionId = requiredText(input?.logicalSessionId, "logicalSessionId");
    const providerThreadId = requiredText(input?.providerThreadId, "providerThreadId");
    const providerId = requiredText(input?.providerId ?? "codex-app-server", "providerId");
    const providerSessionId = requiredText(input?.providerSessionId ?? providerThreadId, "providerSessionId");
    const bindingId = requiredText(input?.bindingId ?? `binding:${randomUUID()}`, "bindingId");
    const boundCwd = requiredText(input?.boundCwd, "boundCwd");
    const timestamp = input.createdAt || new Date().toISOString();
    const sessionName = requiredText(input.sessionName ?? input.title ?? logicalSessionId, "sessionName");
    const sessionNameKey = normalizeSessionTitle(sessionName);
    // Deleted routes keep their immutable IDs for audit, but names are not
    // identities and must be immediately reusable.
    this.db.run(
      "UPDATE logical_sessions SET session_name_key = NULL WHERE session_name_key = ? AND deleted_at IS NOT NULL",
      [sessionNameKey]
    );
    const nameOwner = this.selectOne(
      "SELECT logical_session_id FROM logical_sessions WHERE session_name_key = ? AND deleted_at IS NULL LIMIT 1",
      [sessionNameKey]
    );
    if (nameOwner && nameOwner.logical_session_id !== logicalSessionId) {
      const error = new Error(`A session named "${sessionName}" already exists.`);
      error.code = "SESSION_TITLE_CONFLICT";
      error.statusCode = 409;
      error.conflictingSessionId = nameOwner.logical_session_id;
      throw error;
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `INSERT INTO logical_sessions (
          logical_session_id, legacy_session_id, active_thread_id, active_workspace_id,
          repository_id, routing_version, transition_state, title, pinned,
          archived, created_at, updated_at, session_name, session_name_key
        ) VALUES (?, ?, NULL, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        [
          logicalSessionId,
          input.legacySessionId || null,
          input.worktreeId || null,
          input.repositoryId || null,
          input.title || null,
          input.pinned ? 1 : 0,
          input.archived ? 1 : 0,
          timestamp,
          timestamp,
          sessionName,
          sessionNameKey
        ]
      );
      this.db.run(
        `INSERT INTO provider_thread_bindings (
          provider_thread_id, binding_id, provider_id, provider_session_id,
          logical_session_id, worktree_id, bound_cwd,
          parent_thread_id, parent_binding_id, forked_at_turn_id, instruction_sources_json,
          permission_snapshot_json, provider_metadata_json,
          routing_version, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 1, 'active', ?, ?)`,
        [
          providerThreadId,
          bindingId,
          providerId,
          providerSessionId,
          logicalSessionId,
          input.worktreeId || null,
          boundCwd,
          JSON.stringify(input.instructionSources ?? []),
          JSON.stringify(input.permissionSnapshot ?? {}),
          JSON.stringify(input.providerMetadata ?? {}),
          timestamp,
          timestamp
        ]
      );
      this.db.run(
        "UPDATE logical_sessions SET active_thread_id = ? WHERE logical_session_id = ?",
        [providerThreadId, logicalSessionId]
      );
      this.assertLogicalSessionRoute(logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getLogicalSession(logicalSessionId);
  }

  getLogicalSession(logicalSessionId) {
    const row = this.selectOne(
      "SELECT * FROM logical_sessions WHERE logical_session_id = ? AND deleted_at IS NULL",
      [logicalSessionId]
    );
    if (!row) return null;
    // Worker and Work Chat names are projections of their owning resources.
    // Only standalone Chat sessions own a mutable Session name.
    const projectedSession = row.legacy_session_id ? this.getSession(row.legacy_session_id) : null;
    const sessionName = projectedSession?.title || row.session_name || row.title || row.logical_session_id;
    return {
      logicalSessionId: row.logical_session_id,
      legacySessionId: row.legacy_session_id,
      activeThreadId: row.active_thread_id,
      activeWorkspaceId: row.active_workspace_id,
      repositoryId: row.repository_id,
      routingVersion: Number(row.routing_version),
      transitionState: row.transition_state,
      sessionName,
      title: sessionName,
      pinned: Boolean(row.pinned),
      archived: Boolean(row.archived),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activeBinding: row.active_thread_id
        ? this.getProviderThreadBinding(row.active_thread_id)
        : null
    };
  }

  getLogicalSessionByLegacySessionId(legacySessionId) {
    const row = this.selectOne(
      "SELECT logical_session_id FROM logical_sessions WHERE legacy_session_id = ?",
      [legacySessionId]
    );
    return row ? this.getLogicalSession(row.logical_session_id) : null;
  }

  getLogicalSessionByName(sessionName) {
    return this.findLogicalSessionsByName(sessionName)[0] ?? null;
  }

  findLogicalSessionsByName(sessionName) {
    const alias = String(sessionName ?? "").trim().replace(/^[@＠]\s*/, "");
    const key = normalizeSessionTitle(alias);
    if (!key) return [];
    const rows = this.selectAll(
      `${this.sessionProjectionSelectSQL()}
       WHERE sessions.deleted_at IS NULL
         AND projection_logical.logical_session_id IS NOT NULL`
    ).filter((row) => normalizeSessionTitle(this.sessionPresentationTitle(row)) === key)
      .map((row) => ({ logical_session_id: row.projection_logical_session_id }));
    return [...new Set(rows.map((row) => row.logical_session_id))]
      .map((logicalSessionId) => this.getLogicalSession(logicalSessionId))
      .filter(Boolean);
  }

  getLogicalSessionByProviderThreadId(providerThreadId) {
    const row = this.selectOne(
      "SELECT logical_session_id FROM provider_thread_bindings WHERE provider_thread_id = ?",
      [providerThreadId]
    );
    return row ? this.getLogicalSession(row.logical_session_id) : null;
  }

  getLogicalSessionByProviderSessionId(providerId, providerSessionId) {
    const row = this.selectOne(
      `SELECT logical_session_id FROM provider_thread_bindings
       WHERE provider_id = ? AND provider_session_id = ? AND state = 'active'`,
      [providerId, providerSessionId]
    );
    return row ? this.getLogicalSession(row.logical_session_id) : null;
  }

  deleteLogicalSessionByLegacySessionId(legacySessionId) {
    const row = this.selectOne(
      "SELECT logical_session_id FROM logical_sessions WHERE legacy_session_id = ? AND deleted_at IS NULL",
      [legacySessionId]
    );
    if (!row) return false;
    const timestamp = new Date().toISOString();
    this.runInTransaction(() => {
      // Provider bindings and the Logical Session remain as immutable routing
      // evidence for startup/recovery audit rows. Clearing the active route
      // makes the tombstone unusable for execution and releases its workspace.
      this.db.run(
        `UPDATE provider_thread_bindings
         SET state=CASE WHEN state='active' THEN 'invalid' ELSE state END, updated_at=?
         WHERE logical_session_id=?`,
        [timestamp, row.logical_session_id]
      );
      this.db.run("DELETE FROM session_name_aliases WHERE logical_session_id=?", [row.logical_session_id]);
      this.db.run(
        `UPDATE logical_sessions
         SET active_thread_id=NULL, active_workspace_id=NULL,
             transition_state=NULL, pinned=0, archived=1,
             session_name_key=NULL, deleted_at=?, updated_at=?
         WHERE logical_session_id=? AND deleted_at IS NULL`,
        [timestamp, timestamp, row.logical_session_id]
      );
    });
    this.scheduleSave();
    return true;
  }

  listLogicalSessionsByWorkspaceId(worktreeId) {
    return this.selectAll(
      "SELECT logical_session_id FROM logical_sessions WHERE active_workspace_id = ?",
      [worktreeId]
    ).map((row) => this.getLogicalSession(row.logical_session_id));
  }

  rebindActiveWorkspacePath(input) {
    const logicalSessionId = requiredText(input?.logicalSessionId, "logicalSessionId");
    const providerThreadId = requiredText(input?.providerThreadId, "providerThreadId");
    const worktreeId = requiredText(input?.worktreeId, "worktreeId");
    const boundCwd = requiredText(input?.boundCwd, "boundCwd");
    const routingVersion = Number(input.routingVersion);
    const timestamp = input.updatedAt || new Date().toISOString();
    const target = this.getGitWorktree(worktreeId);
    if (!target || target.availability !== "available") {
      throw new Error(`Worktree ${worktreeId} is not available.`);
    }
    if (boundCwd !== (target.canonicalPath || target.path)) {
      throw new Error("The rebound cwd does not match the registered worktree path.");
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      const logical = this.selectOne(
        "SELECT * FROM logical_sessions WHERE logical_session_id = ?",
        [logicalSessionId]
      );
      if (!logical
        || logical.active_thread_id !== providerThreadId
        || logical.active_workspace_id !== worktreeId
        || Number(logical.routing_version) !== routingVersion) {
        throw new Error("The logical session route changed before its workspace path could be rebound.");
      }
      this.db.run(
        `UPDATE provider_thread_bindings
         SET bound_cwd = ?, instruction_sources_json = ?, permission_snapshot_json = ?,
             routing_version = ?, updated_at = ?
         WHERE provider_thread_id = ? AND state = 'active'`,
        [
          boundCwd,
          JSON.stringify(input.instructionSources ?? []),
          JSON.stringify(input.permissionSnapshot ?? {}),
          routingVersion + 1,
          timestamp,
          providerThreadId
        ]
      );
      this.db.run(
        `UPDATE logical_sessions
         SET routing_version = routing_version + 1, updated_at = ?
         WHERE logical_session_id = ?`,
        [timestamp, logicalSessionId]
      );
      this.db.run(
        `UPDATE sessions SET cwd = ?, updated_at = ?
         WHERE id = (SELECT legacy_session_id FROM logical_sessions WHERE logical_session_id = ?)`,
        [boundCwd, timestamp, logicalSessionId]
      );
      this.assertLogicalSessionRoute(logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getLogicalSession(logicalSessionId);
  }

  getProviderThreadBinding(providerThreadId) {
    const row = this.selectOne(
      "SELECT * FROM provider_thread_bindings WHERE provider_thread_id = ?",
      [providerThreadId]
    );
    return row ? providerThreadBindingFromRow(row) : null;
  }


  getAgentSessionBinding(bindingId) {
    const row = this.selectOne(
      "SELECT * FROM provider_thread_bindings WHERE binding_id = ?",
      [bindingId]
    );
    return row ? providerThreadBindingFromRow(row) : null;
  }

  getAgentSessionBindingByProviderSession(providerId, providerSessionId) {
    const row = this.selectOne(
      `SELECT * FROM provider_thread_bindings
       WHERE provider_id = ? AND provider_session_id = ?
       ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, routing_version DESC
       LIMIT 1`,
      [providerId, providerSessionId]
    );
    return row ? providerThreadBindingFromRow(row) : null;
  }

  listProviderThreadBindings(logicalSessionId) {
    return this.selectAll(
      `SELECT * FROM provider_thread_bindings
       WHERE logical_session_id = ?
       ORDER BY created_at ASC, provider_thread_id ASC`,
      [logicalSessionId]
    ).map(providerThreadBindingFromRow);
  }

  listActiveProviderSessionIds(providerId) {
    const normalizedProviderId = requiredText(providerId, "providerId");
    return this.selectAll(
      `SELECT DISTINCT bindings.provider_session_id
       FROM provider_thread_bindings bindings
       LEFT JOIN logical_sessions logical
         ON logical.logical_session_id = bindings.logical_session_id
       LEFT JOIN sessions
         ON sessions.id = logical.legacy_session_id
       WHERE bindings.provider_id = ?
         AND bindings.state = 'active'
         AND bindings.provider_session_id IS NOT NULL
         AND COALESCE((
           sessions.archived = 1
           OR (sessions.session_kind = 'worker' AND EXISTS (
             SELECT 1 FROM tasks archived_task
             WHERE archived_task.id = sessions.task_id
               AND (archived_task.lifecycle_state = 'done' OR archived_task.archived = 1)
           ))
         ), 0) = 0
       ORDER BY provider_session_id ASC`,
      [normalizedProviderId]
    ).map((row) => row.provider_session_id);
  }

  hasUnsettledSessionRuntimeWork(sessionId) {
    const id = requiredText(sessionId, "sessionId");
    const activeTurn = this.selectOne(
      `SELECT 1 AS active FROM session_turns
       WHERE session_id=? AND execution_status IN ('running','blocked') LIMIT 1`,
      [id]
    );
    const activeDelivery = this.selectOne(
      `SELECT 1 AS active FROM message_deliveries
       WHERE session_id=? AND status IN ('queued','dispatching','accepted','processing','delivery_unknown') LIMIT 1`,
      [id]
    );
    const activeWork = this.selectOne(
      `SELECT 1 AS active FROM agent_operations
       WHERE session_id=? AND status IN ('queued','running') LIMIT 1`,
      [id]
    );
    return Boolean(activeTurn || activeDelivery || activeWork);
  }


  recordProviderThreadBinding(input) {
    const providerThreadId = requiredText(input?.providerThreadId, "providerThreadId");
    const providerId = requiredText(input?.providerId ?? "codex-app-server", "providerId");
    const providerSessionId = requiredText(input?.providerSessionId ?? providerThreadId, "providerSessionId");
    const bindingId = requiredText(input?.bindingId ?? `binding:${randomUUID()}`, "bindingId");
    if (providerSessionId !== providerThreadId) {
      throw new Error("providerSessionId must match providerThreadId during the compatibility migration.");
    }
    const logicalSessionId = requiredText(input?.logicalSessionId, "logicalSessionId");
    const boundCwd = requiredText(input?.boundCwd, "boundCwd");
    const state = input.state || "orphaned";
    if (!["invalid", "orphaned"].includes(state)) {
      throw new Error("Detached provider bindings must be invalid or orphaned.");
    }
    const timestamp = input.createdAt || new Date().toISOString();
    this.db.run(
      `INSERT INTO provider_thread_bindings (
        provider_thread_id, binding_id, provider_id, provider_session_id,
        logical_session_id, worktree_id, bound_cwd,
        parent_thread_id, parent_binding_id, forked_at_turn_id, instruction_sources_json,
        permission_snapshot_json, provider_metadata_json,
        routing_version, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_thread_id) DO UPDATE SET
        provider_id=excluded.provider_id,
        provider_session_id=excluded.provider_session_id,
        instruction_sources_json=excluded.instruction_sources_json,
        permission_snapshot_json=excluded.permission_snapshot_json,
        provider_metadata_json=excluded.provider_metadata_json,
        state=excluded.state,
        updated_at=excluded.updated_at`,
      [
        providerThreadId,
        bindingId,
        providerId,
        providerSessionId,
        logicalSessionId,
        input.worktreeId || null,
        boundCwd,
        input.parentThreadId || null,
        input.parentBindingId || null,
        input.forkedAtTurnId || null,
        JSON.stringify(input.instructionSources ?? []),
        JSON.stringify(input.permissionSnapshot ?? {}),
        JSON.stringify(input.providerMetadata ?? {}),
        Number(input.routingVersion) || 1,
        state,
        timestamp,
        timestamp
      ]
    );
    this.scheduleSave();
    return this.getProviderThreadBinding(providerThreadId);
  }


  assertLogicalSessionRoute(logicalSessionId) {
    const row = this.selectOne(
      `SELECT ls.active_thread_id, ls.active_workspace_id, binding.worktree_id, binding.state
       FROM logical_sessions ls
       LEFT JOIN provider_thread_bindings binding
         ON binding.provider_thread_id = ls.active_thread_id
       WHERE ls.logical_session_id = ?`,
      [logicalSessionId]
    );
    if (!row?.active_thread_id || row.state !== "active") {
      throw new Error(`Logical session ${logicalSessionId} has no valid active thread.`);
    }
    if ((row.active_workspace_id ?? null) !== (row.worktree_id ?? null)) {
      throw new Error(`Logical session ${logicalSessionId} has mismatched thread and workspace bindings.`);
    }
    return true;
  }

  retireLogicalSessionWorkspace(logicalSessionId, expectedWorktreeId) {
    const logical = this.getLogicalSession(logicalSessionId);
    if (!logical?.activeBinding || logical.activeWorkspaceId !== expectedWorktreeId) {
      const error = new Error(`Logical Session ${logicalSessionId} is no longer bound to the selected Worktree.`);
      error.code = "WORKSPACE_ROUTE_CHANGED";
      throw error;
    }
    const timestamp = new Date().toISOString();
    const session = logical.legacySessionId ? this.getSession(logical.legacySessionId) : null;
    const rawStatus = {
      ...(session?.rawStatus ?? {}),
      capabilities: {
        ...(session?.rawStatus?.capabilities ?? session?.capabilities ?? {}),
        canSend: false,
        canInterrupt: false,
        canReconnect: false
      },
      workspaceRetired: {
        worktreeId: expectedWorktreeId,
        path: logical.activeBinding.boundCwd,
        retiredAt: timestamp
      }
    };
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `UPDATE provider_thread_bindings
         SET worktree_id = NULL, updated_at = ?
         WHERE provider_thread_id = ? AND state = 'active'`,
        [timestamp, logical.activeThreadId]
      );
      this.db.run(
        `UPDATE logical_sessions
         SET active_workspace_id = NULL, archived = 1, updated_at = ?
         WHERE logical_session_id = ?`,
        [timestamp, logicalSessionId]
      );
      if (logical.legacySessionId) {
        this.db.run(
          `UPDATE sessions
           SET archived = 1, status = 'complete', raw_json = ?, updated_at = ?
           WHERE id = ?`,
          [JSON.stringify(rawStatus), timestamp, logical.legacySessionId]
        );
      }
      this.assertLogicalSessionRoute(logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getLogicalSession(logicalSessionId);
  }

  restoreLogicalSessionWorkspace(logicalSessionId) {
    const logical = this.getLogicalSession(logicalSessionId);
    if (!logical?.activeBinding || !logical.activeWorkspaceId) {
      const error = new Error(`Logical Session ${logicalSessionId} has no active Workspace to restore.`);
      error.code = "WORKSPACE_ROUTE_UNAVAILABLE";
      throw error;
    }
    const timestamp = new Date().toISOString();
    const session = logical.legacySessionId ? this.getSession(logical.legacySessionId) : null;
    const rawStatus = { ...(session?.rawStatus ?? {}) };
    delete rawStatus.workspaceRetired;
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `UPDATE logical_sessions SET archived = 0, updated_at = ? WHERE logical_session_id = ?`,
        [timestamp, logicalSessionId]
      );
      if (logical.legacySessionId) {
        this.db.run(
          `UPDATE sessions SET archived = 0, raw_json = ?, updated_at = ? WHERE id = ?`,
          [JSON.stringify(rawStatus), timestamp, logical.legacySessionId]
        );
      }
      this.assertLogicalSessionRoute(logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getLogicalSession(logicalSessionId);
  }

  // A Work Session keeps one stable product Session identity while its Provider
  // binding is replaced during a workspace transition. The Task ownership
  // must therefore remain intact before and after every route commit.
  assertLogicalWorkSessionBinding(logicalSessionId) {
    const logical = this.getLogicalSession(logicalSessionId);
    if (!logical?.legacySessionId) {
      // Provider-only routes can exist during migration/recovery. They are not
      // Work Sessions and therefore have no Task ownership to preserve.
      return { logicalSessionId, sessionId: null, taskId: null, agentId: null };
    }
    const session = this.getSession(logical.legacySessionId);
    if (!session) {
      const error = new Error(`Product Session not found: ${logical.legacySessionId}`);
      error.code = "WORK_SESSION_BINDING_INVALID";
      throw error;
    }
    const isWorkSession = session.sessionKind === SESSION_KIND.worker || Boolean(session.taskId);
    if (!isWorkSession) {
      return { logicalSessionId, sessionId: session.id, taskId: null };
    }
    if (!session.taskId) {
      const error = new Error(`Worker Session ${session.id} is not bound to a Task.`);
      error.code = "WORK_SESSION_BINDING_INVALID";
      throw error;
    }
    const task = this.getTask(session.taskId);
    if (!task) {
      const error = new Error(`Task not found for Worker Session ${session.id}: ${session.taskId}`);
      error.code = "WORK_SESSION_BINDING_INVALID";
      throw error;
    }
    if (task.current_session_id !== session.id) {
      const error = new Error(
        `Task ${task.id} points to ${task.current_session_id ?? "no Session"}, not active Worker Session ${session.id}.`
      );
      error.code = "WORK_SESSION_BINDING_STALE";
      throw error;
    }
    if (session.workId !== task.work_id) {
      const error = new Error(`Worker Session ${session.id} and Task ${task.id} have different Works.`);
      error.code = "WORK_SESSION_BINDING_INVALID";
      throw error;
    }
    if (task.main_agent_id && session.agentId !== task.main_agent_id) {
      const error = new Error(`Worker Session ${session.id} and Task ${task.id} have different Agents.`);
      error.code = "WORK_SESSION_BINDING_INVALID";
      throw error;
    }
    return {
      logicalSessionId,
      sessionId: session.id,
      taskId: task.id,
      workId: task.work_id,
      agentId: task.main_agent_id ?? session.agentId ?? null
    };
  }
}

function providerThreadBindingFromRow(row) {
  return {
    bindingId: row.binding_id,
    providerId: row.provider_id,
    providerSessionId: row.provider_session_id ?? row.provider_thread_id,
    providerThreadId: row.provider_thread_id,
    logicalSessionId: row.logical_session_id,
    worktreeId: row.worktree_id,
    boundCwd: row.bound_cwd,
    parentThreadId: row.parent_thread_id,
    parentBindingId: row.parent_binding_id,
    forkedAtTurnId: row.forked_at_turn_id,
    instructionSources: parseJson(row.instruction_sources_json, []),
    permissionSnapshot: parseJson(row.permission_snapshot_json, {}),
    providerMetadata: parseJson(row.provider_metadata_json, {}),
    routingVersion: Number(row.routing_version ?? 1),
    bindingGeneration: Number(row.binding_generation ?? 1),
    capabilityRevision: row.capability_revision ?? "legacy:unknown",
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
