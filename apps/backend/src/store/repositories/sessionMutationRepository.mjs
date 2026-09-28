import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { inferSessionKind, assertExplicitSessionKind, SESSION_KIND } from "../../utils/sessionKinds.mjs";
import { normalizeSessionTitle } from "../../utils/sessionTitles.mjs";
import { assertManualSessionArchiveAllowed } from "../../domain/sessionArchivePolicy.mjs";
import { requiredText } from "../validation.mjs";
import { serializeActiveChoicePrompt, toSessionSummary, toRawStatus } from "../storedSessionInput.mjs";

// Uses the Store-owned connection and notification/transaction coordinator.
export class SessionMutationRepository {
  constructor({ getDatabase, selectOne, selectAll, scheduleSave, runInTransaction, getSession, listSessions, ensureSessionLog, assertSessionAssociation, getLogicalSessionByLegacySessionId, getLogicalSession }) {
    this.getDatabase = getDatabase;
    this.selectOne = selectOne;
    this.selectAll = selectAll;
    this.scheduleSave = scheduleSave;
    this.runInTransaction = runInTransaction;
    this.getSession = getSession;
    this.listSessions = listSessions;
    this.ensureSessionLog = ensureSessionLog;
    this.assertSessionAssociation = assertSessionAssociation;
    this.getLogicalSessionByLegacySessionId = getLogicalSessionByLegacySessionId;
    this.getLogicalSession = getLogicalSession;
  }

  get db() { return this.getDatabase(); }

  touchSessionProjectionDependency(sessionId) {
    this.db.run(
      `UPDATE sessions SET archive_dependency_version = archive_dependency_version + 1
       WHERE id = ?`,
      [sessionId]
    );
    this.scheduleSave();
  }

