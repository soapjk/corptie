import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";

export class TimelineMutationRepository {
  constructor({ getDatabase, normalizedSessionIdFilter, selectOne, selectAll, getSession, getSessionItem, scheduleSave, notifyTimelineDirty }) {
    this.getDatabase = getDatabase;
    this.normalizedSessionIdFilter = normalizedSessionIdFilter;
    this.selectOne = selectOne;
    this.selectAll = selectAll;
    this.getSession = getSession;
    this.getSessionItem = getSessionItem;
    this.scheduleSave = scheduleSave;
    this.notifyTimelineDirty = notifyTimelineDirty;
  }

  get db() {
    return this.getDatabase();
  }

  upsertTimelineItemProjection(sessionId, item) {
    if (this.selectOne("SELECT 1 FROM deleted_user_messages WHERE session_id=? AND message_id=?", [sessionId, item.id])) return false;
    const createdAt = createdAtFromOrNow(item);
    const rawMetadataJSON = typeof item.rawMetadataJSON === "string" ? item.rawMetadataJSON : null;
    // Provider status/echo projections are not authority to remove durable
    // attachments admitted with the message. Preserve only images, not stale
    // interaction/status metadata. An explicit images array still wins.
    // Merge inside the existing write: no extra SELECT or whole-message JSON
    // decoding on every streaming update. Reuse the expression in the change
    // predicate so replaying the same echo does not dirty the Timeline again.
    const mergedMetadata = `CASE
      WHEN excluded.type IN ('userMessage','agentMessage','imageView')
        AND json_valid(excluded.raw_metadata_json) AND json_valid(session_items.raw_metadata_json)
      THEN CASE WHEN json_type(excluded.raw_metadata_json, '$.images') IS NULL
        AND json_type(session_items.raw_metadata_json, '$.images') = 'array'
        THEN json_set(excluded.raw_metadata_json, '$.images', json_extract(session_items.raw_metadata_json, '$.images'))
        ELSE excluded.raw_metadata_json END
      ELSE COALESCE(excluded.raw_metadata_json, session_items.raw_metadata_json) END`;
    this.db.run(
      `INSERT INTO session_items (
        id, session_id, turn_id, turn_status, type, title, text, options_json, raw_metadata_json,
        binding_id, presentation_role, presentation_text, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET
        turn_id=excluded.turn_id,
        turn_status=excluded.turn_status,
        type=excluded.type,
        title=excluded.title,
        text=excluded.text,
        options_json=excluded.options_json,
        raw_metadata_json=${mergedMetadata},
        binding_id=COALESCE(excluded.binding_id, session_items.binding_id),
        presentation_role=COALESCE(excluded.presentation_role, session_items.presentation_role),
        presentation_text=COALESCE(excluded.presentation_text, session_items.presentation_text),
        status=excluded.status
      WHERE session_items.turn_id IS NOT excluded.turn_id
         OR session_items.turn_status IS NOT excluded.turn_status
         OR session_items.type IS NOT excluded.type
         OR session_items.title IS NOT excluded.title
         OR session_items.text IS NOT excluded.text
         OR session_items.options_json IS NOT excluded.options_json
         OR (excluded.raw_metadata_json IS NOT NULL AND session_items.raw_metadata_json IS NOT (${mergedMetadata}))
         OR (excluded.binding_id IS NOT NULL AND session_items.binding_id IS NOT excluded.binding_id)
         OR (excluded.presentation_role IS NOT NULL AND session_items.presentation_role IS NOT excluded.presentation_role)
         OR (excluded.presentation_text IS NOT NULL AND session_items.presentation_text IS NOT excluded.presentation_text)
         OR session_items.status IS NOT excluded.status`,
      [
        item.id,
        sessionId,
        item.turnId || sessionId,
        item.turnStatus || "completed",
        item.type || "terminalOutput",
        item.title || "Agent",
        item.text || "",
        Array.isArray(item.options) ? JSON.stringify(item.options) : null,
        rawMetadataJSON,
        item.bindingId || null,
        item.presentationRole || null,
        item.presentationText || null,
        item.status || null,
        createdAt
      ]
    );
    const changed = this.db.getRowsModified() > 0;
    if (changed) {
      this.scheduleSave();
      this.notifyTimelineDirty(sessionId);
    }
    return changed;
  }

