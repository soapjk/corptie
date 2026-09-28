import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { requiredText, optionalStoredText } from "../validation.mjs";

export class LegacyHistoryRepository {
  constructor({ getDatabase, selectAll, selectOne, rowToSession, scheduleSave, runInTransaction, getSession, upsertTimelineItemProjection, notifyTimelineDirty }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.rowToSession = rowToSession;
    this.scheduleSave = scheduleSave;
    this.runInTransaction = runInTransaction;
    this.getSession = getSession;
    this.upsertTimelineItemProjection = upsertTimelineItemProjection;
    this.notifyTimelineDirty = notifyTimelineDirty;
  }

  get db() {
    return this.getDatabase();
  }

  listLegacyHistoryRepairCandidates({ createdBefore, limit = 200 } = {}) {
    const cutoff = requiredText(createdBefore, "createdBefore");
    const pageLimit = Math.max(1, Math.min(1_000, Math.floor(Number(limit) || 200)));
    return this.selectAll(
      `SELECT sessions.* FROM sessions
       WHERE sessions.created_at < ?
         AND sessions.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM session_items WHERE session_items.session_id = sessions.id
         )
       ORDER BY sessions.created_at ASC, sessions.id ASC
       LIMIT ?`,
      [cutoff, pageLimit]
    ).map((row) => ({
      session: this.rowToSession(row),
      repair: this.getLegacyHistoryRepair(row.id)
    }));
  }

  getLegacyHistoryRepair(sessionId) {
    return this.selectOne(
      "SELECT * FROM legacy_history_repairs WHERE session_id = ?",
      [sessionId]
    );
  }

  recordLegacyHistoryRepair(input) {
    const timestamp = createdAtFromOrNow(input.attemptedAt);
    const completedAt = input.completedAt === null
      ? null
      : createdAtFromOrNow(input.completedAt, timestamp);
    this.db.run(
      `INSERT INTO legacy_history_repairs (
         session_id, provider_id, binding_id, provider_session_id, status,
         source_item_count, imported_item_count, attempt_count,
         failure_code, failure_message, first_attempted_at, last_attempted_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         provider_id=excluded.provider_id,
         binding_id=excluded.binding_id,
         provider_session_id=excluded.provider_session_id,
         status=excluded.status,
         source_item_count=excluded.source_item_count,
         imported_item_count=excluded.imported_item_count,
         attempt_count=legacy_history_repairs.attempt_count + 1,
         failure_code=excluded.failure_code,
         failure_message=excluded.failure_message,
         last_attempted_at=excluded.last_attempted_at,
         completed_at=excluded.completed_at`,
      [
        requiredText(input.sessionId, "sessionId"),
        requiredText(input.providerId, "providerId"),
        optionalStoredText(input.bindingId),
        optionalStoredText(input.providerSessionId),
        legacyHistoryRepairStatus(input.status),
        nonNegativeInteger(input.sourceItemCount),
        nonNegativeInteger(input.importedItemCount),
        optionalStoredText(input.failureCode),
        optionalStoredText(input.failureMessage),
        timestamp,
        timestamp,
        completedAt
      ]
    );
    this.scheduleSave();
    return this.getLegacyHistoryRepair(input.sessionId);
  }

  importLegacyHistoryRepair(input) {
    const sessionId = requiredText(input.sessionId, "sessionId");
    const providerId = requiredText(input.providerId, "providerId");
    const attemptedAt = createdAtFromOrNow(input.attemptedAt);
    const items = normalizedLegacyHistoryItems(input.items);
    return this.runInTransaction(() => {
      if (!this.getSession(sessionId)) {
        const error = new Error(`Session not found: ${sessionId}`);
        error.code = "SESSION_NOT_FOUND";
        throw error;
      }
      const existing = this.selectOne(
        "SELECT COUNT(*) AS count FROM session_items WHERE session_id = ?",
        [sessionId]
      );
      if (Number(existing?.count ?? 0) > 0) {
        return this.recordLegacyHistoryRepair({
          ...input,
          sessionId,
          providerId,
          status: "conflict",
          sourceItemCount: items.length,
          importedItemCount: 0,
          failureCode: "TIMELINE_ALREADY_MATERIALIZED",
          failureMessage: "Timeline items appeared before the legacy repair transaction committed.",
          attemptedAt,
          completedAt: attemptedAt
        });
      }
      for (const item of items) {
        this.upsertTimelineItemProjection(sessionId, {
          ...item,
          bindingId: input.bindingId ?? item.bindingId ?? null
        });
        this.db.run(
          `INSERT OR IGNORE INTO legacy_history_repair_items (session_id, item_id, inserted_at)
           VALUES (?, ?, ?)`,
          [sessionId, item.id, attemptedAt]
        );
      }
      return this.recordLegacyHistoryRepair({
        ...input,
        sessionId,
        providerId,
        status: items.length > 0 ? "imported" : "no_history",
        sourceItemCount: items.length,
        importedItemCount: items.length,
        attemptedAt,
        completedAt: attemptedAt,
        failureCode: null,
        failureMessage: null
      });
    });
  }