  upsertSession(session) {
    const persistedAssociation = this.selectOne(
      "SELECT work_id, task_id, session_kind, deleted_at FROM sessions WHERE id = ?",
      [session.id]
    );
    // Provider discovery can race with, or arrive late after, local deletion.
    // A Provider projection must never resurrect a deliberately deleted actor.
    if (persistedAssociation?.deleted_at) return false;
    const suppliedSessionKind = session.sessionKind == null
      ? inferSessionKind({ workId: session.workId, taskId: session.taskId })
      : assertExplicitSessionKind(session.sessionKind, { allowLegacy: true });
    const effectiveSessionKind = suppliedSessionKind === "legacy"
      ? persistedAssociation?.session_kind ?? "legacy"
      : suppliedSessionKind;
    const effectiveWorkId = effectiveSessionKind === "worker"
      ? session.workId ?? persistedAssociation?.work_id ?? null
      : session.workId ?? null;
    const effectiveTaskId = effectiveSessionKind === "worker"
      ? session.taskId ?? persistedAssociation?.task_id ?? null
      : session.taskId ?? null;
    this.assertSessionAssociation({
      sessionId: session.id,
      sessionKind: effectiveSessionKind,
      workId: effectiveWorkId,
      taskId: effectiveTaskId
    });
    const summary = toSessionSummary(session);
    const values = [
      session.id,
      session.title,
      session.agentName || session.agent || "Agent",
      session.provider || session.external?.provider || "unknown",
      session.command || session.external?.source || null,
      JSON.stringify(session.args || []),
      session.cwd || session.external?.cwd || null,
      summary.status,
      summary.progress,
      summary.summary,
      session.accent || summary.accent || "cyan",
      createdAtFromOrNow(session.createdAt, session.updatedAt),
      createdAtFromOrNow(session.updatedAt),
      session.archived ? 1 : 0,
      session.pinned ? 1 : 0,
      Number.isFinite(session.sortOrder) ? session.sortOrder : this.nextTopSortOrder(session.archived === true),
      serializeActiveChoicePrompt(summary.suggestedOptions, summary.summary, session.activeChoicePrompt),
      JSON.stringify(toRawStatus(session)),
      effectiveWorkId,
      effectiveTaskId,
      effectiveSessionKind,
      session.agentId ?? null
    ];

    // Change-detection: an UPDATE bumps the state_sync_clock revision (via the
    // sessions trigger) and fans out a change-set to every connected client, so a
    // no-op write is a real source of idle churn. Compare the normalized row against
    // what is already persisted and skip the write entirely when nothing changed.
    const existing = this.selectOne(
      `SELECT title, agent, provider, command, args_json, cwd, status, progress,
              summary, accent, created_at, updated_at, archived, pinned, sort_order,
              active_choice_json, raw_json, work_id, task_id, session_kind, agent_id
       FROM sessions WHERE id = ?`,
      [session.id]
    );
    if (existing) {
      // Fields omitted by Provider polling retain their persisted storage
      // identity/order. Generating a fresh fallback here turns every poll into
      // a semantic UPDATE even though the visible Session is unchanged.
      values[11] = existing.created_at;
      if (!Number.isFinite(session.sortOrder)) values[15] = existing.sort_order;
      if (session.workId == null) values[18] = existing.work_id;
      if (session.taskId == null) values[19] = existing.task_id;
      if (values[20] === SESSION_KIND.legacy) values[20] = existing.session_kind;
      if (session.agentId == null) values[21] = existing.agent_id;
      const columns = [
        "title", "agent", "provider", "command", "args_json", "cwd", "status", "progress",
        "summary", "accent", "created_at", "updated_at", "archived", "pinned", "sort_order",
        "active_choice_json", "raw_json", "work_id", "task_id", "session_kind", "agent_id"
      ];
      let changed = false;
      for (let i = 0; i < columns.length; i++) {
        if (columns[i] === "updated_at") continue;
        const next = values[i + 1];
        const prev = existing[columns[i]];
        // SQLite returns integers/bools as numbers and NULL for absent values;
        // normalize both sides so `0` matches `false` and `null` matches `undefined`.
        const a = next == null ? null : next;
        const b = prev == null ? null : prev;
        if (a !== b) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        this.ensureSessionLog(session.id);
        return;
      }
    }

    this.db.run(
      `INSERT INTO sessions (
        id, title, agent, provider, command, args_json, cwd, status, progress, summary, accent, created_at, updated_at, archived, pinned, sort_order, active_choice_json, raw_json, work_id, task_id, session_kind, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        agent=excluded.agent,
        provider=excluded.provider,
        command=excluded.command,
        args_json=excluded.args_json,
        cwd=excluded.cwd,
        status=excluded.status,
        progress=excluded.progress,
        summary=excluded.summary,
        accent=excluded.accent,
        updated_at=excluded.updated_at,
        archived=excluded.archived,
        pinned=excluded.pinned,
        sort_order=excluded.sort_order,
        active_choice_json=excluded.active_choice_json,
        raw_json=excluded.raw_json,
        work_id=COALESCE(excluded.work_id, sessions.work_id),
        task_id=COALESCE(excluded.task_id, sessions.task_id),
        agent_id=COALESCE(excluded.agent_id, sessions.agent_id),
        session_kind=CASE
          WHEN excluded.session_kind = 'legacy' THEN sessions.session_kind
          ELSE excluded.session_kind
        END`,
      values
    );
    this.ensureSessionLog(session.id);
    this.scheduleSave();
  }

