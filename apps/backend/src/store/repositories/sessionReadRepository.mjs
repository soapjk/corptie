import { sessionAttention } from "../../utils/sessionAttention.mjs";
import { inferSessionKind } from "../../utils/sessionKinds.mjs";
import { resolveSessionArchiveState } from "../../domain/sessionArchivePolicy.mjs";
import { parseJson } from "../storedJson.mjs";
import { sessionProjectionSelectSQL, sessionPresentationTitle, effectiveSessionArchivedSQL, normalizedExecutionStatus, normalizedProviderConnectionStatus, parseActiveChoicePrompt, normalizedStoredProviderCapabilities, modelFromArgs, reasoningFromArgs } from "../storedSessionProjection.mjs";

// Read projections only; database and transaction lifecycles remain owned by Store.
export class SessionReadRepository {
  constructor({ selectOne, selectAll, getItems }) {
    this.getItems = getItems;
    this.selectOne = selectOne;
    this.selectAll = selectAll;
  }

  getDetail(id, { includeItems = true } = {}) {
    const session = this.getSession(id);
    if (!session) {
      return null;
    }

    return {
      id,
      title: session.title,
      status: session.external?.provider === "claude-sdk" && session.status === "running" ? "failed" : session.status,
      source: session.external?.provider,
      connectionStatus: "disconnected",
      currentModel: session.external?.currentModel ?? session.rawStatus?.currentModel ?? session.rawStatus?.resume?.currentModel ?? null,
      cwd: session.external?.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      rawStatus: session.rawStatus,
      capabilities: normalizedStoredProviderCapabilities(
        session.external?.provider,
        session.status,
        session.rawStatus?.capabilities
      ),
      canSend: false,
      sendUnavailableReason: session.external?.provider === "claude-sdk"
          ? "This Claude Code session is no longer connected. Start a new Claude session to continue."
        : "This session is not currently attached to a running process.",
      turnCount: 1,
      items: includeItems ? this.getItems(id, 240, session.external?.provider) : []
    };
  }

  listEmptyActiveProviderBindings(providerId) {
    return this.selectAll(
      `SELECT sessions.id AS session_id,
              logical.logical_session_id,
              binding.binding_id,
              binding.provider_id,
              binding.provider_session_id
       FROM logical_sessions logical
       JOIN sessions ON sessions.id = logical.legacy_session_id
       JOIN provider_thread_bindings binding
         ON binding.provider_thread_id = logical.active_thread_id
       WHERE logical.archived = 0
         AND sessions.deleted_at IS NULL
         AND ${effectiveSessionArchivedSQL()} = 0
         AND logical.transition_state IS NULL
         AND binding.state = 'active'
         AND binding.provider_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM session_turns turn
           WHERE turn.session_id = sessions.id
             AND turn.binding_id = binding.binding_id
         )
       ORDER BY sessions.pinned DESC,
                sessions.sort_order ASC,
                sessions.updated_at DESC,
                logical.logical_session_id ASC`,
      [providerId]
    ).map((row) => ({
      sessionId: row.session_id,
      logicalSessionId: row.logical_session_id,
      bindingId: row.binding_id,
      providerId: row.provider_id,
      providerSessionId: row.provider_session_id
    }));
  }

