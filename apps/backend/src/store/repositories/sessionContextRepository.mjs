import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";

export class SessionContextRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
  }

  get db() {
    return this.getDatabase();
  }

  createSessionContextReference(input = {}) {
    const referenceId = input.referenceId ?? `context_ref:${randomUUID()}`;
    const timestamp = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO session_context_references (
        reference_id, owner_session_id, target_type, target_key, target_id, locator,
        display_name, inclusion_mode, enabled, priority, status,
        snapshot_title, snapshot_text, snapshot_at, content_hash, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        referenceId,
        input.ownerSessionId,
        input.targetType,
        input.targetKey,
        input.targetId ?? null,
        input.locator ?? null,
        input.displayName,
        input.inclusionMode ?? "default",
        input.enabled === false ? 0 : 1,
        Number.isFinite(input.priority) ? input.priority : 100,
        input.status ?? "available",
        input.snapshotTitle ?? null,
        input.snapshotText ?? null,
        input.snapshotAt ?? null,
        input.contentHash ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp
      ]
    );
    this.scheduleSave();
    return this.getSessionContextReference(referenceId);
  }

  getSessionContextReference(referenceId) {
    const row = this.selectOne(
      "SELECT * FROM session_context_references WHERE reference_id = ?",
      [referenceId]
    );
    return row ? sessionContextReferenceFromRow(row) : null;
  }

  listSessionContextReferences(ownerSessionId) {
    return this.selectAll(
      `SELECT * FROM session_context_references
       WHERE owner_session_id = ?
       ORDER BY enabled DESC, priority DESC, created_at ASC`,
      [ownerSessionId]
    ).map(sessionContextReferenceFromRow);
  }

  updateSessionContextReference(referenceId, patch = {}) {
    const current = this.getSessionContextReference(referenceId);
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE session_context_references SET
        display_name = ?, inclusion_mode = ?, enabled = ?, priority = ?, status = ?,
        snapshot_title = ?, snapshot_text = ?, snapshot_at = ?, content_hash = ?,
        metadata_json = ?, updated_at = ?
       WHERE reference_id = ?`,
      [
        has("displayName") ? patch.displayName : current.displayName,
        has("inclusionMode") ? patch.inclusionMode : current.inclusionMode,
        has("enabled") ? (patch.enabled ? 1 : 0) : (current.enabled ? 1 : 0),
        has("priority") ? patch.priority : current.priority,
        has("status") ? patch.status : current.status,
        has("snapshotTitle") ? patch.snapshotTitle : current.snapshotTitle,
        has("snapshotText") ? patch.snapshotText : current.snapshotText,
        has("snapshotAt") ? patch.snapshotAt : current.snapshotAt,
        has("contentHash") ? patch.contentHash : current.contentHash,
        JSON.stringify(has("metadata") ? (patch.metadata ?? {}) : current.metadata),
        createdAtFromOrNow(),
        referenceId
      ]
    );
    this.scheduleSave();
    return this.getSessionContextReference(referenceId);
  }

  deleteSessionContextReference(referenceId) {
    this.db.run(
      "DELETE FROM session_context_references WHERE reference_id = ?",
      [referenceId]
    );
    const deleted = this.db.getRowsModified() > 0;
    this.scheduleSave();
    return deleted;
  }
}

function sessionContextReferenceFromRow(row) {
  return {
    referenceId: row.reference_id,
    ownerSessionId: row.owner_session_id,
    targetType: row.target_type,
    targetKey: row.target_key,
    targetId: row.target_id ?? null,
    locator: row.locator ?? null,
    displayName: row.display_name,
    inclusionMode: row.inclusion_mode,
    enabled: Boolean(row.enabled),
    priority: Number(row.priority),
    status: row.status,
    snapshotTitle: row.snapshot_title ?? null,
    snapshotText: row.snapshot_text ?? null,
    snapshotAt: row.snapshot_at ?? null,
    contentHash: row.content_hash ?? null,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