  createSession(input = {}) {
    const id = input.id ?? `session:${randomUUID()}`;
    const now = createdAtFromOrNow();
    const sessionKind = input.sessionKind == null
      ? inferSessionKind({ workId: input.workId, taskId: input.taskId })
      : assertExplicitSessionKind(input.sessionKind);
    this.db.run(
      `INSERT INTO sessions (
        id, title, agent, provider, command, args_json, cwd, status, progress, summary, accent,
        created_at, updated_at, archived, pinned, sort_order, active_choice_json, raw_json,
        work_id, task_id, session_kind, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.title ?? "新会话",
        input.agentName ?? "Agent",
        input.provider ?? "codex-app-server",
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        input.cwd ?? null,
        input.status ?? "running",
        input.progress ?? 0,
        input.summary ?? "",
        input.accent ?? "cyan",
        now,
        now,
        input.archived ? 1 : 0,
        input.pinned ? 1 : 0,
        input.sortOrder ?? null,
        input.activeChoiceJson ?? null,
        JSON.stringify(input.raw ?? {}),
        input.workId ?? null,
        input.taskId ?? null,
        input.taskId ? SESSION_KIND.worker : sessionKind,
        input.agentId ?? null
      ]
    );
    if (input.taskId && input.deferTaskProjection !== true) {
      this.db.run(
        `UPDATE tasks SET current_session_id = ?, updated_at = ? WHERE id = ?`,
        [id, now, input.taskId]
      );
    }
    // 会话日志事件溯源（10）：新 session 建立 1:1 的 session_log。
    this.ensureSessionLog(id);
    this.scheduleSave();
    return this.getSession(id);
  }

  closeSession(id) {
    this.db.run(
      `UPDATE sessions SET status = 'completed', updated_at = ? WHERE id = ?`,
      [createdAtFromOrNow(), id]
    );
    this.scheduleSave();
    return this.getSession(id);
  }

  archiveSession(id, archived = true) {
    const session = this.getSession(id);
    if (!session) return null;
    assertManualSessionArchiveAllowed(session);
    const updatedAt = new Date().toISOString();
    this.db.run(
      "UPDATE sessions SET archived = ?, sort_order = ?, updated_at = ? WHERE id = ?",
      [archived ? 1 : 0, this.nextTopSortOrder(archived), updatedAt, id]
    );
    if (!archived) this.clearSessionRuntimeReleaseReceipt(id);
    this.scheduleSave();
    return this.getSession(id);
  }

  markSessionRuntimeReleased(sessionId, reason = "archived", releasedAt = new Date().toISOString()) {
    this.db.run(
      `INSERT INTO session_runtime_release_receipts (session_id, reason, released_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         reason=excluded.reason,
         released_at=excluded.released_at`,
      [sessionId, reason, releasedAt]
    );
    this.scheduleSave();
  }

  clearSessionRuntimeReleaseReceipt(sessionId) {
    this.db.run("DELETE FROM session_runtime_release_receipts WHERE session_id = ?", [sessionId]);
    this.scheduleSave();
  }

  pinSession(id, pinned = true) {
    this.db.run("UPDATE sessions SET pinned = ? WHERE id = ?", [pinned ? 1 : 0, id]);
    this.scheduleSave();
    return this.getSession(id);
  }

  reorderSessions(sessionIds = []) {
    const ids = sessionIds.map((id) => String(id)).filter(Boolean);
    ids.forEach((id, index) => {
      this.db.run(
        "UPDATE sessions SET sort_order = ? WHERE id = ? AND sort_order IS NOT ?",
        [index, id, index]
      );
    });
    this.scheduleSave();
    return this.listSessions({ archived: false });
  }

  renameSession(id, title) {
    const sessionName = requiredText(title, "title");
    const sessionNameKey = normalizeSessionTitle(sessionName);
    const updatedAt = new Date().toISOString();
    const logical = this.getLogicalSessionByLegacySessionId(id) ?? this.getLogicalSession(id);
    const storageSessionId = logical?.legacySessionId ?? id;
    const currentSession = this.getSession(storageSessionId);
    if (currentSession && ["worker", "workChat"].includes(currentSession.sessionKind)) {
      const error = new Error("Task and Work Chat Session names are derived from their owning resource.");
      error.code = "SESSION_TITLE_DERIVED";
      error.statusCode = 409;
      throw error;
    }
    if (logical) {
      const conflict = this.selectOne(
        `SELECT logical_session_id FROM logical_sessions
         WHERE session_name_key = ? AND logical_session_id <> ?`,
        [sessionNameKey, logical.logicalSessionId]
      );
      if (conflict) {
        const error = new Error(`A session named "${sessionName}" already exists.`);
        error.code = "SESSION_TITLE_CONFLICT";
        error.statusCode = 409;
        error.conflictingSessionId = conflict.logical_session_id;
        throw error;
      }
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", [sessionName, updatedAt, storageSessionId]);
      if (logical) {
        // Renaming is replacement, not an alias operation. Stable IDs are the
        // only supported long-lived route; old names stop resolving.
        this.db.run("DELETE FROM session_name_aliases WHERE logical_session_id = ?", [logical.logicalSessionId]);
        this.db.run(
          `UPDATE logical_sessions
           SET session_name = ?, session_name_key = ?, title = ?, updated_at = ?
           WHERE logical_session_id = ?`,
          [sessionName, sessionNameKey, sessionName, updatedAt, logical.logicalSessionId]
        );
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getSession(storageSessionId);
  }

  setActiveChoicePrompt(sessionId, prompt = "", options = []) {
    const rawId = String(sessionId);
    const activeChoice = serializeActiveChoicePrompt(options, prompt);
    this.db.run(
      "UPDATE sessions SET active_choice_json = ?, updated_at = ? WHERE id = ?",
      [activeChoice, new Date().toISOString(), rawId]
    );
    this.scheduleSave();
    return this.getSession(rawId);
  }

  clearActiveChoicePrompt(sessionId) {
    const rawId = String(sessionId);
    this.db.run(
      "UPDATE sessions SET active_choice_json = NULL, updated_at = ? WHERE id = ?",
      [new Date().toISOString(), rawId]
    );
    this.scheduleSave();
    return this.getSession(rawId);
  }

  deleteSession(id) {
    const timestamp = new Date().toISOString();
    const existing = this.selectOne("SELECT deleted_at FROM sessions WHERE id = ?", [id]);
    if (!existing || existing.deleted_at) return false;
    this.runInTransaction(() => {
      this.db.run(
        `UPDATE agent_operations
         SET status = 'cancelled', completed_at = ?, updated_at = ?,
             last_error = COALESCE(last_error, 'Target Session was cleared or deleted before this message was processed.')
         WHERE session_id = ? AND status IN ('queued', 'running')`,
        [timestamp, timestamp, id]
      );
      this.db.run(
        `UPDATE tasks SET current_session_id = NULL, updated_at = ?
         WHERE current_session_id = ? AND COALESCE(deletion_status, '') <> 'deleting'`,
        [timestamp, id]
      );
      this.db.run(
        `UPDATE agent_sessions SET unbound_at = COALESCE(unbound_at, ?)
         WHERE session_id = ? AND unbound_at IS NULL`,
        [timestamp, id]
      );
      this.db.run("DELETE FROM session_items WHERE session_id = ?", [id]);
      this.db.run(
        `UPDATE sessions
         SET deleted_at = ?, status = 'deleted', progress = 1,
             archived = 1, pinned = 0, active_choice_json = NULL, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
        [timestamp, timestamp, id]
      );
    });
    this.scheduleSave();
    return true;
  }

  initializeSortOrder() {
    const rows = this.selectAll(
      "SELECT id FROM sessions WHERE sort_order IS NULL AND deleted_at IS NULL ORDER BY archived ASC, updated_at DESC"
    );
    rows.forEach((row, index) => {
      this.db.run("UPDATE sessions SET sort_order = ? WHERE id = ?", [index, row.id]);
    });
  }

  nextTopSortOrder(archived = false) {
    const row = this.selectOne(
      "SELECT MIN(sort_order) AS min_order FROM sessions WHERE archived = ? AND deleted_at IS NULL",
      [archived ? 1 : 0]
    );
    const minOrder = Number(row?.min_order);
    return Number.isFinite(minOrder) ? minOrder - 1 : 0;
  }
}