  listSessions(options = {}) {
    const archived = options.archived === true ? 1 : 0;
    const rows = this.selectAll(
      `${sessionProjectionSelectSQL()}
       WHERE sessions.deleted_at IS NULL
         AND ${effectiveSessionArchivedSQL()} = ?
       ORDER BY sessions.pinned DESC, sessions.sort_order ASC, sessions.updated_at DESC`,
      [archived]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  listSessionTitleIdentities() {
    return this.selectAll(`${sessionProjectionSelectSQL()} WHERE sessions.deleted_at IS NULL`)
      .map((row) => ({ id: row.id, title: sessionPresentationTitle(row) }))
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  }

  listSessionPage(options = {}) {
    const archived = options.archived === true ? 1 : 0;
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const cursor = options.cursor ?? null;
    const sessionKind = typeof options.sessionKind === "string" && options.sessionKind
      ? options.sessionKind
      : null;
    const sessionId = typeof options.sessionId === "string" && options.sessionId
      ? options.sessionId
      : null;
    const workId = typeof options.workId === "string" && options.workId ? options.workId : null;
    const taskId = typeof options.taskId === "string" && options.taskId ? options.taskId : null;
    const includeArchived = options.includeArchived === true;
    const queryTerms = typeof options.query === "string"
      ? options.query.trim().split(/\s+/u).filter(Boolean).slice(0, 8)
        .map((term) => `%${term.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`) : [];
    const hasCursor = typeof cursor?.updatedAt === "string" && typeof cursor?.id === "string";
    const rows = this.selectAll(
      `${sessionProjectionSelectSQL()}
       WHERE sessions.deleted_at IS NULL
         ${includeArchived ? "" : `AND ${effectiveSessionArchivedSQL()} = ?`}
         ${sessionId ? "AND sessions.id = ?" : ""}
         ${workId ? "AND sessions.work_id = ?" : ""}
         ${taskId ? "AND sessions.task_id = ?" : ""}
         ${queryTerms.length ? `AND (${queryTerms.map(() => "sessions.title LIKE ? ESCAPE '\\' OR sessions.summary LIKE ? ESCAPE '\\'").join(" OR ")})` : ""}
         ${sessionKind ? "AND sessions.session_kind = ?" : ""}
         ${hasCursor ? `AND (
           sessions.updated_at < ?
           OR (sessions.updated_at = ? AND sessions.id < ?)
         )` : ""}
       ORDER BY sessions.updated_at DESC, sessions.id DESC
       LIMIT ?`,
      [
        ...(includeArchived ? [] : [archived]),
        ...(sessionId ? [sessionId] : []),
        ...(workId ? [workId] : []),
        ...(taskId ? [taskId] : []),
        ...queryTerms.flatMap((term) => [term, term]),
        ...(sessionKind ? [sessionKind] : []),
        ...(hasCursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []),
        limit + 1
      ]
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => this.rowToSession(row));
    const tail = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && tail
        ? { updatedAt: tail.updatedAt, id: tail.id }
        : null
    };
  }

  getSession(id) {
    const row = this.selectOne(
      `${sessionProjectionSelectSQL()} WHERE sessions.id = ? AND sessions.deleted_at IS NULL`,
      [id]
    );
    return row ? this.rowToSession(row) : null;
  }

  listSessionsByTask(taskId) {
    const rows = this.selectAll(
      `${sessionProjectionSelectSQL()} WHERE sessions.task_id = ? AND sessions.deleted_at IS NULL ORDER BY sessions.created_at ASC`,
      [taskId]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  listSessionsByWork(workId) {
    const rows = this.selectAll(
      `${sessionProjectionSelectSQL()} WHERE sessions.work_id = ? AND sessions.deleted_at IS NULL ORDER BY sessions.created_at ASC`,
      [workId]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  getWorkChatSession(workId) {
    const row = this.selectOne(
      `${sessionProjectionSelectSQL()}
       WHERE sessions.work_id = ? AND sessions.session_kind = 'workChat' AND sessions.deleted_at IS NULL
       ORDER BY sessions.created_at ASC, sessions.id ASC LIMIT 1`,
      [workId]
    );
    return row ? this.rowToSession(row) : null;
  }

  listSessionsByAgent(agentId) {
    const rows = this.selectAll(
      `${sessionProjectionSelectSQL()}
       WHERE sessions.deleted_at IS NULL AND (sessions.agent_id = ? OR EXISTS (
         SELECT 1 FROM agent_sessions bindings
         WHERE bindings.session_id = sessions.id AND bindings.agent_id = ?
       ))
       ORDER BY sessions.created_at ASC`,
      [agentId, agentId]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  listArchivedSessionsPendingRuntimeRelease({ taskId = null, limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.selectAll(
      `${sessionProjectionSelectSQL()}
       WHERE sessions.archived = 1
         AND sessions.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM session_runtime_release_receipts receipt
           WHERE receipt.session_id = sessions.id
         )
         ${taskId ? "AND sessions.task_id = ?" : ""}
       ORDER BY sessions.pinned DESC, sessions.sort_order ASC, sessions.id ASC
       LIMIT ?`,
      taskId ? [taskId, boundedLimit] : [boundedLimit]
    ).map((row) => this.rowToSession(row));
  }

  rowToSession(row) {
    const rawStatus = parseJson(row.raw_json, {});
    const args = parseJson(row.args_json, []);
    // Stored Provider turn outcomes use "completed"; the product Session
    // contract exposed to both clients uses "complete". A legacy value must
    // not make an entire State Sync snapshot undecodable on macOS.
    const status = row.status === "completed" ? "complete" : row.status;
    const projectedProvider = row.projection_provider_id ?? row.provider;
    const isCodexAppServer = projectedProvider === "codex-app-server";
    const publicId = row.id;
    const threadId = row.projection_provider_thread_id
      ?? rawStatus.threadId
      ?? (isCodexAppServer ? String(row.id).replace(/^codex:/, "") : row.id);
    const displayStatus = status;
    const executionStatus = row.projection_execution_status
      ?? normalizedExecutionStatus(displayStatus);
    const deliveryStatus = row.projection_delivery_status ?? null;
    const providerConnectionStatus = row.projection_provider_connection_status
      ?? normalizedProviderConnectionStatus(rawStatus.connectionStatus);
    const syncHealth = row.projection_sync_health ?? "healthy";
    const activeChoicePrompt = parseActiveChoicePrompt(row.active_choice_json);
    const suggestedOptions = activeChoicePrompt?.options ?? null;
    const logicalIdentity = Object.hasOwn(row, "projection_logical_session_id")
      ? {
          logical_session_id: row.projection_logical_session_id,
          session_name: row.projection_session_name,
          transition_state: row.projection_transition_state,
          routing_version: row.projection_routing_version,
          active_workspace_id: row.projection_active_workspace_id,
          repository_id: row.projection_repository_id
        }
      : this.selectOne(
        `SELECT logical_session_id, session_name, transition_state, routing_version,
                active_workspace_id, repository_id
         FROM logical_sessions WHERE legacy_session_id = ?`,
        [row.id]
      );
    const routingVersion = logicalIdentity?.routing_version == null
      ? Number(rawStatus.routingVersion ?? 0)
      : Number(logicalIdentity.routing_version);
    const activeCwd = row.projection_bound_cwd ?? row.cwd;
    const agentIdentity = Object.hasOwn(row, "projection_binding_agent_id")
      ? { agent_id: row.projection_binding_agent_id }
      : this.selectOne(
        `SELECT bindings.agent_id
         FROM agent_sessions bindings
         WHERE bindings.session_id = ? AND bindings.unbound_at IS NULL LIMIT 1`,
        [row.id]
      );
    const sessionKind = inferSessionKind({
      sessionKind: row.session_kind,
      workId: row.work_id,
      taskId: row.task_id
    });
    const archiveState = resolveSessionArchiveState(
      { sessionKind, archived: Boolean(row.archived) },
      { taskStatus: row.projection_task_status, taskArchived: row.projection_task_archived === 1 }
    );
    return {
      id: publicId,
      title: sessionPresentationTitle(row),
      sessionName: sessionPresentationTitle(row),
      logicalSessionId: logicalIdentity?.logical_session_id ?? null,
      transitionState: logicalIdentity?.transition_state ?? null,
      agent: row.agent,
      agentId: row.agent_id ?? agentIdentity?.agent_id ?? null,
      sessionKind,
      status: displayStatus,
      executionStatus,
      deliveryStatus,
      providerConnectionStatus,
      syncHealth,
      progress: displayStatus === "running" || displayStatus === "blocked" ? Number(row.progress) : 1,
      summary: row.summary,
      canSend: logicalIdentity?.transition_state === "sessionRecovery" ? false : undefined,
      sendUnavailableReason: logicalIdentity?.transition_state === "sessionRecovery"
        ? "Session recovery is in progress. Sending messages is temporarily unavailable."
        : rawStatus.sendUnavailableReason ?? null,
      activityStatus: rawStatus.activityStatus ?? null,
      suggestedOptions,
      suggestedPrompt: activeChoicePrompt?.prompt ?? null,
      attention: sessionAttention({ status: displayStatus, executionStatus,
        choice: activeChoicePrompt, failureReason: rawStatus.sendUnavailableReason,
        updatedAt: row.updated_at }),
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      accent: row.accent,
      archived: archiveState.archived,
      archiveReason: archiveState.reason,
      pinned: Boolean(row.pinned),
      sortOrder: Number(row.sort_order ?? 0),
      workId: row.work_id ?? null,
      taskId: row.task_id ?? null,
      capabilities: {
        ...normalizedStoredProviderCapabilities(projectedProvider, displayStatus, rawStatus.capabilities),
        ...(logicalIdentity?.transition_state === "sessionRecovery" ? { canSend: false } : {})
      },
      rawStatus,
      external: {
        provider: projectedProvider,
        threadId,
        sessionId: row.projection_provider_session_id ?? rawStatus.sessionId ?? threadId,
        activeTurnId: rawStatus.activeTurnId ?? null,
        lastSettledTurnId: rawStatus.lastSettledTurnId ?? null,
        sandbox: rawStatus.sandbox ?? rawStatus.sandboxMode ?? null,
        approvalPolicy: rawStatus.approvalPolicy ?? null,
        logicalSessionId: logicalIdentity?.logical_session_id ?? rawStatus.logicalSessionId ?? null,
        workspace: rawStatus.workspace ?? null,
        routingVersion,
        agentSessionId: rawStatus.agentSessionId ?? rawStatus.resume?.agentSessionId ?? null,
        connectionStatus: providerConnectionStatus,
        currentModel: rawStatus.currentModel ?? rawStatus.resume?.currentModel ?? modelFromArgs(args),
        currentReasoningLevel: rawStatus.currentReasoningLevel ?? rawStatus.resume?.currentReasoningLevel ?? reasoningFromArgs(args),
        cwd: activeCwd,
        source: rawStatus.source ?? row.command,
        args
      }
    };
  }
}