  rollbackLegacyHistoryRepair(sessionId, reason = "Operator-requested rollback") {
    const normalizedSessionId = requiredText(sessionId, "sessionId");
    const rollbackReason = requiredText(reason, "reason");
    return this.runInTransaction(() => {
      const repair = this.getLegacyHistoryRepair(normalizedSessionId);
      if (!repair || repair.status !== "imported") {
        const error = new Error(`Session ${normalizedSessionId} does not have an imported legacy history repair.`);
        error.code = "LEGACY_HISTORY_REPAIR_NOT_ROLLBACKABLE";
        throw error;
      }
      const recordedItems = this.selectAll(
        "SELECT item_id FROM legacy_history_repair_items WHERE session_id = ? ORDER BY item_id",
        [normalizedSessionId]
      );
      for (const row of recordedItems) {
        this.db.run(
          "DELETE FROM session_items WHERE session_id = ? AND id = ?",
          [normalizedSessionId, row.item_id]
        );
      }
      this.db.run(
        "DELETE FROM legacy_history_repair_items WHERE session_id = ?",
        [normalizedSessionId]
      );
      const rolledBackAt = createdAtFromOrNow();
      this.db.run(
        `UPDATE legacy_history_repairs
         SET status = 'rolled_back', imported_item_count = 0,
             failure_code = 'LEGACY_HISTORY_REPAIR_ROLLED_BACK', failure_message = ?,
             last_attempted_at = ?, completed_at = ?
         WHERE session_id = ?`,
        [rollbackReason, rolledBackAt, rolledBackAt, normalizedSessionId]
      );
      if (recordedItems.length > 0) this.notifyTimelineDirty(normalizedSessionId);
      this.scheduleSave();
      return this.getLegacyHistoryRepair(normalizedSessionId);
    });
  }
}

const LEGACY_HISTORY_REPAIR_STATUSES = new Set([
  "imported", "no_history", "unsupported", "unavailable", "failed", "conflict", "rolled_back"
]);

function legacyHistoryRepairStatus(value) {
  const status = requiredText(value, "status");
  if (!LEGACY_HISTORY_REPAIR_STATUSES.has(status)) {
    throw new Error(`Unsupported legacy history repair status: ${status}`);
  }
  return status;
}

function nonNegativeInteger(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("Legacy history repair counts must be non-negative integers.");
  }
  return number;
}

function normalizedLegacyHistoryItems(input) {
  if (!Array.isArray(input)) {
    throw new TypeError("Legacy history repair items must be an array.");
  }
  const identifiers = new Set();
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`Legacy history repair item ${index} must be an object.`);
    }
    const id = requiredText(item.id, `items[${index}].id`);
    if (identifiers.has(id)) {
      throw new Error(`Duplicate legacy history repair item id: ${id}`);
    }
    identifiers.add(id);
    if (item.options != null && !Array.isArray(item.options)) {
      throw new TypeError(`Legacy history repair item ${id} options must be an array.`);
    }
    if (item.rawMetadataJSON != null && typeof item.rawMetadataJSON !== "string") {
      throw new TypeError(`Legacy history repair item ${id} rawMetadataJSON must be a string.`);
    }
    return {
      id,
      turnId: requiredText(item.turnId, `items[${index}].turnId`),
      turnStatus: requiredText(item.turnStatus, `items[${index}].turnStatus`),
      type: requiredText(item.type, `items[${index}].type`),
      title: requiredText(item.title, `items[${index}].title`),
      text: typeof item.text === "string" ? item.text : "",
      options: item.options ?? null,
      rawMetadataJSON: item.rawMetadataJSON ?? null,
      bindingId: optionalStoredText(item.bindingId),
      presentationRole: optionalStoredText(item.presentationRole),
      presentationText: typeof item.presentationText === "string" ? item.presentationText : null,
      status: optionalStoredText(item.status),
      createdAt: optionalStoredText(item.createdAt)
    };
  });
}