  getExecutionPlanState(sessionId, bindingId, planKey) {
    const row = this.selectOne(
      `SELECT plan_json FROM session_execution_plan_state
       WHERE session_id = ? AND binding_id = ? AND plan_key = ?`,
      [sessionId, bindingId, planKey]
    );
    return row ? parseJson(row.plan_json, null) : null;
  }

  upsertExecutionPlanState(sessionId, bindingId, planKey, plan) {
    this.db.run(
      `INSERT INTO session_execution_plan_state
       (session_id, binding_id, plan_key, plan_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, binding_id, plan_key) DO UPDATE SET
         plan_json = excluded.plan_json, updated_at = excluded.updated_at`,
      [sessionId, bindingId, planKey, JSON.stringify(plan), plan.updatedAt]
    );
  }


  removeItem(sessionId, itemId) {
    this.db.run("DELETE FROM session_items WHERE session_id = ? AND id = ?", [sessionId, itemId]);
    if (this.db.getRowsModified() > 0) {
      this.scheduleSave();
      this.notifyTimelineDirty(sessionId);
    }
  }

  clearItems(sessionId) {
    this.db.run("DELETE FROM session_items WHERE session_id = ?", [sessionId]);
    if (this.db.getRowsModified() > 0) {
      this.scheduleSave();
      this.notifyTimelineDirty(sessionId);
    }
  }

  getQueuedItems(sessionId) {
    return this.selectAll(
      `SELECT * FROM session_items
       WHERE session_id = ? AND status = 'queued'
       ORDER BY created_at ASC`,
      [sessionId]
    ).map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      turnStatus: row.turn_status,
      type: row.type,
      title: row.title,
      text: row.text,
      status: row.status,
      createdAt: row.created_at
    }));
  }


  listSessionTimelineRevisions(sessionIds = null) {
    const ids = this.normalizedSessionIdFilter(sessionIds);
    if (ids?.length === 0) return new Map();
    const filter = ids ? `AND sessions.id IN (${ids.map(() => "?").join(", ")})` : "";
    const rows = this.selectAll(`
      SELECT sessions.id AS session_id,
             COALESCE(session_timeline_revisions.revision, 0) AS revision
      FROM sessions
      LEFT JOIN session_timeline_revisions
        ON session_timeline_revisions.session_id = sessions.id
      WHERE sessions.deleted_at IS NULL
        ${filter}
    `, ids ?? []);
    return new Map(rows.map((row) => [row.session_id, Number(row.revision ?? 0)]));
  }

  sessionTimelineRevision(sessionId) {
    const row = this.selectOne(
      "SELECT revision FROM session_timeline_revisions WHERE session_id = ?",
      [sessionId]
    );
    return Number(row?.revision ?? 0);
  }

  sessionTimelineChangesAfter(sessionId, afterRevision, limit = 200) {
    if (!this.getSession(sessionId)) {
      const error = new Error("Session not found.");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    const after = Number(afterRevision);
    const currentRevision = this.sessionTimelineRevision(sessionId);
    if (!Number.isSafeInteger(after) || after < 0 || after > currentRevision) {
      return { snapshotRequired: true, currentRevision };
    }
    if (after === currentRevision) {
      return {
        snapshotRequired: false,
        baseRevision: after,
        revision: after,
        currentRevision,
        hasMore: false,
        changes: []
      };
    }
    const oldest = this.selectOne(
      "SELECT MIN(revision) AS revision FROM session_timeline_change_log WHERE session_id = ?",
      [sessionId]
    );
    const oldestRevision = Number(oldest?.revision ?? currentRevision);
    if (after < oldestRevision - 1) {
      return { snapshotRequired: true, currentRevision };
    }
    const pageLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const rows = this.selectAll(
      `SELECT revision, item_id, operation, changed_at
       FROM session_timeline_change_log
       WHERE session_id = ? AND revision > ?
       ORDER BY revision ASC LIMIT ?`,
      [sessionId, after, pageLimit]
    );
    if (rows.length === 0) {
      return { snapshotRequired: true, currentRevision };
    }
    const revision = Number(rows.at(-1).revision);
    return {
      snapshotRequired: false,
      baseRevision: after,
      revision,
      currentRevision,
      hasMore: revision < currentRevision,
      changes: rows.map((row) => ({
        revision: Number(row.revision),
        itemId: row.item_id,
        operation: row.operation,
        item: row.operation === "upsert"
          ? this.getSessionItem(sessionId, row.item_id)
          : null,
        changedAt: row.changed_at
      }))
    };
  }
}
